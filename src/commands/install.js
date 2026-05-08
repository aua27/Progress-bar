'use strict';

const chalk = require('chalk').default;
const ArboristAdapter = require('../adapters/arborist');
const { getArboristOpts } = require('../adapters/config');
const { fetchWithRetry } = require('../adapters/pacote');
const { probeAll } = require('../cache-probe');
const DownloadAggregator = require('../aggregator');
const ProgressRenderer = require('../progress');
const { printSummary } = require('../summary');

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

async function install(packages, flags) {
  const start = Date.now();

  // Pass no path/prefix in extraOpts — config.js routes --prefix to arborist.path
  // (local install) or arborist.prefix (global install) as appropriate.
  // Without --prefix, arborist defaults its path to process.cwd() which is correct.
  const arboristOpts = getArboristOpts(flags);

  // Step 1: Build ideal tree — animate a spinner since this can take several seconds.
  const arb = new ArboristAdapter(arboristOpts);
  let spinnerFrame = 0;
  const spinnerTimer = process.stdout.isTTY
    ? setInterval(() => {
        process.stdout.write(`  ${chalk.blue(SPINNER_FRAMES[spinnerFrame++ % SPINNER_FRAMES.length])}  Resolving packages...\r`);
      }, 100)
    : null;

  let pkgSpecs;
  try {
    await arb.buildIdealTree(packages);
    pkgSpecs = arb.extractPackageSpecs();
  } catch (err) {
    if (spinnerTimer) clearInterval(spinnerTimer);
    process.stdout.write('\n');
    console.error(`npmx: failed to resolve packages: ${err.message}`);
    process.exit(1);
  }
  if (spinnerTimer) clearInterval(spinnerTimer);

  // Step 2: Cache probe (best-effort).
  // Use arborist's fully-resolved options (includes registry, auth, etc.) for pacote calls.
  // Probe with the resolved tarball URL — same identifier pacote uses to fetch.
  const pacoteOpts = arb.pacoteOpts;
  const specNames = pkgSpecs.map(p => p.resolved || p.spec);
  const { likelyCached, cachedSpecs } = await probeAll(specNames, pacoteOpts);

  process.stdout.write(`\r  ${chalk.green('✔')}  Resolved ${pkgSpecs.length} packages (~${likelyCached} likely cached)\n`);

  // Step 3: Register all specs in aggregator.
  const aggregator = new DownloadAggregator();
  for (const pkg of pkgSpecs) {
    aggregator.register(pkg.spec, { optional: pkg.optional, distSize: pkg.distSize });
  }

  // Step 4: Download phase with progress.
  const renderer = new ProgressRenderer(aggregator);
  renderer.start();

  const ac = new AbortController();
  let requiredFailure = null;

  await Promise.all(pkgSpecs.map(async pkg => {
    aggregator.onFetchStart(pkg.spec);
    try {
      // Use resolved URL so pacote fetches the exact tarball arborist planned,
      // with no re-resolution. Falls back to name@version for unusual node types.
      const fetchSpec = pkg.resolved || pkg.spec;
      await fetchWithRetry(
        fetchSpec,
        { ...pacoteOpts, integrity: pkg.integrity, signal: ac.signal },
        (len) => aggregator.onChunk(pkg.spec, len),
        () => aggregator.onRetry(pkg.spec),
      );
      // Determine cached status from the probe result — bytes alone can't distinguish
      // network vs disk-cache since pacote always streams the full tarball.
      aggregator.onEnd(pkg.spec, { cached: cachedSpecs.has(fetchSpec) });
    } catch (err) {
      if (ac.signal.aborted) {
        aggregator.onAbort(pkg.spec);
        return;
      }
      if (pkg.optional) {
        aggregator.onFailed(pkg.spec, err);
      } else {
        requiredFailure = { spec: pkg.spec, err };
        aggregator.onFailed(pkg.spec, err);
        ac.abort();
      }
    }
  }));

  renderer.stop();

  if (requiredFailure) {
    console.error(`\n  ${chalk.red('✖')}  Required package fetch failed: ${requiredFailure.spec}`);
    console.error(`     ${requiredFailure.err.message}`);
    process.exit(1);
  }

  // Step 5: Reify (link packages).
  // Cache is warm from the explicit pacote pass above — no network traffic expected.
  process.stdout.write(`  ${chalk.blue('🔗')}  Linking...\n`);
  try {
    await arb.reify();
  } catch (err) {
    console.error(`npmx: reify failed: ${err.message}`);
    console.error('  Run `npm install` to attempt recovery.');
    process.exit(1);
  }

  // Step 6: Summary.
  printSummary(aggregator, Date.now() - start, flags);
}

module.exports = install;

'use strict';

const fs = require('fs');
const chalk = require('chalk');
const ArboristAdapter = require('../adapters/arborist');
const { getArboristOpts } = require('../adapters/config');
const { fetchWithRetry } = require('../adapters/pacote');
const { probeAll, tarballCachePath, resolveCacheDir } = require('../cache-probe');
const DownloadAggregator = require('../aggregator');
const ProgressRenderer = require('../progress');
const { printSummary } = require('../summary');

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Mutually-exclusive flag groups. npm rejects these combinations explicitly;
// silently picking one and dropping the others would mask user intent.
const VALID_OMIT_TYPES = new Set(['dev', 'optional', 'peer']);

function validateFlags(flags) {
  const saveFlags = [];
  if (flags.saveDev) saveFlags.push('--save-dev');
  if (flags.saveOptional) saveFlags.push('--save-optional');
  if (flags.saveProd) saveFlags.push('--save-prod');
  if (flags.save === false) saveFlags.push('--no-save');
  if (saveFlags.length > 1) {
    console.error(`npmbar: conflicting flags: ${saveFlags.join(' and ')} cannot be combined`);
    process.exit(1);
  }
  if (typeof flags.workspace === 'string' && !flags.workspace.trim()) {
    console.error('npmbar: invalid --workspace value: workspace name cannot be empty');
    process.exit(1);
  }
  if (flags.workspace && flags.workspaces) {
    console.error('npmbar: conflicting flags: --workspace and --workspaces cannot be combined');
    process.exit(1);
  }
  if (flags.omit) {
    for (const val of flags.omit) {
      if (!VALID_OMIT_TYPES.has(val)) {
        console.error(`npmbar: invalid --omit value '${val}'. Valid values: dev, optional, peer`);
        process.exit(1);
      }
    }
  }
  if (flags.include) {
    for (const val of flags.include) {
      if (!VALID_OMIT_TYPES.has(val)) {
        console.error(`npmbar: invalid --include value '${val}'. Valid values: dev, optional, peer`);
        process.exit(1);
      }
    }
  }
}

async function install(packages, flags) {
  validateFlags(flags);
  const start = Date.now();

  // Progress is a renderer concern only — never forwarded to arborist.
  // Disabled by --no-progress, CI env, or non-TTY stdout (npm parity).
  const showProgress = ProgressRenderer.progressEnabled(flags.progress);

  // SIGINT: stop rendering (clears bar lines + restores the cursor), cancel
  // in-flight fetches, print a one-liner, exit 130 (128 + SIGINT).
  // Registered before the resolve phase so an early Ctrl-C is also handled.
  const ac = new AbortController();
  let renderer = null;
  const onSigint = () => {
    if (renderer) renderer.stop();
    ac.abort();
    process.stderr.write('Aborted.\n');
    process.exit(130);
  };
  process.once('SIGINT', onSigint);

  // config.js routes --prefix to arborist.path (local) or arborist.prefix (global).
  // Without --prefix, arborist defaults its path to process.cwd().
  const arboristOpts = getArboristOpts(flags);

  // Step 1: Build ideal tree — animated spinner since this can take seconds.
  const arb = new ArboristAdapter(arboristOpts);
  let spinnerFrame = 0;
  const spinnerTimer = showProgress
    ? setInterval(() => {
        process.stdout.write(`  ${chalk.blue(SPINNER_FRAMES[spinnerFrame++ % SPINNER_FRAMES.length])}  Resolving packages...\r`);
      }, 100)
    : null;

  let pkgSpecs;
  try {
    await arb.buildIdealTree(packages);
    pkgSpecs = arb.extractPackageSpecs();
  } catch (err) {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      process.stdout.write('\n');
    }
    console.error(`npmbar: failed to resolve packages: ${err.message}`);
    process.exit(1);
  }
  if (spinnerTimer) clearInterval(spinnerTimer);

  // Step 2: Probe — fs.access on cacache content paths derived from each
  // package's integrity hash. Always runs; fs.access on a missing file is
  // microseconds, so guarding on cache-existence saved less than it cost.
  const pacoteOpts = arb.pacoteOpts;
  const { likelyCached, cachedSpecs } = await probeAll(pkgSpecs, pacoteOpts);

  // \r overwrites the spinner — only meaningful when the spinner actually
  // drew. In piped/suppressed output it gets written literally and garbles logs.
  const lineStart = spinnerTimer ? '\r' : '';
  process.stdout.write(`${lineStart}  ${chalk.green('✔')}  Resolved ${pkgSpecs.length} packages (~${likelyCached} likely cached)\n`);

  // Step 3: Register specs and short-circuit cached packages.
  // The double-read fix: only call pacote.tarball.stream() for non-cached.
  // Cached packages are read once, by reify, during extraction.
  const aggregator = new DownloadAggregator();
  for (const pkg of pkgSpecs) {
    aggregator.register(pkg.key, { optional: pkg.optional, distSize: pkg.distSize, displaySpec: pkg.spec });
  }
  for (const pkg of pkgSpecs) {
    if (cachedSpecs.has(pkg.key)) {
      aggregator.onFetchStart(pkg.key);
      aggregator.onEnd(pkg.key, { cached: true });
    }
  }

  const toDownload = pkgSpecs.filter(p => !cachedSpecs.has(p.key));

  // Step 4: Download phase. Skipped on dry-run (semantic contract: no side
  // effects, no network) and when there's nothing to download.
  // (AbortController `ac` is hoisted to the top of install() so the SIGINT
  // handler can cancel fetches.)
  const requiredFailures = [];
  let evictedPkgs = [];

  if (!flags.dryRun && toDownload.length > 0) {
    renderer = new ProgressRenderer(aggregator, { enabled: showProgress });
    renderer.start();

    await Promise.all(toDownload.map(async pkg => {
      aggregator.onFetchStart(pkg.key);
      try {
        const fetchSpec = pkg.resolved || pkg.spec;
        await fetchWithRetry(
          fetchSpec,
          { ...pacoteOpts, integrity: pkg.integrity, signal: ac.signal },
          (len) => aggregator.onChunk(pkg.key, len),
          () => aggregator.onRetry(pkg.key),
        );
        aggregator.onEnd(pkg.key, { cached: false });
      } catch (err) {
        // Classify by the error itself, not by ac.signal.aborted: when several
        // required packages fail in the same tick, the first failure aborts the
        // signal and a signal-first check would misattribute the rest as
        // "aborted", discarding their real errors. Only fetches whose error IS
        // the abort (EABORT_SIGNAL, normalized in fetchWithRetry) are aborted.
        if (err.code === 'EABORT_SIGNAL') {
          aggregator.onAbort(pkg.key);
          return;
        }
        if (pkg.optional) {
          aggregator.onFailed(pkg.key, err);
          return;
        }
        requiredFailures.push({ spec: pkg.spec, err });
        aggregator.onFailed(pkg.key, err);
        ac.abort();
      }
    }));

    renderer.stop();
  }

  if (requiredFailures.length > 0) {
    console.error(`\n  ${chalk.red('✖')}  ${requiredFailures.length} required package(s) failed:`);
    for (const f of requiredFailures) {
      console.error(`     ${f.spec}: ${f.err.message}`);
    }
    // Abort-fast means fetches cancelled by the abort have no observed
    // outcome — they are not failures, but hiding them would understate the
    // blast radius during an outage. Report the count explicitly.
    const abortedCount = aggregator.counts().aborted;
    if (abortedCount > 0) {
      console.error(`     ${abortedCount} other fetch(es) cancelled when the install aborted.`);
    }
    process.exit(1);
  }

  // Step 4b: Re-verify cached tarballs immediately before reify. Closes the
  // TOCTOU window where probe-says-cached + tarball-evicted-by-other-process
  // would surface as a confusing "reify failed" error. fs.access on each
  // path is microseconds; silently re-fetching evicted ones is cheap insurance.
  if (!flags.dryRun && cachedSpecs.size > 0) {
    const cacheDir = resolveCacheDir(pacoteOpts);
    const cachedPkgs = pkgSpecs.filter(p => cachedSpecs.has(p.key));
    await Promise.all(cachedPkgs.map(async pkg => {
      const tarPath = tarballCachePath(cacheDir, pkg.integrity);
      if (!tarPath) return;
      try {
        await fs.promises.access(tarPath, fs.constants.F_OK);
      } catch {
        evictedPkgs.push(pkg);
      }
    }));

    if (evictedPkgs.length > 0) {
      await Promise.all(evictedPkgs.map(async pkg => {
        try {
          const fetchSpec = pkg.resolved || pkg.spec;
          await fetchWithRetry(
            fetchSpec,
            { ...pacoteOpts, integrity: pkg.integrity },
            () => {},
            () => {},
          );
        } catch (refetchErr) {
          // Log warning — reify may fail next if this tarball is truly unavailable.
          // We don't abort here because reify's own pacote call will surface
          // the canonical error with proper context.
          console.error(`  ${chalk.yellow('⚠')}  Re-fetch failed for evicted tarball: ${pkg.spec} (${refetchErr.message})`);
        }
      }));
    }
  }

  // Step 5: Reify (link packages). Cache is warm — explicit pacote pass
  // populated it, and the re-verify step above repaired any post-probe evictions.
  process.stdout.write(`  ${chalk.blue('🔗')}  Linking...\n`);
  try {
    await arb.reify();
  } catch (err) {
    console.error(`npmbar: reify failed: ${err.message}`);
    if (evictedPkgs.length > 0) {
      console.error(`  ${evictedPkgs.length} tarball(s) were re-fetched after cache eviction — this may be the cause.`);
    }
    console.error('  Run `npm install` to attempt recovery.');
    process.exit(1);
  }

  // Step 6: Summary. Install finished — restore default Ctrl-C behavior.
  process.removeListener('SIGINT', onSigint);
  printSummary(aggregator, Date.now() - start, flags);
}

module.exports = install;

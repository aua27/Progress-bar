'use strict';

// Standard performance benchmark: npmbar vs npm, cold + warm cache, against a
// local verdaccio registry (auto-spawned if not already running on :4873).
//
// Usage:
//   node test/perf.js [--runs N] [--large] [--help]
//
// Knobs:
//   --runs N / PERF_RUNS=N   timed runs per tool per regime (default 10; argv wins)
//   --large                  100+ direct-dependency manifest (default: small 31-dep
//                            manifest — keep the small one for CI time budgets)
//   TEST_REGISTRY=<url>      use an existing registry instead of localhost:4873
//                            (no auto-spawn for non-local registries)
//
// Output ends with a machine-readable line for CI:
//   RESULT overhead_pct=<warm> npmbar_median_ms=<a> npm_median_ms=<b> n=<n> ...

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execSync, spawn } = require('child_process');

const DEFAULT_REGISTRY = 'http://localhost:4873';
const REGISTRY = process.env.TEST_REGISTRY || DEFAULT_REGISTRY;
const VERDACCIO_READY_TIMEOUT_MS = 90000;
const THRESHOLD = 0.03;

// --- argv ---------------------------------------------------------------

function usage() {
  console.log(`Usage: node test/perf.js [options]

Options:
  --runs N    timed runs per tool per regime (default: PERF_RUNS env or 10)
  --large     use the 100+ direct-dependency manifest (default: small, for CI)
  --help      show this help

Environment:
  PERF_RUNS=N        same as --runs (argv wins)
  TEST_REGISTRY=url  registry to benchmark against (default ${DEFAULT_REGISTRY};
                     a local verdaccio is auto-spawned if :4873 is not listening)`);
}

function parseArgs(argv) {
  const opts = { runs: process.env.PERF_RUNS ? parseInt(process.env.PERF_RUNS, 10) : 10, large: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a === '--large') opts.large = true;
    else if (a === '--runs') {
      opts.runs = parseInt(argv[++i], 10);
    } else {
      console.error(`Unknown argument: ${a}\n`);
      usage();
      process.exit(1);
    }
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) {
    console.error('--runs / PERF_RUNS must be a positive integer');
    process.exit(1);
  }
  return opts;
}

// --- manifests ------------------------------------------------------------

const SMALL_PKG = {
  name: 'npmbar-perf-test',
  version: '1.0.0',
  dependencies: {
    'express': '^4.18.0',
    'lodash': '^4.17.21',
    'axios': '^1.6.0',
    'chalk': '^4.1.2',
    'commander': '^11.0.0',
    'dotenv': '^16.0.0',
    'moment': '^2.29.4',
    'uuid': '^9.0.0',
    'semver': '^7.5.4',
    'glob': '^10.3.0',
    'minimatch': '^9.0.0',
    'debug': '^4.3.4',
    'ms': '^2.1.3',
    'qs': '^6.11.0',
    'mime': '^3.0.0',
    'bytes': '^3.1.2',
    'on-finished': '^2.4.1',
    'statuses': '^2.0.1',
    'vary': '^1.1.2',
    'cookie': '^0.5.0',
    'accepts': '^1.3.8',
    'negotiator': '^0.6.3',
    'etag': '^1.8.1',
    'fresh': '^0.5.2',
    'range-parser': '^1.2.1',
    'send': '^0.18.0',
    'serve-static': '^1.15.0',
    'finalhandler': '^1.2.0',
    'parseurl': '^1.3.3',
    'path-to-regexp': '^0.1.7',
    'proxy-addr': '^2.0.7',
  },
};

// 120+ direct dependencies, all well-known leaf-ish utility packages.
// Resolved through verdaccio (proxy uplink to npmjs); the untimed seed pass
// populates verdaccio's storage so timed cold runs are network-local.
const LARGE_DEP_NAMES = [
  'accepts', 'ajv', 'ansi-regex', 'ansi-styles', 'anymatch', 'argparse',
  'array-flatten', 'asynckit', 'axios', 'balanced-match', 'binary-extensions',
  'body-parser', 'brace-expansion', 'braces', 'buffer-from', 'bytes',
  'call-bind', 'camelcase', 'chokidar', 'cliui', 'color-convert', 'color-name',
  'combined-stream', 'commander', 'concat-map', 'content-disposition',
  'content-type', 'cookie', 'cookie-signature', 'core-util-is', 'debug',
  'decamelize', 'deep-is', 'define-properties', 'delayed-stream', 'depd',
  'destroy', 'dotenv', 'ee-first', 'emoji-regex', 'encodeurl', 'escape-html',
  'escape-string-regexp', 'etag', 'fast-deep-equal', 'fill-range',
  'finalhandler', 'find-up', 'follow-redirects', 'form-data', 'forwarded',
  'fresh', 'fs-extra', 'function-bind', 'get-intrinsic', 'glob', 'glob-parent',
  'graceful-fs', 'has-flag', 'has-symbols', 'http-errors', 'iconv-lite',
  'inherits', 'ipaddr.js', 'is-binary-path', 'is-extglob',
  'is-fullwidth-code-point', 'is-glob', 'is-number', 'isarray', 'js-yaml',
  'jsonfile', 'kind-of', 'locate-path', 'lodash', 'lru-cache', 'media-typer',
  'merge-descriptors', 'methods', 'micromatch', 'mime', 'mime-db',
  'mime-types', 'minimatch', 'minimist', 'mkdirp', 'moment', 'ms', 'nanoid',
  'negotiator', 'normalize-path', 'object-assign', 'object-inspect',
  'on-finished', 'once', 'p-limit', 'p-locate', 'p-try', 'parseurl',
  'path-exists', 'path-is-absolute', 'path-to-regexp', 'picocolors',
  'picomatch', 'pify', 'proxy-addr', 'punycode', 'qs', 'range-parser',
  'raw-body', 'readable-stream', 'readdirp', 'rimraf', 'safe-buffer',
  'safer-buffer', 'semver', 'send', 'serve-static', 'setprototypeof',
  'side-channel', 'source-map', 'statuses', 'string-width', 'string_decoder',
  'strip-ansi', 'supports-color', 'to-regex-range', 'toidentifier', 'tslib',
  'type-is', 'universalify', 'unpipe', 'util-deprecate', 'utils-merge',
  'uuid', 'vary', 'wrap-ansi', 'wrappy', 'ws', 'xtend', 'yallist', 'yargs',
  'yargs-parser',
];

function largePkg() {
  const deps = {};
  for (const name of LARGE_DEP_NAMES) deps[name] = 'latest';
  return { name: 'npmbar-perf-test-large', version: '1.0.0', dependencies: deps };
}

// --- verdaccio lifecycle ----------------------------------------------------

let verdaccioChild = null;
let verdaccioTmpDir = null;
let verdaccioLog = '';

function isLocalRegistry(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function pingRegistry(url, timeoutMs = 2000) {
  return new Promise(resolve => {
    const req = http.get(`${url.replace(/\/$/, '')}/-/ping`, { timeout: timeoutMs }, res => {
      res.resume();
      resolve(true); // any HTTP response means something is listening
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function killVerdaccio() {
  if (!verdaccioChild || verdaccioChild.killed || verdaccioChild.exitCode !== null) {
    verdaccioChild = null;
    return;
  }
  try {
    if (process.platform === 'win32') {
      // shell:true wraps the real process; kill the whole tree.
      execSync(`taskkill /pid ${verdaccioChild.pid} /T /F`, { stdio: 'ignore' });
    } else {
      verdaccioChild.kill('SIGTERM');
    }
  } catch { /* already gone */ }
  verdaccioChild = null;
}

function cleanupVerdaccio() {
  killVerdaccio();
  if (verdaccioTmpDir) {
    try { fs.rmSync(verdaccioTmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    verdaccioTmpDir = null;
  }
}

function manualInstructions() {
  return [
    'Start verdaccio manually in another terminal and re-run this benchmark:',
    '    npx --yes verdaccio --listen 4873',
    'or point the benchmark at a different registry:',
    "    PowerShell:  $env:TEST_REGISTRY = 'https://registry.npmjs.org'; node test/perf.js",
    '    bash:        TEST_REGISTRY=https://registry.npmjs.org node test/perf.js',
  ].join('\n');
}

async function ensureRegistry() {
  if (await pingRegistry(REGISTRY)) {
    console.log(`Registry already running at ${REGISTRY}`);
    return;
  }
  if (!isLocalRegistry(REGISTRY)) {
    console.error(`✖  Registry ${REGISTRY} is unreachable (set via TEST_REGISTRY; auto-spawn only applies to localhost).`);
    process.exit(1);
  }

  const port = new URL(REGISTRY).port || '4873';
  console.log(`Registry not running at ${REGISTRY} — auto-spawning verdaccio (npx --yes verdaccio)...`);

  verdaccioTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmbar-verdaccio-'));
  const storageDir = path.join(verdaccioTmpDir, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });
  const toYamlPath = p => p.replace(/\\/g, '/'); // backslashes are escapes in YAML double-quoted strings
  const configPath = path.join(verdaccioTmpDir, 'config.yaml');
  fs.writeFileSync(configPath, [
    `storage: "${toYamlPath(storageDir)}"`,
    'auth:',
    '  htpasswd:',
    `    file: "${toYamlPath(path.join(verdaccioTmpDir, 'htpasswd'))}"`,
    'uplinks:',
    '  npmjs:',
    '    url: https://registry.npmjs.org/',
    'packages:',
    "  '**':",
    '    access: $all',
    '    proxy: npmjs',
    'web:',
    '  enable: false',
    'log: { type: stdout, format: pretty, level: warn }',
    '',
  ].join('\n'));

  try {
    verdaccioChild = spawn(`npx --yes verdaccio --config "${configPath}" --listen ${port}`, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    console.error(`✖  Failed to spawn verdaccio: ${err.message}`);
    console.error(manualInstructions());
    cleanupVerdaccio();
    process.exit(1);
  }

  verdaccioChild.stdout.on('data', d => { verdaccioLog = (verdaccioLog + d).slice(-4000); });
  verdaccioChild.stderr.on('data', d => { verdaccioLog = (verdaccioLog + d).slice(-4000); });

  let spawnError = null;
  let exitedEarly = false;
  verdaccioChild.on('error', err => { spawnError = err; });
  verdaccioChild.on('exit', () => { exitedEarly = true; });

  // Kill the child no matter how this process dies.
  process.on('exit', killVerdaccio);
  process.on('SIGINT', () => { cleanupVerdaccio(); process.exit(130); });
  process.on('SIGTERM', () => { cleanupVerdaccio(); process.exit(143); });

  const deadline = Date.now() + VERDACCIO_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError || exitedEarly) {
      console.error(`✖  verdaccio failed to start${spawnError ? `: ${spawnError.message}` : ' (process exited early)'}.`);
      if (verdaccioLog.trim()) console.error(`--- verdaccio output ---\n${verdaccioLog.trim()}\n------------------------`);
      console.error('This usually means npx could not download verdaccio (no network?) or the port is blocked.');
      console.error(manualInstructions());
      cleanupVerdaccio();
      process.exit(1);
    }
    if (await pingRegistry(REGISTRY, 1500)) {
      console.log(`verdaccio is ready at ${REGISTRY} (temp storage: ${verdaccioTmpDir})`);
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.error(`✖  verdaccio did not become ready within ${VERDACCIO_READY_TIMEOUT_MS / 1000}s — giving up (refusing to hang).`);
  if (verdaccioLog.trim()) console.error(`--- verdaccio output ---\n${verdaccioLog.trim()}\n------------------------`);
  console.error(manualInstructions());
  cleanupVerdaccio();
  process.exit(1);
}

// --- run helpers ------------------------------------------------------------

function freshDir(label, pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `npmbar-perf-${label}-`));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  return dir;
}

function runEnv(cacheDir) {
  return {
    ...process.env,
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_cache: cacheDir,
    npm_config_registry: REGISTRY,
    npm_config_progress: 'false',
  };
}

function timedRun(cmd, dir, cacheDir) {
  const start = Date.now();
  execSync(cmd, { cwd: dir, stdio: 'pipe', env: runEnv(cacheDir) });
  return Date.now() - start;
}

function untimedRun(cmd, dir, cacheDir) {
  execSync(cmd, { cwd: dir, stdio: 'pipe', env: runEnv(cacheDir) });
}

// --- statistics ---------------------------------------------------------

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(times) {
  const s = [...times].sort((a, b) => a - b);
  return {
    median: quantile(s, 0.5),
    p25: quantile(s, 0.25),
    p75: quantile(s, 0.75),
    min: s[0],
    max: s[s.length - 1],
  };
}

function fmtStats(label, st) {
  return `${label} median=${Math.round(st.median)}ms  IQR=[${Math.round(st.p25)}..${Math.round(st.p75)}]ms  min=${st.min}ms  max=${st.max}ms`;
}

// --- main -----------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const RUNS = opts.runs;
  const scenario = opts.large ? 'large' : 'small';
  const pkg = opts.large ? largePkg() : SMALL_PKG;

  console.log(`Performance benchmark: ${RUNS} timed runs per tool per regime (cold + warm cache)`);
  console.log(`Scenario: ${scenario} (${Object.keys(pkg.dependencies).length} direct dependencies)`);
  console.log(`Registry: ${REGISTRY}\n`);

  await ensureRegistry();

  const npmbarCmd = `node "${path.resolve(__dirname, '../bin/npmbar.js')}" install`;
  const npmCmd = 'npm install';

  const npmbarCold = [];
  const npmCold = [];
  const npmbarWarm = [];
  const npmWarm = [];

  try {
    // --- Untimed warm-up of BOTH tools ---
    // 1. Populates verdaccio's proxy storage (so timed cold runs are uniform
    //    and network-local instead of paying npmjs latency on run 1 only).
    // 2. Pays the one-time Node startup + JIT + OS file-cache cost for npmbar
    //    that npm doesn't pay, so run 1 doesn't inflate npmbar's numbers.
    console.log('--- Warm-up (untimed, both tools) ---');
    {
      const seedCache = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-cache-'));
      const nDir = freshDir('seed-npm', pkg);
      untimedRun(npmCmd, nDir, seedCache);
      fs.rmSync(nDir, { recursive: true, force: true });
      fs.rmSync(seedCache, { recursive: true, force: true });
      console.log('  npm warm-up complete (verdaccio storage seeded)');

      const xCache = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-cache-x-'));
      const xDir = freshDir('seed-npmbar', pkg);
      untimedRun(npmbarCmd, xDir, xCache);
      fs.rmSync(xDir, { recursive: true, force: true });
      fs.rmSync(xCache, { recursive: true, force: true });
      console.log('  npmbar warm-up complete');
    }

    // --- Cold cache runs (interleaved to cancel out temporal drift) ---
    console.log('\n--- Cold cache runs (interleaved) ---');
    for (let i = 0; i < RUNS; i++) {
      const xCache = fs.mkdtempSync(path.join(os.tmpdir(), 'npmbar-cache-'));
      const xDir = freshDir(`cold-npmbar-${i}`, pkg);
      const xt = timedRun(npmbarCmd, xDir, xCache);
      npmbarCold.push(xt);
      fs.rmSync(xDir, { recursive: true, force: true });
      fs.rmSync(xCache, { recursive: true, force: true });

      const nCache = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-cache-'));
      const nDir = freshDir(`cold-npm-${i}`, pkg);
      const nt = timedRun(npmCmd, nDir, nCache);
      npmCold.push(nt);
      fs.rmSync(nDir, { recursive: true, force: true });
      fs.rmSync(nCache, { recursive: true, force: true });

      process.stdout.write(`  run ${i + 1}: npmbar=${xt}ms  npm=${nt}ms\n`);
    }

    // --- Warm cache runs (shared cache, seeded untimed for both tools) ---
    console.log('\n--- Warm cache runs (interleaved) ---');
    const warmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-cache-'));

    const warmupNpmDir = freshDir('warmup-npm', pkg);
    untimedRun(npmCmd, warmupNpmDir, warmCache);
    fs.rmSync(warmupNpmDir, { recursive: true, force: true });
    const warmupXDir = freshDir('warmup-npmbar', pkg);
    untimedRun(npmbarCmd, warmupXDir, warmCache);
    fs.rmSync(warmupXDir, { recursive: true, force: true });
    console.log('  (warm-up passes complete)');

    for (let i = 0; i < RUNS; i++) {
      const xDir = freshDir(`warm-npmbar-${i}`, pkg);
      const xt = timedRun(npmbarCmd, xDir, warmCache);
      npmbarWarm.push(xt);
      fs.rmSync(xDir, { recursive: true, force: true });

      const nDir = freshDir(`warm-npm-${i}`, pkg);
      const nt = timedRun(npmCmd, nDir, warmCache);
      npmWarm.push(nt);
      fs.rmSync(nDir, { recursive: true, force: true });

      process.stdout.write(`  run ${i + 1}: npmbar=${xt}ms  npm=${nt}ms\n`);
    }

    fs.rmSync(warmCache, { recursive: true, force: true });
  } finally {
    cleanupVerdaccio();
  }

  const xcs = stats(npmbarCold);
  const ncs = stats(npmCold);
  const xws = stats(npmbarWarm);
  const nws = stats(npmWarm);

  console.log('\n--- Results ---');
  console.log(fmtStats('Cold cache:  npmbar', xcs));
  console.log(fmtStats('Cold cache:  npm   ', ncs));
  console.log(fmtStats('Warm cache:  npmbar', xws));
  console.log(fmtStats('Warm cache:  npm   ', nws));

  const coldOverhead = (xcs.median - ncs.median) / ncs.median;
  const warmOverhead = (xws.median - nws.median) / nws.median;
  console.log(`\nCold overhead: ${(coldOverhead * 100).toFixed(2)}%`);
  console.log(`Warm overhead: ${(warmOverhead * 100).toFixed(2)}%`);

  // Machine-readable summary (primary regime = warm cache, where users live).
  console.log(
    `\nRESULT overhead_pct=${(warmOverhead * 100).toFixed(2)} ` +
    `npmbar_median_ms=${Math.round(xws.median)} npm_median_ms=${Math.round(nws.median)} n=${RUNS} ` +
    `regime=warm scenario=${scenario} ` +
    `cold_overhead_pct=${(coldOverhead * 100).toFixed(2)} ` +
    `cold_npmbar_median_ms=${Math.round(xcs.median)} cold_npm_median_ms=${Math.round(ncs.median)}`
  );

  const failures = [];
  if (coldOverhead > THRESHOLD) failures.push(`cold ${(coldOverhead * 100).toFixed(2)}%`);
  if (warmOverhead > THRESHOLD) failures.push(`warm ${(warmOverhead * 100).toFixed(2)}%`);
  if (failures.length) {
    console.error(`✖  Overhead exceeds ${THRESHOLD * 100}% threshold: ${failures.join(', ')}`);
    process.exit(1);
  } else {
    console.log(`✔  Overhead within ${THRESHOLD * 100}% threshold (cold and warm)`);
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  cleanupVerdaccio();
  process.exit(1);
});

'use strict';

// Standard performance benchmark: npmbar vs npm, cold + warm cache, against a
// local verdaccio registry (auto-spawned if not already running on :4873).
//
// Two modes:
//   (default) piped stdio, cold + warm regimes. Measures accounting overhead.
//   --tty     both tools wrapped in a real pseudo-terminal (script(1)), so
//             npmbar's render loop / chalk / ANSI writes genuinely execute
//             during timing. This is the ONLY mode that measures the cost of
//             the redraw loop npm removed its own progress bar over. Linux-only.
//
// Usage:
//   node test/perf.js [--runs N] [--large] [--tty] [--cold-advisory] [--help]
//
// Knobs:
//   --runs N / PERF_RUNS=N   timed runs per tool per regime (default 10; argv wins)
//   --large                  100+ direct-dependency manifest (default: small 31-dep
//                            manifest — keep the small one for CI time budgets)
//   --tty                    PTY rendering benchmark (regime=warm-tty), Linux-only
//   --cold-advisory          cold breach warns instead of failing (warm still gates)
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
  --runs N          timed runs per tool per regime (default: PERF_RUNS env or 10)
  --large           use the 100+ direct-dependency manifest (default: small, for CI)
  --tty             PTY rendering benchmark: run BOTH tools inside a real
                    pseudo-terminal (script(1), util-linux) so npmbar's render
                    loop actually executes during timing. Linux-only; loud-skips
                    elsewhere. Reports regime=warm-tty.
  --cold-advisory   do not fail on a cold-cache breach (warm still gates). Cold
                    is network/IO-variance-dominated and has been observed to
                    breach on unmodified baseline HEAD; used by CI to gate on the
                    warm number (the core constraint) without going red on noise.
  --help            show this help

Environment:
  PERF_RUNS=N        same as --runs (argv wins)
  TEST_REGISTRY=url  registry to benchmark against (default ${DEFAULT_REGISTRY};
                     a local verdaccio is auto-spawned if :4873 is not listening)`);
}

function parseArgs(argv) {
  const opts = {
    runs: process.env.PERF_RUNS ? parseInt(process.env.PERF_RUNS, 10) : 10,
    large: false,
    tty: false,
    coldAdvisory: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a === '--large') opts.large = true;
    else if (a === '--tty') opts.tty = true;
    else if (a === '--cold-advisory') opts.coldAdvisory = true;
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
      // shell:true + npx means verdaccio is a grandchild: kill(child) only
      // reaps the sh wrapper, verdaccio survives holding our stdout/stderr
      // pipes and the event loop never drains (observed as a 90-minute hang
      // on ubuntu runners). detached:true made the child a group leader —
      // signal the whole group (negative pid).
      process.kill(-verdaccioChild.pid, 'SIGTERM');
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
      // POSIX: own process group so killVerdaccio can signal the whole
      // sh → npx → verdaccio tree at once (see killVerdaccio).
      detached: process.platform !== 'win32',
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

// --- PTY harness (--tty mode) -----------------------------------------------
// src/progress.js gates ALL rendering on stdout.isTTY, so a piped benchmark run
// executes the render loop zero times — it proves accounting overhead only, not
// that the redraw loop npm removed its bar over is cheap. To measure rendering
// for real, wrap BOTH tools in a pseudo-terminal via script(1) (util-linux):
// under it the child's stdout is a real PTY, so npmbar's setInterval redraw,
// chalk SGR codes and cursor escapes actually run while we time them.

function commandExists(probe) {
  try { execSync(probe, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// Best-effort: find a WSL distro that can host the PTY benchmark (needs both
// node and script). Used only to print a helpful hint on win32 — never to
// orchestrate a cross-boundary run (temp-dir/cache paths don't translate).
function findWslPtyDistro() {
  let distros;
  try {
    // `wsl --list --quiet` emits UTF-16LE with embedded NULs.
    const raw = execSync('wsl.exe --list --quiet', { stdio: ['ignore', 'pipe', 'ignore'] });
    distros = raw.toString('utf16le').split(/\r?\n/).map(s => s.replace(/\0/g, '').trim()).filter(Boolean);
  } catch { return null; }
  for (const d of distros) {
    try {
      execSync(`wsl.exe -d ${d} sh -c "command -v node && command -v script"`, { stdio: 'ignore' });
      return d;
    } catch { /* distro lacks node or script */ }
  }
  return null;
}

// Under script(1), GitHub's CI=true would still make src/progress.js suppress
// the bar. Strip CI so rendering runs: this makes the child match a developer's
// interactive terminal — the environment the <3% claim is ABOUT — not the CI
// shell. Documented on purpose: we are measuring the rendering path, not hiding it.
function ttyEnv(cacheDir) {
  const env = runEnv(cacheDir);
  delete env.CI;
  return env;
}

// Wrap a command in a PTY via script(1) and time it. Returns { ms, out } where
// `out` is the captured session output (including ANSI escapes). `-q` quiet,
// `-c` run the command, `/dev/null` discards the typescript (we capture stdout).
//
// NOTE: script's --return/-e (propagate child exit status) is UNRELIABLE across
// util-linux versions — on 2.39.x it returns 0 even when the child fails. So we
// do NOT trust the exit code for success; callers must verify the install
// independently via assertInstalled() (below). Otherwise a failed install would
// be silently timed as a success — the exact "silent pass" the gate forbids.
function timedRunPty(innerCmd, dir, cacheDir) {
  const ptyCmd = `script -qc '${innerCmd}' /dev/null`;
  const start = Date.now();
  const out = execSync(ptyCmd, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: ttyEnv(cacheDir) });
  return { ms: Date.now() - start, out: out.toString('latin1') };
}

// Independent success check: both manifests (small + large) declare `lodash`, so
// a completed install must have linked it. Guards against script(1) swallowing a
// nonzero child exit — a failed install then throws instead of being timed.
function assertInstalled(dir, tool) {
  const marker = path.join(dir, 'node_modules', 'lodash', 'package.json');
  if (!fs.existsSync(marker)) {
    throw new Error(`${tool} install under PTY produced no node_modules/lodash — install failed (script(1) can swallow child exit codes). dir=${dir}`);
  }
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

async function runStandard(opts) {
  const RUNS = opts.runs;
  const scenario = opts.large ? 'large' : 'small';
  const pkg = opts.large ? largePkg() : SMALL_PKG;

  console.log(`Performance benchmark: ${RUNS} timed runs per tool per regime (cold + warm cache)`);
  console.log(`Scenario: ${scenario} (${Object.keys(pkg.dependencies).length} direct dependencies)`);
  console.log(`Registry: ${REGISTRY}\n`);

  await ensureRegistry();

  const npmbarCmd = `node "${path.resolve(__dirname, '../bin/npmbar.js')}" install`;
  // Work parity: npmbar never runs audit/fund, so npm must not be charged
  // for those registry round-trips — otherwise the overhead claim is flattered.
  const npmCmd = 'npm install --no-audit --no-fund';

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

  // Warm is the core project constraint (where users live) and always gates.
  // Cold is network/IO-variance-dominated; with --cold-advisory a breach warns
  // instead of failing. CI uses that flag so the required gate keys off the warm
  // number without going red on cold noise (a breach has been reproduced on
  // unmodified baseline HEAD). Local runs default to gating on both.
  const failures = [];
  if (warmOverhead > THRESHOLD) failures.push(`warm ${(warmOverhead * 100).toFixed(2)}%`);
  if (coldOverhead > THRESHOLD) {
    if (opts.coldAdvisory) {
      console.warn(`⚠  ADVISORY: cold overhead ${(coldOverhead * 100).toFixed(2)}% exceeds ${THRESHOLD * 100}% — not gating (see --cold-advisory).`);
    } else {
      failures.push(`cold ${(coldOverhead * 100).toFixed(2)}%`);
    }
  }
  if (failures.length) {
    console.error(`✖  Overhead exceeds ${THRESHOLD * 100}% threshold: ${failures.join(', ')}`);
    process.exit(1);
  } else {
    console.log(`✔  Overhead within ${THRESHOLD * 100}% threshold${opts.coldAdvisory ? ' (warm gated; cold advisory)' : ' (cold and warm)'}`);
  }
}

// --- PTY rendering benchmark (regime=warm-tty) ------------------------------
// Fresh client cache each run FORCES the download path, which is where the
// render loop lives (src/commands/install.js only starts the renderer when
// there are tarballs to download). A fully warm client cache short-circuits
// downloads and would exercise no rendering — so, like the cold loop, we use a
// fresh cache per run against the seeded (network-local) verdaccio.
async function runTty(opts) {
  const RUNS = opts.runs;
  const scenario = opts.large ? 'large' : 'small';
  const pkg = opts.large ? largePkg() : SMALL_PKG;

  // Platform gate: script(1) is util-linux. On anything else, loud-skip with a
  // distinct exit code (3) that CI — which runs this on ubuntu-latest — never hits.
  if (process.platform !== 'linux') {
    console.error('✖  PTY rendering benchmark unsupported natively on Windows/macOS — run in WSL or CI.');
    console.error('   It needs script(1) from util-linux to allocate a pseudo-terminal.');
    if (process.platform === 'win32') {
      const distro = findWslPtyDistro();
      if (distro) {
        console.error(`   A WSL distro with node+script was found ('${distro}'): open it and run \`node test/perf.js --tty\` from the repo checkout.`);
      } else {
        console.error('   No WSL distro with both node and script was found. The Perf workflow runs this on ubuntu-latest.');
      }
    }
    process.exit(3);
  }
  if (!commandExists('command -v script')) {
    console.error('✖  script(1) not found (util-linux). Cannot allocate a PTY. Install util-linux or run in CI.');
    process.exit(3);
  }

  console.log(`PTY rendering benchmark: ${RUNS} timed runs per tool (fresh cache each run → render loop active)`);
  console.log(`Scenario: ${scenario} (${Object.keys(pkg.dependencies).length} direct dependencies)`);
  console.log(`Registry: ${REGISTRY}\n`);

  await ensureRegistry();

  const npmbarInner = `node "${path.resolve(__dirname, '../bin/npmbar.js')}" install`;
  const npmInner = 'npm install --no-audit --no-fund';

  const npmbarT = [];
  const npmT = [];
  let renderProof = '';

  try {
    // Untimed warm-up (in PTY): seeds verdaccio storage so timed runs are
    // network-local, and pays npmbar's one-time Node startup/JIT that npm doesn't.
    console.log('--- Warm-up (untimed, both tools, in PTY) ---');
    {
      const c1 = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-cache-'));
      const d1 = freshDir('seed-npm-tty', pkg);
      timedRunPty(npmInner, d1, c1);
      assertInstalled(d1, 'npm');
      fs.rmSync(d1, { recursive: true, force: true }); fs.rmSync(c1, { recursive: true, force: true });

      const c2 = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-cache-x-'));
      const d2 = freshDir('seed-npmbar-tty', pkg);
      renderProof = timedRunPty(npmbarInner, d2, c2).out;
      assertInstalled(d2, 'npmbar');
      fs.rmSync(d2, { recursive: true, force: true }); fs.rmSync(c2, { recursive: true, force: true });
      console.log('  warm-up complete (verdaccio seeded)');
    }

    // Prove rendering actually happened. A rendering benchmark that never
    // rendered is invalid — refuse to report a number. The cursor-hide escape
    // (\x1b[?25l) is emitted by src/progress.js hideCursor() only on a TTY.
    const CURSOR_HIDE = '\x1b[?25l';
    if (!renderProof.includes(CURSOR_HIDE)) {
      console.error('✖  npmbar emitted no cursor-hide escape under the PTY — rendering did NOT run.');
      console.error('   Refusing to report a rendering number that did not measure rendering.');
      process.exit(1);
    }
    console.log('  ✔  verified rendering ran (cursor-hide escape present in captured PTY output)\n');

    console.log('--- Timed runs (interleaved, fresh cache each run) ---');
    for (let i = 0; i < RUNS; i++) {
      const xCache = fs.mkdtempSync(path.join(os.tmpdir(), 'npmbar-cache-'));
      const xDir = freshDir(`tty-npmbar-${i}`, pkg);
      const xt = timedRunPty(npmbarInner, xDir, xCache).ms;
      assertInstalled(xDir, 'npmbar');
      npmbarT.push(xt);
      fs.rmSync(xDir, { recursive: true, force: true }); fs.rmSync(xCache, { recursive: true, force: true });

      const nCache = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-cache-'));
      const nDir = freshDir(`tty-npm-${i}`, pkg);
      const nt = timedRunPty(npmInner, nDir, nCache).ms;
      assertInstalled(nDir, 'npm');
      npmT.push(nt);
      fs.rmSync(nDir, { recursive: true, force: true }); fs.rmSync(nCache, { recursive: true, force: true });

      process.stdout.write(`  run ${i + 1}: npmbar=${xt}ms  npm=${nt}ms\n`);
    }
  } finally {
    cleanupVerdaccio();
  }

  const xs = stats(npmbarT);
  const ns = stats(npmT);
  console.log('\n--- Results (PTY, rendering active) ---');
  console.log(fmtStats('npmbar', xs));
  console.log(fmtStats('npm   ', ns));

  const overhead = (xs.median - ns.median) / ns.median;
  console.log(`\nRendering overhead (PTY): ${(overhead * 100).toFixed(2)}%`);

  console.log(
    `\nRESULT overhead_pct=${(overhead * 100).toFixed(2)} ` +
    `npmbar_median_ms=${Math.round(xs.median)} npm_median_ms=${Math.round(ns.median)} n=${RUNS} ` +
    `regime=warm-tty scenario=${scenario} rendering=on`
  );

  if (overhead > THRESHOLD) {
    console.error(`✖  Rendering overhead ${(overhead * 100).toFixed(2)}% exceeds ${THRESHOLD * 100}% threshold`);
    process.exit(1);
  }
  console.log(`✔  Rendering overhead within ${THRESHOLD * 100}% threshold`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.tty) return runTty(opts);
  return runStandard(opts);
}

main().then(() => {
  // Exit explicitly: the auto-spawned verdaccio's pipes (and any other stray
  // handle) must not keep the event loop alive after the verdict is printed.
  cleanupVerdaccio();
  process.exit(process.exitCode || 0);
}, err => {
  console.error(err.stack || err.message);
  cleanupVerdaccio();
  process.exit(1);
});

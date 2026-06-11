'use strict';

// Cold-cache perf check: npmbar vs npm, fresh cache per run.
//
// Usage: node test/perf-cold.js [--runs N]
// Knobs: --runs N or PERF_RUNS=N (default 5; argv wins), TEST_REGISTRY=<url>.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const REGISTRY = process.env.TEST_REGISTRY || 'https://registry.npmjs.org';
const THRESHOLD = 0.03;

function parseRuns(argv, def) {
  let runs = process.env.PERF_RUNS ? parseInt(process.env.PERF_RUNS, 10) : def;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') runs = parseInt(argv[++i], 10);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`Usage: node ${path.basename(process.argv[1])} [--runs N]   (default n=${def}; PERF_RUNS env also honored)`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${argv[i]} (supported: --runs N, --help)`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(runs) || runs < 1) {
    console.error('--runs / PERF_RUNS must be a positive integer');
    process.exit(1);
  }
  return runs;
}

const RUNS = parseRuns(process.argv.slice(2), 5);

// Smaller package set for faster cold runs
const TEST_PKG = {
  name: 'npmbar-perf-test',
  version: '1.0.0',
  dependencies: {
    'lodash': '^4.17.21',
    'semver': '^7.5.4',
    'debug': '^4.3.4',
    'ms': '^2.1.3',
  },
};

const npmbarBin = path.resolve(__dirname, '../bin/npmbar.js');
const npmbarCmd = `node "${npmbarBin}" install`;
// Work parity: npmbar never runs audit/fund, so npm must not be charged
// for those registry round-trips — otherwise the overhead claim is flattered.
const npmCmd = `npm install --no-audit --no-fund`;

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmbar-perf-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(TEST_PKG, null, 2));
  return dir;
}

function run(cmd, dir, cacheDir) {
  const env = {
    ...process.env,
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_cache: cacheDir,
    npm_config_registry: REGISTRY,
    npm_config_progress: 'false',
  };
  const start = Date.now();
  execSync(cmd, { cwd: dir, stdio: 'pipe', env });
  return Date.now() - start;
}

function coldRun(cmd, label) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), `perf-cache-${label}-`));
  const dir = freshDir();
  let elapsed = null;
  try {
    elapsed = run(cmd, dir, cache);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  }
  return elapsed;
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(times) {
  const s = [...times].sort((a, b) => a - b);
  return { median: quantile(s, 0.5), p25: quantile(s, 0.25), p75: quantile(s, 0.75), min: s[0], max: s[s.length - 1] };
}

function fmtStats(label, st) {
  return `${label} median=${Math.round(st.median)}ms  IQR=[${Math.round(st.p25)}..${Math.round(st.p75)}]ms  min=${st.min}ms  max=${st.max}ms`;
}

async function main() {
  console.log(`Cold-cache perf check: ${RUNS} runs each (interleaved)`);
  console.log(`Registry: ${REGISTRY}`);
  console.log(`Packages: ${Object.keys(TEST_PKG.dependencies).join(', ')}\n`);

  // Untimed warm-up of BOTH tools: pays the one-time Node startup + JIT +
  // OS file-cache cost so it doesn't land in either tool's first timed run.
  // Caches are throwaway, so the timed runs below are still cache-cold.
  process.stdout.write('Warm-up (untimed, both tools)... ');
  coldRun(npmCmd, 'warmup-n');
  coldRun(npmbarCmd, 'warmup-x');
  process.stdout.write('done\n\n');

  const npmbarTimes = [];
  const npmTimes = [];

  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`run ${i + 1}: npmbar (cold)... `);
    const xt = coldRun(npmbarCmd, 'x');
    npmbarTimes.push(xt);
    process.stdout.write(`${xt}ms\n`);

    process.stdout.write(`run ${i + 1}: npm  (cold)... `);
    const nt = coldRun(npmCmd, 'n');
    npmTimes.push(nt);
    process.stdout.write(`${nt}ms  overhead=${((xt - nt) / nt * 100).toFixed(1)}%\n\n`);
  }

  const xs = stats(npmbarTimes);
  const ns = stats(npmTimes);
  const overhead = (xs.median - ns.median) / ns.median;

  console.log(fmtStats('npmbar:', xs));
  console.log(fmtStats('npm:   ', ns));
  console.log(`Cold-cache overhead: ${(overhead * 100).toFixed(2)}%`);

  console.log(
    `\nRESULT overhead_pct=${(overhead * 100).toFixed(2)} ` +
    `npmbar_median_ms=${Math.round(xs.median)} npm_median_ms=${Math.round(ns.median)} n=${RUNS} ` +
    `regime=cold scenario=small`
  );

  if (overhead > THRESHOLD) {
    console.error(`\nFAIL: ${(overhead * 100).toFixed(2)}% exceeds ${THRESHOLD * 100}% goal`);
    process.exit(1);
  } else {
    console.log(`\nPASS: overhead within ${THRESHOLD * 100}%`);
  }
}

main().catch(err => {
  console.error(err.stack);
  process.exit(1);
});

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const REGISTRY = process.env.TEST_REGISTRY || 'http://localhost:4873';
const RUNS = process.env.PERF_RUNS ? parseInt(process.env.PERF_RUNS, 10) : 10;

const TEST_PKG = {
  name: 'npmx-perf-test',
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

function freshDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `npmx-perf-${label}-`));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(TEST_PKG, null, 2));
  return dir;
}

function timedRun(cmd, dir, cacheDir) {
  const env = { ...process.env, NPM_CONFIG_CACHE: cacheDir, npm_config_registry: REGISTRY };
  const start = Date.now();
  execSync(cmd, { cwd: dir, stdio: 'pipe', env });
  return Date.now() - start;
}

function untimedRun(cmd, dir, cacheDir) {
  const env = { ...process.env, NPM_CONFIG_CACHE: cacheDir, npm_config_registry: REGISTRY };
  execSync(cmd, { cwd: dir, stdio: 'pipe', env });
}

function median(sorted) {
  const n = sorted.length;
  if (n % 2 === 1) return sorted[Math.floor(n / 2)];
  return (sorted[Math.floor(n / 2) - 1] + sorted[Math.floor(n / 2)]) / 2;
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, -1); // discard min and max
  const med = median(trimmed);
  const p95 = trimmed[Math.floor(trimmed.length * 0.95)];
  return { median: med, p95 };
}

async function main() {
  console.log(`Performance test: ${RUNS} runs each, cold and warm cache`);
  console.log(`Registry: ${REGISTRY}\n`);

  const npmxCmd = `node ${path.join(__dirname, '../bin/npmx.js')} install`;
  const npmCmd = `npm install`;

  const npmxCold = [];
  const npmCold = [];
  const npmxWarm = [];
  const npmWarm = [];

  // --- Cold cache runs (interleaved to cancel out temporal bias) ---
  console.log('--- Cold cache runs (interleaved) ---');
  for (let i = 0; i < RUNS; i++) {
    const xCache = fs.mkdtempSync(path.join(os.tmpdir(), 'npmx-cache-'));
    const xDir = freshDir(`cold-npmx-${i}`);
    const xt = timedRun(npmxCmd, xDir, xCache);
    npmxCold.push(xt);
    fs.rmSync(xDir, { recursive: true, force: true });
    fs.rmSync(xCache, { recursive: true, force: true });

    const nCache = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-cache-'));
    const nDir = freshDir(`cold-npm-${i}`);
    const nt = timedRun(npmCmd, nDir, nCache);
    npmCold.push(nt);
    fs.rmSync(nDir, { recursive: true, force: true });
    fs.rmSync(nCache, { recursive: true, force: true });

    process.stdout.write(`  run ${i + 1}: npmx=${xt}ms  npm=${nt}ms\n`);
  }

  // --- Warm cache runs ---
  // One shared cache, seeded with an untimed warm-up pass before the timed runs.
  console.log('\n--- Warm cache runs ---');
  const warmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-cache-'));

  // Warm-up pass (untimed) — populates the cache for both tools
  const warmupDir = freshDir('warmup');
  untimedRun(npmCmd, warmupDir, warmCache);
  fs.rmSync(warmupDir, { recursive: true, force: true });
  console.log('  (warm-up pass complete)');

  // Interleaved timed warm runs
  for (let i = 0; i < RUNS; i++) {
    const xDir = freshDir(`warm-npmx-${i}`);
    const xt = timedRun(npmxCmd, xDir, warmCache);
    npmxWarm.push(xt);
    fs.rmSync(xDir, { recursive: true, force: true });

    const nDir = freshDir(`warm-npm-${i}`);
    const nt = timedRun(npmCmd, nDir, warmCache);
    npmWarm.push(nt);
    fs.rmSync(nDir, { recursive: true, force: true });

    process.stdout.write(`  run ${i + 1}: npmx=${xt}ms  npm=${nt}ms\n`);
  }

  fs.rmSync(warmCache, { recursive: true, force: true });

  const xcs = stats(npmxCold);
  const ncs = stats(npmCold);
  const xws = stats(npmxWarm);
  const nws = stats(npmWarm);

  console.log('\n--- Results ---');
  console.log(`Cold cache:  npmx median=${xcs.median}ms p95=${xcs.p95}ms`);
  console.log(`Cold cache:  npm  median=${ncs.median}ms p95=${ncs.p95}ms`);
  console.log(`Warm cache:  npmx median=${xws.median}ms p95=${xws.p95}ms`);
  console.log(`Warm cache:  npm  median=${nws.median}ms p95=${nws.p95}ms`);

  const overhead = (xcs.median - ncs.median) / ncs.median;
  const warmOverhead = (xws.median - nws.median) / nws.median;
  console.log(`\nCold overhead: ${(overhead * 100).toFixed(2)}%`);
  console.log(`Warm overhead: ${(warmOverhead * 100).toFixed(2)}%`);

  const failures = [];
  if (overhead > 0.03) failures.push(`cold ${(overhead * 100).toFixed(2)}%`);
  if (warmOverhead > 0.03) failures.push(`warm ${(warmOverhead * 100).toFixed(2)}%`);
  if (failures.length) {
    console.error(`✖  Overhead exceeds 3% threshold: ${failures.join(', ')}`);
    process.exit(1);
  } else {
    console.log(`✔  Overhead within 3% threshold (cold and warm)`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

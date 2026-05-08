'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const REGISTRY = process.env.TEST_REGISTRY || 'https://registry.npmjs.org';
const RUNS = parseInt(process.env.PERF_RUNS || '3', 10);

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
    'semver': '^7.5.4',
    'debug': '^4.3.4',
    'ms': '^2.1.3',
    'qs': '^6.11.0',
  },
};

const npmxBin = path.resolve(__dirname, '../bin/npmx.js');
const npmxCmd = `node "${npmxBin}" install`;
const npmCmd = `npm install`;

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmx-perf-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(TEST_PKG, null, 2));
  return dir;
}

function run(cmd, dir, cacheDir) {
  const env = {
    ...process.env,
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_registry: REGISTRY,
    npm_config_progress: 'false',
  };
  const start = Date.now();
  execSync(cmd, { cwd: dir, stdio: 'pipe', env });
  return Date.now() - start;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[Math.floor(n / 2)] : (s[Math.floor(n / 2) - 1] + s[Math.floor(n / 2)]) / 2;
}

async function main() {
  console.log(`Quick perf check: ${RUNS} warm-cache runs each`);
  console.log(`Registry: ${REGISTRY}`);
  console.log(`npmx: ${npmxCmd}\n`);

  const sharedCache = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-cache-'));

  process.stdout.write('Seeding warm cache via npm install (first time, may take 30-60s)...');
  const seedDir = freshDir();
  const seedEnv = { ...process.env, NPM_CONFIG_CACHE: sharedCache, npm_config_registry: REGISTRY, npm_config_progress: 'false' };
  execSync(npmCmd, { cwd: seedDir, stdio: 'pipe', env: seedEnv });
  fs.rmSync(seedDir, { recursive: true, force: true });
  process.stdout.write(' done\n');

  // Untimed npmx warm-up — first npmx run pays a one-time module-load + JIT
  // cost (Node has to read npmx's source from disk and warm the OS file cache).
  // Without this, run 1 looks like 5x overhead vs npm and skews the median.
  process.stdout.write('Warming up npmx (untimed)...');
  const warmupDir = freshDir();
  execSync(npmxCmd, { cwd: warmupDir, stdio: 'pipe', env: seedEnv });
  fs.rmSync(warmupDir, { recursive: true, force: true });
  process.stdout.write(' done\n\n');

  const npmxTimes = [];
  const npmTimes = [];

  for (let i = 0; i < RUNS; i++) {
    const xDir = freshDir();
    const xt = run(npmxCmd, xDir, sharedCache);
    npmxTimes.push(xt);
    fs.rmSync(xDir, { recursive: true, force: true });

    const nDir = freshDir();
    const nt = run(npmCmd, nDir, sharedCache);
    npmTimes.push(nt);
    fs.rmSync(nDir, { recursive: true, force: true });

    const overhead = ((xt - nt) / nt * 100).toFixed(1);
    console.log(`  run ${i + 1}: npmx=${xt}ms  npm=${nt}ms  overhead=${overhead}%`);
  }

  fs.rmSync(sharedCache, { recursive: true, force: true });

  const mNpmx = median(npmxTimes);
  const mNpm = median(npmTimes);
  const overhead = (mNpmx - mNpm) / mNpm;

  console.log(`\nMedian: npmx=${mNpmx}ms  npm=${mNpm}ms`);
  console.log(`Overhead: ${(overhead * 100).toFixed(2)}%`);

  if (overhead > 0.03) {
    console.error(`\nFAIL: ${(overhead * 100).toFixed(2)}% exceeds 3% threshold`);
    process.exit(1);
  } else {
    console.log(`\nPASS: overhead within 3% threshold`);
  }
}

main().catch(err => {
  console.error(err.stack);
  process.exit(1);
});

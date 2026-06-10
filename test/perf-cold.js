'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const REGISTRY = process.env.TEST_REGISTRY || 'https://registry.npmjs.org';
const RUNS = parseInt(process.env.PERF_RUNS || '2', 10);

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
const npmCmd = `npm install`;

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

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[Math.floor(n / 2)] : (s[Math.floor(n / 2) - 1] + s[Math.floor(n / 2)]) / 2;
}

async function main() {
  console.log(`Cold-cache perf check: ${RUNS} runs each (interleaved)`);
  console.log(`Registry: ${REGISTRY}`);
  console.log(`Packages: ${Object.keys(TEST_PKG.dependencies).join(', ')}\n`);

  const npmbarTimes = [];
  const npmTimes = [];

  for (let i = 0; i < RUNS; i++) {
    const xCache = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-cache-x-'));
    const xDir = freshDir();
    process.stdout.write(`run ${i + 1}: npmbar (cold)... `);
    const xt = run(npmbarCmd, xDir, xCache);
    npmbarTimes.push(xt);
    fs.rmSync(xDir, { recursive: true, force: true });
    fs.rmSync(xCache, { recursive: true, force: true });
    process.stdout.write(`${xt}ms\n`);

    const nCache = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-cache-n-'));
    const nDir = freshDir();
    process.stdout.write(`run ${i + 1}: npm  (cold)... `);
    const nt = run(npmCmd, nDir, nCache);
    npmTimes.push(nt);
    fs.rmSync(nDir, { recursive: true, force: true });
    fs.rmSync(nCache, { recursive: true, force: true });
    process.stdout.write(`${nt}ms  overhead=${((xt - nt) / nt * 100).toFixed(1)}%\n\n`);
  }

  const mNpmbar = median(npmbarTimes);
  const mNpm = median(npmTimes);
  const overhead = (mNpmbar - mNpm) / mNpm;

  console.log(`Median: npmbar=${mNpmbar}ms  npm=${mNpm}ms`);
  console.log(`Cold-cache overhead: ${(overhead * 100).toFixed(2)}%`);

  if (overhead > 0.03) {
    console.error(`\nFAIL: ${(overhead * 100).toFixed(2)}% exceeds 3% goal`);
    process.exit(1);
  } else {
    console.log(`\nPASS: overhead within 3%`);
  }
}

main().catch(err => {
  console.error(err.stack);
  process.exit(1);
});

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const GLOBAL_MODE = process.argv.includes('--global');
const REGISTRY = process.env.TEST_REGISTRY || 'https://registry.npmjs.org';

const TEST_PKG = {
  name: 'npmbar-correctness-test',
  version: '1.0.0',
  dependencies: { express: '^4.18.0' },
};

function deepSortedEqual(a, b, keyPath = '') {
  if (typeof a !== typeof b) throw new Error(`Type mismatch at ${keyPath}: ${typeof a} vs ${typeof b}`);
  if (a === null || b === null) {
    if (a !== b) throw new Error(`Null mismatch at ${keyPath}`);
    return;
  }
  if (typeof a !== 'object') {
    if (a !== b) throw new Error(`Value mismatch at ${keyPath}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) throw new Error(`Array/object mismatch at ${keyPath}`);
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) {
    const missing = aKeys.filter(k => !bKeys.includes(k));
    const extra = bKeys.filter(k => !aKeys.includes(k));
    throw new Error(`Key mismatch at ${keyPath}: missing=[${missing}] extra=[${extra}]`);
  }
  for (const k of aKeys) deepSortedEqual(a[k], b[k], `${keyPath}.${k}`);
}

function freshDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `npmbar-test-${label}-`));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(TEST_PKG, null, 2));
  return dir;
}

function runInstall(cmd, dir) {
  execSync(cmd, {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_registry: REGISTRY },
  });
}

function readLock(dir, file = 'package-lock.json') {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  if (GLOBAL_MODE) {
    console.log('Running global install parity test\n');

    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'npmbar-test-npmbar-global-'));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'npmbar-test-npm-global-'));
    const prefix1 = path.join(dir1, 'prefix');
    const prefix2 = path.join(dir2, 'prefix');
    fs.mkdirSync(prefix1, { recursive: true });
    fs.mkdirSync(prefix2, { recursive: true });

    try {
      runInstall(`node ${path.join(__dirname, '../bin/npmbar.js')} install -g cowsay --prefix ${prefix1}`, dir1);
      runInstall(`npm install -g cowsay --prefix ${prefix2}`, dir2);

      // Check 1: prefix layout — lib/node_modules/cowsay exists
      const npmbarCowsay = path.join(prefix1, 'lib', 'node_modules', 'cowsay');
      const npmCowsay = path.join(prefix2, 'lib', 'node_modules', 'cowsay');
      if (!fs.existsSync(npmbarCowsay)) throw new Error(`npmbar: cowsay not found at ${npmbarCowsay}`);
      if (!fs.existsSync(npmCowsay)) throw new Error(`npm: cowsay not found at ${npmCowsay}`);
      console.log('✔  Prefix layout: lib/node_modules/cowsay present');

      // Check 2: bin shim exists and is executable
      const cowsayBin = path.join(prefix1, 'bin', 'cowsay');
      if (!fs.existsSync(cowsayBin)) throw new Error(`npmbar: cowsay bin not found at ${cowsayBin}`);
      execSync(`"${cowsayBin}" hello`, { stdio: 'pipe' });
      console.log('✔  Bin shim: cowsay hello exits 0');

      // Check 3: package is resolvable from the global prefix
      execSync(`node -e "require('cowsay')"`, {
        env: { ...process.env, NODE_PATH: path.join(prefix1, 'lib', 'node_modules') },
        stdio: 'pipe',
      });
      console.log('✔  Package visibility: require("cowsay") resolves from global prefix');
    } finally {
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
    return;
  }

  console.log('Running correctness comparison: npmbar install vs npm install\n');

  const npmbarDir = freshDir('npmbar');
  const npmDir = freshDir('npm');

  try {
    console.log('→ Running npmbar install...');
    runInstall(`node ${path.join(__dirname, '../bin/npmbar.js')} install`, npmbarDir);

    console.log('→ Running npm install...');
    runInstall(`npm install`, npmDir);

    // Primary: full semantic lockfile comparison
    const npmbarLock = readLock(npmbarDir);
    const npmLock = readLock(npmDir);
    if (!npmbarLock) throw new Error('npmbar did not produce package-lock.json');
    if (!npmLock) throw new Error('npm did not produce package-lock.json');

    console.log('\n→ Comparing package-lock.json semantically...');
    deepSortedEqual(npmbarLock, npmLock);
    console.log('✔  package-lock.json: semantically identical');

    // Secondary: node_modules/.package-lock.json comparison
    const npmbarInternalLock = readLock(npmbarDir, path.join('node_modules', '.package-lock.json'));
    const npmInternalLock = readLock(npmDir, path.join('node_modules', '.package-lock.json'));
    if (npmbarInternalLock && npmInternalLock) {
      console.log('\n→ Comparing node_modules/.package-lock.json semantically...');
      deepSortedEqual(npmbarInternalLock, npmInternalLock);
      console.log('✔  node_modules/.package-lock.json: semantically identical');
    } else {
      console.log('⚠  node_modules/.package-lock.json: skipped (one or both missing)');
    }

    // Smoke test
    console.log('\n→ Smoke test: require("express")...');
    execSync(`node -e "require('express')"`, { cwd: npmbarDir, stdio: 'inherit' });
    console.log('✔  Smoke test passed');

    console.log('\nAll correctness checks passed.');
  } finally {
    fs.rmSync(npmbarDir, { recursive: true, force: true });
    fs.rmSync(npmDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

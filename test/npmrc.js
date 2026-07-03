'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readNpmrcRegistry, resolveRegistry } = require('../src/npmrc');

let passed = 0;
let failed = 0;

console.log('\nnpmrc registry-resolution tests\n');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✔  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✖  ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

function tmpDirWith(npmrcContents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmbar-npmrc-'));
  if (npmrcContents !== null) {
    fs.writeFileSync(path.join(dir, '.npmrc'), npmrcContents);
  }
  return dir;
}

// Snapshot + restore the env var each test touches so ordering can't leak state.
function withEnv(value, fn) {
  const prev = process.env.npm_config_registry;
  if (value === undefined) delete process.env.npm_config_registry;
  else process.env.npm_config_registry = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = prev;
  }
}

test('readNpmrcRegistry reads registry from a project .npmrc', () => {
  const dir = tmpDirWith('registry=https://npmrc.example/\n');
  assert.strictEqual(readNpmrcRegistry(dir), 'https://npmrc.example/');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readNpmrcRegistry ignores unrelated keys and comments', () => {
  const dir = tmpDirWith('; a comment\nsave-exact=true\nregistry=http://local:4873/\n');
  assert.strictEqual(readNpmrcRegistry(dir), 'http://local:4873/');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readNpmrcRegistry returns undefined when project .npmrc has no registry', () => {
  // Relies on the test machine's ~/.npmrc having no registry line (CI: none).
  const dir = tmpDirWith('save-exact=true\n');
  assert.strictEqual(readNpmrcRegistry(dir), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readNpmrcRegistry survives a malformed .npmrc without throwing', () => {
  const dir = tmpDirWith('this is not = valid = ini [[[\n');
  // Must not throw; result may be undefined or a best-effort parse — either is fine.
  assert.doesNotThrow(() => readNpmrcRegistry(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveRegistry: --registry flag wins over env and .npmrc', () => {
  const dir = tmpDirWith('registry=https://npmrc.example/\n');
  withEnv('https://env.example/', () => {
    assert.strictEqual(resolveRegistry('https://flag.example/', dir), 'https://flag.example/');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveRegistry: env wins over .npmrc when no flag', () => {
  const dir = tmpDirWith('registry=https://npmrc.example/\n');
  withEnv('https://env.example/', () => {
    assert.strictEqual(resolveRegistry(undefined, dir), 'https://env.example/');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveRegistry: .npmrc used when no flag and no env', () => {
  const dir = tmpDirWith('registry=https://npmrc.example/\n');
  withEnv(undefined, () => {
    assert.strictEqual(resolveRegistry(undefined, dir), 'https://npmrc.example/');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveRegistry: undefined when nothing configured', () => {
  const dir = tmpDirWith('save-exact=true\n');
  withEnv(undefined, () => {
    assert.strictEqual(resolveRegistry(undefined, dir), undefined);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

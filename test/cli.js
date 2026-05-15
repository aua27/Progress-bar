'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const BIN = path.resolve(__dirname, '../bin/npmx.js');

let passed = 0;
let failed = 0;

console.log('\nCLI flag tests\n');

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

// Unknown flag must exit 1 and name the offending flag without starting an install.
test('unknown flag exits 1 and names the offending flag', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', 'react', '--unknown-flag'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.ok(
    result.stderr.includes('--unknown-flag'),
    `expected stderr to mention --unknown-flag, got: ${result.stderr}`,
  );
});

// Unknown flag must list the supported flags so the user knows what's allowed.
test('unknown flag error lists supported flags', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', 'react', '--unknown-flag'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ok(
    result.stderr.includes('--save-dev'),
    `expected stderr to include allowlist, got: ${result.stderr}`,
  );
});

// --version must print the version from package.json, not a hardcoded string.
test('--version reads from package.json', () => {
  const pkg = require('../package.json');
  const result = spawnSync(process.execPath, [BIN, '--version'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ok(
    result.stdout.trim() === pkg.version || result.stderr.trim() === pkg.version,
    `expected version ${pkg.version}, got stdout="${result.stdout.trim()}" stderr="${result.stderr.trim()}"`,
  );
});

// Conflicting save flags must exit 1 — silently dropping one would mask user intent.
test('--save-dev with --save-optional exits 1', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', 'react', '--save-dev', '--save-optional'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.ok(
    result.stderr.includes('conflicting flags'),
    `expected stderr to mention conflicting flags, got: ${result.stderr}`,
  );
});

test('--save-dev with --no-save exits 1', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', 'react', '--save-dev', '--no-save'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.ok(
    result.stderr.includes('conflicting flags'),
    `expected stderr to mention conflicting flags, got: ${result.stderr}`,
  );
});

test('--workspace with --workspaces exits 1', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', '--workspace', 'pkg-a', '--workspaces'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.ok(
    result.stderr.includes('conflicting flags'),
    `expected stderr to mention conflicting flags, got: ${result.stderr}`,
  );
});

// --save-prod conflicts with other save flags.
test('--save-prod with --save-dev exits 1', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', 'react', '--save-prod', '--save-dev'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.ok(
    result.stderr.includes('conflicting flags'),
    `expected stderr to mention conflicting flags, got: ${result.stderr}`,
  );
});

// --omit with an invalid value must exit 1.
test('--omit with invalid value exits 1', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', '--omit', 'nonsense'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.ok(
    result.stderr.includes("invalid --omit value"),
    `expected stderr to mention invalid --omit value, got: ${result.stderr}`,
  );
});

// --include with an invalid value must exit 1.
test('--include with invalid value exits 1', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', '--include', 'nonsense'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.ok(
    result.stderr.includes("invalid --include value"),
    `expected stderr to mention invalid --include value, got: ${result.stderr}`,
  );
});

// The supported-flags message must list all new flags.
test('unknown flag error lists new flags (--ignore-scripts, --omit, --registry)', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', '--bad-flag'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ok(result.stderr.includes('--ignore-scripts'), `missing --ignore-scripts in flag list`);
  assert.ok(result.stderr.includes('--omit'), `missing --omit in flag list`);
  assert.ok(result.stderr.includes('--registry'), `missing --registry in flag list`);
  assert.ok(result.stderr.includes('--prefer-offline'), `missing --prefer-offline in flag list`);
});

// BUG-004: --workspace with empty string must be rejected
test('--workspace with empty string exits 1', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', '--workspace', ''], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.ok(
    result.stderr.includes('workspace'),
    `expected workspace error, got: ${result.stderr}`,
  );
});

// BUG-005: --save accepted as valid no-op flag
test('--save accepted as valid flag (no unknown-flag error)', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', '--save', '--dry-run'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ok(
    !result.stderr.includes('unknown flag'),
    `--save should be recognized, got stderr: ${result.stderr}`,
  );
});

// BUG-005: --package-lock accepted as valid no-op flag
test('--package-lock accepted as valid flag (no unknown-flag error)', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', '--package-lock', '--dry-run'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ok(
    !result.stderr.includes('unknown flag'),
    `--package-lock should be recognized, got stderr: ${result.stderr}`,
  );
});

// BUG-009: flag-like args after -- separator give a clear error
test('package names starting with - give clear error', () => {
  const result = spawnSync(process.execPath, [BIN, 'install', '--', 'react', '--dry-run'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.ok(
    result.stderr.includes('--dry-run') || result.stderr.includes('invalid package name'),
    `expected clear error about flag-like arg, got: ${result.stderr}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { probeAll, tarballCachePath, mapLimit } = require('../src/cache-probe');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

console.log('\nCache-probe unit tests\n');

// --- mapLimit ---------------------------------------------------------------

test('mapLimit: results are correct and in input order', async () => {
  const items = [5, 1, 4, 2, 3];
  // Reverse-sorted delays so completion order differs from input order.
  const out = await mapLimit(items, 2, async (n) => {
    await new Promise(r => setTimeout(r, n * 5));
    return n * 10;
  });
  assert.deepStrictEqual(out, [50, 10, 40, 20, 30]);
});

test('mapLimit: concurrency never exceeds the limit', async () => {
  let active = 0;
  let maxActive = 0;
  await mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
  });
  assert.ok(maxActive <= 3, `expected at most 3 concurrent, saw ${maxActive}`);
  assert.ok(maxActive > 1, `expected some parallelism, saw ${maxActive}`);
});

test('mapLimit: empty input resolves to empty array', async () => {
  assert.deepStrictEqual(await mapLimit([], 8, async () => 1), []);
});

test('mapLimit: limit larger than input still processes every item', async () => {
  const out = await mapLimit([1, 2], 16, async (n) => n + 1);
  assert.deepStrictEqual(out, [2, 3]);
});

// --- probeAll ---------------------------------------------------------------

// Build a real integrity string and seed the corresponding cacache blob path.
function seedTarball(cacheDir, content) {
  const digest = crypto.createHash('sha512').update(content).digest('base64');
  const integrity = `sha512-${digest}`;
  const blobPath = tarballCachePath(cacheDir, integrity);
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(blobPath, content);
  return integrity;
}

test('probeAll: seeded tarball reports cached, missing one does not', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmbar-probe-'));
  try {
    const seeded = seedTarball(cacheDir, 'tarball-bytes');
    const missing = `sha512-${crypto.createHash('sha512').update('absent').digest('base64')}`;
    const specs = [
      { key: 'a', spec: 'a@1.0.0', integrity: seeded },
      { key: 'b', spec: 'b@1.0.0', integrity: missing },
    ];
    const { likelyCached, cachedSpecs } = await probeAll(specs, { cache: cacheDir });
    assert.strictEqual(likelyCached, 1);
    assert.ok(cachedSpecs.has('a'));
    assert.ok(!cachedSpecs.has('b'));
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('probeAll: no-integrity specs fall back to manifest and report uncached on an empty cache', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmbar-probe-'));
  try {
    // 20 fallback specs exercise the capped worker pool (MANIFEST_CONCURRENCY=8)
    // with more items than workers; offline manifest misses on an empty cache.
    const specs = Array.from({ length: 20 }, (_, i) => ({
      key: `pkg-${i}`, spec: `pkg-${i}@1.0.0`, integrity: null,
    }));
    const { likelyCached, cachedSpecs } = await probeAll(specs, { cache: cacheDir });
    assert.strictEqual(likelyCached, 0);
    assert.strictEqual(cachedSpecs.size, 0);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('probeAll: mixed integrity and fallback specs keep per-spec results aligned', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmbar-probe-'));
  try {
    const seeded = seedTarball(cacheDir, 'mixed-tarball');
    const specs = [
      { key: 'fallback-1', spec: 'fallback-1@1.0.0', integrity: null },
      { key: 'hit', spec: 'hit@1.0.0', integrity: seeded },
      { key: 'fallback-2', spec: 'fallback-2@1.0.0', integrity: null },
    ];
    const { likelyCached, cachedSpecs } = await probeAll(specs, { cache: cacheDir });
    assert.strictEqual(likelyCached, 1);
    assert.ok(cachedSpecs.has('hit'));
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✔  ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✖  ${name}`);
      console.log(`     ${err.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();

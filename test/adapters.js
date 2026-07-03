'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const ArboristAdapter = require('../src/adapters/arborist');

let passed = 0;
let failed = 0;

console.log('\nAdapter unit tests\n');

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

// Build an adapter whose ideal tree is a hand-crafted inventory, so
// extractPackageSpecs() can be exercised without a network or real resolve.
function adapterWithNodes(nodes) {
  const adapter = new ArboristAdapter({ path: __dirname });
  adapter._idealTree = {
    inventory: new Map(nodes.map((n, i) => [`node-${i}`, n])),
  };
  return adapter;
}

function node(overrides = {}) {
  return {
    isRoot: false,
    name: 'dep-x',
    version: '1.0.0',
    resolved: 'https://registry.example/dep-x/-/dep-x-1.0.0.tgz',
    integrity: 'sha512-abc',
    optional: false,
    package: { dist: { size: 1234 } },
    ...overrides,
  };
}

// `optional` belongs to the dependency edge, not the tarball. If any occurrence
// of a resolved URL is required, the deduped spec must be required — otherwise
// a required fetch failure is silently swallowed as optional.
test('dedup: required-then-optional duplicate stays required', () => {
  const adapter = adapterWithNodes([
    node({ optional: false }),
    node({ optional: true }),
  ]);
  const specs = adapter.extractPackageSpecs();
  assert.strictEqual(specs.length, 1);
  assert.strictEqual(specs[0].optional, false);
});

test('dedup: optional-then-required duplicate stays required (order-independent)', () => {
  const adapter = adapterWithNodes([
    node({ optional: true }),
    node({ optional: false }),
  ]);
  const specs = adapter.extractPackageSpecs();
  assert.strictEqual(specs.length, 1);
  assert.strictEqual(specs[0].optional, false);
});

test('dedup: duplicate optional on every edge stays optional', () => {
  const adapter = adapterWithNodes([
    node({ optional: true }),
    node({ optional: true }),
    node({ optional: true }),
  ]);
  const specs = adapter.extractPackageSpecs();
  assert.strictEqual(specs.length, 1);
  assert.strictEqual(specs[0].optional, true);
});

test('dedup: distinct resolved URLs produce one spec each with own optionality', () => {
  const adapter = adapterWithNodes([
    node({ name: 'a', resolved: 'https://registry.example/a.tgz', optional: false }),
    node({ name: 'b', resolved: 'https://registry.example/b.tgz', optional: true }),
  ]);
  const specs = adapter.extractPackageSpecs();
  assert.strictEqual(specs.length, 2);
  const byName = Object.fromEntries(specs.map(s => [s.name, s]));
  assert.strictEqual(byName.a.optional, false);
  assert.strictEqual(byName.b.optional, true);
});

test('dedup: root and unresolved nodes are skipped', () => {
  const adapter = adapterWithNodes([
    node({ isRoot: true, resolved: 'https://registry.example/root.tgz' }),
    node({ resolved: null }),
    node({ resolved: undefined }),
    node({ resolved: 'https://registry.example/real.tgz' }),
  ]);
  const specs = adapter.extractPackageSpecs();
  assert.strictEqual(specs.length, 1);
  assert.strictEqual(specs[0].resolved, 'https://registry.example/real.tgz');
});

test('dedup: first occurrence supplies spec fields (name, integrity, distSize)', () => {
  const adapter = adapterWithNodes([
    node({ optional: true, integrity: 'sha512-first', package: { dist: { size: 42 } } }),
    node({ optional: false, integrity: 'sha512-second', package: { dist: { size: 99 } } }),
  ]);
  const specs = adapter.extractPackageSpecs();
  assert.strictEqual(specs.length, 1);
  assert.strictEqual(specs[0].integrity, 'sha512-first');
  assert.strictEqual(specs[0].distSize, 42);
  assert.strictEqual(specs[0].optional, false, 'optional must still be ANDed');
});

// --- Registry + cache bridging (the config standalone arborist doesn't load) ---

// Snapshot/restore the two env vars these tests mutate so they can't leak.
function withEnv(vars, fn) {
  const keys = ['npm_config_registry', 'npm_config_cache'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('registry: --registry flag wins over npm_config_registry env', () => {
  withEnv({ npm_config_registry: 'https://env.example/', npm_config_cache: undefined }, () => {
    const adapter = new ArboristAdapter({ path: __dirname, registry: 'https://flag.example/' });
    assert.strictEqual(adapter.opts.registry, 'https://flag.example/');
  });
});

test('registry: npm_config_registry env is honored when no flag', () => {
  withEnv({ npm_config_registry: 'http://localhost:4873/', npm_config_cache: undefined }, () => {
    const adapter = new ArboristAdapter({ path: __dirname });
    assert.strictEqual(adapter.opts.registry, 'http://localhost:4873/');
  });
});

test('cache: npm_config_cache env is normalized to the _cacache root', () => {
  const raw = path.join(os.tmpdir(), 'npmbar-cache-test');
  withEnv({ npm_config_cache: raw, npm_config_registry: undefined }, () => {
    const adapter = new ArboristAdapter({ path: __dirname });
    assert.strictEqual(adapter.opts.cache, path.join(raw, '_cacache'));
  });
});

test('cache: a path already ending in _cacache is not double-appended', () => {
  const withCacache = path.join(os.tmpdir(), 'npmbar-cache-test', '_cacache');
  withEnv({ npm_config_cache: withCacache, npm_config_registry: undefined }, () => {
    const adapter = new ArboristAdapter({ path: __dirname });
    assert.strictEqual(adapter.opts.cache, withCacache);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

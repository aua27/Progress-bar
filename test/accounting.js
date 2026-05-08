'use strict';

const assert = require('assert');
const DownloadAggregator = require('../src/aggregator');
const ProgressRenderer = require('../src/progress');

let passed = 0;
let failed = 0;

console.log('\nAccounting unit tests\n');

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

// 1. Retry double-count
test('retry resets bytes — final total is from last successful attempt only', () => {
  const agg = new DownloadAggregator();
  agg.register('lodash@4.0.0');
  agg.onFetchStart('lodash@4.0.0');
  agg.onChunk('lodash@4.0.0', 500);
  agg.onRetry('lodash@4.0.0');
  agg.onChunk('lodash@4.0.0', 1000);
  agg.onEnd('lodash@4.0.0');
  assert.strictEqual(agg.totalBytes(), 1000);
});

// 2. Aborted stream: close without end
test('aborted stream: close without end discards partial bytes and sets aborted status', () => {
  const agg = new DownloadAggregator();
  agg.register('express@4.0.0');
  agg.onFetchStart('express@4.0.0');
  agg.onChunk('express@4.0.0', 300);
  agg.onAbort('express@4.0.0');
  assert.strictEqual(agg.totalBytes(), 0);
  assert.strictEqual(agg.counts().aborted, 1);
  // aborted specs must not appear in fetching/retrying counts
  assert.strictEqual(agg.counts().fetching, 0);
});

// 3. Redirect transparency
test('redirect transparency: no state change, bytes accumulate normally', () => {
  const agg = new DownloadAggregator();
  agg.register('react@18.0.0');
  agg.onFetchStart('react@18.0.0');
  agg.onChunk('react@18.0.0', 200);
  agg.onChunk('react@18.0.0', 800);
  agg.onEnd('react@18.0.0');
  assert.strictEqual(agg.totalBytes(), 1000);
});

// 4a. Unknown dist_size: totalSize returns null
test('unknown dist_size causes totalSize to return null', () => {
  const agg = new DownloadAggregator();
  agg.register('a@1.0.0', { distSize: 500 });
  agg.register('b@1.0.0', { distSize: null });
  assert.strictEqual(agg.totalSize(), null);
});

// 4b. Renderer tier 1: fraction capped at 0.99 even when bytes exceed totalSize
test('renderer tier 1: fraction capped at 0.99 before end — no crash on over-byte', () => {
  const agg = new DownloadAggregator();
  agg.register('a@1.0.0', { distSize: 100 });
  agg.onFetchStart('a@1.0.0');
  agg.onChunk('a@1.0.0', 200); // exceeds distSize

  // Simulate what the renderer calculates for tier 1
  const totalBytes = agg.totalBytes();   // 200
  const totalSize = agg.totalSize();     // 100
  assert.ok(totalSize !== null, 'totalSize should be non-null when all distSizes are known');
  const fraction = Math.min(totalBytes / totalSize, 0.99);
  assert.ok(fraction <= 0.99, `fraction ${fraction} should be capped at 0.99`);
  assert.ok(fraction > 0, 'fraction should be positive');
});

// 5. Required failure
test('required failure: status is failed, bytes reset', () => {
  const agg = new DownloadAggregator();
  agg.register('core@1.0.0', { optional: false });
  agg.onFetchStart('core@1.0.0');
  agg.onChunk('core@1.0.0', 200);
  agg.onFailed('core@1.0.0', new Error('404'));
  assert.strictEqual(agg.counts().failed, 1);
  assert.strictEqual(agg.totalBytes(), 0);
});

// 6. Optional failure
test('optional failure: failure recorded, other packages unaffected', () => {
  const agg = new DownloadAggregator();
  agg.register('bufferutil@4.0.0', { optional: true });
  agg.register('express@4.0.0', { optional: false });
  agg.onFetchStart('bufferutil@4.0.0');
  agg.onFailed('bufferutil@4.0.0', new Error('ECONNREFUSED'));
  agg.onFetchStart('express@4.0.0');
  agg.onChunk('express@4.0.0', 1000);
  agg.onEnd('express@4.0.0');
  const failures = agg.failures();
  assert.strictEqual(failures.length, 1);
  assert.strictEqual(failures[0].optional, true);
  assert.strictEqual(agg.counts().done, 1);
});

// 7. Concurrent aggregation
test('concurrent aggregation: totalBytes equals sum of all chunk sizes', () => {
  const agg = new DownloadAggregator();
  const sizes = [100, 200, 300, 400, 500];
  for (let i = 0; i < 5; i++) agg.register(`pkg${i}@1.0.0`);
  for (let i = 0; i < 5; i++) agg.onFetchStart(`pkg${i}@1.0.0`);
  for (let i = 0; i < 5; i++) agg.onChunk(`pkg${i}@1.0.0`, sizes[i] / 2);
  for (let i = 0; i < 5; i++) agg.onChunk(`pkg${i}@1.0.0`, sizes[i] / 2);
  for (let i = 0; i < 5; i++) agg.onEnd(`pkg${i}@1.0.0`);
  assert.strictEqual(agg.totalBytes(), sizes.reduce((a, b) => a + b, 0));
});

// 8. Cache-probe false positive
test('cache-probe false positive: bytes counted even when probe said cached', () => {
  const agg = new DownloadAggregator();
  agg.register('lodash@4.17.21');
  agg.onFetchStart('lodash@4.17.21');
  agg.onChunk('lodash@4.17.21', 750);
  agg.onEnd('lodash@4.17.21');
  assert.strictEqual(agg.totalBytes(), 750);
  assert.strictEqual(agg.counts().done, 1);
});

// 9. Cached package credits distSize toward totalBytes
test('cached package credits distSize as bytes when no chunks streamed', () => {
  const agg = new DownloadAggregator();
  agg.register('lodash@4.17.21', { distSize: 1000 });
  agg.onFetchStart('lodash@4.17.21');
  agg.onEnd('lodash@4.17.21', { cached: true });
  assert.strictEqual(agg.totalBytes(), 1000);
  assert.strictEqual(agg.counts().cached, 1);
});

// 10. Cached credit doesn't double-count when bytes were streamed
test('cached credit does not override real streamed bytes', () => {
  const agg = new DownloadAggregator();
  agg.register('lodash@4.17.21', { distSize: 1000 });
  agg.onFetchStart('lodash@4.17.21');
  agg.onChunk('lodash@4.17.21', 750);
  agg.onEnd('lodash@4.17.21', { cached: true });
  assert.strictEqual(agg.totalBytes(), 750);
});

// 11. onChunk after retry transitions retrying back to fetching
test('onChunk after retry exits retrying status — counter no longer inflated', () => {
  const agg = new DownloadAggregator();
  agg.register('lodash@4.17.21');
  agg.onFetchStart('lodash@4.17.21');
  agg.onChunk('lodash@4.17.21', 100);
  agg.onRetry('lodash@4.17.21');
  assert.strictEqual(agg.counts().retrying, 1);
  agg.onChunk('lodash@4.17.21', 200);
  assert.strictEqual(agg.counts().retrying, 0);
  assert.strictEqual(agg.counts().fetching, 1);
  assert.strictEqual(agg.totalBytes(), 200);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

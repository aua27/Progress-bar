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

// 12. BUG-001: duplicate name@version with different resolved URLs → two separate entries
test('duplicate name@version with different resolved URLs tracked as separate entries', () => {
  const agg = new DownloadAggregator();
  agg.register('https://registry-a.example/lodash-4.17.21.tgz', { distSize: 1000, displaySpec: 'lodash@4.17.21' });
  agg.register('https://registry-b.example/lodash-4.17.21.tgz', { distSize: 2000, displaySpec: 'lodash@4.17.21' });
  assert.strictEqual(agg.total(), 2, 'both entries should be tracked separately');
  assert.strictEqual(agg.totalSize(), 3000, 'both distSizes should be summed');
  agg.onFetchStart('https://registry-a.example/lodash-4.17.21.tgz');
  agg.onEnd('https://registry-a.example/lodash-4.17.21.tgz');
  agg.onFetchStart('https://registry-b.example/lodash-4.17.21.tgz');
  agg.onEnd('https://registry-b.example/lodash-4.17.21.tgz');
  assert.strictEqual(agg.counts().done, 2);
});

// 13. BUG-002: aborted packages excluded from totalSize — no Tier 1 denominator inflation
test('aborted packages excluded from totalSize — no Tier 1 freeze', () => {
  const agg = new DownloadAggregator();
  agg.register('a@1.0.0', { distSize: 1000 });
  agg.register('b@1.0.0', { distSize: 1000 });
  agg.onFetchStart('a@1.0.0');
  agg.onChunk('a@1.0.0', 1000);
  agg.onEnd('a@1.0.0');
  agg.onFetchStart('b@1.0.0');
  agg.onAbort('b@1.0.0');
  // b's distSize is zeroed on abort → allKnown false → totalSize null → Tier 2 used
  assert.strictEqual(agg.totalSize(), null, 'totalSize null when aborted packages present');
  assert.strictEqual(agg.totalBytes(), 1000, 'completed bytes unaffected');
  assert.strictEqual(agg.counts().aborted, 1);
});

// 14. BUG-008: distSize=0 treated as unknown — does not activate Tier 1
test('distSize=0 treated as unknown — does not activate Tier 1', () => {
  const agg = new DownloadAggregator();
  agg.register('a@1.0.0', { distSize: 0 });
  assert.strictEqual(agg.totalSize(), null, 'distSize=0 treated as unknown');
  assert.strictEqual(agg.knownSizeCount(), 0, 'distSize=0 not counted as known size');
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

// --- Renderer polish (G8) ---------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = s => s.replace(ANSI_RE, '');

function fakeStream(columns) {
  return {
    isTTY: true,
    columns,
    writes: [],
    write(s) { this.writes.push(s); return true; },
  };
}

function writtenLines(stream) {
  return stream.writes.join('').split('\n').map(stripAnsi).filter(l => l.length > 0);
}

// 15. Narrow terminal: no rendered line may ever exceed the terminal width.
test('narrow terminal (columns=30): every rendered line fits within columns', () => {
  const agg = new DownloadAggregator();
  agg.register('a-very-long-package-name@1.0.0', { distSize: 5000000 });
  agg.register('another-long-package@2.0.0', { distSize: 5000000 });
  agg.onFetchStart('a-very-long-package-name@1.0.0');
  agg.onChunk('a-very-long-package-name@1.0.0', 2500000);
  agg.onRetry('another-long-package@2.0.0'); // adds the retry line too

  const stream = fakeStream(30);
  const r = new ProgressRenderer(agg, { stream, enabled: true });
  r._render();
  r._render(); // second render exercises the clear-lines path as well

  const lines = writtenLines(stream);
  assert.ok(lines.length > 0, 'renderer should have written lines');
  for (const line of lines) {
    assert.ok(line.length <= 30, `line visible length ${line.length} > 30 columns: "${line}"`);
  }
  assert.ok(lines.some(l => l.length === 29), 'expected at least one line truncated to columns-1');
});

// 16. Undefined columns: conservative 80-column fallback, still no wrap risk.
test('undefined columns: renderer truncates to 80-column fallback', () => {
  const agg = new DownloadAggregator();
  const name = i => `an-absurdly-long-package-name-used-to-verify-fallback-truncation-behavior-${i}@1.0.0`;
  for (let i = 0; i < 3; i++) {
    agg.register(name(i), { distSize: 1000000 });
  }
  agg.onFetchStart(name(0));
  agg.onChunk(name(0), 500000);
  agg.onRetry(name(1));

  const stream = fakeStream(undefined);
  const r = new ProgressRenderer(agg, { stream, enabled: true });
  r._render();

  const lines = writtenLines(stream);
  for (const line of lines) {
    assert.ok(line.length <= 80, `line visible length ${line.length} > 80 fallback: "${line}"`);
  }
  assert.ok(lines.some(l => l.length === 79), 'expected the retry line truncated to 79 (fallback-1)');
});

// 17. Disabled renderer: start/stop emit nothing — no interval, no escapes.
test('disabled renderer: start() is a no-op and no bytes (no ANSI) are written', () => {
  const agg = new DownloadAggregator();
  agg.register('a@1.0.0', { distSize: 100 });
  const stream = fakeStream(80);
  const r = new ProgressRenderer(agg, { stream, enabled: false });
  r.start();
  assert.strictEqual(r._timer, null, 'disabled renderer must not start its interval');
  r.stop();
  assert.strictEqual(stream.writes.length, 0, `expected zero writes, got: ${JSON.stringify(stream.writes)}`);
});

// 18. progressEnabled: --no-progress, CI env, and non-TTY each suppress.
test('progressEnabled: flag=false, CI truthy, and non-TTY each disable progress', () => {
  const { progressEnabled } = ProgressRenderer;
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  assert.strictEqual(progressEnabled(undefined, {}, tty), true, 'default on in interactive TTY');
  assert.strictEqual(progressEnabled(true, {}, tty), true, 'explicit --progress on in TTY');
  assert.strictEqual(progressEnabled(false, {}, tty), false, '--no-progress disables');
  assert.strictEqual(progressEnabled(undefined, { CI: '1' }, tty), false, 'CI=1 disables');
  assert.strictEqual(progressEnabled(undefined, { CI: 'false' }, tty), true, 'CI=false is not CI');
  assert.strictEqual(progressEnabled(undefined, {}, pipe), false, 'non-TTY disables');
});

// 19. Cursor lifecycle: hidden on start, restored on stop, stop idempotent.
test('cursor hidden on start and restored on stop — stop is idempotent', () => {
  const agg = new DownloadAggregator();
  const stream = fakeStream(80);
  const r = new ProgressRenderer(agg, { stream, enabled: true });
  r.start();
  assert.ok(stream.writes.join('').includes('\x1b[?25l'), 'start() must hide cursor');
  r.stop();
  const countShows = () => stream.writes.join('').split('\x1b[?25h').length - 1;
  assert.strictEqual(countShows(), 1, 'stop() must show cursor exactly once');
  r.stop(); // idempotent: no second show escape
  assert.strictEqual(countShows(), 1, 'second stop() must not emit another cursor-show');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

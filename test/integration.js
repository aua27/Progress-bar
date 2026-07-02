'use strict';

// Integration tests: drive bin/npmbar.js end-to-end against an in-process mock
// registry (test/mock-registry.js). Offline — everything resolves against
// 127.0.0.1, so these run in CI.
//
// Fixture shape used throughout: pkg-x@1.0.0 appears twice in the ideal tree
// with the SAME resolved URL — nested under pkg-a (required edge) and under
// pkg-b (optional edge) — because root's pkg-x@2.0.0 blocks hoisting. Arborist
// emits both nodes without merging (verified 2026-07-02); the dedup in
// extractPackageSpecs() must treat the package as required.

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MockRegistry } = require('./mock-registry');

const BIN = path.resolve(__dirname, '../bin/npmbar.js');

let passed = 0;
let failed = 0;

console.log('\nIntegration tests (mock registry)\n');

async function test(name, fn) {
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

function freshDirs() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'npmbar-itest-'));
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  return { work, proj, cache: path.join(work, 'cache') };
}

// Async spawn — the mock registry runs in THIS process, so a spawnSync child
// would deadlock: the blocked parent event loop can never accept the child's
// HTTP connections.
function runNpmbar(args, { proj, cache }, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args, '--prefix', proj], {
      env: { ...process.env, npm_config_cache: cache, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => {
      child.kill();
      reject(new Error(`npmbar timed out after ${timeout}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeout);
    child.on('error', err => { clearTimeout(killer); reject(err); });
    child.on('close', status => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

const MIXED_OPTIONALITY = {
  'pkg-x': { '1.0.0': {}, '2.0.0': {} },
  'pkg-a': { '1.0.0': { dependencies: { 'pkg-x': '1.0.0' } } },
  'pkg-b': { '1.0.0': { optionalDependencies: { 'pkg-x': '1.0.0' } } },
};

const ALL_OPTIONAL = {
  'pkg-x': { '1.0.0': {}, '2.0.0': {} },
  'pkg-a': { '1.0.0': { optionalDependencies: { 'pkg-x': '1.0.0' } } },
  'pkg-b': { '1.0.0': { optionalDependencies: { 'pkg-x': '1.0.0' } } },
};

const INSTALL_ARGS = ['install', 'pkg-x@2.0.0', 'pkg-a@1.0.0', 'pkg-b@1.0.0'];

async function withRegistry(config, fn) {
  const registry = new MockRegistry(config);
  const url = await registry.start();
  const dirs = freshDirs();
  try {
    await fn(url, dirs, registry);
  } finally {
    await registry.stop();
    fs.rmSync(dirs.work, { recursive: true, force: true });
  }
}

async function main() {
  // Happy path: duplicate-resolved specs install cleanly, nested copies land.
  await test('mixed-optionality duplicate installs cleanly when tarballs are healthy', async () => {
    await withRegistry({ packages: MIXED_OPTIONALITY }, async (url, dirs) => {
      const r = await runNpmbar([...INSTALL_ARGS, '--registry', url], dirs);
      assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
      for (const p of [
        'node_modules/pkg-x/package.json',
        'node_modules/pkg-a/node_modules/pkg-x/package.json',
        'node_modules/pkg-b/node_modules/pkg-x/package.json',
      ]) {
        assert.ok(fs.existsSync(path.join(dirs.proj, p)), `missing ${p}`);
      }
    });
  });

  // The regression the audit called the worst potential failure mode: a package
  // reachable through both a required and an optional edge must abort the
  // install when its tarball fails — never report success.
  await test('required+optional duplicate: tarball 404 aborts install with exit 1', async () => {
    await withRegistry(
      { packages: MIXED_OPTIONALITY, tarballFailures: { 'pkg-x@1.0.0': 404 } },
      async (url, dirs) => {
        const r = await runNpmbar([...INSTALL_ARGS, '--registry', url], dirs);
        assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
        assert.ok(
          r.stderr.includes('required package(s) failed'),
          `expected required-failure message, got stderr: ${r.stderr}`,
        );
        assert.ok(
          r.stderr.includes('pkg-x@1.0.0'),
          `expected pkg-x@1.0.0 named in failures, got stderr: ${r.stderr}`,
        );
      },
    );
  });

  // Failure-policy counterpart: optional on every edge → warn and continue.
  await test('all-optional duplicate: tarball 404 warns but exits 0', async () => {
    await withRegistry(
      { packages: ALL_OPTIONAL, tarballFailures: { 'pkg-x@1.0.0': 404 } },
      async (url, dirs) => {
        const r = await runNpmbar([...INSTALL_ARGS, '--registry', url], dirs);
        assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
        assert.ok(
          r.stdout.includes('optional package failed') || r.stdout.includes('optional packages failed'),
          `expected optional-failure warning in summary, got stdout: ${r.stdout}`,
        );
      },
    );
  });

  // Concurrent required failures: the first failure aborts the controller.
  // Errors observed before the abort must be attributed to their packages
  // (not reclassified "aborted" and discarded), and fetches the abort
  // cancelled must be accounted for explicitly — every one of the N packages
  // is either a listed real failure or a counted cancellation. Which packages
  // land on which side is a genuine race; the arithmetic is not.
  await test('concurrent required failures: every package is a listed failure or counted cancellation', async () => {
    await withRegistry(
      {
        packages: {
          'pkg-f1': { '1.0.0': {} },
          'pkg-f2': { '1.0.0': {} },
          'pkg-f3': { '1.0.0': {} },
        },
        tarballFailures: {
          'pkg-f1@1.0.0': 404,
          'pkg-f2@1.0.0': 404,
          'pkg-f3@1.0.0': 404,
        },
      },
      async (url, dirs) => {
        const r = await runNpmbar(
          ['install', 'pkg-f1@1.0.0', 'pkg-f2@1.0.0', 'pkg-f3@1.0.0', '--registry', url],
          dirs,
        );
        assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);

        const failedMatch = r.stderr.match(/(\d+) required package\(s\) failed/);
        assert.ok(failedMatch, `expected required-failure count, got stderr: ${r.stderr}`);
        const failedCount = Number(failedMatch[1]);
        const cancelledMatch = r.stderr.match(/(\d+) other fetch\(es\) cancelled/);
        const cancelledCount = cancelledMatch ? Number(cancelledMatch[1]) : 0;

        assert.ok(failedCount >= 1, 'at least the abort-triggering failure must be listed');
        assert.strictEqual(
          failedCount + cancelledCount, 3,
          `every package must be accounted for: ${failedCount} failed + ${cancelledCount} cancelled != 3\nstderr: ${r.stderr}`,
        );
        // Each listed failure must carry its real error, not an abort artifact.
        const listed = [...r.stderr.matchAll(/pkg-f\d@1\.0\.0: (.+)/g)];
        assert.strictEqual(listed.length, failedCount, `listed entries must match the count\nstderr: ${r.stderr}`);
        for (const [, msg] of listed) {
          assert.ok(msg.includes('404'), `expected real 404 error in "${msg}"`);
        }
      },
    );
  });

  // BUG-011 behavioral: --fetch-retries must actually control the retry count,
  // not just parse. A required tarball that resets the socket every time
  // (transient ECONNRESET) is retried until the count is exhausted, then the
  // install fails. Proven by counting tarball GETs against the mock registry:
  // --fetch-retries 0 → exactly one attempt (no retry); a positive count →
  // strictly more attempts. This is the semantics the NaN bug silently broke.
  await test('--fetch-retries controls retry count on a transient tarball failure', async () => {
    const RETRY_FIXTURE = { packages: { 'pkg-r': { '1.0.0': {} } }, tarballFailures: { 'pkg-r@1.0.0': 'destroy' } };
    const RETRY_ARGS = ['--fetch-retry-mintimeout', '10', '--fetch-retry-maxtimeout', '50'];
    const tarHits = reg => reg.requests.filter(u => /\/pkg-r\/-\/pkg-r-1\.0\.0\.tgz/.test(u)).length;

    let noRetryHits, withRetryHits;

    await withRegistry(RETRY_FIXTURE, async (url, dirs, registry) => {
      const r = await runNpmbar(['install', 'pkg-r@1.0.0', '--registry', url, '--fetch-retries', '0', ...RETRY_ARGS], dirs);
      assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
      noRetryHits = tarHits(registry);
      assert.strictEqual(noRetryHits, 1, `--fetch-retries 0 must attempt the tarball exactly once, got ${noRetryHits}`);
    });

    await withRegistry(RETRY_FIXTURE, async (url, dirs, registry) => {
      const r = await runNpmbar(['install', 'pkg-r@1.0.0', '--registry', url, '--fetch-retries', '1', ...RETRY_ARGS], dirs);
      assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
      withRetryHits = tarHits(registry);
      assert.ok(withRetryHits > 1, `--fetch-retries 1 must retry (>1 attempt), got ${withRetryHits}`);
      assert.ok(withRetryHits > noRetryHits, `--fetch-retries 1 (${withRetryHits}) must attempt more than --fetch-retries 0 (${noRetryHits})`);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });

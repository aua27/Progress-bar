'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const pacote = require('pacote');

// cacache content-v2 layout:
//   <cacacheRoot>/content-v2/<algo>/<hex[0:2]>/<hex[2:4]>/<hex[4:]>
// where hex is the integrity hash decoded from base64.
// We compute this path manually rather than depending on cacache, so the
// "is this tarball already on disk?" check is an O(1) fs.access — a few μs
// per spec — instead of a pacote.manifest call (~10ms each, dominates probe time).
//
// Two cache-dir conventions exist in the npm ecosystem:
//   - arborist's resolved options.cache → already ends in `_cacache`
//   - raw npm_config_cache or ~/.npm fallback → parent of `_cacache`
// Normalize both into the cacache root before appending content-v2 segments.
function cacacheRoot(cacheDir) {
  if (!cacheDir) return null;
  const norm = cacheDir.replace(/[\\/]+$/, '');
  return norm.endsWith('_cacache') ? norm : path.join(norm, '_cacache');
}

function tarballCachePath(cacheDir, integrity) {
  if (!integrity || !cacheDir) return null;
  // ssri integrity strings can be space-separated lists; the first entry suffices.
  const first = integrity.split(' ')[0];
  const dash = first.indexOf('-');
  if (dash === -1) return null;
  const algo = first.slice(0, dash);
  const b64 = first.slice(dash + 1);
  let hex;
  try {
    hex = Buffer.from(b64, 'base64').toString('hex');
    // Sanity: hex must be strictly hex characters
    if (!/^[0-9a-f]+$/i.test(hex)) return null;
  } catch { return null; }
  if (hex.length < 4) return null;
  const root = cacacheRoot(cacheDir);
  return path.join(
    root, 'content-v2',
    algo, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4),
  );
}

function resolveCacheDir(opts) {
  return (opts && opts.cache)
    || process.env.npm_config_cache
    || process.env.NPM_CONFIG_CACHE
    || path.join(os.homedir(), '.npm');
}

// Slow fallback for specs missing integrity — uses pacote's offline manifest.
async function probeViaManifest(spec, opts) {
  try {
    await pacote.manifest(spec, { ...opts, offline: true });
    return true;
  } catch {
    return false;
  }
}

// Each manifest fallback reads and parses cache index entries (~10ms, fs
// threadpool + CPU). A tree with many no-integrity specs (git/file deps)
// fanning them all out at once can stall the probe phase; fs.access probes
// stay unbounded because a missing-file stat is microseconds.
const MANIFEST_CONCURRENCY = 8;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Fast probe: existence check on the cacache tarball blob path computed from
// the integrity hash. Falls back to pacote.manifest only when integrity is
// unavailable (rare for arborist v9 idealTree nodes).
async function probeAll(specs, opts) {
  const cacheDir = resolveCacheDir(opts);
  const results = new Array(specs.length);
  const fallbackIndexes = [];
  await Promise.all(specs.map(async (s, i) => {
    const tarPath = tarballCachePath(cacheDir, s.integrity);
    if (!tarPath) {
      fallbackIndexes.push(i);
      return;
    }
    try {
      await fs.promises.access(tarPath, fs.constants.F_OK);
      results[i] = true;
    } catch {
      results[i] = false;
    }
  }));
  await mapLimit(fallbackIndexes, MANIFEST_CONCURRENCY, async (i) => {
    results[i] = await probeViaManifest(specs[i].spec, opts);
  });

  const cachedSpecs = new Set();
  for (let i = 0; i < specs.length; i++) {
    if (results[i]) cachedSpecs.add(specs[i].key || specs[i].spec);
  }
  return {
    likelyCached: cachedSpecs.size,
    cachedSpecs,
  };
}

module.exports = { probeAll, tarballCachePath, resolveCacheDir, cacacheRoot, mapLimit };

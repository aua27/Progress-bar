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
  try { hex = Buffer.from(b64, 'base64').toString('hex'); }
  catch { return null; }
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

// Fast probe: existence check on the cacache tarball blob path computed from
// the integrity hash. Falls back to pacote.manifest only when integrity is
// unavailable (rare for arborist v9 idealTree nodes).
async function probeAll(specs, opts) {
  const cacheDir = resolveCacheDir(opts);
  const results = await Promise.all(specs.map(async (s) => {
    const tarPath = tarballCachePath(cacheDir, s.integrity);
    if (tarPath) {
      try {
        await fs.promises.access(tarPath, fs.constants.F_OK);
        return true;
      } catch {
        return false;
      }
    }
    return probeViaManifest(s.spec, opts);
  }));

  const cachedSpecs = new Set();
  for (let i = 0; i < specs.length; i++) {
    if (results[i]) cachedSpecs.add(specs[i].key || specs[i].spec);
  }
  return {
    likelyCached: cachedSpecs.size,
    cachedSpecs,
  };
}

module.exports = { probeAll, tarballCachePath, resolveCacheDir };

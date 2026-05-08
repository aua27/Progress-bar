'use strict';

const pacote = require('pacote');

async function probe(spec, opts) {
  try {
    // offline: true — cache-only, throws immediately on miss without a network
    // round-trip. preferOffline would fall back to the network on miss, adding
    // N extra manifest requests for cold-cache installs.
    await pacote.manifest(spec, { ...opts, offline: true });
    return 'likely-cached';
  } catch {
    return 'likely-download';
  }
}

async function probeAll(specs, opts) {
  // Worker-pool pattern: cap concurrent manifest requests to avoid an
  // uncontrolled I/O spike on large trees (cold cache = 500 simultaneous throws).
  const CONCURRENCY = 20;
  const results = new Array(specs.length);
  let next = 0;

  async function worker() {
    while (next < specs.length) {
      const i = next++;
      results[i] = await probe(specs[i], opts);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, specs.length) }, worker),
  );

  const cachedSpecs = new Set();
  for (let i = 0; i < specs.length; i++) {
    if (results[i] === 'likely-cached') cachedSpecs.add(specs[i]);
  }
  return { likelyCached: cachedSpecs.size, likelyToDownload: specs.length - cachedSpecs.size, cachedSpecs };
}

module.exports = { probe, probeAll };

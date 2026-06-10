'use strict';

const TERMINAL = new Set(['done', 'cached', 'failed', 'aborted']);

class DownloadAggregator {
  constructor() {
    this._specs = new Map();
  }

  // key   — unique identifier used as the Map key (e.g. resolved URL)
  // displaySpec — human-readable name shown in retry/failure output (e.g. name@version)
  register(key, { optional = false, distSize = null, displaySpec = null } = {}) {
    this._specs.set(key, {
      spec: displaySpec || key,
      optional,
      status: 'pending',
      attempt: 0,
      bytes: 0,
      committed: false,
      distSize,
      error: null,
    });
  }

  onFetchStart(spec) {
    const s = this._get(spec);
    if (TERMINAL.has(s.status)) return;
    s.status = 'fetching';
  }

  onChunk(spec, length) {
    if (!Number.isFinite(length) || length < 0) throw new RangeError(`Invalid chunk length: ${length}`);
    const s = this._get(spec);
    if (TERMINAL.has(s.status)) return;
    // First chunk after a retry transitions the spec out of 'retrying' — that
    // status means "waiting between attempts", not "actively receiving data".
    // Without this, the renderer's retrying counter stays inflated until onEnd.
    if (s.status === 'retrying') s.status = 'fetching';
    s.bytes += length;
  }

  onEnd(spec, { cached = false } = {}) {
    const s = this._get(spec);
    if (TERMINAL.has(s.status)) return;
    s.committed = true;
    s.status = cached ? 'cached' : 'done';
    // Track significant distSize mismatches for diagnostic reporting.
    // A mismatch means the progress bar's Tier 1 percentage was inaccurate
    // during this package's download (but capped at 99% so no visual break).
    if (!cached && s.distSize != null && s.distSize > 0 && s.bytes > 0) {
      const ratio = s.bytes / s.distSize;
      if (ratio < 0.5 || ratio > 2.0) {
        this._distSizeMismatches = (this._distSizeMismatches || 0) + 1;
      }
    }
    // Credit distSize as bytes when we mark a package cached without streaming —
    // keeps the Tier 1 progress bar's totalBytes/totalSize ratio correct on
    // partial-cache installs where some packages are pre-known cached.
    if (cached && s.bytes === 0 && s.distSize != null && s.distSize > 0) {
      s.bytes = s.distSize;
    }
  }

  onRetry(spec) {
    const s = this._get(spec);
    if (TERMINAL.has(s.status)) return;
    s.attempt++;
    s.bytes = 0;
    s.committed = false;
    s.status = 'retrying';
  }

  onAbort(spec) {
    const s = this._get(spec);
    if (TERMINAL.has(s.status)) return;
    s.bytes = 0;
    s.distSize = null;  // exclude from totalSize so aborted packages don't freeze Tier 1
    s.committed = false;
    s.status = 'aborted';
  }

  onFailed(spec, err) {
    const s = this._get(spec);
    if (TERMINAL.has(s.status)) return;
    s.status = 'failed';
    s.bytes = 0;
    s.error = err;
  }

  totalBytes() {
    let total = 0;
    for (const s of this._specs.values()) {
      total += s.bytes;
    }
    return total;
  }

  totalSize() {
    if (this._specs.size === 0) return null;
    let total = 0;
    let allKnown = true;
    for (const s of this._specs.values()) {
      if (s.distSize != null && s.distSize > 0) {
        total += s.distSize;
      } else {
        allKnown = false;
      }
    }
    return allKnown ? total : null;
  }

  knownSizeCount() {
    let known = 0;
    for (const s of this._specs.values()) {
      if (s.distSize != null && s.distSize > 0) known++;
    }
    return known;
  }

  counts() {
    const result = { pending: 0, fetching: 0, cached: 0, retrying: 0, failed: 0, done: 0, aborted: 0 };
    for (const s of this._specs.values()) {
      result[s.status] = (result[s.status] || 0) + 1;
    }
    return result;
  }

  total() {
    return this._specs.size;
  }

  retryingDetails() {
    const retrying = [];
    for (const s of this._specs.values()) {
      if (s.status === 'retrying') {
        retrying.push({ spec: s.spec, attempt: s.attempt });
      }
    }
    return retrying;
  }

  failures() {
    const failed = [];
    for (const s of this._specs.values()) {
      if (s.status === 'failed') {
        failed.push({ spec: s.spec, error: s.error, optional: s.optional });
      }
    }
    return failed;
  }

  distSizeMismatches() {
    return this._distSizeMismatches || 0;
  }

  _get(spec) {
    const s = this._specs.get(spec);
    if (!s) throw new Error(`Unknown spec: ${spec}`);
    return s;
  }
}

module.exports = DownloadAggregator;

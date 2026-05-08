'use strict';

const TERMINAL = new Set(['done', 'cached', 'failed', 'aborted']);

class DownloadAggregator {
  constructor() {
    this._specs = new Map();
  }

  register(spec, { optional = false, distSize = null } = {}) {
    this._specs.set(spec, {
      spec,
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
    s.bytes += length;
  }

  onEnd(spec, { cached = false } = {}) {
    const s = this._get(spec);
    if (TERMINAL.has(s.status)) return;
    s.committed = true;
    s.status = cached ? 'cached' : 'done';
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
      if (s.distSize != null) {
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
      if (s.distSize != null) known++;
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

  _get(spec) {
    const s = this._specs.get(spec);
    if (!s) throw new Error(`Unknown spec: ${spec}`);
    return s;
  }
}

module.exports = DownloadAggregator;

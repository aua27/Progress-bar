'use strict';

const pacote = require('pacote');

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EABORT']);

// EABORT (close without end) is retried because server connection drops are
// usually transient. It is distinct from EABORT_SIGNAL (AbortController abort),
// which is never retried.

function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  if (typeof err.statusCode === 'number' && err.statusCode >= 500) return true;
  return false;
}

function abortError() {
  return Object.assign(new Error('fetch aborted'), { code: 'EABORT_SIGNAL' });
}

// Error codes that are artifacts of tearing a stream down, not verdicts about
// the fetch itself. When our own AbortController caused the teardown, these
// are all reported as EABORT_SIGNAL so callers can tell "cancelled by the
// abort" apart from "actually failed" (e.g. E404 racing the abort).
const TEARDOWN_CODES = new Set(['EABORT', 'FETCH_ABORTED', 'ERR_STREAM_PREMATURE_CLOSE']);

// pacote v21 API: tarball.stream(spec, streamHandler, opts)
// The handler receives a Node stream and must return a Promise.
// This is a breaking change from earlier pacote versions where
// tarball.stream(spec, opts) returned a stream directly.
async function fetchWithRetry(spec, opts, onChunk, onRetry) {
  const { signal } = opts;
  let attempt = 0;

  while (true) {
    if (signal?.aborted) throw abortError();

    try {
      await pacote.tarball.stream(spec, (stream) => {
        return new Promise((resolve, reject) => {
          let ended = false;
          // On abort, destroying the stream is necessary (stop pumping bytes
          // into the aggregator) but NOT sufficient: a destroyed minipass
          // stream may emit no further events, leaving this promise — and the
          // install's Promise.all — pending forever. The event loop then
          // drains and node exits 0 mid-install. Reject explicitly so every
          // aborted fetch settles.
          const onAbortSignal = () => {
            stream.destroy();
            reject(abortError());
          };
          const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbortSignal); };
          if (signal) {
            if (signal.aborted) { onAbortSignal(); return; }
            signal.addEventListener('abort', onAbortSignal, { once: true });
          }

          stream.on('data', chunk => {
            onChunk(chunk.length);
          });

          stream.on('end', () => {
            ended = true;
            cleanup();
            resolve();
          });

          stream.on('error', err => { cleanup(); reject(err); });

          stream.on('close', () => {
            cleanup();
            if (!ended) {
              reject(Object.assign(new Error('stream closed without end'), { code: 'EABORT' }));
            }
          });
        });
      }, opts);

      return;
    } catch (err) {
      if (signal?.aborted) {
        // Our abort caused this teardown — normalize so the caller can
        // attribute it to the abort rather than to the package.
        if (TEARDOWN_CODES.has(err.code) || err.name === 'AbortError' || err.code === 'EABORT_SIGNAL') {
          throw abortError();
        }
        // A genuine failure (e.g. E404) that raced the abort — preserve it.
        throw err;
      }
      const maxRetries = opts.fetchRetries ?? 2;
      if (isTransient(err) && attempt < maxRetries) {
        attempt++;
        if (onRetry) onRetry();
        
        const minTimeout = opts.fetchRetryMintimeout ?? 10000;
        const maxTimeout = opts.fetchRetryMaxtimeout ?? 60000;
        const factor = opts.fetchRetryFactor ?? 10;
        
        let delay = minTimeout * Math.pow(factor, attempt - 1);
        if (typeof err.statusCode === 'number' && err.statusCode >= 500) {
          delay = Math.max(delay, 500 * attempt);
        } else {
          // Subdue latency for network errors by clamping to a smaller max for non-500 errors
          delay = Math.min(delay, 5000 * attempt); 
        }
        delay = Math.min(delay, maxTimeout);
        
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { fetchWithRetry };

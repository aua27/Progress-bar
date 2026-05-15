'use strict';

const pacote = require('pacote');

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EABORT']);
const MAX_RETRIES = 2;

// EABORT (close without end) is retried because server connection drops are
// usually transient. It is distinct from EABORT_SIGNAL (AbortController abort),
// which is never retried.

function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  if (typeof err.statusCode === 'number' && err.statusCode >= 500) return true;
  return false;
}

// pacote v21 API: tarball.stream(spec, streamHandler, opts)
// The handler receives a Node stream and must return a Promise.
// This is a breaking change from earlier pacote versions where
// tarball.stream(spec, opts) returned a stream directly.
async function fetchWithRetry(spec, opts, onChunk, onRetry) {
  const { signal } = opts;
  let attempt = 0;

  while (true) {
    if (signal?.aborted) throw Object.assign(new Error('fetch aborted'), { code: 'EABORT_SIGNAL' });

    try {
      await pacote.tarball.stream(spec, (stream) => {
        // Destroy the stream immediately when the AbortController fires, so
        // in-flight streams don't keep pumping data into the aggregator after
        // a required-package failure triggers ac.abort().
        const onAbortSignal = () => stream.destroy();
        if (signal) {
          if (signal.aborted) {
            stream.destroy();
          } else {
            signal.addEventListener('abort', onAbortSignal, { once: true });
          }
        }

        return new Promise((resolve, reject) => {
          let ended = false;
          const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbortSignal); };

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
      if (signal?.aborted) throw err;
      if (isTransient(err) && attempt < MAX_RETRIES) {
        attempt++;
        if (onRetry) onRetry();
        // Server errors need recovery time; network errors (ECONNRESET etc.) retry immediately
        if (typeof err.statusCode === 'number' && err.statusCode >= 500) {
          await new Promise(r => setTimeout(r, 500 * attempt));
        }
        continue;
      }
      throw err;
    }
  }
}

module.exports = { fetchWithRetry, MAX_RETRIES };

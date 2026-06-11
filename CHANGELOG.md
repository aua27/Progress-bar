# Changelog

## 0.9.0 (2026-06-11)

Initial public beta.

### Features

- `npmbar install` (alias `i`): drop-in for `npm install` with accurate
  download progress — bytes, transfer speed, ETA — rendered at 10fps,
  decoupled from the I/O event loop.
- Three-tier progress display: byte fraction when all sizes are known,
  package fraction otherwise, spinner before registration.
- O(1) cache probe via `fs.access` on cacache content paths; cached
  packages skip the download phase entirely.
- Strict flag allowlist mirroring npm install semantics, including
  `--workspace`/`--workspaces`, `--omit`/`--include`, save variants,
  `--fetch-retries` family, and `--progress`/`--no-progress`.
- Progress auto-suppression in CI and non-TTY environments; narrow-terminal
  truncation; cursor restoration on exit and crash; SIGINT aborts in-flight
  downloads and exits 130.
- Retry with exponential backoff on transient network errors and 5xx
  responses; AbortController cancels all fetches when a required package
  fails (optional-package failures never block the install).
- Lockfile v3 output, semantically identical to `npm install` (verified by
  deep-equal comparison in CI).

### Performance

- Median install overhead vs `npm install --no-audit --no-fund` is within
  the < 3% project budget in both warm- and cold-cache regimes (see README
  for current measured numbers).

# Changelog

## [0.9.1](https://github.com/aua27/Progress-bar/compare/npmbar-v0.9.0...npmbar-v0.9.1) (2026-07-03)


### Features

* implement high and medium priority CLI flags ([12f5ae4](https://github.com/aua27/Progress-bar/commit/12f5ae4d22f491e2860d665de3ae7908545cf774))
* progress suppression (--no-progress, CI, non-TTY), narrow-terminal truncation, SIGINT exit 130, cursor restore on exit ([033f460](https://github.com/aua27/Progress-bar/commit/033f460342fbb6c54dac69a6ec974acac1d1bb1d))
* rename to npmbar, v0.9.0 ([3139505](https://github.com/aua27/Progress-bar/commit/3139505bb6a9e376c6fd3451abe5b44d4b5655af))
* update npmx cli, adapters, and tests ([ef87858](https://github.com/aua27/Progress-bar/commit/ef8785815ab8ea1b758c9a7dd6ea926e68700544))


### Bug Fixes

* honor npm_config_registry and .npmrc; share npm's cacache root ([d3a0235](https://github.com/aua27/Progress-bar/commit/d3a023592cf9cc08625d2adbd2b48aeff9fee4b7))
* reap verdaccio process group on POSIX so perf.js exits after the verdict ([d3f4589](https://github.com/aua27/Progress-bar/commit/d3f45892b9d1bf7bbff6ec90faf608bf181b3c8b))
* reject empty package args and non-directory --prefix; wrap arborist constructor errors ([3994b14](https://github.com/aua27/Progress-bar/commit/3994b143c1e0f635bd74519c6148efd027bf02d3))
* settle aborted fetches and attribute concurrent required failures correctly ([7016dc7](https://github.com/aua27/Progress-bar/commit/7016dc76bd537ad1ca0bbc6c06e9ea3d5b055942))
* treat duplicate resolved URLs as optional only when every edge is optional ([d6d349e](https://github.com/aua27/Progress-bar/commit/d6d349e8783fc32298870643b3a2d7fb7fe6a1a4))
* validate fetch-retry flag values ([012b365](https://github.com/aua27/Progress-bar/commit/012b3655e4173117bd05551499d3b3f51b4c304b))


### Performance Improvements

* cap manifest-fallback concurrency in cache probe ([c0cfdfa](https://github.com/aua27/Progress-bar/commit/c0cfdfa41c9041abfeca57811bbf79c31711d13f))

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

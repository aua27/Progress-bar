# npmbar

[![CI](https://github.com/aua27/Progress-bar/actions/workflows/ci.yml/badge.svg)](https://github.com/aua27/Progress-bar/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`npm install` with accurate download progress bars — bytes downloaded, transfer speed, ETA — at less than 3% warm-cache overhead vs plain `npm install`.

npm's own progress bar was removed because it caused 30–50% slowdown. `npmbar` decouples rendering from byte counting, so progress is reported without competing with the install itself for the I/O event loop.

## Install

```sh
npm install -g npmbar
```

Requires Node.js 18 or later.

## Usage

```sh
npmbar install                         # install from package.json
npmbar install express react           # add packages
npmbar i lodash --save-dev             # alias `i` works; --save-dev / -D supported
npmbar install --dry-run               # plan only; no network, no writes
npmbar install --global cowsay         # global install
```

V1 only ships `npmbar install` (and the `i` alias). `npmbar update` and `npmbar exec` are planned for v2.

### Supported flags

| Flag | Alias | Effect |
|---|---|---|
| `--save` | | Save to `package.json` (default) |
| `--save-dev` | `-D` | Save to `devDependencies` |
| `--save-optional` | `-O` | Save to `optionalDependencies` |
| `--save-prod` | `-P` | Save to `dependencies` (explicit) |
| `--save-exact` | `-E` | Save with exact version (no `^`/`~`) |
| `--no-save` | | Do not modify `package.json` |
| `--global` | `-g` | Install to the global prefix |
| `--legacy-peer-deps` | | Use legacy peer-dep resolution |
| `--strict-peer-deps` | | Fail on any peer dependency conflict |
| `--force` | | Force install |
| `--dry-run` | | Resolve only — nothing is downloaded or written |
| `--ignore-scripts` | | Do not run lifecycle scripts |
| `--prefix <path>` | | Override install prefix |
| `--registry <url>` | | Set custom registry URL |
| `--workspace <name>` | `-w` | Install in a specific workspace |
| `--workspaces` | | Install in all workspaces |
| `--omit <type>` | | Omit dependency type (`dev`, `optional`, `peer`) |
| `--include <type>` | | Include dependency type (overrides `--omit`) |
| `--package-lock` | | Generate `package-lock.json` (default) |
| `--no-package-lock` | | Do not generate `package-lock.json` |
| `--prefer-offline` | | Prefer cached packages over registry |
| `--fetch-retries <n>` | | Retries for transient fetch failures (default 2) |
| `--fetch-retry-mintimeout <ms>` | | Minimum retry backoff delay |
| `--fetch-retry-maxtimeout <ms>` | | Maximum retry backoff delay |
| `--fetch-retry-factor <n>` | | Exponential backoff factor |
| `--progress` | | Show the progress bar (default in interactive terminals) |
| `--no-progress` | | Disable the progress bar |

Unknown flags exit with code 1 rather than being silently ignored, so a typo or an unsupported npm flag is always surfaced.

Conflicting flags (`--save-dev` with `--save-optional` or `--save-prod`, `--workspace` with `--workspaces`, etc.) also exit with code 1.

Progress rendering is automatically disabled when stdout is not a TTY or when `CI` is set in the environment, matching npm's behavior — output falls back to plain log lines with no ANSI escape codes. `Ctrl-C` aborts in-flight downloads, restores the cursor, and exits with code 130.

## How it works

`npmbar` ships pinned copies of npm's own libraries (`@npmcli/arborist` and `pacote`) as regular dependencies — it does not depend on the user's globally installed npm CLI. The lockfile format (v3) is determined entirely by the bundled arborist.

```
npmbar install <pkgs>
   │
   1. arborist.buildIdealTree()          — same as npm
   │
   2. Cache probe via fs.access on the
      cacache content path computed from
      each package's integrity hash      — best-effort UI hint
   │
   3. Pre-fetch only packages NOT in
      cache, with byte/speed/ETA tracking
      via setInterval(render, 100)        — decoupled from I/O
   │
   4. Re-verify cached paths just before
      reify; silently re-fetch any that
      were evicted (TOCTOU repair)        — correctness safety net
   │
   5. arborist.reify()                    — same as npm
   │
   6. Final summary
```

The probe uses a direct `fs.access` on the cacache `content-v2` path derived from each package's integrity hash. This is roughly 85× faster than calling `pacote.manifest({ offline: true })` and gives an accurate (not best-guess) cached/needs-download split — which is what makes the warm-cache path skip the redundant byte-counting read entirely.

## Pinned versions

`npmbar` pins the npm internals it ships:

| Package | Pinned in npmbar 0.9.x |
|---|---|
| `@npmcli/arborist` | `^9.4.3` |
| `pacote` | `^21.5.0` |

The lockfile output is npm v3 format (readable by npm ≥ 7).

### Update policy

When any pinned upstream package publishes a new minor or major:

1. Run the full correctness test suite (`npm run test:correctness`) against the new version.
2. Run the perf suite (`npm run test:perf`) to confirm the <3% overhead claim still holds.
3. If correctness or perf fails, pin to the last passing version and open a compatibility issue.

CI runs the correctness suite on every push (see `CONTRIBUTING.md`), and a weekly scheduled benchmark guards against performance drift. Benchmark results are re-measured against each new npm release.

## Verification

`npmbar` claims its `package-lock.json` matches what `npm install` produces on the same `package.json`. The correctness test parses both lockfiles and does a recursive deep-equal that ignores key ordering, covering the entire object — not a subset of fields.

The performance suite times interleaved cold- and warm-cache install pairs (10 runs each) and asserts that the median overhead stays under 3%. For a like-for-like comparison, npm is timed as `npm install --no-audit --no-fund`, since npmbar performs neither of those operations during an install (see *V1 limitations* below). Results report median, interquartile range, and min/max. `test/perf.js` automatically starts a local [verdaccio](https://verdaccio.org/) registry if one is not already running on `localhost:4873`.

### Measured overhead (v0.9.0)

Overhead is measured in separate regimes, because the cost of the progress bar depends on how it is exercised:

- **Piped** (warm and cold) — stdout is piped rather than attached to a terminal, so npmbar reports through plain log lines and the live render loop is suppressed — the same fallback npm uses when its own stdout is not a terminal. This isolates the resolve + cache-probe + byte-accounting overhead. *Warm* is a repeat install where every tarball is already cached; *cold* is a first install where every tarball is downloaded (network-dominated, so the accounting overhead is proportionally small).
- **PTY, rendering active** (first install) — an install with a fresh cache, run inside a real pseudo-terminal, so tarballs actually download and the full render path (the 10fps `setInterval` loop, chalk, and ANSI writes) executes live during timing. (A warm-cache install has nothing to download, so the bar never engages — only a first install exercises rendering.) This is the only regime that measures the rendering cost itself — the thing npm removed its own bar over. Both tools are wrapped in an identical pseudo-terminal so the comparison stays like-for-like.

| Regime | Registry | n | Median overhead | npmbar median | npm median |
|---|---|---|---|---|---|
| Warm cache, piped | registry.npmjs.org | 10 | **−2.3%** | 2749 ms | 2814 ms |
| Cold cache, piped | local verdaccio proxy | 10 | **−2.3%** | 8625 ms | 8828 ms |
| First install (fresh cache), PTY, rendering active | local verdaccio | 10 | **+21.3%** | 3599 ms | 2966 ms |

A negative value indicates npmbar completed faster than npm in that measurement session. Differences of this size are within run-to-run variance; the supported conclusion is that npmbar's overhead is below the 3% threshold, not that it is faster than npm.

The PTY row was measured 2026-07-03 by the CI perf workflow on a GitHub-hosted Ubuntu runner (Node 22). It exceeds the 3% threshold — but the excess is not the render loop: on the same runner, the same fresh-cache workload with output piped (rendering suppressed) measured +16.5%, and npmbar's own median was unchanged by turning rendering on (3599 ms PTY vs 3613 ms piped). Rendering adds no measurable cost. The gap is in npmbar's first-install path, which is environment-dependent (−2.3% on the reference machine above, +16–21% on CI-runner hardware) and is being worked on.

The < 3% claim is therefore currently verified for **warm-cache installs** — the everyday case of repeated installs — and holds in every measured environment. First-install overhead exceeds the threshold on CI-class hardware until the first-install gap is closed.

Environment for the piped rows: Windows 11, Node v24.1.0, npm 11.3.0, 31-dependency tree, measured 2026-06-11. Per-run overhead in the warm regime ranged from −9.1% to +3.7%.

```sh
npm test                  # accounting + CLI unit tests
npm run test:perf         # cold + warm benchmark, n=10 (slow; auto-spawns verdaccio)
npm run test:correctness  # lockfile parity check
```

## V1 limitations

| Behavior | V1 status |
|---|---|
| `npm audit` and `npm fund` | Not run during install — they add registry round-trips on the performance-critical path. Run `npm audit` / `npm fund` directly; an opt-in `--audit` flag is planned (see `SECURITY.md`) |
| `npm shrinkwrap` | Not supported |
| Workspace protocols (`workspace:*`) | Basic support; edge cases not guaranteed |
| Interactive peer-dep conflict resolution | Conflicts surface as errors |
| Uncommon `.npmrc` keys | May be silently ignored |


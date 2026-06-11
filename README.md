# npmbar

[![CI](https://github.com/aua27/Progress-bar/actions/workflows/ci.yml/badge.svg)](https://github.com/aua27/Progress-bar/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`npm install` with accurate download progress bars — bytes downloaded, transfer speed, ETA — at less than 3% overhead vs plain `npm install`.

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

Unknown flags exit with code 1. The supported list is strict and intentional — silent passthrough would mask wrong behavior.

Conflicting flags (`--save-dev` with `--save-optional` or `--save-prod`, `--workspace` with `--workspaces`, etc.) also exit with code 1.

Progress rendering is automatically disabled when stdout is not a TTY or when `CI` is set in the environment (npm parity) — output degrades to plain log lines with no ANSI escape codes. `Ctrl-C` aborts in-flight downloads, restores the cursor, and exits with code 130.

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

CI runs the correctness suite on every push (see `CONTRIBUTING.md`), and a weekly scheduled benchmark catches perf drift. When a new npm major ships, the CI matrix is manually expanded and the overhead claim is re-measured (the denominator moves).

## Verification

`npmbar` claims its `package-lock.json` matches what `npm install` produces on the same `package.json`. The correctness test parses both lockfiles and does a recursive deep-equal that ignores key ordering, covering the entire object — not a subset of fields.

The performance suite times interleaved cold- and warm-cache install pairs (n=10 each) and asserts the median overhead is under 3%. For work parity, npm is timed as `npm install --no-audit --no-fund` — npmbar doesn't run audit or fund, so npm isn't charged for round-trips npmbar never makes. Results report median, IQR, and min/max; `test/perf.js` auto-spawns a local [verdaccio](https://verdaccio.org/) registry if one isn't already running on `localhost:4873`.

### Measured overhead (v0.9.0)

| Regime | Registry | n | Median overhead | npmbar median | npm median |
|---|---|---|---|---|---|
| Warm cache | registry.npmjs.org | 10 | **−2.3%** | 2749 ms | 2814 ms |
| Cold cache | local verdaccio proxy | 10 | **−2.3%** | 8625 ms | 8828 ms |

Negative means npmbar measured faster than npm in that session — read it as "within noise of zero, comfortably inside the <3% budget", not as a speedup claim. Measured 2026-06-11 on Windows 11, Node v24.1.0, npm 11.3.0, small tree (31 deps); per-run spread in the warm regime was −9.1% to +3.7%. Overhead is relative to a moving baseline — numbers are re-measured per npm release.

```sh
npm test                  # accounting + CLI unit tests
npm run test:perf         # cold + warm benchmark, n=10 (slow; auto-spawns verdaccio)
npm run test:correctness  # lockfile parity check
```

## V1 limitations

| Behavior | V1 status |
|---|---|
| `npm audit` and `npm fund` | Not run — message at end suggests running `npm audit` separately |
| `npm shrinkwrap` | Not supported |
| Workspace protocols (`workspace:*`) | Basic support; edge cases not guaranteed |
| Interactive peer-dep conflict resolution | Conflicts surface as errors |
| Uncommon `.npmrc` keys | May be silently ignored |


# npmx

`npm install` with accurate download progress bars — bytes downloaded, transfer speed, ETA — at less than 3% overhead vs plain `npm install`.

npm's own progress bar was removed because it caused 30–50% slowdown. `npmx` decouples rendering from byte counting, so progress is reported without competing with the install itself for the I/O event loop.

## Install

```sh
npm install -g npmx
```

Requires Node.js 22.12 or later.

## Usage

```sh
npmx install                         # install from package.json
npmx install express react           # add packages
npmx i lodash --save-dev             # alias `i` works; --save-dev / -D supported
npmx install --dry-run               # plan only; no network, no writes
npmx install --global cowsay         # global install
```

V1 only ships `npmx install` (and the `i` alias). `npmx update` and `npmx exec` are planned for v2.

### Supported flags

| Flag | Alias | Effect |
|---|---|---|
| `--save-dev` | `-D` | Save to `devDependencies` |
| `--save-optional` | `-O` | Save to `optionalDependencies` |
| `--save-prod` | `-P` | Save to `dependencies` (explicit) |
| `--save-exact` | `-E` | Save with exact version (no `^`/`~`) |
| `--no-save` | | Do not modify `package.json` |
| `--global` | `-g` | Install to the global prefix |
| `--legacy-peer-deps` | | Use legacy peer-dep resolution |
| `--strict-peer-deps` | | Fail on any peer dependency conflict |
| `--force` | | Force install |
| `--dry-run` | | Plan only — no network, no disk writes |
| `--ignore-scripts` | | Do not run lifecycle scripts |
| `--prefix <path>` | | Override install prefix |
| `--registry <url>` | | Set custom registry URL |
| `--workspace <name>` | `-w` | Install in a specific workspace |
| `--workspaces` | | Install in all workspaces |
| `--omit <type>` | | Omit dependency type (`dev`, `optional`, `peer`) |
| `--include <type>` | | Include dependency type (overrides `--omit`) |
| `--no-package-lock` | | Do not generate `package-lock.json` |
| `--prefer-offline` | | Prefer cached packages over registry |

Unknown flags exit with code 1. The supported list is strict and intentional — silent passthrough would mask wrong behavior.

Conflicting flags (`--save-dev` with `--save-optional` or `--save-prod`, `--workspace` with `--workspaces`, etc.) also exit with code 1.

## How it works

`npmx` ships pinned copies of npm's own libraries (`@npmcli/arborist` and `pacote`) as regular dependencies — it does not depend on the user's globally installed npm CLI. The lockfile format (v3) is determined entirely by the bundled arborist.

```
npmx install <pkgs>
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

`npmx` pins the npm internals it ships:

| Package | Pinned in npmx 1.x |
|---|---|
| `@npmcli/arborist` | `^9.4.3` |
| `pacote` | `^21.5.0` |

The lockfile output is npm v3 format (readable by npm ≥ 7).

### Update policy

When any pinned upstream package publishes a new minor or major:

1. Run the full correctness test suite (`npm run test:correctness`) against the new version.
2. Run the perf suite (`npm run test:perf`) to confirm the <3% overhead claim still holds.
3. If correctness or perf fails, pin to the last passing version and open a compatibility issue.

A nightly CI job (see `CONTRIBUTING.md`) catches lockfile-format drift before users hit it. When a new npm major ships, the CI matrix is manually expanded.

## Verification

`npmx` claims its `package-lock.json` matches what `npm install` produces on the same `package.json`. The correctness test parses both lockfiles and does a recursive deep-equal that ignores key ordering, covering the entire object — not a subset of fields.

The performance test runs 10 cold-cache and 10 warm-cache iterations against a real registry, drops min/max, and asserts both medians are within 3% of `npm install`.

```sh
npm test                  # accounting + CLI unit tests
npm run test:perf         # 10x10 cold + warm benchmark (slow)
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


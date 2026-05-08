# Plan: `npmx` — npm install with accurate progress bars

## Context

npm has never shown accurate download progress (bytes, speed, ETA). Its old progress bar
was removed because it caused 30–50% slowdown. The goal is a globally-installable CLI
tool named `npmx` that shows real download stats with **less than 3% performance overhead**.

V1 ships `npmx install` only. `npmx update` and `npmx <exec>` are v2 once the install
path is proven. Progress reporting is best-effort and degrades gracefully.

---

## Compatibility and pinned versions

`npmx` ships its own pinned copies of arborist and pacote as regular `dependencies`.
The lockfile format is determined entirely by `npmx`'s arborist — not by the user's
globally installed npm CLI. **There is no npm CLI version gate.**

**Current ecosystem versions (as of May 2026):**

| Package | Current version | Pinned in npmx 1.x |
|---|---|---|
| `@npmcli/arborist` | 9.4.3 | `^9.4.3` |
| `pacote` | 21.5.0 | `^21.5.0` |
| npm CLI (for reference only) | 11.14.0 | — not a dependency — |

These pins are explicit in `package.json` and listed in the README. The release process
requires re-running the full correctness test suite whenever any of these packages
publishes a new minor or major. If the semantic lockfile comparison fails after an
upstream update, `npmx` pins the last passing version and opens a compatibility issue.

What we guarantee: `npmx` produces **lockfile v3** (readable by npm ≥ 7).

**Startup checks — Node.js version only:**

```js
if (!satisfies(process.version, '>=18.0.0')) {
  console.error(`npmx: requires Node.js >=18, found ${process.version}`)
  process.exit(1)
}
```

No `peerDependencies`. No npm CLI version check.

---

## V1 known limitations (explicit)

| npm behavior | V1 status |
|---|---|
| Workspace protocols (`workspace:*`, `workspace:^`) | Basic flags work; edge-case protocols not guaranteed |
| Lifecycle script ordering in non-standard topologies | Delegates to arborist |
| Interactive peer-dep conflict resolution | Not reproduced; conflicts surface as errors |
| `npm audit` and `npm fund` | Not run — tool prints "Run `npm audit` separately." |
| Uncommon `.npmrc` config keys | May be silently ignored |
| `bundledDependencies` edge cases | Depends on arborist version |
| `npm shrinkwrap` | Not supported |
| Global installs (`--global`) | Correctness test skips lockfile diff (no `package-lock.json` produced) |

Anything not on this list is a bug.

---

## Architecture

```
npmx install express react
         │
         ▼
1. Startup checks (Node.js version; lockfile-version upgrade warning)
         │
         ▼
2. Parse args + map CLI flags to arborist options (config.js)
         │
         ▼
3. ArboristAdapter.buildIdealTree()
   → resolves full dep tree
   → each idealTree node carries: spec, resolved (URL), integrity, optional flag
         │
         ▼
4. Best-effort cache probe (see Cache probe section)
   → purely for UI — wrong results are self-correcting
   → partitions packages into { likelyCached, likelyToDownload } (estimates only)
         │
         ▼
5. Download phase (PacoteAdapter + DownloadAggregator)
   → concurrent fetches for all packages (cached ones complete near-instantly)
   → setInterval(render, 100) decoupled from I/O
   → failure handling per required vs optional (see Failure policy)
         │
         ▼
6. ArboristAdapter.reify()
   → reuses idealTree from step 3
   → cache warm — no network
         │
         ▼
7. Final summary (installed, cached, failed optional, elapsed)
   → "Run `npm audit` separately to check for vulnerabilities."
```

---

## Cache probe (best-effort, not correctness-critical)

The probe exists only to seed the UI with an initial estimate of how many packages will
be downloaded vs already cached. **It is never used to skip pacote calls.** Pacote
always runs for every package — cached ones complete near-instantly with bytes sourced
from disk rather than network.

**Approach**: Use pacote with `{ preferOffline: true }` to attempt a manifest fetch
without hitting the network. If it succeeds, the manifest (and likely the tarball) is
cached. If it throws, the package needs a network fetch.

```js
async function probe(spec, opts) {
  try {
    await pacote.manifest(spec, { ...opts, preferOffline: true })
    return 'likely-cached'
  } catch {
    return 'likely-download'
  }
}
```

**Why this is acceptable**: This probes the manifest, not the tarball. A false positive
(manifest cached, tarball not) means we show "cached" in the UI but pacote still fetches
the tarball — the aggregator counts those bytes and updates the display. A false negative
(manifest not cached) means we show "downloading" for something that completes instantly.
Neither case is an error; the UI just corrects itself as events arrive.

**No `cacache` as a direct dependency.** No `createRequire` resolution from inside
pacote's node_modules. The probe uses only pacote's public API.

---

## Byte accounting model

### Per-spec state

```js
{
  spec: string,
  optional: boolean,    // from idealTree node — drives failure policy
  status: 'pending' | 'fetching' | 'cached' | 'retrying' | 'failed' | 'done',
  attempt: number,
  bytes: number,        // bytes from current attempt only
  committed: boolean    // true only after stream 'end'
}
```

### Event rules (exhaustive)

| Event | Action |
|---|---|
| Fetch starts | `status = 'fetching'` |
| `data(chunk)` | `bytes += chunk.length` |
| `end` | `committed = true; status = 'done'` |
| `end` with 0 bytes (cache hit) | `committed = true; status = 'cached'` |
| `error` → retry | `attempt++; bytes = 0; committed = false; status = 'retrying'` |
| `close` without prior `end` | Abort: `bytes = 0; committed = false` |
| HTTP redirect | Transparent — pacote handles internally; no state change |
| Permanent failure | `status = 'failed'; bytes = 0` — see Failure policy |

### Retry policy

- 2 retries on transient errors (5xx, timeout, `ECONNRESET`, `ECONNREFUSED`)
- 0 retries on permanent errors (403, 404)

### Failure policy

Required and optional dependencies are treated differently. The `optional` flag comes
from each idealTree node.

| Package type | On permanent fetch failure | Exit code |
|---|---|---|
| Required dependency | **Abort.** Clear error naming the package. Do not call `reify()`. | **1** |
| Optional dependency | **Warn and continue.** Mark `status = 'failed'`. Call `reify()`. List failures in summary. | **0** |

The exit-code contract is: **exit 0 means the install produced a usable tree.** A tree
with missing optional dependencies is still usable, so exit 0 is correct — matching
npm's own behavior. Exit 1 means the tree is definitely broken or incomplete.

This is a single unambiguous rule: exit code reflects tree usability, not whether
every fetch succeeded.

### DownloadAggregator

Holds all per-spec state. Exposes read-only methods for the render loop.
Node.js single-threaded: no locking needed.

```js
aggregator.totalBytes()   // sum of bytes (committed + in-progress)
aggregator.totalSize()    // sum of known dist_size values
aggregator.counts()       // { pending, fetching, cached, retrying, failed, done }
```

---

## Progress display

### Degradation tiers

| Condition | Bar type | Speed | ETA |
|---|---|---|---|
| All `dist_size` present | Byte fraction | MB/s | shown |
| Some `dist_size` missing | **Package fraction** (31/52) | pkgs/s | hidden |
| No `dist_size` at all | Spinner only | — | hidden |

In the middle tier, the percentage shown (e.g. `60%`) represents package count fraction
(31/52), **not byte fraction**. The bar label will read "packages" not "bytes" to make
this explicit. ETA is never shown without full size data — package-count ETA assumes
uniform package sizes, which is incorrect for real-world registries.

### Retrying display

```
retrying: 3  (latest: lodash@4.17.21, attempt 2/3)
```

Count prevents false impression that only one package is in trouble.

### Full display example

```
  ✔ Resolved 75 packages (~23 likely cached)

  ⬇  Downloading   [████████████░░░░░░░░]  60%  31/52 packages  4.2 MB/s  ETA 8s
      2.1 MB / 3.5 MB
      retrying: 1  (latest: lodash@4.17.21, attempt 2/3)

  🔗  Linking...
  ✔  Done in 12.4s  (52 downloaded, 23 cached, 0 failed)
  ⚠  1 optional package failed: bufferutil@4.0.7 (ECONNREFUSED)
  ℹ  Run `npm audit` separately to check for vulnerabilities.
```

The "~23 likely cached" is the probe estimate — the tilde signals it's approximate.

---

## Project structure

```
C:\Projects\Progress-bar\
├── package.json
├── bin/
│   └── npmx.js                # CLI entry — startup checks, parse args, route
├── src/
│   ├── adapters/
│   │   ├── arborist.js        # ONLY file that imports @npmcli/arborist
│   │   ├── pacote.js          # ONLY file that imports pacote
│   │   └── config.js          # maps CLI flags to arborist options
│   ├── cache-probe.js         # best-effort probe via pacote public API only
│   ├── aggregator.js          # DownloadAggregator
│   ├── commands/
│   │   └── install.js         # install flow + failure policy
│   ├── progress.js            # setInterval render loop, degradation logic
│   └── summary.js             # final stats + optional failure list
└── test/
    ├── correctness.js         # semantic lockfile comparison + smoke test
    ├── perf.js                # isolated cold/warm cache runs, median + p95
    └── accounting.js          # aggregator, state machine, probe unit tests
```

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@npmcli/arborist` | `^9.4.3` | Dep resolution + install |
| `pacote` | `^21.5.0` | Tarball fetching |
| `chalk` | latest | Terminal colors |
| `commander` | latest | Arg parsing |
| `semver` | latest | Node.js version check |

**No `cacache` direct dependency.** **Never import the `npm` package as a library.**

---

## Flag allowlist (strict — not a passthrough)

Only the following flags are intentionally supported and mapped to arborist options:

| Flag | Alias | Arborist option |
|---|---|---|
| `--save-dev` | `-D` | `{ save: true, saveType: 'dev' }` |
| `--save-optional` | `-O` | `{ save: true, saveType: 'optional' }` |
| `--no-save` | | `{ save: false }` |
| `--global` | `-g` | `{ global: true }` |
| `--legacy-peer-deps` | | `{ legacyPeerDeps: true }` |
| `--force` | | `{ force: true }` |
| `--dry-run` | | `{ dryRun: true }` |
| `--prefix <path>` | | `{ prefix: path }` |
| `--workspace <name>` | `-w` | `{ workspaces: [name] }` |
| `--workspaces` | | `{ workspaces: true }` |

**Any flag not on this list is an error**, not a warning:

```
npmx: unknown flag --some-flag
Supported flags: --save-dev, --save-optional, --no-save, --global,
  --legacy-peer-deps, --force, --dry-run, --prefix, --workspace
```

Exit code 1. This prevents unknown flags from silently masking wrong behavior — the
user must know the flag isn't handled before assuming the install did what they intended.

---

## V2 note: `npx` vs `npm exec`

V2 exec must define an explicit argument-parser spec. `npx` and `npm exec` are not
identical: flag placement differs, `--` handling differs, `npx` prompts before
installing while `npm exec` does not, and legacy `npx` had a shell fallback that
`npm exec` removed. V2 implements **modern `npm exec` semantics** and documents
differences from legacy `npx` explicitly. The install arg parser must not be shared
with the exec command.

---

## Publishing

- Verify `npmx` availability; also audit `npm-x`, `npmx-cli`. Fallback: `@username/npmx`.
- Binary `npmx` in `"bin"` field
- `"engines": { "node": ">=18.0.0" }`
- No `peerDependencies`
- README documents pinned versions and update policy

---

## Verification

### 1. Correctness

Run `npmx install` and `npm install` on an identical fresh project (same `package.json`,
empty `node_modules`, cleared cache):

1. **Primary — full semantic lockfile comparison**:
   Parse both `package-lock.json` as JSON. Perform a recursive deep-equal that ignores
   key ordering (keys sorted before comparison) but preserves all values. The comparison
   covers the **entire parsed object** — not a subset of fields. This catches any field
   that npm writes but `npmx` omits or differs on.

2. **Secondary**: semantic diff of `node_modules/.package-lock.json`

3. **Functional smoke test**: `node -e "require('express')"` exits 0

4. **Byte-identical diff** (optional, non-blocking): only when arborist versions match
   exactly between `npmx` and npm CLI.

Skip lockfile comparison for `--global` installs.

### 2. Performance

Required controls:
- Dedicated `NPM_CONFIG_CACHE` temp dir, cleared between cold runs
- Local Verdaccio registry with fixed package set
- Fixed committed `package.json` with 30–50 representative packages

Two suites, 10 runs each, discard min/max, report **median and p95**:
- **Cold-cache** and **warm-cache**

Assert: `(npmx_cold_median - npm_cold_median) / npm_cold_median < 0.03`

### 3. Accounting unit tests (`test/accounting.js`)

- **Retry double-count**: 500 bytes then error; 1000 bytes fully. Assert `total === 1000`.
- **Aborted stream**: `close` without `end`. Assert partial bytes not counted.
- **Redirect transparency**: 301 mid-stream. Assert bytes not reset.
- **Wrong `dist_size`**: caps at 99% until `end`. No crash.
- **Required failure**: required dep fetch fails permanently. Assert process exits
  non-zero; `reify()` not called.
- **Optional failure**: optional dep fails. Assert install completes (exit 0); failure
  listed in summary; `reify()` was called.
- **Concurrent aggregation**: 5 concurrent fetches, interleaved chunks. Assert
  `aggregator.totalBytes()` equals sum of all tarball sizes.
- **Cache-probe false positive**: probe returns 'likely-cached' but pacote delivers
  bytes. Assert aggregator counts those bytes and status updates to 'done'.

### 4. Flag parity and flag errors

- `npmx install react --save-dev` → `devDependencies` updated identically to npm.
- `npmx install react --unknown-flag` → exits 1 with an error naming the unsupported
  flag and listing the allowlist. Install must not proceed.

### 5. Global install parity (`--global`)

Because no `package-lock.json` is produced, a separate parity suite covers:

1. **Prefix layout**: after `npmx install -g cowsay`, verify the installed prefix
   directory structure matches what `npm install -g cowsay` produces (same files under
   `lib/node_modules/cowsay/`).
2. **Bin shim**: verify the `cowsay` executable exists in the prefix `bin/` directory
   and is runnable (`cowsay hello` exits 0).
3. **Package visibility**: verify `node -e "require('cowsay')"` resolves correctly
   from the global prefix.

These three checks prevent global-mode regressions that a lockfile diff would miss.

### 6. Nightly CI: lockfile format drift

Nightly job installs latest arborist, pacote, config; runs full semantic lockfile
comparison. Alerts on divergence before users hit it. When a new npm major ships,
the CI matrix must be manually expanded — this is documented in `CONTRIBUTING.md`.

### 7. Publish dry-run

`npm publish --dry-run` before any actual publish.

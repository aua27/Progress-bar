# Contributing to npmbar

## Setup

```sh
git clone https://github.com/aua27/Progress-bar.git
cd Progress-bar
npm ci
```

Requires Node.js >= 18. No build step — the CLI runs directly from source
(`node bin/npmbar.js install <pkgs>`).

## Tests

| Command | What it covers | Needs network |
|---|---|---|
| `npm test` | Aggregator/renderer unit tests + CLI flag tests | one test resolves a package |
| `npm run test:correctness` | Semantic lockfile equality vs real `npm install` + smoke test | yes |
| `npm run test:perf` | Full overhead benchmark (cold + warm, n=10 each) | yes (auto-spawns a local verdaccio registry) |

CI runs `npm test` on a {ubuntu, macos, windows} × Node {18, 20, 22, 24}
matrix plus a correctness job. PRs labeled `perf` also run the benchmark
workflow.

## The performance gate

The core project constraint is **< 3% median overhead** versus
`npm install --no-audit --no-fund` on the same tree. Benchmark rules
(enforced by the scripts — do not weaken them):

- npm runs with `--no-audit --no-fund` for work parity: npmbar does not
  audit, so npm must not be charged for those round-trips.
- Both tools get an untimed warm-up run before timing; runs are interleaved
  A/B so machine drift hits both equally.
- Results report median, IQR, and min/max — never a lone average.
- `test/perf.js` benchmarks against a local verdaccio registry on
  `localhost:4873` and auto-spawns one if absent (90s hard timeout, fails
  loudly). Run count: `--runs N` or `PERF_RUNS=N`. Large-tree scenario:
  `--large`.

Any change touching the hot path (cache probe, aggregator, renderer,
download pipeline) must include benchmark results in the PR description.

## Hard constraints

- **chalk stays at v4.** chalk v5 is ESM-only and cannot be `require()`d
  from this CommonJS project on the Node range we support.
- **arborist/pacote pins**: before bumping `@npmcli/arborist` or `pacote`,
  run `npm run test:correctness` against the new version. If semantic
  lockfile equality fails, keep the pin and open a compatibility issue.
- **Strict flag allowlist**: unknown flags are errors, never silently
  ignored. New flags need: commander option, `SUPPORTED_FLAGS_MSG` entry,
  README table row, and a CLI test.
- **Failure policy is asymmetric by design**: a required package failure
  aborts all in-flight fetches and exits 1; an optional package failure is
  recorded and the install continues with exit 0. Do not make it symmetric.
- **Byte accounting uses `dist.size`** (compressed tarball size), never
  `dist.unpackedSize`.

## Commit messages

Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `ci:`) — releases
and the changelog are automated with release-please, so the prefix
determines version bumps. Keep messages brief and factual.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately via GitHub
Security Advisories, not public issues.

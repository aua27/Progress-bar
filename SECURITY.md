# Security Policy

## Supported versions

npmbar is at an early (pre-1.0) stage. Security fixes are applied to the
latest `0.9.x` release only.

| Version | Supported          |
| ------- | ------------------ |
| 0.9.x   | :white_check_mark: |
| < 0.9   | :x:                |

## Reporting a vulnerability

Please report security issues privately through GitHub's **private
vulnerability reporting** (Security Advisories) on the repository:

- https://github.com/aua27/Progress-bar/security/advisories/new

Do not open a public issue for a suspected vulnerability. We aim to
acknowledge a report within a few days and will coordinate a fix and
disclosure timeline with you.

## Security model

npmbar is a drop-in front end for `npm install` that adds an accurate
download progress bar. It deliberately delegates the security-sensitive
work — registry access, authentication, integrity verification, and the
actual linking of packages — to the same `npm` libraries npm itself uses
(`@npmcli/arborist` and `pacote`). The progress layer is decoupled from
byte handling and never inspects or transforms tarball contents.

### Integrity enforcement

- Tarballs are streamed via `pacote.tarball.stream()` (pacote v21), which
  verifies the sha512 subresource integrity (SSRI) of every tarball through
  `cacache` on each fetch. A tarball whose bytes do not match the expected
  integrity hash is rejected — npmbar never completes a fetch with content
  that fails verification.
- A **tampered or corrupted cache entry** is detected by cacache on read.
  When the content can be re-fetched (online), cacache evicts the bad entry
  and repairs it from the registry before the operation completes; when it
  cannot (offline / `--prefer-offline`), the fetch fails rather than
  yielding corrupted bytes. Either way, corrupted content is never silently
  installed.
- Final extraction and linking (**reify**) is performed by `@npmcli/arborist`
  against the warm cache, which re-verifies integrity again. There is no
  npmbar code path that extracts a tarball without integrity verification.
- The fast cache probe (`src/cache-probe.js`) is an existence-only
  `fs.access` check on the cacache content path derived from the lockfile
  integrity hash. It is an optimization to avoid redundant work; it does not
  bypass verification. A probe "hit" only causes the package to be linked by
  reify, which verifies integrity regardless.

### Lifecycle scripts

npmbar introduces **no difference** in lifecycle-script behavior versus npm.
Scripts (`preinstall`/`install`/`postinstall`, etc.) are run by arborist
during reify exactly as npm runs them. The `--ignore-scripts` flag is
forwarded unchanged to arborist (`ignoreScripts`), so disabling scripts
behaves identically to `npm install --ignore-scripts`.

### Lockfile semantics

npmbar produces a **lockfile v3** `package-lock.json` with semantics
identical to npm (readable by npm >= 7). Correctness is verified by a
semantic deep-equal of the generated lockfile against npm's own output.
npmbar does not invent its own resolution or integrity data — the ideal tree
is built by arborist.

### Registry, authentication, and configuration

npmbar does not implement its own registry client or credential handling.
Registry URLs, scopes, auth tokens, proxies, and all other settings are read
from npm's standard configuration chain (`.npmrc` files and `npm_config_*`
environment variables) by pacote and arborist. The `--registry` flag is
passed through to arborist. npmbar never reads, logs, or transmits
credentials itself.

## The audit story

npmbar V1 does **not** run `npm audit` as part of `install`. The install
summary prints a reminder instead:

> Run `npm audit` separately.

An opt-in `--audit` flag was evaluated and **deferred to V1.1**. Rationale:

- The core project constraint is **< 3% overhead** versus a plain
  `npm install` on a warm cache. Running an audit adds an extra registry
  round-trip on the install hot path, which works against establishing that
  overhead claim cleanly.
- Auditing is an orthogonal concern to npmbar's purpose (accurate progress)
  and is fully available today via `npm audit`.

The decision will be revisited once real-world usage data exists and the
overhead budget is established. Until then, run `npm audit` separately for
vulnerability scanning.

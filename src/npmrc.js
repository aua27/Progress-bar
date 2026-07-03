'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const ini = require('ini');

// Standalone @npmcli/arborist does NOT run npm's config loader, so it never
// reads a `registry` from .npmrc — it silently defaults to registry.npmjs.org.
// npmbar bridges the two files npm reads most often: the project ./.npmrc
// (highest precedence) then the user ~/.npmrc. Global and builtin npmrc, plus
// npm's `${VAR}` env-expansion and per-scope `@scope:registry` keys, are V2
// (they need @npmcli/config) — see BLINDSPOTS §0.
function readNpmrcRegistry(cwd = process.cwd()) {
  const candidates = [
    path.join(cwd, '.npmrc'),
    path.join(os.homedir(), '.npmrc'),
  ];
  for (const file of candidates) {
    let contents;
    try {
      contents = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // missing/unreadable .npmrc is normal — try the next one
    }
    let parsed;
    try {
      parsed = ini.parse(contents);
    } catch {
      continue; // malformed .npmrc: skip rather than crash the install
    }
    if (parsed && typeof parsed.registry === 'string' && parsed.registry.trim()) {
      return parsed.registry.trim();
    }
  }
  return undefined;
}

// Registry precedence, highest first: an explicit --registry flag (already on
// opts), then the npm_config_registry env var, then .npmrc. Returns undefined
// when nothing is configured, letting arborist fall back to its own default.
function resolveRegistry(flagRegistry, cwd = process.cwd()) {
  return flagRegistry
    || process.env.npm_config_registry
    || process.env.NPM_CONFIG_REGISTRY
    || readNpmrcRegistry(cwd)
    || undefined;
}

module.exports = { readNpmrcRegistry, resolveRegistry };

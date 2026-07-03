'use strict';

const Arborist = require('@npmcli/arborist');
const { cacacheRoot } = require('../cache-probe');
const { resolveRegistry } = require('../npmrc');

class ArboristAdapter {
  constructor(opts = {}) {
    // Bridge npm's env-var cache override (NPM_CONFIG_CACHE / npm_config_cache)
    // into arborist's options. @npmcli/arborist v9 does not read these env vars
    // itself — it would fall back to ~/.npm/_cacache, ignoring the override.
    const resolvedOpts = { ...opts };
    if (!resolvedOpts.cache) {
      const envCache = process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE;
      if (envCache) resolvedOpts.cache = envCache;
    }
    // arborist uses `options.cache` verbatim as the cacache ROOT, whereas npm's
    // own `cache` config points at the PARENT and npm appends `_cacache` before
    // handing it to arborist. Mirror npm: normalize to `<cache>/_cacache` so
    // npmbar and npm share one cache dir, and so it matches where cache-probe
    // (which applies the same normalization) actually looks.
    if (resolvedOpts.cache) {
      resolvedOpts.cache = cacacheRoot(resolvedOpts.cache);
    }
    // Standalone arborist runs no npm config loader, so it ignores
    // npm_config_registry and .npmrc — it silently defaults to npmjs.org even
    // when the user (or our benchmark) configured a private/local registry.
    // Bridge it here, mirroring the cache bridge above. The --registry flag,
    // if given, is already on resolvedOpts and wins (see resolveRegistry).
    if (!resolvedOpts.registry) {
      const registry = resolveRegistry(resolvedOpts.registry);
      if (registry) resolvedOpts.registry = registry;
    }
    this.opts = resolvedOpts;
    this.arb = new Arborist(resolvedOpts);
    this._idealTree = null;

    // Runtime API surface check — catch arborist major version breaks early.
    // These are the undocumented arborist internals we depend on.
    if (typeof this.arb.buildIdealTree !== 'function') {
      throw new Error('npmbar: incompatible @npmcli/arborist — missing buildIdealTree(). Check pinned version.');
    }
    if (typeof this.arb.reify !== 'function') {
      throw new Error('npmbar: incompatible @npmcli/arborist — missing reify(). Check pinned version.');
    }
  }

  async buildIdealTree(packages) {
    const addOpts = packages && packages.length ? { add: packages } : {};
    this._idealTree = await this.arb.buildIdealTree(addOpts);
    return this._idealTree;
  }

  get idealTree() {
    return this._idealTree;
  }

  extractPackageSpecs() {
    if (!this._idealTree) throw new Error('idealTree not built');
    if (!this._idealTree.inventory || typeof this._idealTree.inventory.values !== 'function') {
      throw new Error('npmbar: incompatible @npmcli/arborist — missing idealTree.inventory.values(). Check pinned version.');
    }
    // Deduplicate by resolved URL: the same tarball can appear at multiple
    // depths in the tree (hoisted and nested peers). We only need one fetch per URL.
    // `optional` is a property of the dependency edge, not the tarball. A package
    // reachable through both a required and an optional edge must be treated as
    // required — otherwise its fetch failure is swallowed instead of aborting the
    // install. AND the flag across every occurrence of the same resolved URL.
    const byResolved = new Map();
    for (const node of this._idealTree.inventory.values()) {
      if (node.isRoot) continue;
      if (!node.resolved) continue;
      const existing = byResolved.get(node.resolved);
      if (existing) {
        existing.optional = existing.optional && !!node.optional;
        continue;
      }
      byResolved.set(node.resolved, {
        name: node.name,
        version: node.version,
        spec: `${node.name}@${node.version}`,
        key: node.resolved,   // unique identifier; resolved is deduped by the map
        resolved: node.resolved,
        integrity: node.integrity,
        optional: !!node.optional,
        // dist.size is the compressed tarball size — what pacote actually streams.
        // dist.unpackedSize is 4-7x larger and makes the progress bar stall at ~23%.
        distSize: node.package?.dist?.size ?? null,
      });
    }
    return [...byResolved.values()];
  }

  get pacoteOpts() {
    // Standalone arborist does NOT load npm config (.npmrc, registry, cache) —
    // the constructor above bridges those in. Expose arborist's resolved options
    // so our explicit pacote calls (probe, download, re-verify) use the same
    // registry and cache as reify().
    return this.arb.options || {};
  }

  async reify() {
    return this.arb.reify({ idealTree: this._idealTree });
  }
}

module.exports = ArboristAdapter;

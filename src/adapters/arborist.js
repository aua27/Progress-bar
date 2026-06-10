'use strict';

const Arborist = require('@npmcli/arborist');

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
    const seen = new Set();
    const specs = [];
    for (const node of this._idealTree.inventory.values()) {
      if (node.isRoot) continue;
      if (!node.resolved) continue;
      if (seen.has(node.resolved)) continue;
      seen.add(node.resolved);
      specs.push({
        name: node.name,
        version: node.version,
        spec: `${node.name}@${node.version}`,
        key: node.resolved,   // unique identifier; resolved is already deduped above
        resolved: node.resolved,
        integrity: node.integrity,
        optional: !!node.optional,
        // dist.size is the compressed tarball size — what pacote actually streams.
        // dist.unpackedSize is 4-7x larger and makes the progress bar stall at ~23%.
        distSize: node.package?.dist?.size ?? null,
      });
    }
    return specs;
  }

  get pacoteOpts() {
    // Arborist loads .npmrc, auth tokens, registry, proxy etc. during construction.
    // Expose its resolved options so our explicit pacote calls use the same config.
    return this.arb.options || {};
  }

  async reify() {
    return this.arb.reify({ idealTree: this._idealTree });
  }
}

module.exports = ArboristAdapter;

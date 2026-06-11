'use strict';

const path = require('path');

function getArboristOpts(parsedFlags, extraOpts = {}) {
  const opts = { ...extraOpts };

  // parsedFlags.progress (--progress / --no-progress) is a renderer concern,
  // consumed in src/commands/install.js — deliberately NOT mapped to arborist.

  if (parsedFlags.saveDev) {
    opts.save = true;
    opts.saveType = 'dev';
  } else if (parsedFlags.saveOptional) {
    opts.save = true;
    opts.saveType = 'optional';
  } else if (parsedFlags.saveProd) {
    opts.save = true;
    opts.saveType = 'prod';
  } else if (parsedFlags.save === false) {
    opts.save = false;
  } else {
    opts.save = true;
  }

  if (parsedFlags.global) opts.global = true;
  if (parsedFlags.legacyPeerDeps) opts.legacyPeerDeps = true;
  if (parsedFlags.force) opts.force = true;
  if (parsedFlags.dryRun) opts.dryRun = true;
  if (parsedFlags.prefix) {
    // arborist.prefix = npm global prefix; arborist.path = local project root.
    // --prefix on a local install should set 'path', not 'prefix'.
    if (parsedFlags.global) {
      opts.prefix = path.resolve(parsedFlags.prefix);
    } else {
      opts.path = path.resolve(parsedFlags.prefix);
    }
  }
  if (parsedFlags.workspace) opts.workspaces = [parsedFlags.workspace];
  // arborist expects workspaces as an array; empty array means "all workspaces".
  // Boolean true is not valid and causes reify() to throw "not iterable".
  if (parsedFlags.workspaces) opts.workspaces = [];

  if (parsedFlags.saveExact) opts.savePrefix = '';
  if (parsedFlags.ignoreScripts) opts.ignoreScripts = true;
  if (parsedFlags.registry) opts.registry = parsedFlags.registry;
  if (parsedFlags.omit && parsedFlags.omit.length) opts.omit = parsedFlags.omit;
  if (parsedFlags.include && parsedFlags.include.length) opts.include = parsedFlags.include;
  if (parsedFlags.strictPeerDeps) opts.strictPeerDeps = true;
  if (parsedFlags.packageLock === false) opts.packageLock = false;
  if (parsedFlags.preferOffline) opts.preferOffline = true;
  if (parsedFlags.fetchRetries !== undefined) opts.fetchRetries = parseInt(parsedFlags.fetchRetries, 10);
  if (parsedFlags.fetchRetryFactor !== undefined) opts.fetchRetryFactor = parseFloat(parsedFlags.fetchRetryFactor);
  if (parsedFlags.fetchRetryMintimeout !== undefined) opts.fetchRetryMintimeout = parseInt(parsedFlags.fetchRetryMintimeout, 10);
  if (parsedFlags.fetchRetryMaxtimeout !== undefined) opts.fetchRetryMaxtimeout = parseInt(parsedFlags.fetchRetryMaxtimeout, 10);

  return opts;
}

module.exports = { getArboristOpts };

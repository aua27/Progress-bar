'use strict';

const path = require('path');

function getArboristOpts(parsedFlags, extraOpts = {}) {
  const opts = { ...extraOpts };

  if (parsedFlags.saveDev) {
    opts.save = true;
    opts.saveType = 'dev';
  } else if (parsedFlags.saveOptional) {
    opts.save = true;
    opts.saveType = 'optional';
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

  return opts;
}

module.exports = { getArboristOpts };

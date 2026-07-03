'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // The codebase uses empty catch deliberately (probe misses, teardown
      // races) — each site carries a comment explaining why.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    ignores: [
      'node_modules/**',
      'scratch/**',
      // Local-only, gitignored (absent from a fresh clone):
      'test/chaos.js',
      'test/arborist-api-check.js',
    ],
  },
];

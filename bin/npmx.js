#!/usr/bin/env node
'use strict';

const { satisfies } = require('semver');

if (!satisfies(process.version, '>=18.0.0')) {
  console.error(`npmx: requires Node.js >=18, found ${process.version}`);
  process.exit(1);
}

const { Command } = require('commander');
const installCommand = require('../src/commands/install');

const SUPPORTED_FLAGS_MSG = 'Supported flags: --save-dev, --save-optional, --no-save, --global,\n  --legacy-peer-deps, --force, --dry-run, --prefix, --workspace, --workspaces';

const program = new Command();

program
  .name('npmx')
  .description('npm install with accurate download progress bars')
  .version(require('../package.json').version)
  .exitOverride()
  .configureOutput({ writeErr: () => {} });

program
  .command('install [packages...]')
  .alias('i')
  .description('Install packages')
  .option('-D, --save-dev', 'Save to devDependencies')
  .option('-O, --save-optional', 'Save to optionalDependencies')
  .option('--no-save', 'Do not save to package.json')
  .option('-g, --global', 'Install globally')
  .option('--legacy-peer-deps', 'Use legacy peer deps resolution')
  .option('--force', 'Force install')
  .option('--dry-run', 'Dry run (no writes)')
  .option('--prefix <path>', 'Set prefix directory')
  .option('-w, --workspace <name>', 'Install in specific workspace')
  .option('--workspaces', 'Install in all workspaces')
  .allowUnknownOption(false)
  .exitOverride(err => {
    if (err.code === 'commander.unknownOption') {
      const flag = err.message.match(/'([^']+)'/)?.[1] || err.message;
      console.error(`npmx: unknown flag ${flag}`);
      console.error(SUPPORTED_FLAGS_MSG);
      process.exit(1);
    }
    throw err;
  })
  .action(async (packages, opts) => {
    await installCommand(packages, opts).catch(err => {
      console.error(`npmx: ${err.message}`);
      process.exit(1);
    });
  });

program.on('command:*', () => {
  console.error(`npmx: unknown command '${program.args[0]}'`);
  console.error('V1 only supports: install');
  process.exit(1);
});

// No arguments — print help and exit cleanly
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch(err => {
  // Commander throws for --version and help subcommands too — all are clean exits.
  if (err.code === 'commander.helpDisplayed' ||
      err.code === 'commander.help' ||
      err.code === 'commander.version') process.exit(0);
  console.error(`npmx: ${err.message}`);
  process.exit(1);
});

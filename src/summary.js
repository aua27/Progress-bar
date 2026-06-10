'use strict';

const chalk = require('chalk');

function printSummary(aggregator, elapsedMs, flags = {}) {
  const counts = aggregator.counts();
  const failures = aggregator.failures();
  const elapsed = (elapsedMs / 1000).toFixed(1);

  let statusParts = `${counts.done} downloaded, ${counts.cached} cached`;
  if (counts.failed > 0) statusParts += `, ${counts.failed} failed`;
  if (counts.aborted > 0) statusParts += `, ${counts.aborted} aborted`;
  console.log(`  ${chalk.green('✔')}  Done in ${elapsed}s  (${statusParts})`);

  if (failures.length === 1) {
    const f = failures[0];
    const errMsg = f.error ? (f.error.code || f.error.message) : 'unknown error';
    console.log(`  ${chalk.yellow('⚠')}  1 optional package failed: ${f.spec} (${errMsg})`);
  } else if (failures.length > 1) {
    console.log(`  ${chalk.yellow('⚠')}  ${failures.length} optional packages failed:`);
    for (const f of failures) {
      const errMsg = f.error ? (f.error.code || f.error.message) : 'unknown error';
      console.log(`       ${f.spec} (${errMsg})`);
    }
  }

  const mismatches = aggregator.distSizeMismatches();
  if (mismatches > 0) {
    console.log(`  ${chalk.yellow('⚠')}  ${mismatches} package(s) had compressed size ≠ declared dist.size (progress bar may have been inaccurate)`);
  }

  if (!flags.global) {
    console.log(`  ${chalk.blue('ℹ')}  Run \`npm audit\` separately to check for vulnerabilities.`);
  }
}

module.exports = { printSummary };

'use strict';

const chalk = require('chalk');
const { MAX_RETRIES } = require('./adapters/pacote');

const RENDER_INTERVAL_MS = 100;
const BAR_WIDTH = 20;
const SPEED_WINDOW_MS = 2000;

function makeBar(fraction, width) {
  const filled = Math.round(fraction * width);
  const empty = width - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

class ProgressRenderer {
  constructor(aggregator) {
    this._agg = aggregator;
    this._timer = null;
    this._lastSampleTime = Date.now();
    this._lastBytes = 0;
    this._lastCompleted = 0;
    this._byteSamples = [];
    this._pkgSamples = [];
    this._lines = 0;
  }

  start() {
    if (!process.stdout.isTTY) return;
    this._timer = setInterval(() => this._render(), RENDER_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._clearLines();
  }

  _takeSample() {
    const now = Date.now();
    const bytes = this._agg.totalBytes();
    const counts = this._agg.counts();
    const completed = counts.done + counts.cached + counts.failed;
    const dt = (now - this._lastSampleTime) / 1000;

    if (dt > 0) {
      const byteRate = (bytes - this._lastBytes) / dt;
      const pkgRate = (completed - this._lastCompleted) / dt;
      this._byteSamples.push({ rate: byteRate, time: now });
      this._pkgSamples.push({ rate: pkgRate, time: now });
      this._byteSamples = this._byteSamples.filter(s => now - s.time < SPEED_WINDOW_MS);
      this._pkgSamples = this._pkgSamples.filter(s => now - s.time < SPEED_WINDOW_MS);
    }

    this._lastBytes = bytes;
    this._lastCompleted = completed;
    this._lastSampleTime = now;

    const byteSpeed = this._byteSamples.length > 0
      ? this._byteSamples.reduce((a, s) => a + s.rate, 0) / this._byteSamples.length
      : 0;
    const pkgSpeed = this._pkgSamples.length > 0
      ? this._pkgSamples.reduce((a, s) => a + s.rate, 0) / this._pkgSamples.length
      : 0;

    return { byteSpeed, pkgSpeed };
  }

  _render() {
    const counts = this._agg.counts();
    const total = this._agg.total();
    const completed = counts.done + counts.cached + counts.failed;
    const { byteSpeed, pkgSpeed } = this._takeSample();
    const totalBytes = this._agg.totalBytes();
    const totalSize = this._agg.totalSize();
    const knownSize = this._agg.knownSizeCount();
    const retrying = this._agg.retryingDetails();

    this._clearLines();

    const lines = [];

    if (knownSize === total && totalSize != null && totalSize > 0) {
      // Tier 1: byte fraction — all dist_sizes known (compressed tarball sizes)
      const raw = totalBytes / totalSize;
      const fraction = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.99) : 0;
      const pct = Math.round(fraction * 100);
      const bar = makeBar(fraction, BAR_WIDTH);
      const speedStr = byteSpeed > 0 ? `  ${(byteSpeed / 1048576).toFixed(1)} MB/s` : '';
      const etaStr = byteSpeed > 0 && totalSize > totalBytes
        ? `  ETA ${Math.round((totalSize - totalBytes) / byteSpeed)}s`
        : '';
      lines.push(`  ${chalk.blue('⬇')}  Downloading   [${bar}]  ${pct}%  ${completed}/${total} packages${speedStr}${etaStr}`);
      lines.push(`      ${(totalBytes / 1048576).toFixed(1)} MB / ${(totalSize / 1048576).toFixed(1)} MB`);
    } else if (total > 0) {
      // Tier 2: package fraction — some or all dist_sizes missing
      const fraction = Math.min(completed / total, 0.99);
      const pct = Math.round(fraction * 100);
      const bar = makeBar(fraction, BAR_WIDTH);
      const speedStr = pkgSpeed > 0.1 ? `  ${pkgSpeed.toFixed(1)} pkgs/s` : '';
      lines.push(`  ${chalk.blue('⬇')}  Downloading   [${bar}]  ${pct}%  ${completed}/${total} packages${speedStr}`);
    } else {
      // Tier 3: spinner — no packages registered yet
      const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
      const frame = frames[Math.floor(Date.now() / 100) % frames.length];
      lines.push(`  ${chalk.blue(frame)}  Downloading...`);
    }

    if (retrying.length > 0) {
      const latest = retrying[retrying.length - 1];
      lines.push(`      ${chalk.yellow('retrying:')} ${retrying.length}  (latest: ${latest.spec}, retry ${latest.attempt}/${MAX_RETRIES})`);
    }

    for (const line of lines) {
      process.stdout.write(line + '\n');
    }
    this._lines = lines.length;
  }

  _clearLines() {
    if (this._lines > 0) {
      process.stdout.write(`\x1b[${this._lines}A\x1b[0J`);
      this._lines = 0;
    }
  }
}

module.exports = ProgressRenderer;

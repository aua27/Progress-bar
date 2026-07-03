'use strict';

const chalk = require('chalk');

const RENDER_INTERVAL_MS = 100;
const BAR_WIDTH = 20;
const SPEED_WINDOW_MS = 2000;
// When stdout is a TTY but reports no width (some pseudo-terminals), assume
// the classic 80 columns rather than risking wrapped re-renders.
const FALLBACK_COLUMNS = 80;

// Matches CSI escape sequences (SGR colors, cursor movement). Our output only
// ever contains chalk SGR codes, so this is sufficient for width measurement.
// eslint-disable-next-line no-control-regex -- matching the ESC control byte is the point
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, '');
}

function visibleLength(str) {
  return stripAnsi(str).length;
}

// --- Cursor lifecycle --------------------------------------------------------
// Terminal corruption on crash is the #1 progress-bar bug class: hide the
// cursor, die, and the user's shell is left cursor-less. A single module-level
// 'exit' hook restores it, but ONLY if the renderer ever hid it AND stdout is
// a real terminal (never write escapes into a pipe). Idempotent: once the
// cursor is shown again (by stop() or by the hook), the flag clears and
// nothing more is ever written.
let cursorHidden = false;
let exitHookInstalled = false;

function hideCursor(stream) {
  if (!stream.isTTY) return;
  stream.write('\x1b[?25l');
  cursorHidden = true;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      if (cursorHidden && process.stdout.isTTY) {
        process.stdout.write('\x1b[?25h');
      }
      cursorHidden = false;
    });
  }
}

function showCursor(stream) {
  if (!cursorHidden) return;
  if (stream.isTTY) stream.write('\x1b[?25h');
  cursorHidden = false;
}

// Decide whether progress rendering should be active at all. npm parity:
// suppressed by --no-progress, in CI, and when stdout is not a TTY.
// CI='' and CI='false' are treated as "not CI" (matches ci-info semantics).
// An explicit --progress does NOT force rendering into CI/non-TTY — a
// multi-line redrawing bar is meaningless in a pipe.
function progressEnabled(flag, env = process.env, stream = process.stdout) {
  if (flag === false) return false;
  if (env.CI && env.CI !== 'false') return false;
  if (!stream.isTTY) return false;
  return true;
}

function makeBar(fraction, width) {
  const filled = Math.round(fraction * width);
  const empty = width - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

class ProgressRenderer {
  constructor(aggregator, opts = {}) {
    this._agg = aggregator;
    this._out = opts.stream || process.stdout;
    this._enabled = typeof opts.enabled === 'boolean'
      ? opts.enabled
      : progressEnabled(undefined, process.env, this._out);
    this._timer = null;
    this._lastSampleTime = Date.now();
    this._lastBytes = 0;
    this._lastCompleted = 0;
    this._byteSamples = [];
    this._pkgSamples = [];
    this._lines = 0;
  }

  start() {
    if (!this._enabled || !this._out.isTTY) return;
    hideCursor(this._out);
    this._timer = setInterval(() => this._render(), RENDER_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._clearLines();
    // No-op unless start() actually hid the cursor — a disabled renderer
    // never emits escapes on stop().
    showCursor(this._out);
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
    if (!this._enabled || !this._out.isTTY) return;
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
      lines.push(`      ${chalk.yellow('retrying:')} ${retrying.length}  (latest: ${latest.spec}, retry ${latest.attempt})`);
    }

    // Never let a render line wrap: a wrapped line breaks the cursor-up
    // clearing math and spams scrollback on every 100ms tick (the classic
    // npm gauge bug). Truncate to columns-1; when a line must be cut,
    // strip styling first so ANSI codes can never be sliced in half.
    const cols = Number.isInteger(this._out.columns) && this._out.columns > 0
      ? this._out.columns
      : FALLBACK_COLUMNS;
    const maxWidth = Math.max(1, cols - 1);
    for (const line of lines) {
      const out = visibleLength(line) > maxWidth
        ? stripAnsi(line).slice(0, maxWidth)
        : line;
      this._out.write(out + '\n');
    }
    this._lines = lines.length;
  }

  _clearLines() {
    if (this._lines > 0) {
      this._out.write(`\x1b[${this._lines}A\x1b[0J`);
      this._lines = 0;
    }
  }
}

module.exports = ProgressRenderer;
module.exports.progressEnabled = progressEnabled;

// lib/logger.js — Structured logging to replace silent catch blocks (H3)

const fs = require('fs');
const path = require('path');

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LOG_LEVELS.info;
let logFile = null;

let writeCount = 0;
const ROTATION_CHECK_INTERVAL = 100;
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 3;

let buffer = [];
let flushTimer = null;
const FLUSH_INTERVAL_MS = 500;

function _scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    _flush();
  }, FLUSH_INTERVAL_MS);
}

async function _flush() {
  if (!logFile || buffer.length === 0) return;
  const lines = buffer.splice(0, buffer.length);
  try {
    await fs.promises.appendFile(logFile, lines.join('\n') + '\n');
  } catch { /* last resort */ }
}

function _flushSync() {
  if (!logFile || buffer.length === 0) return;
  const lines = buffer.splice(0, buffer.length);
  try {
    fs.appendFileSync(logFile, lines.join('\n') + '\n');
  } catch { /* last resort */ }
}

process.on('exit', _flushSync);

function setLevel(level) {
  if (level in LOG_LEVELS) minLevel = LOG_LEVELS[level];
}

function setLogFile(filePath) {
  logFile = filePath;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    process.stderr.write(`[auto-claude] Could not create log directory: ${err.message}\n`);
  }
}

function _rotateIfNeeded(filePath, maxSize) {
  const threshold = maxSize || MAX_LOG_SIZE;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < threshold) return;

    // Delete oldest, shift others
    const oldest = filePath + '.' + MAX_ROTATED_FILES;
    try { fs.unlinkSync(oldest); } catch { /* ok */ }
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const from = filePath + '.' + i;
      const to = filePath + '.' + (i + 1);
      try { fs.renameSync(from, to); } catch { /* ok */ }
    }
    fs.renameSync(filePath, filePath + '.1');
  } catch { /* stat failed — nothing to rotate */ }
}

function log(level, context, message, extra) {
  if (LOG_LEVELS[level] < minLevel) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    ctx: context,
    msg: message,
  };
  if (extra !== undefined) {
    entry.detail = typeof extra === 'string' ? extra :
      (extra instanceof Error ? extra.message : JSON.stringify(extra));
  }

  const line = JSON.stringify(entry);

  // Always write errors to stderr
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`[auto-claude:${level}] ${context}: ${message}${extra ? ' — ' + (extra instanceof Error ? extra.message : String(extra)) : ''}\n`);
  }

  // Write to log file if configured
  if (logFile) {
    buffer.push(line);
    if (level === 'error') {
      _flushSync(); // Errors flush immediately
    } else {
      _scheduleFlush();
      writeCount++;
      if (writeCount % ROTATION_CHECK_INTERVAL === 0) {
        _flushSync(); // Flush before rotation check
        _rotateIfNeeded(logFile);
      }
    }
  }
}

module.exports = {
  setLevel,
  setLogFile,
  debug: (ctx, msg, extra) => log('debug', ctx, msg, extra),
  info: (ctx, msg, extra) => log('info', ctx, msg, extra),
  warn: (ctx, msg, extra) => log('warn', ctx, msg, extra),
  error: (ctx, msg, extra) => log('error', ctx, msg, extra),
  _rotateIfNeeded,
  _flushSync,
};

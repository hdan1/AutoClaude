// lib/logger.js — Structured logging to replace silent catch blocks (H3)

const fs = require('fs');
const path = require('path');

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LOG_LEVELS.info;
let logFile = null;

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
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch {
      // Last resort — can't log about logging failures
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
};

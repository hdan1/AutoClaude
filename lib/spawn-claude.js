// lib/spawn-claude.js — Centralized claude binary spawn helper
const { spawn } = require('child_process');
const { findClaudePath } = require('./claude-detection');

function getClaudeCommand() {
  const resolved = findClaudePath();
  if (resolved) {
    return { cmd: resolved, shellFlag: false };
  }
  return { cmd: 'claude', shellFlag: process.platform === 'win32' };
}

function spawnClaude(args, options = {}) {
  const { cmd, shellFlag } = getClaudeCommand();
  const mergedOptions = {
    windowsHide: true,
    ...options,
  };
  if (shellFlag) {
    mergedOptions.shell = true;
  }
  return spawn(cmd, args, mergedOptions);
}

function killClaudeProcess(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      const tk = spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
      tk.on('error', () => { /* taskkill not found — best effort */ });
    } else {
      proc.kill('SIGTERM');
    }
  } catch { /* process may have already exited */ }
}

module.exports = { spawnClaude, killClaudeProcess, getClaudeCommand };

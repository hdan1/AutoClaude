'use strict';
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const {
  HOOK_POLL_INTERVAL_MS,
  RING_BUFFER_HOOK_EVENTS,
  MAX_HOOK_LOG_BYTES,
} = require('./constants');

function getHookWatcherFailureKey(watcher) {
  return watcher === 'worktree' ? '_worktreeHookWatcherFailures' : '_hookWatcherFailures';
}

function getHookWatcherDegradedKey(watcher) {
  return watcher === 'worktree' ? '_worktreeHookWatcherDegraded' : '_hookWatcherDegraded';
}

function noteHookWatcherFailure(proxy, details, watcher = 'main') {
  const key = getHookWatcherFailureKey(watcher);
  const degradedKey = getHookWatcherDegradedKey(watcher);
  proxy[key] = (proxy[key] || 0) + 1;
  if (proxy[key] === 3) {
    proxy[degradedKey] = true;
    proxy.emit('telemetry-degraded', {
      severity: 'warning',
      scope: 'telemetry',
      summary: 'Telemetry degraded',
      details,
      nextSteps: [
        'Keep session running',
        'Open app logs',
        'Check hook log file permissions',
      ],
    });
  }
}

function noteHookWatcherSuccess(proxy, watcher = 'main') {
  const failureKey = getHookWatcherFailureKey(watcher);
  const degradedKey = getHookWatcherDegradedKey(watcher);
  proxy[failureKey] = 0;
  if (!proxy[degradedKey]) return;
  proxy[degradedKey] = false;
  if (!proxy._hookWatcherDegraded && !proxy._worktreeHookWatcherDegraded) {
    proxy.emit('telemetry-restored', {
      scope: 'telemetry',
      summary: 'Telemetry restored',
    });
  }
}

function startHookWatcher(proxy, projectDir, result) {
  const logFile = path.join(projectDir, proxy.config.hooks?.logFile || '.planning/auto-claude-hooks.jsonl');

  try {
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch { /* silent */ }

  try {
    const stat = fs.statSync(logFile);
    proxy.hookByteOffset = stat.size;
  } catch {
    proxy.hookByteOffset = 0;
  }

  const poll = async () => {
    await readHookLog(proxy, logFile, result);
    if (!proxy._hookWatcherStopped) {
      proxy.hookWatcher = setTimeout(poll, HOOK_POLL_INTERVAL_MS);
    }
  };
  proxy._hookWatcherStopped = false;
  proxy.hookWatcher = setTimeout(poll, HOOK_POLL_INTERVAL_MS);
}

async function readHookLog(proxy, logFile, result) {
  try {
    let stat;
    try { stat = await fs.promises.stat(logFile); } catch { return; }
    if (stat.size < proxy.hookByteOffset) { proxy.hookByteOffset = 0; }
    if (stat.size === proxy.hookByteOffset) {
      noteHookWatcherSuccess(proxy, 'main');
      return;
    }

    const maxBytes = ((proxy.config.hooks?.maxLogSizeMB || 5) * 1024 * 1024) || MAX_HOOK_LOG_BYTES;
    if (stat.size > maxBytes) {
      try {
        const all = await fs.promises.readFile(logFile, 'utf8');
        const lines = all.split('\n').filter(l => l.trim());
        const keep = lines.slice(Math.floor(lines.length / 2));
        const tmpFile = logFile + '.tmp';
        await fs.promises.writeFile(tmpFile, keep.join('\n') + '\n');
        await fs.promises.rename(tmpFile, logFile);
        const newStat = await fs.promises.stat(logFile);
        proxy.hookByteOffset = newStat.size;
        return;
      } catch (e) { logger.debug('proxy', `hook log truncation failed: ${e.message}`); }
    }

    const newBytes = stat.size - proxy.hookByteOffset;
    const buf = Buffer.alloc(newBytes);
    const fh = await fs.promises.open(logFile, 'r');
    try {
      await fh.read(buf, 0, newBytes, proxy.hookByteOffset);
    } finally {
      await fh.close();
    }

    proxy.hookByteOffset = stat.size;

    const newContent = buf.toString('utf8');
    const lines = newContent.split('\n').filter(l => l.trim());
    let parsedAtLeastOneLine = false;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        parsedAtLeastOneLine = true;
        result.hookEvents.push(entry);
        if (result.hookEvents.length > RING_BUFFER_HOOK_EVENTS) result.hookEvents = result.hookEvents.slice(-RING_BUFFER_HOOK_EVENTS);
        proxy.emit('hook-event', entry);
        trackRedundantReads(proxy, entry);
      } catch (err) {
        noteHookWatcherFailure(proxy, err.message, 'main');
        logger.debug('proxy', `JSON parse failed: ${err.message}`);
      }
    }
    if (parsedAtLeastOneLine) noteHookWatcherSuccess(proxy, 'main');
  } catch (err) {
    noteHookWatcherFailure(proxy, err.message, 'main');
    logger.debug('proxy', `hook log read failed: ${err.message}`);
  }
}

async function flushHookLog(proxy, projectDir, result) {
  const logFile = path.join(projectDir, proxy.config.hooks?.logFile || '.planning/auto-claude-hooks.jsonl');
  await readHookLog(proxy, logFile, result);
}

function trackRedundantReads(proxy, entry) {
  const toolName = entry.tool_name || entry.tool || '';
  if (toolName !== 'Read') return;
  const filePath = entry.input?.file_path || entry.file_path || '';
  if (!filePath) return;
  const count = (proxy._readCounts.get(filePath) || 0) + 1;
  proxy._readCounts.set(filePath, count);
  if (count >= 3) {
    const fileName = path.basename(filePath);
    proxy.emit('redundant-reads', { filePath, fileName, count });
  }
}

function stopHookWatcher(proxy) {
  proxy._hookWatcherStopped = true;
  if (proxy.hookWatcher) {
    clearTimeout(proxy.hookWatcher);
    proxy.hookWatcher = null;
  }
  if (proxy.worktreeHookWatcher) {
    clearTimeout(proxy.worktreeHookWatcher);
    proxy.worktreeHookWatcher = null;
  }
}

function startWorktreeHookWatcher(proxy, worktreeDir, result) {
  if (proxy.worktreeDir) return;
  proxy.worktreeDir = worktreeDir;
  const logFile = path.join(worktreeDir, proxy.config.hooks?.logFile || '.planning/auto-claude-hooks.jsonl');

  try {
    const stat = fs.statSync(logFile);
    proxy.worktreeHookByteOffset = stat.size;
  } catch {
    proxy.worktreeHookByteOffset = 0;
  }

  const pollWorktree = async () => {
    await readWorktreeHookLog(proxy, logFile, result);
    if (!proxy._hookWatcherStopped) {
      proxy.worktreeHookWatcher = setTimeout(pollWorktree, HOOK_POLL_INTERVAL_MS);
    }
  };
  proxy.worktreeHookWatcher = setTimeout(pollWorktree, HOOK_POLL_INTERVAL_MS);
}

async function readWorktreeHookLog(proxy, logFile, result) {
  try {
    let stat;
    try { stat = await fs.promises.stat(logFile); } catch { return; }
    if (stat.size < proxy.worktreeHookByteOffset) { proxy.worktreeHookByteOffset = 0; }
    if (stat.size === proxy.worktreeHookByteOffset) {
      noteHookWatcherSuccess(proxy, 'worktree');
      return;
    }

    const newBytes = stat.size - proxy.worktreeHookByteOffset;
    const buf = Buffer.alloc(newBytes);
    const fh = await fs.promises.open(logFile, 'r');
    try {
      await fh.read(buf, 0, newBytes, proxy.worktreeHookByteOffset);
    } finally {
      await fh.close();
    }
    proxy.worktreeHookByteOffset = stat.size;

    const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
    let parsedAtLeastOneLine = false;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        parsedAtLeastOneLine = true;
        result.hookEvents.push(entry);
        if (result.hookEvents.length > RING_BUFFER_HOOK_EVENTS) result.hookEvents = result.hookEvents.slice(-RING_BUFFER_HOOK_EVENTS);
        proxy.emit('hook-event', entry);
      } catch (err) {
        noteHookWatcherFailure(proxy, err.message, 'worktree');
      }
    }
    if (parsedAtLeastOneLine) noteHookWatcherSuccess(proxy, 'worktree');
  } catch (err) {
    noteHookWatcherFailure(proxy, err.message, 'worktree');
  }
}

module.exports = {
  startHookWatcher, readHookLog, flushHookLog,
  trackRedundantReads, stopHookWatcher,
  startWorktreeHookWatcher, readWorktreeHookLog,
  noteHookWatcherFailure, noteHookWatcherSuccess,
};

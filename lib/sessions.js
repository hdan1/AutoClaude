// lib/sessions.js -- Session discovery for Claude CLI sessions
// Scans ~/.claude/projects/<path-hash>/ for JSONL session files

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_SESSIONS = 20;
const MAX_PREVIEW_BYTES = 8192;

/**
 * Compute the path hash that Claude CLI uses for project directories.
 * Encoding: normalize to forward slashes, replace ':/' with '--', then '/' with '-', then ' ' with '-'.
 * Verified: D:\work\projects\sources\FreeLance\RalphClaude -> D--work-projects-sources-FreeLance-RalphClaude
 * Verified: C:\Users\Dan\Desktop\New folder -> C--Users-Dan-Desktop-New-folder
 */
function projectPathHash(projectDir) {
  let p = projectDir.replace(/\\/g, '/');
  p = p.replace(/:\//, '--');
  // Note: on Unix, paths like /home/user/project produce hashes like -home-user-project
  // This matches Claude CLI's own hashing behavior — do not strip the leading dash.
  p = p.replace(/\//g, '-');
  p = p.replace(/ /g, '-');
  return p;
}

/**
 * List available sessions for a project directory.
 * Returns array sorted by mtime (most recent first), capped at MAX_SESSIONS.
 * Each entry: { sessionId, mtime, date, firstPrompt }
 */
function listSessions(projectDir) {
  try {
    const hash = projectPathHash(projectDir);
    const dir = path.join(SESSIONS_DIR, hash);
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fullPath = path.join(dir, f);
        try {
          const stat = fs.statSync(fullPath);
          return { sessionId: f.replace('.jsonl', ''), fullPath, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_SESSIONS);

    return files.map(f => {
      const meta = extractSessionMeta(f.fullPath);
      return {
        sessionId: f.sessionId,
        mtime: f.mtime,
        date: new Date(f.mtime).toISOString(),
        firstPrompt: meta.firstPrompt,
      };
    });
  } catch (err) {
    logger.warn('sessions.list', 'Failed to list sessions', err);
    return [];
  }
}

/**
 * Extract metadata from a session JSONL file.
 * Reads only first MAX_PREVIEW_BYTES bytes for performance.
 * Skips non-user entries and isMeta entries (internal commands).
 * Returns { firstPrompt: string }
 */
function extractSessionMeta(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(MAX_PREVIEW_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, MAX_PREVIEW_BYTES, 0);
    fs.closeSync(fd);
    const text = buf.toString('utf8', 0, bytesRead);
    const lines = text.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Skip non-user entries and meta entries (internal commands like /clear)
        if (entry.type !== 'user' && entry.type !== 'human') continue;
        if (entry.isMeta) continue;

        const content = entry.message?.content;
        if (typeof content === 'string') {
          return { firstPrompt: content.substring(0, 120) };
        }
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              return { firstPrompt: block.text.substring(0, 120) };
            }
          }
        }
      } catch { /* skip unparseable lines */ }
    }
  } catch { /* file read error */ }
  return { firstPrompt: '' };
}

module.exports = { listSessions, projectPathHash };

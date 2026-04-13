// install-hooks.js
// Merges auto-claude telemetry hooks into a project's .claude/settings.json
// Usage: node install-hooks.js <project-dir> [--uninstall]
//
// Installs async PostToolUse and SubagentStop hooks that log to .planning/auto-claude-hooks.jsonl
// These are async: true, so they add ZERO latency to Claude's execution.

const fs = require('fs');
const path = require('path');

// Try to load from lib/runtime-utils (works in dev and when extraResources includes lib/)
// Fall back to inline implementations if the module isn't available (e.g., older packaged builds)
let safeWriteFileAtomic, backupFileBeforeWrite;
try {
  ({ safeWriteFileAtomic, backupFileBeforeWrite } = require('./lib/runtime-utils'));
} catch {
  // Inline fallbacks — same logic as runtime-utils.js
  safeWriteFileAtomic = function({ filePath, content, fs: fsMod }) {
    const tmpPath = filePath + '.tmp';
    try {
      fsMod.writeFileSync(tmpPath, content, 'utf8');
      try {
        fsMod.renameSync(tmpPath, filePath);
      } catch (renameErr) {
        try { fsMod.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
        return { ok: false, error: renameErr?.message || String(renameErr) };
      }
      return { ok: true };
    } catch (writeErr) {
      return { ok: false, error: writeErr?.message || String(writeErr) };
    }
  };
  backupFileBeforeWrite = function({ filePath, fs: fsMod }) {
    if (!fsMod.existsSync(filePath)) return { ok: false, error: 'Source file does not exist' };
    const backupPath = filePath + '.bak';
    try {
      fsMod.copyFileSync(filePath, backupPath);
      return { ok: true, backupPath };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  };
}

const projectDir = process.argv[2];
const uninstall = process.argv.includes('--uninstall');

if (!projectDir) {
  console.error('Usage: node install-hooks.js <project-dir> [--uninstall]');
  process.exit(1);
}

const settingsDir = path.join(projectDir, '.claude');
const settingsFile = path.join(settingsDir, 'settings.json');
const hookScript = path.resolve(__dirname, 'hooks', 'auto-claude-hook.js');

// The hook entry we manage (identified by the marker in the command)
const MARKER = 'auto-claude-hook.js';
const OLD_MARKER = 'gsd-ralph-hook.js';

function makeHookEntry() {
  return {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `node "${hookScript.replace(/\\/g, '/')}"`,
      async: true,
    }],
  };
}

try {
  // Ensure .claude dir exists
  if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });

  // Load existing settings
  let settings = {};
  if (fs.existsSync(settingsFile)) {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  }

  if (!settings.hooks) settings.hooks = {};

  if (uninstall) {
    // Remove our hooks
    for (const event of ['PostToolUse', 'SubagentStop', 'Notification']) {
      if (Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = settings.hooks[event].filter(
          h => { const s = JSON.stringify(h); return !s.includes(MARKER) && !s.includes(OLD_MARKER); }
        );
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
    }
    console.log('Removed auto-claude hooks from', settingsFile);
  } else {
    // Add our hooks (if not already present)
    for (const event of ['PostToolUse', 'SubagentStop', 'Notification']) {
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];

      // Check if already installed (new or old marker)
      const exists = settings.hooks[event].some(
        h => { const s = JSON.stringify(h); return s.includes(MARKER) || s.includes(OLD_MARKER); }
      );
      if (!exists) {
        settings.hooks[event].push(makeHookEntry());
      } else {
        // If old hook found but not new, replace it
        const hasNew = settings.hooks[event].some(h => JSON.stringify(h).includes(MARKER));
        const hasOld = settings.hooks[event].some(h => JSON.stringify(h).includes(OLD_MARKER));
        if (hasOld && !hasNew) {
          settings.hooks[event] = settings.hooks[event].filter(
            h => !JSON.stringify(h).includes(OLD_MARKER)
          );
          settings.hooks[event].push(makeHookEntry());
        }
      }
    }
    console.log('Installed auto-claude hooks into', settingsFile);
    console.log('Hooks are async — zero latency impact on Claude.');
  }

  // Backup existing settings before overwrite
  backupFileBeforeWrite({ filePath: settingsFile, fs });

  // Atomic write: temp file → rename (prevents partial writes on crash)
  const writeResult = safeWriteFileAtomic({
    filePath: settingsFile,
    content: JSON.stringify(settings, null, 2),
    fs,
  });
  if (!writeResult.ok) {
    console.error('Atomic write failed:', writeResult.error);
    console.error('Backup may be available at:', settingsFile + '.bak');
    process.exit(1);
  }
  console.log('Done.');

} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}

# Cross-Platform Compatibility Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 15 cross-platform issues so Auto Claude works correctly on Windows, macOS, and Linux.

**Architecture:** Create a centralized `spawn-claude.js` helper to eliminate 5 duplicate bare-spawn bugs, then apply targeted fixes to 10 other files for platform-specific UX and behavior issues.

**Tech Stack:** Electron, Node.js, `child_process`, `path`, `os`, `fs`

---

### Task 1: Create centralized `spawn-claude.js` helper

**Files:**
- Create: `lib/spawn-claude.js`
- Create: `lib/spawn-claude.test.js`

- [ ] **Step 1: Write the test file**

```js
// lib/spawn-claude.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { getClaudeCommand, killClaudeProcess } = require('./spawn-claude');

test('getClaudeCommand returns cmd and shellFlag', () => {
  const result = getClaudeCommand();
  assert.equal(typeof result.cmd, 'string');
  assert.equal(typeof result.shellFlag, 'boolean');
  assert.ok(result.cmd.length > 0, 'cmd should not be empty');
});

test('getClaudeCommand shellFlag is true on win32 when no full path', (t) => {
  // This test validates the logic structure — actual platform behavior
  // depends on whether findClaudePath() finds a binary
  const result = getClaudeCommand();
  if (process.platform === 'win32' && result.cmd === 'claude') {
    assert.equal(result.shellFlag, true);
  }
});

test('killClaudeProcess does not throw on null/undefined', () => {
  // Should be a no-op, not crash
  assert.doesNotThrow(() => killClaudeProcess(null));
  assert.doesNotThrow(() => killClaudeProcess(undefined));
  assert.doesNotThrow(() => killClaudeProcess({}));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/spawn-claude.test.js`
Expected: FAIL with "Cannot find module './spawn-claude'"

- [ ] **Step 3: Write the implementation**

```js
// lib/spawn-claude.js — Centralized claude binary spawn helper
// Resolves path, handles .cmd shims on Windows, platform-aware process killing
const { spawn, execFile, execFileSync } = require('child_process');
const { findClaudePath } = require('./claude-detection');

/**
 * Returns the resolved claude command and whether shell mode is needed.
 * Use with spawn/execFile/execFileSync when you need granular control.
 * @returns {{ cmd: string, shellFlag: boolean }}
 */
function getClaudeCommand() {
  const resolved = findClaudePath();
  if (resolved) {
    return { cmd: resolved, shellFlag: false };
  }
  // Bare 'claude' fallback — needs shell on Windows to resolve .cmd shims
  return { cmd: 'claude', shellFlag: process.platform === 'win32' };
}

/**
 * Spawn the claude binary with proper path resolution and shell handling.
 * Drop-in replacement for spawn('claude', args, options).
 * @param {string[]} args - CLI arguments
 * @param {object} [options] - spawn options (cwd, env, stdio, etc.)
 * @returns {ChildProcess}
 */
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

/**
 * Platform-aware process termination.
 * Windows: uses taskkill /T (tree kill) since SIGTERM maps to TerminateProcess.
 * Unix: sends SIGTERM for graceful shutdown.
 * @param {ChildProcess|null} proc - process to kill
 */
function killClaudeProcess(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/PID', String(proc.pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      proc.kill('SIGTERM');
    }
  } catch { /* process may have already exited */ }
}

module.exports = { spawnClaude, killClaudeProcess, getClaudeCommand };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/spawn-claude.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/spawn-claude.js lib/spawn-claude.test.js
git commit -m "feat: add centralized spawn-claude helper for cross-platform binary resolution"
```

---

### Task 2: Update `pty-executor.js` to use `spawnClaude` and `killClaudeProcess`

**Files:**
- Modify: `lib/pty-executor.js:1,19,32`
- Reference: `lib/pty-executor.test.js` (existing tests must still pass)

- [ ] **Step 1: Run existing tests to confirm green baseline**

Run: `node --test lib/pty-executor.test.js`
Expected: PASS (3 tests)

- [ ] **Step 2: Update the imports**

Replace line 1:
```js
const { spawn } = require('child_process');
```
With:
```js
const { spawnClaude, killClaudeProcess } = require('./spawn-claude');
```

- [ ] **Step 3: Replace bare `spawn('claude', ...)` with `spawnClaude()`**

Replace lines 19-24:
```js
    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
```
With:
```js
    const proc = spawnClaude(args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
```

- [ ] **Step 4: Replace `proc.kill('SIGTERM')` with `killClaudeProcess(proc)`**

Replace line 32:
```js
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
```
With:
```js
      killClaudeProcess(proc);
```

- [ ] **Step 5: Run existing tests to confirm they still pass**

Run: `node --test lib/pty-executor.test.js`
Expected: PASS (3 tests — classifyPtyRun and normalizePtyError are pure functions, unaffected)

- [ ] **Step 6: Commit**

```bash
git add lib/pty-executor.js
git commit -m "fix: use spawnClaude in pty-executor for Windows .cmd shim resolution and proper kill"
```

---

### Task 3: Update `plugin-manager.js` to use `spawnClaude` and `getClaudeCommand`

**Files:**
- Modify: `lib/plugin-manager.js:2,131,148-152,164-167`

- [ ] **Step 1: Add spawn-claude import and remove unused spawn import**

Replace line 2:
```js
const { execFileSync, spawn } = require('child_process');
```
With:
```js
const { execFileSync } = require('child_process');
const { spawnClaude, getClaudeCommand } = require('./spawn-claude');
```

- [ ] **Step 2: Replace `installPlugin` spawn block**

Replace lines 131 and 163-167:

First, remove line 131:
```js
  const claudePath = findClaudePath() || 'claude';
```
Replace with:
```js
  const { cmd: claudePath, shellFlag } = getClaudeCommand();
```

Then replace lines 148-152 (marketplace `execFileSync`):
```js
      execFileSync(claudePath, ['plugins', 'marketplace', 'add', repo], {
        timeout: 120000, windowsHide: true, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
```
With:
```js
      execFileSync(claudePath, ['plugins', 'marketplace', 'add', repo], {
        timeout: 120000, windowsHide: true, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: shellFlag,
      });
```

Then replace lines 164-167 (plugin install spawn):
```js
    const proc = spawn(claudePath, ['plugins', 'install', pluginKey], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
```
With:
```js
    const proc = spawnClaude(['plugins', 'install', pluginKey], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
```

- [ ] **Step 3: Remove unused `findClaudePath` from the import if no longer directly used**

Check line 7 — `findClaudePath` is still imported for the `installPlugin` function's `findClaudePath() || 'claude'`. Since we replaced that with `getClaudeCommand()`, check if `findClaudePath` is still used elsewhere in this file. It's used in the `installViaCommand` path indirectly, but that path uses `parseInstallCommand`. So remove `findClaudePath` from the import on line 7:

Replace:
```js
const { getClaudeHome, findClaudePath, isGsdInstalledFromPaths, DEFAULT_RECOMMENDED_PLUGINS } = require('./claude-detection');
```
With:
```js
const { getClaudeHome, isGsdInstalledFromPaths, DEFAULT_RECOMMENDED_PLUGINS } = require('./claude-detection');
```

- [ ] **Step 4: Commit**

```bash
git add lib/plugin-manager.js
git commit -m "fix: use spawnClaude in plugin-manager for Windows .cmd shim resolution"
```

---

### Task 4: Update `update-checker.js` to use `getClaudeCommand`

**Files:**
- Modify: `lib/update-checker.js:2,15,19`

- [ ] **Step 1: Replace the import and command resolution**

Replace lines 1-2:
```js
// lib/update-checker.js — Update checking extracted from claude-detector.js (5A)
const { findClaudePath } = require('./claude-detection');
```
With:
```js
// lib/update-checker.js — Update checking extracted from claude-detector.js (5A)
const { getClaudeCommand } = require('./spawn-claude');
```

- [ ] **Step 2: Replace the path resolution and execFile call**

Replace line 15:
```js
  const claudePath = findClaudePath() || 'claude';
```
With:
```js
  const { cmd: claudePath, shellFlag } = getClaudeCommand();
```

Replace line 19:
```js
    execFile(claudePath, ['update'], { timeout: 60000, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
```
With:
```js
    execFile(claudePath, ['update'], { timeout: 60000, windowsHide: true, encoding: 'utf8', shell: shellFlag }, (err, stdout, stderr) => {
```

- [ ] **Step 3: Commit**

```bash
git add lib/update-checker.js
git commit -m "fix: use getClaudeCommand in update-checker for Windows .cmd shim resolution"
```

---

### Task 5: Update `claude-installer.js` — fix `authenticate()` and add platform validation

**Files:**
- Modify: `lib/claude-installer.js:1-12,28-56,58-85`

- [ ] **Step 1: Add spawn-claude import**

Replace line 1:
```js
const { spawn, execSync } = require('child_process');
```
With:
```js
const { spawn, execSync } = require('child_process');
const { spawnClaude } = require('./spawn-claude');
```

- [ ] **Step 2: Add platform method validation map and fix homebrew for Linux**

After line 5 (`const path = require('path');`), add:

```js
const PLATFORM_METHODS = {
  win32:  new Set(['powershell', 'cmd', 'winget']),
  darwin: new Set(['curl', 'homebrew']),
  linux:  new Set(['curl', 'homebrew']),
};
```

Replace the homebrew entry in `INSTALL_COMMANDS` (line 11):
```js
  homebrew:   { cmd: 'brew', args: ['install', '--cask', 'claude-code'] },
```
With:
```js
  homebrew:   { cmd: 'brew', args: process.platform === 'darwin'
    ? ['install', '--cask', 'claude-code']
    : ['install', 'claude-code'] },
```

- [ ] **Step 3: Add platform validation to `install()`**

In the `install()` function, after `const spec = INSTALL_COMMANDS[method];` check (line 30-33), add a platform check before the spec check:

Replace lines 28-34:
```js
function install(method) {
  const emitter = new EventEmitter();
  const spec = INSTALL_COMMANDS[method];
  if (!spec) {
    setTimeout(() => emitter.emit('error', `Unknown install method: ${method}`), 0);
    return emitter;
  }
```
With:
```js
function install(method) {
  const emitter = new EventEmitter();
  const allowed = PLATFORM_METHODS[process.platform];
  if (allowed && !allowed.has(method)) {
    setTimeout(() => emitter.emit('error', `Install method '${method}' is not available on ${process.platform}. Available: ${[...allowed].join(', ')}`), 0);
    return emitter;
  }
  const spec = INSTALL_COMMANDS[method];
  if (!spec) {
    setTimeout(() => emitter.emit('error', `Unknown install method: ${method}`), 0);
    return emitter;
  }
```

- [ ] **Step 4: Fix `authenticate()` to use `spawnClaude`**

Replace lines 58-84:
```js
function authenticate(method) {
  const emitter = new EventEmitter();
  let cmd, args;

  if (method === 'anthropic') {
    cmd = 'claude'; args = ['auth', 'login'];
  } else if (method === 'console') {
    cmd = 'claude'; args = ['auth', 'login', '--console'];
  } else {
    setTimeout(() => emitter.emit('error', 'Use custom provider or cloud provider settings instead'), 0);
    return emitter;
  }

  const proc = spawn(cmd, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });

  proc.stdout.on('data', d => emitter.emit('progress', d.toString()));
  proc.stderr.on('data', d => emitter.emit('progress', d.toString()));
  proc.on('close', code => {
    if (code === 0) emitter.emit('complete');
    else emitter.emit('error', `Auth exited with code ${code}`);
  });
  proc.on('error', err => emitter.emit('error', err.message));

  return emitter;
}
```
With:
```js
function authenticate(method) {
  const emitter = new EventEmitter();
  let args;

  if (method === 'anthropic') {
    args = ['auth', 'login'];
  } else if (method === 'console') {
    args = ['auth', 'login', '--console'];
  } else {
    setTimeout(() => emitter.emit('error', 'Use custom provider or cloud provider settings instead'), 0);
    return emitter;
  }

  const proc = spawnClaude(args, {
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', d => emitter.emit('progress', d.toString()));
  proc.stderr.on('data', d => emitter.emit('progress', d.toString()));
  proc.on('close', code => {
    if (code === 0) emitter.emit('complete');
    else emitter.emit('error', `Auth exited with code ${code}`);
  });
  proc.on('error', err => emitter.emit('error', err.message));

  return emitter;
}
```

- [ ] **Step 5: Commit**

```bash
git add lib/claude-installer.js
git commit -m "fix: add platform validation for install methods and use spawnClaude for auth"
```

---

### Task 6: macOS application menu (`main.js`)

**Files:**
- Modify: `main.js:354`

- [ ] **Step 1: Replace `Menu.setApplicationMenu(null)` with platform-aware menu**

Replace lines 353-354:
```js
  // Remove default menu bar (File, Edit, View, etc.)
  Menu.setApplicationMenu(null);
```
With:
```js
  // macOS needs a menu for standard shortcuts (Cmd+Q, Cmd+C/V, Cmd+H, Cmd+W)
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
```

- [ ] **Step 2: Commit**

```bash
git add main.js
git commit -m "fix: preserve standard macOS keyboard shortcuts by adding minimal app menu"
```

---

### Task 7: Linux terminal emulator discovery (`main.js`)

**Files:**
- Modify: `main.js:1266-1268`

- [ ] **Step 1: Replace the single `x-terminal-emulator` fallback with discovery cascade**

Replace lines 1266-1268:
```js
    } else {
      spawn('x-terminal-emulator', ['-e', `cd "${projDir}" && claude${skipPerms}`],
        { detached: true, stdio: 'ignore' });
    }
```
With:
```js
    } else {
      // Try multiple terminal emulators — x-terminal-emulator is Debian-only
      const terminals = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
      let launched = false;
      for (const term of terminals) {
        try {
          require('child_process').execFileSync('which', [term], { stdio: 'pipe', timeout: 2000 });
          spawn(term, ['-e', 'bash', '-c', `cd "${projDir}" && claude${skipPerms}`],
            { detached: true, stdio: 'ignore' });
          launched = true;
          break;
        } catch { /* terminal not found, try next */ }
      }
      if (!launched) {
        logger.warn('ipc.open-terminal', 'No supported terminal emulator found on this system');
      }
    }
```

- [ ] **Step 2: Commit**

```bash
git add main.js
git commit -m "fix: discover available Linux terminal emulator instead of assuming Debian"
```

---

### Task 8: macOS app lifecycle — don't quit on window close (`main.js`)

**Files:**
- Modify: `main.js:815-820`

- [ ] **Step 1: Add macOS platform check to `window-all-closed` handler**

Replace lines 815-820:
```js
app.on('window-all-closed', () => {
  if (!shouldKeepAppAliveWithoutWindows({ tray })) {
    isQuitting = true;
    app.quit();
  }
});
```
With:
```js
app.on('window-all-closed', () => {
  // macOS convention: apps stay running when all windows are closed (until Cmd+Q)
  if (process.platform === 'darwin') return;
  if (!shouldKeepAppAliveWithoutWindows({ tray })) {
    isQuitting = true;
    app.quit();
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add main.js
git commit -m "fix: follow macOS convention — don't quit app when all windows are closed"
```

---

### Task 9: Linux `safeStorage` warning (`telegram-secure.js`)

**Files:**
- Modify: `lib/telegram-secure.js:12-13`

- [ ] **Step 1: Add Linux-specific warning when encryption is unavailable**

Replace lines 12-14:
```js
function saveEncryptedToken(userDataPath, plainToken, fileName) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const encrypted = safeStorage.encryptString(plainToken);
```
With:
```js
function saveEncryptedToken(userDataPath, plainToken, fileName) {
  if (!safeStorage.isEncryptionAvailable()) {
    if (process.platform === 'linux') {
      logger.warn('telegram-secure', 'Encryption unavailable on Linux — install gnome-keyring or kwallet for secure token storage');
    }
    return false;
  }
  const encrypted = safeStorage.encryptString(plainToken);
```

- [ ] **Step 2: Commit**

```bash
git add lib/telegram-secure.js
git commit -m "fix: log actionable warning when Linux keyring is unavailable for token storage"
```

---

### Task 10: Windows path case normalization (`master-telegram.js`)

**Files:**
- Modify: `lib/master-telegram.js:338-346,387`

- [ ] **Step 1: Add `_normPath` helper to the class**

Add this method to the `MasterTelegramBridge` class, right before the `_isWorkspaceProject` method (before line 338):

```js
  /** Normalize path for comparison — lowercase on Windows where paths are case-insensitive */
  _normPath(p) {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
```

- [ ] **Step 2: Update `_isWorkspaceProject` to use `_normPath`**

Replace lines 338-346:
```js
  _isWorkspaceProject(state) {
    const rawRoot = typeof this.config?.workspaceRoot === 'string' ? this.config.workspaceRoot.trim() : '';
    const projectDir = typeof state?.projectDir === 'string' ? state.projectDir.trim() : '';
    if (!rawRoot || !projectDir) return false;
    const root = path.resolve(rawRoot);
    const full = path.resolve(projectDir);
    const rel = path.relative(root, full);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }
```
With:
```js
  _isWorkspaceProject(state) {
    const rawRoot = typeof this.config?.workspaceRoot === 'string' ? this.config.workspaceRoot.trim() : '';
    const projectDir = typeof state?.projectDir === 'string' ? state.projectDir.trim() : '';
    if (!rawRoot || !projectDir) return false;
    const root = this._normPath(rawRoot);
    const full = this._normPath(projectDir);
    const rel = path.relative(root, full);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }
```

- [ ] **Step 3: Update `_formatList` path comparison**

Replace line 387:
```js
      const openRow = rows.find(r => path.resolve(this.config.workspaceRoot, r.project) === proj.fullPath
```
With:
```js
      const openRow = rows.find(r => this._normPath(path.join(this.config.workspaceRoot, r.project)) === this._normPath(proj.fullPath)
```

- [ ] **Step 4: Update `_rows` to use `_normPath` for `openPaths`**

Replace line 355:
```js
      openPaths.add(path.resolve(state.projectDir));
```
With:
```js
      openPaths.add(this._normPath(state.projectDir));
```

- [ ] **Step 5: Commit**

```bash
git add lib/master-telegram.js
git commit -m "fix: normalize path case on Windows for workspace project matching"
```

---

### Task 11: Linux `package.json` improvements

**Files:**
- Modify: `package.json` (linux build config section)

- [ ] **Step 1: Add `rpm` target and `StartupWMClass`**

Replace the linux build config:
```json
    "linux": {
      "target": [
        "AppImage",
        "deb"
      ],
      "icon": "build/icon.png",
      "category": "Development"
    },
```
With:
```json
    "linux": {
      "target": [
        "AppImage",
        "deb",
        "rpm"
      ],
      "icon": "build/icon.png",
      "category": "Development",
      "desktop": {
        "StartupWMClass": "auto-claude"
      }
    },
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "fix: add rpm target and StartupWMClass for better Linux desktop integration"
```

---

### Task 12: macOS tray icon Retina support (`runtime-utils.js`)

**Files:**
- Modify: `lib/runtime-utils.js:54-72`
- Existing tests: `lib/runtime-utils.test.js` (must still pass)

- [ ] **Step 1: Run existing tests to confirm green baseline**

Run: `node --test lib/runtime-utils.test.js`
Expected: PASS

- [ ] **Step 2: Update `resolveTrayIconPath` to prefer macOS Template icons**

Replace lines 54-72:
```js
function resolveTrayIconPath({ platform, appDir, resourcesPath, exePath, existsSync }) {
  const ext = platform === 'win32' ? 'ico' : 'png';
  const candidates = [
    path.join(appDir || '', 'build', `icon.${ext}`),
    path.join(resourcesPath || '', 'build', `icon.${ext}`),
    path.join(resourcesPath || '', `icon.${ext}`),
    path.join(resourcesPath || '', 'app.asar.unpacked', 'build', `icon.${ext}`),
    path.join(path.dirname(exePath || ''), 'build', `icon.${ext}`),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Continue checking candidates
    }
  }

  return null;
}
```
With:
```js
function resolveTrayIconPath({ platform, appDir, resourcesPath, exePath, existsSync }) {
  const ext = platform === 'win32' ? 'ico' : 'png';
  const baseDirs = [
    path.join(appDir || '', 'build'),
    path.join(resourcesPath || '', 'build'),
    resourcesPath || '',
    path.join(resourcesPath || '', 'app.asar.unpacked', 'build'),
    path.join(path.dirname(exePath || ''), 'build'),
  ];

  // On macOS, prefer Template@2x icons for Retina support and native dark/light mode
  if (platform === 'darwin') {
    for (const dir of baseDirs) {
      try {
        const template2x = path.join(dir, 'iconTemplate@2x.png');
        if (existsSync(template2x)) return template2x;
      } catch { /* continue */ }
    }
  }

  // Standard icon resolution
  const candidates = baseDirs.map(dir => path.join(dir, `icon.${ext}`));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Continue checking candidates
    }
  }

  return null;
}
```

- [ ] **Step 3: Run existing tests to confirm they still pass**

Run: `node --test lib/runtime-utils.test.js`
Expected: PASS (existing tests use mocked `existsSync` and will still work since the fallback behavior is unchanged)

- [ ] **Step 4: Commit**

```bash
git add lib/runtime-utils.js
git commit -m "fix: prefer macOS Template@2x tray icon for Retina and dark mode support"
```

---

### Task 13: Unix path hash leading dash fix (`sessions.js`)

**Files:**
- Modify: `lib/sessions.js:19-25`
- Existing tests: `lib/sessions.test.js` (must still pass)

- [ ] **Step 1: Run existing tests to confirm green baseline**

Run: `node --test lib/sessions.test.js`
Expected: PASS

- [ ] **Step 2: Fix leading slash on Unix paths**

Replace lines 19-25:
```js
function projectPathHash(projectDir) {
  let p = projectDir.replace(/\\/g, '/');
  p = p.replace(/:\//, '--');
  p = p.replace(/\//g, '-');
  p = p.replace(/ /g, '-');
  return p;
}
```
With:
```js
function projectPathHash(projectDir) {
  let p = projectDir.replace(/\\/g, '/');
  p = p.replace(/:\//, '--');
  // Strip leading slash on Unix paths to avoid a leading dash in the hash
  // e.g., /home/user/project -> home-user-project (not -home-user-project)
  p = p.replace(/^\//, '');
  p = p.replace(/\//g, '-');
  p = p.replace(/ /g, '-');
  return p;
}
```

**IMPORTANT NOTE:** This change affects how session directories are found on Unix. If Claude CLI produces hashes WITH the leading dash, this fix would be WRONG and should be reverted. Before committing, verify by checking whether `~/.claude/projects/` directories on a macOS/Linux system use leading dashes. If they do, revert this change and instead add a comment documenting the behavior:

```js
  // Note: on Unix, paths like /home/user/project produce hashes like -home-user-project
  // This matches Claude CLI's own hashing behavior — do not strip the leading dash.
```

- [ ] **Step 3: Run existing tests to confirm they still pass**

Run: `node --test lib/sessions.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add lib/sessions.js
git commit -m "fix: strip leading slash in Unix path hash to avoid leading dash"
```

---

### Task 14: Final integration verification

**Files:**
- All modified files

- [ ] **Step 1: Run all existing tests**

Run: `node --test lib/*.test.js`
Expected: ALL PASS

- [ ] **Step 2: Verify the app starts without errors**

Run: `npm start` (or `npx electron .`)
Expected: App starts without console errors. Check the DevTools console for any import/require errors from the new `spawn-claude.js` module.

- [ ] **Step 3: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: integration verification for cross-platform compatibility fixes"
```

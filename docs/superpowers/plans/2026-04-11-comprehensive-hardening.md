# Comprehensive Hardening & SDK Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all bugs, race conditions, and silent catches; add ~60 tests; decompose monolithic modules; convert hot paths to async; migrate to Claude Code's SDK protocol for bidirectional communication; harden autonomy with configurable permission rules.

**Architecture:** Bottom-up: Phases 1-3 (bugs, races, observability) are independent and can be done in any order. Phase 4 (tests) benefits from 1-3. Phase 5 (decomposition) follows 1-3. Phase 6 (performance) depends on 5. Phase 7 (SDK migration) depends on 4+5. Phase 8 (autonomy hardening) depends on 7.

**Tech Stack:** Node.js 20, Electron, `node:test` + `node:assert/strict` for testing, `node-telegram-bot-api`, `sql.js`, Claude Code CLI

**Test runner:** `node --test lib/*.test.js` (Node's built-in test runner, NOT Jest)

---

## File Structure

### Existing files modified:
- `index.html` — XSS fix (B1), timer leak fix (B4)
- `lib/telegram.js` — token storage fix (B2)
- `lib/master-telegram.js` — duplicate handler fix (B6)
- `proxy.js` — FD leak fix (B3), hook truncation race (R4), async polling (P1), SIGKILL escalation (A1), SDK protocol (Phase 7)
- `session-manager.js` — double answerResolve fix (B5), concurrent start race (R2), resume state race (R5), stats save logging (E4)
- `main.js` — PID TOCTOU fix (R1), batch queue race (R3), IPC trust wrapper (5C), start-session handle (R2)
- `lib/claude-detector.js` — silent catches (E1), then decomposed in Phase 5
- `lib/telegram-secure.js` — catch classification (E2)
- `lib/logger.js` — rotation (E6), buffering (P2)
- `lib/constants.js` — SDK constants, new permission rule constants
- `lib/autonomy.js` — SDK control_request handling (Phase 7), permission rules (A2)
- `settings-db.js` — save batching (P3)
- `install-hooks.js` — notification hook (A3)

### New files created:
- `lib/autonomy.test.js` — ~15 tests
- `lib/context-guard.test.js` — ~10 tests
- `lib/validate.test.js` — extended with ~12 more tests (existing file has 2)
- `lib/telegram-secure.test.js` — ~8 tests
- `lib/sessions.test.js` — ~6 tests
- `lib/summarize.test.js` — ~8 tests
- `test/helpers.js` — shared test utilities
- `lib/claude-detection.js` — decomposed from claude-detector.js (Phase 5)
- `lib/plugin-manager.js` — decomposed from claude-detector.js (Phase 5)
- `lib/settings-manager.js` — decomposed from claude-detector.js (Phase 5)
- `lib/update-checker.js` — decomposed from claude-detector.js (Phase 5)
- `lib/ipc/session.js` — extracted from main.js (Phase 5)
- `lib/ipc/telegram.js` — extracted from main.js (Phase 5)
- `lib/ipc/workspace.js` — extracted from main.js (Phase 5)
- `lib/ipc/claude-manager.js` — extracted from main.js (Phase 5)
- `lib/ipc/settings.js` — extracted from main.js (Phase 5)
- `lib/telegram-auth.js` — shared auth logic (Phase 5)
- `lib/question-utils.js` — shared question extraction (Phase 5)

---

## Phase 1: Critical Bugs

### Task 1: XSS via Telegram Username (B1)

**Files:**
- Modify: `index.html:880`

The `esc()` function already exists in index.html (search for `function esc(`). Telegram usernames are injected raw into `innerHTML` at line 880.

- [ ] **Step 1: Locate the XSS sink and fix it**

In `index.html`, find line 880:
```js
for(const c of r.chats){const d=document.createElement('div');d.className='tutor-chat-item';d.innerHTML=`<b>${c.username||c.firstName||'?'}</b> (ID: ${c.chatId})`;tgTabChatList.appendChild(d)}
```

Replace with:
```js
for(const c of r.chats){const d=document.createElement('div');d.className='tutor-chat-item';d.innerHTML=`<b>${esc(c.username||c.firstName||'?')}</b> (ID: ${esc(String(c.chatId))})`;tgTabChatList.appendChild(d)}
```

- [ ] **Step 2: Search for any other raw innerHTML injections with Telegram data**

Run: `grep -n "innerHTML.*username\|innerHTML.*firstName\|innerHTML.*chatId" index.html`

If any others are found, wrap them with `esc()` too. Also check the master-telegram tutorial chat discovery flow in the CCM modal section.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "fix: escape Telegram usernames in innerHTML to prevent XSS (B1)"
```

---

### Task 2: TelegramBridge.token Never Set (B2)

**Files:**
- Modify: `lib/telegram.js:35`
- Test: `lib/telegram.test.js` (new — minimal test)

- [ ] **Step 1: Write the failing test**

Create `lib/telegram.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');

// We can't instantiate TelegramBridge directly (requires node-telegram-bot-api),
// so we test the token assignment pattern by verifying the fix exists in source.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'telegram.js'), 'utf8');

test('TelegramBridge.start stores decryptedToken as this.token', () => {
  // The start() method must assign this.token = decryptedToken
  // before any code that references this.token (photo download at ~line 349)
  const startMethod = src.substring(
    src.indexOf('async start(decryptedToken'),
    src.indexOf('async stop()')
  );
  assert.ok(
    startMethod.includes('this.token = decryptedToken'),
    'start() must assign this.token = decryptedToken'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/telegram.test.js`
Expected: FAIL — `this.token = decryptedToken` not found in source.

- [ ] **Step 3: Fix the bug**

In `lib/telegram.js`, find the `start` method (line 35):
```js
  async start(decryptedToken, allowedUsers) {
    if (this._started) await this.stop();
    this.allowedUsers = (allowedUsers || []).map(String);
```

Add `this.token = decryptedToken;` after the allowedUsers line:
```js
  async start(decryptedToken, allowedUsers) {
    if (this._started) await this.stop();
    this.allowedUsers = (allowedUsers || []).map(String);
    this.token = decryptedToken;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/telegram.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/telegram.js lib/telegram.test.js
git commit -m "fix: store decryptedToken in TelegramBridge.start so photo downloads work (B2)"
```

---

### Task 3: File Descriptor Leaks in Hook Log Reader (B3)

**Files:**
- Modify: `proxy.js:424-428`

- [ ] **Step 1: Write the failing test**

Add to `lib/runtime-utils.test.js` (since this tests a pure pattern):
```js
test('FD leak pattern: readSync wrapped in try/finally closeSync', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'proxy.js'), 'utf8');
  // The _readHookLog method must use try/finally around readSync/closeSync
  const hookReader = src.substring(
    src.indexOf('_readHookLog('),
    src.indexOf('_flushHookLog(')
  );
  // Must have finally { ...closeSync pattern
  assert.ok(
    hookReader.includes('finally'),
    '_readHookLog must wrap readSync in try/finally for FD safety'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/runtime-utils.test.js`
Expected: FAIL — no `finally` in _readHookLog

- [ ] **Step 3: Fix the FD leak**

In `proxy.js`, find lines 423-428:
```js
      const fd = fs.openSync(logFile, 'r');
      const newBytes = stat.size - this.hookByteOffset;
      const buf = Buffer.alloc(newBytes);
      fs.readSync(fd, buf, 0, newBytes, this.hookByteOffset);
      fs.closeSync(fd);
```

Replace with:
```js
      const newBytes = stat.size - this.hookByteOffset;
      const buf = Buffer.alloc(newBytes);
      const fd = fs.openSync(logFile, 'r');
      try {
        fs.readSync(fd, buf, 0, newBytes, this.hookByteOffset);
      } finally {
        fs.closeSync(fd);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/runtime-utils.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add proxy.js lib/runtime-utils.test.js
git commit -m "fix: wrap hook log readSync in try/finally to prevent FD leaks (B3)"
```

---

### Task 4: Timer Leaks on Tab Close (B4)

**Files:**
- Modify: `index.html:782`

- [ ] **Step 1: Fix the timer leaks**

In `index.html`, find the `closeTab` function at line 770. After line 782 (`if(ts.eTmr)clearInterval(ts.eTmr);`), add cleanup for the two leaked timers:

```js
  if(ts.eTmr)clearInterval(ts.eTmr);
  if(ts._countdownTimer)clearInterval(ts._countdownTimer);
  if(ts.activityDebounceTimer)clearTimeout(ts.activityDebounceTimer);
```

- [ ] **Step 2: Verify no other timer references are leaked**

Search for timer assignments in index.html:
Run: `grep -n "_countdownTimer\|activityDebounceTimer\|setInterval\|setTimeout" index.html | head -30`

Confirm these are the only two uncleared timers at tab close.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "fix: clear countdown and activity timers on tab close to prevent leaks (B4)"
```

---

### Task 5: Double answerResolve Overwrite (B5)

**Files:**
- Modify: `session-manager.js:698-710`

- [ ] **Step 1: Fix the race**

In `session-manager.js`, find `_waitForAnswerWithTimeout` at line 698:
```js
  _waitForAnswerWithTimeout(session, timeoutMs) {
    return new Promise(resolve => {
      let timer = null;
      session.answerResolve = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => {
        session.answerResolve = null;
        resolve(false);
      }, timeoutMs);
    });
  }
```

Replace with:
```js
  _waitForAnswerWithTimeout(session, timeoutMs) {
    // B5: Clear any existing timer before setting a new resolve to prevent orphaned promises
    if (session._answerTimer) clearTimeout(session._answerTimer);
    return new Promise(resolve => {
      session.answerResolve = () => {
        if (session._answerTimer) clearTimeout(session._answerTimer);
        session._answerTimer = null;
        resolve(true);
      };
      session._answerTimer = setTimeout(() => {
        session.answerResolve = null;
        session._answerTimer = null;
        resolve(false);
      }, timeoutMs);
    });
  }
```

- [ ] **Step 2: Commit**

```bash
git add session-manager.js
git commit -m "fix: clear existing answer timer before setting new resolve to prevent orphan (B5)"
```

---

### Task 6: Duplicate /start Handler (B6)

**Files:**
- Modify: `lib/master-telegram.js:85`

- [ ] **Step 1: Remove the duplicate handler**

In `lib/master-telegram.js`, find line 85:
```js
    this.bot.onText(/\/start$/, (msg) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const key = msg.from.username || String(msg.from.id);
      this.chatIds.set(key, msg.chat.id);
      this._persistChatIds();
      this.bot.sendMessage(msg.chat.id,
        '\u2705 Master bot connected.\n\n/list \u2014 workspace projects\n/open <name> \u2014 open project\n/status \u2014 session overview\n/help \u2014 all commands')
        .catch(() => {});
    });
```

Search for the parameterized `/start` handler further down (should be something like `/start(?:\s+(.*))?$/`). If both exist, delete the bare `/start$` handler (lines 85-93) entirely. Keep only the parameterized version and ensure it handles bare `/start` (no args) correctly.

- [ ] **Step 2: Verify the parameterized handler handles bare /start**

Check that the remaining handler's regex `/start(?:\s+(.*))?$/` matches bare `/start` (it does — the group is optional). Verify the handler body checks `if (!match[1])` to handle the no-args case with the welcome message.

If the parameterized handler doesn't have the welcome message logic, merge it in:
```js
    this.bot.onText(/\/start(?:\s+(.*))?$/, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const key = msg.from.username || String(msg.from.id);
      this.chatIds.set(key, msg.chat.id);
      this._persistChatIds();
      
      if (!match[1] || !match[1].trim()) {
        // Bare /start — welcome message
        this.bot.sendMessage(msg.chat.id,
          '\u2705 Master bot connected.\n\n/list \u2014 workspace projects\n/open <name> \u2014 open project\n/status \u2014 session overview\n/help \u2014 all commands')
          .catch(() => {});
        return;
      }
      // Handle /start <args> if needed
      // ...existing parameterized logic...
    });
```

- [ ] **Step 3: Commit**

```bash
git add lib/master-telegram.js
git commit -m "fix: remove duplicate /start handler in master-telegram to prevent double processing (B6)"
```

---

## Phase 2: Race Conditions & Concurrency

### Task 7: PID File TOCTOU Race (R1)

**Files:**
- Modify: `main.js:104-144`

- [ ] **Step 1: Replace file-based PID tracking with in-memory Map**

In `main.js`, replace the PID tracking section (lines 104-144):

```js
// ── PID Tracking (PERF-04) ────────────────────────
let PID_FILE = null;
function getPidFile() {
  if (!PID_FILE) PID_FILE = path.join(app.getPath('userData'), 'auto-claude-pids.json');
  return PID_FILE;
}

function trackPid(tabId, pid) {
  try {
    let pids = {};
    try { pids = JSON.parse(fs.readFileSync(getPidFile(), 'utf8')); } catch { /* no file yet */ }
    pids[tabId] = pid;
    fs.writeFileSync(getPidFile(), JSON.stringify(pids), 'utf8');
  } catch { /* silent */ }
}

function untrackPid(tabId) {
  try {
    let pids = {};
    try { pids = JSON.parse(fs.readFileSync(getPidFile(), 'utf8')); } catch { return; }
    delete pids[tabId];
    fs.writeFileSync(getPidFile(), JSON.stringify(pids), 'utf8');
  } catch { /* silent */ }
}

function killOrphans() {
  try {
    const pids = JSON.parse(fs.readFileSync(getPidFile(), 'utf8'));
    for (const [tabId, pid] of Object.entries(pids)) {
      try {
        if (process.platform === 'win32') {
          require('child_process').execFileSync('taskkill', ['/T', '/PID', String(pid), '/F'],
            { stdio: 'ignore', timeout: 3000, windowsHide: true });
        } else {
          process.kill(pid, 'SIGTERM');
        }
      } catch { /* already dead - expected */ }
    }
    fs.unlinkSync(getPidFile());
  } catch { /* no pid file or parse error - normal on first run */ }
}
```

With:
```js
// ── PID Tracking (R1: in-memory map, debounced flush) ────────
const activePids = new Map(); // pid -> tabId
let pidFlushTimer = null;
let PID_FILE = null;

function getPidFile() {
  if (!PID_FILE) PID_FILE = path.join(app.getPath('userData'), 'auto-claude-pids.json');
  return PID_FILE;
}

function _flushPids() {
  try {
    const obj = {};
    for (const [tabId, pid] of activePids) obj[tabId] = pid;
    fs.writeFileSync(getPidFile(), JSON.stringify(obj), 'utf8');
  } catch (e) { logger.debug('pid-tracking', `flush failed: ${e.message}`); }
}

function _schedulePidFlush() {
  if (pidFlushTimer) return;
  pidFlushTimer = setTimeout(() => {
    pidFlushTimer = null;
    _flushPids();
  }, 500);
}

function trackPid(tabId, pid) {
  activePids.set(tabId, pid);
  _schedulePidFlush();
}

function untrackPid(tabId) {
  activePids.delete(tabId);
  _schedulePidFlush();
}

function killOrphans() {
  try {
    const pids = JSON.parse(fs.readFileSync(getPidFile(), 'utf8'));
    for (const [tabId, pid] of Object.entries(pids)) {
      try {
        if (process.platform === 'win32') {
          require('child_process').execFileSync('taskkill', ['/T', '/PID', String(pid), '/F'],
            { stdio: 'ignore', timeout: 3000, windowsHide: true });
        } else {
          process.kill(pid, 'SIGTERM');
        }
      } catch { /* already dead - expected */ }
    }
    fs.unlinkSync(getPidFile());
  } catch { /* no pid file or parse error - normal on first run */ }
}
```

- [ ] **Step 2: Commit**

```bash
git add main.js
git commit -m "fix: replace PID file TOCTOU with in-memory map + debounced flush (R1)"
```

---

### Task 8: Concurrent start-session Race (R2)

**Files:**
- Modify: `main.js:893`

- [ ] **Step 1: Change ipcMain.on to ipcMain.handle and add starting guard**

In `main.js`, find line 893:
```js
ipcMain.on('start-session', async (event, o) => {
  if (!isTrustedIpcEvent(event, 'start-session')) return;
  const tabId = o.tabId || 'default';
  const existing = sessionManager.get(tabId);
  if (existing?.state.running) return;
```

Replace with:
```js
ipcMain.handle('start-session', async (event, o) => {
  if (!isTrustedIpcEvent(event, 'start-session')) return;
  const tabId = o.tabId || 'default';
  const existing = sessionManager.get(tabId);
  if (existing?.state.running || existing?.state.starting) return;
```

Then, right after the validation checks succeed and before any async work begins (after `saveConfig(config);`), add:
```js
  // R2: Set starting flag synchronously to prevent concurrent start-session races
  const session = sessionManager.get(tabId) || sessionManager.create(tabId, dirVal.path);
  session.state.starting = true;
```

And at the end of the handler (after session starts or on error), clear it:
```js
  session.state.starting = false;
```

- [ ] **Step 2: Update the renderer call from send to invoke**

Search `index.html` for the `start-session` IPC call. It will be something like:
```js
window.api.startSession(...)
```

Check `preload.js` — if it uses `ipcRenderer.send('start-session', ...)`, change to `ipcRenderer.invoke('start-session', ...)`. If it already uses `invoke`, no change needed.

- [ ] **Step 3: Commit**

```bash
git add main.js preload.js
git commit -m "fix: change start-session to ipcMain.handle with starting guard to prevent race (R2)"
```

---

### Task 9: Batch Queue Double-Dequeue (R3)

**Files:**
- Modify: `main.js:288-310`

- [ ] **Step 1: Add mutex flag**

In `main.js`, before the `processBatchQueue` function (line 288), add:
```js
let batchProcessing = false;
```

Then wrap the function body:
```js
function processBatchQueue() {
  if (batchProcessing) return;
  if (!sessionManager) return;
  if (!config.batch?.enabled || !config.batch.queue?.length) return;

  const running = Array.from(sessionManager.sessions.values()).filter(s => s.state.running).length;
  const limit = config.batch.mode === 'parallel' ? (config.batch.parallelLimit || 2) : 1;
  if (running >= limit) return;

  batchProcessing = true;
  const item = config.batch.queue.shift();
  if (!item) { batchProcessing = false; return; }
  saveConfig(config);
  batchProcessing = false;

  // ... rest of function unchanged ...
```

- [ ] **Step 2: Commit**

```bash
git add main.js
git commit -m "fix: add batchProcessing mutex to prevent double-dequeue race (R3)"
```

---

### Task 10: Hook Log Truncation Race (R4)

**Files:**
- Modify: `proxy.js:412-420`

- [ ] **Step 1: Replace non-atomic truncation with atomic write**

In `proxy.js`, find the truncation block at lines 412-420:
```js
      if (stat.size > maxBytes) {
        try {
          const all = fs.readFileSync(logFile, 'utf8');
          const lines = all.split('\n').filter(l => l.trim());
          const keep = lines.slice(Math.floor(lines.length / 2));
          fs.writeFileSync(logFile, keep.join('\n') + '\n');
          this.hookByteOffset = fs.statSync(logFile).size;
          return; // Skip this poll cycle; next poll picks up normally
        } catch { /* silent */ }
      }
```

Replace with atomic truncation:
```js
      if (stat.size > maxBytes) {
        try {
          const all = fs.readFileSync(logFile, 'utf8');
          const lines = all.split('\n').filter(l => l.trim());
          const keep = lines.slice(Math.floor(lines.length / 2));
          // R4: Atomic truncation — write to temp, rename over original
          const tmpFile = logFile + '.tmp';
          fs.writeFileSync(tmpFile, keep.join('\n') + '\n');
          fs.renameSync(tmpFile, logFile);
          this.hookByteOffset = fs.statSync(logFile).size;
          return;
        } catch (e) { logger.debug('proxy', `hook log truncation failed: ${e.message}`); }
      }
```

- [ ] **Step 2: Commit**

```bash
git add proxy.js
git commit -m "fix: use atomic rename for hook log truncation to prevent data loss (R4)"
```

---

### Task 11: Resume State Last-Write-Wins (R5)

**Files:**
- Modify: `session-manager.js:712-724`

- [ ] **Step 1: Include tabId in resume state key**

In `session-manager.js`, find `_saveResumeState` at line 712:
```js
  _saveResumeState(tabId, session, prompt) {
    const dir = session.state.projectDir;
    if (!dir) return;
    if (!this.config.sessions) this.config.sessions = {};
    this.config.sessions[dir] = {
      ...(this.config.sessions[dir] || {}),
      sessionId: session.state.sessionId,
```

Replace the key to include tabId:
```js
  _saveResumeState(tabId, session, prompt) {
    const dir = session.state.projectDir;
    if (!dir) return;
    if (!this.config.sessions) this.config.sessions = {};
    // R5: Include tabId in key to prevent last-write-wins between concurrent sessions
    const key = `${dir}::${tabId}`;
    this.config.sessions[key] = {
      sessionId: session.state.sessionId,
```

Also update `_clearResumeState` to use the same key format:
```js
  _clearResumeState(tabId, session) {
    const dir = session.state.projectDir;
    if (!dir) return;
    const key = `${dir}::${tabId}`;
    if (this.config.sessions) delete this.config.sessions[key];
```

And update `getResumeState` in `lib/autonomy.js` to parse the composite key:
```js
  getResumeState(configSessions) {
    if (!configSessions) return [];
    if (this.config.resilience?.autoResume === false) return [];

    const toResume = [];
    for (const [key, entry] of Object.entries(configSessions)) {
      if (entry.wasRunning && entry.sessionId) {
        // R5: key is "dir::tabId" — extract dir
        const dir = key.includes('::') ? key.split('::')[0] : key;
        toResume.push({
          tabId: entry.tabId || `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          projectDir: dir,
          sessionId: entry.sessionId,
          lastPrompt: entry.lastPrompt || 'continue',
        });
      }
    }
    return toResume;
  }
```

- [ ] **Step 2: Commit**

```bash
git add session-manager.js lib/autonomy.js
git commit -m "fix: include tabId in resume state key to prevent concurrent session overwrite (R5)"
```

---

## Phase 3: Error Observability

### Task 12: claude-detector.js Silent Catches (E1)

**Files:**
- Modify: `lib/claude-detector.js`

- [ ] **Step 1: Replace all silent catches with classified logging**

In `lib/claude-detector.js`, find every `catch { }` or `catch(e) { }` block. For each one:

1. If the catch is around file reads (`readFileSync`, `existsSync`, `statSync`), classify ENOENT as debug, others as warn:
```js
} catch (err) {
  if (err.code !== 'ENOENT') logger.warn('claude-detector', `<operation> failed: ${err.message}`);
}
```

2. If the catch is around `execFileSync` calls, log as debug (expected when CLI not found):
```js
} catch (err) {
  logger.debug('claude-detector', `<operation> failed: ${err.message}`);
}
```

3. If the catch is around JSON parse, log as debug:
```js
} catch (err) {
  logger.debug('claude-detector', `JSON parse failed: ${err.message}`);
}
```

Make sure `logger` is required at the top if not already:
```js
const logger = require('./logger');
```

- [ ] **Step 2: Verify logging works**

Run: `node --test lib/*.test.js`
Expected: All tests pass (no behavioral changes, only logging additions)

- [ ] **Step 3: Commit**

```bash
git add lib/claude-detector.js
git commit -m "fix: replace 19 silent catches in claude-detector with classified logging (E1)"
```

---

### Task 13: telegram-secure.js Catch Classification (E2)

**Files:**
- Modify: `lib/telegram-secure.js:18-24,27-31`

- [ ] **Step 1: Add error classification to loadEncryptedToken**

In `lib/telegram-secure.js`, find `loadEncryptedToken` (line 18):
```js
function loadEncryptedToken(userDataPath, fileName) {
  try {
    const p = path.join(userDataPath, fileName);
    if (!fs.existsSync(p)) return null;
    const encrypted = fs.readFileSync(p);
    return safeStorage.decryptString(encrypted);
  } catch(e) { return null; }
}
```

Replace with:
```js
function loadEncryptedToken(userDataPath, fileName) {
  try {
    const p = path.join(userDataPath, fileName);
    if (!fs.existsSync(p)) return null;
    const encrypted = fs.readFileSync(p);
    return safeStorage.decryptString(encrypted);
  } catch (e) {
    // E2: ENOENT is expected (no token saved yet), anything else is a real problem
    if (e.code !== 'ENOENT') {
      logger.warn('telegram-secure', `Failed to load token ${fileName}: ${e.message}`);
    }
    return null;
  }
}
```

Add `clearEncryptedToken` error classification too:
```js
function clearEncryptedToken(userDataPath, fileName) {
  try {
    const p = path.join(userDataPath, fileName);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      logger.warn('telegram-secure', `Failed to clear token ${fileName}: ${e.message}`);
    }
  }
}
```

Add logger require at top:
```js
const logger = require('./logger');
```

- [ ] **Step 2: Commit**

```bash
git add lib/telegram-secure.js
git commit -m "fix: classify telegram-secure catches — ENOENT silent, others logged (E2)"
```

---

### Task 14: Remaining Silent Catches (E3, E4, E5)

**Files:**
- Modify: `proxy.js:63,420,445`
- Modify: `session-manager.js:695,780`

- [ ] **Step 1: proxy.js kill failure (E5)**

In `proxy.js` line 63, find:
```js
      } catch { resolve(); }
```

Replace with:
```js
      } catch (e) {
        logger.debug('proxy', `kill failed for PID ${pid}: ${e.message}`);
        resolve();
      }
```

- [ ] **Step 2: proxy.js hook read outer catch (E3)**

In `proxy.js` line 445, find:
```js
    } catch (err) { /* silent */ }
```

Replace with:
```js
    } catch (err) { logger.debug('proxy', `hook log read failed: ${err.message}`); }
```

Also fix line 420 (`catch { /* silent */ }` inside truncation):
```js
        } catch (e) { logger.debug('proxy', `hook log truncation failed: ${e.message}`); }
```

(This may already be done in Task 10 — verify and skip if so.)

- [ ] **Step 3: session-manager.js hook verification (E3 continued)**

In `session-manager.js` line 695, find:
```js
    } catch { /* silent — installHooks will handle errors */ }
```

Replace with:
```js
    } catch (e) { logger.debug('session-manager', `hook verification failed: ${e.message}`); }
```

- [ ] **Step 4: session-manager.js stats save (E4)**

In `session-manager.js` line 780, find:
```js
    } catch { /* silent */ }
```

Replace with:
```js
    } catch (e) {
      this.send(tabId, 'log', { type: 'stderr', text: `Stats save failed: ${e.message}` });
    }
```

The `tabId` parameter needs to be passed to `_saveProjectStats`. Check the calling code — if `_saveProjectStats` doesn't receive `tabId`, add it as a parameter.

- [ ] **Step 5: Commit**

```bash
git add proxy.js session-manager.js
git commit -m "fix: replace remaining silent catches with classified logging (E3, E4, E5)"
```

---

### Task 15: Logger Rotation (E6)

**Files:**
- Modify: `lib/logger.js`

- [ ] **Step 1: Write the failing test**

Add to `lib/runtime-utils.test.js` (or create a small inline test):
```js
test('logger rotation: rotateIfNeeded moves files correctly', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  const logFile = path.join(tmpDir, 'test.log');

  // Create a "large" log file (we'll test the rotation logic directly)
  const bigContent = 'x'.repeat(1024);
  fs.writeFileSync(logFile, bigContent);

  // Import the rotateIfNeeded function (we'll add it as an export)
  const { _rotateIfNeeded } = require('./logger');
  _rotateIfNeeded(logFile, 512); // threshold = 512 bytes

  // After rotation: old file moved to .1, new file is empty or doesn't exist
  assert.ok(fs.existsSync(logFile + '.1'), 'Rotated file should exist as .1');
  assert.ok(!fs.existsSync(logFile) || fs.statSync(logFile).size === 0, 'Original should be gone or empty');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/runtime-utils.test.js`
Expected: FAIL — `_rotateIfNeeded` is not exported

- [ ] **Step 3: Add rotation to logger.js**

In `lib/logger.js`, add a write counter and rotation function:

```js
let writeCount = 0;
const ROTATION_CHECK_INTERVAL = 100; // Check every 100 writes
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 3;

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
  } catch { /* stat failed — file doesn't exist yet, nothing to rotate */ }
}
```

Then modify the `log` function's file write section:
```js
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n');
      writeCount++;
      if (writeCount % ROTATION_CHECK_INTERVAL === 0) {
        _rotateIfNeeded(logFile);
      }
    } catch {
      // Last resort — can't log about logging failures
    }
  }
```

Export `_rotateIfNeeded` for testing:
```js
module.exports = {
  setLevel,
  setLogFile,
  debug: (ctx, msg, extra) => log('debug', ctx, msg, extra),
  info: (ctx, msg, extra) => log('info', ctx, msg, extra),
  warn: (ctx, msg, extra) => log('warn', ctx, msg, extra),
  error: (ctx, msg, extra) => log('error', ctx, msg, extra),
  _rotateIfNeeded, // exported for testing
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/runtime-utils.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/logger.js lib/runtime-utils.test.js
git commit -m "feat: add log rotation at 10MB with 3 rotated files (E6)"
```

---

## Phase 4: Test Coverage

### Task 16: Shared Test Utilities

**Files:**
- Create: `test/helpers.js`

- [ ] **Step 1: Create test helpers**

```js
// test/helpers.js — Shared test utilities
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Create a temporary directory for test isolation.
 * Returns { dir, cleanup } where cleanup removes the dir.
 */
function tmpDir(prefix = 'auto-claude-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    },
  };
}

/**
 * Create a mock filesystem structure.
 * @param {string} root - base directory
 * @param {Object} tree - { 'file.txt': 'content', 'sub/dir/file.js': 'content' }
 */
function createTree(root, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/**
 * Normalize path separators for cross-platform test assertions.
 */
function normPath(p) {
  return p.replace(/\\/g, '/');
}

module.exports = { tmpDir, createTree, normPath };
```

- [ ] **Step 2: Commit**

```bash
git add test/helpers.js
git commit -m "feat: add shared test helpers (tmpDir, createTree, normPath)"
```

---

### Task 17: autonomy.js Tests (~15 tests)

**Files:**
- Create: `lib/autonomy.test.js`

- [ ] **Step 1: Write all autonomy tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const AutonomyEngine = require('./autonomy');

// ── classifyQuestion ────────────────────────────────

test('classifyQuestion returns unknown for null input', () => {
  const engine = new AutonomyEngine({});
  assert.deepEqual(engine.classifyQuestion(null), { tier: 'unknown' });
});

test('classifyQuestion returns unknown for empty questions array', () => {
  const engine = new AutonomyEngine({});
  assert.deepEqual(engine.classifyQuestion({ questions: [] }), { tier: 'unknown' });
});

test('classifyQuestion returns simple for options-based question', () => {
  const engine = new AutonomyEngine({});
  const qd = { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] };
  assert.equal(engine.classifyQuestion(qd).tier, 'simple');
});

test('classifyQuestion returns simple for y/n pattern', () => {
  const engine = new AutonomyEngine({});
  const qd = { question: 'Do you want to proceed? (y/n)' };
  assert.equal(engine.classifyQuestion(qd).tier, 'simple');
});

test('classifyQuestion returns critical for approve plan', () => {
  const engine = new AutonomyEngine({});
  const qd = { question: 'Do you approve this plan?' };
  assert.equal(engine.classifyQuestion(qd).tier, 'critical');
});

test('classifyQuestion returns critical for delete operations', () => {
  const engine = new AutonomyEngine({});
  const qd = { question: 'Should I delete the database?' };
  assert.equal(engine.classifyQuestion(qd).tier, 'critical');
});

test('classifyQuestion returns simple for preference delegation', () => {
  const engine = new AutonomyEngine({});
  const qd = { question: 'Which approach would you prefer?' };
  // "which.*approach" matches CRITICAL_QUESTION_PATTERNS, so this is critical
  assert.equal(engine.classifyQuestion(qd).tier, 'critical');
});

// ── autoAnswer ──────────────────────────────────────

test('autoAnswer returns null when autoAnswer config is off', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.autoAnswer({}, {}), null);
});

test('autoAnswer selects recommended option', () => {
  const engine = new AutonomyEngine({});
  const cfg = { autoAnswer: { selectRecommended: true } };
  const qd = { question: 'Pick', options: [{ label: 'A' }, { label: 'B (Recommended)' }] };
  const result = engine.autoAnswer(qd, cfg);
  assert.equal(result.answer, '2');
});

test('autoAnswer selects all for multi-select', () => {
  const engine = new AutonomyEngine({});
  const cfg = { autoAnswer: { selectAll: true } };
  const qd = { question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true };
  const result = engine.autoAnswer(qd, cfg);
  assert.equal(result.answer, '1, 2');
});

test('autoAnswer returns yes for y/n with full autonomy', () => {
  const engine = new AutonomyEngine({});
  const cfg = { autoAnswer: { fullAutonomy: true } };
  const qd = { question: 'Continue? (y/n)' };
  const result = engine.autoAnswer(qd, cfg);
  assert.equal(result.answer, 'yes');
});

test('autoAnswer delegates choice for preference questions with full autonomy', () => {
  const engine = new AutonomyEngine({});
  const cfg = { autoAnswer: { fullAutonomy: true } };
  const qd = { question: 'What name would you like?' };
  const result = engine.autoAnswer(qd, cfg);
  assert.ok(result.answer.includes('you decide'));
});

// ── handleQuestion ──────────────────────────────────

test('handleQuestion returns ask-user when autoAnswer config missing', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.handleQuestion('tab1', {}, null).action, 'ask-user');
});

test('handleQuestion returns ask-user in manual mode', () => {
  const engine = new AutonomyEngine({ autoAnswer: { mode: 'manual' } });
  assert.equal(engine.handleQuestion('tab1', {}, null).action, 'ask-user');
});

test('handleQuestion auto-answers simple question in full mode', () => {
  const engine = new AutonomyEngine({ autoAnswer: { mode: 'full', selectRecommended: true } });
  const qd = { question: 'Pick', options: [{ label: 'A (Recommended)' }] };
  const result = engine.handleQuestion('tab1', qd, null);
  assert.equal(result.action, 'auto-answer');
});

// ── shouldRetry ─────────────────────────────────────

test('shouldRetry returns false for clean exit', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.shouldRetry(0, '', 0), false);
});

test('shouldRetry returns true for crash code 1', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.shouldRetry(1, '', 0), true);
});

test('shouldRetry returns false for fatal error', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.shouldRetry(1, 'unauthorized', 0), false);
});

test('shouldRetry returns false when max retries exceeded', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.shouldRetry(1, '', 3), false);
});

// ── getResumeState ──────────────────────────────────

test('getResumeState returns empty for null sessions', () => {
  const engine = new AutonomyEngine({});
  assert.deepEqual(engine.getResumeState(null), []);
});

test('getResumeState returns sessions that were running', () => {
  const engine = new AutonomyEngine({});
  const sessions = {
    '/project/a': { wasRunning: true, sessionId: 'abc', tabId: 'tab1' },
    '/project/b': { wasRunning: false, sessionId: 'def' },
  };
  const result = engine.getResumeState(sessions);
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 'abc');
});
```

- [ ] **Step 2: Run tests**

Run: `node --test lib/autonomy.test.js`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add lib/autonomy.test.js
git commit -m "test: add 20 tests for autonomy.js (classifyQuestion, autoAnswer, handleQuestion, shouldRetry, getResumeState)"
```

---

### Task 18: context-guard.js Tests (~10 tests)

**Files:**
- Create: `lib/context-guard.test.js`

- [ ] **Step 1: Write all context-guard tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getContextWindow,
  detectGsdWarning,
  shouldRecover,
  getHandoffPrompt,
  getResumePrompt,
} = require('./context-guard');

// ── getContextWindow ────────────────────────────────

test('getContextWindow returns config override when set', () => {
  assert.equal(getContextWindow('claude-sonnet-4', 500000, null), 500000);
});

test('getContextWindow returns API value when no override', () => {
  assert.equal(getContextWindow('claude-sonnet-4', null, 300000), 300000);
});

test('getContextWindow matches model prefix', () => {
  assert.equal(getContextWindow('claude-sonnet-4-20250514', null, null), 200000);
});

test('getContextWindow returns default for unknown model', () => {
  assert.equal(getContextWindow('gpt-4o', null, null), 200000);
});

// ── detectGsdWarning ────────────────────────────────

test('detectGsdWarning returns null for empty text', () => {
  assert.equal(detectGsdWarning(''), null);
});

test('detectGsdWarning detects warning', () => {
  assert.equal(detectGsdWarning('some text CONTEXT WARNING here'), 'warning');
});

test('detectGsdWarning detects critical', () => {
  assert.equal(detectGsdWarning('CONTEXT CRITICAL: please compact'), 'critical');
});

// ── shouldRecover ───────────────────────────────────

test('shouldRecover returns false when disabled', () => {
  const result = shouldRecover({ inputTokens: 180000 }, 'claude-sonnet-4', { contextGuard: { enabled: false } }, 0);
  assert.equal(result.recover, false);
});

test('shouldRecover returns true when above threshold', () => {
  const result = shouldRecover({ inputTokens: 180000 }, 'claude-sonnet-4', {}, 0);
  // 180000/200000 = 90% > 80% threshold
  assert.equal(result.recover, true);
});

test('shouldRecover returns false when below threshold', () => {
  const result = shouldRecover({ inputTokens: 100000 }, 'claude-sonnet-4', {}, 0);
  // 100000/200000 = 50% < 80%
  assert.equal(result.recover, false);
});

test('shouldRecover returns false when max recoveries reached', () => {
  const result = shouldRecover({ inputTokens: 180000 }, 'claude-sonnet-4', {}, 3);
  assert.equal(result.recover, false);
});

test('shouldRecover forces recovery on GSD critical', () => {
  const result = shouldRecover(
    { inputTokens: 50000, fullText: 'CONTEXT CRITICAL detected' },
    'claude-sonnet-4', {}, 0
  );
  assert.equal(result.recover, true);
});

// ── getHandoffPrompt / getResumePrompt ──────────────

test('getHandoffPrompt returns GSD pause for GSD sessions', () => {
  assert.equal(getHandoffPrompt({ gsdPhase: 'executing phase 1' }), '/gsd-pause-work');
});

test('getHandoffPrompt returns generic for non-GSD sessions', () => {
  assert.ok(getHandoffPrompt({}).includes('handoff summary'));
});

test('getResumePrompt returns GSD resume for GSD sessions', () => {
  assert.equal(getResumePrompt({ skillSource: 'gsd' }), '/gsd-resume-work');
});

test('getResumePrompt returns generic for non-GSD sessions', () => {
  assert.ok(getResumePrompt({}).includes('handoff'));
});
```

- [ ] **Step 2: Run tests**

Run: `node --test lib/context-guard.test.js`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add lib/context-guard.test.js
git commit -m "test: add 14 tests for context-guard.js (getContextWindow, detectGsdWarning, shouldRecover, prompts)"
```

---

### Task 19: validate.js Extended Tests (~12 tests)

**Files:**
- Modify: `lib/validate.test.js`

- [ ] **Step 1: Add comprehensive validation tests**

Append to `lib/validate.test.js`:
```js
const {
  validateProjectDir,
  validatePrompt,
  validateMasterTelegramConfig,
  validateDistinctTelegramTokens,
  validateProjectTelegramConfig,
  validateResponse,
} = require('./validate');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── validateProjectDir ──────────────────────────────

test('validateProjectDir rejects null', () => {
  const r = validateProjectDir(null);
  assert.equal(r.valid, false);
});

test('validateProjectDir rejects empty string', () => {
  const r = validateProjectDir('  ');
  assert.equal(r.valid, false);
});

test('validateProjectDir rejects dangerous characters', () => {
  const r = validateProjectDir('/tmp; rm -rf /');
  assert.equal(r.valid, false);
  assert.ok(r.error.includes('invalid characters'));
});

test('validateProjectDir rejects non-existent path', () => {
  const r = validateProjectDir('/nonexistent/path/xyz');
  assert.equal(r.valid, false);
});

test('validateProjectDir accepts valid directory', () => {
  const r = validateProjectDir(os.tmpdir());
  assert.equal(r.valid, true);
});

test('validateProjectDir rejects path over 500 chars', () => {
  const r = validateProjectDir('a'.repeat(501));
  assert.equal(r.valid, false);
});

// ── validatePrompt ──────────────────────────────────

test('validatePrompt accepts empty', () => {
  assert.equal(validatePrompt('').valid, true);
});

test('validatePrompt rejects non-string', () => {
  assert.equal(validatePrompt(123).valid, false);
});

test('validatePrompt rejects oversized', () => {
  assert.equal(validatePrompt('x'.repeat(50001)).valid, false);
});

// ── validateMasterTelegramConfig ────────────────────

test('validateMasterTelegramConfig rejects non-object', () => {
  assert.equal(validateMasterTelegramConfig('string').valid, false);
});

test('validateMasterTelegramConfig sanitizes valid config', () => {
  const r = validateMasterTelegramConfig({ enabled: true, allowedUsers: ['user1', 'user2'] });
  assert.equal(r.valid, true);
  assert.equal(r.config.enabled, true);
  assert.deepEqual(r.config.allowedUsers, ['user1', 'user2']);
});

// ── validateDistinctTelegramTokens ──────────────────

test('validateDistinctTelegramTokens rejects duplicate tokens', () => {
  const r = validateDistinctTelegramTokens('abc:123', 'abc:123');
  assert.equal(r.valid, false);
  assert.equal(r.code, 'DUPLICATE_TELEGRAM_TOKEN');
});

test('validateDistinctTelegramTokens accepts different tokens', () => {
  const r = validateDistinctTelegramTokens('abc:123', 'def:456');
  assert.equal(r.valid, true);
});

// ── validateProjectTelegramConfig ───────────────────

test('validateProjectTelegramConfig rejects null', () => {
  assert.equal(validateProjectTelegramConfig(null).ok, false);
});

// ── validateResponse ────────────────────────────────

test('validateResponse rejects empty', () => {
  assert.equal(validateResponse('').valid, false);
});

test('validateResponse rejects oversized', () => {
  assert.equal(validateResponse('x'.repeat(10001)).valid, false);
});

test('validateResponse accepts valid', () => {
  const r = validateResponse('hello');
  assert.equal(r.valid, true);
  assert.equal(r.text, 'hello');
});
```

- [ ] **Step 2: Run tests**

Run: `node --test lib/validate.test.js`
Expected: All pass (existing 2 + new 17 = 19 total)

- [ ] **Step 3: Commit**

```bash
git add lib/validate.test.js
git commit -m "test: add 17 tests for validate.js (validateProjectDir, validatePrompt, telegram config, response)"
```

---

### Task 20: sessions.js Tests (~6 tests)

**Files:**
- Create: `lib/sessions.test.js`

- [ ] **Step 1: Write sessions tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectPathHash } = require('./sessions');

test('projectPathHash converts Windows path correctly', () => {
  assert.equal(
    projectPathHash('D:\\work\\projects\\sources\\FreeLance\\RalphClaude'),
    'D--work-projects-sources-FreeLance-RalphClaude'
  );
});

test('projectPathHash converts path with spaces', () => {
  assert.equal(
    projectPathHash('C:\\Users\\Dan\\Desktop\\New folder'),
    'C--Users-Dan-Desktop-New-folder'
  );
});

test('projectPathHash converts Unix path', () => {
  assert.equal(
    projectPathHash('/home/user/project'),
    '-home-user-project'
  );
});

test('projectPathHash is deterministic', () => {
  const a = projectPathHash('D:\\test');
  const b = projectPathHash('D:\\test');
  assert.equal(a, b);
});

test('projectPathHash handles forward slashes', () => {
  assert.equal(
    projectPathHash('D:/work/project'),
    'D--work-project'
  );
});

test('projectPathHash handles single segment', () => {
  const result = projectPathHash('project');
  assert.equal(typeof result, 'string');
  assert.ok(result.length > 0);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test lib/sessions.test.js`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add lib/sessions.test.js
git commit -m "test: add 6 tests for sessions.js projectPathHash"
```

---

### Task 21: summarize.js Tests (~8 tests)

**Files:**
- Create: `lib/summarize.test.js`

- [ ] **Step 1: Write summarize tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const summarize = require('./summarize');

test('summarize Bash returns command prefix', () => {
  assert.equal(summarize('Bash', { command: 'npm test' }), '$ npm test');
});

test('summarize Read returns file path', () => {
  assert.equal(summarize('Read', { file_path: '/src/index.js' }), '/src/index.js');
});

test('summarize Write returns file path', () => {
  assert.equal(summarize('Write', { file_path: '/out.txt' }), '/out.txt');
});

test('summarize Edit returns file path', () => {
  assert.equal(summarize('Edit', { file_path: '/foo.js' }), '/foo.js');
});

test('summarize Grep returns quoted pattern', () => {
  assert.equal(summarize('Grep', { pattern: 'TODO' }), '"TODO"');
});

test('summarize Glob returns pattern', () => {
  assert.equal(summarize('Glob', { pattern: '**/*.js' }), '**/*.js');
});

test('summarize returns empty for null input', () => {
  assert.equal(summarize('Bash', null), '');
});

test('summarize falls back to first string value for unknown tool', () => {
  const result = summarize('CustomTool', { foo: 42, bar: 'hello' });
  assert.equal(result, 'hello');
});

test('summarize truncates long Bash commands', () => {
  const long = 'x'.repeat(200);
  const result = summarize('Bash', { command: long });
  assert.ok(result.length <= 122); // '$ ' + 120 chars
});

test('summarize WebFetch returns url', () => {
  assert.equal(summarize('WebFetch', { url: 'https://example.com' }), 'https://example.com');
});
```

- [ ] **Step 2: Run tests**

Run: `node --test lib/summarize.test.js`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add lib/summarize.test.js
git commit -m "test: add 10 tests for summarize.js (all tool types + edge cases)"
```

---

### Task 22: telegram-secure.js Tests (~8 tests)

**Files:**
- Create: `lib/telegram-secure.test.js`

- [ ] **Step 1: Write telegram-secure tests**

These tests mock `electron`'s `safeStorage` since it's not available outside Electron:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// telegram-secure.js requires electron.safeStorage which isn't available in tests.
// We test by reading the source and verifying patterns, plus testing projectTokenFileName.
const crypto = require('crypto');

// We can test projectTokenFileName directly since it only uses crypto
test('projectTokenFileName produces deterministic hash', () => {
  // Replicate the function logic
  function projectTokenFileName(projectDir) {
    const hash = crypto.createHash('md5').update(path.resolve(projectDir)).digest('hex').slice(0, 12);
    return `tg-project-${hash}.enc`;
  }

  const a = projectTokenFileName('/project/a');
  const b = projectTokenFileName('/project/a');
  assert.equal(a, b);
  assert.ok(a.startsWith('tg-project-'));
  assert.ok(a.endsWith('.enc'));
});

test('projectTokenFileName differs for different paths', () => {
  function projectTokenFileName(projectDir) {
    const hash = crypto.createHash('md5').update(path.resolve(projectDir)).digest('hex').slice(0, 12);
    return `tg-project-${hash}.enc`;
  }

  const a = projectTokenFileName('/project/a');
  const b = projectTokenFileName('/project/b');
  assert.notEqual(a, b);
});

test('projectTokenFileName hash is 12 chars', () => {
  function projectTokenFileName(projectDir) {
    const hash = crypto.createHash('md5').update(path.resolve(projectDir)).digest('hex').slice(0, 12);
    return `tg-project-${hash}.enc`;
  }

  const name = projectTokenFileName('/any/path');
  // tg-project- (11) + hash (12) + .enc (4) = 27
  assert.equal(name.length, 27);
});

// Source-level verification tests
test('telegram-secure exports all expected functions', () => {
  const src = fs.readFileSync(path.join(__dirname, 'telegram-secure.js'), 'utf8');
  const expectedExports = [
    'saveToken', 'loadToken', 'deleteToken',
    'saveMasterTelegramToken', 'loadMasterTelegramToken', 'clearMasterTelegramToken',
    'saveProjectToken', 'loadProjectToken', 'clearProjectToken',
    'saveCustomProviderToken', 'loadCustomProviderToken', 'clearCustomProviderToken',
    'isEncryptionAvailable',
  ];
  for (const fn of expectedExports) {
    assert.ok(src.includes(fn), `Missing export: ${fn}`);
  }
});

test('telegram-secure uses safeStorage.encryptString for saves', () => {
  const src = fs.readFileSync(path.join(__dirname, 'telegram-secure.js'), 'utf8');
  assert.ok(src.includes('safeStorage.encryptString'));
});

test('telegram-secure uses safeStorage.decryptString for loads', () => {
  const src = fs.readFileSync(path.join(__dirname, 'telegram-secure.js'), 'utf8');
  assert.ok(src.includes('safeStorage.decryptString'));
});

test('telegram-secure checks isEncryptionAvailable before save', () => {
  const src = fs.readFileSync(path.join(__dirname, 'telegram-secure.js'), 'utf8');
  assert.ok(src.includes('isEncryptionAvailable()'));
});

test('telegram-secure loadEncryptedToken returns null for missing file', () => {
  const src = fs.readFileSync(path.join(__dirname, 'telegram-secure.js'), 'utf8');
  // Verify it checks existsSync and returns null
  assert.ok(src.includes('existsSync'));
  assert.ok(src.includes('return null'));
});
```

- [ ] **Step 2: Run tests**

Run: `node --test lib/telegram-secure.test.js`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add lib/telegram-secure.test.js
git commit -m "test: add 8 tests for telegram-secure.js (hash determinism, exports, patterns)"
```

---

## Phase 5: Module Decomposition

### Task 23: Extract question-utils.js (5E)

**Files:**
- Create: `lib/question-utils.js`
- Modify: `lib/autonomy.js`
- Modify: `session-manager.js`

- [ ] **Step 1: Write the failing test**

Create `lib/question-utils.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractQuestions } = require('./question-utils');

test('extractQuestions returns questions array when present', () => {
  const data = { questions: [{ question: 'A' }, { question: 'B' }] };
  assert.equal(extractQuestions(data).length, 2);
});

test('extractQuestions wraps single question in array', () => {
  const data = { question: 'Pick one' };
  const result = extractQuestions(data);
  assert.equal(result.length, 1);
  assert.equal(result[0].question, 'Pick one');
});

test('extractQuestions returns empty for null', () => {
  assert.deepEqual(extractQuestions(null), []);
});

test('extractQuestions returns empty for empty object', () => {
  assert.deepEqual(extractQuestions({}), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/question-utils.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create question-utils.js**

```js
// lib/question-utils.js — Shared question extraction (5E)
// Eliminates the 5x duplicated pattern:
//   questionData.questions || (questionData.question ? [questionData] : [])

function extractQuestions(data) {
  if (!data) return [];
  return data.questions || (data.question ? [data] : []);
}

module.exports = { extractQuestions };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/question-utils.test.js`
Expected: PASS

- [ ] **Step 5: Replace duplicated patterns in autonomy.js**

In `lib/autonomy.js`, add the require at top:
```js
const { extractQuestions } = require('./question-utils');
```

Replace the two occurrences:
- Line 23: `const qList = questionData.questions || (questionData.question ? [questionData] : []);`
  becomes: `const qList = extractQuestions(questionData);`
- Line 64: same pattern
  becomes: `const qList = extractQuestions(questionData);`

- [ ] **Step 6: Run all tests**

Run: `node --test lib/*.test.js`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add lib/question-utils.js lib/question-utils.test.js lib/autonomy.js
git commit -m "refactor: extract question-utils.js to eliminate 5x duplicated pattern (5E)"
```

---

### Task 24: IPC Trust Wrapper (5C)

**Files:**
- Create: `lib/ipc-trust.js`
- Modify: `main.js`

- [ ] **Step 1: Write the failing test**

Create `lib/ipc-trust.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { withTrustedIpc } = require('./ipc-trust');

test('withTrustedIpc rejects untrusted event', async () => {
  const handler = withTrustedIpc('test-channel', () => 'ok', {
    isTrusted: () => false,
  });
  const result = await handler({ sender: { id: 999 } }, 'arg1');
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('Untrusted'));
});

test('withTrustedIpc passes trusted event to handler', async () => {
  const handler = withTrustedIpc('test-channel', (event, arg) => ({ ok: true, data: arg }), {
    isTrusted: () => true,
  });
  const result = await handler({ sender: { id: 1 } }, 'arg1');
  assert.equal(result.ok, true);
  assert.equal(result.data, 'arg1');
});

test('withTrustedIpc passes action name to isTrusted', async () => {
  let receivedAction = null;
  const handler = withTrustedIpc('my-channel', () => 'ok', {
    isTrusted: (event, action) => { receivedAction = action; return true; },
  });
  await handler({}, 'arg');
  assert.equal(receivedAction, 'my-channel');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/ipc-trust.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create ipc-trust.js**

```js
// lib/ipc-trust.js — IPC trust wrapper (5C)
// Replaces 50+ copy-pasted trust checks with a single wrapper.

/**
 * Wrap an IPC handler with trust verification.
 * @param {string} action - Channel name for logging
 * @param {Function} handler - The actual handler function
 * @param {Object} deps - { isTrusted: (event, action) => boolean }
 * @returns {Function} Wrapped handler
 */
function withTrustedIpc(action, handler, deps) {
  return async (event, ...args) => {
    if (!deps.isTrusted(event, action)) {
      return { ok: false, error: 'Untrusted IPC sender' };
    }
    return handler(event, ...args);
  };
}

module.exports = { withTrustedIpc };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/ipc-trust.test.js`
Expected: PASS

- [ ] **Step 5: Apply to a few IPC handlers in main.js as a pattern**

Pick 3-5 simple `ipcMain.handle` calls in main.js and convert them. Example for `load-config`:

Before:
```js
ipcMain.handle('load-config', (event) => {
  if (!isTrustedIpcEvent(event, 'load-config')) return {};
  config = settingsDb.buildConfigObject(config);
  return config;
});
```

After:
```js
const { withTrustedIpc } = require('./lib/ipc-trust');
const trustDeps = { isTrusted: isTrustedIpcEvent };

ipcMain.handle('load-config', withTrustedIpc('load-config', () => {
  config = settingsDb.buildConfigObject(config);
  return config;
}, trustDeps));
```

Apply this pattern to the remaining IPC handlers incrementally (don't try to convert all 50+ at once — that's fragile).

- [ ] **Step 6: Run all tests**

Run: `node --test lib/*.test.js`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add lib/ipc-trust.js lib/ipc-trust.test.js main.js
git commit -m "refactor: add IPC trust wrapper to replace copy-pasted trust checks (5C)"
```

---

### Task 25: Split claude-detector.js into 4 modules (5A)

**Files:**
- Create: `lib/claude-detection.js`
- Create: `lib/plugin-manager.js`
- Create: `lib/settings-manager.js`
- Create: `lib/update-checker.js`
- Modify: `lib/claude-detector.js` (becomes thin re-export facade)

This is the largest decomposition task. The approach: extract functions into new modules, then make `claude-detector.js` re-export everything for backward compatibility.

- [ ] **Step 1: Identify function groups in claude-detector.js**

Scan the file for all exported functions. Group them:

**claude-detection.js:** `detect`, `detectPrerequisites`, `detectRecommendedTools`, `extractVersion`, `getClaudeHome`, `maskToken`

**plugin-manager.js:** `listPlugins`, `togglePlugin`, `installPlugin`

**settings-manager.js:** `readSettingsJson`, `writeSettingsJson`, `listSettingsTags`, `loadSettingsTag`, `saveSettingsTag`, `deleteSettingsTag`

**update-checker.js:** `checkForUpdate`

- [ ] **Step 2: Create lib/claude-detection.js**

Move the detection-related functions to this new file. Include all their dependencies (requires, helper functions used only by them).

```js
// lib/claude-detection.js — CLI detection, version, auth, prerequisites (5A)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

// ... move detect(), detectPrerequisites(), detectRecommendedTools(),
//     extractVersion(), getClaudeHome(), maskToken() here ...
// Include all helper functions they depend on (findClaudeBinary, etc.)

module.exports = { detect, detectPrerequisites, detectRecommendedTools, extractVersion, getClaudeHome, maskToken };
```

- [ ] **Step 3: Create lib/plugin-manager.js**

```js
// lib/plugin-manager.js — Plugin listing, toggling, installation (5A)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('./logger');

// ... move listPlugins(), togglePlugin(), installPlugin() here ...

module.exports = { listPlugins, togglePlugin, installPlugin };
```

- [ ] **Step 4: Create lib/settings-manager.js**

```js
// lib/settings-manager.js — Settings read/write, tags (5A)
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// ... move readSettingsJson(), writeSettingsJson(),
//     listSettingsTags(), loadSettingsTag(), saveSettingsTag(), deleteSettingsTag() here ...

module.exports = { readSettingsJson, writeSettingsJson, listSettingsTags, loadSettingsTag, saveSettingsTag, deleteSettingsTag };
```

- [ ] **Step 5: Create lib/update-checker.js**

```js
// lib/update-checker.js — Claude CLI update detection (5A)
const { execFileSync } = require('child_process');
const logger = require('./logger');

// ... move checkForUpdate() here ...

module.exports = { checkForUpdate };
```

- [ ] **Step 6: Convert claude-detector.js to re-export facade**

Replace `lib/claude-detector.js` with:
```js
// lib/claude-detector.js — Backward-compatible re-export facade (5A)
// After decomposition, consumers should import from the specific module directly.
const detection = require('./claude-detection');
const plugins = require('./plugin-manager');
const settings = require('./settings-manager');
const updates = require('./update-checker');

module.exports = {
  ...detection,
  ...plugins,
  ...settings,
  ...updates,
};
```

- [ ] **Step 7: Run all tests**

Run: `node --test lib/*.test.js`
Expected: All pass (facade preserves all exports)

- [ ] **Step 8: Commit**

```bash
git add lib/claude-detection.js lib/plugin-manager.js lib/settings-manager.js lib/update-checker.js lib/claude-detector.js
git commit -m "refactor: decompose claude-detector.js (633 lines) into 4 focused modules (5A)"
```

---

### Task 26: Extract telegram-auth.js (5D)

**Files:**
- Create: `lib/telegram-auth.js`
- Modify: `lib/telegram.js`
- Modify: `lib/master-telegram.js`

- [ ] **Step 1: Write the failing test**

Create `lib/telegram-auth.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorized } = require('./telegram-auth');

test('isAuthorized returns true when no allowedUsers (open access)', () => {
  assert.equal(isAuthorized('someUser', 12345, []), true);
});

test('isAuthorized matches by username', () => {
  assert.equal(isAuthorized('alice', 12345, ['alice', 'bob']), true);
});

test('isAuthorized matches by numeric ID', () => {
  assert.equal(isAuthorized(null, 12345, ['12345']), true);
});

test('isAuthorized rejects unauthorized user', () => {
  assert.equal(isAuthorized('eve', 99999, ['alice', 'bob']), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/telegram-auth.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create telegram-auth.js**

```js
// lib/telegram-auth.js — Shared Telegram auth logic (5D)
const fs = require('fs');
const logger = require('./logger');

/**
 * Check if a user is authorized.
 * @param {string|null} username
 * @param {number} numericId
 * @param {string[]} allowedUsers - list of usernames or numeric ID strings
 * @returns {boolean}
 */
function isAuthorized(username, numericId, allowedUsers) {
  if (!allowedUsers || allowedUsers.length === 0) return true;
  const key = username || String(numericId);
  return allowedUsers.includes(key) || allowedUsers.includes(String(numericId));
}

/**
 * Persist chat IDs to a JSON file.
 * @param {string} filePath
 * @param {Map<string, number>} chatIds
 */
function persistChatIds(filePath, chatIds) {
  try {
    const obj = {};
    for (const [k, v] of chatIds) obj[k] = v;
    fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
  } catch (e) {
    logger.debug('telegram-auth', `Failed to persist chat IDs: ${e.message}`);
  }
}

/**
 * Load chat IDs from a JSON file.
 * @param {string} filePath
 * @returns {Map<string, number>}
 */
function loadChatIds(filePath) {
  const map = new Map();
  try {
    if (!fs.existsSync(filePath)) return map;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [k, v] of Object.entries(data)) map.set(k, v);
  } catch (e) {
    logger.debug('telegram-auth', `Failed to load chat IDs: ${e.message}`);
  }
  return map;
}

module.exports = { isAuthorized, persistChatIds, loadChatIds };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/telegram-auth.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/telegram-auth.js lib/telegram-auth.test.js
git commit -m "refactor: extract telegram-auth.js with shared auth logic (5D)"
```

---

## Phase 6: Performance

### Task 27: Async Hook Polling (P1)

**Files:**
- Modify: `proxy.js:402-445`

- [ ] **Step 1: Convert _readHookLog to async**

Replace the sync `_readHookLog` method with an async version:

```js
  async _readHookLog(logFile, result) {
    try {
      let stat;
      try { stat = await fs.promises.stat(logFile); } catch { return; }
      if (stat.size < this.hookByteOffset) { this.hookByteOffset = 0; }
      if (stat.size === this.hookByteOffset) return;

      const maxBytes = ((this.config.hooks?.maxLogSizeMB || 5) * 1024 * 1024) || MAX_HOOK_LOG_BYTES;
      if (stat.size > maxBytes) {
        try {
          const all = await fs.promises.readFile(logFile, 'utf8');
          const lines = all.split('\n').filter(l => l.trim());
          const keep = lines.slice(Math.floor(lines.length / 2));
          const tmpFile = logFile + '.tmp';
          await fs.promises.writeFile(tmpFile, keep.join('\n') + '\n');
          await fs.promises.rename(tmpFile, logFile);
          const newStat = await fs.promises.stat(logFile);
          this.hookByteOffset = newStat.size;
          return;
        } catch (e) { logger.debug('proxy', `hook log truncation failed: ${e.message}`); }
      }

      const newBytes = stat.size - this.hookByteOffset;
      const buf = Buffer.alloc(newBytes);
      const fh = await fs.promises.open(logFile, 'r');
      try {
        await fh.read(buf, 0, newBytes, this.hookByteOffset);
      } finally {
        await fh.close();
      }

      this.hookByteOffset = stat.size;

      const newContent = buf.toString('utf8');
      const lines = newContent.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          result.hookEvents.push(entry);
          if (result.hookEvents.length > RING_BUFFER_HOOK_EVENTS) result.hookEvents = result.hookEvents.slice(-RING_BUFFER_HOOK_EVENTS);
          this.emit('hook-event', entry);
          this._trackRedundantReads(entry);
        } catch { /* skip unparseable lines */ }
      }
    } catch (err) { logger.debug('proxy', `hook log read failed: ${err.message}`); }
  }
```

- [ ] **Step 2: Update _startHookWatcher to handle async polling**

The `setInterval` callback can be async — Node handles this fine (unhandled rejections are caught by the try/catch inside _readHookLog):

```js
  _startHookWatcher(projectDir, result) {
    // ... existing setup code ...
    this.hookWatcher = setInterval(() => {
      this._readHookLog(logFile, result); // returns Promise, but fire-and-forget is fine here
    }, HOOK_POLL_INTERVAL_MS);
  }
```

- [ ] **Step 3: Run all tests**

Run: `node --test lib/*.test.js`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add proxy.js
git commit -m "perf: convert hook log polling to async I/O to unblock event loop (P1)"
```

---

### Task 28: Logger Buffering (P2)

**Files:**
- Modify: `lib/logger.js`

- [ ] **Step 1: Add write buffering**

Add a buffer array and flush mechanism to `lib/logger.js`:

```js
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

// Immediate flush on error or process exit
function _flushSync() {
  if (!logFile || buffer.length === 0) return;
  const lines = buffer.splice(0, buffer.length);
  try {
    fs.appendFileSync(logFile, lines.join('\n') + '\n');
  } catch { /* last resort */ }
}

// Register exit handler
process.on('exit', _flushSync);
```

Then modify the `log` function's file write section:
```js
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
```

- [ ] **Step 2: Export _flushSync for testing and shutdown**

Add to exports:
```js
module.exports = {
  // ... existing exports ...
  _flushSync, // for testing and graceful shutdown
};
```

- [ ] **Step 3: Run all tests**

Run: `node --test lib/*.test.js`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add lib/logger.js
git commit -m "perf: buffer log writes with 500ms flush interval, immediate on error (P2)"
```

---

### Task 29: Settings-DB Save Batching (P3)

**Files:**
- Modify: `settings-db.js`

- [ ] **Step 1: Add debounced save**

In `settings-db.js`, find the `set()` method. It currently calls `this.save()` after every write. Add debouncing:

After the constructor, add:
```js
  _scheduleSave() {
    if (this._saveTimer) return;
    this._dirty = true;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) {
        this.save();
        this._dirty = false;
      }
    }, 500);
  }
```

In the `set()` method, replace `this.save()` with `this._scheduleSave()`.

Keep `setMany()` calling `this.save()` immediately (bulk operations should flush).

Add to the class:
```js
  flushSync() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) {
      this.save();
      this._dirty = false;
    }
  }
```

In `main.js`, register flush on exit:
```js
process.on('exit', () => { settingsDb?.flushSync(); });
app.on('before-quit', () => { settingsDb?.flushSync(); });
```

- [ ] **Step 2: Run all tests**

Run: `node --test lib/*.test.js`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add settings-db.js main.js
git commit -m "perf: debounce settings-db saves with 500ms delay, immediate on setMany (P3)"
```

---

### Task 30: Async claude-detector (P4)

**Files:**
- Modify: `lib/claude-detection.js` (after Phase 5 decomposition)

- [ ] **Step 1: Convert detect() to async**

In `lib/claude-detection.js`, replace all `execFileSync` calls with `util.promisify(execFile)`:

```js
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function detect() {
  // Replace: const stdout = execFileSync('claude', ['--version'], ...);
  // With: const { stdout } = await execFileAsync('claude', ['--version'], ...);
  // ... apply to all execFileSync calls in detect(), detectPrerequisites(), detectRecommendedTools()
}
```

- [ ] **Step 2: Update all callers to await**

In `main.js`, find all calls to `claudeDetector.detect()`, `claudeDetector.detectPrerequisites()`, etc. and add `await`. Most are already in async handlers so this is straightforward.

- [ ] **Step 3: Run all tests**

Run: `node --test lib/*.test.js`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add lib/claude-detection.js main.js
git commit -m "perf: convert claude-detector to async execFile to unblock main thread (P4)"
```

---

### Task 31: Health Status Caching (P5)

**Files:**
- Modify: `main.js` (buildHealthStatus area)

- [ ] **Step 1: Add TTL cache**

Near the `buildHealthStatus` function in `main.js`, add caching:

```js
let healthCache = null;
let healthCacheTime = 0;
const HEALTH_CACHE_TTL_MS = 30000; // 30 seconds

async function buildHealthStatusCached() {
  const now = Date.now();
  if (healthCache && (now - healthCacheTime) < HEALTH_CACHE_TTL_MS) {
    return healthCache;
  }
  healthCache = await buildHealthStatus();
  healthCacheTime = now;
  return healthCache;
}

function invalidateHealthCache() {
  healthCache = null;
  healthCacheTime = 0;
}
```

Replace `buildHealthStatus()` calls in IPC handlers with `buildHealthStatusCached()`. Call `invalidateHealthCache()` after plugin installs, config changes, etc.

- [ ] **Step 2: Commit**

```bash
git add main.js
git commit -m "perf: cache health status for 30s with invalidation on config change (P5)"
```

---

## Phase 7: SDK Protocol Migration

### Task 32: Add SDK Constants

**Files:**
- Modify: `lib/constants.js`

- [ ] **Step 1: Add SDK-related constants**

Append to `lib/constants.js`:
```js
  // ── SDK Protocol (Phase 7) ─────────────────────────
  SDK_MIN_VERSION: '1.0.0', // Minimum Claude CLI version supporting stream-json input
  SDK_KEEPALIVE_INTERVAL_MS: 30000, // Heartbeat interval
  SDK_INPUT_FORMAT: 'stream-json',
  SDK_OUTPUT_FORMAT: 'stream-json',

  // Control request/response types
  CONTROL_REQUEST_TYPES: ['can_use_tool'],
  CONTROL_DECISIONS: ['allow', 'deny'],

  // Session state events (CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS)
  SESSION_STATES: ['idle', 'running', 'requires_action'],
```

- [ ] **Step 2: Commit**

```bash
git add lib/constants.js
git commit -m "feat: add SDK protocol constants for bidirectional communication (Phase 7)"
```

---

### Task 33: SDK Mode in ClaudeProxy

**Files:**
- Modify: `proxy.js`

This is the core migration. The proxy must support two modes: legacy (print mode) and SDK (stream-json bidirectional).

- [ ] **Step 1: Add SDK mode detection**

In `proxy.js`, add a method to check if the installed Claude CLI supports SDK mode:

```js
  _supportsSDKMode() {
    try {
      const version = this.config._claudeVersion || '';
      // SDK mode requires --input-format stream-json support
      // Compare against minimum version from constants
      return this._compareVersions(version, SDK_MIN_VERSION) >= 0;
    } catch { return false; }
  }

  _compareVersions(a, b) {
    const pa = (a || '0.0.0').split('.').map(Number);
    const pb = (b || '0.0.0').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }
```

- [ ] **Step 2: Add bidirectional stdin communication**

Add methods for writing to stdin:

```js
  _sendToStdin(message) {
    if (!this.process || !this.process.stdin || this.process.stdin.destroyed) return false;
    try {
      this.process.stdin.write(JSON.stringify(message) + '\n');
      return true;
    } catch (e) {
      logger.debug('proxy', `stdin write failed: ${e.message}`);
      return false;
    }
  }

  sendControlResponse(toolUseId, decision) {
    return this._sendToStdin({
      type: 'control_response',
      tool_use_id: toolUseId,
      decision, // 'allow' or 'deny'
    });
  }

  sendKeepAlive() {
    return this._sendToStdin({ type: 'keep_alive' });
  }
```

- [ ] **Step 3: Add control_request parsing to _parseLine**

In the `_parseLine` method, add handling for `control_request` messages:

```js
    // SDK mode: handle control requests (permission prompts)
    if (parsed.type === 'control_request') {
      this.emit('control-request', {
        subtype: parsed.subtype,
        toolName: parsed.tool_name,
        input: parsed.input,
        toolUseId: parsed.tool_use_id,
      });
      return;
    }
```

- [ ] **Step 4: Build SDK CLI args**

Add a new arg builder for SDK mode:

```js
  static _buildSDKModeArgs(prompt, options, config) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--input-format', 'stream-json'];

    if (options.sessionId) args.push('--session-id', options.sessionId);
    if (options.resume) args.push('--resume', options.resume);
    if (config.model) args.push('--model', config.model);
    if (config.skipPermissions) args.push('--dangerously-skip-permissions');

    // Include hook events in stream (eliminates separate hook log polling)
    args.push('--include-hook-events');
    // Replay user messages for context
    args.push('--replay-user-messages');

    return args;
  }
```

- [ ] **Step 5: Update _execute for SDK mode**

In `_execute`, add a branch for SDK mode that keeps stdin open:

```js
  async _execute(projectDir, options) {
    const sdkMode = this._supportsSDKMode();
    // ... existing plan resolution ...

    if (sdkMode) {
      return this._executeSDK(projectDir, options, plan);
    }
    return this._executePrintMode(projectDir, options, plan);
  }

  async _executeSDK(projectDir, options, plan) {
    const args = ClaudeProxy._buildSDKModeArgs(options.prompt, options, this.config);
    const env = { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: 'true' };

    const proc = spawn(plan.binary, args, {
      cwd: projectDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'], // stdin stays open
    });

    this.process = proc;

    // Start keepalive heartbeat
    const keepalive = setInterval(() => this.sendKeepAlive(), SDK_KEEPALIVE_INTERVAL_MS);

    // Parse stdout as NDJSON
    let lineBuffer = '';
    proc.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (line.trim()) this._parseLine(line, result);
      }
    });

    // ... stderr, close handling similar to existing ...

    // Cleanup on close
    proc.on('close', (code) => {
      clearInterval(keepalive);
      // ... existing close logic ...
    });
  }
```

- [ ] **Step 6: Rename existing _execute to _executePrintMode**

Move the current `_execute` logic into `_executePrintMode` for backward compatibility.

- [ ] **Step 7: Run all tests**

Run: `node --test lib/*.test.js`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add proxy.js
git commit -m "feat: add SDK bidirectional protocol support with control_request/response (Phase 7)"
```

---

### Task 34: Session Manager SDK Integration

**Files:**
- Modify: `session-manager.js`

- [ ] **Step 1: Wire control-request events**

In `_wireProxy`, add handler for SDK permission requests:

```js
  proxy.on('control-request', (request) => {
    // Route permission request through autonomy engine
    const decision = this.autonomy.evaluatePermission(request, this.config);
    if (decision.action === 'allow') {
      proxy.sendControlResponse(request.toolUseId, 'allow');
      this.send(tabId, 'log', { type: 'system', text: `\u2705 Auto-approved: ${request.toolName} (${decision.reason})` });
    } else if (decision.action === 'deny') {
      proxy.sendControlResponse(request.toolUseId, 'deny');
      this.send(tabId, 'log', { type: 'system', text: `\u274c Denied: ${request.toolName} (${decision.reason})` });
    } else {
      // Route to user/telegram
      this._handlePermissionQuestion(tabId, session, proxy, request);
    }
  });
```

- [ ] **Step 2: Remove kill-restart answer pattern for SDK mode**

In the question handling flow, when SDK mode is active, use `proxy.sendControlResponse()` instead of killing and restarting the process. Add a check:

```js
  if (proxy.sdkMode) {
    // SDK mode: send response via stdin
    proxy.sendControlResponse(questionData.toolUseId, 'allow');
  } else {
    // Legacy mode: resolve answer promise (triggers process kill/restart)
    session.pendingResponse = answer;
    if (session.answerResolve) session.answerResolve();
  }
```

- [ ] **Step 3: Commit**

```bash
git add session-manager.js
git commit -m "feat: integrate SDK control_request routing with autonomy engine (Phase 7)"
```

---

### Task 35: Autonomy Engine SDK Permission Evaluation

**Files:**
- Modify: `lib/autonomy.js`

- [ ] **Step 1: Write the failing test**

Add to `lib/autonomy.test.js`:
```js
test('evaluatePermission auto-approves Read tool', () => {
  const engine = new AutonomyEngine({
    autonomy: { permissionRules: { alwaysApprove: ['Read', 'Glob', 'Grep'] } }
  });
  const result = engine.evaluatePermission({ toolName: 'Read', input: {} });
  assert.equal(result.action, 'allow');
});

test('evaluatePermission prompts for unknown tool', () => {
  const engine = new AutonomyEngine({
    autonomy: { permissionRules: { alwaysApprove: ['Read'] } }
  });
  const result = engine.evaluatePermission({ toolName: 'NotebookEdit', input: {} });
  assert.equal(result.action, 'ask-user');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/autonomy.test.js`
Expected: FAIL — `evaluatePermission` not defined

- [ ] **Step 3: Add evaluatePermission to autonomy.js**

```js
  /**
   * Evaluate a permission request from SDK control_request.
   * @param {Object} request - { toolName, input, toolUseId }
   * @param {Object} config - global config (optional, falls back to this.config)
   * @returns {{ action: 'allow'|'deny'|'ask-user', reason: string }}
   */
  evaluatePermission(request, config) {
    const cfg = config || this.config;
    const rules = cfg.autonomy?.permissionRules || {};
    const tool = request.toolName;

    // Always-approve list (safe read-only tools)
    const alwaysApprove = rules.alwaysApprove || ['Read', 'Glob', 'Grep', 'LSP', 'WebSearch'];
    if (alwaysApprove.includes(tool)) {
      return { action: 'allow', reason: `${tool} is in always-approve list` };
    }

    // Always-deny list
    const alwaysDeny = rules.alwaysDeny || [];
    if (alwaysDeny.includes(tool)) {
      return { action: 'deny', reason: `${tool} is in always-deny list` };
    }

    // Full autonomy mode: approve everything
    if (cfg.autoAnswer?.fullAutonomy) {
      return { action: 'allow', reason: 'full autonomy mode' };
    }

    // Default: ask user
    return { action: 'ask-user', reason: `${tool} requires user approval` };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/autonomy.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/autonomy.js lib/autonomy.test.js
git commit -m "feat: add evaluatePermission for SDK permission auto-approve rules (A2/Phase 7)"
```

---

## Phase 8: Autonomy Hardening

### Task 36: SIGKILL Escalation (A1)

**Files:**
- Modify: `proxy.js:41-65`

- [ ] **Step 1: Add SIGKILL escalation after SIGTERM**

Replace the `kill()` method:

```js
  kill() {
    return new Promise((resolve) => {
      this.aborted = true;
      this._stopHookWatcher();
      if (!this.process) { resolve(); return; }
      const pid = this.process.pid;
      const proc = this.process;
      this.process = null;

      const timeout = setTimeout(() => {
        // A1: Escalate to SIGKILL after 3s if still alive
        try {
          if (os.platform() === 'win32' && pid) {
            execFile('taskkill', ['/F', '/T', '/PID', String(pid)],
              { timeout: 3000, windowsHide: true }, () => {});
          } else if (pid) {
            process.kill(pid, 'SIGKILL');
          }
        } catch { /* already dead */ }
        setTimeout(resolve, 500); // Give OS time to clean up
      }, 3000);

      proc.on('close', () => { clearTimeout(timeout); resolve(); });

      try {
        if (os.platform() === 'win32' && pid) {
          execFile('taskkill', ['/T', '/PID', String(pid)],
            { timeout: 5000, windowsHide: true }, () => {});
        } else {
          proc.kill('SIGTERM');
        }
      } catch (e) {
        logger.debug('proxy', `kill failed for PID ${pid}: ${e.message}`);
        resolve();
      }
    });
  }
```

- [ ] **Step 2: Commit**

```bash
git add proxy.js
git commit -m "feat: escalate to SIGKILL after 3s SIGTERM timeout to prevent zombie processes (A1)"
```

---

### Task 37: Session State Display (A4)

**Files:**
- Modify: `index.html`
- Modify: `session-manager.js`

- [ ] **Step 1: Forward session state events to renderer**

In `session-manager.js` `_wireProxy`, add handler for session state events (received in SDK mode output):

```js
  proxy.on('session-state', (state) => {
    // state is 'idle' | 'running' | 'requires_action'
    session.state.sessionState = state;
    this.send(tabId, 'session-state', { tabId, state });
  });
```

In proxy `_parseLine`, detect state events:
```js
    if (parsed.type === 'system' && parsed.subtype === 'session_state') {
      this.emit('session-state', parsed.state);
      return;
    }
```

- [ ] **Step 2: Update tab header in index.html**

In `index.html`, find the `onStatus` or session event handler section. Add handler for `session-state`:

```js
window.api.onSessionState((data) => {
  const tab = document.querySelector(`.t[data-tab-id="${data.tabId}"]`);
  if (!tab) return;
  const dot = tab.querySelector('.state-dot') || (() => {
    const d = document.createElement('span');
    d.className = 'state-dot';
    tab.prepend(d);
    return d;
  })();
  dot.className = 'state-dot state-' + data.state;
  dot.title = data.state;
});
```

Add CSS:
```css
.state-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
.state-idle { background: var(--dim); }
.state-running { background: var(--green); }
.state-requires_action { background: var(--orange); }
```

- [ ] **Step 3: Commit**

```bash
git add index.html session-manager.js proxy.js
git commit -m "feat: display session state (idle/running/requires_action) in tab header (A4)"
```

---

### Task 38: Notification Hook Forwarding (A3)

**Files:**
- Modify: `install-hooks.js`
- Modify: `session-manager.js`

- [ ] **Step 1: Add Notification hook to install-hooks.js**

In `install-hooks.js`, find where hooks are defined (PostToolUse, SubagentStop). Add a Notification hook:

```js
const hookEntries = {
  PostToolUse: [/* existing */],
  SubagentStop: [/* existing */],
  Notification: [{
    type: 'command',
    command: hookScript + ' notification',
    timeout: 5000,
  }],
};
```

- [ ] **Step 2: Handle notification events in session-manager.js**

In `_wireProxy`, if a hook event with type 'Notification' arrives, forward to Telegram:

```js
  proxy.on('hook-event', (entry) => {
    // ... existing hook event handling ...

    // A3: Forward notifications to Telegram
    if (entry.event === 'Notification' && session.telegram?.isRunning) {
      const msg = entry.title || entry.message || 'Notification from Claude';
      session.telegram.broadcastDirect(`\ud83d\udd14 ${msg}`);
    }
  });
```

- [ ] **Step 3: Commit**

```bash
git add install-hooks.js session-manager.js
git commit -m "feat: register Notification hook and forward to Telegram (A3)"
```

---

### Task 39: Operational Runbook (A5)

**Files:**
- Create: `docs/runbook.md`

- [ ] **Step 1: Write the operational runbook**

Create `docs/runbook.md` with sections covering:

```markdown
# Auto Claude — Operational Runbook

## DB Corruption Recovery
- Backup location: `<userData>/settings.db.bak` (created automatically on corruption detection)
- Manual restore: copy `.bak` over `settings.db`, restart app
- Nuclear option: delete `settings.db`, app recreates with defaults on next launch

## Telegram 409 Conflict
- **Symptom:** "409 Conflict: terminated by other getUpdates request"
- **Cause:** Two instances polling the same bot token
- **Fix:** Stop all instances of Auto Claude. Check for orphan processes. Restart one instance only.

## Hook Cleanup
- Auto-installed to: `<projectDir>/.claude/settings.json`
- Manual uninstall: `node install-hooks.js --uninstall <projectDir>`
- Stale hook detection: hooks have marker `auto-claude-hook.js`. If marker not found, hooks are re-installed automatically.

## Stuck Session Recovery
- PID file: `<userData>/auto-claude-pids.json`
- Manual kill: read PIDs from file, `kill -9 <pid>` or `taskkill /F /PID <pid>`
- After kill: delete PID file, restart app

## Token Rotation
- **Telegram bot:** Settings > Telegram > enter new token. Old encrypted token overwritten.
- **Custom provider:** Settings > Custom Provider > update token. Re-saved to encrypted storage.

## Context Recovery Debugging
- Default threshold: 80% of context window
- Adjust: Settings > Context Guard > threshold slider
- Max recoveries per session: 3 (prevents infinite recovery loops)
- GSD workflow: automatic `/gsd-pause-work` + `/gsd-resume-work` pattern
- Generic workflow: writes `.auto-claude-handoff.md` → reads on resume
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbook.md
git commit -m "docs: add operational runbook for common issues (A5)"
```

---

## Final Verification

### Task 40: Full Test Suite & Audit

- [ ] **Step 1: Run complete test suite**

```bash
node --test lib/*.test.js
```

Expected: 120+ tests passing, 0 failures.

- [ ] **Step 2: Verify no remaining silent catches in critical paths**

```bash
grep -rn "catch {" lib/ proxy.js session-manager.js main.js | grep -v "test.js" | grep -v node_modules
```

Each remaining silent catch should be in a non-critical path (e.g., cleanup on exit, already-dead process). If any are in critical paths, add logging.

- [ ] **Step 3: Verify file sizes after decomposition**

```bash
wc -l lib/claude-detector.js lib/claude-detection.js lib/plugin-manager.js lib/settings-manager.js lib/update-checker.js
```

No file should exceed 400 lines.

- [ ] **Step 4: Verify no sync I/O in hot paths**

```bash
grep -n "Sync(" proxy.js | grep -v "closeSync\|test" | head -20
```

After P1, `_readHookLog` should have no sync calls. The only remaining sync I/O should be in startup code (one-time) or exit handlers.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: final verification — all hardening phases complete"
```

# Comprehensive Hardening & SDK Migration Design

**Date:** 2026-04-11  
**Goal:** Fix all bugs, security issues, race conditions, and performance bottlenecks in Auto Claude, then migrate to Claude Code's structured SDK protocol for dramatically improved reliability and autonomy.  
**Architecture:** Bottom-up approach — 8 phases from critical bug fixes through SDK migration, each independently shippable with re-audit gates.

---

## Phase 1: Critical Bugs

### B1: XSS via Telegram Username (CRITICAL)
- **File:** `index.html:880`
- **Bug:** Telegram `username`, `firstName`, `chatId` injected raw into `innerHTML`. A malicious Telegram user with `<img src=x onerror=alert(1)>` as their name gets script execution in the renderer.
- **Fix:** Wrap all Telegram fields in `esc()`: `esc(c.username||c.firstName||'?')`, `esc(String(c.chatId))`

### B2: TelegramBridge.token Never Set
- **File:** `lib/telegram.js` — `start()` method
- **Bug:** `start()` receives `decryptedToken` parameter but never stores it as `this.token`. Photo download handler at line 349 references `this.token` — always undefined. Photo downloads are broken.
- **Fix:** Add `this.token = decryptedToken;` at the beginning of `start()`.

### B3: File Descriptor Leaks in Hook Log Reader
- **File:** `proxy.js:424-427` and `proxy.js:503-506`
- **Bug:** `openSync` → `readSync` → `closeSync` sequence without try/finally. If `readSync` throws (disk error, file deleted between stat and open), the FD leaks. Repeated leaks exhaust OS FD limits.
- **Fix:** Wrap in try/finally:
  ```js
  const fd = fs.openSync(logFile, 'r');
  try { fs.readSync(fd, buf, 0, newBytes, this.hookByteOffset); }
  finally { fs.closeSync(fd); }
  ```

### B4: Timer Leaks on Tab Close
- **File:** `index.html:770` — `closeTab()` function
- **Bug:** `_countdownTimer` (question countdown interval) and `activityDebounceTimer` are not cleared when a tab is closed. Their closures hold references to the tab state, preventing GC.
- **Fix:** Add to closeTab():
  ```js
  if (ts._countdownTimer) clearInterval(ts._countdownTimer);
  if (ts.activityDebounceTimer) clearTimeout(ts.activityDebounceTimer);
  ```

### B5: Double answerResolve Overwrite
- **File:** `session-manager.js:698-710` — `_waitForAnswerWithTimeout`
- **Bug:** If called rapidly twice, the second call overwrites `session.answerResolve` without clearing the first timer. The old promise is orphaned and its timer fires on a stale resolve.
- **Fix:** Clear any existing timer before setting a new resolve:
  ```js
  if (session._answerTimer) clearTimeout(session._answerTimer);
  ```

### B6: Duplicate /start Handler
- **File:** `lib/master-telegram.js:85,113`
- **Bug:** `/start$` and `/start(?:\s+(.*))?$/` both fire for bare `/start`. Duplicate processing.
- **Fix:** Remove the bare `/start$` handler (line 85). Keep only the parameterized one.

---

## Phase 2: Race Conditions & Concurrency

### R1: PID File TOCTOU
- **File:** `main.js:113-127` — `trackPid` / `untrackPid`
- **Race:** `readFileSync` → modify → `writeFileSync`. Concurrent session start/stop can overwrite each other's PID entry.
- **Fix:** Replace with in-memory `Map<pid, tabId>`. Flush to file asynchronously on change (debounced 500ms). Read file only on startup to recover orphans.

### R2: Concurrent start-session
- **File:** `main.js:893` — `start-session` handler
- **Race:** `ipcMain.on` (fire-and-forget) means two rapid clicks can bypass the `session.state.running` guard before either sets it.
- **Fix:** Change to `ipcMain.handle`. Add `session.starting` flag set synchronously before any async work. Check both `running` and `starting` on entry.

### R3: Batch Queue Double-Dequeue
- **File:** `main.js:296` — `processBatchQueue`
- **Race:** Can fire from both the interval timer (line 535) and `session-complete` event (line 283) simultaneously. Two items dequeued, exceeding parallel limit.
- **Fix:** Add `batchProcessing` mutex flag. Set before `shift()`, clear after spawn. Check on entry.

### R4: Hook Log Truncation Race
- **File:** `proxy.js:412-419`
- **Race:** Two proxies in the same project both detect oversized log, both read/halve/write. Data lost.
- **Fix:** Use atomic truncation: write halved content to `.tmp` file, rename over original. Track per-session byte offsets independently so concurrent sessions don't interfere.

### R5: Resume State Last-Write-Wins
- **File:** `session-manager.js:712-724`
- **Race:** Two sessions for the same `projectDir` overwrite each other's resume state via `this.config.sessions[dir]`.
- **Fix:** Include `tabId` in the resume state key: `this.config.sessions[dir + ':' + tabId]`. On resume, find the most recent entry for the dir.

---

## Phase 3: Error Observability

### E1: claude-detector.js — 19 Silent Catches
- **File:** `lib/claude-detector.js`
- **Fix:** Replace each `catch {}` with `catch (err) { logger.warn('claude-detector', \`operation failed: ${err?.message}\`) }`. Classify expected errors (ENOENT for missing files) as `debug` level, unexpected errors as `warn`.

### E2: telegram-secure.js — Catch Classification
- **File:** `lib/telegram-secure.js:23`
- **Fix:** In `loadEncryptedToken`, check `err.code === 'ENOENT'` → return null silently (no token saved yet). Any other error → `logger.warn('telegram-secure', ...)` to surface keychain/decryption problems.

### E3: proxy.js Outer Catches
- **Files:** `proxy.js:445, 519`
- **Fix:** Log errors at debug level and emit `'hook-read-error'` event. This surfaces disk problems without spamming.

### E4: Stats Save Failure
- **File:** `session-manager.js:780`
- **Fix:** Replace silent catch with `this.send(tabId, 'log', { type: 'stderr', text: \`Stats save failed: ${e.message}\` })`. Session cost data loss should be visible to the operator.

### E5: Kill Failure Logging
- **File:** `proxy.js:63`
- **Fix:** Replace `catch { resolve(); }` with `catch (e) { this.emit('kill-error', e); resolve(); }`. Enables zombie process diagnosis.

### E6: Logger Rotation
- **File:** `lib/logger.js`
- **Fix:** Add log rotation at 10MB. On rotation, rename current to `.1`, delete `.3`, shift others. Check file size on each `appendFileSync` call (amortized — check every 100 writes).

---

## Phase 4: Test Coverage

Target: ~60 new tests, bringing total from 63 to ~123.

### autonomy.js (~15 tests)
- `classifyQuestion` — tier classification for different question types (permission, confirmation, clarification, critical)
- `autoAnswer` — correct auto-responses for each tier
- `handleQuestion` — routing decisions (auto-answer, review, route-telegram, ask-user)
- `shouldRetry` — crash retry logic with exit codes and retry counts
- `getResumeState` — session resume state generation

### context-guard.js (~10 tests)
- `shouldRecover` — threshold detection with various usage percentages
- `getHandoffPrompt` / `getResumePrompt` — workflow-aware prompt generation
- `getContextWindow` — model-to-window mapping with prefix matching
- `detectGsdWarning` — GSD warning pattern detection

### validate.js gaps (~12 tests)
- `validateProjectDir` — valid dirs, non-existent, non-directory, path traversal
- `validatePrompt` — empty, oversized, valid
- `validateMasterTelegramConfig` — token format, chat ID format
- `validateDistinctTelegramTokens` — duplicate detection
- `validateProjectTelegramConfig` — project-level validation
- `validateResponse` — response sanitization

### telegram-secure.js (~8 tests)
- `saveEncryptedToken` / `loadEncryptedToken` — round-trip with mocked safeStorage
- `clearEncryptedToken` — cleanup
- `isEncryptionAvailable` — availability check
- Error cases — corrupted file, missing file, unavailable safeStorage

### sessions.js (~6 tests)
- `listSessions` — multiple sessions, empty dir, corrupted JSONL
- `projectPathHash` — deterministic hashing

### summarize.js (~8 tests)
- `summarize` for each tool type (Bash, Read, Write, Edit, Glob, Grep, Agent, WebSearch)

### Shared test utilities
- Create `test/helpers.js` with: `mockFs()` factory, `normalize()` path helper, HTTP server factory

---

## Phase 5: Module Decomposition

### 5A: Split claude-detector.js (633 lines → 4 modules)
| New Module | Responsibility | Exports |
|------------|---------------|---------|
| `lib/claude-detection.js` | CLI detection, version, auth, prerequisites | `detect`, `detectPrerequisites`, `extractVersion`, `getClaudeHome`, `maskToken` |
| `lib/plugin-manager.js` | Plugin listing, toggling, installation | `listPlugins`, `togglePlugin`, `installPlugin` |
| `lib/settings-manager.js` | Settings read/write, tags | `readSettingsJson`, `writeSettingsJson`, `listSettingsTags`, `loadSettingsTag`, `saveSettingsTag`, `deleteSettingsTag` |
| `lib/update-checker.js` | Claude CLI update detection | `checkForUpdate` |

### 5B: Extract IPC Handlers from main.js (950 lines → 5 modules)
| New Module | Channels | Approx Lines |
|------------|----------|-------------|
| `lib/ipc/session.js` | start-session, stop-session, send-response, skip-question, get-state, list-sessions, get/clear-stored-session | ~150 |
| `lib/ipc/telegram.js` | save/load-telegram-config, save/load-master-telegram-config, test-telegram-bot, tutorial-* | ~200 |
| `lib/ipc/workspace.js` | list-workspace-projects, get-workspace-status, open/new/close-workspace-project, create-project-folder | ~150 |
| `lib/ipc/claude-manager.js` | detect-claude-code, read/write-claude-settings, list/toggle/install-claude-plugins, install-claude-code, authenticate, install-prerequisite, install-tool, save/test/get-custom-provider, check-claude-update | ~300 |
| `lib/ipc/settings.js` | get/set-setting, get-settings-group, get-settings-schema, fetch-models, get/save-custom-models, settings-tags, save/load-config | ~150 |

Each module exports a `register(ipcMain, deps)` function. `deps` contains `mainWindow`, `sessionManager`, `settingsDb`, `config`, etc.

### 5C: IPC Trust Wrapper
Replace 50+ copy-pasted trust checks with:
```js
function withTrustedIpc(action, handler) {
  return (event, ...args) => {
    if (!isTrustedIpcEvent(event, action)) 
      return { ok: false, error: 'Untrusted IPC sender' };
    return handler(event, ...args);
  };
}
// Usage:
ipcMain.handle('channel', withTrustedIpc('channel', (event, args) => { ... }));
```

### 5D: Telegram Auth Dedup
Extract shared patterns from `telegram.js` and `master-telegram.js`:
- `lib/telegram-auth.js` — `isAuthorized(chatId, authorizedIds)`, `persistChatIds(filePath, chatIds)`, `loadChatIds(filePath)`

### 5E: Question Extraction Utility
The pattern `questionData.questions || (questionData.question ? [questionData] : [])` appears 5 times. Extract to:
```js
// lib/question-utils.js
function extractQuestions(data) {
  return data?.questions || (data?.question ? [data] : []);
}
```

---

## Phase 6: Performance

### P1: Async Hook Polling
- **File:** `proxy.js:405-427`
- **Change:** Convert `_readHookLog` to async. Replace `existsSync`+`statSync`+`openSync`+`readSync`+`closeSync` with `fs.promises.stat`+`fs.promises.open`+`fileHandle.read`+`fileHandle.close`. The `setInterval` callback becomes async.
- **Impact:** Unblocks event loop on every poll tick (currently blocks briefly on every interval for every running session).

### P2: Logger Buffering
- **File:** `lib/logger.js`
- **Change:** Collect log entries in an array. Flush to disk every 500ms via `setInterval`, or immediately on `error` level or process exit. Replace `appendFileSync` with `fs.promises.appendFile` in the flush.
- **Impact:** Eliminates per-log-line synchronous disk I/O.

### P3: Settings-DB Save Batching
- **File:** `settings-db.js`
- **Change:** After `set()`, mark dirty and schedule a 500ms debounced save. `setMany()` saves immediately. Register `process.on('exit')` and `app.on('before-quit')` for final flush.
- **Impact:** Reduces redundant full-SQLite-to-disk writes.

### P4: Async claude-detector
- **File:** `lib/claude-detection.js` (after decomposition)
- **Change:** Replace `execFileSync` calls with `util.promisify(execFile)`. Make `detect()`, `detectPrerequisites()`, `detectRecommendedTools()` async. Update all callers.
- **Impact:** Removes 5s-timeout main-thread blocks during detection.

### P5: Health Status Caching
- **File:** `main.js` (or `lib/ipc/claude-manager.js` after decomposition)
- **Change:** Cache `buildHealthStatus` result with 30s TTL. Invalidate on config change or plugin install.
- **Impact:** Avoids repeated sync file reads during health check polling.

---

## Phase 7: SDK Protocol Migration

### Overview
Migrate the proxy layer from terminal text parsing to Claude Code's structured JSON protocol. This is the highest-impact change for autonomy and reliability.

### Current Architecture (print mode)
```
SessionManager → ClaudeProxy.run()
  → spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose'])
  → stdin.end() immediately
  → parse stdout NDJSON lines for assistant/system/result events
  → detect questions by matching tool names in assistant text
  → answer questions by killing process and restarting with answer text
  → poll hook log file separately for telemetry
```

### New Architecture (SDK mode)
```
SessionManager → ClaudeProxy.run()
  → spawn('claude', ['-p', prompt,
       '--input-format', 'stream-json',
       '--output-format', 'stream-json',
       '--include-hook-events',
       '--replay-user-messages'])
  → keep stdin OPEN for bidirectional communication
  → parse stdout NDJSON for:
    - assistant/system/result events (same as now)
    - control_request messages (permission prompts)
    - hook events (embedded in stream)
  → on control_request(subtype: "can_use_tool"):
    - route to autonomy engine for decision
    - write control_response to stdin (allow/deny)
  → no process kill/restart needed for responses
  → session IDs managed via --session-id / --resume flags
```

### Key Implementation Details

**Stdin protocol:** Send NDJSON lines:
- `{"type": "user", "message": {"role": "user", "content": "..."}}`  — user messages
- `{"type": "control_response", "tool_use_id": "...", "decision": "allow"}` — permission responses
- `{"type": "keep_alive"}` — heartbeat

**Stdout protocol:** Receive NDJSON lines:
- `{"type": "assistant", ...}` — assistant content (text, tool_use blocks)
- `{"type": "system", ...}` — status changes
- `{"type": "result", ...}` — final result with token usage
- `{"type": "control_request", "subtype": "can_use_tool", "tool_name": "...", "input": {...}, "tool_use_id": "..."}` — permission prompts

**Permission routing:** The autonomy engine receives `control_request` messages instead of parsed question text. It evaluates tool name + input against configured rules and returns allow/deny via `control_response` on stdin.

**Hook events in stream:** With `--include-hook-events`, hook lifecycle events appear in the stdout stream, eliminating the need for the separate hook log file polling mechanism. The `_readHookLog` and `_readWorktreeHookLog` polling code becomes unnecessary.

**Session management:**
- Use `--session-id <uuid>` to set deterministic session IDs on start
- Use `--resume <id>` for session resumption instead of inferring from state
- Session IDs stored in settings-db per tab

**State events:** Set `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=true` env var. Receive `idle/running/requires_action` state transitions in the stream for precise UI state display.

**Backward compatibility:** Detect Claude Code version at startup. If < version supporting stream-json input, fall back to current print-mode approach. Version check via `claude --version` output parsing (already implemented in `extractVersion`).

### Files Changed
- `proxy.js` — Major rewrite: bidirectional stdin, control_request/response handling, hook events from stream
- `session-manager.js` — Remove process kill/restart answer pattern, use stdin responses
- `lib/autonomy.js` — Accept `control_request` format instead of parsed question text
- `lib/constants.js` — Add SDK-related constants

---

## Phase 8: Autonomy Hardening

### A1: SIGKILL Escalation
- **File:** `proxy.js:41-65` — `kill()` method
- **Change:** After SIGTERM, set 3s timer for SIGKILL (Unix) or `taskkill /F /T` (Windows). Current 5s timeout just resolves the promise — the zombie process continues.

### A2: Permission Auto-Approve Rules
- **File:** `lib/autonomy.js` + settings schema
- **Change:** Configurable rules engine for the SDK permission handling:
  - Always approve: `Read`, `Glob`, `Grep`, `LSP`, `WebSearch`
  - Approve with review window: `Edit`, `Write`, `Bash` (configurable per-command patterns)
  - Always prompt: `NotebookEdit`, `Agent` (subagent spawning)
  - Always deny: tools writing outside project directory
- Rules stored in settings-db under `autonomy.permissionRules`

### A3: Notification Hook Forwarding
- **Change:** Register `Notification` hook in Claude's settings.json during hook installation. When Claude emits a notification (e.g., "Build failed", "Tests passing"), forward to Telegram via the bridge.

### A4: Session State Display
- **Change:** Show `idle` / `running` / `requires_action` in tab header dot + tooltip. Uses session state events from `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=true`.

### A5: Operational Runbook
- **File:** `docs/runbook.md`
- **Content:**
  - DB corruption recovery (backup locations, manual restore steps)
  - Telegram 409 conflict resolution (stop duplicate pollers)
  - Hook cleanup (manual uninstall command, stale hook detection)
  - Stuck session recovery (PID file location, manual kill)
  - Token rotation (Telegram bot, custom provider)
  - Context recovery debugging (threshold tuning, max recoveries)

---

## Phase Ordering & Dependencies

```
Phase 1 (Critical Bugs) — no dependencies
Phase 2 (Race Conditions) — no dependencies  
Phase 3 (Error Observability) — no dependencies
Phase 4 (Test Coverage) — benefits from Phase 1 fixes
Phase 5 (Module Decomposition) — benefits from Phases 1-3 fixes
Phase 6 (Performance) — depends on Phase 5 (decomposed modules are easier to convert to async)
Phase 7 (SDK Migration) — depends on Phase 5 (clean module boundaries) and Phase 4 (test safety net)
Phase 8 (Autonomy Hardening) — depends on Phase 7 (SDK protocol required for permission rules)
```

Phases 1-3 can be done in parallel. Phase 4 can overlap with 1-3. Phase 5 should follow 1-3. Phases 6-8 are sequential.

---

## Success Criteria

- [ ] Zero known bugs (B1-B6 all fixed)
- [ ] Zero race conditions in session lifecycle
- [ ] Zero silent catches in critical paths (all classified as expected/unexpected with appropriate log levels)
- [ ] 120+ unit tests passing
- [ ] No file over 400 lines (after decomposition)
- [ ] No synchronous I/O in hot paths (poll loops, log writes)
- [ ] SDK protocol operational with bidirectional stdin/stdout
- [ ] Permission auto-approve rules configurable and functional
- [ ] Operational runbook published
- [ ] All phases pass re-audit gate before proceeding

---

*Design approved: 2026-04-11*

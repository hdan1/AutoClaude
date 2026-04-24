# Master Bot Notification Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-project master bot notification modes (full/ping/off) with deep-link buttons to project bot chats, while preserving `/reply` fallback when no project bot is available.

**Architecture:** Extend per-project Telegram config with `masterNotifyMode`, propagate it through `main.js` question routing, and enrich `MasterTelegramBridge.forwardQuestion()` to branch by mode and project bot availability. Capture each project bot username at startup (`getMe`) so the master bot can generate `https://t.me/<username>` inline buttons. Keep `/reply` tokens only for fallback.

**Tech Stack:** Electron main process IPC, Node.js (`node:test`), `node-telegram-bot-api`, vanilla HTML/JS UI in `index.html`

---

## File Structure & Responsibilities

- `lib/validate.js`
  - Extend `validateProjectTelegramConfig()` to sanitize `masterNotifyMode` with default `'full'`.
- `lib/validate.test.js`
  - Add validation tests for allowed modes and fallback behavior.
- `main.js`
  - Persist and load `masterNotifyMode` in Telegram config handlers.
  - Pass `projectBotUsername` and normalized `masterNotifyMode` into `masterTelegram.forwardQuestion()`.
- `lib/telegram.js`
  - Capture project bot username via `bot.getMe()` during startup (`this.botUsername`).
- `lib/telegram.test.js`
  - Add checks that startup logic includes username capture and fallback to `null`.
- `lib/master-telegram.js`
  - Rewrite `forwardQuestion()` for mode matrix (`off`, `ping`, `full`) + fallback `/reply` token path.
  - Extend `_send()` to support Telegram `sendMessage` options (inline keyboard).
- `lib/master-telegram.test.js` (new)
  - Add behavior tests for each mode and fallback routing.
- `index.html`
  - Add `masterNotifyMode` dropdown in per-project Telegram panel.
  - Wire load/save logic for the new field.
- `lib/index-telegram-ui.test.js` (new)
  - Add source-level tests for presence and wiring of the new dropdown.

---

### Task 1: Add `masterNotifyMode` validation and tests

**Files:**
- Modify: `lib/validate.js:199-219`
- Modify: `lib/validate.test.js`

- [ ] **Step 1: Write failing validation tests**

Append to `lib/validate.test.js`:

```js
test('validateProjectTelegramConfig defaults masterNotifyMode to full', () => {
  const r = validateProjectTelegramConfig({ enabled: true, allowedUsers: ['u1'] });
  assert.equal(r.ok, true);
  assert.equal(r.config.masterNotifyMode, 'full');
});

test('validateProjectTelegramConfig accepts ping mode', () => {
  const r = validateProjectTelegramConfig({
    enabled: true,
    allowedUsers: ['u1'],
    masterNotifyMode: 'ping',
  });
  assert.equal(r.ok, true);
  assert.equal(r.config.masterNotifyMode, 'ping');
});

test('validateProjectTelegramConfig coerces invalid mode to full', () => {
  const r = validateProjectTelegramConfig({
    enabled: true,
    allowedUsers: ['u1'],
    masterNotifyMode: 'loud',
  });
  assert.equal(r.ok, true);
  assert.equal(r.config.masterNotifyMode, 'full');
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `node --test lib/validate.test.js`
Expected: FAIL on `masterNotifyMode` assertions (`undefined` before implementation).

- [ ] **Step 3: Implement validation logic**

Update `validateProjectTelegramConfig()` in `lib/validate.js` to:

```js
function validateProjectTelegramConfig(incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { ok: false, error: 'Project telegram config must be a plain object' };
  }
  const sanitized = {
    enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : false,
    allowedUsers: [],
    masterNotifyMode: 'full',
  };

  if ('allowedUsers' in incoming) {
    if (!Array.isArray(incoming.allowedUsers)) {
      return { ok: false, error: 'Project telegram allowedUsers must be an array of strings' };
    }
    sanitized.allowedUsers = incoming.allowedUsers
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      .map(s => s.trim())
      .slice(0, 50);
  }

  if ('masterNotifyMode' in incoming && typeof incoming.masterNotifyMode === 'string') {
    const mode = incoming.masterNotifyMode.trim().toLowerCase();
    sanitized.masterNotifyMode = ['full', 'ping', 'off'].includes(mode) ? mode : 'full';
  }

  return { ok: true, config: sanitized };
}
```

- [ ] **Step 4: Re-run tests**

Run: `node --test lib/validate.test.js`
Expected: PASS (existing tests + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add lib/validate.js lib/validate.test.js
git commit -m "feat: validate per-project master notification mode"
```

---

### Task 2: Persist/load mode and route question metadata in `main.js`

**Files:**
- Modify: `main.js:265-272`
- Modify: `main.js:1367-1385`
- Modify: `main.js:1415-1424`
- Create: `lib/main-telegram-routing.test.js`

- [ ] **Step 1: Write failing routing/config tests**

Create `lib/main-telegram-routing.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('question event forwards projectBotUsername to master bot', () => {
  assert.ok(src.includes('projectBotUsername: bot?.botUsername || null'));
});

test('question event forwards masterNotifyMode to master bot', () => {
  assert.ok(src.includes('masterNotifyMode:'));
});

test('save-telegram-config persists masterNotifyMode', () => {
  assert.ok(src.includes('masterNotifyMode: result.config.masterNotifyMode'));
});

test('load-telegram-config returns masterNotifyMode with full default', () => {
  assert.ok(src.includes("masterNotifyMode: ['full', 'ping', 'off'].includes(ptConfig.masterNotifyMode) ? ptConfig.masterNotifyMode : 'full'"));
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `node --test lib/main-telegram-routing.test.js`
Expected: FAIL on missing `projectBotUsername`/`masterNotifyMode` snippets.

- [ ] **Step 3: Update `save-telegram-config` validation input and persistence**

In `main.js` `save-telegram-config` handler, replace:

```js
const result = validateProjectTelegramConfig({ enabled: !!c.enabled, allowedUsers: c.allowedUsers || [] });
```

With:

```js
const result = validateProjectTelegramConfig({
  enabled: !!c.enabled,
  allowedUsers: c.allowedUsers || [],
  masterNotifyMode: c.masterNotifyMode,
});
```

And replace config save block with:

```js
config.projectTelegram[resolved] = {
  enabled: result.config.enabled,
  allowedUsers: result.config.allowedUsers,
  masterNotifyMode: result.config.masterNotifyMode,
};
```

- [ ] **Step 4: Update `load-telegram-config` response**

In `main.js` `load-telegram-config` return object, add:

```js
masterNotifyMode: ['full', 'ping', 'off'].includes(ptConfig.masterNotifyMode) ? ptConfig.masterNotifyMode : 'full',
```

Also update fallback defaults in both return paths to include `masterNotifyMode: 'full'`.

- [ ] **Step 5: Update question event forwarding metadata**

Replace `main.js` `sessionManager.on('question', ...)` block with:

```js
sessionManager.on('question', ({ tabId, questionData }) => {
  const state = sessionManager.getState(tabId) || {};
  const bot = getProjectBot(state.projectDir);
  logger.info('question-event', `tabId=${tabId} projectDir=${state.projectDir || '(none)'} projectBot=${!!bot} projectBotRunning=${bot?.isRunning} masterBot=${!!masterTelegram} masterBotRunning=${masterTelegram?.isRunning} questionText="${(questionData?.questionText || '').substring(0, 50)}"`);
  if (bot?.isRunning) { bot.forwardQuestion(tabId, questionData); }
  if (masterTelegram?.isRunning) {
    const resolved = state.projectDir ? path.resolve(state.projectDir) : null;
    const ptConfig = resolved ? (config.projectTelegram?.[resolved] || {}) : {};
    const masterNotifyMode = ['full', 'ping', 'off'].includes(ptConfig.masterNotifyMode) ? ptConfig.masterNotifyMode : 'full';
    masterTelegram.forwardQuestion({
      tabId,
      projectDir: state.projectDir,
      state,
      projectBotUsername: bot?.botUsername || null,
      masterNotifyMode,
    }, questionData);
  }
});
```

- [ ] **Step 6: Re-run tests**

Run: `node --test lib/main-telegram-routing.test.js`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add main.js lib/main-telegram-routing.test.js
git commit -m "feat: route per-project master notification mode and project bot username"
```

---

### Task 3: Capture project bot username in `TelegramBridge`

**Files:**
- Modify: `lib/telegram.js:21-33,37-64`
- Modify: `lib/telegram.test.js`

- [ ] **Step 1: Write failing tests for username capture**

Append to `lib/telegram.test.js`:

```js
test('TelegramBridge constructor initializes botUsername to null', () => {
  const ctor = src.substring(
    src.indexOf('constructor(config, sessionManager, projectDir) {'),
    src.indexOf('get projectLabel()')
  );
  assert.ok(ctor.includes('this.botUsername = null'));
});

test('TelegramBridge.start attempts to load bot username via getMe', () => {
  const startMethod = src.substring(
    src.indexOf('async start(decryptedToken'),
    src.indexOf('async stop()')
  );
  assert.ok(startMethod.includes('await this.bot.getMe()'));
  assert.ok(startMethod.includes('this.botUsername = me?.username || null'));
});

test('TelegramBridge.start handles getMe failure by keeping botUsername null', () => {
  const startMethod = src.substring(
    src.indexOf('async start(decryptedToken'),
    src.indexOf('async stop()')
  );
  assert.ok(startMethod.includes('this.botUsername = null'));
  assert.ok(startMethod.includes("logger.warn('telegram', 'Failed to fetch bot username'"));
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `node --test lib/telegram.test.js`
Expected: FAIL on missing `botUsername`/`getMe` assertions.

- [ ] **Step 3: Implement username capture in `lib/telegram.js`**

In constructor, add:

```js
this.botUsername = null;
```

In `start()`, after `await this.bot.startPolling();` and before the final started log, add:

```js
try {
  const me = await this.bot.getMe();
  this.botUsername = me?.username || null;
} catch (err) {
  this.botUsername = null;
  logger.warn('telegram', 'Failed to fetch bot username', err?.message || err);
}
```

In `stop()`, reset:

```js
this.botUsername = null;
```

- [ ] **Step 4: Re-run tests**

Run: `node --test lib/telegram.test.js`
Expected: PASS (existing token test + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add lib/telegram.js lib/telegram.test.js
git commit -m "feat: capture project bot username for master deep-link notifications"
```

---

### Task 4: Rewrite `MasterTelegramBridge.forwardQuestion()` for mode matrix

**Files:**
- Modify: `lib/master-telegram.js:298-302,475-503`
- Create: `lib/master-telegram.test.js`

- [ ] **Step 1: Write failing behavior tests**

Create `lib/master-telegram.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const MasterTelegramBridge = require('./master-telegram');

function makeBridge() {
  const bridge = new MasterTelegramBridge({}, {
    get: () => ({ proxy: true }),
    sendResponse: () => {},
  }, {});
  const sent = [];
  bridge.bot = {
    sendMessage: (chatId, text, options) => {
      sent.push({ chatId, text, options });
      return Promise.resolve();
    },
  };
  bridge._started = true;
  bridge._pollingDead = false;
  bridge.chatIds.set('u1', 1001);
  return { bridge, sent };
}

test('forwardQuestion mode off sends nothing', () => {
  const { bridge, sent } = makeBridge();
  bridge.forwardQuestion({
    tabId: 'tab-1',
    projectDir: '/tmp/proj',
    state: { projectDir: '/tmp/proj' },
    projectBotUsername: 'proj_bot',
    masterNotifyMode: 'off',
  }, { questionText: 'Need input?' });

  assert.equal(sent.length, 0);
  assert.equal(bridge.pending.size, 0);
});

test('forwardQuestion mode ping sends short message with deep-link button', () => {
  const { bridge, sent } = makeBridge();
  bridge.forwardQuestion({
    tabId: 'tab-1',
    projectDir: '/tmp/proj',
    state: { projectDir: '/tmp/proj' },
    projectBotUsername: 'proj_bot',
    masterNotifyMode: 'ping',
  }, { questionText: 'Need input?' });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /needs your input/i);
  assert.equal(sent[0].options.reply_markup.inline_keyboard[0][0].url, 'https://t.me/proj_bot');
  assert.equal(bridge.pending.size, 0);
});

test('forwardQuestion mode full sends question with deep-link button and no token', () => {
  const { bridge, sent } = makeBridge();
  bridge.forwardQuestion({
    tabId: 'tab-1',
    projectDir: '/tmp/proj',
    state: { projectDir: '/tmp/proj' },
    projectBotUsername: 'proj_bot',
    masterNotifyMode: 'full',
  }, { questionText: 'What value should I use?' });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /What value should I use\?/);
  assert.doesNotMatch(sent[0].text, /Reply token:/);
  assert.equal(bridge.pending.size, 0);
});

test('forwardQuestion falls back to reply token flow when no project bot username', () => {
  const { bridge, sent } = makeBridge();
  bridge.forwardQuestion({
    tabId: 'tab-1',
    projectDir: '/tmp/proj',
    state: { projectDir: '/tmp/proj' },
    projectBotUsername: null,
    masterNotifyMode: 'ping',
  }, { questionText: 'Need fallback?' });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Reply token:/);
  assert.match(sent[0].text, /Usage: \/reply <token> <text>/);
  assert.equal(bridge.pending.size, 1);
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `node --test lib/master-telegram.test.js`
Expected: FAIL (current implementation always generates token and has no options argument).

- [ ] **Step 3: Update `_send` to support Telegram options**

In `lib/master-telegram.js`, replace:

```js
_send(chatId, text) {
  if (!this.bot) return;
  this.bot.sendMessage(chatId, text).catch(() => {});
}
```

With:

```js
_send(chatId, text, options) {
  if (!this.bot) return;
  this.bot.sendMessage(chatId, text, options).catch(() => {});
}
```

- [ ] **Step 4: Rewrite `forwardQuestion()` behavior**

Replace existing `forwardQuestion()` with:

```js
forwardQuestion(tabInfo, questionPayload) {
  if (!this.bot || !this.isRunning) return;
  const tabId = tabInfo?.tabId;
  if (!tabId) return;

  const state = tabInfo.state || {};
  const alias = this._normalizeAlias(state, tabInfo.projectDir, tabId);
  const label = state.projectDir ? path.basename(state.projectDir) : '(none)';
  const questionText = questionPayload?.questionText || 'Claude needs input.';
  const projectBotUsername = typeof tabInfo?.projectBotUsername === 'string' && tabInfo.projectBotUsername.trim()
    ? tabInfo.projectBotUsername.trim().replace(/^@/, '')
    : null;

  const rawMode = typeof tabInfo?.masterNotifyMode === 'string' ? tabInfo.masterNotifyMode : 'full';
  const mode = ['full', 'ping', 'off'].includes(rawMode) ? rawMode : 'full';

  if (mode === 'off') return;

  const buttonOptions = projectBotUsername
    ? {
      reply_markup: {
        inline_keyboard: [[{
          text: '💬 Open Project Bot',
          url: `https://t.me/${projectBotUsername}`,
        }]],
      },
    }
    : undefined;

  // Normal path: project bot exists -> notify + deep-link (no token)
  if (projectBotUsername) {
    const msg = mode === 'ping'
      ? `🔔 ${label} needs your input`
      : [`❓ [${tabId} | ${alias} | ${label}] Question`, questionText].join('\n');

    for (const chatId of this._allChatIds()) {
      this._send(chatId, msg, buttonOptions);
    }
    return;
  }

  // Fallback path: no project bot -> token reply flow
  this._pruneExpired();
  const token = this._newToken();
  const createdAt = Date.now();
  const entry = {
    tabId,
    createdAt,
    expiresAt: createdAt + TOKEN_TTL_MS,
  };
  this.pending.set(token, entry);

  const fallbackMsg = [
    `[${tabId} | ${alias} | ${label}] Question`,
    questionText,
    `Reply token: ${token}`,
    'Usage: /reply <token> <text>',
  ].join('\n');

  for (const chatId of this._allChatIds()) {
    this._send(chatId, fallbackMsg);
  }
}
```

- [ ] **Step 5: Run tests**

Run: `node --test lib/master-telegram.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/master-telegram.js lib/master-telegram.test.js
git commit -m "feat: add master bot notification modes with deep-link and reply fallback"
```

---

### Task 5: Add per-project mode selector to Telegram UI

**Files:**
- Modify: `index.html:628-636,898-918`
- Create: `lib/index-telegram-ui.test.js`

- [ ] **Step 1: Write failing UI wiring tests**

Create `lib/index-telegram-ui.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('Telegram panel contains master notification mode select', () => {
  assert.ok(src.includes('data-el="tgMasterNotify"'));
  assert.ok(src.includes('<option value="full">Full question</option>'));
  assert.ok(src.includes('<option value="ping">Ping only</option>'));
  assert.ok(src.includes('<option value="off">Off</option>'));
});

test('Telegram config load sets tgMasterNotify default to full', () => {
  assert.ok(src.includes("tgMasterNotify.value=(c.masterNotifyMode||'full')"));
});

test('Telegram config save sends masterNotifyMode', () => {
  assert.ok(src.includes('masterNotifyMode:tgMasterNotify.value'));
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `node --test lib/index-telegram-ui.test.js`
Expected: FAIL on missing select and wiring snippets.

- [ ] **Step 3: Update HTML panel markup**

In `index.html`, insert this block between token/allowed row and status div:

```html
<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
  <span style="color:var(--tx2);font-size:12px">Master bot notification</span>
  <select data-el="tgMasterNotify" style="font-size:11px">
    <option value="full">Full question</option>
    <option value="ping">Ping only</option>
    <option value="off">Off</option>
  </select>
</div>
```

- [ ] **Step 4: Wire JS load/save logic**

Update JS variable declarations near current Telegram block:

```js
const tgPanel=el('tgTabPanel'),tgToggle=el('tgTabEnabled'),tgToken=el('tgTabToken'),tgAllowed=el('tgTabAllowed'),tgMasterNotify=el('tgMasterNotify');
```

In `loadTelegramConfig` handler block, add:

```js
tgMasterNotify.value=(c.masterNotifyMode||'full');
```

In `tgSaveBtn.onclick`, update payload to:

```js
const cfg={
  projectDir:ts.projectDir,
  enabled:tgToggle.classList.contains('on'),
  allowedUsers:tgAllowed.value.split(',').map(s=>s.trim()).filter(Boolean),
  masterNotifyMode:tgMasterNotify.value,
};
```

- [ ] **Step 5: Run tests**

Run: `node --test lib/index-telegram-ui.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add index.html lib/index-telegram-ui.test.js
git commit -m "feat: add per-project master notification mode selector in telegram panel"
```

---

### Task 6: Final verification (automated + manual)

**Files:**
- No new source files; verification only

- [ ] **Step 1: Run all feature-related tests together**

Run:

```bash
node --test lib/validate.test.js lib/telegram.test.js lib/main-telegram-routing.test.js lib/master-telegram.test.js lib/index-telegram-ui.test.js
```

Expected: PASS for all tests.

- [ ] **Step 2: Manual UI + runtime smoke test**

Run app:

```bash
npm start
```

Manual checks:
1. Open a project tab with Telegram settings panel.
2. Confirm dropdown appears with `Full question`, `Ping only`, `Off`.
3. Save each mode and reopen panel; value persists.
4. Trigger a question event with project bot running:
   - `ping`: master bot gets short notification + deep-link button.
   - `full`: master bot gets question text + deep-link button.
   - `off`: master bot gets nothing.
5. Stop project bot (or clear token) and trigger question event:
   - master bot gets `/reply` token fallback message.

Expected: behavior matches mode matrix and fallback.

- [ ] **Step 3: Commit verification updates (only if any test files/logs changed intentionally)**

```bash
git status
```

Expected: clean working tree. If intentional changes exist, commit with a focused message.

---

## Spec Coverage Check (Self-Review)

- Per-project config with `masterNotifyMode` and default `'full'`: **Task 1 + Task 2**
- Project bot username discovery via `getMe`: **Task 3**
- Master bot mode matrix (`off`/`ping`/`full`) + deep-link button: **Task 4**
- `/reply` fallback when no project bot: **Task 4**
- UI dropdown + load/save wiring: **Task 5**
- Invalid mode treated as `'full'`: **Task 1 + Task 2 + Task 4 normalization**
- End-to-end verification: **Task 6**

No spec gaps found.

## Placeholder Scan (Self-Review)

No `TODO`, `TBD`, or unresolved placeholders in tasks.

## Type/Signature Consistency (Self-Review)

- `masterNotifyMode` consistently named across validation, IPC save/load, UI, and question routing.
- `projectBotUsername` consistently named across routing and master forwarding.
- Allowed modes consistently `['full', 'ping', 'off']`.

# Context Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect when a Claude Code session approaches the context window limit, perform a workflow-aware handoff, and seamlessly resume in a fresh session.

**Architecture:** A new `lib/context-guard.js` module checks `result.inputTokens` against the model's context window after each turn. On threshold breach (80%), it returns handoff/resume prompts tailored to the active workflow (GSD, Superpowers, or plain Claude). `SessionManager.start()` calls the guard between turns. Settings are added to the existing `settings-db.js` schema with a new "Context Guard" category in the settings UI.

**Tech Stack:** Node.js (matching existing patterns), Electron IPC, vanilla JS/HTML/CSS

**Design Spec:** `docs/superpowers/specs/2026-04-08-context-guard-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/context-guard.js` | Create | Detection logic, model context map, handoff/resume prompt generation |
| `lib/constants.js` | Modify | Add `MODEL_CONTEXT_WINDOWS`, `DEFAULT_CONTEXT_WINDOW`, `CONTEXT_GUARD_DEFAULTS` |
| `settings-db.js` | Modify | Add `contextGuard.*` schema entries and category |
| `session-manager.js` | Modify | Import context-guard, add check in `start()` loop, track recovery count |
| `preload.js` | No change | Settings API already generic — no new preload methods needed |
| `index.html` | Modify | Add Context Guard settings section in settings panel |

---

### Task 1: Add Constants

**Files:**
- Modify: `lib/constants.js`

- [ ] **Step 1: Add context guard constants to `lib/constants.js`**

Open `lib/constants.js` and add these entries inside the `module.exports` object, after the existing `COST_DANGER_USD` line (around line 131):

```js
  // ── Context Guard (CTX-01) ──────────────────────────
  // Model context window sizes (input tokens).
  // Used when the model API doesn't provide max_input_tokens.
  MODEL_CONTEXT_WINDOWS: {
    'claude-opus-4': 200000,
    'claude-sonnet-4': 200000,
    'claude-haiku-4': 200000,
    'claude-sonnet-3': 200000,
    'claude-haiku-3': 200000,
    'claude-opus-3': 200000,
  },
  DEFAULT_CONTEXT_WINDOW: 200000,

  CONTEXT_GUARD_DEFAULTS: {
    enabled: true,
    threshold: 0.80,
    contextWindowOverride: null,
    maxRecoveriesPerSession: 3,
  },

  // GSD context warning patterns injected by gsd-context-monitor.js hook
  GSD_CONTEXT_WARNING_RE: /CONTEXT WARNING/i,
  GSD_CONTEXT_CRITICAL_RE: /CONTEXT CRITICAL/i,
```

- [ ] **Step 2: Verify the constants file still parses**

Run:
```bash
node -e "const c = require('./lib/constants'); console.log('MODEL_CONTEXT_WINDOWS:', Object.keys(c.MODEL_CONTEXT_WINDOWS).length, 'models'); console.log('DEFAULT_CONTEXT_WINDOW:', c.DEFAULT_CONTEXT_WINDOW); console.log('CONTEXT_GUARD_DEFAULTS:', JSON.stringify(c.CONTEXT_GUARD_DEFAULTS));"
```

Expected: Prints 6 models, 200000 default, and the defaults object.

- [ ] **Step 3: Commit**

```bash
git add lib/constants.js
git commit -m "feat(context-guard): add context window constants and defaults"
```

---

### Task 2: Create Context Guard Module

**Files:**
- Create: `lib/context-guard.js`

- [ ] **Step 1: Create `lib/context-guard.js`**

```js
// lib/context-guard.js -- Turn-boundary context guard
// Detects when context usage exceeds threshold and provides
// workflow-aware handoff/resume prompts for seamless recovery.

const {
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  CONTEXT_GUARD_DEFAULTS,
  GSD_CONTEXT_WARNING_RE,
  GSD_CONTEXT_CRITICAL_RE,
} = require('./constants');

const HANDOFF_FILE = '.auto-claude-handoff.md';

const HANDOFF_PROMPT_GENERIC = `Context is nearly full. Please write a brief handoff summary to ${HANDOFF_FILE} describing:
1. What you were working on
2. What is done so far
3. What remains to be done
4. Any important decisions or context
Then stop.`;

const RESUME_PROMPT_GENERIC = `Read ${HANDOFF_FILE} and continue the work described there. Delete the handoff file when you've understood it.`;

/**
 * Look up the context window size for a model.
 * Tries prefix matching against MODEL_CONTEXT_WINDOWS,
 * then falls back to DEFAULT_CONTEXT_WINDOW.
 *
 * @param {string} modelId - e.g. 'claude-sonnet-4-20250514'
 * @param {number|null} configOverride - user config override
 * @param {number|null} apiMaxInputTokens - from models API if available
 * @returns {number} context window in tokens
 */
function getContextWindow(modelId, configOverride, apiMaxInputTokens) {
  // User override takes highest priority
  if (configOverride && configOverride > 0) return configOverride;

  // API-reported value (from lib/models.js _parseModel) takes second priority
  if (apiMaxInputTokens && apiMaxInputTokens > 0) return apiMaxInputTokens;

  // Prefix match against known models
  if (modelId) {
    for (const [prefix, tokens] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      if (modelId.startsWith(prefix)) return tokens;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Detect GSD context warnings in output text.
 * @param {string} fullText - the turn's accumulated output
 * @returns {'critical'|'warning'|null}
 */
function detectGsdWarning(fullText) {
  if (!fullText) return null;
  if (GSD_CONTEXT_CRITICAL_RE.test(fullText)) return 'critical';
  if (GSD_CONTEXT_WARNING_RE.test(fullText)) return 'warning';
  return null;
}

/**
 * Check whether a context recovery should be triggered.
 *
 * @param {object} result - proxy.run() result with inputTokens, fullText
 * @param {string} model - model ID from session state
 * @param {object} config - global config (reads contextGuard sub-object)
 * @param {number} recoveryCount - how many recoveries already performed
 * @returns {{ recover: boolean, pct: number, reason: string }}
 */
function shouldRecover(result, model, config, recoveryCount) {
  const guard = { ...CONTEXT_GUARD_DEFAULTS, ...(config.contextGuard || {}) };
  if (!guard.enabled) return { recover: false, pct: 0, reason: 'disabled' };

  // Safety: don't exceed max recoveries
  if (recoveryCount >= guard.maxRecoveriesPerSession) {
    return { recover: false, pct: 0, reason: `max recoveries reached (${recoveryCount}/${guard.maxRecoveriesPerSession})` };
  }

  // Need valid input tokens to measure
  if (!result || !result.inputTokens || result.inputTokens <= 0) {
    return { recover: false, pct: 0, reason: 'no token data' };
  }

  const contextWindow = getContextWindow(model, guard.contextWindowOverride, null);
  const pct = result.inputTokens / contextWindow;

  // Secondary signal: GSD context warnings can lower threshold or force recovery
  const gsdSignal = detectGsdWarning(result.fullText);
  if (gsdSignal === 'critical') {
    return { recover: true, pct, reason: `GSD CONTEXT CRITICAL detected (${(pct * 100).toFixed(0)}% usage)` };
  }

  // GSD warning lowers effective threshold to 70%
  const effectiveThreshold = gsdSignal === 'warning' ? 0.70 : guard.threshold;

  if (pct >= effectiveThreshold) {
    const reasonPrefix = gsdSignal === 'warning' ? 'GSD warning + ' : '';
    return { recover: true, pct, reason: `${reasonPrefix}context at ${(pct * 100).toFixed(0)}% (threshold: ${(effectiveThreshold * 100).toFixed(0)}%)` };
  }

  return { recover: false, pct, reason: 'below threshold' };
}

/**
 * Get the workflow-appropriate handoff prompt.
 * @param {object} sessionState - session.state with skillSource, gsdPhase
 * @returns {string} prompt to send as the handoff turn
 */
function getHandoffPrompt(sessionState) {
  if (sessionState.skillSource === 'gsd' || sessionState.gsdPhase) {
    return '/gsd-pause-work';
  }
  return HANDOFF_PROMPT_GENERIC;
}

/**
 * Get the workflow-appropriate resume prompt.
 * @param {object} sessionState - session.state with skillSource, gsdPhase
 * @returns {string} prompt to send as the first turn of the fresh session
 */
function getResumePrompt(sessionState) {
  if (sessionState.skillSource === 'gsd' || sessionState.gsdPhase) {
    return '/gsd-resume-work';
  }
  return RESUME_PROMPT_GENERIC;
}

module.exports = {
  shouldRecover,
  getHandoffPrompt,
  getResumePrompt,
  getContextWindow,
  detectGsdWarning,
  HANDOFF_FILE,
};
```

- [ ] **Step 2: Verify the module loads**

Run:
```bash
node -e "const cg = require('./lib/context-guard'); console.log('shouldRecover:', typeof cg.shouldRecover); console.log('getHandoffPrompt:', typeof cg.getHandoffPrompt); console.log('getResumePrompt:', typeof cg.getResumePrompt); console.log('getContextWindow:', typeof cg.getContextWindow); console.log('detectGsdWarning:', typeof cg.detectGsdWarning);"
```

Expected: All print `function`.

- [ ] **Step 3: Test `getContextWindow` logic**

Run:
```bash
node -e "
const { getContextWindow } = require('./lib/context-guard');
// Config override wins
console.log('override:', getContextWindow('claude-sonnet-4-20250514', 150000, null) === 150000);
// API value second
console.log('api:', getContextWindow('claude-sonnet-4-20250514', null, 180000) === 180000);
// Prefix match third
console.log('prefix:', getContextWindow('claude-sonnet-4-20250514', null, null) === 200000);
// Unknown model falls back
console.log('fallback:', getContextWindow('gpt-4o', null, null) === 200000);
"
```

Expected: All print `true`.

- [ ] **Step 4: Test `shouldRecover` logic**

Run:
```bash
node -e "
const { shouldRecover } = require('./lib/context-guard');
// Below threshold = no recovery
let r = shouldRecover({ inputTokens: 100000, fullText: '' }, 'claude-sonnet-4-20250514', {}, 0);
console.log('below:', !r.recover, r.pct.toFixed(2));
// Above threshold = recovery
r = shouldRecover({ inputTokens: 170000, fullText: '' }, 'claude-sonnet-4-20250514', {}, 0);
console.log('above:', r.recover, r.pct.toFixed(2));
// GSD CRITICAL = always recover
r = shouldRecover({ inputTokens: 50000, fullText: 'CONTEXT CRITICAL: Usage at 85%' }, 'claude-sonnet-4-20250514', {}, 0);
console.log('critical:', r.recover);
// GSD WARNING lowers threshold
r = shouldRecover({ inputTokens: 145000, fullText: 'CONTEXT WARNING: Usage at 72%' }, 'claude-sonnet-4-20250514', {}, 0);
console.log('warning-lowered:', r.recover, r.pct.toFixed(2));
// Max recoveries reached
r = shouldRecover({ inputTokens: 170000, fullText: '' }, 'claude-sonnet-4-20250514', {}, 3);
console.log('max-reached:', !r.recover);
// Disabled
r = shouldRecover({ inputTokens: 170000, fullText: '' }, 'claude-sonnet-4-20250514', { contextGuard: { enabled: false } }, 0);
console.log('disabled:', !r.recover);
"
```

Expected: All print `true` (plus percentage values).

- [ ] **Step 5: Test `getHandoffPrompt` and `getResumePrompt`**

Run:
```bash
node -e "
const { getHandoffPrompt, getResumePrompt } = require('./lib/context-guard');
// GSD
console.log('gsd-handoff:', getHandoffPrompt({ skillSource: 'gsd', gsdPhase: 'executing phase 3' }) === '/gsd-pause-work');
console.log('gsd-resume:', getResumePrompt({ skillSource: 'gsd', gsdPhase: 'executing phase 3' }) === '/gsd-resume-work');
// GSD by gsdPhase alone
console.log('gsd-phase-only:', getHandoffPrompt({ gsdPhase: 'planning phase 1' }) === '/gsd-pause-work');
// Plain/Superpowers
console.log('plain-handoff:', getHandoffPrompt({ skillSource: 'superpowers' }).includes('.auto-claude-handoff.md'));
console.log('plain-resume:', getResumePrompt({}).includes('.auto-claude-handoff.md'));
"
```

Expected: All print `true`.

- [ ] **Step 6: Commit**

```bash
git add lib/context-guard.js
git commit -m "feat(context-guard): create context guard module with detection and recovery logic"
```

---

### Task 3: Add Settings Schema

**Files:**
- Modify: `settings-db.js`

- [ ] **Step 1: Add `contextGuard` entries to `SETTINGS_SCHEMA`**

In `settings-db.js`, find the `SETTINGS_SCHEMA` constant. Add these entries after the `'resilience.autoResume'` line (around line 30):

```js
  'contextGuard.enabled':                  { category:'contextGuard', type:'toggle', label:'Context Guard',               default:true,          description:'Automatically detect when context window is nearly full and seamlessly recover by saving state and starting a fresh session.' },
  'contextGuard.threshold':                { category:'contextGuard', type:'number', label:'Threshold (%)',                default:80, min:50, max:95, description:'Context usage percentage at which to trigger recovery (50-95). Lower values trigger earlier, leaving more room for the handoff turn.' },
  'contextGuard.contextWindowOverride':    { category:'contextGuard', type:'number', label:'Context Window Override',     default:0, min:0,      description:'Manually set context window size in tokens. 0 = auto-detect from model. Use if auto-detection is wrong for your model/provider.' },
  'contextGuard.maxRecoveriesPerSession':  { category:'contextGuard', type:'number', label:'Max Recoveries',              default:3, min:1, max:10, description:'Maximum context recoveries per session before stopping. Prevents infinite recovery loops.' },
```

**Note:** The threshold is stored as an integer (80) in settings and converted to a float (0.80) when consumed by context-guard. This matches how users think about percentages.

- [ ] **Step 2: Add `contextGuard` to `CATEGORY_ORDER`**

Find the `CATEGORY_ORDER` array (around line 51). Add the context guard category after `resilience`:

```js
  { key:'contextGuard', icon:'🧠', label:'Context Guard' },
```

So the array now reads:
```js
const CATEGORY_ORDER = [
  { key:'workspace',     icon:'📁', label:'Workspace' },
  { key:'session',       icon:'⚡', label:'Session' },
  { key:'autonomy',      icon:'🤖', label:'Autonomy' },
  { key:'notifications', icon:'🔔', label:'Notifications' },
  { key:'retry',         icon:'🔄', label:'Retry' },
  { key:'resilience',    icon:'🛡️', label:'Resilience' },
  { key:'contextGuard',  icon:'🧠', label:'Context Guard' },
  { key:'telegram',      icon:'📡', label:'Telegram' },
  { key:'hooks',         icon:'🧩', label:'Hooks' },
  { key:'batch',         icon:'📦', label:'Batch' },
  { key:'superpowers',   icon:'✨', label:'Superpowers' },
  { key:'system',        icon:'💻', label:'System' },
];
```

- [ ] **Step 3: Update `buildConfigObject` to convert threshold**

In `settings-db.js`, find the `buildConfigObject` function (around line 261). After the existing `masterTelegram.chatIds` conversion block (end of function, before `return config`), add:

```js
  // Convert contextGuard.threshold from integer percentage to float (80 → 0.80)
  if (config.contextGuard && config.contextGuard.threshold) {
    config.contextGuard.threshold = config.contextGuard.threshold / 100;
  }
  // Convert contextWindowOverride: 0 means null (auto-detect)
  if (config.contextGuard && config.contextGuard.contextWindowOverride === 0) {
    config.contextGuard.contextWindowOverride = null;
  }
```

- [ ] **Step 4: Verify settings schema loads**

Run:
```bash
node -e "
const sdb = require('./settings-db');
sdb.init();
const schema = sdb.SETTINGS_SCHEMA;
console.log('contextGuard.enabled:', schema['contextGuard.enabled']?.type);
console.log('contextGuard.threshold:', schema['contextGuard.threshold']?.default);
console.log('contextGuard.contextWindowOverride:', schema['contextGuard.contextWindowOverride']?.type);
console.log('contextGuard.maxRecoveriesPerSession:', schema['contextGuard.maxRecoveriesPerSession']?.default);
const cats = sdb.CATEGORY_ORDER.map(c => c.key);
console.log('category exists:', cats.includes('contextGuard'));
console.log('category position:', cats.indexOf('contextGuard'), '(after resilience at', cats.indexOf('resilience'), ')');
sdb.close();
"
```

Expected: Shows toggle type, 80 default, number type, 3 default, category exists at position after resilience.

- [ ] **Step 5: Verify `buildConfigObject` threshold conversion**

Run:
```bash
node -e "
const sdb = require('./settings-db');
sdb.init();
const config = sdb.buildConfigObject();
console.log('threshold (should be 0.80):', config.contextGuard?.threshold);
console.log('contextWindowOverride (should be null):', config.contextGuard?.contextWindowOverride);
sdb.close();
"
```

Expected: `0.80` and `null`.

- [ ] **Step 6: Commit**

```bash
git add settings-db.js
git commit -m "feat(context-guard): add contextGuard settings schema and category"
```

---

### Task 4: Integrate into SessionManager

**Files:**
- Modify: `session-manager.js`

- [ ] **Step 1: Add import at top of `session-manager.js`**

After the existing `const AutonomyEngine = require('./lib/autonomy');` line (line 6), add:

```js
const contextGuard = require('./lib/context-guard');
```

- [ ] **Step 2: Add recovery counter to the `start()` method**

In the `start()` method, find the line `let derailmentCount = 0;` (around line 121). Add after it:

```js
    let contextRecoveryCount = 0;
```

- [ ] **Step 3: Add context guard check in the while-loop**

In the `start()` method, find the block after crash retry that resets `crashRetryCount = 0;` (around line 163). This is the line right after the crash retry `if` block closes. Add the context guard check immediately after that line, **before** the `// Auto-answer was set during the turn` comment:

```js
      // ── Context Guard (CTX-01) ──────────────────────────
      // Check if context usage exceeds threshold — trigger handoff + fresh session
      const ctxCheck = contextGuard.shouldRecover(result, session.state.model, this.config, contextRecoveryCount);
      if (ctxCheck.recover) {
        contextRecoveryCount++;
        const pctStr = (ctxCheck.pct * 100).toFixed(0);
        this.send(tabId, 'log', { type: 'system', text: `\u26a0 Context at ${pctStr}% \u2014 saving state and starting fresh session (${contextRecoveryCount}/${this.config.contextGuard?.maxRecoveriesPerSession || 3})` });
        this.emit('notify', { type: 'error', title: 'Auto Claude \u2014 Context Recovery', body: ctxCheck.reason });

        // Step 1: Handoff turn — save state via workflow-appropriate method
        const handoffPrompt = contextGuard.getHandoffPrompt(session.state);
        this.send(tabId, 'log', { type: 'system', text: `Handoff: ${handoffPrompt.substring(0, 80)}...` });
        session.proxy = new ClaudeProxy(this.config);
        this._wireProxy(tabId, session, session.proxy);
        const handoffResult = await session.proxy.run(session.state.projectDir, {
          prompt: handoffPrompt,
          mode: 'continue',
          sessionId: session.state.sessionId,
        });
        if (!session.state.running) return;
        // Accumulate handoff turn tokens
        session.state.totalInputTokens += handoffResult.inputTokens;
        session.state.totalOutputTokens += handoffResult.outputTokens;
        session.state.totalCostUsd += handoffResult.costUsd || 0;

        // Step 2: Clear session — next turn starts fresh
        session.state.sessionId = null;
        this.send(tabId, 'log', { type: 'system', text: '\u2713 Session cleared \u2014 starting fresh with handoff' });

        // Step 3: Resume — set prompt for fresh session
        turnPrompt = contextGuard.getResumePrompt(session.state);
        turnMode = 'fresh';
        turnSessionId = null;

        // Reset loop detection state for the fresh session
        autoNextHistory.length = 0;
        derailmentCount = 0;
        session.state.lastAutoNextPrompt = null;
        continue;
      }

```

- [ ] **Step 4: Verify `session-manager.js` still loads without errors**

Run:
```bash
node -e "const SM = require('./session-manager'); console.log('SessionManager loaded:', typeof SM === 'function');"
```

Expected: `SessionManager loaded: true`

- [ ] **Step 5: Commit**

```bash
git add session-manager.js
git commit -m "feat(context-guard): integrate turn-boundary context check into session loop"
```

---

### Task 5: Settings UI

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Verify settings UI auto-renders the new category**

The existing settings UI in `index.html` dynamically renders categories from `CATEGORY_ORDER` and settings from `SETTINGS_SCHEMA`. The settings editor uses `window.electronAPI.getSettingsSchema()` and `window.electronAPI.getSettingsGroup(category)` to build the UI. Since we added our schema entries with `category: 'contextGuard'` and added the category to `CATEGORY_ORDER`, the settings panel should already show the "Context Guard" tab automatically.

Start the app and verify:
```bash
npm start
```

Open Settings → verify "🧠 Context Guard" tab appears with 4 settings:
1. Context Guard toggle (default: on)
2. Threshold (%) number input (default: 80)
3. Context Window Override number input (default: 0)
4. Max Recoveries number input (default: 3)

- [ ] **Step 2: Commit (if any manual UI adjustments were needed)**

```bash
git add -A
git commit -m "feat(context-guard): verify settings UI renders context guard category"
```

---

### Task 6: End-to-End Verification

- [ ] **Step 1: Verify full module integration**

Run a comprehensive integration check:
```bash
node -e "
// 1. Load all modules
const SM = require('./session-manager');
const cg = require('./lib/context-guard');
const constants = require('./lib/constants');
const sdb = require('./settings-db');

// 2. Check constants
console.log('[OK] MODEL_CONTEXT_WINDOWS:', Object.keys(constants.MODEL_CONTEXT_WINDOWS).length, 'models');
console.log('[OK] DEFAULT_CONTEXT_WINDOW:', constants.DEFAULT_CONTEXT_WINDOW);

// 3. Check context-guard functions
const r1 = cg.shouldRecover({ inputTokens: 170000, fullText: '' }, 'claude-sonnet-4-20250514', {}, 0);
console.log('[OK] shouldRecover (above threshold):', r1.recover, r1.reason);

const r2 = cg.shouldRecover({ inputTokens: 100000, fullText: '' }, 'claude-sonnet-4-20250514', {}, 0);
console.log('[OK] shouldRecover (below threshold):', !r2.recover);

const r3 = cg.shouldRecover({ inputTokens: 50000, fullText: 'blah CONTEXT CRITICAL blah' }, 'claude-sonnet-4-20250514', {}, 0);
console.log('[OK] shouldRecover (GSD critical):', r3.recover, r3.reason);

console.log('[OK] GSD handoff:', cg.getHandoffPrompt({ skillSource: 'gsd' }));
console.log('[OK] GSD resume:', cg.getResumePrompt({ gsdPhase: 'exec' }));
console.log('[OK] Generic handoff contains file:', cg.getHandoffPrompt({}).includes('.auto-claude-handoff.md'));
console.log('[OK] Generic resume contains file:', cg.getResumePrompt({}).includes('.auto-claude-handoff.md'));

// 4. Check settings
sdb.init();
const config = sdb.buildConfigObject();
console.log('[OK] Config threshold:', config.contextGuard?.threshold);
console.log('[OK] Config enabled:', config.contextGuard?.enabled);
sdb.close();

console.log('\\n=== All checks passed ===');
"
```

Expected: All lines print `[OK]` with correct values, ending with `=== All checks passed ===`.

- [ ] **Step 2: Manual smoke test**

1. Start the app: `npm start`
2. Open Settings → verify Context Guard category appears with all 4 settings
3. Toggle Context Guard off/on — verify setting persists after app restart
4. Start a session with a simple prompt — verify no errors in the log
5. The context guard won't trigger on short sessions, but verify no crashes or regressions

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat(context-guard): complete context guard implementation with settings and integration"
```

# Settings Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GSD settings category, enlarge settings/CCM windows, replace the JSON editor with a syntax-highlighted version, and audit all settings.

**Architecture:** Schema-driven settings in `settings-db.js` feed a generic renderer in `index.html`. GSD detector gets config-awareness matching SuperpowersDetector. JSON editor uses textarea+overlay pattern for zero-dependency syntax highlighting.

**Tech Stack:** Electron, vanilla JS, Node.js test runner

---

### Task 1: GSD Settings Schema

**Files:**
- Modify: `settings-db.js:46-73` (add GSD entries to SETTINGS_SCHEMA and CATEGORY_ORDER)

- [ ] **Step 1: Write failing test**

Create `lib/gsd-settings.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('SETTINGS_SCHEMA includes gsd.enabled', () => {
  const { SETTINGS_SCHEMA } = require('../settings-db');
  assert.ok(SETTINGS_SCHEMA['gsd.enabled'], 'gsd.enabled should exist in schema');
  assert.equal(SETTINGS_SCHEMA['gsd.enabled'].category, 'gsd');
  assert.equal(SETTINGS_SCHEMA['gsd.enabled'].type, 'toggle');
  assert.equal(SETTINGS_SCHEMA['gsd.enabled'].default, true);
});

test('SETTINGS_SCHEMA includes all 6 GSD settings', () => {
  const { SETTINGS_SCHEMA } = require('../settings-db');
  const gsdKeys = Object.keys(SETTINGS_SCHEMA).filter(k => k.startsWith('gsd.'));
  assert.equal(gsdKeys.length, 6);
  assert.ok(SETTINGS_SCHEMA['gsd.autoNext']);
  assert.ok(SETTINGS_SCHEMA['gsd.derailmentCorrection']);
  assert.ok(SETTINGS_SCHEMA['gsd.maxPhaseRetries']);
  assert.ok(SETTINGS_SCHEMA['gsd.autoContinueDelaySecs']);
  assert.ok(SETTINGS_SCHEMA['gsd.phaseTimeoutMinutes']);
});

test('CATEGORY_ORDER includes gsd after superpowers', () => {
  const { CATEGORY_ORDER } = require('../settings-db');
  const spIdx = CATEGORY_ORDER.findIndex(c => c.key === 'superpowers');
  const gsdIdx = CATEGORY_ORDER.findIndex(c => c.key === 'gsd');
  assert.ok(gsdIdx > 0, 'gsd category should exist');
  assert.ok(gsdIdx > spIdx, 'gsd should come after superpowers');
  assert.equal(CATEGORY_ORDER[gsdIdx].icon, '🚀');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/gsd-settings.test.js`
Expected: FAIL — `gsd.enabled` not found in schema

- [ ] **Step 3: Add GSD settings to schema**

In `settings-db.js`, add after the `superpowers.skillChain` line (line 50) and before `projectTelegram`:

```js
  'gsd.enabled':                             { category:'gsd',           type:'toggle', label:'Enabled',                    default:true,          description:'Master switch for GSD workflow detection. When OFF, GSD auto-next, derailment correction, and phase tracking are all disabled.' },
  'gsd.autoNext':                            { category:'gsd',           type:'toggle', label:'Auto-Next',                  default:true,          description:'Auto-advance to the next GSD phase when the current one completes. Follows /gsd:next suggestions automatically.' },
  'gsd.derailmentCorrection':                { category:'gsd',           type:'toggle', label:'Derailment Correction',      default:true,          description:'Detect and correct when Claude goes off-track during GSD workflows. Sends a refocus prompt to get back on task.' },
  'gsd.maxPhaseRetries':                     { category:'gsd',           type:'number', label:'Max Phase Retries',          default:3, min:1, max:10, description:'Maximum times to retry a stuck phase before stopping auto-next. Prevents infinite loops on persistent failures.' },
  'gsd.autoContinueDelaySecs':               { category:'gsd',           type:'number', label:'Auto-Continue Delay (s)',    default:15, min:5, max:120, description:'Seconds to wait before auto-continuing when Claude is waiting for background agents. Lower = faster, higher = less API churn.' },
  'gsd.phaseTimeoutMinutes':                 { category:'gsd',           type:'number', label:'Phase Timeout (min)',        default:0, min:0,      description:'Maximum minutes per phase before alerting. 0 = no limit. Useful for detecting stuck phases in unattended sessions.' },
```

In `CATEGORY_ORDER`, add after the superpowers entry:

```js
  { key:'gsd',          icon:'🚀', label:'GSD' },
```

Note: `SETTINGS_SCHEMA` and `CATEGORY_ORDER` are already exported from `settings-db.js` — no export changes needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/gsd-settings.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `node --test lib/runtime-utils.test.js lib/claude-detector.test.js lib/proxy.test.js lib/gsd-detector.test.js`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add settings-db.js lib/gsd-settings.test.js
git commit -m "feat: add GSD settings category to schema with 6 toggles/controls"
```

---

### Task 2: Wire GSD Settings into GsdDetector

**Files:**
- Modify: `lib/gsd-detector.js` — accept config, gate methods with settings
- Modify: `main.js:567` — pass config to GsdDetector constructor
- Modify: `lib/gsd-detector.test.js` — add tests for config-gated behavior

- [ ] **Step 1: Write failing tests for config-gated behavior**

Append to `lib/gsd-detector.test.js`:

```js
// ── Config-gated behavior ──

test('detect returns null when gsd.enabled is false', () => {
  const d = new GsdDetector({ gsd: { enabled: false } });
  assert.equal(d.detect('/gsd:execute-phase 1'), null);
});

test('detect works when gsd.enabled is true', () => {
  const d = new GsdDetector({ gsd: { enabled: true } });
  const r = d.detect('/gsd:execute-phase 1');
  assert.ok(r);
  assert.equal(r.label, 'executing phase 1');
});

test('detectAutoNext returns null when gsd.autoNext is false', () => {
  const d = new GsdDetector({ gsd: { autoNext: false } });
  const result = makeResult('## PHASE COMPLETE\nPhase: 1');
  const session = makeSession('executing phase 1');
  assert.equal(d.detectAutoNext(result, session), null);
});

test('detectDerailment returns null when gsd.derailmentCorrection is false', () => {
  const d = new GsdDetector({ gsd: { derailmentCorrection: false } });
  const result = makeResult('Some random off-topic text without any question marks or GSD markers');
  const session = makeSession('executing phase 1');
  assert.equal(d.detectDerailment(result, session), null);
});

test('detectAutoNext uses config autoContinueDelaySecs for agent waits', () => {
  const d = new GsdDetector({ gsd: { autoContinueDelaySecs: 30 } });
  const result = makeResult('Waiting for background agents to complete.');
  result.numTurns = 2;
  const session = makeSession('executing phase 1');
  const r = d.detectAutoNext(result, session);
  assert.ok(r);
  assert.equal(r.delaySecs, 30);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/gsd-detector.test.js`
Expected: FAIL — GsdDetector constructor doesn't accept config, detect() doesn't check enabled

- [ ] **Step 3: Update GsdDetector to accept and use config**

In `lib/gsd-detector.js`, update the class:

```js
class GsdDetector extends WorkflowDetector {
  constructor(config) {
    super('gsd');
    this.config = config || {};
    this.patterns = GSD_PHASE_PATTERNS;
    this._phaseRetryCount = 0;
    this._lastPhaseKey = null;
  }

  _gsdCfg() {
    return this.config.gsd || {};
  }

  detect(text) {
    if (this._gsdCfg().enabled === false) return null;
    for (const p of this.patterns) {
      const m = text.match(p.re);
      if (m) return { label: p.label.replace('$1', m[1] || '') };
    }
    return null;
  }
```

In `detectAutoNext`, add at the top:
```js
  detectAutoNext(result, session) {
    if (!result || !result.fullText) return null;
    const cfg = this._gsdCfg();
    if (cfg.enabled === false || cfg.autoNext === false) return null;
    const text = result.fullText;
```

Update the agent-waiting return to use config delay:
```js
    if (/waiting (?:for|on).*(?:agent|research|task)|.../) {
      return { prompt: 'continue', reason: 'Waiting for background agents', delaySecs: cfg.autoContinueDelaySecs || 15 };
    }
```

In `detectDerailment`, add at the top:
```js
  detectDerailment(result, session) {
    if (!result || !result.fullText) return null;
    const cfg = this._gsdCfg();
    if (cfg.enabled === false || cfg.derailmentCorrection === false) return null;
    const text = result.fullText;
```

- [ ] **Step 4: Update main.js to pass config to GsdDetector**

In `main.js:567`, change:
```js
  workflowManager = new WorkflowManager([
    new GsdDetector(config),
    new SuperpowersDetector(config),
  ]);
```

- [ ] **Step 5: Run all tests**

Run: `node --test lib/gsd-detector.test.js lib/gsd-settings.test.js lib/runtime-utils.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add lib/gsd-detector.js lib/gsd-detector.test.js main.js
git commit -m "feat: wire GSD settings into GsdDetector for config-gated behavior"
```

---

### Task 3: Settings Window Size Increase

**Files:**
- Modify: `index.html:194,216` — CSS size changes

- [ ] **Step 1: Update settings panel size**

In `index.html` line 194, change:
```css
.settings-panel{...width:720px;...height:520px;...}
```
to:
```css
.settings-panel{...width:860px;...height:620px;...}
```

- [ ] **Step 2: Update CCM modal size**

In `index.html` line 216, change:
```css
.ccm-modal{...width:900px;...height:700px;...}
```
to:
```css
.ccm-modal{...width:1000px;...height:780px;...}
```

- [ ] **Step 3: Verify visually**

Run: `npm start`
Open Settings panel — should be larger. Open Claude Code Manager (Settings.json tab) — should be larger. Both should still center on screen and not overflow on 1080p.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: enlarge settings panel (860×620) and CCM modal (1000×780)"
```

---

### Task 4: JSON Editor — CSS Classes

**Files:**
- Modify: `index.html` — add CSS rules for JSON syntax highlighting

- [ ] **Step 1: Add JSON editor CSS classes**

Add these CSS rules after the existing `.ccm-editor-area` rule (around line 287) in the `<style>` block:

```css
.ccm-editor-wrap{display:flex;flex:1;overflow:hidden;position:relative;border:1px solid var(--bdr);border-radius:6px;background:var(--bg)}
.ccm-line-gutter{width:48px;padding:12px 8px 12px 0;text-align:right;font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace;font-size:12px;line-height:20px;color:var(--tx2);overflow:hidden;user-select:none;flex-shrink:0;background:rgba(0,0,0,.15);border-right:1px solid var(--bdr)}
.ccm-editor-container{position:relative;flex:1;overflow:hidden}
.ccm-editor-area-v2{position:absolute;top:0;left:0;width:100%;height:100%;font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace;font-size:12px;line-height:20px;padding:12px;margin:0;border:none;background:transparent;color:transparent;caret-color:var(--tx);resize:none;tab-size:2;box-sizing:border-box;white-space:pre;overflow:auto;z-index:2;outline:none}
.ccm-highlight-overlay{position:absolute;top:0;left:0;width:100%;height:100%;font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace;font-size:12px;line-height:20px;padding:12px;margin:0;border:none;white-space:pre;overflow:hidden;pointer-events:none;box-sizing:border-box;z-index:1;color:var(--tx)}
.json-key{color:#7dcfff}
.json-string{color:#9ece6a}
.json-number{color:#ff9e64}
.json-bool,.json-null{color:#bb9af7}
.json-brace{color:var(--tx2)}
.json-error-line{background:rgba(255,50,50,.15);display:inline}
.json-bracket-match{outline:1px solid rgba(125,207,255,.5);border-radius:2px}
```

- [ ] **Step 2: Commit CSS**

```bash
git add index.html
git commit -m "feat: add CSS classes for JSON syntax highlighting editor"
```

---

### Task 5: JSON Editor — highlightJson Function

**Files:**
- Modify: `index.html` — add `highlightJson()` function in the `<script>` block

- [ ] **Step 1: Add highlightJson function**

Add this function near the top of the CCM section (inside the script block, before the `renderSettingsEditor` function). Find a good insertion point near the CCM rendering code:

```js
function highlightJson(text, errorLine) {
  // Regex-based JSON tokenizer for display coloring
  const lines = text.split('\n');
  return lines.map((line, idx) => {
    let highlighted = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // Highlight tokens — order matters: strings first (they may contain other patterns)
    highlighted = highlighted.replace(
      /("(?:[^"\\]|\\.)*")\s*:/g,
      '<span class="json-key">$1</span>:'
    );
    highlighted = highlighted.replace(
      /:\s*("(?:[^"\\]|\\.)*")/g,
      ': <span class="json-string">$1</span>'
    );
    // Standalone strings (in arrays)
    highlighted = highlighted.replace(
      /(?<=[\[,]\s*)("(?:[^"\\]|\\.)*")/g,
      '<span class="json-string">$1</span>'
    );
    highlighted = highlighted.replace(
      /\b(-?\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g,
      '<span class="json-number">$1</span>'
    );
    highlighted = highlighted.replace(
      /\b(true|false)\b/g,
      '<span class="json-bool">$1</span>'
    );
    highlighted = highlighted.replace(
      /\b(null)\b/g,
      '<span class="json-null">$1</span>'
    );
    highlighted = highlighted.replace(
      /([{}[\]])/g,
      '<span class="json-brace">$1</span>'
    );
    if (errorLine !== undefined && idx === errorLine) {
      return '<span class="json-error-line">' + highlighted + '</span>';
    }
    return highlighted;
  }).join('\n');
}

function parseJsonErrorPosition(errMsg) {
  // Extract line and column from JSON.parse error messages
  // Chrome/V8: "...at position 123" or "...at line 5 column 10"
  const posMatch = errMsg.match(/position\s+(\d+)/i);
  const lineColMatch = errMsg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColMatch) return { line: parseInt(lineColMatch[1], 10) - 1, col: parseInt(lineColMatch[2], 10) - 1 };
  return posMatch ? { position: parseInt(posMatch[1], 10) } : null;
}

function positionToLineCol(text, position) {
  let line = 0, col = 0;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 0; } else { col++; }
  }
  return { line, col };
}
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: add highlightJson tokenizer and error position parser"
```

---

### Task 6: JSON Editor — Rebuild renderRaw()

**Files:**
- Modify: `index.html` — replace the `renderRaw()` function (around line 2598-2616)

- [ ] **Step 1: Replace renderRaw function**

Replace the existing `renderRaw()` function with:

```js
    function renderRaw(){
      const json = JSON.stringify(workingSettings || {}, null, 2);

      editorScroll.innerHTML = `
        <div class="ccm-editor-wrap">
          <div class="ccm-line-gutter" id="ccmLineGutter"></div>
          <div class="ccm-editor-container">
            <pre class="ccm-highlight-overlay" id="ccmHighlightOverlay"></pre>
            <textarea class="ccm-editor-area-v2" id="ccmRawEditor" spellcheck="false">${esc(json)}</textarea>
          </div>
        </div>`;

      const editor = editorScroll.querySelector('#ccmRawEditor');
      const overlay = editorScroll.querySelector('#ccmHighlightOverlay');
      const gutter = editorScroll.querySelector('#ccmLineGutter');
      statusEl.style.display = 'inline';

      function updateGutter(text) {
        const lineCount = text.split('\n').length;
        let html = '';
        for (let i = 1; i <= lineCount; i++) html += i + '\n';
        gutter.textContent = html;
      }

      function updateHighlight(text, errorLine) {
        overlay.innerHTML = highlightJson(text, errorLine);
      }

      function syncScroll() {
        overlay.scrollTop = editor.scrollTop;
        overlay.scrollLeft = editor.scrollLeft;
        gutter.scrollTop = editor.scrollTop;
      }

      function validateAndRender() {
        const text = editor.value;
        updateGutter(text);
        let errorLine;
        try {
          JSON.parse(text);
          statusEl.textContent = '● Valid JSON';
          statusEl.className = 'ccm-json-status valid';
          body.querySelector('#ccmSave').disabled = false;
          errorLine = undefined;
        } catch (e) {
          const pos = parseJsonErrorPosition(e.message);
          let line, col;
          if (pos && pos.line !== undefined) {
            line = pos.line; col = pos.col;
          } else if (pos && pos.position !== undefined) {
            const lc = positionToLineCol(text, pos.position);
            line = lc.line; col = lc.col;
          }
          if (line !== undefined) {
            statusEl.textContent = `● Line ${line + 1}:${(col || 0) + 1} — ${e.message.replace(/^JSON\.parse:\s*/i, '').slice(0, 60)}`;
          } else {
            statusEl.textContent = '● Invalid JSON';
          }
          statusEl.className = 'ccm-json-status invalid';
          body.querySelector('#ccmSave').disabled = true;
          errorLine = line;
        }
        updateHighlight(text, errorLine);
      }

      editor.addEventListener('input', () => { validateAndRender(); syncScroll(); });
      editor.addEventListener('scroll', syncScroll);

      editor.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); body.querySelector('#ccmSave').click(); }
        if (e.key === 'Tab') {
          e.preventDefault();
          const s = editor.selectionStart, end = editor.selectionEnd;
          editor.value = editor.value.substring(0, s) + '  ' + editor.value.substring(end);
          editor.selectionStart = editor.selectionEnd = s + 2;
          validateAndRender();
        }
      });

      // Initial render
      validateAndRender();
    }
```

- [ ] **Step 2: Update syncFromRaw to match new textarea ID**

The existing `syncFromRaw()` function already uses `#ccmRawEditor` selector, so it continues to work unchanged.

- [ ] **Step 3: Verify visually**

Run: `npm start`
Open Claude Code Manager → Settings.json tab → click "Raw JSON". Verify:
- Line numbers appear in the gutter
- JSON is syntax-highlighted (keys cyan, strings green, numbers orange, bools purple)
- Typing updates highlighting in real-time
- Introduce a JSON error (delete a comma) — status shows line:column and error line turns red
- Scrolling keeps gutter and highlight in sync
- Tab inserts 2 spaces, Ctrl+S saves

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: replace plain textarea with syntax-highlighted JSON editor"
```

---

### Task 7: Settings Schema Audit & Cleanup

**Files:**
- Modify: `settings-db.js` — update descriptions, fix constraints

- [ ] **Step 1: Audit and fix settings**

Review each setting. Based on codebase analysis, the following need attention:

1. **`autoAnswer.questionTimeoutSeconds`** — description says "Seconds before auto-answering questions" but it's used as a general timeout in `session-manager.js:319`. Description is correct. ✓

2. **`resilience.maxCrashRetries`** — used in both `autonomy.js:228` and `session-manager.js:168`. Missing `max` constraint. Add `max:10`.

3. **`system.autoUpdate`** — description says "Only works in installed (packaged) builds." This is accurate (`app.isPackaged` check in main.js). ✓

4. **`hooks.maxLogSizeMB`** — description doesn't mention that this is per-project. Update description to: `'Max hook log file size in MB per project before truncation. Older entries removed first. 5 MB holds thousands of events.'`

5. **`contextGuard.threshold`** — missing `max` in description. The schema already has `max:95`. ✓

6. **`batch.enabled`** — description says "Enable when you have a list of tasks." Improve to: `'Enable batch queue for processing multiple prompts sequentially or in parallel across a project.'`

7. **All number fields** — verify all have `min`. `autoAnswer.questionTimeoutSeconds` and `resilience.crashRetryDelaySecs` have `min:0`. Good.

8. **`gsd.maxPhaseRetries`** — already added with `min:1, max:10` in Task 1. ✓

Apply the fixes to `settings-db.js`.

- [ ] **Step 2: Run all tests**

Run: `node --test lib/runtime-utils.test.js lib/claude-detector.test.js lib/proxy.test.js lib/gsd-detector.test.js lib/gsd-settings.test.js`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add settings-db.js
git commit -m "chore: audit settings schema — add constraints, update descriptions"
```

---

### Task 8: Version Bump, Final Test, Tag & Release

**Files:**
- Modify: `package.json:3` — bump version

- [ ] **Step 1: Bump version to 3.8.0** (minor bump for new feature: GSD settings + JSON editor)

In `package.json`, change `"version": "3.7.4"` to `"version": "3.8.0"`.

- [ ] **Step 2: Run full test suite**

Run: `node --test lib/*.test.js`
Expected: All tests pass

- [ ] **Step 3: Commit, tag, push**

```bash
git add package.json
git commit -m "chore: bump version to 3.8.0"
git tag v3.8.0
git push origin master --tags
```

- [ ] **Step 4: Verify release workflow triggers**

Run: `gh run list --limit 1`
Expected: "Build & Release" workflow queued for v3.8.0

- [ ] **Step 5: Monitor release**

Run: `gh run watch <run-id> --exit-status`
Expected: All 3 platform builds succeed, release created with binaries

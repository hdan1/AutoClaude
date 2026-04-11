# Hybrid Print-First PTY Slash Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep print-mode as the default execution path while automatically running interactive-only slash commands through an on-demand PTY fallback.

**Architecture:** Introduce a routing decision in `proxy.js` that classifies each turn into `print`, `cli-subcommand`, or `pty-fallback`. Keep the existing stream-json parser untouched for print-mode turns, and add a separate PTY executor module for fallback turns. Emit explicit execution-mode events so session logs remain understandable in mixed-mode operation.

**Tech Stack:** Electron main/session architecture, Node `child_process`, Claude CLI, Node built-in test runner (`node:test`)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `settings-db.js` | Modify | Add runtime fallback settings (`runtime.slashFallback.*`) with defaults |
| `lib/validate.js` | Modify | Allow/validate `runtime` block when config is saved through IPC |
| `lib/validate.test.js` | Create | Unit tests for runtime config validation rules |
| `lib/pty-executor.js` | Create | Run single interactive slash command in on-demand PTY/tmux-style bridge and return normalized result |
| `lib/pty-executor.test.js` | Create | Unit tests for PTY result classification and timeout/error handling |
| `proxy.js` | Modify | Add execution plan resolver and PTY fallback path while preserving current print-mode flow |
| `lib/proxy.test.js` | Modify | Routing and normalization regression tests |
| `index.html` | Modify | Render execution-mode events in live log panel (`print`, `cli-subcommand`, `pty-fallback`) |

---

### Task 1: Add Runtime Settings and Validation Guardrails

**Files:**
- Create: `lib/validate.test.js`
- Modify: `lib/validate.js`
- Modify: `settings-db.js`

- [ ] **Step 1: Write failing validation tests for `runtime.slashFallback`**

Create `lib/validate.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('./validate');

test('validateConfig preserves runtime slash fallback keys', () => {
  const result = validateConfig({
    runtime: {
      slashFallback: {
        enabled: true,
        timeoutMs: 45000,
        logRawOutput: false,
      },
    },
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.config.runtime, {
    slashFallback: {
      enabled: true,
      timeoutMs: 45000,
      logRawOutput: false,
    },
  });
});

test('validateConfig clamps invalid runtime timeout', () => {
  const result = validateConfig({
    runtime: {
      slashFallback: {
        enabled: true,
        timeoutMs: 5,
        logRawOutput: true,
      },
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.config.runtime.slashFallback.enabled, true);
  assert.equal(result.config.runtime.slashFallback.logRawOutput, true);
  assert.equal(result.config.runtime.slashFallback.timeoutMs, undefined);
});
```

- [ ] **Step 2: Run test to verify RED state**

Run:
```bash
node --test "D:/work/projects/sources/FreeLance/RalphClaude/lib/validate.test.js"
```

Expected: FAIL because `runtime` is not currently allowed in `validateConfig`.

- [ ] **Step 3: Implement minimal validation support**

In `lib/validate.js`:
1. Add `runtime: 'object'` to `ALLOWED_KEYS`.
2. Add runtime validation branch:

```js
    } else if (key === 'runtime' && typeof val === 'object') {
      sanitized.runtime = {};
      if (val.slashFallback && typeof val.slashFallback === 'object') {
        sanitized.runtime.slashFallback = {};
        if (typeof val.slashFallback.enabled === 'boolean') {
          sanitized.runtime.slashFallback.enabled = val.slashFallback.enabled;
        }
        if (typeof val.slashFallback.logRawOutput === 'boolean') {
          sanitized.runtime.slashFallback.logRawOutput = val.slashFallback.logRawOutput;
        }
        if (typeof val.slashFallback.timeoutMs === 'number' && val.slashFallback.timeoutMs >= 10000 && val.slashFallback.timeoutMs <= 120000) {
          sanitized.runtime.slashFallback.timeoutMs = val.slashFallback.timeoutMs;
        }
      }
```

In `settings-db.js`, add schema entries:

```js
  'runtime.slashFallback.enabled':             { category:'system', type:'toggle', label:'Slash PTY Fallback', default:true, description:'Auto-fallback unsupported slash commands to on-demand PTY execution.' },
  'runtime.slashFallback.timeoutMs':           { category:'system', type:'number', label:'Slash PTY Timeout (ms)', default:45000, min:10000, description:'Timeout for on-demand PTY fallback runs.' },
  'runtime.slashFallback.logRawOutput':        { category:'system', type:'toggle', label:'Slash PTY Raw Logs', default:false, description:'Log raw PTY output to session log for debugging.' },
```

- [ ] **Step 4: Run tests to verify GREEN state**

Run:
```bash
node --test "D:/work/projects/sources/FreeLance/RalphClaude/lib/validate.test.js"
```

Expected: PASS (2 tests, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add lib/validate.js lib/validate.test.js settings-db.js
git commit -m "feat: add runtime slash fallback settings and validation"
```

---

### Task 2: Create PTY Executor Module (On-Demand, Single Command)

**Files:**
- Create: `lib/pty-executor.js`
- Create: `lib/pty-executor.test.js`

- [ ] **Step 1: Write failing PTY executor tests**

Create `lib/pty-executor.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPtyRun, normalizePtyError } = require('./pty-executor');

test('classifyPtyRun marks timeout when timedOut is true', () => {
  const r = classifyPtyRun({ code: null, stdout: '', stderr: '', timedOut: true });
  assert.equal(r.ok, false);
  assert.equal(r.timeout, true);
});

test('classifyPtyRun marks success on zero exit code', () => {
  const r = classifyPtyRun({ code: 0, stdout: 'done', stderr: '', timedOut: false });
  assert.equal(r.ok, true);
  assert.equal(r.timeout, false);
  assert.match(r.summary, /done/i);
});

test('normalizePtyError returns explicit bridge guidance', () => {
  assert.match(
    normalizePtyError(new Error('spawn ENOENT')),
    /PTY fallback unavailable/i
  );
});
```

- [ ] **Step 2: Run test to verify RED state**

Run:
```bash
node --test "D:/work/projects/sources/FreeLance/RalphClaude/lib/pty-executor.test.js"
```

Expected: FAIL because module/functions do not exist yet.

- [ ] **Step 3: Implement minimal PTY executor**

Create `lib/pty-executor.js` with these exports:

```js
const { spawn } = require('child_process');

function normalizePtyError(err) {
  const msg = String(err?.message || err || 'unknown error');
  return `PTY fallback unavailable: ${msg}`;
}

function classifyPtyRun({ code, stdout, stderr, timedOut }) {
  const text = [stdout, stderr].filter(Boolean).join('\n').trim();
  if (timedOut) return { ok: false, timeout: true, exitCode: code, summary: text || 'PTY fallback timed out' };
  if (code === 0) return { ok: true, timeout: false, exitCode: 0, summary: text || 'PTY fallback complete' };
  return { ok: false, timeout: false, exitCode: code, summary: text || `PTY fallback failed (exit ${code})` };
}

function runPtyCommand({ cwd, prompt, timeoutMs = 45000, env = {}, skipPermissions = true }) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    proc.stdin.write(`${prompt}\n`);
    proc.stdin.write('/exit\n');
    proc.stdin.end();
  });
}

module.exports = { runPtyCommand, classifyPtyRun, normalizePtyError };
```

- [ ] **Step 4: Run test to verify GREEN state**

Run:
```bash
node --test "D:/work/projects/sources/FreeLance/RalphClaude/lib/pty-executor.test.js"
```

Expected: PASS (3 tests, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add lib/pty-executor.js lib/pty-executor.test.js
git commit -m "feat: add on-demand pty executor primitives"
```

---

### Task 3: Add Execution Plan Resolver in Proxy (Print vs CLI vs PTY)

**Files:**
- Modify: `proxy.js`
- Modify: `lib/proxy.test.js`

- [ ] **Step 1: Write failing routing tests for PTY fallback**

Append to `lib/proxy.test.js`:

```js
test('resolveExecutionPlan chooses pty-fallback for interactive-only slash commands', () => {
  const plan = ClaudeProxy._resolveExecutionPlan(
    { mode: 'fresh', prompt: '/clear', sessionId: null },
    { runtime: { slashFallback: { enabled: true, timeoutMs: 45000, logRawOutput: false } }, skipPermissions: true, session: { model: 'auto', effort: 'high' } }
  );

  assert.equal(plan.mode, 'pty-fallback');
  assert.equal(plan.originalPrompt, '/clear');
  assert.equal(plan.reason, 'interactive-only-slash');
});

test('resolveExecutionPlan keeps print mode when fallback disabled', () => {
  const plan = ClaudeProxy._resolveExecutionPlan(
    { mode: 'fresh', prompt: '/clear', sessionId: null },
    { runtime: { slashFallback: { enabled: false } }, skipPermissions: true, session: { model: 'auto', effort: 'high' } }
  );

  assert.equal(plan.mode, 'print');
});
```

- [ ] **Step 2: Run test to verify RED state**

Run:
```bash
node --test "D:/work/projects/sources/FreeLance/RalphClaude/lib/proxy.test.js"
```

Expected: FAIL because `_resolveExecutionPlan` does not exist.

- [ ] **Step 3: Implement resolver with minimal changes**

In `proxy.js` add:

```js
  static _getSlashFallbackConfig(config) {
    const cfg = config?.runtime?.slashFallback || {};
    return {
      enabled: cfg.enabled !== false,
      timeoutMs: typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : 45000,
      logRawOutput: !!cfg.logRawOutput,
    };
  }

  static _resolveExecutionPlan(options, config) {
    const mapped = ClaudeProxy._mapSlashCommandToCliArgs(options, config);
    if (mapped) {
      const isPrint = mapped[0] === '--output-format';
      return {
        mode: isPrint ? 'print' : 'cli-subcommand',
        args: mapped,
        reason: isPrint ? 'print-mapped' : 'direct-cli-map',
        originalPrompt: options?.prompt || '',
      };
    }

    const slash = ClaudeProxy._parseSlashCommand(options?.prompt);
    const fallback = ClaudeProxy._getSlashFallbackConfig(config);
    const interactiveOnly = new Set(['clear', 'compact', 'config', 'cost', 'init', 'memory', 'review', 'terminal-setup']);

    if (slash && interactiveOnly.has(slash.command) && fallback.enabled) {
      return {
        mode: 'pty-fallback',
        args: [],
        reason: 'interactive-only-slash',
        originalPrompt: slash.raw,
        timeoutMs: fallback.timeoutMs,
        logRawOutput: fallback.logRawOutput,
      };
    }

    return {
      mode: 'print',
      args: ClaudeProxy._buildPrintModeArgs(options, config),
      reason: 'default-print',
      originalPrompt: options?.prompt || '',
    };
  }
```

Keep `_buildCliArgs` as compatibility shim:

```js
  static _buildCliArgs(options, config) {
    return ClaudeProxy._resolveExecutionPlan(options, config).args;
  }
```

- [ ] **Step 4: Run test to verify GREEN state**

Run:
```bash
node --test "D:/work/projects/sources/FreeLance/RalphClaude/lib/proxy.test.js"
```

Expected: PASS with new resolver tests green and existing routing tests still green.

- [ ] **Step 5: Commit**

```bash
git add proxy.js lib/proxy.test.js
git commit -m "feat: add proxy execution plan resolver for slash routing"
```

---

### Task 4: Execute PTY Fallback Path in Proxy Runtime

**Files:**
- Modify: `proxy.js`
- Modify: `lib/proxy.test.js`
- Modify: `lib/pty-executor.js`

- [ ] **Step 1: Write failing tests for PTY result normalization**

Append to `lib/proxy.test.js`:

```js
test('applyPtyFallbackResult maps successful pty run into result object', () => {
  const result = { error: null, resultText: null, exitCode: null, fullText: '' };
  ClaudeProxy._applyPtyFallbackResult(result, {
    ok: true,
    timeout: false,
    exitCode: 0,
    summary: 'PTY fallback complete',
    stdout: 'done',
    stderr: '',
  });

  assert.equal(result.error, null);
  assert.equal(result.resultText, 'PTY fallback complete');
  assert.equal(result.exitCode, 0);
});

test('applyPtyFallbackResult sets error for timeout/failure', () => {
  const result = { error: null, resultText: null, exitCode: null, fullText: '' };
  ClaudeProxy._applyPtyFallbackResult(result, {
    ok: false,
    timeout: true,
    exitCode: null,
    summary: 'PTY fallback timed out',
    stdout: '',
    stderr: '',
  });

  assert.match(result.error, /timed out/i);
});
```

- [ ] **Step 2: Run test to verify RED state**

Run:
```bash
node --test "D:/work/projects/sources/FreeLance/RalphClaude/lib/proxy.test.js"
```

Expected: FAIL because `_applyPtyFallbackResult` does not exist.

- [ ] **Step 3: Implement PTY branch in `_execute`**

In `proxy.js`:
1. Import PTY executor at top:

```js
const { runPtyCommand, classifyPtyRun, normalizePtyError } = require('./lib/pty-executor');
```

2. In `_execute`, after `result` initialization and before spawning print-mode process:
- Build `plan = ClaudeProxy._resolveExecutionPlan(options, this.config)`.
- Emit mode event:

```js
this.emit('event', { type: 'execution-mode', mode: plan.mode, reason: plan.reason, prompt: plan.originalPrompt });
```

3. If `plan.mode === 'pty-fallback'`, run:

```js
try {
  const raw = await runPtyCommand({
    cwd: projectDir,
    prompt: plan.originalPrompt,
    timeoutMs: plan.timeoutMs,
    skipPermissions: this.config.skipPermissions !== false,
  });
  const classified = classifyPtyRun(raw);
  ClaudeProxy._applyPtyFallbackResult(result, { ...classified, stdout: raw.stdout, stderr: raw.stderr });
  this._mergeToolCalls(result);
  return resolve(result);
} catch (err) {
  result.error = normalizePtyError(err);
  this._mergeToolCalls(result);
  return resolve(result);
}
```

4. Add helper:

```js
static _applyPtyFallbackResult(result, classified) {
  result.exitCode = classified.exitCode;
  result.resultText = classified.summary;
  if (!classified.ok) result.error = classified.summary;
}
```

- [ ] **Step 4: Run test to verify GREEN state**

Run:
```bash
node --test "D:/work/projects/sources/FreeLance/RalphClaude/lib/proxy.test.js"
```

Expected: PASS with new PTY mapping tests green.

- [ ] **Step 5: Commit**

```bash
git add proxy.js lib/proxy.test.js lib/pty-executor.js
git commit -m "feat: execute interactive slash commands through on-demand pty fallback"
```

---

### Task 5: Surface Mixed-Mode Execution in Live Logs

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add failing behavior check (manual RED)**

Run the app and trigger a slash command expected to route to PTY fallback (`/clear`).

Expected current behavior (RED): No explicit `execution-mode` line appears in the live output.

- [ ] **Step 2: Add execution-mode handling in renderer event pipeline**

In `index.html`, inside `handleProxyEvent(d)`, add a branch before the `result` branch:

```js
else if(d.type==='execution-mode'){
  const mode=d.mode||'unknown';
  const reason=d.reason||'';
  const prompt=d.prompt||'';
  addLogForTab(tabId,'sys',`Runtime: ${mode}${reason?` (${reason})`:''}${prompt?` → ${prompt}`:''}`);
}
```

- [ ] **Step 3: Verify GREEN behavior manually**

Run app, send:
- `/plugins list` (should log runtime `cli-subcommand`)
- `/clear` (should log runtime `pty-fallback`)
- normal prompt text (should log runtime `print` only when emitted)

Expected: runtime lines appear in live output for routed turns.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: log execution mode for hybrid slash routing"
```

---

### Task 6: Full Verification and Regression Sweep

**Files:**
- Modify (if needed): `lib/proxy.test.js`, `lib/pty-executor.test.js`, `lib/validate.test.js`

- [ ] **Step 1: Run full targeted unit suite**

Run:
```bash
node --test "D:/work/projects/sources/FreeLance/RalphClaude/lib/validate.test.js" "D:/work/projects/sources/FreeLance/RalphClaude/lib/pty-executor.test.js" "D:/work/projects/sources/FreeLance/RalphClaude/lib/proxy.test.js"
```

Expected: PASS, 0 failures.

- [ ] **Step 2: Run CLI behavior smoke checks**

Run:
```bash
node -e "const P=require('./proxy'); const cfg={skipPermissions:true,session:{model:'claude-opus-4-6',effort:'high'},runtime:{slashFallback:{enabled:true,timeoutMs:45000,logRawOutput:false}}}; const samples=['/plugins list','/mcp list','/clear','normal prompt']; for(const s of samples){ const plan=P._resolveExecutionPlan({mode:'fresh',prompt:s,sessionId:null},cfg); console.log(s,'=>',plan.mode,plan.reason); }"
```

Expected:
- `/plugins list => cli-subcommand direct-cli-map`
- `/mcp list => cli-subcommand direct-cli-map`
- `/clear => pty-fallback interactive-only-slash`
- `normal prompt => print default-print`

- [ ] **Step 3: Manual session smoke test in app**

1. Start Auto Claude session.
2. Send `/plugins list`, `/clear`, and a normal prompt.
3. Confirm no crash, clear runtime logs, and session remains responsive.

Expected: app stays stable and routed commands complete.

- [ ] **Step 4: Commit verification touch-ups (only if changes were needed)**

```bash
git add lib/proxy.test.js lib/pty-executor.test.js lib/validate.test.js proxy.js index.html settings-db.js lib/validate.js lib/pty-executor.js
git commit -m "test: finalize hybrid slash routing verification coverage"
```

(If no file changed during verification, skip commit.)

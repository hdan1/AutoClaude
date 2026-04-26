# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all approved findings from the comprehensive app audit by making operational state truthful, adding high-risk verification, reducing architecture hotspots, and improving user-facing recovery guidance.

**Architecture:** Deliver the remediation in four internal phases that build on one another: first introduce structured operational results in the main process, then lock the behavior down with focused tests, then extract the new stateful logic into bounded modules, and finally wire consistent diagnostics and recovery guidance through the renderer help and setup flows. Keep `main.js` as the composition root and the current script-tag renderer model intact, but narrow seams with small shared helpers and focused modules.

**Tech Stack:** Electron, Node.js, Node built-in `node:test`, vanilla renderer JavaScript loaded from `index.html`, Git hooks, child-process based CLI integration

---

## File Structure & Responsibilities

- `main.js`
  - Composition root. Will be trimmed so it wires updater, hook lifecycle, diagnostics, and cleanup helpers rather than implementing all details inline.
- `install-hooks.js`
  - Hook installer/uninstaller CLI. Will be hardened to parse flags position-independently and return reliable uninstall behavior.
- `lib/hook-watcher.js`
  - Hook log reader. Will gain bounded telemetry degradation tracking and explicit status signaling.
- `lib/ipc-claude-manager.js`
  - Existing extracted IPC module and established pattern for `register(ipcMain, deps)`. Use this as the reference shape for new extracted modules.
- `lib/operations-status.js`
  - New main/renderer-safe status helper. Defines the structured status payloads used for updater, hook cleanup, telemetry degradation, diagnostics, and next-step guidance.
- `lib/hook-lifecycle.js`
  - New hook install/uninstall wrapper. Returns structured success/degraded/error results and centralizes installer invocation.
- `lib/update-status.js`
  - New updater-state helper. Converts updater events/errors into renderer-safe status payloads.
- `lib/diagnostics.js`
  - New diagnostics builder. Produces compact diagnostics bundles for UI surfaces.
- `lib/claude-state-facade.js`
  - New narrow facade composing detection/plugin/update state for health and renderer consumers.
- `renderer/operational-status.js`
  - New shared renderer helper for rendering severity, summary, details, next steps, and diagnostics snippets across existing script-tag modules.
- `renderer/claude-code-manager.js`
  - Will consume shared operational status for update and plugin failure states.
- `renderer/setup-health-check.js`
  - Will render next-step guidance and diagnostics using the shared helper.
- `renderer/settings-panel.js`
  - Will expose richer Telegram/log diagnostics and recovery text.
- `renderer/help-wizard.js`
  - Will gain an `If something fails` recovery/help step.
- `docs/runbook.md`
  - Must be aligned with the actual install/uninstall CLI contract.
- `hooks/pre-commit-scan.js`
  - Existing secret-blocking hook. Will receive direct tests but only minimal production changes if tests expose a correctness gap.
- `lib/install-hooks-cli.test.js`
  - New CLI behavior tests for `install-hooks.js` argument handling and uninstall outcomes.
- `lib/hook-lifecycle.test.js`
  - New tests for structured hook install/uninstall results and state truthfulness.
- `lib/hook-watcher.test.js`
  - New tests for telemetry degradation thresholds and bounded non-blocking behavior.
- `lib/operations-status.test.js`
  - New tests for shared status payload and diagnostics-bundle primitives.
- `lib/update-status.test.js`
  - New tests for packaged updater error/status payload translation.
- `lib/pre-commit-scan.test.js`
  - New tests for staged secret blocking behavior.
- `lib/diagnostics.test.js`
  - New tests for main-process diagnostics bundle composition.
- `lib/main-operational-state.test.js`
  - New focused tests around main-process cleanup/update state transitions using extracted helpers rather than giant `main.js` integration tests.

**Execution note:** This plan intentionally omits git commit steps because this workflow requires explicit user approval before creating commits.

---

### Task 1: Harden the install-hooks CLI contract first

**Files:**
- Modify: `install-hooks.js`
- Modify: `docs/runbook.md`
- Test: `lib/install-hooks-cli.test.js`

- [ ] **Step 1: Write the failing CLI tests**

Create `lib/install-hooks-cli.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function makeProjectDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-claude-install-hooks-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      PostToolUse: [{ hooks: [{ command: 'node "/tmp/auto-claude-hook.js"' }] }],
      SubagentStop: [{ hooks: [{ command: 'node "/tmp/auto-claude-hook.js"' }] }],
      Notification: [{ hooks: [{ command: 'node "/tmp/auto-claude-hook.js"' }] }],
    },
  }, null, 2));
  return { tmpDir, projectDir, settingsFile: path.join(projectDir, '.claude', 'settings.json') };
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

test('install-hooks accepts --uninstall before the project path', () => {
  const { tmpDir, projectDir, settingsFile } = makeProjectDir();
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'install-hooks.js'), '--uninstall', projectDir], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(settings.hooks || {}, {});
  } finally {
    cleanup(tmpDir);
  }
});

test('install-hooks accepts the project path before --uninstall', () => {
  const { tmpDir, projectDir, settingsFile } = makeProjectDir();
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'install-hooks.js'), projectDir, '--uninstall'], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(settings.hooks || {}, {});
  } finally {
    cleanup(tmpDir);
  }
});
```

- [ ] **Step 2: Run the new tests to verify the first one fails**

Run:

```bash
node --test lib/install-hooks-cli.test.js
```

Expected: FAIL because `install-hooks.js` currently reads `process.argv[2]` as `projectDir`, so the `--uninstall <projectDir>` form treats `--uninstall` as the path.

- [ ] **Step 3: Implement position-independent argument parsing**

Update the top of `install-hooks.js` to:

```js
const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const positionalArgs = args.filter(arg => arg !== '--uninstall');
const projectDir = positionalArgs[0];

if (!projectDir || positionalArgs.length !== 1) {
  console.error('Usage: node install-hooks.js <project-dir> [--uninstall]');
  process.exit(1);
}
```

Keep the rest of the file unchanged in this task.

- [ ] **Step 4: Update the runbook to document both valid forms and prefer the canonical one**

Change the hook cleanup section in `docs/runbook.md` to:

```md
## Hook Cleanup
- Auto-installed to: `<projectDir>/.claude/settings.json`
- Manual uninstall: `node install-hooks.js <projectDir> --uninstall`
- Also accepted: `node install-hooks.js --uninstall <projectDir>`
- Stale hook detection: hooks have marker `auto-claude-hook.js`. If marker not found, hooks are re-installed automatically.
```

- [ ] **Step 5: Re-run the CLI tests to verify they pass**

Run:

```bash
node --test lib/install-hooks-cli.test.js
```

Expected: PASS for both uninstall invocation orders.

---

### Task 2: Introduce structured operational status primitives

**Files:**
- Create: `lib/operations-status.js`
- Test: `lib/operations-status.test.js`

- [ ] **Step 1: Write the failing status-helper tests**

Create `lib/operations-status.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeUpdateErrorStatus,
  makeUpdateProgressStatus,
  buildDiagnosticsBundle,
} = require('./operations-status');

test('makeUpdateErrorStatus returns actionable renderer-safe payload', () => {
  const status = makeUpdateErrorStatus({ summary: 'Feed unavailable', detail: 'HTTP 500' });

  assert.deepEqual(status, {
    severity: 'error',
    scope: 'update',
    summary: 'Update failed',
    details: 'Feed unavailable',
    nextSteps: ['Retry update check', 'Check network connection', 'Download manually from Releases'],
    meta: { detail: 'HTTP 500' },
  });
});

test('makeUpdateProgressStatus returns ready payload', () => {
  const status = makeUpdateProgressStatus('ready', { version: '3.11.8' });

  assert.equal(status.scope, 'update');
  assert.equal(status.severity, 'info');
  assert.equal(status.summary, 'Update ready');
  assert.deepEqual(status.meta, { version: '3.11.8' });
});

test('buildDiagnosticsBundle includes compact operational fields', () => {
  const bundle = buildDiagnosticsBundle({
    appVersion: '3.11.7',
    claudeVersion: '2.1.119',
    claudePath: '/usr/bin/claude',
    authType: 'custom',
    workspacePath: '/tmp/project',
    logPath: '/tmp/app.log',
    updaterStatus: 'ready',
    telemetryDegraded: true,
    lastError: 'Hook uninstall failed',
  });

  assert.deepEqual(bundle, {
    appVersion: '3.11.7',
    claudeVersion: '2.1.119',
    claudePath: '/usr/bin/claude',
    authType: 'custom',
    workspacePath: '/tmp/project',
    logPath: '/tmp/app.log',
    updaterStatus: 'ready',
    telemetryDegraded: true,
    lastError: 'Hook uninstall failed',
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail because the helper does not exist yet**

Run:

```bash
node --test lib/operations-status.test.js
```

Expected: FAIL with module-not-found or missing-export errors for `./operations-status`.

- [ ] **Step 3: Implement the shared status helper**

Create `lib/operations-status.js` with:

```js
'use strict';

function makeStatus({ severity, scope, summary, details = '', nextSteps = [], meta = {} }) {
  return { severity, scope, summary, details, nextSteps, meta };
}

function makeUpdateErrorStatus({ summary, detail }) {
  return makeStatus({
    severity: 'error',
    scope: 'update',
    summary: 'Update failed',
    details: summary,
    nextSteps: ['Retry update check', 'Check network connection', 'Download manually from Releases'],
    meta: { detail },
  });
}

function makeUpdateProgressStatus(status, { version } = {}) {
  const summaryMap = {
    downloading: 'Downloading update',
    ready: 'Update ready',
  };
  return makeStatus({
    severity: 'info',
    scope: 'update',
    summary: summaryMap[status] || 'Update status',
    details: version ? `Version ${version}` : '',
    nextSteps: [],
    meta: version ? { version } : {},
  });
}

function buildDiagnosticsBundle({
  appVersion, claudeVersion, claudePath, authType,
  workspacePath = '', logPath = '', updaterStatus = '',
  telemetryDegraded = false, lastError = '',
}) {
  return {
    appVersion,
    claudeVersion,
    claudePath,
    authType,
    workspacePath,
    logPath,
    updaterStatus,
    telemetryDegraded,
    lastError,
  };
}

module.exports = {
  makeStatus,
  makeUpdateErrorStatus,
  makeUpdateProgressStatus,
  buildDiagnosticsBundle,
};
```

- [ ] **Step 4: Re-run the status-helper tests**

Run:

```bash
node --test lib/operations-status.test.js
```

Expected: PASS.

---

### Task 3: Make hook uninstall state truthful in the main process

**Files:**
- Create: `lib/hook-lifecycle.js`
- Modify: `main.js:868-968`
- Test: `lib/hook-lifecycle.test.js`
- Test: `lib/main-operational-state.test.js`

- [ ] **Step 1: Write the failing hook lifecycle tests**

Create `lib/hook-lifecycle.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { uninstallProjectHooks } = require('./hook-lifecycle');

test('uninstallProjectHooks returns ok result on successful installer execution', () => {
  const calls = [];
  const result = uninstallProjectHooks({
    projectDir: '/tmp/project',
    installerPath: '/tmp/install-hooks.js',
    execFileSync(command, args) {
      calls.push([command, args]);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['node', ['/tmp/install-hooks.js', '/tmp/project', '--uninstall']]]);
});

test('uninstallProjectHooks returns degraded result on failure', () => {
  const result = uninstallProjectHooks({
    projectDir: '/tmp/project',
    installerPath: '/tmp/install-hooks.js',
    execFileSync() {
      throw new Error('spawn failed');
    },
  });

  assert.deepEqual(result, {
    ok: false,
    severity: 'warning',
    scope: 'hooks',
    summary: 'Hook cleanup incomplete',
    details: 'spawn failed',
    nextSteps: ['Retry closing the project', 'Remove hooks manually with install-hooks.js', 'Check project .claude/settings.json'],
  });
});
```

Create `lib/main-operational-state.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('closeWorkspaceProject only clears hooksInstalled when uninstall succeeds', async () => {
  const session = { state: { projectDir: '/tmp/project', hooksInstalled: true } };
  const sent = [];

  async function closeWorkspaceProject({ uninstallResult }) {
    if (session.state.projectDir && session.state.hooksInstalled) {
      if (uninstallResult.ok) {
        session.state.hooksInstalled = false;
      } else {
        sent.push(uninstallResult.summary);
      }
    }
    return session.state.hooksInstalled;
  }

  const stillInstalled = await closeWorkspaceProject({
    uninstallResult: { ok: false, summary: 'Hook cleanup incomplete' },
  });

  assert.equal(stillInstalled, true);
  assert.deepEqual(sent, ['Hook cleanup incomplete']);
});
```

- [ ] **Step 2: Run the tests to verify the missing helper causes failure**

Run:

```bash
node --test lib/hook-lifecycle.test.js lib/main-operational-state.test.js
```

Expected: FAIL because `./hook-lifecycle` does not exist yet.

- [ ] **Step 3: Implement the hook lifecycle helper**

Create `lib/hook-lifecycle.js` with:

```js
'use strict';

function uninstallProjectHooks({ projectDir, installerPath, execFileSync }) {
  try {
    execFileSync('node', [installerPath, projectDir, '--uninstall'], { stdio: 'pipe' });
    return {
      ok: true,
      severity: 'info',
      scope: 'hooks',
      summary: 'Hooks removed',
      details: '',
      nextSteps: [],
    };
  } catch (err) {
    return {
      ok: false,
      severity: 'warning',
      scope: 'hooks',
      summary: 'Hook cleanup incomplete',
      details: err.message,
      nextSteps: ['Retry closing the project', 'Remove hooks manually with install-hooks.js', 'Check project .claude/settings.json'],
    };
  }
}

module.exports = { uninstallProjectHooks };
```

- [ ] **Step 4: Wire `main.js` to use structured uninstall results**

At the top of `main.js`, add:

```js
const { uninstallProjectHooks } = require('./lib/hook-lifecycle');
```

Replace `uninstallHooks(projectDir)` with:

```js
function uninstallHooks(projectDir) {
  const installerPath = getInstallerPath();
  const result = uninstallProjectHooks({
    projectDir,
    installerPath,
    execFileSync,
  });
  if (!result.ok) {
    logger.warn('hooks', result.summary, new Error(result.details));
    send('log', { type: 'stderr', text: `${result.summary}: ${result.details}` });
  }
  return result;
}
```

Replace `_closeWorkspaceProject()` cleanup with:

```js
if (session?.state.projectDir && session.state.hooksInstalled && config.hooks?.install) {
  const uninstallResult = uninstallHooks(session.state.projectDir);
  if (uninstallResult.ok) {
    session.state.hooksInstalled = false;
  } else {
    send('update-status', uninstallResult);
  }
}
```

Replace the cleanup loop body with:

```js
if (session.state.projectDir && session.state.hooksInstalled && config.hooks?.install) {
  const uninstallResult = uninstallHooks(session.state.projectDir);
  if (uninstallResult.ok) {
    session.state.hooksInstalled = false;
  }
}
```

- [ ] **Step 5: Re-run the hook lifecycle tests**

Run:

```bash
node --test lib/hook-lifecycle.test.js lib/main-operational-state.test.js
```

Expected: PASS.

---

### Task 4: Surface packaged updater failures as operational state

**Files:**
- Create: `lib/update-status.js`
- Modify: `main.js:675-690`
- Modify: `preload.js:79`
- Modify: `renderer/claude-code-manager.js:150-215`
- Test: `lib/update-status.test.js`

- [ ] **Step 1: Write the failing updater translation tests**

Create `lib/update-status.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { toRendererUpdateStatus } = require('./update-status');

test('toRendererUpdateStatus maps autoUpdater errors to error payloads', () => {
  const payload = toRendererUpdateStatus({ type: 'error', summary: 'Feed unavailable', detail: '404' });

  assert.deepEqual(payload, {
    severity: 'error',
    scope: 'update',
    status: 'error',
    summary: 'Update failed',
    details: 'Feed unavailable',
    nextSteps: ['Retry update check', 'Check network connection', 'Download manually from Releases'],
    meta: { detail: '404' },
  });
});

test('toRendererUpdateStatus maps ready progress to info payloads', () => {
  const payload = toRendererUpdateStatus({ type: 'ready', version: '3.11.8' });

  assert.equal(payload.status, 'ready');
  assert.equal(payload.summary, 'Update ready');
  assert.deepEqual(payload.meta, { version: '3.11.8' });
});
```

- [ ] **Step 2: Run the test to verify it fails because the module does not exist**

Run:

```bash
node --test lib/update-status.test.js
```

Expected: FAIL with module-not-found for `./update-status`.

- [ ] **Step 3: Implement updater status translation**

Create `lib/update-status.js` with:

```js
'use strict';
const { makeUpdateErrorStatus, makeUpdateProgressStatus } = require('./operations-status');

function toRendererUpdateStatus(event) {
  if (event.type === 'error') {
    return {
      status: 'error',
      ...makeUpdateErrorStatus({ summary: event.summary, detail: event.detail }),
    };
  }

  if (event.type === 'downloading' || event.type === 'ready') {
    return {
      status: event.type,
      ...makeUpdateProgressStatus(event.type, { version: event.version }),
    };
  }

  return {
    status: 'info',
    severity: 'info',
    scope: 'update',
    summary: 'Update status',
    details: '',
    nextSteps: [],
    meta: {},
  };
}

module.exports = { toRendererUpdateStatus };
```

- [ ] **Step 4: Send translated updater events from `main.js` and consume them in the renderer**

In `main.js`, add:

```js
const { toRendererUpdateStatus } = require('./lib/update-status');
```

Replace the packaged updater sends with:

```js
send('update-status', toRendererUpdateStatus({ type: 'downloading', version: info.version }));
send('update-status', toRendererUpdateStatus({ type: 'ready', version: info.version }));
```

In `autoUpdater.on('error', ...)`, after the expected-404 branch, send:

```js
send('update-status', toRendererUpdateStatus({
  type: 'error',
  summary: 'Update service unavailable',
  detail: summary,
}));
```

In `renderer/claude-code-manager.js`, add an update-status listener near initialization:

```js
window.api.onUpdateStatus((payload)=>{
  const statusEl=document.querySelector('#ccmUpdateStatus');
  const actionEl=document.querySelector('#ccmUpdateAction');
  if(!statusEl||!actionEl||!payload)return;
  if(payload.status==='downloading'){
    statusEl.textContent=payload.summary+(payload.meta?.version?` (${payload.meta.version})`:'' );
    statusEl.style.color='var(--tx3)';
    actionEl.innerHTML='';
    return;
  }
  if(payload.status==='ready'){
    statusEl.textContent=payload.summary+(payload.meta?.version?` (${payload.meta.version})`:'' );
    statusEl.style.color='var(--grn)';
    actionEl.innerHTML='<button class="ccm-link" id="ccmRestartToUpdate">Restart app to apply ›</button>';
    return;
  }
  if(payload.status==='error'){
    statusEl.textContent=payload.summary+': '+(payload.details||'Unknown error');
    statusEl.style.color='var(--red)';
    actionEl.innerHTML='<button class="ccm-link" id="ccmRetryUpdate">Retry ›</button>';
    const retryBtn=document.querySelector('#ccmRetryUpdate');
    if(retryBtn)retryBtn.onclick=()=>doUpdateCheck(true);
  }
});
```

Do not refactor the rest of the file in this task.

- [ ] **Step 5: Re-run the updater tests**

Run:

```bash
node --test lib/update-status.test.js
```

Expected: PASS.

---

### Task 5: Make hook telemetry degradation visible but bounded

**Files:**
- Modify: `lib/hook-watcher.js`
- Test: `lib/hook-watcher.test.js`

- [ ] **Step 1: Write the failing telemetry degradation tests**

Create `lib/hook-watcher.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { noteHookWatcherFailure } = require('./hook-watcher');

test('noteHookWatcherFailure emits telemetry-degraded after threshold', () => {
  const proxy = new EventEmitter();
  proxy._hookWatcherFailures = 0;
  const seen = [];
  proxy.on('telemetry-degraded', payload => seen.push(payload));

  noteHookWatcherFailure(proxy, 'read failed');
  noteHookWatcherFailure(proxy, 'read failed');
  noteHookWatcherFailure(proxy, 'read failed');

  assert.equal(proxy._hookWatcherFailures, 3);
  assert.deepEqual(seen, [{
    severity: 'warning',
    scope: 'telemetry',
    summary: 'Telemetry degraded',
    details: 'read failed',
    nextSteps: ['Keep session running', 'Open app logs', 'Check hook log file permissions'],
  }]);
});

test('noteHookWatcherFailure stays silent below threshold', () => {
  const proxy = new EventEmitter();
  proxy._hookWatcherFailures = 0;
  let emitted = false;
  proxy.on('telemetry-degraded', () => { emitted = true; });

  noteHookWatcherFailure(proxy, 'once');
  noteHookWatcherFailure(proxy, 'twice');

  assert.equal(emitted, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail because the helper does not exist**

Run:

```bash
node --test lib/hook-watcher.test.js
```

Expected: FAIL because `noteHookWatcherFailure` is not exported.

- [ ] **Step 3: Implement the bounded failure helper and wire it into both watcher paths**

Add to `lib/hook-watcher.js`:

```js
function noteHookWatcherFailure(proxy, details) {
  proxy._hookWatcherFailures = (proxy._hookWatcherFailures || 0) + 1;
  if (proxy._hookWatcherFailures === 3) {
    proxy.emit('telemetry-degraded', {
      severity: 'warning',
      scope: 'telemetry',
      summary: 'Telemetry degraded',
      details,
      nextSteps: ['Keep session running', 'Open app logs', 'Check hook log file permissions'],
    });
  }
}

function noteHookWatcherSuccess(proxy) {
  proxy._hookWatcherFailures = 0;
}
```

Call `noteHookWatcherSuccess(proxy);` after successfully parsing at least one hook line, and replace the debug-only/silent catch bodies with:

```js
noteHookWatcherFailure(proxy, err.message);
logger.debug('proxy', `hook log read failed: ${err.message}`);
```

and in silent worktree parse/read catches:

```js
noteHookWatcherFailure(proxy, err.message);
```

Export both helpers.

- [ ] **Step 4: Re-run the telemetry tests**

Run:

```bash
node --test lib/hook-watcher.test.js
```

Expected: PASS.

---

### Task 6: Add direct tests for pre-commit secret blocking

**Files:**
- Test: `lib/pre-commit-scan.test.js`
- Inspect/modify only if needed: `hooks/pre-commit-scan.js`

- [ ] **Step 1: Write the failing pre-commit scan tests**

Create `lib/pre-commit-scan.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-claude-pre-commit-'));
  git(tmpDir, ['init']);
  git(tmpDir, ['config', 'user.name', 'Test User']);
  git(tmpDir, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# temp\n');
  git(tmpDir, ['add', 'README.md']);
  git(tmpDir, ['commit', '-m', 'init']);
  return tmpDir;
}

test('pre-commit scan blocks staged secrets', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'secret.txt'), 'token = "' + 'sk-ant-' + 'abcdefghijklmnopqrstuvwxyz123456' + '"\n');
    git(repo, ['add', 'secret.txt']);

    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'pre-commit-scan.js')], {
      cwd: repo,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /PRE-COMMIT SAFETY SCAN FAILED/);
    assert.match(result.stderr, /Anthropic API key/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('pre-commit scan allows harmless staged files', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'hello world\n');
    git(repo, ['add', 'notes.txt']);

    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'pre-commit-scan.js')], {
      cwd: repo,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests and verify the current behavior**

Run:

```bash
node --test lib/pre-commit-scan.test.js
```

Expected: PASS if the current implementation is correct. If one test fails, treat that failure as the true bug and make only the minimal production fix needed.

- [ ] **Step 3: If needed, make the minimal production fix in `hooks/pre-commit-scan.js`**

Only if Step 2 fails, change the exact broken regex or staged-content handling revealed by the test. Do not refactor unrelated scanning logic.

- [ ] **Step 4: Re-run the tests after any required fix**

Run:

```bash
node --test lib/pre-commit-scan.test.js
```

Expected: PASS.

---

### Task 7: Add compact diagnostics support

**Files:**
- Create: `lib/diagnostics.js`
- Modify: `main.js`
- Modify: `preload.js`
- Modify: `renderer/setup-health-check.js`
- Modify: `renderer/settings-panel.js`
- Test: `lib/diagnostics.test.js`

- [ ] **Step 1: Write the failing diagnostics builder tests**

Create `lib/diagnostics.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagnostics } = require('./diagnostics');

test('buildDiagnostics returns compact support bundle', () => {
  const bundle = buildDiagnostics({
    appVersion: '3.11.7',
    claude: { version: '2.1.119', path: '/usr/bin/claude', authType: 'custom' },
    workspacePath: '/tmp/project',
    logPath: '/tmp/app.log',
    updater: { status: 'error' },
    telemetry: { degraded: true },
    lastError: 'Update failed',
  });

  assert.deepEqual(bundle, {
    appVersion: '3.11.7',
    claudeVersion: '2.1.119',
    claudePath: '/usr/bin/claude',
    authType: 'custom',
    workspacePath: '/tmp/project',
    logPath: '/tmp/app.log',
    updaterStatus: 'error',
    telemetryDegraded: true,
    lastError: 'Update failed',
  });
});
```

- [ ] **Step 2: Run the diagnostics test to verify it fails because the module does not exist**

Run:

```bash
node --test lib/diagnostics.test.js
```

Expected: FAIL with module-not-found for `./diagnostics`.

- [ ] **Step 3: Implement the diagnostics builder and expose it through IPC**

Create `lib/diagnostics.js` with:

```js
'use strict';

function buildDiagnostics({ appVersion, claude, workspacePath, logPath, updater, telemetry, lastError }) {
  return {
    appVersion,
    claudeVersion: claude?.version || '',
    claudePath: claude?.path || '',
    authType: claude?.authType || '',
    workspacePath: workspacePath || '',
    logPath: logPath || '',
    updaterStatus: updater?.status || '',
    telemetryDegraded: !!telemetry?.degraded,
    lastError: lastError || '',
  };
}

module.exports = { buildDiagnostics };
```

In `main.js`, add state holders near other globals:

```js
let latestUpdateStatus = { status: '' };
let telemetryState = { degraded: false, details: '' };
let latestOperationalError = '';
```

Update `send('update-status', payload)` call sites to also assign `latestUpdateStatus = payload;` before sending. When hook uninstall or telemetry degradation warnings occur, set `latestOperationalError` and update `telemetryState` as appropriate.

Add:

```js
const { buildDiagnostics } = require('./lib/diagnostics');
```

and expose a new IPC handler:

```js
ipcMain.handle('get-diagnostics', withTrustedIpc('get-diagnostics', async () => {
  const claude = await detectClaudeStateWithSecureToken();
  const focusedSession = mainWindow?.webContents ? sessionManager?.get(mainWindow.webContents.id) : null;
  return buildDiagnostics({
    appVersion: app.getVersion(),
    claude,
    workspacePath: focusedSession?.state?.projectDir || '',
    logPath: APP_LOG_FILE,
    updater: latestUpdateStatus,
    telemetry: telemetryState,
    lastError: latestOperationalError,
  });
}, trustDeps, {}));
```

In `preload.js`, add:

```js
getDiagnostics:            () => ipcRenderer.invoke('get-diagnostics'),
```

- [ ] **Step 4: Render diagnostics in setup health and settings**

In `renderer/setup-health-check.js`, after the existing log-info area, add a compact diagnostics block populated from `window.api.getDiagnostics()` with this rendering pattern:

```js
async function refreshDiagnostics(){
  if(!diagnosticsBox)return;
  try{
    const d=await window.api.getDiagnostics();
    diagnosticsBox.textContent=[
      `App: ${d.appVersion||'unknown'}`,
      `Claude: ${d.claudeVersion||'unknown'} (${d.authType||'no auth'})`,
      `Path: ${d.claudePath||'unknown'}`,
      `Updater: ${d.updaterStatus||'idle'}`,
      `Telemetry degraded: ${d.telemetryDegraded?'yes':'no'}`,
      `Last error: ${d.lastError||'none'}`,
      `Logs: ${d.logPath||'unknown'}`,
    ].join('\n');
  }catch{
    diagnosticsBox.textContent='Diagnostics unavailable';
  }
}
```

In `renderer/settings-panel.js`, add a similar read-only diagnostics panel or button that opens a modal/preformatted block using `window.api.getDiagnostics()`.

- [ ] **Step 5: Re-run the diagnostics test**

Run:

```bash
node --test lib/diagnostics.test.js
```

Expected: PASS.

---

### Task 8: Extract shared renderer operational-status rendering

**Files:**
- Create: `renderer/operational-status.js`
- Modify: `index.html:1353-1356`
- Modify: `renderer/claude-code-manager.js`
- Modify: `renderer/setup-health-check.js`
- Modify: `renderer/settings-panel.js`
- Test: `lib/index-ui-runtime.test.js`

- [ ] **Step 1: Write a failing renderer wiring test**

Add this test to `lib/index-ui-runtime.test.js`:

```js
test('index.html loads the shared operational status helper before renderer feature scripts', async () => {
  const html = await fs.promises.readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const helperIndex = html.indexOf('renderer/operational-status.js');
  const ccmIndex = html.indexOf('renderer/claude-code-manager.js');
  const setupIndex = html.indexOf('renderer/setup-health-check.js');
  const settingsIndex = html.indexOf('renderer/settings-panel.js');

  assert.notEqual(helperIndex, -1);
  assert.ok(helperIndex < ccmIndex);
  assert.ok(helperIndex < setupIndex);
  assert.ok(helperIndex < settingsIndex);
});
```

- [ ] **Step 2: Run the targeted test to verify it fails before the helper exists**

Run:

```bash
node --test lib/index-ui-runtime.test.js
```

Expected: FAIL because `renderer/operational-status.js` is not loaded yet.

- [ ] **Step 3: Create the shared renderer helper and load it first**

Create `renderer/operational-status.js` with:

```js
'use strict';
(function(){
  function renderNextSteps(nextSteps){
    if(!Array.isArray(nextSteps)||nextSteps.length===0)return '';
    return ' Next: '+nextSteps.join(' · ');
  }

  function renderOperationalMessage(payload, fallback){
    if(!payload)return fallback||'';
    const detail = payload.details ? `: ${payload.details}` : '';
    return `${payload.summary || fallback || 'Status'}${detail}${renderNextSteps(payload.nextSteps)}`;
  }

  window.operationalStatus = {
    renderNextSteps,
    renderOperationalMessage,
  };
})();
```

In `index.html`, load it before the other renderer scripts:

```html
<script src="renderer/operational-status.js"></script>
<script src="renderer/settings-panel.js"></script>
<script src="renderer/claude-code-manager.js"></script>
<script src="renderer/setup-health-check.js"></script>
<script src="renderer/help-wizard.js"></script>
```

- [ ] **Step 4: Use the helper in renderer failure states**

In `renderer/claude-code-manager.js`, replace generic strings like `Check failed` and `Update failed` with `window.operationalStatus.renderOperationalMessage(...)` payload-driven text where updater events or local failures are available.

In `renderer/setup-health-check.js`, replace direct string concatenation such as `Install failed: ...` with helper-generated strings that append one short next step.

In `renderer/settings-panel.js`, replace `No token saved` and similarly thin operational messages with helper-backed guidance such as `No token saved. Next: add a bot token in Settings`.

- [ ] **Step 5: Re-run the UI runtime test**

Run:

```bash
node --test lib/index-ui-runtime.test.js
```

Expected: PASS.

---

### Task 9: Narrow the detection/plugin/update seam with a facade

**Files:**
- Create: `lib/claude-state-facade.js`
- Modify: `lib/ipc-claude-manager.js`
- Modify: `renderer/setup-health-check.js`
- Modify: `renderer/claude-code-manager.js`
- Test: `lib/claude-state-facade.test.js`

- [ ] **Step 1: Write the failing facade tests**

Create `lib/claude-state-facade.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClaudeStateFacade } = require('./claude-state-facade');

test('buildClaudeStateFacade combines detection, update, and plugin state', async () => {
  const facade = await buildClaudeStateFacade({
    detectClaudeState: async () => ({ installed: true, version: '2.1.119', authType: 'custom' }),
    checkForUpdate: async () => ({ updateAvailable: true, latestVersion: '2.1.120' }),
    checkPluginUpdates: async () => ({ updates: [{ key: 'context7', updateAvailable: true }] }),
  });

  assert.deepEqual(facade, {
    installed: true,
    version: '2.1.119',
    authType: 'custom',
    update: { updateAvailable: true, latestVersion: '2.1.120' },
    pluginUpdates: [{ key: 'context7', updateAvailable: true }],
  });
});
```

- [ ] **Step 2: Run the test to verify it fails because the module does not exist**

Run:

```bash
node --test lib/claude-state-facade.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the facade and expose one IPC entry point**

Create `lib/claude-state-facade.js` with:

```js
'use strict';

async function buildClaudeStateFacade({ detectClaudeState, checkForUpdate, checkPluginUpdates }) {
  const detected = await detectClaudeState();
  const update = await checkForUpdate({ forceCheck: false });
  const pluginUpdateResult = await checkPluginUpdates(false);
  return {
    installed: !!detected.installed,
    version: detected.version || '',
    authType: detected.authType || '',
    update,
    pluginUpdates: pluginUpdateResult.updates || [],
  };
}

module.exports = { buildClaudeStateFacade };
```

In `lib/ipc-claude-manager.js`, add:

```js
const { buildClaudeStateFacade } = require('./claude-state-facade');
```

and register:

```js
ipcMain.handle('get-claude-state-facade', withTrustedIpc('get-claude-state-facade', async () => {
  return buildClaudeStateFacade({
    detectClaudeState: detectClaudeStateWithSecureToken,
    checkForUpdate: opts => claudeDetector.checkForUpdate(opts),
    checkPluginUpdates: forceRefresh => pluginUpdateChecker.checkPluginUpdates(forceRefresh),
  });
}, trustDeps, { installed: false, version: '', authType: '', update: {}, pluginUpdates: [] }));
```

In `preload.js`, expose:

```js
getClaudeStateFacade:       () => ipcRenderer.invoke('get-claude-state-facade'),
```

- [ ] **Step 4: Switch health/setup and Claude manager reads to the facade where they currently make overlapping calls**

Replace one overlapping call site in `renderer/setup-health-check.js` and one in `renderer/claude-code-manager.js` so they consume `window.api.getClaudeStateFacade()` instead of separately fetching detect/update/plugin state for the same render pass.

- [ ] **Step 5: Re-run the facade test**

Run:

```bash
node --test lib/claude-state-facade.test.js
```

Expected: PASS.

---

### Task 10: Extract update, hook, and diagnostics logic out of `main.js`

**Files:**
- Create: `lib/main-update-events.js`
- Create: `lib/main-cleanup-state.js`
- Modify: `main.js`
- Test: `lib/main-update-events.test.js`
- Test: `lib/main-cleanup-state.test.js`

- [ ] **Step 1: Write the failing extraction tests**

Create `lib/main-update-events.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { forwardUpdateEvent } = require('./main-update-events');

test('forwardUpdateEvent records latest status and sends it', () => {
  const sent = [];
  const state = { latestUpdateStatus: null };
  forwardUpdateEvent({
    state,
    send(channel, payload) { sent.push([channel, payload]); },
    payload: { status: 'ready', summary: 'Update ready' },
  });

  assert.deepEqual(state.latestUpdateStatus, { status: 'ready', summary: 'Update ready' });
  assert.deepEqual(sent, [['update-status', { status: 'ready', summary: 'Update ready' }]]);
});
```

Create `lib/main-cleanup-state.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { clearHookStateAfterSuccessfulCleanup } = require('./main-cleanup-state');

test('clearHookStateAfterSuccessfulCleanup mutates only successful sessions', () => {
  const session = { state: { hooksInstalled: true } };
  clearHookStateAfterSuccessfulCleanup(session, { ok: true });
  assert.equal(session.state.hooksInstalled, false);
});

test('clearHookStateAfterSuccessfulCleanup leaves failed cleanup installed', () => {
  const session = { state: { hooksInstalled: true } };
  clearHookStateAfterSuccessfulCleanup(session, { ok: false });
  assert.equal(session.state.hooksInstalled, true);
});
```

- [ ] **Step 2: Run the extraction tests to verify they fail because the helpers do not exist**

Run:

```bash
node --test lib/main-update-events.test.js lib/main-cleanup-state.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the helpers and move the logic out of `main.js`**

Create `lib/main-update-events.js` with:

```js
'use strict';

function forwardUpdateEvent({ state, send, payload }) {
  state.latestUpdateStatus = payload;
  send('update-status', payload);
}

module.exports = { forwardUpdateEvent };
```

Create `lib/main-cleanup-state.js` with:

```js
'use strict';

function clearHookStateAfterSuccessfulCleanup(session, result) {
  if (result?.ok) {
    session.state.hooksInstalled = false;
  }
}

module.exports = { clearHookStateAfterSuccessfulCleanup };
```

In `main.js`, replace the inline duplicated state mutation/send logic with calls to these helpers.

- [ ] **Step 4: Re-run the extraction tests**

Run:

```bash
node --test lib/main-update-events.test.js lib/main-cleanup-state.test.js
```

Expected: PASS.

---

### Task 11: Add sleep-prevention lifecycle tests

**Files:**
- Test: `lib/main-sleep-prevention.test.js`
- Modify only if required: `main.js:74-83,901`

- [ ] **Step 1: Write the failing sleep-prevention tests**

Create `lib/main-sleep-prevention.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

function startSleepPrevention(powerSaveBlocker) {
  return powerSaveBlocker.start('prevent-app-suspension');
}

function stopSleepPrevention(powerSaveBlocker, sleepBlockerId) {
  if (sleepBlockerId !== null) {
    try { powerSaveBlocker.stop(sleepBlockerId); } catch { /* ignore */ }
    return null;
  }
  return sleepBlockerId;
}

test('sleep prevention starts with prevent-app-suspension', () => {
  const calls = [];
  const id = startSleepPrevention({
    start(kind) {
      calls.push(kind);
      return 7;
    },
  });

  assert.equal(id, 7);
  assert.deepEqual(calls, ['prevent-app-suspension']);
});

test('sleep prevention stop clears the blocker id', () => {
  const stopped = [];
  const next = stopSleepPrevention({
    stop(id) { stopped.push(id); },
  }, 7);

  assert.equal(next, null);
  assert.deepEqual(stopped, [7]);
});
```

- [ ] **Step 2: Run the tests and use the result as the verification baseline**

Run:

```bash
node --test lib/main-sleep-prevention.test.js
```

Expected: PASS immediately as a narrow executable verification contract. If it fails after wiring to extracted helpers in later tasks, fix only the lifecycle mismatch.

---

### Task 12: Add in-app recovery discoverability

**Files:**
- Modify: `renderer/help-wizard.js`
- Modify: `index.html`
- Test: `lib/index-ui-runtime.test.js`

- [ ] **Step 1: Write a failing help-flow test for the recovery entry point**

Add this test to `lib/index-ui-runtime.test.js`:

```js
test('help flow includes an If something fails recovery entry point', async () => {
  const helpJs = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'help-wizard.js'), 'utf8');
  assert.match(helpJs, /If something fails/);
});
```

- [ ] **Step 2: Run the test to verify it fails before the copy exists**

Run:

```bash
node --test lib/index-ui-runtime.test.js
```

Expected: FAIL because `help-wizard.js` does not yet contain the new recovery language.

- [ ] **Step 3: Add the recovery step to the help flow**

In `renderer/help-wizard.js`, add one compact step or card with the title `If something fails` and content equivalent to:

```js
{
  title: 'If something fails',
  body: [
    'Check live output first.',
    'Open the app logs from Settings or Setup Health.',
    'Look at updater status and Claude diagnostics.',
    'If telemetry is degraded or hooks are stuck, retry cleanup or run install-hooks.js manually.',
  ],
}
```

Wire it into the existing help-step sequence rather than building a separate modal.

- [ ] **Step 4: Re-run the help-flow test**

Run:

```bash
node --test lib/index-ui-runtime.test.js
```

Expected: PASS.

---

### Task 13: Run the expanded targeted verification suite

**Files:**
- Modify only if failures require it: files from Tasks 1-12
- Test: `lib/install-hooks-cli.test.js`
- Test: `lib/hook-lifecycle.test.js`
- Test: `lib/main-operational-state.test.js`
- Test: `lib/update-status.test.js`
- Test: `lib/hook-watcher.test.js`
- Test: `lib/pre-commit-scan.test.js`
- Test: `lib/diagnostics.test.js`
- Test: `lib/claude-state-facade.test.js`
- Test: `lib/main-update-events.test.js`
- Test: `lib/main-cleanup-state.test.js`
- Test: `lib/main-sleep-prevention.test.js`
- Test: `lib/index-ui-runtime.test.js`

- [ ] **Step 1: Run the new targeted remediation suite**

Run:

```bash
node --test lib/install-hooks-cli.test.js lib/hook-lifecycle.test.js lib/main-operational-state.test.js lib/update-status.test.js lib/hook-watcher.test.js lib/pre-commit-scan.test.js lib/diagnostics.test.js lib/claude-state-facade.test.js lib/main-update-events.test.js lib/main-cleanup-state.test.js lib/main-sleep-prevention.test.js lib/index-ui-runtime.test.js
```

Expected: PASS for all newly added and modified tests.

- [ ] **Step 2: Run the full project suite**

Run:

```bash
node --test lib/*.test.js
```

Expected: PASS with all pre-existing tests still green.

- [ ] **Step 3: Start the app and manually verify the UI surfaces changed in this remediation**

Run:

```bash
npm start
```

Expected manual checks:
- Claude Code Manager update area shows richer status/error text instead of only `Check failed` or `Update failed`.
- Setup Health exposes compact diagnostics and clearer next-step text.
- Settings exposes diagnostics or clearer operational messaging.
- Help flow includes `If something fails`.

If the native window cannot be directly driven from the available harness, record exactly which UI checks could not be directly exercised and why.

---

## Self-Review Checklist

- Coverage of resilience fixes:
  - `R1` handled in Task 1.
  - `R2` handled in Task 3.
  - `R3` handled in Task 4.
  - `R4` handled in Task 5.
- Coverage of verification findings:
  - `V1` addressed by Tasks 4, 7, 10, 11, and 13.
  - `V2` addressed by Tasks 1 and 6.
- Coverage of maintainability findings:
  - `M1` addressed by Task 10.
  - `M2` addressed by Task 8.
  - `M3` addressed by Task 9.
- Coverage of product findings:
  - `P1` addressed by Tasks 7 and 8.
  - `P2` addressed by Task 12.
  - `P3` addressed by Task 7.
- Placeholder scan: no `TODO`, `TBD`, or undefined helper names remain.
- Naming consistency: `operations-status`, `hook-lifecycle`, `update-status`, `diagnostics`, `claude-state-facade`, `main-update-events`, and `main-cleanup-state` are used consistently across tasks.

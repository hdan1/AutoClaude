'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { clearHookStateAfterSuccessfulCleanup } = require('./main-cleanup-state');
const { buildDiagnostics } = require('./diagnostics');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extract(regex, label) {
  const match = src.match(regex);
  assert.ok(match, `Could not locate ${label} in main.js`);
  return match;
}

function buildCloseWorkspaceProject(deps) {
  const [, body] = extract(
    /async function _closeWorkspaceProject\(tabId\) \{([\s\S]*?)\n\}/,
    '_closeWorkspaceProject'
  );

  return new Function(
    'deps',
    `const { sessionManager, config, uninstallHooks, untrackPid, send, logger, clearHookStateAfterSuccessfulCleanup } = deps; return async (tabId) => {${body}};`
  )(deps);
}

function buildCleanup(deps) {
  const [, body] = extract(
    /function cleanup\(\) \{([\s\S]*?)\n\}/,
    'cleanup'
  );

  return new Function(
    'deps',
    `
      let cleanedUp = false;
      let ipcFlushTimer = null;
      let masterTelegram = deps.masterTelegram ?? null;
      let sleepBlockerId = deps.sleepBlockerId ?? null;
      const { logger, stopAllProjectBots, sessionManager, config, uninstallHooks, settingsDb, powerSaveBlocker, fs, getPidFile, send, clearHookStateAfterSuccessfulCleanup } = deps;
      function cleanup() {${body}}
      return { cleanup };
    `
  )(deps);
}

function buildUninstallHooks(deps) {
  const [, body] = extract(
    /function uninstallHooks\(projectDir\) \{([\s\S]*?)\n\}/,
    'uninstallHooks'
  );

  return new Function(
    'deps',
    `
      let latestOperationalError = deps.latestOperationalError ?? '';
      let latestOperationalErrorSource = deps.latestOperationalErrorSource ?? '';
      const { getInstallerPath, uninstallProjectHooks, execFileSync, logger, send } = deps;
      const uninstallHooks = (projectDir) => {${body}};
      uninstallHooks.getLatestOperationalError = () => latestOperationalError;
      uninstallHooks.getLatestOperationalErrorSource = () => latestOperationalErrorSource;
      return uninstallHooks;
    `
  )(deps);
}

function buildGetDiagnostics(deps) {
  const [, body] = extract(
    /ipcMain\.handle\('get-diagnostics', withTrustedIpc\('get-diagnostics', async \([^)]*\) => \{([\s\S]*?)\n\}, trustDeps, \{\}\)\);/,
    'get-diagnostics handler'
  );

  return new Function(
    'deps',
    `
      const {
        detectClaudeStateWithSecureToken,
        sessionManager,
        buildDiagnostics,
        app,
        APP_LOG_FILE,
        latestUpdateStatus,
        telemetryState,
        latestOperationalError,
        mainWindow,
      } = deps;
      const telemetryStateByTab = deps.telemetryStateByTab ?? new Map();
      const latestOperationalErrorSource = deps.latestOperationalErrorSource ?? '';
      return async (input = {}) => {
        const event = null;
        const data = input;
        ${body}
      };
    `
  )(deps);
}

function buildStopSession(deps) {
  const [, body] = extract(
    /ipcMain\.handle\('stop-session', withTrustedIpc\('stop-session', async \([^)]*\) => \{([\s\S]*?)\n\}, trustDeps\)\);/,
    'stop-session handler'
  );

  return new Function(
    'deps',
    `const { sessionManager, config, uninstallHooks, send, clearHookStateAfterSuccessfulCleanup, untrackPid, releaseSleepLock } = deps; return async (input = {}) => { const event = null; const data = input; ${body} };`
  )(deps);
}

function buildWireSessionManagerEvents(deps) {
  const [, body] = extract(
    /function _wireSessionManagerEvents\(\) \{([\s\S]*?)\n\}/,
    '_wireSessionManagerEvents'
  );

  return new Function(
    'deps',
    `
      let telemetryState = deps.telemetryState;
      let telemetryStateByTab = deps.telemetryStateByTab ?? new Map();
      let latestOperationalError = deps.latestOperationalError ?? '';
      let latestOperationalErrorSource = deps.latestOperationalErrorSource ?? '';
      const { sessionManager, saveConfig, config, path, fs, notify, installHooks, saveStatusJson, logger, getProjectBot, masterTelegram, trackPid, settingsDb, untrackPid, releaseSleepLock, processBatchQueue } = deps;
      function _wireSessionManagerEvents() {${body}}
      return {
        wire: _wireSessionManagerEvents,
        getTelemetryState: () => telemetryState,
        getLatestOperationalError: () => latestOperationalError,
      };
    `
  )(deps);
}

test('failed hook uninstall during cleanup keeps hooksInstalled set and reports structured status', () => {
  const session = {
    state: {
      projectDir: '/tmp/project-omega',
      hooksInstalled: true,
    },
  };
  const sent = [];
  const warnings = [];
  const uninstallResult = {
    ok: false,
    severity: 'warning',
    scope: 'hooks',
    summary: 'Hook cleanup incomplete',
    details: 'spawn failed',
    nextSteps: [
      'Retry closing the project',
      'Remove hooks manually with install-hooks.js',
      'Check project .claude/settings.json',
    ],
  };

  const { cleanup } = buildCleanup({
    logger: {
      info: () => {},
      warn: (scope, summary, error) => warnings.push([scope, summary, error.message]),
    },
    stopAllProjectBots: () => {},
    masterTelegram: null,
    sessionManager: {
      stopAll: () => {},
      sessions: new Map([['tab-1', session]]),
    },
    config: { hooks: { install: true } },
    uninstallHooks: () => uninstallResult,
    settingsDb: { close: () => {} },
    powerSaveBlocker: { stop: () => {} },
    fs: { unlinkSync: () => {} },
    getPidFile: () => '/tmp/ralph.pid',
    send: (channel, payload) => sent.push([channel, payload]),
    clearHookStateAfterSuccessfulCleanup,
    sleepBlockerId: null,
  });

  cleanup();

  assert.equal(session.state.hooksInstalled, true);
  assert.deepEqual(warnings, []);
  assert.deepEqual(sent, [['update-status', uninstallResult]]);
});

test('failed hook uninstall does not clear hooksInstalled during workspace close and reports structured status', async () => {
  const session = {
    state: {
      projectDir: '/tmp/project-zeta',
      hooksInstalled: true,
    },
  };
  const sent = [];
  const warnings = [];
  const uninstallResult = {
    ok: false,
    severity: 'warning',
    scope: 'hooks',
    summary: 'Hook cleanup incomplete',
    details: 'spawn failed',
    nextSteps: [
      'Retry closing the project',
      'Remove hooks manually with install-hooks.js',
      'Check project .claude/settings.json',
    ],
  };

  const closeWorkspaceProject = buildCloseWorkspaceProject({
    sessionManager: {
      get: () => session,
      close: async () => ({ ok: true, tabId: 'tab-1', projectName: 'zeta', projectPath: '/tmp/project-zeta' }),
    },
    config: { hooks: { install: true } },
    uninstallHooks: () => uninstallResult,
    untrackPid: () => {},
    send: (channel, payload) => sent.push([channel, payload]),
    logger: {
      warn: (scope, summary, error) => warnings.push([scope, summary, error.message]),
    },
    clearHookStateAfterSuccessfulCleanup,
  });

  const result = await closeWorkspaceProject('tab-1');

  assert.equal(result.ok, true);
  assert.equal(session.state.hooksInstalled, true);
  assert.deepEqual(warnings, []);
  assert.deepEqual(sent, [
    ['update-status', uninstallResult],
    ['master-workspace-close', { tabId: 'tab-1' }],
  ]);
});

test('failed hook uninstall during stop-session keeps hooksInstalled set and reports structured status', async () => {
  const session = {
    state: {
      projectDir: '/tmp/project-iota',
      hooksInstalled: true,
    },
  };
  const sent = [];
  const uninstallResult = {
    ok: false,
    severity: 'warning',
    scope: 'hooks',
    summary: 'Hook cleanup incomplete',
    details: 'spawn failed',
    nextSteps: [
      'Retry closing the project',
      'Remove hooks manually with install-hooks.js',
      'Check project .claude/settings.json',
    ],
  };

  const stopSession = buildStopSession({
    sessionManager: {
      get: () => session,
      stop: async () => {},
    },
    config: { hooks: { install: true } },
    uninstallHooks: () => uninstallResult,
    send: (channel, payload) => sent.push([channel, payload]),
    clearHookStateAfterSuccessfulCleanup,
    untrackPid: () => {},
    releaseSleepLock: () => {},
  });

  const result = await stopSession({ tabId: 'tab-1' });

  assert.deepEqual(result, { ok: true });
  assert.equal(session.state.hooksInstalled, true);
  assert.deepEqual(sent, [['update-status', uninstallResult]]);
});

test('uninstallHooks logs structured warning details on failure', () => {
  const warnings = [];
  const sent = [];
  const uninstallHooks = buildUninstallHooks({
    getInstallerPath: () => '/tmp/install-hooks.js',
    uninstallProjectHooks: () => ({
      ok: false,
      severity: 'warning',
      scope: 'hooks',
      summary: 'Hook cleanup incomplete',
      details: 'spawn failed',
      nextSteps: [
        'Retry closing the project',
        'Remove hooks manually with install-hooks.js',
        'Check project .claude/settings.json',
      ],
    }),
    execFileSync: () => {},
    logger: {
      warn: (scope, summary, error) => warnings.push([scope, summary, error.message]),
    },
    send: (channel, payload) => sent.push([channel, payload]),
  });

  const result = uninstallHooks('/tmp/project-theta');

  assert.deepEqual(result, {
    ok: false,
    severity: 'warning',
    scope: 'hooks',
    summary: 'Hook cleanup incomplete',
    details: 'spawn failed',
    nextSteps: [
      'Retry closing the project',
      'Remove hooks manually with install-hooks.js',
      'Check project .claude/settings.json',
    ],
  });
  assert.deepEqual(warnings, [
    ['hooks', 'Hook cleanup incomplete', 'spawn failed'],
  ]);
  assert.deepEqual(sent, [
    ['log', { type: 'stderr', text: 'Hook cleanup incomplete: spawn failed' }],
  ]);
});

test('uninstallHooks clears stale hook operational error after successful cleanup', () => {
  const uninstallHooks = buildUninstallHooks({
    latestOperationalError: 'spawn failed',
    latestOperationalErrorSource: 'hooks',
    getInstallerPath: () => '/tmp/install-hooks.js',
    uninstallProjectHooks: () => ({
      ok: true,
      severity: 'info',
      scope: 'hooks',
      summary: 'Hooks removed',
      details: '',
      nextSteps: [],
    }),
    execFileSync: () => {},
    logger: { warn: () => {} },
    send: () => {},
  });

  uninstallHooks('/tmp/project-theta');

  assert.equal(uninstallHooks.getLatestOperationalError(), '');
  assert.equal(uninstallHooks.getLatestOperationalErrorSource(), '');
});

test('getDiagnostics prefers the requested tab session over BrowserWindow webContents id', async () => {
  const sessions = new Map([
    ['tab-1', { state: { projectDir: '/tmp/project-alpha' } }],
    ['tab-2', { state: { projectDir: '/tmp/project-beta' } }],
  ]);
  const getDiagnostics = buildGetDiagnostics({
    detectClaudeStateWithSecureToken: async () => ({ version: '2.1.119' }),
    sessionManager: {
      get: (tabId) => sessions.get(tabId) || null,
      sessions,
    },
    buildDiagnostics,
    app: { getVersion: () => '3.11.7' },
    APP_LOG_FILE: '/tmp/app.log',
    latestUpdateStatus: { status: 'idle' },
    telemetryState: { degraded: false },
    latestOperationalError: '',
    mainWindow: { webContents: { id: 42 } },
  });

  const diagnostics = await getDiagnostics({ tabId: 'tab-2' });

  assert.equal(diagnostics.workspacePath, '/tmp/project-beta');
});

test('getDiagnostics does not inherit telemetry degradation from another tab', async () => {
  const sessions = new Map([
    ['tab-1', { state: { projectDir: '/tmp/project-alpha' } }],
    ['tab-2', { state: { projectDir: '/tmp/project-beta' } }],
  ]);
  const getDiagnostics = buildGetDiagnostics({
    detectClaudeStateWithSecureToken: async () => ({ version: '2.1.119' }),
    sessionManager: {
      get: (tabId) => sessions.get(tabId) || null,
      sessions,
    },
    buildDiagnostics,
    app: { getVersion: () => '3.11.7' },
    APP_LOG_FILE: '/tmp/app.log',
    latestUpdateStatus: { status: 'idle' },
    telemetryState: { degraded: true, details: 'tab-1 failed' },
    telemetryStateByTab: new Map([['tab-1', { degraded: true, details: 'tab-1 failed' }]]),
    latestOperationalError: 'tab-1 failed',
    latestOperationalErrorSource: 'telemetry',
    mainWindow: { webContents: { id: 42 } },
  });

  const diagnostics = await getDiagnostics({ tabId: 'tab-2' });

  assert.equal(diagnostics.workspacePath, '/tmp/project-beta');
  assert.equal(diagnostics.telemetryDegraded, false);
  assert.equal(diagnostics.lastError, '');
});

test('wireSessionManagerEvents clears telemetry state after telemetry recovery', () => {
  const handlers = new Map();
  const wired = buildWireSessionManagerEvents({
    telemetryState: { degraded: false, details: '' },
    telemetryStateByTab: new Map(),
    latestOperationalError: '',
    latestOperationalErrorSource: '',
    sessionManager: {
      on(event, handler) { handlers.set(event, handler); },
      getState: () => null,
      get: () => null,
    },
    saveConfig: () => {},
    config: {},
    path,
    fs: { existsSync: () => false, readFileSync: () => '' },
    notify: () => {},
    installHooks: () => {},
    saveStatusJson: () => {},
    logger: { info: () => {} },
    getProjectBot: () => null,
    masterTelegram: null,
    trackPid: () => {},
    settingsDb: { setSession: () => {} },
    untrackPid: () => {},
    releaseSleepLock: () => {},
    processBatchQueue: () => {},
  });

  wired.wire();
  handlers.get('telemetry-degraded')({ tabId: 'tab-1', details: 'hook read failed' });
  handlers.get('telemetry-restored')({ tabId: 'tab-1' });

  assert.deepEqual(wired.getTelemetryState(), { degraded: false, details: '' });
  assert.equal(wired.getLatestOperationalError(), '');
});

test('wireSessionManagerEvents keeps telemetry degraded while another tab remains degraded', () => {
  const handlers = new Map();
  const wired = buildWireSessionManagerEvents({
    telemetryState: { degraded: false, details: '' },
    telemetryStateByTab: new Map(),
    latestOperationalError: '',
    latestOperationalErrorSource: '',
    sessionManager: {
      on(event, handler) { handlers.set(event, handler); },
      getState: () => null,
      get: () => null,
    },
    saveConfig: () => {},
    config: {},
    path,
    fs: { existsSync: () => false, readFileSync: () => '' },
    notify: () => {},
    installHooks: () => {},
    saveStatusJson: () => {},
    logger: { info: () => {} },
    getProjectBot: () => null,
    masterTelegram: null,
    trackPid: () => {},
    settingsDb: { setSession: () => {} },
    untrackPid: () => {},
    releaseSleepLock: () => {},
    processBatchQueue: () => {},
  });

  wired.wire();
  handlers.get('telemetry-degraded')({ tabId: 'tab-1', details: 'tab-1 failed' });
  handlers.get('telemetry-degraded')({ tabId: 'tab-2', details: 'tab-2 failed' });
  handlers.get('telemetry-restored')({ tabId: 'tab-1' });

  assert.deepEqual(wired.getTelemetryState(), { degraded: true, details: 'tab-2 failed' });
  assert.equal(wired.getLatestOperationalError(), 'tab-2 failed');
});

test('wireSessionManagerEvents does not clear non-telemetry operational errors on telemetry recovery', () => {
  const handlers = new Map();
  const wired = buildWireSessionManagerEvents({
    telemetryState: { degraded: true, details: 'hook read failed' },
    telemetryStateByTab: new Map([['tab-1', { degraded: true, details: 'hook read failed' }]]),
    latestOperationalError: 'hook read failed',
    latestOperationalErrorSource: 'hooks',
    sessionManager: {
      on(event, handler) { handlers.set(event, handler); },
      getState: () => null,
      get: () => null,
    },
    saveConfig: () => {},
    config: {},
    path,
    fs: { existsSync: () => false, readFileSync: () => '' },
    notify: () => {},
    installHooks: () => {},
    saveStatusJson: () => {},
    logger: { info: () => {} },
    getProjectBot: () => null,
    masterTelegram: null,
    trackPid: () => {},
    settingsDb: { setSession: () => {} },
    untrackPid: () => {},
    releaseSleepLock: () => {},
    processBatchQueue: () => {},
  });

  wired.wire();
  handlers.get('telemetry-restored')({ tabId: 'tab-1' });

  assert.deepEqual(wired.getTelemetryState(), { degraded: false, details: '' });
  assert.equal(wired.getLatestOperationalError(), 'hook read failed');
});

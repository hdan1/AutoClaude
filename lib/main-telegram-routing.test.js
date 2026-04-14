const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extract(regex, label) {
  const match = src.match(regex);
  assert.ok(match, `Could not locate ${label} in main.js`);
  return match;
}

function buildQuestionHandler(deps) {
  const [, body] = extract(
    /sessionManager\.on\('question',\s*\(\{\s*tabId,\s*questionData\s*\}\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/,
    'question event handler'
  );

  return new Function(
    'deps',
    `const { sessionManager, getProjectBot, logger, masterTelegram, config, path } = deps; return ({ tabId, questionData }) => {${body}};`
  )(deps);
}

function buildSaveTelegramConfigHandler(deps) {
  const [, body] = extract(
    /ipcMain\.handle\('save-telegram-config',\s*withTrustedIpc\('save-telegram-config',\s*async\s*\(event,\s*c\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*trustDeps\)\);/,
    'save-telegram-config handler'
  );

  return new Function(
    'deps',
    `const { path, validateProjectTelegramConfig, validateProjectTokenDistinct, loadMasterTelegramToken, logger, config, saveConfig, app, saveProjectToken, stopProjectBot, loadProjectToken, TelegramBridge, projectTelegramBots, sessionManager } = deps; return async (event, c) => {${body}};`
  )(deps);
}

function buildLoadTelegramConfigHandlerAndFallback(deps) {
  const [, body, fallbackLiteral] = extract(
    /ipcMain\.handle\('load-telegram-config',\s*withTrustedIpc\('load-telegram-config',\s*async\s*\(event,\s*c\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*trustDeps,\s*(\{[\s\S]*?\})\s*\)\);/,
    'load-telegram-config handler'
  );

  const handler = new Function(
    'deps',
    `const { path, config, loadProjectToken, app, isEncryptionAvailable } = deps; return async (event, c) => {${body}};`
  )(deps);

  const fallback = new Function(`return (${fallbackLiteral});`)();
  return { handler, fallback };
}

function buildStartSessionHandler(deps) {
  const [, body] = extract(
    /ipcMain\.handle\('start-session',\s*async\s*\(event,\s*o\)\s*=>\s*\{([\s\S]*?)\n\}\);/,
    'start-session handler'
  );

  return new Function(
    'deps',
    `const { isTrustedIpcEvent, sessionManager, validateProjectDir, validatePrompt, saveConfig, config, sendToTab, startProjectBot, installHooks, acquireSleepLock } = deps; return async (event, o) => {${body}};`
  )(deps);
}

test('question routing passes projectBotUsername and masterNotifyMode with full fallback', () => {
  const calls = [];
  const projectDir = '/tmp/project-alpha';
  const resolved = path.resolve(projectDir);
  const bot = {
    isRunning: true,
    botUsername: 'alpha_bot',
    forwardQuestion: () => {},
  };

  const handler = buildQuestionHandler({
    sessionManager: {
      getState: () => ({ projectDir }),
    },
    getProjectBot: () => bot,
    logger: { info: () => {} },
    masterTelegram: {
      isRunning: true,
      forwardQuestion: (...args) => calls.push(args),
    },
    config: {
      projectTelegram: {
        [resolved]: { masterNotifyMode: 'mentions' },
      },
    },
    path,
  });

  handler({ tabId: 'tab-1', questionData: { questionText: 'Hi' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].projectBotUsername, 'alpha_bot');
  assert.equal(calls[0][0].masterNotifyMode, 'mentions');

  calls.length = 0;
  bot.botUsername = undefined;
  handler({ tabId: 'tab-2', questionData: { questionText: 'Fallback check' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].projectBotUsername, null);
  assert.equal(calls[0][0].masterNotifyMode, 'mentions');

  calls.length = 0;
  const noModeHandler = buildQuestionHandler({
    sessionManager: {
      getState: () => ({ projectDir }),
    },
    getProjectBot: () => bot,
    logger: { info: () => {} },
    masterTelegram: {
      isRunning: true,
      forwardQuestion: (...args) => calls.push(args),
    },
    config: {
      projectTelegram: {
        [resolved]: {},
      },
    },
    path,
  });

  noModeHandler({ tabId: 'tab-3', questionData: { questionText: 'Default mode' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].masterNotifyMode, 'full');
});

test('save-telegram-config forwards masterNotifyMode into validation and persists normalized value', async () => {
  const projectDir = '/tmp/project-beta';
  const resolved = path.resolve(projectDir);
  const savedConfigs = [];
  let validationInput;
  const config = {};

  const handler = buildSaveTelegramConfigHandler({
    path,
    validateProjectTelegramConfig: (incoming) => {
      validationInput = incoming;
      return {
        ok: true,
        config: {
          enabled: false,
          allowedUsers: ['alice'],
          masterNotifyMode: 'mentions',
        },
      };
    },
    validateProjectTokenDistinct: () => ({ ok: true }),
    loadMasterTelegramToken: () => null,
    logger: { warn: () => {} },
    config,
    saveConfig: (next) => savedConfigs.push(next),
    app: { getPath: () => '/tmp/userData' },
    saveProjectToken: () => true,
    stopProjectBot: async () => {},
    loadProjectToken: () => null,
    TelegramBridge: class {},
    projectTelegramBots: new Map(),
    sessionManager: { sessions: new Map(), setTelegram: () => {} },
  });

  const result = await handler(null, {
    projectDir,
    enabled: true,
    allowedUsers: ['alice'],
    masterNotifyMode: 'full',
  });

  assert.equal(result.ok, true);
  assert.equal(validationInput.masterNotifyMode, 'full');
  assert.deepEqual(config.projectTelegram[resolved], {
    enabled: false,
    allowedUsers: ['alice'],
    masterNotifyMode: 'mentions',
  });
  assert.equal(savedConfigs.length, 1);
});

test('load-telegram-config includes masterNotifyMode defaults for missing-project and fallback/default paths', async () => {
  const projectDir = '/tmp/project-gamma';
  const { handler, fallback } = buildLoadTelegramConfigHandlerAndFallback({
    path,
    config: { projectTelegram: {} },
    loadProjectToken: () => null,
    app: { getPath: () => '/tmp/userData' },
    isEncryptionAvailable: () => true,
  });

  const missingProject = await handler(null, {});
  assert.equal(missingProject.masterNotifyMode, 'full');

  const configFallback = await handler(null, { projectDir });
  assert.equal(configFallback.masterNotifyMode, 'full');

  assert.equal(fallback.masterNotifyMode, 'full');
});

test('start-session preserves existing session when no explicit new-session choice is provided', async () => {
  const existing = {
    state: {
      running: false,
      starting: false,
      sessionId: 'sess-existing-1',
      projectDir: '/tmp/project-delta',
      hooksInstalled: false,
      startTime: null,
    },
  };

  let startedPrompt = null;
  const handler = buildStartSessionHandler({
    isTrustedIpcEvent: () => true,
    sessionManager: {
      get: () => existing,
      create: () => existing,
      setTelegram: () => {},
      start: (tabId, prompt) => {
        startedPrompt = prompt;
      },
    },
    validateProjectDir: () => ({ valid: true, path: '/tmp/project-delta' }),
    validatePrompt: () => ({ valid: true, prompt: '/gsd:autonomous' }),
    saveConfig: () => {},
    config: { hooks: { install: false } },
    sendToTab: () => {},
    startProjectBot: async () => null,
    installHooks: () => {},
    acquireSleepLock: () => {},
  });

  await handler({}, {
    tabId: 'tab-1',
    projectDir: '/tmp/project-delta',
    prompt: '/gsd:autonomous',
  });

  assert.equal(startedPrompt, '/gsd:autonomous');
  assert.equal(existing.state.sessionId, 'sess-existing-1');
});

test('start-session clears existing session only when explicit new-session choice is provided', async () => {
  const existing = {
    state: {
      running: false,
      starting: false,
      sessionId: 'sess-existing-2',
      projectDir: '/tmp/project-epsilon',
      hooksInstalled: false,
      startTime: null,
    },
  };

  let startedPrompt = null;
  const handler = buildStartSessionHandler({
    isTrustedIpcEvent: () => true,
    sessionManager: {
      get: () => existing,
      create: () => existing,
      setTelegram: () => {},
      start: (tabId, prompt) => {
        startedPrompt = prompt;
      },
    },
    validateProjectDir: () => ({ valid: true, path: '/tmp/project-epsilon' }),
    validatePrompt: () => ({ valid: true, prompt: '/gsd:autonomous' }),
    saveConfig: () => {},
    config: { hooks: { install: false } },
    sendToTab: () => {},
    startProjectBot: async () => null,
    installHooks: () => {},
    acquireSleepLock: () => {},
  });

  await handler({}, {
    tabId: 'tab-2',
    projectDir: '/tmp/project-epsilon',
    prompt: '/gsd:autonomous',
    sessionSelectionTouched: true,
  });

  assert.equal(startedPrompt, '/gsd:autonomous');
  assert.equal(existing.state.sessionId, null);
});

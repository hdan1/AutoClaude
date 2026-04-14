const test = require('node:test');
const assert = require('node:assert/strict');

const MasterTelegramBridge = require('./master-telegram');

function createBridge() {
  const sessionManager = {
    sessions: new Map(),
    emit() {},
    get() { return null; },
    getState() { return null; },
    start() {},
    stop() {},
    sendResponse() {},
  };

  return new MasterTelegramBridge({ masterTelegram: {} }, sessionManager, {});
}

function attachBot(bridge) {
  const calls = [];
  bridge.bot = {
    sendMessage(chatId, text, options) {
      calls.push({ chatId, text, options });
      return Promise.resolve();
    },
  };
  bridge._started = true;
  bridge._pollingDead = false;
  bridge.chatIds.set('user', 12345);
  return calls;
}

test('forwardQuestion off mode sends nothing', () => {
  const bridge = createBridge();
  const calls = attachBot(bridge);

  bridge.forwardQuestion({
    tabId: 'tab-1',
    projectDir: '/tmp/MyProject',
    state: { projectDir: '/tmp/MyProject', alias: 'MyProject' },
    projectBotUsername: 'project_bot',
    masterNotifyMode: 'off',
  }, {
    questionText: 'Need input',
  });

  assert.equal(calls.length, 0);
  assert.equal(bridge.pending.size, 0);
});

test('forwardQuestion ping mode sends short deep-link message without token', () => {
  const bridge = createBridge();
  const calls = attachBot(bridge);

  bridge.forwardQuestion({
    tabId: 'tab-2',
    projectDir: '/tmp/MyProject',
    state: { projectDir: '/tmp/MyProject', alias: 'MyProject' },
    projectBotUsername: 'project_bot',
    masterNotifyMode: 'ping',
  }, {
    questionText: 'Need input',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '🔔 MyProject needs your input');
  assert.equal(calls[0].text.includes('Reply token:'), false);
  assert.deepEqual(calls[0].options, {
    reply_markup: {
      inline_keyboard: [[
        { text: '💬 Open Project Bot', url: 'https://t.me/project_bot' },
      ]],
    },
  });
  assert.equal(bridge.pending.size, 0);
});

test('forwardQuestion full mode sends question text with deep-link and no token', () => {
  const bridge = createBridge();
  const calls = attachBot(bridge);

  bridge.forwardQuestion({
    tabId: 'tab-3',
    projectDir: '/tmp/MyProject',
    state: { projectDir: '/tmp/MyProject', alias: 'MyProject' },
    projectBotUsername: 'project_bot',
    masterNotifyMode: 'full',
  }, {
    questionText: 'What API key should I use?',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '❓ [tab-3 | MyProject | MyProject] Question\nWhat API key should I use?');
  assert.equal(calls[0].text.includes('Reply token:'), false);
  assert.deepEqual(calls[0].options, {
    reply_markup: {
      inline_keyboard: [[
        { text: '💬 Open Project Bot', url: 'https://t.me/project_bot' },
      ]],
    },
  });
  assert.equal(bridge.pending.size, 0);
});

test('forwardQuestion normalizes @project_bot and uses deep-link mode', () => {
  const bridge = createBridge();
  const calls = attachBot(bridge);

  bridge.forwardQuestion({
    tabId: 'tab-3b',
    projectDir: '/tmp/MyProject',
    state: { projectDir: '/tmp/MyProject', alias: 'MyProject' },
    projectBotUsername: '@project_bot',
    masterNotifyMode: 'ping',
  }, {
    questionText: 'Need input',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '🔔 MyProject needs your input');
  assert.equal(calls[0].text.includes('Reply token:'), false);
  assert.deepEqual(calls[0].options, {
    reply_markup: {
      inline_keyboard: [[
        { text: '💬 Open Project Bot', url: 'https://t.me/project_bot' },
      ]],
    },
  });
  assert.equal(bridge.pending.size, 0);
});

test('forwardQuestion falls back to reply token flow when project bot username is missing', () => {
  const bridge = createBridge();
  const calls = attachBot(bridge);

  bridge.forwardQuestion({
    tabId: 'tab-4',
    projectDir: '/tmp/MyProject',
    state: { projectDir: '/tmp/MyProject', alias: 'MyProject' },
    projectBotUsername: null,
    masterNotifyMode: 'ping',
  }, {
    questionText: 'Fallback question?',
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^\[tab-4 \| MyProject \| MyProject\] Question\nFallback question\?\nReply token: [A-Z2-9]{6}\nUsage: \/reply <token> <text>$/);
  assert.equal(calls[0].options, undefined);
  assert.equal(bridge.pending.size, 1);
});

test('forwardQuestion falls back to token flow when project bot username is invalid', () => {
  const bridge = createBridge();
  const calls = attachBot(bridge);

  bridge.forwardQuestion({
    tabId: 'tab-5',
    projectDir: '/tmp/MyProject',
    state: { projectDir: '/tmp/MyProject', alias: 'MyProject' },
    projectBotUsername: 'bad name',
    masterNotifyMode: 'ping',
  }, {
    questionText: 'Invalid username fallback?',
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^\[tab-5 \| MyProject \| MyProject\] Question\nInvalid username fallback\?\nReply token: [A-Z2-9]{6}\nUsage: \/reply <token> <text>$/);
  assert.equal(calls[0].options, undefined);
  assert.equal(bridge.pending.size, 1);
});

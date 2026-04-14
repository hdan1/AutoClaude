const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function createSessionManagerStub() {
  return {
    sessions: new Map(),
    on() {},
    removeListener() {},
    emit() {},
    get() { return null; },
    getState() { return null; },
    start() {},
    stop() {},
    sendResponse() {},
  };
}

function loadTelegramBridgeWithMock(TelegramBotMock) {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'node-telegram-bot-api') {
      return TelegramBotMock;
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const telegramPath = require.resolve('./telegram');
    delete require.cache[telegramPath];
    return require('./telegram');
  } finally {
    Module._load = originalLoad;
  }
}

function createBotMock({ getMeImpl } = {}) {
  return class TelegramBotMock {
    constructor(token, options) {
      this.token = token;
      this.options = options;
      this.startPollingCalled = false;
      this.stopPollingCalled = false;
      TelegramBotMock.instances.push(this);
    }

    static instances = [];

    on() {}

    onText() {}

    setMyCommands() {
      return Promise.resolve();
    }

    startPolling() {
      this.startPollingCalled = true;
      return Promise.resolve();
    }

    getMe() {
      if (getMeImpl) {
        return getMeImpl();
      }
      return Promise.resolve({ username: 'test_bot' });
    }

    stopPolling() {
      this.stopPollingCalled = true;
      return Promise.resolve();
    }

    sendMessage() {
      return Promise.resolve();
    }

    editMessageText() {
      return Promise.resolve();
    }

    answerCallbackQuery() {
      return Promise.resolve();
    }
  };
}

function createBridge(TelegramBridge) {
  return new TelegramBridge({ projectTelegram: {} }, createSessionManagerStub(), __dirname);
}

test('TelegramBridge constructor initializes botUsername to null', () => {
  const TelegramBotMock = createBotMock();
  const TelegramBridge = loadTelegramBridgeWithMock(TelegramBotMock);
  const bridge = createBridge(TelegramBridge);

  assert.equal(bridge.botUsername, null);
});

test('TelegramBridge.start assigns token and stores bot username after getMe success', async () => {
  const TelegramBotMock = createBotMock({
    getMeImpl: () => Promise.resolve({ username: 'runtime_bot' }),
  });
  const TelegramBridge = loadTelegramBridgeWithMock(TelegramBotMock);
  const bridge = createBridge(TelegramBridge);

  await bridge.start('decrypted-token-123', []);

  assert.equal(bridge.token, 'decrypted-token-123');
  assert.equal(bridge.botUsername, 'runtime_bot');
  assert.equal(bridge.bot.startPollingCalled, true);

  await bridge.stop();
});

test('TelegramBridge.start getMe rejection leaves botUsername null and does not throw', async () => {
  const TelegramBotMock = createBotMock({
    getMeImpl: () => Promise.reject(new Error('getMe failed')),
  });
  const TelegramBridge = loadTelegramBridgeWithMock(TelegramBotMock);
  const bridge = createBridge(TelegramBridge);

  await assert.doesNotReject(async () => {
    await bridge.start('decrypted-token-456', []);
  });

  assert.equal(bridge.token, 'decrypted-token-456');
  assert.equal(bridge.botUsername, null);

  await bridge.stop();
});

test('TelegramBridge.stop resets botUsername to null', async () => {
  const TelegramBotMock = createBotMock({
    getMeImpl: () => Promise.resolve({ username: 'to_be_cleared' }),
  });
  const TelegramBridge = loadTelegramBridgeWithMock(TelegramBotMock);
  const bridge = createBridge(TelegramBridge);

  await bridge.start('decrypted-token-789', []);
  assert.equal(bridge.botUsername, 'to_be_cleared');

  await bridge.stop();

  assert.equal(bridge.botUsername, null);
});

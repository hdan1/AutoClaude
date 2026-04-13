const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('question event passes project bot username and notification mode to master bot', () => {
  assert.ok(
    src.includes('projectBotUsername: bot?.botUsername || null'),
    'question handler must pass projectBotUsername to masterTelegram.forwardQuestion'
  );

  assert.ok(
    src.includes("masterNotifyMode: ptConfig.masterNotifyMode || 'full'"),
    'question handler must pass normalized masterNotifyMode to masterTelegram.forwardQuestion'
  );
});

test('save-telegram-config validates and persists masterNotifyMode', () => {
  assert.ok(
    src.includes('masterNotifyMode: c.masterNotifyMode'),
    'save-telegram-config must send masterNotifyMode to validateProjectTelegramConfig'
  );

  assert.ok(
    src.includes('masterNotifyMode: result.config.masterNotifyMode'),
    'save-telegram-config must persist normalized masterNotifyMode'
  );
});

test('load-telegram-config returns masterNotifyMode with default full', () => {
  assert.ok(
    src.includes("masterNotifyMode: ptConfig.masterNotifyMode || 'full'"),
    'load-telegram-config must include masterNotifyMode with full default'
  );

  assert.ok(
    src.includes("return { enabled: false, hasToken: false, allowedUsers: [], masterNotifyMode: 'full', encryptionAvailable: isEncryptionAvailable() };"),
    'load-telegram-config missing-project response must include masterNotifyMode default'
  );

  assert.ok(
    src.includes("}, trustDeps, { enabled: false, hasToken: false, allowedUsers: [], masterNotifyMode: 'full', encryptionAvailable: false }));"),
    'load-telegram-config fallback default object must include masterNotifyMode default'
  );
});

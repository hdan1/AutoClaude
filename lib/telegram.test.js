const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');

test('TelegramBridge.start stores decryptedToken as this.token', () => {
  const startMethod = src.substring(
    src.indexOf('async start(decryptedToken'),
    src.indexOf('async stop()')
  );
  assert.ok(
    startMethod.includes('this.token = decryptedToken'),
    'start() must assign this.token = decryptedToken'
  );
});

test('TelegramBridge constructor initializes this.botUsername to null', () => {
  const constructorBlock = src.substring(
    src.indexOf('constructor(config, sessionManager, projectDir) {'),
    src.indexOf('get projectLabel()')
  );
  assert.ok(
    constructorBlock.includes('this.botUsername = null'),
    'constructor must initialize this.botUsername = null'
  );
});

test('TelegramBridge.start fetches bot username via getMe after polling starts', () => {
  const startMethod = src.substring(
    src.indexOf('async start(decryptedToken'),
    src.indexOf('async stop()')
  );

  assert.ok(
    startMethod.includes('await this.bot.startPolling()'),
    'start() must await this.bot.startPolling()'
  );
  assert.ok(
    startMethod.includes('const me = await this.bot.getMe()'),
    'start() must call await this.bot.getMe()'
  );
  assert.ok(
    startMethod.includes('this.botUsername = me?.username || null'),
    'start() must assign this.botUsername = me?.username || null'
  );
});

test('TelegramBridge handles getMe failures and clears botUsername on stop', () => {
  const startMethod = src.substring(
    src.indexOf('async start(decryptedToken'),
    src.indexOf('async stop()')
  );
  const stopMethod = src.substring(
    src.indexOf('async stop()'),
    src.indexOf('get isRunning')
  );

  assert.ok(
    startMethod.includes("logger.warn('telegram', 'Failed to get bot username', e)"),
    'start() must log warning when getMe() fails'
  );
  assert.ok(
    startMethod.includes('this.botUsername = null'),
    'start() must clear this.botUsername when getMe() fails'
  );
  assert.ok(
    stopMethod.includes('this.botUsername = null'),
    'stop() must reset this.botUsername = null'
  );
});

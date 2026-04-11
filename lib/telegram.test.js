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

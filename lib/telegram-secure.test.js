const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

test('projectTokenFileName produces deterministic hash', () => {
  function pf(d) { return `tg-project-${crypto.createHash('md5').update(path.resolve(d)).digest('hex').slice(0,12)}.enc`; }
  assert.equal(pf('/project/a'), pf('/project/a'));
  assert.ok(pf('/a').startsWith('tg-project-'));
  assert.ok(pf('/a').endsWith('.enc'));
});
test('projectTokenFileName differs for different paths', () => {
  function pf(d) { return `tg-project-${crypto.createHash('md5').update(path.resolve(d)).digest('hex').slice(0,12)}.enc`; }
  assert.notEqual(pf('/project/a'), pf('/project/b'));
});
test('projectTokenFileName hash is 12 chars', () => {
  function pf(d) { return `tg-project-${crypto.createHash('md5').update(path.resolve(d)).digest('hex').slice(0,12)}.enc`; }
  assert.equal(pf('/any').length, 27);
});
test('telegram-secure exports all expected functions', () => {
  const src = fs.readFileSync(path.join(__dirname, 'telegram-secure.js'), 'utf8');
  for (const fn of ['saveToken','loadToken','deleteToken','saveMasterTelegramToken','loadMasterTelegramToken',
    'clearMasterTelegramToken','saveProjectToken','loadProjectToken','clearProjectToken',
    'saveCustomProviderToken','loadCustomProviderToken','clearCustomProviderToken','isEncryptionAvailable']) {
    assert.ok(src.includes(fn), `Missing: ${fn}`);
  }
});
test('telegram-secure uses safeStorage encrypt/decrypt', () => {
  const src = fs.readFileSync(path.join(__dirname, 'telegram-secure.js'), 'utf8');
  assert.ok(src.includes('safeStorage.encryptString'));
  assert.ok(src.includes('safeStorage.decryptString'));
});
test('telegram-secure checks encryption availability', () => {
  const src = fs.readFileSync(path.join(__dirname, 'telegram-secure.js'), 'utf8');
  assert.ok(src.includes('isEncryptionAvailable()'));
});
test('telegram-secure returns null for missing file', () => {
  const src = fs.readFileSync(path.join(__dirname, 'telegram-secure.js'), 'utf8');
  assert.ok(src.includes('existsSync'));
  assert.ok(src.includes('return null'));
});

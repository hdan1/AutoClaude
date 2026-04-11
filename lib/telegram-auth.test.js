const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorized } = require('./telegram-auth');

test('isAuthorized returns true when no allowedUsers (open access)', () => {
  assert.equal(isAuthorized('someUser', 12345, []), true);
});

test('isAuthorized matches by username', () => {
  assert.equal(isAuthorized('alice', 12345, ['alice', 'bob']), true);
});

test('isAuthorized matches by numeric ID', () => {
  assert.equal(isAuthorized(null, 12345, ['12345']), true);
});

test('isAuthorized rejects unauthorized user', () => {
  assert.equal(isAuthorized('eve', 99999, ['alice', 'bob']), false);
});

test('isAuthorized handles null allowedUsers', () => {
  assert.equal(isAuthorized('anyone', 123, null), true);
});

test('isAuthorized handles undefined username with ID match', () => {
  assert.equal(isAuthorized(undefined, 42, ['42']), true);
});

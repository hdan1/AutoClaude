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

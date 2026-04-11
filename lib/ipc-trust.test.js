const test = require('node:test');
const assert = require('node:assert/strict');
const { withTrustedIpc } = require('./ipc-trust');

test('withTrustedIpc rejects untrusted event', async () => {
  const handler = withTrustedIpc('test-channel', () => 'ok', {
    isTrusted: () => false,
  });
  const result = await handler({ sender: { id: 999 } }, 'arg1');
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('Untrusted'));
});

test('withTrustedIpc passes trusted event to handler', async () => {
  const handler = withTrustedIpc('test-channel', (event, arg) => ({ ok: true, data: arg }), {
    isTrusted: () => true,
  });
  const result = await handler({ sender: { id: 1 } }, 'arg1');
  assert.equal(result.ok, true);
  assert.equal(result.data, 'arg1');
});

test('withTrustedIpc passes action name to isTrusted', async () => {
  let receivedAction = null;
  const handler = withTrustedIpc('my-channel', () => 'ok', {
    isTrusted: (event, action) => { receivedAction = action; return true; },
  });
  await handler({}, 'arg');
  assert.equal(receivedAction, 'my-channel');
});

test('withTrustedIpc handles async handlers', async () => {
  const handler = withTrustedIpc('async-test', async () => {
    return { ok: true, data: 'async-result' };
  }, { isTrusted: () => true });
  const result = await handler({});
  assert.equal(result.ok, true);
  assert.equal(result.data, 'async-result');
});

test('withTrustedIpc handles handler errors gracefully', async () => {
  const handler = withTrustedIpc('error-test', () => {
    throw new Error('handler error');
  }, { isTrusted: () => true });
  await assert.rejects(() => handler({}), { message: 'handler error' });
});

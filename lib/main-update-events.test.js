const test = require('node:test');
const assert = require('node:assert/strict');
const { forwardUpdateEvent } = require('./main-update-events');

test('forwardUpdateEvent records latest status and sends it', () => {
  const sent = [];
  const state = { latestUpdateStatus: null };
  forwardUpdateEvent({
    state,
    send(channel, payload) { sent.push([channel, payload]); },
    payload: { status: 'ready', summary: 'Update ready' },
  });

  assert.deepEqual(state.latestUpdateStatus, { status: 'ready', summary: 'Update ready' });
  assert.deepEqual(sent, [['update-status', { status: 'ready', summary: 'Update ready' }]]);
});

test('forwardUpdateEvent clears stale updater error after non-error update status', () => {
  const sent = [];
  const state = {
    latestUpdateStatus: null,
    latestOperationalError: 'feed timeout',
    latestOperationalErrorSource: 'updater',
  };

  forwardUpdateEvent({
    state,
    send(channel, payload) { sent.push([channel, payload]); },
    payload: { status: 'downloading', summary: 'Downloading update' },
  });

  assert.equal(state.latestOperationalError, '');
  assert.equal(state.latestOperationalErrorSource, '');
  assert.deepEqual(sent, [['update-status', { status: 'downloading', summary: 'Downloading update' }]]);
});

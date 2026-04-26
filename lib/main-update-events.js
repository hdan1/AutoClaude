'use strict';

function forwardUpdateEvent({ state, send, payload }) {
  state.latestUpdateStatus = payload;
  if (payload?.status !== 'error' && state.latestOperationalErrorSource === 'updater') {
    state.latestOperationalError = '';
    state.latestOperationalErrorSource = '';
  }
  send('update-status', payload);
}

module.exports = { forwardUpdateEvent };

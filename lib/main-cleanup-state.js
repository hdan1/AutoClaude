'use strict';

function clearHookStateAfterSuccessfulCleanup(session, result) {
  if (result?.ok) {
    session.state.hooksInstalled = false;
  }
}

module.exports = { clearHookStateAfterSuccessfulCleanup };

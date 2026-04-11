// lib/ipc-trust.js — IPC trust wrapper (5C)
// Replaces 50+ copy-pasted trust checks with a single wrapper.

/**
 * Wrap an IPC handler with trust verification.
 * @param {string} action - Channel name for logging
 * @param {Function} handler - The actual handler function
 * @param {Object} deps - { isTrusted: (event, action) => boolean }
 * @param {*} [defaultReturn] - Value to return when sender is untrusted (default: { ok: false, error: 'Untrusted IPC sender' })
 * @returns {Function} Wrapped handler
 */
function withTrustedIpc(action, handler, deps, defaultReturn) {
  return async (event, ...args) => {
    if (!deps.isTrusted(event, action)) {
      return defaultReturn !== undefined ? defaultReturn : { ok: false, error: 'Untrusted IPC sender' };
    }
    return handler(event, ...args);
  };
}

module.exports = { withTrustedIpc };

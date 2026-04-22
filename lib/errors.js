'use strict';

class AutoUpdateError extends Error {
  constructor(message, { statusCode, isExpected = false } = {}) {
    super(message);
    this.name = 'AutoUpdateError';
    this.statusCode = statusCode;
    this.isExpected = isExpected;
  }

  static isAutoUpdateError(err) {
    if (err instanceof AutoUpdateError) return true;
    const msg = String(err?.message || err || '');
    return /releases\.atom|auto-update|electron-updater|provider|Cannot find latest\.yml|net::ERR_/i.test(msg);
  }

  static isExpectedFeed404(err) {
    if (err instanceof AutoUpdateError) return err.isExpected;
    const msg = String(err?.message || err || '');
    return /releases\.atom/i.test(msg) && /\b404\b/.test(msg);
  }
}

module.exports = { AutoUpdateError };

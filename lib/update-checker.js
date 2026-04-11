// lib/update-checker.js — Update checking extracted from claude-detector.js (5A)
const { findClaudePath } = require('./claude-detection');

// ── Update Checking ──────────────────────────────
let _updateCache = null;
let _updateCacheTime = 0;
const UPDATE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function checkForUpdate(opts) {
  const forceCheck = opts && opts.forceCheck;
  if (!forceCheck && _updateCache && (Date.now() - _updateCacheTime < UPDATE_CACHE_TTL)) {
    return Promise.resolve(_updateCache);
  }

  const claudePath = findClaudePath() || 'claude';
  const { execFile } = require('child_process');

  return new Promise(resolve => {
    execFile(claudePath, ['update'], { timeout: 60000, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      let result;

      if (err && !output) {
        result = { updateAvailable: false, currentVersion: null, latestVersion: null, error: err.message || 'Update check failed' };
      } else if (/is up to date/i.test(output)) {
        const verMatch = output.match(/up to date \(([^)]+)\)/i) || output.match(/(\d+\.\d+\.\d+)/);
        const ver = verMatch ? verMatch[1] : null;
        result = { updateAvailable: false, currentVersion: ver, latestVersion: ver };
      } else if (/updat/i.test(output)) {
        const curMatch = output.match(/Current version:\s*(\S+)/i);
        const newMatch = output.match(/(\d+\.\d+\.\d+)\s*$/m) || output.match(/to\s+(\d+\.\d+\.\d+)/i);
        const cur = curMatch ? curMatch[1] : null;
        const latest = newMatch ? newMatch[1] : null;
        result = { updateAvailable: !!(latest && cur && latest !== cur), currentVersion: cur, latestVersion: latest || cur };
      } else {
        result = { updateAvailable: false, currentVersion: null, latestVersion: null, error: 'Could not determine update status' };
      }

      _updateCache = result;
      _updateCacheTime = Date.now();
      resolve(result);
    });
  });
}

module.exports = {
  checkForUpdate,
};

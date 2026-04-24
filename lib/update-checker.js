// lib/update-checker.js — Update checking extracted from claude-detector.js (5A)
const { getClaudeCommand } = require('./spawn-claude');
const logger = require('./logger');

// ── Update Checking ──────────────────────────────
let _updateCache = null;
let _updateCacheTime = 0;
const UPDATE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function _previewOutput(output) {
  return String(output || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function checkForUpdate(opts) {
  const forceCheck = opts && opts.forceCheck;
  if (!forceCheck && _updateCache && (Date.now() - _updateCacheTime < UPDATE_CACHE_TTL)) {
    logger.debug('update-checker', 'returning cached update result');
    return Promise.resolve(_updateCache);
  }

  const { cmd: claudePath, shellFlag } = getClaudeCommand();
  const { execFile } = require('child_process');
  logger.info('update-checker', `starting claude update check via ${claudePath}`);

  return new Promise(resolve => {
    execFile(claudePath, ['update'], { timeout: 60000, windowsHide: true, encoding: 'utf8', shell: shellFlag }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      let result;

      if (err) {
        const detail = [err.message, err.killed ? 'killed' : '', err.signal || '', err.code == null ? '' : `code=${err.code}`].filter(Boolean).join(' ');
        logger.warn('update-checker', `claude update subprocess issue: ${detail || 'unknown error'}`);
      }

      if (err && !output) {
        result = { updateAvailable: false, currentVersion: null, latestVersion: null, error: err.message || 'Update check failed' };
      } else if (/is up to date/i.test(output)) {
        const verMatch = output.match(/up to date \(([^)]+)\)/i) || output.match(/(\d+\.\d+\.\d+)/);
        const ver = verMatch ? verMatch[1] : null;
        result = { updateAvailable: false, currentVersion: ver, latestVersion: ver };
        logger.info('update-checker', `claude update check complete: up to date${ver ? ` (${ver})` : ''}`);
      } else if (/updat/i.test(output)) {
        const curMatch = output.match(/Current version:\s*(\S+)/i);
        const newMatch = output.match(/(\d+\.\d+\.\d+)\s*$/m) || output.match(/to\s+(\d+\.\d+\.\d+)/i);
        const cur = curMatch ? curMatch[1] : null;
        const latest = newMatch ? newMatch[1] : null;
        result = { updateAvailable: !!(latest && cur && latest !== cur), currentVersion: cur, latestVersion: latest || cur };
        logger.info('update-checker', `claude update check parsed: current=${cur || 'null'} latest=${(latest || cur || 'null')} available=${result.updateAvailable}`);
      } else {
        result = { updateAvailable: false, currentVersion: null, latestVersion: null, error: 'Could not determine update status' };
        logger.warn('update-checker', `could not determine update status; output preview: ${_previewOutput(output) || '(empty)'}`);
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

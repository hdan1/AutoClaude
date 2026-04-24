const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const ccmJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'claude-code-manager.js'), 'utf8');

test('log-to-file IPC is trust-wrapped before writing renderer diagnostics to app log file', () => {
  assert.match(
    mainJs,
    /ipcMain\.on\('log-to-file',\s*withTrustedIpc\('log-to-file',/,
  );
});

test('claude code manager diagnostics use app log bridge instead of renderer console output', () => {
  assert.match(ccmJs, /window\.api\.logToFile\(/);
  assert.doesNotMatch(ccmJs, /console\.(log|warn|error)\('\[CCM\]/);
});

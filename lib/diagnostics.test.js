'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagnostics } = require('./diagnostics');

test('buildDiagnostics returns compact support bundle', () => {
  const bundle = buildDiagnostics({
    appVersion: '3.11.7',
    claude: { version: '2.1.119', path: '/usr/bin/claude', authType: 'custom' },
    workspacePath: '/tmp/project',
    logPath: '/tmp/app.log',
    updater: { status: 'error' },
    telemetry: { degraded: true },
    lastError: 'Update failed',
  });

  assert.deepEqual(bundle, {
    appVersion: '3.11.7',
    claudeVersion: '2.1.119',
    claudePath: '/usr/bin/claude',
    authType: 'custom',
    workspacePath: '/tmp/project',
    logPath: '/tmp/app.log',
    updaterStatus: 'error',
    telemetryDegraded: true,
    lastError: 'Update failed',
  });
});

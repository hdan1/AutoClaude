'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  makeStatus,
  makeUpdateErrorStatus,
  makeUpdateProgressStatus,
  buildDiagnosticsBundle,
} = require('./operations-status');

test('makeUpdateErrorStatus returns actionable renderer-safe payload', () => {
  const status = makeUpdateErrorStatus({ summary: 'Feed unavailable', detail: 'HTTP 500' });

  assert.deepEqual(status, {
    severity: 'error',
    scope: 'update',
    summary: 'Update failed',
    details: 'Feed unavailable',
    nextSteps: ['Retry update check', 'Check network connection', 'Download manually from Releases'],
    meta: { detail: 'HTTP 500' },
  });
});

test('makeUpdateProgressStatus returns ready payload', () => {
  const status = makeUpdateProgressStatus('ready', { version: '3.11.8' });

  assert.equal(status.scope, 'update');
  assert.equal(status.severity, 'info');
  assert.equal(status.summary, 'Update ready');
  assert.deepEqual(status.meta, { version: '3.11.8' });
});

test('makeStatus defensively copies nextSteps and meta inputs', () => {
  const nextSteps = ['Retry update check'];
  const meta = { detail: 'HTTP 500' };
  const status = makeStatus({
    severity: 'error',
    scope: 'update',
    summary: 'Update failed',
    nextSteps,
    meta,
  });

  status.nextSteps.push('Download manually from Releases');
  status.meta.detail = 'Mutated detail';

  assert.deepEqual(nextSteps, ['Retry update check']);
  assert.deepEqual(meta, { detail: 'HTTP 500' });
});

test('buildDiagnosticsBundle includes compact operational fields', () => {
  const bundle = buildDiagnosticsBundle({
    appVersion: '3.11.7',
    claudeVersion: '2.1.119',
    claudePath: '/usr/bin/claude',
    authType: 'custom',
    workspacePath: '/tmp/project',
    logPath: '/tmp/app.log',
    updaterStatus: 'ready',
    telemetryDegraded: true,
    lastError: 'Hook uninstall failed',
  });

  assert.deepEqual(bundle, {
    appVersion: '3.11.7',
    claudeVersion: '2.1.119',
    claudePath: '/usr/bin/claude',
    authType: 'custom',
    workspacePath: '/tmp/project',
    logPath: '/tmp/app.log',
    updaterStatus: 'ready',
    telemetryDegraded: true,
    lastError: 'Hook uninstall failed',
  });
});

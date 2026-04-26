'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { toRendererUpdateStatus } = require('./update-status');
const { forwardUpdateEvent } = require('./main-update-events');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extractUpdaterHandler(eventName) {
  const eventPattern = eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = mainSrc.match(new RegExp(`autoUpdater\\.on\\('${eventPattern}', \\(([^)]*)\\) => \\{([\\s\\S]*?)\\r?\\n\\s*\\}\\);\\r?\\n\\s*if \\(config\\.system\\?\\.autoUpdate !== false\\) \\{`));
  assert.ok(match, `Could not locate autoUpdater ${eventName} handler in main.js`);
  return match;
}

function buildUpdaterErrorHandler(deps) {
  const [, params, body] = extractUpdaterHandler('error');
  return new Function(
    'deps',
    `const { summarizeAutoUpdateError, isExpectedAutoUpdateFeed404, logger, send, toRendererUpdateStatus, forwardUpdateEvent } = deps; let latestOperationalError = ''; let latestUpdateStatus = { status: '' }; return (${params}) => {${body}};`
  )(deps);
}

test('toRendererUpdateStatus maps updater errors to actionable renderer state', () => {
  const status = toRendererUpdateStatus({
    type: 'error',
    summary: 'Feed unavailable',
    detail: '404',
  });

  assert.deepEqual(status, {
    severity: 'error',
    scope: 'update',
    status: 'error',
    summary: 'Update failed',
    details: 'Feed unavailable',
    nextSteps: ['Retry update check', 'Check network connection', 'Download manually from Releases'],
    meta: { detail: '404' },
  });
});

test('toRendererUpdateStatus preserves downloading state metadata', () => {
  const status = toRendererUpdateStatus({ type: 'downloading', version: '3.11.8' });

  assert.equal(status.status, 'downloading');
  assert.equal(status.summary, 'Downloading update');
  assert.deepEqual(status.meta, { version: '3.11.8' });
});

test('toRendererUpdateStatus preserves ready state metadata', () => {
  const status = toRendererUpdateStatus({ type: 'ready', version: '3.11.8' });

  assert.equal(status.status, 'ready');
  assert.equal(status.summary, 'Update ready');
  assert.deepEqual(status.meta, { version: '3.11.8' });
});

test('packaged updater error handler emits translated status for non-404 failures', () => {
  const sent = [];
  const warnings = [];
  const handleError = buildUpdaterErrorHandler({
    summarizeAutoUpdateError: () => 'HTTP 500',
    isExpectedAutoUpdateFeed404: () => false,
    logger: {
      warn: (scope, message) => warnings.push([scope, message]),
      debug: () => {},
    },
    send: (channel, payload) => sent.push([channel, payload]),
    toRendererUpdateStatus,
    forwardUpdateEvent,
  });

  handleError(new Error('boom'));

  assert.deepEqual(warnings, [
    ['app', 'Auto-update error: HTTP 500'],
  ]);
  assert.deepEqual(sent, [
    ['update-status', toRendererUpdateStatus({
      type: 'error',
      summary: 'Update service unavailable',
      detail: 'HTTP 500',
    })],
  ]);
});

test('packaged updater error handler suppresses expected feed 404s', () => {
  const sent = [];
  const debugLogs = [];
  const handleError = buildUpdaterErrorHandler({
    summarizeAutoUpdateError: () => 'Feed 404',
    isExpectedAutoUpdateFeed404: () => true,
    logger: {
      warn: () => assert.fail('unexpected warn log'),
      debug: (scope, message) => debugLogs.push([scope, message]),
    },
    send: (channel, payload) => sent.push([channel, payload]),
    toRendererUpdateStatus,
    forwardUpdateEvent,
  });

  handleError(new Error('feed 404'));

  assert.deepEqual(debugLogs, [
    ['app', 'Auto-update feed unavailable (expected 404): Feed 404'],
  ]);
  assert.deepEqual(sent, []);
});

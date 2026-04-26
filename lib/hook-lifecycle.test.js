'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { uninstallProjectHooks } = require('./hook-lifecycle');

test('uninstallProjectHooks returns structured success result when installer exec succeeds', () => {
  const calls = [];

  const result = uninstallProjectHooks({
    projectDir: '/tmp/project-alpha',
    installerPath: '/tmp/install-hooks.js',
    execFileSync: (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [[
    'node',
    ['/tmp/install-hooks.js', '/tmp/project-alpha', '--uninstall'],
    { stdio: 'pipe' },
  ]]);
  assert.deepEqual(result, {
    ok: true,
    severity: 'info',
    scope: 'hooks',
    summary: 'Hooks removed',
    details: '',
    nextSteps: [],
  });
});

test('uninstallProjectHooks returns degraded warning result on failure', () => {
  const result = uninstallProjectHooks({
    projectDir: '/tmp/project-beta',
    installerPath: '/tmp/install-hooks.js',
    execFileSync: () => {
      throw new Error('spawn failed');
    },
  });

  assert.deepEqual(result, {
    ok: false,
    severity: 'warning',
    scope: 'hooks',
    summary: 'Hook cleanup incomplete',
    details: 'spawn failed',
    nextSteps: [
      'Retry closing the project',
      'Remove hooks manually with install-hooks.js',
      'Check project .claude/settings.json',
    ],
  });
});

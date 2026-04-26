const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClaudeStateFacade } = require('./claude-state-facade');

test('buildClaudeStateFacade combines detection, update, and plugin state', async () => {
  const facade = await buildClaudeStateFacade({
    detectClaudeState: async () => ({ installed: true, version: '2.1.119', authType: 'custom' }),
    checkForUpdate: async () => ({ updateAvailable: true, latestVersion: '2.1.120' }),
    checkPluginUpdates: async () => ({ updates: [{ key: 'context7', updateAvailable: true }] }),
  });

  assert.deepEqual(facade, {
    installed: true,
    version: '2.1.119',
    authType: 'custom',
    update: { updateAvailable: true, latestVersion: '2.1.120' },
    pluginUpdates: [{ key: 'context7', updateAvailable: true }],
  });
});

test('buildClaudeStateFacade preserves detection when update checks fail', async () => {
  const facade = await buildClaudeStateFacade({
    detectClaudeState: async () => ({ installed: true, version: '2.1.119', authType: 'oauth' }),
    checkForUpdate: async () => { throw new Error('update offline'); },
    checkPluginUpdates: async () => { throw new Error('plugin registry offline'); },
  });

  assert.deepEqual(facade, {
    installed: true,
    version: '2.1.119',
    authType: 'oauth',
    update: { error: 'update offline' },
    pluginUpdates: [],
    pluginUpdatesError: 'plugin registry offline',
  });
});

test('buildClaudeStateFacade preserves stable facade shape when detection fails', async () => {
  const facade = await buildClaudeStateFacade({
    detectClaudeState: async () => { throw new Error('claude binary missing'); },
    checkForUpdate: async () => ({ updateAvailable: false }),
    checkPluginUpdates: async () => ({ updates: [{ key: 'context7', updateAvailable: false }] }),
  });

  assert.deepEqual(facade, {
    installed: false,
    version: '',
    authType: '',
    error: 'claude binary missing',
    update: { updateAvailable: false },
    pluginUpdates: [{ key: 'context7', updateAvailable: false }],
  });
});

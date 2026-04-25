const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

async function withPluginUpdateCheckerMocks({
  installed,
  versions = {},
  npmResponses = {},
  marketplaceResponses = {},
}, run) {
  const originalLoad = Module._load;

  const fsMock = {
    readFileSync(filePath) {
      if (String(filePath).replace(/\\/g, '/').endsWith('/.claude/plugin-versions.json')) {
        return JSON.stringify(versions);
      }
      const err = new Error(`ENOENT: ${filePath}`);
      err.code = 'ENOENT';
      throw err;
    },
    writeFileSync() {},
    mkdirSync() {},
  };

  const loggerMock = {
    info() {}, warn() {}, error() {}, debug() {},
  };

  function makeHttpModule() {
    return {
      get(url, opts, cb) {
        const handlers = {};
        const req = {
          on(event, handler) {
            handlers[event] = handler;
            return req;
          },
          destroy() {},
        };

        process.nextTick(() => {
          try {
            let payload;
            if (/registry\.npmjs\.org\/(.+)\/latest/.test(url)) {
              const pkg = decodeURIComponent(url.match(/registry\.npmjs\.org\/(.+)\/latest/)[1]);
              if (!(pkg in npmResponses)) throw new Error(`No mocked npm response for ${pkg}`);
              payload = npmResponses[pkg];
            } else {
              if (!(url in marketplaceResponses)) throw new Error(`No mocked marketplace response for ${url}`);
              payload = marketplaceResponses[url];
            }

            const res = {
              statusCode: 200,
              on(event, handler) {
                if (event === 'data') process.nextTick(() => handler(JSON.stringify(payload)));
                if (event === 'end') process.nextTick(() => handler());
                return res;
              },
              resume() {},
            };
            cb(res);
          } catch (err) {
            if (handlers.error) handlers.error(err);
          }
        });

        return req;
      },
    };
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'fs') return fsMock;
    if (request === './logger') return loggerMock;
    if (request === './plugin-manager') return { listPlugins: () => ({ installed }) };
    if (request === 'https' || request === 'http') return makeHttpModule();
    return originalLoad.apply(this, arguments);
  };

  try {
    const modPath = require.resolve('./plugin-update-checker');
    delete require.cache[modPath];
    const updateChecker = require('./plugin-update-checker');
    return await run(updateChecker);
  } finally {
    Module._load = originalLoad;
  }
}

test('checkPluginUpdates returns latest version metadata for unknown Context7 current version', async () => {
  await withPluginUpdateCheckerMocks({
    installed: [
      { key: 'mcp:context7', name: 'context7', source: 'mcp-server', isMcp: true },
    ],
    versions: {},
    npmResponses: {
      '@upstash/context7-mcp': { version: '2.4.0' },
    },
  }, async ({ checkPluginUpdates }) => {
    const result = await checkPluginUpdates(true);
    const plugin = result.updates[0];

    assert.equal(plugin.type, 'mcp');
    assert.equal(plugin.currentVersion, '');
    assert.equal(plugin.latestVersion, '2.4.0');
    assert.equal(plugin.updateAvailable, false);
    assert.equal(plugin.currentVersionKnown, false);
    assert.equal(plugin.versionStatus, 'unknown-current');
  });
});

test('checkPluginUpdates resolves GSD npm package mapping and marks available updates', async () => {
  await withPluginUpdateCheckerMocks({
    installed: [
      { key: 'gsd@get-shit-done', name: 'gsd', source: 'skill', isSkill: true },
    ],
    versions: { gsd: '4.5.6' },
    npmResponses: {
      'get-shit-done-cc': { version: '4.6.0' },
    },
  }, async ({ checkPluginUpdates }) => {
    const result = await checkPluginUpdates(true);
    const plugin = result.updates[0];

    assert.equal(plugin.type, 'skill');
    assert.equal(plugin.currentVersion, '4.5.6');
    assert.equal(plugin.latestVersion, '4.6.0');
    assert.equal(plugin.updateAvailable, true);
    assert.equal(plugin.currentVersionKnown, true);
    assert.equal(plugin.versionStatus, 'update-available');
  });
});

test('checkPluginUpdates returns stable metadata for marketplace plugins', async () => {
  await withPluginUpdateCheckerMocks({
    installed: [
      { key: 'superpowers@claude-plugins-official', name: 'superpowers', source: 'claude-plugins-official', version: '5.0.7' },
    ],
    marketplaceResponses: {
      'https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/manifest.json': {
        plugins: [
          { name: 'superpowers', version: '5.1.0' },
        ],
      },
    },
  }, async ({ checkPluginUpdates }) => {
    const result = await checkPluginUpdates(true);
    const plugin = result.updates[0];

    assert.equal(plugin.type, 'claude-plugin');
    assert.equal(plugin.currentVersion, '5.0.7');
    assert.equal(plugin.latestVersion, '5.1.0');
    assert.equal(plugin.updateAvailable, true);
    assert.equal(plugin.currentVersionKnown, true);
    assert.equal(plugin.versionStatus, 'update-available');
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('node:path');

function withPluginManagerMocks({
  settingsJson,
  claudeJson,
  manifestByPath = {},
  pluginVersions = {},
  gsdInstalled = false,
}, run) {
  const originalLoad = Module._load;

  const claudeHome = path.join('C:', 'Users', 'Test', '.claude');
  const settingsPath = path.join(claudeHome, 'settings.json');
  const claudeJsonPath = path.join('C:', 'Users', 'Test', '.claude.json');
  const versionsPath = path.join(claudeHome, 'plugin-versions.json');

  const normalize = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  const manifestMap = Object.fromEntries(Object.entries(manifestByPath).map(([k, v]) => [normalize(k), v]));

  const fsMock = {
    readFileSync(filePath) {
      const normalized = normalize(filePath);
      if (normalized === normalize(settingsPath)) return JSON.stringify(settingsJson);
      if (normalized === normalize(claudeJsonPath)) return JSON.stringify(claudeJson);
      if (normalized === normalize(versionsPath)) return JSON.stringify(pluginVersions);
      if (manifestMap[normalized]) return JSON.stringify(manifestMap[normalized]);
      const err = new Error(`ENOENT: ${filePath}`);
      err.code = 'ENOENT';
      throw err;
    },
    existsSync(filePath) {
      const normalized = normalize(filePath);
      return normalized in manifestMap;
    },
    writeFileSync() {},
    mkdirSync() {},
    readdirSync() { return []; },
  };

  const loggerMock = {
    info() {}, warn() {}, error() {}, debug() {},
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'fs') return fsMock;
    if (request === './logger') return loggerMock;
    if (request === './spawn-claude') return { spawnClaude() {}, getClaudeCommand() { return { cmd: 'claude', shellFlag: false }; } };
    if (request === './runtime-utils') return { parseInstallCommand() { return { ok: true, executable: 'npx', args: [] }; }, evaluateToolInstallResult() { return { ok: true }; } };
    if (request === './claude-detection') {
      const actual = originalLoad.apply(this, arguments);
      return {
        ...actual,
        getClaudeHome: () => claudeHome,
        isGsdInstalledFromPaths: () => gsdInstalled,
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const modPath = require.resolve('./plugin-manager');
    delete require.cache[modPath];
    const pluginManager = require('./plugin-manager');
    return run({ pluginManager, claudeHome, settingsPath, claudeJsonPath, versionsPath });
  } finally {
    Module._load = originalLoad;
  }
}

test('listPlugins attaches manifest version metadata for marketplace plugins', () => {
  withPluginManagerMocks({
    settingsJson: {
      enabledPlugins: { 'superpowers@claude-plugins-official': true },
      extraKnownMarketplaces: {},
      mcpServers: {},
    },
    claudeJson: {},
    manifestByPath: {
      'C:/Users/Test/.claude/plugins/cache/claude-plugins-official/superpowers/manifest.json': {
        description: 'Official plugin',
        version: '5.0.7',
      },
    },
  }, ({ pluginManager }) => {
    const { installed } = pluginManager.listPlugins();
    const plugin = installed.find(p => p.key === 'superpowers@claude-plugins-official');

    assert.ok(plugin);
    assert.equal(plugin.version, '5.0.7');
    assert.equal(plugin.versionKnown, true);
    assert.equal(plugin.versionSource, 'manifest');
  });
});

test('listPlugins attaches recorded version metadata for context7 MCP entries', () => {
  withPluginManagerMocks({
    settingsJson: {
      enabledPlugins: {},
      extraKnownMarketplaces: {},
      mcpServers: { context7: { url: 'https://mcp.context7.com/mcp' } },
    },
    claudeJson: {},
    pluginVersions: { context7: '1.2.3' },
  }, ({ pluginManager }) => {
    const { installed } = pluginManager.listPlugins();
    const plugin = installed.find(p => p.name === 'context7');

    assert.ok(plugin);
    assert.equal(plugin.isMcp, true);
    assert.equal(plugin.version, '1.2.3');
    assert.equal(plugin.versionKnown, true);
    assert.equal(plugin.versionSource, 'npm-recorded');
  });
});

test('listPlugins attaches recorded version metadata for detected GSD skill entries', () => {
  withPluginManagerMocks({
    settingsJson: {
      enabledPlugins: {},
      extraKnownMarketplaces: {},
      mcpServers: {},
    },
    claudeJson: {},
    pluginVersions: { gsd: '4.5.6' },
    gsdInstalled: true,
  }, ({ pluginManager }) => {
    const { installed } = pluginManager.listPlugins();
    const plugin = installed.find(p => p.name === 'gsd');

    assert.ok(plugin);
    assert.equal(plugin.isSkill, true);
    assert.equal(plugin.version, '4.5.6');
    assert.equal(plugin.versionKnown, true);
    assert.equal(plugin.versionSource, 'npm-recorded');
  });
});

test('listPlugins marks version as unknown when installed MCP has no recorded version', () => {
  withPluginManagerMocks({
    settingsJson: {
      enabledPlugins: {},
      extraKnownMarketplaces: {},
      mcpServers: { context7: { url: 'https://mcp.context7.com/mcp' } },
    },
    claudeJson: {},
    pluginVersions: {},
  }, ({ pluginManager }) => {
    const { installed } = pluginManager.listPlugins();
    const plugin = installed.find(p => p.name === 'context7');

    assert.ok(plugin);
    assert.equal(plugin.version, '');
    assert.equal(plugin.versionKnown, false);
    assert.equal(plugin.versionSource, 'unknown');
  });
});

test('listPlugins still deduplicates context7 between MCP config and recommended detection', () => {
  withPluginManagerMocks({
    settingsJson: {
      enabledPlugins: {},
      extraKnownMarketplaces: {},
      mcpServers: { context7: { url: 'https://mcp.context7.com/mcp' } },
    },
    claudeJson: {},
    pluginVersions: { context7: '1.2.3' },
  }, ({ pluginManager }) => {
    const { installed } = pluginManager.listPlugins();
    const context7Entries = installed.filter(p => p.name === 'context7');

    assert.equal(context7Entries.length, 1);
  });
});

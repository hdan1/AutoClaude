const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('node:path');

function withPluginManagerMocks({
  settingsJson,
  claudeJson,
  manifestByPath = {},
  pluginVersions = {},
  extraFiles = {},
  gsdInstalled = false,
}, run) {
  const originalLoad = Module._load;

  const homeDir = path.join('C:', 'Users', 'Test');
  const claudeHome = path.join(homeDir, '.claude');
  const settingsPath = path.join(claudeHome, 'settings.json');
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  const versionsPath = path.join(claudeHome, 'plugin-versions.json');

  const normalize = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
  const toFileEntry = (value, defaultMtimeMs = 0) => {
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'content')) {
      const rawContent = value.content;
      return {
        content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent),
        mtimeMs: value.mtimeMs || defaultMtimeMs,
      };
    }
    return {
      content: typeof value === 'string' ? value : JSON.stringify(value),
      mtimeMs: defaultMtimeMs,
    };
  };

  const fileMap = Object.fromEntries([
    [settingsPath, toFileEntry(settingsJson)],
    [claudeJsonPath, toFileEntry(claudeJson)],
    [versionsPath, toFileEntry(pluginVersions)],
    ...Object.entries(manifestByPath).map(([filePath, value]) => [filePath, toFileEntry(value)]),
    ...Object.entries(extraFiles).map(([filePath, value]) => [filePath, toFileEntry(value)]),
  ].map(([filePath, entry]) => [normalize(filePath), entry]));

  function listImmediateChildren(dirPath) {
    const normalizedDir = normalize(dirPath);
    const prefix = normalizedDir + '/';
    const names = new Set();
    for (const filePath of Object.keys(fileMap)) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      if (!remainder) continue;
      names.add(remainder.split('/')[0]);
    }
    return [...names];
  }

  const fsMock = {
    readFileSync(filePath) {
      const normalized = normalize(filePath);
      if (fileMap[normalized]) return fileMap[normalized].content;
      const err = new Error(`ENOENT: ${filePath}`);
      err.code = 'ENOENT';
      throw err;
    },
    existsSync(filePath) {
      const normalized = normalize(filePath);
      return normalized in fileMap || listImmediateChildren(normalized).length > 0;
    },
    statSync(filePath) {
      const normalized = normalize(filePath);
      if (fileMap[normalized]) return { mtimeMs: fileMap[normalized].mtimeMs };
      if (listImmediateChildren(normalized).length > 0) return { mtimeMs: 0 };
      const err = new Error(`ENOENT: ${filePath}`);
      err.code = 'ENOENT';
      throw err;
    },
    writeFileSync() {},
    mkdirSync() {},
    readdirSync(dirPath) {
      const children = listImmediateChildren(dirPath);
      if (children.length) return children;
      const err = new Error(`ENOENT: ${dirPath}`);
      err.code = 'ENOENT';
      throw err;
    },
  };

  const loggerMock = {
    info() {}, warn() {}, error() {}, debug() {},
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'fs') return fsMock;
    if (request === 'os') {
      const actual = originalLoad.apply(this, arguments);
      return { ...actual, homedir: () => homeDir };
    }
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

test('listPlugins reads version metadata from versioned plugin cache layout', () => {
  withPluginManagerMocks({
    settingsJson: {
      enabledPlugins: { 'superpowers@claude-plugins-official': true },
      extraKnownMarketplaces: {},
      mcpServers: {},
    },
    claudeJson: {},
    extraFiles: {
      'C:/Users/Test/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/.claude-plugin/plugin.json': {
        name: 'superpowers',
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

test('listPlugins applies recorded version metadata to enabled Context7 plugin rows', () => {
  withPluginManagerMocks({
    settingsJson: {
      enabledPlugins: { 'context7@claude-plugins-official': true },
      extraKnownMarketplaces: {},
      mcpServers: {},
    },
    claudeJson: {},
    pluginVersions: { context7: '2.1.8' },
    extraFiles: {
      'C:/Users/Test/.claude/plugins/cache/claude-plugins-official/context7/unknown/.claude-plugin/plugin.json': {
        name: 'context7',
        description: 'Upstash Context7 MCP server',
      },
    },
  }, ({ pluginManager }) => {
    const { installed } = pluginManager.listPlugins();
    const plugin = installed.find(p => p.key === 'context7@claude-plugins-official');

    assert.ok(plugin);
    assert.equal(plugin.version, '2.1.8');
    assert.equal(plugin.versionKnown, true);
    assert.equal(plugin.versionSource, 'npm-recorded');
  });
});

test('listPlugins infers GSD version from legacy VERSION file', () => {
  withPluginManagerMocks({
    settingsJson: {
      enabledPlugins: {},
      extraKnownMarketplaces: {},
      mcpServers: {},
    },
    claudeJson: {},
    pluginVersions: {},
    gsdInstalled: true,
    extraFiles: {
      'C:/Users/Test/.claude/get-shit-done/VERSION': '1.34.2',
    },
  }, ({ pluginManager }) => {
    const { installed } = pluginManager.listPlugins();
    const plugin = installed.find(p => p.name === 'gsd');

    assert.ok(plugin);
    assert.equal(plugin.version, '1.34.2');
    assert.equal(plugin.versionKnown, true);
    assert.equal(plugin.versionSource, 'version-file');
  });
});

test('listPlugins infers Context7 version from latest npm cache package', () => {
  withPluginManagerMocks({
    settingsJson: {
      enabledPlugins: { 'context7@claude-plugins-official': true },
      extraKnownMarketplaces: {},
      mcpServers: {},
    },
    claudeJson: {},
    pluginVersions: {},
    extraFiles: {
      'C:/Users/Test/AppData/Local/npm-cache/_npx/oldhash/node_modules/@upstash/context7-mcp/package.json': {
        content: { name: '@upstash/context7-mcp', version: '2.1.7' },
        mtimeMs: 1000,
      },
      'C:/Users/Test/AppData/Local/npm-cache/_npx/newhash/node_modules/@upstash/context7-mcp/package.json': {
        content: { name: '@upstash/context7-mcp', version: '2.1.8' },
        mtimeMs: 2000,
      },
      'C:/Users/Test/.npm/_npx/oldhash/node_modules/@upstash/context7-mcp/package.json': {
        content: { name: '@upstash/context7-mcp', version: '2.1.7' },
        mtimeMs: 1000,
      },
      'C:/Users/Test/.npm/_npx/newhash/node_modules/@upstash/context7-mcp/package.json': {
        content: { name: '@upstash/context7-mcp', version: '2.1.8' },
        mtimeMs: 2000,
      },
    },
  }, ({ pluginManager }) => {
    const { installed } = pluginManager.listPlugins();
    const plugin = installed.find(p => p.key === 'context7@claude-plugins-official');

    assert.ok(plugin);
    assert.equal(plugin.version, '2.1.8');
    assert.equal(plugin.versionKnown, true);
    assert.equal(plugin.versionSource, 'npm-cache');
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

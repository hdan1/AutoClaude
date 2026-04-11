const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isGsdInstalledFromPaths,
  DEFAULT_RECOMMENDED_PLUGINS,
  DEFAULT_RECOMMENDED_TOOLS,
  listPlugins,
  deduplicateToolsAgainstPlugins,
  extractVersion,
} = require('./claude-detector');

const normalize = (p) => p.replace(/\\/g, '/');

test('isGsdInstalledFromPaths returns false when only one stale skill file exists', () => {
  const existsSync = (p) => normalize(p).endsWith('/skills/gsd-help');
  const readdirSync = () => ['gsd-help'];

  assert.equal(
    isGsdInstalledFromPaths('C:/Users/Test/.claude', { existsSync, readdirSync }),
    false
  );
});

test('isGsdInstalledFromPaths returns false when only marker and one stale gsd skill exist', () => {
  const existsSync = (p) => {
    const normalized = normalize(p);
    return normalized.endsWith('/skills/gsd-help') || normalized.endsWith('/gsd-file-manifest.json');
  };
  const readdirSync = () => ['gsd-help'];

  assert.equal(
    isGsdInstalledFromPaths('C:/Users/Test/.claude', { existsSync, readdirSync }),
    false
  );
});

test('isGsdInstalledFromPaths returns true when many gsd skills exist', () => {
  const existsSync = (p) => normalize(p).endsWith('/skills/gsd-help');
  const readdirSync = () => [
    'gsd-help',
    'gsd-next',
    'gsd-debug',
    'gsd-plan-phase',
    'gsd-execute-phase',
    'gsd-ship',
  ];

  assert.equal(
    isGsdInstalledFromPaths('C:/Users/Test/.claude', { existsSync, readdirSync }),
    true
  );
});

// ── Task #28: Recommended plugins list ──────────────────────────

test('DEFAULT_RECOMMENDED_PLUGINS does not include rust-analyzer-lsp', () => {
  const keys = DEFAULT_RECOMMENDED_PLUGINS.map(p => p.key);
  assert.ok(!keys.some(k => k.includes('rust-analyzer-lsp')), 'rust-analyzer-lsp should be removed');
});

test('DEFAULT_RECOMMENDED_PLUGINS includes context7', () => {
  const keys = DEFAULT_RECOMMENDED_PLUGINS.map(p => p.key);
  assert.ok(keys.some(k => k.includes('context7')), 'context7 should be in recommended plugins');
});

test('DEFAULT_RECOMMENDED_PLUGINS includes GSD', () => {
  const keys = DEFAULT_RECOMMENDED_PLUGINS.map(p => p.key);
  assert.ok(keys.some(k => k.toLowerCase().includes('gsd')), 'GSD should be in recommended plugins');
});

test('DEFAULT_RECOMMENDED_TOOLS is empty after merging into DEFAULT_RECOMMENDED_PLUGINS', () => {
  assert.equal(DEFAULT_RECOMMENDED_TOOLS.length, 0, 'tools list should be empty — all items merged into plugins');
});

// ── Task #30: Deduplication helper ──────────────────────────────

test('deduplicateToolsAgainstPlugins removes tools already in plugins list', () => {
  const plugins = [{ key: 'context7@context7-mcp', name: 'context7' }];
  const tools = [
    { key: 'context7', name: 'Context7', type: 'mcp', installed: true },
    { key: 'gsd', name: 'GSD', type: 'skill', installed: true },
  ];
  const result = deduplicateToolsAgainstPlugins(tools, plugins);
  assert.equal(result.length, 1);
  assert.equal(result[0].key, 'gsd');
});

test('deduplicateToolsAgainstPlugins returns all tools when no overlap', () => {
  const plugins = [{ key: 'superpowers@claude-plugins-official', name: 'superpowers' }];
  const tools = [
    { key: 'context7', name: 'Context7', type: 'mcp', installed: true },
  ];
  const result = deduplicateToolsAgainstPlugins(tools, plugins);
  assert.equal(result.length, 1);
});

// ── Task #29: Version extraction ────────────────────────────────

test('extractVersion parses clean "claude 1.2.3" stdout', () => {
  assert.equal(extractVersion('claude 1.2.3'), '1.2.3');
});

test('extractVersion parses version from noisy stdout with update notice', () => {
  assert.equal(extractVersion('claude 1.0.16\nUpdate available: 1.0.17'), '1.0.16');
});

test('extractVersion returns null for empty string', () => {
  assert.equal(extractVersion(''), null);
});

test('extractVersion returns null for garbage output', () => {
  assert.equal(extractVersion('error: something went wrong'), null);
});

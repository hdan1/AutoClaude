const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  computeHealthStatus,
  resolveTrayIconPath,
  getAppLogFilePath,
  isExpectedAutoUpdateFeed404,
  summarizeAutoUpdateError,
  evaluateToolInstallResult,
  shouldHideWindowToTray,
  shouldKeepAppAliveWithoutWindows,
  parseInstallCommand,
  isTrustedIpcSender,
  applyCustomProviderToSettings,
  classifyProviderFromBaseUrl,
  enrichDetectionWithCustomProviderSecret,
  buildCorruptBackupPath,
  preserveCorruptDbFile,
} = require('./runtime-utils');

test('computeHealthStatus marks unhealthy when recommended tools are missing', () => {
  const status = computeHealthStatus({
    detection: { installed: true, version: '1.0.0', authType: 'anthropic', authDetail: 'Anthropic Account' },
    prerequisites: {
      git: { required: true, installed: true },
      node: { required: true, installed: true },
    },
    recommendedPlugins: [],
    installedPlugins: [],
    recommendedTools: [{ key: 'context7', installed: false }],
  });

  assert.equal(status.tools.missing.length, 1);
  assert.equal(status.healthy, false);
});

const normalize = (p) => p.replace(/\\/g, '/');

test('resolveTrayIconPath prefers existing icon candidate and never falls back to exe path', () => {
  const seen = [];
  const iconPath = resolveTrayIconPath({
    platform: 'win32',
    appDir: 'C:/app',
    resourcesPath: 'C:/app/resources',
    exePath: 'C:/app/Auto Claude.exe',
    existsSync: (p) => {
      seen.push(p);
      return normalize(p) === 'C:/app/resources/build/icon.ico';
    },
  });

  assert.equal(normalize(iconPath), 'C:/app/resources/build/icon.ico');
  assert.ok(seen.length > 0);

  const fallback = resolveTrayIconPath({
    platform: 'win32',
    appDir: 'C:/app',
    resourcesPath: 'C:/app/resources',
    exePath: 'C:/app/Auto Claude.exe',
    existsSync: () => false,
  });

  assert.equal(fallback, null);
});

test('resolveTrayIconPath checks resources root icon fallback candidate', () => {
  const iconPath = resolveTrayIconPath({
    platform: 'win32',
    appDir: 'C:/app',
    resourcesPath: 'C:/app/resources',
    exePath: 'C:/app/Auto Claude.exe',
    existsSync: (p) => normalize(p) === 'C:/app/resources/icon.ico',
  });

  assert.equal(normalize(iconPath), 'C:/app/resources/icon.ico');
});

test('getAppLogFilePath writes logs under userData/logs', () => {
  const p = getAppLogFilePath('C:/Users/Test/AppData/Roaming/Auto Claude');
  assert.equal(
    normalize(p),
    'C:/Users/Test/AppData/Roaming/Auto Claude/logs/auto-claude-app.log'
  );
});

test('isExpectedAutoUpdateFeed404 matches releases.atom 404 messages only', () => {
  const expected = isExpectedAutoUpdateFeed404('404 GET https://github.com/example/repo/releases.atom');
  const notFoundElsewhere = isExpectedAutoUpdateFeed404('404 GET https://github.com/example/repo/releases/latest');
  const otherCode = isExpectedAutoUpdateFeed404('500 GET https://github.com/example/repo/releases.atom');

  assert.equal(expected, true);
  assert.equal(notFoundElsewhere, false);
  assert.equal(otherCode, false);
});

test('summarizeAutoUpdateError strips headers and compacts multiline payload', () => {
  const raw = '404 \\n"method: GET url: https://github.com/example/repo/releases.atom\\n\\nDetails..."\\nHeaders: {"x":1}';
  const summary = summarizeAutoUpdateError(raw, 120);

  assert.ok(summary.includes('404'));
  assert.ok(summary.includes('releases.atom'));
  assert.equal(summary.includes('Headers:'), false);
  assert.ok(summary.length <= 120);
});

test('evaluateToolInstallResult keeps Context7 warning as failure when not detected installed', () => {
  const output = 'Error: skill failed because path resolves outside the target directory';
  const result = evaluateToolInstallResult({ key: 'context7', code: 1, output, context7Installed: false });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Install exited with code 1');
});

test('evaluateToolInstallResult treats known Context7 warning as success only when detected installed', () => {
  const output = 'Error: skill failed because path resolves outside the target directory';
  const result = evaluateToolInstallResult({ key: 'context7', code: 1, output, context7Installed: true });

  assert.equal(result.ok, true);
  assert.ok(result.warning);
});

test('evaluateToolInstallResult keeps generic non-zero exit as failure', () => {
  const result = evaluateToolInstallResult({ key: 'gsd', code: 1, output: 'failed' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Install exited with code 1');
});

test('shouldHideWindowToTray returns true only when not quitting and tray exists', () => {
  assert.equal(shouldHideWindowToTray({ isQuitting: false, tray: {} }), true);
  assert.equal(shouldHideWindowToTray({ isQuitting: true, tray: {} }), false);
  assert.equal(shouldHideWindowToTray({ isQuitting: false, tray: null }), false);
});

test('computeHealthStatus matches recommended plugins by MCP key prefix', () => {
  const status = computeHealthStatus({
    detection: { installed: true, version: '1.0.0', authType: 'anthropic', authDetail: 'Anthropic Account' },
    prerequisites: {},
    recommendedPlugins: [
      { key: 'context7@context7-mcp', repo: null },
      { key: 'gsd@get-shit-done', repo: null },
    ],
    installedPlugins: [
      { key: 'mcp:context7', name: 'context7' },
      { key: 'mcp:gsd', name: 'gsd' },
    ],
    recommendedTools: [],
  });

  assert.equal(status.plugins.missing.length, 0);
  assert.equal(status.healthy, true);
});

test('shouldKeepAppAliveWithoutWindows returns true only when tray exists', () => {
  assert.equal(shouldKeepAppAliveWithoutWindows({ tray: {} }), true);
  assert.equal(shouldKeepAppAliveWithoutWindows({ tray: null }), false);
});

test('parseInstallCommand splits simple command into executable and args', () => {
  const parsed = parseInstallCommand('npx -y ctx7 setup --claude -y');

  assert.equal(parsed.ok, true);
  assert.equal(parsed.executable, 'npx');
  assert.deepEqual(parsed.args, ['-y', 'ctx7', 'setup', '--claude', '-y']);
});

test('parseInstallCommand rejects shell metacharacters', () => {
  const parsed = parseInstallCommand('npx -y ctx7 setup --claude -y && whoami');

  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /unsafe command/i);
});

test('isTrustedIpcSender allows only the main window sender', () => {
  const trusted = isTrustedIpcSender(
    { sender: { id: 11 }, senderFrame: { url: 'file:///app/index.html' } },
    { webContents: { id: 11 } }
  );

  const untrustedSender = isTrustedIpcSender(
    { sender: { id: 12 }, senderFrame: { url: 'file:///app/index.html' } },
    { webContents: { id: 11 } }
  );

  const untrustedOrigin = isTrustedIpcSender(
    { sender: { id: 11 }, senderFrame: { url: 'https://evil.example/' } },
    { webContents: { id: 11 } }
  );

  assert.equal(trusted, true);
  assert.equal(untrustedSender, false);
  assert.equal(untrustedOrigin, false);
});

test('applyCustomProviderToSettings removes plaintext token when secure storage is used', () => {
  const source = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://old.example/v1',
      ANTHROPIC_AUTH_TOKEN: 'old-token',
      KEEP: 'ok',
    },
  });

  const result = applyCustomProviderToSettings({
    settingsContent: source,
    baseUrl: 'https://bedrock.amazonaws.com/v1/',
    authToken: 'new-token',
    useSecureToken: true,
  });

  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://bedrock.amazonaws.com/v1');
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(parsed.env.KEEP, 'ok');
});

test('applyCustomProviderToSettings preserves token in settings when secure storage is unavailable', () => {
  const source = '{"env":{}}';
  const result = applyCustomProviderToSettings({
    settingsContent: source,
    baseUrl: 'https://proxy.example',
    authToken: 'token-123',
    useSecureToken: false,
  });

  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://proxy.example');
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, 'token-123');
});

test('applyCustomProviderToSettings preserves token when tokenMode is preserve', () => {
  const source = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://old.example',
      ANTHROPIC_AUTH_TOKEN: 'existing-token',
    },
  });

  const result = applyCustomProviderToSettings({
    settingsContent: source,
    baseUrl: 'https://new.example',
    authToken: '',
    useSecureToken: true,
    tokenMode: 'preserve',
  });

  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://new.example');
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, 'existing-token');
});

test('applyCustomProviderToSettings clears token when tokenMode is clear', () => {
  const source = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'existing-token' } });
  const result = applyCustomProviderToSettings({
    settingsContent: source,
    baseUrl: 'https://new.example',
    authToken: '',
    useSecureToken: true,
    tokenMode: 'clear',
  });

  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('classifyProviderFromBaseUrl detects cloud providers and custom hosts', () => {
  const bedrock = classifyProviderFromBaseUrl('https://bedrock.amazonaws.com/v1');
  const custom = classifyProviderFromBaseUrl('https://proxy.example.com/v1');

  assert.equal(bedrock.authType, 'cloud');
  assert.equal(bedrock.authDetail, 'Amazon Bedrock');
  assert.equal(custom.authType, 'custom');
  assert.equal(custom.authDetail, 'proxy.example.com');
});

test('enrichDetectionWithCustomProviderSecret infers auth when secure token exists', () => {
  const enriched = enrichDetectionWithCustomProviderSecret({
    detection: { installed: true, authType: null, authDetail: null },
    baseUrl: 'https://proxy.example.com/v1',
    hasSecureToken: true,
  });

  assert.equal(enriched.authType, 'custom');
  assert.equal(enriched.authDetail, 'proxy.example.com');
});

test('buildCorruptBackupPath appends timestamped corrupt backup suffix', () => {
  const d = new Date('2026-04-11T09:08:07Z');
  const backupPath = buildCorruptBackupPath('C:/data/auto-claude.db', d);
  // Uses local time — build expected pattern from the Date's local components
  const pad2 = n => String(n).padStart(2, '0');
  const expected = `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  assert.match(backupPath, new RegExp(`auto-claude\\.db\\.corrupt-${expected}\\.bak$`));
});

// --- Slice 3: Hook atomicity pure functions ---

test('safeWriteFileAtomic writes via temp file and renames', () => {
  const { safeWriteFileAtomic } = require('./runtime-utils');
  const writes = [];
  const renames = [];
  const unlinkAttempts = [];
  const fs = {
    writeFileSync: (p, c, o) => writes.push({ p, c, o }),
    renameSync: (from, to) => renames.push({ from, to }),
    unlinkSync: (p) => unlinkAttempts.push(p),
  };

  const result = safeWriteFileAtomic({
    filePath: '/project/.claude/settings.json',
    content: '{"hooks":{}}',
    fs,
  });

  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.match(writes[0].p, /settings\.json\.tmp$/);
  assert.equal(writes[0].c, '{"hooks":{}}');
  assert.equal(renames.length, 1);
  assert.equal(renames[0].to, '/project/.claude/settings.json');
});

test('safeWriteFileAtomic cleans up temp file on rename failure', () => {
  const { safeWriteFileAtomic } = require('./runtime-utils');
  const unlinkAttempts = [];
  const fs = {
    writeFileSync: () => {},
    renameSync: () => { throw new Error('rename failed'); },
    unlinkSync: (p) => unlinkAttempts.push(p),
  };

  const result = safeWriteFileAtomic({
    filePath: '/project/.claude/settings.json',
    content: '{"hooks":{}}',
    fs,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /rename failed/);
  assert.equal(unlinkAttempts.length, 1);
});

test('backupFileBeforeWrite creates a .bak copy before modifying', () => {
  const { backupFileBeforeWrite } = require('./runtime-utils');
  const copies = [];
  const fs = {
    existsSync: () => true,
    copyFileSync: (src, dst) => copies.push({ src, dst }),
  };

  const result = backupFileBeforeWrite({
    filePath: '/project/.claude/settings.json',
    fs,
  });

  assert.equal(result.ok, true);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].src, '/project/.claude/settings.json');
  assert.match(copies[0].dst, /settings\.json\.bak$/);
});

test('backupFileBeforeWrite returns ok false when source does not exist', () => {
  const { backupFileBeforeWrite } = require('./runtime-utils');
  const fs = {
    existsSync: () => false,
    copyFileSync: () => {},
  };

  const result = backupFileBeforeWrite({
    filePath: '/project/.claude/settings.json',
    fs,
  });

  assert.equal(result.ok, false);
});

test('classifyCatchAction categorizes expected vs unexpected errors', () => {
  const { classifyCatchAction } = require('./runtime-utils');

  const enoent = classifyCatchAction({ code: 'ENOENT' });
  assert.equal(enoent, 'expected');

  const generic = classifyCatchAction(new Error('disk full'));
  assert.equal(generic, 'unexpected');

  const eacces = classifyCatchAction({ code: 'EACCES' });
  assert.equal(eacces, 'unexpected');
});

test('preserveCorruptDbFile renames corrupt DB file to backup path', () => {
  const moves = [];
  const d = new Date('2026-04-11T09:08:07Z');
  const result = preserveCorruptDbFile({
    dbPath: 'C:/data/auto-claude.db',
    existsSync: () => true,
    renameSync: (from, to) => moves.push({ from, to }),
    now: d,
  });

  assert.equal(result.ok, true);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].from, 'C:/data/auto-claude.db');
  // Uses local time — build expected pattern from the Date's local components
  const pad2 = n => String(n).padStart(2, '0');
  const expected = `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  assert.match(moves[0].to, new RegExp(`auto-claude\\.db\\.corrupt-${expected}\\.bak$`));
});

test('logger rotation: _rotateIfNeeded moves files correctly', () => {
  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  const logFile = path.join(tmpDir, 'test.log');

  // Create a log file larger than threshold
  fs.writeFileSync(logFile, 'x'.repeat(1024));

  const { _rotateIfNeeded } = require('./logger');
  _rotateIfNeeded(logFile, 512); // threshold = 512 bytes

  // After rotation: old file moved to .1
  assert.ok(fs.existsSync(logFile + '.1'), 'Rotated file should exist as .1');
  assert.ok(!fs.existsSync(logFile), 'Original should be gone after rotation');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

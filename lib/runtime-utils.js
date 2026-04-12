const path = require('path');

function computeHealthStatus({
  detection,
  prerequisites,
  recommendedPlugins,
  installedPlugins,
  recommendedTools,
}) {
  const installedKeys = (installedPlugins || []).map(p => p.key);
  const installedNames = new Set((installedPlugins || []).map(p => (p.name || '').toLowerCase()));
  const missingPlugins = (recommendedPlugins || []).filter(r => {
    // Direct key match (standard plugins)
    if (installedKeys.includes(r.key)) return false;
    // Name-based match (for MCP/skill plugins detected via listPlugins MCP entries)
    const baseName = (r.key || '').split('@')[0].toLowerCase();
    if (installedNames.has(baseName)) return false;
    // Check if an MCP entry matches
    if (installedKeys.some(k => k.toLowerCase() === 'mcp:' + baseName)) return false;
    return true;
  });
  const missingTools = (recommendedTools || []).filter(t => !t.installed);
  const prereqsOk = Object.values(prerequisites || {}).every(p => !p.required || p.installed);

  const healthy = prereqsOk
    && !!detection?.installed
    && detection?.authType !== null
    && missingPlugins.length === 0
    && missingTools.length === 0;

  return {
    prerequisites: prerequisites || {},
    claudeCode: {
      installed: !!detection?.installed,
      version: detection?.version || null,
      authenticated: detection?.authType !== null,
      authType: detection?.authType || null,
      authDetail: detection?.authDetail || null,
    },
    plugins: {
      recommended: recommendedPlugins || [],
      installed: installedPlugins || [],
      missing: missingPlugins,
    },
    tools: {
      recommended: recommendedTools || [],
      missing: missingTools,
    },
    recommendedEmpty: false,
    healthy,
  };
}

function resolveTrayIconPath({ platform, appDir, resourcesPath, exePath, existsSync }) {
  const ext = platform === 'win32' ? 'ico' : 'png';
  const baseDirs = [
    path.join(appDir || '', 'build'),
    path.join(resourcesPath || '', 'build'),
    resourcesPath || '',
    path.join(resourcesPath || '', 'app.asar.unpacked', 'build'),
    path.join(path.dirname(exePath || ''), 'build'),
  ];

  // On macOS, prefer Template@2x icons for Retina support and native dark/light mode
  if (platform === 'darwin') {
    for (const dir of baseDirs) {
      try {
        const template2x = path.join(dir, 'iconTemplate@2x.png');
        if (existsSync(template2x)) return template2x;
      } catch { /* continue */ }
    }
  }

  // Standard icon resolution
  const candidates = baseDirs.map(dir => path.join(dir, `icon.${ext}`));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Continue checking candidates
    }
  }

  return null;
}

function getAppLogFilePath(userDataPath) {
  return path.join(userDataPath, 'logs', 'auto-claude-app.log');
}

function shouldHideWindowToTray({ isQuitting, tray }) {
  return !isQuitting && !!tray;
}

function shouldKeepAppAliveWithoutWindows({ tray }) {
  return !!tray;
}

function evaluateToolInstallResult({ key, code, output, context7Installed = false }) {
  const lowerOutput = String(output || '').toLowerCase();
  const hasContext7SkillPathWarning = key === 'context7'
    && lowerOutput.includes('skill failed')
    && lowerOutput.includes('resolves outside the target directory');

  if (hasContext7SkillPathWarning && context7Installed) {
    return {
      ok: true,
      warning: 'Context7 MCP installed. Skill symlink warning is non-fatal and can be ignored.',
    };
  }

  if (code === 0) return { ok: true };
  return { ok: false, error: `Install exited with code ${code}` };
}

function parseInstallCommand(command) {
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, error: 'Invalid install command' };
  }

  const unsafeChars = /[;&|<>`]/;
  if (unsafeChars.test(command)) {
    return { ok: false, error: 'Unsafe command contains shell metacharacters' };
  }

  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { ok: false, error: 'Invalid install command' };

  return {
    ok: true,
    executable: parts[0],
    args: parts.slice(1),
  };
}

function isTrustedIpcSender(event, mainWindow) {
  const senderId = event?.sender?.id;
  const mainSenderId = mainWindow?.webContents?.id;
  const url = String(event?.senderFrame?.url || '');
  return !!senderId && !!mainSenderId && senderId === mainSenderId && url.startsWith('file://');
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function applyCustomProviderToSettings({
  settingsContent,
  baseUrl,
  authToken,
  useSecureToken,
  tokenMode = 'set',
}) {
  let settings;
  try {
    settings = settingsContent ? JSON.parse(settingsContent) : {};
  } catch {
    return { ok: false, error: 'Invalid settings JSON' };
  }

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  if (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)) settings.env = {};

  settings.env.ANTHROPIC_BASE_URL = normalizeBaseUrl(baseUrl);

  if (tokenMode === 'preserve') {
    // Keep existing token representation unchanged
  } else if (tokenMode === 'clear') {
    delete settings.env.ANTHROPIC_AUTH_TOKEN;
  } else {
    const token = String(authToken || '').trim();
    if (useSecureToken || !token) {
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
    } else {
      settings.env.ANTHROPIC_AUTH_TOKEN = token;
    }
  }

  return {
    ok: true,
    settings,
    content: JSON.stringify(settings, null, 2),
  };
}

function classifyProviderFromBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (/bedrock|amazonaws/i.test(normalized)) {
    return { authType: 'cloud', authDetail: 'Amazon Bedrock' };
  }
  if (/vertex|googleapis/i.test(normalized)) {
    return { authType: 'cloud', authDetail: 'Google Vertex AI' };
  }
  if (/azure|foundry/i.test(normalized)) {
    return { authType: 'cloud', authDetail: 'Microsoft Foundry' };
  }

  let authDetail = normalized;
  try { authDetail = new URL(normalized).hostname; } catch { /* keep normalized */ }
  return { authType: 'custom', authDetail };
}

function enrichDetectionWithCustomProviderSecret({ detection, baseUrl, hasSecureToken }) {
  if (!hasSecureToken) return detection;
  if (detection?.authType) return detection;
  const classified = classifyProviderFromBaseUrl(baseUrl);
  return {
    ...(detection || {}),
    authType: classified.authType,
    authDetail: classified.authDetail,
  };
}

function buildCorruptBackupPath(dbPath, now = new Date()) {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `${dbPath}.corrupt-${yyyy}${mm}${dd}-${hh}${min}${ss}.bak`;
}

function preserveCorruptDbFile({ dbPath, existsSync, renameSync, now = new Date() }) {
  const hasFile = (existsSync || (() => false))(dbPath);
  if (!hasFile) return { ok: false, backupPath: null, error: 'Database file does not exist' };

  const backupPath = buildCorruptBackupPath(dbPath, now);
  try {
    (renameSync || (() => {}))(dbPath, backupPath);
    return { ok: true, backupPath };
  } catch (error) {
    return { ok: false, backupPath, error: error?.message || String(error) };
  }
}

// --- Slice 3: Hook atomicity helpers ---

function safeWriteFileAtomic({ filePath, content, fs: fsMod }) {
  const tmpPath = filePath + '.tmp';
  try {
    fsMod.writeFileSync(tmpPath, content, 'utf8');
    try {
      fsMod.renameSync(tmpPath, filePath);
    } catch (renameErr) {
      try { fsMod.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
      return { ok: false, error: renameErr?.message || String(renameErr) };
    }
    return { ok: true };
  } catch (writeErr) {
    return { ok: false, error: writeErr?.message || String(writeErr) };
  }
}

function backupFileBeforeWrite({ filePath, fs: fsMod }) {
  if (!fsMod.existsSync(filePath)) {
    return { ok: false, error: 'Source file does not exist' };
  }
  const backupPath = filePath + '.bak';
  try {
    fsMod.copyFileSync(filePath, backupPath);
    return { ok: true, backupPath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function classifyCatchAction(err) {
  const code = err?.code || '';
  const expectedCodes = ['ENOENT', 'ENOTDIR', 'ESRCH'];
  if (expectedCodes.includes(code)) return 'expected';
  return 'unexpected';
}

module.exports = {
  computeHealthStatus,
  resolveTrayIconPath,
  getAppLogFilePath,
  shouldHideWindowToTray,
  shouldKeepAppAliveWithoutWindows,
  evaluateToolInstallResult,
  parseInstallCommand,
  isTrustedIpcSender,
  applyCustomProviderToSettings,
  classifyProviderFromBaseUrl,
  enrichDetectionWithCustomProviderSecret,
  buildCorruptBackupPath,
  preserveCorruptDbFile,
  safeWriteFileAtomic,
  backupFileBeforeWrite,
  classifyCatchAction,
};

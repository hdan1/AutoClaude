// lib/plugin-manager.js — Plugin management extracted from claude-detector.js (5A)
const { execFileSync, spawn } = require('child_process');
const { spawnClaude, getClaudeCommand } = require('./spawn-claude');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');
const { getClaudeHome, isGsdInstalledFromPaths, DEFAULT_RECOMMENDED_PLUGINS } = require('./claude-detection');
const { parseInstallCommand, evaluateToolInstallResult } = require('./runtime-utils');

// In-memory install lock — prevents concurrent installs of the same plugin key
const _installsInFlight = new Map(); // key → Promise

function listPlugins() {
  const settingsPath = path.join(getClaudeHome(), 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') logger.debug('claude-detector', `listPlugins settings read failed: ${err.message}`); }

  const enabled = settings.enabledPlugins || {};
  const extraMarkets = settings.extraKnownMarketplaces || {};
  const installed = [];

  for (const [key, val] of Object.entries(enabled)) {
    const parts = key.split('@');
    const name = parts[0] || key;
    const source = parts[1] || 'unknown';
    const isCommunity = !!extraMarkets[source];
    installed.push({ key, name, source, enabled: !!val, community: isCommunity });
  }

  // Try to read cached plugin info for descriptions
  const cacheDir = path.join(getClaudeHome(), 'plugins', 'cache');
  for (const plugin of installed) {
    try {
      const manifestPath = path.join(cacheDir, plugin.source, plugin.name, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        plugin.description = manifest.description || '';
        plugin.version = manifest.version || '';
      }
    } catch (err) {
      if (err.code !== 'ENOENT') logger.debug('claude-detector', `plugin manifest read failed: ${err.message}`);
    }
  }

  // Also include MCP servers configured in settings.json AND ~/.claude.json
  const allMcpServers = { ...(settings.mcpServers || {}) };

  // Read MCP servers from ~/.claude.json (Claude Code's primary MCP config)
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const globalMcps = claudeJson.mcpServers || {};
    for (const [name, config] of Object.entries(globalMcps)) {
      if (!allMcpServers[name]) allMcpServers[name] = config;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.debug('claude-detector', `JSON parse failed: ${err.message}`);
  }

  const pluginKeys = new Set(installed.map(p => p.name.toLowerCase()));
  for (const [serverName, serverConfig] of Object.entries(allMcpServers)) {
    // Skip if already represented as a plugin (avoid duplicates)
    if (pluginKeys.has(serverName.toLowerCase())) continue;
    const desc = serverConfig.command
      ? `MCP: ${serverConfig.command}`
      : (serverConfig.url ? `MCP: ${serverConfig.url}` : 'MCP server');
    installed.push({
      key: `mcp:${serverName}`,
      name: serverName,
      source: 'mcp-server',
      enabled: !serverConfig.disabled,
      community: false,
      isMcp: true,
      description: desc,
    });
  }

  // Also detect skill-based tools (e.g., GSD) from DEFAULT_RECOMMENDED_PLUGINS
  const installedNames = new Set(installed.map(p => p.name.toLowerCase()));
  const home = getClaudeHome();
  for (const rec of DEFAULT_RECOMMENDED_PLUGINS) {
    const baseName = (rec.key || '').split('@')[0].toLowerCase();
    if (installedNames.has(baseName)) continue;
    if (installed.some(p => p.key && p.key.toLowerCase() === 'mcp:' + baseName)) continue;

    let detected = false;
    if (rec.detectPath) {
      if (rec.key && rec.key.startsWith('gsd')) {
        detected = isGsdInstalledFromPaths(home);
      } else {
        detected = fs.existsSync(path.join(home, rec.detectPath));
      }
    }
    // Also detect MCP-type plugins by checking mcpServers keys
    if (!detected && rec.detectMcp) {
      const mcpName = rec.detectMcp.toLowerCase();
      detected = Object.keys(allMcpServers).some(k => k.toLowerCase().includes(mcpName));
    }
    if (detected) {
      installed.push({
        key: rec.key,
        name: baseName,
        source: rec.type === 'mcp' ? 'mcp-server' : 'skill',
        enabled: true,
        community: !rec.official,
        isMcp: rec.type === 'mcp',
        isSkill: rec.type === 'skill',
        description: rec.type === 'skill' ? 'Skill pack' : 'Installed',
      });
    }
  }

  return { installed };
}

function togglePlugin(pluginKey, enabled) {
  const settingsPath = path.join(getClaudeHome(), 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') logger.debug('claude-detector', `togglePlugin settings read failed: ${err.message}`); }
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins[pluginKey] = enabled;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return { ok: true };
}

function installPlugin(source, repo) {
  // Deduplicate concurrent installs of the same plugin
  const lockKey = `${source}::${repo || ''}`;
  if (_installsInFlight.has(lockKey)) {
    logger.info('plugin-manager', `Install already in-flight for ${source}, reusing existing promise`);
    return _installsInFlight.get(lockKey);
  }

  const promise = _installPluginImpl(source, repo).finally(() => {
    _installsInFlight.delete(lockKey);
  });
  _installsInFlight.set(lockKey, promise);
  return promise;
}

function _installPluginImpl(source, repo) {
  // Check if this plugin has a custom installCmd (MCP servers, skill packs)
  const recPlugin = DEFAULT_RECOMMENDED_PLUGINS.find(p => p.key === source);
  if (recPlugin && recPlugin.installCmd && recPlugin.installCmd[process.platform]) {
    return installViaCommand(recPlugin, source);
  }

  // Resolve the claude binary path
  const { cmd: claudePath, shellFlag } = getClaudeCommand();

  // Determine plugin key and marketplace info
  let pluginKey = source;
  let marketplace = null;

  if (source && source.includes('@')) {
    pluginKey = source;
    marketplace = source.split('@')[1];
  } else if (repo) {
    const name = repo.split('/').pop();
    pluginKey = `${name}@${source}`;
    marketplace = source;
  }

  // For community plugins, ensure marketplace is registered first
  if (repo && marketplace && marketplace !== 'claude-plugins-official') {
    try {
      execFileSync(claudePath, ['plugins', 'marketplace', 'add', repo], {
        timeout: 120000, windowsHide: true, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: shellFlag,
      });
    } catch (e) {
      // Marketplace may already exist — only fail if it's not a "already exists" error
      const msg = (e.stderr || e.message || '').toLowerCase();
      if (!msg.includes('already') && !msg.includes('exists')) {
        return Promise.resolve({ ok: false, error: `Failed to add marketplace: ${e.message}` });
      }
    }
  }

  // Install the plugin via CLI (downloads files + registers in settings)
  return new Promise((resolve) => {
    const proc = spawnClaude(['plugins', 'install', pluginKey], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve({ ok: true, output });
      else resolve({ ok: false, error: `Plugin install failed (exit ${code}): ${output}` });
    });
    proc.on('error', err => {
      resolve({ ok: false, error: `Plugin install error: ${err.message}` });
    });
  });
}

// Install Context7 MCP by directly writing the config to ~/.claude.json
// Avoids the OAuth login flow from `npx ctx7 setup` which fails in non-interactive spawns
function installContext7Directly() {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  let claudeJson = {};
  try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch { /* fresh file */ }

  if (!claudeJson.mcpServers) claudeJson.mcpServers = {};

  // Check if already installed
  const alreadyInstalled = Object.keys(claudeJson.mcpServers).some(k => k.toLowerCase().includes('context7'));
  if (alreadyInstalled) {
    logger.info('plugin-manager', 'Context7 MCP already configured in ~/.claude.json');
    return Promise.resolve({ ok: true, output: 'Context7 MCP already installed.' });
  }

  // Add Context7 MCP server using the streamable HTTP endpoint (no API key required for basic usage)
  claudeJson.mcpServers['context7'] = {
    url: 'https://mcp.context7.com/mcp',
  };

  try {
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2), 'utf8');
    logger.info('plugin-manager', 'Context7 MCP installed via direct config to ~/.claude.json');
    return Promise.resolve({ ok: true, output: 'Context7 MCP server configured successfully.' });
  } catch (err) {
    logger.error('plugin-manager', `Failed to write ~/.claude.json: ${err.message}`);
    return Promise.resolve({ ok: false, error: `Failed to write ~/.claude.json: ${err.message}` });
  }
}

// Install a plugin/tool that has a custom installCmd (e.g., context7 MCP, GSD skill pack)
function installViaCommand(recPlugin, key) {
  // Context7: use direct config instead of OAuth-dependent npx setup
  const baseName = (key || '').split('@')[0].toLowerCase();
  if (baseName === 'context7') {
    return installContext7Directly();
  }

  const cmd = recPlugin.installCmd[process.platform];
  const parsed = parseInstallCommand(cmd);
  if (!parsed.ok) return Promise.resolve({ ok: false, error: parsed.error });

  logger.info('plugin-manager', `Installing ${key} via command: ${cmd}`);

  const INSTALL_TIMEOUT_MS = 120000; // 2 minute timeout

  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn(parsed.executable, parsed.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill(); } catch (e) { /* ignore */ }
        const errMsg = `Install timed out after ${INSTALL_TIMEOUT_MS / 1000}s`;
        logger.error('plugin-manager', `${key} timed out`);
        resolve({ ok: false, error: errMsg, output });
      }
    }, INSTALL_TIMEOUT_MS);

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Use evaluateToolInstallResult for known tools
      const verdict = evaluateToolInstallResult({ key: baseName, code, output, context7Installed: false });
      if (verdict.ok) {
        if (verdict.warning) {
          logger.warn('plugin-manager', `Install warning tolerated for ${key}: ${verdict.warning}`);
        }
        logger.info('plugin-manager', `Install completed for ${key}`);
        resolve({ ok: true, output, warning: verdict.warning });
      } else {
        const errMsg = verdict.error || `Install exited with code ${code}`;
        logger.error('plugin-manager', `${key} failed`, output || errMsg);
        resolve({ ok: false, error: errMsg, output });
      }
    });
    proc.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.error('plugin-manager', `${key} spawn error`, err);
      resolve({ ok: false, error: `Install error: ${err.message}` });
    });
  });
}

async function testCustomProvider(baseUrl, authToken) {
  const url = baseUrl.replace(/\/+$/, '') + '/v1/messages';
  try {
    const { net } = require('electron');
    const resp = await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': authToken, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(10000),
    });
    // 200 = works, 401 = auth issue but endpoint exists, 400 = endpoint exists
    if (resp.status === 200 || resp.status === 400) return { ok: true };
    if (resp.status === 401) return { ok: false, error: 'Authentication failed — check your token' };
    return { ok: false, error: `Endpoint returned status ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e.message || 'Connection failed' };
  }
}

function updatePlugin(key) {
  const baseName = (key || '').split('@')[0].toLowerCase();
  const recPlugin = DEFAULT_RECOMMENDED_PLUGINS.find(p => {
    const pBase = (p.key || '').split('@')[0].toLowerCase();
    return pBase === baseName;
  });

  // MCP/skill plugins: re-run install command
  if (recPlugin && recPlugin.installCmd && recPlugin.installCmd[process.platform]) {
    logger.info('plugin-manager', `Updating ${key} via install command`);
    return installViaCommand(recPlugin, key).then(result => {
      if (result.ok) {
        // Try to save the new version
        try {
          const { savePluginVersion } = require('./plugin-update-checker');
          const { execFileSync } = require('child_process');
          // For npm-based plugins, get the installed version
          if (recPlugin.npmPackage) {
            try {
              const ver = execFileSync('npm', ['view', recPlugin.npmPackage, 'version'], {
                timeout: 15000, windowsHide: true, encoding: 'utf8', shell: process.platform === 'win32',
              }).trim();
              if (ver) savePluginVersion(baseName, ver);
            } catch (e) { logger.debug('plugin-manager', `Could not get version after update: ${e.message}`); }
          }
        } catch (e) { /* ignore */ }
      }
      return result;
    });
  }

  // Claude Code plugins: use CLI
  const { cmd: claudePath, shellFlag } = getClaudeCommand();
  logger.info('plugin-manager', `Updating ${key} via claude plugins update`);
  return new Promise((resolve) => {
    const proc = spawnClaude(['plugins', 'update', key], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve({ ok: true, output });
      else resolve({ ok: false, error: `Plugin update failed (exit ${code}): ${output}` });
    });
    proc.on('error', err => {
      resolve({ ok: false, error: `Plugin update error: ${err.message}` });
    });
  });
}

async function updateAllPlugins(keys) {
  const results = [];
  for (const key of keys) {
    const result = await updatePlugin(key);
    results.push({ key, ...result });
  }
  return results;
}

module.exports = {
  listPlugins,
  togglePlugin,
  installPlugin,
  updatePlugin,
  updateAllPlugins,
  testCustomProvider,
};

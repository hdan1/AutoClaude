'use strict';
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { withTrustedIpc } = require('./ipc-trust');
const { buildClaudeStateFacade } = require('./claude-state-facade');
const { evaluateToolInstallResult, parseInstallCommand, applyCustomProviderToSettings } = require('./runtime-utils');

const ALLOWED_INSTALL_METHODS = new Set(['powershell', 'cmd', 'winget', 'curl', 'homebrew']);
const ALLOWED_AUTH_METHODS = new Set(['anthropic', 'console']);
const ALLOWED_PREREQUISITES = new Set(['git', 'node']);

function sanitizeClaudeProjectDir(dir) {
  if (!dir || typeof dir !== 'string') return null;
  const resolved = path.resolve(dir);
  if (!path.isAbsolute(resolved)) return null;
  return resolved;
}

function register(ipcMain, deps) {
  const {
    claudeDetector, claudeInstaller, send, trustDeps,
    readGlobalClaudeEnv, syncCustomProviderRuntimeEnv,
    refreshWorkflowAvailability, invalidateHealthCache,
    buildHealthStatusCached, detectClaudeStateWithSecureToken,
    loadCustomProviderToken, saveCustomProviderToken, clearCustomProviderToken,
    isEncryptionAvailable, APP_LOG_FILE, shell,
  } = deps;

  ipcMain.handle('detect-claude-code', withTrustedIpc('detect-claude-code', async () => {
    return detectClaudeStateWithSecureToken();
  }, trustDeps, { installed: false, authType: null, authDetail: null }));

  ipcMain.handle('read-claude-settings', withTrustedIpc('read-claude-settings', (event, { scope, projectDir }) => {
    const dir = scope === 'project' ? sanitizeClaudeProjectDir(projectDir) : null;
    return claudeDetector.readSettingsJson(scope, dir);
  }, trustDeps, { content: '{\n}', path: '', error: 'Untrusted IPC sender' }));

  ipcMain.handle('write-claude-settings', withTrustedIpc('write-claude-settings', (event, { scope, projectDir, content }) => {
    try {
      const dir = scope === 'project' ? sanitizeClaudeProjectDir(projectDir) : null;
      const result = claudeDetector.writeSettingsJson(scope, dir, content);
      if (result?.ok !== false) refreshWorkflowAvailability();
      return result;
    } catch (e) { return { ok: false, error: e.message }; }
  }, trustDeps));

  ipcMain.handle('list-claude-plugins', withTrustedIpc('list-claude-plugins', () => {
    return claudeDetector.listPlugins();
  }, trustDeps, { installed: [], error: 'Untrusted IPC sender' }));

  ipcMain.handle('toggle-claude-plugin', withTrustedIpc('toggle-claude-plugin', (event, { pluginKey, enabled }) => {
    const result = claudeDetector.togglePlugin(pluginKey, enabled);
    invalidateHealthCache();
    if (result?.ok !== false) refreshWorkflowAvailability();
    return result;
  }, trustDeps));

  ipcMain.handle('install-claude-plugin', withTrustedIpc('install-claude-plugin', (event, { source, repo }) => {
    const result = claudeDetector.installPlugin(source, repo);
    invalidateHealthCache();
    if (result && typeof result.then === 'function') {
      return result.then((resolved) => {
        if (resolved?.ok !== false) refreshWorkflowAvailability();
        return resolved;
      });
    }
    if (result?.ok !== false) refreshWorkflowAvailability();
    return result;
  }, trustDeps));

  ipcMain.handle('test-custom-provider', withTrustedIpc('test-custom-provider', (event, { baseUrl, authToken }) => {
    const env = readGlobalClaudeEnv();
    const resolvedBaseUrl = String(baseUrl || env.ANTHROPIC_BASE_URL || '').trim();
    const providedToken = typeof authToken === 'string' ? authToken.trim() : '';
    let secureToken = null;
    try { secureToken = loadCustomProviderToken(); }
    catch (err) { logger.warn('custom-provider', `Failed to load secure token for test: ${err?.message || err}`); }
    const resolvedToken = providedToken || secureToken || String(env.ANTHROPIC_AUTH_TOKEN || '').trim();
    if (!resolvedBaseUrl || !resolvedToken) return { ok: false, error: 'Base URL and auth token are required' };
    return claudeDetector.testCustomProvider(resolvedBaseUrl, resolvedToken);
  }, trustDeps));

  ipcMain.handle('install-claude-code', withTrustedIpc('install-claude-code', (event, { method }) => {
    if (!ALLOWED_INSTALL_METHODS.has(method)) return { ok: false, error: 'Invalid install method' };
    return new Promise((resolve) => {
      const emitter = claudeInstaller.install(method);
      let output = '';
      emitter.on('progress', text => { output += text; send('install-claude-code-progress', { output: text, done: false }); });
      emitter.on('complete', () => {
        const pathResult = claudeInstaller.addClaudeToPath();
        const pathMsg = pathResult.ok ? pathResult.message : `PATH update: ${pathResult.error}`;
        send('install-claude-code-progress', { output: pathMsg + '\n', done: true });
        resolve({ ok: true, output, pathResult });
      });
      emitter.on('error', err => {
        send('install-claude-code-progress', { output: err, done: true, error: err });
        resolve({ ok: false, error: err, output });
      });
    });
  }, trustDeps));

  ipcMain.handle('authenticate-claude-code', withTrustedIpc('authenticate-claude-code', (event, { method }) => {
    if (!ALLOWED_AUTH_METHODS.has(method)) return { ok: false, error: 'Invalid auth method' };
    return new Promise((resolve) => {
      const emitter = claudeInstaller.authenticate(method);
      let output = '';
      emitter.on('progress', text => { output += text; });
      emitter.on('complete', () => resolve({ ok: true, output }));
      emitter.on('error', err => resolve({ ok: false, error: err, output }));
    });
  }, trustDeps));

  ipcMain.handle('install-prerequisite', withTrustedIpc('install-prerequisite', (event, { name }) => {
    if (!ALLOWED_PREREQUISITES.has(name)) return { ok: false, error: 'Invalid prerequisite' };
    return new Promise((resolve) => {
      const emitter = claudeInstaller.installPrerequisite(name);
      let output = '';
      emitter.on('progress', text => { output += text; send('install-prerequisite-progress', { name, output: text, done: false }); });
      emitter.on('complete', () => { send('install-prerequisite-progress', { name, output: '', done: true }); resolve({ ok: true, output }); });
      emitter.on('error', err => { send('install-prerequisite-progress', { name, output: err, done: true, error: err }); resolve({ ok: false, error: err, output }); });
    });
  }, trustDeps));

  ipcMain.handle('install-tool', withTrustedIpc('install-tool', (event, { key }) => {
    const tool = claudeDetector.DEFAULT_RECOMMENDED_TOOLS.find(t => t.key === key);
    if (!tool) return { ok: false, error: `Unknown tool: ${key}` };
    const cmd = tool.installCmd[process.platform];
    if (!cmd) return { ok: false, error: `No installer for ${key} on ${process.platform}` };
    const parsed = parseInstallCommand(cmd);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    logger.info('install-tool', `Starting installer for ${key}: ${cmd}`);
    const INSTALL_TIMEOUT_MS = 120000;
    return new Promise((resolve) => {
      let settled = false;
      const proc = require('child_process').spawn(parsed.executable, parsed.args, {
        stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true,
      });
      let output = '';
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { proc.kill(); } catch (e) { /* ignore */ }
          const errMsg = `Install timed out after ${INSTALL_TIMEOUT_MS / 1000}s`;
          logger.error('install-tool', `${key} timed out`);
          send('install-tool-progress', { key, output: errMsg, done: true, error: errMsg });
          resolve({ ok: false, error: errMsg, output });
        }
      }, INSTALL_TIMEOUT_MS);
      proc.stdout.on('data', d => { const text = d.toString(); output += text; send('install-tool-progress', { key, output: text, done: false }); });
      proc.stderr.on('data', d => { const text = d.toString(); output += text; send('install-tool-progress', { key, output: text, done: false }); });
      proc.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let context7Installed = false;
        if (key === 'context7') {
          try { const tools = claudeDetector.detectRecommendedTools(); context7Installed = tools.some(t => t.key === 'context7' && t.installed); }
          catch (err) { logger.warn('install-tool', `Context7 detection failed: ${err?.message || err}`); }
        }
        const verdict = evaluateToolInstallResult({ key, code, output, context7Installed });
        if (verdict.ok) {
          if (verdict.warning) { logger.warn('install-tool', `Warning tolerated for ${key}: ${verdict.warning}`); send('install-tool-progress', { key, output: verdict.warning, done: true }); resolve({ ok: true, output, warning: verdict.warning }); return; }
          logger.info('install-tool', `Installer completed for ${key}`);
          send('install-tool-progress', { key, output: '', done: true });
          resolve({ ok: true, output });
        } else {
          const errMsg = verdict.error || `Install exited with code ${code}`;
          logger.error('install-tool', `${key} failed`, output || errMsg);
          send('install-tool-progress', { key, output: errMsg, done: true, error: errMsg });
          resolve({ ok: false, error: errMsg, output });
        }
      });
      proc.on('error', err => {
        if (settled) return; settled = true; clearTimeout(timer);
        logger.error('install-tool', `${key} spawn error`, err);
        send('install-tool-progress', { key, output: err.message, done: true, error: err.message });
        resolve({ ok: false, error: err.message, output });
      });
    });
  }, trustDeps));

  ipcMain.handle('save-custom-provider', withTrustedIpc('save-custom-provider', (event, { baseUrl, authToken }) => {
    try {
      const { readSettingsJson, writeSettingsJson } = claudeDetector;
      const { content } = readSettingsJson('global');
      const tokenProvided = typeof authToken === 'string';
      const token = String(authToken || '').trim();
      const secureAvailable = isEncryptionAvailable();
      const tokenMode = tokenProvided ? (token ? 'set' : 'clear') : 'preserve';
      const transformed = applyCustomProviderToSettings({ settingsContent: content, baseUrl, authToken: token, useSecureToken: false, tokenMode });
      if (!transformed.ok) return { ok: false, error: transformed.error || 'Failed to parse settings' };
      if (tokenMode === 'clear') { clearCustomProviderToken(); }
      else if (tokenMode === 'set' && secureAvailable) { try { saveCustomProviderToken(token); } catch (e) { /* best effort */ } }
      writeSettingsJson('global', null, transformed.content);
      syncCustomProviderRuntimeEnv();
      return { ok: true, secureToken: false, warning: null };
    } catch (e) { return { ok: false, error: e.message }; }
  }, trustDeps));

  ipcMain.handle('get-custom-provider-state', withTrustedIpc('get-custom-provider-state', () => {
    const env = readGlobalClaudeEnv();
    let hasSecureToken = false;
    try { hasSecureToken = !!loadCustomProviderToken(); } catch (err) { logger.warn('custom-provider', `Failed to check secure token: ${err?.message || err}`); }
    return { ok: true, baseUrl: env.ANTHROPIC_BASE_URL || '', hasSecureToken, hasEnvToken: typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.length > 0, secureStorageAvailable: isEncryptionAvailable() };
  }, trustDeps));

  ipcMain.handle('list-settings-tags', withTrustedIpc('list-settings-tags', () => claudeDetector.listSettingsTags(), trustDeps, { tags: [] }));
  ipcMain.handle('load-settings-tag', withTrustedIpc('load-settings-tag', (event, { name }) => claudeDetector.loadSettingsTag(name), trustDeps));
  ipcMain.handle('save-settings-tag', withTrustedIpc('save-settings-tag', (event, { name, content }) => { try { return claudeDetector.saveSettingsTag(name, content); } catch (e) { return { ok: false, error: e.message }; } }, trustDeps));
  ipcMain.handle('delete-settings-tag', withTrustedIpc('delete-settings-tag', (event, { name }) => { try { return claudeDetector.deleteSettingsTag(name); } catch (e) { return { ok: false, error: e.message }; } }, trustDeps));
  ipcMain.handle('check-claude-update', withTrustedIpc('check-claude-update', (event, opts) => claudeDetector.checkForUpdate(opts), trustDeps));

  const pluginUpdateChecker = require('./plugin-update-checker');

  ipcMain.handle('check-plugin-updates', withTrustedIpc('check-plugin-updates', (event, opts) => {
    return pluginUpdateChecker.checkPluginUpdates(opts?.forceRefresh);
  }, trustDeps, { updates: [], error: 'Untrusted IPC sender' }));

  ipcMain.handle('get-claude-state-facade', withTrustedIpc('get-claude-state-facade', async () => {
    return buildClaudeStateFacade({
      detectClaudeState: detectClaudeStateWithSecureToken,
      checkForUpdate: opts => claudeDetector.checkForUpdate(opts),
      checkPluginUpdates: forceRefresh => pluginUpdateChecker.checkPluginUpdates(forceRefresh),
    });
  }, trustDeps, { installed: false, version: '', authType: '', update: {}, pluginUpdates: [], pluginUpdatesError: 'Untrusted IPC sender' }));

  ipcMain.handle('update-plugin', withTrustedIpc('update-plugin', async (event, { key }) => {
    const result = await claudeDetector.updatePlugin(key);
    invalidateHealthCache();
    if (result?.ok !== false) refreshWorkflowAvailability();
    return result;
  }, trustDeps));

  ipcMain.handle('update-all-plugins', withTrustedIpc('update-all-plugins', async (event, { keys }) => {
    const results = await claudeDetector.updateAllPlugins(keys);
    invalidateHealthCache();
    refreshWorkflowAvailability();
    return results;
  }, trustDeps));
}

module.exports = { register };

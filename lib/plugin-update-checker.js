// lib/plugin-update-checker.js — Check for plugin updates across all plugin types
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');
const { listPlugins } = require('./plugin-manager');
const { DEFAULT_RECOMMENDED_PLUGINS } = require('./claude-detection');

// ── Cache ──────────────────────────────────────────────────────
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ── npm package name mappings for MCP/skill plugins ───────────
const NPM_PACKAGE_MAP = {
  context7: 'ctx7',
  gsd:      'get-shit-done-cc',
};

// ── Marketplace manifest URLs ──────────────────────────────────
const MARKETPLACE_MANIFEST_URLS = {
  'claude-plugins-official': 'https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/manifest.json',
};

// ── HTTP helpers ───────────────────────────────────────────────

function _fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on('error', reject);
  });
}

async function _fetchNpmLatestVersion(packageName) {
  const data = await _fetchJson(`https://registry.npmjs.org/${packageName}/latest`);
  if (!data.version) throw new Error(`No version in npm response for ${packageName}`);
  return data.version;
}

async function _fetchMarketplaceManifest(repoUrl) {
  return _fetchJson(repoUrl);
}

// ── Version comparison ─────────────────────────────────────────

function _compareVersions(current, latest) {
  if (!current || !latest) return false;
  const parse = v => String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const a = parse(current);
  const b = parse(latest);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (bv > av) return true;
    if (bv < av) return false;
  }
  return false;
}

// ── plugin-versions.json helpers ──────────────────────────────

const VERSIONS_FILE = path.join(os.homedir(), '.claude', 'plugin-versions.json');

function _readPluginVersions() {
  try {
    return JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') logger.debug('plugin-update-checker', `plugin-versions.json read failed: ${err.message}`);
    return {};
  }
}

function savePluginVersion(name, version) {
  const versions = _readPluginVersions();
  versions[name] = version;
  try {
    fs.mkdirSync(path.dirname(VERSIONS_FILE), { recursive: true });
    fs.writeFileSync(VERSIONS_FILE, JSON.stringify(versions, null, 2), 'utf8');
    logger.debug('plugin-update-checker', `saved version ${name}@${version}`);
  } catch (err) {
    logger.error('plugin-update-checker', `failed to save plugin version: ${err.message}`);
  }
}

function _withVersionStatus(result) {
  const currentVersion = result.currentVersion || '';
  const latestVersion = result.latestVersion || '';
  const currentVersionKnown = !!currentVersion;
  let versionStatus = 'current';

  if (!currentVersionKnown) versionStatus = latestVersion ? 'unknown-current' : 'unknown';
  else if (result.updateAvailable) versionStatus = 'update-available';

  return { ...result, currentVersion, latestVersion, currentVersionKnown, versionStatus };
}

// ── Per-plugin update checks ───────────────────────────────────

async function _checkClaudePlugin(plugin) {
  const source = plugin.source || '';
  const manifestUrl = MARKETPLACE_MANIFEST_URLS[source];

  // Derive manifest URL from DEFAULT_RECOMMENDED_PLUGINS if not in known map
  let resolvedUrl = manifestUrl;
  if (!resolvedUrl) {
    const rec = DEFAULT_RECOMMENDED_PLUGINS.find(r => (r.marketplace || '') === source && r.repo);
    if (rec && rec.repo) {
      resolvedUrl = `https://raw.githubusercontent.com/${rec.repo}/main/manifest.json`;
    }
  }

  if (!resolvedUrl) {
    return _withVersionStatus({ currentVersion: plugin.version || '', latestVersion: '', updateAvailable: false, error: `No manifest URL for marketplace: ${source}` });
  }

  const manifest = await _fetchMarketplaceManifest(resolvedUrl);
  const plugins = Array.isArray(manifest) ? manifest : (manifest.plugins || []);
  const entry = plugins.find(p => p.name === plugin.name || p.name === plugin.key);
  if (!entry) return _withVersionStatus({ currentVersion: plugin.version || '', latestVersion: '', updateAvailable: false, error: `Plugin ${plugin.name} not found in marketplace manifest` });

  const latestVersion = entry.version || '';
  const currentVersion = plugin.version || '';
  return _withVersionStatus({ currentVersion, latestVersion, updateAvailable: _compareVersions(currentVersion, latestVersion) });
}

async function _checkNpmPlugin(plugin) {
  const versions = _readPluginVersions();
  const currentVersion = plugin.version || versions[plugin.name] || '';

  // Resolve npm package name
  const rec = DEFAULT_RECOMMENDED_PLUGINS.find(r => {
    const baseName = (r.key || '').split('@')[0].toLowerCase();
    return baseName === plugin.name.toLowerCase();
  });
  const npmPackage = NPM_PACKAGE_MAP[plugin.name.toLowerCase()]
    || (rec && rec.npmPackage)
    || null;

  if (!npmPackage) {
    return _withVersionStatus({ currentVersion, latestVersion: '', updateAvailable: false, error: `No npm package mapping for ${plugin.name}` });
  }

  const latestVersion = await _fetchNpmLatestVersion(npmPackage);
  return _withVersionStatus({ currentVersion, latestVersion, updateAvailable: _compareVersions(currentVersion, latestVersion) });
}

// ── Main export ────────────────────────────────────────────────

async function checkPluginUpdates(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cache && (now - _cacheTime) < CACHE_TTL) {
    logger.debug('plugin-update-checker', 'returning cached update results');
    return { ..._cache, cached: true };
  }

  const { installed } = listPlugins();
  logger.debug('plugin-update-checker', `checking updates for ${installed.length} plugins`);

  const updates = await Promise.all(installed.map(async (plugin) => {
    const base = { key: plugin.key, name: plugin.name };
    try {
      const isMcp   = plugin.isMcp   || plugin.source === 'mcp-server';
      const isSkill = plugin.isSkill || plugin.source === 'skill';

      let result;
      if (isMcp || isSkill) {
        const type = isMcp ? 'mcp' : 'skill';
        result = await _checkNpmPlugin(plugin);
        return { ...base, type, ...result };
      } else {
        result = await _checkClaudePlugin(plugin);
        return { ...base, type: 'claude-plugin', ...result };
      }
    } catch (err) {
      logger.debug('plugin-update-checker', `update check failed for ${plugin.name}: ${err.message}`);
      return { ...base, type: 'unknown', updateAvailable: false, error: err.message };
    }
  }));

  const result = { updates, cached: false };
  _cache = result;
  _cacheTime = now;
  return result;
}

module.exports = { checkPluginUpdates, savePluginVersion };

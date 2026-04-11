// lib/models.js -- Fetch available Claude models from Anthropic API
// Discovers API key from env vars or ~/.claude/settings.json
// Caches results for 10 minutes to avoid repeated API calls

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ── Default model list (fallback when API unavailable) ─────
const DEFAULT_MODELS = [
  { id: 'claude-opus-4-20250514',    displayName: 'Claude Opus 4',    effortSupported: true,  effortLevels: ['low','medium','high','max'], maxInputTokens: 200000, maxOutputTokens: 32000, createdAt: '2025-05-14' },
  { id: 'claude-sonnet-4-20250514',  displayName: 'Claude Sonnet 4',  effortSupported: true,  effortLevels: ['low','medium','high','max'], maxInputTokens: 200000, maxOutputTokens: 16000, createdAt: '2025-05-14' },
  { id: 'claude-haiku-4-20250514',   displayName: 'Claude Haiku 4',   effortSupported: true,  effortLevels: ['low','medium','high','max'], maxInputTokens: 200000, maxOutputTokens: 8192,  createdAt: '2025-05-14' },
  { id: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet', effortSupported: false, effortLevels: [], maxInputTokens: 200000, maxOutputTokens: 8192, createdAt: '2024-10-22' },
  { id: 'claude-3-5-haiku-20241022',  displayName: 'Claude 3.5 Haiku',  effortSupported: false, effortLevels: [], maxInputTokens: 200000, maxOutputTokens: 8192, createdAt: '2024-10-22' },
];

// ── Built-in defaults for known Claude models ─────
// Used when the API (e.g. proxy/gateway) doesn't return effort capability data.
// Keyed by model ID prefix — matches if model ID starts with key.
const KNOWN_CLAUDE_DEFAULTS = {
  'claude-opus-4':    { effortSupported: true,  effortLevels: ['low','medium','high','max'] },
  'claude-sonnet-4':  { effortSupported: true,  effortLevels: ['low','medium','high','max'] },
  'claude-haiku-4':   { effortSupported: true,  effortLevels: ['low','medium','high','max'] },
  'claude-sonnet-3':  { effortSupported: false, effortLevels: [] },
  'claude-haiku-3':   { effortSupported: false, effortLevels: [] },
  'claude-opus-3':    { effortSupported: false, effortLevels: [] },
};

function _getBuiltinDefaults(modelId) {
  for (const [prefix, defaults] of Object.entries(KNOWN_CLAUDE_DEFAULTS)) {
    if (modelId.startsWith(prefix)) return defaults;
  }
  return null;
}

// ── Credential Discovery ───────────────────────────

function _discoverCredentials() {
  // 1. Environment variables (highest priority)
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (apiKey) return { apiKey, baseUrl: baseUrl || 'https://api.anthropic.com' };

  // 2. Claude Code settings.json
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw);
    const env = settings?.env || {};
    const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
    const url = env.ANTHROPIC_BASE_URL;
    if (key) return { apiKey: key, baseUrl: url || 'https://api.anthropic.com' };
  } catch (e) { /* settings.json not found or invalid */ }

  return null;
}

// ── HTTP Request Helper ────────────────────────────

function _request(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;
    const req = transport.get(url, { headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Invalid JSON from ${url}`)); }
        } else {
          reject(new Error(`API ${res.statusCode}: ${data.substring(0, 4000)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('API request timeout')); });
  });
}

function _probeAvailableModelsFromMessages(apiKey, baseUrl) {
  return new Promise((resolve) => {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/v1/messages`);
    const transport = url.protocol === 'http:' ? http : https;
    const payload = JSON.stringify({
      model: 'invalid-model-for-discovery',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });

    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-api-key': apiKey,
        'authorization': 'Bearer ' + apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const extracted = _extractModelsFromError(`API ${res.statusCode}: ${data.substring(0, 4000)}`);
        resolve(extracted);
      });
    });

    req.on('error', () => resolve([]));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve([]);
    });

    req.write(payload);
    req.end();
  });
}

// ── Model Fetching ─────────────────────────────────

async function _fetchAllModels(apiKey, baseUrl) {
  const headers = {
    'x-api-key': apiKey,
    'authorization': 'Bearer ' + apiKey,
    'anthropic-version': '2023-06-01',
  };
  const all = [];
  let afterId = null;

  // Paginate through all models
  for (let page = 0; page < 10; page++) {
    let url = `${baseUrl}/v1/models?limit=100`;
    if (afterId) url += `&after_id=${encodeURIComponent(afterId)}`;

    const res = await _request(url, headers);
    if (res.data && Array.isArray(res.data)) {
      all.push(...res.data);
    }
    if (!res.has_more) break;
    afterId = res.last_id;
  }

  return all;
}

function _parseModel(m) {
  const caps = m.capabilities || {};
  const effort = caps.effort || {};
  const hasCapData = Object.keys(caps).length > 0;
  const hasEffortData = Object.keys(effort).length > 0;
  let effortLevels = [];
  if (effort.low?.supported) effortLevels.push('low');
  if (effort.medium?.supported) effortLevels.push('medium');
  if (effort.high?.supported) effortLevels.push('high');
  if (effort.max?.supported) effortLevels.push('max');

  // Determine effort support from API data
  let effortSupported = hasCapData ? (effort.supported === true) : true;

  // Fallback: if API didn't return effort data (proxy/gateway APIs),
  // use built-in defaults for known Claude models
  if (!hasEffortData) {
    const builtin = _getBuiltinDefaults(m.id);
    if (builtin) {
      effortSupported = builtin.effortSupported;
      effortLevels = builtin.effortLevels;
    }
  }

  return {
    id: m.id,
    displayName: m.display_name || m.id,
    effortSupported,
    effortLevels,
    maxInputTokens: m.max_input_tokens || 0,
    maxOutputTokens: m.max_tokens || 0,
    createdAt: m.created_at || null,
  };
}

// ── Public API ─────────────────────────────────────

async function fetchModels(forceRefresh = false) {
  // Return cache if fresh
  if (!forceRefresh && _cache && (Date.now() - _cacheTime) < CACHE_TTL) {
    return { models: _cache, cached: true };
  }

  const creds = _discoverCredentials();
  if (!creds) {
    return {
      models: _cache || DEFAULT_MODELS,
      error: 'No API key found. Showing default models.',
      cached: !!_cache,
      isDefault: !_cache,
    };
  }

  try {
    const raw = await _fetchAllModels(creds.apiKey, creds.baseUrl);
    const models = raw.map(_parseModel)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    _cache = models;
    _cacheTime = Date.now();

    return { models, cached: false };
  } catch (err) {
    // If API fails, try to extract model names from error message
    const errorModels = _extractModelsFromError(err.message);
    if (errorModels.length > 0) {
      _cache = errorModels;
      _cacheTime = Date.now();
      return { models: errorModels, cached: false, error: 'API /v1/models unavailable. Loaded models from API error response.' };
    }

    // Some gateways return HTML/404 for /v1/models but valid JSON model hints on /v1/messages
    const probedModels = await _probeAvailableModelsFromMessages(creds.apiKey, creds.baseUrl);
    if (probedModels.length > 0) {
      _cache = probedModels;
      _cacheTime = Date.now();
      return { models: probedModels, cached: false, error: 'API /v1/models unavailable. Loaded models from /v1/messages error response.' };
    }

    return {
      models: _cache || DEFAULT_MODELS,
      error: err.message + (_cache ? ' (showing cached)' : ' (showing defaults)'),
      cached: !!_cache,
      isDefault: !_cache,
    };
  }
}

// Try to extract model names from API error messages like
// "Available models: model1, model2, model3"
function _extractModelsFromError(errorMsg) {
  let sourceText = String(errorMsg || '');

  const jsonStart = sourceText.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const payload = JSON.parse(sourceText.slice(jsonStart));
      if (typeof payload?.error?.message === 'string') {
        sourceText = payload.error.message;
      }
    } catch {
      // Keep original text when payload isn't valid JSON
    }
  }

  const match = sourceText.match(/Available models?:\s*(.+)/i);
  if (!match) return [];

  const names = match[1]
    .split(',')
    .map(s => s.trim().replace(/[."}\s]+$/, ''))
    .filter(Boolean)
    .map(id => id.match(/[a-z0-9][a-z0-9._-]*/i)?.[0] || '')
    .filter(Boolean)
    .filter(id => !/["{}:]/.test(id));

  return names.map(id => ({
    id,
    displayName: id,
    effortSupported: !!_getBuiltinDefaults(id)?.effortSupported,
    effortLevels: _getBuiltinDefaults(id)?.effortLevels || ['low','medium','high','max'],
    maxInputTokens: 200000,
    maxOutputTokens: 16000,
    createdAt: null,
  }));
}

// Fetch models specifically from Anthropic's default API (ignoring custom base URL)
async function fetchModelsFromAnthropic() {
  const creds = _discoverCredentials();
  if (!creds) return { models: DEFAULT_MODELS, error: 'No API key found', isDefault: true };

  try {
    const raw = await _fetchAllModels(creds.apiKey, 'https://api.anthropic.com');
    const models = raw.map(_parseModel)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return { models, cached: false };
  } catch (err) {
    return { models: DEFAULT_MODELS, error: err.message + ' (showing defaults)', isDefault: true };
  }
}

function getDefaultModels() {
  return { models: [...DEFAULT_MODELS] };
}

module.exports = { fetchModels, fetchModelsFromAnthropic, getDefaultModels, DEFAULT_MODELS, extractModelsFromError: _extractModelsFromError };

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

// ── Default recommended plugins (shown on fresh installs) ─────
const DEFAULT_RECOMMENDED_PLUGINS = [
  { key: 'chrome-devtools-mcp@chrome-devtools-plugins', repo: 'ChromeDevTools/chrome-devtools-mcp', official: false, marketplace: 'chrome-devtools-plugins' },
  { key: 'frontend-design@claude-plugins-official',     repo: null, official: true },
  { key: 'superpowers@claude-plugins-official',          repo: null, official: true },
  { key: 'ui-ux-pro-max@ui-ux-pro-max-skill',          repo: 'nextlevelbuilder/ui-ux-pro-max-skill', official: false, marketplace: 'ui-ux-pro-max-skill' },
  { key: 'context7@context7-mcp',                       repo: 'nicobailon/context7-mcp', official: false, marketplace: 'context7-mcp', installCmd: { win32: 'npx -y ctx7 setup --claude -y', darwin: 'npx -y ctx7 setup --claude -y', linux: 'npx -y ctx7 setup --claude -y' }, type: 'mcp', detectMcp: 'context7' },
  { key: 'gsd@get-shit-done',                           repo: 'glittercowboy/get-shit-done', official: false, marketplace: 'get-shit-done', installCmd: { win32: 'npx -y get-shit-done-cc@latest --global', darwin: 'npx -y get-shit-done-cc@latest --global', linux: 'npx -y get-shit-done-cc@latest --global' }, type: 'skill', detectPath: 'skills/gsd-help' },
];

// ── Recommended tools (non-plugin items installed via npx/MCP) ─────
// NOTE: context7 and GSD have been merged into DEFAULT_RECOMMENDED_PLUGINS above.
const DEFAULT_RECOMMENDED_TOOLS = [];

function isGsdInstalledFromPaths(home, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;

  // Legacy Claude Code layout
  const legacyCommandsPath = path.join(home, 'commands', 'gsd');
  if (existsSync(legacyCommandsPath)) return true;

  const helpSkillPath = path.join(home, 'skills', 'gsd-help');
  if (!existsSync(helpSkillPath)) return false;

  let gsdSkillCount = 0;
  try {
    const skillNames = readdirSync(path.join(home, 'skills'));
    gsdSkillCount = skillNames.filter(name => /^gsd-/i.test(name)).length;
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('claude-detector', `readdirSync skills failed: ${err.message}`);
    gsdSkillCount = 0;
  }

  // gsd-file-manifest.json may persist from stale installs; require enough gsd skills too
  const manifestPath = path.join(home, 'gsd-file-manifest.json');
  const hasManifest = existsSync(manifestPath);

  if (gsdSkillCount >= 5) return true;
  if (hasManifest && gsdSkillCount >= 2) return true;
  return false;
}

function detectRecommendedTools() {
  const home = getClaudeHome();
  const results = [];
  for (const tool of DEFAULT_RECOMMENDED_TOOLS) {
    const entry = { ...tool, installed: false };
    if (tool.key === 'gsd') {
      entry.installed = isGsdInstalledFromPaths(home);
    } else if (tool.detectPath) {
      // Check if skill/command directory exists under ~/.claude/
      const skillPath = path.join(home, tool.detectPath);
      entry.installed = fs.existsSync(skillPath);
    }
    if (tool.detectMcp) {
      // Check if MCP server is configured in settings.json or .claude.json
      const mcpFiles = [
        path.join(home, 'settings.json'),
        path.join(os.homedir(), '.claude.json'),
      ];
      for (const mcpFile of mcpFiles) {
        try {
          const settings = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
          const mcpServers = settings.mcpServers || {};
          if (Object.keys(mcpServers).some(k => k.toLowerCase().includes(tool.detectMcp))) {
            entry.installed = true;
            break;
          }
        } catch (err) {
          if (err.code !== 'ENOENT') logger.warn('claude-detector', `MCP settings read failed: ${err.message}`);
        }
      }
    }
    results.push(entry);
  }
  return results;
}

function getClaudeHome() {
  return path.join(os.homedir(), '.claude');
}

function deduplicateToolsAgainstPlugins(tools, plugins) {
  const pluginKeys = new Set(plugins.map(p => (p.key || p.name || '').split('@')[0].toLowerCase()));
  return tools.filter(t => !pluginKeys.has((t.key || '').toLowerCase()));
}

function extractVersion(output) {
  if (!output || typeof output !== 'string') return null;
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function detect() {
  const platform = process.platform; // 'win32' | 'darwin' | 'linux'
  const result = {
    installed: false,
    version: null,
    path: null,
    authType: null,   // 'anthropic' | 'console' | 'cloud' | 'custom' | null
    authDetail: null,  // partial email, masked key, base URL domain, etc.
    platform,
  };

  // Build extended PATH including common Claude install dirs
  const extraPaths = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.claude', 'local'),
  ];
  const envPath = process.env.PATH || '';
  const extendedEnv = { ...process.env, PATH: extraPaths.join(path.delimiter) + path.delimiter + envPath };

  // 1. Check known install locations first (most reliable in packaged apps)
  const knownPath = findClaudePath();
  if (knownPath) {
    result.path = knownPath;
    result.installed = true; // File exists = installed
    try {
      const stdout = execFileSync(knownPath, ['--version'], {
        timeout: 5000, windowsHide: true, encoding: 'utf8', env: extendedEnv,
      }).trim();
      result.version = extractVersion(stdout);
    } catch (e) {
      // Some CLI versions output version on stderr or mix with update notices
      const stderr = (e.stderr || '').toString();
      const stdout = (e.stdout || '').toString();
      result.version = extractVersion(stdout) || extractVersion(stderr);
    }
  }

  // 2. Fallback: try `claude --version` on PATH
  if (!result.installed) {
    try {
      const stdout = execFileSync('claude', ['--version'], {
        timeout: 5000, windowsHide: true, encoding: 'utf8', env: extendedEnv,
      }).trim();
      result.installed = true;
      result.version = extractVersion(stdout);
      if (!result.path) result.path = 'claude'; // on PATH
    } catch (e) {
      const stderr = (e.stderr || '').toString();
      const stdout = (e.stdout || '').toString();
      const ver = extractVersion(stdout) || extractVersion(stderr);
      if (ver) {
        result.installed = true;
        result.version = ver;
        if (!result.path) result.path = 'claude';
      }
    }
  }

  // 3. Detect auth from settings.json
  try {
    const settingsPath = path.join(getClaudeHome(), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const env = settings.env || {};
      const baseUrl = env.ANTHROPIC_BASE_URL || '';
      const authToken = env.ANTHROPIC_AUTH_TOKEN || '';

      if (baseUrl && authToken) {
        // Check if it's a known cloud provider
        if (/bedrock|amazonaws/i.test(baseUrl)) {
          result.authType = 'cloud';
          result.authDetail = 'Amazon Bedrock';
        } else if (/vertex|googleapis/i.test(baseUrl)) {
          result.authType = 'cloud';
          result.authDetail = 'Google Vertex AI';
        } else if (/azure|foundry/i.test(baseUrl)) {
          result.authType = 'cloud';
          result.authDetail = 'Microsoft Foundry';
        } else {
          result.authType = 'custom';
          try { result.authDetail = new URL(baseUrl).hostname; } catch { result.authDetail = baseUrl; }
        }
      } else if (authToken && !baseUrl) {
        result.authType = 'console';
        result.authDetail = maskToken(authToken);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('claude-detector', `settings.json read failed: ${err.message}`);
  }

  // 4. Check for OAuth credentials if no env-based auth found
  if (!result.authType && result.installed) {
    try {
      const credDir = path.join(getClaudeHome(), '.credentials');
      if (fs.existsSync(credDir)) {
        result.authType = 'anthropic';
        result.authDetail = 'Anthropic Account';
      }
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn('claude-detector', `credentials check failed: ${err.message}`);
    }
  }

  return result;
}

function findClaudePath() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
        path.join(os.homedir(), '.claude', 'local', 'claude.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
      ]
    : [
        path.join(os.homedir(), '.local', 'bin', 'claude'),
        path.join(os.homedir(), '.claude', 'local', 'claude'),
        '/usr/local/bin/claude',
      ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (err) { if (err.code !== 'ENOENT') logger.warn('claude-detector', `existsSync failed: ${err.message}`); }
  }
  return null;
}

function maskToken(token) {
  if (!token || token.length < 10) return '••••••••';
  return token.slice(0, 10) + '•••' + token.slice(-4);
}

function readSettingsJson(scope, projectDir) {
  const filePath = scope === 'project' && projectDir
    ? path.join(projectDir, '.claude', 'settings.json')
    : path.join(getClaudeHome(), 'settings.json');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, path: filePath };
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('claude-detector', `readSettingsJson failed: ${err.message}`);
    return { content: '{\n}', path: filePath };
  }
}

function writeSettingsJson(scope, projectDir, content) {
  const filePath = scope === 'project' && projectDir
    ? path.join(projectDir, '.claude', 'settings.json')
    : path.join(getClaudeHome(), 'settings.json');
  // Validate JSON before writing
  JSON.parse(content); // throws if invalid
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, path: filePath };
}

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
  // Resolve the claude binary path
  const claudePath = findClaudePath() || 'claude';

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
    const proc = spawn(claudePath, ['plugins', 'install', pluginKey], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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

function getTagsDir() {
  return path.join(getClaudeHome(), 'settings-tags');
}

function validateTagName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 50) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

function listSettingsTags() {
  const dir = getTagsDir();
  const tags = [];
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const name = f.replace(/\.json$/, '');
      tags.push({ name, path: path.join(dir, f) });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('claude-detector', `listSettingsTags read failed: ${err.message}`);
  }
  tags.sort((a, b) => a.name.localeCompare(b.name));
  return { tags };
}

function loadSettingsTag(name) {
  if (!validateTagName(name)) return { content: '{\n}', path: '', error: 'Invalid tag name' };
  const filePath = path.join(getTagsDir(), name + '.json');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, path: filePath };
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('claude-detector', `loadSettingsTag read failed: ${err.message}`);
    return { content: '{\n}', path: filePath, error: 'Tag not found' };
  }
}

function saveSettingsTag(name, content) {
  if (!validateTagName(name)) throw new Error('Invalid tag name: alphanumeric, hyphens, underscores only, max 50 chars');
  JSON.parse(content); // throws if invalid JSON
  const dir = getTagsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name + '.json');
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, path: filePath };
}

function deleteSettingsTag(name) {
  if (!validateTagName(name)) throw new Error('Invalid tag name');
  const filePath = path.join(getTagsDir(), name + '.json');
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('Tag not found');
    throw err;
  }
  return { ok: true };
}

// ── Update Checking ──────────────────────────────
let _updateCache = null;
let _updateCacheTime = 0;
const UPDATE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function checkForUpdate(opts) {
  const forceCheck = opts && opts.forceCheck;
  if (!forceCheck && _updateCache && (Date.now() - _updateCacheTime < UPDATE_CACHE_TTL)) {
    return Promise.resolve(_updateCache);
  }

  const claudePath = findClaudePath() || 'claude';
  const { execFile } = require('child_process');

  return new Promise(resolve => {
    execFile(claudePath, ['update'], { timeout: 60000, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      let result;

      if (err && !output) {
        result = { updateAvailable: false, currentVersion: null, latestVersion: null, error: err.message || 'Update check failed' };
      } else if (/is up to date/i.test(output)) {
        const verMatch = output.match(/up to date \(([^)]+)\)/i) || output.match(/(\d+\.\d+\.\d+)/);
        const ver = verMatch ? verMatch[1] : null;
        result = { updateAvailable: false, currentVersion: ver, latestVersion: ver };
      } else if (/updat/i.test(output)) {
        const curMatch = output.match(/Current version:\s*(\S+)/i);
        const newMatch = output.match(/(\d+\.\d+\.\d+)\s*$/m) || output.match(/to\s+(\d+\.\d+\.\d+)/i);
        const cur = curMatch ? curMatch[1] : null;
        const latest = newMatch ? newMatch[1] : null;
        result = { updateAvailable: !!(latest && cur && latest !== cur), currentVersion: cur, latestVersion: latest || cur };
      } else {
        result = { updateAvailable: false, currentVersion: null, latestVersion: null, error: 'Could not determine update status' };
      }

      _updateCache = result;
      _updateCacheTime = Date.now();
      resolve(result);
    });
  });
}

// ── Prerequisite Detection ──────────────────────────
function detectPrerequisites() {
  const platform = process.platform;
  const result = {
    git: { installed: false, version: null, path: null, required: platform === 'win32' },
    node: { installed: false, version: null, path: null, required: true },
  };

  // Git / git-bash detection
  try {
    const stdout = execFileSync('git', ['--version'], {
      timeout: 5000, windowsHide: true, encoding: 'utf8',
    }).trim();
    result.git.installed = true;
    const verMatch = stdout.match(/(\d+\.\d+[\d.]*)/);
    result.git.version = verMatch ? verMatch[1].replace(/\.$/, '') : stdout;
    result.git.path = findExecutable('git');
  } catch (err) {
    logger.debug('claude-detector', `git --version failed: ${err.message}`);
    // Check known locations on Windows
    if (platform === 'win32') {
      const knownPaths = [
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
      ];
      for (const p of knownPaths) {
        try {
          if (fs.existsSync(p)) {
            result.git.installed = true;
            result.git.path = p;
            try {
              const stdout = execFileSync(p, ['--version'], {
                timeout: 5000, windowsHide: true, encoding: 'utf8',
              }).trim();
              const verMatch = stdout.match(/(\d+\.\d+[\d.]*)/);
              result.git.version = verMatch ? verMatch[1] : null;
            } catch (err2) { logger.debug('claude-detector', `git version read failed: ${err2.message}`); }
            break;
          }
        } catch (err2) { logger.debug('claude-detector', `git existsSync failed: ${err2.message}`); }
      }
    }
  }

  // Check for git-bash specifically on Windows (required by Claude Code)
  if (platform === 'win32') {
    const bashPaths = [
      process.env.CLAUDE_CODE_GIT_BASH_PATH,
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    ].filter(Boolean);
    result.git.hasBash = bashPaths.some(p => { try { return fs.existsSync(p); } catch (err) { logger.debug('claude-detector', `bash existsSync failed: ${err.message}`); return false; } });
    if (!result.git.hasBash) result.git.installed = false; // git without bash is not sufficient on Windows
  }

  // Node.js detection
  try {
    const stdout = execFileSync('node', ['--version'], {
      timeout: 5000, windowsHide: true, encoding: 'utf8',
    }).trim();
    result.node.installed = true;
    result.node.version = stdout.replace(/^v/i, '').trim();
    result.node.path = findExecutable('node');
  } catch (err) {
    logger.debug('claude-detector', `node --version failed: ${err.message}`);
    // Check known locations on Windows
    if (platform === 'win32') {
      const knownPaths = [
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'nodejs', 'node.exe'),
      ];
      for (const p of knownPaths) {
        try {
          if (fs.existsSync(p)) {
            result.node.installed = true;
            result.node.path = p;
            try {
              const stdout = execFileSync(p, ['--version'], {
                timeout: 5000, windowsHide: true, encoding: 'utf8',
              }).trim();
              result.node.version = stdout.replace(/^v/i, '').trim();
            } catch (err2) { logger.debug('claude-detector', `node version read failed: ${err2.message}`); }
            break;
          }
        } catch (err2) { logger.debug('claude-detector', `node existsSync failed: ${err2.message}`); }
      }
    }
  }

  return result;
}

function findExecutable(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const stdout = execFileSync(cmd, [name], {
      timeout: 3000, windowsHide: true, encoding: 'utf8',
    }).trim();
    return stdout.split(/\r?\n/)[0]; // first result
  } catch (err) { logger.debug('claude-detector', `findExecutable ${name} failed: ${err.message}`); return null; }
}

module.exports = {
  detect, detectPrerequisites, detectRecommendedTools, readSettingsJson, writeSettingsJson,
  listPlugins, togglePlugin, installPlugin, testCustomProvider,
  listSettingsTags, loadSettingsTag, saveSettingsTag, deleteSettingsTag,
  checkForUpdate,
  getClaudeHome, maskToken,
  isGsdInstalledFromPaths,
  deduplicateToolsAgainstPlugins,
  extractVersion,
  DEFAULT_RECOMMENDED_PLUGINS, DEFAULT_RECOMMENDED_TOOLS,
};

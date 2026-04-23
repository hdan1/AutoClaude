// lib/claude-detection.js — Detection logic extracted from claude-detector.js (5A)
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const execFileAsync = promisify(execFile);

// ── Default recommended plugins (shown on fresh installs) ─────
const DEFAULT_RECOMMENDED_PLUGINS = [
  { key: 'chrome-devtools-mcp@chrome-devtools-plugins', repo: 'ChromeDevTools/chrome-devtools-mcp', official: false, marketplace: 'chrome-devtools-plugins' },
  { key: 'frontend-design@claude-plugins-official',     repo: null, official: true },
  { key: 'superpowers@claude-plugins-official',          repo: null, official: true },
  { key: 'ui-ux-pro-max@ui-ux-pro-max-skill',          repo: 'nextlevelbuilder/ui-ux-pro-max-skill', official: false, marketplace: 'ui-ux-pro-max-skill' },
  { key: 'context7@context7-mcp',                       repo: 'nicobailon/context7-mcp', official: false, marketplace: 'context7-mcp', npmPackage: 'ctx7', installCmd: { win32: 'npx -y ctx7 setup --claude -y', darwin: 'npx -y ctx7 setup --claude -y', linux: 'npx -y ctx7 setup --claude -y' }, type: 'mcp', detectMcp: 'context7' },
  { key: 'gsd@get-shit-done',                           repo: 'glittercowboy/get-shit-done', official: false, marketplace: 'get-shit-done', npmPackage: 'get-shit-done-cc', installCmd: { win32: 'npx -y get-shit-done-cc@latest --global', darwin: 'npx -y get-shit-done-cc@latest --global', linux: 'npx -y get-shit-done-cc@latest --global' }, type: 'skill', detectPath: 'skills/gsd-help' },
];

// ── Recommended tools (non-plugin items installed via npx/MCP) ─────
// NOTE: context7 and GSD have been merged into DEFAULT_RECOMMENDED_PLUGINS above.
const DEFAULT_RECOMMENDED_TOOLS = [];

function getClaudeHome() {
  return path.join(os.homedir(), '.claude');
}

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

function deduplicateToolsAgainstPlugins(tools, plugins) {
  const pluginKeys = new Set(plugins.map(p => (p.key || p.name || '').split('@')[0].toLowerCase()));
  return tools.filter(t => !pluginKeys.has((t.key || '').toLowerCase()));
}

function extractVersion(output) {
  if (!output || typeof output !== 'string') return null;
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function maskToken(token) {
  if (!token || token.length < 10) return '••••••••';
  return token.slice(0, 10) + '•••' + token.slice(-4);
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

function findExecutable(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const stdout = execFileSync(cmd, [name], {
      timeout: 3000, windowsHide: true, encoding: 'utf8',
    }).trim();
    return stdout.split(/\r?\n/)[0]; // first result
  } catch (err) { logger.debug('claude-detector', `findExecutable ${name} failed: ${err.message}`); return null; }
}

async function detect() {
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
      const { stdout } = await execFileAsync(knownPath, ['--version'], {
        timeout: 5000, windowsHide: true, encoding: 'utf8', env: extendedEnv,
      });
      result.version = extractVersion(stdout.trim());
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
      const { stdout } = await execFileAsync('claude', ['--version'], {
        timeout: 5000, windowsHide: true, encoding: 'utf8', env: extendedEnv,
      });
      result.installed = true;
      result.version = extractVersion(stdout.trim());
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

// ── Prerequisite Detection ──────────────────────────
async function detectPrerequisites() {
  const platform = process.platform;
  const result = {
    git: { installed: false, version: null, path: null, required: platform === 'win32' },
    node: { installed: false, version: null, path: null, required: true },
  };

  // Git / git-bash detection
  try {
    const { stdout: gitOut } = await execFileAsync('git', ['--version'], {
      timeout: 5000, windowsHide: true, encoding: 'utf8',
    });
    result.git.installed = true;
    const verMatch = gitOut.trim().match(/(\d+\.\d+[\d.]*)/);
    result.git.version = verMatch ? verMatch[1].replace(/\.$/, '') : gitOut.trim();
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
              const { stdout: gitVerOut } = await execFileAsync(p, ['--version'], {
                timeout: 5000, windowsHide: true, encoding: 'utf8',
              });
              const verMatch = gitVerOut.trim().match(/(\d+\.\d+[\d.]*)/);
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
    const { stdout: nodeOut } = await execFileAsync('node', ['--version'], {
      timeout: 5000, windowsHide: true, encoding: 'utf8',
    });
    result.node.installed = true;
    result.node.version = nodeOut.trim().replace(/^v/i, '').trim();
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
              const { stdout: nodeVerOut } = await execFileAsync(p, ['--version'], {
                timeout: 5000, windowsHide: true, encoding: 'utf8',
              });
              result.node.version = nodeVerOut.trim().replace(/^v/i, '').trim();
            } catch (err2) { logger.debug('claude-detector', `node version read failed: ${err2.message}`); }
            break;
          }
        } catch (err2) { logger.debug('claude-detector', `node existsSync failed: ${err2.message}`); }
      }
    }
  }

  return result;
}

module.exports = {
  detect,
  detectPrerequisites,
  detectRecommendedTools,
  extractVersion,
  getClaudeHome,
  maskToken,
  findClaudePath,
  findExecutable,
  isGsdInstalledFromPaths,
  deduplicateToolsAgainstPlugins,
  DEFAULT_RECOMMENDED_PLUGINS,
  DEFAULT_RECOMMENDED_TOOLS,
};

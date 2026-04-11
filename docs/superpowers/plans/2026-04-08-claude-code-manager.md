# Claude Code Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude Code detection badge to the topbar with a modal for managing installation, settings.json editing, and plugin management.

**Architecture:** Two new backend modules (`lib/claude-detector.js`, `lib/claude-installer.js`) handle detection and installation via IPC. The renderer gets a modal with three tabs (Overview, Settings Editor, Plugins) built inline in `index.html` following existing patterns. A setup wizard guides first-time install. No external editor dependencies — uses a styled `<textarea>` with manual syntax highlighting to match the existing zero-dependency approach.

**Tech Stack:** Electron IPC (ipcMain.handle), Node.js child_process, vanilla JS/HTML/CSS (matching existing index.html patterns)

**Design Spec:** `docs/superpowers/specs/2026-04-08-claude-code-manager-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/claude-detector.js` | Create | Detect Claude Code: installed?, version, path, auth type, platform |
| `lib/claude-installer.js` | Create | Run install commands per platform, stream output |
| `main.js` | Modify | Register IPC handlers for detection, install, auth, settings r/w, plugins |
| `preload.js` | Modify | Expose new API methods to renderer |
| `index.html` | Modify | Badge in topbar, modal HTML/CSS/JS, all three tabs |
| `package.json` | Modify | Add `lib/claude-detector.js` and `lib/claude-installer.js` to build.files |

---

### Task 1: Claude Code Detector Module

**Files:**
- Create: `lib/claude-detector.js`

- [ ] **Step 1: Create `lib/claude-detector.js`**

```js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getClaudeHome() {
  return path.join(os.homedir(), '.claude');
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

  // 1. Try `claude --version` on PATH
  try {
    const stdout = execFileSync('claude', ['--version'], {
      timeout: 5000, windowsHide: true, encoding: 'utf8',
    }).trim();
    result.installed = true;
    result.version = stdout.replace(/^claude\s*/i, '').trim();
    result.path = findClaudePath();
  } catch {
    // 2. Check known install locations
    const knownPath = findClaudePath();
    if (knownPath) {
      try {
        const stdout = execFileSync(knownPath, ['--version'], {
          timeout: 5000, windowsHide: true, encoding: 'utf8',
        }).trim();
        result.installed = true;
        result.version = stdout.replace(/^claude\s*/i, '').trim();
        result.path = knownPath;
      } catch { /* not runnable */ }
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
  } catch { /* can't read settings */ }

  // 4. Check for OAuth credentials if no env-based auth found
  if (!result.authType && result.installed) {
    try {
      const credDir = path.join(getClaudeHome(), '.credentials');
      if (fs.existsSync(credDir)) {
        result.authType = 'anthropic';
        result.authDetail = 'Anthropic Account';
      }
    } catch { /* silent */ }
  }

  return result;
}

function findClaudePath() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(os.homedir(), '.claude', 'local', 'claude.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
      ]
    : [
        path.join(os.homedir(), '.claude', 'local', 'claude'),
        '/usr/local/bin/claude',
      ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
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
  } catch {
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
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* empty */ }

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
    } catch { /* no manifest */ }
  }

  return { installed };
}

function togglePlugin(pluginKey, enabled) {
  const settingsPath = path.join(getClaudeHome(), 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* new */ }
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins[pluginKey] = enabled;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return { ok: true };
}

function installPlugin(source, repo) {
  const settingsPath = path.join(getClaudeHome(), 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* new */ }
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  if (!settings.extraKnownMarketplaces) settings.extraKnownMarketplaces = {};

  // Extract plugin name from repo (last segment)
  const name = repo.split('/').pop();
  const pluginKey = `${name}@${name}`;
  settings.extraKnownMarketplaces[name] = { source: { source: 'github', repo } };
  settings.enabledPlugins[pluginKey] = true;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return { ok: true };
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

module.exports = {
  detect, readSettingsJson, writeSettingsJson,
  listPlugins, togglePlugin, installPlugin, testCustomProvider,
  getClaudeHome, maskToken,
};
```

- [ ] **Step 2: Commit**

```bash
git add lib/claude-detector.js
git commit -m "feat: add claude-detector module for Claude Code detection, settings, and plugin management"
```

---

### Task 2: Claude Code Installer Module

**Files:**
- Create: `lib/claude-installer.js`

- [ ] **Step 1: Create `lib/claude-installer.js`**

```js
const { spawn } = require('child_process');
const EventEmitter = require('events');

const INSTALL_COMMANDS = {
  powershell: { cmd: 'powershell', args: ['-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex'] },
  cmd:        { cmd: 'cmd', args: ['/c', 'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd'] },
  winget:     { cmd: 'winget', args: ['install', 'Anthropic.ClaudeCode', '--accept-package-agreements', '--accept-source-agreements'] },
  curl:       { cmd: 'bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] },
  homebrew:   { cmd: 'brew', args: ['install', '--cask', 'claude-code'] },
};

function install(method) {
  const emitter = new EventEmitter();
  const spec = INSTALL_COMMANDS[method];
  if (!spec) {
    setTimeout(() => emitter.emit('error', `Unknown install method: ${method}`), 0);
    return emitter;
  }

  const proc = spawn(spec.cmd, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  proc.stdout.on('data', d => emitter.emit('progress', d.toString()));
  proc.stderr.on('data', d => emitter.emit('progress', d.toString()));

  proc.on('close', code => {
    if (code === 0) {
      emitter.emit('complete');
    } else {
      emitter.emit('error', `Install exited with code ${code}`);
    }
  });

  proc.on('error', err => emitter.emit('error', err.message));

  return emitter;
}

function authenticate(method) {
  const emitter = new EventEmitter();
  let cmd, args;

  if (method === 'anthropic') {
    cmd = 'claude'; args = ['auth', 'login'];
  } else if (method === 'console') {
    cmd = 'claude'; args = ['auth', 'login', '--console'];
  } else {
    setTimeout(() => emitter.emit('error', 'Use custom provider or cloud provider settings instead'), 0);
    return emitter;
  }

  const proc = spawn(cmd, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });

  proc.stdout.on('data', d => emitter.emit('progress', d.toString()));
  proc.stderr.on('data', d => emitter.emit('progress', d.toString()));
  proc.on('close', code => {
    if (code === 0) emitter.emit('complete');
    else emitter.emit('error', `Auth exited with code ${code}`);
  });
  proc.on('error', err => emitter.emit('error', err.message));

  return emitter;
}

module.exports = { install, authenticate, INSTALL_COMMANDS };
```

- [ ] **Step 2: Commit**

```bash
git add lib/claude-installer.js
git commit -m "feat: add claude-installer module for platform-aware Claude Code installation"
```

---

### Task 3: IPC Handlers in main.js

**Files:**
- Modify: `main.js` (add require + IPC handlers after existing handlers)

- [ ] **Step 1: Add requires at top of main.js (after line ~16, after existing requires)**

Add these two lines after the `SuperpowersDetector` require:

```js
const claudeDetector = require('./lib/claude-detector');
const claudeInstaller = require('./lib/claude-installer');
```

- [ ] **Step 2: Add IPC handlers**

Add these handlers in `main.js` after the existing `ipcMain.handle('show-confirm-dialog')` block (around line ~380). Find the last `ipcMain.handle` block and add after it:

```js
// ── Claude Code Manager IPC ─────────────────────
ipcMain.handle('detect-claude-code', () => claudeDetector.detect());

ipcMain.handle('read-claude-settings', (_, { scope, projectDir }) =>
  claudeDetector.readSettingsJson(scope, projectDir));

ipcMain.handle('write-claude-settings', (_, { scope, projectDir, content }) => {
  try { return claudeDetector.writeSettingsJson(scope, projectDir, content); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('list-claude-plugins', () => claudeDetector.listPlugins());

ipcMain.handle('toggle-claude-plugin', (_, { pluginKey, enabled }) =>
  claudeDetector.togglePlugin(pluginKey, enabled));

ipcMain.handle('install-claude-plugin', (_, { source, repo }) =>
  claudeDetector.installPlugin(source, repo));

ipcMain.handle('test-custom-provider', (_, { baseUrl, authToken }) =>
  claudeDetector.testCustomProvider(baseUrl, authToken));

ipcMain.handle('install-claude-code', (_, { method }) => {
  return new Promise((resolve) => {
    const emitter = claudeInstaller.install(method);
    let output = '';
    emitter.on('progress', text => {
      output += text;
      send('install-claude-code-progress', { output: text, done: false });
    });
    emitter.on('complete', () => {
      send('install-claude-code-progress', { output: '', done: true });
      resolve({ ok: true, output });
    });
    emitter.on('error', err => {
      send('install-claude-code-progress', { output: err, done: true, error: err });
      resolve({ ok: false, error: err, output });
    });
  });
});

ipcMain.handle('authenticate-claude-code', (_, { method }) => {
  return new Promise((resolve) => {
    const emitter = claudeInstaller.authenticate(method);
    let output = '';
    emitter.on('progress', text => { output += text; });
    emitter.on('complete', () => resolve({ ok: true, output }));
    emitter.on('error', err => resolve({ ok: false, error: err, output }));
  });
});

ipcMain.handle('save-custom-provider', (_, { baseUrl, authToken }) => {
  try {
    const { readSettingsJson, writeSettingsJson } = claudeDetector;
    const { content, path: filePath } = readSettingsJson('global');
    const settings = JSON.parse(content);
    if (!settings.env) settings.env = {};
    settings.env.ANTHROPIC_BASE_URL = baseUrl;
    settings.env.ANTHROPIC_AUTH_TOKEN = authToken;
    writeSettingsJson('global', null, JSON.stringify(settings, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
```

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat: register Claude Code Manager IPC handlers in main.js"
```

---

### Task 4: Preload API Extensions

**Files:**
- Modify: `preload.js`

- [ ] **Step 1: Add Claude Code Manager API methods**

Add these methods inside the `contextBridge.exposeInMainWorld('api', { ... })` object, before the closing `});`. Add them after the sleep/update section (around line 69, before the final `});`):

```js
  // -- Claude Code Manager --
  detectClaudeCode:       () => ipcRenderer.invoke('detect-claude-code'),
  readClaudeSettings:     opts => ipcRenderer.invoke('read-claude-settings', opts),
  writeClaudeSettings:    opts => ipcRenderer.invoke('write-claude-settings', opts),
  listClaudePlugins:      () => ipcRenderer.invoke('list-claude-plugins'),
  toggleClaudePlugin:     opts => ipcRenderer.invoke('toggle-claude-plugin', opts),
  installClaudePlugin:    opts => ipcRenderer.invoke('install-claude-plugin', opts),
  testCustomProvider:     opts => ipcRenderer.invoke('test-custom-provider', opts),
  installClaudeCode:      opts => ipcRenderer.invoke('install-claude-code', opts),
  authenticateClaudeCode: opts => ipcRenderer.invoke('authenticate-claude-code', opts),
  saveCustomProvider:     opts => ipcRenderer.invoke('save-custom-provider', opts),
  onInstallProgress:      cb => safeOn('install-claude-code-progress', cb),
```

- [ ] **Step 2: Commit**

```bash
git add preload.js
git commit -m "feat: expose Claude Code Manager API in preload.js"
```

---

### Task 5: Update package.json Build Files

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Verify `lib/**/*` glob in build.files**

The existing `"lib/**/*"` entry in `package.json` `build.files` already covers the new files. No change needed — the glob includes all files under `lib/`.

- [ ] **Step 2: Commit (skip — no changes needed)**

---

### Task 6: Badge CSS & HTML in index.html

**Files:**
- Modify: `index.html` (CSS section + topbar HTML)

- [ ] **Step 1: Add badge CSS**

Add these styles inside the `<style>` block in `index.html`, after the existing `.settings-close:hover` rule (around line 192):

```css
/* Claude Code Manager Badge */
.cc-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 10px;border-radius:12px;cursor:pointer;margin-left:10px;transition:opacity .15s;border:1px solid transparent}
.cc-badge:hover{opacity:.85}
.cc-badge.installed{background:rgba(35,134,54,.2);color:var(--grn);border-color:rgba(35,134,54,.4)}
.cc-badge.missing{background:rgba(218,54,51,.15);color:var(--red);border-color:rgba(218,54,51,.3)}
.cc-badge.installing{background:rgba(210,153,34,.15);color:var(--ylw);border-color:rgba(210,153,34,.3)}
.cc-badge .dot{font-size:8px}
```

- [ ] **Step 2: Add badge HTML in topbar**

In `index.html`, change line 245 from:

```html
  <div class="logo">AUTO CLAUDE</div>
```

to:

```html
  <div class="logo">AUTO CLAUDE</div>
  <span class="cc-badge missing" id="ccBadge" title="Claude Code Status"><span class="dot">●</span> <span id="ccBadgeText">Checking...</span></span>
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add Claude Code status badge to topbar"
```

---

### Task 7: Modal CSS in index.html

**Files:**
- Modify: `index.html` (CSS section)

- [ ] **Step 1: Add modal CSS**

Add after the badge CSS from Task 6:

```css
/* Claude Code Manager Modal */
.ccm-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:310}
.ccm-overlay.show{display:block}
.ccm-modal{display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--bg);border:1px solid var(--bdr);border-radius:10px;z-index:311;width:680px;max-width:92vw;height:540px;max-height:88vh;box-shadow:0 12px 40px rgba(0,0,0,.6);overflow:hidden;flex-direction:column}
.ccm-modal.show{display:flex}
.ccm-header{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid var(--bdr)}
.ccm-header h3{margin:0;font-size:14px;font-weight:600;color:var(--tx)}
.ccm-close{background:none;border:none;color:var(--tx2);font-size:18px;cursor:pointer;padding:4px 8px}
.ccm-close:hover{color:var(--tx)}
.ccm-tabs{display:flex;border-bottom:1px solid var(--bdr)}
.ccm-tab{padding:10px 20px;font-size:12px;color:var(--tx2);cursor:pointer;border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none}
.ccm-tab:hover{color:var(--tx)}
.ccm-tab.active{color:var(--acc);border-bottom-color:var(--acc)}
.ccm-tab.disabled{color:var(--tx3);cursor:not-allowed;opacity:.4}
.ccm-body{flex:1;overflow-y:auto;padding:18px}
.ccm-card{background:var(--bg2);border:1px solid var(--bdr);border-radius:6px;padding:10px 14px;margin-bottom:8px}
.ccm-card-label{font-size:10px;color:var(--tx2);text-transform:uppercase;margin-bottom:4px}
.ccm-card-value{font-size:13px;color:var(--tx)}
.ccm-card-row{display:flex;justify-content:space-between;align-items:center}
.ccm-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.ccm-btn{padding:6px 16px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:none;transition:opacity .15s}
.ccm-btn:hover{opacity:.85}
.ccm-btn-primary{background:#238636;color:#fff}
.ccm-btn-secondary{background:var(--bg3);color:var(--tx);border:1px solid var(--bdr)}
.ccm-link{color:var(--acc);font-size:11px;cursor:pointer;background:none;border:none}
.ccm-link:hover{text-decoration:underline}
/* Wizard steps */
.ccm-step{display:flex;align-items:flex-start;gap:12px;margin-bottom:18px}
.ccm-step-num{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
.ccm-step-num.active{background:#238636;color:#fff}
.ccm-step-num.done{background:#238636;color:#fff}
.ccm-step-num.pending{background:var(--bg3);color:var(--tx2)}
.ccm-step-body{flex:1}
.ccm-step-title{font-size:14px;color:var(--tx);font-weight:600}
.ccm-step-sub{font-size:11px;color:var(--tx2);margin-top:2px}
.ccm-dimmed{opacity:.35}
/* Install method tabs */
.ccm-method-tabs{display:flex;gap:2px;background:var(--bg2);border-radius:5px;padding:2px;width:fit-content;margin-bottom:10px;border:1px solid var(--bdr)}
.ccm-method-tab{font-size:10px;padding:4px 10px;border-radius:3px;cursor:pointer;color:var(--tx2);background:none;border:none}
.ccm-method-tab.active{background:#238636;color:#fff;font-weight:500}
/* Command display */
.ccm-cmd{background:var(--bg2);border:1px solid var(--bdr);border-radius:6px;padding:8px 12px;font-family:monospace;font-size:11px;color:var(--cyn);margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
.ccm-cmd-copy{color:var(--tx2);cursor:pointer;font-size:10px;background:none;border:none}
/* Auth options */
.ccm-auth-opt{background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:12px;cursor:pointer;margin-bottom:8px;transition:border-color .15s}
.ccm-auth-opt:hover{border-color:var(--acc)}
.ccm-auth-opt.selected{border:2px solid var(--acc)}
.ccm-auth-opt h4{font-size:12px;color:var(--tx);font-weight:500;margin:0}
.ccm-auth-opt p{font-size:10px;color:var(--tx2);margin:2px 0 0}
.ccm-badge-rec{background:#238636;color:#fff;font-size:9px;padding:2px 6px;border-radius:3px;margin-left:6px}
/* Settings editor */
.ccm-editor-toolbar{display:flex;align-items:center;justify-content:space-between;padding:8px 0;margin-bottom:8px}
.ccm-scope-toggle{display:flex;gap:2px;background:var(--bg2);border-radius:5px;padding:2px;border:1px solid var(--bdr)}
.ccm-scope-btn{font-size:10px;padding:3px 10px;border-radius:3px;cursor:pointer;background:none;border:none;color:var(--tx2)}
.ccm-scope-btn.active{background:#238636;color:#fff;font-weight:500}
.ccm-editor-path{font-size:10px;color:var(--tx3);font-family:monospace;margin-left:8px}
.ccm-json-status{font-size:10px;margin-right:8px}
.ccm-json-status.valid{color:var(--grn)}
.ccm-json-status.invalid{color:var(--red)}
.ccm-editor-area{width:100%;min-height:300px;background:var(--bg);border:1px solid var(--bdr);border-radius:6px;font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace;font-size:12px;line-height:20px;color:var(--tx);padding:12px;resize:vertical;tab-size:2}
.ccm-editor-status{display:flex;justify-content:space-between;font-size:9px;color:var(--tx3);padding:4px 0}
/* Plugins */
.ccm-plugin-tabs{display:flex;gap:2px;background:var(--bg2);border-radius:5px;padding:2px;border:1px solid var(--bdr);margin-bottom:12px}
.ccm-plugin-tab{font-size:10px;padding:3px 12px;border-radius:3px;cursor:pointer;background:none;border:none;color:var(--tx2)}
.ccm-plugin-tab.active{background:var(--bg3);color:var(--tx);font-weight:500}
.ccm-plugin-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--bg3)}
.ccm-plugin-icon{width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.ccm-plugin-info{flex:1;min-width:0}
.ccm-plugin-name{font-size:12px;color:var(--tx);font-weight:600}
.ccm-plugin-source{font-size:9px;color:var(--tx2);background:var(--bg2);padding:1px 5px;border-radius:3px;margin-left:6px}
.ccm-plugin-source.community{color:var(--ylw);background:rgba(210,153,34,.15)}
.ccm-plugin-desc{font-size:10px;color:var(--tx2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ccm-toggle{width:36px;height:20px;border-radius:10px;position:relative;cursor:pointer;flex-shrink:0;border:none;transition:background .2s}
.ccm-toggle.on{background:#238636}
.ccm-toggle.off{background:var(--bg3)}
.ccm-toggle::after{content:'';width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;transition:left .2s}
.ccm-toggle.on::after{left:18px}
.ccm-toggle.off::after{left:2px}
.ccm-plugin-search{background:var(--bg2);border:1px solid var(--bdr);border-radius:4px;padding:5px 10px;font-size:11px;color:var(--tx);width:180px}
.ccm-plugin-search::placeholder{color:var(--tx3)}
.ccm-add-repo{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg2);border:1px dashed var(--bdr);border-radius:8px;cursor:pointer;margin-bottom:12px}
.ccm-add-repo:hover{border-color:var(--acc)}
.ccm-install-log{background:var(--bg);border:1px solid var(--bdr);border-radius:6px;padding:8px 12px;font-family:monospace;font-size:10px;color:var(--tx2);max-height:120px;overflow-y:auto;margin-top:8px;white-space:pre-wrap}
.ccm-warn{display:flex;align-items:center;gap:6px;background:rgba(210,153,34,.1);border:1px solid rgba(210,153,34,.2);border-radius:4px;padding:6px 10px;margin-bottom:10px;font-size:10px;color:var(--ylw)}
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: add Claude Code Manager modal CSS"
```

---

### Task 8: Modal HTML Structure in index.html

**Files:**
- Modify: `index.html` (after settings panel HTML, around line 263)

- [ ] **Step 1: Add modal HTML**

Add this after the `</div>` that closes `settingsPanel` (line 263), before `<div class="tb" id="tabBar">`:

```html
<div class="ccm-overlay" id="ccmOverlay"></div>
<div class="ccm-modal" id="ccmModal">
  <div class="ccm-header">
    <h3>Claude Code Manager</h3>
    <button class="ccm-close" id="ccmClose">&times;</button>
  </div>
  <div class="ccm-tabs" id="ccmTabs">
    <button class="ccm-tab active" data-tab="overview">Overview</button>
    <button class="ccm-tab" data-tab="settings">Settings.json</button>
    <button class="ccm-tab" data-tab="plugins">Plugins</button>
  </div>
  <div class="ccm-body" id="ccmBody"></div>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: add Claude Code Manager modal HTML structure"
```

---

### Task 9: Modal JavaScript — Core + Overview Tab

**Files:**
- Modify: `index.html` (add script block before closing `</script>`)

- [ ] **Step 1: Add Claude Code Manager JS**

Add this code at the end of the main `<script>` block in `index.html`, before the final closing `</script>` tag. This is a self-contained IIFE following the same pattern as the existing settings panel code (line 895):

```js
// ── Claude Code Manager ─────────────────────────
(function(){
  const overlay=$('ccmOverlay'),modal=$('ccmModal'),body=$('ccmBody');
  const badge=$('ccBadge'),badgeText=$('ccBadgeText');
  let ccState=null, activeTab='overview';

  // Badge click opens modal
  badge.onclick=()=>{openModal()};
  $('ccmClose').onclick=closeModal;
  overlay.onclick=closeModal;
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal.classList.contains('show'))closeModal()});

  // Tab switching
  $('ccmTabs').addEventListener('click',e=>{
    const tab=e.target.closest('.ccm-tab');
    if(!tab||tab.classList.contains('disabled'))return;
    activeTab=tab.dataset.tab;
    $('ccmTabs').querySelectorAll('.ccm-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    renderTab();
  });

  async function openModal(){
    ccState=await window.api.detectClaudeCode();
    overlay.classList.add('show');modal.classList.add('show');
    updateTabs();renderTab();
  }
  function closeModal(){overlay.classList.remove('show');modal.classList.remove('show')}

  function updateTabs(){
    const tabs=$('ccmTabs').querySelectorAll('.ccm-tab');
    tabs.forEach(t=>{
      if(!ccState.installed&&t.dataset.tab!=='overview'){
        t.classList.add('disabled');
      } else {
        t.classList.remove('disabled');
      }
    });
    // If not installed, rename Overview to Setup
    tabs[0].textContent=ccState.installed?'Overview':'Setup';
    if(!ccState.installed)activeTab='overview';
  }

  function renderTab(){
    if(activeTab==='overview') renderOverview();
    else if(activeTab==='settings') renderSettingsEditor();
    else if(activeTab==='plugins') renderPlugins();
  }

  // Update badge on startup and periodically
  async function refreshBadge(){
    try{
      ccState=await window.api.detectClaudeCode();
      if(ccState.installed){
        badge.className='cc-badge installed';
        badgeText.textContent='Claude Code v'+(ccState.version||'?');
      } else {
        badge.className='cc-badge missing';
        badgeText.textContent='Claude Code missing';
      }
    }catch{
      badge.className='cc-badge missing';
      badgeText.textContent='Claude Code missing';
    }
  }
  refreshBadge();

  // ── Overview / Setup Tab ──────────────────────
  function renderOverview(){
    if(!ccState.installed){renderWizard();return}
    body.innerHTML=`
      <div class="ccm-grid">
        <div class="ccm-card"><div class="ccm-card-label">Status</div><div class="ccm-card-value" style="color:var(--grn)">● Installed</div></div>
        <div class="ccm-card"><div class="ccm-card-label">Version</div><div class="ccm-card-value">${esc(ccState.version||'unknown')}</div></div>
      </div>
      <div class="ccm-card"><div class="ccm-card-label">Path</div><div class="ccm-card-value" style="font-family:monospace;font-size:12px">${esc(ccState.path||'on PATH')}</div></div>
      <div class="ccm-card"><div class="ccm-card-row"><div><div class="ccm-card-label">Auth</div><div class="ccm-card-value">${formatAuth()}</div></div><button class="ccm-link" id="ccmChangeAuth">Change ›</button></div></div>
    `;
    const changeBtn=body.querySelector('#ccmChangeAuth');
    if(changeBtn)changeBtn.onclick=()=>renderAuthStep();
  }

  function formatAuth(){
    if(!ccState.authType)return'<span style="color:var(--ylw)">Not configured</span>';
    const labels={anthropic:'Anthropic Account',console:'API Key',cloud:'Cloud Provider',custom:'Custom Provider'};
    let s=labels[ccState.authType]||ccState.authType;
    if(ccState.authDetail)s+=' · <span style="color:var(--cyn)">'+esc(ccState.authDetail)+'</span>';
    return s;
  }

  // ── Setup Wizard ──────────────────────────────
  let wizardStep=1;
  function renderWizard(){
    wizardStep=1;
    renderWizardStep();
  }

  function renderWizardStep(){
    if(wizardStep===1)renderInstallStep();
    else if(wizardStep===2)renderAuthStep();
    else if(wizardStep===3)renderReadyStep();
  }

  function renderInstallStep(){
    const isWin=ccState.platform==='win32';
    const isMac=ccState.platform==='darwin';
    const methods=isWin?['powershell','cmd','winget']:(isMac?['curl','homebrew']:['curl']);
    const labels={powershell:'PowerShell',cmd:'CMD',winget:'WinGet',curl:'Native',homebrew:'Homebrew'};
    const commands={
      powershell:'irm https://claude.ai/install.ps1 | iex',
      cmd:'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd',
      winget:'winget install Anthropic.ClaudeCode',
      curl:'curl -fsSL https://claude.ai/install.sh | bash',
      homebrew:'brew install --cask claude-code',
    };
    const autoUpdate={powershell:true,cmd:true,curl:true,winget:false,homebrew:false};
    const defaultMethod=methods[0];

    body.innerHTML=`
      <div class="ccm-step">
        <div class="ccm-step-num active">1</div>
        <div class="ccm-step-body">
          <div class="ccm-step-title">Install Claude Code</div>
          <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
            <span style="font-size:11px;color:var(--tx2)">Detected:</span>
            <span style="background:var(--bg2);color:var(--acc);font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid var(--bdr)">${isWin?'Windows':(isMac?'macOS':'Linux')}</span>
          </div>
          <div class="ccm-method-tabs" id="ccmMethodTabs">
            ${methods.map((m,i)=>`<button class="ccm-method-tab${i===0?' active':''}" data-method="${m}">${labels[m]}</button>`).join('')}
          </div>
          <div class="ccm-cmd" id="ccmInstallCmd"><span id="ccmCmdText">${commands[defaultMethod]}</span><button class="ccm-cmd-copy" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">📋</button></div>
          ${isWin&&defaultMethod!=='winget'?'<div class="ccm-warn">⚠ Requires <a href="https://git-scm.com/downloads/win" style="color:var(--acc);text-decoration:underline" target="_blank">Git for Windows</a></div>':''}
          <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
            <button class="ccm-btn ccm-btn-primary" id="ccmInstallBtn">Install Now</button>
            <span style="font-size:10px;color:var(--tx2)" id="ccmAutoUpdateNote">${autoUpdate[defaultMethod]?'Auto-updates ✓':'Manual updates'}</span>
          </div>
          <div class="ccm-install-log" id="ccmInstallLog" style="display:none"></div>
        </div>
      </div>
      <div style="border-top:1px solid var(--bg3);margin:4px 0 16px 38px"></div>
      <div class="ccm-step ccm-dimmed"><div class="ccm-step-num pending">2</div><div class="ccm-step-body"><div class="ccm-step-title" style="color:var(--tx2)">Authenticate</div><div class="ccm-step-sub">Connect your Anthropic account or API key</div></div></div>
      <div style="border-top:1px solid var(--bg3);margin:4px 0 16px 38px"></div>
      <div class="ccm-step ccm-dimmed"><div class="ccm-step-num pending">3</div><div class="ccm-step-body"><div class="ccm-step-title" style="color:var(--tx2)">Ready</div><div class="ccm-step-sub">Start your first session</div></div></div>
    `;

    // Method tab switching
    const methodTabs=body.querySelector('#ccmMethodTabs');
    const cmdText=body.querySelector('#ccmCmdText');
    const autoNote=body.querySelector('#ccmAutoUpdateNote');
    methodTabs.addEventListener('click',e=>{
      const tab=e.target.closest('.ccm-method-tab');if(!tab)return;
      methodTabs.querySelectorAll('.ccm-method-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      const m=tab.dataset.method;
      cmdText.textContent=commands[m];
      autoNote.textContent=autoUpdate[m]?'Auto-updates ✓':'Manual updates';
    });

    // Install button
    body.querySelector('#ccmInstallBtn').onclick=async()=>{
      const activeMethod=methodTabs.querySelector('.ccm-method-tab.active').dataset.method;
      const log=body.querySelector('#ccmInstallLog');
      const btn=body.querySelector('#ccmInstallBtn');
      log.style.display='block';log.textContent='Starting install...\n';
      btn.disabled=true;btn.textContent='Installing...';
      badge.className='cc-badge installing';badgeText.textContent='Installing Claude Code...';

      window.api.onInstallProgress(d=>{
        if(d.output)log.textContent+=d.output;
        log.scrollTop=log.scrollHeight;
      });

      const result=await window.api.installClaudeCode({method:activeMethod});
      if(result.ok){
        ccState=await window.api.detectClaudeCode();
        refreshBadge();
        if(ccState.installed){wizardStep=2;renderAuthStep()}
        else{btn.disabled=false;btn.textContent='Retry Install';log.textContent+='\nInstall completed but claude not detected. Try restarting the app.'}
      } else {
        btn.disabled=false;btn.textContent='Retry Install';
        log.textContent+='\nError: '+(result.error||'Unknown error');
      }
    };
  }

  function renderAuthStep(){
    body.innerHTML=`
      ${ccState.installed?`<div class="ccm-step"><div class="ccm-step-num done">✓</div><div class="ccm-step-body"><span style="font-size:13px;color:var(--grn);font-weight:500">Claude Code v${esc(ccState.version||'?')} installed</span><span style="font-size:10px;color:var(--tx3);margin-left:8px;font-family:monospace">${esc(ccState.path||'')}</span></div></div><div style="border-top:1px solid var(--bg3);margin:4px 0 16px 38px"></div>`:''}
      <div class="ccm-step">
        <div class="ccm-step-num active">2</div>
        <div class="ccm-step-body">
          <div class="ccm-step-title" style="margin-bottom:10px">Authenticate</div>
          <div id="ccmAuthOptions">
            <div class="ccm-auth-opt" data-auth="anthropic"><div style="display:flex;align-items:center;justify-content:space-between"><div><h4>Anthropic Account<span class="ccm-badge-rec">Recommended</span></h4><p>Claude Pro, Max, Team, or Enterprise</p></div></div></div>
            <div class="ccm-auth-opt" data-auth="console"><h4>Console API Key</h4><p>Pre-paid credits</p></div>
            <div class="ccm-auth-opt" data-auth="cloud"><h4>Cloud Provider</h4><p>Amazon Bedrock · Google Vertex AI · Microsoft Foundry</p></div>
            <div class="ccm-auth-opt" data-auth="custom"><h4>Custom Anthropic Provider</h4><p>Proxy, gateway, or self-hosted endpoint (LiteLLM, OpenRouter, etc.)</p></div>
          </div>
          <div id="ccmAuthForm"></div>
        </div>
      </div>
      ${!ccState.installed?`<div style="border-top:1px solid var(--bg3);margin:4px 0 16px 38px"></div><div class="ccm-step ccm-dimmed"><div class="ccm-step-num pending">3</div><div class="ccm-step-body"><div class="ccm-step-title" style="color:var(--tx2)">Ready</div><div class="ccm-step-sub">Start your first session</div></div></div>`:''}
    `;

    body.querySelector('#ccmAuthOptions').addEventListener('click',e=>{
      const opt=e.target.closest('.ccm-auth-opt');if(!opt)return;
      body.querySelectorAll('.ccm-auth-opt').forEach(o=>o.classList.remove('selected'));
      opt.classList.add('selected');
      const method=opt.dataset.auth;
      const form=body.querySelector('#ccmAuthForm');

      if(method==='anthropic'){
        form.innerHTML='<button class="ccm-btn ccm-btn-primary" style="margin-top:10px" id="ccmAuthGo">Login with Browser →</button><div class="ccm-install-log" id="ccmAuthLog" style="display:none"></div>';
        form.querySelector('#ccmAuthGo').onclick=async()=>{
          const log=form.querySelector('#ccmAuthLog');log.style.display='block';log.textContent='Opening browser for login...\n';
          const r=await window.api.authenticateClaudeCode({method:'anthropic'});
          if(r.ok){log.textContent+='Login successful!';ccState=await window.api.detectClaudeCode();refreshBadge();if(!ccState.installed){renderOverview()}else{wizardStep=3;renderReadyStep()}}
          else log.textContent+='Error: '+(r.error||'Failed');
        };
      } else if(method==='console'){
        form.innerHTML='<div class="ccm-cmd" style="margin-top:10px"><span>claude auth login --console</span></div><button class="ccm-btn ccm-btn-primary" id="ccmAuthGo">Run Login</button><div class="ccm-install-log" id="ccmAuthLog" style="display:none"></div>';
        form.querySelector('#ccmAuthGo').onclick=async()=>{
          const log=form.querySelector('#ccmAuthLog');log.style.display='block';log.textContent='Starting console login...\n';
          const r=await window.api.authenticateClaudeCode({method:'console'});
          if(r.ok){log.textContent+='Login successful!';ccState=await window.api.detectClaudeCode();refreshBadge();if(!ccState.installed){renderOverview()}else{wizardStep=3;renderReadyStep()}}
          else log.textContent+='Error: '+(r.error||'Failed');
        };
      } else if(method==='cloud'){
        form.innerHTML='<div style="margin-top:10px;font-size:12px;color:var(--tx2)"><p>Follow the setup guide for your provider:</p><ul style="list-style:none;padding:0;margin:8px 0"><li style="margin:6px 0"><a href="https://code.claude.com/en/amazon-bedrock" style="color:var(--acc)" target="_blank">Amazon Bedrock setup guide →</a></li><li style="margin:6px 0"><a href="https://code.claude.com/en/google-vertex-ai" style="color:var(--acc)" target="_blank">Google Vertex AI setup guide →</a></li><li style="margin:6px 0"><a href="https://code.claude.com/en/microsoft-foundry" style="color:var(--acc)" target="_blank">Microsoft Foundry setup guide →</a></li></ul><button class="ccm-btn ccm-btn-secondary" id="ccmAuthSkip">I\'ve configured it externally → Continue</button></div>';
        form.querySelector('#ccmAuthSkip').onclick=async()=>{ccState=await window.api.detectClaudeCode();refreshBadge();if(ccState.installed){wizardStep=3;renderReadyStep()}else renderOverview()};
      } else if(method==='custom'){
        form.innerHTML=`<div style="margin-top:10px"><div style="margin-bottom:8px"><div style="font-size:10px;color:var(--tx2);text-transform:uppercase;margin-bottom:3px">Base URL (ANTHROPIC_BASE_URL)</div><input type="text" class="ccm-editor-area" style="min-height:auto;height:32px;padding:6px 10px" id="ccmBaseUrl" placeholder="https://api.example.com" value=""></div><div style="margin-bottom:8px"><div style="font-size:10px;color:var(--tx2);text-transform:uppercase;margin-bottom:3px">Auth Token (ANTHROPIC_AUTH_TOKEN)</div><div style="display:flex;gap:6px"><input type="password" class="ccm-editor-area" style="min-height:auto;height:32px;padding:6px 10px;flex:1" id="ccmAuthToken" placeholder="sk-..."><button class="ccm-btn ccm-btn-secondary" style="padding:4px 8px;font-size:10px" id="ccmTogglePw">👁</button></div></div><div style="display:flex;gap:8px;margin-top:10px"><button class="ccm-btn ccm-btn-secondary" id="ccmTestConn">Test Connection</button><button class="ccm-btn ccm-btn-primary" id="ccmApplyCustom">Apply & Continue</button></div><div id="ccmCustomStatus" style="font-size:11px;margin-top:6px"></div><div style="font-size:9px;color:var(--tx3);margin-top:4px">Sets ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json</div></div>`;
        // Pre-fill from existing settings
        (async()=>{
          try{const s=await window.api.readClaudeSettings({scope:'global'});const j=JSON.parse(s.content);if(j.env){if(j.env.ANTHROPIC_BASE_URL)form.querySelector('#ccmBaseUrl').value=j.env.ANTHROPIC_BASE_URL;if(j.env.ANTHROPIC_AUTH_TOKEN)form.querySelector('#ccmAuthToken').value=j.env.ANTHROPIC_AUTH_TOKEN}}catch{}
        })();
        form.querySelector('#ccmTogglePw').onclick=()=>{const inp=form.querySelector('#ccmAuthToken');inp.type=inp.type==='password'?'text':'password'};
        form.querySelector('#ccmTestConn').onclick=async()=>{
          const status=form.querySelector('#ccmCustomStatus');
          status.style.color='var(--ylw)';status.textContent='Testing...';
          const r=await window.api.testCustomProvider({baseUrl:form.querySelector('#ccmBaseUrl').value,authToken:form.querySelector('#ccmAuthToken').value});
          if(r.ok){status.style.color='var(--grn)';status.textContent='✓ Connection successful!'}
          else{status.style.color='var(--red)';status.textContent='✗ '+(r.error||'Failed')}
        };
        form.querySelector('#ccmApplyCustom').onclick=async()=>{
          const status=form.querySelector('#ccmCustomStatus');
          const r=await window.api.saveCustomProvider({baseUrl:form.querySelector('#ccmBaseUrl').value,authToken:form.querySelector('#ccmAuthToken').value});
          if(r.ok){status.style.color='var(--grn)';status.textContent='✓ Saved!';ccState=await window.api.detectClaudeCode();refreshBadge();setTimeout(()=>{if(ccState.installed){wizardStep=3;renderReadyStep()}else renderOverview()},800)}
          else{status.style.color='var(--red)';status.textContent='✗ '+(r.error||'Failed')}
        };
      }
    });
  }

  function renderReadyStep(){
    body.innerHTML=`
      <div class="ccm-step"><div class="ccm-step-num done">✓</div><div class="ccm-step-body"><span style="color:var(--grn);font-weight:500">Claude Code installed</span></div></div>
      <div style="border-top:1px solid var(--bg3);margin:4px 0 12px 38px"></div>
      <div class="ccm-step"><div class="ccm-step-num done">✓</div><div class="ccm-step-body"><span style="color:var(--grn);font-weight:500">Authenticated</span></div></div>
      <div style="border-top:1px solid var(--bg3);margin:4px 0 12px 38px"></div>
      <div style="text-align:center;padding:20px 0">
        <div style="font-size:32px;margin-bottom:8px">🎉</div>
        <div style="font-size:16px;color:var(--grn);font-weight:600">Claude Code is Ready!</div>
        <div style="font-size:11px;color:var(--tx2);margin-top:4px">All checks passed. You can start sessions now.</div>
        <button class="ccm-btn ccm-btn-primary" style="margin-top:16px" onclick="document.querySelector('#ccmClose').click()">Close</button>
      </div>
    `;
    // Enable all tabs now
    ccState.installed=true;
    updateTabs();refreshBadge();
  }

  // ── Settings Editor Tab ───────────────────────
  let editorScope='global';
  async function renderSettingsEditor(){
    const tabId=activeTabId;
    const ts=tabs.get(tabId);
    const projectDir=ts&&ts.projectDir?ts.projectDir:null;

    body.innerHTML=`
      <div class="ccm-editor-toolbar">
        <div style="display:flex;align-items:center">
          <div class="ccm-scope-toggle" id="ccmScopeToggle">
            <button class="ccm-scope-btn active" data-scope="global">Global</button>
            <button class="ccm-scope-btn" data-scope="project">Project</button>
          </div>
          <span class="ccm-editor-path" id="ccmEditorPath"></span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="ccm-json-status valid" id="ccmJsonStatus">● Valid JSON</span>
          <button class="ccm-btn ccm-btn-secondary" style="padding:4px 10px;font-size:10px" id="ccmFormat">Format</button>
          <button class="ccm-btn ccm-btn-primary" style="padding:4px 12px;font-size:10px" id="ccmSave">Save</button>
        </div>
      </div>
      <textarea class="ccm-editor-area" id="ccmEditor" spellcheck="false"></textarea>
      <div class="ccm-editor-status"><span id="ccmEditorInfo">JSON · UTF-8</span><span id="ccmEditorPos"></span></div>
    `;

    const editor=body.querySelector('#ccmEditor');
    const pathEl=body.querySelector('#ccmEditorPath');
    const statusEl=body.querySelector('#ccmJsonStatus');

    async function loadEditor(scope){
      editorScope=scope;
      body.querySelectorAll('.ccm-scope-btn').forEach(b=>b.classList.remove('active'));
      body.querySelector(`.ccm-scope-btn[data-scope="${scope}"]`).classList.add('active');
      const r=await window.api.readClaudeSettings({scope,projectDir});
      editor.value=r.content;
      pathEl.textContent=r.path;
      validateJson();
    }

    function validateJson(){
      try{JSON.parse(editor.value);statusEl.textContent='● Valid JSON';statusEl.className='ccm-json-status valid';body.querySelector('#ccmSave').disabled=false}
      catch(e){statusEl.textContent='● Invalid JSON';statusEl.className='ccm-json-status invalid';body.querySelector('#ccmSave').disabled=true}
    }

    editor.addEventListener('input',validateJson);
    editor.addEventListener('keydown',e=>{
      if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();body.querySelector('#ccmSave').click()}
      // Tab inserts 2 spaces
      if(e.key==='Tab'){e.preventDefault();const s=editor.selectionStart,end=editor.selectionEnd;editor.value=editor.value.substring(0,s)+'  '+editor.value.substring(end);editor.selectionStart=editor.selectionEnd=s+2;validateJson()}
    });

    body.querySelector('#ccmScopeToggle').addEventListener('click',e=>{
      const btn=e.target.closest('.ccm-scope-btn');if(!btn)return;
      loadEditor(btn.dataset.scope);
    });

    body.querySelector('#ccmFormat').onclick=()=>{
      try{editor.value=JSON.stringify(JSON.parse(editor.value),null,2);validateJson()}catch{}
    };

    body.querySelector('#ccmSave').onclick=async()=>{
      const r=await window.api.writeClaudeSettings({scope:editorScope,projectDir,content:editor.value});
      if(r.ok){statusEl.textContent='● Saved ✓';statusEl.style.color='var(--grn)';setTimeout(validateJson,1500)}
      else{statusEl.textContent='● Error: '+(r.error||'');statusEl.style.color='var(--red)'}
    };

    loadEditor(editorScope);
  }

  // ── Plugins Tab ───────────────────────────────
  let pluginView='installed';
  async function renderPlugins(){
    const data=await window.api.listClaudePlugins();
    const installed=data.installed||[];
    const colors=['#238636','#8957e5','#d29922','#58a6ff','#f85149','#3fb950','#a5a3ff','#ff7b72'];
    const icons=['⚡','🎨','🔧','💎','🦀','📡','🐳','🔌'];

    body.innerHTML=`
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="ccm-plugin-tabs">
          <button class="ccm-plugin-tab${pluginView==='installed'?' active':''}" data-view="installed">Installed (${installed.length})</button>
          <button class="ccm-plugin-tab${pluginView==='browse'?' active':''}" data-view="browse">Browse</button>
        </div>
        <input class="ccm-plugin-search" placeholder="Search plugins..." id="ccmPluginSearch">
      </div>
      <div id="ccmPluginList"></div>
    `;

    const list=body.querySelector('#ccmPluginList');
    const search=body.querySelector('#ccmPluginSearch');

    body.querySelector('.ccm-plugin-tabs').addEventListener('click',e=>{
      const tab=e.target.closest('.ccm-plugin-tab');if(!tab)return;
      pluginView=tab.dataset.view;
      body.querySelectorAll('.ccm-plugin-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      renderList();
    });

    search.addEventListener('input',()=>renderList());

    function renderList(){
      const q=(search.value||'').toLowerCase();
      if(pluginView==='installed'){
        const filtered=installed.filter(p=>!q||p.name.toLowerCase().includes(q)||(p.description||'').toLowerCase().includes(q));
        if(!filtered.length){list.innerHTML='<div style="text-align:center;color:var(--tx2);padding:20px;font-size:12px">No plugins found</div>';return}
        list.innerHTML=filtered.map((p,i)=>`
          <div class="ccm-plugin-row">
            <div class="ccm-plugin-icon" style="background:${colors[i%colors.length]}">${icons[i%icons.length]}</div>
            <div class="ccm-plugin-info">
              <div><span class="ccm-plugin-name">${esc(p.name)}</span><span class="ccm-plugin-source${p.community?' community':''}">${esc(p.source)}</span>${p.version?'<span style="font-size:9px;color:var(--grn);margin-left:4px">v'+esc(p.version)+'</span>':''}</div>
              <div class="ccm-plugin-desc">${esc(p.description||'No description')}</div>
            </div>
            <button class="ccm-toggle ${p.enabled?'on':'off'}" data-plugin="${esc(p.key)}" title="${p.enabled?'Disable':'Enable'}"></button>
          </div>
        `).join('');
        list.querySelectorAll('.ccm-toggle').forEach(btn=>{
          btn.onclick=async()=>{
            const key=btn.dataset.plugin;
            const nowOn=btn.classList.contains('on');
            btn.classList.toggle('on');btn.classList.toggle('off');
            await window.api.toggleClaudePlugin({pluginKey:key,enabled:!nowOn});
          };
        });
      } else {
        // Browse view
        list.innerHTML=`
          <div class="ccm-add-repo" id="ccmAddRepo"><span style="font-size:18px;color:var(--acc)">+</span><div><div style="font-size:12px;color:var(--acc);font-weight:500">Add from GitHub Repository</div><div style="font-size:10px;color:var(--tx2)">Enter owner/repo to install a community plugin</div></div></div>
          <div id="ccmAddRepoForm" style="display:none;margin-bottom:12px">
            <div style="display:flex;gap:6px"><input class="ccm-plugin-search" style="flex:1" placeholder="owner/repo" id="ccmRepoInput"><button class="ccm-btn ccm-btn-primary" style="padding:4px 12px;font-size:10px" id="ccmRepoInstall">Install</button></div>
            <div id="ccmRepoStatus" style="font-size:11px;margin-top:4px"></div>
          </div>
          <div style="color:var(--tx2);font-size:12px;text-align:center;padding:20px">
            Plugin browsing shows installed plugins.<br>Use "Add from GitHub Repository" to install community plugins.
          </div>
        `;
        body.querySelector('#ccmAddRepo').onclick=()=>{
          body.querySelector('#ccmAddRepoForm').style.display='block';
          body.querySelector('#ccmAddRepo').style.display='none';
        };
        const installBtn=body.querySelector('#ccmRepoInstall');
        if(installBtn)installBtn.onclick=async()=>{
          const repo=body.querySelector('#ccmRepoInput').value.trim();
          const status=body.querySelector('#ccmRepoStatus');
          if(!repo||!repo.includes('/')){status.style.color='var(--red)';status.textContent='Enter owner/repo format';return}
          status.style.color='var(--ylw)';status.textContent='Installing...';
          const r=await window.api.installClaudePlugin({source:'github',repo});
          if(r.ok){status.style.color='var(--grn)';status.textContent='✓ Installed!';setTimeout(()=>renderPlugins(),1000)}
          else{status.style.color='var(--red)';status.textContent='✗ '+(r.error||'Failed')}
        };
      }
    }
    renderList();
  }
})();
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: implement Claude Code Manager modal with Overview, Settings Editor, and Plugins tabs"
```

---

### Task 10: Final Integration & Smoke Test

**Files:** None (testing only)

- [ ] **Step 1: Start the app and verify badge appears**

```bash
cd D:\work\projects\sources\FreeLance\RalphClaude
npm start
```

Expected: Green badge "Claude Code v{version}" appears next to "AUTO CLAUDE" in the topbar.

- [ ] **Step 2: Click badge — verify modal opens with Overview tab**

Expected: Modal opens, shows Status (Installed), Version, Path, Auth info with your custom provider (api.gameron.me).

- [ ] **Step 3: Switch to Settings.json tab**

Expected: Shows Global/Project toggle, textarea with your settings.json content, JSON validation shows "Valid JSON". Click Format to pretty-print. Click Save to write back.

- [ ] **Step 4: Switch to Plugins tab**

Expected: Shows 5 installed plugins (superpowers, frontend-design, chrome-devtools-mcp, ui-ux-pro-max, rust-analyzer-lsp) with toggles. ui-ux-pro-max has orange "community" badge.

- [ ] **Step 5: Test plugin toggle**

Expected: Toggle a plugin off, then check ~/.claude/settings.json — the plugin should show `false` in `enabledPlugins`.

- [ ] **Step 6: Test "Add from GitHub Repository" in Browse tab**

Expected: Enter a fake `test/test-plugin`, click Install, see it added to settings.json.

- [ ] **Step 7: Close modal with X button and Escape key**

Expected: Both work. Modal closes, overlay disappears.

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "feat: Claude Code Manager — detection badge, settings editor, plugin management"
```

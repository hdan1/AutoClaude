const { app, BrowserWindow, ipcMain, Notification, dialog, shell, powerSaveBlocker, Menu, Tray } = require('electron');
const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ClaudeProxy = require('./proxy');
const SessionManager = require('./session-manager');
const logger = require('./lib/logger');
const { validateProjectDir, validatePrompt, validateConfig, validateMasterTelegramConfig, validateDistinctTelegramTokens, validateProjectTelegramConfig, validateProjectTokenDistinct, validateResponse } = require('./lib/validate');
const { listSessions } = require('./lib/sessions');
const { QUESTION_PATTERNS, IPC_BATCH_INTERVAL_MS, IPC_BATCH_CHANNELS, SUPERPOWERS_DEFAULTS } = require('./lib/constants');
const TelegramBridge = require('./lib/telegram');
const MasterTelegramBridge = require('./lib/master-telegram');
const { WorkflowManager } = require('./lib/workflow-detector');
const GsdDetector = require('./lib/gsd-detector');
const SuperpowersDetector = require('./lib/superpowers-detector');
const claudeDetector = require('./lib/claude-detector');
const { withTrustedIpc } = require('./lib/ipc-trust');
const claudeInstaller = require('./lib/claude-installer');
const {
  computeHealthStatus,
  resolveTrayIconPath,
  getAppLogFilePath,
  shouldHideWindowToTray,
  shouldKeepAppAliveWithoutWindows,
  evaluateToolInstallResult,
  parseInstallCommand,
  isTrustedIpcSender,
  applyCustomProviderToSettings,
  enrichDetectionWithCustomProviderSecret,
} = require('./lib/runtime-utils');
const {
  saveToken,
  loadToken,
  deleteToken,
  saveMasterTelegramToken,
  loadMasterTelegramToken,
  clearMasterTelegramToken,
  saveProjectToken,
  loadProjectToken,
  clearProjectToken,
  saveCustomProviderToken,
  loadCustomProviderToken,
  clearCustomProviderToken,
  isEncryptionAvailable,
} = require('./lib/telegram-secure');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ── Single Instance Lock ─────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus the existing window when a second instance is launched
    if (mainWindow) {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── Sleep Prevention ─────────────────────────────
let sleepBlockerId = null;

function acquireSleepLock() {
  if (sleepBlockerId !== null) return;
  if (!config.system?.preventSleep) return;
  sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  logger.info('app', 'Sleep prevention activated');
  send('sleep-status', { active: true });
}

function releaseSleepLock() {
  if (sleepBlockerId === null) return;
  const running = Array.from(sessionManager.sessions.values()).filter(s => s.state.running).length;
  if (running > 0) return;
  powerSaveBlocker.stop(sleepBlockerId);
  sleepBlockerId = null;
  logger.info('app', 'Sleep prevention released');
  send('sleep-status', { active: false });
}

// ── Config (SQLite-backed) ───────────────────────
const settingsDb = require('./settings-db');
const CONFIG_PATH = path.join(__dirname, 'config.json');  // kept for migration detection
let config = {}; // populated after settingsDb.init()

function saveConfig(c) {
  // Sync the in-memory config object back to SQLite
  settingsDb.syncFromConfigObject(c);
}


// Initialize logger with persistent user-level log file
const APP_LOG_FILE = getAppLogFilePath(app.getPath('userData'));
logger.setLogFile(APP_LOG_FILE);


// ── PID Tracking (R1: in-memory map, debounced flush) ────────
const activePids = new Map(); // tabId -> pid
let pidFlushTimer = null;
let PID_FILE = null;

function getPidFile() {
  if (!PID_FILE) PID_FILE = path.join(app.getPath('userData'), 'auto-claude-pids.json');
  return PID_FILE;
}

function _flushPids() {
  try {
    const obj = {};
    for (const [tabId, pid] of activePids) obj[tabId] = pid;
    fs.writeFileSync(getPidFile(), JSON.stringify(obj), 'utf8');
  } catch (e) { logger.debug('pid-tracking', `flush failed: ${e.message}`); }
}

function _schedulePidFlush() {
  if (pidFlushTimer) return;
  pidFlushTimer = setTimeout(() => {
    pidFlushTimer = null;
    _flushPids();
  }, 500);
}

function trackPid(tabId, pid) {
  activePids.set(tabId, pid);
  _schedulePidFlush();
}

function untrackPid(tabId) {
  activePids.delete(tabId);
  _schedulePidFlush();
}

function killOrphans() {
  try {
    const pids = JSON.parse(fs.readFileSync(getPidFile(), 'utf8'));
    for (const [tabId, pid] of Object.entries(pids)) {
      try {
        if (process.platform === 'win32') {
          require('child_process').execFileSync('taskkill', ['/T', '/PID', String(pid), '/F'],
            { stdio: 'ignore', timeout: 3000, windowsHide: true });
        } else {
          process.kill(pid, 'SIGTERM');
        }
      } catch { /* already dead - expected */ }
    }
    fs.unlinkSync(getPidFile());
  } catch { /* no pid file or parse error - normal on first run */ }
}

// ── SessionManager ───────────────────────────────
function send(ch, d) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, d); }

function rejectUntrustedIpc(event, action) {
  if (isTrustedIpcSender(event, mainWindow)) return null;
  logger.warn('ipc-security', `Blocked untrusted IPC sender for ${action}`);
  return { ok: false, error: 'Untrusted IPC sender' };
}

function isTrustedIpcEvent(event, action) {
  const rejection = rejectUntrustedIpc(event, action);
  return !rejection;
}

const trustDeps = { isTrusted: isTrustedIpcEvent };

// ── IPC Batching ─────────────────────────────────
const BATCH_SET = new Set(IPC_BATCH_CHANNELS);
let ipcBatch = [];
let ipcFlushTimer = null;

function sendToTab(tabId, ch, d) {
  const payload = { tabId, ...d };
  if (BATCH_SET.has(ch)) {
    ipcBatch.push({ ch, ...payload });
    if (!ipcFlushTimer) {
      ipcFlushTimer = setTimeout(flushIpcBatch, IPC_BATCH_INTERVAL_MS);
    }
  } else {
    send(ch, payload);
  }
}
function flushIpcBatch() {
  ipcFlushTimer = null;
  if (!ipcBatch.length) return;
  send('batch', ipcBatch);
  ipcBatch = [];
}
let workflowManager = null;
let sessionManager = null;
const projectTelegramBots = new Map();  // projectDir -> TelegramBridge
let masterTelegram = null;

function getProjectBot(projectDir) {
  if (!projectDir) return null;
  return projectTelegramBots.get(path.resolve(projectDir)) || null;
}

async function startProjectBot(projectDir) {
  if (!projectDir) { logger.info('tg-debug', 'startProjectBot: no projectDir'); return null; }
  const resolved = path.resolve(projectDir);
  const existing = projectTelegramBots.get(resolved);
  if (existing?.isRunning) { logger.info('tg-debug', 'startProjectBot: existing bot running, chatIds: ' + existing.chatIds.size); return existing; }
  const ptConfig = config.projectTelegram?.[resolved];
  if (!ptConfig?.enabled) { logger.info('tg-debug', 'startProjectBot: not enabled for ' + path.basename(resolved) + ', keys: ' + Object.keys(config.projectTelegram || {}).join(',')); return null; }
  const token = loadProjectToken(app.getPath('userData'), resolved);
  if (!token) { logger.info('telegram', `No saved token for project: ${path.basename(resolved)}`); return null; }
  // Prevent duplicate token conflict with master bot
  const masterToken = loadMasterTelegramToken(app.getPath('userData'));
  if (masterToken && token === masterToken) {
    logger.warn('telegram', `Project bot token is the same as master bot token for ${path.basename(resolved)} — skipping to avoid 409 conflict`);
    return null;
  }
  if (existing) { await existing.stop(); }
  const bridge = new TelegramBridge(config, sessionManager, resolved);
  await bridge.start(token, ptConfig.allowedUsers || []);
  projectTelegramBots.set(resolved, bridge);
  return bridge;
}

async function stopProjectBot(projectDir) {
  if (!projectDir) return;
  const resolved = path.resolve(projectDir);
  const bot = projectTelegramBots.get(resolved);
  if (bot) { await bot.stop(); projectTelegramBots.delete(resolved); }
}

async function stopAllProjectBots() {
  for (const [, bot] of projectTelegramBots) { await bot.stop(); }
  projectTelegramBots.clear();
}

function _wireSessionManagerEvents() {
  sessionManager.on('save-config', () => { saveConfig(config); });
  sessionManager.on('get-logs', ({ tabId, count, callback }) => {
    try {
      const projectDir = sessionManager.getState(tabId)?.projectDir;
      if (!projectDir) { callback([]); return; }
      const logFile = path.join(projectDir, '.planning', 'auto-claude-hooks.jsonl');
      if (!fs.existsSync(logFile)) { callback(['No log file found.']); return; }
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-count);
      callback(lines);
    } catch { callback(['Error reading logs.']); }
  });
  sessionManager.on('notify', ({ type, title, body }) => {
    const n = config.notifications || {};
    if (type === 'question' && n.onQuestion === false) return;
    if (type === 'complete' && n.onComplete === false) return;
    if (type === 'error' && n.onError === false) return;
    notify(title, body);
  });
  sessionManager.on('reinstall-hooks', (projectDir) => { installHooks(projectDir); });
  sessionManager.on('save-status', (tabId) => {
    const s = sessionManager.getState(tabId);
    if (!s) return;
    saveStatusJson(s);
  });
  sessionManager.on('question', ({ tabId, questionData }) => {
    const state = sessionManager.getState(tabId) || {};
    const bot = getProjectBot(state.projectDir);
    logger.info('question-event', `tabId=${tabId} projectDir=${state.projectDir || '(none)'} projectBot=${!!bot} projectBotRunning=${bot?.isRunning} masterBot=${!!masterTelegram} masterBotRunning=${masterTelegram?.isRunning} questionText="${(questionData?.questionText || '').substring(0, 50)}"`);
    if (bot?.isRunning) { bot.forwardQuestion(tabId, questionData); }
    if (masterTelegram?.isRunning) {
      masterTelegram.forwardQuestion({ tabId, projectDir: state.projectDir, state }, questionData);
    }
  });
  sessionManager.on('output', ({ tabId, text }) => {
    const state = sessionManager.getState(tabId) || {};
    const bot = getProjectBot(state.projectDir);
    if (bot?.isRunning) { bot.broadcast(`[${tabId}] ${text}`); }
  });
  sessionManager.on('pid-tracked', ({ tabId, pid }) => { trackPid(tabId, pid); });
  sessionManager.on('session-init', ({ tabId, sessionId }) => {
    if (!sessionId) return;
    const session = sessionManager.get(tabId);
    if (!session?.state.projectDir) return;
    settingsDb.setSession(session.state.projectDir, sessionId);
    config.sessions = settingsDb.getAllSessions();
  });
  sessionManager.on('session-complete', ({ tabId }) => {
    untrackPid(tabId);
    releaseSleepLock();
    const s = sessionManager.getState(tabId);
    const bot = getProjectBot(s?.projectDir);
    if (bot?.isRunning) {
      bot.broadcastDirect(`[${tabId}] Session complete. Tokens: ${s?.totalInputTokens || 0}in / ${s?.totalOutputTokens || 0}out`);
    }
  });
  sessionManager.on('session-complete', () => {
    setTimeout(processBatchQueue, 2000);
  });
}

// ── Batch Queue Runner ─────────────────────────────
let batchProcessing = false;
function processBatchQueue() {
  if (batchProcessing) return;
  if (!sessionManager) return;
  if (!config.batch?.enabled || !config.batch.queue?.length) return;

  const running = Array.from(sessionManager.sessions.values()).filter(s => s.state.running).length;
  const limit = config.batch.mode === 'parallel' ? (config.batch.parallelLimit || 2) : 1;
  if (running >= limit) return;

  batchProcessing = true;
  const item = config.batch.queue.shift();
  if (!item) { batchProcessing = false; return; }
  saveConfig(config);
  batchProcessing = false;

  const projectPath = path.join(config.workspaceRoot || '', item.project);
  if (!fs.existsSync(projectPath)) {
    logger.warn('batch', `Skipping queue item: project not found: ${item.project}`);
    const batchBot = getProjectBot(projectPath);
    if (batchBot?.isRunning) {
      batchBot.broadcastDirect(`\u26a0 Batch: project not found: ${item.project}`);
    }
    processBatchQueue();
    return;
  }

  const tabId = `batch-${Date.now()}-${item.project.substring(0, 8)}`;
  sessionManager.create(tabId, projectPath);
  send('master-workspace-open', { tabId, projectName: item.project, projectPath });
  setTimeout(() => {
    sessionManager.start(tabId, item.prompt);
    const batchBot2 = getProjectBot(projectPath);
    if (batchBot2?.isRunning) {
      batchBot2.broadcastDirect(`\u25b6 Batch started: ${item.project} \u2192 ${item.prompt.substring(0, 80)}`);
    }
  }, 500);
}

// ── Window ────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Remove default menu bar (File, Edit, View, etc.)
  Menu.setApplicationMenu(null);
  mainWindow.loadFile('index.html');
  const appVersion = require('./package.json').version;
  mainWindow.setTitle(`Auto Claude v${appVersion}`);

  // ── System Tray ──────────────────────────────────
  const trayIconPath = resolveTrayIconPath({
    platform: process.platform,
    appDir: __dirname,
    resourcesPath: process.resourcesPath,
    exePath: app.getPath('exe'),
    existsSync: fs.existsSync,
  });

  tray = null;
  if (trayIconPath) {
    try {
      tray = new Tray(trayIconPath);
      logger.info('tray', `Using tray icon: ${trayIconPath}`);
    } catch (err) {
      logger.warn('tray', `Tray icon failed (${trayIconPath}); close-to-tray disabled for this run`, err);
    }
  } else {
    logger.warn('tray', 'No tray icon file found; close-to-tray disabled for this run');
  }

  if (tray) {
    tray.setToolTip(`Auto Claude v${appVersion}`);
    const trayMenu = Menu.buildFromTemplate([
      { label: 'Show Auto Claude', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(trayMenu);
    tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
  }

  // ── Close to tray instead of quitting ────────────
  mainWindow.on('close', (e) => {
    if (shouldHideWindowToTray({ isQuitting, tray })) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}
// ── Health Check Helper ──────────────────────────
function readGlobalClaudeEnv() {
  try {
    const settingsData = claudeDetector.readSettingsJson('global');
    const parsed = JSON.parse(settingsData.content || '{}');
    const env = parsed?.env;
    return env && typeof env === 'object' ? env : {};
  } catch (err) {
    logger.warn('custom-provider', `Failed to read global Claude env: ${err?.message || err}`);
    return {};
  }
}

function syncCustomProviderRuntimeEnv() {
  const env = readGlobalClaudeEnv();
  const baseUrl = String(env.ANTHROPIC_BASE_URL || '');
  if (baseUrl) process.env.ANTHROPIC_BASE_URL = baseUrl;
  else delete process.env.ANTHROPIC_BASE_URL;

  let secureToken = null;
  try {
    secureToken = loadCustomProviderToken(app.getPath('userData'));
  } catch (err) {
    logger.warn('custom-provider', `Failed to load secure provider token: ${err?.message || err}`);
    secureToken = null;
  }

  if (secureToken) {
    process.env.ANTHROPIC_AUTH_TOKEN = secureToken;
  } else {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }

  return { baseUrl, hasSecureToken: !!secureToken };
}

async function detectClaudeStateWithSecureToken() {
  const detection = await claudeDetector.detect();
  const runtime = syncCustomProviderRuntimeEnv();

  return enrichDetectionWithCustomProviderSecret({
    detection,
    baseUrl: runtime.baseUrl,
    hasSecureToken: runtime.hasSecureToken,
  });
}

async function buildHealthStatus() {
  const detection = await detectClaudeStateWithSecureToken();
  const prerequisites = await claudeDetector.detectPrerequisites();
  const pluginData = detection.installed ? claudeDetector.listPlugins() : { installed: [] };

  let recommended = [];
  try {
    const raw = settingsDb.get('system.recommendedPlugins');
    recommended = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
  } catch { recommended = []; }

  // Fallback to built-in defaults if no recommended plugins saved
  if (recommended.length === 0) {
    recommended = claudeDetector.DEFAULT_RECOMMENDED_PLUGINS;
  }

  // Detect recommended tools (GSD, Context7, etc.)
  const recommendedTools = claudeDetector.detectRecommendedTools();

  // Augment installed plugins with detection from recommended plugins that have
  // detectMcp/detectPath (e.g., GSD installed as skills, Context7 as MCP server).
  // This ensures computeHealthStatus's matching logic can find them.
  const installedPlugins = [...pluginData.installed];
  const installedKeys = new Set(installedPlugins.map(p => (p.name || '').toLowerCase()));
  for (const rec of recommended) {
    const baseName = (rec.key || '').split('@')[0].toLowerCase();
    // Skip if already found by listPlugins
    if (installedKeys.has(baseName)) continue;
    if (installedPlugins.some(p => p.key && p.key.toLowerCase() === 'mcp:' + baseName)) continue;

    let detected = false;
    // Check detectPath (e.g., GSD skills directory)
    if (rec.detectPath) {
      const home = claudeDetector.getClaudeHome();
      if (rec.key && rec.key.startsWith('gsd')) {
        detected = claudeDetector.isGsdInstalledFromPaths(home);
      } else {
        const skillPath = path.join(home, rec.detectPath);
        detected = fs.existsSync(skillPath);
      }
    }
    // Check detectMcp (e.g., Context7 MCP server in settings)
    if (!detected && rec.detectMcp) {
      const mcpFiles = [
        path.join(claudeDetector.getClaudeHome(), 'settings.json'),
        path.join(os.homedir(), '.claude.json'),
      ];
      for (const mcpFile of mcpFiles) {
        try {
          const settings = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
          const mcpServers = settings.mcpServers || {};
          if (Object.keys(mcpServers).some(k => k.toLowerCase().includes(rec.detectMcp))) {
            detected = true;
            break;
          }
        } catch { /* file not found */ }
      }
    }
    if (detected) {
      installedPlugins.push({
        key: rec.key,
        name: baseName,
        source: rec.type === 'mcp' ? 'mcp-server' : 'skill',
        enabled: true,
        community: !rec.official,
        isMcp: rec.type === 'mcp',
        description: rec.type === 'mcp' ? 'MCP server' : 'Skill',
      });
    }
  }

  return computeHealthStatus({
    detection,
    prerequisites,
    recommendedPlugins: recommended,
    installedPlugins,
    recommendedTools,
  });
}

// ── Health Status Caching ───────────────────────────
let healthCache = null;
let healthCacheTime = 0;
const HEALTH_CACHE_TTL_MS = 30000;

async function buildHealthStatusCached() {
  const now = Date.now();
  if (healthCache && (now - healthCacheTime) < HEALTH_CACHE_TTL_MS) {
    return healthCache;
  }
  healthCache = await buildHealthStatus();
  healthCacheTime = now;
  return healthCache;
}

function invalidateHealthCache() {
  healthCache = null;
  healthCacheTime = 0;
}

app.whenReady().then(async () => {
  // Initialize SQLite settings DB
  const dbPath = path.join(app.getPath('userData'), 'auto-claude.db');
  await settingsDb.init(dbPath);

  // Migrate from config.json if DB was just created
  if (fs.existsSync(CONFIG_PATH)) {
    settingsDb.migrateFromJson(CONFIG_PATH);
  }

  // Build the in-memory config object for backward compat
  config = settingsDb.buildConfigObject(config);
  syncCustomProviderRuntimeEnv();

  // Prune stale sessions
  const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
  settingsDb.pruneSessionsOlderThan(STALE_SESSION_MS);
  config = settingsDb.buildConfigObject(config); // refresh after pruning

  // Create managers with populated config
  workflowManager = new WorkflowManager([
    new GsdDetector(),
    new SuperpowersDetector(config),
  ]);
  sessionManager = new SessionManager(config, sendToTab, workflowManager);
  _wireSessionManagerEvents();

  // Start batch queue runner
  setTimeout(processBatchQueue, 5000);

  killOrphans();
  createWindow();

  // ── Startup Health Check ──────────────────────────
  setTimeout(async () => {
    try {
      const status = await buildHealthStatusCached();
      if (!status.healthy) send('health-check', status);
    } catch (err) {
      logger.warn('startup', `Health check failed: ${err.message}`);
    }
  }, 2000);

  // ── Auto-Update (packaged builds only) ──────────
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('update-available', (info) => {
        logger.info('app', `Update available: v${info.version}`);
        send('update-status', { status: 'downloading', version: info.version });
      });
      autoUpdater.on('update-downloaded', (info) => {
        logger.info('app', `Update downloaded: v${info.version}`);
        send('update-status', { status: 'ready', version: info.version });
      });
      autoUpdater.on('error', (err) => {
        logger.info('app', `Auto-update error: ${err.message}`);
      });
      if (config.system?.autoUpdate !== false) {
        autoUpdater.checkForUpdatesAndNotify();
      }
    } catch (err) {
      logger.info('app', `Auto-updater not available: ${err.message}`);
    }
  }

  await _initMasterTelegram();

  // Auto-resume sessions that were running when app closed
  const AutonomyEngine = require('./lib/autonomy');
  const resumeEngine = new AutonomyEngine(config, null);
  const toResume = resumeEngine.getResumeState(config.sessions);
  if (toResume.length > 0) {
    logger.info('startup', `Auto-resuming ${toResume.length} session(s)`);
    for (const { tabId, projectDir, sessionId, lastPrompt } of toResume) {
      const session = sessionManager.create(tabId, projectDir);
      session.state.sessionId = sessionId;
      send('master-workspace-open', { tabId, projectName: path.basename(projectDir), projectPath: projectDir });
      // Start per-project bot if configured
      const bot = await startProjectBot(projectDir);
      if (bot) {
        sessionManager.setTelegram(tabId, bot);
        if (masterTelegram) bot.seedChatIds(masterTelegram.chatIds);
      }
      setTimeout(() => {
        sessionManager.start(tabId, lastPrompt || 'continue');
        acquireSleepLock();
      }, 1000);
    }
  }
});

async function _initMasterTelegram() {
  const masterConfig = config.masterTelegram;
  if (!masterConfig?.enabled) {
    if (masterTelegram) { await masterTelegram.stop(); masterTelegram = null; }
    return;
  }
  const masterToken = loadMasterTelegramToken(app.getPath('userData'));
  if (!masterToken) {
    logger.info('master-telegram', 'No saved master token found');
    if (masterTelegram) { await masterTelegram.stop(); masterTelegram = null; }
    return;
  }
  if (!masterTelegram) {
    masterTelegram = new MasterTelegramBridge(config, sessionManager, {
      openProject: _openWorkspaceProject,
      newProject: _createWorkspaceProject,
      closeProject: _closeWorkspaceProject,
      startProjectBot: async (projectPath, tabId) => {
        const bot = await startProjectBot(projectPath);
        if (bot && tabId) sessionManager.setTelegram(tabId, bot);
        if (bot && masterTelegram) bot.seedChatIds(masterTelegram.chatIds);
        return bot;
      },
    });
  }
  await masterTelegram.start(masterToken, masterConfig.allowedUsers || []);
}

function _resolveToken(candidate, fallback) {
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
}

function _slugifyProjectName(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 80) return '';
  if (trimmed.includes('/') || trimmed.includes('\\')) return '';
  const clean = trimmed.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('.')) return '';
  return clean;
}

function _resolveWorkspaceRoot() {
  const raw = typeof config.workspaceRoot === 'string' ? config.workspaceRoot.trim() : '';
  if (!raw) return { ok: false, error: 'Workspace root is not configured. Set workspace root in settings before using /open-project or /new-project.' };
  try {
    const stat = fs.statSync(raw);
    if (!stat.isDirectory()) return { ok: false, error: `Workspace root is not a directory: ${raw}` };
  } catch {
    return { ok: false, error: `Workspace root directory does not exist: ${raw}` };
  }
  return { ok: true, root: path.resolve(raw) };
}

function _resolveWorkspaceProject(projectName) {
  const name = _slugifyProjectName(projectName);
  if (!name) return { ok: false, error: 'Invalid project name. Use letters, numbers, dot, underscore, or dash only.' };
  const rootCheck = _resolveWorkspaceRoot();
  if (!rootCheck.ok) return rootCheck;
  const projectPath = path.resolve(rootCheck.root, name);
  const rel = path.relative(rootCheck.root, projectPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'Unsafe project path rejected (must stay within workspace root).' };
  }
  return { ok: true, root: rootCheck.root, name, projectPath };
}

function _getWorkspaceStatus() {
  const raw = typeof config.workspaceRoot === 'string' ? config.workspaceRoot.trim() : '';
  const rootConfigured = !!raw;
  let rootAccessible = false;
  if (rootConfigured) {
    try {
      const stat = fs.statSync(raw);
      rootAccessible = stat.isDirectory();
    } catch (err) { logger.debug('workspace', `Workspace root not accessible: ${err?.message || err}`); }
  }
  let gitAvailable = true;
  let gitError = '';
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
  } catch (err) {
    gitAvailable = false;
    gitError = err?.message || 'git not available on PATH';
  }
  return {
    workspaceRoot: raw,
    rootConfigured,
    rootAccessible,
    gitAvailable,
    gitError,
  };
}

function _isPathInWorkspaceRoot(candidatePath, workspaceRoot) {
  if (!candidatePath || !workspaceRoot) return false;
  const root = path.resolve(workspaceRoot);
  const full = path.resolve(candidatePath);
  const rel = path.relative(root, full);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function _newTabId() {
  return `tab-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
}

async function _openWorkspaceProject(projectName) {
  const resolved = _resolveWorkspaceProject(projectName);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const dirVal = validateProjectDir(resolved.projectPath);
  if (!dirVal.valid) return { ok: false, error: `Project not found in workspace: ${resolved.name}` };
  const tabId = _newTabId();
  sessionManager.create(tabId, dirVal.path);
  send('master-workspace-open', { tabId, projectDir: dirVal.path, projectName: resolved.name });
  return { ok: true, tabId, projectName: resolved.name, projectPath: dirVal.path };
}

async function _createWorkspaceProject(projectName) {
  const resolved = _resolveWorkspaceProject(projectName);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (fs.existsSync(resolved.projectPath)) return { ok: false, error: `Project already exists: ${resolved.name}` };
  try {
    fs.mkdirSync(resolved.projectPath, { recursive: false });
  } catch (err) {
    return { ok: false, error: `Failed to create project directory: ${err.message}` };
  }
  try {
    execFileSync('git', ['init'], { cwd: resolved.projectPath, stdio: 'pipe' });
  } catch (err) {
    try { fs.rmSync(resolved.projectPath, { recursive: true, force: true }); } catch (err) { logger.warn('workspace', `Failed to remove project dir: ${err?.message || err}`); }    return { ok: false, error: `git init failed for ${resolved.name}: ${err.message}` };
  }
  return _openWorkspaceProject(resolved.name);
}

async function _closeWorkspaceProject(tabId) {
  const session = sessionManager.get(tabId);
  if (session?.state.projectDir && session.state.hooksInstalled && config.hooks?.install) {
    uninstallHooks(session.state.projectDir);
    session.state.hooksInstalled = false;
  }
  const closed = await sessionManager.close(tabId);
  if (!closed?.ok) return closed || { ok: false, error: 'Close failed' };
  untrackPid(tabId);
  send('master-workspace-close', { tabId: closed.tabId });
  return { ok: true, tabId: closed.tabId, projectName: closed.projectName, projectPath: closed.projectPath };
}

// Clean up on all exit paths
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (ipcFlushTimer) { clearTimeout(ipcFlushTimer); ipcFlushTimer = null; }
  logger.info('app', 'Cleaning up...');
  stopAllProjectBots();
  if (masterTelegram) { masterTelegram.stop(); masterTelegram = null; }
  if (sessionManager) {
    sessionManager.stopAll();
    // Uninstall hooks for all sessions
    for (const [tabId, session] of sessionManager.sessions) {
      if (session.state.projectDir && session.state.hooksInstalled && config.hooks?.install) {
        uninstallHooks(session.state.projectDir);
        session.state.hooksInstalled = false;
      }
    }
  }
  settingsDb.close();
  if (sleepBlockerId !== null) { try { powerSaveBlocker.stop(sleepBlockerId); } catch { /* silent */ } sleepBlockerId = null; }
  try { fs.unlinkSync(getPidFile()); } catch { /* silent */ }
}

app.on('window-all-closed', () => {
  if (!shouldKeepAppAliveWithoutWindows({ tray })) {
    isQuitting = true;
    app.quit();
  }
});
app.on('before-quit', () => { isQuitting = true; cleanup(); });
process.on('exit', () => { settingsDb?.flushSync(); });
process.on('uncaughtException', (err) => {
  logger.error('app', 'Uncaught exception', err);
  cleanup();
});
process.on('unhandledRejection', (reason) => {
  logger.error('app', 'Unhandled rejection', reason);
});

// ── Helpers ───────────────────────────────────────
function notify(t, b) {
  try {
    if (Notification.isSupported()) new Notification({ title: t, body: b }).show();
  } catch (err) {
    logger.warn('notify', 'Notification failed', err);
  }
}

function detectQuestion(t) {
  return QUESTION_PATTERNS.some(p => p.test(t));
}

// ── Hook installation ─────────────────────────────
function installHooks(projectDir) {
  try {
    const installerPath = path.join(__dirname, 'install-hooks.js');
    // C2: Use execFileSync with arguments array to prevent injection
    execFileSync('node', [installerPath, projectDir], { stdio: 'pipe' });
    send('log', { type: 'system', text: '\u2713 Telemetry hooks installed (async \u2014 zero latency)' });
    return true;
  } catch (err) {
    logger.warn('hooks', 'Hook install warning', err);
    send('log', { type: 'stderr', text: `Hook install warning: ${err.message}` });
    return false;
  }
}

function uninstallHooks(projectDir) {
  try {
    const installerPath = path.join(__dirname, 'install-hooks.js');
    // C2: Use execFileSync with arguments array
    execFileSync('node', [installerPath, projectDir, '--uninstall'], { stdio: 'pipe' });
  } catch (err) {
    logger.warn('hooks', 'Hook uninstall error', err);
  }
}

function saveStatusJson(s) {
  try {
    const planDir = path.join(s.projectDir, '.planning');
    if (!fs.existsSync(planDir)) return;
    fs.writeFileSync(path.join(planDir, 'auto-claude-status.json'),
      JSON.stringify({
        state: s.running ? 'running' : 'stopped',
        step: s.currentStep, message: s.message,
        sessionId: s.sessionId,
        totalInputTokens: s.totalInputTokens, totalOutputTokens: s.totalOutputTokens,
        timestamp: new Date().toISOString(),
      }, null, 2), 'utf8');
  } catch (err) {
    logger.error('status', 'Failed to save status JSON', err);
  }
}

// ── IPC ───────────────────────────────────────────
ipcMain.handle('select-directory', async (event, opts = {}) => {
  if (!isTrustedIpcEvent(event, 'select-directory')) return null;
  const scoped = !!opts.workspaceOnly;
  const rootCheck = scoped ? _resolveWorkspaceRoot() : null;
  const enforceWorkspaceBoundary = scoped && rootCheck?.ok;

  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select Project Directory' });
  if (r.canceled || !r.filePaths.length) {
    return scoped ? { ok: true, canceled: true, path: null } : null;
  }

  const selected = r.filePaths[0];
  if (enforceWorkspaceBoundary && !_isPathInWorkspaceRoot(selected, rootCheck.root)) {
    return { ok: false, error: 'Selected folder is outside workspace root.', path: null };
  }

  return scoped ? { ok: true, path: selected } : selected;
});
ipcMain.handle('load-config', withTrustedIpc('load-config', (event) => {
  config = settingsDb.buildConfigObject(config);
  return config;
}, trustDeps));
ipcMain.handle('show-confirm-dialog', async (event, opts) => {
  if (!isTrustedIpcEvent(event, 'show-confirm-dialog')) return 1;
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: opts.title || 'Confirm',
    message: opts.message || '',
    buttons: opts.buttons || ['OK', 'Cancel'],
    defaultId: opts.defaultId ?? 1,
    cancelId: opts.buttons ? opts.buttons.length - 1 : 1,
  });
  return r.response;
});

ipcMain.on('restart-for-update', (event) => {
  if (!isTrustedIpcEvent(event, 'restart-for-update')) return;
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall();
  } catch (err) { logger.warn('updater', `Auto-update restart failed: ${err?.message || err}`); }
});

// ── Session IPC ───────────────────────────────────
ipcMain.handle('start-session', async (event, o) => {
  if (!isTrustedIpcEvent(event, 'start-session')) return;
  const tabId = o.tabId || 'default';
  const existing = sessionManager.get(tabId);
  if (existing?.state.running || existing?.state.starting) return;
  if (existing) existing.state.starting = true;

  const dirVal = validateProjectDir(o.projectDir);
  if (!dirVal.valid) { if (existing) existing.state.starting = false; sendToTab(tabId, 'error', { message: dirVal.error }); return; }
  const promptVal = validatePrompt(o.prompt);
  if (!promptVal.valid) { if (existing) existing.state.starting = false; sendToTab(tabId, 'error', { message: promptVal.error }); return; }

  saveConfig(config);

  // If an existing stopped session has a sessionId, continue it.
  // A new prompt continues the existing conversation (new turn).
  // o.sessionId is set when user has a session selected in the dropdown;
  // it's undefined when "New session" is selected (value="" → ||undefined).
  if (existing && existing.state.sessionId) {
    if (!o.sessionId) {
      // "New session" selected in dropdown → clear stale session, start fresh
      existing.state.sessionId = null;
    } else {
      // Session selected in dropdown → continue it (switch if different)
      if (o.sessionId !== existing.state.sessionId) {
        existing.state.sessionId = o.sessionId;
      }
      existing.state.running = false;
      existing.state.startTime = Date.now();
      // Wire up per-project telegram bot
      const existBot = await startProjectBot(dirVal.path);
      if (existBot) {
        sessionManager.setTelegram(tabId, existBot);
        if (masterTelegram) existBot.seedChatIds(masterTelegram.chatIds);
      }
      if (config.hooks?.install) {
        installHooks(dirVal.path);
        existing.state.hooksInstalled = true;
      }
      existing.state.starting = false;
      sessionManager.start(tabId, promptVal.prompt);
      acquireSleepLock();
      return;
    }
  }

  sessionManager.create(tabId, dirVal.path);
  const session = sessionManager.get(tabId);
  // Use dropdown sessionId if one was explicitly selected
  session.state.sessionId = o.sessionId || null;
  session.state.startTime = Date.now();

  // Wire up per-project telegram bot
  const bot = await startProjectBot(dirVal.path);
  if (bot) {
    sessionManager.setTelegram(tabId, bot);
    if (masterTelegram) bot.seedChatIds(masterTelegram.chatIds);
  }

  if (config.hooks?.install) {
    installHooks(dirVal.path);
    session.state.hooksInstalled = true;
  }
  session.state.starting = false;
  sessionManager.start(tabId, promptVal.prompt);
  acquireSleepLock();
});

ipcMain.handle('stop-session', async (event, data) => {
  if (!isTrustedIpcEvent(event, 'stop-session')) return { ok: false, error: 'Untrusted IPC sender' };
  const tabId = data?.tabId || 'default';
  const session = sessionManager.get(tabId);
  if (session?.state.projectDir && session.state.hooksInstalled && config.hooks?.install) {
    uninstallHooks(session.state.projectDir);
    session.state.hooksInstalled = false;
  }
  await sessionManager.stop(tabId);
  // Preserve session (with sessionId) so next start continues it
  untrackPid(tabId);
  releaseSleepLock();
  return { ok: true };
});

ipcMain.handle('list-workspace-projects', async (event) => {
  if (!isTrustedIpcEvent(event, 'list-workspace-projects')) return { ok: false, error: 'Untrusted IPC sender', projects: [] };
  const rootCheck = _resolveWorkspaceRoot();
  if (!rootCheck.ok) return { ok: false, error: rootCheck.error, projects: [] };
  let entries = [];
  try {
    entries = fs.readdirSync(rootCheck.root, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: `Failed to read workspace root: ${err.message}`, projects: [] };
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry || !entry.isDirectory || !entry.isDirectory()) continue;
    const name = entry.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const projectPath = path.resolve(rootCheck.root, name);
    const rel = path.relative(rootCheck.root, projectPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    projects.push({ name, path: projectPath });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, error: '', projects };
});

ipcMain.handle('get-workspace-status', async (event) => {
  if (!isTrustedIpcEvent(event, 'get-workspace-status')) return { ok: false, error: 'Untrusted IPC sender' };
  return _getWorkspaceStatus();
});

ipcMain.handle('open-workspace-project', async (event, projectName) => {
  if (!isTrustedIpcEvent(event, 'open-workspace-project')) return { ok: false, error: 'Untrusted IPC sender' };
  const result = await _openWorkspaceProject(projectName);
  return result;
});

ipcMain.handle('new-workspace-project', async (event, projectName) => {
  if (!isTrustedIpcEvent(event, 'new-workspace-project')) return { ok: false, error: 'Untrusted IPC sender' };
  const result = await _createWorkspaceProject(projectName);
  return result;
});

ipcMain.handle('close-workspace-project', async (event, tabId) => {
  if (!isTrustedIpcEvent(event, 'close-workspace-project')) return { ok: false, error: 'Untrusted IPC sender' };
  const result = await _closeWorkspaceProject(tabId);
  return result;
});

ipcMain.handle('create-project-folder', async (event, projectName) => {
  if (!isTrustedIpcEvent(event, 'create-project-folder')) return { ok: false, error: 'Untrusted IPC sender' };
  const resolved = _resolveWorkspaceProject(projectName);
  if (!resolved.ok) return resolved;
  if (fs.existsSync(resolved.projectPath)) return { ok: false, error: `Project already exists: ${resolved.name}` };
  try { fs.mkdirSync(resolved.projectPath, { recursive: false }); } catch (err) {
    return { ok: false, error: `Failed to create directory: ${err.message}` };
  }
  try { execFileSync('git', ['init'], { cwd: resolved.projectPath, stdio: 'pipe' }); } catch (err) {
    try { fs.rmSync(resolved.projectPath, { recursive: true, force: true }); } catch (err) { logger.warn('workspace', `Failed to remove project dir: ${err?.message || err}`); }    return { ok: false, error: `git init failed: ${err.message}` };
  }
  return { ok: true, projectPath: resolved.projectPath, name: resolved.name };
});

ipcMain.handle('list-sessions', (event, projectDir) => {
  if (!isTrustedIpcEvent(event, 'list-sessions')) return [];
  const dir = projectDir;
  if (!dir) return [];
  return listSessions(dir);
});

ipcMain.handle('get-stored-session', async (event, projectDir) => {
  if (!isTrustedIpcEvent(event, 'get-stored-session')) return null;
  if (!projectDir) return null;
  const entry = settingsDb.getSession(projectDir);
  if (!entry) return null;
  const sessions = listSessions(projectDir);
  const valid = sessions.some(s => s.sessionId === entry.sessionId);
  if (!valid) {
    settingsDb.deleteSession(projectDir);
    return { sessionId: entry.sessionId, valid: false };
  }
  const STALE_MS = 7 * 24 * 60 * 60 * 1000;
  const age = Date.now() - entry.timestamp;
  if (age > STALE_MS) {
    settingsDb.deleteSession(projectDir);
    return null;
  }
  return { sessionId: entry.sessionId, timestamp: entry.timestamp, valid: true };
});

ipcMain.handle('clear-stored-session', async (event, projectDir) => {
  if (!isTrustedIpcEvent(event, 'clear-stored-session')) return { ok: false, error: 'Untrusted IPC sender' };
  if (!projectDir) return { ok: true };
  settingsDb.deleteSession(projectDir);
  config.sessions = settingsDb.getAllSessions();
  return { ok: true };
});

// ── Config & Response IPC ─────────────────────────
ipcMain.on('save-config', (event, c) => {
  if (!isTrustedIpcEvent(event, 'save-config')) return;
  const result = validateConfig(c);
  if (!result.valid) {
    logger.warn('ipc.save-config', 'Invalid config rejected', result.error);
    send('log', { type: 'stderr', text: `Config validation error: ${result.error}` });
    return;
  }
  config = { ...config, ...result.config };
  saveConfig(config);
});

// ── Settings DB IPC ──────────────────────────────
ipcMain.handle('get-setting', withTrustedIpc('get-setting', (event, key) => {
  return settingsDb.get(key);
}, trustDeps));

ipcMain.handle('set-setting', (event, { key, value }) => {
  if (!isTrustedIpcEvent(event, 'set-setting')) return { ok: false, error: 'Untrusted IPC sender' };
  settingsDb.set(key, value);
  config = settingsDb.buildConfigObject(config);
  return { ok: true };
});

ipcMain.handle('get-settings-group', withTrustedIpc('get-settings-group', (event, category) => {
  return settingsDb.getGroup(category);
}, trustDeps));

ipcMain.handle('get-settings-schema', withTrustedIpc('get-settings-schema', (event) => {
  return { schema: settingsDb.SETTINGS_SCHEMA, categories: settingsDb.CATEGORY_ORDER };
}, trustDeps));

ipcMain.handle('fetch-models', async (event) => {
  if (!isTrustedIpcEvent(event, 'fetch-models')) return { ok: false, error: 'Untrusted IPC sender' };
  const { fetchModels } = require('./lib/models');
  return fetchModels();
});

ipcMain.handle('fetch-models-anthropic', async (event) => {
  if (!isTrustedIpcEvent(event, 'fetch-models-anthropic')) return { ok: false, error: 'Untrusted IPC sender' };
  const { fetchModelsFromAnthropic } = require('./lib/models');
  return fetchModelsFromAnthropic();
});

ipcMain.handle('get-default-models', (event) => {
  if (!isTrustedIpcEvent(event, 'get-default-models')) return [];
  const { getDefaultModels } = require('./lib/models');
  return getDefaultModels();
});

ipcMain.handle('get-custom-models', (event) => {
  if (!isTrustedIpcEvent(event, 'get-custom-models')) return { models: null };
  try {
    const raw = settingsDb.get('session.customModels');
    return { models: raw ? JSON.parse(raw) : null };
  } catch (err) { logger.warn('models', `Failed to parse custom models: ${err?.message || err}`); return { models: null }; }
});

ipcMain.handle('save-custom-models', (event, { models }) => {
  if (!isTrustedIpcEvent(event, 'save-custom-models')) return { ok: false, error: 'Untrusted IPC sender' };
  try {
    settingsDb.set('session.customModels', JSON.stringify(models));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Image Attachment Support ─────────────────────
ipcMain.handle('save-image-for-prompt', (event, { buffer, filename, tabId }) => {
  if (!isTrustedIpcEvent(event, 'save-image-for-prompt')) return { ok: false, error: 'Untrusted IPC sender' };
  try {
    const imgDir = path.join(app.getPath('temp'), 'auto-claude-images', tabId || 'default');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    // Ensure unique filename
    const ext = path.extname(filename) || '.png';
    const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const uniqueName = `${base}-${Date.now()}${ext}`;
    const filePath = path.join(imgDir, uniqueName);
    // buffer comes as ArrayBuffer from renderer — convert to Node Buffer
    fs.writeFileSync(filePath, Buffer.from(buffer));
    return { ok: true, path: filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cleanup-prompt-images', (event, { tabId }) => {
  if (!isTrustedIpcEvent(event, 'cleanup-prompt-images')) return { ok: false, error: 'Untrusted IPC sender' };
  try {
    const imgDir = path.join(app.getPath('temp'), 'auto-claude-images', tabId || 'default');
    if (fs.existsSync(imgDir)) {
      const files = fs.readdirSync(imgDir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(imgDir, f)); } catch { /* ignore */ }
      }
      try { fs.rmdirSync(imgDir); } catch { /* ignore if not empty */ }
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// send-response triggers continuation via proxy.sendResponse() -> response-ready event
ipcMain.on('send-response', (event, data) => {
  if (!isTrustedIpcEvent(event, 'send-response')) return;
  const tabId = data?.tabId || 'default';
  const session = sessionManager.get(tabId);
  if (!session?.state.running) return;
  const response = typeof data === 'string' ? data : data.text || data.response;
  const respVal = validateResponse(response);
  if (!respVal.valid) {
    sendToTab(tabId, 'log', { type: 'stderr', text: `Response validation error: ${respVal.error}` });
    return;
  }
  sendToTab(tabId, 'hide-question', {});
  sessionManager.sendResponse(tabId, respVal.text);
  sendToTab(tabId, 'log', { type: 'system', text: `Sent answer: ${respVal.text}` });
});

// question-answer triggers continuation via proxy.sendResponse() -> response-ready event
ipcMain.on('question-answer', (event, data) => {
  if (!isTrustedIpcEvent(event, 'question-answer')) return;
  const tabId = data?.tabId || 'default';
  const session = sessionManager.get(tabId);
  if (!session?.state.running) return;
  const answer = typeof data === 'string' ? data : data.answer || data.text;
  const respVal = validateResponse(answer);
  if (!respVal.valid) return;
  sendToTab(tabId, 'hide-question', {});
  sessionManager.sendResponse(tabId, respVal.text);
  sendToTab(tabId, 'log', { type: 'system', text: `Sent answer: ${respVal.text}` });
});

ipcMain.on('skip-question', (event, data) => {
  if (!isTrustedIpcEvent(event, 'skip-question')) return;
  const tabId = data?.tabId || 'default';
  sessionManager.skipQuestion(tabId);
  sendToTab(tabId, 'hide-question', {});
});

// ── Chart child window ────────────────────────────
let chartWindow = null;
ipcMain.on('open-chart', (event, data) => {
  if (!isTrustedIpcEvent(event, 'open-chart')) return;
  if (chartWindow && !chartWindow.isDestroyed()) {
    chartWindow.webContents.send('chart-data', data);
    chartWindow.focus();
    return;
  }
  chartWindow = new BrowserWindow({
    width: 520, height: 380, minWidth: 360, minHeight: 280,
    parent: mainWindow,
    modal: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#0d1117',
    title: data.title || 'Chart',
    webPreferences: {
      preload: path.join(__dirname, 'preload-chart.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chartWindow.setMenuBarVisibility(false);
  chartWindow.loadFile('chart.html');
  chartWindow.webContents.on('did-finish-load', () => {
    chartWindow.webContents.send('chart-data', data);
  });
  chartWindow.on('closed', () => { chartWindow = null; });
});

// Cross-platform terminal opening
ipcMain.on('open-terminal', (event, data) => {
  if (!isTrustedIpcEvent(event, 'open-terminal')) return;
  const tabId = data?.tabId || 'default';
  const session = sessionManager.get(tabId);
  const projDir = session?.state.projectDir;
  if (!projDir) return;
  try {
    const skipPerms = config.skipPermissions !== false ? ' --dangerously-skip-permissions' : '';
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `cd /d "${projDir}" && claude${skipPerms}`],
        { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', projDir], { detached: true, stdio: 'ignore' });
    } else {
      spawn('x-terminal-emulator', ['-e', `cd "${projDir}" && claude${skipPerms}`],
        { detached: true, stdio: 'ignore' });
    }
  } catch (err) {
    logger.warn('ipc.open-terminal', 'Failed to open terminal', err);
  }
});


ipcMain.on('get-state', (event, data) => {
  if (!isTrustedIpcEvent(event, 'get-state')) return;
  const tabId = data?.tabId || 'default';
  sessionManager.sendState(tabId);
});

// -- Telegram IPC (per-project session bots) -----------------
ipcMain.handle('save-telegram-config', async (event, c) => {
  if (!isTrustedIpcEvent(event, 'save-telegram-config')) return { ok: false, error: 'Untrusted IPC sender' };
  const projectDir = c.projectDir;
  if (!projectDir) return { ok: false, error: 'projectDir is required' };
  const resolved = path.resolve(projectDir);

  // Validate config
  const result = validateProjectTelegramConfig({ enabled: !!c.enabled, allowedUsers: c.allowedUsers || [] });
  if (!result.ok) return { ok: false, error: result.error };

  // Check token distinctness against master
  if (c.botToken) {
    const masterToken = loadMasterTelegramToken(app.getPath('userData'));
    const check = validateProjectTokenDistinct(c.botToken, masterToken);
    if (!check.ok) {
      logger.warn('telegram', check.error);
      return { ok: false, code: check.code, error: 'Project bot token must differ from master bot token.' };
    }
  }

  // Save config
  if (!config.projectTelegram) config.projectTelegram = {};
  config.projectTelegram[resolved] = {
    enabled: result.config.enabled,
    allowedUsers: result.config.allowedUsers,
  };
  saveConfig(config);

  // Save or clear token
  if (c.botToken) {
    const ok = saveProjectToken(app.getPath('userData'), resolved, c.botToken);
    if (!ok) logger.warn('telegram', 'Encryption not available - project token not saved');
  }

  // Restart bot for this project
  await stopProjectBot(resolved);
  if (result.config.enabled) {
    const token = c.botToken || loadProjectToken(app.getPath('userData'), resolved);
    if (token) {
      const bridge = new TelegramBridge(config, sessionManager, resolved);
      await bridge.start(token, result.config.allowedUsers);
      projectTelegramBots.set(resolved, bridge);
      // Update any active session for this project
      for (const [tabId, session] of sessionManager.sessions) {
        if (session.state.projectDir && path.resolve(session.state.projectDir) === resolved) {
          sessionManager.setTelegram(tabId, bridge);
        }
      }
    }
  }
  return { ok: true };
});

ipcMain.handle('load-telegram-config', async (event, c) => {
  if (!isTrustedIpcEvent(event, 'load-telegram-config')) return { enabled: false, hasToken: false, allowedUsers: [], encryptionAvailable: isEncryptionAvailable() };
  const projectDir = c?.projectDir;
  if (!projectDir) return { enabled: false, hasToken: false, allowedUsers: [], encryptionAvailable: isEncryptionAvailable() };
  const resolved = path.resolve(projectDir);
  const ptConfig = config.projectTelegram?.[resolved] || {};
  const hasToken = !!loadProjectToken(app.getPath('userData'), resolved);
  return {
    enabled: ptConfig.enabled || false,
    hasToken,
    allowedUsers: ptConfig.allowedUsers || [],
    encryptionAvailable: isEncryptionAvailable(),
  };
});

ipcMain.handle('save-master-telegram-config', async (event, incoming) => {
  if (!isTrustedIpcEvent(event, 'save-master-telegram-config')) return { ok: false, error: 'Untrusted IPC sender' };
  const result = validateMasterTelegramConfig(incoming || {});
  if (!result.valid) {
    return { ok: false, code: 'INVALID_MASTER_TELEGRAM_CONFIG', error: result.error };
  }

  config.masterTelegram = {
    enabled: result.config.enabled,
    allowedUsers: result.config.allowedUsers || [],
  };
  saveConfig(config);

  if ('botToken' in result.config) {
    if (result.config.botToken) {
      const ok = saveMasterTelegramToken(app.getPath('userData'), result.config.botToken);
      if (!ok) return { ok: false, code: 'ENCRYPTION_UNAVAILABLE', error: 'Encryption not available - master token not saved' };
    } else {
      clearMasterTelegramToken(app.getPath('userData'));
    }
  }

  await _initMasterTelegram();
  return { ok: true };
});

ipcMain.handle('load-master-telegram-config', async (event) => {
  if (!isTrustedIpcEvent(event, 'load-master-telegram-config')) {
    return { enabled: false, hasToken: false, allowedUsers: [], encryptionAvailable: isEncryptionAvailable() };
  }
  const hasToken = !!loadMasterTelegramToken(app.getPath('userData'));
  return {
    enabled: config.masterTelegram?.enabled || false,
    hasToken,
    allowedUsers: config.masterTelegram?.allowedUsers || [],
    encryptionAvailable: isEncryptionAvailable(),
  };
});

ipcMain.handle('test-telegram-bot', async (event, c) => {
  if (!isTrustedIpcEvent(event, 'test-telegram-bot')) return { ok: false, error: 'Untrusted IPC sender' };
  const projectDir = c?.projectDir;
  if (!projectDir) return { ok: false, error: 'projectDir is required' };
  const bot = getProjectBot(projectDir);
  if (!bot) return { ok: false, error: 'No bot configured for this project' };
  if (bot._pollingDead) return { ok: false, error: 'Bot polling died (409 conflict — is another instance using the same token?)' };
  if (!bot.isRunning) return { ok: false, error: 'Bot not running for this project' };
  return { ok: true, status: 'Bot is polling' };
});

// ── Tutorial: Test Send & Chat ID Discovery ──────
ipcMain.handle('tutorial-test-send', async (event, { token, chatId }) => {
  if (!isTrustedIpcEvent(event, 'tutorial-test-send')) return { ok: false, error: 'Untrusted IPC sender' };
  if (!token || !chatId) return { ok: false, error: 'Token and chat ID are required' };
  try {
    const https = require('https');
    const msg = encodeURIComponent('Auto Claude test message — your bot is working!');
    const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${msg}`;
    const result = await new Promise((resolve, reject) => {
      https.get(url, { timeout: 10000 }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, description: data }); }
        });
      }).on('error', reject);
    });
    if (result.ok) return { ok: true };
    return { ok: false, error: result.description || 'Telegram API returned an error' };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('tutorial-discover-chat-id', async (event, { token, projectDir }) => {
  if (!isTrustedIpcEvent(event, 'tutorial-discover-chat-id')) return { ok: false, error: 'Untrusted IPC sender' };
  // If no token provided directly, load from secure storage for the project
  if (!token && projectDir) {
    const resolved = path.resolve(projectDir);
    token = loadProjectToken(app.getPath('userData'), resolved);
  }
  if (!token) return { ok: false, error: 'Bot token is required' };
  // Temporarily stop the project bot if running (it consumes getUpdates)
  const resolvedDir = projectDir ? path.resolve(projectDir) : null;
  const runningBot = resolvedDir ? projectTelegramBots.get(resolvedDir) : null;
  if (runningBot?.isRunning) { await runningBot.stop(); }
  try {
    const https = require('https');
    const url = `https://api.telegram.org/bot${token}/getUpdates?limit=20&timeout=0`;
    const result = await new Promise((resolve, reject) => {
      https.get(url, { timeout: 15000 }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, description: data }); }
        });
      }).on('error', reject);
    });
    if (!result.ok) return { ok: false, error: result.description || 'Telegram API error' };
    const chats = [];
    const seen = new Set();
    for (const upd of (result.result || [])) {
      const msg = upd.message;
      if (!msg?.chat?.id) continue;
      const key = String(msg.chat.id);
      if (seen.has(key)) continue;
      seen.add(key);
      chats.push({
        chatId: msg.chat.id,
        username: msg.chat.username || '',
        firstName: msg.chat.first_name || '',
        text: msg.text || '',
      });
    }
    // Restart the bot if we stopped it
    if (runningBot && resolvedDir) { await startProjectBot(resolvedDir); }
    if (!chats.length) return { ok: true, chats: [], message: 'No messages found. Send /start to your bot first, then try again.' };
    return { ok: true, chats };
  } catch (e) {
    // Restart the bot even on error
    if (runningBot && resolvedDir) { await startProjectBot(resolvedDir); }
    return { ok: false, error: e.message };
  }
});

// ── Claude Code Manager IPC ─────────────────────
const ALLOWED_INSTALL_METHODS = new Set(['powershell', 'cmd', 'winget', 'curl', 'homebrew']);
const ALLOWED_AUTH_METHODS = new Set(['anthropic', 'console']);

function sanitizeClaudeProjectDir(dir) {
  if (!dir || typeof dir !== 'string') return null;
  const resolved = path.resolve(dir);
  if (!path.isAbsolute(resolved)) return null;
  return resolved;
}

ipcMain.handle('detect-claude-code', (event) => {
  if (!isTrustedIpcEvent(event, 'detect-claude-code')) return { installed: false, authType: null, authDetail: null };
  return detectClaudeStateWithSecureToken();
});

ipcMain.handle('read-claude-settings', (event, { scope, projectDir }) => {
  if (!isTrustedIpcEvent(event, 'read-claude-settings')) return { content: '{\n}', path: '', error: 'Untrusted IPC sender' };
  const dir = scope === 'project' ? sanitizeClaudeProjectDir(projectDir) : null;
  return claudeDetector.readSettingsJson(scope, dir);
});

ipcMain.handle('write-claude-settings', (event, { scope, projectDir, content }) => {
  if (!isTrustedIpcEvent(event, 'write-claude-settings')) return { ok: false, error: 'Untrusted IPC sender' };
  try {
    const dir = scope === 'project' ? sanitizeClaudeProjectDir(projectDir) : null;
    return claudeDetector.writeSettingsJson(scope, dir, content);
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('list-claude-plugins', (event) => {
  if (!isTrustedIpcEvent(event, 'list-claude-plugins')) return { installed: [], error: 'Untrusted IPC sender' };
  return claudeDetector.listPlugins();
});

ipcMain.handle('toggle-claude-plugin', (event, { pluginKey, enabled }) => {
  if (!isTrustedIpcEvent(event, 'toggle-claude-plugin')) return { ok: false, error: 'Untrusted IPC sender' };
  const result = claudeDetector.togglePlugin(pluginKey, enabled);
  invalidateHealthCache();
  return result;
});

ipcMain.handle('install-claude-plugin', (event, { source, repo }) => {
  if (!isTrustedIpcEvent(event, 'install-claude-plugin')) return { ok: false, error: 'Untrusted IPC sender' };
  const result = claudeDetector.installPlugin(source, repo);
  invalidateHealthCache();
  return result;
});

ipcMain.handle('test-custom-provider', (event, { baseUrl, authToken }) => {
  if (!isTrustedIpcEvent(event, 'test-custom-provider')) return { ok: false, error: 'Untrusted IPC sender' };

  const env = readGlobalClaudeEnv();
  const resolvedBaseUrl = String(baseUrl || env.ANTHROPIC_BASE_URL || '').trim();
  const providedToken = typeof authToken === 'string' ? authToken.trim() : '';

  let secureToken = null;
  try {
    secureToken = loadCustomProviderToken(app.getPath('userData'));
  } catch (err) {
    logger.warn('custom-provider', `Failed to load secure token for test: ${err?.message || err}`);
    secureToken = null;
  }

  const resolvedToken = providedToken || secureToken || String(env.ANTHROPIC_AUTH_TOKEN || '').trim();
  if (!resolvedBaseUrl || !resolvedToken) {
    return { ok: false, error: 'Base URL and auth token are required' };
  }

  return claudeDetector.testCustomProvider(resolvedBaseUrl, resolvedToken);
});

ipcMain.handle('install-claude-code', (event, { method }) => {
  if (!isTrustedIpcEvent(event, 'install-claude-code')) return { ok: false, error: 'Untrusted IPC sender' };
  if (!ALLOWED_INSTALL_METHODS.has(method)) return { ok: false, error: 'Invalid install method' };
  return new Promise((resolve) => {
    const emitter = claudeInstaller.install(method);
    let output = '';
    emitter.on('progress', text => {
      output += text;
      send('install-claude-code-progress', { output: text, done: false });
    });
    emitter.on('complete', () => {
      // Auto-add claude to PATH after successful install
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
});

ipcMain.handle('authenticate-claude-code', (event, { method }) => {
  if (!isTrustedIpcEvent(event, 'authenticate-claude-code')) return { ok: false, error: 'Untrusted IPC sender' };
  if (!ALLOWED_AUTH_METHODS.has(method)) return { ok: false, error: 'Invalid auth method' };
  return new Promise((resolve) => {
    const emitter = claudeInstaller.authenticate(method);
    let output = '';
    emitter.on('progress', text => { output += text; });
    emitter.on('complete', () => resolve({ ok: true, output }));
    emitter.on('error', err => resolve({ ok: false, error: err, output }));
  });
});

const ALLOWED_PREREQUISITES = new Set(['git', 'node']);
ipcMain.handle('install-prerequisite', (event, { name }) => {
  if (!isTrustedIpcEvent(event, 'install-prerequisite')) return { ok: false, error: 'Untrusted IPC sender' };
  if (!ALLOWED_PREREQUISITES.has(name)) return { ok: false, error: 'Invalid prerequisite' };
  return new Promise((resolve) => {
    const emitter = claudeInstaller.installPrerequisite(name);
    let output = '';
    emitter.on('progress', text => {
      output += text;
      send('install-prerequisite-progress', { name, output: text, done: false });
    });
    emitter.on('complete', () => {
      send('install-prerequisite-progress', { name, output: '', done: true });
      resolve({ ok: true, output });
    });
    emitter.on('error', err => {
      send('install-prerequisite-progress', { name, output: err, done: true, error: err });
      resolve({ ok: false, error: err, output });
    });
  });
});

// Install recommended tools (GSD, Context7, etc.) via npx
ipcMain.handle('install-tool', (event, { key }) => {
  if (!isTrustedIpcEvent(event, 'install-tool')) return { ok: false, error: 'Untrusted IPC sender' };
  const tool = claudeDetector.DEFAULT_RECOMMENDED_TOOLS.find(t => t.key === key);
  if (!tool) return { ok: false, error: `Unknown tool: ${key}` };
  const cmd = tool.installCmd[process.platform];
  if (!cmd) return { ok: false, error: `No installer for ${key} on ${process.platform}` };
  const parsed = parseInstallCommand(cmd);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  logger.info('install-tool', `Starting installer for ${key}: ${cmd}`);

  return new Promise((resolve) => {
    const proc = require('child_process').spawn(parsed.executable, parsed.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    let output = '';
    proc.stdout.on('data', d => {
      const text = d.toString();
      output += text;
      send('install-tool-progress', { key, output: text, done: false });
    });

    proc.stderr.on('data', d => {
      const text = d.toString();
      output += text;
      send('install-tool-progress', { key, output: text, done: false });
    });

    proc.on('close', code => {
      let context7Installed = false;
      if (key === 'context7') {
        try {
          const tools = claudeDetector.detectRecommendedTools();
          context7Installed = tools.some(t => t.key === 'context7' && t.installed);
        } catch (err) {
          logger.warn('install-tool', `Context7 detection failed: ${err?.message || err}`);
          context7Installed = false;
        }
      }

      const verdict = evaluateToolInstallResult({ key, code, output, context7Installed });

      if (verdict.ok) {
        if (verdict.warning) {
          logger.warn('install-tool', `Installer warning tolerated for ${key}: ${verdict.warning}`);
          send('install-tool-progress', { key, output: verdict.warning, done: true });
          resolve({ ok: true, output, warning: verdict.warning });
          return;
        }

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
      logger.error('install-tool', `${key} spawn error`, err);
      send('install-tool-progress', { key, output: err.message, done: true, error: err.message });
      resolve({ ok: false, error: err.message, output });
    });
  });
});

ipcMain.handle('save-custom-provider', (event, { baseUrl, authToken }) => {
  if (!isTrustedIpcEvent(event, 'save-custom-provider')) return { ok: false, error: 'Untrusted IPC sender' };

  try {
    const { readSettingsJson, writeSettingsJson } = claudeDetector;
    const { content } = readSettingsJson('global');

    const tokenProvided = typeof authToken === 'string';
    const token = String(authToken || '').trim();
    const secureAvailable = isEncryptionAvailable();

    const tokenMode = tokenProvided ? (token ? 'set' : 'clear') : 'preserve';
    const useSecureToken = secureAvailable && tokenMode === 'set' && token.length > 0;

    const transformed = applyCustomProviderToSettings({
      settingsContent: content,
      baseUrl,
      authToken: token,
      useSecureToken,
      tokenMode,
    });

    if (!transformed.ok) {
      return { ok: false, error: transformed.error || 'Failed to parse settings' };
    }

    if (tokenMode === 'clear') {
      clearCustomProviderToken(app.getPath('userData'));
    } else if (tokenMode === 'set' && useSecureToken) {
      const saved = saveCustomProviderToken(app.getPath('userData'), token);
      if (!saved) {
        return { ok: false, error: 'Secure storage unavailable for provider token' };
      }
    } else if (tokenMode === 'set' && !useSecureToken) {
      // Ensure plaintext fallback in settings.json is the only active token source
      clearCustomProviderToken(app.getPath('userData'));
    }

    writeSettingsJson('global', null, transformed.content);
    syncCustomProviderRuntimeEnv();

    return {
      ok: true,
      secureToken: tokenMode === 'set' ? useSecureToken : null,
      warning: tokenMode === 'set' && !useSecureToken && token ? 'Secure storage unavailable; token stored in settings.json' : null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-custom-provider-state', (event) => {
  if (!isTrustedIpcEvent(event, 'get-custom-provider-state')) return { ok: false, error: 'Untrusted IPC sender' };
  const env = readGlobalClaudeEnv();
  let hasSecureToken = false;
  try {
    hasSecureToken = !!loadCustomProviderToken(app.getPath('userData'));
  } catch (err) {
    logger.warn('custom-provider', `Failed to check secure token: ${err?.message || err}`);
    hasSecureToken = false;
  }

  return {
    ok: true,
    baseUrl: env.ANTHROPIC_BASE_URL || '',
    hasSecureToken,
    hasEnvToken: typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.length > 0,
    secureStorageAvailable: isEncryptionAvailable(),
  };
});

ipcMain.handle('list-settings-tags', withTrustedIpc('list-settings-tags', (event) => {
  return claudeDetector.listSettingsTags();
}, trustDeps));

ipcMain.handle('load-settings-tag', (event, { name }) => {
  if (!isTrustedIpcEvent(event, 'load-settings-tag')) return { ok: false, error: 'Untrusted IPC sender' };
  return claudeDetector.loadSettingsTag(name);
});

ipcMain.handle('save-settings-tag', (event, { name, content }) => {
  if (!isTrustedIpcEvent(event, 'save-settings-tag')) return { ok: false, error: 'Untrusted IPC sender' };
  try { return claudeDetector.saveSettingsTag(name, content); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('delete-settings-tag', (event, { name }) => {
  if (!isTrustedIpcEvent(event, 'delete-settings-tag')) return { ok: false, error: 'Untrusted IPC sender' };
  try { return claudeDetector.deleteSettingsTag(name); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('check-claude-update', (event, opts) => {
  if (!isTrustedIpcEvent(event, 'check-claude-update')) return { ok: false, error: 'Untrusted IPC sender' };
  return claudeDetector.checkForUpdate(opts);
});

// ── Startup Health Check ─────────────────────────
ipcMain.handle('run-health-check', async (event) => {
  if (!isTrustedIpcEvent(event, 'run-health-check')) return { healthy: false, error: 'Untrusted IPC sender' };
  try { return await buildHealthStatusCached(); }
  catch (e) { return { healthy: false, error: e.message }; }
});

ipcMain.handle('get-app-log-info', (event) => {
  if (!isTrustedIpcEvent(event, 'get-app-log-info')) return { ok: false, error: 'Untrusted IPC sender' };
  try {
    return {
      ok: true,
      path: APP_LOG_FILE,
      exists: fs.existsSync(APP_LOG_FILE),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-app-log-folder', async (event) => {
  if (!isTrustedIpcEvent(event, 'open-app-log-folder')) return { ok: false, error: 'Untrusted IPC sender' };
  try {
    const logDir = path.dirname(APP_LOG_FILE);
    fs.mkdirSync(logDir, { recursive: true });
    const openResult = await shell.openPath(logDir);
    if (openResult) {
      return { ok: false, error: openResult, path: logDir };
    }
    return { ok: true, path: logDir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('snapshot-recommended-plugins', async (event) => {
  if (!isTrustedIpcEvent(event, 'snapshot-recommended-plugins')) return [];
  try {
    const detection = await claudeDetector.detect();
    if (!detection.installed) return [];
    const pluginData = claudeDetector.listPlugins();
    const enabled = pluginData.installed.filter(p => p.enabled);
    const recommended = enabled.map(p => ({ key: p.key, repo: p.source }));
    settingsDb.set('system.recommendedPlugins', JSON.stringify(recommended));
    return recommended;
  } catch (e) { return []; }
});

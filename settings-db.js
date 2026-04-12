'use strict';
const fs = require('fs');
const path = require('path');
const { preserveCorruptDbFile } = require('./lib/runtime-utils');

const SETTINGS_SCHEMA = {
  'workspaceRoot':                            { category:'workspace',     type:'path',   label:'Workspace Root',              default:'',            description:'Base directory for project discovery. Subfolders appear as launchable projects.' },
  'defaultPrompt':                            { category:'session',       type:'text',   label:'Default Prompt',              default:'',            description:'Pre-fills the prompt input on every session start. Sent automatically each time you click Start until cleared. Supports slash commands (e.g., /gsd:next). Leave empty to enter a prompt manually each time.' },
  'skipPermissions':                          { category:'session',       type:'toggle', label:'Skip Permissions',            default:true,          description:"Skip Claude's tool-use permission prompts. Required for autonomous sessions. Turn OFF only if you want manual approval of every action." },
  'session.model':                            { category:'session',       type:'select', label:'Model',                       default:'auto', options:['auto'], description:'Claude model to use. "auto" uses Claude CLI default. Models fetched from API on settings open.' },
  'session.effort':                           { category:'session',       type:'select', label:'Effort',                      default:'auto', options:['auto','low','medium','high','max'], description:'Reasoning effort level. "auto" uses model default. Disabled for models that don\'t support effort.' },
  'autoAnswer.mode':                          { category:'autonomy',      type:'select', label:'Mode',                        default:'full', options:['full','review','manual'], description:"How to handle Claude's questions. Full: auto-answer. Review: auto-answer with countdown to intervene. Manual: pause and wait." },
  'autoAnswer.selectRecommended':             { category:'autonomy',      type:'toggle', label:'Select Recommended',          default:true,          description:'Auto-select the (Recommended) option when Claude presents multiple choices.' },
  'autoAnswer.selectAll':                     { category:'autonomy',      type:'toggle', label:'Select All',                  default:true,          description:'Auto-select all items when Claude shows a multi-select checklist.' },
  'autoAnswer.fullAutonomy':                  { category:'autonomy',      type:'toggle', label:'Full Autonomy',               default:true,          description:"Auto-answer open-ended questions with 'continue with best judgment.' Essential for fully unattended sessions." },
  'autoAnswer.derailmentCorrection':          { category:'autonomy',      type:'toggle', label:'Derailment Correction',       default:true,          description:'Detect and correct when Claude goes off-track. Sends a refocus prompt to get back on task.' },
  'autoAnswer.questionTimeoutSeconds':        { category:'autonomy',      type:'number', label:'Question Timeout (s)',        default:300, min:0,    description:'Seconds before auto-answering questions. Lower = faster throughput. Higher = more time to intervene.' },
  'autoAnswer.criticalQuestionTimeoutSeconds':{ category:'autonomy',      type:'number', label:'Critical Timeout (s)',        default:120, min:0,    description:'Seconds before auto-answering critical/destructive questions. Shorter than normal timeout for faster resolution.' },
  'autoAnswer.reviewCountdownSeconds':        { category:'autonomy',      type:'number', label:'Review Countdown (s)',        default:10, min:0,     description:'Review mode only. Seconds shown on countdown before auto-sending the answer. Click to cancel.' },
  'autoAnswer.skipReviewInFullAutonomy':      { category:'autonomy',      type:'toggle', label:'Skip Review in Full Auto',   default:true,          description:'In Full Auto, send answers instantly without countdown. OFF adds a brief review window even in Full Auto.' },
  'autoAnswer.noRecommendedTimeoutSeconds':   { category:'autonomy',      type:'number', label:'No Recommended Timeout (s)', default:30, min:0,     description:'Seconds to wait when no option is marked Recommended. Auto-selects the first option after timeout.' },
  'notifications.onQuestion':                { category:'notifications', type:'toggle', label:'On Question',                default:true,          description:'Desktop notification when Claude asks a question. Helpful for catching questions while multitasking.' },
  'notifications.onComplete':                { category:'notifications', type:'toggle', label:'On Complete',                default:true,          description:'Desktop notification when a session completes. Know when work is done without watching the dashboard.' },
  'notifications.onError':                   { category:'notifications', type:'toggle', label:'On Error',                   default:true,          description:'Desktop notification on fatal errors. Alerts you when a session crashes or hits an unrecoverable failure.' },
  'retry.enabled':                           { category:'retry',         type:'toggle', label:'Retry Enabled',              default:true,          description:'Auto-retry on transient errors (rate limits, timeouts, 5xx). Keeps sessions alive through temporary API issues.' },
  'retry.maxRetries':                        { category:'retry',         type:'number', label:'Max Retries',                default:3, min:0,      description:'Max retry attempts per error. Uses exponential backoff between attempts. 3 handles most rate limits.' },
  'retry.backoffSeconds':                    { category:'retry',         type:'text',   label:'Backoff Seconds (comma-sep)', default:'30,60,120',  description:"Wait times between retries (comma-separated seconds). e.g., '30,60,120' = wait 30s, then 60s, then 120s." },
  'resilience.crashRetry':                   { category:'resilience',    type:'toggle', label:'Crash Retry',                default:true,          description:'Auto-restart after CLI process crashes. Handles OOM kills, unexpected exits, and OS signals.' },
  'resilience.maxCrashRetries':              { category:'resilience',    type:'number', label:'Max Crash Retries',           default:3, min:0, max:10, description:'Max consecutive crash restarts before stopping. Prevents infinite restart loops on persistent crashes.' },
  'resilience.crashRetryDelaySecs':          { category:'resilience',    type:'number', label:'Crash Retry Delay (s)',       default:10, min:0,     description:'Seconds to wait before restarting after a crash. Allows system recovery (memory, locks) before relaunch.' },
  'resilience.autoResume':                   { category:'resilience',    type:'toggle', label:'Auto Resume',                default:true,          description:'Resume conversation context after crash restart using --resume flag. Without this, restarted sessions lose all prior context.' },
  'contextGuard.enabled':                  { category:'contextGuard', type:'toggle', label:'Context Guard',               default:true,          description:'Automatically detect when context window is nearly full and seamlessly recover by saving state and starting a fresh session.' },
  'contextGuard.threshold':                { category:'contextGuard', type:'number', label:'Threshold (%)',                default:85, min:50, max:95, description:'Context usage percentage at which to trigger recovery (50-95). Lower values trigger earlier, leaving more room for the handoff turn.' },
  'contextGuard.contextWindowOverride':    { category:'contextGuard', type:'number', label:'Context Window Override',     default:0, min:0,      description:'Manually set context window size in tokens. 0 = auto-detect from model. Use if auto-detection is wrong for your model/provider.' },
  'contextGuard.maxRecoveriesPerSession':  { category:'contextGuard', type:'number', label:'Max Recoveries',              default:3, min:1, max:10, description:'Maximum context recoveries per session before stopping. Prevents infinite recovery loops.' },
  'masterTelegram.enabled':                  { category:'telegram',      type:'toggle', label:'Master Bot Enabled',          default:false,         description:'Enable Telegram bot for remote monitoring and control. Requires bot token from @BotFather. Token stored securely in OS keychain.' },
  'masterTelegram.allowedUsers':             { category:'telegram',      type:'text',   label:'Allowed Users (comma-sep)',   default:'',            description:'Telegram usernames allowed to control the bot (comma-separated, no @). Leave empty to allow anyone (not recommended).' },
  'masterTelegram.chatIds':                  { category:'telegram',      type:'hidden', label:'Master Bot Chat IDs',         default:'{}' },
  'hooks.install':                           { category:'hooks',         type:'toggle', label:'Install Hooks',              default:true,          description:'Install telemetry hooks in target project for live metrics (tool calls, tokens, model). Auto-removed on session stop.' },
  'hooks.logFile':                           { category:'hooks',         type:'text',   label:'Log File',                   default:'.planning/auto-claude-hooks.jsonl', description:'JSONL file path for hook telemetry data (relative to project root). Polled by dashboard for live metrics.' },
  'hooks.maxLogSizeMB':                      { category:'hooks',         type:'number', label:'Max Log Size (MB)',          default:5, min:1,      description:'Max hook log file size in MB per project before truncation. Older entries removed first. 5 MB holds thousands of events.' },
  'batch.enabled':                           { category:'batch',         type:'toggle', label:'Batch Enabled',              default:false,         description:'Enable batch queue for processing multiple prompts sequentially or in parallel across a project.' },
  'batch.mode':                              { category:'batch',         type:'select', label:'Mode',                        default:'sequential', options:['sequential','parallel'], description:'Sequential: one task at a time. Parallel: multiple concurrent tasks (up to Parallel Limit). Sequential is safer.' },
  'batch.parallelLimit':                     { category:'batch',         type:'number', label:'Parallel Limit',             default:2, min:1,      description:'Max concurrent batch tasks in parallel mode. Higher = faster but more API usage. 2 balances speed and quota.' },
  'batch.queue':                             { category:'batch',         type:'hidden', label:'Batch Queue',                default:'[]' },
  'superpowers.enabled':                     { category:'superpowers',   type:'toggle', label:'Enabled',                    default:true,          description:'Enable Superpowers skill integration. Auto-handles skill prompts and workflows during autonomous sessions.' },
  'superpowers.autoChain':                   { category:'superpowers',   type:'toggle', label:'Auto Chain',                 default:true,          description:'Auto-approve skill-to-skill transitions (e.g., brainstorm → plan → execute). OFF pauses at each skill boundary.' },
  'superpowers.declineVisualCompanion':      { category:'superpowers',   type:'toggle', label:'Decline Visual Companion',   default:true,          description:'Auto-decline visual companion prompts. The visual companion requires human interaction and doesn\'t work in autonomous mode.' },
  'superpowers.autoApproveRoutine':          { category:'superpowers',   type:'toggle', label:'Auto-Approve Routine',       default:true,          description:'Auto-approve routine confirmations (proceed, continue, plan approval). Keeps unattended workflows flowing.' },
  'superpowers.skillChain':                  { category:'superpowers',   type:'hidden', label:'Skill Chain',                default:'[]' },
  'gsd.enabled':                             { category:'gsd',           type:'toggle', label:'Enabled',                    default:true,          description:'Enable GSD workflow engine. Provides structured phase-based project execution with autonomous progression.' },
  'gsd.autoNext':                            { category:'gsd',           type:'toggle', label:'Auto Next',                  default:true,          description:'Automatically advance to the next phase when the current one completes. OFF pauses between phases for manual review.' },
  'gsd.derailmentCorrection':                { category:'gsd',           type:'toggle', label:'Derailment Correction',      default:true,          description:'Detect and correct when a phase execution goes off-track. Sends a refocus prompt to realign with the phase plan.' },
  'gsd.maxPhaseRetries':                     { category:'gsd',           type:'number', label:'Max Phase Retries',           default:3, min:1, max:10, description:'Maximum retry attempts per phase on failure before marking it as blocked. Higher values increase resilience at the cost of time.' },
  'gsd.autoContinueDelaySecs':               { category:'gsd',           type:'number', label:'Auto Continue Delay (s)',     default:15, min:5, max:120, description:'Seconds to wait before auto-continuing to the next phase. Gives time to review results or intervene.' },
  'gsd.phaseTimeoutMinutes':                 { category:'gsd',           type:'number', label:'Phase Timeout (min)',         default:0, min:0,      description:'Maximum minutes a single phase can run before being timed out. 0 = no timeout (unlimited).' },
  'projectTelegram':                         { category:'telegram',      type:'hidden', label:'Project Telegram Configs',   default:'{}' },
  'system.preventSleep':                      { category:'system',        type:'toggle', label:'Prevent Sleep',              default:true,          description:'Keep the computer awake while sessions are running. Prevents sleep/suspend during long Claude operations. Releases automatically when all sessions stop.' },
  'system.recommendedPlugins':                { category:'system',        type:'hidden', label:'Recommended Plugins',        default:'[]',          description:'JSON array of recommended plugins to install on setup. Set via "Save as Recommended" button.' },
  'system.autoUpdate':                        { category:'system',        type:'toggle', label:'Auto Update',                default:true,          description:'Check for updates on startup. Downloads new versions automatically and prompts to restart. Only works in installed (packaged) builds.' },
  'runtime.slashFallback.enabled':            { category:'system',        type:'toggle', label:'Slash PTY Fallback',         default:true,          description:'Auto-fallback unsupported slash commands to on-demand PTY execution.' },
  'runtime.slashFallback.timeoutMs':          { category:'system',        type:'number', label:'Slash PTY Timeout (ms)',     default:45000, min:10000, description:'Timeout for on-demand PTY fallback runs.' },
  'runtime.slashFallback.logRawOutput':       { category:'system',        type:'toggle', label:'Slash PTY Raw Logs',         default:false,         description:'Log raw PTY output to session log for debugging.' },
};

const CATEGORY_ORDER = [
  { key:'workspace',     icon:'📁', label:'Workspace' },
  { key:'session',       icon:'⚡', label:'Session' },
  { key:'autonomy',      icon:'🤖', label:'Autonomy' },
  { key:'notifications', icon:'🔔', label:'Notifications' },
  { key:'retry',         icon:'🔄', label:'Retry' },
  { key:'resilience',    icon:'🛡️', label:'Resilience' },
  { key:'contextGuard',  icon:'🧠', label:'Context Guard' },
  { key:'telegram',      icon:'📡', label:'Telegram' },
  { key:'hooks',         icon:'🧩', label:'Hooks' },
  { key:'batch',         icon:'📦', label:'Batch' },
  { key:'superpowers',   icon:'✨', label:'Superpowers' },
  { key:'gsd',           icon:'🚀', label:'GSD' },
  { key:'system',        icon:'💻', label:'System' },
];

let _db = null;
let _dbPath = null;
let _SQL = null;
let _saveTimer = null;
const SAVE_DEBOUNCE_MS = 500;

// ── Helpers ──────────────────────────────────────

function _setNestedValue(obj, dotKey, value) {
  const parts = dotKey.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in cur) || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function _getNestedValue(obj, dotKey) {
  const parts = dotKey.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function _parseValue(raw) {
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

// ── Core API ─────────────────────────────────────

async function init(dbPath) {
  const initSqlJs = require('sql.js');
  _SQL = await initSqlJs();
  _dbPath = dbPath;

  if (fs.existsSync(dbPath)) {
    try {
      const fileBuffer = fs.readFileSync(dbPath);
      _db = new _SQL.Database(fileBuffer);
    } catch (err) {
      const preserved = preserveCorruptDbFile({
        dbPath,
        existsSync: fs.existsSync,
        renameSync: fs.renameSync,
      });
      if (preserved.ok) {
        console.error(`settings-db: corrupt DB moved to ${preserved.backupPath}`);
      } else {
        console.error(`settings-db: corrupt DB backup failed: ${preserved.error || 'unknown error'}`);
      }
      _db = new _SQL.Database();
    }
  } else {
    _db = new _SQL.Database();
  }

  _db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    category TEXT,
    updated_at INTEGER
  )`);
  _db.run(`CREATE TABLE IF NOT EXISTS sessions (
    project_dir TEXT PRIMARY KEY,
    session_id TEXT,
    timestamp INTEGER
  )`);

  // Insert defaults for any missing keys
  const stmt = _db.prepare('SELECT key FROM settings WHERE key = ?');
  for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
    stmt.bind([key]);
    if (!stmt.step()) {
      const defVal = typeof schema.default === 'string' ? schema.default : JSON.stringify(schema.default);
      _db.run('INSERT INTO settings (key, value, category, updated_at) VALUES (?, ?, ?, ?)',
        [key, defVal, schema.category, Date.now()]);
    }
    stmt.reset();
  }
  stmt.free();
  save();
}

function get(key) {
  if (!_db) return SETTINGS_SCHEMA[key]?.default ?? null;
  const stmt = _db.prepare('SELECT value FROM settings WHERE key = ?');
  stmt.bind([key]);
  let val = null;
  if (stmt.step()) {
    val = _parseValue(stmt.get()[0]);
  } else {
    val = SETTINGS_SCHEMA[key]?.default ?? null;
  }
  stmt.free();
  return val;
}

function set(key, value, category) {
  if (!_db) return;
  const cat = category || SETTINGS_SCHEMA[key]?.category || 'general';
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  _db.run(
    'INSERT OR REPLACE INTO settings (key, value, category, updated_at) VALUES (?, ?, ?, ?)',
    [key, encoded, cat, Date.now()]
  );
  _scheduleSave();
}

function getGroup(category) {
  if (!_db) return {};
  const result = {};
  // Pre-fill with schema defaults for this category
  for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
    if (schema.category === category && schema.type !== 'hidden') {
      result[key] = schema.default;
    }
  }
  // Override with stored values
  const stmt = _db.prepare('SELECT key, value FROM settings WHERE category = ?');
  stmt.bind([category]);
  while (stmt.step()) {
    const row = stmt.get();
    result[row[0]] = _parseValue(row[1]);
  }
  stmt.free();
  return result;
}

function getAll() {
  if (!_db) return {};
  const result = {};
  const rows = _db.exec('SELECT key, value FROM settings');
  if (rows.length > 0) {
    for (const row of rows[0].values) {
      result[row[0]] = _parseValue(row[1]);
    }
  }
  return result;
}

function setMany(entries) {
  if (!_db) return;
  for (const { key, value, category } of entries) {
    const cat = category || SETTINGS_SCHEMA[key]?.category || 'general';
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    _db.run(
      'INSERT OR REPLACE INTO settings (key, value, category, updated_at) VALUES (?, ?, ?, ?)',
      [key, encoded, cat, Date.now()]
    );
  }
  save();
}

function del(key) {
  if (!_db) return;
  _db.run('DELETE FROM settings WHERE key = ?', [key]);
  _scheduleSave();
}

// ── Sessions ─────────────────────────────────────

function getSession(projectDir) {
  if (!_db) return null;
  const stmt = _db.prepare('SELECT session_id, timestamp FROM sessions WHERE project_dir = ?');
  stmt.bind([projectDir]);
  let result = null;
  if (stmt.step()) {
    const row = stmt.get();
    result = { sessionId: row[0], timestamp: row[1] };
  }
  stmt.free();
  return result;
}

function setSession(projectDir, sessionId) {
  if (!_db) return;
  _db.run(
    'INSERT OR REPLACE INTO sessions (project_dir, session_id, timestamp) VALUES (?, ?, ?)',
    [projectDir, sessionId, Date.now()]
  );
  _scheduleSave();
}

function deleteSession(projectDir) {
  if (!_db) return;
  _db.run('DELETE FROM sessions WHERE project_dir = ?', [projectDir]);
  _scheduleSave();
}

function getAllSessions() {
  if (!_db) return {};
  const result = {};
  const rows = _db.exec('SELECT project_dir, session_id, timestamp FROM sessions');
  if (rows.length > 0) {
    for (const row of rows[0].values) {
      result[row[0]] = { sessionId: row[1], timestamp: row[2] };
    }
  }
  return result;
}

function pruneSessionsOlderThan(ms) {
  if (!_db) return;
  const cutoff = Date.now() - ms;
  _db.run('DELETE FROM sessions WHERE timestamp < ?', [cutoff]);
  _scheduleSave();
}

// ── Config Object (backward compat) ──────────────

function buildConfigObject(existingConfig) {
  const all = getAll();
  const config = {};
  // Preserve dynamic keys from existing config (not in schema, not sessions)
  if (existingConfig) {
    for (const [k, v] of Object.entries(existingConfig)) {
      if (!(k in SETTINGS_SCHEMA) && k !== 'sessions' && k !== 'projectTelegram') config[k] = v;
    }
  }
  for (const [dotKey, value] of Object.entries(all)) {
    _setNestedValue(config, dotKey, value);
  }
  // Add sessions
  config.sessions = getAllSessions();
  // Ensure batch.queue is an array
  if (config.batch && typeof config.batch.queue === 'string') {
    try { config.batch.queue = JSON.parse(config.batch.queue); } catch { config.batch.queue = []; }
  }
  // Ensure superpowers.skillChain is an array
  if (config.superpowers && typeof config.superpowers.skillChain === 'string') {
    try { config.superpowers.skillChain = JSON.parse(config.superpowers.skillChain); } catch { config.superpowers.skillChain = []; }
  }
  // Ensure retry.backoffSeconds is an array
  if (config.retry && typeof config.retry.backoffSeconds === 'string') {
    const parsed = config.retry.backoffSeconds.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
    config.retry.backoffSeconds = parsed.length ? parsed : [30, 60, 120];
  }
  // Ensure projectTelegram is an object
  if (typeof config.projectTelegram === 'string') {
    try { config.projectTelegram = JSON.parse(config.projectTelegram); } catch { config.projectTelegram = {}; }
  }
  if (!config.projectTelegram || typeof config.projectTelegram !== 'object') config.projectTelegram = {};
  // Ensure masterTelegram.chatIds is an object
  if (config.masterTelegram && typeof config.masterTelegram.chatIds === 'string') {
    try { config.masterTelegram.chatIds = JSON.parse(config.masterTelegram.chatIds); } catch { config.masterTelegram.chatIds = {}; }
  }
  // Ensure system.recommendedPlugins is an array
  if (config.system && typeof config.system.recommendedPlugins === 'string') {
    try { config.system.recommendedPlugins = JSON.parse(config.system.recommendedPlugins); } catch { config.system.recommendedPlugins = []; }
  }
  // Convert contextGuard.threshold from integer percentage to float (80 → 0.80)
  if (config.contextGuard && config.contextGuard.threshold) {
    config.contextGuard.threshold = config.contextGuard.threshold / 100;
  }
  // Convert contextWindowOverride: 0 means null (auto-detect)
  if (config.contextGuard && config.contextGuard.contextWindowOverride === 0) {
    config.contextGuard.contextWindowOverride = null;
  }
  return config;
}

function syncFromConfigObject(config) {
  const entries = [];
  for (const [dotKey, schema] of Object.entries(SETTINGS_SCHEMA)) {
    let value = _getNestedValue(config, dotKey);
    if (value === undefined) continue;
    // Serialize arrays as strings for DB storage
    if (Array.isArray(value) && (dotKey === 'retry.backoffSeconds')) {
      value = value.join(',');
    }
    if (Array.isArray(value) && (dotKey === 'batch.queue' || dotKey === 'superpowers.skillChain')) {
      value = JSON.stringify(value);
    }
    if (dotKey === 'projectTelegram' && typeof value === 'object' && !Array.isArray(value)) {
      value = JSON.stringify(value);
    }
    if (dotKey === 'masterTelegram.chatIds' && typeof value === 'object' && !Array.isArray(value)) {
      value = JSON.stringify(value);
    }
    // Reverse the threshold conversion: buildConfigObject divides by 100 for runtime,
    // so we must multiply back to store as integer percentage (0.85 → 85)
    if (dotKey === 'contextGuard.threshold' && typeof value === 'number' && value > 0 && value < 1) {
      value = Math.round(value * 100);
    }
    entries.push({ key: dotKey, value, category: schema.category });
  }
  if (entries.length) setMany(entries);

  // Sync sessions
  if (config.sessions && typeof config.sessions === 'object') {
    for (const [dir, entry] of Object.entries(config.sessions)) {
      if (entry?.sessionId) {
        setSession(dir, entry.sessionId);
      }
    }
  }
}

// ── Migration ────────────────────────────────────

function migrateFromJson(configJsonPath) {
  if (!fs.existsSync(configJsonPath)) return null;
  try {
    const raw = fs.readFileSync(configJsonPath, 'utf8');
    const json = JSON.parse(raw);
    syncFromConfigObject(json);

    // Rename to .bak
    const bakPath = configJsonPath + '.bak';
    fs.renameSync(configJsonPath, bakPath);
    console.log(`settings-db: migrated config.json -> ${bakPath}`);
    // Return the full JSON so caller can preserve dynamic keys (e.g. projectTelegram)
    return json;
  } catch (err) {
    console.error('settings-db: migration failed', err.message);
    return null;
  }
}

// ── Persistence ──────────────────────────────────

function _scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    save();
  }, SAVE_DEBOUNCE_MS);
}

function flushSync() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    save();
  }
}

function save() {
  if (!_db || !_dbPath) return;
  try {
    const data = _db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(_dbPath, buffer);
  } catch (err) {
    console.error('settings-db: save failed', err.message);
  }
}

function close() {
  if (_db) {
    flushSync();
    _db.close();
    _db = null;
  }
}

module.exports = {
  SETTINGS_SCHEMA,
  CATEGORY_ORDER,
  init,
  get,
  set,
  getGroup,
  getAll,
  setMany,
  delete: del,
  getSession,
  setSession,
  deleteSession,
  getAllSessions,
  pruneSessionsOlderThan,
  buildConfigObject,
  syncFromConfigObject,
  migrateFromJson,
  save,
  flushSync,
  close,
};

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { TG_UNAUTHORIZED_MSG } = require('./constants');

const TOKEN_TTL_MS = 30 * 60 * 1000;
const REPLY_TOKEN_LEN = 6;

class MasterTelegramBridge {
  constructor(config, sessionManager, workspaceOps) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.workspaceOps = workspaceOps || {};
    this.bot = null;
    this.allowedUsers = [];
    this.chatIds = new Map();
    this.pending = new Map();
    this.consumed = new Map();
    this._started = false;
  }

  async start(decryptedToken, allowedUsers) {
    if (this._started) await this.stop();
    this.allowedUsers = (allowedUsers || []).map(String);
    try {
      this.bot = new TelegramBot(decryptedToken, { polling: { autoStart: false } });
      this._started = true;
      this._pollingDead = false;
      this._loadChatIds();
      this._registerCommands();
      this.bot.on('polling_error', (err) => {
        const msg = err.message || String(err);
        logger.warn('master-telegram', 'Polling error', msg);
        if (msg.includes('409 Conflict') || msg.includes('terminated by other')) {
          this._pollingDead = true;
        }
      });
      await this.bot.startPolling();
      logger.info('master-telegram', 'Master bot started (polling mode)');
    } catch (err) {
      logger.error('master-telegram', 'Failed to start master bot', err);
      this._started = false;
    }
  }

  async stop() {
    if (this.bot) {
      try { await this.bot.stopPolling({ cancel: true, reason: 'MasterTelegramBridge stop' }); } catch {}
      this.bot = null;
    }
    this._started = false;
    this._pollingDead = false;
    this.pending.clear();
    this.consumed.clear();
    logger.info('master-telegram', 'Master bot stopped');
  }

  get isRunning() { return this._started && this.bot !== null && !this._pollingDead; }

  _isAuthorized(msg) {
    if (!this.allowedUsers.length) return false;
    const from = msg.from;
    if (!from) return false;
    return this.allowedUsers.includes(String(from.id)) || this.allowedUsers.includes(from.username);
  }

  _rejectUnauthorized(msg) {
    if (!this.bot) return;
    this.bot.sendMessage(msg.chat.id, TG_UNAUTHORIZED_MSG).catch(() => {});
    logger.info('master-telegram', `Rejected unauthorized user: ${msg.from?.username || msg.from?.id}`);
  }

  _registerCommands() {
    // Register command menu with Telegram
    this.bot.setMyCommands([
      { command: 'start', description: 'Connect to master bot' },
      { command: 'list', description: 'List all workspace projects' },
      { command: 'status', description: 'Show running sessions status' },
      { command: 'open', description: 'Open a project (auto-starts bot)' },
      { command: 'close', description: 'Close a project tab' },
      { command: 'help', description: 'List all commands' },
    ]).catch(() => {});

    this.bot.onText(/^\/list(?:\s+(.*))?$/i, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      if (match[1] && match[1].trim()) {
        this._send(msg.chat.id, 'Usage: /list');
        return;
      }
      this._send(msg.chat.id, this._formatList());
    });

    this.bot.onText(/^\/status(?:\s+(.*))?$/i, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      if (match[1] && match[1].trim()) {
        this._send(msg.chat.id, 'Usage: /status');
        return;
      }
      this._send(msg.chat.id, this._formatStatus());
    });

    this.bot.onText(/^\/start(?:\s+(.*))?$/i, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const operand = (match[1] || '').trim();
      if (!operand) {
        const key = msg.from.username || String(msg.from.id);
        this.chatIds.set(key, msg.chat.id);
        this._persistChatIds();
        this.bot.sendMessage(msg.chat.id,
          '✅ Master bot connected.\n\n/list — workspace projects\n/open <name> — open project\n/status — session overview\n/help — all commands')
          .catch(() => {});
        return;
      }
      const resolved = this._resolveTab(operand);
      if (!resolved.ok) {
        this._send(msg.chat.id, resolved.error);
        return;
      }
      const tabId = resolved.tabId;
      const session = this.sessionManager.get(tabId);
      if (!session) {
        this._send(msg.chat.id, `Unable to start ${tabId}: session not found.`);
        return;
      }
      if (session.state.running) {
        this._send(msg.chat.id, `Tab ${tabId} already running.`);
        return;
      }
      this.sessionManager.start(tabId, 'continue');
      this._send(msg.chat.id, `Started tab ${tabId}.`);
    });

    this.bot.onText(/^\/stop(?:\s+(.*))?$/i, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const operand = (match[1] || '').trim();
      if (!operand) {
        this._send(msg.chat.id, 'Usage: /stop <tab>');
        return;
      }
      const resolved = this._resolveTab(operand);
      if (!resolved.ok) {
        this._send(msg.chat.id, resolved.error);
        return;
      }
      const tabId = resolved.tabId;
      const session = this.sessionManager.get(tabId);
      if (!session) {
        this._send(msg.chat.id, `Unable to stop ${tabId}: session not found.`);
        return;
      }
      this.sessionManager.stop(tabId)
        .then(() => this._send(msg.chat.id, `Stopped tab ${tabId}.`))
        .catch((err) => this._send(msg.chat.id, `Failed to stop ${tabId}: ${err?.message || 'unknown error'}.`));
    });

    this.bot.onText(/^\/close(?:\s+(.*))?$/i, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const operand = (match[1] || '').trim();
      if (!operand) {
        this._send(msg.chat.id, 'Usage: /close <project-name or tab-id>');
        return;
      }
      const resolved = this._resolveTab(operand);
      if (!resolved.ok) {
        this._send(msg.chat.id, resolved.error);
        return;
      }
      if (typeof this.workspaceOps.closeProject !== 'function') {
        this._send(msg.chat.id, 'Close-project handler unavailable.');
        return;
      }
      this.workspaceOps.closeProject(resolved.tabId)
        .then((result) => {
          if (!result?.ok) {
            this._send(msg.chat.id, `Failed to close: ${result?.error || 'unknown error'}.`);
            return;
          }
          this._send(msg.chat.id, `✅ Closed ${result.projectName || '(unknown)'}`);
        })
        .catch((err) => this._send(msg.chat.id, `Failed to close: ${err?.message || 'unknown error'}.`));
    });

    this.bot.onText(/^\/open(?:\s+(.*))?$/i, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const operand = (match[1] || '').trim();
      if (!operand) {
        this._send(msg.chat.id, 'Usage: /open <name>');
        return;
      }
      if (typeof this.workspaceOps.openProject !== 'function') {
        this._send(msg.chat.id, 'Open-project handler unavailable.');
        return;
      }
      this.workspaceOps.openProject(operand)
        .then(async (result) => {
          if (!result?.ok) {
            this._send(msg.chat.id, `Failed to open project ${operand}: ${result?.error || 'unknown error'}.`);
            return;
          }
          let botStatus = '';
          // Auto-start project bot if configured
          if (typeof this.workspaceOps.startProjectBot === 'function') {
            try {
              const bot = await this.workspaceOps.startProjectBot(result.projectPath, result.tabId);
              botStatus = bot ? '\n🤖 Project bot started' : '\n⚪ No bot token configured';
            } catch (e) {
              botStatus = `\n⚠ Bot start failed: ${e.message}`;
            }
          }
          this._send(msg.chat.id, `✅ Opened ${result.projectName}${botStatus}`);
        })
        .catch((err) => this._send(msg.chat.id, `Failed to open project ${operand}: ${err?.message || 'unknown error'}.`));
    });

    this.bot.onText(/^\/new(?:\s+(.*))?$/i, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const operand = (match[1] || '').trim();
      if (!operand) {
        this._send(msg.chat.id, 'Usage: /new <name>');
        return;
      }
      if (typeof this.workspaceOps.newProject !== 'function') {
        this._send(msg.chat.id, 'New-project handler unavailable.');
        return;
      }
      this.workspaceOps.newProject(operand)
        .then((result) => {
          if (!result?.ok) {
            this._send(msg.chat.id, `Failed to create project ${operand}: ${result?.error || 'unknown error'}.`);
            return;
          }
          this._send(msg.chat.id, `✅ Created ${result.projectName}`);
        })
        .catch((err) => this._send(msg.chat.id, `Failed to create project ${operand}: ${err?.message || 'unknown error'}.`));
    });

    this.bot.onText(/^\/reply(?:\s+(.*))?$/i, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const payload = (match[1] || '').trim();
      if (!payload) {
        this._send(msg.chat.id, 'Usage: /reply <token> <text>');
        return;
      }
      const parts = payload.split(/\s+/);
      const token = (parts.shift() || '').trim();
      const text = parts.join(' ').trim();
      if (!token || !text) {
        this._send(msg.chat.id, 'Usage: /reply <token> <text>');
        return;
      }
      const now = Date.now();
      this._pruneExpired(now);
      this._pruneConsumed(now);
      const entry = this.pending.get(token);
      if (!entry) {
        if (this.consumed.has(token)) {
          this._send(msg.chat.id, `Consumed token: ${token}.`);
        } else {
          this._send(msg.chat.id, `Unknown token: ${token}.`);
        }
        return;
      }
      if (entry.expiresAt <= now) {
        this.pending.delete(token);
        this._send(msg.chat.id, `Expired token: ${token}.`);
        return;
      }
      const session = this.sessionManager.get(entry.tabId);
      if (!session?.proxy) {
        this._send(msg.chat.id, `Failed to route token ${token}: target tab ${entry.tabId} is not accepting replies.`);
        return;
      }
      this.sessionManager.sendResponse(entry.tabId, text);
      this.pending.delete(token);
      this.consumed.set(token, now + TOKEN_TTL_MS);
      this._send(msg.chat.id, `Routed reply ${token} to tab ${entry.tabId}.`);
    });

    // /help -- list commands
    this.bot.onText(/^\/help$/i, (msg) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      this._send(msg.chat.id,
        '🤖 Auto Claude Master Bot\n\n'
        + '/list — List all workspace projects\n'
        + '/open <name> — Open project + start its bot\n'
        + '/close <name> — Close a project tab\n'
        + '/new <name> — Create new project\n'
        + '/status — Running sessions overview\n'
        + '/stop <name> — Stop a running session\n'
        + '/reply <token> <text> — Answer a forwarded question\n'
        + '/help — This message'
      );
    });

  }

  _send(chatId, text) {
    if (!this.bot) return;
    this.bot.sendMessage(chatId, text).catch(() => {});
  }

  _allChatIds() {
    const seen = new Set();
    const ids = [];
    for (const [, chatId] of this.chatIds) {
      if (seen.has(chatId)) continue;
      seen.add(chatId);
      ids.push(chatId);
    }
    return ids;
  }

  _persistChatIds() {
    if (!this.config.masterTelegram) this.config.masterTelegram = {};
    const saved = {};
    for (const [key, chatId] of this.chatIds) saved[key] = chatId;
    this.config.masterTelegram.chatIds = saved;
    if (this.sessionManager) this.sessionManager.emit('save-config');
  }

  _loadChatIds() {
    const saved = this.config.masterTelegram?.chatIds;
    if (saved && typeof saved === 'object') {
      for (const [key, chatId] of Object.entries(saved)) {
        this.chatIds.set(key, chatId);
      }
    }
  }

  _normalizeAlias(state, projectDir, tabId) {
    if (typeof state.alias === 'string' && state.alias.trim()) return state.alias.trim();
    if (typeof state.projectAlias === 'string' && state.projectAlias.trim()) return state.projectAlias.trim();
    if (projectDir) return path.basename(projectDir);
    return `tab-${tabId}`;
  }

  _isWorkspaceProject(state) {
    const rawRoot = typeof this.config?.workspaceRoot === 'string' ? this.config.workspaceRoot.trim() : '';
    const projectDir = typeof state?.projectDir === 'string' ? state.projectDir.trim() : '';
    if (!rawRoot || !projectDir) return false;
    const root = path.resolve(rawRoot);
    const full = path.resolve(projectDir);
    const rel = path.relative(root, full);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }


  _rows() {
    const rows = [];
    const openPaths = new Set(); // track which workspace paths are already open as tabs
    for (const [tabId, session] of this.sessionManager.sessions) {
      const state = this.sessionManager.getState(tabId) || session.state || {};
      if (!this._isWorkspaceProject(state)) continue;
      openPaths.add(path.resolve(state.projectDir));
      rows.push({
        tabId,
        alias: this._normalizeAlias(state, state.projectDir, tabId),
        project: state.projectDir ? path.basename(state.projectDir) : '(none)',
        state: this._stateLabel(state, session.waitingForAnswer),
      });
    }
    rows.sort((a, b) => a.project.localeCompare(b.project));
    return { rows, openPaths };
  }

  _scanWorkspaceProjects() {
    const rawRoot = typeof this.config?.workspaceRoot === 'string' ? this.config.workspaceRoot.trim() : '';
    if (!rawRoot) return [];
    const root = path.resolve(rawRoot);
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, fullPath: path.resolve(root, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  }

  _formatList() {
    const { rows, openPaths } = this._rows();
    const allProjects = this._scanWorkspaceProjects();
    if (!allProjects.length && !rows.length) return 'No projects found. Check workspace root setting.';

    const lines = ['📂 Workspace Projects:\n'];
    for (const proj of allProjects) {
      const openRow = rows.find(r => path.resolve(this.config.workspaceRoot, r.project) === proj.fullPath
        || r.project === proj.name);
      if (openRow) {
        const icon = openRow.state === 'running' ? '🟢' : openRow.state === 'waiting' ? '🟡' : openRow.state === 'error' ? '🔴' : '⚪';
        lines.push(`${icon} ${proj.name} — ${openRow.state}`);
      } else {
        lines.push(`— ${proj.name}`);
      }
    }
    // Include any open tabs not in workspace scan (edge case)
    for (const row of rows) {
      const inScan = allProjects.some(p => p.name === row.project);
      if (!inScan) {
        const icon = row.state === 'running' ? '🟢' : row.state === 'waiting' ? '🟡' : row.state === 'error' ? '🔴' : '⚪';
        lines.push(`${icon} ${row.project} — ${row.state} (external)`);
      }
    }
    lines.push('\nUse /open <name> to open a project.');
    return lines.join('\n');
  }

  _stateLabel(state, waitingForAnswer) {
    if (state.activityType === 'error') return 'error';
    if (waitingForAnswer || state.activityType === 'waiting') return 'waiting';
    if (state.running) return 'running';
    return 'idle';
  }

  _formatStatus() {
    const { rows } = this._rows();
    const counts = { running: 0, idle: 0, waiting: 0, error: 0 };
    for (const row of rows) {
      if (row.state === 'running') counts.running += 1;
      else if (row.state === 'waiting') counts.waiting += 1;
      else if (row.state === 'error') counts.error += 1;
      else counts.idle += 1;
    }
    return `Status: running=${counts.running}, idle=${counts.idle}, waiting=${counts.waiting}, error=${counts.error}`;
  }

  _resolveTab(operand) {
    const key = operand.trim();
    if (!key) return { ok: false, error: 'Tab target is required.' };
    const byId = this.sessionManager.get(key);
    if (byId) return { ok: true, tabId: key, via: 'id' };

    const { rows } = this._rows();
    const aliasMatches = rows.filter(r => r.alias.toLowerCase() === key.toLowerCase());
    if (aliasMatches.length === 1) return { ok: true, tabId: aliasMatches[0].tabId, via: 'alias' };
    if (aliasMatches.length > 1) {
      return {
        ok: false,
        error: `ambiguous alias "${key}". Use /list and target by tab ID.`,
      };
    }
    return { ok: false, error: `Unknown tab target: ${key}. Use /list to view IDs.` };
  }

  _newToken() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 10; i++) {
      let token = '';
      for (let n = 0; n < REPLY_TOKEN_LEN; n++) {
        token += chars[Math.floor(Math.random() * chars.length)];
      }
      if (!this.pending.has(token)) return token;
    }
    return `${Date.now().toString(36).toUpperCase().slice(-REPLY_TOKEN_LEN)}`;
  }

  _pruneExpired(now = Date.now()) {
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(token);
    }
  }

  _pruneConsumed(now = Date.now()) {
    for (const [token, expiresAt] of this.consumed) {
      if (expiresAt <= now) this.consumed.delete(token);
    }
  }

  forwardQuestion(tabInfo, questionPayload) {
    if (!this.bot || !this.isRunning) return;
    const tabId = tabInfo?.tabId;
    if (!tabId) return;
    this._pruneExpired();
    const token = this._newToken();
    const createdAt = Date.now();
    const entry = {
      tabId,
      createdAt,
      expiresAt: createdAt + TOKEN_TTL_MS,
    };
    this.pending.set(token, entry);

    const state = tabInfo.state || {};
    const alias = this._normalizeAlias(state, tabInfo.projectDir, tabId);
    const label = state.projectDir ? path.basename(state.projectDir) : '(none)';
    const questionText = questionPayload?.questionText || 'Claude needs input.';
    const msg = [
      `[${tabId} | ${alias} | ${label}] Question`,
      questionText,
      `Reply token: ${token}`,
      'Usage: /reply <token> <text>',
    ].join('\n');

    for (const chatId of this._allChatIds()) {
      this._send(chatId, msg);
    }
  }
}

module.exports = MasterTelegramBridge;

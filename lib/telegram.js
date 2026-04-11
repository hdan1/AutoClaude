// lib/telegram.js -- TelegramBridge: Telegram bot integration for Auto Claude
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const logger = require('./logger');
const { TG_BUFFER_FLUSH_MS, TG_MAX_MESSAGE_LENGTH, TG_UNAUTHORIZED_MSG } = require('./constants');
const { extractQuestions } = require('./question-utils');

// Log streaming modes
const STREAM_OFF = 'off';          // no live streaming
const STREAM_IMPORTANT = 'important'; // only system, errors, questions, auto-answers
const STREAM_LIVE = 'live';        // everything (like the dashboard console)

const IMPORTANT_LOG_TYPES = new Set(['system', 'stderr', 'user-input', 'auto-answer']);
const TOOL_EMOJI = { Read: '📖', Write: '✏️', Edit: '✏️', Bash: '💻', Glob: '🔍', Grep: '🔍', Agent: '🤖', WebFetch: '🌐', WebSearch: '🌐', LSP: '🧠' };

class TelegramBridge {
  constructor(config, sessionManager, projectDir) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.projectDir = projectDir || '';
    this.bot = null;
    this.chatIds = new Map();       // username|id -> chatId
    this.buffers = new Map();       // chatId -> accumulated text
    this.flushInterval = null;
    this.allowedUsers = [];         // array of strings (usernames or numeric IDs)
    this._started = false;
    this._eventHandlers = [];       // track SM event subscriptions for cleanup
    this._streamMode = STREAM_LIVE; // default: live streaming (all logs)
  }

  get projectLabel() { return this.projectDir ? path.basename(this.projectDir) : 'unknown'; }

  async start(decryptedToken, allowedUsers) {
    if (this._started) await this.stop();
    this.allowedUsers = (allowedUsers || []).map(String);
    this.token = decryptedToken;
    try {
      // Create bot WITHOUT auto-starting polling so we can register error handlers first
      this.bot = new TelegramBot(decryptedToken, { polling: { autoStart: false } });
      this._started = true;
      this._pollingDead = false;
      this._loadChatIds();
      this._registerCommands();
      this._registerCallbackQuery();
      this._startBufferFlush();
      this._subscribeSessionEvents();
      this.bot.on('polling_error', (err) => {
        const msg = err.message || String(err);
        logger.warn('telegram', 'Polling error', msg);
        if (msg.includes('409 Conflict') || msg.includes('terminated by other')) {
          this._pollingDead = true;
        }
      });
      // Now start polling after all handlers are registered
      await this.bot.startPolling();
      logger.info('telegram', 'Bot started (polling mode)');
    } catch(e) {
      logger.error('telegram', 'Failed to start bot', e);
      this._started = false;
    }
  }

  async stop() {
    if (this.flushInterval) { clearInterval(this.flushInterval); this.flushInterval = null; }
    if (this.bot) {
      try { await this.bot.stopPolling({ cancel: true, reason: 'TelegramBridge stop' }); } catch(e) {}
      this.bot = null;
    }
    this._unsubscribeSessionEvents();
    this._started = false;
    this._pollingDead = false;
    this.buffers.clear();
    logger.info('telegram', 'Bot stopped');
  }

  get isRunning() { return this._started && this.bot !== null && !this._pollingDead; }

  // -- Persist/Load Chat IDs --------------------------------
  _persistChatIds() {
    if (!this.projectDir || !this.config.projectTelegram) return;
    const resolved = path.resolve(this.projectDir);
    if (!this.config.projectTelegram[resolved]) return;
    const saved = {};
    for (const [key, chatId] of this.chatIds) saved[key] = chatId;
    this.config.projectTelegram[resolved].chatIds = saved;
    this.sessionManager.emit('save-config');
  }

  _loadChatIds() {
    if (!this.projectDir || !this.config.projectTelegram) return;
    const resolved = path.resolve(this.projectDir);
    const saved = this.config.projectTelegram[resolved]?.chatIds;
    if (saved && typeof saved === 'object') {
      for (const [key, chatId] of Object.entries(saved)) {
        this.chatIds.set(key, chatId);
      }
    }
  }

  seedChatIds(chatIdsMap) {
    if (!chatIdsMap || typeof chatIdsMap !== 'object') return;
    let added = false;
    for (const [key, chatId] of (chatIdsMap instanceof Map ? chatIdsMap : Object.entries(chatIdsMap))) {
      if (!this.chatIds.has(key)) {
        this.chatIds.set(key, chatId);
        added = true;
      }
    }
    if (added) this._persistChatIds();
  }

  // -- Auth -------------------------------------------------
  _isAuthorized(msg) {
    if (!this.allowedUsers.length) return false;
    const from = msg.from;
    if (!from) return false;
    return this.allowedUsers.includes(String(from.id))
        || this.allowedUsers.includes(from.username);
  }

  _rejectUnauthorized(msg) {
    if (!this.bot) return;
    this.bot.sendMessage(msg.chat.id, TG_UNAUTHORIZED_MSG).catch(() => {});
    logger.info('telegram', `Rejected unauthorized user: ${msg.from?.username || msg.from?.id}`);
  }

  // -- Command Handlers -------------------------------------
  _registerCommands() {
    // Register command menu with Telegram so users see commands when typing /
    this.bot.setMyCommands([
      { command: 'start', description: 'Connect + start session [prompt]' },
      { command: 'status', description: 'Show session status' },
      { command: 'stop', description: 'Stop the running session' },
      { command: 'live', description: 'Toggle log streaming: off/important/live' },
      { command: 'logs', description: 'Show recent log output' },
      { command: 'autonomy', description: 'Toggle full autonomy on/off' },
      { command: 'help', description: 'List all commands' },
    ]).catch(() => {});

    // Helper: find the tabId for this project's bot
    const _findTabId = () => {
      for (const [tabId, session] of this.sessionManager.sessions) {
        if (session.state.projectDir && path.resolve(session.state.projectDir) === path.resolve(this.projectDir)) {
          return tabId;
        }
      }
      return null;
    };

    // /start [prompt] -- connect + optionally start session
    this.bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const chatId = msg.chat.id;
      const key = msg.from.username || String(msg.from.id);
      this.chatIds.set(key, chatId);
      this._persistChatIds();
      const tabId = _findTabId();
      const session = tabId ? this.sessionManager.get(tabId) : null;
      const s = session?.state;
      const prompt = match[1]?.trim();

      if (!tabId || !session) {
        this.bot.sendMessage(chatId, `✅ Connected to ${this.projectLabel}\n⚪ No active session. Open the project in Auto Claude first.`).catch(() => {});
        return;
      }

      if (s?.running) {
        // Already running — just connect and show status
        this.bot.sendMessage(chatId,
          `✅ Connected to ${this.projectLabel}\n🟢 Already running\nStep: ${s.currentStep || '-'}`
        ).catch(() => {});
        return;
      }

      // Not running — start session (reset metrics tracking)
      this._ttftHistory = [];
      this._lastTtft = null;
      this._lastModel = null;
      this._lastInputTokens = null;
      this._lastOutputTokens = null;
      this._lastCostUsd = null;
      const defaultPrompt = this.config.defaultPrompt || 'continue';
      const usePrompt = prompt || defaultPrompt;
      this.sessionManager.start(tabId, usePrompt);
      this.bot.sendMessage(chatId,
        `✅ Connected to ${this.projectLabel}\n▶️ Starting session\nPrompt: ${usePrompt.substring(0, 100)}`
      ).catch(() => {});
    });

    // /status -- show session status (no tabId needed)
    this.bot.onText(/\/status/, (msg) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const chatId = msg.chat.id;
      const tabId = _findTabId();
      if (!tabId) { this.bot.sendMessage(chatId, `📊 ${this.projectLabel}: No active session`).catch(() => {}); return; }
      const s = this.sessionManager.getState(tabId);
      if (!s) { this.bot.sendMessage(chatId, `📊 ${this.projectLabel}: No session data`).catch(() => {}); return; }
      // Compute elapsed from startTime
      let elapsed = '-';
      if (s.startTime) {
        const sec = Math.floor((Date.now() - s.startTime) / 1000);
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = sec % 60;
        elapsed = h > 0 ? `${h}h ${m}m` : `${m}m ${ss}s`;
      }
      // Get model from state (populated on session-init)
      const model = s.model || this._lastModel || '-';
      const effort = this.config?.session?.effort || 'auto';
      const effortLine = effort !== 'auto' ? `\nEffort: ${effort}` : '';
      // TTFT stats
      let ttftLine = '';
      if (this._ttftHistory && this._ttftHistory.length > 0) {
        const last = (this._lastTtft / 1000).toFixed(2);
        const avg = (this._ttftHistory.reduce((a, b) => a + b, 0) / this._ttftHistory.length / 1000).toFixed(2);
        const min = (Math.min(...this._ttftHistory) / 1000).toFixed(2);
        const max = (Math.max(...this._ttftHistory) / 1000).toFixed(2);
        ttftLine = `\nTTFT: ${last}s (avg ${avg}s, min ${min}s, max ${max}s, ${this._ttftHistory.length} turns)`;
      }
      // Use real-time token data if available
      const tokIn = this._lastInputTokens || s.totalInputTokens || 0;
      const tokOut = this._lastOutputTokens || s.totalOutputTokens || 0;
      this.bot.sendMessage(chatId,
        `📊 ${this.projectLabel}\n`
        + `Status: ${s.running ? '🟢 Running' : '⚪ Idle'}\n`
        + `Step: ${s.currentStep || '-'}\n`
        + `Model: ${model}\n`
        + (effortLine ? effortLine + '\n' : '')
        + `Tokens: ${tokIn} in / ${tokOut} out\n`
        + `Elapsed: ${elapsed}`
        + ttftLine
      ).catch(() => {});
    });

    // /stop -- stop session (no tabId needed)
    this.bot.onText(/\/stop/, (msg) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const chatId = msg.chat.id;
      const tabId = _findTabId();
      if (!tabId) { this.bot.sendMessage(chatId, `No active session for ${this.projectLabel}`).catch(() => {}); return; }
      const session = this.sessionManager.get(tabId);
      if (!session?.state?.running) { this.bot.sendMessage(chatId, `Session already stopped.`).catch(() => {}); return; }
      this.sessionManager.stop(tabId);
      this.bot.sendMessage(chatId, `⏹ Stopped: ${this.projectLabel}`).catch(() => {});
    });

    // /answer <text> -- answer a question (no tabId needed)
    this.bot.onText(/\/answer\s+(.+)/, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const chatId = msg.chat.id;
      const answerText = match[1];
      const tabId = _findTabId();
      if (!tabId) { this.bot.sendMessage(chatId, `No active session.`).catch(() => {}); return; }
      this.sessionManager.sendResponse(tabId, answerText);
      this.bot.sendMessage(chatId, `📝 Answer sent: ${answerText.substring(0, 100)}`).catch(() => {});
    });

    // /logs [N] -- show recent output (no tabId needed)
    this.bot.onText(/\/logs(?:\s+(\d+))?/, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const chatId = msg.chat.id;
      const n = parseInt(match[1] || '20', 10);
      const tabId = _findTabId();
      if (!tabId) { this.bot.sendMessage(chatId, `No active session.`).catch(() => {}); return; }
      this.sessionManager.emit('get-logs', { tabId, count: n, callback: (lines) => {
        const text = lines.length ? lines.join('\n').substring(0, 4000) : 'No logs available.';
        this.bot.sendMessage(chatId, `📋 Last ${n} lines:\n${text}`).catch(() => {});
      }});
    });

    // /live [off|important|live] -- toggle log streaming mode
    this.bot.onText(/\/live(?:\s+(off|important|live))?/, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const chatId = msg.chat.id;
      const val = match[1];
      if (val) {
        this._streamMode = val;
        const labels = { off: '🔴 OFF', important: '🟡 Important only', live: '🟢 Live (all)' };
        this.bot.sendMessage(chatId, `Log streaming: ${labels[val]}`).catch(() => {});
      } else {
        const labels = { off: '🔴 OFF', important: '🟡 Important only', live: '🟢 Live (all)' };
        this.bot.sendMessage(chatId, `Log streaming: ${labels[this._streamMode] || this._streamMode}\n\nUsage: /live off | /live important | /live live`).catch(() => {});
      }
    });

    // /autonomy [on|off] -- toggle full autonomy
    this.bot.onText(/\/autonomy(?:\s+(on|off))?/, (msg, match) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const chatId = msg.chat.id;
      const val = match[1];
      if (val) {
        const enabled = val === 'on';
        if (!this.config.autoAnswer) this.config.autoAnswer = {};
        this.config.autoAnswer.fullAutonomy = enabled;
        this.config.autoAnswer.derailmentCorrection = enabled;
        this.sessionManager.emit('save-config');
        this.bot.sendMessage(chatId, `Full autonomy: ${enabled ? '🟢 ON' : '🔴 OFF'}`).catch(() => {});
      } else {
        const current = this.config.autoAnswer?.fullAutonomy ? '🟢 ON' : '🔴 OFF';
        this.bot.sendMessage(chatId, `Full autonomy: ${current}`).catch(() => {});
      }
    });

    // /help -- list commands
    this.bot.onText(/\/help/, (msg) => {
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      this.bot.sendMessage(msg.chat.id,
        `🤖 Auto Claude — ${this.projectLabel}\n\n`
        + '/start [prompt] - Connect + start session\n'
        + '/status - Session status\n'
        + '/stop - Stop session\n'
        + '/answer <text> - Answer a question\n'
        + '/live [off|important|live] - Log streaming mode\n'
        + '/logs [N] - Show last N log lines\n'
        + '/autonomy [on|off] - Toggle autonomy\n'
        + '/help - This message\n'
        + '\nOr just type a message to send it to the running session.'
      ).catch(() => {});
    });

    // Plain text messages (non-commands) → forward to running session
    this.bot.on('message', async (msg) => {
      const hasPhoto = msg.photo && msg.photo.length > 0;
      const hasDocument = msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/');
      if (!hasPhoto && !hasDocument && (!msg.text || msg.text.startsWith('/'))) return; // skip commands
      if (!this._isAuthorized(msg)) { this._rejectUnauthorized(msg); return; }
      const chatId = msg.chat.id;
      const key = msg.from.username || String(msg.from.id);
      if (!this.chatIds.has(key)) { this.chatIds.set(key, chatId); this._persistChatIds(); }
      const tabId = _findTabId();
      if (!tabId) { this.bot.sendMessage(chatId, `No active session for ${this.projectLabel}`).catch(() => {}); return; }
      const session = this.sessionManager.get(tabId);
      if (!session?.state?.running) {
        this.bot.sendMessage(chatId, `⚪ Session not running. Use /start to begin.`).catch(() => {});
        return;
      }

      // Handle photo/image messages
      if (hasPhoto || hasDocument) {
        try {
          let fileId;
          if (hasPhoto) {
            // Telegram sends multiple sizes — pick the largest
            fileId = msg.photo[msg.photo.length - 1].file_id;
          } else {
            fileId = msg.document.file_id;
          }
          const file = await this.bot.getFile(fileId);
          const fileUrl = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
          const ext = path.extname(file.file_path) || '.jpg';
          const imgDir = path.join(os.tmpdir(), 'auto-claude-images', tabId);
          if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
          const imgPath = path.join(imgDir, `tg-${Date.now()}${ext}`);

          // Download the file
          await new Promise((resolve, reject) => {
            const transport = fileUrl.startsWith('https') ? https : http;
            transport.get(fileUrl, (res) => {
              const ws = fs.createWriteStream(imgPath);
              res.pipe(ws);
              ws.on('finish', () => { ws.close(); resolve(); });
              ws.on('error', reject);
            }).on('error', reject);
          });

          const caption = msg.caption || '';
          const prompt = `[Attached image from Telegram — use your Read tool to view this file:]\n- ${imgPath}\n\n${caption}`.trim();
          this.sessionManager.sendResponse(tabId, prompt);
          this.bot.sendMessage(chatId, `📷 Image sent to Claude${caption ? ': ' + caption.substring(0, 80) : ''}`).catch(() => {});
        } catch (e) {
          logger.warn('telegram', `Photo download failed: ${e.message}`);
          this.bot.sendMessage(chatId, `❌ Failed to process image: ${e.message}`).catch(() => {});
        }
        return;
      }

      // Plain text
      this.sessionManager.sendResponse(tabId, msg.text);
      this.bot.sendMessage(chatId, `📝 Sent to Claude: ${msg.text.substring(0, 100)}`).catch(() => {});
    });
  }

  // -- Callback Query (Inline Keyboard) ---------------------
  _registerCallbackQuery() {
    this.bot.on('callback_query', (query) => {
      try {
        const data = JSON.parse(query.data);

        // Critical question resolver
        if (data.cr) {
          if (this._criticalResolvers?.[data.cr]) {
            const answer = data.a || String(data.i);
            this.bot.answerCallbackQuery(query.id, { text: `Answered: ${answer}` }).catch(() => {});
            this._criticalResolvers[data.cr](answer);
          } else {
            // Resolver expired (timed out) — notify user the button is stale
            this.bot.answerCallbackQuery(query.id, { text: '\u23f0 This question already timed out', show_alert: true }).catch(() => {});
          }
          return;
        }

        // Regular question callback (existing behavior)
        const tabId = data.tab || data.t;
        const optIdx = data.idx || data.i;
        this.bot.answerCallbackQuery(query.id, { text: `Selected option ${optIdx}` }).catch(() => {});
        this.sessionManager.sendResponse(tabId, String(optIdx));
        this.bot.editMessageText(`Selected: Option ${optIdx}`, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }).catch(() => {});
      } catch(e) {
        logger.warn('telegram', 'callback_query parse error', e);
      }
    });
  }

  // -- Formatted Log Forwarding -----------------------------
  _ts() {
    const now = new Date();
    return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
  }

  forwardLog(logType, text) {
    if (this._streamMode === STREAM_OFF) return;
    if (this._streamMode === STREAM_IMPORTANT && !IMPORTANT_LOG_TYPES.has(logType)) return;
    const prefix = logType === 'stderr' ? '❌'
      : logType === 'system' ? 'ℹ️'
      : logType === 'user-input' ? ''
      : logType === 'auto-answer' ? '🤖' : '';
    const line = `${this._ts()}  ${prefix}${prefix ? ' ' : ''}${text}`;
    this.broadcast(line);
  }

  forwardMetrics(data) {
    if (data.ttft != null) {
      this._lastTtft = data.ttft;
      this._ttftHistory = this._ttftHistory || [];
      this._ttftHistory.push(data.ttft);
    }
    if (data.model) this._lastModel = data.model;
    if (data.inputTokens != null) this._lastInputTokens = data.inputTokens;
    if (data.outputTokens != null) this._lastOutputTokens = data.outputTokens;
    if (data.costUsd != null) this._lastCostUsd = data.costUsd;
  }

  forwardProxyEvent(event) {
    if (this._streamMode === STREAM_OFF) return;
    if (this._streamMode === STREAM_IMPORTANT) return; // proxy events only in live mode
    if (event.type === 'tool_use') {
      const emoji = TOOL_EMOJI[event.name] || '⚡';
      const input = (event.input || '').replace(/\n/g, ' ').substring(0, 120);
      this._lastToolLine = `${this._ts()}  ${emoji} ${event.name}  ${input}`;
      this.broadcast(this._lastToolLine);
    } else if (event.type === 'tool_result') {
      const mark = event.isError ? ' ✗' : ' ✓';
      // Append mark to the last tool line in the buffer, or broadcast standalone
      let anyAppended = false;
      for (const [, chatId] of this.chatIds) {
        const existing = this.buffers.get(chatId) || '';
        if (existing) {
          // Find the last newline and append mark to the last line
          const lastNewline = existing.lastIndexOf('\n');
          if (lastNewline >= 0 && lastNewline < existing.length - 1) {
            this.buffers.set(chatId, existing + mark);
          } else if (lastNewline === -1) {
            this.buffers.set(chatId, existing + mark);
          } else {
            // Buffer ends with newline — mark goes on a new standalone line
            this.buffers.set(chatId, existing + mark + '\n');
          }
          anyAppended = true;
        }
      }
      // If buffer was already flushed for all chats, broadcast the mark standalone
      if (!anyAppended && this._lastToolLine) {
        this.broadcast(mark);
      }
    } else if (event.type === 'text') {
      // Show abbreviated Claude text output — truncate to avoid flooding
      const raw = (event.text || '').replace(/\n/g, ' ').trim();
      if (raw) {
        const abbreviated = raw.length > 200 ? raw.substring(0, 197) + '…' : raw;
        this.broadcast(`${this._ts()}  ${abbreviated}`);
      }
    }
  }

  forwardHookEvent(event) {
    if (this._streamMode === STREAM_OFF) return;
    if (this._streamMode === STREAM_IMPORTANT) return;
    const isSubagent = !!event.agentId;
    const tool = event.tool || 'unknown';
    const input = (event.input || '').replace(/\n/g, ' ').substring(0, 120);
    const emoji = TOOL_EMOJI[tool] || '⚡';
    const prefix = isSubagent ? '  🔗 [subagent] ' : '  ';
    this.broadcast(`${this._ts()}${prefix}${emoji} ${tool}  ${input}`);
  }

  // -- Rate-Limited Output Buffering ------------------------
  _startBufferFlush() {
    this.flushInterval = setInterval(() => {
      for (const [chatId, text] of this.buffers) {
        if (!text) continue;
        const chunk = text.substring(0, TG_MAX_MESSAGE_LENGTH);
        if (this.bot) {
          this.bot.sendMessage(chatId, chunk).catch(() => {});
        }
        const remaining = text.substring(TG_MAX_MESSAGE_LENGTH);
        if (remaining) this.buffers.set(chatId, remaining);
        else this.buffers.delete(chatId);
      }
    }, TG_BUFFER_FLUSH_MS);
  }

  appendOutput(chatId, text) {
    const existing = this.buffers.get(chatId) || '';
    this.buffers.set(chatId, existing + text);
  }

  // -- Broadcast to all known authorized chat IDs -----------
  broadcast(text) {
    for (const [, chatId] of this.chatIds) {
      this.appendOutput(chatId, text + '\n');
    }
  }

  broadcastDirect(text) {
    if (!this.bot) return;
    for (const [, chatId] of this.chatIds) {
      this.bot.sendMessage(chatId, text).catch(() => {});
    }
  }

  notifyAutoAnswer(tabId, questionData, answer, reason) {
    if (!this.bot) return;
    const qText = questionData?.questions?.[0]?.question || questionData?.question || 'unknown question';
    const short = qText.length > 100 ? qText.substring(0, 100) + '\u2026' : qText;
    this.broadcastDirect(`[\u{1f916} ${tabId}] Auto-answered: ${answer}\nQ: ${short}\nReason: ${reason}`);
  }

  forwardCritical(tabId, questionData, timeoutMs) {
    if (!this.bot) { logger.info('telegram', 'forwardCritical: no bot instance'); return Promise.resolve(null); }
    const { options, questionText, multiSelect } = this._extractQuestionParts(questionData);
    logger.info('telegram', `forwardCritical: tabId=${tabId}, question="${(questionText || '').substring(0, 60)}", chatIds=${this.chatIds.size}, timeout=${timeoutMs}ms`);
    const msgText = `[\u23f3 ${tabId}] Critical question:\n"${questionText || 'Claude needs input'}"\n\nTimeout: ${Math.round(timeoutMs / 1000)}s \u2014 will auto-answer if no response`;

    return new Promise((resolve) => {
      const normalizedOpts = (options || []).map(o => typeof o === 'string' ? o : (o.label || o.value || String(o)));
      const sentMessages = [];
      let resolved = false;
      let timer = null;

      const resolverKey = `${tabId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!this._criticalResolvers) this._criticalResolvers = {};

      const cleanup = () => {
        if (this._criticalResolvers) delete this._criticalResolvers[resolverKey];
        if (timer) { clearTimeout(timer); timer = null; }
      };

      // Register resolver BEFORE sending messages to avoid race condition
      // where user presses button before resolver is registered
      this._criticalResolvers[resolverKey] = (answer) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        for (const { chatId, messageId } of sentMessages) {
          this.bot.editMessageText(`\u2705 [${tabId}] Answered: ${answer}`, {
            chat_id: chatId, message_id: messageId,
          }).catch(() => {});
        }
        resolve(answer);
      };

      const keyboard = [];
      if (normalizedOpts.length > 0 && !multiSelect) {
        for (let i = 0; i < normalizedOpts.length; i++) {
          keyboard.push([{
            text: String(normalizedOpts[i]).substring(0, 60),
            callback_data: JSON.stringify({ cr: resolverKey, i: i + 1 }),
          }]);
        }
      }
      if (keyboard.length === 0) {
        keyboard.push(
          [{ text: '\u2705 Yes, approve', callback_data: JSON.stringify({ cr: resolverKey, a: 'yes' }) }],
          [{ text: '\u274c No, revise', callback_data: JSON.stringify({ cr: resolverKey, a: 'no' }) }],
          [{ text: '\u23ed Skip', callback_data: JSON.stringify({ cr: resolverKey, a: 'skip' }) }]
        );
      }

      const promises = [];
      for (const [, chatId] of this.chatIds) {
        promises.push(
          this.bot.sendMessage(chatId, msgText, {
            reply_markup: { inline_keyboard: keyboard },
          }).then(msg => sentMessages.push({ chatId, messageId: msg.message_id }))
            .catch(err => logger.warn('telegram', `forwardCritical sendMessage failed for chat ${chatId}`, err.message || err))
        );
      }

      Promise.all(promises).then(() => {
        if (resolved) return; // Already answered before messages finished sending
        timer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          cleanup();
          for (const { chatId, messageId } of sentMessages) {
            this.bot.editMessageText(`\u23f0 [${tabId}] Timed out \u2014 auto-answering...`, {
              chat_id: chatId, message_id: messageId,
            }).catch(() => {});
          }
          resolve(null);
        }, timeoutMs);
      });
    });
  }

  _extractQuestionParts(questionData) {
    let options = null, questionText = null, multiSelect = false;
    if (typeof questionData === 'string') {
      return { options: null, questionText: questionData, multiSelect: false };
    }
    if (questionData) {
      const qList = extractQuestions(questionData);
      if (qList.length > 0) {
        const q = qList[0];
        questionText = q.question || null;
        multiSelect = !!q.multiSelect;
        if (q.options && Array.isArray(q.options)) {
          options = q.options;
        }
      }
    }
    return { options, questionText, multiSelect };
  }

  // -- Forward question with inline keyboard ----------------
  forwardQuestion(tabId, questionData) {
    if (!this.bot) { logger.info('telegram', 'forwardQuestion: no bot instance'); return; }
    const { options, questionText, multiSelect } = questionData || {};
    logger.info('telegram', `forwardQuestion: tabId=${tabId}, question="${(questionText || '').substring(0, 60)}", chatIds=${this.chatIds.size}, options=${(options || []).length}`);
    const msgText = `❓ ${this.projectLabel}:\n${questionText || 'Claude needs input'}`;
    const normalizedOpts = (options || []).map(o => typeof o === 'string' ? o : (o.label || o.value || String(o)));
    if (normalizedOpts.length > 0 && !multiSelect) {
      const keyboard = normalizedOpts.map((opt, i) => ([{
        text: String(opt).substring(0, 64),
        callback_data: JSON.stringify({ t: tabId, i: i + 1 }),
      }]));
      for (const [, chatId] of this.chatIds) {
        this.bot.sendMessage(chatId, msgText, {
          reply_markup: { inline_keyboard: keyboard },
        }).catch(err => logger.warn('telegram', `forwardQuestion sendMessage failed for chat ${chatId}`, err.message || err));
      }
    } else {
      const hint = multiSelect
        ? '\nReply with: /answer <comma-separated numbers>'
        : '\nReply with: /answer <your answer>';
      for (const [, chatId] of this.chatIds) {
        this.bot.sendMessage(chatId, msgText + hint).catch(err => logger.warn('telegram', `forwardQuestion text sendMessage failed for chat ${chatId}`, err.message || err));
      }
    }
  }

  // -- SessionManager Event Subscriptions -------------------
  _subscribeSessionEvents() {
    const onNotify = ({ title, body }) => {
      this.broadcastDirect(`${title}\n${body}`);
    };
    this.sessionManager.on('notify', onNotify);
    this._eventHandlers.push(['notify', onNotify]);

    const onSessionComplete = ({ tabId }) => {
      if (!this._criticalResolvers) return;
      for (const key of Object.keys(this._criticalResolvers)) {
        if (key.startsWith(`${tabId}-`)) {
          delete this._criticalResolvers[key];
        }
      }
    };
    this.sessionManager.on('session-complete', onSessionComplete);
    this._eventHandlers.push(['session-complete', onSessionComplete]);
  }

  _unsubscribeSessionEvents() {
    for (const [event, handler] of this._eventHandlers) {
      this.sessionManager.removeListener(event, handler);
    }
    this._eventHandlers = [];
  }
}

module.exports = TelegramBridge;

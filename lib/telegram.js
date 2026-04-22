// lib/telegram.js -- TelegramBridge: Telegram bot integration for Auto Claude
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const logger = require('./logger');
const { TG_BUFFER_FLUSH_MS, TG_MAX_MESSAGE_LENGTH, TG_UNAUTHORIZED_MSG } = require('./constants');
const { registerCommands } = require('./telegram-commands');
const {
  STREAM_LIVE,
  forwardLog: _forwardLog,
  forwardMetrics: _forwardMetrics,
  forwardProxyEvent: _forwardProxyEvent,
  forwardHookEvent: _forwardHookEvent,
  extractQuestionParts,
} = require('./telegram-formatters');

class TelegramBridge {
  constructor(config, sessionManager, projectDir) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.projectDir = projectDir || '';
    this.bot = null;
    this.chatIds = new Map();
    this.buffers = new Map();
    this.flushInterval = null;
    this.allowedUsers = [];
    this._started = false;
    this._eventHandlers = [];
    this._streamMode = STREAM_LIVE;
    this.botUsername = null;
  }

  get projectLabel() { return this.projectDir ? path.basename(this.projectDir) : 'unknown'; }

  async start(decryptedToken, allowedUsers) {
    if (this._started) await this.stop();
    this.allowedUsers = (allowedUsers || []).map(String);
    this.token = decryptedToken;
    try {
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
      await this.bot.startPolling();
      try {
        const me = await this.bot.getMe();
        this.botUsername = me?.username || null;
      } catch (e) {
        this.botUsername = null;
        logger.warn('telegram', 'Failed to get bot username', e);
      }
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
    this.botUsername = null;
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

  // -- Commands (delegated) ---------------------------------
  _registerCommands() { registerCommands(this); }

  // -- Callback Query (Inline Keyboard) ---------------------
  _registerCallbackQuery() {
    this.bot.on('callback_query', (query) => {
      try {
        const data = JSON.parse(query.data);
        if (data.cr) {
          if (this._criticalResolvers?.[data.cr]) {
            const answer = data.a || String(data.i);
            this.bot.answerCallbackQuery(query.id, { text: `Answered: ${answer}` }).catch(() => {});
            this._criticalResolvers[data.cr](answer);
          } else {
            this.bot.answerCallbackQuery(query.id, { text: '\u23f0 This question already timed out', show_alert: true }).catch(() => {});
          }
          return;
        }
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

  // -- Forwarding (delegated to telegram-formatters) --------
  forwardLog(logType, text) { _forwardLog(this, logType, text); }
  forwardMetrics(data) { _forwardMetrics(this, data); }
  forwardProxyEvent(event) { _forwardProxyEvent(this, event); }
  forwardHookEvent(event) { _forwardHookEvent(this, event); }

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
    const { options, questionText, multiSelect } = extractQuestionParts(questionData);
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
        if (resolved) return;
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

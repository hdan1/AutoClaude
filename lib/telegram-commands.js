'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const logger = require('./logger');

function registerCommands(bridge) {
  const { bot, sessionManager, config } = bridge;

  bot.setMyCommands([
    { command: 'start', description: 'Connect + start session [prompt]' },
    { command: 'status', description: 'Show session status' },
    { command: 'stop', description: 'Stop the running session' },
    { command: 'live', description: 'Toggle log streaming: off/important/live' },
    { command: 'logs', description: 'Show recent log output' },
    { command: 'autonomy', description: 'Toggle full autonomy on/off' },
    { command: 'help', description: 'List all commands' },
  ]).catch(() => {});

  const _findTabId = () => {
    for (const [tabId, session] of sessionManager.sessions) {
      if (session.state.projectDir && path.resolve(session.state.projectDir) === path.resolve(bridge.projectDir)) {
        return tabId;
      }
    }
    return null;
  };

  // /start [prompt]
  bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
    if (!bridge._isAuthorized(msg)) { bridge._rejectUnauthorized(msg); return; }
    const chatId = msg.chat.id;
    const key = msg.from.username || String(msg.from.id);
    bridge.chatIds.set(key, chatId);
    bridge._persistChatIds();
    const tabId = _findTabId();
    const session = tabId ? sessionManager.get(tabId) : null;
    const s = session?.state;
    const prompt = match[1]?.trim();

    if (!tabId || !session) {
      bot.sendMessage(chatId, `✅ Connected to ${bridge.projectLabel}\n⚪ No active session. Open the project in Auto Claude first.`).catch(() => {});
      return;
    }

    if (s?.running) {
      bot.sendMessage(chatId,
        `✅ Connected to ${bridge.projectLabel}\n🟢 Already running\nStep: ${s.currentStep || '-'}`
      ).catch(() => {});
      return;
    }

    bridge._ttftHistory = [];
    bridge._lastTtft = null;
    bridge._lastModel = null;
    bridge._lastInputTokens = null;
    bridge._lastOutputTokens = null;
    bridge._lastCostUsd = null;
    const defaultPrompt = config.defaultPrompt || 'continue';
    const usePrompt = prompt || defaultPrompt;
    sessionManager.start(tabId, usePrompt);
    bot.sendMessage(chatId,
      `✅ Connected to ${bridge.projectLabel}\n▶️ Starting session\nPrompt: ${usePrompt.substring(0, 100)}`
    ).catch(() => {});
  });

  // /status
  bot.onText(/\/status/, (msg) => {
    if (!bridge._isAuthorized(msg)) { bridge._rejectUnauthorized(msg); return; }
    const chatId = msg.chat.id;
    const tabId = _findTabId();
    if (!tabId) { bot.sendMessage(chatId, `📊 ${bridge.projectLabel}: No active session`).catch(() => {}); return; }
    const s = sessionManager.getState(tabId);
    if (!s) { bot.sendMessage(chatId, `📊 ${bridge.projectLabel}: No session data`).catch(() => {}); return; }
    let elapsed = '-';
    if (s.startTime) {
      const sec = Math.floor((Date.now() - s.startTime) / 1000);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = sec % 60;
      elapsed = h > 0 ? `${h}h ${m}m` : `${m}m ${ss}s`;
    }
    const model = s.model || bridge._lastModel || '-';
    const effort = config?.session?.effort || 'auto';
    const effortLine = effort !== 'auto' ? `\nEffort: ${effort}` : '';
    let ttftLine = '';
    if (bridge._ttftHistory && bridge._ttftHistory.length > 0) {
      const last = (bridge._lastTtft / 1000).toFixed(2);
      const avg = (bridge._ttftHistory.reduce((a, b) => a + b, 0) / bridge._ttftHistory.length / 1000).toFixed(2);
      const min = (Math.min(...bridge._ttftHistory) / 1000).toFixed(2);
      const max = (Math.max(...bridge._ttftHistory) / 1000).toFixed(2);
      ttftLine = `\nTTFT: ${last}s (avg ${avg}s, min ${min}s, max ${max}s, ${bridge._ttftHistory.length} turns)`;
    }
    const tokIn = bridge._lastInputTokens || s.totalInputTokens || 0;
    const tokOut = bridge._lastOutputTokens || s.totalOutputTokens || 0;
    bot.sendMessage(chatId,
      `📊 ${bridge.projectLabel}\n`
      + `Status: ${s.running ? '🟢 Running' : '⚪ Idle'}\n`
      + `Step: ${s.currentStep || '-'}\n`
      + `Model: ${model}\n`
      + (effortLine ? effortLine + '\n' : '')
      + `Tokens: ${tokIn} in / ${tokOut} out\n`
      + `Elapsed: ${elapsed}`
      + ttftLine
    ).catch(() => {});
  });

  // /stop
  bot.onText(/\/stop/, (msg) => {
    if (!bridge._isAuthorized(msg)) { bridge._rejectUnauthorized(msg); return; }
    const chatId = msg.chat.id;
    const tabId = _findTabId();
    if (!tabId) { bot.sendMessage(chatId, `No active session for ${bridge.projectLabel}`).catch(() => {}); return; }
    const session = sessionManager.get(tabId);
    if (!session?.state?.running) { bot.sendMessage(chatId, `Session already stopped.`).catch(() => {}); return; }
    sessionManager.stop(tabId);
    bot.sendMessage(chatId, `⏹ Stopped: ${bridge.projectLabel}`).catch(() => {});
  });

  // /answer <text>
  bot.onText(/\/answer\s+(.+)/, (msg, match) => {
    if (!bridge._isAuthorized(msg)) { bridge._rejectUnauthorized(msg); return; }
    const chatId = msg.chat.id;
    const answerText = match[1];
    const tabId = _findTabId();
    if (!tabId) { bot.sendMessage(chatId, `No active session.`).catch(() => {}); return; }
    sessionManager.sendResponse(tabId, answerText);
    bot.sendMessage(chatId, `📝 Answer sent: ${answerText.substring(0, 100)}`).catch(() => {});
  });

  // /logs [N]
  bot.onText(/\/logs(?:\s+(\d+))?/, (msg, match) => {
    if (!bridge._isAuthorized(msg)) { bridge._rejectUnauthorized(msg); return; }
    const chatId = msg.chat.id;
    const n = parseInt(match[1] || '20', 10);
    const tabId = _findTabId();
    if (!tabId) { bot.sendMessage(chatId, `No active session.`).catch(() => {}); return; }
    sessionManager.emit('get-logs', { tabId, count: n, callback: (lines) => {
      const text = lines.length ? lines.join('\n').substring(0, 4000) : 'No logs available.';
      bot.sendMessage(chatId, `📋 Last ${n} lines:\n${text}`).catch(() => {});
    }});
  });

  // /live [off|important|live]
  bot.onText(/\/live(?:\s+(off|important|live))?/, (msg, match) => {
    if (!bridge._isAuthorized(msg)) { bridge._rejectUnauthorized(msg); return; }
    const chatId = msg.chat.id;
    const val = match[1];
    if (val) {
      bridge._streamMode = val;
      const labels = { off: '🔴 OFF', important: '🟡 Important only', live: '🟢 Live (all)' };
      bot.sendMessage(chatId, `Log streaming: ${labels[val]}`).catch(() => {});
    } else {
      const labels = { off: '🔴 OFF', important: '🟡 Important only', live: '🟢 Live (all)' };
      bot.sendMessage(chatId, `Log streaming: ${labels[bridge._streamMode] || bridge._streamMode}\n\nUsage: /live off | /live important | /live live`).catch(() => {});
    }
  });

  // /autonomy [on|off]
  bot.onText(/\/autonomy(?:\s+(on|off))?/, (msg, match) => {
    if (!bridge._isAuthorized(msg)) { bridge._rejectUnauthorized(msg); return; }
    const chatId = msg.chat.id;
    const val = match[1];
    if (val) {
      const enabled = val === 'on';
      if (!config.autoAnswer) config.autoAnswer = {};
      config.autoAnswer.fullAutonomy = enabled;
      config.autoAnswer.derailmentCorrection = enabled;
      sessionManager.emit('save-config');
      bot.sendMessage(chatId, `Full autonomy: ${enabled ? '🟢 ON' : '🔴 OFF'}`).catch(() => {});
    } else {
      const current = config.autoAnswer?.fullAutonomy ? '🟢 ON' : '🔴 OFF';
      bot.sendMessage(chatId, `Full autonomy: ${current}`).catch(() => {});
    }
  });

  // /help
  bot.onText(/\/help/, (msg) => {
    if (!bridge._isAuthorized(msg)) { bridge._rejectUnauthorized(msg); return; }
    bot.sendMessage(msg.chat.id,
      `🤖 Auto Claude — ${bridge.projectLabel}\n\n`
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

  // Plain text / image messages
  bot.on('message', async (msg) => {
    const hasPhoto = msg.photo && msg.photo.length > 0;
    const hasDocument = msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/');
    if (!hasPhoto && !hasDocument && (!msg.text || msg.text.startsWith('/'))) return;
    if (!bridge._isAuthorized(msg)) { bridge._rejectUnauthorized(msg); return; }
    const chatId = msg.chat.id;
    const key = msg.from.username || String(msg.from.id);
    if (!bridge.chatIds.has(key)) { bridge.chatIds.set(key, chatId); bridge._persistChatIds(); }
    const tabId = _findTabId();
    if (!tabId) { bot.sendMessage(chatId, `No active session for ${bridge.projectLabel}`).catch(() => {}); return; }
    const session = sessionManager.get(tabId);
    if (!session?.state?.running) {
      bot.sendMessage(chatId, `⚪ Session not running. Use /start to begin.`).catch(() => {});
      return;
    }

    if (hasPhoto || hasDocument) {
      try {
        let fileId;
        if (hasPhoto) {
          fileId = msg.photo[msg.photo.length - 1].file_id;
        } else {
          fileId = msg.document.file_id;
        }
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${bridge.token}/${file.file_path}`;
        const ext = path.extname(file.file_path) || '.jpg';
        const imgDir = path.join(os.tmpdir(), 'auto-claude-images', tabId);
        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
        const imgPath = path.join(imgDir, `tg-${Date.now()}${ext}`);

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
        sessionManager.sendResponse(tabId, prompt);
        bot.sendMessage(chatId, `📷 Image sent to Claude${caption ? ': ' + caption.substring(0, 80) : ''}`).catch(() => {});
      } catch (e) {
        logger.warn('telegram', `Photo download failed: ${e.message}`);
        bot.sendMessage(chatId, `❌ Failed to process image: ${e.message}`).catch(() => {});
      }
      return;
    }

    sessionManager.sendResponse(tabId, msg.text);
    bot.sendMessage(chatId, `📝 Sent to Claude: ${msg.text.substring(0, 100)}`).catch(() => {});
  });
}

module.exports = { registerCommands };

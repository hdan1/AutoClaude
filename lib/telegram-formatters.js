'use strict';
const logger = require('./logger');
const { TG_MAX_MESSAGE_LENGTH } = require('./constants');
const { extractQuestions } = require('./question-utils');

const STREAM_OFF = 'off';
const STREAM_IMPORTANT = 'important';
const STREAM_LIVE = 'live';

const IMPORTANT_LOG_TYPES = new Set(['system', 'stderr', 'user-input', 'auto-answer']);
const TOOL_EMOJI = { Read: '📖', Write: '✏️', Edit: '✏️', Bash: '💻', Glob: '🔍', Grep: '🔍', Agent: '🤖', WebFetch: '🌐', WebSearch: '🌐', LSP: '🧠' };

function ts() {
  const now = new Date();
  return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
}

function forwardLog(bridge, logType, text) {
  if (bridge._streamMode === STREAM_OFF) return;
  if (bridge._streamMode === STREAM_IMPORTANT && !IMPORTANT_LOG_TYPES.has(logType)) return;
  const prefix = logType === 'stderr' ? '❌'
    : logType === 'system' ? 'ℹ️'
    : logType === 'user-input' ? ''
    : logType === 'auto-answer' ? '🤖' : '';
  const line = `${ts()}  ${prefix}${prefix ? ' ' : ''}${text}`;
  bridge.broadcast(line);
}

function forwardMetrics(bridge, data) {
  if (data.ttft != null) {
    bridge._lastTtft = data.ttft;
    bridge._ttftHistory = bridge._ttftHistory || [];
    bridge._ttftHistory.push(data.ttft);
  }
  if (data.model) bridge._lastModel = data.model;
  if (data.inputTokens != null) bridge._lastInputTokens = data.inputTokens;
  if (data.outputTokens != null) bridge._lastOutputTokens = data.outputTokens;
  if (data.costUsd != null) bridge._lastCostUsd = data.costUsd;
}

function forwardProxyEvent(bridge, event) {
  if (bridge._streamMode === STREAM_OFF) return;
  if (bridge._streamMode === STREAM_IMPORTANT) return;
  if (event.type === 'tool_use') {
    const emoji = TOOL_EMOJI[event.name] || '⚡';
    const input = (event.input || '').replace(/\n/g, ' ').substring(0, 120);
    bridge._lastToolLine = `${ts()}  ${emoji} ${event.name}  ${input}`;
    bridge.broadcast(bridge._lastToolLine);
  } else if (event.type === 'tool_result') {
    const mark = event.isError ? ' ✗' : ' ✓';
    let anyAppended = false;
    for (const [, chatId] of bridge.chatIds) {
      const existing = bridge.buffers.get(chatId) || '';
      if (existing) {
        const lastNewline = existing.lastIndexOf('\n');
        if (lastNewline >= 0 && lastNewline < existing.length - 1) {
          bridge.buffers.set(chatId, existing + mark);
        } else if (lastNewline === -1) {
          bridge.buffers.set(chatId, existing + mark);
        } else {
          bridge.buffers.set(chatId, existing + mark + '\n');
        }
        anyAppended = true;
      }
    }
    if (!anyAppended && bridge._lastToolLine) {
      bridge.broadcast(mark);
    }
  } else if (event.type === 'text') {
    const raw = (event.text || '').replace(/\n/g, ' ').trim();
    if (raw) {
      const abbreviated = raw.length > 200 ? raw.substring(0, 197) + '…' : raw;
      bridge.broadcast(`${ts()}  ${abbreviated}`);
    }
  }
}

function forwardHookEvent(bridge, event) {
  if (bridge._streamMode === STREAM_OFF) return;
  if (bridge._streamMode === STREAM_IMPORTANT) return;
  const isSubagent = !!event.agentId;
  const tool = event.tool || 'unknown';
  const input = (event.input || '').replace(/\n/g, ' ').substring(0, 120);
  const emoji = TOOL_EMOJI[tool] || '⚡';
  const prefix = isSubagent ? '  🔗 [subagent] ' : '  ';
  bridge.broadcast(`${ts()}${prefix}${emoji} ${tool}  ${input}`);
}

function extractQuestionParts(questionData) {
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

module.exports = {
  STREAM_OFF, STREAM_IMPORTANT, STREAM_LIVE,
  forwardLog, forwardMetrics, forwardProxyEvent, forwardHookEvent,
  extractQuestionParts,
};

'use strict';
const path = require('path');
const summarize = require('./summarize');
const {
  RING_BUFFER_TIMELINE,
  MAX_FULL_TEXT_BYTES,
  QUESTION_TOOL_NAMES,
} = require('./constants');

function parseLine(proxy, line, result) {
  let event;
  try {
    event = JSON.parse(line);
  } catch (err) {
    proxy.emit('raw', line);
    appendFullText(proxy, result, line + '\n');
    return;
  }

  const elapsed = Date.now() - result.startTime;
  const type = event.type;

  if (type === 'control_request') {
    proxy.emit('control-request', {
      subtype: event.subtype,
      toolName: event.tool_name,
      input: event.input,
      toolUseId: event.tool_use_id,
    });
    return;
  }

  if (type === 'system' && event.subtype === 'session_state') {
    proxy.emit('session-state', event.state);
    return;
  }

  if (type === 'system') {
    if (event.subtype === 'init' && event.session_id) {
      result.sessionId = event.session_id;
      proxy.emit('session-init', {
        sessionId: event.session_id,
        model: event.model,
        version: event.claude_code_version,
      });
    }
    if (event.model) result.model = event.model;
    _pushTimeline(result, elapsed, 'system', { model: event.model });
    proxy.emit('event', { type: 'system', event, elapsed });
    proxy.emit('metrics', { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  }

  else if (type === 'assistant') {
    _parseAssistant(proxy, event, result, elapsed);
  }

  else if (type === 'user') {
    const msg = event.message;
    if (!msg?.content) return;
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        _pushTimeline(result, elapsed, 'tool_result', { id: block.tool_use_id, isError: block.is_error || false });
        proxy.emit('event', { type: 'tool_result', isError: block.is_error, elapsed });
      }
    }
  }

  else if (type === 'result') {
    _parseResult(proxy, event, result, elapsed);
  }
}

function _parseAssistant(proxy, event, result, elapsed) {
  const msg = event.message;
  if (!msg) return;
  if (!result.firstTokenTime && msg.content?.length > 0) {
    result.firstTokenTime = Date.now();
    result.ttft = result.firstTokenTime - result.startTime;
    proxy.emit('metrics', { ttft: result.ttft, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  }
  if (msg.usage) {
    result.inputTokens += msg.usage.input_tokens || 0;
    result.outputTokens += msg.usage.output_tokens || 0;
    result.hasTrustedInputTokens = false;
    proxy.emit('metrics', { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  }
  if (msg.content) {
    for (const block of msg.content) {
      if (block.type === 'text') {
        appendFullText(proxy, result, block.text);
        _pushTimeline(result, elapsed, 'text', { text: block.text });
        proxy.emit('event', { type: 'text', text: block.text, elapsed });
      }
      if (block.type === 'tool_use') {
        const summary = summarize(block.name, block.input);
        _pushTimeline(result, elapsed, 'tool_use', { id: block.id, name: block.name, input: summary, isSubagent: false });
        proxy.emit('event', { type: 'tool_use', name: block.name, input: summary, elapsed });
        if (QUESTION_TOOL_NAMES.includes(block.name)) {
          result.askedQuestion = true;
          proxy.emit('ask-user-question', { input: block.input, id: block.id, elapsed });
        }
      }
    }
  }
}

function _parseResult(proxy, event, result, elapsed) {
  result.numTurns = event.num_turns || 0;
  const inTok = event.total_input_tokens || event.usage?.input_tokens || 0;
  const outTok = event.total_output_tokens || event.usage?.output_tokens || 0;
  if (inTok) result.inputTokens = inTok;
  if (outTok) result.outputTokens = outTok;
  result.hasTrustedInputTokens = true;
  result.cacheReadTokens = event.usage?.cache_read_input_tokens || 0;
  result.cacheCreateTokens = event.usage?.cache_creation_input_tokens || 0;
  if (event.total_cost_usd) result.costUsd = event.total_cost_usd;

  proxy.emit('metrics', {
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheCreateTokens: result.cacheCreateTokens,
    costUsd: result.costUsd,
  });
  _pushTimeline(result, elapsed, 'result', { inputTokens: result.inputTokens, outputTokens: result.outputTokens, numTurns: result.numTurns });
  proxy.emit('event', { type: 'result', event, elapsed });
  if (event.subtype === 'error') result.error = event.error || 'Unknown error';

  if (event.result && typeof event.result === 'string') {
    result.resultText = event.result;
    if (!result.error && result.inputTokens === 0 && result.outputTokens === 0) {
      const rt = event.result.toLowerCase();
      if (rt.startsWith('unknown skill') || rt.startsWith('unknown command') || rt.startsWith('error:')) {
        const { normalizeCliResultError } = require('./proxy-args');
        result.error = normalizeCliResultError(event.result);
      }
    }
  }
}

function appendFullText(proxy, result, text) {
  if (!proxy.worktreeDir) {
    const wtMatch = text.match(/\.claude[\/\\]worktrees[\/\\]([\w.-]+)/);
    if (wtMatch && proxy._lastProjectDir) {
      const wtPath = path.join(proxy._lastProjectDir, '.claude', 'worktrees', wtMatch[1]);
      proxy._startWorktreeHookWatcher(wtPath, result);
    }
  }

  if (result.fullText.length < MAX_FULL_TEXT_BYTES) {
    result.fullText += text;
    if (result.fullText.length > MAX_FULL_TEXT_BYTES) {
      result.fullText = result.fullText.slice(-MAX_FULL_TEXT_BYTES);
    }
  } else {
    result.fullText = (result.fullText + text).slice(-MAX_FULL_TEXT_BYTES);
  }
}

function _pushTimeline(result, elapsed, type, data) {
  result.timeline.push({ time: elapsed, type, data });
  if (result.timeline.length > RING_BUFFER_TIMELINE) result.timeline = result.timeline.slice(-RING_BUFFER_TIMELINE);
}

module.exports = { parseLine, appendFullText };

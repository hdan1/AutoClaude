#!/usr/bin/env node
// auto-claude-hook.js
// Installed as an async PostToolUse + SubagentStop hook.
// Reads JSON from stdin, appends a one-line JSON entry to the hook log.
// Because it's async, it adds ZERO latency to Claude's execution.

const fs = require('fs');
const path = require('path');

// L2: Use shared summarize function (deduplicated)
// Note: This file runs in the target project's cwd, so we need absolute path to our module
const summarize = require(path.join(__dirname, '..', 'lib', 'summarize'));

const LOG_FILE = path.join(process.cwd(), '.planning', 'auto-claude-hooks.jsonl');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const entry = {
      ts: Date.now(),
      event: data.hook_event_name || 'unknown',
      tool: data.tool_name || null,
      input: summarize(data.tool_name, data.tool_input),
      agentId: data.agent_id || null,
      agentType: data.agent_type || null,
      isError: data.is_error || false,
    };

    // Ensure directory exists
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Append one JSON line
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Log error to stderr but never disrupt Claude
    process.stderr.write(`[auto-claude-hook] Error: ${err.message}\n`);
  }
});

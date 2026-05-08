const test = require('node:test');
const assert = require('node:assert/strict');

const ClaudeProxy = require('../proxy');
const { parseLine } = require('./stream-parser');

test('normalizePrompt strips accidental double slash', () => {
  assert.equal(ClaudeProxy._normalizePrompt('//model'), '/model');
});

test('normalizePrompt converts plugin:skill command to -p compatible form', () => {
  assert.equal(ClaudeProxy._normalizePrompt('/gsd:new-project now'), '/gsd-new-project now');
});

test('normalizePrompt keeps /model commands unchanged for CLI handling', () => {
  assert.equal(ClaudeProxy._normalizePrompt('/model'), '/model');
  assert.equal(ClaudeProxy._normalizePrompt('/model as'), '/model as');
});

test('shouldPassSessionModel disables configured --model only for /model slash commands', () => {
  assert.equal(ClaudeProxy._shouldPassSessionModel('/model'), false);
  assert.equal(ClaudeProxy._shouldPassSessionModel('/model as'), false);
  assert.equal(ClaudeProxy._shouldPassSessionModel(' /model as '), false);
  assert.equal(ClaudeProxy._shouldPassSessionModel('/models'), true);
  assert.equal(ClaudeProxy._shouldPassSessionModel('/model-info'), true);
  assert.equal(ClaudeProxy._shouldPassSessionModel('/clear'), true);
  assert.equal(ClaudeProxy._shouldPassSessionModel('normal prompt'), true);
});

test('normalizeCliResultError adds guidance for unavailable /model slash command', () => {
  assert.equal(
    ClaudeProxy._normalizeCliResultError('Unknown skill: model'),
    'Unknown skill: model (this Claude Code environment does not expose /model; use session model setting or --model).'
  );
});

test('normalizeCliResultError keeps unrelated errors unchanged', () => {
  assert.equal(
    ClaudeProxy._normalizeCliResultError('Unknown skill: gsd-foo'),
    'Unknown skill: gsd-foo'
  );
});

test('parsePluginSlashCommand detects /plugin and /plugins with optional args', () => {
  assert.deepEqual(ClaudeProxy._parsePluginSlashCommand('/plugin'), []);
  assert.deepEqual(ClaudeProxy._parsePluginSlashCommand('/plugins'), []);
  assert.deepEqual(ClaudeProxy._parsePluginSlashCommand('/plugins list'), ['list']);
  assert.deepEqual(ClaudeProxy._parsePluginSlashCommand('/plugin install context7@claude-plugins-official'), ['install', 'context7@claude-plugins-official']);
  assert.equal(ClaudeProxy._parsePluginSlashCommand('/model'), null);
  assert.equal(ClaudeProxy._parsePluginSlashCommand('normal prompt'), null);
});

test('buildCliArgs routes plugin slash command to claude plugins subcommand', () => {
  const args = ClaudeProxy._buildCliArgs(
    { mode: 'fresh', prompt: '/plugins list', sessionId: null },
    { skipPermissions: true, session: { model: 'claude-opus-4-6', effort: 'high' } }
  );
  assert.deepEqual(args, ['plugins', 'list']);
});

test('buildCliArgs keeps print mode args for non-plugin prompts', () => {
  const args = ClaudeProxy._buildCliArgs(
    { mode: 'continue', prompt: '/gsd:next', sessionId: 'abc-123' },
    { skipPermissions: true, session: { model: 'claude-opus-4-6', effort: 'high' } }
  );
  assert.deepEqual(args, [
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
    '--continue', '-r', 'abc-123',
    '-p', '/gsd-next',
    '--model', 'claude-opus-4-6',
    '--effort', 'high',
  ]);
});

test('buildCliArgs maps built-in slash commands to Claude CLI subcommands/flags', () => {
  const cfg = { skipPermissions: true, session: { model: 'claude-opus-4-6', effort: 'high' } };

  assert.deepEqual(ClaudeProxy._buildCliArgs({ mode: 'fresh', prompt: '/plugins list', sessionId: null }, cfg), ['plugins', 'list']);
  assert.deepEqual(ClaudeProxy._buildCliArgs({ mode: 'fresh', prompt: '/plugin list', sessionId: null }, cfg), ['plugins', 'list']);
  assert.deepEqual(ClaudeProxy._buildCliArgs({ mode: 'fresh', prompt: '/mcp', sessionId: null }, cfg), ['mcp']);
  assert.deepEqual(ClaudeProxy._buildCliArgs({ mode: 'fresh', prompt: '/mcp list', sessionId: null }, cfg), ['mcp', 'list']);
  assert.deepEqual(ClaudeProxy._buildCliArgs({ mode: 'fresh', prompt: '/doctor', sessionId: null }, cfg), ['doctor']);
  assert.deepEqual(ClaudeProxy._buildCliArgs({ mode: 'fresh', prompt: '/status', sessionId: null }, cfg), ['auth', 'status']);
  assert.deepEqual(ClaudeProxy._buildCliArgs({ mode: 'fresh', prompt: '/model sonnet', sessionId: null }, cfg), [
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
    '-p', 'continue',
    '--model', 'sonnet',
    '--effort', 'high',
  ]);
});

test('buildCliArgs marks unsupported print-mode slash commands with explicit guidance', () => {
  const cfg = {
    skipPermissions: true,
    session: { model: 'claude-opus-4-6', effort: 'high' },
    runtime: { slashFallback: { enabled: false } },
  };
  const args = ClaudeProxy._buildCliArgs({ mode: 'fresh', prompt: '/clear', sessionId: null }, cfg);
  assert.deepEqual(args, [
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
    '-p', '/clear',
    '--model', 'claude-opus-4-6',
    '--effort', 'high',
  ]);
  assert.equal(
    ClaudeProxy._normalizeCliResultError('Unknown skill: clear'),
    'Unknown skill: clear (built-in slash commands are interactive-only in this print-mode flow; use Auto Claude controls or mapped CLI equivalents).'
  );
});

test('resolveExecutionPlan chooses pty-fallback for interactive-only slash commands', () => {
  const plan = ClaudeProxy._resolveExecutionPlan(
    { mode: 'fresh', prompt: '/clear', sessionId: null },
    { runtime: { slashFallback: { enabled: true, timeoutMs: 45000, logRawOutput: false } }, skipPermissions: true, session: { model: 'auto', effort: 'high' } }
  );

  assert.equal(plan.mode, 'pty-fallback');
  assert.equal(plan.originalPrompt, '/clear');
  assert.equal(plan.reason, 'interactive-only-slash');
});

test('resolveExecutionPlan keeps print mode when fallback disabled', () => {
  const plan = ClaudeProxy._resolveExecutionPlan(
    { mode: 'fresh', prompt: '/clear', sessionId: null },
    { runtime: { slashFallback: { enabled: false } }, skipPermissions: true, session: { model: 'auto', effort: 'high' } }
  );

  assert.equal(plan.mode, 'print');
});

test('applyPtyFallbackResult maps successful pty run into result object', () => {
  const result = { error: null, resultText: null, exitCode: null, fullText: '' };
  ClaudeProxy._applyPtyFallbackResult(result, {
    ok: true,
    timeout: false,
    exitCode: 0,
    summary: 'PTY fallback complete',
    stdout: 'done',
    stderr: '',
  });

  assert.equal(result.error, null);
  assert.equal(result.resultText, 'PTY fallback complete');
  assert.equal(result.exitCode, 0);
  assert.equal(result.fullText, 'done\nPTY fallback complete');
  assert.equal(result.inputTokens, Math.ceil('done\nPTY fallback complete'.length / 4));
});

test('applyPtyFallbackResult sets error for timeout/failure', () => {
  const result = { error: null, resultText: null, exitCode: null, fullText: '' };
  ClaudeProxy._applyPtyFallbackResult(result, {
    ok: false,
    timeout: true,
    exitCode: null,
    summary: 'PTY fallback timed out',
    stdout: '',
    stderr: '',
  });

  assert.match(result.error, /timed out/i);
});

test('parseLine marks assistant usage as untrusted until final result totals arrive', () => {
  const proxy = new ClaudeProxy({});
  const result = {
    startTime: Date.now(), firstTokenTime: null, endTime: null, ttft: null,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    costUsd: 0, numTurns: 0, model: '', sessionId: null,
    timeline: [], hookEvents: [], toolCalls: [], fullText: '',
    resultText: null, error: null, exitCode: null, askedQuestion: false,
  };

  parseLine(proxy, JSON.stringify({
    type: 'assistant',
    message: {
      usage: { input_tokens: 150000, output_tokens: 3000 },
      content: [{ type: 'text', text: 'CONTEXT WARNING' }],
    },
  }), result);

  assert.equal(result.inputTokens, 150000);
  assert.equal(result.hasTrustedInputTokens, false);
});

test('parseLine trusts final result totals over accumulated assistant usage', () => {
  const proxy = new ClaudeProxy({});
  const result = {
    startTime: Date.now(), firstTokenTime: null, endTime: null, ttft: null,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    costUsd: 0, numTurns: 0, model: '', sessionId: null,
    timeline: [], hookEvents: [], toolCalls: [], fullText: '',
    resultText: null, error: null, exitCode: null, askedQuestion: false,
  };

  parseLine(proxy, JSON.stringify({
    type: 'assistant',
    message: {
      usage: { input_tokens: 150000, output_tokens: 3000 },
      content: [{ type: 'text', text: 'First chunk' }],
    },
  }), result);
  parseLine(proxy, JSON.stringify({
    type: 'assistant',
    message: {
      usage: { input_tokens: 220000, output_tokens: 5000 },
      content: [{ type: 'text', text: 'Second chunk' }],
    },
  }), result);
  parseLine(proxy, JSON.stringify({
    type: 'result',
    total_input_tokens: 1100,
    total_output_tokens: 140,
    subtype: 'success',
  }), result);

  assert.equal(result.inputTokens, 1100);
  assert.equal(result.outputTokens, 140);
  assert.equal(result.hasTrustedInputTokens, true);
});

// ── SDK Mode Tests (Task 33) ──────────────────────────

test('_compareVersions returns correct ordering', () => {
  const proxy = new ClaudeProxy({});
  assert.equal(proxy._compareVersions('1.0.33', '1.0.33'), 0);
  assert.equal(proxy._compareVersions('1.0.34', '1.0.33'), 1);
  assert.equal(proxy._compareVersions('1.0.32', '1.0.33'), -1);
  assert.equal(proxy._compareVersions('2.0.0', '1.0.33'), 1);
  assert.equal(proxy._compareVersions('0.9.99', '1.0.0'), -1);
  assert.equal(proxy._compareVersions('', '1.0.0'), -1);
  assert.equal(proxy._compareVersions(null, '1.0.0'), -1);
});

test('_supportsSDKMode returns true when version >= SDK_MIN_VERSION', () => {
  const proxy = new ClaudeProxy({});
  proxy.emit('session-init', { version: '1.0.33' });
  assert.equal(proxy._supportsSDKMode(), true);
});

test('_supportsSDKMode returns false when version < SDK_MIN_VERSION', () => {
  const proxy = new ClaudeProxy({});
  proxy.emit('session-init', { version: '0.9.0' });
  assert.equal(proxy._supportsSDKMode(), false);
});

test('_supportsSDKMode returns false when version is missing', () => {
  const proxy = new ClaudeProxy({});
  assert.equal(proxy._supportsSDKMode(), false);
});

test('_buildSDKModeArgs builds correct args with all options', () => {
  const args = ClaudeProxy._buildSDKModeArgs('hello', { sessionId: 'sess-1', resume: 'res-1' }, { model: 'opus', skipPermissions: true, verbose: true });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('hello'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--input-format'));
  assert.ok(args.includes('--session-id'));
  assert.ok(args.includes('sess-1'));
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('res-1'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('opus'));
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--include-hook-events'));
  assert.ok(args.includes('--replay-user-messages'));
  assert.ok(args.includes('--verbose'));
});

test('_buildSDKModeArgs omits optional flags when not set', () => {
  const args = ClaudeProxy._buildSDKModeArgs('hello', {}, {});
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('hello'));
  assert.ok(!args.includes('--session-id'));
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('--model'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--verbose'));
});

test('_buildSDKModeArgs skips model when set to auto', () => {
  const args = ClaudeProxy._buildSDKModeArgs('hi', {}, { model: 'auto' });
  assert.ok(!args.includes('--model'));
});

test('_parseLine emits control-request for SDK control_request events', () => {
  const proxy = new ClaudeProxy({});
  const result = { startTime: Date.now(), timeline: [], hookEvents: [], toolCalls: [], fullText: '', inputTokens: 0, outputTokens: 0 };
  let emitted = null;
  proxy.on('control-request', (data) => { emitted = data; });

  const line = JSON.stringify({
    type: 'control_request',
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'ls' },
    tool_use_id: 'tu-123',
  });
  proxy._parseLine(line, result);

  assert.ok(emitted);
  assert.equal(emitted.subtype, 'can_use_tool');
  assert.equal(emitted.toolName, 'Bash');
  assert.equal(emitted.toolUseId, 'tu-123');
  assert.deepEqual(emitted.input, { command: 'ls' });
});

test('_parseLine emits session-state for system session_state events', () => {
  const proxy = new ClaudeProxy({});
  const result = { startTime: Date.now(), timeline: [], hookEvents: [], toolCalls: [], fullText: '', inputTokens: 0, outputTokens: 0 };
  let emitted = null;
  proxy.on('session-state', (data) => { emitted = data; });

  const line = JSON.stringify({
    type: 'system',
    subtype: 'session_state',
    state: { status: 'running' },
  });
  proxy._parseLine(line, result);

  assert.ok(emitted);
  assert.deepEqual(emitted, { status: 'running' });
});

test('sendControlResponse formats correct stdin message', () => {
  const proxy = new ClaudeProxy({});
  // Create a mock stdin
  let written = '';
  proxy.process = {
    stdin: {
      destroyed: false,
      write(data) { written = data; },
    },
  };

  const ok = proxy.sendControlResponse('tu-456', 'allow');
  assert.equal(ok, true);
  const parsed = JSON.parse(written.trim());
  assert.equal(parsed.type, 'control_response');
  assert.equal(parsed.tool_use_id, 'tu-456');
  assert.equal(parsed.decision, 'allow');
});

test('sendKeepAlive sends keep_alive message', () => {
  const proxy = new ClaudeProxy({});
  let written = '';
  proxy.process = {
    stdin: {
      destroyed: false,
      write(data) { written = data; },
    },
  };

  const ok = proxy.sendKeepAlive();
  assert.equal(ok, true);
  const parsed = JSON.parse(written.trim());
  assert.equal(parsed.type, 'keep_alive');
});

test('_sendToStdin returns false when no process', () => {
  const proxy = new ClaudeProxy({});
  proxy.process = null;
  assert.equal(proxy._sendToStdin({ type: 'test' }), false);
});

test('_sendToStdin returns false when stdin destroyed', () => {
  const proxy = new ClaudeProxy({});
  proxy.process = { stdin: { destroyed: true } };
  assert.equal(proxy._sendToStdin({ type: 'test' }), false);
});

test('sdkMode defaults to false', () => {
  const proxy = new ClaudeProxy({});
  assert.equal(proxy.sdkMode, false);
});

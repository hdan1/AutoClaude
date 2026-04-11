const test = require('node:test');
const assert = require('node:assert/strict');

const ClaudeProxy = require('../proxy');

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

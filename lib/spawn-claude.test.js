const test = require('node:test');
const assert = require('node:assert/strict');

const { getClaudeCommand, killClaudeProcess } = require('./spawn-claude');

test('getClaudeCommand returns cmd and shellFlag', () => {
  const result = getClaudeCommand();
  assert.equal(typeof result.cmd, 'string');
  assert.equal(typeof result.shellFlag, 'boolean');
  assert.ok(result.cmd.length > 0, 'cmd should not be empty');
});

test('getClaudeCommand shellFlag is true on win32 when no full path', (t) => {
  const result = getClaudeCommand();
  if (process.platform === 'win32' && result.cmd === 'claude') {
    assert.equal(result.shellFlag, true);
  }
});

test('killClaudeProcess does not throw on null/undefined', () => {
  assert.doesNotThrow(() => killClaudeProcess(null));
  assert.doesNotThrow(() => killClaudeProcess(undefined));
  assert.doesNotThrow(() => killClaudeProcess({}));
});

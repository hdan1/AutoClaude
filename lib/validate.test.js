const test = require('node:test');
const assert = require('node:assert/strict');

const { validateConfig } = require('./validate');

test('validateConfig preserves runtime slash fallback keys', () => {
  const result = validateConfig({
    runtime: {
      slashFallback: {
        enabled: true,
        timeoutMs: 45000,
        logRawOutput: false,
      },
    },
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.config.runtime, {
    slashFallback: {
      enabled: true,
      timeoutMs: 45000,
      logRawOutput: false,
    },
  });
});

test('validateConfig clamps invalid runtime timeout', () => {
  const result = validateConfig({
    runtime: {
      slashFallback: {
        enabled: true,
        timeoutMs: 5,
        logRawOutput: true,
      },
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.config.runtime.slashFallback.enabled, true);
  assert.equal(result.config.runtime.slashFallback.logRawOutput, true);
  assert.equal(result.config.runtime.slashFallback.timeoutMs, undefined);
});

const { validateProjectDir, validatePrompt, validateMasterTelegramConfig, validateDistinctTelegramTokens, validateProjectTelegramConfig, validateResponse } = require('./validate');
const os = require('os');

test('validateProjectDir rejects null', () => { assert.equal(validateProjectDir(null).valid, false); });
test('validateProjectDir rejects empty', () => { assert.equal(validateProjectDir('  ').valid, false); });
test('validateProjectDir rejects dangerous chars', () => { assert.equal(validateProjectDir('/tmp; rm -rf /').valid, false); });
test('validateProjectDir rejects nonexistent', () => { assert.equal(validateProjectDir('/nonexistent/xyz').valid, false); });
test('validateProjectDir accepts valid dir', () => { assert.equal(validateProjectDir(os.tmpdir()).valid, true); });
test('validateProjectDir rejects too long', () => { assert.equal(validateProjectDir('a'.repeat(501)).valid, false); });
test('validatePrompt accepts empty', () => { assert.equal(validatePrompt('').valid, true); });
test('validatePrompt rejects non-string', () => { assert.equal(validatePrompt(123).valid, false); });
test('validatePrompt rejects oversized', () => { assert.equal(validatePrompt('x'.repeat(50001)).valid, false); });
test('validateMasterTelegramConfig rejects non-object', () => { assert.equal(validateMasterTelegramConfig('x').valid, false); });
test('validateMasterTelegramConfig sanitizes valid', () => {
  const r = validateMasterTelegramConfig({ enabled: true, allowedUsers: ['u1'] });
  assert.equal(r.valid, true);
  assert.deepEqual(r.config.allowedUsers, ['u1']);
});
test('validateDistinctTelegramTokens rejects duplicates', () => {
  const r = validateDistinctTelegramTokens('abc', 'abc');
  assert.equal(r.valid, false);
});
test('validateDistinctTelegramTokens accepts different', () => {
  assert.equal(validateDistinctTelegramTokens('abc', 'def').valid, true);
});
test('validateProjectTelegramConfig rejects null', () => { assert.equal(validateProjectTelegramConfig(null).ok, false); });
test('validateResponse rejects empty', () => { assert.equal(validateResponse('').valid, false); });
test('validateResponse rejects oversized', () => { assert.equal(validateResponse('x'.repeat(10001)).valid, false); });
test('validateResponse accepts valid', () => { assert.equal(validateResponse('hello').valid, true); });

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

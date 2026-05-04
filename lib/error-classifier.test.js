'use strict';
const { classifyError, CircuitBreaker, getFallbackModel, SEVERITY } = require('./error-classifier');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', msg); }
}

// classifyError
assert(classifyError(0, '').severity === null, 'exit 0 = no error');
assert(classifyError(0, '').retryable === false, 'exit 0 = not retryable');

assert(classifyError(1, 'unauthorized').severity === SEVERITY.FATAL, 'unauthorized = fatal');
assert(classifyError(1, 'unauthorized').retryable === false, 'unauthorized = not retryable');

assert(classifyError(1, 'invalid api key').severity === SEVERITY.FATAL, 'invalid api key = fatal');

assert(classifyError(1, 'overloaded').severity === SEVERITY.CAPACITY, 'overloaded = capacity');
assert(classifyError(1, 'overloaded').retryable === true, 'overloaded = retryable');
assert(classifyError(1, 'overloaded').suggestFallback === true, 'overloaded = suggest fallback');

assert(classifyError(1, '529').severity === SEVERITY.CAPACITY, '529 = capacity');

assert(classifyError(1, 'rate limit exceeded').severity === SEVERITY.TRANSIENT, 'rate limit = transient');
assert(classifyError(1, 'rate limit exceeded').retryable === true, 'rate limit = retryable');

assert(classifyError(1, 'ETIMEDOUT').severity === SEVERITY.TRANSIENT, 'ETIMEDOUT = transient');

assert(classifyError(137, '').severity === SEVERITY.CRASH, 'exit 137 = crash');
assert(classifyError(null, '').severity === SEVERITY.CRASH, 'exit null = crash');

assert(classifyError(42, '').severity === SEVERITY.UNKNOWN, 'exit 42 = unknown');
assert(classifyError(42, '').retryable === true, 'exit 42 = retryable');

// CircuitBreaker
const cb = new CircuitBreaker({ threshold: 3, resetTimeMs: 100 });
assert(cb.canAttempt() === true, 'cb starts closed');
cb.recordFailure({ retryable: true });
cb.recordFailure({ retryable: true });
assert(cb.canAttempt() === true, 'cb still closed after 2 failures');
cb.recordFailure({ retryable: true });
assert(cb.state === 'open', 'cb opens after 3 failures');
assert(cb.canAttempt() === false, 'cb blocks attempts when open');

cb.recordSuccess();
assert(cb.state === 'closed', 'cb closes on success');
assert(cb.canAttempt() === true, 'cb allows after reset');

// CircuitBreaker half-open (async test at end)
function testHalfOpen() {
  return new Promise(resolve => {
    const cb2 = new CircuitBreaker({ threshold: 2, resetTimeMs: 50 });
    cb2.recordFailure({ retryable: true });
    cb2.recordFailure({ retryable: true });
    assert(cb2.state === 'open', 'cb2 opens');
    setTimeout(() => {
      assert(cb2.canAttempt() === true, 'cb2 half-open after cooldown');
      assert(cb2.state === 'half-open', 'cb2 state is half-open');
      resolve();
    }, 60);
  });
}

// getFallbackModel
assert(getFallbackModel('auto') === null, 'auto = no fallback');
assert(getFallbackModel('claude-opus-4-20250514') === 'claude-sonnet-4-20250514', 'opus falls back to sonnet');
assert(getFallbackModel('claude-sonnet-4-20250514') === 'claude-haiku-4-20250414', 'sonnet falls back to haiku');
assert(getFallbackModel('claude-haiku-4-20250414') === null, 'haiku = no further fallback');

testHalfOpen().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});

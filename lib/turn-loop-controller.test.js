const test = require('node:test');
const assert = require('node:assert/strict');
const TurnLoopController = require('./turn-loop-controller');

// ── checkRepeatedQuestion ──────────────────────────

test('checkRepeatedQuestion returns null for first occurrence', () => {
  const loop = new TurnLoopController();
  assert.equal(loop.checkRepeatedQuestion('Create these 3 phases?'), null);
});

test('checkRepeatedQuestion returns null for second occurrence', () => {
  const loop = new TurnLoopController();
  loop.checkRepeatedQuestion('Create these 3 phases?');
  assert.equal(loop.checkRepeatedQuestion('Create these 3 phases?'), null);
});

test('checkRepeatedQuestion triggers on third identical question', () => {
  const loop = new TurnLoopController();
  loop.checkRepeatedQuestion('Create these 3 phases?');
  loop.checkRepeatedQuestion('Create these 3 phases?');
  const result = loop.checkRepeatedQuestion('Create these 3 phases?');
  assert.ok(result);
  assert.equal(result.repeated, true);
  assert.equal(result.count, 3);
  assert.ok(result.reason.includes('3 times'));
});

test('checkRepeatedQuestion distinguishes different questions', () => {
  const loop = new TurnLoopController();
  loop.checkRepeatedQuestion('Create these 3 phases?');
  loop.checkRepeatedQuestion('Do you want to proceed?');
  loop.checkRepeatedQuestion('Create these 3 phases?');
  assert.equal(loop.checkRepeatedQuestion('Do you want to proceed?'), null);
});

test('checkRepeatedQuestion returns null for null/empty input', () => {
  const loop = new TurnLoopController();
  assert.equal(loop.checkRepeatedQuestion(null), null);
  assert.equal(loop.checkRepeatedQuestion(''), null);
});

test('checkRepeatedQuestion resets after resetAfterAnswer', () => {
  const loop = new TurnLoopController();
  loop.checkRepeatedQuestion('Create these 3 phases?');
  loop.checkRepeatedQuestion('Create these 3 phases?');
  loop.resetAfterAnswer();
  assert.equal(loop.checkRepeatedQuestion('Create these 3 phases?'), null);
});

test('checkRepeatedQuestion resets after resetForFreshSession', () => {
  const loop = new TurnLoopController();
  loop.checkRepeatedQuestion('Create these 3 phases?');
  loop.checkRepeatedQuestion('Create these 3 phases?');
  loop.resetForFreshSession();
  assert.equal(loop.checkRepeatedQuestion('Create these 3 phases?'), null);
});

test('checkRepeatedQuestion respects history limit', () => {
  const loop = new TurnLoopController();
  // Add 2 occurrences of the target question
  loop.checkRepeatedQuestion('Create these 3 phases?');
  loop.checkRepeatedQuestion('Create these 3 phases?');
  // Fill history with 10 different questions to evict the 2 above (MAX_HISTORY = 10)
  for (let i = 0; i < 10; i++) {
    loop.checkRepeatedQuestion(`Different question ${i}`);
  }
  // Now only 1 new occurrence in history — should not trigger
  assert.equal(loop.checkRepeatedQuestion('Create these 3 phases?'), null);
});

// ── Retryable patterns ─────────────────────────────

test('RETRYABLE_PATTERNS includes system error', () => {
  const { RETRYABLE_PATTERNS } = require('./constants');
  assert.ok(RETRYABLE_PATTERNS.includes('system error'));
});

test('RETRYABLE_PATTERNS includes 1033', () => {
  const { RETRYABLE_PATTERNS } = require('./constants');
  assert.ok(RETRYABLE_PATTERNS.includes('1033'));
});

test('system error pattern matches proxy gateway error', () => {
  const { RETRYABLE_PATTERNS } = require('./constants');
  const errorMsg = '{"content": "", "base_resp": {"status_code": 1033, "status_msg": "system error"}}';
  const matches = RETRYABLE_PATTERNS.some(p => errorMsg.toLowerCase().includes(p));
  assert.ok(matches, 'proxy gateway error should match retryable patterns');
});

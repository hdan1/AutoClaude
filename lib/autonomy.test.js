const test = require('node:test');
const assert = require('node:assert/strict');
const AutonomyEngine = require('./autonomy');

// classifyQuestion
test('classifyQuestion returns unknown for null input', () => {
  const engine = new AutonomyEngine({});
  assert.deepEqual(engine.classifyQuestion(null), { tier: 'unknown' });
});

test('classifyQuestion returns unknown for empty questions array', () => {
  const engine = new AutonomyEngine({});
  assert.deepEqual(engine.classifyQuestion({ questions: [] }), { tier: 'unknown' });
});

test('classifyQuestion returns simple for options-based question', () => {
  const engine = new AutonomyEngine({});
  const qd = { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] };
  assert.equal(engine.classifyQuestion(qd).tier, 'simple');
});

test('classifyQuestion returns simple for y/n pattern', () => {
  const engine = new AutonomyEngine({});
  const qd = { question: 'Do you want to proceed? (y/n)' };
  assert.equal(engine.classifyQuestion(qd).tier, 'simple');
});

test('classifyQuestion returns critical for approve plan', () => {
  const engine = new AutonomyEngine({});
  const qd = { question: 'Do you approve this plan?' };
  assert.equal(engine.classifyQuestion(qd).tier, 'critical');
});

test('classifyQuestion returns critical for delete operations', () => {
  const engine = new AutonomyEngine({});
  const qd = { question: 'Should I delete the database?' };
  assert.equal(engine.classifyQuestion(qd).tier, 'critical');
});

// autoAnswer
test('autoAnswer returns null when autoAnswer config is off', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.autoAnswer({}, {}), null);
});

test('autoAnswer selects recommended option', () => {
  const engine = new AutonomyEngine({});
  const cfg = { autoAnswer: { selectRecommended: true } };
  const qd = { question: 'Pick', options: [{ label: 'A' }, { label: 'B (Recommended)' }] };
  const result = engine.autoAnswer(qd, cfg);
  assert.equal(result.answer, '2');
});

test('autoAnswer selects all for multi-select', () => {
  const engine = new AutonomyEngine({});
  const cfg = { autoAnswer: { selectAll: true } };
  const qd = { question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true };
  const result = engine.autoAnswer(qd, cfg);
  assert.equal(result.answer, '1, 2');
});

test('autoAnswer returns yes for y/n with full autonomy', () => {
  const engine = new AutonomyEngine({});
  const cfg = { autoAnswer: { fullAutonomy: true } };
  const qd = { question: 'Continue? (y/n)' };
  const result = engine.autoAnswer(qd, cfg);
  assert.equal(result.answer, 'yes');
});

test('autoAnswer delegates choice for preference questions', () => {
  const engine = new AutonomyEngine({});
  const cfg = { autoAnswer: { fullAutonomy: true } };
  const qd = { question: 'What name would you like?' };
  const result = engine.autoAnswer(qd, cfg);
  assert.ok(result.answer.includes('you decide'));
});

test('autoAnswer returns single option with full autonomy', () => {
  const engine = new AutonomyEngine({});
  const cfg = { autoAnswer: { fullAutonomy: true } };
  const qd = { question: 'Confirm', options: [{ label: 'OK' }] };
  const result = engine.autoAnswer(qd, cfg);
  assert.equal(result.answer, '1');
});

// handleQuestion
test('handleQuestion returns ask-user when autoAnswer missing', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.handleQuestion('tab1', {}, null).action, 'ask-user');
});

test('handleQuestion returns ask-user in manual mode', () => {
  const engine = new AutonomyEngine({ autoAnswer: { mode: 'manual' } });
  assert.equal(engine.handleQuestion('tab1', {}, null).action, 'ask-user');
});

test('handleQuestion auto-answers simple question in full mode', () => {
  const engine = new AutonomyEngine({ autoAnswer: { mode: 'full', selectRecommended: true } });
  const qd = { question: 'Pick', options: [{ label: 'A (Recommended)' }] };
  const result = engine.handleQuestion('tab1', qd, null);
  assert.equal(result.action, 'auto-answer');
});

// shouldRetry
test('shouldRetry returns false for clean exit', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.shouldRetry(0, '', 0), false);
});

test('shouldRetry returns true for crash code 1', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.shouldRetry(1, '', 0), true);
});

test('shouldRetry returns false for fatal error', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.shouldRetry(1, 'unauthorized', 0), false);
});

test('shouldRetry returns false when max retries exceeded', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.shouldRetry(1, '', 3), false);
});

test('shouldRetry returns true for null exit code', () => {
  const engine = new AutonomyEngine({});
  assert.equal(engine.shouldRetry(null, '', 0), true);
});

// getResumeState
test('getResumeState returns empty for null sessions', () => {
  const engine = new AutonomyEngine({});
  assert.deepEqual(engine.getResumeState(null), []);
});

test('getResumeState returns sessions that were running', () => {
  const engine = new AutonomyEngine({});
  const sessions = {
    '/project/a': { wasRunning: true, sessionId: 'abc', tabId: 'tab1' },
    '/project/b': { wasRunning: false, sessionId: 'def' },
  };
  const result = engine.getResumeState(sessions);
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 'abc');
});

test('getResumeState respects autoResume disabled', () => {
  const engine = new AutonomyEngine({ resilience: { autoResume: false } });
  const sessions = { '/a': { wasRunning: true, sessionId: 'x' } };
  assert.deepEqual(engine.getResumeState(sessions), []);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { getContextWindow, detectGsdWarning, shouldRecover, getHandoffPrompt, getResumePrompt } = require('./context-guard');

test('getContextWindow returns config override when set', () => {
  assert.equal(getContextWindow('claude-sonnet-4', 500000, null), 500000);
});
test('getContextWindow returns API value when no override', () => {
  assert.equal(getContextWindow('claude-sonnet-4', null, 300000), 300000);
});
test('getContextWindow matches model prefix', () => {
  assert.equal(getContextWindow('claude-sonnet-4-20250514', null, null), 200000);
});
test('getContextWindow returns default for unknown model', () => {
  assert.equal(getContextWindow('gpt-4o', null, null), 200000);
});
test('detectGsdWarning returns null for empty', () => {
  assert.equal(detectGsdWarning(''), null);
});
test('detectGsdWarning detects warning', () => {
  assert.equal(detectGsdWarning('CONTEXT WARNING'), 'warning');
});
test('detectGsdWarning detects critical', () => {
  assert.equal(detectGsdWarning('CONTEXT CRITICAL'), 'critical');
});
test('shouldRecover false when disabled', () => {
  assert.equal(shouldRecover({ inputTokens: 180000 }, 'claude-sonnet-4', { contextGuard: { enabled: false } }, 0).recover, false);
});
test('shouldRecover true above threshold', () => {
  assert.equal(shouldRecover({ inputTokens: 180000 }, 'claude-sonnet-4', {}, 0).recover, true);
});
test('shouldRecover false below threshold', () => {
  assert.equal(shouldRecover({ inputTokens: 100000 }, 'claude-sonnet-4', {}, 0).recover, false);
});
test('shouldRecover false at max recoveries', () => {
  assert.equal(shouldRecover({ inputTokens: 180000 }, 'claude-sonnet-4', {}, 3).recover, false);
});
test('shouldRecover forces on GSD critical', () => {
  assert.equal(shouldRecover({ inputTokens: 50000, fullText: 'CONTEXT CRITICAL' }, 'claude-sonnet-4', {}, 0).recover, true);
});
test('getHandoffPrompt GSD', () => {
  assert.equal(getHandoffPrompt({ gsdPhase: 'exec' }), '/gsd-pause-work');
});
test('getHandoffPrompt generic', () => {
  assert.ok(getHandoffPrompt({}).includes('handoff'));
});
test('getResumePrompt GSD', () => {
  assert.equal(getResumePrompt({ skillSource: 'gsd' }), '/gsd-resume-work');
});
test('getResumePrompt generic', () => {
  assert.ok(getResumePrompt({}).includes('handoff'));
});

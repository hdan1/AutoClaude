const test = require('node:test');
const assert = require('node:assert/strict');
const GsdDetector = require('./gsd-detector');

function makeResult(fullText, opts = {}) {
  return { fullText, numTurns: opts.numTurns ?? 2, askedQuestion: opts.askedQuestion ?? false };
}
function makeSession(gsdPhase, lastAutoNextPrompt) {
  return { state: { gsdPhase: gsdPhase || 'executing phase 1', lastAutoNextPrompt: lastAutoNextPrompt || null } };
}

// ── Bug #1: Catch-all should NOT fire when Claude asks a question ──

test('detectDerailment: does not fire when output ends with a question mark', () => {
  const d = new GsdDetector();
  const result = makeResult('What do you want to build next? What new capabilities do you want to add?');
  const session = makeSession('milestone complete');
  assert.equal(d.detectDerailment(result, session), null);
});

test('detectDerailment: does not fire when output asks "what do you think"', () => {
  const d = new GsdDetector();
  const result = makeResult('I have a few ideas. What do you think about adding notifications?');
  const session = makeSession('milestone complete');
  assert.equal(d.detectDerailment(result, session), null);
});

test('detectDerailment: does not fire when output asks "which approach"', () => {
  const d = new GsdDetector();
  const result = makeResult('There are two options. Which approach do you prefer?');
  const session = makeSession('milestone complete');
  assert.equal(d.detectDerailment(result, session), null);
});

test('detectDerailment: does not fire when output asks for user input/preference', () => {
  const d = new GsdDetector();
  const result = makeResult('Here is the summary. Can you tell me your preference?');
  const session = makeSession('milestone complete');
  assert.equal(d.detectDerailment(result, session), null);
});

test('detectDerailment: does not fire when output says "let me know your thoughts"', () => {
  const d = new GsdDetector();
  const result = makeResult('I shipped phase 7. Let me know your thoughts on what to do next.');
  const session = makeSession('milestone complete');
  assert.equal(d.detectDerailment(result, session), null);
});

test('detectDerailment: does not fire when result.askedQuestion is true', () => {
  const d = new GsdDetector();
  const result = makeResult('Some output without question patterns', { askedQuestion: true });
  const session = makeSession('executing phase 1');
  assert.equal(d.detectDerailment(result, session), null);
});

test('detectDerailment: does not fire when lastAutoNextPrompt was gsd-new-milestone', () => {
  const d = new GsdDetector();
  const result = makeResult('Here is what shipped in v1.0. What do you want to build next?');
  const session = makeSession('milestone complete', '/gsd-new-milestone');
  assert.equal(d.detectDerailment(result, session), null);
});

test('detectDerailment: does not fire when lastAutoNextPrompt was gsd:new-project', () => {
  const d = new GsdDetector();
  const result = makeResult('Some output asking about project goals.');
  const session = makeSession('milestone complete', '/gsd:new-project');
  assert.equal(d.detectDerailment(result, session), null);
});

// ── Bug #1: Catch-all SHOULD fire for genuine derailments ──

test('detectDerailment: fires catch-all on non-question GSD output without completion', () => {
  const d = new GsdDetector();
  const result = makeResult('I wrote some code and stopped in the middle of phase 1.');
  const session = makeSession('executing phase 1');
  const r = d.detectDerailment(result, session);
  assert.ok(r);
  assert.equal(r.prompt, '/gsd:next');
});

// ── Bug #11: Tighter derailment patterns ──

test('detectDerailment: "is there anything else" alone does NOT trigger derailment', () => {
  const d = new GsdDetector();
  // Pattern should now require "I can help/do/assist" suffix
  const result = makeResult('The code is done. Is there anything else?');
  const session = makeSession('executing phase 1');
  // This should NOT match the tighter derailment pattern, but the catch-all
  // may fire since it ends with "?" — which is now caught by endsWithQuestionMark
  // Either way it should not be a derailment correction
  assert.equal(d.detectDerailment(result, session), null);
});

test('detectDerailment: "is there anything else I can help with" triggers derailment', () => {
  const d = new GsdDetector();
  const result = makeResult('Sure! Is there anything else I can help with today.');
  const session = makeSession('executing phase 1');
  const r = d.detectDerailment(result, session);
  assert.ok(r);
  assert.ok(r.reason.includes('Derailment'));
});

// ── detectAutoNext ──

test('detectAutoNext: detects phase complete', () => {
  const d = new GsdDetector();
  const result = makeResult('## PHASE COMPLETE Phase: 3');
  const r = d.detectAutoNext(result, {});
  assert.ok(r);
  assert.equal(r.prompt, '/gsd:next');
});

test('detectAutoNext: detects GSD suggestion in tail', () => {
  const d = new GsdDetector();
  const result = makeResult('Phase done. Next Up: /gsd-plan-phase 2');
  const r = d.detectAutoNext(result, {});
  assert.ok(r);
  assert.equal(r.prompt, '/gsd-plan-phase 2');
});

test('detectAutoNext: rejects duplicate phase suggestion', () => {
  const d = new GsdDetector();
  const result = makeResult('Next: /gsd-execute-phase 1');
  const session = makeSession('executing phase 1');
  const r = d.detectAutoNext(result, session);
  assert.equal(r, null);
});

test('detectAutoNext: allows wave re-execution', () => {
  const d = new GsdDetector();
  const result = makeResult('Wave 1 complete. 2 remaining waves. Next: /gsd-execute-phase 1');
  const session = makeSession('executing phase 1');
  const r = d.detectAutoNext(result, session);
  assert.ok(r);
});

test('detectAutoNext: returns null on milestone complete', () => {
  const d = new GsdDetector();
  const result = makeResult('All phases complete. Milestone complete!');
  assert.equal(d.detectAutoNext(result, {}), null);
});

test('detectAutoNext: returns null on empty result', () => {
  const d = new GsdDetector();
  assert.equal(d.detectAutoNext(null, {}), null);
  assert.equal(d.detectAutoNext({}, {}), null);
});

// ── detect ──

test('detect: matches gsd:discuss-phase', () => {
  const d = new GsdDetector();
  const r = d.detect('gsd:discuss-phase 3');
  assert.ok(r);
  assert.equal(r.label, 'discussing phase 3');
});

test('detect: matches gsd:quick', () => {
  const d = new GsdDetector();
  const r = d.detect('gsd:quick');
  assert.ok(r);
  assert.equal(r.label, 'quick task');
});

test('detect: returns null on no match', () => {
  const d = new GsdDetector();
  assert.equal(d.detect('random text'), null);
});

// ── _parseGsdCommand ──

test('_parseGsdCommand: parses execute-phase', () => {
  const d = new GsdDetector();
  const r = d._parseGsdCommand('/gsd-execute-phase 2');
  assert.deepStrictEqual(r, { type: 'execute', num: 2 });
});

test('_parseGsdCommand: parses discuss-phase with colon', () => {
  const d = new GsdDetector();
  const r = d._parseGsdCommand('/gsd:discuss-phase 3');
  assert.deepStrictEqual(r, { type: 'discuss', num: 3 });
});

test('_parseGsdCommand: returns null on non-phase command', () => {
  const d = new GsdDetector();
  assert.equal(d._parseGsdCommand('/gsd:next'), null);
});

// ── Config-gated behavior ──

test('detect returns null when gsd.enabled is false', () => {
  const d = new GsdDetector({ gsd: { enabled: false } });
  assert.equal(d.detect('/gsd:execute-phase 1'), null);
});

test('detect works when gsd.enabled is true', () => {
  const d = new GsdDetector({ gsd: { enabled: true } });
  const r = d.detect('/gsd:execute-phase 1');
  assert.ok(r);
  assert.equal(r.label, 'executing phase 1');
});

test('detectAutoNext returns null when gsd.autoNext is false', () => {
  const d = new GsdDetector({ gsd: { autoNext: false } });
  const result = makeResult('## PHASE COMPLETE\nPhase: 1');
  const session = makeSession('executing phase 1');
  assert.equal(d.detectAutoNext(result, session), null);
});

test('detectDerailment returns null when gsd.derailmentCorrection is false', () => {
  const d = new GsdDetector({ gsd: { derailmentCorrection: false } });
  const result = makeResult('Some random off-topic text without any question marks or GSD markers');
  const session = makeSession('executing phase 1');
  assert.equal(d.detectDerailment(result, session), null);
});

test('detectAutoNext uses config autoContinueDelaySecs for agent waits', () => {
  const d = new GsdDetector({ gsd: { autoContinueDelaySecs: 30 } });
  const result = makeResult('Waiting for background agents to complete.');
  result.numTurns = 2;
  const session = makeSession('executing phase 1');
  const r = d.detectAutoNext(result, session);
  assert.ok(r);
  assert.equal(r.delaySecs, 30);
});

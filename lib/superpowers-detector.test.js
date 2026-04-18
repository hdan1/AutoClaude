const test = require('node:test');
const assert = require('node:assert/strict');
const SuperpowersDetector = require('./superpowers-detector');

function makeResult(fullText) {
  return { fullText };
}

function makeQuestion(question) {
  return { question };
}

test('detect returns null when superpowers.enabled is false', () => {
  const d = new SuperpowersDetector({ superpowers: { enabled: false } });
  assert.equal(d.detect('Using brainstorming skill now'), null);
});

test('detect returns null when superpowersInstalled is false', () => {
  const d = new SuperpowersDetector({
    superpowers: { enabled: true },
    runtime: { workflowAvailability: { superpowersInstalled: false } },
  });
  assert.equal(d.detect('Using brainstorming skill now'), null);
});

test('classifyQuestion returns unknown when superpowers.enabled is false', () => {
  const d = new SuperpowersDetector({ superpowers: { enabled: false } });
  assert.equal(d.classifyQuestion(makeQuestion('Do you prefer option A or B?')), 'unknown');
});

test('classifyQuestion returns unknown when superpowersInstalled is false', () => {
  const d = new SuperpowersDetector({
    superpowers: { enabled: true },
    runtime: { workflowAvailability: { superpowersInstalled: false } },
  });
  assert.equal(d.classifyQuestion(makeQuestion('Do you prefer option A or B?')), 'unknown');
});

test('autoAnswer returns null when superpowersInstalled is false from runtime config override', () => {
  const d = new SuperpowersDetector({ superpowers: { enabled: true } });
  const result = d.autoAnswer(
    makeQuestion('Would you like to open visual companion?'),
    {
      superpowers: { enabled: true },
      runtime: { workflowAvailability: { superpowersInstalled: false } },
    },
  );
  assert.equal(result, null);
});

test('detectAutoNext returns null when superpowersInstalled is false', () => {
  const d = new SuperpowersDetector({
    superpowers: { enabled: true, autoChain: true },
    runtime: { workflowAvailability: { superpowersInstalled: false } },
  });
  const result = makeResult('implementation complete');
  const session = { state: { activeSkill: 'executing plans' } };
  assert.equal(d.detectAutoNext(result, session), null);
});

test('detectDerailment returns null when superpowersInstalled is false', () => {
  const d = new SuperpowersDetector({
    superpowers: { enabled: true },
    runtime: { workflowAvailability: { superpowersInstalled: false } },
  });
  const result = makeResult('I would use superpowers next');
  const session = { state: { activeSkill: 'brainstorming' } };
  assert.equal(d.detectDerailment(result, session), null);
});

test('autoAnswer still works when superpowers is active', () => {
  const d = new SuperpowersDetector({ superpowers: { enabled: true } });
  const result = d.autoAnswer(makeQuestion('Would you like to open visual companion?'), {
    superpowers: { enabled: true, declineVisualCompanion: true },
  });
  assert.ok(result);
  assert.match(result.reason, /decline visual companion/i);
});

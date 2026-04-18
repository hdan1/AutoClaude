const test = require('node:test');
const assert = require('node:assert/strict');

const logger = require('./logger');
const SessionManager = require('../session-manager');

function createManager({ nowSequence, questionData, decision } = {}) {
  const sent = [];
  const originalInfo = logger.info;
  const infoCalls = [];

  logger.info = (ctx, msg) => infoCalls.push({ ctx, msg });

  const manager = new SessionManager({ autoAnswer: { mode: 'full', fullAutonomy: true } }, (tabId, channel, data) => {
    sent.push({ tabId, channel, data });
  }, null);

  manager.create('tab-1', '/tmp/project');

  const session = manager.get('tab-1');
  session.state.running = true;

  if (Array.isArray(nowSequence)) {
    let idx = 0;
    manager._now = () => nowSequence[Math.min(idx++, nowSequence.length - 1)];
  } else {
    manager._now = () => 1000;
  }

  manager.autonomy = {
    handleQuestion: () => decision || { action: 'ask-user' },
    autoAnswer: () => null,
    evaluatePermission: () => ({ action: 'ask-user' }),
    detectAutoNext: () => null,
    shouldRetry: () => false,
    detectDerailment: () => null,
    shouldCorrectDerailment: () => false,
  };

  const proxyHandlers = {};
  const proxy = {
    on: (event, handler) => { proxyHandlers[event] = handler; },
  };

  manager._wireProxy('tab-1', session, proxy);

  return {
    manager,
    sent,
    infoCalls,
    triggerQuestion: async () => {
      await proxyHandlers['ask-user-question']({ input: questionData || {
        question: 'Which option?',
        options: ['A', 'B'],
        multiSelect: false,
      } });
    },
    restore: () => { logger.info = originalInfo; },
  };
}

test('question-routing info log is emitted for first question event', async () => {
  const h = createManager();
  try {
    await h.triggerQuestion();
    const routingLogs = h.infoCalls.filter(x => x.ctx === 'question-routing');
    assert.equal(routingLogs.length, 1);
    assert.match(routingLogs[0].msg, /decision=ask-user/);
  } finally {
    h.restore();
  }
});

test('question-routing info log dedupes identical events inside throttle window', async () => {
  const h = createManager({ nowSequence: [1000, 1300] });
  try {
    await h.triggerQuestion();
    await h.triggerQuestion();
    const routingLogs = h.infoCalls.filter(x => x.ctx === 'question-routing');
    assert.equal(routingLogs.length, 1);
  } finally {
    h.restore();
  }
});

test('question-routing info log emits again after throttle window', async () => {
  const h = createManager({ nowSequence: [1000, 2600] });
  try {
    await h.triggerQuestion();
    await h.triggerQuestion();
    const routingLogs = h.infoCalls.filter(x => x.ctx === 'question-routing');
    assert.equal(routingLogs.length, 2);
  } finally {
    h.restore();
  }
});

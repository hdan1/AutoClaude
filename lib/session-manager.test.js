const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const logger = require('./logger');
const SessionManager = require('../session-manager');

function createManager({ nowSequence, questionData, decision } = {}) {
  const sent = [];
  const originalInfo = logger.info;
  const originalDebug = logger.debug;
  const infoCalls = [];
  const debugCalls = [];

  logger.info = (ctx, msg) => infoCalls.push({ ctx, msg });
  logger.debug = (ctx, msg) => debugCalls.push({ ctx, msg });

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
    sdkMode: false,
    on: (event, handler) => { proxyHandlers[event] = handler; },
    emit: (event, data) => proxyHandlers[event]?.(data),
    kill: async () => {},
    sendResponse: () => {},
    sendControlResponse: () => {},
  };

  manager._wireProxy('tab-1', session, proxy);

  return {
    manager,
    session,
    sent,
    infoCalls,
    debugCalls,
    triggerQuestion: async () => {
      await proxyHandlers['ask-user-question']({ input: questionData || {
        question: 'Which option?',
        options: ['A', 'B'],
        multiSelect: false,
      } });
    },
    restore: () => {
      logger.info = originalInfo;
      logger.debug = originalDebug;
    },
  };
}

test('question-routing debug log is emitted for first question event', async () => {
  const h = createManager();
  try {
    await h.triggerQuestion();
    const routingLogs = h.debugCalls.filter(x => x.ctx === 'question-routing');
    assert.equal(routingLogs.length, 1);
    assert.match(routingLogs[0].msg, /decision=ask-user/);
  } finally {
    h.restore();
  }
});

test('question-routing debug log dedupes identical events inside throttle window', async () => {
  const h = createManager({ nowSequence: [1000, 1300] });
  try {
    await h.triggerQuestion();
    await h.triggerQuestion();
    const routingLogs = h.debugCalls.filter(x => x.ctx === 'question-routing');
    assert.equal(routingLogs.length, 1);
  } finally {
    h.restore();
  }
});

test('question-routing debug log emits again after throttle window', async () => {
  const h = createManager({ nowSequence: [1000, 2600] });
  try {
    await h.triggerQuestion();
    await h.triggerQuestion();
    const routingLogs = h.debugCalls.filter(x => x.ctx === 'question-routing');
    assert.equal(routingLogs.length, 2);
  } finally {
    h.restore();
  }
});

test('stop clears stale question state and hides the question UI', async () => {
  const h = createManager();
  try {
    await h.triggerQuestion();

    assert.equal(h.session.waitingForAnswer, true);
    assert.equal(h.session.pendingResponse, null);
    assert.deepEqual(h.session._lastQuestionData, {
      question: 'Which option?',
      options: ['A', 'B'],
      multiSelect: false,
    });

    await h.manager.stop('tab-1');

    assert.equal(h.session.waitingForAnswer, false);
    assert.equal(h.session.pendingResponse, null);
    assert.equal(h.session.answerResolve, null);
    assert.equal(h.session._lastQuestionData, null);
    assert.ok(h.sent.some(x => x.channel === 'hide-question'));
  } finally {
    h.restore();
  }
});

test('session completion clears stale question state and hides the question UI', async () => {
  const sessionManagerPath = require.resolve('../session-manager');
  const originalCached = require.cache[sessionManagerPath];
  const originalLoad = Module._load;

  class FakeProxy extends EventEmitter {
    async run() {
      return {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        sessionId: 'session-1',
        resultText: 'Done',
      };
    }

    async kill() {}
  }

  try {
    delete require.cache[sessionManagerPath];
    Module._load = function(request, parent, isMain) {
      if (request === './proxy' && parent?.filename === sessionManagerPath) {
        return FakeProxy;
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const FreshSessionManager = require('../session-manager');
    const sent = [];
    const manager = new FreshSessionManager({ autoAnswer: { mode: 'manual' } }, (tabId, channel, data) => {
      sent.push({ tabId, channel, data });
    }, null);

    manager._saveProjectStats = () => {};
    manager._cleanupTempImages = () => {};
    manager.create('tab-1', process.cwd());

    const session = manager.get('tab-1');
    session.waitingForAnswer = true;
    session.pendingResponse = 'stale answer';
    session._lastQuestionData = { question: 'Stale question?' };

    await manager.start('tab-1', 'continue');

    const hideIdx = sent.findIndex(x => x.channel === 'hide-question');
    const completeIdx = sent.findIndex(x => x.channel === 'session-complete');

    assert.notEqual(hideIdx, -1);
    assert.notEqual(completeIdx, -1);
    assert.ok(hideIdx < completeIdx);
    assert.equal(session.waitingForAnswer, false);
    assert.equal(session.pendingResponse, null);
    assert.equal(session._lastQuestionData, null);
  } finally {
    Module._load = originalLoad;
    delete require.cache[sessionManagerPath];
    if (originalCached) require.cache[sessionManagerPath] = originalCached;
  }
});

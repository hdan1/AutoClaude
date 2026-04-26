const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extract(regex, label) {
  const match = src.match(regex);
  assert.ok(match, `Could not locate ${label} in main.js`);
  return match;
}

function buildSleepPrevention(deps) {
  const [, acquireBody] = extract(
    /function acquireSleepLock\(\) \{([\s\S]*?)\n\}/,
    'acquireSleepLock'
  );
  const [, releaseBody] = extract(
    /function releaseSleepLock\(\) \{([\s\S]*?)\n\}/,
    'releaseSleepLock'
  );

  return new Function(
    'deps',
    `
      let sleepBlockerId = deps.sleepBlockerId ?? null;
      const { config, powerSaveBlocker, logger, send, sessionManager } = deps;
      function acquireSleepLock() {${acquireBody}}
      function releaseSleepLock() {${releaseBody}}
      return {
        acquireSleepLock,
        releaseSleepLock,
        getSleepBlockerId: () => sleepBlockerId,
      };
    `
  )(deps);
}

test('sleep prevention starts with prevent-app-suspension', () => {
  const started = [];
  const sent = [];
  const sleepPrevention = buildSleepPrevention({
    config: { system: { preventSleep: true } },
    powerSaveBlocker: {
      start(kind) {
        started.push(kind);
        return 7;
      },
      stop() {},
    },
    logger: { info: () => {} },
    send: (channel, payload) => sent.push([channel, payload]),
    sessionManager: { sessions: new Map() },
  });

  sleepPrevention.acquireSleepLock();

  assert.equal(sleepPrevention.getSleepBlockerId(), 7);
  assert.deepEqual(started, ['prevent-app-suspension']);
  assert.deepEqual(sent, [['sleep-status', { active: true }]]);
});

test('sleep prevention stop clears the blocker id', () => {
  const stopped = [];
  const sent = [];
  const sleepPrevention = buildSleepPrevention({
    config: { system: { preventSleep: true } },
    powerSaveBlocker: {
      start() { return 7; },
      stop(id) { stopped.push(id); },
    },
    logger: { info: () => {} },
    send: (channel, payload) => sent.push([channel, payload]),
    sessionManager: { sessions: new Map() },
    sleepBlockerId: 7,
  });

  sleepPrevention.releaseSleepLock();

  assert.equal(sleepPrevention.getSleepBlockerId(), null);
  assert.deepEqual(stopped, [7]);
  assert.deepEqual(sent, [['sleep-status', { active: false }]]);
});

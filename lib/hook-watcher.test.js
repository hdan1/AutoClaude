'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  noteHookWatcherFailure,
  noteHookWatcherSuccess,
  readHookLog,
  readWorktreeHookLog,
} = require('./hook-watcher');

const TELEMETRY_DEGRADED = {
  severity: 'warning',
  scope: 'telemetry',
  summary: 'Telemetry degraded',
  nextSteps: [
    'Keep session running',
    'Open app logs',
    'Check hook log file permissions',
  ],
};

function makeProxy() {
  const events = [];
  return {
    config: { hooks: {} },
    events,
    _readCounts: new Map(),
    hookByteOffset: 0,
    worktreeHookByteOffset: 0,
    emit(event, payload) {
      events.push([event, payload]);
    },
  };
}

function makeResult() {
  return { hookEvents: [] };
}

function makeTempLogFile(fileName = 'hooks.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-watcher-'));
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, '');
  return { dir, file };
}

async function withPatchedOpen(openImpl, run) {
  const originalOpen = fs.promises.open;
  fs.promises.open = openImpl;
  try {
    return await run();
  } finally {
    fs.promises.open = originalOpen;
  }
}

test('noteHookWatcherFailure emits telemetry-degraded when failure count reaches 3', () => {
  const proxy = makeProxy();

  noteHookWatcherFailure(proxy, 'read failed');
  noteHookWatcherFailure(proxy, 'read failed');
  noteHookWatcherFailure(proxy, 'read failed');

  assert.deepEqual(proxy.events, [[
    'telemetry-degraded',
    {
      ...TELEMETRY_DEGRADED,
      details: 'read failed',
    },
  ]]);
});

test('noteHookWatcherFailure stays silent below threshold', () => {
  const proxy = makeProxy();

  noteHookWatcherFailure(proxy, 'read failed');
  noteHookWatcherFailure(proxy, 'read failed');

  assert.deepEqual(proxy.events, []);
});

test('readHookLog emits telemetry-restored after telemetry recovers', async () => {
  const proxy = makeProxy();
  const result = makeResult();
  const { dir, file } = makeTempLogFile();

  try {
    fs.appendFileSync(file, '{bad\n');
    await readHookLog(proxy, file, result);
    fs.appendFileSync(file, '{bad-again\n');
    await readHookLog(proxy, file, result);
    fs.appendFileSync(file, '{bad-third\n');
    await readHookLog(proxy, file, result);
    fs.appendFileSync(file, `${JSON.stringify({ tool: 'Write', message: 'ok' })}\n`);
    await readHookLog(proxy, file, result);

    assert.deepEqual(proxy.events.map(([event]) => event), [
      'telemetry-degraded',
      'hook-event',
      'telemetry-restored',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('noteHookWatcherSuccess waits until all degraded watchers recover before restoring telemetry', () => {
  const proxy = makeProxy();

  noteHookWatcherFailure(proxy, 'main failed');
  noteHookWatcherFailure(proxy, 'main failed');
  noteHookWatcherFailure(proxy, 'main failed');
  noteHookWatcherFailure(proxy, 'worktree failed', 'worktree');
  noteHookWatcherFailure(proxy, 'worktree failed', 'worktree');
  noteHookWatcherFailure(proxy, 'worktree failed', 'worktree');
  noteHookWatcherSuccess(proxy, 'main');

  assert.deepEqual(proxy.events.map(([event]) => event), [
    'telemetry-degraded',
    'telemetry-degraded',
  ]);

  noteHookWatcherSuccess(proxy, 'worktree');

  assert.deepEqual(proxy.events.map(([event]) => event), [
    'telemetry-degraded',
    'telemetry-degraded',
    'telemetry-restored',
  ]);
});

test('readHookLog emits telemetry-degraded after repeated parse failures and resets after success', async () => {
  const proxy = makeProxy();
  const result = makeResult();
  const { dir, file } = makeTempLogFile();

  try {
    fs.appendFileSync(file, '{bad\n');
    await readHookLog(proxy, file, result);
    fs.appendFileSync(file, '{bad-again\n');
    await readHookLog(proxy, file, result);
    fs.appendFileSync(file, '{bad-third\n');
    await readHookLog(proxy, file, result);

    assert.equal(proxy._hookWatcherFailures, 3);
    assert.equal(proxy.events.length, 1);
    assert.equal(proxy.events[0][0], 'telemetry-degraded');
    assert.deepEqual(proxy.events[0][1].severity, TELEMETRY_DEGRADED.severity);
    assert.deepEqual(proxy.events[0][1].scope, TELEMETRY_DEGRADED.scope);
    assert.deepEqual(proxy.events[0][1].summary, TELEMETRY_DEGRADED.summary);
    assert.deepEqual(proxy.events[0][1].nextSteps, TELEMETRY_DEGRADED.nextSteps);
    assert.equal(typeof proxy.events[0][1].details, 'string');
    assert.ok(proxy.events[0][1].details.length > 0);

    fs.appendFileSync(file, `${JSON.stringify({ tool: 'Write', message: 'ok' })}\n`);
    await readHookLog(proxy, file, result);

    assert.equal(proxy._hookWatcherFailures, 0);
    assert.equal(result.hookEvents.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readHookLog notes repeated read failures through the outer catch path', async () => {
  const proxy = makeProxy();
  const result = makeResult();
  const { dir, file } = makeTempLogFile();

  try {
    fs.writeFileSync(file, 'not-empty\n');
    await withPatchedOpen(async () => {
      throw new Error('open failed');
    }, async () => {
      await readHookLog(proxy, file, result);
      await readHookLog(proxy, file, result);
      await readHookLog(proxy, file, result);
    });

    assert.equal(proxy._hookWatcherFailures, 3);
    assert.deepEqual(proxy.events, [[
      'telemetry-degraded',
      {
        ...TELEMETRY_DEGRADED,
        details: 'open failed',
      },
    ]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readHookLog restores telemetry when polling stays quiet after failures', async () => {
  const proxy = makeProxy();
  const result = makeResult();
  const { dir, file } = makeTempLogFile();

  try {
    fs.appendFileSync(file, '{bad\n');
    await readHookLog(proxy, file, result);
    fs.appendFileSync(file, '{bad-again\n');
    await readHookLog(proxy, file, result);
    fs.appendFileSync(file, '{bad-third\n');
    await readHookLog(proxy, file, result);
    await readHookLog(proxy, file, result);

    assert.deepEqual(proxy.events.map(([event]) => event), [
      'telemetry-degraded',
      'telemetry-restored',
    ]);
    assert.equal(proxy._hookWatcherFailures, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorktreeHookLog emits telemetry-degraded after repeated parse failures and resets after success', async () => {
  const proxy = makeProxy();
  const result = makeResult();
  const { dir, file } = makeTempLogFile();

  try {
    fs.appendFileSync(file, '{bad\n');
    await readWorktreeHookLog(proxy, file, result);
    fs.appendFileSync(file, '{bad-again\n');
    await readWorktreeHookLog(proxy, file, result);
    fs.appendFileSync(file, '{bad-third\n');
    await readWorktreeHookLog(proxy, file, result);

    assert.equal(proxy._worktreeHookWatcherFailures, 3);
    assert.equal(proxy.events.length, 1);
    assert.equal(proxy.events[0][0], 'telemetry-degraded');
    assert.deepEqual(proxy.events[0][1].severity, TELEMETRY_DEGRADED.severity);
    assert.deepEqual(proxy.events[0][1].scope, TELEMETRY_DEGRADED.scope);
    assert.deepEqual(proxy.events[0][1].summary, TELEMETRY_DEGRADED.summary);
    assert.deepEqual(proxy.events[0][1].nextSteps, TELEMETRY_DEGRADED.nextSteps);
    assert.equal(typeof proxy.events[0][1].details, 'string');
    assert.ok(proxy.events[0][1].details.length > 0);

    fs.appendFileSync(file, `${JSON.stringify({ tool: 'Write', message: 'ok' })}\n`);
    await readWorktreeHookLog(proxy, file, result);

    assert.equal(proxy._worktreeHookWatcherFailures, 0);
    assert.equal(result.hookEvents.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorktreeHookLog notes repeated read failures through the outer catch path', async () => {
  const proxy = makeProxy();
  const result = makeResult();
  const { dir, file } = makeTempLogFile();

  try {
    fs.writeFileSync(file, 'not-empty\n');
    await withPatchedOpen(async () => {
      throw new Error('open failed');
    }, async () => {
      await readWorktreeHookLog(proxy, file, result);
      await readWorktreeHookLog(proxy, file, result);
      await readWorktreeHookLog(proxy, file, result);
    });

    assert.equal(proxy._worktreeHookWatcherFailures, 3);
    assert.deepEqual(proxy.events, [[
      'telemetry-degraded',
      {
        ...TELEMETRY_DEGRADED,
        details: 'open failed',
      },
    ]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main watcher success does not reset worktree watcher failure count', async () => {
  const proxy = makeProxy();
  const result = makeResult();
  const { dir: mainDir, file: mainFile } = makeTempLogFile('main.jsonl');
  const { dir: worktreeDir, file: worktreeFile } = makeTempLogFile('worktree.jsonl');

  try {
    fs.appendFileSync(worktreeFile, '{bad\n');
    await readWorktreeHookLog(proxy, worktreeFile, result);
    fs.appendFileSync(worktreeFile, '{bad-again\n');
    await readWorktreeHookLog(proxy, worktreeFile, result);

    fs.appendFileSync(mainFile, `${JSON.stringify({ tool: 'Write', message: 'ok' })}\n`);
    await readHookLog(proxy, mainFile, result);

    fs.appendFileSync(worktreeFile, '{bad-third\n');
    await readWorktreeHookLog(proxy, worktreeFile, result);

    const degradedEvents = proxy.events.filter(([event]) => event === 'telemetry-degraded');
    assert.equal(degradedEvents.length, 1);
    assert.equal(typeof degradedEvents[0][1].details, 'string');
  } finally {
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test('main and worktree watchers threshold independently', async () => {
  const proxy = makeProxy();
  const result = makeResult();
  const { dir: mainDir, file: mainFile } = makeTempLogFile('main.jsonl');
  const { dir: worktreeDir, file: worktreeFile } = makeTempLogFile('worktree.jsonl');

  try {
    fs.appendFileSync(mainFile, '{bad\n');
    await readHookLog(proxy, mainFile, result);
    fs.appendFileSync(mainFile, '{bad-again\n');
    await readHookLog(proxy, mainFile, result);

    fs.appendFileSync(worktreeFile, '{bad\n');
    await readWorktreeHookLog(proxy, worktreeFile, result);
    fs.appendFileSync(worktreeFile, '{bad-again\n');
    await readWorktreeHookLog(proxy, worktreeFile, result);

    assert.equal(proxy.events.length, 0);

    fs.appendFileSync(mainFile, '{bad-third\n');
    await readHookLog(proxy, mainFile, result);

    assert.equal(proxy.events.length, 1);

    fs.appendFileSync(worktreeFile, '{bad-third\n');
    await readWorktreeHookLog(proxy, worktreeFile, result);

    assert.equal(proxy.events.length, 2);
  } finally {
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

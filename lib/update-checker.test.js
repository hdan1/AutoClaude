const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

async function withUpdateCheckerMocks({ execFileImpl, loggerMock, getClaudeCommandImpl }, run) {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'child_process') {
      return { execFile: execFileImpl };
    }
    if (request === './spawn-claude') {
      return { getClaudeCommand: getClaudeCommandImpl || (() => ({ cmd: 'claude', shellFlag: false })) };
    }
    if (request === './logger') {
      return loggerMock;
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const modPath = require.resolve('./update-checker');
    delete require.cache[modPath];
    const spawnClaudePath = require.resolve('./spawn-claude');
    delete require.cache[spawnClaudePath];
    const updateChecker = require('./update-checker');
    return await run(updateChecker);
  } finally {
    Module._load = originalLoad;
  }
}

function createLoggerMock() {
  const calls = [];
  return {
    calls,
    info(ctx, msg) { calls.push({ level: 'info', ctx, msg }); },
    warn(ctx, msg) { calls.push({ level: 'warn', ctx, msg }); },
    error(ctx, msg) { calls.push({ level: 'error', ctx, msg }); },
    debug(ctx, msg) { calls.push({ level: 'debug', ctx, msg }); },
  };
}

test('checkForUpdate logs subprocess start and timeout outcome', async () => {
  const logger = createLoggerMock();

  await withUpdateCheckerMocks({
    loggerMock: logger,
    execFileImpl: (cmd, args, opts, cb) => {
      cb(Object.assign(new Error('Command failed: claude update'), { killed: true, signal: 'SIGTERM', code: null }), '', '');
    },
  }, async ({ checkForUpdate }) => {
    const result = await checkForUpdate({ forceCheck: true });

    assert.equal(result.updateAvailable, false);
    assert.ok(logger.calls.some(c => c.level === 'info' && c.ctx === 'update-checker' && /starting claude update/i.test(c.msg)));
    assert.ok(logger.calls.some(c => c.level === 'warn' && c.ctx === 'update-checker' && /timed out|SIGTERM|killed/i.test(c.msg)));
  });
});

test('checkForUpdate logs parse failure with output preview when status is undetermined', async () => {
  const logger = createLoggerMock();

  await withUpdateCheckerMocks({
    loggerMock: logger,
    execFileImpl: (cmd, args, opts, cb) => {
      cb(null, 'weird output with no version markers', '');
    },
  }, async ({ checkForUpdate }) => {
    const result = await checkForUpdate({ forceCheck: true });

    assert.equal(result.updateAvailable, false);
    assert.equal(result.currentVersion, null);
    assert.equal(result.latestVersion, null);
    assert.ok(logger.calls.some(c => c.level === 'warn' && c.ctx === 'update-checker' && /could not determine update status/i.test(c.msg)));
    assert.ok(logger.calls.some(c => c.ctx === 'update-checker' && /weird output with no version markers/i.test(c.msg)));
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyPtyRun, normalizePtyError } = require('./pty-executor');

test('classifyPtyRun marks timeout when timedOut is true', () => {
  const r = classifyPtyRun({ code: null, stdout: '', stderr: '', timedOut: true });
  assert.equal(r.ok, false);
  assert.equal(r.timeout, true);
});

test('classifyPtyRun marks success on zero exit code', () => {
  const r = classifyPtyRun({ code: 0, stdout: 'done', stderr: '', timedOut: false });
  assert.equal(r.ok, true);
  assert.equal(r.timeout, false);
  assert.match(r.summary, /done/i);
});

test('normalizePtyError returns explicit bridge guidance', () => {
  assert.match(
    normalizePtyError(new Error('spawn ENOENT')),
    /PTY fallback unavailable/i
  );
});

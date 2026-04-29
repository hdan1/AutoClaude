const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { projectPathHash, listSessions } = require('./sessions');

test('projectPathHash converts Windows path', () => {
  assert.equal(projectPathHash('D:\\work\\project'), 'D--work-project');
});
test('projectPathHash converts spaces', () => {
  assert.equal(projectPathHash('C:\\Users\\Dan\\New folder'), 'C--Users-Dan-New-folder');
});
test('projectPathHash converts Unix path', () => {
  assert.equal(projectPathHash('/home/user/project'), '-home-user-project');
});
test('projectPathHash is deterministic', () => {
  assert.equal(projectPathHash('D:\\test'), projectPathHash('D:\\test'));
});
test('projectPathHash handles forward slashes', () => {
  assert.equal(projectPathHash('D:/work/project'), 'D--work-project');
});
test('projectPathHash handles single segment', () => {
  assert.equal(typeof projectPathHash('project'), 'string');
});

test('listSessions returns prompt preview and latest-turn token metadata from session jsonl', (t) => {
  const projectDir = `D:/tmp/ralph-session-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const hash = projectPathHash(projectDir);
  const sessionsDir = path.join(os.homedir(), '.claude', 'projects', hash);
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = path.join(sessionsDir, 'test-session.jsonl');
  const lines = [
    JSON.stringify({ type: 'human', message: { content: 'Investigate context continuity after reload' } }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 120, output_tokens: 45 }, content: [{ type: 'text', text: 'Done.' }] } }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 80, output_tokens: 30 }, content: [{ type: 'text', text: 'More output.' }] } }),
  ].join('\n');
  fs.writeFileSync(sessionFile, lines, 'utf8');

  t.after(() => {
    try { fs.rmSync(sessionsDir, { recursive: true, force: true }); } catch {}
  });

  const sessions = listSessions(projectDir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'test-session');
  assert.equal(sessions[0].firstPrompt, 'Investigate context continuity after reload');
  assert.equal(sessions[0].inputTokens, 80);
  assert.equal(sessions[0].outputTokens, 30);
});

test('listSessions prefers result total tokens for latest turn context instead of cumulative usage tokens', (t) => {
  const projectDir = `D:/tmp/ralph-session-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const hash = projectPathHash(projectDir);
  const sessionsDir = path.join(os.homedir(), '.claude', 'projects', hash);
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = path.join(sessionsDir, 'result-session.jsonl');
  const lines = [
    JSON.stringify({ type: 'human', message: { content: 'Investigate context reset after handoff' } }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 150000, output_tokens: 3000 }, content: [{ type: 'text', text: 'Large turn.' }] } }),
    JSON.stringify({ type: 'result', total_input_tokens: 900, total_output_tokens: 120, subtype: 'success' }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 220000, output_tokens: 5000 }, content: [{ type: 'text', text: 'Cumulative usage from older context.' }] } }),
    JSON.stringify({ type: 'result', total_input_tokens: 1100, total_output_tokens: 140, subtype: 'success' }),
  ].join('\n');
  fs.writeFileSync(sessionFile, lines, 'utf8');

  t.after(() => {
    try { fs.rmSync(sessionsDir, { recursive: true, force: true }); } catch {}
  });

  const sessions = listSessions(projectDir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].inputTokens, 1100);
  assert.equal(sessions[0].outputTokens, 140);
});

test('listSessions reads usage from file tail when session file is larger than usage scan window', (t) => {
  const projectDir = `D:/tmp/ralph-session-tail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const hash = projectPathHash(projectDir);
  const sessionsDir = path.join(os.homedir(), '.claude', 'projects', hash);
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = path.join(sessionsDir, 'tail-session.jsonl');
  const largePrefix = JSON.stringify({ type: 'human', message: { content: 'x'.repeat(300000) } });
  const lines = [
    largePrefix,
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 999, output_tokens: 111 }, content: [{ type: 'text', text: 'Tail usage.' }] } }),
  ].join('\n');
  fs.writeFileSync(sessionFile, lines, 'utf8');

  t.after(() => {
    try { fs.rmSync(sessionsDir, { recursive: true, force: true }); } catch {}
  });

  const sessions = listSessions(projectDir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].inputTokens, 999);
  assert.equal(sessions[0].outputTokens, 111);
});

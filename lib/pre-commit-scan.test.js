'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-claude-pre-commit-'));
  git(tmpDir, ['init']);
  git(tmpDir, ['config', 'user.name', 'Test User']);
  git(tmpDir, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# temp\n');
  git(tmpDir, ['add', 'README.md']);
  git(tmpDir, ['commit', '-m', 'init']);
  return tmpDir;
}

test('pre-commit scan blocks staged secrets', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'secret.txt'), 'token = "' + 'sk-ant-' + 'abcdefghijklmnopqrstuvwxyz123456' + '"\n');
    git(repo, ['add', 'secret.txt']);

    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'pre-commit-scan.js')], {
      cwd: repo,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /PRE-COMMIT SAFETY SCAN FAILED/);
    assert.match(result.stderr, /Anthropic API key/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('pre-commit scan allows harmless staged files', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'hello world\n');
    git(repo, ['add', 'notes.txt']);

    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'pre-commit-scan.js')], {
      cwd: repo,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

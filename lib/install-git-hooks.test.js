const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeHookFixture(repoRoot, markerText) {
  const hooksDir = path.join(repoRoot, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const installerSource = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'install-git-hooks.js'), 'utf8');
  fs.writeFileSync(path.join(hooksDir, 'install-git-hooks.js'), installerSource);
  fs.writeFileSync(
    path.join(hooksDir, 'pre-commit-scan.js'),
    `'use strict';\nconst fs = require('node:fs');\nconst path = require('node:path');\nfs.writeFileSync(path.join(__dirname, '..', 'hook-script-origin.txt'), ${JSON.stringify(markerText)});\n`
  );
}

function createRepoWithWorktree() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-claude-hooks-'));
  const repoRoot = path.join(tmpDir, 'repo');
  const worktreeRoot = path.join(tmpDir, 'repo-worktree');
  fs.mkdirSync(repoRoot, { recursive: true });

  git(repoRoot, ['init']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);

  writeHookFixture(repoRoot, 'MAIN');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# temp repo\n');
  git(repoRoot, ['add', 'README.md', 'hooks/install-git-hooks.js', 'hooks/pre-commit-scan.js']);
  git(repoRoot, ['commit', '-m', 'init']);

  git(repoRoot, ['worktree', 'add', worktreeRoot, '-b', 'feature/worktree-hooks']);
  writeHookFixture(worktreeRoot, 'WORKTREE');

  return { tmpDir, repoRoot, worktreeRoot };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function resolveGitPath(repoRoot, gitPath) {
  return path.isAbsolute(gitPath) ? gitPath : path.join(repoRoot, gitPath);
}

test('install-git-hooks works in a git worktree and uses the worktree hook script on commit', () => {
  const { tmpDir, repoRoot, worktreeRoot } = createRepoWithWorktree();

  try {
    const install = spawnSync(process.execPath, [path.join(worktreeRoot, 'hooks', 'install-git-hooks.js')], {
      cwd: worktreeRoot,
      encoding: 'utf8',
    });

    assert.equal(install.status, 0, `installer failed: ${install.stderr || install.stdout}`);

    const hookPath = resolveGitPath(worktreeRoot, git(worktreeRoot, ['rev-parse', '--git-path', 'hooks/pre-commit']));
    assert.equal(fs.existsSync(hookPath), true, `expected hook at ${hookPath}`);

    fs.writeFileSync(path.join(worktreeRoot, 'note.txt'), 'worktree commit\n');
    git(worktreeRoot, ['add', 'note.txt', 'hooks/pre-commit-scan.js']);
    const commit = spawnSync('git', ['commit', '-m', 'worktree hook test'], {
      cwd: worktreeRoot,
      encoding: 'utf8',
    });

    assert.equal(commit.status, 0, `commit failed: ${commit.stderr || commit.stdout}`);

    const mainMarker = path.join(repoRoot, 'hook-script-origin.txt');
    const worktreeMarker = path.join(worktreeRoot, 'hook-script-origin.txt');

    assert.equal(fs.existsSync(worktreeMarker), true, 'expected worktree hook script to run');
    assert.equal(fs.readFileSync(worktreeMarker, 'utf8'), 'WORKTREE');
    assert.equal(fs.existsSync(mainMarker), false, 'main checkout hook script should not run for worktree commits');
  } finally {
    cleanup(tmpDir);
  }
});

test('install-git-hooks still installs a pre-commit hook in a normal checkout', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-claude-hooks-main-'));
  const repoRoot = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });

  try {
    git(repoRoot, ['init']);
    git(repoRoot, ['config', 'user.name', 'Test User']);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);

    writeHookFixture(repoRoot, 'MAIN');
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# temp repo\n');
    git(repoRoot, ['add', 'README.md', 'hooks/install-git-hooks.js', 'hooks/pre-commit-scan.js']);
    git(repoRoot, ['commit', '-m', 'init']);

    const install = spawnSync(process.execPath, [path.join(repoRoot, 'hooks', 'install-git-hooks.js')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(install.status, 0, `installer failed: ${install.stderr || install.stdout}`);

    const hookPath = resolveGitPath(repoRoot, git(repoRoot, ['rev-parse', '--git-path', 'hooks/pre-commit']));
    assert.equal(fs.existsSync(hookPath), true, `expected hook at ${hookPath}`);
  } finally {
    cleanup(tmpDir);
  }
});

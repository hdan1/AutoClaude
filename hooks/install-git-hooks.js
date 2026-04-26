#!/usr/bin/env node
'use strict';
/**
 * Installs git hooks by writing shell scripts to .git/hooks/.
 * Runs automatically via npm "prepare" script.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function resolveGitHooksDir(root) {
  try {
    const hooksPath = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    return path.isAbsolute(hooksPath) ? hooksPath : path.join(root, hooksPath);
  } catch {
    return null;
  }
}

const GIT_HOOKS_DIR = resolveGitHooksDir(ROOT);

// Only run if git metadata is available (skip in CI or non-git environments)
if (!GIT_HOOKS_DIR) {
  console.log('Not a git repo — skipping hook install');
  process.exit(0);
}

// Ensure hooks directory exists
if (!fs.existsSync(GIT_HOOKS_DIR)) {
  fs.mkdirSync(GIT_HOOKS_DIR, { recursive: true });
}

const hookPath = path.join(GIT_HOOKS_DIR, 'pre-commit');

const hookContent = `#!/bin/sh
# Auto-installed by Auto Claude — runs pre-commit safety scan
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
node "$repo_root/hooks/pre-commit-scan.js"
`;

fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
console.log('✅ Pre-commit hook installed');

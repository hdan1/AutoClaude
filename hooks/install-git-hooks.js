#!/usr/bin/env node
'use strict';
/**
 * Installs git hooks by writing shell scripts to .git/hooks/.
 * Runs automatically via npm "prepare" script.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GIT_HOOKS_DIR = path.join(ROOT, '.git', 'hooks');

// Only run if .git exists (skip in CI or non-git environments)
if (!fs.existsSync(path.join(ROOT, '.git'))) {
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
node "$(dirname "$0")/../../hooks/pre-commit-scan.js"
`;

fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
console.log('✅ Pre-commit hook installed');

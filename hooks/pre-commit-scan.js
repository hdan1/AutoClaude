#!/usr/bin/env node
'use strict';
/**
 * Pre-commit hook: scans staged files for sensitive data patterns.
 * Blocks the commit if anything suspicious is found.
 * Bypass with: git commit --no-verify
 */
const { execSync } = require('child_process');
const path = require('path');

// ── Blocked file extensions ──────────────────────
const BLOCKED_EXTENSIONS = new Set([
  '.db', '.sqlite', '.sqlite3',
  '.env', '.pem', '.key', '.p12', '.pfx',
]);

// ── Blocked filename patterns ────────────────────
const BLOCKED_NAMES = [
  /credentials/i,
  /keystore/i,
  /\.env\./,
];

// ── Content patterns (regex + description) ───────
const CONTENT_PATTERNS = [
  { re: /sk-[a-zA-Z0-9]{20,}/, desc: 'Possible API key (sk-...)' },
  { re: /ghp_[a-zA-Z0-9]{36}/, desc: 'GitHub personal access token' },
  { re: /bot[0-9]{8,}:[A-Za-z0-9_-]{35}/, desc: 'Telegram bot token' },
  { re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/, desc: 'Private key' },
  { re: /password\s*[:=]\s*['"][^'"]{4,}['"]/, desc: 'Hardcoded password' },
  { re: /secret\s*[:=]\s*['"][^'"]{4,}['"]/, desc: 'Hardcoded secret' },
];

function main() {
  // Get staged files (added, copied, modified only)
  let files;
  try {
    const raw = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' });
    files = raw.trim().split('\n').filter(Boolean);
  } catch {
    process.exit(0); // Can't get staged files — allow commit
  }

  if (files.length === 0) process.exit(0);

  const issues = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const basename = path.basename(file);

    // Check blocked extensions
    if (BLOCKED_EXTENSIONS.has(ext)) {
      issues.push({ file, reason: `Blocked file extension: ${ext}` });
      continue;
    }

    // Check blocked filenames
    for (const pat of BLOCKED_NAMES) {
      if (pat.test(basename)) {
        issues.push({ file, reason: `Blocked filename pattern: ${pat}` });
        break;
      }
    }

    // Scan file contents for secrets
    try {
      const content = execSync(`git show ":${file}"`, { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
      for (const { re, desc } of CONTENT_PATTERNS) {
        const match = content.match(re);
        if (match) {
          issues.push({ file, reason: desc, match: match[0].substring(0, 40) + '...' });
        }
      }
    } catch {
      // Binary file or can't read — skip content scan
    }
  }

  if (issues.length > 0) {
    console.error('\n🚨 PRE-COMMIT SAFETY SCAN FAILED\n');
    console.error('The following issues were detected in staged files:\n');
    for (const { file, reason, match } of issues) {
      console.error(`  ❌ ${file}`);
      console.error(`     ${reason}`);
      if (match) console.error(`     Found: ${match}`);
      console.error('');
    }
    console.error('To fix: unstage the file or remove the sensitive data.');
    console.error('To bypass (if false positive): git commit --no-verify\n');
    process.exit(1);
  }

  process.exit(0);
}

main();

// test/helpers.js — Shared test utilities
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir(prefix = 'auto-claude-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    },
  };
}

function createTree(root, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function normPath(p) {
  return p.replace(/\\/g, '/');
}

module.exports = { tmpDir, createTree, normPath };

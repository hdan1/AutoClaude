const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'install-hooks.js');

function createProjectWithInstalledHooks() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-hooks-cli-'));
  const projectDir = path.join(tmpDir, 'project');
  const settingsDir = path.join(projectDir, '.claude');
  const settingsFile = path.join(settingsDir, 'settings.json');

  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      hooks: {
        PostToolUse: [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: 'node /tmp/auto-claude-hook.js',
            async: true,
          }],
        }],
        Notification: [{
          matcher: 'keep-me',
          hooks: [{
            type: 'command',
            command: 'node /tmp/other-hook.js',
            async: true,
          }],
        }],
      },
    }, null, 2)
  );

  return { tmpDir, projectDir, settingsFile };
}

function readSettings(settingsFile) {
  return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
}

function runUninstall(args, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('uninstalls hooks when --uninstall comes before the project directory', () => {
  const { tmpDir, projectDir, settingsFile } = createProjectWithInstalledHooks();

  try {
    const result = runUninstall(['--uninstall', projectDir], tmpDir);

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const settings = readSettings(settingsFile);
    assert.equal(settings.hooks.PostToolUse, undefined);
    assert.equal(settings.hooks.Notification.length, 1);
    assert.match(result.stdout, /Removed auto-claude hooks/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('uninstalls hooks when --uninstall comes after the project directory', () => {
  const { tmpDir, projectDir, settingsFile } = createProjectWithInstalledHooks();

  try {
    const result = runUninstall([projectDir, '--uninstall'], tmpDir);

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const settings = readSettings(settingsFile);
    assert.equal(settings.hooks.PostToolUse, undefined);
    assert.equal(settings.hooks.Notification.length, 1);
    assert.match(result.stdout, /Removed auto-claude hooks/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

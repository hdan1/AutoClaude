const { spawn, execSync } = require('child_process');
const EventEmitter = require('events');
const os = require('os');
const path = require('path');

const INSTALL_COMMANDS = {
  powershell: { cmd: 'powershell', args: ['-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex'] },
  cmd:        { cmd: 'cmd', args: ['/c', 'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd'] },
  winget:     { cmd: 'winget', args: ['install', 'Anthropic.ClaudeCode', '--accept-package-agreements', '--accept-source-agreements'] },
  curl:       { cmd: 'bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] },
  homebrew:   { cmd: 'brew', args: ['install', '--cask', 'claude-code'] },
};

// Platform-specific prerequisite install commands
const PREREQUISITE_COMMANDS = {
  git: {
    win32:  { cmd: 'winget', args: ['install', 'Git.Git', '--accept-package-agreements', '--accept-source-agreements'] },
    darwin: { cmd: 'brew', args: ['install', 'git'] },
    linux:  null, // varies by distro, show instructions instead
  },
  node: {
    win32:  { cmd: 'winget', args: ['install', 'OpenJS.NodeJS.LTS', '--accept-package-agreements', '--accept-source-agreements'] },
    darwin: { cmd: 'brew', args: ['install', 'node'] },
    linux:  null,
  },
};

function install(method) {
  const emitter = new EventEmitter();
  const spec = INSTALL_COMMANDS[method];
  if (!spec) {
    setTimeout(() => emitter.emit('error', `Unknown install method: ${method}`), 0);
    return emitter;
  }

  const proc = spawn(spec.cmd, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  proc.stdout.on('data', d => emitter.emit('progress', d.toString()));
  proc.stderr.on('data', d => emitter.emit('progress', d.toString()));

  proc.on('close', code => {
    if (code === 0) {
      emitter.emit('complete');
    } else {
      emitter.emit('error', `Install exited with code ${code}`);
    }
  });

  proc.on('error', err => emitter.emit('error', err.message));

  return emitter;
}

function authenticate(method) {
  const emitter = new EventEmitter();
  let cmd, args;

  if (method === 'anthropic') {
    cmd = 'claude'; args = ['auth', 'login'];
  } else if (method === 'console') {
    cmd = 'claude'; args = ['auth', 'login', '--console'];
  } else {
    setTimeout(() => emitter.emit('error', 'Use custom provider or cloud provider settings instead'), 0);
    return emitter;
  }

  const proc = spawn(cmd, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });

  proc.stdout.on('data', d => emitter.emit('progress', d.toString()));
  proc.stderr.on('data', d => emitter.emit('progress', d.toString()));
  proc.on('close', code => {
    if (code === 0) emitter.emit('complete');
    else emitter.emit('error', `Auth exited with code ${code}`);
  });
  proc.on('error', err => emitter.emit('error', err.message));

  return emitter;
}

function installPrerequisite(name) {
  const emitter = new EventEmitter();
  const platform = process.platform;
  const commands = PREREQUISITE_COMMANDS[name];

  if (!commands) {
    setTimeout(() => emitter.emit('error', `Unknown prerequisite: ${name}`), 0);
    return emitter;
  }

  const spec = commands[platform];
  if (!spec) {
    const instructions = {
      git: 'Install git using your system package manager (e.g., apt install git, dnf install git)',
      node: 'Install Node.js from https://nodejs.org or via your package manager (e.g., apt install nodejs)',
    };
    setTimeout(() => emitter.emit('error', instructions[name] || `No auto-installer for ${name} on ${platform}`), 0);
    return emitter;
  }

  const proc = spawn(spec.cmd, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  proc.stdout.on('data', d => emitter.emit('progress', d.toString()));
  proc.stderr.on('data', d => emitter.emit('progress', d.toString()));

  proc.on('close', code => {
    if (code === 0) emitter.emit('complete');
    else emitter.emit('error', `Install of ${name} exited with code ${code}`);
  });

  proc.on('error', err => emitter.emit('error', err.message));

  return emitter;
}

/**
 * Add Claude's install directory to the user's PATH on Windows.
 * On macOS/Linux, the installer typically handles this via shell profile.
 */
function addClaudeToPath() {
  const platform = process.platform;
  const claudeDir = path.join(os.homedir(), '.local', 'bin');

  if (platform === 'win32') {
    try {
      // Read current user PATH from registry
      const currentPath = execSync(
        'reg query "HKCU\\Environment" /v Path',
        { encoding: 'utf8', windowsHide: true }
      );
      // Extract the PATH value
      const match = currentPath.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
      const existingPath = match ? match[1].trim() : '';

      // Check if already in PATH
      const pathDirs = existingPath.split(';').map(d => d.toLowerCase().replace(/\\$/, ''));
      if (pathDirs.includes(claudeDir.toLowerCase().replace(/\\$/, ''))) {
        return { ok: true, message: 'Claude directory already in PATH' };
      }

      // Add to user PATH via registry
      const newPath = existingPath ? `${existingPath};${claudeDir}` : claudeDir;
      execSync(
        `reg add "HKCU\\Environment" /v Path /t REG_EXPAND_SZ /d "${newPath}" /f`,
        { encoding: 'utf8', windowsHide: true }
      );

      // Broadcast WM_SETTINGCHANGE so running processes pick up the change
      try {
        execSync(
          'powershell -NoProfile -Command "[System.Environment]::SetEnvironmentVariable(\'__dummy__\',\'\',[System.EnvironmentVariableTarget]::User)"',
          { windowsHide: true, timeout: 5000 }
        );
      } catch { /* non-critical */ }

      // Also update current process PATH so detection works immediately
      process.env.PATH = `${claudeDir};${process.env.PATH || ''}`;

      return { ok: true, message: `Added ${claudeDir} to user PATH. Restart terminals for full effect.` };
    } catch (e) {
      return { ok: false, error: `Failed to update PATH: ${e.message}` };
    }
  }

  // macOS/Linux: typically handled by installer, but add to shell profile if needed
  if (platform === 'darwin' || platform === 'linux') {
    const shell = process.env.SHELL || '/bin/bash';
    const profileFile = shell.includes('zsh') ? '.zshrc' : '.bashrc';
    const profilePath = path.join(os.homedir(), profileFile);
    const exportLine = `export PATH="$HOME/.local/bin:$PATH"`;

    try {
      const fs = require('fs');
      const content = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
      if (content.includes('.local/bin')) {
        return { ok: true, message: 'Claude directory already in PATH' };
      }
      fs.appendFileSync(profilePath, `\n# Added by Auto Claude\n${exportLine}\n`);
      process.env.PATH = `${claudeDir}:${process.env.PATH || ''}`;
      return { ok: true, message: `Added to ${profileFile}. Restart terminal for full effect.` };
    } catch (e) {
      return { ok: false, error: `Failed to update ${profileFile}: ${e.message}` };
    }
  }

  return { ok: false, error: `Unsupported platform: ${platform}` };
}

module.exports = { install, authenticate, installPrerequisite, addClaudeToPath, INSTALL_COMMANDS, PREREQUISITE_COMMANDS };

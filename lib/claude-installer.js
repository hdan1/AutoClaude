const { spawn, execSync } = require('child_process');
const { spawnClaude } = require('./spawn-claude');
const EventEmitter = require('events');
const os = require('os');
const path = require('path');

const PLATFORM_METHODS = {
  win32:  new Set(['powershell', 'cmd', 'winget']),
  darwin: new Set(['curl', 'homebrew']),
  linux:  new Set(['curl', 'homebrew']),
};

const INSTALL_COMMANDS = {
  powershell: { cmd: 'powershell', args: ['-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex'] },
  cmd:        { cmd: 'cmd', args: ['/c', 'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd'] },
  winget:     { cmd: 'winget', args: ['install', 'Anthropic.ClaudeCode', '--accept-package-agreements', '--accept-source-agreements'] },
  curl:       { cmd: 'bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] },
  homebrew:   { cmd: 'brew', args: process.platform === 'darwin'
    ? ['install', '--cask', 'claude-code']
    : ['install', 'claude-code'] },
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
  const allowed = PLATFORM_METHODS[process.platform];
  if (allowed && !allowed.has(method)) {
    setTimeout(() => emitter.emit('error', `Install method '${method}' is not available on ${process.platform}. Available: ${[...allowed].join(', ')}`), 0);
    return emitter;
  }
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
  let args;

  if (method === 'anthropic') {
    args = ['auth', 'login'];
  } else if (method === 'console') {
    args = ['auth', 'login', '--console'];
  } else {
    setTimeout(() => emitter.emit('error', 'Use custom provider or cloud provider settings instead'), 0);
    return emitter;
  }

  const proc = spawnClaude(args, {
    stdio: ['inherit', 'pipe', 'pipe'],
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
 * Add Claude's install directory (~/.local/bin) to the user's PATH.
 * Works on Windows (registry), macOS, and Linux (shell profiles + fish).
 * Idempotent — safe to call multiple times.
 */
function addClaudeToPath() {
  const fs = require('fs');
  const platform = process.platform;
  const claudeDir = path.join(os.homedir(), '.local', 'bin');

  // Verify the directory actually exists before adding to PATH
  if (!fs.existsSync(claudeDir)) {
    try { fs.mkdirSync(claudeDir, { recursive: true }); } catch { /* best-effort */ }
  }

  if (platform === 'win32') {
    return _addToPathWindows(claudeDir);
  }

  if (platform === 'darwin' || platform === 'linux') {
    return _addToPathUnix(fs, claudeDir, platform);
  }

  return { ok: false, error: `Unsupported platform: ${platform}` };
}

/** @private Windows: persist to user registry + broadcast change */
function _addToPathWindows(claudeDir) {
  try {
    // Read current user PATH from registry
    let existingPath = '';
    try {
      const currentPath = execSync(
        'reg query "HKCU\\Environment" /v Path',
        { encoding: 'utf8', windowsHide: true }
      );
      const match = currentPath.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
      existingPath = match ? match[1].trim() : '';
    } catch {
      // Path key may not exist yet — that's fine, we'll create it
    }

    // Check if already in PATH
    const pathDirs = existingPath.split(';').map(d => d.toLowerCase().replace(/[\\/]+$/, ''));
    if (pathDirs.includes(claudeDir.toLowerCase().replace(/[\\/]+$/, ''))) {
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

/** @private macOS/Linux: add export to all relevant shell profiles + fish */
function _addToPathUnix(fs, claudeDir, platform) {
  const home = os.homedir();
  const exportLine = `export PATH="$HOME/.local/bin:$PATH"`;
  const comment = '# Added by Auto Claude';
  const updated = [];
  const errors = [];

  // Determine which shell profile files to update.
  // We write to ALL profiles that exist (or that the user's shell expects)
  // because users may open different terminal types.
  const shell = process.env.SHELL || '/bin/bash';
  const profileFiles = [];

  // Always try .profile — sourced by login shells on most Linux distros/display managers
  if (platform === 'linux') {
    profileFiles.push('.profile');
  }

  if (shell.includes('zsh')) {
    profileFiles.push('.zshrc');
  } else if (shell.includes('bash')) {
    // macOS Terminal.app sources .bash_profile, not .bashrc
    if (platform === 'darwin') {
      profileFiles.push('.bash_profile');
    }
    profileFiles.push('.bashrc');
  }

  // Also update .zshrc on macOS even if current shell is bash,
  // since macOS default shell is zsh and user may switch
  if (platform === 'darwin' && !profileFiles.includes('.zshrc')) {
    profileFiles.push('.zshrc');
  }

  let anyUpdated = false;
  for (const file of profileFiles) {
    const filePath = path.join(home, file);
    try {
      const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      if (content.includes('.local/bin')) {
        // Already present — skip
        continue;
      }
      fs.appendFileSync(filePath, `\n${comment}\n${exportLine}\n`);
      updated.push(file);
      anyUpdated = true;
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
    }
  }

  // Fish shell support — uses a different syntax
  if (shell.includes('fish') || fs.existsSync(path.join(home, '.config', 'fish'))) {
    const fishConfDir = path.join(home, '.config', 'fish', 'conf.d');
    const fishFile = path.join(fishConfDir, 'auto-claude-path.fish');
    try {
      if (!fs.existsSync(fishFile)) {
        fs.mkdirSync(fishConfDir, { recursive: true });
        fs.writeFileSync(fishFile, `# Added by Auto Claude\nfish_add_path -g $HOME/.local/bin\n`);
        updated.push('fish conf.d');
        anyUpdated = true;
      }
    } catch (e) {
      errors.push(`fish: ${e.message}`);
    }
  }

  // Update current process PATH so detection works immediately
  if (!process.env.PATH?.includes(claudeDir)) {
    process.env.PATH = `${claudeDir}:${process.env.PATH || ''}`;
  }

  if (anyUpdated) {
    return { ok: true, message: `Added to ${updated.join(', ')}. Restart terminal for full effect.` };
  }
  if (errors.length) {
    return { ok: false, error: `Failed to update shell profiles: ${errors.join('; ')}` };
  }
  return { ok: true, message: 'Claude directory already in PATH' };
}

module.exports = { install, authenticate, installPrerequisite, addClaudeToPath, INSTALL_COMMANDS, PREREQUISITE_COMMANDS };

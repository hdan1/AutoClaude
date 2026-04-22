'use strict';
const {
  SDK_OUTPUT_FORMAT,
  SDK_INPUT_FORMAT,
} = require('./constants');

function shouldPassSessionModel(prompt) {
  return !(prompt && /^\/model(?:\s|$)/i.test(prompt.trim()));
}

function normalizeCliResultError(message) {
  if (typeof message !== 'string') return message;
  const trimmed = message.trim();
  if (/^Unknown skill:\s*model\s*$/i.test(trimmed)) {
    return 'Unknown skill: model (this Claude Code environment does not expose /model; use session model setting or --model).';
  }
  const m = trimmed.match(/^Unknown skill:\s*([a-z0-9_-]+)\s*$/i);
  if (m) {
    const skill = m[1].toLowerCase();
    const interactiveOnly = new Set(['clear', 'compact', 'config', 'cost', 'init', 'memory', 'review', 'status', 'terminal-setup']);
    if (interactiveOnly.has(skill)) {
      return `Unknown skill: ${skill} (built-in slash commands are interactive-only in this print-mode flow; use Auto Claude controls or mapped CLI equivalents).`;
    }
  }
  return message;
}

function parsePluginSlashCommand(prompt) {
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trim();
  const m = trimmed.match(/^\/(plugin|plugins)(?:\s+(.*))?$/i);
  if (!m) return null;
  const rest = (m[2] || '').trim();
  return rest ? rest.split(/\s+/).filter(Boolean) : [];
}

function parseSlashCommand(prompt) {
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trim();
  const m = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/);
  if (!m) return null;
  const command = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  const args = rest ? rest.split(/\s+/).filter(Boolean) : [];
  return { command, args, raw: trimmed };
}

function normalizePrompt(prompt) {
  let p = prompt.replace(/^\/\/+/, '/');
  p = p.replace(/^\/([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)/, '/$1-$2');
  return p;
}

function buildPrintModeArgs(options, config, overrides = {}) {
  const args = ['--output-format', 'stream-json', '--verbose'];
  if (config?.skipPermissions !== false) args.push('--dangerously-skip-permissions');
  if (options?.mode === 'resume' && options?.sessionId) args.push('-r', options.sessionId);
  if (options?.mode === 'continue') {
    args.push('--continue');
    if (options?.sessionId) args.push('-r', options.sessionId);
  }

  const prompt = overrides.prompt !== undefined ? overrides.prompt : options?.prompt;
  if (prompt) args.push('-p', normalizePrompt(prompt));

  const shouldPass = !overrides.forceSkipDefaultModel && shouldPassSessionModel(prompt);
  if (overrides.model && overrides.model !== 'auto') {
    args.push('--model', overrides.model);
  } else if (shouldPass && config?.session?.model && config.session.model !== 'auto') {
    args.push('--model', config.session.model);
  }

  if (config?.session?.effort && config.session.effort !== 'auto') {
    args.push('--effort', config.session.effort);
  }
  return args;
}

function mapSlashCommandToCliArgs(options, config) {
  const slash = parseSlashCommand(options?.prompt);
  if (!slash) return null;

  if (slash.command === 'plugin' || slash.command === 'plugins') return ['plugins', ...slash.args];
  if (slash.command === 'mcp') return ['mcp', ...slash.args];
  if (slash.command === 'doctor') return ['doctor', ...slash.args];
  if (slash.command === 'help') return ['--help'];
  if (slash.command === 'login') return ['auth', 'login'];
  if (slash.command === 'logout') return ['auth', 'logout'];
  if (slash.command === 'status') return ['auth', 'status'];
  if (slash.command === 'model' && slash.args.length > 0) {
    return buildPrintModeArgs(
      { ...options, prompt: 'continue' },
      config,
      { model: slash.args[0], forceSkipDefaultModel: true }
    );
  }
  return null;
}

function getSlashFallbackConfig(config) {
  const cfg = config?.runtime?.slashFallback || {};
  return {
    enabled: cfg.enabled !== false,
    timeoutMs: typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : 45000,
    logRawOutput: !!cfg.logRawOutput,
  };
}

function resolveExecutionPlan(options, config) {
  const mapped = mapSlashCommandToCliArgs(options, config);
  if (mapped) {
    const isPrint = mapped[0] === '--output-format';
    return {
      mode: isPrint ? 'print' : 'cli-subcommand',
      args: mapped,
      reason: isPrint ? 'print-mapped' : 'direct-cli-map',
      originalPrompt: options?.prompt || '',
    };
  }

  const slash = parseSlashCommand(options?.prompt);
  const fallback = getSlashFallbackConfig(config);
  const interactiveOnly = new Set(['clear', 'compact', 'config', 'cost', 'init', 'memory', 'review', 'terminal-setup']);

  if (slash && interactiveOnly.has(slash.command) && fallback.enabled) {
    return {
      mode: 'pty-fallback',
      args: [],
      reason: 'interactive-only-slash',
      originalPrompt: slash.raw,
      timeoutMs: fallback.timeoutMs,
      logRawOutput: fallback.logRawOutput,
    };
  }

  return {
    mode: 'print',
    args: buildPrintModeArgs(options, config),
    reason: 'default-print',
    originalPrompt: options?.prompt || '',
  };
}

function buildSDKModeArgs(prompt, options, config) {
  const args = ['-p', prompt, '--output-format', SDK_OUTPUT_FORMAT, '--input-format', SDK_INPUT_FORMAT];
  if (options.sessionId) args.push('--session-id', options.sessionId);
  if (options.resume) args.push('--resume', options.resume);
  if (config.model && config.model !== 'auto') args.push('--model', config.model);
  if (config.skipPermissions) args.push('--dangerously-skip-permissions');
  args.push('--include-hook-events');
  args.push('--replay-user-messages');
  if (config.verbose) args.push('--verbose');
  return args;
}

module.exports = {
  shouldPassSessionModel,
  normalizeCliResultError,
  parsePluginSlashCommand,
  parseSlashCommand,
  normalizePrompt,
  buildPrintModeArgs,
  mapSlashCommandToCliArgs,
  getSlashFallbackConfig,
  resolveExecutionPlan,
  buildSDKModeArgs,
};

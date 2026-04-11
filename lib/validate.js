// lib/validate.js — IPC input validation (H1: No IPC input validation)

const fs = require('fs');
const { DANGEROUS_PATH_CHARS } = require('./constants');

/**
 * Validate and sanitize a directory path.
 * Returns { valid: true, path: sanitizedPath } or { valid: false, error: message }
 */
function validateProjectDir(dir) {
  if (!dir || typeof dir !== 'string') {
    return { valid: false, error: 'projectDir must be a non-empty string' };
  }
  const trimmed = dir.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'projectDir cannot be empty' };
  }
  if (trimmed.length > 500) {
    return { valid: false, error: 'projectDir path is too long (max 500 chars)' };
  }
  // C2: Block dangerous characters that could enable command injection
  if (DANGEROUS_PATH_CHARS.test(trimmed)) {
    return { valid: false, error: 'projectDir contains invalid characters' };
  }
  if (!fs.existsSync(trimmed)) {
    return { valid: false, error: `Directory does not exist: ${trimmed}` };
  }
  const stat = fs.statSync(trimmed);
  if (!stat.isDirectory()) {
    return { valid: false, error: `Path is not a directory: ${trimmed}` };
  }
  return { valid: true, path: trimmed };
}

/**
 * Validate prompt parameter.
 */
function validatePrompt(val) {
  if (val === undefined || val === null || val === '') return { valid: true, prompt: '' };
  if (typeof val !== 'string') return { valid: false, error: 'Prompt must be a string' };
  if (val.length > 50000) return { valid: false, error: 'Prompt too long (max 50000 chars)' };
  return { valid: true, prompt: val.trim() };
}

/**
 * Validate and sanitize config object for save-config.
 * Only allow known keys with correct types. (H1)
 */
function validateConfig(incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { valid: false, error: 'Config must be a plain object' };
  }

  const ALLOWED_KEYS = {
    projectDir: 'string',
    workspaceRoot: 'string',
    defaultPrompt: 'string',
    skipPermissions: 'boolean',
    retry: 'object',
    notifications: 'object',
    hooks: 'object',
    autoAnswer: 'object',
    telegram: 'object',
    runtime: 'object',
  };

  const sanitized = {};
  for (const [key, val] of Object.entries(incoming)) {
    if (!(key in ALLOWED_KEYS)) continue; // Skip unknown keys
    const expectedType = ALLOWED_KEYS[key];
    if (typeof val !== expectedType) continue; // Skip wrong types

    // Deep-validate sub-objects
    if (key === 'retry' && typeof val === 'object') {
      sanitized.retry = {};
      if (typeof val.enabled === 'boolean') sanitized.retry.enabled = val.enabled;
      if (typeof val.maxRetries === 'number' && val.maxRetries >= 0 && val.maxRetries <= 10) {
        sanitized.retry.maxRetries = val.maxRetries;
      }
      if (Array.isArray(val.backoffSeconds)) {
        sanitized.retry.backoffSeconds = val.backoffSeconds
          .filter(s => typeof s === 'number' && s >= 1 && s <= 600)
          .slice(0, 10);
      }
    } else if (key === 'notifications' && typeof val === 'object') {
      sanitized.notifications = {};
      for (const nk of ['onQuestion', 'onComplete', 'onError']) {
        if (typeof val[nk] === 'boolean') sanitized.notifications[nk] = val[nk];
      }
    } else if (key === 'hooks' && typeof val === 'object') {
      sanitized.hooks = {};
      if (typeof val.install === 'boolean') sanitized.hooks.install = val.install;
      if (typeof val.logFile === 'string' && val.logFile.length < 200) sanitized.hooks.logFile = val.logFile;
    } else if (key === 'autoAnswer' && typeof val === 'object') {
      sanitized.autoAnswer = {};
      for (const bk of ['selectRecommended', 'selectAll', 'fullAutonomy', 'derailmentCorrection', 'skipReviewInFullAutonomy']) {
        if (typeof val[bk] === 'boolean') sanitized.autoAnswer[bk] = val[bk];
      }
      if (typeof val.mode === 'string' && ['full', 'review', 'manual'].includes(val.mode)) {
        sanitized.autoAnswer.mode = val.mode;
      }
      for (const nk of ['reviewCountdownSeconds', 'noRecommendedTimeoutSeconds']) {
        if (typeof val[nk] === 'number' && val[nk] >= 1 && val[nk] <= 300) sanitized.autoAnswer[nk] = val[nk];
      }
      for (const nk of ['questionTimeoutSeconds', 'criticalQuestionTimeoutSeconds']) {
        if (typeof val[nk] === 'number' && val[nk] >= 10 && val[nk] <= 3600) sanitized.autoAnswer[nk] = val[nk];
      }
    } else if (key === 'telegram' && typeof val === 'object') {
      sanitized.telegram = {};
      if (typeof val.enabled === 'boolean') sanitized.telegram.enabled = val.enabled;
      if (Array.isArray(val.allowedUsers)) {
        sanitized.telegram.allowedUsers = val.allowedUsers
          .filter(s => typeof s === 'string' && s.trim().length > 0)
          .map(s => s.trim())
          .slice(0, 50);
      }
    } else if (key === 'runtime' && typeof val === 'object') {
      sanitized.runtime = {};
      if (val.slashFallback && typeof val.slashFallback === 'object') {
        sanitized.runtime.slashFallback = {};
        if (typeof val.slashFallback.enabled === 'boolean') {
          sanitized.runtime.slashFallback.enabled = val.slashFallback.enabled;
        }
        if (typeof val.slashFallback.logRawOutput === 'boolean') {
          sanitized.runtime.slashFallback.logRawOutput = val.slashFallback.logRawOutput;
        }
        if (
          typeof val.slashFallback.timeoutMs === 'number'
          && val.slashFallback.timeoutMs >= 10000
          && val.slashFallback.timeoutMs <= 120000
        ) {
          sanitized.runtime.slashFallback.timeoutMs = val.slashFallback.timeoutMs;
        }
      }
    } else if (key === 'projectDir') {
      const check = validateProjectDir(val);
      if (check.valid) sanitized.projectDir = check.path;
    } else if (key === 'workspaceRoot') {
      if (val === '') {
        sanitized.workspaceRoot = '';
      } else {
        const check = validateProjectDir(val);
        if (check.valid) sanitized.workspaceRoot = check.path;
      }
    } else if (key === 'defaultPrompt') {
      if (typeof val === 'string' && val.length < 50000) sanitized.defaultPrompt = val;
    } else if (key === 'skipPermissions') {
      sanitized.skipPermissions = val;
    }
  }

  return { valid: true, config: sanitized };
}

/**
 * Validate user response text for send-response.
 */
function validateResponse(text) {
  if (!text || typeof text !== 'string') {
    return { valid: false, error: 'Response must be a non-empty string' };
  }
  if (text.length > 10000) {
    return { valid: false, error: 'Response too long (max 10000 chars)' };
  }
  return { valid: true, text: text.trim() };
}

function validateMasterTelegramConfig(incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { valid: false, error: 'Master telegram config must be a plain object' };
  }
  const sanitized = {
    enabled: !!incoming.enabled,
    allowedUsers: [],
  };

  if ('allowedUsers' in incoming) {
    if (!Array.isArray(incoming.allowedUsers)) {
      return { valid: false, error: 'Master telegram allowedUsers must be an array of strings' };
    }
    const users = incoming.allowedUsers
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      .map(s => s.trim())
      .slice(0, 50);
    sanitized.allowedUsers = users;
  }

  if ('botToken' in incoming) {
    if (incoming.botToken !== null && typeof incoming.botToken !== 'string') {
      return { valid: false, error: 'Master telegram botToken must be a string when provided' };
    }
    const token = typeof incoming.botToken === 'string' ? incoming.botToken.trim() : '';
    if (token.length > 0) sanitized.botToken = token;
  }

  return { valid: true, config: sanitized };
}

function validateProjectTelegramConfig(incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { ok: false, error: 'Project telegram config must be a plain object' };
  }
  const sanitized = {
    enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : false,
    allowedUsers: [],
  };

  if ('allowedUsers' in incoming) {
    if (!Array.isArray(incoming.allowedUsers)) {
      return { ok: false, error: 'Project telegram allowedUsers must be an array of strings' };
    }
    sanitized.allowedUsers = incoming.allowedUsers
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      .map(s => s.trim())
      .slice(0, 50);
  }

  return { ok: true, config: sanitized };
}

function validateProjectTokenDistinct(projectToken, masterToken) {
  const project = typeof projectToken === 'string' ? projectToken.trim() : '';
  const master = typeof masterToken === 'string' ? masterToken.trim() : '';
  if (!project || !master) return { ok: true };
  if (project === master) {
    return {
      ok: false,
      error: 'Duplicate token detected: master token must differ from project token.',
      code: 'DUPLICATE_TELEGRAM_TOKEN',
    };
  }
  return { ok: true };
}

// Backward compat shim
function validateDistinctTelegramTokens(sessionToken, masterToken) {
  const r = validateProjectTokenDistinct(sessionToken, masterToken);
  return { valid: r.ok !== false, error: r.error, code: r.code };
}

module.exports = {
  validateProjectDir,
  validatePrompt,
  validateConfig,
  validateMasterTelegramConfig,
  validateDistinctTelegramTokens,
  validateProjectTelegramConfig,
  validateProjectTokenDistinct,
  validateResponse,
};

// lib/context-guard.js -- Turn-boundary context guard
// Detects when context usage exceeds threshold and provides
// workflow-aware handoff/resume prompts for seamless recovery.

const {
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  CONTEXT_GUARD_DEFAULTS,
  GSD_CONTEXT_WARNING_RE,
  GSD_CONTEXT_CRITICAL_RE,
} = require('./constants');

const HANDOFF_FILE = '.auto-claude-handoff.md';

const HANDOFF_PROMPT_GENERIC = `Context is nearly full. Please write a brief handoff summary to ${HANDOFF_FILE} describing:
1. What you were working on
2. What is done so far
3. What remains to be done
4. Any important decisions or context
Then stop.`;

const RESUME_PROMPT_GENERIC = `Read ${HANDOFF_FILE} and continue the work described there. Delete the handoff file when you've understood it.`;

/**
 * Look up the context window size for a model.
 * Tries prefix matching against MODEL_CONTEXT_WINDOWS,
 * then falls back to DEFAULT_CONTEXT_WINDOW.
 *
 * @param {string} modelId - e.g. 'claude-sonnet-4-20250514'
 * @param {number|null} configOverride - user config override
 * @param {number|null} apiMaxInputTokens - from models API if available
 * @returns {number} context window in tokens
 */
function getContextWindow(modelId, configOverride, apiMaxInputTokens) {
  // User override takes highest priority
  if (configOverride && configOverride > 0) return configOverride;

  // API-reported value (from lib/models.js _parseModel) takes second priority
  if (apiMaxInputTokens && apiMaxInputTokens > 0) return apiMaxInputTokens;

  // Prefix match against known models
  if (modelId) {
    for (const [prefix, tokens] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      if (modelId.startsWith(prefix)) return tokens;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Detect GSD context warnings in output text.
 * @param {string} fullText - the turn's accumulated output
 * @returns {'critical'|'warning'|null}
 */
function detectGsdWarning(fullText) {
  if (!fullText) return null;
  if (GSD_CONTEXT_CRITICAL_RE.test(fullText)) return 'critical';
  if (GSD_CONTEXT_WARNING_RE.test(fullText)) return 'warning';
  return null;
}

/**
 * Check whether a context recovery should be triggered.
 *
 * @param {object} result - proxy.run() result with inputTokens, fullText
 * @param {string} model - model ID from session state
 * @param {object} config - global config (reads contextGuard sub-object)
 * @param {number} recoveryCount - how many recoveries already performed
 * @returns {{ recover: boolean, pct: number, reason: string }}
 */
function shouldRecover(result, model, config, recoveryCount) {
  const guard = { ...CONTEXT_GUARD_DEFAULTS, ...(config.contextGuard || {}) };
  if (!guard.enabled) return { recover: false, pct: 0, reason: 'disabled' };

  // Safety: don't exceed max recoveries
  if (recoveryCount >= guard.maxRecoveriesPerSession) {
    return { recover: false, pct: 0, reason: `max recoveries reached (${recoveryCount}/${guard.maxRecoveriesPerSession})` };
  }

  // Need valid input tokens to measure
  if (!result || !result.inputTokens || result.inputTokens <= 0) {
    return { recover: false, pct: 0, reason: 'no token data' };
  }

  const contextWindow = getContextWindow(model, guard.contextWindowOverride, null);
  const hasTrustedInputTokens = result.hasTrustedInputTokens !== false;
  const pct = hasTrustedInputTokens ? (result.inputTokens / contextWindow) : 0;

  // Secondary signal: GSD context warnings can lower threshold or force recovery
  const gsdSignal = detectGsdWarning(result.fullText);

  if (gsdSignal === 'critical') {
    return { recover: true, pct, reason: 'GSD CONTEXT CRITICAL detected' };
  }

  if (!hasTrustedInputTokens) {
    return { recover: false, pct: 0, reason: 'untrusted token metric' };
  }

  // Guard against cumulative or malformed token metrics being interpreted as per-turn usage.
  if (pct > 1) {
    return { recover: false, pct, reason: `invalid token metric (${(pct * 100).toFixed(0)}%)` };
  }

  // GSD warning lowers effective threshold to 70%
  const effectiveThreshold = gsdSignal === 'warning' ? 0.70 : guard.threshold;

  if (pct >= effectiveThreshold) {
    const reasonPrefix = gsdSignal === 'warning' ? 'GSD warning + ' : '';
    return { recover: true, pct, reason: `${reasonPrefix}context at ${(pct * 100).toFixed(0)}% (threshold: ${(effectiveThreshold * 100).toFixed(0)}%)` };
  }

  return { recover: false, pct, reason: 'below threshold' };
}

/**
 * Get the workflow-appropriate handoff prompt.
 * @param {object} sessionState - session.state with skillSource, gsdPhase
 * @returns {string} prompt to send as the handoff turn
 */
function getHandoffPrompt(sessionState) {
  if (sessionState.skillSource === 'gsd' || sessionState.gsdPhase) {
    return '/gsd-pause-work';
  }
  return HANDOFF_PROMPT_GENERIC;
}

/**
 * Get the workflow-appropriate resume prompt.
 * @param {object} sessionState - session.state with skillSource, gsdPhase
 * @returns {string} prompt to send as the first turn of the fresh session
 */
function getResumePrompt(sessionState) {
  if (sessionState.skillSource === 'gsd' || sessionState.gsdPhase) {
    return '/gsd-resume-work';
  }
  return RESUME_PROMPT_GENERIC;
}

module.exports = {
  shouldRecover,
  getHandoffPrompt,
  getResumePrompt,
  getContextWindow,
  detectGsdWarning,
  HANDOFF_FILE,
};

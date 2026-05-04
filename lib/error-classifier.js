'use strict';

const {
  RETRYABLE_PATTERNS,
  FATAL_ERROR_PATTERNS,
  CRASH_RETRY_CODES,
} = require('./constants');

// Error severity levels
const SEVERITY = {
  TRANSIENT: 'transient',   // Rate limit, timeout — retry after backoff
  CAPACITY: 'capacity',     // 529, overloaded — retry or fallback model
  CRASH: 'crash',           // Process crash — retry with delay
  FATAL: 'fatal',           // Auth, permission — don't retry
  UNKNOWN: 'unknown',       // Unclassified non-zero exit
};

const CAPACITY_PATTERNS = [
  'overloaded', '529', 'capacity', '503',
];

const TRANSIENT_PATTERNS = [
  'rate limit', 'rate_limit', '429',
  'timeout', 'etimedout', 'econnreset', 'econnrefused',
  '500', '502', 'system error', '1033',
];

function classifyError(exitCode, errorText) {
  const lower = (errorText || '').toLowerCase();

  if (exitCode === 0) return { severity: null, retryable: false };

  // Fatal — never retry
  if (FATAL_ERROR_PATTERNS.some(p => lower.includes(p))) {
    return { severity: SEVERITY.FATAL, retryable: false, reason: 'fatal error' };
  }

  // Capacity — retry with model fallback option
  if (CAPACITY_PATTERNS.some(p => lower.includes(p))) {
    return { severity: SEVERITY.CAPACITY, retryable: true, reason: 'capacity/overloaded', suggestFallback: true };
  }

  // Transient — retry with backoff
  if (TRANSIENT_PATTERNS.some(p => lower.includes(p))) {
    return { severity: SEVERITY.TRANSIENT, retryable: true, reason: 'transient error' };
  }

  // Process crash codes
  if (exitCode === null || CRASH_RETRY_CODES.includes(exitCode)) {
    return { severity: SEVERITY.CRASH, retryable: true, reason: `crash (exit ${exitCode})` };
  }

  // Unknown non-zero
  if (exitCode !== 0) {
    return { severity: SEVERITY.UNKNOWN, retryable: true, reason: `unknown exit ${exitCode}` };
  }

  return { severity: null, retryable: false };
}

// Circuit breaker: tracks consecutive failures and opens the circuit
// to prevent hammering a failing API.
class CircuitBreaker {
  constructor(opts = {}) {
    this.threshold = opts.threshold || 5;
    this.resetTimeMs = opts.resetTimeMs || 60000;
    this.halfOpenMax = opts.halfOpenMax || 1;

    this.failures = 0;
    this.state = 'closed';       // closed | open | half-open
    this.openedAt = null;
    this.halfOpenAttempts = 0;
  }

  recordSuccess() {
    this.failures = 0;
    this.state = 'closed';
    this.halfOpenAttempts = 0;
  }

  recordFailure(classification) {
    if (classification && !classification.retryable) return;
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  canAttempt() {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.resetTimeMs) {
        this.state = 'half-open';
        this.halfOpenAttempts = 0;
        return true;
      }
      return false;
    }

    // half-open
    if (this.halfOpenAttempts < this.halfOpenMax) {
      this.halfOpenAttempts++;
      return true;
    }
    return false;
  }

  get remainingCooldownMs() {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.resetTimeMs - (Date.now() - this.openedAt));
  }

  reset() {
    this.failures = 0;
    this.state = 'closed';
    this.openedAt = null;
    this.halfOpenAttempts = 0;
  }
}

// Model fallback chain: when capacity errors hit, try the next model
const DEFAULT_FALLBACK_CHAIN = [
  'claude-sonnet-4-20250514',
  'claude-haiku-4-20250414',
];

function getFallbackModel(currentModel, fallbackChain) {
  const chain = fallbackChain || DEFAULT_FALLBACK_CHAIN;
  if (!currentModel || currentModel === 'auto') return null;

  const normalized = currentModel.toLowerCase();
  const idx = chain.findIndex(m => normalized.includes(m.split('-').slice(0, 3).join('-')));

  // If current model is in the chain, return the next one
  if (idx >= 0 && idx < chain.length - 1) return chain[idx + 1];

  // If current model is NOT in the chain (e.g., opus), return first fallback
  if (idx < 0) return chain[0];

  return null;
}

module.exports = {
  SEVERITY,
  classifyError,
  CircuitBreaker,
  getFallbackModel,
  DEFAULT_FALLBACK_CHAIN,
};

'use strict';
const logger = require('./logger');

const MAX_TOTAL_CORRECTIONS = 15;
const MAX_SESSION_CRASHES = 10;
const MAX_DERAILMENTS = 3;
const MAX_HISTORY = 10;
const STUCK_THRESHOLD = 3;
const OSCILLATION_WINDOW = 8;

class TurnLoopController {
  constructor() {
    this.crashRetryCount = 0;
    this.derailmentCount = 0;
    this.contextRecoveryCount = 0;
    this.totalCorrections = 0;
    this.totalCrashRetries = 0;
    this.autoNextHistory = [];
  }

  resetAfterAnswer() {
    this.autoNextHistory.length = 0;
    this.derailmentCount = 0;
  }

  resetForFreshSession() {
    this.autoNextHistory.length = 0;
    this.derailmentCount = 0;
  }

  resetCrashCount() {
    this.crashRetryCount = 0;
  }

  checkCrashRetry(autonomy, result, config) {
    if (!result.exitCode || result.exitCode === 0) {
      this.crashRetryCount = 0;
      return null;
    }

    if (!autonomy.shouldRetry(result.exitCode, result.error, this.crashRetryCount)) {
      return null;
    }

    this.crashRetryCount++;
    this.totalCrashRetries++;

    if (this.totalCrashRetries > MAX_SESSION_CRASHES) {
      return { action: 'stop', reason: `Session crash limit reached (${this.totalCrashRetries} total retries)` };
    }

    const maxR = config.resilience?.maxCrashRetries || 3;
    return {
      action: 'retry',
      attempt: this.crashRetryCount,
      maxRetries: maxR,
      exitCode: result.exitCode,
    };
  }

  checkContextRecovery(contextGuard, result, model, config) {
    const ctxCheck = contextGuard.shouldRecover(result, model, config, this.contextRecoveryCount);
    if (!ctxCheck.recover) return null;

    this.contextRecoveryCount++;
    return {
      action: 'context-recovery',
      pct: ctxCheck.pct,
      reason: ctxCheck.reason,
      count: this.contextRecoveryCount,
      maxRecoveries: config.contextGuard?.maxRecoveriesPerSession || 3,
    };
  }

  checkAutoNext(autonomy, result, session) {
    const nextAction = autonomy.detectAutoNext(result, session);
    if (!nextAction) return null;

    const outputHash = this._fingerprint(result.fullText);
    const entry = { prompt: nextAction.prompt, outputHash };

    // Stuck detection
    const lastEntry = this.autoNextHistory.length > 0
      ? this.autoNextHistory[this.autoNextHistory.length - 1] : null;
    if (lastEntry && lastEntry.prompt === entry.prompt && lastEntry.outputHash === entry.outputHash) {
      const stuckCount = this.autoNextHistory.filter(
        h => h.prompt === entry.prompt && h.outputHash === entry.outputHash
      ).length;
      if (stuckCount >= STUCK_THRESHOLD) {
        return {
          action: 'stop',
          reason: `Loop detected: ${nextAction.prompt} produced identical output ${stuckCount + 1} times`,
        };
      }
    }

    // Oscillation detection
    if (this.autoNextHistory.length >= OSCILLATION_WINDOW) {
      const recent = this.autoNextHistory.slice(-OSCILLATION_WINDOW).concat(entry);
      const uniquePrompts = new Set(recent.map(h => h.prompt));
      if (uniquePrompts.size <= 2) {
        return {
          action: 'stop',
          reason: `Oscillation detected: cycling between ${[...uniquePrompts].join(' \u2194 ')}`,
        };
      }
    }

    this.autoNextHistory.push(entry);
    if (this.autoNextHistory.length > MAX_HISTORY) this.autoNextHistory.shift();

    if (!lastEntry || lastEntry.prompt !== nextAction.prompt) {
      this.derailmentCount = 0;
    }

    this.totalCorrections++;
    if (this.totalCorrections > MAX_TOTAL_CORRECTIONS) {
      return {
        action: 'stop',
        reason: `Total correction limit reached (${this.totalCorrections} auto-next + derailment corrections)`,
      };
    }

    return { action: 'continue', ...nextAction };
  }

  checkDerailment(autonomy, result, session) {
    const derail = autonomy.detectDerailment(result, session);
    if (!derail) return null;

    this.derailmentCount++;
    this.totalCorrections++;

    if (this.derailmentCount > MAX_DERAILMENTS || this.totalCorrections > MAX_TOTAL_CORRECTIONS) {
      return {
        action: 'stop',
        reason: `Derailment correction repeated ${this.derailmentCount} times (${this.totalCorrections} total corrections)`,
      };
    }

    const outputHash = this._fingerprint(result.fullText);
    this.autoNextHistory.push({ prompt: derail.prompt, outputHash });
    if (this.autoNextHistory.length > MAX_HISTORY) this.autoNextHistory.shift();

    return {
      action: 'redirect',
      ...derail,
      count: this.derailmentCount,
      maxDerailments: MAX_DERAILMENTS,
    };
  }

  _fingerprint(text) {
    if (!text) return '';
    const tail = text.length > 500 ? text.slice(-500) : text;
    let h = 0;
    for (let i = 0; i < tail.length; i++) {
      h = ((h << 5) - h + tail.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }
}

module.exports = TurnLoopController;

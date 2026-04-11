// lib/autonomy.js -- Centralized decision engine for Auto Claude
// Classifies questions, produces auto-answers, detects derailment,
// evaluates crash retry, computes session resume state.

const {
  CRITICAL_QUESTION_PATTERNS,
  CRASH_RETRY_CODES,
  FATAL_ERROR_PATTERNS,
  DEFAULT_CRASH_RETRIES,
} = require('./constants');
const { extractQuestions } = require('./question-utils');

class AutonomyEngine {
  constructor(config, workflowManager) {
    this.config = config;
    this.workflows = workflowManager || null;
  }

  // ── Question Classification ────────────────────────

  // Returns { tier: 'simple' | 'critical' | 'unknown' }
  classifyQuestion(questionData) {
    if (!questionData) return { tier: 'unknown' };
    const qList = extractQuestions(questionData);
    if (qList.length === 0) return { tier: 'unknown' };

    const q = qList[0];
    const qText = (q.question || '').toLowerCase();
    const hasOptions = q.options && Array.isArray(q.options) && q.options.length > 0;

    // Check critical patterns first
    for (const pat of CRITICAL_QUESTION_PATTERNS) {
      if (pat.test(qText)) return { tier: 'critical' };
    }

    // Options-based questions are simple (recommended, multi-select, single)
    if (hasOptions) return { tier: 'simple' };

    // Known simple free-text patterns
    if (/\(y\/n\)|\[y\/n\]|shall i|should i|do you want|proceed\?|continue\?|confirm|ready to|go ahead/i.test(qText)) {
      return { tier: 'simple' };
    }

    // Brainstorming / preference delegation
    if (/which.*prefer|what.*would you|how.*should|pick|choose|select|what.*name/i.test(qText)) {
      return { tier: 'simple' };
    }

    // Consult workflow detectors for additional classification
    if (this.workflows) {
      const wfTier = this.workflows.classifyQuestion(questionData);
      if (wfTier === 'critical') return { tier: 'critical' };
      if (wfTier === 'simple') return { tier: 'simple' };
    }

    return { tier: 'unknown' };
  }

  // Produce an auto-answer for a question.
  // Returns { answer, reason } or null if can't auto-answer.
  autoAnswer(questionData, cfg) {
    if (!cfg?.autoAnswer) return null;

    if (questionData) {
      const qList = extractQuestions(questionData);
      if (qList.length > 0) {
        const q = qList[0];
        const qText = q.question || '';
        if (q.options && Array.isArray(q.options)) {
          const optLabels = q.options.map(o => typeof o === 'string' ? o : (o.label || o.value || String(o)));

          // Auto-select all for multi-select (before recommended — multi-select wants all)
          if (cfg.autoAnswer.selectAll && q.multiSelect && optLabels.length >= 2) {
            return {
              answer: optLabels.map((_, i) => String(i + 1)).join(', '),
              reason: `auto-selected all ${optLabels.length} options`,
            };
          }

          // Auto-select recommended option
          if (cfg.autoAnswer.selectRecommended) {
            const recIdx = optLabels.findIndex(l => /\(Recommended\)/i.test(l));
            if (recIdx >= 0) {
              return {
                answer: String(recIdx + 1),
                reason: `auto-selected recommended: "${optLabels[recIdx].replace(/\(Recommended\)/i, '').trim()}"`,
              };
            }
          }

          // Full autonomy: single option
          if (cfg.autoAnswer.fullAutonomy && optLabels.length === 1) {
            return { answer: '1', reason: `auto-selected single option: "${optLabels[0]}"` };
          }

          // Full autonomy: no recommended — fallback to first/all with review flag
          if (cfg.autoAnswer.fullAutonomy && optLabels.length >= 2) {
            const fallbackAnswer = q.multiSelect
              ? optLabels.map((_, i) => String(i + 1)).join(', ')
              : '1';
            const fallbackLabel = q.multiSelect
              ? `all ${optLabels.length} options`
              : `"${optLabels[0]}"`;
            return {
              answer: fallbackAnswer,
              reason: `no recommended — fallback: ${fallbackLabel}`,
              noRecommended: true,
            };
          }
        }

        // Free-text auto-answer (full autonomy)
        if (cfg.autoAnswer.fullAutonomy && qText) {
          if (/\(y\/n\)|\[y\/n\]|shall i|should i|do you want|proceed\?|continue\?|approve|confirm|ready to|go ahead/i.test(qText)) {
            return { answer: 'yes', reason: 'auto-confirmed (y/n pattern)' };
          }
          if (/approve.*plan|review.*plan|does.*plan.*look|is.*plan.*ready|ready to implement/i.test(qText)) {
            return { answer: 'yes, approved - proceed with implementation', reason: 'auto-approved plan' };
          }
          if (/which.*prefer|what.*would you|how.*should|pick|choose|select|what.*name|what.*approach/i.test(qText)) {
            return { answer: 'you decide - pick the best option based on your expertise', reason: 'auto-delegated choice' };
          }
        }
      }
    }

    // Consult workflow detectors for additional auto-answers
    if (this.workflows) {
      const wfAnswer = this.workflows.autoAnswer(questionData, cfg);
      if (wfAnswer) return wfAnswer;
    }

    return null;
  }

  // Top-level question handler. Returns one of:
  //   { action: 'auto-answer', answer, reason, wasCritical? }
  //   { action: 'review', answer, reason, countdown }  // show answer with countdown
  //   { action: 'route-telegram', timeout, questionData }
  //   { action: 'ask-user' }
  handleQuestion(tabId, questionData, telegramBridge) {
    const cfg = this.config;
    if (!cfg.autoAnswer) return { action: 'ask-user' };

    const mode = cfg.autoAnswer.mode || 'full'; // 'full' | 'review' | 'manual'
    if (mode === 'manual') return { action: 'ask-user' };

    const { tier } = this.classifyQuestion(questionData);
    const hasTelegram = telegramBridge && telegramBridge.isRunning;
    const timeout = (cfg.autoAnswer.criticalQuestionTimeoutSeconds || 120) * 1000;

    if (tier === 'simple') {
      const result = this.autoAnswer(questionData, cfg);
      if (result) {
        // No recommended option — route through review+telegram so user can choose
        if (result.noRecommended) {
          // Full autonomy + no Telegram = nobody watching → skip review, answer immediately
          if (cfg.autoAnswer.skipReviewInFullAutonomy !== false && cfg.autoAnswer.fullAutonomy && !hasTelegram) {
            return { action: 'auto-answer', answer: result.answer, reason: `${result.reason} (skipped review — full autonomy, no Telegram)` };
          }
          const countdown = cfg.autoAnswer.noRecommendedTimeoutSeconds || 30;
          if (hasTelegram) {
            return { action: 'route-telegram', timeout: countdown * 1000, questionData, fallbackAnswer: result.answer, fallbackReason: result.reason };
          }
          return { action: 'review', answer: result.answer, reason: result.reason, countdown };
        }
        if (mode === 'review') {
          const countdown = cfg.autoAnswer.reviewCountdownSeconds || 10;
          return { action: 'review', answer: result.answer, reason: result.reason, countdown };
        }
        return { action: 'auto-answer', answer: result.answer, reason: result.reason };
      }
      // Fallback: can't auto-answer a "simple" question — treat as unknown
    }

    if (tier === 'critical' || tier === 'unknown') {
      if (cfg.autoAnswer.fullAutonomy && hasTelegram) {
        return { action: 'route-telegram', timeout, questionData };
      }
      // No telegram or autonomy off for critical — try auto-answer anyway
      if (cfg.autoAnswer.fullAutonomy) {
        const result = this.autoAnswer(questionData, cfg);
        if (result) {
          // No recommended option — review with countdown even for critical
          if (result.noRecommended) {
            // Full autonomy + no Telegram → skip review
            if (cfg.autoAnswer.skipReviewInFullAutonomy !== false && !hasTelegram) {
              return { action: 'auto-answer', answer: result.answer, reason: `${result.reason} (skipped review — full autonomy)`, wasCritical: true };
            }
            const countdown = cfg.autoAnswer.noRecommendedTimeoutSeconds || 30;
            return { action: 'review', answer: result.answer, reason: result.reason, wasCritical: true, countdown };
          }
          if (mode === 'review') {
            const countdown = cfg.autoAnswer.reviewCountdownSeconds || 10;
            return { action: 'review', answer: result.answer, reason: result.reason, wasCritical: true, countdown };
          }
          return { action: 'auto-answer', answer: result.answer, reason: result.reason, wasCritical: true };
        }
      }
    }

    return { action: 'ask-user' };
  }

  // ── Session Decisions (moved from session-manager) ──

  // Delegate auto-next detection to workflow detectors (GsdDetector, SuperpowersDetector).
  detectAutoNext(result, session) {
    if (!result || !result.fullText) return null;
    if (this.workflows) return this.workflows.detectAutoNext(result, session);
    return null;
  }

  // Delegate derailment detection to workflow detectors.
  detectDerailment(result, session) {
    if (!result || !result.fullText) return null;
    if (!this.config.autoAnswer?.derailmentCorrection) return null;
    if (this.workflows) return this.workflows.detectDerailment(result, session);
    return null;
  }

  // ── Resilience ─────────────────────────────────────

  shouldRetry(exitCode, error, attemptCount) {
    const cfg = this.config.resilience || {};
    if (cfg.crashRetry === false) return false;

    const maxRetries = cfg.maxCrashRetries || DEFAULT_CRASH_RETRIES;
    if (attemptCount >= maxRetries) return false;

    // Clean exit — don't retry
    if (exitCode === 0) return false;

    // Fatal errors — don't retry
    const errLower = (error || '').toLowerCase();
    if (FATAL_ERROR_PATTERNS.some(p => errLower.includes(p))) return false;

    // Known crash codes or null (process error)
    if (exitCode === null || CRASH_RETRY_CODES.includes(exitCode)) return true;

    // Unknown non-zero exit — retry conservatively
    return exitCode !== 0;
  }

  getResumeState(configSessions) {
    if (!configSessions) return [];
    if (this.config.resilience?.autoResume === false) return [];

    const toResume = [];
    for (const [key, entry] of Object.entries(configSessions)) {
      if (entry.wasRunning && entry.sessionId) {
        // R5: key may be "dir::tabId" format — extract dir
        const dir = key.includes('::') ? key.split('::')[0] : key;
        toResume.push({
          tabId: entry.tabId || `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          projectDir: dir,
          sessionId: entry.sessionId,
          lastPrompt: entry.lastPrompt || 'continue',
        });
      }
    }
    return toResume;
  }
}

module.exports = AutonomyEngine;

// lib/gsd-detector.js -- GSD workflow detector
// Extracted from autonomy.js and constants.js for plugin architecture.

const { WorkflowDetector } = require('./workflow-detector');
const { DERAILMENT_PATTERNS, CRITICAL_QUESTION_PATTERNS } = require('./constants');
const { extractQuestions } = require('./question-utils');

const GSD_PHASE_PATTERNS = [
  {re: /(?:gsd:discuss-phase|discuss.phase)\s*(\d+)?/i, label: 'discussing phase $1'},
  {re: /(?:gsd:plan-phase|plan.phase)\s*(\d+)?/i, label: 'planning phase $1'},
  {re: /(?:gsd:execute-phase|execute.phase)\s*(\d+)?/i, label: 'executing phase $1'},
  {re: /gsd:verify|verify.work/i, label: 'verifying'},
  {re: /gsd:ship/i, label: 'shipping'},
  {re: /gsd:quick/i, label: 'quick task'},
  {re: /gsd:debug/i, label: 'debugging'},
  {re: /milestone.complete|all.phases.complete/i, label: 'milestone complete'},
];

class GsdDetector extends WorkflowDetector {
  constructor(config) {
    super('gsd');
    this.config = config || {};
    this.patterns = GSD_PHASE_PATTERNS;
    this._derailmentCount = 0;
    this._maxDerailments = config?.gsd?.maxDerailmentCorrections || 3;
  }

  _gsdCfg() { return this.config.gsd || {}; }

  _isGsdActive() {
    const gsdCfg = this._gsdCfg();
    if (gsdCfg.enabled === false) return false;
    const availability = this.config?.runtime?.workflowAvailability;
    if (availability && availability.gsdInstalled === false) return false;
    return true;
  }

  detect(text) {
    if (!this._isGsdActive()) return null;
    for (const p of this.patterns) {
      const m = text.match(p.re);
      if (m) return { label: p.label.replace('$1', m[1] || '') };
    }
    return null;
  }

  classifyQuestion(questionData) {
    if (!this._isGsdActive()) return 'unknown';
    if (!questionData) return 'unknown';
    const qList = extractQuestions(questionData);
    if (qList.length === 0) return 'unknown';
    const qText = (qList[0].question || '').toLowerCase();

    for (const pat of CRITICAL_QUESTION_PATTERNS) {
      if (pat.test(qText)) return 'critical';
    }
    return 'unknown'; // defer to base classification in autonomy engine
  }

  autoAnswer(questionData, config) {
    // GSD-specific auto-answers are handled by the generic autonomy engine.
    return null;
  }

  // Extract phase type + number from a /gsd command string.
  // e.g., "/gsd-execute-phase 2" → { type: 'execute', num: 2 }
  //        "/gsd:discuss-phase 3" → { type: 'discuss', num: 3 }
  _parseGsdCommand(cmd) {
    const m = cmd.match(/gsd[-:](discuss|plan|execute|research|verify)[-\s]?phase\s+(\d+)/i);
    if (m) return { type: m[1].toLowerCase(), num: parseInt(m[2], 10) };
    return null;
  }

  // Check if a suggested command duplicates the current/just-completed phase.
  // Allows re-invocation when the output indicates partial completion (e.g., wave done,
  // more waves remaining) — the progress-aware loop guard in session-manager handles
  // true stuck loops via output fingerprinting.
  _isDuplicatePhase(cmd, session, outputText) {
    const suggested = this._parseGsdCommand(cmd);
    if (!suggested) return false; // Not a phase command — allow it
    const currentPhase = session?.state?.gsdPhase || '';
    // gsdPhase looks like "executing phase 1", "discussing phase 3", etc.
    const currentMatch = currentPhase.match(/(discuss|plan|execut|research|verif)\w*\s+phase\s+(\d+)/i);
    if (!currentMatch) return false;
    const currentType = currentMatch[1].toLowerCase().replace(/ing$/, '').replace(/ut$/, 'ute');
    const currentNum = parseInt(currentMatch[2], 10);
    const samePhase = suggested.num === currentNum &&
      (suggested.type === currentType || suggested.type.startsWith(currentType.slice(0, 4)));
    if (!samePhase) return false;

    // Same phase re-invocation — allow if output shows partial/wave completion
    if (outputText && /wave\s+\d+.*(?:complete|done|finished)|remaining\s+waves|continue.*waves|partial.*execution|--wave\s+\d+/i.test(outputText)) {
      return false; // Allow re-execution for next wave
    }
    if (outputText && /--gaps|gaps.only|gap.*closure/i.test(outputText)) {
      return false; // Allow re-execution for gap closure
    }
    return true; // Block: genuine duplicate
  }

  detectAutoNext(result, session) {
    if (!result || !result.fullText) return null;
    const cfg = this._gsdCfg();
    if (!this._isGsdActive() || cfg.autoNext === false) return null;
    const text = result.fullText;

    const phaseMatch = text.match(/##\s*PHASE\s+COMPLETE.*?Phase:\s*(\S+)/i) ||
      text.match(/GSD\s*►\s*PHASE\s+(\d+)\s+COMPLETE/i) ||
      text.match(/PHASE\s+(\d+)\s+ALREADY\s+COMPLETE/i);
    if (phaseMatch) {
      return { prompt: '/gsd:next', reason: `Phase ${phaseMatch[1]} complete` };
    }

    // Check for explicit GSD suggestion BEFORE milestone bail-out.
    // Match /gsd commands anywhere — Claude may phrase suggestions many ways
    // (e.g., "Next Up: /gsd-next", "Run this command: /gsd-discuss-phase 1", bare "/gsd-next")
    // IMPORTANT: Use only the LAST ~2000 chars to avoid matching stale commands from early in
    // a long turn (e.g., "/gsd-execute-phase 5" from the start when phase 5 is now done).
    const tail = text.length > 2000 ? text.slice(-2000) : text;
    const suggestMatch = tail.match(/(\/gsd[-:][\w-]+(?:\s+\d+)?)\s*$/m) ||
      tail.match(/(?:Next Up|next step|Next:|run|execute|continue with).*?(\/gsd[-:][\w-]+(?:\s+\d+)?)/i);
    if (suggestMatch) {
      // Reject if the suggestion re-invokes the current/just-completed phase
      if (this._isDuplicatePhase(suggestMatch[1], session, text)) return null;
      // Reject if output indicates a human UAT gate — don't auto-route to verify-work in a loop
      if (/awaiting human|human.needed|human.?UAT|Reply with.*(?:number|1)|yes\s*\/\s*no\s*\/\s*skip\s*\/\s*blocked/i.test(tail)) return null;
      return { prompt: suggestMatch[1], reason: `Following GSD suggestion: ${suggestMatch[1]}` };
    }

    if (/milestone.complete|all.phases.complete/i.test(text)) {
      return null;
    }

    if (/verification\s+\*?\*?passed\*?\*?/i.test(text) && /--no-transition/i.test(text)) {
      return { prompt: '/gsd:next', reason: 'Verification passed (no-transition)' };
    }

    if (/waiting (?:for|on).*(?:agent|research|task)|(?:agent|research).*(?:still|running|background)|once they.*(?:complete|finish|land|return)|hang tight|no action needed/i.test(text)) {
      return { prompt: 'continue', reason: 'Waiting for background agents', delaySecs: cfg.autoContinueDelaySecs || 15 };
    }

    return null;
  }

  detectDerailment(result, session) {
    if (!result || !result.fullText) return null;
    const cfg = this._gsdCfg();
    if (!this._isGsdActive() || cfg.derailmentCorrection === false) return null;
    if (this._derailmentCount >= this._maxDerailments) return null; // cap reached, stop correcting
    const text = result.fullText;
    const gsdActive = session?.state?.gsdPhase || /GSD|gsd:|## PHASE|ROADMAP/i.test(text);
    if (!gsdActive) return null;

    for (const pat of DERAILMENT_PATTERNS) {
      if (pat.test(text)) {
        this._derailmentCount++;
        return {
          prompt: 'STOP. You went off-topic. Return to the active GSD workflow. Run /gsd:next to continue.',
          reason: `Derailment (${this._derailmentCount}/${this._maxDerailments}): ${pat.source.substring(0, 40)}`,
        };
      }
    }

    // Catch-all: GSD active but session ended without phase completion
    if (result.numTurns <= 1 || this.detectAutoNext(result, session)) return null;

    const trimmed = text.trim();
    const lastChunk = trimmed.length > 500 ? trimmed.slice(-500) : trimmed;
    const lastCmd = session?.state?.lastAutoNextPrompt || '';

    // Each guard is a reason NOT to auto-continue with /gsd:next
    const guards = [
      /QUESTIONING/i.test(text),
      /\?\s*$/.test(lastChunk),
      /(?:what do you (?:want|think|prefer)|want me to|would you like|shall i|get started|how (?:do you|should|would)|which (?:one|option|approach)|do you (?:want|have|need)|can you (?:tell|share|provide|clarify)|let me know|your (?:thoughts|preference|input|decision|feedback))\b.*?[.?]?\s*$/i.test(lastChunk),
      /gsd:new-project|gsd:new-milestone|gsd-new-project|gsd-new-milestone/i.test(text) ||
        /gsd[-:]new[-:](?:project|milestone)/i.test(lastCmd),
      /waiting (?:for|on).*(?:agent|research)|(?:agent|research).*(?:still|running|background)|hang tight|no action needed/i.test(text),
      /(?:created|wrote|generated)\s+CONTEXT\.md|phase.*initialized|context.*gathered|discussion.*complete/i.test(text),
      /milestone.complete|all.phases.complete/i.test(text),
      /##\s*PHASE\s+COMPLETE|phase\s+\d+\s+(?:complete|done|finished)/i.test(text),
      /already\s+(?:done|complete|finished|verified)|phase.*already.*complete/i.test(text),
      result.askedQuestion || false,
      /\/gsd[-:][\/\w-]+/i.test(lastChunk),
      /\u26a1\s*Skill\s+gsd|Skill.*gsd[-:]|skill:\s*"gsd/i.test(lastChunk),
      /Next Up|next step|\u25b6 Next|then run|then:\s*\/gsd/i.test(lastChunk),
      /awaiting human|human.needed|human.?UAT|Reply with.*(?:number|1)|resume.*session|yes\s*\/\s*no\s*\/\s*skip\s*\/\s*blocked/i.test(lastChunk),
    ];

    if (guards.some(Boolean)) return null;

    this._derailmentCount++;
    return {
      prompt: '/gsd:next',
      reason: `GSD session ended without phase completion (${this._derailmentCount}/${this._maxDerailments}) \u2014 auto-continuing`,
    };
  }
}

module.exports = GsdDetector;

// lib/superpowers-detector.js -- Superpowers skill workflow detector
// Detects active skills, auto-responds to routine prompts,
// auto-chains skills, and detects derailment.

const { WorkflowDetector } = require('./workflow-detector');
const { extractQuestions } = require('./question-utils');

const SKILL_PATTERNS = [
  {re: /superpowers:brainstorming|Using.*brainstorming.*skill/i, label: 'brainstorming'},
  {re: /superpowers:writing-plans|Using.*writing-plans/i, label: 'writing plans'},
  {re: /superpowers:executing-plans|Using.*executing-plans/i, label: 'executing plans'},
  {re: /superpowers:test-driven-development|Using.*TDD.*skill/i, label: 'TDD'},
  {re: /superpowers:systematic-debugging|Using.*debugging.*skill/i, label: 'debugging'},
  {re: /superpowers:requesting-code-review/i, label: 'requesting review'},
  {re: /superpowers:receiving-code-review/i, label: 'receiving review'},
  {re: /superpowers:verification-before-completion/i, label: 'verifying'},
  {re: /superpowers:finishing-a-development-branch/i, label: 'finishing branch'},
  {re: /superpowers:dispatching-parallel-agents/i, label: 'dispatching agents'},
  {re: /superpowers:subagent-driven-development/i, label: 'subagent dev'},
  {re: /superpowers:using-git-worktrees/i, label: 'git worktrees'},
  {re: /superpowers:simplify/i, label: 'simplifying'},
  {re: /frontend-design:frontend-design/i, label: 'frontend design'},
];

const COMPLETION_PATTERNS = [
  {skill: 'brainstorming', re: /Spec written and committed|Invoke writing-plans|invoking writing-plans/i},
  {skill: 'writing plans', re: /Plan written|plan.*committed|Plan complete and saved/i},
  {skill: 'executing plans', re: /implementation complete|all tasks completed|execution complete/i},
  {skill: 'TDD', re: /all tests pass|test suite passing|tests.*green/i},
  {skill: 'debugging', re: /root cause identified|fix verified|bug.*fixed/i},
  {skill: 'requesting review', re: /review request sent|requesting.*code.*review/i},
  {skill: 'receiving review', re: /all feedback addressed|review.*complete/i},
  {skill: 'verifying', re: /verification passed|all checks pass/i},
  {skill: 'finishing branch', re: /PR created|branch ready|pull request.*created/i},
  {skill: 'dispatching agents', re: /all agents completed|agents.*finished/i},
  {skill: 'subagent dev', re: /all subagents completed|subagent.*finished/i},
  {skill: 'simplifying', re: /simplification complete|code.*simplified/i},
  {skill: 'frontend design', re: /design implemented|frontend.*complete/i},
  {skill: 'git worktrees', re: /worktree.*complete|worktree.*created/i},
];

const CRITICAL_PATTERNS = [
  /which approach/i,
  /do you prefer/i,
  /design.*look.*right/i,
  /review.*spec/i,
  /approve.*plan/i,
  /trade.?off/i,
  /ready to implement/i,
  /before.*proceed/i,
  /which.*option/i,
  /proposal.*\d/i,
];

const DEFAULT_SKILL_CHAIN = [
  'brainstorming',
  'writing-plans',
  'executing-plans',
  'verification-before-completion',
  'finishing-a-development-branch',
];

// Map from skill labels (what detect() returns) to chain command names
const LABEL_TO_COMMAND = {
  'brainstorming': 'brainstorming',
  'writing plans': 'writing-plans',
  'executing plans': 'executing-plans',
  'TDD': 'test-driven-development',
  'debugging': 'systematic-debugging',
  'requesting review': 'requesting-code-review',
  'receiving review': 'receiving-code-review',
  'verifying': 'verification-before-completion',
  'finishing branch': 'finishing-a-development-branch',
  'dispatching agents': 'dispatching-parallel-agents',
  'subagent dev': 'subagent-driven-development',
  'git worktrees': 'using-git-worktrees',
  'simplifying': 'simplify',
  'frontend design': 'frontend-design',
};

// Reverse map: command name to label
const COMMAND_TO_LABEL = {};
for (const [label, cmd] of Object.entries(LABEL_TO_COMMAND)) {
  COMMAND_TO_LABEL[cmd] = label;
}

class SuperpowersDetector extends WorkflowDetector {
  constructor(config) {
    super('superpowers');
    this.config = config || {};
    this.patterns = SKILL_PATTERNS;
  }

  detect(text) {
    const spCfg = this.config.superpowers;
    if (spCfg && spCfg.enabled === false) return null;

    for (const p of this.patterns) {
      const m = text.match(p.re);
      if (m) return { label: p.label };
    }
    return null;
  }

  classifyQuestion(questionData) {
    if (!questionData) return 'unknown';
    const qList = extractQuestions(questionData);
    if (qList.length === 0) return 'unknown';
    const qText = (qList[0].question || '').toLowerCase();

    // Visual companion is always simple (auto-decline)
    if (/visual companion|show (?:in |the )?browser.*(?:preview|companion|mockup)|mockups.*diagrams/i.test(qText)) return 'simple';

    // Routine section approvals are simple
    if (/look.*right.*so far|does this.*make sense/i.test(qText)) return 'simple';

    // Superpowers critical patterns
    for (const pat of CRITICAL_PATTERNS) {
      if (pat.test(qText)) return 'critical';
    }

    return 'unknown';
  }

  autoAnswer(questionData, config) {
    const spCfg = config?.superpowers || this.config?.superpowers || {};
    if (spCfg.enabled === false) return null;

    const qList = questionData?.questions || (questionData?.question ? [questionData] : []);
    if (qList.length === 0) return null;
    const qText = qList[0].question || '';

    // Visual companion -> decline
    if (spCfg.declineVisualCompanion !== false && /visual companion|show (?:in |the )?browser.*(?:preview|companion|mockup)|mockups.*diagrams/i.test(qText)) {
      return { answer: 'No thanks, let\'s stay text-only', reason: 'decline visual companion' };
    }

    // Simple section approval within brainstorming
    if (spCfg.autoApproveRoutine !== false && /look.*right.*so far|does this.*make sense/i.test(qText)) {
      return { answer: 'Yes, looks good. Continue.', reason: 'routine section approval' };
    }

    return null;
  }

  detectAutoNext(result, session) {
    if (!result || !result.fullText) return null;
    const spCfg = this.config.superpowers || {};
    if (spCfg.enabled === false || spCfg.autoChain === false) return null;

    const text = result.fullText;
    const activeSkill = session?.state?.activeSkill;
    if (!activeSkill) return null;

    // Check if the active skill has completed
    for (const cp of COMPLETION_PATTERNS) {
      if (cp.skill === activeSkill && cp.re.test(text)) {
        const chain = spCfg.skillChain || DEFAULT_SKILL_CHAIN;
        const cmdName = LABEL_TO_COMMAND[activeSkill];
        const chainIdx = chain.indexOf(cmdName);
        if (chainIdx >= 0 && chainIdx < chain.length - 1) {
          const nextCmd = chain[chainIdx + 1];
          return {
            prompt: `/superpowers:${nextCmd}`,
            reason: `${activeSkill} completed \u2014 advancing to ${COMMAND_TO_LABEL[nextCmd] || nextCmd}`,
          };
        }
        // End of chain — clear stale activeSkill to prevent false matches
        if (session?.state) session.state.activeSkill = null;
        return null;
      }
    }

    return null;
  }

  detectDerailment(result, session) {
    if (!result || !result.fullText) return null;
    const spCfg = this.config.superpowers || {};
    if (spCfg.enabled === false) return null;

    const activeSkill = session?.state?.activeSkill;
    if (!activeSkill) return null;

    // Detect Claude discussing skills conceptually instead of invoking them
    const text = result.fullText;
    if (/I would (?:use|invoke|recommend).*superpowers/i.test(text) && !/Skill.*tool/i.test(text)) {
      return {
        prompt: 'You are discussing skills instead of using them. Invoke the skill now.',
        reason: 'Superpowers: discussing instead of invoking',
      };
    }

    return null;
  }
}

module.exports = SuperpowersDetector;

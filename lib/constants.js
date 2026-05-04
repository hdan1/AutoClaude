// lib/constants.js -- Shared constants for Auto Claude
// Extracted to eliminate magic numbers and hardcoded patterns (L3)

module.exports = {
  // ── Polling / Timing ──────────────────────────────
  HOOK_POLL_INTERVAL_MS: 500,
  PROCESS_CLOSE_FLUSH_MS: 500,

  // ── Buffer Limits ─────────────────────────────────
  MAX_FULL_TEXT_BYTES: 100 * 1024,  // 100KB cap on fullText accumulation (M3)
  MAX_HOOK_LOG_BYTES: 5 * 1024 * 1024, // 5MB default cap on hook JSONL file
  MAX_LOG_LINES_UI: 3000,           // Max lines in UI live output

  // ── Ring Buffer Caps (PROX-05) ─────────────────────
  RING_BUFFER_TIMELINE: 2000,
  RING_BUFFER_HOOK_EVENTS: 1000,
  RING_BUFFER_TOOL_CALLS: 500,

  // ── Retry Config ──────────────────────────────────
  RETRYABLE_PATTERNS: [
    'rate limit', 'rate_limit', '429', 'overloaded', 'capacity',
    'timeout', 'etimedout', 'econnreset', 'econnrefused', '500', '502', '503', '529',
    'system error', '1033',
  ],
  DEFAULT_MAX_RETRIES: 3,
  DEFAULT_BACKOFF_SECONDS: [30, 60, 120],

  QUESTION_PATTERNS: [
    /(?:^|\n)\s*\?\s/m,
    /please (choose|select|pick|confirm)/i,
    /which (option|approach|one)/i,
    /would you (like|prefer|want)/i,
    /do you want to/i,
    /waiting for.*input/i,
    /\(y\/n\)/i,
    /\[y\/N\]/i,
    /approve.*roadmap/i,
    /select.*option/i,
  ],

  // Tool names Claude CLI uses when asking the user a question
  QUESTION_TOOL_NAMES: ['AskFollowupQuestion', 'AskUserQuestion'],

  // ── Path Validation ───────────────────────────────
  // Characters that should not appear in a sanitized directory path
  DANGEROUS_PATH_CHARS: /[;&|`$(){}!<>]/,

  // ── Telegram ──────────────────────────────────────
  TG_BUFFER_FLUSH_MS: 1000,        // 1 msg/sec/chat rate limit
  TG_MAX_MESSAGE_LENGTH: 4096,     // Telegram message char limit
  TG_CALLBACK_DATA_MAX: 64,        // Telegram callback_data byte limit
  TG_UNAUTHORIZED_MSG: 'Unauthorized. Your user ID is not in the allowed list.',

  // ── IPC Batching ──────────────────────────────────
  IPC_BATCH_INTERVAL_MS: 16,         // One animation frame (~60fps)
  IPC_BATCH_CHANNELS: ['log', 'proxy-event', 'hook-event', 'metrics'],

  // -- Activity Status (ACTV-01, ACTV-05) ------
  ACTIVITY_DEBOUNCE_MS: 500,

  TOOL_ACTIVITY_MAP: {
    Read: 'reading',
    Write: 'writing',
    Edit: 'writing',
    MultiEdit: 'writing',
    multi_edit: 'writing',
    Bash: 'running',
    Grep: 'reading',
    Glob: 'reading',
    Task: 'thinking',
    WebFetch: 'running',
    TodoRead: 'reading',
    TodoWrite: 'writing',
    AskFollowupQuestion: 'waiting',
    AskUserQuestion: 'waiting',
  },

  GSD_PHASE_PATTERNS: [
    {re: /gsd:discuss-phase|discuss.phase\s*(\d+)/i, label: 'discussing phase $1'},
    {re: /gsd:plan-phase|plan.phase\s*(\d+)/i, label: 'planning phase $1'},
    {re: /gsd:execute-phase|execute.phase\s*(\d+)/i, label: 'executing phase $1'},
    {re: /gsd:verify|verify.work/i, label: 'verifying'},
    {re: /gsd:ship/i, label: 'shipping'},
    {re: /gsd:quick/i, label: 'quick task'},
    {re: /gsd:debug/i, label: 'debugging'},
    {re: /milestone.complete|all.phases.complete/i, label: 'milestone complete'},
  ],

  // ── Derailment Detection (DRL-01) ──────────────────
  // These patterns detect when Claude has gone off-topic during a GSD session.
  // Keep patterns SPECIFIC to avoid false positives on normal conversational endings.
  DERAILMENT_PATTERNS: [
    /fun fact/i,
    /want me to pick.*(?:coding challenge|project idea|random file)/i,
    /I (?:can help|can assist) (?:you )?with (?:something|anything) else/i,
    /is there anything else (?:I can|you'd like me to) (?:help|do|assist)/i,
    /let me know (?:if|what) (?:you'd like|you want) (?:me to|to do|next)/i,
  ],

  // ── Critical Question Patterns (SMART-01) ─────────
  // Questions matching these are routed to Telegram with timeout
  // instead of being auto-answered immediately
  CRITICAL_QUESTION_PATTERNS: [
    /approve.*roadmap/i,
    /approve.*plan/i,
    /review.*plan/i,
    /ready to implement/i,
    /is.*plan.*ready/i,
    /which.*approach/i,
    /which.*architecture/i,
    /scope|breaking change|migration/i,
    /delete|remove|destroy|drop/i,
  ],

  // ── Crash Retry (RES-01) ─────────────────────────
  // Exit codes that indicate a retryable crash (not a clean exit)
  CRASH_RETRY_CODES: [1, 137, 139],
  // Error text that means "don't retry, it's permanent"
  FATAL_ERROR_PATTERNS: [
    'unauthorized', 'invalid api key', 'invalid_api_key',
    'permission denied', 'not found on path',
  ],
  DEFAULT_CRASH_RETRIES: 3,
  CRASH_RETRY_DELAY_MS: 10000,

  // ── Question Timeout ─────────────────────────────
  QUESTION_TIMEOUT_MS: 300000,           // 5 min default when autonomy OFF
  CRITICAL_QUESTION_TIMEOUT_MS: 120000,  // 2 min for Telegram-routed critical Qs

  ACTIVITY_TYPES: ['thinking', 'reading', 'writing', 'running', 'idle', 'waiting', 'error'],

  // ── Cost Awareness (COST-01) ─────────────────────
  COST_WARNING_USD: 5.0,
  COST_DANGER_USD: 10.0,

  // ── Context Guard (CTX-01) ──────────────────────────
  // Model context window sizes (input tokens).
  // Used when the model API doesn't provide max_input_tokens.
  MODEL_CONTEXT_WINDOWS: {
    'claude-opus-4': 200000,
    'claude-sonnet-4': 200000,
    'claude-haiku-4': 200000,
    'claude-sonnet-3': 200000,
    'claude-haiku-3': 200000,
    'claude-opus-3': 200000,
  },
  DEFAULT_CONTEXT_WINDOW: 200000,

  CONTEXT_GUARD_DEFAULTS: {
    enabled: true,
    threshold: 0.80,
    contextWindowOverride: null,
    maxRecoveriesPerSession: 3,
  },

  // GSD context warning patterns injected by gsd-context-monitor.js hook
  GSD_CONTEXT_WARNING_RE: /CONTEXT WARNING/i,
  GSD_CONTEXT_CRITICAL_RE: /CONTEXT CRITICAL/i,

  // ── Autonomy Modes (AUTO-01) ─────────────────────
  // 'full' = auto-answer immediately, 'review' = show with countdown, 'manual' = always ask
  AUTONOMY_MODES: ['full', 'review', 'manual'],
  REVIEW_COUNTDOWN_SECONDS: 10,

  // ── Superpowers Config Defaults ──────────────────
  SUPERPOWERS_DEFAULTS: {
    enabled: true,
    autoChain: true,
    declineVisualCompanion: true,
    autoApproveRoutine: true,
    skillChain: [
      'brainstorming',
      'writing-plans',
      'executing-plans',
      'verification-before-completion',
      'finishing-a-development-branch',
    ],
  },

  // ── Circuit Breaker (RES-02) ─────────────────────────
  CIRCUIT_BREAKER_THRESHOLD: 5,
  CIRCUIT_BREAKER_RESET_MS: 60000,
  CIRCUIT_BREAKER_HALF_OPEN_MAX: 1,

  // ── Model Fallback (RES-03) ─────────────────────────
  DEFAULT_FALLBACK_CHAIN: [
    'claude-sonnet-4-20250514',
    'claude-haiku-4-20250414',
  ],

  // ── SDK Protocol (Phase 7) ─────────────────────────
  SDK_MIN_VERSION: '1.0.0',
  SDK_KEEPALIVE_INTERVAL_MS: 30000,
  SDK_INPUT_FORMAT: 'stream-json',
  SDK_OUTPUT_FORMAT: 'stream-json',
  CONTROL_REQUEST_TYPES: ['can_use_tool'],
  CONTROL_DECISIONS: ['allow', 'deny'],
  SESSION_STATES: ['idle', 'running', 'requires_action'],
};

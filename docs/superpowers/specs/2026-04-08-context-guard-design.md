# Context Guard: Automatic Context-Limit Recovery

## Problem

When Auto Claude runs long autonomous sessions, the Claude Code context window (200k tokens) gradually fills up. GSD's context monitor warns Claude about this, but in an autonomous setting there's nobody at the keyboard to act on the warning. The session either degrades silently or crashes.

## Solution

A turn-boundary context guard that detects when context usage exceeds 80% of the model's context window, performs a workflow-aware handoff, clears the session, and resumes in a fresh context — all automatically.

## Detection

### Primary: Token-Based Check

After each `proxy.run()` completes (between turns, never mid-work):

1. Read `result.inputTokens` — this is the **last turn's** actual context usage, not cumulative
2. Look up the model's context window from a hardcoded map (with config override)
3. Calculate `contextPct = result.inputTokens / modelContextWindow`
4. If `contextPct >= 0.80` → trigger recovery

**Why `result.inputTokens` is the right metric:** Each turn with `--continue` replays the full conversation history. Turn 3's `input_tokens: 60,000` means the context window has 60k tokens in it — regardless of what turns 1 and 2 reported. The cumulative `totalInputTokens` is wrong for this purpose.

### Secondary: GSD Warning Text

When scanning `result.fullText` (already done for derailment/phase detection), also match:
- `CONTEXT WARNING` → lower effective threshold to 70% for that check
- `CONTEXT CRITICAL` → trigger recovery immediately regardless of token count

This provides a belt-and-suspenders approach when GSD is active.

### Model Context Window Map

Hardcoded in `lib/context-guard.js`:

```javascript
const MODEL_CONTEXT_WINDOWS = {
  'claude-sonnet-4-20250514': 200000,
  'claude-opus-4-20250219': 200000,
  'claude-haiku-3.5-20241022': 200000,
  // Add new models as needed
};
const DEFAULT_CONTEXT_WINDOW = 200000;
```

User can override via `config.contextGuard.contextWindowOverride`.

## Recovery Flow

When threshold is hit, recovery runs as a 3-step sequence inside the existing `SessionManager.start()` while-loop:

### Step 1: Handoff Turn

Workflow-aware — send one more `--continue` turn to save state:

| Workflow Detected | Detection Method | Handoff Prompt |
|---|---|---|
| **GSD** | `session.state.skillSource === 'gsd'` or `session.state.gsdPhase` is set | `/gsd-pause-work` |
| **Superpowers** | `session.state.skillSource === 'superpowers'` | Ask Claude to write `.auto-claude-handoff.md` with: what's in progress, what's done, what's remaining, key decisions |
| **Plain Claude** | Neither detected | Same as Superpowers |

### Step 2: Clear Session

- Set `session.state.sessionId = null` (next turn starts fresh — no `--continue`, no `-r`)
- Log: `"⚠ Context at {pct}% — starting fresh session with handoff"`
- Emit desktop notification + Telegram notification if configured
- Increment recovery counter

### Step 3: Resume Turn

| Workflow | Resume Prompt |
|---|---|
| **GSD** | `/gsd-resume-work` |
| **Superpowers/Plain** | `"Read .auto-claude-handoff.md and continue the work described there. Delete the handoff file when you've read it."` |

The while-loop continues normally from here. The fresh session starts in the same `projectDir`, so all state files are accessible.

## Safety Limits

- **Max recoveries per session:** 3 (configurable). After 3 recoveries, stop and notify the user. Prevents infinite recovery loops.
- **Never interrupts mid-turn:** Detection only runs between turns, after `proxy.run()` returns.
- **Recovery counter resets** when the user manually starts a new session.

## Configuration

New config section in the existing settings system:

```json
{
  "contextGuard": {
    "enabled": true,
    "threshold": 0.80,
    "contextWindowOverride": null,
    "maxRecoveriesPerSession": 3
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Toggle the entire context guard feature |
| `threshold` | number | `0.80` | Context usage percentage at which to trigger recovery (0.0-1.0) |
| `contextWindowOverride` | number or null | `null` | Manually set context window size (tokens). Overrides model map. |
| `maxRecoveriesPerSession` | number | `3` | Max recovery attempts before stopping |

## New Module: `lib/context-guard.js`

A focused module with:

- `shouldRecover(result, model, config)` → `{ recover: boolean, pct: number, reason: string }`
- `getHandoffPrompt(session)` → string (workflow-appropriate handoff prompt)
- `getResumePrompt(session)` → string (workflow-appropriate resume prompt)
- `MODEL_CONTEXT_WINDOWS` constant map
- `detectGsdWarning(fullText)` → `'warning' | 'critical' | null`

## Integration Point

In `SessionManager.start()`, after `proxy.run()` returns and **after crash retry** (which re-runs the same turn and should take priority), but **before** auto-answer, auto-next, and derailment checks:

```
result = await session.proxy.run(...)

// Existing: Crash retry (re-runs same turn, takes priority)
if (result.exitCode && result.exitCode !== 0) { ... }

// NEW: Context guard check (only on successful turns)
if (contextGuard.shouldRecover(result, session.state.model, config)) {
  // handoff → clear → resume
}

// Existing checks continue below (auto-answer, auto-next, derailment)
```

**Priority order:** Crash retry > Context guard > Auto-answer > Auto-next > Derailment. A crashed turn shouldn't trigger recovery — retry it first.

## UI Impact

- **Log entries:** `"⚠ Context at 82% — saving state and starting fresh session"` and `"✓ Fresh session started with handoff"`
- **Notifications:** Desktop + Telegram (using existing notification infrastructure)
- **Settings UI:** New "Context Guard" section with enabled toggle, threshold slider, and context window override field
- **No new UI panels or screens needed** — the existing metrics display already shows token counts

## Files Changed

| File | Change |
|---|---|
| `lib/context-guard.js` | New module (detection + handoff/resume logic) |
| `session-manager.js` | Import context-guard, add check in start() loop |
| `lib/constants.js` | Add MODEL_CONTEXT_WINDOWS map |
| `settings-db.js` | Add contextGuard config schema |
| `index.html` | Add context guard settings section |

# Hybrid Print-First + On-Demand PTY Fallback for Slash Commands

## Context
Auto Claude currently runs Claude CLI in print mode (`--print --output-format stream-json`) for deterministic machine-readable events, token accounting, and stable session telemetry. In this mode, many built-in slash commands are interactive-only and return `Unknown skill`.

Goal: keep print mode as default for reliability, while automatically handling unsupported slash commands through a short-lived PTY/tmux bridge.

## Decision Summary
- Default runtime remains print mode.
- Slash commands are routed through a command classifier before execution.
- If a slash command is mappable to a direct CLI command/flag, execute directly (existing behavior expanded).
- If a slash command is interactive-only/unsupported in print mode, auto-fallback to on-demand PTY for that turn.
- PTY process is short-lived per fallback command (no persistent PTY session).

## Non-Goals
- Replacing the entire runtime with PTY.
- Full terminal emulation for all Claude interactions.
- Rebuilding all telemetry semantics from PTY text output.

## Architecture

### 1) Command Routing Layer (Proxy)
Add a runtime selector in `proxy.js` that chooses one execution path per turn:
- `print` path: current JSON stream parser.
- `cli-subcommand` path: direct CLI command (`plugins`, `mcp`, `auth status`, etc.).
- `pty-fallback` path: for interactive-only slash commands.

Routing outcome contract:
```js
{
  mode: 'print' | 'cli-subcommand' | 'pty-fallback',
  args: string[],
  reason: string,
  originalPrompt: string,
}
```

### 2) PTY Executor (New Module)
Introduce `lib/pty-executor.js` with a minimal interface:
```js
run({ projectDir, prompt, timeoutMs, env }): Promise<{
  exitCode,
  stdout,
  stderr,
  matchedSignals,
  error,
}>
```

Behavior:
- Spawn tmux-backed interactive Claude command.
- Send one slash command.
- Wait for completion signals or timeout.
- Return raw output and classified status.

### 3) Session Integration
`session-manager.js` continues to consume proxy events with minimal additions:
- New event type: `execution-mode` (print/cli-subcommand/pty-fallback).
- PTY fallback emits synthetic lifecycle markers (`pty-start`, `pty-complete`, `pty-timeout`) for UI visibility.

### 4) UI/Log Visibility
Current logs remain, with explicit entries:
- `Auto-route: slash command requires interactive mode; using PTY fallback`
- `PTY fallback complete` / `PTY fallback timed out`

No UI redesign required.

## Command Classification Model

### A. Directly Mappable (no PTY)
- `/plugin ...`, `/plugins ...` → `claude plugins ...`
- `/mcp ...` → `claude mcp ...`
- `/doctor` → `claude doctor`
- `/help` → `claude --help`
- `/login` → `claude auth login`
- `/logout` → `claude auth logout`
- `/status` → `claude auth status`
- `/model <x>` → print mode with `--model <x>` and neutral prompt (`continue`)

### B. PTY Fallback Candidates
Interactive built-ins that are not reliable in print mode (e.g. `/clear`, `/compact`, `/config`, `/memory`, `/review`, `/terminal-setup`, and future unknown interactive slash commands).

### C. Normal Prompts
Non-slash prompts always stay in print mode.

## Data Flow
1. User submits prompt.
2. Proxy classifies prompt.
3. If `print`: existing execution/parser path.
4. If `cli-subcommand`: execute direct command and normalize output.
5. If `pty-fallback`:
   - invoke PTY executor,
   - emit synthetic events,
   - map result to `resultText/error/exitCode` compatible with current session flow.
6. Session manager updates state and logs as it does today.

## Error Handling
- PTY timeout (configurable default): return explicit timeout error with guidance.
- PTY unavailable (tmux missing, spawn failure): degrade to current unsupported-mode guidance.
- Non-zero PTY exit: keep stderr and first actionable error line.
- Retry policy: no automatic retries for PTY fallback by default (avoid replaying interactive commands).

## Observability Strategy
- Preserve structured observability for most turns by keeping print as default.
- For PTY turns, add explicit execution-mode events and synthetic checkpoints.
- Keep hook-log ingestion unchanged as supplemental tooling signal source.

## Security and Safety
- Continue existing command argument sanitization and prompt validation.
- PTY fallback only executes recognized slash commands from classifier.
- Avoid shell interpolation; pass args as argv arrays.

## Configuration
Add optional settings:
- `runtime.slashFallback.enabled` (default: `true`)
- `runtime.slashFallback.timeoutMs` (default: `45000`)
- `runtime.slashFallback.logRawOutput` (default: `false`)

## Testing Plan

### Unit
- Classifier routing matrix: slash → mode/args/reason.
- PTY fallback decision logic for interactive-only and unknown slash commands.
- Error normalization for PTY timeout/failure.

### Integration
- Print path unaffected for non-slash prompts.
- Existing mapped commands still work.
- Simulated PTY success/failure updates session state predictably.

### Regression
- Token/tool telemetry behavior for print turns unchanged.
- No regressions in auto-answer and loop detection paths.

## Rollout Plan
1. Implement behind `runtime.slashFallback.enabled`.
2. Validate locally with representative slash command set.
3. Enable by default after successful regression suite.

## Risks and Mitigations
- **Risk:** PTY output parsing drift.
  - **Mitigation:** keep PTY output handling shallow; rely on completion markers and explicit timeouts.
- **Risk:** user confusion across mixed runtimes.
  - **Mitigation:** explicit logs for route decisions and fallback reasons.
- **Risk:** tmux dependency issues.
  - **Mitigation:** detect early; emit clear remediation and no-crash fallback.

## Success Criteria
- Interactive-only slash commands no longer fail with `Unknown skill` in normal use.
- Non-slash flows preserve current structured telemetry and behavior.
- No regression in proxy/session core tests.
- Users can issue slash commands naturally without manual mode switching.

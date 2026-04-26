# Comprehensive App Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an evidence-backed audit of Auto Claude that runs the current app and test suite, inspects resilience, test coverage, maintainability, and product/operability, and delivers a ranked findings register plus a phased improvement roadmap.

**Architecture:** Create a single audit report under `docs/superpowers/audits/` and gather evidence in a small companion `artifacts/` directory. Execute the work in two passes: first capture runtime and test evidence, then trace those observations through the codebase and docs to write findings and a roadmap. This plan does not change production code; it produces the audit artifact that will drive later implementation work.

**Tech Stack:** Electron, Node.js, Node built-in `node:test`, vanilla HTML/JS renderer, `node-telegram-bot-api`, `sql.js`, GitHub Actions release workflow

---

## File Structure & Responsibilities

- `docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md`
  - Final audit report. Holds the summary, evidence log, lane-by-lane findings, ranked findings register, and phased roadmap.
- `docs/superpowers/audits/artifacts/2026-04-25/test-suite.txt`
  - Raw `node:test` output for the current repo state.
- `docs/superpowers/audits/artifacts/2026-04-25/module-sizes.txt`
  - File size snapshot used as evidence for maintainability and decomposition findings.
- `package.json`
  - Source of truth for startup/build commands and packaging entrypoints.
- `main.js`
  - Main-process orchestration, session lifecycle wiring, update wiring, IPC, tray/window behavior.
- `session-manager.js`
  - Session state machine, question routing, persistence hooks, runtime transitions.
- `proxy.js`
  - Claude CLI spawn logic, stream parsing coordination, retries, hook log handling.
- `preload.js`, `index.html`, `renderer/settings-panel.js`, `renderer/setup-health-check.js`, `renderer/help-wizard.js`, `renderer/claude-code-manager.js`
  - Renderer/UI flows that affect usability, observability, and recovery.
- `lib/*.js`
  - Focused subsystems: context guard, runtime utilities, updater, Telegram integration, stream parsing, plugin manager, hook watcher, autonomy, validation.
- `lib/*.test.js`, `test/helpers.js`
  - Existing automated verification surface.
- `README.md`, `docs/runbook.md`, `docs/architecture/DEFAULT_PROMPT_FLOW.txt`, `.github/workflows/release.yml`
  - Declared product behavior, recovery guidance, architecture notes, and release process.

**Execution note:** This plan intentionally omits git commit steps because this repo workflow requires explicit user approval before creating commits.

---

### Task 1: Create the audit workspace and report scaffold

**Files:**
- Create: `docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md`
- Create: `docs/superpowers/audits/artifacts/2026-04-25/`

- [ ] **Step 1: Create the audit directories**

Run:

```bash
mkdir -p "docs/superpowers/audits/artifacts/2026-04-25"
```

Expected: the directory `docs/superpowers/audits/artifacts/2026-04-25` exists.

- [ ] **Step 2: Create the audit report scaffold**

Create `docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md` with:

```md
# Comprehensive App Audit

Date: 2026-04-25

## 1. Audit Summary

## 2. Environment & Commands
- Branch: record output of `git branch --show-current`
- Node: record output of `node --version`
- Claude CLI: record output of `claude --version` or the exact error if unavailable
- Test command: `node --test lib/*.test.js`
- App launch command: `npm start`

## 3. Automated Verification Baseline
### 3.1 Environment checks
### 3.2 Test suite result
### 3.3 Packaging and release pipeline

## 4. Runtime Validation
### 4.1 App startup
### 4.2 Golden-path flows
### 4.3 Failure handling and recovery

## 5. Resilience & Stability Findings

## 6. Tests & Verification Findings

## 7. Maintainability & Architecture Findings

## 8. Product & Operability Findings

## 9. Ranked Findings Register

| ID | Lane | Severity | Evidence | Why it matters | Recommendation | Effort |
|----|------|----------|----------|----------------|----------------|--------|

## 10. Phased Roadmap
### Phase 1 — Immediate hardening
### Phase 2 — Test-strengthening
### Phase 3 — Maintainability / architecture
### Phase 4 — Product / operability

## 11. Appendix
### 11.1 Test inventory
### 11.2 Files inspected
### 11.3 Command outputs
```

- [ ] **Step 3: Verify the scaffold exists and is readable**

Run:

```bash
test -f "docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md" && echo "audit scaffold ready"
```

Expected: `audit scaffold ready`

---

### Task 2: Capture the automated verification baseline

**Files:**
- Modify: `docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md`
- Create: `docs/superpowers/audits/artifacts/2026-04-25/test-suite.txt`
- Inspect: `package.json`
- Inspect: `.github/workflows/release.yml`
- Inspect: `lib/*.test.js`
- Inspect: `test/helpers.js`

- [ ] **Step 1: Record environment commands in the audit report**

Run each command separately and paste the exact outputs into `## 2. Environment & Commands`:

```bash
git branch --show-current
node --version
claude --version
```

Expected:
- `git branch --show-current` prints `master`
- `node --version` prints a Node 18+ version string
- `claude --version` prints a Claude Code version string; if it fails, record the exact failure text as an environment blocker

- [ ] **Step 2: Run the full built-in test suite and save the raw output**

Run:

```bash
node --test lib/*.test.js | tee "docs/superpowers/audits/artifacts/2026-04-25/test-suite.txt"
```

Expected: TAP-style output from Node’s built-in test runner plus a final summary line showing pass/fail counts.

- [ ] **Step 3: Summarize the test baseline in the audit report**

Under `## 3. Automated Verification Baseline`, add:

```md
### 3.1 Environment checks
- Current branch: `master`
- Node runtime: copy exact `node --version` output
- Claude CLI: copy exact `claude --version` output or failure text

### 3.2 Test suite result
- Command: `node --test lib/*.test.js`
- Raw output file: `docs/superpowers/audits/artifacts/2026-04-25/test-suite.txt`
- Result: record PASS or FAIL
- Passing areas: list the test files that passed cleanly
- Failing areas: list the test files that failed, or write `None`
- Notable warnings: copy any repeated warnings, skipped tests, or flaky-looking output

### 3.3 Packaging and release pipeline
- `package.json` start command: `npm start`
- `package.json` build commands: `dist`, `dist:win`, `dist:mac`, `dist:linux`
- Release workflow file: `.github/workflows/release.yml`
- Observation: note whether packaging/release flow is present and whether the audit should treat packaging as first-class operational surface
```

- [ ] **Step 4: Add the test inventory appendix**

Under `## 11. Appendix`, create `### 11.1 Test inventory` with this table and fill it using the actual test files in `lib/*.test.js`:

```md
| Subsystem | Source files | Existing tests |
|-----------|--------------|----------------|
| Session lifecycle | `session-manager.js`, `lib/sessions.js` | `lib/session-manager.test.js`, `lib/sessions.test.js` |
| CLI spawn / proxy | `proxy.js`, `lib/spawn-claude.js`, `lib/pty-executor.js`, `lib/stream-parser.js` | `lib/proxy.test.js`, `lib/spawn-claude.test.js`, `lib/pty-executor.test.js` |
| Context management | `lib/context-guard.js`, `lib/summarize.js`, `lib/question-utils.js` | `lib/context-guard.test.js`, `lib/summarize.test.js`, `lib/question-utils.test.js` |
| Telegram | `lib/telegram.js`, `lib/master-telegram.js`, `lib/telegram-auth.js`, `lib/telegram-secure.js`, `lib/telegram-formatters.js`, `lib/telegram-commands.js` | `lib/telegram.test.js`, `lib/master-telegram.test.js`, `lib/telegram-auth.test.js`, `lib/telegram-secure.test.js`, `lib/main-telegram-routing.test.js`, `lib/index-telegram-ui.test.js` |
| Update / plugin management | `lib/update-checker.js`, `lib/plugin-manager.js`, `lib/plugin-update-checker.js`, `lib/claude-detection.js` | `lib/update-checker.test.js`, `lib/plugin-manager.test.js`, `lib/plugin-update-checker.test.js`, `lib/claude-detector.test.js` |
| Settings / validation / autonomy | `lib/validate.js`, `lib/autonomy.js`, `lib/gsd-detector.js`, `lib/superpowers-detector.js`, `lib/gsd-settings.js` or equivalent wiring | `lib/validate.test.js`, `lib/autonomy.test.js`, `lib/gsd-detector.test.js`, `lib/superpowers-detector.test.js`, `lib/gsd-settings.test.js` |
| UI runtime / build surface | `index.html`, `renderer/*.js`, build packaging files | `lib/index-ui-runtime.test.js`, `lib/build-files.test.js`, `lib/ccm-file-logging.test.js` |
```

---

### Task 3: Run the app and document the golden-path runtime behavior

**Files:**
- Modify: `docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md`
- Inspect: `main.js`
- Inspect: `preload.js`
- Inspect: `index.html`
- Inspect: `renderer/settings-panel.js`
- Inspect: `renderer/setup-health-check.js`
- Inspect: `renderer/help-wizard.js`
- Inspect: `renderer/claude-code-manager.js`
- Inspect: `settings-db.js`

- [ ] **Step 1: Launch the app from the repo root**

Run:

```bash
npm start
```

Expected: an Electron window opens for Auto Claude. If the process exits immediately or prints errors, copy the exact stderr/stdout into `## 4. Runtime Validation`.

- [ ] **Step 2: Exercise the golden-path UI flows in one pass**

Check these exact flows in the running app:

```md
1. The dashboard renders without a blank window or immediate crash.
2. The Settings panel opens and closes cleanly.
3. The Help Wizard opens and closes cleanly.
4. The Claude Code Manager view renders without missing sections or obvious runtime errors.
5. A project can be selected for the current repo.
6. A session can be started with the prompt `reply with READY and then stop`.
7. The session can be stopped cleanly from the UI.
8. Quit and relaunch the app once to see whether settings/session state resume cleanly.
```

If any step is blocked by missing CLI auth, missing workspace config, or another external dependency, record the exact blocker instead of inventing a workaround.

- [ ] **Step 3: Write the runtime validation section in the report**

Under `## 4. Runtime Validation`, add:

```md
### 4.1 App startup
- Launch command: `npm start`
- Window opened: yes / no
- Immediate errors: copy exact message text or write `None`
- First noticeable friction: one sentence

### 4.2 Golden-path flows
- Settings panel: success / failure + one sentence of evidence
- Help Wizard: success / failure + one sentence of evidence
- Claude Code Manager: success / failure + one sentence of evidence
- Project selection: success / failure + one sentence of evidence
- Session start with `reply with READY and then stop`: success / failure + one sentence of evidence
- Session stop: success / failure + one sentence of evidence
- Relaunch/resume behavior: success / failure + one sentence of evidence

### 4.3 Failure handling and recovery
- Any unclear errors, silent failures, or dead-end states encountered during the run
- Any recovery path that worked well
- Any recovery path that was missing or hard to discover
```

---

### Task 4: Review resilience and stability surfaces

**Files:**
- Modify: `docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md`
- Inspect: `main.js`
- Inspect: `session-manager.js`
- Inspect: `proxy.js`
- Inspect: `lib/context-guard.js`
- Inspect: `lib/runtime-utils.js`
- Inspect: `lib/update-checker.js`
- Inspect: `lib/hook-watcher.js`
- Inspect: `lib/stream-parser.js`
- Inspect: `lib/errors.js`
- Inspect: `install-hooks.js`
- Inspect: `hooks/auto-claude-hook.js`
- Inspect: `docs/runbook.md`
- Inspect: `docs/architecture/DEFAULT_PROMPT_FLOW.txt`

- [ ] **Step 1: Inspect the resilience files against a fixed checklist**

Use this checklist while reading the files above:

```md
- Startup/shutdown path is explicit and leaves the app in a known state.
- Crash/retry logic has bounded retries and clear user-visible states.
- Session cleanup removes or repairs stale processes and stale hook state.
- Hook install/remove lifecycle matches the runbook and product claims.
- Context recovery and resume logic have a clear stop condition.
- Update checks and update application failures produce actionable signals.
- External dependency failures (Claude CLI, Telegram, filesystem, network) do not silently disappear.
```

- [ ] **Step 2: Convert file review notes into resilience findings**

Under `## 5. Resilience & Stability Findings`, write one finding block per issue using this exact format:

```md
### R1. <short finding title>
- Evidence: runtime / code inspection / doc mismatch
- Files: `exact/file.js`, `exact/other-file.js`
- Why it matters: one short paragraph
- Improvement: one short paragraph
```

Create at least one finding if the audit reveals a real issue. If this lane is unexpectedly clean, write the sentence `No material resilience issues found in this pass.` and justify that with the files inspected.

- [ ] **Step 3: Add the inspected resilience files to the appendix**

Under `### 11.2 Files inspected`, add:

```md
- `main.js`
- `session-manager.js`
- `proxy.js`
- `lib/context-guard.js`
- `lib/runtime-utils.js`
- `lib/update-checker.js`
- `lib/hook-watcher.js`
- `lib/stream-parser.js`
- `lib/errors.js`
- `install-hooks.js`
- `hooks/auto-claude-hook.js`
- `docs/runbook.md`
- `docs/architecture/DEFAULT_PROMPT_FLOW.txt`
```

---

### Task 5: Review tests and verification gaps

**Files:**
- Modify: `docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md`
- Inspect: `lib/*.test.js`
- Inspect: `test/helpers.js`
- Inspect: `package.json`
- Inspect: `.github/workflows/release.yml`

- [ ] **Step 1: Compare the test inventory to the highest-risk subsystems**

Use the inventory from Task 2 and answer these exact questions:

```md
- Which critical runtime paths have direct tests?
- Which critical runtime paths are only indirectly covered?
- Which product claims in `README.md` and `docs/runbook.md` have no obvious automated verification?
- Is there any single failure-prone subsystem that depends mostly on source-inspection tests rather than behavior tests?
- Is there any important path that requires manual verification today?
```

- [ ] **Step 2: Write the tests and verification findings**

Under `## 6. Tests & Verification Findings`, use this exact subsection structure:

```md
### Current strengths
- List the areas where the current test suite is strongest.

### High-risk coverage gaps
- List the missing or weakly-covered behaviors.

### Verification quality notes
- Note any signs of brittle tests, source-snippet assertions, missing end-to-end checks, or difficult-to-run workflows.
```

Every coverage-gap bullet must cite the exact source file(s) and test file(s) involved.

- [ ] **Step 3: Add a short verification conclusion**

End `## 6. Tests & Verification Findings` with:

```md
**Bottom line:** write 2-4 sentences answering whether the current test suite is likely to catch regressions in the app’s most failure-prone behavior.
```

---

### Task 6: Review maintainability and architectural risk

**Files:**
- Modify: `docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md`
- Create: `docs/superpowers/audits/artifacts/2026-04-25/module-sizes.txt`
- Inspect: `main.js`
- Inspect: `session-manager.js`
- Inspect: `proxy.js`
- Inspect: `index.html`
- Inspect: `renderer/settings-panel.js`
- Inspect: `renderer/setup-health-check.js`
- Inspect: `renderer/help-wizard.js`
- Inspect: `renderer/claude-code-manager.js`
- Inspect: `lib/ipc-claude-manager.js`
- Inspect: `lib/turn-loop-controller.js`
- Inspect: `lib/workflow-detector.js`
- Inspect: `lib/plugin-manager.js`
- Inspect: `lib/claude-detection.js`

- [ ] **Step 1: Capture a file-size snapshot for the largest source files**

Run:

```bash
wc -l main.js session-manager.js proxy.js index.html renderer/*.js lib/*.js | sort -nr | tee "docs/superpowers/audits/artifacts/2026-04-25/module-sizes.txt"
```

Expected: descending line counts with the largest modules at the top.

- [ ] **Step 2: Inspect the biggest and most central modules for coupling**

Use this exact review lens while reading the files above:

```md
- Does the file mix orchestration and business logic?
- Does the file own too many unrelated responsibilities?
- Do neighboring modules communicate through clear interfaces or shared mutable state?
- Is there duplication or near-duplication across runtime paths?
- Would a bug fix in this area likely require touching several unrelated files?
```

- [ ] **Step 3: Write the maintainability findings**

Under `## 7. Maintainability & Architecture Findings`, create one subsection per issue using this exact format:

```md
### M1. <short finding title>
- Evidence: `docs/superpowers/audits/artifacts/2026-04-25/module-sizes.txt` and code inspection
- Files: `exact/file.js`, `exact/other-file.js`
- Why it matters: one short paragraph
- Improvement: one short paragraph
```

If no structural issue rises above normal repo complexity, write `No material maintainability issues found in this pass.` and justify that with the specific modules inspected.

---

### Task 7: Review product and operability gaps

**Files:**
- Modify: `docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md`
- Inspect: `README.md`
- Inspect: `docs/runbook.md`
- Inspect: `index.html`
- Inspect: `renderer/settings-panel.js`
- Inspect: `renderer/setup-health-check.js`
- Inspect: `renderer/help-wizard.js`
- Inspect: `renderer/claude-code-manager.js`
- Inspect: `lib/logger.js`
- Inspect: `lib/runtime-utils.js`

- [ ] **Step 1: Compare the product claims, runtime experience, and recovery guidance**

Answer these exact questions from the live app plus the files above:

```md
- Can a user tell what failed and what to do next when startup, updates, hooks, Telegram, or session launch go wrong?
- Are the strongest resilience features discoverable from the UI, or only obvious from docs/code?
- Do the README and runbook describe workflows that are still realistic in the current app?
- Are there missing diagnostics that would make on-device debugging much easier?
- Are there low-effort UX changes that would materially increase trust in the app?
```

- [ ] **Step 2: Write the product/operability findings**

Under `## 8. Product & Operability Findings`, use this exact format:

```md
### P1. <short finding title>
- Evidence: runtime / docs / code inspection
- Files: `exact/file.js`, `exact/other-file.js`
- Why it matters: one short paragraph
- Improvement: one short paragraph
```

At least one recommendation in this section must be a low-effort, high-trust improvement if the audit reveals one.

---

### Task 8: Assemble the ranked findings register and phased roadmap

**Files:**
- Modify: `docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md`

- [ ] **Step 1: Convert all lane findings into a single ranked register**

Under `## 9. Ranked Findings Register`, fill the table using these rules:

```md
- Severity must be one of: Critical, High, Medium, Low.
- Effort must be one of: S, M, L.
- Evidence must cite one of: runtime, test suite, code inspection, doc mismatch.
- Every row must reference a finding ID from sections 5-8.
- Sort the rows by severity first, then by effort within the same severity.
```

- [ ] **Step 2: Build the phased roadmap from the ranked findings**

Under `## 10. Phased Roadmap`, place finding IDs into the four phases using this exact structure:

```md
### Phase 1 — Immediate hardening
- Finding IDs that address crashes, dead ends, unclear recovery, or severe operational risk

### Phase 2 — Test-strengthening
- Finding IDs that add or improve verification on the highest-risk paths

### Phase 3 — Maintainability / architecture
- Finding IDs that reduce coupling, shrink oversized modules, or clarify interfaces

### Phase 4 — Product / operability
- Finding IDs that improve trust, diagnostics, discoverability, or day-to-day usability
```

- [ ] **Step 3: Add a concise executive summary**

At the top of `## 1. Audit Summary`, write exactly three short paragraphs:

```md
1. The overall audit verdict on current app trustworthiness.
2. The most important technical risks.
3. The highest-leverage next moves.
```

- [ ] **Step 4: Self-review the audit against the approved spec**

Run this checklist against the finished report:

```md
- The report answers all four spec questions:
  1. What is most fragile today?
  2. What is under-tested or unverified?
  3. What structural changes would reduce future breakage?
  4. What product or operational improvements would improve trust and usability?
- Each audit lane has either findings or an explicit `No material ... issues found in this pass.` sentence.
- The ranked register and roadmap are both present.
- The appendix lists files inspected and command outputs.
- Every recommendation is tied to runtime evidence, test output, code inspection, or a doc mismatch.
```

If any item is missing, fix the report before marking the task complete.

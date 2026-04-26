# Comprehensive Audit Remediation Design

**Date:** 2026-04-25  
**Goal:** Implement all approved findings from the 2026-04-25 comprehensive app audit by hardening operational truthfulness, expanding high-risk verification, reducing architectural hotspots, and improving operator-facing recovery guidance.  
**Architecture:** One coordinated remediation program with four internal tracks: resilience hardening, verification expansion, bounded maintainability refactors, and product/operability UX improvements. The design keeps `main.js` as composition root, introduces structured operational state at the main-process boundary, shares one renderer-facing operational-status model, and narrows subsystem seams rather than rewriting the app.

---

## 1. Scope and Outcome

This remediation effort closes all findings in `docs/superpowers/audits/2026-04-25-comprehensive-app-audit.md`, but not all findings receive the same implementation weight. The high-severity resilience and truthfulness issues (`R2`, `R3`) get direct behavioral fixes first. Verification gaps (`V1`, `V2`) are addressed with focused automated coverage for observable behavior rather than broad synthetic test scaffolding. Maintainability findings (`M1`, `M2`, `M3`) are implemented through bounded extraction and interface narrowing, not a wholesale rewrite. Product findings (`P1`, `P2`, `P3`) are addressed through a shared operational-status and diagnostics surface rather than ad hoc message tweaks.

The desired outcome is a shipped app that remains non-blocking during failures, but no longer hides degraded cleanup, degraded telemetry, updater breakage, or missing recovery guidance behind logs or implicit state. The resulting code should also make future operational changes less collision-prone by reducing the concentration of responsibilities in `main.js` and the Claude management renderer flows.

---

## 2. Design Principles

### 2.1 Keep runtime tolerant, make state truthful
The app currently favors non-blocking behavior in hook and runtime helpers. That design should remain. The change is that tolerant execution must no longer imply silent state lies. Cleanup, updater, and telemetry flows must produce explicit operational outcomes that the renderer and logs can consume.

### 2.2 Prefer shared operational models over one-off UI strings
Multiple findings stem from fragmented operational messaging. The fix is not to hand-edit each message independently. Instead, the app should use one shared operational-status shape that includes severity, summary, and next-step guidance.

### 2.3 Refactor only where the audit identified a real hotspot
The maintainability work should stay bounded to the hotspots identified by the audit: `main.js`, `renderer/claude-code-manager.js`, and the plugin/detection seam. This is remediation work, not a general cleanup pass.

### 2.4 Test behavior at boundaries
The new tests should focus on observable outcomes: uninstall result handling, updater error propagation, telemetry-degraded signaling, diagnostics payload composition, help/recovery content, secret-blocking behavior, and recovery command correctness.

---

## 3. Remediation Tracks

### Track A: Resilience hardening
This track closes `R1`, `R2`, `R3`, and `R4`.

#### A1. Truthful hook uninstall state
`uninstallHooks()` should return a structured result object rather than only logging internally. Main-process callers should only clear persisted `hooksInstalled` state after a successful uninstall result. Failed cleanup should remain visible as degraded operational state.

#### A2. Structured packaged updater failures
The packaged updater path in `main.js` should emit renderer-safe error payloads using the same status channel family already used for update progress. These payloads should include a compact summary and a small fixed set of next steps such as retry, restart, check network, or manual download.

#### A3. Telemetry degradation state
Repeated hook-log read/parse/append failures should promote a bounded `telemetry degraded` state into app-visible operational state. The app should remain non-blocking, but both logs and UI should indicate that hook-based observability is compromised.

#### A4. Runbook/script contract alignment
`install-hooks.js` and `docs/runbook.md` must agree on uninstall invocation. The preferred implementation is to make the script parse `--uninstall` position-independently so the documented form and the more obvious CLI form both work.

### Track B: Verification expansion
This track closes `V1` and `V2` and adds regression protection for the resilience changes.

#### B1. Hook/runtime truthfulness tests
Add tests covering successful uninstall, failed uninstall, and state clearing behavior so cleanup can no longer regress into optimistic state mutation.

#### B2. Updater error propagation tests
Add tests at the main-process boundary proving that packaged updater errors produce renderer-facing operational state rather than only logs.

#### B3. Telemetry degraded tests
Add tests proving that repeated hook-log failures trigger degraded state while isolated failures remain non-blocking and bounded.

#### B4. Recovery and safety tests
Add focused tests for `hooks/pre-commit-scan.js` secret-blocking behavior and for the highest-risk documented recovery commands whose behavior is implemented in code, especially uninstall/recovery command parsing and related runtime helper paths.

#### B5. Sleep-prevention and desktop runtime verification
Where behavior is code-driven and automatable, add direct tests around the app’s sleep-prevention acquire/release lifecycle and related main-process runtime paths. For any remaining native behavior that cannot be directly automated from the current harness, provide a compact explicit verification contract in code or test comments rather than implying full automation.

### Track C: Maintainability refactor
This track closes `M1`, `M2`, and `M3`.

#### C1. Main-process bounded extraction
Keep `main.js` as composition root, but extract bounded modules for:
- updater operational state
- hook lifecycle result handling
- workspace/session cleanup state transitions
- diagnostics/health IPC assembly

The extracted modules should own behavior and return structured outcomes, with `main.js` wiring them together.

#### C2. Shared operational-status layer for renderer flows
Introduce a shared renderer-facing operational-state helper used by `renderer/claude-code-manager.js`, `renderer/setup-health-check.js`, `renderer/settings-panel.js`, and help/recovery surfaces. This reduces duplicate message logic and gives one place to normalize status rendering.

#### C3. Detection/plugin facade narrowing
Keep `lib/claude-detection.js` discovery-oriented and `lib/plugin-manager.js` mutation-oriented. Add a narrow facade for health/setup/renderer consumers so they do not each compose detection/plugin/update state independently.

### Track D: Product and operability UX
This track closes `P1`, `P2`, and `P3`.

#### D1. Failure-state next-step guidance
Operational failure states should consistently include one short next-step message. This includes setup/install/auth/plugin/update/Telegram/hook cleanup states.

#### D2. Compact diagnostics bundle
Expose a compact diagnostics payload in the UI containing the most support-relevant fields, such as:
- app version
- Claude Code version/path
- auth type
- updater status
- workspace path when relevant
- log path
- last meaningful error
- telemetry degraded state

#### D3. In-app recovery discoverability
Add a light-weight `If something fails` help/recovery surface that points users to live output, logs, updater state, retry/restart expectations, and documented recovery entry points.

---

## 4. Architectural Boundaries

### 4.1 Main-process state boundary
The main process should own the source of truth for operational state. Renderer code should consume structured snapshots or events rather than deducing operational truth from scattered strings or side effects. This is especially important for hook lifecycle, updater failures, and telemetry degradation.

### 4.2 Renderer operational boundary
Renderer components should not independently invent recovery messaging. They should render a shared operational-status model with fields equivalent to:
- `severity`
- `summary`
- `details`
- `nextSteps`
- `diagnosticsKey` or inline diagnostics payload where appropriate

### 4.3 Detection/plugin/update boundary
Detection answers what exists and what state was observed. Plugin/update flows answer what can be changed or installed. Health/setup consumers should read from one façade that composes those concerns without duplicating orchestration logic in multiple callers.

---

## 5. Error Handling Model

Operational outcomes introduced by this remediation should follow one consistent model. The exact structure can be finalized during implementation, but it must support:
- machine-checkable success/failure/degraded state
- human-readable summary
- optional details for diagnostics
- optional next-step guidance
- safe transport across IPC to renderer consumers

Expected applications:
- hook uninstall returns success or degraded-cleanup result
- updater errors emit warning/error status with recovery steps
- repeated hook-log failures emit telemetry-degraded status
- diagnostics UI shows the latest meaningful operational error

This preserves the app’s non-blocking runtime philosophy while eliminating silent or misleading operational states.

---

## 6. Testing Strategy

The remediation should follow TDD for each behavior change. Tests should fail first, then the minimum production code should be added to satisfy them.

Priority coverage areas:
1. hook uninstall result and session state truthfulness
2. packaged updater error propagation to renderer-facing state
3. telemetry degraded signaling after repeated failures
4. `install-hooks.js` argument parsing and runbook-aligned CLI behavior
5. `hooks/pre-commit-scan.js` secret-blocking behavior
6. diagnostics payload composition and presence of last meaningful error
7. sleep-prevention lifecycle behavior where directly code-driven
8. help/recovery operational content where behavior is generated by code

The tests should prefer observable behavior over source-shape assertions. Where existing tests are source-inspection oriented, new tests should attach to operational outputs, events, and returned structured state.

---

## 7. Delivery Order

Although this is one broad remediation effort, implementation should proceed in the following internal sequence:

### Phase 1: Resilience primitives and truthful state
Implement `R1`, `R2`, `R3`, and the operational-state foundations needed for `R4`.

### Phase 2: Verification for the new behavior
Add the regression tests and runtime-boundary coverage for the newly introduced behavior.

### Phase 3: Maintainability extraction
Refactor `main.js`, renderer operational flows, and the detection/plugin seam only after the operational model is stable.

### Phase 4: UX/help/diagnostics polish
Finish the user-facing diagnostics and recovery discoverability work once the underlying state model and extracted interfaces are settled.

This sequencing minimizes rework because tests are written against stabilized behavior and renderer polish happens after operational truth is available.

---

## 8. Files Likely Affected

### Main-process and core behavior
- `main.js`
- `install-hooks.js`
- `lib/hook-watcher.js`
- `lib/update-checker.js`
- `lib/claude-detection.js`
- `lib/plugin-manager.js`
- any new bounded modules extracted from `main.js`

### Renderer and UX
- `renderer/claude-code-manager.js`
- `renderer/setup-health-check.js`
- `renderer/settings-panel.js`
- `renderer/help-wizard.js`
- possibly `index.html` for help/diagnostics entry points

### Tests
- new or expanded tests around hook lifecycle, updater state, telemetry degradation, diagnostics, pre-commit scan behavior, and recovery command handling

### Documentation
- `docs/runbook.md`
- potentially `README.md` if the user-facing recovery/help language needs alignment after implementation

---

## 9. Non-Goals

This remediation does not attempt to:
- build a full end-to-end native Electron UI automation harness
- redesign the entire frontend architecture
- replace current logging infrastructure wholesale
- refactor unrelated subsystems not implicated by the audit
- invent new product features beyond what is needed to close the audit findings

---

## 10. Success Criteria

The remediation is successful when:
- hook uninstall no longer clears state optimistically on failure
- packaged updater failures become actionable renderer-visible state
- repeated hook-log failures surface telemetry degradation without breaking sessions
- uninstall command usage is reliable and documentation-aligned
- high-risk verification gaps called out by the audit have direct automated coverage where practical
- `main.js` and Claude management operational flows have narrower responsibilities than before
- users can see concise next-step guidance and a compact diagnostics bundle when operational issues occur
- the help flow exposes a clear recovery entry point for failure scenarios

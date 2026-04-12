# Settings Enhancement: GSD Integration, JSON Editor, Window Size, Audit

**Date:** 2026-04-12
**Status:** Approved

## Overview

Four improvements to the Auto Claude settings and configuration experience:

1. GSD skill settings category with full control toggles
2. Larger settings and CCM modal windows
3. Lightweight JSON editor with syntax highlighting and error positioning
4. Settings schema audit and cleanup

## 1. GSD Settings Category

### Problem

GSD workflow detection (`GsdDetector`) has auto-next, derailment correction, and agent-waiting logic baked in with no user-facing controls. Superpowers has a settings category with toggles; GSD should match.

### Design

Add `gsd` category to `SETTINGS_SCHEMA` in `settings-db.js`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `gsd.enabled` | toggle | true | Master switch for GSD workflow detection |
| `gsd.autoNext` | toggle | true | Auto-advance to next phase on completion |
| `gsd.derailmentCorrection` | toggle | true | Detect and correct off-track Claude behavior |
| `gsd.maxPhaseRetries` | number | 3 | Max retries for a stuck phase before stopping |
| `gsd.autoContinueDelaySecs` | number | 15 | Seconds before auto-continuing (agent waits) |
| `gsd.phaseTimeoutMinutes` | number | 0 | Max minutes per phase before alerting (0 = no limit) |

Add to `CATEGORY_ORDER` after `superpowers`:
```js
{ key: 'gsd', icon: '🚀', label: 'GSD' },
```

### GsdDetector Changes

Update `GsdDetector` constructor to accept `config` parameter (currently takes none). Wire settings:

- `gsd.enabled` → gate `detect()`, `detectAutoNext()`, `detectDerailment()`
- `gsd.autoNext` → gate `detectAutoNext()` return value
- `gsd.derailmentCorrection` → gate `detectDerailment()` return value
- `gsd.maxPhaseRetries` → count consecutive same-phase retries, return null after max
- `gsd.autoContinueDelaySecs` → set `delaySecs` on agent-waiting auto-next
- `gsd.phaseTimeoutMinutes` → track phase start time, emit warning/stop if exceeded

### Integration

The autonomy engine (`lib/autonomy.js`) already instantiates `GsdDetector`. Pass the settings config object to its constructor, same pattern as `SuperpowersDetector`.

### Files Changed

- `settings-db.js` — add 6 schema entries + category
- `lib/gsd-detector.js` — accept config, read settings in each method
- `lib/autonomy.js` — pass config to GsdDetector constructor

## 2. Settings Window Size Increase

### Changes

In `index.html` CSS:

| Element | Before | After |
|---------|--------|-------|
| `.settings-panel` width | 720px | 860px |
| `.settings-panel` height | 520px | 620px |
| `.ccm-modal` width | 900px | 1000px |
| `.ccm-modal` height | 700px | 780px |

Max constraints unchanged: `max-width:90vw/92vw`, `max-height:85vh/90vh`.

### Files Changed

- `index.html` — two CSS rule changes (lines 194, 216)

## 3. JSON Editor Improvements

### Problem

The Raw JSON editor in the CCM Settings.json tab is a plain `<textarea>`. It shows "Valid JSON" or "Invalid JSON" but no syntax highlighting, no line numbers, and no indication of WHERE an error is.

### Design

Replace with a lightweight custom editor using the overlay pattern (no external dependencies):

**Architecture:**
```
┌─────────┬──────────────────────────────────┐
│  Line   │  Editor area                     │
│  gutter │  ┌────────────────────────────┐  │
│  (div)  │  │ <textarea> (invisible text) │  │
│   1     │  │ <pre> overlay (colored)     │  │
│   2     │  │  ↑ pointer-events:none      │  │
│   3     │  └────────────────────────────┘  │
│  ...    │                                  │
└─────────┴──────────────────────────────────┘
│  Status: ● Valid JSON  |  ● Line 42:5 — Expected "," │
└────────────────────────────────────────────────────────┘
```

**Components:**

1. **Line number gutter** — `<div>` alongside textarea, scroll-synced. Numbers styled in `var(--tx2)` (dim).

2. **Syntax highlight overlay** — `<pre>` positioned exactly over the textarea. Textarea has `color:transparent; caret-color:var(--tx)` so the user sees the overlay colors but types into the textarea. Overlay has `pointer-events:none`.

3. **`highlightJson(text)` function** — regex-based tokenizer that scans JSON text and wraps tokens in spans (not a full parser — purely for display coloring):
   - `.json-key` — cyan (`#7dcfff`)
   - `.json-string` — green (`#9ece6a`)
   - `.json-number` — orange (`#ff9e64`)
   - `.json-bool` — purple (`#bb9af7`)
   - `.json-null` — purple
   - `.json-brace` — dimmed (`var(--tx2)`)
   - `.json-error-line` — red background on the error line

4. **Error position display** — on JSON parse failure, extract line:column from the error message, update status to `● Line 42:5 — Expected ","`, scroll to error line, highlight it with `.json-error-line`.

5. **Bracket matching** — on cursor move, if cursor is adjacent to `{`, `}`, `[`, or `]`, find the matching bracket and highlight both with a subtle border/background.

**Event handling:**
- `textarea.oninput` → re-render overlay, validate JSON, update status
- `textarea.onscroll` → sync gutter and overlay scroll position
- `textarea.onclick` / `onkeyup` → bracket matching
- Tab key inserts 2 spaces (existing behavior preserved)
- Ctrl+S saves (existing behavior preserved)

### Token Colors

Match the dark theme already in use (Tokyo Night-inspired):

```css
.json-key { color: #7dcfff; }
.json-string { color: #9ece6a; }
.json-number { color: #ff9e64; }
.json-bool, .json-null { color: #bb9af7; }
.json-brace { color: var(--tx2); }
.json-error-line { background: rgba(255, 50, 50, 0.15); display: block; }
```

### Files Changed

- `index.html` — new CSS classes, rebuilt `renderRaw()` function, new `highlightJson()` function

## 4. Settings Schema Audit & Cleanup

### Process

For each setting in `SETTINGS_SCHEMA`:

1. **Usage verification** — grep for the setting key across all `.js` files. If not read anywhere except schema definition, mark for removal.
2. **Description check** — verify description matches current behavior. Update stale references.
3. **Default validation** — confirm defaults are sensible for current feature state.
4. **Type/constraint check** — verify min/max on numbers, options on selects.
5. **Category check** — confirm setting is in the correct category.

### Scope

- Remove dead settings (defined but never read)
- Update stale descriptions
- Fix incorrect defaults or constraints
- No behavioral changes to working settings

### Files Changed

- `settings-db.js` — schema updates inline

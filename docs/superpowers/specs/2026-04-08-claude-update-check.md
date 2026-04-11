# Claude Code Update Checking — Design Spec

**Date:** 2026-04-08
**Goal:** Add update awareness to the topbar badge and Claude Code Manager Overview tab, using `claude update` CLI command to check for and install updates.

---

## Architecture Overview

The app currently detects Claude Code's installed version via `claude --version` but has no mechanism to check for newer versions. This adds:

1. A backend method that runs `claude update` (which both checks and installs)
2. A cached result to avoid repeated CLI calls
3. Badge visual indicator when an update is available
4. An UPDATE card in the Overview tab with check/install flow

---

## Backend

### New Method in `lib/claude-detector.js`

```
checkForUpdate() → Promise<{ updateAvailable, currentVersion, latestVersion, error? }>
```

**Behavior:**
- Runs `claude update` via `execFile` (async, not sync — avoids blocking main process)
- Parses stdout to determine outcome:
  - Contains "is up to date" → `{updateAvailable: false, currentVersion: X, latestVersion: X}`
  - Contains "Updating" or version change detected → `{updateAvailable: true, currentVersion: X, latestVersion: Y}`
  - After successful update, re-runs `claude --version` to confirm new version
- Caches result for 30 minutes (avoids hammering CLI on every modal open)
- Returns cached result immediately if within TTL
- On error (timeout, CLI not found), returns `{updateAvailable: false, error: message}`
- Uses the same `findClaudePath()` logic to locate the claude binary

**Cache invalidation:**
- TTL: 30 minutes
- Manually invalidated when `forceCheck: true` is passed (used by Update Now button)

### New IPC Handler in `main.js`

```
ipcMain.handle('check-claude-update', (_, opts) => claudeDetector.checkForUpdate(opts));
```

`opts` may include `{forceCheck: true}` to bypass cache (for Update Now / Retry).

### New Preload Method

```
checkClaudeUpdate: opts => ipcRenderer.invoke('check-claude-update', opts)
```

---

## Frontend — Topbar Badge

### Current Behavior

Badge shows `• Claude Code v2.1.96 (Claude Code)` with class `cc-badge installed` (green background).

### New Behavior

On modal open or periodic check, call `checkClaudeUpdate()`. Based on result:

- **No update:** Badge unchanged (green, current version text)
- **Update available:** Badge text becomes `• Claude Code v2.1.96 ⬆ Update`. Badge gets additional class `update-available` with yellow/accent background instead of green. Clicking badge opens Manager modal on Overview tab (existing behavior).
- **After update:** Badge refreshes to show new version, reverts to green.

### CSS Addition

```css
.cc-badge.update-available { background: var(--ylw); color: #000; }
```

---

## Frontend — Overview Tab

### New UPDATE Card

Add a new card row after the existing AUTH card in `renderOverview()`. The card spans full width (like PATH and AUTH cards do).

**States:**

| State | Card Content | Actions |
|-------|-------------|---------|
| Checking | `Checking for updates...` (dimmed text) | None |
| Up to date | `✓ Up to date` (green) | `Check Again ›` link (right-aligned) |
| Update available | `⬆ vX.Y.Z available` (yellow/accent) | `Update Now` button (right-aligned) |
| Updating | `Updating to vX.Y.Z...` (dimmed, spinner) | None (button disabled) |
| Updated | `✓ Updated to vX.Y.Z — restart sessions to use` (green) | None |
| Error | `Update check failed` (red) | `Retry ›` link (right-aligned) |

### Flow

1. `renderOverview()` is called → shows "Checking for updates..." in UPDATE card
2. Calls `window.api.checkClaudeUpdate()` (returns cached or fresh result)
3. Updates card to show result
4. If user clicks "Update Now":
   - Card shows "Updating..." state
   - Calls `window.api.checkClaudeUpdate({forceCheck: true})` — this runs `claude update` which installs
   - On completion, refreshes badge (`refreshBadge()`) and shows "Updated" state
5. If user clicks "Check Again" or "Retry":
   - Calls with `{forceCheck: true}` to bypass cache
   - Shows "Checking..." → result

---

## Error Handling

- **Claude not installed:** Don't show UPDATE card (Overview shows install wizard instead)
- **CLI timeout:** 60-second timeout on `execFile`. Return error state.
- **Parse failure:** If stdout doesn't match expected patterns, return `{updateAvailable: false, error: 'Could not determine update status'}`
- **Network issues:** `claude update` handles its own network errors; we just parse the output

---

## Files Changed

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/claude-detector.js` | Modify | Add `checkForUpdate()` with caching |
| `main.js` | Modify | Add `check-claude-update` IPC handler |
| `preload.js` | Modify | Add `checkClaudeUpdate` bridge method |
| `index.html` | Modify | Update badge CSS, `refreshBadge()`, `renderOverview()` |

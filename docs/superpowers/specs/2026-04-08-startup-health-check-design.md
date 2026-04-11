# Startup Health Check & Auto-Setup

## Problem

When a user installs Auto Claude, they need Claude Code installed and authenticated, plus recommended plugins (Superpowers, GSD, etc.). Currently there's no automated setup — users must manually install Claude Code, authenticate, and install plugins separately.

## Solution

A startup health check that runs on every app launch. It detects whether Claude Code is installed, authenticated, and whether recommended plugins are present. If anything is missing, a setup modal appears with one-click installation for everything.

## Recommended Plugins Configuration

A `system.recommendedPlugins` setting stores the list of plugins that should be installed. It's a JSON array:

```json
[
  { "key": "superpowers@https://github.com/anthropics/claude-code-plugins", "repo": "obra/superpowers" },
  { "key": "gsd@https://github.com/gsd-build/get-shit-done", "repo": "gsd-build/get-shit-done" }
]
```

**Population:** The list starts empty. When Claude Code is already installed with plugins, the user can snapshot their current plugins as "recommended" via:
1. A "Set current plugins as recommended" button in Settings
2. A prompt in the setup modal when `recommendedPlugins` is empty but plugins are detected

**Storage:** In Auto Claude's settings DB as a JSON string under `system.recommendedPlugins`.

## Startup Health Check

On every app start, after window creation:

1. Call `claudeDetector.detect()` — returns `{ installed, version, path, authType }`
2. If installed, call `claudeDetector.listPlugins()` — returns installed plugins
3. Compare against `recommendedPlugins` setting
4. Build health status:

```js
{
  claudeCode: { installed: true, version: '1.2.3', authenticated: true, authType: 'anthropic' },
  plugins: {
    recommended: [{ key: 'superpowers@...', repo: 'obra/superpowers' }, ...],
    installed: ['superpowers@...', ...],
    missing: [{ key: 'gsd@...', repo: 'gsd-build/get-shit-done' }],
  },
  recommendedEmpty: false,
  healthy: false
}
```

5. Send to renderer via `mainWindow.webContents.send('health-check', status)`
6. If `healthy === false`, renderer shows setup modal automatically

**Performance:** No network calls — just `claude --version` spawn + `settings.json` read. Under 1 second.

`healthy` is `true` only when: Claude Code installed + authenticated + all recommended plugins present (or recommended list is empty).

## Setup Modal

A modal dialog shown when health check fails. Styled to match existing modals in `index.html`.

### Layout

```
╔═══════════════════════════════════════════╗
║  🔧 Auto Claude Setup                    ║
╠═══════════════════════════════════════════╣
║                                           ║
║  ✅ Claude Code v1.2.3         Installed  ║
║  ✅ Authenticated (OAuth)      Connected  ║
║  ❌ Superpowers Plugin        [Install]   ║
║  ❌ GSD Plugin                [Install]   ║
║                                           ║
║  ─────────────────────────────────────    ║
║  [Install All Missing]  [Dismiss]         ║
║                                           ║
║  Progress: Installing superpowers...      ║
║  ████████░░░░░░░░  50%                    ║
║                                           ║
╚═══════════════════════════════════════════╝
```

### States

| Item | State | Display |
|------|-------|---------|
| Claude Code | Not installed | ❌ + "Install" button → opens install method picker (powershell/cmd/winget/brew) |
| Claude Code | Installed, no auth | ⚠️ + "Authenticate" button → runs `claude auth login` |
| Claude Code | Installed + auth | ✅ + version + auth type |
| Plugin | Missing | ❌ + "Install" button |
| Plugin | Installed + enabled | ✅ |
| Plugin | Installed + disabled | ⚠️ + "Enable" button |

### Actions

- **Individual "Install" buttons:** Install one item at a time
- **"Install All Missing":** Installs Claude Code (if needed) → authenticates (if needed) → installs all missing plugins, sequentially
- **"Dismiss":** Close modal, proceed to main UI. Modal will show again on next launch if issues persist.
- **Progress area:** Shows streaming output from installation process (reuses existing install progress pattern from `lib/claude-installer.js`)

### Auto-Close

When all items are ✅, modal shows a brief success state ("All set!") then auto-closes after 2 seconds.

### Recommended Plugins Empty State

When `recommendedPlugins` is empty and Claude Code is installed with existing plugins, show an additional prompt:

> "You have plugins installed. Save them as recommended for future setups?"
> [Save as Recommended] [Skip]

Clicking "Save as Recommended" snapshots current enabled plugins into the `recommendedPlugins` setting.

## Snapshot Current Plugins

### Settings UI

A button in the System settings section: **"Set current plugins as recommended"**

**Action:** Reads `claudeDetector.listPlugins()`, filters enabled ones, saves to `system.recommendedPlugins` setting as JSON. Shows confirmation toast.

### IPC Handler

New handler: `ipcMain.handle('snapshot-recommended-plugins')`:
1. Call `claudeDetector.listPlugins()`
2. Filter to enabled plugins
3. Map to `{ key, repo }` objects
4. Save to settings DB as JSON string
5. Return the saved list

## Files Changed

| File | Change |
|------|--------|
| `settings-db.js` | Add `system.recommendedPlugins` schema entry (type: hidden, default: '[]') |
| `main.js` | Add startup health check logic after window creation. Add `snapshot-recommended-plugins` IPC handler. Add `run-health-check` IPC handler. |
| `preload.js` | Expose `runHealthCheck()` and `snapshotRecommendedPlugins()` APIs |
| `index.html` | Add setup modal HTML/CSS/JS. Add health check listener. Add "Set as recommended" button in settings. |

## No New Modules Needed

All core functionality already exists:
- `lib/claude-detector.js` — detection + plugin listing
- `lib/claude-installer.js` — installation + authentication
- `settings-db.js` — config storage

This feature is purely orchestration and UI on top of existing infrastructure.

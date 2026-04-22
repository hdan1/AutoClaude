# Plugin Update Checker — Design Spec

Date: 2026-04-22

## Summary

Add plugin update checking and updating to Auto Claude. Users can check for plugin updates from the Overview tab (alongside Claude Code updates) and from the Plugins tab. When updates are available, users can update individual plugins or all at once. The update flow stops the running session, applies updates, and restarts the session automatically. All errors are logged and shown to the user.

## Approach

CLI-first (Approach A): use `claude plugins update <plugin>` for Claude Code plugins, npm registry API for version checking of all plugin types, and re-run install commands for MCP servers and skill packs.

## Plugin Types

| Type | Examples | Current Version Source | Latest Version Source | Update Mechanism |
|------|----------|----------------------|----------------------|------------------|
| Claude Code plugin | superpowers, frontend-design, chrome-devtools-mcp, ui-ux-pro-max | Cached manifest at `~/.claude/plugins/cache/<marketplace>/<name>/manifest.json` | GitHub marketplace manifest from repo | `claude plugins update <key>` |
| MCP server | context7 | `~/.claude/plugin-versions.json` (tracked by Auto Claude) | npm registry: `https://registry.npmjs.org/ctx7/latest` | Re-run install command: `npx -y ctx7 setup --claude -y` |
| Skill pack | gsd | `~/.claude/plugin-versions.json` (tracked by Auto Claude) | npm registry: `https://registry.npmjs.org/get-shit-done-cc/latest` | Re-run install command: `npx -y get-shit-done-cc@latest --global` |

## Architecture

Three layers:

### 1. Version Checker (`lib/plugin-update-checker.js`)

New module. Exports:

- `checkPluginUpdates()` — returns `[{ key, name, type, currentVersion, latestVersion, updateAvailable }]`
- Queries latest versions for all installed plugins
- 10-minute in-memory cache (same pattern as `lib/models.js`)
- Uses Node built-in `https`/`http` modules (no new dependencies)

**Version checking per type:**

- **Claude Code plugins**: current version from cached manifest (`listPlugins()` already reads this). Latest version fetched from GitHub marketplace manifest at `https://raw.githubusercontent.com/<repo>/main/manifest.json`. Marketplace repos are derived from `DEFAULT_RECOMMENDED_PLUGINS` repo field, or known mappings for official plugins (`anthropics/claude-plugins-official`).
- **MCP servers**: current version from `~/.claude/plugin-versions.json`. Latest version from npm registry `https://registry.npmjs.org/<npmPackage>/latest` → `.version`.
- **Skill packs**: current version from `~/.claude/plugin-versions.json`. Latest version from npm registry.

**Version tracking file** (`~/.claude/plugin-versions.json`):

For plugins without a manifest (MCP, skills), Auto Claude stores the installed version after each install/update:

```json
{
  "context7": "1.2.3",
  "gsd": "4.5.6"
}
```

If the file doesn't exist (first run or pre-existing installs), treat current version as "unknown". For unknown versions, always show the update button with "unknown → v1.2.3" so the user can update to a known version. The file is created/updated after each successful install or update.

### 2. Update Executor (additions to `lib/plugin-manager.js`)

New functions:

- `updatePlugin(key)` — runs the appropriate update command per plugin type. Returns `{ ok, error?, updatedVersion? }`.
  - Claude Code plugins: `claude plugins update <key>`
  - MCP servers: re-run install command from `DEFAULT_RECOMMENDED_PLUGINS`
  - Skill packs: re-run install command from `DEFAULT_RECOMMENDED_PLUGINS`
- `updateAllPlugins(keys)` — runs updates sequentially. Returns `[{ key, ok, error?, updatedVersion? }]`.

After each successful update, writes the new version to `plugin-versions.json`.

### 3. UI Integration (changes to `renderer/claude-code-manager.js`)

Two integration points:

**Overview tab** — new "Plugin Updates" card below the existing "Update" card:
- Triggered when user clicks "Check Again" on the Claude Code update card
- Shows "Checking plugins..." while scanning
- If no updates: "✓ All plugins up to date" (green)
- If updates found: lists each plugin with `current → latest` version, individual "Update" button per plugin, plus "Update All" button
- Errors shown inline in red

**Plugins tab (Installed view)** — per-plugin update indicators:
- Version number already partially displayed (extend to all plugins)
- When update available: version text turns yellow with "v5.0.7 → v5.1.0", small "Update" button appears next to toggle
- During update: button shows "Updating..." state
- After update: "✓ Updated" in green

## Data Flow

### Check for Updates

1. User clicks "Check Again" on Overview tab
2. Renderer calls `window.api.checkPluginUpdates()`
3. IPC → `check-plugin-updates` handler → `checkPluginUpdates()` in `lib/plugin-update-checker.js`
4. For each installed plugin: get current version, fetch latest version, compare
5. Returns array of update status objects
6. Results cached 10 minutes

### Update Flow

1. User clicks "Update" (single) or "Update All"
2. Renderer calls `window.api.updatePlugin({ key, tabId })` or `window.api.updateAllPlugins({ keys, tabId })`
3. IPC handler:
   a. Stops running session via existing `sessionManager.stop(tabId)`
   b. Runs update command per plugin type
   c. Updates `plugin-versions.json` with new version
   d. Restarts session with previous prompt/config via existing `sessionManager.start(tabId, prompt)`
4. Returns `{ ok, error?, updatedVersion? }`

## Error Handling

- **Network failures during version check**: show "Check failed" with retry, log to app log
- **Individual plugin check failure**: show error for that plugin, don't block others
- **Update failure**: show error message to user in red, log full output, still restart session
- **Session stop failure**: show error, don't proceed with update
- **npm registry timeout**: 10-second timeout per request, fail gracefully

## npm Package Mapping

Added as `npmPackage` field to `DEFAULT_RECOMMENDED_PLUGINS` in `lib/claude-detection.js`:

| Plugin Key | npm Package |
|-----------|-------------|
| context7@context7-mcp | ctx7 |
| gsd@get-shit-done | get-shit-done-cc |

Claude Code plugins don't use npm — they use GitHub marketplace manifests.

## Files Changed

### New files
- `lib/plugin-update-checker.js` — version checking logic, npm registry queries, marketplace manifest fetching, version comparison, cache

### Modified files
- `lib/plugin-manager.js` — add `updatePlugin(key)`, `updateAllPlugins(keys)`
- `lib/claude-detection.js` — add `npmPackage` field to `DEFAULT_RECOMMENDED_PLUGINS` for context7 and gsd
- `lib/ipc-claude-manager.js` — add IPC handlers: `check-plugin-updates`, `update-plugin`, `update-all-plugins`
- `preload.js` — expose: `checkPluginUpdates`, `updatePlugin`, `updateAllPlugins`
- `renderer/claude-code-manager.js` — Overview tab: new "Plugin Updates" card. Plugins tab: version display + update buttons

### No changes needed
- `session-manager.js` — renderer uses existing stop/start APIs
- No new npm dependencies — uses Node built-in `https` module

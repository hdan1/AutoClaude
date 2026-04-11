# Claude Code Manager — Design Spec

## Overview

Add a Claude Code detection badge next to the "AUTO CLAUDE" logo in the topbar that shows installation status. Clicking the badge opens a modal with three tabs: Overview, Settings.json editor, and Plugin manager. When Claude Code is not installed, the modal shows a guided wizard to install and authenticate.

## Badge (Topbar)

### Placement
Immediately after the "AUTO CLAUDE" logo text, inline in the topbar.

### States

| State | Appearance | Action on Click |
|-------|-----------|-----------------|
| Installed | Green pill: `● Claude Code v{version}` | Opens modal → Overview tab |
| Missing | Red pill: `● Claude Code missing` | Opens modal → Setup wizard |
| Installing | Yellow pill: `⟳ Installing Claude Code...` | Opens modal → Setup wizard (progress) |

### Detection Logic (main process)

On app start and periodically:
1. Run `claude --version` via `execFileSync` to check if `claude` is on PATH
2. If not found, check common install paths:
   - Windows: `%USERPROFILE%\.claude\local\claude.exe`
   - macOS/Linux: `~/.claude/local/claude`
3. Parse version from stdout
4. Read `~/.claude/settings.json` to detect auth configuration:
   - `env.ANTHROPIC_AUTH_TOKEN` + `env.ANTHROPIC_BASE_URL` → Custom Provider
   - `env.ANTHROPIC_AUTH_TOKEN` without custom base URL → API Key
   - Presence of OAuth credentials in `~/.claude/` → Anthropic Account
   - `env.ANTHROPIC_BASE_URL` pointing to AWS/GCP/Azure → Cloud Provider
5. Send detection result to renderer via IPC: `{ installed, version, path, authType, authDetail }`

## Modal

Centered modal overlay (similar to VS Code settings dialog). Dark theme matching existing app. Close with X button or Escape key. Three tabs across the top.

### Tab 1: Overview

Shown after successful setup. Displays read-only info cards:

| Card | Content | Source |
|------|---------|--------|
| Status | `● Installed` (green) | Detection result |
| Version | e.g. `1.0.41` | `claude --version` |
| Path | e.g. `C:\Users\Dan\.claude\local\claude.exe` | Detection result |
| Auth | Auth type + partial detail (e.g. `Custom Provider · api.gameron.me` with masked token `sk-user-46f6•••f10c`) | `~/.claude/settings.json` |
| Auto-update | `Enabled` or `Manual (Homebrew/WinGet)` | Install method detection |

Auth row includes a "Change" link that reopens the auth selection flow.

### Tab 2: Settings.json Editor

Full syntax-highlighted JSON code editor with line numbers.

**Toolbar:**
- **Scope toggle:** Global (`~/.claude/settings.json`) vs Project (`.claude/settings.json` in the currently selected project directory). Project scope is only available when a project is selected in a tab.
- **File path display:** Shows the resolved path being edited
- **JSON validation indicator:** Green "Valid JSON" or Red "Invalid JSON (line X: message)" — updates live as user types
- **Buttons:** Format (pretty-print JSON), Undo (revert last change), Save (write to disk). Save is disabled when JSON is invalid.
- **Keyboard shortcut:** Ctrl+S / Cmd+S to save

**Editor area:**
- Syntax highlighting: keys in green (#7ee787), strings in blue (#a5d6ff), numbers in orange, booleans in purple — matching GitHub dark theme
- Line numbers in left gutter
- Monospace font (Cascadia Code / Fira Code / JetBrains Mono / system monospace)
- Collapsible sections for large objects (hooks, enabledPlugins)

**Status bar:**
- Language (JSON), encoding (UTF-8), line count
- Cursor position (Ln, Col)

**Implementation note:** Use a `<textarea>` with a syntax-highlighting overlay library (e.g., CodeMirror 6 or a lightweight alternative) rather than embedding full Monaco, to keep bundle size reasonable for an Electron app.

### Tab 3: Plugins

Two sub-views toggled by a pill selector: **Installed** and **Browse**.

#### Installed Sub-view

Lists all plugins from `enabledPlugins` in `~/.claude/settings.json`.

Each plugin row shows:
- **Icon:** Color-coded square with emoji (derived from plugin type or first letter)
- **Name:** Plugin identifier (e.g. `superpowers`)
- **Source badge:** Marketplace name (e.g. `claude-plugins-official`). Community plugins from `extraKnownMarketplaces` get an orange "community" badge
- **Version:** When available from cached plugin metadata
- **Description:** One-line summary from plugin manifest
- **Toggle switch:** On/off. Toggling writes `true`/`false` to `enabledPlugins[pluginKey]` in settings.json

Search field filters the installed list by name or description.

#### Browse Sub-view

Discover and install new plugins.

**"Add from GitHub Repository" card** (top, dashed border):
- Click opens an input for `owner/repo` format
- On submit: adds entry to `extraKnownMarketplaces` in settings.json with `source: { source: "github", repo: "owner/repo" }`, then enables the plugin in `enabledPlugins`

**Available plugins list:**
- Fetched from the official Claude Code plugin registry (same source the CLI uses)
- Each row shows: icon, name, source, description, and an **Install** button
- Already-installed plugins show "Installed" instead of Install button
- Search field filters results

**Implementation note:** The plugin registry data can be fetched by running `claude plugins list --json` or by reading the cached registry from `~/.claude/plugins/cache/`. The exact mechanism depends on what the CLI exposes.

## Setup Wizard (Not Installed State)

When Claude Code is not detected, the modal opens to a 3-step guided wizard. The Settings.json and Plugins tabs are greyed out (disabled) until setup completes.

### Step 1: Install Claude Code

**Platform detection:** Auto-detect OS via `process.platform` in the main process (`win32`, `darwin`, `linux`).

**Install method tabs** (per platform):

| Platform | Methods | Default |
|----------|---------|---------|
| Windows | PowerShell (native), CMD (native), WinGet | PowerShell |
| macOS | Native curl, Homebrew | Native curl |
| Linux | Native curl | Native curl |

**Commands (from official docs at code.claude.com/docs/en/quickstart):**

| Method | Command | Auto-updates? |
|--------|---------|---------------|
| macOS/Linux native | `curl -fsSL https://claude.ai/install.sh \| bash` | Yes |
| Windows PowerShell | `irm https://claude.ai/install.ps1 \| iex` | Yes |
| Windows CMD | `curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd` | Yes |
| Homebrew | `brew install --cask claude-code` | No (manual: `brew upgrade claude-code`) |
| WinGet | `winget install Anthropic.ClaudeCode` | No (manual: `winget upgrade Anthropic.ClaudeCode`) |

**UI elements:**
- Platform detected badge (e.g. "Detected: Windows 11")
- Install method tab selector
- Command display with copy button
- Prerequisite warnings (e.g. "Requires Git for Windows" with link to git-scm.com for Windows native install)
- Auto-update status note
- **"Install Now"** button — spawns the install command in main process, streams output to a log area in the modal
- Progress indicator while installing

**After install succeeds:** Re-run detection, show checkmark on Step 1, advance to Step 2.

### Step 2: Authenticate

Four authentication methods:

**1. Anthropic Account (Recommended)**
- Label: "Claude Pro, Max, Team, or Enterprise"
- Action: "Login with Browser" button — runs `claude auth login` which opens browser for OAuth
- Badge: green "Recommended"

**2. Console API Key**
- Label: "Pre-paid credits"
- Action: Runs `claude auth login --console`
- Shows the command being run

**3. Cloud Provider**
- Label: "Amazon Bedrock · Google Vertex AI · Microsoft Foundry"
- Action: Opens sub-selection for the specific provider, links to setup guides:
  - Bedrock: code.claude.com/en/amazon-bedrock
  - Vertex: code.claude.com/en/google-vertex-ai
  - Foundry: code.claude.com/en/microsoft-foundry

**4. Custom Anthropic Provider**
- Label: "Proxy, gateway, or self-hosted endpoint (LiteLLM, OpenRouter, etc.)"
- Expands to show editable form fields:
  - **Base URL** (`ANTHROPIC_BASE_URL`) — text input, pre-filled from existing settings.json if present
  - **Auth Token** (`ANTHROPIC_AUTH_TOKEN`) — password input with reveal toggle, pre-filled (masked) from existing settings.json
- **"Test Connection"** button — sends a minimal `POST` to `{baseUrl}/v1/messages` with a tiny prompt and `max_tokens: 1` using the provided auth token. Success = 200 or 401-with-valid-JSON (confirms endpoint exists). Timeout after 10 seconds.
- **"Apply & Continue"** button — writes values to `~/.claude/settings.json` → `env` object
- Shows note: "Sets ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json"

**After auth succeeds:** Show checkmark on Step 2, advance to Step 3.

### Step 3: Ready

- Success message with celebration icon
- Summary of configured values (version, path, auth type)
- "Setup" tab label transforms to "Overview" for all future opens
- All tabs become enabled

## Architecture

### New Files

| File | Purpose |
|------|---------|
| `lib/claude-detector.js` | Main process module: detects Claude Code installation, version, path, auth type. Exports `detect()` returning `{ installed, version, path, authType, authDetail, platform, installMethod }` |
| `lib/claude-installer.js` | Main process module: runs install commands, streams output. Exports `install(method)` returning event emitter with `progress`/`complete`/`error` events |

### IPC Channels (main ↔ renderer)

| Channel | Direction | Payload |
|---------|-----------|---------|
| `detect-claude-code` | renderer → main → renderer | Returns detection result object |
| `install-claude-code` | renderer → main | `{ method: 'powershell' \| 'cmd' \| 'winget' \| 'curl' \| 'homebrew' }` |
| `install-claude-code-progress` | main → renderer | `{ output: string, done: boolean, error?: string }` |
| `authenticate-claude-code` | renderer → main | `{ method: 'anthropic' \| 'console' \| 'cloud' \| 'custom', customConfig?: { baseUrl, authToken } }` |
| `test-custom-provider` | renderer → main → renderer | `{ baseUrl, authToken }` → `{ ok, error? }` |
| `read-settings-json` | renderer → main → renderer | `{ scope: 'global' \| 'project', projectDir? }` → `{ content, path }` |
| `write-settings-json` | renderer → main → renderer | `{ scope, projectDir?, content }` → `{ ok, error? }` |
| `list-plugins` | renderer → main → renderer | Returns `{ installed: [...], available: [...] }` |
| `toggle-plugin` | renderer → main → renderer | `{ pluginKey, enabled }` → `{ ok }` |
| `install-plugin` | renderer → main → renderer | `{ source, repo? }` → `{ ok, error? }` |

### Preload API Additions (preload.js)

Add corresponding methods to `contextBridge.exposeInMainWorld('api', { ... })` for each IPC channel above.

### Renderer (index.html)

- Badge element added after `.logo` div in `.topbar`
- Modal HTML structure added after `settingsPanel` div
- Modal JS: tab switching, wizard step logic, editor initialization, plugin list rendering
- Editor: integrate CodeMirror 6 (lightweight, ~50KB) for JSON editing with syntax highlighting

### Detection Timing

- Run `detect()` once on app startup (`app.whenReady()`)
- Re-run after install completes
- Re-run when modal opens (to catch external changes)
- Cache result in main process, invalidate on settings.json file change

## Edge Cases

- **Claude installed but not on PATH:** Fall back to known install paths before reporting "missing"
- **Multiple Claude installs:** Use the first one found (PATH first, then known paths). Show path in Overview so user can verify
- **settings.json doesn't exist:** Create it on first write (with `{ }` as base)
- **settings.json is malformed:** Show error in editor, don't overwrite. Allow user to fix
- **Install fails:** Show error output in the wizard, keep "Install Now" button active for retry
- **Auth test fails:** Show error message, don't advance. Keep "Test Connection" available
- **Project has no .claude/ dir:** Project scope toggle shows "No project settings" placeholder. Offer to create the directory
- **Plugin registry unavailable:** Show "Could not load plugin registry" in Browse tab with retry button. Installed tab still works (reads from local settings.json)

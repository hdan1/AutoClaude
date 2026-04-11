# Settings Editor Redesign — Design Spec

**Date:** 2026-04-08
**Goal:** Replace the raw textarea settings.json editor in the Claude Code Manager modal with a structured section-based editor, dual-mode editing (Structured/Raw JSON), and a tagged config history system with left sidebar navigation.

---

## Architecture Overview

The Settings.json tab in the Claude Code Manager modal gets a complete redesign:

- **Left sidebar** (~140px): tag list for config history, "Current" always on top
- **Right editor** (~540px): toolbar with mode toggle + accordion section panels or raw JSON editor
- **Global only** — no project scope toggle (removed)

Storage: live config at `~/.claude/settings.json`, tagged snapshots in `~/.claude/settings-tags/{name}.json`.

---

## Layout

### Left Sidebar

Fixed-width sidebar (~140px) with:

- **Header:** "CONFIGS" label
- **Current entry:** Always first, green highlight, represents the live `~/.claude/settings.json`
- **Tag list:** Alphabetically sorted below Current. Each tag shows its name. Clicking a tag loads its content into the editor.
- **Delete:** Each tag (except Current) has a delete button on hover (trash icon or X)
- **Footer:** "+ New Tag" link at bottom

### Right Editor Area

**Toolbar row:**
- Left: `[Structured | Raw JSON]` mode toggle (pill-style buttons matching existing `ccm-scope-toggle` pattern)
- Center (Raw mode only): JSON validation status (`● Valid JSON` / `● Invalid JSON`)
- Right: `[Save As...]` secondary button + `[Save]` primary button

### Mode Toggle Behavior

- **Structured → Raw:** Serialize current structured form state to formatted JSON, display in textarea
- **Raw → Structured:** Parse JSON from textarea, populate structured form fields. If JSON is invalid, show error and prevent switch.
- Edits in either mode are the "working state" until Save is clicked.

---

## Structured Mode

Accordion sections, vertically stacked. Multiple sections can be open simultaneously. Each section header shows the section name and a count/summary on the right.

### Section 1: Environment

- Lists all keys from `settings.env` as key-value rows
- Each row: label (key name, uppercase), text input (value)
- `ANTHROPIC_AUTH_TOKEN` gets a password input with eye toggle to show/hide
- `[+ Add Variable]` button at bottom to add new env vars
- Delete button (X) on each row to remove a var

### Section 2: Model & Effort

- **Model:** Dropdown select populated with known model names: `claude-opus-4-6`, `claude-sonnet-4-20250514`, `claude-haiku-4-20250414` (and any current value if not in the list)
- **Effort Level:** Dropdown: `low`, `medium`, `high`
- Both dropdowns show the current value from settings

### Section 3: Hooks

Nested accordion structure:

- **Top level:** Hook event types (PostToolUse, PreToolUse, SessionStart, etc.)
- Each event type shows count of hook entries
- **Expanded event type:** List of hook group cards. Each card shows:
  - **Matcher:** Text input (e.g., `Bash|Edit|Write|MultiEdit|Agent|Task`)
  - **Hooks array:** Each hook in the group shows:
    - **Type:** Text input (usually `command`)
    - **Command:** Text input (the command string)
    - **Timeout:** Number input (optional)
  - `[🗑 Delete]` button per hook entry
- `[+ Add Hook]` button at bottom of each event type
- `[+ Add Event Type]` button at the section level for new hook categories

### Section 4: Status Line

- **Type:** Text input (e.g., `command`)
- **Command:** Text input (the statusLine command path)
- If `statusLine` is not set, show a placeholder with `[+ Configure]`

### Section 5: Flags & Other

- **Boolean flags:** Toggle switches for known boolean settings (e.g., `skipDangerousModePermissionPrompt`)
- **Unknown keys:** Any keys not handled by the above sections are listed as read-only key-value pairs with a note: "Edit in Raw JSON mode"
- This ensures no data is lost when switching between modes

---

## Raw JSON Mode

Enhanced textarea editor (replaces the current implementation):

- Monospace font (`Cascadia Code`, `Fira Code`, `JetBrains Mono`)
- JSON validation on every keystroke — status indicator in toolbar
- `[Format]` button to pretty-print (JSON.stringify with 2-space indent)
- `Ctrl+S` / `Cmd+S` keyboard shortcut to save
- `Tab` key inserts 2 spaces (existing behavior preserved)
- Full content of the settings JSON visible and editable

---

## Tag History System

### Storage

```
~/.claude/
  settings.json              ← live config ("Current")
  settings-tags/
    daily-work.json          ← full copy of settings at time of save
    debugging.json
    minimal.json
```

Each tag file is a complete, standalone copy of settings.json — not a diff or partial.

### Sidebar Behavior

- **Click "Current":** Loads `~/.claude/settings.json` into editor
- **Click a tag:** Loads `~/.claude/settings-tags/{name}.json` into editor
- **Selected state:** Highlighted background on the active tag

### Save Flow

- **Save button:** Writes current editor content to the selected tag's file. If "Current" is selected, writes to `~/.claude/settings.json`. If a named tag is selected, writes to `~/.claude/settings-tags/{name}.json`.
- **Save As button:** Opens a small inline prompt (not a system dialog) asking for a tag name. Creates `~/.claude/settings-tags/{name}.json` with the current editor content. Switches the sidebar selection to the new tag.

### Delete Flow

- Hover over a tag → show delete icon (X or trash)
- Click delete → confirm dialog ("Delete tag '{name}'?")
- Deletes the file from `settings-tags/`
- If the deleted tag was selected, switch to "Current"
- "Current" cannot be deleted

### Tag Name Validation

- Alphanumeric, hyphens, underscores only
- No spaces, no path separators
- Max 50 characters
- Must be unique (case-insensitive on Windows)

---

## Backend Changes

### New Methods in `lib/claude-detector.js`

```
listSettingsTags()              → { tags: [{ name, path }] }
loadSettingsTag(name)           → { content, path }
saveSettingsTag(name, content)  → { ok, path } | { ok: false, error }
deleteSettingsTag(name)         → { ok } | { ok: false, error }
```

All operate on `~/.claude/settings-tags/` directory. Create the directory on first save if it doesn't exist.

### New IPC Handlers in `main.js`

```
list-settings-tags       → claudeDetector.listSettingsTags()
load-settings-tag        → claudeDetector.loadSettingsTag(name)
save-settings-tag        → claudeDetector.saveSettingsTag(name, content)
delete-settings-tag      → claudeDetector.deleteSettingsTag(name)
```

Tag name validation happens in the IPC handler before passing to detector.

### New Preload API Methods

```
listSettingsTags()              → invoke('list-settings-tags')
loadSettingsTag(opts)           → invoke('load-settings-tag', opts)
saveSettingsTag(opts)           → invoke('save-settings-tag', opts)
deleteSettingsTag(opts)         → invoke('delete-settings-tag', opts)
```

### Removed

- `read-claude-settings` scope/projectDir handling simplified — only global scope
- Project scope toggle removed from UI

---

## Changes to Existing Code

### index.html — Settings Tab

The entire `renderSettingsEditor()` function is replaced. The new implementation:

1. Renders the sidebar + editor layout
2. Loads tag list via `listSettingsTags()`
3. Loads current config via `readClaudeSettings({ scope: 'global' })`
4. Parses JSON and populates structured form OR raw textarea
5. Handles mode switching, save, save-as, delete, tag selection

### CSS

- Remove: `.ccm-scope-toggle`, `.ccm-scope-btn` (project toggle no longer needed)
- Add: sidebar styles, accordion styles, form input styles, mode toggle styles
- Reuse existing patterns: `.ccm-card`, `.ccm-btn-primary`, `.ccm-btn-secondary`

---

## Error Handling

- **Invalid JSON in Raw mode:** Disable Save button, show red validation status. Prevent switch to Structured mode.
- **Structured → JSON serialization:** Always produces valid JSON (built programmatically).
- **Tag file read errors:** Show "Failed to load" inline, fall back to Current.
- **Tag file write errors:** Show error message inline near Save button.
- **Missing settings-tags directory:** Create on first save automatically.
- **Unknown settings keys:** Preserved in Flags & Other section, never dropped during structured editing.

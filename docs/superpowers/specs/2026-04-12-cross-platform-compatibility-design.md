# Cross-Platform Compatibility Fixes

**Date:** 2026-04-12
**Scope:** Ensure Auto Claude works correctly on Windows, macOS, and Linux
**Files affected:** 11 source files + package.json

## Problem

The codebase is primarily developed on Windows and has good cross-platform awareness in many areas (platform-guarded process killing, `path.join()` usage, per-platform binary detection). However, an audit found 15 issues across critical, high, medium, and low severity that would break functionality or degrade UX on specific platforms.

The most pervasive issue is 5 call sites that `spawn`/`execFile` a bare `'claude'` string without `shell: true` on Windows, which fails to resolve `.cmd` shims.

## Design

### 1. Centralized `spawnClaude()` Helper

**New file:** `lib/spawn-claude.js`

Exports:
- `spawnClaude(args, options)` — Resolves claude binary path via `findClaudePath()`, falls back to `'claude'` with `shell: true` on Windows. Returns the spawned child process.
- `killClaudeProcess(proc)` — Platform-aware process termination: `taskkill /T /PID` on Windows (tree kill), `SIGTERM` on Unix.
- `getClaudeCommand()` — Returns `{cmd, shellFlag}` for use with `execFile`/`execFileSync` where `spawn` isn't appropriate.

**Updated call sites:**
- `lib/pty-executor.js` — Replace `spawn('claude', ...)` with `spawnClaude()`, replace `proc.kill('SIGTERM')` with `killClaudeProcess()`
- `lib/plugin-manager.js:164` — Replace `spawn(claudePath, ...)` with `spawnClaude()`
- `lib/plugin-manager.js:148` — Replace `execFileSync(claudePath, ...)` with resolved path + shell flag from `getClaudeCommand()`
- `lib/update-checker.js:19` — Replace `execFile(claudePath, ...)` with resolved path + shell flag
- `lib/claude-installer.js:71` — Replace `spawn('claude', ...)` in `authenticate()` with `spawnClaude()`

### 2. Install Method Platform Validation

**File:** `lib/claude-installer.js`

Add `PLATFORM_METHODS` map:
```
win32:  ['powershell', 'cmd', 'winget']
darwin: ['curl', 'homebrew']
linux:  ['curl']
```

`install()` rejects invalid method/platform combos with a descriptive error message.

Fix `INSTALL_COMMANDS.homebrew` to omit `--cask` on Linux (Linuxbrew doesn't support casks).

### 3. macOS Application Menu

**File:** `main.js`

Replace `Menu.setApplicationMenu(null)` with a platform check:
- macOS: Create minimal menu with `appMenu`, `editMenu`, `viewMenu`, `windowMenu` roles (preserves Cmd+Q, Cmd+C/V/X, Cmd+H, Cmd+W)
- Windows/Linux: Keep `Menu.setApplicationMenu(null)`

### 4. Linux Terminal Emulator Discovery

**File:** `main.js`

Replace the single `x-terminal-emulator` spawn with a cascade that tries:
1. `x-terminal-emulator` (Debian/Ubuntu)
2. `gnome-terminal` (GNOME)
3. `konsole` (KDE)
4. `xfce4-terminal` (XFCE)
5. `xterm` (universal fallback)

Use `which` to find the first available terminal.

### 5. macOS App Lifecycle

**File:** `main.js`

In the `window-all-closed` handler, don't quit on macOS even if tray is unavailable. This follows standard macOS convention where apps stay running until Cmd+Q.

### 6. Linux `safeStorage` Warning

**File:** `lib/telegram-secure.js`

When `safeStorage.isEncryptionAvailable()` returns false on Linux, log a warning message suggesting `gnome-keyring` or `kwallet` installation. Return the failure gracefully (already done), but now with visibility.

### 7. Windows Path Case Normalization

**File:** `lib/master-telegram.js`

Add a `_normPath()` helper that lowercases resolved paths on Windows before comparison. Apply to `_isWorkspaceProject()` and `_formatList()`.

### 8. Linux Package Config

**File:** `package.json`

Add to `linux` build config:
- `"StartupWMClass": "auto-claude"` for proper taskbar grouping
- `"rpm"` target for Fedora/RHEL users

### 9. macOS Tray Icon

**File:** `lib/runtime-utils.js`

When resolving tray icon on macOS, prefer `iconTemplate@2x.png` if it exists (Retina support, auto dark/light mode). Fall back to `icon.png`.

### 10. Unix Path Hash

**File:** `lib/sessions.js`

Strip leading `/` from Unix paths before hashing to avoid a leading dash in the hash string. Verify this matches Claude CLI's own behavior.

## Testing Strategy

- Test each fix on the target platform(s)
- Existing tests in `*.test.js` files should continue to pass
- The centralized helper can be unit-tested with mocked `findClaudePath()`

## Risk Assessment

- **Low risk:** All fixes are additive or replace simple patterns with guarded versions
- **No breaking changes:** Existing Windows behavior is preserved
- **Idempotent:** All PATH/config changes check before writing

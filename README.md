# Auto Claude

Multi-session Claude Code dashboard. Start and manage multiple persistent Claude CLI sessions in tabs with real-time monitoring, autonomous operation, and remote control via Telegram.

**Core idea:** One-click launch of Claude Code sessions with live output, tool call visibility, token tracking, and auto-answer — no terminal required.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install from Release](#install-from-release)
- [Install from Source](#install-from-source)
- [Quick Start](#quick-start)
- [Settings](#settings)
- [Dashboard](#dashboard)
- [Telegram Integration](#telegram-integration)
- [Building Installers](#building-installers)
- [Creating a Release](#creating-a-release)
- [Architecture](#architecture)

---

## Features

- **Multi-tab sessions** — run multiple Claude CLI sessions side by side, each pointed at a different project
- **Live output** — color-coded real-time stream showing tool calls, subagent activity, errors
- **Model & effort selection** — choose Claude model and reasoning effort level per session from the toolbar
- **Autonomous operation** — auto-answer questions, auto-select recommended options, derailment correction with loop protection
- **Token tracking** — cumulative input/output tokens, cost tracking, TTFT, model info per session
- **Loop detection** — progress-aware stuck detection and oscillation prevention stops runaway sessions
- **Sleep prevention** — keeps your computer awake while sessions are running (Windows, macOS, Linux)
- **Telegram bot** — remote monitoring and control from your phone (master bot + per-project bots)
- **Batch mode** — queue multiple prompts for sequential or parallel execution
- **Crash recovery** — auto-restart on CLI crashes with configurable retry and backoff
- **Session persistence** — resume conversations across restarts with `--resume`
- **Hook telemetry** — async PostToolUse/SubagentStop hooks for deep subagent visibility at zero latency cost
- **Auto-update** — checks GitHub Releases for new versions and prompts to update (installed builds)
- **Pre-commit safety** — git hook scans staged files for API keys, tokens, and secrets before every commit

---

## Requirements

- **Node.js** 18+ — [download](https://nodejs.org)
- **Claude CLI** — must be installed globally and on your PATH ([install guide](https://docs.anthropic.com/en/docs/claude-code/overview))

Verify both are available:

```bash
node --version
claude --version
```

---

## Install from Release

Download the latest installer for your platform from [GitHub Releases](../../releases):

| Platform | File |
|----------|------|
| Windows | `Auto-Claude-Setup-x.x.x.exe` |
| macOS | `Auto-Claude-x.x.x.dmg` |
| Linux | `Auto-Claude-x.x.x.AppImage` or `.deb` |

Run the installer. The app will check for updates automatically on startup.

> **Note:** Installers are not code-signed. You may see "unknown publisher" warnings on Windows or Gatekeeper prompts on macOS. This is expected for open-source Electron apps without signing certificates.

---

## Install from Source

```bash
git clone https://github.com/herdanw/AutoClaude.git
cd AutoClaude
npm install
npm start
```

On Windows, you can also double-click `start.bat`.

---

## Quick Start

1. **Set your workspace** — Open Settings (gear icon) > Workspace > set a root directory containing your project folders
2. **Open a project** — Click a project name in the sidebar, or use the directory picker
3. **Enter a prompt** — Type a prompt or slash command (e.g., `/gsd:next`, `fix the login bug`)
4. **Click Start** — The session launches and you see live output immediately

The app auto-installs telemetry hooks into your project's `.claude/settings.json` on start and removes them on stop. These hooks are async — they add zero latency to Claude's operations.

---

## Settings

Open Settings via the gear icon. All settings are stored in a local SQLite database at `~/.electron/auto-claude/auto-claude.db` (never committed to git).

| Category | What it controls |
|----------|-----------------|
| **Workspace** | Root directory for project discovery |
| **Session** | Default prompt, model/effort selection, permission skipping |
| **Autonomy** | Auto-answer mode (full/review/manual), question timeouts, derailment correction |
| **Notifications** | Desktop notifications for questions, completions, errors |
| **Retry** | Auto-retry on rate limits and API errors, backoff timing |
| **Resilience** | Crash recovery, max crash retries, auto-resume |
| **Telegram** | Master bot and per-project bot configuration |
| **Hooks** | Telemetry hook installation, log file path, max log size |
| **Batch** | Batch queue mode (sequential/parallel), parallel limit |
| **Superpowers** | Skill integration, auto-chaining, auto-approve |
| **System** | Sleep prevention, auto-update |

### Key settings

**Autonomy mode:**
- `Full` — auto-answers all questions immediately, selects recommended options, approves all tool permissions, and continues with best judgment. If no recommended option exists, answers instantly without review. Truly hands-off.
- `Review` — auto-answers but shows the answer with a countdown timer (default 10s) so you can intervene before it proceeds. Questions without a recommended option get a longer countdown (default 30s). Tool permissions still require approval.
- `Manual` — pauses on every question and waits for your input. No auto-answering at all.

**Sleep prevention:** Keeps the computer awake while any session is running. Uses Electron's built-in `powerSaveBlocker` — works on Windows, macOS, and Linux. Releases automatically when all sessions stop.

**Auto-update:** Checks GitHub Releases on startup (packaged builds only). Downloads updates in the background and shows a banner when ready to install.

---

## Dashboard

### Status Cards

| Card | Shows |
|------|-------|
| State | IDLE / RUNNING / PAUSED |
| Tokens | Cumulative input + output tokens |
| Tools | Total tool calls (main agent vs subagent) |
| TTFT | Time to first token (last run) |
| Model | Which Claude model is in use + effort level |
| Elapsed | Wall clock time |

### Live Output

Color-coded real-time stream:
- Cyan — tool calls (main agent)
- Pink — subagent tool calls (from hooks)
- Blue — system events
- Red — errors

### Sleep Indicator

When sleep prevention is active, a "☕ Awake" indicator appears in the header. It shows automatically when any session is running and disappears when all sessions stop.

### Update Banner

When a new version is downloaded (packaged builds only), a banner appears at the top: "Update vX.X.X ready — Restart Now". Click to apply the update, or dismiss to update later (it will install on next app quit).

---

## Telegram Integration

Control and monitor sessions from your phone.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram
2. Open Settings > Telegram > enable Master Bot
3. Save your bot token (stored securely in OS keychain)
4. Set allowed usernames (comma-separated, no @)
5. Use "Discover Chat ID" to link your chat

### Commands

Send these to your bot:

| Command | Action |
|---------|--------|
| `/status` | Current state of all sessions |
| `/start` | Start a session |
| `/stop` | Stop a session |
| `/send <text>` | Send a response to Claude |
| `/skip` | Skip the current question |

---

## Building Installers

Build locally for your current platform:

```bash
# All platforms (current OS)
npm run dist

# Platform-specific
npm run dist:win      # Windows (.exe installer)
npm run dist:mac      # macOS (.dmg + .zip)
npm run dist:linux    # Linux (.AppImage + .deb)
```

Output goes to `dist/`. Icons go in the `build/` directory:
- `build/icon.ico` — Windows (256x256 minimum)
- `build/icon.icns` — macOS (512x512)
- `build/icon.png` — Linux (512x512)

If no icons are provided, the default Electron icon is used.

---

## Creating a Release

Releases are automated via GitHub Actions. When you push a version tag, GitHub builds installers for all three platforms and creates a draft release.

### Steps

```bash
# 1. Bump version in package.json
#    e.g., "version": "3.0.0" → "version": "3.1.0"

# 2. Commit the version bump
git add package.json
git commit -m "chore: bump version to 3.1.0"

# 3. Create a version tag
git tag v3.1.0

# 4. Push everything
git push && git push --tags
```

### What happens next

1. GitHub Actions triggers on the `v*` tag
2. Three runners build in parallel: Windows, macOS, Linux
3. Each runner creates platform-specific installers
4. A **draft** GitHub Release is created with all installers attached
5. Go to [Releases](../../releases), review the draft, and click **Publish**

Users with Auto Claude installed will see an update notification on next launch.

---

## Architecture

```
main.js              Electron main process — session lifecycle, IPC, orchestration
preload.js           Context bridge (secure IPC between main and renderer)
index.html           Dashboard UI — HTML + CSS + inline JS (single file)
settings-db.js       SQLite settings with schema-driven UI rendering
session-manager.js   Session state machine and event coordination
proxy.js             ClaudeProxy — spawns CLI, parses stream-json, manages retries
lib/
  autonomy.js        Auto-answer engine
  models.js          Claude API model fetching
  sessions.js        Session state persistence
  summarize.js       Output summarization
  telegram.js        Per-project Telegram bot
  master-telegram.js Master Telegram bot
  telegram-secure.js OS keychain token storage
  workflow-detector.js  Workflow state detection
  gsd-detector.js    GSD phase detection
  superpowers-detector.js  Skill detection
  validate.js        Input validation
  logger.js          Logging
  constants.js       Shared constants
hooks/
  auto-claude-hook.js     Async telemetry hook (installed into target projects)
  pre-commit-scan.js      Git pre-commit safety scanner
  install-git-hooks.js    Git hook installer (runs on npm install)
```

### Data Flow

```
User clicks Start
  → main.js receives 'start-session' IPC
    → installs telemetry hooks in target project
    → creates ClaudeProxy instance
      → spawns `claude` CLI with stream-json output
        → proxy parses events, emits to main
          → main forwards via IPC to renderer
            → index.html updates dashboard live
```

### Telemetry

**stream-json** (built into Claude CLI): time to first token, token counts, model name, tool calls, completion status.

**Async hooks** (installed by Auto Claude): every tool call inside subagents. Zero latency impact — `async: true` means Claude fires them but doesn't wait. Each hook takes ~10ms to append a JSON line to a log file.

---

## Pre-commit Safety

A git hook automatically scans staged files before every commit. It blocks commits containing:

- Database files (`.db`, `.sqlite`, `.env`)
- Private keys (`.pem`, `.key`, `.p12`)
- API keys (`sk-...`, `ghp_...`)
- Telegram bot tokens
- Hardcoded passwords or secrets

If blocked, the error message shows exactly what was detected. To bypass a false positive:

```bash
git commit --no-verify
```

---

## License

MIT

# Auto Claude — Operational Runbook

## DB Corruption Recovery
- Backup location: `<userData>/settings.db.bak` (created automatically on corruption detection)
- Manual restore: copy `.bak` over `settings.db`, restart app
- Nuclear option: delete `settings.db`, app recreates with defaults on next launch

## Telegram 409 Conflict
- **Symptom:** "409 Conflict: terminated by other getUpdates request"
- **Cause:** Two instances polling the same bot token
- **Fix:** Stop all instances of Auto Claude. Check for orphan processes. Restart one instance only.

## Hook Cleanup
- Auto-installed to: `<projectDir>/.claude/settings.json`
- Manual uninstall: `node install-hooks.js <projectDir> --uninstall`
- Also accepted: `node install-hooks.js --uninstall <projectDir>`
- Stale hook detection: hooks have marker `auto-claude-hook.js`. If marker not found, hooks are re-installed automatically.

## Stuck Session Recovery
- PID file: `<userData>/auto-claude-pids.json`
- Manual kill: read PIDs from file, `kill -9 <pid>` or `taskkill /F /PID <pid>`
- After kill: delete PID file, restart app

## Token Rotation
- **Telegram bot:** Settings > Telegram > enter new token. Old encrypted token overwritten.
- **Custom provider:** Settings > Custom Provider > update token. Re-saved to encrypted storage.

## Context Recovery Debugging
- Default threshold: 85% of context window
- Adjust: Settings > Context Guard > threshold slider
- Max recoveries per session: 3 (prevents infinite recovery loops)
- GSD workflow: automatic `/gsd-pause-work` + `/gsd-resume-work` pattern
- Generic workflow: writes `.auto-claude-handoff.md` → reads on resume

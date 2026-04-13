# Master Bot Notification Hub

**Date:** 2026-04-13
**Status:** Draft

## Problem

When projects have Telegram bots configured, the project bot can be noisy with streaming output, tool events, and log messages. Users may mute the project bot to avoid distractions. However, when Claude needs user input (a question), the user might miss it because the project bot is muted.

The master bot already forwards questions, but it does so with the same verbosity as the project bot and requires answering via a `/reply <token>` mechanism rather than directing the user to the project bot's chat.

## Solution

Transform the master bot into a configurable notification hub. Each project gets a `masterNotifyMode` setting that controls how the master bot handles question notifications:

- **`"full"`** — Master bot shows the full question text plus a deep-link button to open the project bot's chat.
- **`"ping"`** — Master bot shows only a short alert ("ProjectName needs your input") plus the deep-link button.
- **`"off"`** — Master bot is not notified for this project.

When a project has no project bot configured, the master bot falls back to the existing `/reply <token>` mechanism regardless of the mode setting.

## Configuration

### Per-Project Config

The `config.projectTelegram[resolvedPath]` object gains a new field:

```js
{
  enabled: boolean,          // existing
  allowedUsers: string[],    // existing
  masterNotifyMode: "full" | "ping" | "off"  // new, default: "full"
}
```

Default is `"full"` for backward compatibility — existing setups continue to work without configuration changes.

## Project Bot Username Discovery

To create `t.me/{botUsername}` deep-links, the system needs to know each project bot's Telegram username.

### Mechanism

1. `TelegramBridge.start()` calls `this.bot.getMe()` after `startPolling()`.
2. Stores the result as `this.botUsername` on the bridge instance.
3. If `getMe()` fails, `botUsername` remains `null` — triggers fallback to `/reply` mode.

### Data Flow

In `main.js`, the `'question'` event handler reads `bot.botUsername` from the project bot instance and passes it to `masterTelegram.forwardQuestion()`:

```js
sessionManager.on('question', ({ tabId, questionData }) => {
    const state = sessionManager.getState(tabId) || {};
    const bot = getProjectBot(state.projectDir);
    if (bot?.isRunning) { bot.forwardQuestion(tabId, questionData); }
    if (masterTelegram?.isRunning) {
        const resolved = state.projectDir ? path.resolve(state.projectDir) : null;
        const ptConfig = resolved ? (config.projectTelegram?.[resolved] || {}) : {};
        masterTelegram.forwardQuestion(
            { tabId, projectDir: state.projectDir, state,
              projectBotUsername: bot?.botUsername || null,
              masterNotifyMode: ptConfig.masterNotifyMode || 'full' },
            questionData
        );
    }
});
```

## Master Bot `forwardQuestion()` Behavior

The rewritten `MasterTelegramBridge.forwardQuestion()` handles three cases based on the `masterNotifyMode` passed in tab info:

### Mode: `"off"`

Return immediately. No message sent.

### Mode: `"ping"` (with project bot available)

Send a short notification with an inline deep-link button:

```
🔔 MyProject needs your input
```

With inline keyboard:
```js
reply_markup: {
  inline_keyboard: [[{
    text: '💬 Open Project Bot',
    url: `https://t.me/${projectBotUsername}`
  }]]
}
```

### Mode: `"full"` (with project bot available)

Send the question text with the inline deep-link button:

```
❓ [tab1 | MyProject] Question
What API key should I use?
```

With the same inline keyboard button as ping mode.

### Fallback (no project bot)

If `projectBotUsername` is `null` (no project bot configured or `getMe()` failed), use the existing `/reply <token>` mechanism regardless of mode. This ensures questions are always answerable.

```
[tab1 | alias | MyProject] Question
What API key should I use?
Reply token: abc123
Usage: /reply abc123 <text>
```

### The `/reply` command

The `/reply` command stays registered on the master bot for the fallback case. Reply tokens are only generated and shown when there is no project bot to deep-link to.

## UI Changes

### Project Telegram Panel

Add a dropdown to the existing per-tab Telegram panel in `index.html`:

```html
<div style="display:flex;align-items:center;gap:8px;margin-top:4px">
  <span style="color:var(--tx2);font-size:12px">Master bot notification</span>
  <select data-el="tgMasterNotify" style="font-size:11px">
    <option value="full">Full question</option>
    <option value="ping">Ping only</option>
    <option value="off">Off</option>
  </select>
</div>
```

Placed after the bot token / allowed users row and before the status/save buttons.

### Load/Save Logic

- **Load:** When the panel opens, `loadTelegramConfig` returns `masterNotifyMode`. The dropdown is set to that value (default `"full"`).
- **Save:** `tgSaveBtn.onclick` reads the dropdown value and includes `masterNotifyMode` in the config payload sent to `saveTelegramConfig`.

### Visibility

The dropdown is always visible in the project Telegram panel. Even if no master bot is configured, showing it doesn't cause harm and avoids complexity.

## Files Changed

| File | Changes |
|------|---------|
| `lib/telegram.js` | Add `this.botUsername = null` in constructor. Call `bot.getMe()` in `start()` to populate it. |
| `lib/master-telegram.js` | Rewrite `forwardQuestion()` to support three modes with inline deep-link button. Keep `/reply` for fallback. |
| `main.js` | Update `'question'` event handler to pass `projectBotUsername` and `masterNotifyMode`. Update `saveTelegramConfig` to accept/persist `masterNotifyMode`. Update `loadTelegramConfig` to return `masterNotifyMode`. |
| `index.html` | Add `masterNotifyMode` dropdown to project Telegram panel. Wire load/save. |
| `lib/telegram.test.js` | Add test for `botUsername` population via `getMe()`. |

## Error Handling

- **`bot.getMe()` failure:** Log warning, `botUsername` stays `null`, fallback to `/reply` mode.
- **Missing `masterNotifyMode`:** Defaults to `"full"` everywhere (backward compatible).
- **Master bot not running:** No change — questions still go to project bot only.
- **Invalid mode value in config:** Treat as `"full"`.

## No Breaking Changes

- Existing setups without `masterNotifyMode` default to `"full"`, which preserves current behavior (full question forwarded to master bot).
- The `/reply` command remains for the fallback case.
- Project bots are unaffected — they continue to receive and handle questions independently.

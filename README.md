# Pager 📟

**Claude Code in your pocket: a Telegram message when a task is done or Claude waits for your permission — and you text back the next prompt.**

A mod (function-hooks plugin) for Claude Code. No server, no Bun, no extra flags: the mod talks to your own Telegram bot through Claude Code's network, and only the chat you paired can talk back.

[Русская версия](README.ru.md)

## What it does

- ✅ **Done** — when a turn that took longer than *N* seconds ends, the paired chat gets the project folder, how long it took and Claude's answer (long answers are cut at a word, `/last` sends the whole one).
- ⏸ **Waiting for you** — when Claude stops to ask for permission or input, you get the question.
- 📨 **Text the next prompt** — any message to the bot is queued into the session as your own prompt; it runs as soon as Claude is free. Its turn is always reported back, however short.
- `/status` — idle, or what Claude is working on and for how long
- `/last` — the last answer in full
- `/stop` — stop the running task
- Several Claude Code windows open? They all send, but only one listens to the bot at a time (a lease in the mod's store; Telegram allows a single reader per bot).

```
✅ Done · 📁 galleria · 3 min 05 s

All 49 unit tests pass. I fixed the cache: the museum's API sent `Vary: *`…
```

## Install

```
/plugin install pager --marketplace vihrea1337/pager
```

Answer `y` to add the marketplace, pick the user scope, and paste your bot token when asked (it goes to Claude Code's secure storage).

## Set up the bot (2 minutes)

1. In Telegram, open **@BotFather** → `/newbot` → a name → a username ending in `bot`. Copy the token it sends (`1234567890:AA…`).
2. If you skipped the token at install: `/pager token <token>` in Claude Code.
3. Text your bot anything. It answers with a 6-digit code.
4. In Claude Code: `/pager pair <code>`. Done — `/pager test` sends a test message.

From then on the bot listens to that chat only; messages from anyone else are dropped silently.

## Settings (`/config` → pager)

| Setting | Default | |
|---|---|---|
| Notify after (seconds) | 30 | Quick answers you watched yourself don't buzz your phone. Turns started from Telegram are always reported. |
| Notify when waiting | on | The "waiting for permission / input" message |
| Accept prompts from Telegram | on | Off = notifications only |
| Desktop notification too | off | Also a system notification on this computer |
| Language | en | `en` or `ru` |

`/pager` alone shows what is set up: token, paired chat, which session is listening.

## Security

A message to your bot becomes a prompt in a session that can edit files and run commands, so:

- only the **paired chat** is heard — pairing needs a code shown in that chat *and* typed at your terminal;
- the token is kept in Claude Code's secure storage (or the mod's store if you used `/pager token`); nobody else should see it — if it leaks, `/revoke` it in @BotFather;
- permission prompts still stop the session: approving tool use from Telegram is deliberately not in 0.1.

## How it works

| Hook | What for |
|---|---|
| `turn.start` / `turn.complete` | remembers what is running; on completion sends the answer (`e.answer`, `e.durationMs`, `e.reason`) |
| `classic.Notification` | permission / input prompts → "waiting for you" (with a `.catch` that always passes the engine's own notification on) |
| `session.start` | registers `/pager`, starts the poll timer (`$.clock.every`) |
| timer → `$.http.fetch` | Telegram `getUpdates` long-poll; text → `$.prompt.submit({ asUser: true })`; `/stop` → `$.turn.abort` |
| `session.end` | hands the polling lease back |

All logic is pure functions in [`hooks/core.ts`](hooks/core.ts) (message formatting, update parsing, the lease); [`hooks/register.ts`](hooks/register.ts) wires them to the engine. Tests run against the engine's own test kit with Telegram and the store faked: `claude plugin test .`

## Develop

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # a session with the mod loaded from this folder
```

Requires Claude Code 2.1.287 or newer (function-hooks mods).

## Compared to the official Telegram channel

Claude Code's research-preview [channels](https://code.claude.com/docs/en/channels) also bridge Telegram, as an MCP server on Bun started with `--channels`. Pager is a lighter take on the other half: it **notifies you first** (a channel only answers what you send), needs nothing but the mod, and works in every session you start. Don't point both at the same bot — Telegram lets one reader poll it.

## License

MIT

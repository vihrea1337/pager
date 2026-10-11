# Changelog

## 0.2.0 — 2026-10-11

- Answers arrive formatted: Claude's Markdown (bold, italics, `code`, code blocks, headings, lists, links) becomes Telegram HTML; if Telegram still refuses the markup, the message goes out as plain text.
- The bot's "Menu" button lists /status, /last, /stop, /help (set on start, `/pager token` and pairing).
- `/status` says when the turn is over but background tasks are still running; "Done" notes them too.
- A turn started by a background task's notification is marked "after a background task" instead of showing its own few seconds as if they were the task's.
- "Done" is sent for every turn by default (`minSeconds` 0).

## 0.1.0 — 2026-10-11

First version.

- "Done" message to Telegram after turns longer than a threshold (folder, duration, the answer), always for turns started from Telegram.
- "Waiting for you" on permission / input prompts.
- Text the bot to queue the next prompt; `/status`, `/last`, `/stop`, `/help`.
- Pairing by a code shown in Telegram and typed at the terminal; only the paired chat is heard.
- One listener across open sessions (a lease in the mod's store).
- `/pager` — token, pair, unpair, test, status. English and Russian messages.

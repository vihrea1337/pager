# Changelog

## 0.3.1 — 2026-10-11

- `/pager unpair` works. It wrote `undefined` into the mod's store, which only takes JSON data, so the command answered nothing and the engine said "no command.run hook answered it". The store's own `delete` is used now.
- The same mistake kept a session from handing the polling lease back when it ended, so another open session had to wait for the lease to expire before it could reach the bot.
- `/pager` always answers: an error inside a subcommand comes back as a readable line instead of the engine's "no hook answered it".
- Tests: the fake store is as strict as the real one (`undefined` refused), with regression tests for unpair and for the lease handed back at session end.

## 0.3.0 — 2026-10-11

- "Done" carries the whole turn: what Claude wrote along the way (between tool calls — progress notes, answers to messages sent mid-task) under "Along the way", then the final answer under "Result". Before, only the last text block arrived.
- Nothing is cut any more: a long answer goes as several messages, "(2/3)" on the ones after the first; a code block split between messages is closed and reopened. `/last` is formatted too.

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

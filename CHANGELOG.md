# Changelog

## 0.1.0 — 2026-10-11

First version.

- "Done" message to Telegram after turns longer than a threshold (folder, duration, the answer), always for turns started from Telegram.
- "Waiting for you" on permission / input prompts.
- Text the bot to queue the next prompt; `/status`, `/last`, `/stop`, `/help`.
- Pairing by a code shown in Telegram and typed at the terminal; only the paired chat is heard.
- One listener across open sessions (a lease in the mod's store).
- `/pager` — token, pair, unpair, test, status. English and Russian messages.

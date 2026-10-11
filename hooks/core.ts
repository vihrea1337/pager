// Pager: all the logic as pure functions — formatting, parsing Telegram updates,
// the polling lease. register.tsx wires them to the engine; tests call them directly.

export type Lang = 'en' | 'ru'

/** Telegram allows 4096 characters per message; leave room for the header. */
export const MAX_ANSWER = 3500

const WORDS = {
  en: {
    done: 'Done',
    stopped: 'Stopped',
    failed: 'Ended with an error',
    refused: 'Refused',
    waiting: 'Waiting for you',
    noAnswer: '(no text answer)',
    cut: '… (cut — /last for the whole answer)',
    queued: '📨 Queued — Claude takes it when the current task is done.',
    sent: '📨 Sent to the session.',
    pairHello: (code: string) =>
      `👋 To link this chat, type in Claude Code:\n<code>/pager pair ${code}</code>\n\nThe code works for 10 minutes.`,
    paired: '✅ Paired. Text me the next prompt, or /help.',
    idle: '💤 Idle — waiting for a prompt.',
    working: (s: string, task: string) => `⏳ Working for ${s} on:\n<i>${task}</i>`,
    nothingToStop: 'Nothing is running.',
    stoppedTurn: '⏹ Stopped the running task.',
    noLast: 'No answer yet in this session.',
    promptsOff: 'Prompts from Telegram are turned off in this session (/config → pager).',
    help:
      '<b>Pager</b> — this chat is linked to a Claude Code session.\n\n' +
      'Any text — queued as the next prompt\n' +
      '/status — what Claude is doing\n' +
      '/last — the last answer in full\n' +
      '/stop — stop the running task\n' +
      '/help — this message',
    unknown: (c: string) => `Unknown command /${c} — /help`,
    sec: 's',
    min: 'min',
    h: 'h',
  },
  ru: {
    done: 'Готово',
    stopped: 'Остановлено',
    failed: 'Завершилось с ошибкой',
    refused: 'Отказ',
    waiting: 'Ждёт вас',
    noAnswer: '(без текстового ответа)',
    cut: '… (обрезано — /last покажет целиком)',
    queued: '📨 В очереди — Claude возьмётся, когда закончит текущую задачу.',
    sent: '📨 Отправлено в сессию.',
    pairHello: (code: string) =>
      `👋 Чтобы привязать этот чат, введите в Claude Code:\n<code>/pager pair ${code}</code>\n\nКод действует 10 минут.`,
    paired: '✅ Привязано. Пишите следующий запрос или /help.',
    idle: '💤 Свободен — ждёт запроса.',
    working: (s: string, task: string) => `⏳ Работает ${s} над:\n<i>${task}</i>`,
    nothingToStop: 'Сейчас ничего не выполняется.',
    stoppedTurn: '⏹ Текущая задача остановлена.',
    noLast: 'В этой сессии ещё не было ответа.',
    promptsOff: 'Запросы из Telegram в этой сессии выключены (/config → pager).',
    help:
      '<b>Pager</b> — этот чат привязан к сессии Claude Code.\n\n' +
      'Любой текст — следующий запрос в очередь\n' +
      '/status — чем занят Claude\n' +
      '/last — последний ответ целиком\n' +
      '/stop — остановить текущую задачу\n' +
      '/help — это сообщение',
    unknown: (c: string) => `Неизвестная команда /${c} — /help`,
    sec: 'с',
    min: 'мин',
    h: 'ч',
  },
} as const

export const words = (lang: Lang) => WORDS[lang] ?? WORDS.en

/** Telegram's HTML mode needs only these three escaped. */
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 42 s · 3 min 05 s · 1 h 12 min */
export function formatDuration(ms: number, lang: Lang): string {
  const w = words(lang)
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} ${w.sec}`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} ${w.min} ${String(total % 60).padStart(2, '0')} ${w.sec}`
  return `${Math.floor(minutes / 60)} ${w.h} ${minutes % 60} ${w.min}`
}

/** Cuts at a line or word boundary near `max`, so a message never ends mid-word. */
export function shorten(text: string, max: number): { text: string; isCut: boolean } {
  if (text.length <= max) return { text, isCut: false }
  const head = text.slice(0, max)
  const at = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '))
  return { text: (at > max * 0.6 ? head.slice(0, at) : head).trimEnd(), isCut: true }
}

export type TurnEnd = 'answer' | 'aborted' | 'refusal' | 'error'

/** The "task is done" message: folder, outcome, duration, then the answer itself. */
export function doneMessage(p: { project: string; reason: TurnEnd; durationMs: number; answer: string; lang: Lang }): string {
  const w = words(p.lang)
  const icon = { answer: '✅', aborted: '⏹', refusal: '🚫', error: '⚠️' }[p.reason]
  const title = { answer: w.done, aborted: w.stopped, refusal: w.refused, error: w.failed }[p.reason]
  const body = p.answer.trim() === '' ? w.noAnswer : p.answer.trim()
  const { text, isCut } = shorten(body, MAX_ANSWER)
  return (
    `${icon} <b>${title}</b> · 📁 ${escapeHtml(p.project)} · ${formatDuration(p.durationMs, p.lang)}\n\n` +
    escapeHtml(text) +
    (isCut ? `\n\n<i>${escapeHtml(w.cut)}</i>` : '')
  )
}

/** "Claude waits for you": permission prompts and the like, as the engine words them. */
export function waitingMessage(p: { project: string; message: string; lang: Lang }): string {
  return `⏸ <b>${words(p.lang).waiting}</b> · 📁 ${escapeHtml(p.project)}\n\n${escapeHtml(p.message)}`
}

/** The answer to /status. */
export function statusMessage(p: { runningSinceMs?: number; nowMs: number; task?: string; lang: Lang }): string {
  const w = words(p.lang)
  if (p.runningSinceMs === undefined) return w.idle
  const task = shorten(p.task ?? '', 300).text
  return w.working(formatDuration(p.nowMs - p.runningSinceMs, p.lang), escapeHtml(task))
}

/** The parts of a Telegram update Pager reads (getUpdates → result[i]). */
export type TgUpdate = {
  update_id: number
  message?: {
    text?: string
    chat: { id: number; type?: string }
    from?: { id: number; first_name?: string; username?: string }
  }
}

export type Incoming =
  | { kind: 'ignore' }
  | { kind: 'pair-request'; chatId: number; name: string }
  | { kind: 'command'; chatId: number; name: string; args: string }
  | { kind: 'prompt'; chatId: number; text: string }

/**
 * What an update asks for. Only private chats count. Before pairing, every message is a
 * pair request (the bot answers with a code); after it, everything from another chat is
 * dropped silently — that chat is the only one allowed to type into the session.
 */
export function classify(update: TgUpdate, pairedChatId: number | undefined): Incoming {
  const m = update.message
  if (!m || typeof m.text !== 'string' || m.chat.type !== undefined && m.chat.type !== 'private') return { kind: 'ignore' }
  const chatId = m.chat.id
  if (pairedChatId === undefined) {
    return { kind: 'pair-request', chatId, name: m.from?.username ?? m.from?.first_name ?? String(chatId) }
  }
  if (chatId !== pairedChatId) return { kind: 'ignore' }
  const text = m.text.trim()
  if (text === '') return { kind: 'ignore' }
  const command = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text)
  if (command) return { kind: 'command', chatId, name: (command[1] ?? '').toLowerCase(), args: (command[2] ?? '').trim() }
  return { kind: 'prompt', chatId, text }
}

/** A 6-digit pairing code from any random number in [0, 1). */
export const pairingCode = (random: number) => String(Math.floor(random * 1_000_000)).padStart(6, '0')

export const PAIRING_TTL_MS = 10 * 60_000

/**
 * Only one session may long-poll a bot (Telegram answers 409 to a second one), so the
 * sessions share a lease in the store: whoever holds a fresh one polls, the others only
 * send. A lease not renewed for LEASE_MS is free to take.
 */
export type Lease = { sessionId: string; until: number }
export const LEASE_MS = 60_000

export function mayPoll(lease: Lease | undefined, sessionId: string, now: number): boolean {
  return lease === undefined || lease.sessionId === sessionId || lease.until < now
}

/** "1234567890:AA..." — a quick sanity check before the first request. */
export const looksLikeToken = (t: string) => /^\d{5,}:[\w-]{20,}$/.test(t.trim())

/** The project's folder name for headers: the last segment of the session's cwd. */
export const projectName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd

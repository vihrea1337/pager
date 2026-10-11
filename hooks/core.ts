// Pager: all the logic as pure functions — formatting, parsing Telegram updates,
// the polling lease. register.tsx wires them to the engine; tests call them directly.

export type Lang = 'en' | 'ru'

/** Telegram allows 4096 characters per message; one part of an answer leaves room for the header and tags. */
export const MAX_ANSWER = 3500

const WORDS = {
  en: {
    done: 'Done',
    stopped: 'Stopped',
    failed: 'Ended with an error',
    refused: 'Refused',
    waiting: 'Waiting for you',
    noAnswer: '(no text answer)',
    along: 'Along the way:',
    result: 'Result:',
    queued: '📨 Queued — Claude takes it when the current task is done.',
    sent: '📨 Sent to the session.',
    pairHello: (code: string) =>
      `👋 To link this chat, type in Claude Code:\n<code>/pager pair ${code}</code>\n\nThe code works for 10 minutes.`,
    paired: '✅ Paired. Text me the next prompt, or /help.',
    idle: '💤 Idle — waiting for a prompt.',
    idleBackground: (n: number) => `💤 Idle · ${n} background task${n === 1 ? '' : 's'} running — Claude picks up when ${n === 1 ? 'it ends' : 'they end'}.`,
    backgroundNote: (n: number) => `\n\n<i>+ ${n} background task${n === 1 ? '' : 's'} running</i>`,
    afterTask: 'after a background task',
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
    commands: { status: 'What Claude is doing', last: 'The last answer in full', stop: 'Stop the running task', help: 'How this bot works' },
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
    along: 'По ходу:',
    result: 'Итог:',
    queued: '📨 В очереди — Claude возьмётся, когда закончит текущую задачу.',
    sent: '📨 Отправлено в сессию.',
    pairHello: (code: string) =>
      `👋 Чтобы привязать этот чат, введите в Claude Code:\n<code>/pager pair ${code}</code>\n\nКод действует 10 минут.`,
    paired: '✅ Привязано. Пишите следующий запрос или /help.',
    idle: '💤 Свободен — ждёт запроса.',
    idleBackground: (n: number) => `💤 Ход закончен · фоновых задач: ${n} — Claude продолжит, когда ${n === 1 ? 'она завершится' : 'они завершатся'}.`,
    backgroundNote: (n: number) => `\n\n<i>+ фоновых задач: ${n}</i>`,
    afterTask: 'после фоновой задачи',
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
    commands: { status: 'Чем занят Claude', last: 'Последний ответ целиком', stop: 'Остановить текущую задачу', help: 'Как пользоваться ботом' },
    sec: 'с',
    min: 'мин',
    h: 'ч',
  },
} as const

export const words = (lang: Lang) => WORDS[lang] ?? WORDS.en

/** Telegram's HTML mode needs only these three escaped. */
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Telegram's limit for one message, after entities are parsed. */
export const TG_LIMIT = 4096

/**
 * Claude answers in Markdown; Telegram's HTML mode shows only a handful of tags. Fenced code →
 * <pre>, `code` → <code>, **bold** / # headings → <b>, *italic* / _italic_ → <i>, ~~x~~ → <s>,
 * [text](url) → <a>. Everything else is escaped text, so the result always parses.
 */
export function markdownToHtml(md: string): string {
  const out: string[] = []
  // Split off fenced blocks first: nothing inside them is Markdown.
  const fence = /^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm
  let last = 0
  for (let m = fence.exec(md); m !== null; m = fence.exec(md)) {
    out.push(inlineMarkdown(md.slice(last, m.index)))
    out.push(`<pre>${escapeHtml((m[1] ?? '').replace(/\n$/, ''))}</pre>`)
    last = m.index + m[0].length
  }
  out.push(inlineMarkdown(md.slice(last)))
  return out.join('')
}

function inlineMarkdown(text: string): string {
  // Inline code is cut out before escaping and emphasis, then put back.
  const codes: string[] = []
  const held = text.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
  const lines = escapeHtml(held)
    .split('\n')
    .map((line) => {
      const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)
      if (heading) return `<b>${heading[1]}</b>`
      return line.replace(/^(\s*)[*-]\s+/, '$1• ')
    })
    .join('\n')
  return lines
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, u: string) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)
    .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/__(?=\S)([^_\n]+?)__/g, '<b>$1</b>')
    .replace(/~~(?=\S)([^~\n]+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?![\w*])/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?=\S)([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${escapeHtml(codes[Number(i)] ?? '')}</code>`)
}

/** The same message without tags: the fallback when Telegram refuses the HTML. */
export const htmlToPlain = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

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

/**
 * Splits Markdown into parts of at most `max` characters at line breaks, so every part can go
 * as its own message. A code fence open at a cut is closed there and reopened in the next part.
 */
export function splitMarkdown(md: string, max: number): string[] {
  const parts: string[] = []
  let rest = md.trim()
  let reopen = ''
  while (rest.length > 0) {
    let { text } = shorten(rest, max)
    rest = rest.slice(text.length).replace(/^\s*\n/, '')
    text = reopen + text
    const fences = text.match(/^```.*$/gm) ?? []
    if (fences.length % 2 === 1 && rest.length > 0) {
      text += '\n```'
      reopen = `${fences[fences.length - 1]}\n`
    } else reopen = ''
    parts.push(text)
  }
  return parts.length > 0 ? parts : ['']
}

/**
 * The "task is done" messages: folder, outcome, duration, then — when Claude wrote along the
 * way, between tool calls — those notes, and the final answer. Nothing is cut: a long answer
 * goes as several messages, "(2/3)" on the ones after the first.
 *
 * A turn a background task's notification started says so instead of a duration: its length is
 * that of the short follow-up, not of the task, and read as the task's it misleads.
 */
export function doneMessages(p: {
  project: string
  reason: TurnEnd
  durationMs: number
  answer: string
  lang: Lang
  notes?: readonly string[]
  afterTask?: boolean
  background?: number
}): string[] {
  const w = words(p.lang)
  const icon = { answer: '✅', aborted: '⏹', refusal: '🚫', error: '⚠️' }[p.reason]
  const title = { answer: w.done, aborted: w.stopped, refusal: w.refused, error: w.failed }[p.reason]
  const when = p.afterTask ? w.afterTask : formatDuration(p.durationMs, p.lang)
  const header = `${icon} <b>${title}</b> · 📁 ${escapeHtml(p.project)} · ${when}\n\n`
  const footer = p.background ? w.backgroundNote(p.background) : ''
  const answer = p.answer.trim() === '' ? w.noAnswer : p.answer.trim()
  const notes = (p.notes ?? []).map((n) => n.trim()).filter((n) => n !== '' && n !== p.answer.trim())
  const along = notes.map((n) => `- ${n.replace(/\n+/g, '\n  ')}`).join('\n')
  const body = notes.length === 0 ? answer : `**${w.along}**\n${along}\n\n**${w.result}**\n${answer}`
  const parts = splitMarkdown(body, MAX_ANSWER)
  return parts.map((part, i) => {
    const top = i === 0 ? header : `<i>(${i + 1}/${parts.length})</i>\n\n`
    const end = i === parts.length - 1 ? footer : ''
    const rich = top + markdownToHtml(part) + end
    // Tags count toward nothing, but a part heavy with them can still outgrow the limit.
    return htmlToPlain(rich).length <= TG_LIMIT ? rich : top + escapeHtml(part) + end
  })
}

/** "Claude waits for you": permission prompts and the like, as the engine words them. */
export function waitingMessage(p: { project: string; message: string; lang: Lang }): string {
  return `⏸ <b>${words(p.lang).waiting}</b> · 📁 ${escapeHtml(p.project)}\n\n${escapeHtml(p.message)}`
}

/** The answer to /status: the running turn, or idle — with the background tasks still at work. */
export function statusMessage(p: { runningSinceMs?: number; nowMs: number; task?: string; background?: number; lang: Lang }): string {
  const w = words(p.lang)
  const background = p.background ?? 0
  if (p.runningSinceMs === undefined) return background > 0 ? w.idleBackground(background) : w.idle
  const task = shorten(p.task ?? '', 300).text
  return w.working(formatDuration(p.nowMs - p.runningSinceMs, p.lang), escapeHtml(task)) + (background > 0 ? w.backgroundNote(background) : '')
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

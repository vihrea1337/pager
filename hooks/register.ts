// Pager — the hooks. Logic lives in core.ts; this file talks to the engine and to Telegram.
//
//   turn.complete           → "✅ Done · 📁 project · 3 min" + the answer, to the paired chat
//   classic.Notification    → "⏸ Waiting for you" (permission prompts and the like)
//   a timer (session.start) → long-polls the bot: text → $.prompt.submit, /status /last /stop /help
//   /pager                  → token <token> · pair <code> · status · test · unpair
//
// Network goes through $.http.fetch (the host's network); nothing is read or written on disk
// but the mod's own store (paired chat, poll offset, the token if set with /pager token).

import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import {
  type Lang,
  type Lease,
  type TgUpdate,
  LEASE_MS,
  PAIRING_TTL_MS,
  classify,
  doneMessage,
  escapeHtml,
  looksLikeToken,
  mayPoll,
  pairingCode,
  projectName,
  shorten,
  statusMessage,
  waitingMessage,
  words,
} from './core'

const API = 'https://api.telegram.org'
/** getUpdates long-poll: Telegram holds the request up to this long when nothing comes. */
const POLL_SECONDS = 20

/** The module's own memory; a reload starts it over, the store keeps what must survive. */
type Ctx = {
  options: PluginOptions
  lang: Lang
  sessionId: string
  project: string
  running?: { turnId: string; since: number; task: string }
  lastAnswer: string
  /** Texts submitted from Telegram: their turns are always reported. */
  remoteTexts: Set<string>
  remoteTurn: boolean
  pending?: { code: string; chatId: number; until: number }
  polling: boolean
  warnedToken: boolean
}

// --- store -----------------------------------------------------------------------------------

async function botToken($: EngineInterface, ctx: Ctx): Promise<string> {
  const fromOptions = String(ctx.options.botToken ?? '').trim()
  if (fromOptions !== '') return fromOptions
  return String((await $.store.get('token')) ?? '').trim()
}

async function pairedChat($: EngineInterface): Promise<number | undefined> {
  const id = await $.store.get('chatId')
  return typeof id === 'number' ? id : undefined
}

// --- Telegram --------------------------------------------------------------------------------

async function tg($: EngineInterface, ctx: Ctx, method: string, body: Record<string, unknown>): Promise<any> {
  const token = await botToken($, ctx)
  if (token === '') return undefined
  const res = await $.http.fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data: any
  try {
    data = JSON.parse(res.text)
  } catch {
    data = undefined
  }
  if (!res.ok || !data?.ok) throw new Error(`telegram ${method}: ${res.status} ${data?.description ?? ''}`.trim())
  return data.result
}

async function send($: EngineInterface, ctx: Ctx, chatId: number, html: string): Promise<void> {
  try {
    await tg($, ctx, 'sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true })
  } catch (err) {
    $.ui.toast(`pager: ${String(err).slice(0, 120)}`)
  }
}

async function notifyPaired($: EngineInterface, ctx: Ctx, html: string): Promise<void> {
  const chatId = await pairedChat($)
  if (chatId !== undefined) await send($, ctx, chatId, html)
}

// --- polling (one session at a time holds the lease) -----------------------------------------

async function poll($: EngineInterface, ctx: Ctx): Promise<void> {
  if (ctx.polling) return
  ctx.polling = true
  try {
    if ((await botToken($, ctx)) === '') {
      if (!ctx.warnedToken) {
        ctx.warnedToken = true
        $.ui.toast('pager: no bot token yet — /pager token <token> (or /config)')
      }
      return
    }
    const now = await $.clock.now()
    const lease = (await $.store.get('lease')) as Lease | undefined
    if (!mayPoll(lease, ctx.sessionId, now)) return
    await $.store.set('lease', { sessionId: ctx.sessionId, until: now + LEASE_MS } satisfies Lease)

    const offset = Number((await $.store.get('offset')) ?? 0)
    const updates = ((await tg($, ctx, 'getUpdates', {
      offset,
      timeout: POLL_SECONDS,
      allowed_updates: ['message'],
    })) ?? []) as TgUpdate[]
    for (const u of updates) {
      await $.store.set('offset', u.update_id + 1)
      await handle($, ctx, u)
    }
  } catch {
    // A network hiccup or Telegram's 409 (another poller): try again next period.
  } finally {
    ctx.polling = false
  }
}

async function handle($: EngineInterface, ctx: Ctx, update: TgUpdate): Promise<void> {
  const w = words(ctx.lang)
  const incoming = classify(update, await pairedChat($))
  switch (incoming.kind) {
    case 'ignore':
      return
    case 'pair-request': {
      const code = pairingCode(Math.random())
      ctx.pending = { code, chatId: incoming.chatId, until: (await $.clock.now()) + PAIRING_TTL_MS }
      await send($, ctx, incoming.chatId, w.pairHello(code))
      $.ui.toast(`pager: @${incoming.name} asks to pair — /pager pair <code from Telegram>`, { timeoutMs: 15_000 })
      return
    }
    case 'prompt': {
      if (ctx.options.acceptPrompts === false) return send($, ctx, incoming.chatId, w.promptsOff)
      ctx.remoteTexts.add(incoming.text)
      await send($, ctx, incoming.chatId, ctx.running ? w.queued : w.sent)
      void $.prompt.submit({ text: incoming.text, asUser: true })
      return
    }
    case 'command':
      return botCommand($, ctx, incoming.chatId, incoming.name)
  }
}

async function botCommand($: EngineInterface, ctx: Ctx, chatId: number, name: string): Promise<void> {
  const w = words(ctx.lang)
  switch (name) {
    case 'start':
    case 'help':
      return send($, ctx, chatId, w.help)
    case 'status':
      return send(
        $,
        ctx,
        chatId,
        statusMessage({ runningSinceMs: ctx.running?.since, nowMs: await $.clock.now(), task: ctx.running?.task, lang: ctx.lang }),
      )
    case 'last': {
      if (ctx.lastAnswer.trim() === '') return send($, ctx, chatId, w.noLast)
      // The whole answer, in as many messages as it takes.
      let rest = ctx.lastAnswer.trim()
      while (rest.length > 0) {
        const part = shorten(rest, 3900)
        await send($, ctx, chatId, escapeHtml(part.text))
        rest = rest.slice(part.text.length).trimStart()
      }
      return
    }
    case 'stop': {
      if (!ctx.running) return send($, ctx, chatId, w.nothingToStop)
      try {
        await $.turn.abort({ turnId: ctx.running.turnId })
        return send($, ctx, chatId, w.stoppedTurn)
      } catch {
        return send($, ctx, chatId, w.nothingToStop)
      }
    }
    default:
      return send($, ctx, chatId, w.unknown(name))
  }
}

/** `/pager` in the terminal. */
async function pagerCommand($: EngineInterface, ctx: Ctx, args: string): Promise<string> {
  const w = words(ctx.lang)
  const [sub = 'status', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ').trim()
  switch (sub) {
    case 'token': {
      if (!looksLikeToken(arg)) return 'pager: that does not look like a bot token (1234567890:AA...).'
      await $.store.set('token', arg)
      ctx.warnedToken = false
      try {
        const me = await tg($, ctx, 'getMe', {})
        return `pager: token saved — bot @${me?.username}. Now text the bot anything; it answers with a code for /pager pair <code>.`
      } catch (err) {
        return `pager: token saved, but Telegram refused it: ${String(err)}`
      }
    }
    case 'pair': {
      const now = await $.clock.now()
      if (!ctx.pending || ctx.pending.until < now) return 'pager: no pairing in progress — text the bot first, it answers with a code.'
      if (arg !== ctx.pending.code) return 'pager: wrong code.'
      await $.store.set('chatId', ctx.pending.chatId)
      await send($, ctx, ctx.pending.chatId, w.paired)
      ctx.pending = undefined
      return 'pager: paired — notifications go to that chat, and only it can send prompts.'
    }
    case 'unpair':
      await $.store.set('chatId', undefined)
      return 'pager: unpaired. Text the bot again to pair a chat.'
    case 'test': {
      const chatId = await pairedChat($)
      if (chatId === undefined) return 'pager: no chat paired yet.'
      await send($, ctx, chatId, doneMessage({ project: ctx.project, reason: 'answer', durationMs: 75_000, answer: 'Test from Pager 👋', lang: ctx.lang }))
      return 'pager: test message sent.'
    }
    default: {
      const token = await botToken($, ctx)
      const chatId = await pairedChat($)
      const lease = (await $.store.get('lease')) as Lease | undefined
      const where = ctx.options.acceptPrompts === false ? 'off' : lease?.sessionId === ctx.sessionId ? 'in this session' : 'in another session'
      return [
        `pager: token ${token ? 'set' : 'missing — /pager token <token>'}`,
        `chat ${chatId !== undefined ? 'paired' : 'not paired — text the bot, then /pager pair <code>'}`,
        `listening ${where}`,
        `notify after ${Number(ctx.options.minSeconds ?? 30)} s · language ${ctx.lang}`,
      ].join('\n')
    }
  }
}

async function releaseLease($: EngineInterface, ctx: Ctx): Promise<void> {
  try {
    const lease = (await $.store.get('lease')) as Lease | undefined
    if (lease?.sessionId === ctx.sessionId) await $.store.set('lease', undefined)
  } catch {}
}

async function reportTurn(
  $: EngineInterface,
  ctx: Ctx,
  turn: { reason: 'answer' | 'aborted' | 'refusal' | 'error'; durationMs: number; answer: string },
): Promise<void> {
  const minMs = Math.max(0, Number(ctx.options.minSeconds ?? 30)) * 1000
  if (turn.durationMs < minMs && !ctx.remoteTurn) return
  await notifyPaired($, ctx, doneMessage({ project: ctx.project, ...turn, lang: ctx.lang }))
  if (ctx.options.desktop === true) {
    await $.ui.notify(shorten(turn.answer.trim() || words(ctx.lang).done, 180).text, { title: `Claude · ${ctx.project}` })
  }
}

// --- hooks -----------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    options,
    lang: options.language === 'ru' ? 'ru' : 'en',
    sessionId: '',
    project: '',
    lastAnswer: '',
    remoteTexts: new Set(),
    remoteTurn: false,
    polling: false,
    warnedToken: false,
  }

  on('session.start', async ($, e, next) => {
    ctx.sessionId = await $.session.id()
    ctx.project = projectName(e.cwd)
    await $.command.register({
      name: 'pager',
      description: 'Telegram pager: token <token> · pair <code> · status · test · unpair',
      argumentHint: 'token <token> | pair <code> | status | test | unpair',
    })
    if (e.isInteractive && options.acceptPrompts !== false) {
      // One period = one long-poll at most; ctx.polling keeps them from overlapping.
      $.clock.every(1500, () => void poll($, ctx))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // Hand the lease back so another open session can take the bot at once.
    await releaseLease($, ctx)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    ctx.running = { turnId: e.turnId, since: Date.now(), task: e.text }
    ctx.remoteTurn = ctx.remoteTexts.delete(e.text)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result // a subagent's run, not the session's turn
    ctx.running = undefined
    ctx.lastAnswer = e.answer
    void reportTurn($, ctx, { reason: e.reason, durationMs: e.durationMs, answer: e.answer })
    ctx.remoteTurn = false
    return result
  })

  on('classic.Notification', async ($, e, next) => {
    if (options.notifyPermission !== false && /permission|input|waiting/i.test(`${e.notification_type} ${e.message}`)) {
      void notifyPaired($, ctx, waitingMessage({ project: ctx.project, message: e.message, lang: ctx.lang }))
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // a pager that failed must never swallow the engine's own notification

  on('command.run', { command: 'pager' }, async ($, e) => ({ text: await pagerCommand($, ctx, e.args) }))
}

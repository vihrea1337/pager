import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import {
  classify,
  doneMessage,
  escapeHtml,
  formatDuration,
  looksLikeToken,
  mayPoll,
  pairingCode,
  projectName,
  shorten,
  statusMessage,
  type TgUpdate,
} from '../hooks/core'

const TOKEN = '1234567890:AAH_fake-token-for-tests-only-123'
const msg = (text: string, chatId = 42, type = 'private'): TgUpdate => ({
  update_id: 7,
  message: { text, chat: { id: chatId, type }, from: { id: chatId, username: 'vihrea' } },
})

// --- core ------------------------------------------------------------------------------------

test('durations read naturally in both languages', () => {
  expect(formatDuration(42_000, 'en')).toBe('42 s')
  expect(formatDuration(185_000, 'en')).toBe('3 min 05 s')
  expect(formatDuration(4_320_000, 'ru')).toBe('1 ч 12 мин')
})

test('long answers are cut at a word, never mid-word', () => {
  const { text, isCut } = shorten('alpha beta gamma delta', 13)
  expect(isCut).toBe(true)
  expect(text).toBe('alpha beta')
  expect(shorten('short', 100)).toEqual({ text: 'short', isCut: false })
})

test('the done message escapes HTML and says what happened', () => {
  const m = doneMessage({ project: 'galleria', reason: 'answer', durationMs: 75_000, answer: 'use <Box> & co', lang: 'en' })
  expect(m).toContain('✅ <b>Done</b> · 📁 galleria · 1 min 15 s')
  expect(m).toContain('use &lt;Box&gt; &amp; co')
  expect(doneMessage({ project: 'p', reason: 'aborted', durationMs: 1, answer: '', lang: 'ru' })).toContain('⏹ <b>Остановлено</b>')
  expect(escapeHtml('a<b')).toBe('a&lt;b')
})

test('before pairing every private message asks to pair', () => {
  expect(classify(msg('hi'), undefined)).toEqual({ kind: 'pair-request', chatId: 42, name: 'vihrea' })
})

test('after pairing only the paired chat is heard', () => {
  expect(classify(msg('fix the tests'), 42)).toEqual({ kind: 'prompt', chatId: 42, text: 'fix the tests' })
  expect(classify(msg('fix the tests', 99), 42)).toEqual({ kind: 'ignore' })
  expect(classify(msg('hello', 42, 'group'), 42)).toEqual({ kind: 'ignore' })
})

test('commands are parsed, with or without the bot name', () => {
  expect(classify(msg('/status'), 42)).toEqual({ kind: 'command', chatId: 42, name: 'status', args: '' })
  expect(classify(msg('/Stop@vihrea_claude_bot now'), 42)).toEqual({ kind: 'command', chatId: 42, name: 'stop', args: 'now' })
})

test('only one session polls: the lease', () => {
  expect(mayPoll(undefined, 'A', 0)).toBe(true)
  expect(mayPoll({ sessionId: 'A', until: 100 }, 'A', 50)).toBe(true)
  expect(mayPoll({ sessionId: 'A', until: 100 }, 'B', 50)).toBe(false)
  expect(mayPoll({ sessionId: 'A', until: 100 }, 'B', 101)).toBe(true) // A stopped renewing
})

test('small helpers', () => {
  expect(pairingCode(0.000042)).toBe('000042')
  expect(looksLikeToken(TOKEN)).toBe(true)
  expect(looksLikeToken('not a token')).toBe(false)
  expect(projectName('C:\\Users\\user\\Desktop\\Projects\\galleria')).toBe('galleria')
  expect(statusMessage({ nowMs: 0, lang: 'en' })).toContain('Idle')
  expect(statusMessage({ runningSinceMs: 0, nowMs: 90_000, task: 'build <it>', lang: 'en' })).toContain('1 min 30 s on:\n<i>build &lt;it&gt;</i>')
})

// --- the hooks, against a fake Telegram and a store in memory --------------------------------

type Sent = { method: string; body: any }

function fakeWorld(on: On, updates: TgUpdate[] = []) {
  const store = new Map<string, unknown>([['chatId', 42]])
  const sent: Sent[] = []
  const submitted: string[] = []
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('session.id', () => ({ value: 'S1' }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text }))
  on('http.fetch', ($, e) => {
    const method = e.url.split('/').pop()!
    sent.push({ method, body: JSON.parse(e.init?.body ?? '{}') })
    const result = method === 'getUpdates' ? updates.splice(0) : method === 'getMe' ? { username: 'test_bot' } : { message_id: 1 }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, result }) } }
  })
  return { store, sent, submitted }
}

/** Lets fire-and-forget sends (void promises) finish before the checks. */
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** /pager <args>, typed at the terminal. */
const run = (args: string) =>
  ({ command: 'pager', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as const

const turn = (durationMs: number, answer = 'All tests pass.') =>
  ({ answer, durationMs, isAborted: false, turnId: 't1', reason: 'answer' }) as const

test('a long turn is reported to the paired chat', { options: { botToken: TOKEN, minSeconds: 30 } }, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start({ cwd: 'C:/Projects/galleria', surface: null, isInteractive: false })
  await $.turn.start({ text: 'run the tests', turnId: 't1' })
  await $.turn.complete(turn(95_000))
  await settle()
  const done = world.sent.find(s => s.method === 'sendMessage')
  expect(done?.body.chat_id).toBe(42)
  expect(done?.body.text).toContain('📁 galleria · 1 min 35 s')
  expect(done?.body.text).toContain('All tests pass.')
})

test('a quick turn stays quiet', { options: { botToken: TOKEN, minSeconds: 30 } }, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start({ cwd: 'C:/Projects/galleria', surface: null, isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(turn(4_000))
  await settle()
  expect(world.sent.filter(s => s.method === 'sendMessage')).toEqual([])
})

test('/pager status tells what is set up', { options: { botToken: TOKEN } }, async ($, on) => {
  fakeWorld(on)
  await $.session.start({ cwd: 'C:/Projects/galleria', surface: null, isInteractive: false })
  const { text } = await $.command.run(run('status'))
  expect(text).toContain('token set')
  expect(text).toContain('chat paired')
})

test('/pager token checks the token with Telegram and keeps it', async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start({ cwd: 'C:/Projects/galleria', surface: null, isInteractive: false })
  const { text } = await $.command.run(run(`token ${TOKEN}`))
  expect(text).toContain('@test_bot')
  expect(world.store.get('token')).toBe(TOKEN)
})

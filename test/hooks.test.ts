import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

let server: any, port: number, home: string, db: any
const backdateCard = (id: number, minutes: number) =>
  db.prepare(`UPDATE cards SET updated_at = datetime('now', ?) WHERE id = ?`).run(`-${minutes} minutes`, id)
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'))
  delete process.env.ORCHESTRA_NAME // an inherited agent name would collapse every test session into one agent
  process.env.ORCHESTRA_HOME = home
  db = openDb(':memory:')
  server = buildServer(db)
  await server.listen({ host: '127.0.0.1', port: 0 })
  port = server.server.address().port
  process.env.ORCHESTRA_PORT = String(port)
})
afterAll(async () => { await server.close(); delete process.env.ORCHESTRA_HOME; delete process.env.ORCHESTRA_PORT })

it('session-start registers and prints rules; post-tool-use delivers pings', async () => {
  const hooks = await import('../src/hooks.js')
  vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue(JSON.stringify({ session_id: 'sess1', cwd: '/tmp' }))
  const out: string[] = []
  vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(String(s)) })

  await hooks.runHook('session-start')
  expect(out.join('\n')).toContain('orchestra rules')
  const sess = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'sess1.json'), 'utf8'))
  expect(sess.agent_id).toBeGreaterThan(0)

  // human asks the agent a question
  await fetch(`http://127.0.0.1:${port}/api/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board_id: sess.board_id, to: sess.agent_name, body: 'status?' }),
  })
  out.length = 0
  await hooks.runHook('post-tool-use')
  const payload = JSON.parse(out.join('\n'))
  expect(payload.hookSpecificOutput.additionalContext).toContain('status?')
})

it('stop does not consume messages; user-prompt-submit delivers them', async () => {
  const hooks = await import('../src/hooks.js')
  vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue(JSON.stringify({ session_id: 'sess2', cwd: '/tmp' }))
  const out: string[] = []
  vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(String(s)) })

  await hooks.runHook('session-start')
  const sess = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'sess2.json'), 'utf8'))
  await fetch(`http://127.0.0.1:${port}/api/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board_id: sess.board_id, to: sess.agent_name, body: 'are you blocked?' }),
  })

  out.length = 0
  await hooks.runHook('stop') // turn ends — must NOT swallow the pending question
  expect(out.join('\n')).toBe('')

  out.length = 0
  await hooks.runHook('user-prompt-submit') // next turn starts — question arrives
  const payload = JSON.parse(out.join('\n'))
  expect(payload.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
  expect(payload.hookSpecificOutput.additionalContext).toContain('are you blocked?')
})

it('stop blocks once to demand a status update on in_progress cards', async () => {
  const hooks = await import('../src/hooks.js')
  vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue(JSON.stringify({ session_id: 'sess3', cwd: '/tmp' }))
  const out: string[] = []
  vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(String(s)) })

  await hooks.runHook('session-start')
  const sess = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'sess3.json'), 'utf8'))
  const { card } = await (await fetch(`http://127.0.0.1:${port}/api/v1/cards`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board_id: sess.board_id, title: 'Fix parser', column: 'in_progress', agent: sess.agent_name }),
  })).json()

  // freshly created card — the agent just touched the board, don't burn a turn
  out.length = 0
  await hooks.runHook('stop')
  expect(out.join('\n')).toBe('')

  // stale card — now the block fires, with a one-line reason
  backdateCard(card.id, 20)
  out.length = 0
  await hooks.runHook('stop')
  const payload = JSON.parse(out.join('\n'))
  expect(payload.decision).toBe('block')
  expect(payload.reason).toContain('Fix parser')
  expect(payload.reason).not.toContain('\n')

  // agent updates the card, then stops — recently-updated skip kicks in again
  backdateCard(card.id, 20)
  await fetch(`http://127.0.0.1:${port}/api/v1/cards/${card.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'halfway through', agent: sess.agent_name }),
  })
  out.length = 0
  await hooks.runHook('stop')
  expect(out.join('\n')).toBe('')

  // second stop (continuation) must not loop
  backdateCard(card.id, 20)
  vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue(JSON.stringify({ session_id: 'sess3', cwd: '/tmp', stop_hook_active: true }))
  out.length = 0
  await hooks.runHook('stop')
  expect(out.join('\n')).toBe('')
})

it('nudges are one-liners: syntax only on first reminder, stale nudge once per window', async () => {
  const hooks = await import('../src/hooks.js')
  vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue(JSON.stringify({ session_id: 'sess5', cwd: '/tmp' }))
  const out: string[] = []
  vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(String(s)) })

  await hooks.runHook('session-start')
  const sess = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'sess5.json'), 'utf8'))

  // first check, no card — one line, full create syntax allowed exactly here
  out.length = 0
  await hooks.runHook('user-prompt-submit')
  const first = JSON.parse(out.join('\n')).hookSpecificOutput.additionalContext
  expect(first).toContain('orchestra card create')
  expect(first).not.toContain('\n')

  // stale card, later window — one short line, no command syntax repeated
  const { card } = await (await fetch(`http://127.0.0.1:${port}/api/v1/cards`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board_id: sess.board_id, title: 'Long task', column: 'in_progress', agent: sess.agent_name }),
  })).json()
  backdateCard(card.id, 20)
  const past = new Date(Date.now() - 700_000)
  fs.utimesSync(path.join(home, 'sessions', 'sess5.json.stale'), past, past)
  out.length = 0
  await hooks.runHook('user-prompt-submit')
  const staleNudge = JSON.parse(out.join('\n')).hookSpecificOutput.additionalContext
  expect(staleNudge).toContain(`#${card.id}`)
  expect(staleNudge).not.toContain('orchestra card')
  expect(staleNudge).not.toContain('\n')

  // same window again — silence
  out.length = 0
  await hooks.runHook('user-prompt-submit')
  expect(out.join('\n')).toBe('')
})

it('self-heals a lost session file and keeps the same agent identity', async () => {
  const hooks = await import('../src/hooks.js')
  vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue(JSON.stringify({ session_id: 'sess4', cwd: '/tmp' }))
  const out: string[] = []
  vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(String(s)) })

  await hooks.runHook('session-start')
  const sessPath = path.join(home, 'sessions', 'sess4.json')
  const orig = JSON.parse(fs.readFileSync(sessPath, 'utf8'))

  // question addressed to the original identity, then the session file is lost
  await fetch(`http://127.0.0.1:${port}/api/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board_id: orig.board_id, to: orig.agent_name, body: 'still there?' }),
  })
  fs.rmSync(sessPath)
  fs.rmSync(sessPath + '.throttle', { force: true })

  out.length = 0
  await hooks.runHook('post-tool-use')
  const payload = JSON.parse(out.join('\n'))
  expect(payload.hookSpecificOutput.additionalContext).toContain('still there?')
  const healed = JSON.parse(fs.readFileSync(sessPath, 'utf8'))
  expect(healed.agent_name).toBe(orig.agent_name) // same identity, not a new agent
})

it('never throws when daemon is down', async () => {
  const hooks = await import('../src/hooks.js')
  process.env.ORCHESTRA_PORT = '1' // nothing listening
  vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue('{"session_id":"sessX","cwd":"/tmp"}')
  await expect(hooks.runHook('post-tool-use')).resolves.toBeUndefined()
  process.env.ORCHESTRA_PORT = String(port)
})

import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

let server: any, port: number, home: string
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'))
  process.env.ORCHESTRA_HOME = home
  server = buildServer(openDb(':memory:'))
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
  await fetch(`http://127.0.0.1:${port}/api/v1/cards`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board_id: sess.board_id, title: 'Fix parser', column: 'in_progress', agent: sess.agent_name }),
  })

  out.length = 0
  await hooks.runHook('stop')
  const payload = JSON.parse(out.join('\n'))
  expect(payload.decision).toBe('block')
  expect(payload.reason).toContain('Fix parser')

  // second stop (continuation) must not loop
  vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue(JSON.stringify({ session_id: 'sess3', cwd: '/tmp', stop_hook_active: true }))
  out.length = 0
  await hooks.runHook('stop')
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

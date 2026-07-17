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

it('never throws when daemon is down', async () => {
  const hooks = await import('../src/hooks.js')
  process.env.ORCHESTRA_PORT = '1' // nothing listening
  vi.spyOn(hooks._internals, 'readStdin').mockResolvedValue('{"session_id":"sessX","cwd":"/tmp"}')
  await expect(hooks.runHook('post-tool-use')).resolves.toBeUndefined()
  process.env.ORCHESTRA_PORT = String(port)
})

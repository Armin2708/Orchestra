import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('broadcasts reach every agent once; unknown recipients are rejected', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a1 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const a2 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })).json()

  // broadcast from amber-fox
  await s.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, from: 'amber-fox', body: 'rebasing main now' } })

  // both a2 AND a1's other peers receive it — a2 consuming it must not hide it from others
  const p2 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a2.id}/pulse` })).json()
  expect(p2.messages.map((m: any) => m.body)).toContain('rebasing main now')

  const a3 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'onyx-crane' } })).json()
  const p3 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a3.id}/pulse` })).json()
  expect(p3.messages.map((m: any) => m.body)).toContain('rebasing main now')

  // but each agent only receives it once
  const p3b = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a3.id}/pulse` })).json()
  expect(p3b.messages).toHaveLength(0)

  // sender never receives its own broadcast
  const p1 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a1.id}/pulse` })).json()
  expect(p1.messages).toHaveLength(0)

  // typo'd recipient fails loudly instead of silently broadcasting
  const bad = await s.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, to: 'no-such-agent', body: 'hi' } })
  expect(bad.statusCode).toBe(400)
  expect(bad.json().error).toContain('no-such-agent')
})

import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('ask, pulse-deliver, reply round-trip', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a1 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const a2 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })).json()

  const q = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', to: 'jade-lynx', body: 'changing auth middleware?' } })).json()

  const p1 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a2.id}/pulse` })).json()
  expect(p1.messages).toHaveLength(1)
  expect(p1.messages[0].body).toBe('changing auth middleware?')
  const p1b = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a2.id}/pulse` })).json()
  expect(p1b.messages).toHaveLength(0) // delivered once

  await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'jade-lynx', to: 'amber-fox', body: 'yes, hold off', reply_to: q.id } })
  const p2 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a1.id}/pulse` })).json()
  expect(p2.messages[0].reply_to).toBe(q.id)
})

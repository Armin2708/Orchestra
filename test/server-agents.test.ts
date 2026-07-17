import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

async function boot() {
  const server = buildServer(openDb(':memory:'))
  await server.ready()
  return server
}

it('resolves boards idempotently and registers agents', async () => {
  const s = await boot()
  const b1 = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/tmp/proj' } })).json()
  const b2 = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/tmp/proj' } })).json()
  expect(b1.id).toBe(b2.id)
  expect(b1.name).toBe('proj')

  const a = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b1.id, session_id: 's1' } })).json()
  expect(a.name).toMatch(/^[a-z]+-[a-z]+$/)
  expect(a.status).toBe('active')

  const snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b1.id}/snapshot` })).json()
  expect(snap.agents).toHaveLength(1)
  expect(snap.cards).toEqual([])
  const health = (await s.inject({ method: 'GET', url: '/health' })).json()
  expect(health.ok).toBe(true)
})

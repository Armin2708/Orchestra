import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('creates cards, warns on overlap, moves columns', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a1 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const a2 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })).json()

  const r1 = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Auth refactor', paths: ['src/auth/**'], agent: 'amber-fox', column: 'in_progress' } })).json()
  expect(r1.card.column).toBe('in_progress')
  expect(r1.overlaps).toEqual([])

  const r2 = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Login page', paths: ['src/auth/login.ts'], agent: 'jade-lynx' } })).json()
  expect(r2.overlaps.map((c: any) => c.id)).toContain(r1.card.id)

  const mv = (await s.inject({ method: 'POST', url: `/api/v1/cards/${r1.card.id}/move`, payload: { column: 'review', agent: 'amber-fox' } })).json()
  expect(mv.card.column).toBe('review')
  const bad = await s.inject({ method: 'POST', url: `/api/v1/cards/${r1.card.id}/move`, payload: { column: 'nope' } })
  expect(bad.statusCode).toBe(400)
})

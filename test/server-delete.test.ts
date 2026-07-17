import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('deletes messages, cards, agents, and boards', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const card = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: b.id, title: 'X', agent: 'amber-fox' } })).json().card
  const q = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, to: 'amber-fox', body: 'q?' } })).json()
  await s.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, from: 'amber-fox', body: 'a', reply_to: q.id } })

  // deleting a question removes its replies too
  await s.inject({ method: 'DELETE', url: `/api/v1/messages/${q.id}` })
  let snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snap.threads).toHaveLength(0)

  await s.inject({ method: 'DELETE', url: `/api/v1/cards/${card.id}` })
  snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snap.cards).toHaveLength(0)

  await s.inject({ method: 'DELETE', url: `/api/v1/agents/${a.id}` })
  snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snap.agents).toHaveLength(0)

  await s.inject({ method: 'DELETE', url: `/api/v1/boards/${b.id}` })
  const boards = (await s.inject({ method: 'GET', url: '/api/v1/boards' })).json()
  expect(boards).toHaveLength(0)
  expect((await s.inject({ method: 'DELETE', url: '/api/v1/cards/999' })).statusCode).toBe(404)
})

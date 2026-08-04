import { expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const boot = async () => {
  const db = openDb(':memory:')
  const server = buildServer(db)
  await server.ready()
  await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })
  return { db, server }
}

const mkCard = async (server: any, title: string) =>
  (await server.inject({
    method: 'POST', url: '/api/v1/cards',
    payload: { board_id: 1, title },
  })).json().card as { id: number }

const contract = (db: Database.Database, cardId: number) =>
  db.prepare(`INSERT INTO task_contracts (card_id, objective, acceptance_criteria) VALUES (?, 'Do it', '["works"]')`)
    .run(cardId)

it('ranks cards over the API and exposes rank + ready in the snapshot', async () => {
  const { db, server } = await boot()
  const a = await mkCard(server, 'first')
  const b = await mkCard(server, 'second')
  contract(db, a.id)

  expect((await server.inject({
    method: 'POST', url: `/api/v1/cards/${a.id}/rank`, payload: { top: true },
  })).statusCode).toBe(200)
  const ranked = (await server.inject({
    method: 'POST', url: `/api/v1/cards/${b.id}/rank`, payload: { after: a.id },
  })).json().card
  expect(typeof ranked.rank).toBe('number')

  const cards = (await server.inject({ url: '/api/v1/boards/1/snapshot' })).json().cards
  const byId = Object.fromEntries(cards.map((c: any) => [c.id, c]))
  expect(byId[a.id].rank).toBeLessThan(byId[b.id].rank)
  expect(byId[a.id].ready).toBe(true)
  expect(byId[b.id].ready).toBe(false)
})

it('rejects a rank request with no position', async () => {
  const { server } = await boot()
  const a = await mkCard(server, 'lonely')
  expect((await server.inject({
    method: 'POST', url: `/api/v1/cards/${a.id}/rank`, payload: {},
  })).statusCode).toBe(400)
})

it('POST /boards/:id/next claims the top ready card and 404s when drained', async () => {
  const { db, server } = await boot()
  db.prepare(`INSERT INTO agents (board_id, name) VALUES (1, 'picker-otter')`).run()
  const top = await mkCard(server, 'unready-top')
  const pick = await mkCard(server, 'ready-pick')
  contract(db, pick.id)
  await server.inject({ method: 'POST', url: `/api/v1/cards/${top.id}/rank`, payload: { top: true } })
  await server.inject({ method: 'POST', url: `/api/v1/cards/${pick.id}/rank`, payload: { bottom: true } })

  const claimed = (await server.inject({
    method: 'POST', url: '/api/v1/boards/1/next', payload: { agent: 'picker-otter' },
  })).json().card
  expect(claimed.id).toBe(pick.id)
  expect(claimed.column).toBe('in_progress')
  expect(claimed.owner).toBe('picker-otter')
  const moved = db.prepare(`SELECT type FROM card_events WHERE card_id=? ORDER BY id DESC LIMIT 1`)
    .get(pick.id) as { type: string }
  expect(moved.type).toBe('moved')

  expect((await server.inject({
    method: 'POST', url: '/api/v1/boards/1/next', payload: { agent: 'picker-otter' },
  })).statusCode).toBe(404)
})

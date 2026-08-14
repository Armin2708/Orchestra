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

const mkCard = async (server: any, title: string, paths: string[] = []) =>
  (await server.inject({
    method: 'POST', url: '/api/v1/cards', payload: { board_id: 1, title, paths },
  })).json().card

const groom = (db: Database.Database, cardId: number, criteria = ['works']) =>
  db.prepare(`INSERT INTO task_contracts (card_id, objective, acceptance_criteria) VALUES (?, 'Do it', ?)`)
    .run(cardId, JSON.stringify(criteria))

// the hire route needs the daemon's conductor; the board row is all these tests need
const hireless = (db: Database.Database, name: string) =>
  db.prepare(`INSERT INTO agents (board_id, name, status) VALUES (1, ?, 'idle')`).run(name)

const funnel = (server: any, cardId: number, body: Record<string, unknown>) =>
  server.inject({ method: 'PATCH', url: `/api/v1/cards/${cardId}/funnel`, payload: body })

const card = async (server: any, id: number) =>
  (await server.inject({ url: '/api/v1/boards/1/snapshot' })).json().cards.find((c: any) => c.id === id)

it('descends one level at a time and refuses to skip or loop', async () => {
  const { server } = await boot()
  const feature = await mkCard(server, 'Search that finds things')
  const spec = await mkCard(server, 'Search index design')
  const task = await mkCard(server, 'Build the tokenizer')

  expect((await funnel(server, feature.id, { kind: 'feature' })).statusCode).toBe(200)
  expect((await funnel(server, spec.id, { kind: 'tech_spec', parent_card_id: feature.id })).statusCode).toBe(200)
  expect((await funnel(server, task.id, { kind: 'task', parent_card_id: spec.id })).statusCode).toBe(200)

  // a task cannot hang straight off a feature — the tech spec level is not optional
  const skipped = await mkCard(server, 'Sneaky task')
  const res = await funnel(server, skipped.id, { kind: 'task', parent_card_id: feature.id })
  expect(res.statusCode).toBe(400)
  expect(res.json().error).toContain('Tech spec')

  // and the tree can never close on itself
  expect((await funnel(server, feature.id, { kind: 'feature', parent_card_id: spec.id })).statusCode).toBe(400)
  expect((await funnel(server, feature.id, { kind: 'tech_spec', parent_card_id: task.id })).statusCode).toBe(400)

  const placed = await card(server, task.id)
  expect(placed.kind).toBe('task')
  expect(placed.parent_card_id).toBe(spec.id)
  expect(placed.funnel_role).toBe('engineer')
})

it('gates the handoff: nothing starts under a spec that is not ready', async () => {
  const { db, server } = await boot()
  const feature = await mkCard(server, 'Search that finds things')
  const spec = await mkCard(server, 'Search index design', ['src/search.ts'])
  const task = await mkCard(server, 'Build the tokenizer', ['src/search.ts'])
  await funnel(server, feature.id, { kind: 'feature' })
  await funnel(server, spec.id, { kind: 'tech_spec', parent_card_id: feature.id })
  await funnel(server, task.id, { kind: 'task', parent_card_id: spec.id })
  hireless(db, 'dev')

  const blocked = await server.inject({
    method: 'POST', url: `/api/v1/cards/${task.id}/assign`, payload: { agent: 'dev' },
  })
  expect(blocked.statusCode).toBe(409)
  expect(blocked.json().error).toContain('not ready')

  // the tech spec becomes Ready once it has an objective, a criterion and its surface
  groom(db, spec.id)
  expect((await card(server, spec.id)).funnel_ready).toBe(true)

  const allowed = await server.inject({
    method: 'POST', url: `/api/v1/cards/${task.id}/assign`, payload: { agent: 'dev' },
  })
  expect(allowed.statusCode).toBe(200)
  expect(allowed.json().card.column).toBe('in_progress')
})

it('leaves cards that predate the funnel ungated', async () => {
  const { db, server } = await boot()
  const plain = await mkCard(server, 'Ordinary ticket')
  hireless(db, 'dev')
  const res = await server.inject({
    method: 'POST', url: `/api/v1/cards/${plain.id}/assign`, payload: { agent: 'dev' },
  })
  expect(res.statusCode).toBe(200)
  expect((await card(server, plain.id)).kind).toBe('task')
})

it('breaks a card down into the level below it, inheriting epic and surface', async () => {
  const { server } = await boot()
  const epic = (await server.inject({
    method: 'POST', url: '/api/v1/milestones', payload: { board_id: 1, title: 'Search' },
  })).json()
  const feature = await mkCard(server, 'Search that finds things')
  await server.inject({
    method: 'PATCH', url: `/api/v1/cards/${feature.id}/milestone`, payload: { milestone_id: epic.id },
  })
  await funnel(server, feature.id, { kind: 'feature' })

  const spec = (await server.inject({
    method: 'POST', url: `/api/v1/cards/${feature.id}/breakdown`,
    payload: { title: 'Index design', paths: ['src/search.ts'] },
  })).json().card
  expect(spec.kind).toBe('tech_spec')
  expect(spec.parent_card_id).toBe(feature.id)
  expect(spec.milestone_id).toBe(epic.id)
  expect(spec.funnel_role).toBe('architect')

  const task = (await server.inject({
    method: 'POST', url: `/api/v1/cards/${spec.id}/breakdown`, payload: { title: 'Tokenizer' },
  })).json().card
  expect(task.kind).toBe('task')
  expect(task.paths).toEqual(['src/search.ts']) // a task inherits its spec's surface
  expect(task.milestone_id).toBe(epic.id)

  // the bottom of the funnel has nothing below it
  const bottom = await server.inject({
    method: 'POST', url: `/api/v1/cards/${task.id}/breakdown`, payload: { title: 'Sub-task' },
  })
  expect(bottom.statusCode).toBe(400)
  expect(bottom.json().error).toContain('lowest level')
})

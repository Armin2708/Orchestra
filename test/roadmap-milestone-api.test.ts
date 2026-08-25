import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const boot = async () => {
  const db = openDb(':memory:')
  const server = buildServer(db)
  await server.ready()
  await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' , create: true } })
  return { db, server }
}

const mkCard = async (server: any, title: string) =>
  (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: 1, title } })).json().card

const mkMilestone = async (server: any, title: string) =>
  (await server.inject({ method: 'POST', url: '/api/v1/milestones', payload: { board_id: 1, title } })).json()

const steps = async (server: any, milestoneId: number) =>
  (await server.inject({ url: '/api/v1/boards/1/snapshot' })).json().cards
    .filter((c: any) => c.milestone_id === milestoneId)
    .sort((a: any, b: any) => a.step_order - b.step_order)
    .map((c: any) => `${c.title}:${c.step_order}`)

it('puts a card on a milestone, inserts behind a step, and detaches cleanly', async () => {
  const { server } = await boot()
  const m = await mkMilestone(server, 'Launch')
  const first = await mkCard(server, 'first')
  const second = await mkCard(server, 'second')
  const wedged = await mkCard(server, 'wedged')

  for (const card of [first, second]) {
    const res = await server.inject({
      method: 'PATCH', url: `/api/v1/cards/${card.id}/milestone`, payload: { milestone_id: m.id },
    })
    expect(res.statusCode).toBe(200)
  }
  expect(await steps(server, m.id)).toEqual(['first:1', 'second:2'])

  // insert behind the first step — everything after it renumbers, no duplicate orders
  const inserted = (await server.inject({
    method: 'PATCH', url: `/api/v1/cards/${wedged.id}/milestone`,
    payload: { milestone_id: m.id, after_step_id: first.id },
  })).json().card
  expect(inserted.step_order).toBe(2)
  expect(await steps(server, m.id)).toEqual(['first:1', 'wedged:2', 'second:3'])

  // detaching clears the position too, so a re-attach can't resurrect it
  const detached = (await server.inject({
    method: 'PATCH', url: `/api/v1/cards/${wedged.id}/milestone`, payload: { milestone_id: null },
  })).json().card
  expect(detached.milestone_id).toBeNull()
  expect(detached.step_order).toBeNull()
  expect(await steps(server, m.id)).toEqual(['first:1', 'second:3'])
})

it('rejects unknown milestones and steps that belong elsewhere', async () => {
  const { server } = await boot()
  const m = await mkMilestone(server, 'Launch')
  const card = await mkCard(server, 'orphan')
  const stray = await mkCard(server, 'stray')

  expect((await server.inject({
    method: 'PATCH', url: `/api/v1/cards/${card.id}/milestone`, payload: { milestone_id: 9999 },
  })).statusCode).toBe(404)
  expect((await server.inject({
    method: 'PATCH', url: '/api/v1/cards/9999/milestone', payload: { milestone_id: m.id },
  })).statusCode).toBe(404)
  expect((await server.inject({
    method: 'PATCH', url: `/api/v1/cards/${card.id}/milestone`,
    payload: { milestone_id: m.id, after_step_id: stray.id },
  })).statusCode).toBe(400)
})

it('orders the roadmap by fractional milestone rank, unranked last', async () => {
  const { server } = await boot()
  const a = await mkMilestone(server, 'A')
  const b = await mkMilestone(server, 'B')
  const c = await mkMilestone(server, 'C')

  const order = async () => (await server.inject({ url: '/api/v1/boards/1/snapshot' })).json()
    .milestones.map((m: any) => m.title)

  expect(await order()).toEqual(['A', 'B', 'C']) // no ranks yet: creation order

  expect((await server.inject({
    method: 'PATCH', url: `/api/v1/milestones/${c.id}`, payload: { top: true },
  })).statusCode).toBe(200)
  const ranked = (await server.inject({
    method: 'PATCH', url: `/api/v1/milestones/${b.id}`, payload: { after: c.id },
  })).json()
  expect(typeof ranked.rank).toBe('number')
  // the first reorder seeds ranks for the whole board, so nothing is left unranked
  expect(await order()).toEqual(['C', 'B', 'A'])
  expect((await server.inject({
    method: 'PATCH', url: `/api/v1/milestones/${c.id}`, payload: { after: a.id },
  })).statusCode).toBe(200)
  expect(await order()).toEqual(['B', 'A', 'C'])

  // ordering rides along with ordinary edits
  const renamed = (await server.inject({
    method: 'PATCH', url: `/api/v1/milestones/${b.id}`, payload: { title: 'B2', top: true },
  })).json()
  expect(renamed.title).toBe('B2')
  expect(await order()).toEqual(['B2', 'A', 'C'])
})

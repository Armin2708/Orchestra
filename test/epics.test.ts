import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const boot = async () => {
  const db = openDb(':memory:')
  const server = buildServer(db)
  await server.ready()
  await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })
  const epic = (await server.inject({
    method: 'POST', url: '/api/v1/milestones', payload: { board_id: 1, title: 'Big effort' },
  })).json()
  return { db, server, epic }
}

it('new milestones are open epics; PATCH updates outcome', async () => {
  const { server, epic } = await boot()
  expect(epic.status).toBe('open')
  const updated = (await server.inject({
    method: 'PATCH', url: `/api/v1/milestones/${epic.id}`, payload: { outcome: 'shipped the thing' },
  })).json()
  expect(updated.outcome).toBe('shipped the thing')
  expect(updated.status).toBe('open')
})

it('shipping an epic requires every step card to be done', async () => {
  const { db, server, epic } = await boot()
  const step = (await server.inject({
    method: 'POST', url: `/api/v1/milestones/${epic.id}/steps`, payload: { title: 'step one' },
  })).json().card

  const premature = await server.inject({
    method: 'PATCH', url: `/api/v1/milestones/${epic.id}`, payload: { status: 'shipped' },
  })
  expect(premature.statusCode).toBe(409)

  db.prepare(`UPDATE cards SET column_name='done' WHERE id=?`).run(step.id)
  const shipped = await server.inject({
    method: 'PATCH', url: `/api/v1/milestones/${epic.id}`, payload: { status: 'shipped', outcome: 'all landed' },
  })
  expect(shipped.statusCode).toBe(200)
  expect(shipped.json()).toMatchObject({ status: 'shipped', outcome: 'all landed' })
})

it('dropping an epic detaches its unfinished cards but keeps done history', async () => {
  const { db, server, epic } = await boot()
  const open = (await server.inject({
    method: 'POST', url: `/api/v1/milestones/${epic.id}/steps`, payload: { title: 'unfinished' },
  })).json().card
  const done = (await server.inject({
    method: 'POST', url: `/api/v1/milestones/${epic.id}/steps`, payload: { title: 'finished' },
  })).json().card
  db.prepare(`UPDATE cards SET column_name='done' WHERE id=?`).run(done.id)

  const dropped = await server.inject({
    method: 'PATCH', url: `/api/v1/milestones/${epic.id}`, payload: { status: 'dropped' },
  })
  expect(dropped.statusCode).toBe(200)
  const cardRow = (id: number) =>
    db.prepare(`SELECT milestone_id FROM cards WHERE id=?`).get(id) as { milestone_id: number | null }
  expect(cardRow(open.id).milestone_id).toBeNull()
  expect(cardRow(done.id).milestone_id).toBe(epic.id)
})

it('rejects invalid epic statuses and reopening from shipped', async () => {
  const { server, epic } = await boot()
  expect((await server.inject({
    method: 'PATCH', url: `/api/v1/milestones/${epic.id}`, payload: { status: 'bogus' },
  })).statusCode).toBe(400)
  await server.inject({
    method: 'PATCH', url: `/api/v1/milestones/${epic.id}`, payload: { status: 'shipped' },
  })
  expect((await server.inject({
    method: 'PATCH', url: `/api/v1/milestones/${epic.id}`, payload: { status: 'open' },
  })).statusCode).toBe(200) // reopening is allowed — shipping was premature
})

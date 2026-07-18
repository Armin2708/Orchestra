import { expect, it, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer, ConductorLike, Bus } from '../src/server.js'

function stubConductor(db: any): ConductorLike & { delivered: any[] } {
  const delivered: any[] = []
  return {
    delivered,
    isHired: (id) => id === 99 || Boolean((db.prepare(`SELECT 1 FROM agents WHERE id=? AND kind='hired'`).get(id))),
    hire: ({ boardId, name }) => {
      db.prepare(`INSERT INTO agents (board_id, name, kind) VALUES (?, ?, 'hired')`).run(boardId, name ?? 'stub-otter')
      return db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(boardId, name ?? 'stub-otter')
    },
    deliver: (id, msg) => { delivered.push({ id, msg }); return true },
    task: () => true,
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => true,
    fire: async () => true,
    launch: () => ({ queued: false }),
    isLaunched: () => false,
  }
}

it('hire registers a hired agent and messages to it deliver instantly', async () => {
  const db = openDb(':memory:')
  let stub!: ReturnType<typeof stubConductor>
  const s = buildServer(db, (_bus: Bus) => { stub = stubConductor(db); return stub })
  await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()

  const hired = (await s.inject({ method: 'POST', url: `/api/v1/boards/${b.id}/hire`, payload: { name: 'stub-otter' } })).json()
  expect(hired.kind).toBe('hired')

  const msg = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, to: 'stub-otter', body: 'start on the parser' } })).json()
  expect(stub.delivered).toHaveLength(1)
  expect(stub.delivered[0].msg.body).toBe('start on the parser')
  expect(msg.delivered_at).not.toBeNull() // marked delivered at send time

  expect((await s.inject({ method: 'POST', url: `/api/v1/agents/${hired.id}/fire` })).json()).toEqual({ ok: true })
})

it('hire returns 501 when no conductor is wired (test/inject contexts)', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })
  expect((await s.inject({ method: 'POST', url: '/api/v1/boards/1/hire', payload: {} })).statusCode).toBe(501)
})

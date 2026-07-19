import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { buildServer, ConductorLike, Bus } from '../src/server.js'
import { registerPush, PushPayload } from '../src/push.js'

function stubConductor(db: any) {
  const wakes: number[] = []
  const stub: ConductorLike & { wakes: number[] } = {
    wakes,
    isHired: () => false,
    hire: () => ({}),
    deliver: () => true,
    task: () => true,
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => true,
    fire: async () => true,
    launch: () => ({ queued: false }),
    isLaunched: () => false,
    wake: (boardId: number) => {
      wakes.push(boardId)
      db.prepare(`UPDATE agents SET status='active' WHERE board_id=? AND status='paused_limit'`).run(boardId)
      return { woke: ['sleepy-otter'], queued: ['queued-otter'], skipped: [] }
    },
  }
  return stub
}

beforeEach(() => { process.env.ORCHESTRA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wake-')) })
afterEach(() => { delete process.env.ORCHESTRA_HOME; delete process.env.ORCHESTRA_AUTOWAKE; vi.restoreAllMocks() })

it('POST /boards/:id/wake wakes limit-paused agents and reports woke/queued', async () => {
  const db = openDb(':memory:')
  let stub!: ReturnType<typeof stubConductor>
  const s = buildServer(db, (_bus: Bus) => { stub = stubConductor(db); return stub })
  await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  db.prepare(`INSERT INTO agents (board_id, name, kind, status) VALUES (?, 'sleepy-otter', 'hired', 'paused_limit')`).run(b.id)

  const res = await s.inject({ method: 'POST', url: `/api/v1/boards/${b.id}/wake` })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ woke: ['sleepy-otter'], queued: ['queued-otter'], skipped: [] })
  expect(stub.wakes).toEqual([b.id])

  expect((await s.inject({ method: 'POST', url: '/api/v1/boards/999/wake' })).statusCode).toBe(404)
})

it('wake returns 501 without a conductor (non-daemon contexts)', async () => {
  const s = buildServer(openDb(':memory:'))
  await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  expect((await s.inject({ method: 'POST', url: `/api/v1/boards/${b.id}/wake` })).statusCode).toBe(501)
})

it('/system exposes the paused count, the scheduled auto-wake time, and the opt-out flag', async () => {
  const db = openDb(':memory:')
  const at = '2026-07-19T21:40:00.000Z'
  const s = buildServer(db, undefined, { autowakeAt: () => at })
  await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  db.prepare(`INSERT INTO agents (board_id, name, kind, status) VALUES (?, 'sleepy-otter', 'hired', 'paused_limit')`).run(b.id)
  db.prepare(`INSERT INTO agents (board_id, name, kind, status) VALUES (?, 'busy-otter', 'hired', 'active')`).run(b.id)

  const sys = (await s.inject({ method: 'GET', url: '/api/v1/system' })).json()
  expect(sys.paused_limit).toBe(1)
  expect(sys.autowake_at).toBe(at)
  expect(sys.autowake_enabled).toBe(true)
})

it('ORCHESTRA_AUTOWAKE=0 reports auto-wake off while the manual endpoint still works', async () => {
  process.env.ORCHESTRA_AUTOWAKE = '0'
  const db = openDb(':memory:')
  let stub!: ReturnType<typeof stubConductor>
  const s = buildServer(db, (_bus: Bus) => { stub = stubConductor(db); return stub }, { autowakeAt: () => null })
  await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  db.prepare(`INSERT INTO agents (board_id, name, kind, status) VALUES (?, 'sleepy-otter', 'hired', 'paused_limit')`).run(b.id)

  const sys = (await s.inject({ method: 'GET', url: '/api/v1/system' })).json()
  expect(sys.autowake_enabled).toBe(false)
  expect(sys.autowake_at).toBeNull()
  expect((await s.inject({ method: 'POST', url: `/api/v1/boards/${b.id}/wake` })).statusCode).toBe(200)
  expect(stub.wakes).toEqual([b.id])
})

it('an auto-wake pushes a window-reset notification to subscribed devices', async () => {
  const db = openDb(':memory:')
  const s = buildServer(db)
  const sent: PushPayload[] = []
  registerPush(s, {
    sendWebPush: async (_sub, payload) => { sent.push(JSON.parse(payload)) },
    sendNtfy: async () => {},
  })
  await s.ready()
  await s.inject({ method: 'POST', url: '/api/v1/push/subscribe', payload: { endpoint: 'https://push.example/d1', keys: { p256dh: 'pk', auth: 'ak' } } })

  s.bus.emit('event', { board_id: 1, type: 'autowake', data: { woke: 3, queued: 2 } })
  await new Promise((r) => setImmediate(r))

  expect(sent).toHaveLength(1)
  expect(sent[0].title).toBe('Claude usage window reset')
  expect(sent[0].body).toBe('3 agents resumed, 2 queued')
})

it('an auto-wake that resumed nobody stays silent', async () => {
  const db = openDb(':memory:')
  const s = buildServer(db)
  const sent: PushPayload[] = []
  registerPush(s, { sendWebPush: async (_s, p) => { sent.push(JSON.parse(p)) }, sendNtfy: async () => {} })
  await s.ready()
  await s.inject({ method: 'POST', url: '/api/v1/push/subscribe', payload: { endpoint: 'https://push.example/d1', keys: { p256dh: 'pk', auth: 'ak' } } })

  s.bus.emit('event', { board_id: 1, type: 'autowake', data: { woke: 0, queued: 0 } })
  await new Promise((r) => setImmediate(r))
  expect(sent).toHaveLength(0)
})

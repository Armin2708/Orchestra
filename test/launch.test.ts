import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { openDb } from '../src/db.js'
import { buildServer, ConductorLike } from '../src/server.js'

// the SDK spawns a real claude subprocess — tests drive a hand-cranked session instead
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Conductor } from '../src/conductor.js'

// a controllable fake of the SDK's streaming query
function fakeSession() {
  const msgs: any[] = []
  let notify: (() => void) | null = null
  let closed = false
  const wake = () => { notify?.(); notify = null }
  return {
    emit(m: any) { msgs.push(m); wake() },
    close() { closed = true; wake() },
    query: {
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (msgs.length) yield msgs.shift()
          if (closed) return
          await new Promise<void>((r) => { notify = r })
        }
      },
    },
  }
}

function setup() {
  const db = openDb(':memory:')
  const bus = new EventEmitter()
  const events: any[] = []
  bus.on('event', (e) => events.push(e))
  const sessions: ReturnType<typeof fakeSession>[] = []
  ;(query as any).mockImplementation(() => {
    const s = fakeSession()
    sessions.push(s)
    return s.query
  })
  const conductor = new Conductor(db, bus)
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  const mkCard = (title: string) => {
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO cards (board_id, title, description) VALUES (1, ?, 'trivial ticket')`).run(title)
    return Number(lastInsertRowid)
  }
  const card = (id: number) => db.prepare(`SELECT * FROM cards WHERE id=?`).get(id) as any
  const cardEvents = (id: number) =>
    db.prepare(`SELECT * FROM card_events WHERE card_id=? ORDER BY id`).all(id) as any[]
  return { db, bus, events, sessions, conductor, mkCard, card, cardEvents }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('condition never became true')
}

beforeEach(() => { delete process.env.ORCHESTRA_MAX_LAUNCHED })
afterEach(() => { delete process.env.ORCHESTRA_MAX_LAUNCHED })

it('launch works a trivial ticket: assigns the card, then parks it in review on success', async () => {
  const t = setup()
  const id = t.mkCard('trivial')
  const res = t.conductor.launch({ boardId: 1, cardId: id, cwd: '/p', brief: 'do the ticket' })
  expect(res.agent.kind).toBe('hired')
  // card auto-moved to in_progress, owned by the launched agent
  expect(t.card(id).column_name).toBe('in_progress')
  expect(t.card(id).owner_agent_id).toBe(res.agent.id)
  expect(t.events.some((e) => e.type === 'launch' && e.data.status === 'started')).toBe(true)

  const s = t.sessions[0]
  s.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'did the work' }] } })
  s.emit({ type: 'result', subtype: 'success', result: 'shipped it' })
  s.close()

  await until(() => t.card(id).column_name === 'review')
  expect(t.card(id).owner_agent_id).toBeNull() // survives removeAgentCards
  const exit = t.cardEvents(id).find((e) => e.type === 'agent_exit')
  expect(JSON.parse(exit.payload)).toMatchObject({ outcome: 'success', to: 'review' })
  const fin = t.events.find((e) => e.type === 'launch' && e.data.status === 'finished')
  expect(fin.data).toMatchObject({ outcome: 'success', to_column: 'review', summary: 'shipped it' })
})

it('launch parks the card in blocked with a reason when the agent errors', async () => {
  const t = setup()
  const id = t.mkCard('doomed')
  t.conductor.launch({ boardId: 1, cardId: id, cwd: '/p', brief: 'try' })
  const s = t.sessions[0]
  s.emit({ type: 'result', subtype: 'error_during_execution' })
  s.close()

  await until(() => t.card(id).column_name === 'blocked')
  const exit = t.cardEvents(id).find((e) => e.type === 'agent_exit')
  expect(JSON.parse(exit.payload).outcome).toBe('error')
  expect(JSON.parse(exit.payload).reason).toContain('error_during_execution')
})

it('stopping a launched agent blocks the card as stopped by user', async () => {
  const t = setup()
  const id = t.mkCard('halted')
  const res = t.conductor.launch({ boardId: 1, cardId: id, cwd: '/p', brief: 'go' })
  await t.conductor.fire(res.agent.id)
  t.sessions[0].close()

  await until(() => t.card(id).column_name === 'blocked')
  const exit = t.cardEvents(id).find((e) => e.type === 'agent_exit')
  expect(JSON.parse(exit.payload).reason).toBe('stopped by user')
})

it('caps concurrent launches and drains the queue on exit', async () => {
  process.env.ORCHESTRA_MAX_LAUNCHED = '1'
  const t = setup()
  const a = t.mkCard('first'), b = t.mkCard('second')
  const r1 = t.conductor.launch({ boardId: 1, cardId: a, cwd: '/p', brief: 'one' })
  expect(r1.agent).toBeDefined()
  const r2 = t.conductor.launch({ boardId: 1, cardId: b, cwd: '/p', brief: 'two' })
  expect(r2).toEqual({ queued: true, position: 1 })
  expect(t.conductor.isLaunched(b)).toBe(true)
  expect(t.card(b).column_name).toBe('backlog') // untouched while queued

  // re-launching a queued card must not double-book it
  expect(t.conductor.launch({ boardId: 1, cardId: b, cwd: '/p', brief: 'two' }))
    .toEqual({ queued: true, position: 1 })

  const s1 = t.sessions[0]
  s1.emit({ type: 'result', subtype: 'success', result: 'done' })
  s1.close()

  await until(() => t.card(a).column_name === 'review' && t.card(b).column_name === 'in_progress')
  expect(t.sessions).toHaveLength(2) // second agent spawned only after the first exited

  const s2 = t.sessions[1]
  s2.emit({ type: 'result', subtype: 'success', result: 'done too' })
  s2.close()
  await until(() => t.card(b).column_name === 'review')
})

it('adoptLaunch re-binds a resumed agent to its ticket so exit parks instead of deleting', async () => {
  const t = setup()
  const id = t.mkCard('survivor')
  const res = t.conductor.launch({ boardId: 1, cardId: id, cwd: '/p', brief: 'go' })
  t.sessions[0].close() // daemon dies mid-run: session ends with no result message

  await until(() => !t.conductor.isHired(res.agent.id))
  // simulate the restart resurrect loop: re-hire by name, then re-adopt from the db
  // (the crash-exit already parked the card; put it back the way a restart finds it)
  t.db.prepare(`UPDATE cards SET owner_agent_id=?, column_name='in_progress' WHERE id=?`).run(res.agent.id, id)
  const again = t.conductor.hire({ boardId: 1, cwd: '/p', name: res.agent.name })
  t.conductor.adoptLaunch(again.id)

  t.sessions[1].emit({ type: 'result', subtype: 'success', result: 'resumed and finished' })
  t.sessions[1].close()
  await until(() => t.card(id)?.column_name === 'review')
  expect(t.card(id).owner_agent_id).toBeNull()
})

it('POST /cards/:id/launch wires the route to the conductor with a review-parking brief', async () => {
  const calls: any[] = []
  const stub: ConductorLike = {
    isHired: () => false,
    hire: () => ({}),
    deliver: () => true,
    task: () => true,
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => true,
    fire: async () => true,
    launch: (req) => { calls.push(req); return { agent: { id: 1 } } },
    isLaunched: (cardId) => cardId === 777,
  }
  const db = openDb(':memory:')
  const s = buildServer(db, () => stub)
  await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/proj' } })).json()
  const { card } = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Trivial ticket', description: 'OBJECTIVE: do a small thing.' } })).json()

  const res = await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/launch` })
  expect(res.statusCode).toBe(200)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ boardId: b.id, cardId: card.id, cwd: '/proj' })
  expect(calls[0].brief).toContain(`card #${card.id}`)
  expect(calls[0].brief).toContain('OBJECTIVE: do a small thing.')
  expect(calls[0].brief).toContain('review') // the no-self-done instruction

  expect((await s.inject({ method: 'POST', url: '/api/v1/cards/9999/launch' })).statusCode).toBe(404)

  await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/move`, payload: { column: 'done' } })
  expect((await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/launch` })).statusCode).toBe(400)
})

it('POST /cards/:id/launch rejects double launches and works without a conductor', async () => {
  const stub: ConductorLike = {
    isHired: () => false, hire: () => ({}), deliver: () => true, task: () => true,
    transcript: () => ({ lines: [], working: null }), subagents: () => [],
    interruptAgent: async () => true,
    fire: async () => true, launch: () => ({ agent: {} }), isLaunched: () => true,
  }
  const db = openDb(':memory:')
  const s = buildServer(db, () => stub)
  await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const { card } = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: b.id, title: 'x' } })).json()
  expect((await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/launch` })).statusCode).toBe(409)

  const bare = buildServer(openDb(':memory:'))
  await bare.ready()
  await bare.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })
  const { card: c2 } = (await bare.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: 1, title: 'y' } })).json()
  expect((await bare.inject({ method: 'POST', url: `/api/v1/cards/${c2.id}/launch` })).statusCode).toBe(501)
})

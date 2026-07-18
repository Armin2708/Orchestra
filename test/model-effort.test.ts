import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { openDb } from '../src/db.js'
import { buildServer, ConductorLike } from '../src/server.js'

// the SDK spawns a real claude subprocess — tests drive a hand-cranked session instead
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Conductor, EFFORT_LEVELS } from '../src/conductor.js'

const MODELS = [
  { model: 'claude-fable-5', displayName: 'Fable 5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { model: 'claude-haiku-4-5', displayName: 'Haiku 4.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
]

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
      setPermissionMode: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      supportedModels: vi.fn(async () => MODELS),
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
  const queryArgs: any[] = []
  ;(query as any).mockImplementation((args: any) => {
    queryArgs.push(args)
    const s = fakeSession()
    sessions.push(s)
    return s.query
  })
  const conductor = new Conductor(db, bus)
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  return { db, events, sessions, queryArgs, conductor }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('condition never became true')
}

// setEffort tears the old session down before rehiring — the fake needs a hand to close it
const settingEffort = async (t: ReturnType<typeof setup>, id: number, level: string) => {
  const old = t.sessions[t.sessions.length - 1]
  const p = t.conductor.setEffort(id, level)
  await new Promise((r) => setTimeout(r, 15))
  old.close()
  return p
}

// ── hire: effort option ─────────────────────────────────────────────

it('hire passes a validated effort level into the SDK query options', () => {
  const t = setup()
  const a = t.conductor.hire({ boardId: 1, cwd: '/p', effort: 'high' })
  expect(t.queryArgs[0].options.effort).toBe('high')
  expect(t.conductor.transcript(a.id).info?.effort).toBe('high')
  const b = t.conductor.hire({ boardId: 1, cwd: '/p', effort: 'ultra' })
  expect(t.queryArgs[1].options.effort).toBeUndefined()
  expect(t.conductor.transcript(b.id).info?.effort).toBeNull()
})

it('supported models surface in transcript info after init', async () => {
  const t = setup()
  const a = t.conductor.hire({ boardId: 1, cwd: '/p' })
  t.sessions[0].emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5' })
  await until(() => (t.conductor.transcript(a.id).info?.models ?? []).length > 0)
  expect(t.conductor.transcript(a.id).info?.models).toEqual(MODELS)
})

// ── setModel ────────────────────────────────────────────────────────

it('setModel switches the live session, persists, and logs to the transcript', async () => {
  const t = setup()
  const a = t.conductor.hire({ boardId: 1, cwd: '/p' })
  t.sessions[0].emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5' })
  await until(() => t.conductor.transcript(a.id).info?.model === 'claude-fable-5')

  expect(await t.conductor.setModel(a.id, 'claude-haiku-4-5')).toBe(true)
  expect(t.sessions[0].query.setModel).toHaveBeenCalledWith('claude-haiku-4-5')
  expect(t.conductor.transcript(a.id).info?.model).toBe('claude-haiku-4-5')
  expect((t.db.prepare(`SELECT model FROM agents WHERE id=?`).get(a.id) as any).model).toBe('claude-haiku-4-5')
  expect(t.conductor.transcript(a.id).lines.some((l) => l.kind === 'status' && l.text.includes('model → claude-haiku-4-5'))).toBe(true)

  expect(await t.conductor.setModel(9999, 'claude-fable-5')).toBe(false)
})

// ── setEffort: restart-with-resume ──────────────────────────────────

it('setEffort mid-turn returns busy without restarting', async () => {
  const t = setup()
  const a = t.conductor.hire({ boardId: 1, cwd: '/p' })
  t.sessions[0].emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5' })
  t.sessions[0].emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'working…' }] } })
  await until(() => t.conductor.transcript(a.id).working !== null)
  expect(await t.conductor.setEffort(a.id, 'high')).toBe('busy')
  expect(t.sessions).toHaveLength(1)
})

it('setEffort with no resumable session yet refuses instead of dropping history', async () => {
  const t = setup()
  const a = t.conductor.hire({ boardId: 1, cwd: '/p' })
  expect(await t.conductor.setEffort(a.id, 'high')).toBe('no-session')
  expect(await t.conductor.setEffort(9999, 'high')).toBe('not-found')
  expect(await t.conductor.setEffort(a.id, 'ultra')).toBe('bad-level')
})

it('setEffort restarts with resume, carrying permission mode, model, and transcript history', async () => {
  const t = setup()
  const a = t.conductor.hire({ boardId: 1, cwd: '/p', permissionMode: 'acceptEdits' })
  t.sessions[0].emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5' })
  await until(() => t.conductor.transcript(a.id).info?.model === 'claude-fable-5')
  t.conductor.task(a.id, 'hello there')
  t.sessions[0].emit({ type: 'result', subtype: 'success', result: 'hi' }) // turn ends → agent idle
  await until(() => t.conductor.transcript(a.id).working === null)

  expect(await settingEffort(t, a.id, 'xhigh')).toBe('ok')
  expect(t.conductor.isHired(a.id)).toBe(true)
  expect(t.queryArgs).toHaveLength(2)
  expect(t.queryArgs[1].options.resume).toBe('s1')
  expect(t.queryArgs[1].options.effort).toBe('xhigh')
  expect(t.queryArgs[1].options.permissionMode).toBe('acceptEdits') // mode carry-through
  expect(t.queryArgs[1].options.model).toBe('claude-fable-5')

  const lines = t.conductor.transcript(a.id).lines
  expect(lines.some((l) => l.kind === 'user' && l.text === 'hello there')).toBe(true) // history carried
  expect(lines.some((l) => l.kind === 'status' && l.text.includes('effort → xhigh'))).toBe(true)
  expect(t.conductor.transcript(a.id).info?.effort).toBe('xhigh')
  expect((t.db.prepare(`SELECT effort FROM agents WHERE id=?`).get(a.id) as any).effort).toBe('xhigh')
  expect(t.conductor.transcript(a.id).info?.permissionMode).toBe('acceptEdits')
})

it('a launched agent keeps its ticket and launch state across an effort change', async () => {
  const t = setup()
  // the reachable idle-launched state: a daemon restart resumed the agent and adoptLaunch
  // re-bound its ticket (mid-turn agents are gated by the 409 instead)
  const a = t.conductor.hire({ boardId: 1, cwd: '/p' })
  t.sessions[0].emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5' })
  await until(() => (t.db.prepare(`SELECT sdk_session FROM agents WHERE id=?`).get(a.id) as any).sdk_session === 's1')
  const { lastInsertRowid } = t.db.prepare(
    `INSERT INTO cards (board_id, title, owner_agent_id, column_name) VALUES (1, 'the ticket', ?, 'in_progress')`).run(a.id)
  const cardId = Number(lastInsertRowid)
  t.db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, 'launched', '{}')`).run(cardId, a.id)
  t.conductor.adoptLaunch(a.id)

  expect(await settingEffort(t, a.id, 'low')).toBe('ok')
  const card = () => t.db.prepare(`SELECT * FROM cards WHERE id=?`).get(cardId) as any
  // the old session's exit path must not park or delete the ticket
  expect(card().column_name).toBe('in_progress')
  expect(card().owner_agent_id).toBe(a.id)
  expect(t.conductor.isLaunched(cardId)).toBe(true)
  expect(t.db.prepare(`SELECT COUNT(*) n FROM card_events WHERE card_id=? AND type='agent_exit'`).get(cardId)).toMatchObject({ n: 0 })

  // the resumed session finishes the ticket — it parks in review exactly once
  t.sessions[1].emit({ type: 'result', subtype: 'success', result: 'done' })
  t.sessions[1].close()
  await until(() => card().column_name === 'review')
  expect(card().owner_agent_id).toBeNull()
  expect(t.db.prepare(`SELECT COUNT(*) n FROM cards WHERE title='the ticket'`).get()).toMatchObject({ n: 1 })
  expect(t.db.prepare(`SELECT COUNT(*) n FROM card_events WHERE card_id=? AND type='agent_exit'`).get(cardId)).toMatchObject({ n: 1 })
})

// ── routes ──────────────────────────────────────────────────────────

const stubWith = (over: Partial<ConductorLike>): ConductorLike => ({
  isHired: () => true, hire: () => ({}), deliver: () => true, task: () => true,
  transcript: () => ({ lines: [], working: null }), subagents: () => [],
  interruptAgent: async () => true, fire: async () => true,
  launch: () => ({ agent: {} }), isLaunched: () => false, ...over,
})

it('POST /agents/:id/model and /effort map conductor outcomes to status codes', async () => {
  const modelCalls: any[] = []
  const effortCalls: any[] = []
  let effortResult: any = 'ok'
  const stub = stubWith({
    setModel: async (id: number, model: string) => { modelCalls.push([id, model]); return model !== 'nope' },
    setEffort: async (id: number, level: string) => { effortCalls.push([id, level]); return effortResult },
  })
  const s = buildServer(openDb(':memory:'), () => stub)
  await s.ready()

  expect((await s.inject({ method: 'POST', url: '/api/v1/agents/7/model', payload: { model: 'claude-fable-5' } })).statusCode).toBe(200)
  expect(modelCalls).toEqual([[7, 'claude-fable-5']])
  expect((await s.inject({ method: 'POST', url: '/api/v1/agents/7/model', payload: {} })).statusCode).toBe(400)
  expect((await s.inject({ method: 'POST', url: '/api/v1/agents/7/model', payload: { model: 'nope' } })).statusCode).toBe(404)

  expect((await s.inject({ method: 'POST', url: '/api/v1/agents/7/effort', payload: { level: 'xhigh' } })).statusCode).toBe(200)
  expect(effortCalls).toEqual([[7, 'xhigh']])
  expect((await s.inject({ method: 'POST', url: '/api/v1/agents/7/effort', payload: { level: 'ultra' } })).statusCode).toBe(400)
  effortResult = 'busy'
  expect((await s.inject({ method: 'POST', url: '/api/v1/agents/7/effort', payload: { level: 'low' } })).statusCode).toBe(409)
  effortResult = 'no-session'
  expect((await s.inject({ method: 'POST', url: '/api/v1/agents/7/effort', payload: { level: 'low' } })).statusCode).toBe(409)
  effortResult = 'not-found'
  expect((await s.inject({ method: 'POST', url: '/api/v1/agents/7/effort', payload: { level: 'low' } })).statusCode).toBe(404)

  const bare = buildServer(openDb(':memory:'))
  await bare.ready()
  expect((await bare.inject({ method: 'POST', url: '/api/v1/agents/7/model', payload: { model: 'x' } })).statusCode).toBe(501)
  expect((await bare.inject({ method: 'POST', url: '/api/v1/agents/7/effort', payload: { level: 'low' } })).statusCode).toBe(501)
})

it('exports the effort ladder for reuse', () => {
  expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
})

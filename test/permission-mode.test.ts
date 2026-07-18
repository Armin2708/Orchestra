import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { openDb } from '../src/db.js'
import { buildServer, ConductorLike, Bus } from '../src/server.js'

// the SDK spawns a real claude subprocess — tests drive a hand-cranked session instead
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Conductor, PERMISSION_MODES } from '../src/conductor.js'

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

// ── conductor: mode wiring ──────────────────────────────────────────

it('hire defaults to bypassPermissions and exposes the live mode in transcript info', () => {
  const { queryArgs, conductor } = setup()
  const a = conductor.hire({ boardId: 1, cwd: '/p' })
  expect(queryArgs[0].options.permissionMode).toBe('bypassPermissions')
  expect(typeof queryArgs[0].options.canUseTool).toBe('function')
  expect(conductor.transcript(a.id).info?.permissionMode).toBe('bypassPermissions')
  expect(conductor.transcript(a.id).permissions).toEqual([])
})

it('hire resumes with a persisted mode; unknown modes fall back to bypass', () => {
  const { queryArgs, conductor } = setup()
  const a = conductor.hire({ boardId: 1, cwd: '/p', permissionMode: 'acceptEdits' })
  expect(queryArgs[0].options.permissionMode).toBe('acceptEdits')
  expect(conductor.transcript(a.id).info?.permissionMode).toBe('acceptEdits')
  const b = conductor.hire({ boardId: 1, cwd: '/p', permissionMode: 'dontAsk' })
  expect(queryArgs[1].options.permissionMode).toBe('bypassPermissions')
  expect(conductor.transcript(b.id).info?.permissionMode).toBe('bypassPermissions')
})

it('setPermissionMode switches the live session, persists, and logs to the transcript', async () => {
  const { db, sessions, conductor, events } = setup()
  const a = conductor.hire({ boardId: 1, cwd: '/p' })
  expect(await conductor.setPermissionMode(a.id, 'acceptEdits')).toBe(true)
  expect(sessions[0].query.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
  expect(conductor.transcript(a.id).info?.permissionMode).toBe('acceptEdits')
  const row = db.prepare(`SELECT permission_mode FROM agents WHERE id=?`).get(a.id) as any
  expect(row.permission_mode).toBe('acceptEdits')
  expect(conductor.transcript(a.id).lines.some((l) => l.text === 'permission mode → acceptEdits')).toBe(true)
  expect(events.some((e) => e.type === 'permission_mode' && e.data.mode === 'acceptEdits')).toBe(true)
})

it('setPermissionMode rejects unknown agents and unknown modes', async () => {
  const { conductor } = setup()
  const a = conductor.hire({ boardId: 1, cwd: '/p' })
  expect(await conductor.setPermissionMode(999, 'plan')).toBe(false)
  expect(await conductor.setPermissionMode(a.id, 'yolo')).toBe(false)
  expect(conductor.transcript(a.id).info?.permissionMode).toBe('bypassPermissions')
})

it('setPermissionMode survives a dead session handle (returns false, mode unchanged)', async () => {
  const { sessions, conductor } = setup()
  const a = conductor.hire({ boardId: 1, cwd: '/p' })
  ;(sessions[0].query.setPermissionMode as any).mockRejectedValueOnce(new Error('session closed'))
  expect(await conductor.setPermissionMode(a.id, 'plan')).toBe(false)
  expect(conductor.transcript(a.id).info?.permissionMode).toBe('bypassPermissions')
})

// ── conductor: canUseTool pending-ask flow ──────────────────────────

it('canUseTool parks a pending ask; allow resolves it with the original input', async () => {
  const { queryArgs, conductor, events } = setup()
  const a = conductor.hire({ boardId: 1, cwd: '/p', permissionMode: 'acceptEdits' })
  const ask = queryArgs[0].options.canUseTool('Bash', { command: 'git push' },
    { toolUseID: 't1', requestId: 'r1', title: 'Claude wants to run git push', signal: new AbortController().signal })
  const pending = conductor.transcript(a.id).permissions!
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({ id: 't1', tool: 'Bash', title: 'Claude wants to run git push' })
  expect(events.some((e) => e.type === 'permission' && e.data.status === 'pending')).toBe(true)

  expect(conductor.resolvePermission(a.id, 't1', 'allow')).toBe(true)
  await expect(ask).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'git push' } })
  expect(conductor.transcript(a.id).permissions).toEqual([])
  expect(events.some((e) => e.type === 'permission' && e.data.status === 'allowed')).toBe(true)
})

it('deny resolves the ask with a deny message', async () => {
  const { queryArgs, conductor } = setup()
  const a = conductor.hire({ boardId: 1, cwd: '/p', permissionMode: 'plan' })
  const ask = queryArgs[0].options.canUseTool('Write', { file_path: '/p/x.ts' }, { toolUseID: 't2' })
  expect(conductor.resolvePermission(a.id, 't2', 'deny', 'not while planning')).toBe(true)
  await expect(ask).resolves.toEqual({ behavior: 'deny', message: 'not while planning' })
  expect(conductor.resolvePermission(a.id, 't2', 'allow')).toBe(false) // already resolved
})

it('resolvePermission returns false for unknown agents or requests', () => {
  const { conductor } = setup()
  const a = conductor.hire({ boardId: 1, cwd: '/p' })
  expect(conductor.resolvePermission(a.id, 'nope', 'allow')).toBe(false)
  expect(conductor.resolvePermission(12345, 'nope', 'deny')).toBe(false)
})

it('an aborted ask withdraws itself and fails closed', async () => {
  const { queryArgs, conductor, events } = setup()
  const a = conductor.hire({ boardId: 1, cwd: '/p', permissionMode: 'acceptEdits' })
  const ac = new AbortController()
  const ask = queryArgs[0].options.canUseTool('Bash', { command: 'rm -rf /' }, { toolUseID: 't3', signal: ac.signal })
  expect(conductor.transcript(a.id).permissions).toHaveLength(1)
  ac.abort()
  await expect(ask).resolves.toMatchObject({ behavior: 'deny' })
  expect(conductor.transcript(a.id).permissions).toEqual([])
  expect(events.some((e) => e.type === 'permission' && e.data.status === 'withdrawn')).toBe(true)
})

// ── server endpoints ────────────────────────────────────────────────

function stubConductor(db: any) {
  const calls: any[] = []
  const stub: ConductorLike & { calls: any[] } = {
    calls,
    isHired: (id) => Boolean(db.prepare(`SELECT 1 FROM agents WHERE id=? AND kind='hired'`).get(id)),
    hire: ({ boardId, name }) => {
      db.prepare(`INSERT INTO agents (board_id, name, kind) VALUES (?, ?, 'hired')`).run(boardId, name ?? 'stub-otter')
      return db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(boardId, name ?? 'stub-otter')
    },
    deliver: () => true,
    task: () => true,
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => true,
    fire: async () => true,
    launch: () => ({ queued: false }),
    isLaunched: () => false,
    setPermissionMode: async (id, mode) => { calls.push(['setPermissionMode', id, mode]); return id !== 404 },
    resolvePermission: (id, requestId, behavior, message) => { calls.push(['resolvePermission', id, requestId, behavior, message]); return requestId !== 'gone' },
  }
  return stub
}

async function serverSetup() {
  const db = openDb(':memory:')
  let stub!: ReturnType<typeof stubConductor>
  const s = buildServer(db, (_bus: Bus) => { stub = stubConductor(db); return stub })
  await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const agent = (await s.inject({ method: 'POST', url: `/api/v1/boards/${b.id}/hire`, payload: { name: 'stub-otter' } })).json()
  return { s, db, stub, agent }
}

it('POST /agents/:id/permission-mode validates and forwards to the conductor', async () => {
  const { s, stub, agent } = await serverSetup()
  const ok = await s.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/permission-mode`, payload: { mode: 'acceptEdits' } })
  expect(ok.json()).toEqual({ ok: true, mode: 'acceptEdits' })
  expect(stub.calls).toContainEqual(['setPermissionMode', agent.id, 'acceptEdits'])

  expect((await s.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/permission-mode`, payload: { mode: 'dontAsk' } })).statusCode).toBe(400)
  expect((await s.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/permission-mode`, payload: {} })).statusCode).toBe(400)
  expect((await s.inject({ method: 'POST', url: `/api/v1/agents/404/permission-mode`, payload: { mode: 'plan' } })).statusCode).toBe(404)
})

it('POST /agents/:id/permissions/:requestId resolves pending asks', async () => {
  const { s, stub, agent } = await serverSetup()
  const ok = await s.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/permissions/t1`, payload: { behavior: 'deny', message: 'no' } })
  expect(ok.json()).toEqual({ ok: true })
  expect(stub.calls).toContainEqual(['resolvePermission', agent.id, 't1', 'deny', 'no'])

  expect((await s.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/permissions/t1`, payload: { behavior: 'maybe' } })).statusCode).toBe(400)
  expect((await s.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/permissions/gone`, payload: { behavior: 'allow' } })).statusCode).toBe(404)
})

it('permission endpoints 501 without a conductor', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  expect((await s.inject({ method: 'POST', url: '/api/v1/agents/1/permission-mode', payload: { mode: 'plan' } })).statusCode).toBe(501)
  expect((await s.inject({ method: 'POST', url: '/api/v1/agents/1/permissions/t1', payload: { behavior: 'allow' } })).statusCode).toBe(501)
})

// ── persistence plumbing for daemon-restart resume ──────────────────

it('agents.permission_mode column exists and the exported mode list is stable', () => {
  const db = openDb(':memory:')
  const cols = db.prepare(`PRAGMA table_info(agents)`).all().map((c: any) => c.name)
  expect(cols).toContain('permission_mode')
  expect([...PERMISSION_MODES]).toEqual(['bypassPermissions', 'acceptEdits', 'plan'])
})

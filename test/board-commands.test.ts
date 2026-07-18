import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer, ConductorLike, Bus } from '../src/server.js'
import { isBoardCommand, runBoardCommand, BOARD_COMMANDS, BoardCmdCtx } from '../web/src/boardCommands.js'

// a fake daemon API that records every call — the zero-token property is simply
// "no POST /agents/:id/task ever happens", assert it everywhere
function fakeApi(routes: Record<string, any> = {}) {
  const calls: { method: string; p: string; body?: unknown }[] = []
  const api = async (method: string, p: string, body?: unknown) => {
    calls.push({ method, p, body })
    const hit = routes[`${method} ${p}`] ?? routes[p]
    if (hit instanceof Error) throw hit
    return hit ?? {}
  }
  return { api, calls, taskCalls: () => calls.filter((c) => c.p.includes('/task')) }
}

const ctx = (api: BoardCmdCtx['api'], cards: BoardCmdCtx['cards'] = []): BoardCmdCtx => ({
  boardId: 1, agent: { id: 7, name: 'jade-lynx' }, cards, api,
})

it('claims exactly the six board verbs; SDK commands fall through', () => {
  for (const c of BOARD_COMMANDS) expect(isBoardCommand(`${c.name} x`)).toBe(true)
  expect(isBoardCommand('/compact')).toBe(false)
  expect(isBoardCommand('/boardgame night')).toBe(false)
  expect(isBoardCommand('plain prompt')).toBe(false)
  expect(BOARD_COMMANDS.every((c) => c.source === 'orchestra')).toBe(true)
})

it('/board renders a compact column view without spending tokens', async () => {
  const { api, calls, taskCalls } = fakeApi({
    'GET /boards/1/snapshot': { cards: [
      { id: 44, title: 'slash commands', column: 'in_progress', owner: 'jade-lynx' },
      { id: 9, title: 'npm publish', column: 'backlog', owner: null },
      { id: 1, title: 'old', column: 'done', owner: null },
    ] },
  })
  const out = await runBoardCommand('/board', ctx(api))
  expect(out).toEqual(['in_progress:', '  #44 slash commands (jade-lynx)', 'backlog:', '  #9 npm publish', 'done: 1 card'])
  expect(calls).toHaveLength(1)
  expect(taskCalls()).toHaveLength(0)
})

it('/card creates and surfaces overlap warnings; /card move patches the column', async () => {
  const { api, calls, taskCalls } = fakeApi({
    'POST /cards': { card: { id: 50, title: 'new thing', column: 'backlog' },
      overlaps: [{ id: 44, title: 'slash commands', owner: 'jade-lynx' }], similar: [] },
    'PATCH /cards/50': { card: { id: 50, column: 'review' } },
  })
  expect(await runBoardCommand('/card new thing', ctx(api))).toEqual(
    ['card #50 created [backlog] new thing', '⚠ overlap with #44 "slash commands" (jade-lynx)'])
  expect(calls[0].body).toMatchObject({ board_id: 1, title: 'new thing' })
  expect(await runBoardCommand('/card move 50 review', ctx(api))).toEqual(['card #50 → review'])
  expect(calls[1]).toMatchObject({ method: 'PATCH', p: '/cards/50', body: { column: 'review' } })
  expect(await runBoardCommand('/card', ctx(api))).toEqual(['usage: /card <title> · /card move <id> <column>'])
  expect(taskCalls()).toHaveLength(0)
})

it('/ask posts a board message to the named agent', async () => {
  const { api, calls, taskCalls } = fakeApi({ 'POST /messages': { id: 99, delivered_at: '2026-07-18' } })
  expect(await runBoardCommand('/ask slate-fox is the bus shape final?', ctx(api)))
    .toEqual(['asked slate-fox (msg #99) · delivered'])
  expect(calls[0].body).toEqual({ board_id: 1, to: 'slate-fox', body: 'is the bus shape final?' })
  expect(await runBoardCommand('/ask', ctx(api))).toEqual(['usage: /ask <agent> <question>'])
  expect(taskCalls()).toHaveLength(0)
})

it("/handoff assigns this agent's open card, preferring in_progress", async () => {
  const { api, calls, taskCalls } = fakeApi()
  const cards = [
    { id: 3, title: 'older', column: 'review', owner: 'jade-lynx' },
    { id: 44, title: 'slash commands', column: 'in_progress', owner: 'jade-lynx' },
    { id: 5, title: 'not mine', column: 'in_progress', owner: 'other' },
  ]
  expect(await runBoardCommand('/handoff teal-ibex', ctx(api, cards)))
    .toEqual(['card #44 "slash commands" handed to teal-ibex'])
  expect(calls[0]).toMatchObject({ p: '/cards/44/assign', body: { agent: 'teal-ibex' } })
  expect(await runBoardCommand('/handoff teal-ibex', ctx(api, [])))
    .toEqual(['✗ jade-lynx owns no open card to hand off'])
  expect(taskCalls()).toHaveLength(0)
})

it('/interrupt hits the interrupt endpoint for this agent', async () => {
  const { api, calls, taskCalls } = fakeApi()
  expect(await runBoardCommand('/interrupt', ctx(api))).toEqual(['interrupt sent'])
  expect(calls[0]).toMatchObject({ method: 'POST', p: '/agents/7/interrupt' })
  expect(taskCalls()).toHaveLength(0)
})

it('/resume re-hires from the stored sdk_session and keeps the persisted permission mode', async () => {
  const { api, calls, taskCalls } = fakeApi({
    'GET /boards/1/snapshot': { agents: [
      { name: 'jade-lynx', sdk_session: 'sess-abc', permission_mode: 'acceptEdits' },
      { name: 'fresh', sdk_session: null },
    ] },
  })
  expect(await runBoardCommand('/resume', ctx(api)))
    .toEqual(['resumed jade-lynx — previous session continues · acceptEdits'])
  expect(calls[1]).toMatchObject({ method: 'POST', p: '/boards/1/hire',
    body: { name: 'jade-lynx', resumeSession: 'sess-abc', permissionMode: 'acceptEdits' } })
  expect(await runBoardCommand('/resume fresh', ctx(api))).toEqual(['✗ fresh has no stored session to resume'])
  expect(await runBoardCommand('/resume ghost', ctx(api))).toEqual(['✗ no agent named ghost on this board'])
  expect(taskCalls()).toHaveLength(0)
})

it('API failures come back as inline ✗ lines, never thrown', async () => {
  const { api } = fakeApi({ 'POST /messages': new Error('unauthorized') })
  expect(await runBoardCommand('/ask x y', ctx(api))).toEqual(['✗ unauthorized'])
})

// ── server: hire route passes resume + permission mode through to the conductor ──

it('POST /boards/:id/hire forwards resumeSession and permissionMode', async () => {
  const db = openDb(':memory:')
  const hires: any[] = []
  const stub: ConductorLike = {
    isHired: () => true,
    hire: (opts) => {
      hires.push(opts)
      db.prepare(`INSERT INTO agents (board_id, name, kind) VALUES (?, ?, 'hired')`).run(opts.boardId, opts.name ?? 'x')
      return db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(opts.boardId, opts.name ?? 'x')
    },
    deliver: () => true, task: () => true, transcript: () => ({ lines: [], working: null }),
    subagents: () => [], interruptAgent: async () => true, fire: async () => true,
    launch: () => ({ queued: false }), isLaunched: () => false,
  }
  const s = buildServer(db, (_bus: Bus) => stub)
  await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const res = await s.inject({ method: 'POST', url: `/api/v1/boards/${b.id}/hire`,
    payload: { name: 'revived-otter', resumeSession: 'sess-xyz', permissionMode: 'plan' } })
  expect(res.statusCode).toBe(200)
  expect(hires[0]).toMatchObject({ name: 'revived-otter', resumeSession: 'sess-xyz', permissionMode: 'plan' })
})

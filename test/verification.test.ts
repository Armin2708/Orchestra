import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { buildServer, ConductorLike, Bus } from '../src/server.js'

function stubConductor(db: any): ConductorLike & { hires: any[]; tasks: { agentId: number; text: string }[] } {
  const hires: any[] = []
  const tasks: { agentId: number; text: string }[] = []
  return {
    hires, tasks,
    isHired: (id) => Boolean(db.prepare(`SELECT 1 FROM agents WHERE id=? AND kind='hired'`).get(id)),
    hire: (opts) => {
      const name = opts.name ?? `verifier-${hires.length + 1}`
      db.prepare(`INSERT INTO agents (board_id, name, kind, role) VALUES (?, ?, 'hired', ?)`).run(opts.boardId, name, opts.role ?? null)
      const agent = db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(opts.boardId, name)
      hires.push({ opts, agent })
      return agent
    },
    deliver: () => true,
    task: (agentId, text) => { tasks.push({ agentId, text }); return true },
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => true,
    fire: async () => true,
    launch: () => ({ queued: false }),
    isLaunched: () => false,
  }
}

async function boot() {
  const db = openDb(':memory:')
  let stub!: ReturnType<typeof stubConductor>
  const server = buildServer(db, (_bus: Bus) => { stub = stubConductor(db); return stub })
  await server.ready()
  const board = (await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/tmp/verif' } })).json()
  const card = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: board.id, title: 'Build the parser', column: 'review',
    description: 'OBJECTIVE: parse. REQUIREMENTS: fast. DONE WHEN: tests pass; handles unicode.',
  } })).json().card
  return { db, server, stub, board, card }
}

afterEach(() => { delete process.env.ORCHESTRA_AUTO_VERIFY })

it('verify hires an ephemeral verifier with the card brief; guards 404/409', async () => {
  const { server, stub, card } = await boot()
  const r = (await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/verify` }))
  expect(r.statusCode).toBe(200)
  expect(stub.hires).toHaveLength(1)
  expect(stub.hires[0].opts).toMatchObject({ role: 'verifier', ephemeral: true, cwd: '/tmp/verif' })
  expect(stub.tasks).toHaveLength(1)
  expect(stub.tasks[0].text).toContain(`card #${card.id}`)
  expect(stub.tasks[0].text).toContain('DONE WHEN')
  expect(stub.tasks[0].text).toContain(`/api/v1/cards/${card.id}/verification`)

  // second trigger while running → 409
  expect((await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/verify` })).statusCode).toBe(409)
  expect((await server.inject({ method: 'POST', url: '/api/v1/cards/9999/verify' })).statusCode).toBe(404)
  await server.close()
})

it('verify rejects cards not in review', async () => {
  const { server, board } = await boot()
  const c = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: board.id, title: 'wip', column: 'in_progress' } })).json().card
  expect((await server.inject({ method: 'POST', url: `/api/v1/cards/${c.id}/verify` })).statusCode).toBe(409)
  await server.close()
})

it('verification records the event, posts a board note, and surfaces in the snapshot badge', async () => {
  const { db, server, board, card } = await boot()
  await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/verify` })
  // snapshot shows running while the verifier works
  let snap = (await server.inject({ method: 'GET', url: `/api/v1/boards/${board.id}/snapshot` })).json()
  expect(snap.cards.find((c: any) => c.id === card.id).verification).toMatchObject({ running: true })

  const post = await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/verification`, payload: {
    verdict: 'gaps', tested: true, by: 'verifier-1',
    criteria: [
      { text: 'tests pass', met: true, evidence: 'vitest 152/152' },
      { text: 'handles unicode', met: 'unverifiable', evidence: 'no unicode fixture found' },
    ],
  } })
  expect(post.statusCode).toBe(200)

  const ev = db.prepare(`SELECT payload FROM card_events WHERE card_id=? AND type='verification'`).get(card.id) as any
  const payload = JSON.parse(ev.payload)
  expect(payload.verdict).toBe('gaps')
  expect(payload.criteria).toHaveLength(2)

  const note = db.prepare(`SELECT body FROM messages WHERE card_id=?`).get(card.id) as any
  expect(note.body).toContain('GAPS')
  expect(note.body).toContain('1/2 criteria met')

  snap = (await server.inject({ method: 'GET', url: `/api/v1/boards/${board.id}/snapshot` })).json()
  const badge = snap.cards.find((c: any) => c.id === card.id).verification
  expect(badge).toMatchObject({ running: false, verdict: 'gaps', tested: true })
  expect(badge.criteria).toHaveLength(2)
  await server.close()
})

it('verification validates verdict and criteria shape', async () => {
  const { server, card } = await boot()
  expect((await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/verification`,
    payload: { verdict: 'maybe' } })).statusCode).toBe(400)
  expect((await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/verification`,
    payload: { verdict: 'pass', criteria: [{ nope: 1 }] } })).statusCode).toBe(400)
  expect((await server.inject({ method: 'POST', url: '/api/v1/cards/9999/verification',
    payload: { verdict: 'pass' } })).statusCode).toBe(404)
  // DONE-WHEN-less degradation: empty criteria list is a valid report, not an error
  expect((await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/verification`,
    payload: { verdict: 'pass', criteria: [] } })).statusCode).toBe(200)
  await server.close()
})

it('approve carries confirmed:true only on explicit confirm (auto-ship contract)', async () => {
  const { db, server, board, card } = await boot()
  await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/verification`,
    payload: { verdict: 'fail', criteria: [] } })
  const events: any[] = []
  ;(server as any).bus.on('event', (e: any) => { if (e.type === 'review') events.push(e.data) })
  await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/approve`, payload: { confirm: true, note: 'ship anyway' } })
  const ev = db.prepare(`SELECT payload FROM card_events WHERE card_id=? AND type='review_decision'`).get(card.id) as any
  expect(JSON.parse(ev.payload)).toMatchObject({ decision: 'approve', confirmed: true })
  expect(events.find((e) => e.status === 'approved')).toMatchObject({ confirmed: true })

  // plain approve on another card carries no confirmed flag
  const c2 = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: board.id, title: 'other', column: 'review' } })).json().card
  await server.inject({ method: 'POST', url: `/api/v1/cards/${c2.id}/approve`, payload: {} })
  const ev2 = db.prepare(`SELECT payload FROM card_events WHERE card_id=? AND type='review_decision'`).get(c2.id) as any
  expect(JSON.parse(ev2.payload).confirmed).toBeUndefined()
  await server.close()
})

it('ORCHESTRA_AUTO_VERIFY=1 spawns a verifier when a card enters review', async () => {
  process.env.ORCHESTRA_AUTO_VERIFY = '1'
  const { server, stub, board } = await boot() // boot's card was created directly in review — but without a move it has no review_request yet
  const c = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: board.id, title: 'auto', column: 'in_progress' } })).json().card
  const before = stub.hires.length
  await server.inject({ method: 'POST', url: `/api/v1/cards/${c.id}/move`, payload: { column: 'review' } })
  expect(stub.hires.length).toBe(before + 1)
  expect(stub.hires.at(-1).opts.role).toBe('verifier')
  await server.close()
})

it('a verifier that died without reporting goes stale: badge clears and re-verify unblocks', async () => {
  const { db, server, stub, board, card } = await boot()
  await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/verify` })
  expect((await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/verify` })).statusCode).toBe(409)

  // the verifier crashed / hit a usage limit — its request ages past the staleness window
  db.prepare(`UPDATE card_events SET created_at = datetime('now', '-20 minutes') WHERE card_id=? AND type='verify_requested'`).run(card.id)
  const snap = (await server.inject({ method: 'GET', url: `/api/v1/boards/${board.id}/snapshot` })).json()
  expect(snap.cards.find((c: any) => c.id === card.id).verification.running).toBe(false)

  expect((await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/verify` })).statusCode).toBe(200)
  expect(stub.hires).toHaveLength(2)
  await server.close()
})

it('shipped hash lands in the verifier brief when recorded', async () => {
  const { db, server, stub, board } = await boot()
  const c = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: board.id, title: 'shipped card', column: 'review' } })).json().card
  db.prepare(`INSERT INTO card_events (card_id, type, payload) VALUES (?, 'shipped', ?)`)
    .run(c.id, JSON.stringify({ hash: 'a'.repeat(40), subject: 'merge: shipped card', by: 'integrator' }))
  await server.inject({ method: 'POST', url: `/api/v1/cards/${c.id}/verify` })
  expect(stub.tasks.at(-1)!.text).toContain(`git show ${'a'.repeat(40)}`)
  await server.close()
})

it('an unmerged delivery branch is explicit and its worktree is the verifier cwd', async () => {
  const { db, server, stub, board } = await boot()
  const c = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: board.id, title: 'branch card', column: 'review' } })).json().card
  db.prepare(`UPDATE cards SET branch=? WHERE id=?`).run(`card-${c.id}`, c.id)
  const worktree = path.join(path.dirname(board.project_path), `${path.basename(board.project_path)}-card-${c.id}`)
  fs.mkdirSync(worktree, { recursive: true })
  try {
    await server.inject({ method: 'POST', url: `/api/v1/cards/${c.id}/verify` })
    expect(stub.hires.at(-1)!.opts.cwd).toBe(worktree)
    expect(stub.tasks.at(-1)!.text).toContain(`DELIVERY BRANCH (ground truth before merge): card-${c.id}`)
    expect(stub.tasks.at(-1)!.text).toContain(`git diff main...card-${c.id}`)
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true })
    await server.close()
  }
})

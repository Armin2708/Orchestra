import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { buildServer, ConductorLike } from '../src/server.js'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Conductor } from '../src/conductor.js'

const run = promisify(execFile)
const git = (cwd: string, ...args: string[]) => run('git', args, { cwd })

async function mkRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orch-wire-repo-'))
  await git(dir, 'init', '-b', 'main')
  await git(dir, 'config', 'user.email', 't@t')
  await git(dir, 'config', 'user.name', 't')
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', scripts: { test: 'node -e ""' } }))
  await writeFile(path.join(dir, 'base.txt'), 'base\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-m', 'init')
  return dir
}

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

const until = async (cond: () => boolean, ms = 20000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition never became true')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(() => { delete process.env.ORCHESTRA_AUTOSHIP })
afterEach(() => { delete process.env.ORCHESTRA_AUTOSHIP })

// ── conductor: launch creates the worktree + branch and persists it ──

function conductorSetup(projectPath: string) {
  const db = openDb(':memory:')
  const bus = new EventEmitter()
  const sessions: ReturnType<typeof fakeSession>[] = []
  const queryArgs: any[] = []
  ;(query as any).mockImplementation((args: any) => {
    queryArgs.push(args)
    const s = fakeSession()
    sessions.push(s)
    return s.query
  })
  const conductor = new Conductor(db, bus)
  db.prepare(`INSERT INTO boards (project_path, name) VALUES (?, 'p')`).run(projectPath)
  const { lastInsertRowid } = db.prepare(`INSERT INTO cards (board_id, title) VALUES (1, 'the ticket')`).run()
  return { db, conductor, sessions, queryArgs, cardId: Number(lastInsertRowid) }
}

it('launch spawns the agent inside a fresh card worktree and persists the branch', async () => {
  const repo = await mkRepo()
  const t = conductorSetup(repo)
  t.conductor.launch({ boardId: 1, cardId: t.cardId, cwd: repo, brief: 'go' })

  const wt = path.join(repo, '..', `${path.basename(repo)}-card-${t.cardId}`)
  expect(existsSync(wt)).toBe(true) // agent works in its own worktree, not the shared checkout
  expect(t.queryArgs[0].options.cwd).toBe(wt)
  const branch = (await git(repo, 'branch', '--list', `card-${t.cardId}`)).stdout.trim()
  expect(branch).not.toBe('')
  const row = t.db.prepare(`SELECT branch FROM cards WHERE id=?`).get(t.cardId) as any
  expect(row.branch).toBe(`card-${t.cardId}`) // survives a daemon restart
}, 30000)

it('ORCHESTRA_AUTOSHIP=0 launches in the shared checkout like today', async () => {
  process.env.ORCHESTRA_AUTOSHIP = '0'
  const repo = await mkRepo()
  const t = conductorSetup(repo)
  t.conductor.launch({ boardId: 1, cardId: t.cardId, cwd: repo, brief: 'go' })
  expect(t.queryArgs[0].options.cwd).toBe(repo)
  expect((t.db.prepare(`SELECT branch FROM cards WHERE id=?`).get(t.cardId) as any).branch).toBeNull()
}, 30000)

// ── server: approve triggers the ship queue behind the gate ──────────

function serverSetup(shipQueue: any) {
  const stub: ConductorLike = {
    isHired: () => false, hire: () => ({}), deliver: () => true, task: () => true,
    transcript: () => ({ lines: [], working: null }), subagents: () => [],
    interruptAgent: async () => true, fire: async () => true,
    launch: () => ({ agent: {} }), isLaunched: () => false,
  }
  const db = openDb(':memory:')
  const s = buildServer(db, () => stub, { makeShipQueue: () => shipQueue })
  return { db, s }
}

async function reviewCard(db: any, s: any, branch: string | null = 'card-1') {
  await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/proj' } })).json()
  const { card } = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: b.id, title: 'ship me' } })).json()
  db.prepare(`UPDATE cards SET column_name='review', branch=? WHERE id=?`).run(branch, card.id)
  return card.id
}

it('approving a branch-bearing card enqueues it for shipping', async () => {
  const enqueued: any[] = []
  const t = serverSetup({ enqueue: (c: any) => { enqueued.push(c); return { queued: true } }, status: () => null })
  const id = await reviewCard(t.db, t.s)
  const res = await t.s.inject({ method: 'POST', url: `/api/v1/cards/${id}/approve`, payload: {} })
  expect(res.statusCode).toBe(200)
  expect(enqueued).toHaveLength(1)
  expect(enqueued[0]).toMatchObject({ cardId: id, branch: 'card-1', title: 'ship me' })
  expect(t.db.prepare(`SELECT column_name FROM cards WHERE id=?`).get(id)).toMatchObject({ column_name: 'done' })
})

it('no branch or AUTOSHIP=0 approves without queueing (today behavior)', async () => {
  const enqueued: any[] = []
  const t = serverSetup({ enqueue: (c: any) => { enqueued.push(c); return { queued: true } }, status: () => null })
  const id = await reviewCard(t.db, t.s, null)
  expect((await t.s.inject({ method: 'POST', url: `/api/v1/cards/${id}/approve`, payload: {} })).statusCode).toBe(200)

  process.env.ORCHESTRA_AUTOSHIP = '0'
  const id2 = await reviewCard(t.db, t.s)
  expect((await t.s.inject({ method: 'POST', url: `/api/v1/cards/${id2}/approve`, payload: {} })).statusCode).toBe(200)
  expect(enqueued).toHaveLength(0)
})

it('a fail verdict holds the card in review unless the approve confirms', async () => {
  const enqueued: any[] = []
  const t = serverSetup({ enqueue: (c: any) => { enqueued.push(c); return { queued: true } }, status: () => null })
  const id = await reviewCard(t.db, t.s)
  t.db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, NULL, 'verification', ?)`)
    .run(id, JSON.stringify({ criteria: [], verdict: 'fail', tested: true }))

  const held = await t.s.inject({ method: 'POST', url: `/api/v1/cards/${id}/approve`, payload: {} })
  expect(held.statusCode).toBe(200)
  expect(held.json().held).toBe(true)
  expect(enqueued).toHaveLength(0)
  // held cards stay re-approvable — they must not slip into done unshipped
  expect(t.db.prepare(`SELECT column_name FROM cards WHERE id=?`).get(id)).toMatchObject({ column_name: 'review' })

  const confirmed = await t.s.inject({ method: 'POST', url: `/api/v1/cards/${id}/approve`, payload: { confirm: true } })
  expect(confirmed.statusCode).toBe(200)
  expect(enqueued).toHaveLength(1)
  expect(t.db.prepare(`SELECT column_name FROM cards WHERE id=?`).get(id)).toMatchObject({ column_name: 'done' })
})

// ── the crown e2e: launch → commit → approve → auto-merged main ─────

it('e2e: launched work auto-ships — merge on main, shipped event, worktree gone', async () => {
  const repo = await mkRepo()
  const db = openDb(':memory:')
  let maestro: any
  const s = buildServer(db, (bus) => (maestro = new Conductor(db, bus)))
  await s.ready()
  const sessions: ReturnType<typeof fakeSession>[] = []
  ;(query as any).mockImplementation(() => {
    const f = fakeSession()
    sessions.push(f)
    return f.query
  })
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: repo } })).json()
  const { card } = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: b.id, title: 'add feature' } })).json()

  const launch = await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/launch` })
  expect(launch.statusCode).toBe(200)
  const wt = path.join(repo, '..', `${path.basename(repo)}-card-${card.id}`)
  await until(() => existsSync(wt))

  // the agent does its work: a commit in the card worktree
  await writeFile(path.join(wt, 'feature.txt'), 'shipped\n')
  await git(wt, 'add', '-A')
  await git(wt, 'commit', '-m', 'the work')

  sessions[0].emit({ type: 'result', subtype: 'success', result: 'done' })
  sessions[0].close()
  await until(() => (db.prepare(`SELECT column_name FROM cards WHERE id=?`).get(card.id) as any).column_name === 'review')

  const res = await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/approve`, payload: {} })
  expect(res.statusCode).toBe(200)
  await until(() => db.prepare(`SELECT 1 FROM card_events WHERE card_id=? AND type='shipped'`).get(card.id) !== undefined)

  expect((await git(repo, 'log', '-1', '--pretty=%s')).stdout.trim()).toBe(`merge: add feature (#${card.id})`)
  expect((await git(repo, 'show', 'main:feature.txt')).stdout).toBe('shipped\n')
  const ev = db.prepare(`SELECT payload FROM card_events WHERE card_id=? AND type='shipped'`).get(card.id) as any
  expect(JSON.parse(ev.payload).hash).toBe((await git(repo, 'rev-parse', 'HEAD')).stdout.trim())
  expect((db.prepare(`SELECT column_name FROM cards WHERE id=?`).get(card.id) as any).column_name).toBe('done')
  await until(() => !existsSync(wt)) // worktree became invisible plumbing
  const branches = (await git(repo, 'branch', '--list', `card-${card.id}`)).stdout.trim()
  expect(branches).toBe('')
}, 40000)

it('e2e: a red suite blocks the card with the failure note, main untouched', async () => {
  const repo = await mkRepo()
  await writeFile(path.join(repo, 'check.js'), `process.exit(require('fs').existsSync('broken.txt') ? 1 : 0)`)
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', scripts: { test: 'node check.js' } }))
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-m', 'checkable suite')
  const before = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()

  const db = openDb(':memory:')
  const s = buildServer(db, (bus) => new Conductor(db, bus))
  await s.ready()
  const sessions: ReturnType<typeof fakeSession>[] = []
  ;(query as any).mockImplementation(() => {
    const f = fakeSession()
    sessions.push(f)
    return f.query
  })
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: repo } })).json()
  const { card } = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: b.id, title: 'doomed' } })).json()
  await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/launch` })
  const wt = path.join(repo, '..', `${path.basename(repo)}-card-${card.id}`)
  await until(() => existsSync(wt))
  await writeFile(path.join(wt, 'broken.txt'), 'boom\n')
  await git(wt, 'add', '-A')
  await git(wt, 'commit', '-m', 'breaks the suite')
  sessions[0].emit({ type: 'result', subtype: 'success', result: 'done' })
  sessions[0].close()
  await until(() => (db.prepare(`SELECT column_name FROM cards WHERE id=?`).get(card.id) as any).column_name === 'review')

  await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/approve`, payload: {} })
  await until(() => (db.prepare(`SELECT column_name FROM cards WHERE id=?`).get(card.id) as any).column_name === 'blocked')

  expect((await git(repo, 'rev-parse', 'HEAD')).stdout.trim()).toBe(before) // main untouched
  const note = db.prepare(`SELECT payload FROM card_events WHERE card_id=? AND type='autoship_failed'`).get(card.id) as any
  expect(JSON.parse(note.payload).reason).toBe('tests failed')
  expect(existsSync(wt)).toBe(true) // preserved for the owner
}, 60000)

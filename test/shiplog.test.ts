import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { parseGitLog, refCardIds, shiplog } from '../src/shiplog.js'

let repo: string
const sha = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim()
const commit = (msg: string, file: string, content: string): string => {
  fs.writeFileSync(path.join(repo, file), content)
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', msg], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-07-18T12:00:00Z', GIT_COMMITTER_DATE: '2026-07-18T12:00:00Z' } })
  return sha()
}

let hashPlain: string, hashRef: string, hashBranch: string, hashShipped: string

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'tester'], { cwd: repo })
  hashPlain = commit('chore: scaffolding', 'a.txt', 'one\n')
  hashRef = commit('merge: add login flow (#101)', 'b.txt', 'two\nlines\n')
  hashBranch = commit("Merge branch 'fix/102-scroll-race'", 'c.txt', 'three\n')
  hashShipped = commit('merge: quiet subject with no refs', 'd.txt', 'four\n')
})
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))

const makeDb = () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES (?, 'proj')`).run(repo)
  const boardId = (db.prepare(`SELECT id FROM boards WHERE project_path=?`).get(repo) as any).id
  db.prepare(`INSERT INTO agents (board_id, name, kind) VALUES (?, 'jade-fox', 'hired')`).run(boardId)
  const agentId = (db.prepare(`SELECT id FROM agents WHERE name='jade-fox'`).get() as any).id
  const card = (id: number, title: string) =>
    db.prepare(`INSERT INTO cards (id, board_id, title, column_name, owner_agent_id) VALUES (?, ?, ?, 'done', ?)`)
      .run(id, boardId, title, agentId)
  card(101, 'Login flow')
  card(102, 'Fix scroll race')
  card(103, 'Silent feature')
  return { db, boardId, agentId }
}

it('parses git log records with numstat', () => {
  const raw = '\x1eabc123\x1fabc\x1f2026-07-18T12:00:00Z\x1ftester\x1fsubject here\x1fbody line\x1f\n3\t1\tsrc/x.ts\n-\t-\tbin/blob\n'
  const [c] = parseGitLog(raw)
  expect(c.hash).toBe('abc123')
  expect(c.subject).toBe('subject here')
  expect(c.body).toBe('body line')
  expect(c.files).toEqual([
    { path: 'src/x.ts', insertions: 3, deletions: 1 },
    { path: 'bin/blob', insertions: 0, deletions: 0 },
  ])
  expect(c.insertions).toBe(3)
  expect(c.deletions).toBe(1)
})

it('extracts card ids from #N refs and merged branch names', () => {
  expect(refCardIds('merge: thing (#45)', '')).toEqual([45])
  expect(refCardIds("Merge branch 'fix/46-creator-vs-owner'", '')).toContain(46)
  expect(refCardIds("Merge branch 'slash-commands-40'", '')).toContain(40)
  expect(refCardIds("Merge branch 'feat/41-model-effort'", '')).toContain(41)
  expect(refCardIds('Merge pull request #9 from user/fix/46-thing', '')).toContain(46)
  // prose numbers and branch-less digits do not match
  expect(refCardIds('bump version to 2', 'now 3 files')).toEqual([])
  // body refs only count when subject+branch yield nothing — merge bodies mention other cards
  expect(refCardIds('merge: dead-letter mail (#47)', 'resolved conflict inside #41 guard')).toEqual([47])
  expect(refCardIds('fix stray bug', 'closes #12')).toEqual([12])
})

it('joins commits to cards: shipped events preferred, refs as fallback, unmatched plain', async () => {
  const { db, boardId, agentId } = makeDb()
  // ground truth for the commit whose subject cites nothing
  db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (103, ?, 'shipped', ?)`)
    .run(agentId, JSON.stringify({ hash: hashShipped, subject: 'merge: quiet subject with no refs', by: 'integrator' }))
  // narrative enrichment
  db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (101, ?, 'agent_exit', ?)`)
    .run(agentId, JSON.stringify({ outcome: 'success', reason: 'finished', to: 'review', agent: 'jade-fox', summary: 'Implemented the login flow end to end.' }))
  db.prepare(`INSERT INTO review_decisions (board_id, card_id, decision, note) VALUES (?, 101, 'approve', 'lgtm')`).run(boardId)

  const log = await shiplog(db, { id: boardId, project_path: repo }, { limit: 50 })
  expect(log.head).toBe(hashShipped)
  const by = Object.fromEntries(log.commits.map((c) => [c.hash, c]))

  expect(by[hashShipped].cards).toHaveLength(1)
  expect(by[hashShipped].cards[0]).toMatchObject({ id: 103, title: 'Silent feature', matched_by: 'shipped' })

  expect(by[hashRef].cards[0]).toMatchObject({
    id: 101, title: 'Login flow', agent: 'jade-fox', matched_by: 'ref',
    summary: 'Implemented the login flow end to end.', decision: 'approve',
  })
  expect(by[hashBranch].cards[0]).toMatchObject({ id: 102, title: 'Fix scroll race', matched_by: 'ref' })

  // unmatched commit still listed, with no fabricated cards
  expect(by[hashPlain].subject).toBe('chore: scaffolding')
  expect(by[hashPlain].cards).toEqual([])
})

it('a #N that is not a card on this board does not match', async () => {
  const { db, boardId } = makeDb()
  const log = await shiplog(db, { id: boardId, project_path: repo }, { limit: 50 })
  // hashRef cites #101 which exists; make a fresh db without card 101
  const db2 = openDb(':memory:')
  db2.prepare(`INSERT INTO boards (project_path, name) VALUES (?, 'other')`).run(repo + '-x')
  db2.prepare(`UPDATE boards SET project_path=?`).run(repo)
  const b2 = (db2.prepare(`SELECT id FROM boards`).get() as any).id
  const log2 = await shiplog(db2, { id: b2, project_path: repo }, { limit: 50 })
  expect(log2.commits.find((c) => c.hash === hashRef)!.cards).toEqual([])
  expect(log.commits.find((c) => c.hash === hashRef)!.cards).toHaveLength(1)
})

it('paginates with offset/limit, no gaps or duplicates, has_more set', async () => {
  const { db, boardId } = makeDb()
  const p1 = await shiplog(db, { id: boardId, project_path: repo }, { limit: 2, offset: 0 })
  expect(p1.commits).toHaveLength(2)
  expect(p1.has_more).toBe(true)
  const p2 = await shiplog(db, { id: boardId, project_path: repo }, { limit: 2, offset: 2 })
  expect(p2.commits).toHaveLength(2)
  expect(p2.has_more).toBe(false)
  const all = [...p1.commits, ...p2.commits].map((c) => c.hash)
  expect(new Set(all).size).toBe(4)
  expect(all).toEqual([hashShipped, hashBranch, hashRef, hashPlain]) // newest first
})

it('clamps limit to 200 and floors bad offsets', async () => {
  const { db, boardId } = makeDb()
  const log = await shiplog(db, { id: boardId, project_path: repo }, { limit: 9999, offset: -5 })
  expect(log.limit).toBe(200)
  expect(log.offset).toBe(0)
})

it('a non-repo project path degrades to an empty listing with an error note', async () => {
  const db = openDb(':memory:')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notrepo-'))
  db.prepare(`INSERT INTO boards (project_path, name) VALUES (?, 'norepo')`).run(dir)
  const b = (db.prepare(`SELECT id FROM boards`).get() as any).id
  const log = await shiplog(db, { id: b, project_path: dir }, {})
  expect(log.head).toBeNull()
  expect(log.commits).toEqual([])
  expect(log.error).toBeTruthy()
  fs.rmSync(dir, { recursive: true, force: true })
})

it('GET /api/v1/boards/:id/shipped serves the annotated log; unknown board 404s', async () => {
  const { db, boardId } = makeDb()
  const s = buildServer(db); await s.ready()
  const res = await s.inject({ method: 'GET', url: `/api/v1/boards/${boardId}/shipped?limit=2` })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.commits).toHaveLength(2)
  expect(body.has_more).toBe(true)
  expect(body.head).toBe(hashShipped)
  const missing = await s.inject({ method: 'GET', url: '/api/v1/boards/9999/shipped' })
  expect(missing.statusCode).toBe(404)
  await s.close()
})

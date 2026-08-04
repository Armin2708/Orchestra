import { expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { claimNext, isReady, rankBetween } from '../src/backlog.js'

const setup = () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  return db
}

const mkCard = (db: Database.Database, title: string, column = 'backlog') =>
  Number(db.prepare(`INSERT INTO cards (board_id, title, column_name) VALUES (1, ?, ?)`)
    .run(title, column).lastInsertRowid)

const contract = (db: Database.Database, cardId: number, objective = 'Do it', criteria: string[] = ['it works']) =>
  db.prepare(`INSERT INTO task_contracts (card_id, objective, acceptance_criteria) VALUES (?, ?, ?)`)
    .run(cardId, objective, JSON.stringify(criteria))

const rankOf = (db: Database.Database, id: number) =>
  (db.prepare(`SELECT rank FROM cards WHERE id=?`).get(id) as { rank: number | null }).rank

it('ranks cards top, bottom, and between with midpoints', () => {
  const db = setup()
  const a = mkCard(db, 'a')
  const b = mkCard(db, 'b')
  const c = mkCard(db, 'c')

  rankBetween(db, a, { top: true })
  rankBetween(db, b, { bottom: true })
  rankBetween(db, c, { before: b })

  const ra = rankOf(db, a)!, rb = rankOf(db, b)!, rc = rankOf(db, c)!
  expect(ra).toBeLessThan(rc)
  expect(rc).toBeLessThan(rb)

  rankBetween(db, c, { before: a })
  expect(rankOf(db, c)!).toBeLessThan(rankOf(db, a)!)
})

it('renormalizes when the gap between neighbors underflows', () => {
  const db = setup()
  const a = mkCard(db, 'a')
  const b = mkCard(db, 'b')
  const c = mkCard(db, 'c')
  db.prepare(`UPDATE cards SET rank=? WHERE id=?`).run(0, a)
  db.prepare(`UPDATE cards SET rank=? WHERE id=?`).run(1e-12, b)

  rankBetween(db, c, { after: a })

  const ranks = [rankOf(db, a)!, rankOf(db, c)!, rankOf(db, b)!]
  expect(ranks[0]).toBeLessThan(ranks[1])
  expect(ranks[1]).toBeLessThan(ranks[2])
  expect(ranks[1] - ranks[0]).toBeGreaterThan(1)
})

it('isReady requires a contract with an objective and at least one criterion', () => {
  const db = setup()
  const bare = mkCard(db, 'bare')
  const empty = mkCard(db, 'empty-contract')
  const ready = mkCard(db, 'ready')
  contract(db, empty, '   ', [])
  contract(db, ready)

  expect(isReady(db, bare)).toBe(false)
  expect(isReady(db, empty)).toBe(false)
  expect(isReady(db, ready)).toBe(true)
})

it('claimNext claims the top-ranked READY backlog card and sets the owner', () => {
  const db = setup()
  db.prepare(`INSERT INTO agents (board_id, name) VALUES (1, 'picker-otter')`).run()
  const unready = mkCard(db, 'unready-top')
  const second = mkCard(db, 'ready-second')
  const third = mkCard(db, 'ready-third')
  contract(db, second)
  contract(db, third)
  rankBetween(db, unready, { top: true })
  rankBetween(db, second, { bottom: true })
  rankBetween(db, third, { bottom: true })

  const first = claimNext(db, 1, 'picker-otter')
  expect(first?.id).toBe(second)
  expect(first?.column_name).toBe('in_progress')
  expect(first?.owner).toBe('picker-otter')

  const next = claimNext(db, 1, 'picker-otter')
  expect(next?.id).toBe(third)
  expect(claimNext(db, 1, 'picker-otter')).toBeNull()
})

it('claimNext ignores unranked cards', () => {
  const db = setup()
  const ready = mkCard(db, 'ready-but-unranked')
  contract(db, ready)
  expect(claimNext(db, 1)).toBeNull()
})

import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { reap, removeAgentCards } from '../src/reaper.js'

it('marks stale agents idle then gone; only their in_progress cards leave with them', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  const ins = db.prepare(`INSERT INTO agents (board_id, name, last_seen) VALUES (1, ?, datetime('now', ?))`)
  ins.run('fresh-otter', '-1 minutes')
  ins.run('idle-otter', '-10 minutes')
  ins.run('gone-otter', '-40 minutes')
  db.prepare(`INSERT INTO agents (board_id, name, kind, last_seen) VALUES (1, 'hired-otter', 'hired', datetime('now', '-90 minutes'))`).run()
  const gone = (db.prepare(`SELECT id FROM agents WHERE name='gone-otter'`).get() as any).id
  const fresh = (db.prepare(`SELECT id FROM agents WHERE name='fresh-otter'`).get() as any).id
  db.prepare(`INSERT INTO cards (board_id, title, owner_agent_id, column_name) VALUES (1, 'abandoned work', ?, 'in_progress')`).run(gone)
  db.prepare(`INSERT INTO cards (board_id, title, owner_agent_id) VALUES (1, 'authored ticket', ?)`).run(gone)
  db.prepare(`INSERT INTO cards (board_id, title, owner_agent_id) VALUES (1, 'live work', ?)`).run(fresh)
  reap(db)
  const status = (n: string) => (db.prepare(`SELECT status FROM agents WHERE name=?`).get(n) as any).status
  expect(status('fresh-otter')).toBe('active')
  expect(status('idle-otter')).toBe('idle')
  expect(status('gone-otter')).toBe('gone')
  expect(status('hired-otter')).not.toBe('gone') // hired agents leave only when fired
  const cards = db.prepare(`SELECT title, owner_agent_id FROM cards ORDER BY title`).all() as any[]
  // in_progress went with the agent; the backlog ticket stays, released to the pool
  expect(cards.map((c) => c.title)).toEqual(['authored ticket', 'live work'])
  expect(cards.find((c) => c.title === 'authored ticket').owner_agent_id).toBeNull()
  expect(cards.find((c) => c.title === 'live work').owner_agent_id).toBe(fresh)
})

it('removeAgentCards releases backlog/review/blocked cards unowned with history intact', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  db.prepare(`INSERT INTO agents (board_id, name) VALUES (1, 'author-otter')`).run()
  const agent = (db.prepare(`SELECT id FROM agents WHERE name='author-otter'`).get() as any).id
  const mk = (title: string, column: string) => Number(db.prepare(
    `INSERT INTO cards (board_id, title, owner_agent_id, column_name) VALUES (1, ?, ?, ?)`).run(title, agent, column).lastInsertRowid)
  const backlog = mk('backlog ticket', 'backlog')
  const review = mk('review ticket', 'review')
  const blocked = mk('blocked ticket', 'blocked')
  const wip = mk('half-done work', 'in_progress')
  const done = mk('shipped work', 'done')
  const ev = db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, 'created', '{}')`)
  for (const id of [backlog, review, blocked, wip]) ev.run(id, agent)

  removeAgentCards(db, agent)

  const card = (id: number) => db.prepare(`SELECT * FROM cards WHERE id=?`).get(id) as any
  expect(card(wip)).toBeUndefined() // abandoned in-flight work leaves with the agent
  expect(card(done).owner_agent_id).toBe(agent) // done history untouched
  for (const id of [backlog, review, blocked]) {
    expect(card(id)).toBeDefined()
    expect(card(id).owner_agent_id).toBeNull()
    expect(db.prepare(`SELECT COUNT(*) n FROM card_events WHERE card_id=?`).get(id)).toMatchObject({ n: 1 })
  }
  expect(db.prepare(`SELECT COUNT(*) n FROM card_events WHERE card_id=?`).get(wip)).toMatchObject({ n: 0 })
})

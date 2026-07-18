import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { reap } from '../src/reaper.js'

it('marks stale agents idle then gone, and clears gone agents cards', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  const ins = db.prepare(`INSERT INTO agents (board_id, name, last_seen) VALUES (1, ?, datetime('now', ?))`)
  ins.run('fresh-otter', '-1 minutes')
  ins.run('idle-otter', '-10 minutes')
  ins.run('gone-otter', '-40 minutes')
  db.prepare(`INSERT INTO agents (board_id, name, kind, last_seen) VALUES (1, 'hired-otter', 'hired', datetime('now', '-90 minutes'))`).run()
  const gone = (db.prepare(`SELECT id FROM agents WHERE name='gone-otter'`).get() as any).id
  const fresh = (db.prepare(`SELECT id FROM agents WHERE name='fresh-otter'`).get() as any).id
  db.prepare(`INSERT INTO cards (board_id, title, owner_agent_id) VALUES (1, 'orphan work', ?)`).run(gone)
  db.prepare(`INSERT INTO cards (board_id, title, owner_agent_id) VALUES (1, 'live work', ?)`).run(fresh)
  reap(db)
  const status = (n: string) => (db.prepare(`SELECT status FROM agents WHERE name=?`).get(n) as any).status
  expect(status('fresh-otter')).toBe('active')
  expect(status('idle-otter')).toBe('idle')
  expect(status('gone-otter')).toBe('gone')
  expect(status('hired-otter')).not.toBe('gone') // hired agents leave only when fired
  const titles = (db.prepare(`SELECT title FROM cards`).all() as any[]).map((c) => c.title)
  expect(titles).toEqual(['live work'])
})

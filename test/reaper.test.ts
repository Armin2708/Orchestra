import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { reap } from '../src/reaper.js'

it('marks stale agents idle then gone', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  const ins = db.prepare(`INSERT INTO agents (board_id, name, last_seen) VALUES (1, ?, datetime('now', ?))`)
  ins.run('fresh-otter', '-1 minutes')
  ins.run('idle-otter', '-10 minutes')
  ins.run('gone-otter', '-40 minutes')
  reap(db)
  const status = (n: string) => (db.prepare(`SELECT status FROM agents WHERE name=?`).get(n) as any).status
  expect(status('fresh-otter')).toBe('active')
  expect(status('idle-otter')).toBe('idle')
  expect(status('gone-otter')).toBe('gone')
})

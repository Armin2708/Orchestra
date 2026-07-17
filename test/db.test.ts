import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'

it('creates schema and enforces board uniqueness', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES (?, ?)`).run('/p/x', 'x')
  expect(() =>
    db.prepare(`INSERT INTO boards (project_path, name) VALUES (?, ?)`).run('/p/x', 'x2')
  ).toThrow()
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
    .map((r: any) => r.name)
  for (const t of ['boards', 'agents', 'cards', 'card_events', 'messages'])
    expect(tables).toContain(t)
})

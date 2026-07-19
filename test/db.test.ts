import { expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'

it('creates schema and enforces board uniqueness', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES (?, ?)`).run('/p/x', 'x')
  expect(() =>
    db.prepare(`INSERT INTO boards (project_path, name) VALUES (?, ?)`).run('/p/x', 'x2')
  ).toThrow()
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
    .map((r: any) => r.name)
  for (const t of ['boards', 'agents', 'cards', 'card_events', 'messages', 'message_targets'])
    expect(tables).toContain(t)
  const kind = db.prepare(`PRAGMA table_info(messages)`).all().find((c: any) => c.name === 'kind') as any
  expect(kind).toMatchObject({ notnull: 1, dflt_value: "'ask'" })
})

it('migrates legacy messages without losing existing mail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-db-'))
  const file = path.join(dir, 'legacy.db')
  const legacy = new Database(file)
  legacy.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL, from_agent_id INTEGER,
      to_agent_id INTEGER, card_id INTEGER, body TEXT NOT NULL, reply_to INTEGER,
      delivered_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO messages (board_id, body) VALUES (1, 'legacy note');
  `)
  legacy.close()

  const db = openDb(file)
  expect(db.prepare(`SELECT body, kind FROM messages WHERE id=1`).get()).toMatchObject({ body: 'legacy note', kind: 'ask' })
  expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='message_targets'`).get()).toBeTruthy()
  db.close()
  fs.rmSync(dir, { recursive: true })
})

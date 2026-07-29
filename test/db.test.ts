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

it('does not rewrite normalized agent usage during restart maintenance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-db-restart-'))
  const file = path.join(dir, 'restart.db')
  try {
    const first = openDb(file)
    first.prepare(`
      INSERT INTO boards (project_path, name) VALUES ('/p/restart', 'restart')
    `).run()
    first.prepare(`
      INSERT INTO agents (board_id, name, provider) VALUES (1, 'worker', 'codex')
    `).run()
    first.prepare(`
      INSERT INTO agent_usage (board_id, agent_id, day, provider)
      VALUES (1, 1, '2026-07-29', 'codex')
    `).run()
    first.exec(`
      CREATE TABLE startup_agent_usage_updates (
        id INTEGER PRIMARY KEY
      );
      CREATE TRIGGER audit_startup_agent_usage_update
      AFTER UPDATE ON agent_usage
      BEGIN
        INSERT INTO startup_agent_usage_updates (id) VALUES (NULL);
      END;
    `)
    const schemaVersionBeforeRestart = first.pragma(
      'schema_version',
      { simple: true },
    )
    first.close()

    const second = openDb(file)
    expect(second.pragma('schema_version', { simple: true }))
      .toBe(schemaVersionBeforeRestart)
    expect(second.prepare(`
      SELECT COUNT(*) AS count FROM startup_agent_usage_updates
    `).get()).toEqual({ count: 0 })
    expect(second.prepare(`
      SELECT provider, cache_read, cache_creation
      FROM agent_usage
      WHERE board_id=1 AND agent_id=1 AND day='2026-07-29'
    `).get()).toEqual({
      provider: 'codex',
      cache_read: 0,
      cache_creation: 0,
    })
    second.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('repairs an incompatible provider-session index once, then stays stable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-db-index-'))
  const file = path.join(dir, 'index.db')
  try {
    openDb(file).close()
    const altered = new Database(file)
    altered.exec(`
      DROP INDEX agents_provider_session_idx;
      CREATE INDEX agents_provider_session_idx ON agents(provider);
    `)
    altered.close()

    const repaired = openDb(file)
    expect(repaired.prepare(`
      SELECT "unique" AS is_unique, partial
      FROM pragma_index_list('agents')
      WHERE name='agents_provider_session_idx'
    `).get()).toEqual({ is_unique: 1, partial: 1 })
    const repairedSchemaVersion = repaired.pragma(
      'schema_version',
      { simple: true },
    )
    repaired.close()

    const stable = openDb(file)
    expect(stable.pragma('schema_version', { simple: true }))
      .toBe(repairedSchemaVersion)
    stable.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { EventStore } from '../src/agent-os/event-store.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('Agent OS migrations', () => {
  it('creates the kernel schema exactly once across repeated opens', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-os-schema-'))
    tempDirs.push(directory)
    const file = path.join(directory, 'orchestra.db')
    const first = openDb(file)
    applyAgentOsMigrations(first)
    expect((first.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(3)
    first.close()

    const second = openDb(file)
    const tables = new Set((second.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((row) => row.name))
    for (const table of ['workspaces', 'agent_sessions', 'processes', 'process_output', 'os_events', 'artifacts',
      'policies', 'task_contracts', 'attention_items', 'checkpoints', 'jobs', 'context_items', 'daemon_leases']) {
      expect(tables.has(table), table).toBe(true)
    }
    expect((second.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(3)
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('workspaces') WHERE name='status'").get() as any).dflt_value)
      .toBe("'active'")
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('processes') WHERE name='recipe_json'").get() as any).dflt_value)
      .toBe("'{}'")
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('jobs') WHERE name='spent_tokens'").get() as any).dflt_value)
      .toBe('0')
    second.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/provider-ownership', 'ownership')").run()
    second.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, base_ref) VALUES ('w1', 1, 'one', 'shared', '/provider-ownership', 'HEAD')`).run()
    second.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, base_ref) VALUES ('w2', 1, 'two', 'shared', '/provider-ownership', 'HEAD')`).run()
    second.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, external_id, status) VALUES ('s1', 'w1', 'codex', 'thread-1', 'running')`).run()
    expect(() => second.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, external_id, status) VALUES ('s2', 'w2', 'codex', 'thread-1', 'running')`).run())
      .toThrow(/UNIQUE/)
    expect(() => second.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, external_id, status) VALUES ('s3', 'w2', 'codex', 'thread-1', 'stopped')`).run())
      .not.toThrow()
    second.close()
  })

  it('uses event ids as no-gap incremental cursors even when timestamps match', () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/p', 'p')").run().lastInsertRowid)
    const events = new EventStore(db)
    const at = '2026-07-19T12:00:00.000Z'
    const first = events.append({ boardId, kind: 'one', source: 'test', createdAt: at })
    const second = events.append({ boardId, kind: 'two', source: 'test', createdAt: at })
    const third = events.append({ boardId, kind: 'three', source: 'test', createdAt: at })

    expect(events.listBoard(boardId).map((event) => event.id)).toEqual([third.id, second.id, first.id])
    expect(events.listBoard(boardId, { after: first.id }).map((event) => event.id)).toEqual([second.id, third.id])
    expect(() => events.listBoard(boardId, { after: 'not-a-cursor' })).toThrow(/cursor/)
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'

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
    expect((first.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(4)
    first.close()

    const second = openDb(file)
    const tables = new Set((second.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((row) => row.name))
    for (const table of ['workspaces', 'agent_sessions', 'processes', 'process_output', 'os_events', 'artifacts',
      'policies', 'task_contracts', 'attention_items', 'checkpoints', 'jobs', 'context_items', 'daemon_leases',
      'delivery_reports', 'delivery_deliverable_results', 'delivery_criterion_results']) {
      expect(tables.has(table), table).toBe(true)
    }
    expect((second.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(4)
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('workspaces') WHERE name='status'").get() as any).dflt_value)
      .toBe("'active'")
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('processes') WHERE name='recipe_json'").get() as any).dflt_value)
      .toBe("'{}'")
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('jobs') WHERE name='spent_tokens'").get() as any).dflt_value)
      .toBe('0')
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('task_contracts') WHERE name='version'").get() as any).dflt_value)
      .toBe('1')
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

  it('upgrades a migration-003 database without rewriting legacy contract meaning', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-os-upgrade-'))
    tempDirs.push(directory)
    const file = path.join(directory, 'legacy.db')
    const db = new Database(file)
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE boards (id INTEGER PRIMARY KEY, project_path TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE cards (
        id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', milestone_id INTEGER, step_order INTEGER
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, board_id INTEGER NOT NULL, card_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE jobs (id TEXT PRIMARY KEY, board_id INTEGER, card_id INTEGER, workspace_id TEXT);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, context_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE task_contracts (
        card_id INTEGER PRIMARY KEY, objective TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL DEFAULT '[]', dependencies TEXT NOT NULL DEFAULT '[]',
        base_ref TEXT, verify_commands TEXT NOT NULL DEFAULT '[]', budget_tokens INTEGER,
        budget_cents INTEGER, priority INTEGER NOT NULL DEFAULT 0, policy_id TEXT,
        workspace_id TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE os_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO os_schema_migrations (id) VALUES
        ('001-agent-os-kernel'), ('002-runtime-hardening'), ('003-provider-session-ownership');
      INSERT INTO boards (id, project_path, name) VALUES (1, '/legacy', 'legacy');
      INSERT INTO cards (id, board_id, title, description) VALUES (1, 1, 'Old task', 'Preserve old meaning');
      INSERT INTO task_contracts
        (card_id, objective, acceptance_criteria, dependencies, base_ref, verify_commands, priority, updated_at)
        VALUES (1, 'Preserve old meaning', '["old criterion"]', '[]', 'HEAD', '["npm test"]', 0,
          '2026-07-22T00:00:00.000Z');
    `)

    applyAgentOsMigrations(db)
    applyAgentOsMigrations(db)

    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(4)
    const contract = new TaskContractService(db).getOrCreate(1)
    expect(contract).toMatchObject({ objective: 'Preserve old meaning', version: 1, verify_commands: ['npm test'] })
    expect(contract.deliverables).toEqual([expect.objectContaining({ id: expect.any(String), required: true })])
    expect(contract.acceptance_criteria).toEqual([
      expect.objectContaining({ id: expect.any(String), text: 'old criterion', required: true }),
    ])
    expect(JSON.parse((db.prepare('SELECT acceptance_criteria FROM task_contracts WHERE card_id=1').get() as any)
      .acceptance_criteria)[0]).toMatchObject({ id: contract.acceptance_criteria[0].id, text: 'old criterion' })
    db.close()
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

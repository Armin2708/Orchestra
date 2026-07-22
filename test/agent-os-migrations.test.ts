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
    expect((first.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(6)
    first.close()

    const second = openDb(file)
    const tables = new Set((second.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((row) => row.name))
    for (const table of ['workspaces', 'agent_sessions', 'processes', 'process_output', 'os_events', 'artifacts',
      'policies', 'task_contracts', 'attention_items', 'checkpoints', 'jobs', 'context_items', 'daemon_leases',
      'delivery_reports', 'delivery_deliverable_results', 'delivery_criterion_results', 'workspace_assignments']) {
      expect(tables.has(table), table).toBe(true)
    }
    expect((second.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(6)
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
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, board_id INTEGER, card_id INTEGER, workspace_id TEXT,
        provider TEXT NOT NULL DEFAULT 'claude'
      );
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, context_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE os_events (
        id TEXT PRIMARY KEY, board_id INTEGER NOT NULL, workspace_id TEXT, card_id INTEGER,
        session_id TEXT, process_id TEXT, kind TEXT NOT NULL, source TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
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
      INSERT INTO jobs (id, board_id, card_id, workspace_id, provider)
        VALUES ('legacy-job', 1, 1, NULL, 'claude');
      INSERT INTO task_contracts
        (card_id, objective, acceptance_criteria, dependencies, base_ref, verify_commands, priority, updated_at)
        VALUES (1, 'Preserve old meaning', '["old criterion"]', '[]', 'HEAD', '["npm test"]', 0,
          '2026-07-22T00:00:00.000Z');
    `)
    const legacyCriteria: unknown[] = [
      'old criterion', 42, true, false, null, ['nested', 7], { foo: 'bar' },
      { text: 12, required: 'legacy' },
      { id: 'custom-id', text: 'Custom criterion', required: false, metadata: { owner: 'legacy' } },
      ...Array.from({ length: 205 }, (_, index) => index),
    ]
    db.prepare('UPDATE task_contracts SET acceptance_criteria=? WHERE card_id=1')
      .run(JSON.stringify(legacyCriteria))

    applyAgentOsMigrations(db)
    applyAgentOsMigrations(db)

    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(6)
    expect(db.prepare('SELECT provider, driver_id, effort, access_profile, idempotency_key FROM jobs WHERE id=?')
      .get('legacy-job')).toEqual({
        provider: 'claude', driver_id: 'claude', effort: null,
        access_profile: 'workspace_write', idempotency_key: null,
      })
    const contract = new TaskContractService(db).getOrCreate(1)
    expect(contract).toMatchObject({ objective: 'Preserve old meaning', version: 1, verify_commands: ['npm test'] })
    expect(contract.deliverables).toEqual([expect.objectContaining({ id: expect.any(String), required: true })])
    expect(contract.acceptance_criteria).toHaveLength(legacyCriteria.length)
    expect(contract.acceptance_criteria.slice(0, 9)).toEqual([
      expect.objectContaining({ id: expect.any(String), text: 'old criterion', required: true }),
      expect.objectContaining({ text: '42', metadata: { legacy_value: 42 } }),
      expect.objectContaining({ text: 'true', metadata: { legacy_value: true } }),
      expect.objectContaining({ text: 'false', metadata: { legacy_value: false } }),
      expect.objectContaining({ text: 'null', metadata: { legacy_value: null } }),
      expect.objectContaining({ text: '["nested",7]' }),
      expect.objectContaining({ text: '{"foo":"bar"}' }),
      expect.objectContaining({ text: '{"required":"legacy","text":12}', required: true }),
      expect.objectContaining({ id: 'custom-id', text: 'Custom criterion', required: false,
        metadata: { owner: 'legacy' } }),
    ])
    expect(new Set(contract.acceptance_criteria.map((item) => item.id)).size).toBe(legacyCriteria.length)
    expect(new TaskContractService(db).getOrCreate(1).acceptance_criteria.map((item) => item.id))
      .toEqual(contract.acceptance_criteria.map((item) => item.id))
    expect(JSON.parse((db.prepare('SELECT acceptance_criteria FROM task_contracts WHERE card_id=1').get() as any)
      .acceptance_criteria)[0]).toMatchObject({ id: contract.acceptance_criteria[0].id, text: 'old criterion' })
    db.close()
  })

  it('upgrades populated migration-004 report revisions and cascades card deletion', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-os-revision-upgrade-'))
    tempDirs.push(directory)
    const db = new Database(path.join(directory, 'legacy-revisions.db'))
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
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, board_id INTEGER, card_id INTEGER, workspace_id TEXT,
        provider TEXT NOT NULL DEFAULT 'claude'
      );
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, context_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE os_events (
        id TEXT PRIMARY KEY, board_id INTEGER NOT NULL, workspace_id TEXT, card_id INTEGER,
        session_id TEXT, process_id TEXT, kind TEXT NOT NULL, source TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE task_contracts (
        card_id INTEGER PRIMARY KEY, objective TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL DEFAULT '[]', dependencies TEXT NOT NULL DEFAULT '[]',
        base_ref TEXT, verify_commands TEXT NOT NULL DEFAULT '[]', budget_tokens INTEGER,
        budget_cents INTEGER, priority INTEGER NOT NULL DEFAULT 0, policy_id TEXT,
        workspace_id TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE os_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO os_schema_migrations (id) VALUES
        ('001-agent-os-kernel'), ('002-runtime-hardening'), ('003-provider-session-ownership'),
        ('005-delivery-report-revision-cascade');
      INSERT INTO boards (id, project_path, name) VALUES (1, '/legacy-revisions', 'legacy revisions');
      INSERT INTO cards (id, board_id, title, description) VALUES (1, 1, 'Old report', 'Preserve revisions');
    `)

    applyAgentOsMigrations(db)
    db.prepare("DELETE FROM os_schema_migrations WHERE id='005-delivery-report-revision-cascade'").run()
    const at = '2026-07-22T00:00:00.000Z'
    db.prepare(`INSERT INTO delivery_reports
      (id, lineage_id, parent_report_id, sequence, board_id, card_id, status, asked_snapshot,
       created_by, created_at, updated_at)
      VALUES ('report-1', 'report-1', NULL, 1, 1, 1, 'rejected', '{}', 'agent', ?, ?),
             ('report-2', 'report-1', 'report-1', 2, 1, 1, 'draft', '{}', 'agent', ?, ?)`)
      .run(at, at, at, at)
    db.prepare(`INSERT INTO delivery_criterion_results
      (report_id, criterion_id, outcome, evidence_refs, actor, created_at, updated_at)
      VALUES ('report-1', 'criterion-1', 'missed', '[]', 'reviewer', ?, ?)`).run(at, at)

    applyAgentOsMigrations(db)

    expect((db.prepare('SELECT COUNT(*) AS count FROM delivery_reports').get() as any).count).toBe(2)
    expect((db.prepare('SELECT COUNT(*) AS count FROM delivery_criterion_results').get() as any).count).toBe(1)
    const parentForeignKey = (db.prepare("PRAGMA foreign_key_list('delivery_reports')").all() as any[])
      .find((row) => row.from === 'parent_report_id')
    expect(parentForeignKey).toMatchObject({ table: 'delivery_reports', on_delete: 'CASCADE' })
    expect(() => db.prepare('DELETE FROM cards WHERE id=1').run()).not.toThrow()
    expect((db.prepare('SELECT COUNT(*) AS count FROM delivery_reports').get() as any).count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM delivery_criterion_results').get() as any).count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(6)
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

  it('stores causal metadata and idempotently replays the same event', () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/events', 'events')")
      .run().lastInsertRowid)
    const events = new EventStore(db)
    const first = events.append({
      boardId,
      kind: 'job.queued',
      source: 'test',
      jobId: 'job-1',
      contractId: 'card:1:v1',
      correlationId: 'correlation-1',
      causationId: 'request-1',
      idempotencyKey: 'job:job-1:queued',
      eventVersion: 2,
      payload: { provider: 'codex', priority: 1 },
    })
    const replay = events.append({
      boardId,
      kind: 'job.queued',
      source: 'test',
      jobId: 'job-1',
      contractId: 'card:1:v1',
      correlationId: 'different-value-is-non-semantic-for-replay',
      causationId: 'different-value-is-non-semantic-for-replay',
      idempotencyKey: 'job:job-1:queued',
      eventVersion: 2,
      payload: { priority: 1, provider: 'codex' },
    })

    expect(replay.id).toBe(first.id)
    expect(first).toMatchObject({
      job_id: 'job-1', contract_id: 'card:1:v1', correlation_id: 'correlation-1', causation_id: 'request-1',
      idempotency_key: 'job:job-1:queued', event_version: 2,
    })
    expect(() => events.append({
      boardId, kind: 'job.blocked', source: 'test', jobId: 'job-1',
      idempotencyKey: 'job:job-1:queued', payload: { error: 'different' },
    })).toThrow(/different event/)
    expect(() => events.append({
      boardId, kind: 'job.queued', source: 'test', jobId: 'job-1', contractId: 'card:1:v1',
      idempotencyKey: 'job:job-1:queued', eventVersion: 3, payload: { provider: 'codex', priority: 1 },
    })).toThrow(/different event/)
  })
})

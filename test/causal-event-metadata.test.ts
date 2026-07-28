import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'

const MIGRATION_ID = '020-causal-event-metadata'
const migrationObjects = [
  ['index', 'idx_os_events_actor'],
  ['index', 'idx_os_events_causation'],
  ['index', 'idx_os_events_contract'],
  ['index', 'idx_os_events_session'],
  ['trigger', 'os_events_causal_metadata_insert'],
  ['trigger', 'os_events_causal_metadata_update'],
] as const

function insertBoard(db: Database.Database, slug: string): number {
  return Number(db.prepare(
    'INSERT INTO boards (project_path, name) VALUES (?, ?)',
  ).run(`/causal-${slug}`, `causal ${slug}`).lastInsertRowid)
}

function removeMigration020(
  db: Database.Database,
  options: { dropActorType?: boolean; dropActorId?: boolean } = {
    dropActorType: true,
    dropActorId: true,
  },
): void {
  for (const [type, name] of [...migrationObjects].reverse()) {
    db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${name}`)
  }
  db.prepare('DELETE FROM os_schema_migrations WHERE id=?').run(MIGRATION_ID)
  if (options.dropActorId) db.exec('ALTER TABLE os_events DROP COLUMN actor_id')
  if (options.dropActorType) db.exec('ALTER TABLE os_events DROP COLUMN actor_type')
}

describe('causal event metadata migration 020', () => {
  it('backfills legacy actor and correlation identity and installs queryable guards', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'backfill')
    removeMigration020(db)
    const assignmentTriggerSql = db.prepare(`SELECT sql FROM sqlite_master
      WHERE type='trigger'
        AND name='os_events_job_assignment_identity_update'`).get()
    db.prepare(`INSERT INTO os_events (
      id, board_id, workspace_id, session_id, job_id, contract_id,
      correlation_id, causation_id, kind, source, payload, created_at
    ) VALUES (
      'legacy-operator-event', ?, 'workspace-1', 'session-1', 'job-1', 'card:1:v1',
      NULL, 'command-1', 'job.started', 'orchestration',
      '{"actor":{"id":"operator-1","type":"operator"}}',
      '2026-07-28T20:00:00.000Z'
    ), (
      'legacy-system-event', ?, NULL, NULL, NULL, NULL,
      NULL, NULL, 'scheduler.tick', 'scheduler', '{}',
      '2026-07-28T20:01:00.000Z'
    )`).run(boardId, boardId)

    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    expect(db.prepare(`SELECT id, actor_type, actor_id, correlation_id
      FROM os_events ORDER BY id`).all()).toEqual([
      {
        id: 'legacy-operator-event',
        actor_type: 'operator',
        actor_id: 'operator-1',
        correlation_id: 'legacy-operator-event',
      },
      {
        id: 'legacy-system-event',
        actor_type: 'system',
        actor_id: 'scheduler',
        correlation_id: 'legacy-system-event',
      },
    ])
    expect(db.prepare(`SELECT type, name FROM sqlite_master
      WHERE name IN (
        'idx_os_events_actor',
        'idx_os_events_causation',
        'idx_os_events_contract',
        'idx_os_events_session',
        'os_events_causal_metadata_insert',
        'os_events_causal_metadata_update'
      )
      ORDER BY type, name`).all()).toEqual(
      migrationObjects.map(([type, name]) => ({ type, name })),
    )
    expect(db.prepare(`SELECT sql FROM sqlite_master
      WHERE type='trigger'
        AND name='os_events_job_assignment_identity_update'`).get())
      .toEqual(assignmentTriggerSql)
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM os_schema_migrations',
    ).get()).toEqual({ count: 21 })

    expect(() => db.prepare(`INSERT INTO os_events (
      id, board_id, actor_type, workspace_id, correlation_id,
      kind, source, payload, created_at
    ) VALUES (
      'invalid-metadata', ?, ' system ', ' workspace ', 'correlation',
      'invalid', 'test', '{}', '2026-07-28T20:02:00.000Z'
    )`).run(boardId)).toThrow(/causal metadata is invalid/)
    db.close()
  })

  it('reruns without rewriting durable rows and rejects partial or altered schemas', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'rerun')
    const event = new EventStore(db).append({
      boardId,
      actor: { type: 'operator', id: 'operator-1' },
      kind: 'request.accepted',
      source: 'orchestration',
      idempotencyKey: 'request:accepted:1',
    })
    db.prepare('DELETE FROM os_schema_migrations WHERE id=?').run(MIGRATION_ID)

    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    expect(db.prepare(`SELECT actor_type, actor_id, correlation_id
      FROM os_events WHERE id=?`).get(event.id)).toEqual({
      actor_type: 'operator',
      actor_id: 'operator-1',
      correlation_id: event.id,
    })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id=?`).get(MIGRATION_ID)).toEqual({ count: 1 })
    db.close()

    const partial = openDb(':memory:')
    removeMigration020(partial, { dropActorId: true, dropActorType: false })
    expect(() => applyAgentOsMigrations(partial))
      .toThrow(/incompatible actor metadata columns/)
    expect(partial.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id=?`).get(MIGRATION_ID)).toEqual({ count: 0 })
    partial.close()

    const altered = openDb(':memory:')
    altered.exec(`
      DROP TRIGGER os_events_causal_metadata_insert;
      CREATE TRIGGER os_events_causal_metadata_insert
      BEFORE INSERT ON os_events
      BEGIN
        SELECT 1;
      END;
      DELETE FROM os_schema_migrations
      WHERE id='020-causal-event-metadata';
    `)
    expect(() => applyAgentOsMigrations(altered))
      .toThrow(/incompatible causal event metadata/)
    expect(altered.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id=?`).get(MIGRATION_ID)).toEqual({ count: 0 })
    altered.close()
  })
})

describe('EventStore causal metadata contract', () => {
  it('normalizes every causal scope and supplies stable internal-service defaults', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'event-store')
    const events = new EventStore(db)
    const event = events.append({
      boardId,
      workspaceId: ' workspace-1 ',
      sessionId: ' session-1 ',
      processId: ' process-1 ',
      jobId: ' job-1 ',
      contractId: ' card:1:v1 ',
      causationId: ' command-1 ',
      idempotencyKey: ' event:1 ',
      kind: ' job.started ',
      source: ' orchestration ',
    })

    expect(event).toMatchObject({
      actor_type: 'system',
      actor_id: 'orchestration',
      workspace_id: 'workspace-1',
      session_id: 'session-1',
      process_id: 'process-1',
      job_id: 'job-1',
      contract_id: 'card:1:v1',
      correlation_id: event.id,
      causation_id: 'command-1',
      idempotency_key: 'event:1',
      kind: 'job.started',
      source: 'orchestration',
    })
    expect(events.append({
      boardId,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      processId: 'process-1',
      jobId: 'job-1',
      contractId: 'card:1:v1',
      causationId: 'command-1',
      idempotencyKey: 'event:1',
      kind: 'job.started',
      source: 'orchestration',
    }).id).toBe(event.id)
    expect(events.append({
      boardId,
      kind: 'request.accepted',
      source: 'orchestration',
      idempotencyKey: 'event:payload-actor',
      payload: { actor: { type: 'operator', id: 'operator-1' } },
    })).toMatchObject({
      actor_type: 'operator',
      actor_id: 'operator-1',
    })
    expect(() => events.append({
      boardId,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      processId: 'process-1',
      jobId: 'job-1',
      contractId: 'card:1:v1',
      correlationId: 'different-operation',
      causationId: 'command-1',
      idempotencyKey: 'event:1',
      kind: 'job.started',
      source: 'orchestration',
    })).toThrow(/different event/)
    db.close()
  })

  it('validates actor, causal, and scoped identifiers at the append boundary', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'validation')
    const events = new EventStore(db)
    const invalidInputs = [
      { actor: { type: '   ', id: null } },
      { actor: { type: 'operator', id: 'x'.repeat(257) } },
      { workspaceId: '   ' },
      { sessionId: '   ' },
      { jobId: '   ' },
      { contractId: '   ' },
      { correlationId: 'x'.repeat(513) },
      { causationId: '   ' },
      { idempotencyKey: 'x'.repeat(513) },
      { cardId: 0 },
    ]
    for (const input of invalidInputs) {
      expect(() => events.append({
        boardId,
        kind: 'validation.event',
        source: 'test',
        ...input,
      })).toThrow()
    }
    expect(events.listBoard(boardId)).toEqual([])
    db.close()
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import {
  OPERATIONS_RECOVERY_SCHEMA_ID,
  OPERATIONS_RECOVERY_SCHEMA_SHA256,
  OperationsRecoveryService,
  OperationsRetentionService,
  SafeShutdownCoordinator,
  installOperationsRecoverySchema,
  classifyOperationsFailure,
} from '../src/agent-os/operations-recovery.js'

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const db = openDb(':memory:')
  installOperationsRecoverySchema(db)
  databases.push(db)
  const service = new OperationsRecoveryService(db)
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/ops-recovery', 'operations recovery')`).run().lastInsertRowid)
  return { db, service, boardId }
}

describe('OPS transactional outbox and replay', () => {
  it('commits source state and its outbox row atomically and rejects a conflicting replay', () => {
    const { db, service, boardId } = fixture()
    const first = service.transact(
      () => db.prepare(`INSERT INTO ideas (board_id, text) VALUES (?, 'recover me')`).run(boardId),
      { boardId, destination: 'push', dedupeKey: 'idea:1', payload: { idea_id: 1 } },
    )
    expect(first.replayed).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS count FROM ideas').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT status FROM ops_outbox WHERE id=?').get(first.outboxId)).toEqual({ status: 'pending' })

    expect(() => service.transact(
      () => { throw new Error('source write failed') },
      { boardId, destination: 'push', dedupeKey: 'idea:2', payload: { idea_id: 2 } },
    )).toThrow('source write failed')
    expect(db.prepare("SELECT COUNT(*) AS count FROM ops_outbox WHERE dedupe_key='idea:2'").get())
      .toEqual({ count: 0 })

    expect(service.enqueue({
      boardId, destination: 'push', dedupeKey: 'idea:1', payload: { idea_id: 1 },
    })).toEqual({ id: first.outboxId, replayed: true })
    expect(() => service.enqueue({
      boardId, destination: 'push', dedupeKey: 'idea:1', payload: { idea_id: 999 },
    })).toThrow(/different payload/)
  })

  it('retries with one stable downstream idempotency key after an acknowledgement-window crash', async () => {
    const { db, service, boardId } = fixture()
    const row = service.enqueue({
      boardId,
      destination: 'attention',
      dedupeKey: 'event:critical',
      payload: { kind: 'approval.required' },
      maxAttempts: 3,
      availableAt: '2026-08-02T07:00:00.000Z',
    })
    const effects = new Set<string>()
    const attempts: string[] = []
    const first = await service.dispatch({
      ownerId: 'worker-a',
      now: new Date('2026-08-02T08:00:00.000Z'),
      deliver: async (delivery) => {
        attempts.push(delivery.idempotencyKey)
        effects.add(delivery.idempotencyKey)
        throw new Error('HTTP 401 Authorization: Bearer MASTER_TOKEN_SENTINEL https://device.invalid/?pair=SECRET')
      },
    })
    expect(first).toEqual({ delivered: [], retried: [row.id], dead: [] })
    expect(db.prepare('SELECT last_error FROM ops_outbox WHERE id=?').get(row.id))
      .toEqual({ last_error: 'delivery_failed:unknown' })
    expect(db.prepare(`SELECT instr(last_error, 'MASTER_TOKEN_SENTINEL') AS leaked
      FROM ops_outbox WHERE id=?`).get(row.id)).toEqual({ leaked: 0 })
    const second = await service.dispatch({
      ownerId: 'worker-b',
      now: new Date('2026-08-02T08:00:01.000Z'),
      deliver: async (delivery) => {
        attempts.push(delivery.idempotencyKey)
        effects.add(delivery.idempotencyKey)
      },
    })
    expect(second).toEqual({ delivered: [row.id], retried: [], dead: [] })
    expect(attempts).toEqual([`orchestra-outbox:${row.id}`, `orchestra-outbox:${row.id}`])
    expect(effects.size).toBe(1)
  })

  it('makes database event consumers replay-safe and rolls back failed projections', () => {
    const { db, service, boardId } = fixture()
    const input = { consumer: 'attention-projector', eventId: 'event-1', payload: { board_id: boardId } }
    const first = service.consumeIdempotently(input, () =>
      db.prepare(`INSERT INTO ideas (board_id, text) VALUES (?, 'projected')`).run(boardId))
    expect(first.replayed).toBe(false)
    expect(service.consumeIdempotently(input, () => {
      throw new Error('must not replay')
    })).toEqual({ replayed: true })
    expect(db.prepare('SELECT COUNT(*) AS count FROM ideas').get()).toEqual({ count: 1 })
    expect(() => service.consumeIdempotently(
      { ...input, eventId: 'event-2' },
      () => {
        db.prepare(`INSERT INTO ideas (board_id, text) VALUES (?, 'rolled back')`).run(boardId)
        throw new Error('projection failed')
      },
    )).toThrow('projection failed')
    expect(db.prepare("SELECT COUNT(*) AS count FROM ideas WHERE text='rolled back'").get()).toEqual({ count: 0 })
  })

  it('reclaims an expired delivery lease after a real database close/reopen without changing identity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-outbox-restart-'))
    directories.push(root)
    const databasePath = path.join(root, 'orchestra.db')
    let db = openDb(databasePath)
    installOperationsRecoverySchema(db)
    const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/outbox-restart', 'outbox restart')`).run().lastInsertRowid)
    const original = new OperationsRecoveryService(db).enqueue({
      boardId, destination: 'push', dedupeKey: 'restart-event', payload: { safe: true },
    })
    db.prepare(`UPDATE ops_outbox SET status='delivering', attempts=1,
      lease_owner='crashed-worker', lease_expires_at='2026-08-02T07:59:00.000Z'
      WHERE id=?`).run(original.id)
    db.close()

    db = openDb(databasePath)
    const delivered: string[] = []
    const replay = await new OperationsRecoveryService(db).dispatch({
      ownerId: 'restart-worker',
      now: new Date('2026-08-02T08:00:00.000Z'),
      deliver: async (delivery) => { delivered.push(delivery.idempotencyKey) },
    })
    expect(replay.delivered).toEqual([original.id])
    expect(delivered).toEqual([`orchestra-outbox:${original.id}`])
    db.close()
  })
})

describe('OPS migration 041 schema attestation', () => {
  it('is an exact no-op after marker-loss replay and preserves one attested object set', () => {
    const pristine = new BetterSqlite3(':memory:')
    databases.push(pristine)
    expect(installOperationsRecoverySchema(pristine)).toEqual({
      created: true,
      replayed: false,
      schemaSha256: OPERATIONS_RECOVERY_SCHEMA_SHA256,
    })
    const db = openDb(':memory:')
    databases.push(db)
    let result: ReturnType<typeof installOperationsRecoverySchema> | undefined
    const applyMigration = db.transaction(() => {
      if (db.prepare('SELECT 1 FROM os_schema_migrations WHERE id=?')
        .get(OPERATIONS_RECOVERY_SCHEMA_ID)) return
      result = installOperationsRecoverySchema(db)
      db.prepare('INSERT INTO os_schema_migrations (id) VALUES (?)')
        .run(OPERATIONS_RECOVERY_SCHEMA_ID)
    })
    db.prepare('DELETE FROM os_schema_migrations WHERE id=?').run(OPERATIONS_RECOVERY_SCHEMA_ID)
    const before = db.prepare(`SELECT type, name, sql FROM sqlite_master
      WHERE name LIKE 'ops_%' OR name LIKE 'idx_ops_%' ORDER BY type, name`).all()
    result = undefined
    applyMigration()
    expect(result).toEqual({
      created: false,
      replayed: true,
      schemaSha256: OPERATIONS_RECOVERY_SCHEMA_SHA256,
    })
    expect(db.prepare(`SELECT type, name, sql FROM sqlite_master
      WHERE name LIKE 'ops_%' OR name LIKE 'idx_ops_%' ORDER BY type, name`).all()).toEqual(before)
    expect(before).toHaveLength(7)
    expect(db.prepare('SELECT count(*) AS count FROM os_schema_migrations WHERE id=?')
      .get(OPERATIONS_RECOVERY_SCHEMA_ID)).toEqual({ count: 1 })
  })

  it('rolls back without creating missing objects when a same-name table is weakened', () => {
    const db = new BetterSqlite3(':memory:')
    databases.push(db)
    db.exec('CREATE TABLE ops_outbox (id TEXT PRIMARY KEY)')
    expect(() => installOperationsRecoverySchema(db)).toThrow(/does not match: ops_outbox/)
    expect(db.prepare(`SELECT type, name FROM sqlite_master
      WHERE name LIKE 'ops_%' ORDER BY type, name`).all()).toEqual([
      { type: 'table', name: 'ops_outbox' },
    ])
    expect(db.prepare(`SELECT name FROM pragma_table_info('ops_outbox') ORDER BY cid`).all())
      .toEqual([{ name: 'id' }])
  })

  it('rejects a weakened same-name index without repairing or mutating the object set', () => {
    const db = openDb(':memory:')
    databases.push(db)
    installOperationsRecoverySchema(db)
    db.exec(`DROP INDEX idx_ops_outbox_ready;
      CREATE INDEX idx_ops_outbox_ready ON ops_outbox(status);`)
    const weakened = db.prepare(`SELECT sql FROM sqlite_master
      WHERE type='index' AND name='idx_ops_outbox_ready'`).get()
    expect(() => installOperationsRecoverySchema(db)).toThrow(/does not match: idx_ops_outbox_ready/)
    expect(db.prepare(`SELECT sql FROM sqlite_master
      WHERE type='index' AND name='idx_ops_outbox_ready'`).get()).toEqual(weakened)
    expect(db.prepare(`SELECT count(*) AS count FROM sqlite_master
      WHERE name IN (
        'ops_outbox', 'ops_event_consumptions', 'ops_recovery_runs',
        'ops_retention_policies', 'ops_compaction_archives',
        'idx_ops_outbox_ready', 'idx_ops_outbox_event'
      )`).get()).toEqual({ count: 7 })
  })
})

describe('OPS orphan reconciliation and recovery gate', () => {
  it('recovers jobs once, revokes orphan authority, preserves valid active work, and releases only stale leases', () => {
    const { db, service, boardId } = fixture()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-ops-recovery-'))
    directories.push(root)
    const workspaceId = 'workspace-active'
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES (?, ?, 'active', 'shared', ?, 'active')`).run(workspaceId, boardId, root)
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES ('workspace-missing', ?, 'missing', 'shared', ?, 'active')`)
      .run(boardId, path.join(root, 'absent'))
    const scheduler = new JobScheduler(db)
    const orphan = scheduler.create({ boardId, workspaceId, provider: 'shell', maxAttempts: 2 })
    const exhausted = scheduler.create({ boardId, workspaceId, provider: 'shell', maxAttempts: 1 })
    const duplicate = scheduler.create({ boardId, workspaceId, provider: 'shell', maxAttempts: 2 })
    const healthy = scheduler.create({ boardId, workspaceId, provider: 'shell', maxAttempts: 2 })
    const missing = scheduler.create({ boardId, workspaceId: 'workspace-missing', provider: 'shell', maxAttempts: 2 })
    const cancelling = scheduler.create({ boardId, workspaceId, provider: 'shell', maxAttempts: 2 })
    for (const job of [orphan, exhausted, duplicate, healthy, missing, cancelling]) {
      db.prepare(`UPDATE jobs SET status='running', attempts=1, started_at=? WHERE id=?`)
        .run('2026-08-02T07:59:00.000Z', job.id)
    }
    db.prepare("UPDATE jobs SET status='cancelling' WHERE id=?").run(cancelling.id)
    const addSession = (id: string, jobId: string) => db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, provider, status, context_json, job_id, control_state,
      recovery_state, history_state, created_at, updated_at
    ) VALUES (?, ?, 'shell', 'running', '{}', ?, 'active', 'attachable', 'complete', ?, ?)`)
      .run(id, workspaceId, jobId, '2026-08-02T07:59:00.000Z', '2026-08-02T07:59:00.000Z')
    addSession('session-duplicate-a', duplicate.id)
    addSession('session-duplicate-b', duplicate.id)
    addSession('session-healthy', healthy.id)
    db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, provider, status, context_json, job_id, control_state,
      recovery_state, history_state, created_at, updated_at
    ) VALUES ('session-missing', 'workspace-missing', 'shell', 'running', '{}', ?,
      'active', 'attachable', 'complete', ?, ?)`).run(
      missing.id, '2026-08-02T07:59:00.000Z', '2026-08-02T07:59:00.000Z',
    )
    db.prepare(`INSERT INTO processes (id, workspace_id, name, command, cwd, status, pid)
      VALUES ('process-dead', ?, 'dead', 'noop', ?, 'running', 999),
             ('process-live', ?, 'live', 'noop', ?, 'running', 123)`)
      .run(workspaceId, root, workspaceId, root)
    db.prepare(`INSERT INTO daemon_leases (name, owner_id, pid, acquired_at, heartbeat_at)
      VALUES ('stale', 'old-owner', 123, ?, ?),
             ('verified', 'verified-owner', 321, ?, ?),
             ('current', 'recovery-owner', 999, ?, ?)`)
      .run('2026-08-02T07:00:00.000Z', '2026-08-02T07:00:00.000Z',
        '2026-08-02T07:00:00.000Z', '2026-08-02T07:00:00.000Z',
        '2026-08-02T07:00:00.000Z', '2026-08-02T07:00:00.000Z')

    const result = service.reconcileOrphans({
      ownerId: 'recovery-owner',
      now: new Date('2026-08-02T08:00:00.000Z'),
      processAlive: (pid) => pid === 123 || pid === 321,
      ownsProcess: (processRecord) => processRecord.id === 'process-live',
      ownsDaemonLease: (lease) => lease.ownerId === 'verified-owner'
        && lease.pid === 321 && lease.heartbeatAt === '2026-08-02T07:00:00.000Z',
    })
    expect(result.lostProcesses).toEqual(['process-dead'])
    expect(result.missingWorkspaces).toEqual(['workspace-missing'])
    expect(result.releasedLeases).toEqual(['stale'])
    expect(result.recoveredJobs.sort()).toEqual([duplicate.id, orphan.id].sort())
    expect(result.blockedJobs.sort()).toEqual([exhausted.id, missing.id].sort())
    expect(result.cancelledJobs).toEqual([cancelling.id])
    expect(result.lostSessions.sort()).toEqual([
      'session-duplicate-a', 'session-duplicate-b', 'session-missing',
    ])
    expect(db.prepare('SELECT status FROM jobs WHERE id=?').get(healthy.id)).toEqual({ status: 'running' })
    expect(db.prepare("SELECT status FROM processes WHERE id='process-live'").get()).toEqual({ status: 'running' })
    expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_leases WHERE name='current'").get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_leases WHERE name='verified'").get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_leases WHERE name='stale'").get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM ops_outbox').get()).toEqual({ count: 5 })

    const replay = service.reconcileOrphans({
      ownerId: 'recovery-owner',
      now: new Date('2026-08-02T08:01:00.000Z'),
      processAlive: (pid) => pid === 123 || pid === 321,
      ownsProcess: (processRecord) => processRecord.id === 'process-live',
      ownsDaemonLease: (lease) => lease.ownerId === 'verified-owner'
        && lease.pid === 321 && lease.heartbeatAt === '2026-08-02T07:00:00.000Z',
    })
    expect(replay).toMatchObject({
      lostProcesses: [], lostSessions: [], recoveredJobs: [], blockedJobs: [],
      cancelledJobs: [], missingWorkspaces: [], releasedLeases: [],
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM ops_outbox').get()).toEqual({ count: 5 })
  })
})

describe('OPS failure and safe shutdown policy', () => {
  it('fails closed for disk, lock, provider, git, path, and corruption classes', () => {
    expect(classifyOperationsFailure(Object.assign(new Error('full'), { code: 'SQLITE_FULL' })))
      .toMatchObject({ mode: 'disk_full', retryable: false, failClosed: true })
    expect(classifyOperationsFailure(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' })))
      .toMatchObject({ mode: 'database_locked', retryable: true, failClosed: true })
    expect(classifyOperationsFailure(Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_UNAVAILABLE' })))
      .toMatchObject({ mode: 'provider_unavailable', retryable: true, preserveActiveAuthority: true })
    expect(classifyOperationsFailure(Object.assign(new Error('merge conflict'), { code: 'GIT_CONFLICT' })))
      .toMatchObject({ mode: 'git_conflict' })
    expect(classifyOperationsFailure(Object.assign(new Error('path resolves outside root'), {
      code: 'PATH_VIOLATION',
    }))).toMatchObject({ mode: 'path_violation' })
    expect(classifyOperationsFailure(Object.assign(new Error('bad'), { code: 'SQLITE_CORRUPT' })))
      .toMatchObject({ mode: 'database_corrupt', preserveActiveAuthority: false })
    expect(classifyOperationsFailure(new Error('provider unavailable')))
      .toMatchObject({ mode: 'unknown', retryable: false })
  })

  it('rejects new mutations while draining and explicitly detaches unfinished provider work', async () => {
    const coordinator = new SafeShutdownCoordinator()
    let detachCount = 0
    coordinator.register({
      id: 'job-active',
      settle: async () => new Promise<void>(() => undefined),
      onDeadline: 'detach',
      detach: async () => { detachCount += 1 },
    })
    const resultPromise = coordinator.begin(0)
    expect(() => coordinator.admitMutation()).toThrow(/draining/)
    await expect(resultPromise).resolves.toEqual({
      completed: [], detached: ['job-active'], stopped: [], unresolved: [],
    })
    expect(detachCount).toBe(1)
    await expect(coordinator.begin(0)).resolves.toEqual({
      completed: [], detached: ['job-active'], stopped: [], unresolved: [],
    })
    expect(detachCount).toBe(1)
  })
})

describe('OPS configurable retention and lossless compaction', () => {
  it('compresses old events and recoverably compacts PTY output/artifact content', () => {
    const { db, boardId } = fixture()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-ops-retention-'))
    directories.push(root)
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES ('retention-workspace', ?, 'retention', 'shared', ?, 'active')`).run(boardId, root)
    db.prepare(`INSERT INTO processes (id, workspace_id, name, command, cwd, status)
      VALUES ('retention-process', 'retention-workspace', 'retention', 'noop', ?, 'exited')`).run(root)
    db.prepare(`INSERT INTO process_output (process_id, seq, stream, data, created_at)
      VALUES ('retention-process', 1, 'pty', 'old output', '2026-01-01T00:00:00.000Z')`).run()
    db.prepare(`INSERT INTO os_events (
      id, board_id, kind, source, payload, created_at, actor_type, idempotency_key
    ) VALUES ('old-event', ?, 'job.progress', 'test', '{"progress":50}',
      '2026-01-01T00:00:00.000Z', 'system', 'old-event')`).run(boardId)
    db.prepare(`INSERT INTO artifacts (
      id, board_id, kind, name, content, created_at
    ) VALUES ('old-artifact', ?, 'text', 'old.txt', 'old artifact',
      '2026-01-01T00:00:00.000Z')`).run(boardId)
    const retention = new OperationsRetentionService(db)
    expect(retention.configure({
      boardId,
      eventDays: 30,
      transcriptDays: 60,
      ptyDays: 7,
      artifactDays: 30,
      now: new Date('2026-08-02T08:00:00.000Z'),
    })).toMatchObject({ event_days: 30, transcript_days: 60, pty_days: 7, artifact_days: 30 })
    expect(retention.run({
      boardId, now: new Date('2026-08-02T08:00:00.000Z'),
    })).toEqual({ events: 1, ptyChunks: 1, artifacts: 1, hasMore: false })
    expect(db.prepare('SELECT COUNT(*) AS count FROM process_output').get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT content FROM artifacts WHERE id='old-artifact'").get()).toEqual({ content: null })
    const archives = db.prepare(`SELECT id, category FROM ops_compaction_archives
      ORDER BY category`).all() as Array<{ id: string; category: string }>
    expect(archives.map((row) => row.category)).toEqual(['artifact', 'event', 'pty'])
    const content = Object.fromEntries(archives.map((row) => [row.category, retention.readArchive(row.id)]))
    expect(content.artifact).toBe('old artifact')
    expect(content.event).toBe('{"progress":50}')
    expect(content.pty).toContain('old output')
    expect(retention.run({
      boardId, now: new Date('2026-08-02T08:00:00.000Z'),
    })).toEqual({ events: 0, ptyChunks: 0, artifacts: 0, hasMore: false })
  })
})

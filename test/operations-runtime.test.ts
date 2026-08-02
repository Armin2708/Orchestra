import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  OperationsRecoveryService,
  OperationsRetentionService,
  SafeShutdownCoordinator,
  installOperationsRecoverySchema,
} from '../src/agent-os/operations-recovery.js'
import {
  OperationsOutboxWorker,
  OperationsRetentionScheduler,
  OperationsRuntimeCoordinator,
  assertOperationsShutdownClean,
  type OutboxDestination,
} from '../src/agent-os/operations-runtime.js'

const databases: Database.Database[] = []
const ignoreObservation = () => undefined
const destination = (
  evidenceId: string,
  deliver: OutboxDestination['deliver'],
): OutboxDestination => ({
  conformance: { mode: 'durable_idempotency_key', evidenceId },
  deliver,
})

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = openDb(':memory:')
  installOperationsRecoverySchema(db)
  databases.push(db)
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/ops-runtime', 'operations runtime')`).run().lastInsertRowid)
  const recovery = new OperationsRecoveryService(db)
  const retention = new OperationsRetentionService(db)
  return { db, boardId, recovery, retention }
}

describe('OPS durable outbox runtime', () => {
  it('dispatches by destination with a stable idempotency key and reaches retry/dead-letter outcomes', async () => {
    const { db, boardId, recovery } = fixture()
    let now = new Date('2026-08-02T08:00:00.000Z')
    const delivered = recovery.enqueue({
      boardId,
      destination: 'push',
      dedupeKey: 'push:delivered',
      payload: { safe: true },
      availableAt: now.toISOString(),
    })
    const failed = recovery.enqueue({
      boardId,
      destination: 'attention',
      dedupeKey: 'attention:dead',
      payload: { requires_operator: true },
      maxAttempts: 2,
      availableAt: now.toISOString(),
    })
    const deliveryKeys: string[] = []
    const worker = new OperationsOutboxWorker(recovery, {
      ownerId: 'runtime-worker',
      now: () => now,
      observe: ignoreObservation,
      destinations: {
        push: destination('push-idempotency-contract', async (delivery) => {
          deliveryKeys.push(delivery.idempotencyKey)
        }),
        attention: destination('attention-idempotency-contract', async (delivery) => {
          deliveryKeys.push(delivery.idempotencyKey)
          throw new Error('Bearer MASTER_TOKEN_SENTINEL')
        }),
      },
    })

    await expect(worker.tick()).resolves.toEqual({
      delivered: [delivered.id],
      retried: [failed.id],
      dead: [],
    })
    now = new Date('2026-08-02T08:00:01.000Z')
    await expect(worker.tick()).resolves.toEqual({ delivered: [], retried: [], dead: [failed.id] })
    expect(deliveryKeys.sort()).toEqual([
      `orchestra-outbox:${delivered.id}`,
      `orchestra-outbox:${failed.id}`,
      `orchestra-outbox:${failed.id}`,
    ].sort())
    expect(db.prepare('SELECT status, last_error FROM ops_outbox WHERE id=?').get(failed.id))
      .toEqual({ status: 'dead', last_error: 'delivery_failed:unknown' })
    expect(db.prepare(`SELECT instr(last_error, 'MASTER_TOKEN_SENTINEL') AS leaked
      FROM ops_outbox WHERE id=?`).get(failed.id)).toEqual({ leaked: 0 })
    expect(worker.diagnostics()).toMatchObject({ ticks: 2, delivered: 1, retried: 1, dead: 1, failed: 0 })
  })

  it('rejects a lease that could expire while its destination callback is still active', () => {
    const { recovery } = fixture()
    expect(() => new OperationsOutboxWorker(recovery, {
      ownerId: 'unsafe-worker',
      destinations: {},
      deliveryTimeoutMs: 10_000,
      leaseMs: 10_999,
      observe: ignoreObservation,
    })).toThrow(/lease must exceed/)
  })

  it('requires durable downstream idempotency evidence for every configured destination', () => {
    const { recovery } = fixture()
    expect(() => new OperationsOutboxWorker(recovery, {
      ownerId: 'unverified-worker',
      observe: ignoreObservation,
      destinations: {
        push: {
          conformance: { mode: 'durable_idempotency_key', evidenceId: '' },
          deliver: async () => undefined,
        },
      },
    })).toThrow(/conformance evidence/)
  })

  it('aborts a timed-out adapter and reuses the unsettled call instead of invoking it concurrently', async () => {
    const { boardId, recovery } = fixture()
    let now = new Date('2026-08-02T08:00:00.000Z')
    let resolveDelivery!: () => void
    const deliveryGate = new Promise<void>((resolve) => { resolveDelivery = resolve })
    const signals: AbortSignal[] = []
    let calls = 0
    const row = recovery.enqueue({
      boardId,
      destination: 'push',
      dedupeKey: 'push:slow',
      payload: { safe: true },
      maxAttempts: 3,
      availableAt: now.toISOString(),
    })
    const worker = new OperationsOutboxWorker(recovery, {
      ownerId: 'slow-worker',
      deliveryTimeoutMs: 2,
      leaseMs: 1_002,
      now: () => now,
      observe: ignoreObservation,
      destinations: {
        push: destination('push-durable-dedupe-proof', async (_delivery, signal) => {
          calls += 1
          signals.push(signal)
          await deliveryGate
        }),
      },
    })

    await expect(worker.tick()).resolves.toEqual({ delivered: [], retried: [row.id], dead: [] })
    expect(signals[0]?.aborted).toBe(true)
    expect(worker.diagnostics().activeDeliveries).toBe(1)
    now = new Date('2026-08-02T08:00:01.000Z')
    await expect(worker.tick()).resolves.toEqual({ delivered: [], retried: [row.id], dead: [] })
    expect(calls).toBe(1)
    resolveDelivery()
    await deliveryGate
    now = new Date('2026-08-02T08:00:02.000Z')
    await expect(worker.tick()).resolves.toEqual({ delivered: [row.id], retried: [], dead: [] })
    expect(calls).toBe(1)
    expect(worker.diagnostics().activeDeliveries).toBe(0)
  })

  it('recovers after invalid and throwing observation clocks without unhandled rejection', async () => {
    const { recovery } = fixture()
    let clockCalls = 0
    const observations: string[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const worker = new OperationsOutboxWorker(recovery, {
        ownerId: 'clock-worker',
        destinations: {},
        observe: (observation) => { observations.push(observation.occurredAt) },
        now: () => {
          clockCalls += 1
          if (clockCalls === 2) return new Date(Number.NaN)
          if (clockCalls === 4) throw new Error('clock unavailable')
          return new Date('2026-08-02T08:00:00.000Z')
        },
      })
      const first = worker.tick()
      await first
      const second = worker.tick()
      expect(second).not.toBe(first)
      await second
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(observations).toEqual([
        '1970-01-01T00:00:00.000Z',
        '1970-01-01T00:00:00.000Z',
      ])
      expect(worker.diagnostics()).toMatchObject({ ticks: 2, failed: 0 })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('OPS retention runtime', () => {
  it('uses the shared policy for transcript retention, prevents overlapping cycles, and compacts losslessly', async () => {
    const { db, boardId, retention } = fixture()
    retention.configure({
      boardId,
      eventDays: 30,
      transcriptDays: 60,
      ptyDays: 7,
      artifactDays: 30,
      now: new Date('2026-08-02T08:00:00.000Z'),
    })
    db.prepare(`INSERT INTO os_events (
      id, board_id, kind, source, payload, created_at, actor_type, idempotency_key
    ) VALUES ('runtime-old-event', ?, 'job.progress', 'test', '{"progress":75}',
      '2026-01-01T00:00:00.000Z', 'system', 'runtime-old-event')`).run(boardId)
    let releaseTranscript!: () => void
    const transcriptGate = new Promise<void>((resolve) => { releaseTranscript = resolve })
    const transcriptCalls: Array<[number, number, string, string]> = []
    const scheduler = new OperationsRetentionScheduler(retention, {
      now: () => new Date('2026-08-02T08:00:00.000Z'),
      cycleId: () => 'retention-cycle-1',
      observe: ignoreObservation,
      authorizeCompaction: async () => ({
        actorType: 'local_admin',
        actorId: 'operator-1',
        auditEventId: 'audit-retention-1',
      }),
      runTranscriptRetention: async (inputBoardId, days, cycleId, authorization) => {
        transcriptCalls.push([inputBoardId, days, cycleId, authorization.auditEventId])
        await transcriptGate
      },
    })

    const first = scheduler.tick()
    const overlapping = scheduler.tick()
    expect(overlapping).toBe(first)
    releaseTranscript()
    await expect(first).resolves.toEqual({
      boards: [{
        boardId,
        transcriptDays: 60,
        auditEventId: 'audit-retention-1',
        events: 1,
        ptyChunks: 0,
        artifacts: 0,
        hasMore: false,
      }],
      failedBoards: [],
    })
    expect(transcriptCalls).toEqual([[boardId, 60, 'retention-cycle-1', 'audit-retention-1']])
    const archive = db.prepare(`SELECT id FROM ops_compaction_archives
      WHERE category='event' AND subject_id='runtime-old-event'`).get() as { id: string }
    expect(retention.readArchive(archive.id)).toBe('{"progress":75}')
  })

  it('fails closed without local-admin audit evidence and preserves retained content', async () => {
    const { db, boardId, retention } = fixture()
    retention.configure({
      boardId,
      eventDays: 30,
      transcriptDays: 60,
      ptyDays: 7,
      artifactDays: 30,
    })
    db.prepare(`INSERT INTO os_events (
      id, board_id, kind, source, payload, created_at, actor_type, idempotency_key
    ) VALUES ('unauthorized-retention-event', ?, 'job.progress', 'test', '{}',
      '2026-01-01T00:00:00.000Z', 'system', 'unauthorized-retention-event')`).run(boardId)
    const observations: string[] = []
    const scheduler = new OperationsRetentionScheduler(retention, {
      now: () => new Date('2026-08-02T08:00:00.000Z'),
      observe: (observation) => { observations.push(`${observation.source}:${observation.outcome}`) },
    })

    await expect(scheduler.tick()).resolves.toEqual({ boards: [], failedBoards: [boardId] })
    expect(db.prepare(`SELECT payload FROM os_events WHERE id='unauthorized-retention-event'`).get())
      .toEqual({ payload: '{}' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM ops_compaction_archives').get()).toEqual({ count: 0 })
    expect(scheduler.diagnostics()).toMatchObject({ ticks: 1, failed: 1 })
    expect(observations).toEqual(['retention:failed'])
  })

  it('uses one restart-stable cycle id throughout an interval bucket', async () => {
    const { boardId, retention } = fixture()
    retention.configure({ boardId, eventDays: 30, transcriptDays: 60, ptyDays: 7, artifactDays: 30 })
    const cycleIds: string[] = []
    const options = {
      intervalMs: 60_000,
      now: () => new Date('2026-08-02T08:00:30.000Z'),
      observe: ignoreObservation,
      authorizeCompaction: async (_policy: unknown, cycleId: string) => {
        cycleIds.push(cycleId)
        return { actorType: 'local_admin' as const, actorId: 'operator-1', auditEventId: `audit:${cycleId}` }
      },
    }
    await new OperationsRetentionScheduler(retention, options).tick()
    await new OperationsRetentionScheduler(retention, options).tick()
    expect(cycleIds).toEqual([cycleIds[0], cycleIds[0]])
    expect(cycleIds[0]).toMatch(/^retention:\d+:\d+$/u)
  })

  it('clears retention in-flight state after invalid and throwing observation clocks', async () => {
    const { retention } = fixture()
    let clockCalls = 0
    const observations: string[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const scheduler = new OperationsRetentionScheduler(retention, {
        observe: (observation) => { observations.push(observation.occurredAt) },
        now: () => {
          clockCalls += 1
          if (clockCalls === 2) return new Date(Number.NaN)
          if (clockCalls === 4) throw new Error('clock unavailable')
          return new Date('2026-08-02T08:00:00.000Z')
        },
      })
      const first = scheduler.tick()
      await first
      const second = scheduler.tick()
      expect(second).not.toBe(first)
      await second
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(observations).toEqual([
        '1970-01-01T00:00:00.000Z',
        '1970-01-01T00:00:00.000Z',
      ])
      expect(scheduler.diagnostics()).toMatchObject({ ticks: 2, failed: 0 })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('OPS startup and shutdown orchestration', () => {
  it('reconciles in authority order before opening launch admission', async () => {
    const { db, recovery, retention } = fixture()
    db.prepare(`INSERT INTO daemon_leases (name, owner_id, pid, acquired_at, heartbeat_at)
      VALUES ('orphan-runtime', 'crashed-owner', 777, ?, ?)`).run(
      '2026-08-02T07:00:00.000Z',
      '2026-08-02T07:00:00.000Z',
    )
    const order: string[] = []
    const outbox = new OperationsOutboxWorker(recovery, {
      ownerId: 'runtime-owner',
      destinations: {},
      observe: ignoreObservation,
    })
    const retentionScheduler = new OperationsRetentionScheduler(retention, { observe: ignoreObservation })
    const runtime = new OperationsRuntimeCoordinator({
      reconcileProcesses: () => { order.push('processes'); return { recovered: 0 } },
      reconcileJobs: () => { order.push('jobs'); return { queued: 0 } },
      reconcileOrphans: () => {
        order.push('orphans')
        return recovery.reconcileOrphans({
          ownerId: 'runtime-owner',
          processAlive: () => false,
          now: new Date('2026-08-02T08:00:00.000Z'),
        })
      },
      outbox,
      retention: retentionScheduler,
      shutdown: new SafeShutdownCoordinator(),
      retentionService: retention,
    })

    let launched = false
    await expect(runtime.admitLaunch({
      id: 'too-early',
      settle: async () => undefined,
      onDeadline: 'stop',
    }, () => { launched = true })).rejects.toThrow(/not accepting/)
    expect(launched).toBe(false)
    const report = await runtime.start()
    expect(order).toEqual(['processes', 'jobs', 'orphans'])
    expect(report.orphans.releasedLeases).toEqual(['orphan-runtime'])
    const admitted = await runtime.admitLaunch({
      id: 'after-recovery',
      settle: async () => undefined,
      onDeadline: 'stop',
    }, () => 'launched')
    expect(admitted.result).toBe('launched')
    admitted.release()
    await runtime.close({ settleDeadlineMs: 1, actionTimeoutMs: 1 })
  })

  it('freezes admission before producer shutdown and returns a bounded drain result', async () => {
    const { recovery, retention } = fixture()
    const events: string[] = []
    const outbox = new OperationsOutboxWorker(recovery, {
      ownerId: 'runtime-owner',
      destinations: {},
      observe: ignoreObservation,
    })
    const retentionScheduler = new OperationsRetentionScheduler(retention, { observe: ignoreObservation })
    const originalOutboxStop = outbox.stop.bind(outbox)
    const originalRetentionStop = retentionScheduler.stop.bind(retentionScheduler)
    outbox.stop = async () => { events.push('outbox-stopped'); await originalOutboxStop() }
    retentionScheduler.stop = async () => { events.push('retention-stopped'); await originalRetentionStop() }
    const shutdown = new SafeShutdownCoordinator()
    const runtime = new OperationsRuntimeCoordinator({
      reconcileProcesses: () => undefined,
      reconcileJobs: () => undefined,
      reconcileOrphans: () => ({
        runId: 'runtime-recovery',
        lostProcesses: [], lostSessions: [], recoveredJobs: [], blockedJobs: [],
        cancelledJobs: [], missingWorkspaces: [], releasedLeases: [],
      }),
      outbox,
      retention: retentionScheduler,
      shutdown,
      retentionService: retention,
      flush: async () => { events.push('flushed') },
    })
    await runtime.start()
    await runtime.admitLaunch({
      id: 'active-provider',
      settle: async () => new Promise<void>(() => undefined),
      onDeadline: 'detach',
      detach: async () => { events.push('detached') },
    }, () => undefined)

    const closing = runtime.close({ settleDeadlineMs: 1, actionTimeoutMs: 10, flushTimeoutMs: 10 })
    let launchedAfterClose = false
    await expect(runtime.admitLaunch({
      id: 'late-launch',
      settle: async () => undefined,
      onDeadline: 'stop',
    }, () => { launchedAfterClose = true })).rejects.toThrow(/not accepting/)
    expect(launchedAfterClose).toBe(false)
    await expect(closing).resolves.toEqual({
      completed: [], detached: ['active-provider'], stopped: [], unresolved: [], flushed: true,
      activeDeliveries: 0, disposition: 'clean', safeToReleaseAuthority: true,
    })
    expect(events.slice(0, 2).sort()).toEqual(['outbox-stopped', 'retention-stopped'])
    expect(events.indexOf('detached')).toBeGreaterThan(1)
    expect(events.at(-1)).toBe('flushed')
  })

  it('does not hang when both active work and its deadline action never settle', async () => {
    const shutdown = new SafeShutdownCoordinator()
    shutdown.register({
      id: 'hung-provider',
      settle: async () => new Promise<void>(() => undefined),
      onDeadline: 'stop',
      stop: async () => new Promise<void>(() => undefined),
    })
    const started = Date.now()
    await expect(shutdown.begin(1, 5)).resolves.toEqual({
      completed: [], detached: [], stopped: [], unresolved: ['hung-provider'],
    })
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('marks unresolved or unflushed shutdown fatal and forbids authority release', async () => {
    const { recovery, retention } = fixture()
    const shutdown = new SafeShutdownCoordinator()
    const runtime = new OperationsRuntimeCoordinator({
      reconcileProcesses: () => undefined,
      reconcileJobs: () => undefined,
      reconcileOrphans: () => ({
        runId: 'runtime-recovery-fatal',
        lostProcesses: [], lostSessions: [], recoveredJobs: [], blockedJobs: [],
        cancelledJobs: [], missingWorkspaces: [], releasedLeases: [],
      }),
      outbox: new OperationsOutboxWorker(recovery, {
        ownerId: 'runtime-owner', destinations: {}, observe: ignoreObservation,
      }),
      retention: new OperationsRetentionScheduler(retention, { observe: ignoreObservation }),
      shutdown,
      retentionService: retention,
      flush: async () => { throw new Error('disk unavailable') },
    })
    await runtime.start()
    await runtime.admitLaunch({
      id: 'unresolved-provider',
      settle: async () => new Promise<void>(() => undefined),
      onDeadline: 'stop',
      stop: async () => new Promise<void>(() => undefined),
    }, () => undefined)

    const report = await runtime.close({ settleDeadlineMs: 1, actionTimeoutMs: 1, flushTimeoutMs: 1 })
    expect(report).toEqual({
      completed: [], detached: [], stopped: [], unresolved: ['unresolved-provider'], flushed: false,
      activeDeliveries: 0,
      disposition: 'fatal_operator_intervention', safeToReleaseAuthority: false,
    })
    expect(() => assertOperationsShutdownClean(report)).toThrow(/retain daemon lease/)
  })
})

import {
  type ActiveWorkRegistration,
  type DispatchResult,
  type OperationsRetentionPolicy,
  type OrphanReconciliationResult,
  type OutboxDelivery,
  OperationsRecoveryService,
  OperationsRetentionService,
  SafeShutdownCoordinator,
} from './operations-recovery.js'

type Timer = ReturnType<typeof setInterval>

const boundedMilliseconds = (value: number, fallback: number, maximum: number): number => {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(1, Math.floor(value)))
}

const runWithTimeout = async <T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.() } catch { /* timeout remains authoritative */ }
      reject(new Error('operations runtime action timed out'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const FALLBACK_OBSERVATION_TIMESTAMP = '1970-01-01T00:00:00.000Z'

const safeObservationTimestamp = (now?: () => Date): string => {
  try {
    const value = now?.() ?? new Date()
    return Number.isFinite(value.getTime()) ? value.toISOString() : FALLBACK_OBSERVATION_TIMESTAMP
  } catch {
    return FALLBACK_OBSERVATION_TIMESTAMP
  }
}

export type OutboxDestination = {
  /** Durable downstream deduplication must be verified outside this process for restart safety. */
  conformance: {
    mode: 'durable_idempotency_key'
    evidenceId: string
  }
  deliver: (delivery: OutboxDelivery, signal: AbortSignal) => Promise<void>
}

export type BackgroundWorkerDiagnostics = {
  ticks: number
  delivered: number
  retried: number
  dead: number
  failed: number
  activeDeliveries: number
  lastTickAt: string | null
  lastFailureAt: string | null
}

export type OperationsRuntimeObservation = {
  source: 'outbox' | 'retention'
  outcome: 'completed' | 'failed'
  occurredAt: string
  delivered?: number
  retried?: number
  dead?: number
  failedBoards?: number
}

const emptyDiagnostics = (): BackgroundWorkerDiagnostics => ({
  ticks: 0,
  delivered: 0,
  retried: 0,
  dead: 0,
  failed: 0,
  activeDeliveries: 0,
  lastTickAt: null,
  lastFailureAt: null,
})

export class OperationsOutboxWorker {
  private timer?: Timer
  private inFlight?: Promise<DispatchResult>
  private readonly state = emptyDiagnostics()
  private readonly deliveryTimeoutMs: number
  private readonly leaseMs: number
  private readonly active = new Map<string, { promise: Promise<void>; controller: AbortController }>()

  constructor(
    private readonly recovery: OperationsRecoveryService,
    private readonly options: {
      ownerId: string
      destinations: Readonly<Record<string, OutboxDestination>>
      intervalMs?: number
      deliveryTimeoutMs?: number
      leaseMs?: number
      limit?: number
      now?: () => Date
      observe: (observation: OperationsRuntimeObservation) => void
    },
  ) {
    this.deliveryTimeoutMs = boundedMilliseconds(
      this.options.deliveryTimeoutMs ?? 10_000,
      10_000,
      60_000,
    )
    this.leaseMs = boundedMilliseconds(this.options.leaseMs ?? 30_000, 30_000, 300_000)
    if (this.leaseMs < this.deliveryTimeoutMs + 1_000) {
      throw new Error('outbox lease must exceed the delivery timeout by at least 1000ms')
    }
    for (const destination of Object.values(this.options.destinations)) {
      if (destination.conformance.mode !== 'durable_idempotency_key'
        || !validEvidenceId(destination.conformance.evidenceId)) {
        throw new Error('outbox destination requires durable idempotency conformance evidence')
      }
    }
  }

  start(immediate = true): void {
    if (this.timer) return
    const intervalMs = boundedMilliseconds(this.options.intervalMs ?? 1_000, 1_000, 300_000)
    this.timer = setInterval(() => { void this.tick().catch(() => undefined) }, intervalMs)
    this.timer.unref?.()
    if (immediate) void this.tick().catch(() => undefined)
  }

  tick(): Promise<DispatchResult> {
    if (this.inFlight) return this.inFlight
    const operation = this.recovery.dispatch({
      ownerId: this.options.ownerId,
      limit: this.options.limit,
      leaseMs: this.leaseMs,
      now: this.options.now?.(),
      deliver: async (delivery) => {
        const destination = this.options.destinations[delivery.destination]
        if (!destination) throw new Error('outbox destination is unavailable')
        await this.deliver(destination, delivery)
      },
    }).then((result) => {
      for (const id of result.delivered) this.active.delete(`orchestra-outbox:${id}`)
      this.state.activeDeliveries = this.active.size
      return result
    })
    this.inFlight = operation
    const clear = () => { if (this.inFlight === operation) this.inFlight = undefined }
    void operation.then(
      (result) => {
        try {
          this.state.ticks += 1
          this.state.delivered += result.delivered.length
          this.state.retried += result.retried.length
          this.state.dead += result.dead.length
          this.state.activeDeliveries = this.active.size
          this.state.lastTickAt = safeObservationTimestamp(this.options.now)
          this.observe({
            source: 'outbox',
            outcome: 'completed',
            occurredAt: this.state.lastTickAt,
            delivered: result.delivered.length,
            retried: result.retried.length,
            dead: result.dead.length,
          })
        } finally {
          clear()
        }
      },
      () => {
        try {
          this.state.failed += 1
          this.state.activeDeliveries = this.active.size
          this.state.lastFailureAt = safeObservationTimestamp(this.options.now)
          this.observe({ source: 'outbox', outcome: 'failed', occurredAt: this.state.lastFailureAt })
        } finally {
          clear()
        }
      },
    ).catch(() => { clear() })
    return operation
  }

  diagnostics(): BackgroundWorkerDiagnostics {
    return { ...this.state }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const delivery of this.active.values()) {
      try { delivery.controller.abort('operations outbox worker stopped') } catch { /* keep stopping */ }
    }
    await this.inFlight?.catch(() => undefined)
    this.state.activeDeliveries = this.active.size
  }

  private observe(observation: OperationsRuntimeObservation): void {
    try { this.options.observe(observation) } catch { /* diagnostics remain authoritative */ }
  }

  private async deliver(destination: OutboxDestination, delivery: OutboxDelivery): Promise<void> {
    let active = this.active.get(delivery.idempotencyKey)
    if (!active) {
      const controller = new AbortController()
      const record: { promise: Promise<void>; controller: AbortController } = {
        promise: Promise.resolve(),
        controller,
      }
      record.promise = Promise.resolve()
        .then(() => destination.deliver(delivery, controller.signal))
        .catch((error: unknown) => {
          if (this.active.get(delivery.idempotencyKey) === record) {
            this.active.delete(delivery.idempotencyKey)
            this.state.activeDeliveries = this.active.size
          }
          throw error
        })
      this.active.set(delivery.idempotencyKey, record)
      this.state.activeDeliveries = this.active.size
      active = record
    }
    await runWithTimeout(
      () => active.promise,
      this.deliveryTimeoutMs,
      () => active.controller.abort('operations delivery timeout'),
    )
  }
}

export type RetentionTickResult = {
  boards: Array<{
    boardId: number
    transcriptDays: number
    auditEventId: string
    events: number
    ptyChunks: number
    artifacts: number
    hasMore: boolean
  }>
  failedBoards: number[]
}

export type RetentionAuthorizationEvidence = {
  actorType: 'local_admin'
  actorId: string
  auditEventId: string
}

export class OperationsRetentionScheduler {
  private timer?: Timer
  private inFlight?: Promise<RetentionTickResult>
  private readonly state = emptyDiagnostics()

  constructor(
    private readonly retention: OperationsRetentionService,
    private readonly options: {
      runTranscriptRetention?: (
        boardId: number,
        transcriptDays: number,
        cycleId: string,
        authorization: RetentionAuthorizationEvidence,
      ) => Promise<void>
      authorizeCompaction?: (
        policy: OperationsRetentionPolicy,
        cycleId: string,
      ) => Promise<RetentionAuthorizationEvidence | null>
      intervalMs?: number
      boardTimeoutMs?: number
      limit?: number
      now?: () => Date
      cycleId?: () => string
      observe: (observation: OperationsRuntimeObservation) => void
    },
  ) {}

  start(immediate = false): void {
    if (this.timer) return
    const intervalMs = boundedMilliseconds(this.options.intervalMs ?? 3_600_000, 3_600_000, 86_400_000)
    this.timer = setInterval(() => { void this.tick().catch(() => undefined) }, intervalMs)
    this.timer.unref?.()
    if (immediate) void this.tick().catch(() => undefined)
  }

  tick(): Promise<RetentionTickResult> {
    if (this.inFlight) return this.inFlight
    const operation = this.run()
    this.inFlight = operation
    const clear = () => { if (this.inFlight === operation) this.inFlight = undefined }
    void operation.then(
      (result) => {
        try {
          this.state.ticks += 1
          this.state.failed += result.failedBoards.length
          this.state.lastTickAt = safeObservationTimestamp(this.options.now)
          if (result.failedBoards.length > 0) this.state.lastFailureAt = this.state.lastTickAt
          this.observe({
            source: 'retention',
            outcome: result.failedBoards.length > 0 ? 'failed' : 'completed',
            occurredAt: this.state.lastTickAt,
            failedBoards: result.failedBoards.length,
          })
        } finally {
          clear()
        }
      },
      () => {
        try {
          this.state.failed += 1
          this.state.lastFailureAt = safeObservationTimestamp(this.options.now)
          this.observe({ source: 'retention', outcome: 'failed', occurredAt: this.state.lastFailureAt })
        } finally {
          clear()
        }
      },
    ).catch(() => { clear() })
    return operation
  }

  diagnostics(): BackgroundWorkerDiagnostics {
    return { ...this.state }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight?.catch(() => undefined)
  }

  private async run(): Promise<RetentionTickResult> {
    const result: RetentionTickResult = { boards: [], failedBoards: [] }
    const at = this.options.now?.() ?? new Date()
    const timeoutMs = boundedMilliseconds(this.options.boardTimeoutMs ?? 30_000, 30_000, 300_000)
    const intervalMs = boundedMilliseconds(this.options.intervalMs ?? 3_600_000, 3_600_000, 86_400_000)
    for (const policy of this.retention.listPolicies()) {
      try {
        const cycleId = this.options.cycleId?.()
          ?? `retention:${policy.board_id}:${Math.floor(at.getTime() / intervalMs)}`
        const authorization = await this.options.authorizeCompaction?.(policy, cycleId)
        if (!isRetentionAuthorization(authorization)) {
          throw new Error('retention compaction requires local-admin audit evidence')
        }
        if (this.options.runTranscriptRetention) {
          await runWithTimeout(
            () => this.options.runTranscriptRetention!(
              policy.board_id,
              policy.transcript_days,
              cycleId,
              authorization,
            ),
            timeoutMs,
          )
        }
        const compacted = this.retention.run({
          boardId: policy.board_id,
          now: at,
          limit: this.options.limit,
        })
        result.boards.push({
          boardId: policy.board_id,
          transcriptDays: policy.transcript_days,
          auditEventId: authorization.auditEventId,
          ...compacted,
        })
      } catch {
        result.failedBoards.push(policy.board_id)
      }
    }
    return result
  }

  private observe(observation: OperationsRuntimeObservation): void {
    try { this.options.observe(observation) } catch { /* diagnostics remain authoritative */ }
  }
}

const isRetentionAuthorization = (
  evidence: RetentionAuthorizationEvidence | null | undefined,
): evidence is RetentionAuthorizationEvidence => evidence?.actorType === 'local_admin'
  && validEvidenceId(evidence.actorId) && validEvidenceId(evidence.auditEventId)

const validEvidenceId = (value: string): boolean => value.length > 0 && value.length <= 512
  && !/[\0-\x1f\x7f]/u.test(value)

export type OperationsStartupReport = {
  processes: unknown
  jobs: unknown
  orphans: OrphanReconciliationResult
  retentionPolicies: OperationsRetentionPolicy[]
}

type OperationsShutdownBase = {
  completed: string[]
  detached: string[]
  stopped: string[]
  unresolved: string[]
  flushed: boolean
  activeDeliveries: number
}

export type OperationsShutdownReport = OperationsShutdownBase & ({
  disposition: 'clean'
  safeToReleaseAuthority: true
} | {
  disposition: 'fatal_operator_intervention'
  safeToReleaseAuthority: false
})

export function assertOperationsShutdownClean(
  report: OperationsShutdownReport,
): asserts report is OperationsShutdownBase & {
  disposition: 'clean'
  safeToReleaseAuthority: true
} {
  if (!report.safeToReleaseAuthority) {
    throw new Error('operations shutdown is not clean; retain daemon lease and database authority')
  }
}

/**
 * Runtime integration seam for the daemon owner. Startup reconciliation completes before
 * admission opens; shutdown freezes admission before stopping producers and draining work.
 */
export class OperationsRuntimeCoordinator {
  private state: 'created' | 'starting' | 'running' | 'closing' | 'closed' | 'failed' = 'created'
  private startup?: Promise<OperationsStartupReport>
  private shutdown?: Promise<OperationsShutdownReport>

  constructor(private readonly options: {
    reconcileProcesses: () => Promise<unknown> | unknown
    reconcileJobs: () => Promise<unknown> | unknown
    reconcileOrphans: () => Promise<OrphanReconciliationResult> | OrphanReconciliationResult
    outbox: OperationsOutboxWorker
    retention: OperationsRetentionScheduler
    shutdown: SafeShutdownCoordinator
    retentionService: OperationsRetentionService
    flush?: () => Promise<void>
  }) {}

  start(): Promise<OperationsStartupReport> {
    if (this.startup) return this.startup
    if (this.state !== 'created') return Promise.reject(new Error('operations runtime cannot be started'))
    this.state = 'starting'
    this.startup = this.startRuntime()
    return this.startup
  }

  async admitLaunch<T>(
    registration: ActiveWorkRegistration,
    launch: () => Promise<T> | T,
  ): Promise<{ result: T; release: () => void }> {
    if (this.state !== 'running') throw new Error('operations runtime is not accepting launches')
    const release = this.options.shutdown.register(registration)
    try {
      return { result: await launch(), release }
    } catch (error) {
      release()
      throw error
    }
  }

  close(input: { settleDeadlineMs?: number; actionTimeoutMs?: number; flushTimeoutMs?: number } = {}): Promise<OperationsShutdownReport> {
    if (this.shutdown) return this.shutdown
    this.state = 'closing'
    this.options.shutdown.closeAdmission()
    this.shutdown = this.closeRuntime(input)
    return this.shutdown
  }

  private async startRuntime(): Promise<OperationsStartupReport> {
    try {
      const processes = await this.options.reconcileProcesses()
      const jobs = await this.options.reconcileJobs()
      const orphans = await this.options.reconcileOrphans()
      const retentionPolicies = this.options.retentionService.listPolicies()
      if (this.state !== 'starting') throw new Error('operations runtime closed during startup')
      this.options.outbox.start(true)
      this.options.retention.start(false)
      this.state = 'running'
      return { processes, jobs, orphans, retentionPolicies }
    } catch (error) {
      this.state = 'closed'
      await Promise.all([this.options.outbox.stop(), this.options.retention.stop()])
      throw error
    }
  }

  private async closeRuntime(input: {
    settleDeadlineMs?: number
    actionTimeoutMs?: number
    flushTimeoutMs?: number
  }): Promise<OperationsShutdownReport> {
    await Promise.all([this.options.outbox.stop(), this.options.retention.stop()])
    const drained = await this.options.shutdown.begin(
      boundedMilliseconds(input.settleDeadlineMs ?? 30_000, 30_000, 300_000),
      boundedMilliseconds(input.actionTimeoutMs ?? 5_000, 5_000, 60_000),
    )
    let flushed = !this.options.flush
    if (this.options.flush) {
      try {
        await runWithTimeout(
          this.options.flush,
          boundedMilliseconds(input.flushTimeoutMs ?? 5_000, 5_000, 60_000),
        )
        flushed = true
      } catch {
        flushed = false
      }
    }
    const safeToReleaseAuthority = drained.unresolved.length === 0 && flushed
      && this.options.outbox.diagnostics().activeDeliveries === 0
    const activeDeliveries = this.options.outbox.diagnostics().activeDeliveries
    if (safeToReleaseAuthority) {
      this.state = 'closed'
      return {
        ...drained,
        flushed,
        activeDeliveries,
        disposition: 'clean',
        safeToReleaseAuthority: true,
      }
    }
    this.state = 'failed'
    return {
      ...drained,
      flushed,
      activeDeliveries,
      disposition: 'fatal_operator_intervention',
      safeToReleaseAuthority: false,
    }
  }
}

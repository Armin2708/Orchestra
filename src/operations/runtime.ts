import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  CapacityController,
  type CapacityAdmission,
  type CapacityControllerOptions,
  type CapacityRequest,
} from './capacity.js'
import {
  OperationsHealthService,
  type OperationsHealthProbe,
  type OperationsHealthSnapshot,
} from './health.js'
import {
  OperationsAlertEngine,
  type OperationsAlert,
  type OperationsAlertEngineOptions,
  type OperationsAlertSignals,
  type OperationsAlertThresholds,
  OperationsMetrics,
  type OperationsMetricsOptions,
} from './metrics.js'
import {
  StructuredOperationsLogger,
  type StructuredOperationsLoggerOptions,
} from './structured-logger.js'

type MaybePromise<T> = T | Promise<T>

export interface RuntimeDriverHealth {
  registered: number
  ready: number
}

export interface RuntimeProviderHealth {
  configured: number
  ready: number
  degraded: number
  unavailable: number
}

export interface RuntimePtyHealth {
  responsive: boolean
  reconciled: boolean
  lostProcesses: number
}

export interface RuntimeHooksHealth {
  enabled: boolean
  coherent: boolean
}

export interface RuntimeCredentialHealth {
  available: boolean
  reasonCode: string
}

export type VerifiedTunnelHealth =
  | { enabled: false }
  | {
    enabled: true
    transport: 'tailscale' | 'cloudflared'
    checkedAt: string
    reachable: boolean
    endToEndVerified: boolean
    originVerified: boolean
    authenticationVerified: boolean
  }

export interface OperationsRuntimeDependencies {
  db: Database.Database
  lease: {
    ownerId: string
    pid: number
    name?: string
    maxHeartbeatAgeMs?: number
  }
  drivers(): MaybePromise<RuntimeDriverHealth>
  providers(): MaybePromise<RuntimeProviderHealth>
  ptySupervisor(): MaybePromise<RuntimePtyHealth>
  hooks(): MaybePromise<RuntimeHooksHealth>
  tunnel(): MaybePromise<VerifiedTunnelHealth>
  credentials?(): MaybePromise<RuntimeCredentialHealth>
  processIsAlive?: (pid: number) => boolean
  clock?: () => Date
  maxTunnelVerificationAgeMs?: number
}

export interface OperationsRuntimeOptions {
  capacity?: CapacityControllerOptions
  metrics?: OperationsMetricsOptions
  logger?: StructuredOperationsLoggerOptions
  alerts?: OperationsAlertThresholds
  alertState?: OperationsAlertEngineOptions
  healthTimeoutMs?: number
  healthRefreshIntervalMs?: number
  maxHealthSnapshotAgeMs?: number
}

const DEFAULT_CAPACITY: CapacityControllerOptions = Object.freeze({
  maxActiveSessions: 16,
  maxQueueDepth: 128,
  maxActivePerProvider: 8,
  reservedInteractiveSlots: 2,
  retryAfterMs: 1_000,
})

class OperationsInstrumentationStatus {
  private metricFailures = 0
  private logFailures = 0
  private healthRefreshFailures = 0

  recordMetricFailure(): void { this.metricFailures += 1 }

  recordLogFailure(metrics: OperationsMetrics): void {
    this.logFailures += 1
    try { metrics.increment('dropped_logs_total') } catch { this.recordMetricFailure() }
  }

  recordHealthRefreshFailure(): void { this.healthRefreshFailures += 1 }

  snapshot(): Readonly<{
    metric_failures: number
    log_failures: number
    health_refresh_failures: number
  }> {
    return Object.freeze({
      metric_failures: this.metricFailures,
      log_failures: this.logFailures,
      health_refresh_failures: this.healthRefreshFailures,
    })
  }
}

/**
 * A daemon-lifetime admission helper. It shares the runtime registry/logger and updates them after
 * every state transition without buffering request bodies, commands, credentials, or PTY data.
 */
export class OperationsCapacityAdmission {
  constructor(
    private readonly controller: CapacityController,
    private readonly metrics: OperationsMetrics,
    private readonly logger: StructuredOperationsLogger,
    private readonly instrumentation: OperationsInstrumentationStatus,
  ) {
    this.observe()
  }

  admit(request: CapacityRequest): CapacityAdmission {
    const decision = this.controller.admit(request)
    this.observe()
    if (decision.decision === 'reject') {
      this.safeMetric(() => this.metrics.increment('capacity_rejections_total', 1, {
        priority: request.priority,
      }))
    }
    this.safeLog({
      level: decision.decision === 'reject' ? 'warn' : 'info',
      event: `capacity.admission.${decision.decision}`,
      outcome: decision.decision === 'reject' ? 'denied' : 'allowed',
      component: 'capacity',
      reasonCode: decision.reason_code,
      attributes: { provider: request.provider, priority: request.priority },
    })
    return Object.freeze({ ...decision })
  }

  release(requestId: string): void {
    this.controller.release(requestId)
    this.observe()
  }

  reconcileActive(requests: readonly CapacityRequest[]): void {
    this.controller.reconcileActive(requests)
    this.observe()
  }

  cancelQueued(requestId: string): boolean {
    const cancelled = this.controller.cancelQueued(requestId)
    this.observe()
    return cancelled
  }

  drain(limit = 1): CapacityRequest[] {
    const started = this.controller.drain(limit)
    this.observe()
    for (const request of started) {
      this.safeLog({
        level: 'info',
        event: 'capacity.admission.drained',
        outcome: 'allowed',
        component: 'capacity',
        reasonCode: 'capacity_available',
        attributes: { provider: request.provider, priority: request.priority },
      })
    }
    return started.map((request) => Object.freeze({ ...request }))
  }

  snapshot(): ReturnType<CapacityController['snapshot']> {
    return this.controller.snapshot()
  }

  private observe(): void {
    const snapshot = this.controller.snapshot()
    this.safeMetric(() => this.metrics.set('active_sessions', snapshot.active_sessions))
    this.safeMetric(() => this.metrics.set('queue_depth', snapshot.queue_depth))
  }

  private safeMetric(operation: () => void): void {
    try { operation() } catch { this.instrumentation.recordMetricFailure() }
  }

  private safeLog(input: Parameters<StructuredOperationsLogger['log']>[0]): void {
    try { this.logger.log(input) } catch { this.instrumentation.recordLogFailure(this.metrics) }
  }
}

/**
 * Shared daemon-lifetime operations primitives. Construct once during daemon composition and pass
 * this same object to schedulers, handlers, diagnostics, and exporters.
 */
export class OperationsRuntime {
  readonly metrics: OperationsMetrics
  readonly logger: StructuredOperationsLogger
  readonly alerts: OperationsAlertEngine
  readonly capacity: OperationsCapacityAdmission
  readonly health: OperationsHealthService
  private readonly instrumentation = new OperationsInstrumentationStatus()
  private readonly clock: () => Date
  private readonly maxHealthSnapshotAgeMs: number
  private healthSnapshot?: { snapshot: OperationsHealthSnapshot; completedAtMs: number }
  private healthInFlight?: Promise<OperationsHealthSnapshot>
  private healthTimer?: ReturnType<typeof setInterval>
  private closed = false
  private readonly rateLimitRejections: number[] = []

  constructor(
    dependencies: OperationsRuntimeDependencies,
    options: OperationsRuntimeOptions = {},
  ) {
    this.clock = dependencies.clock ?? (() => new Date())
    const refreshIntervalMs = boundedDuration(
      options.healthRefreshIntervalMs ?? 5_000,
      1_000,
      5 * 60_000,
      'health refresh interval',
    )
    this.maxHealthSnapshotAgeMs = boundedDuration(
      options.maxHealthSnapshotAgeMs ?? refreshIntervalMs * 3,
      refreshIntervalMs,
      30 * 60_000,
      'health snapshot age',
    )
    this.metrics = new OperationsMetrics({
      ...options.metrics,
      clock: options.metrics?.clock ?? this.clock,
    })
    this.logger = new StructuredOperationsLogger({
      ...options.logger,
      clock: options.logger?.clock ?? this.clock,
    })
    this.alerts = new OperationsAlertEngine(options.alerts, this.clock, options.alertState)
    this.capacity = new OperationsCapacityAdmission(
      new CapacityController(options.capacity ?? DEFAULT_CAPACITY),
      this.metrics,
      this.logger,
      this.instrumentation,
    )
    this.health = new OperationsHealthService(
      runtimeHealthProbes(
        dependencies,
        this.clock,
        () => observabilityProbe(this.instrumentation, this.logger),
      ),
      { clock: this.clock, defaultTimeoutMs: options.healthTimeoutMs },
    )
    this.healthTimer = setInterval(() => { this.scheduleHealthCheck() }, refreshIntervalMs)
    this.healthTimer.unref()
    queueMicrotask(() => { if (!this.closed) this.scheduleHealthCheck() })
  }

  async checkHealth(): Promise<OperationsHealthSnapshot> {
    if (this.closed) throw new Error('operations runtime is closed')
    if (this.healthInFlight) return this.healthInFlight
    const operation = this.runHealthCheck()
    this.healthInFlight = operation
    try {
      return await operation
    } catch (error) {
      this.healthSnapshot = undefined
      this.instrumentation.recordHealthRefreshFailure()
      throw error
    } finally {
      if (this.healthInFlight === operation) this.healthInFlight = undefined
    }
  }

  /** Cache-only public view: it never runs a probe or touches SQLite on the request path. */
  publicReadiness(): Readonly<{ live: true; ready: boolean }> {
    try {
      if (this.closed || !this.healthSnapshot) return Object.freeze({ live: true, ready: false })
      const nowMs = trustedNow(this.clock).getTime()
      const age = nowMs - this.healthSnapshot.completedAtMs
      if (age < 0 || age > this.maxHealthSnapshotAgeMs) {
        return Object.freeze({ live: true, ready: false })
      }
      return this.health.publicStatus(this.healthSnapshot.snapshot)
    } catch {
      return Object.freeze({ live: true, ready: false })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = undefined
  }

  evaluateAlerts(signals: OperationsAlertSignals): OperationsAlert[] {
    const emitted = this.alerts.evaluate(signals)
    for (const alert of emitted) {
      this.safeLog({
        level: alert.severity === 'critical' ? 'error' : 'warn',
        event: `operations.alert.${alert.type}`,
        outcome: 'degraded',
        component: 'alerts',
        reasonCode: alert.reason_code,
        correlationId: alert.correlation_id,
        jobId: alert.job_id,
        sessionId: alert.session_id,
        deviceId: alert.device_id,
        attributes: { occurrences: alert.occurrences },
      })
    }
    return emitted.map((alert) => Object.freeze({ ...alert }))
  }

  recordRateLimitRejection(deviceId?: string): OperationsAlert[] {
    const now = trustedNow(this.clock).getTime()
    this.rateLimitRejections.push(now)
    while (this.rateLimitRejections[0] !== undefined
      && this.rateLimitRejections[0] < now - 60_000) this.rateLimitRejections.shift()
    try { this.metrics.increment('rate_limit_rejections_total') }
    catch { this.instrumentation.recordMetricFailure() }
    return this.evaluateAlerts({
      rateLimitRejections: this.rateLimitRejections.length,
      deviceId,
    })
  }

  currentRateLimitRejections(): number {
    const now = trustedNow(this.clock).getTime()
    while (this.rateLimitRejections[0] !== undefined
      && this.rateLimitRejections[0] < now - 60_000) this.rateLimitRejections.shift()
    return this.rateLimitRejections.length
  }

  private safeLog(input: Parameters<StructuredOperationsLogger['log']>[0]): void {
    try { this.logger.log(input) } catch { this.instrumentation.recordLogFailure(this.metrics) }
  }

  private async runHealthCheck(): Promise<OperationsHealthSnapshot> {
    const snapshot = await this.health.check()
    const completedAtMs = trustedNow(this.clock).getTime()
    this.healthSnapshot = { snapshot, completedAtMs }
    if (snapshot.status !== 'ready') {
      this.safeLog({
        level: snapshot.status === 'unavailable' ? 'error' : 'warn',
        event: 'operations.health.checked',
        outcome: snapshot.status === 'unavailable' ? 'failed' : 'degraded',
        component: 'health',
        reasonCode: `health_${snapshot.status}`,
        attributes: {
          impaired_components: snapshot.components
            .filter((component) => component.status === 'degraded' || component.status === 'unavailable')
            .map((component) => component.component),
        },
      })
    }
    return snapshot
  }

  private scheduleHealthCheck(): void {
    void this.checkHealth().catch(() => {
      // checkHealth invalidates the cache and records a fixed counter. Background refresh must
      // never create an unhandled rejection capable of terminating the daemon.
    })
  }
}

export function createOperationsRuntime(
  dependencies: OperationsRuntimeDependencies,
  options: OperationsRuntimeOptions = {},
): OperationsRuntime {
  return new OperationsRuntime(dependencies, options)
}

function runtimeHealthProbes(
  dependencies: OperationsRuntimeDependencies,
  clock: () => Date,
  observability: () => ReturnType<typeof observabilityProbe>,
): OperationsHealthProbe[] {
  const leaseName = safeLeaseName(dependencies.lease.name ?? 'orchestra-daemon')
  const ownerId = safeLeaseOwner(dependencies.lease.ownerId)
  const expectedPid = positiveInteger(dependencies.lease.pid, 'daemon lease pid')
  const heartbeatLimit = boundedDuration(
    dependencies.lease.maxHeartbeatAgeMs ?? 15_000,
    5_000,
    120_000,
    'daemon lease heartbeat age',
  )
  const tunnelLimit = boundedDuration(
    dependencies.maxTunnelVerificationAgeMs ?? 30_000,
    1_000,
    5 * 60_000,
    'tunnel verification age',
  )
  const processIsAlive = dependencies.processIsAlive ?? defaultProcessIsAlive
  const databaseProbeKey = `__orchestra_operations_health__:${randomUUID()}`

  return [
    {
      component: 'database',
      required: true,
      check: () => databaseReadWriteProbe(dependencies.db, databaseProbeKey, trustedNow(clock)),
    },
    {
      component: 'daemon_lease',
      required: true,
      check: () => daemonLeaseProbe(
        dependencies.db,
        { leaseName, ownerId, expectedPid, heartbeatLimit, processIsAlive },
        trustedNow(clock),
      ),
    },
    { component: 'drivers', required: true, check: async () => driverProbe(await dependencies.drivers()) },
    { component: 'providers', required: true, check: async () => providerProbe(await dependencies.providers()) },
    {
      component: 'pty_supervisor',
      required: true,
      check: async () => ptyProbe(await dependencies.ptySupervisor()),
    },
    { component: 'hooks', required: true, check: async () => hooksProbe(await dependencies.hooks()) },
    {
      component: 'tunnels',
      required: false,
      check: async () => tunnelProbe(await dependencies.tunnel(), trustedNow(clock), tunnelLimit),
    },
    {
      component: 'credentials',
      required: false,
      check: async () => dependencies.credentials
        ? credentialProbe(await dependencies.credentials())
        : { status: 'disabled', reasonCode: 'credential_probe_not_configured' },
    },
    { component: 'observability', required: true, check: observability },
  ]
}

function credentialProbe(input: RuntimeCredentialHealth): {
  status: 'ready' | 'unavailable'
  reasonCode: string
} {
  return {
    status: input.available ? 'ready' : 'unavailable',
    reasonCode: /^[a-z][a-z0-9_]{1,95}$/u.test(input.reasonCode)
      ? input.reasonCode
      : input.available ? 'credential_store_ready' : 'credential_store_unavailable',
  }
}

function observabilityProbe(
  instrumentation: OperationsInstrumentationStatus,
  logger: StructuredOperationsLogger,
): {
  status: 'ready' | 'degraded' | 'unavailable'
  reasonCode: string
  details: Record<string, unknown>
} {
  const failures = instrumentation.snapshot()
  const logs = logger.statistics()
  const loggingUnavailable = failures.log_failures > 0 || logs.sink_failures > 0
  const unavailable = failures.metric_failures > 0 && loggingUnavailable
  const degraded = failures.metric_failures > 0
    || failures.log_failures > 0
    || failures.health_refresh_failures > 0
    || logs.sink_failures > 0
    || logs.dropped > 0
  return {
    status: unavailable ? 'unavailable' : degraded ? 'degraded' : 'ready',
    reasonCode: unavailable ? 'observability_unavailable'
      : degraded ? 'observability_degraded' : 'observability_ready',
    details: {
      metric_failures: failures.metric_failures,
      log_failures: failures.log_failures,
      health_refresh_failures: failures.health_refresh_failures,
      sink_failures: logs.sink_failures,
      dropped_logs: logs.dropped,
    },
  }
}

function databaseReadWriteProbe(
  db: Database.Database,
  key: string,
  now: Date,
): { status: 'ready'; reasonCode: string } {
  const verify = db.transaction(() => {
    const read = db.prepare('SELECT 1 AS healthy').get() as { healthy: number } | undefined
    if (read?.healthy !== 1) throw new Error('database read verification failed')
    db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, 'ok', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(key, now.toISOString())
    const written = db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined
    if (written?.value !== 'ok') throw new Error('database write verification failed')
    if (db.prepare('DELETE FROM kv WHERE key=?').run(key).changes !== 1) {
      throw new Error('database write cleanup failed')
    }
  })
  verify.immediate()
  return { status: 'ready', reasonCode: 'database_read_write_verified' }
}

function daemonLeaseProbe(
  db: Database.Database,
  expected: {
    leaseName: string
    ownerId: string
    expectedPid: number
    heartbeatLimit: number
    processIsAlive: (pid: number) => boolean
  },
  now: Date,
): { status: 'ready' | 'unavailable'; reasonCode: string; details?: Record<string, unknown> } {
  const row = db.prepare(`SELECT owner_id, pid, heartbeat_at FROM daemon_leases WHERE name=?`)
    .get(expected.leaseName) as { owner_id: string; pid: number; heartbeat_at: string } | undefined
  if (!row) return { status: 'unavailable', reasonCode: 'daemon_lease_missing' }
  if (row.owner_id !== expected.ownerId) {
    return { status: 'unavailable', reasonCode: 'daemon_lease_owner_mismatch' }
  }
  if (row.pid !== expected.expectedPid || !expected.processIsAlive(row.pid)) {
    return { status: 'unavailable', reasonCode: 'daemon_lease_process_missing' }
  }
  const heartbeatMs = canonicalTimestamp(row.heartbeat_at, 'daemon heartbeat')
  const nowMs = now.getTime()
  const age = nowMs - heartbeatMs
  if (age < 0 || age > expected.heartbeatLimit) {
    return {
      status: 'unavailable',
      reasonCode: age < 0 ? 'daemon_lease_heartbeat_future' : 'daemon_lease_heartbeat_stale',
      details: { heartbeat_age_ms: Math.max(0, age) },
    }
  }
  return {
    status: 'ready',
    reasonCode: 'daemon_lease_verified',
    details: { heartbeat_age_ms: age },
  }
}

function driverProbe(input: RuntimeDriverHealth): {
  status: 'ready' | 'degraded' | 'unavailable'
  reasonCode: string
  details: Record<string, unknown>
} {
  const registered = count(input.registered, 'registered driver count')
  const ready = count(input.ready, 'ready driver count')
  if (ready > registered) throw new Error('ready driver count exceeds registered count')
  const status = registered === 0 || ready === 0
    ? 'unavailable'
    : ready < registered ? 'degraded' : 'ready'
  return {
    status,
    reasonCode: status === 'ready' ? 'drivers_ready'
      : status === 'degraded' ? 'drivers_partially_ready' : 'drivers_unavailable',
    details: { registered, ready },
  }
}

function providerProbe(input: RuntimeProviderHealth): {
  status: 'ready' | 'degraded' | 'unavailable'
  reasonCode: string
  details: Record<string, unknown>
} {
  const configured = count(input.configured, 'configured provider count')
  const ready = count(input.ready, 'ready provider count')
  const degraded = count(input.degraded, 'degraded provider count')
  const unavailable = count(input.unavailable, 'unavailable provider count')
  if (ready + degraded + unavailable !== configured) {
    throw new Error('provider health counts do not match configured count')
  }
  const status = configured === 0 || ready === 0
    ? 'unavailable'
    : degraded > 0 || unavailable > 0 ? 'degraded' : 'ready'
  return {
    status,
    reasonCode: status === 'ready' ? 'providers_ready'
      : status === 'degraded' ? 'providers_partially_ready' : 'providers_unavailable',
    details: { configured, ready, degraded, unavailable },
  }
}

function ptyProbe(input: RuntimePtyHealth): {
  status: 'ready' | 'degraded' | 'unavailable'
  reasonCode: string
  details: Record<string, unknown>
} {
  const lostProcesses = count(input.lostProcesses, 'lost process count')
  const status = !input.responsive || !input.reconciled
    ? 'unavailable'
    : lostProcesses > 0 ? 'degraded' : 'ready'
  return {
    status,
    reasonCode: status === 'ready' ? 'pty_supervisor_ready'
      : status === 'degraded' ? 'pty_processes_lost' : 'pty_supervisor_unavailable',
    details: { lost_processes: lostProcesses },
  }
}

function hooksProbe(input: RuntimeHooksHealth): {
  status: 'ready' | 'unavailable'
  reasonCode: string
} {
  if (typeof input.enabled !== 'boolean' || typeof input.coherent !== 'boolean') {
    throw new Error('invalid hooks health result')
  }
  if (!input.enabled) return { status: 'ready', reasonCode: 'hooks_not_enabled' }
  return input.coherent
    ? { status: 'ready', reasonCode: 'hooks_coherent' }
    : { status: 'unavailable', reasonCode: 'hooks_incoherent' }
}

function tunnelProbe(
  input: VerifiedTunnelHealth,
  now: Date,
  maxAgeMs: number,
): {
  status: 'ready' | 'unavailable' | 'disabled'
  reasonCode: string
  observedAt?: string
  details?: Record<string, unknown>
} {
  if (typeof input.enabled !== 'boolean') throw new Error('invalid tunnel health result')
  if (!input.enabled) return { status: 'disabled', reasonCode: 'tunnel_not_enabled' }
  if (!['tailscale', 'cloudflared'].includes(input.transport)) {
    throw new Error('invalid tunnel transport')
  }
  const checkedAtMs = canonicalTimestamp(input.checkedAt, 'tunnel verification time')
  const age = now.getTime() - checkedAtMs
  if (age < 0 || age > maxAgeMs) {
    return {
      status: 'unavailable',
      reasonCode: age < 0 ? 'tunnel_verification_future' : 'tunnel_verification_stale',
      observedAt: input.checkedAt,
      details: { transport: input.transport, verification_age_ms: Math.max(0, age) },
    }
  }
  if (!input.reachable) {
    return {
      status: 'unavailable',
      reasonCode: 'tunnel_unreachable',
      observedAt: input.checkedAt,
      details: { transport: input.transport, verification_age_ms: age },
    }
  }
  if (!input.endToEndVerified || !input.originVerified || !input.authenticationVerified) {
    return {
      status: 'unavailable',
      reasonCode: 'tunnel_verification_incomplete',
      observedAt: input.checkedAt,
      details: { transport: input.transport, verification_age_ms: age },
    }
  }
  return {
    status: 'ready',
    reasonCode: 'tunnel_end_to_end_verified',
    observedAt: input.checkedAt,
    details: { transport: input.transport, verification_age_ms: age },
  }
}

function trustedNow(clock: () => Date): Date {
  let value: Date
  try { value = clock() } catch { throw new Error('operations runtime clock unavailable') }
  if (!(value instanceof Date)) throw new Error('operations runtime clock unavailable')
  const timestamp = Date.prototype.getTime.call(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('operations runtime clock unavailable')
  }
  return new Date(timestamp)
}

function canonicalTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${field} must be a canonical UTC timestamp`)
  }
  const timestamp = Date.parse(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC timestamp`)
  }
  return timestamp
}

function defaultProcessIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function safeLeaseName(value: string): string {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(value)) throw new Error('invalid daemon lease name')
  return value
}

function safeLeaseOwner(value: string): string {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value)) throw new Error('invalid daemon lease owner')
  return value
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function count(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function boundedDuration(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum} milliseconds`)
  }
  return value
}

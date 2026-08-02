import { safeOperationalIdentifier } from './redaction.js'

export const OPERATIONS_METRICS = Object.freeze([
  'queue_depth',
  'launch_latency_ms',
  'active_sessions',
  'provider_errors_total',
  'recovery_results_total',
  'projection_lag_ms',
  'retry_attempts',
  'outbox_lag_ms',
  'device_revoke_propagation_pending',
  'rate_limit_rejections_total',
  'capacity_rejections_total',
  'dropped_logs_total',
] as const)

export type OperationsMetricName = typeof OPERATIONS_METRICS[number]

export interface OperationsMetricSample {
  name: OperationsMetricName
  value: number
  labels: Readonly<Record<string, string>>
  observed_at: string
}

export interface OperationsMetricsOptions {
  clock?: () => Date
  maxSeries?: number
}

/** A bounded-cardinality in-process registry suitable for local diagnostics or an exporter. */
export class OperationsMetrics {
  private readonly samples = new Map<string, OperationsMetricSample>()
  private readonly clock: () => Date
  private readonly maxSeries: number

  constructor(options: OperationsMetricsOptions = {}) {
    this.clock = options.clock ?? (() => new Date())
    this.maxSeries = boundedInteger(options.maxSeries ?? 512, 9, 10_000, 'metric series capacity')
  }

  set(
    name: Exclude<OperationsMetricName, `${string}_total`>,
    value: number,
    labels: Record<string, string> = {},
  ): void {
    this.write(name, value, labels, false)
  }

  increment(
    name: Extract<OperationsMetricName, `${string}_total`>,
    by = 1,
    labels: Record<string, string> = {},
  ): void {
    if (!Number.isFinite(by) || by < 0) throw new Error('metric increment must be non-negative')
    const normalized = normalizeLabels(labels)
    const key = metricKey(name, normalized)
    const current = this.samples.get(key)?.value ?? 0
    this.write(name, current + by, normalized, true)
  }

  snapshot(): ReadonlyArray<Readonly<OperationsMetricSample>> {
    return [...this.samples.values()]
      .sort((left, right) => metricKey(left.name, left.labels)
        .localeCompare(metricKey(right.name, right.labels)))
      .map((sample) => Object.freeze({ ...sample, labels: Object.freeze({ ...sample.labels }) }))
  }

  value(name: OperationsMetricName, labels: Record<string, string> = {}): number | undefined {
    return this.samples.get(metricKey(name, normalizeLabels(labels)))?.value
  }

  private write(
    name: OperationsMetricName,
    value: number,
    labels: Record<string, string>,
    labelsAlreadyNormalized: boolean,
  ): void {
    if (!OPERATIONS_METRICS.includes(name)) throw new Error(`unknown operations metric: ${name}`)
    if (!Number.isFinite(value) || value < 0) throw new Error('metric value must be non-negative')
    const normalized = labelsAlreadyNormalized ? labels : normalizeLabels(labels)
    const key = metricKey(name, normalized)
    if (!this.samples.has(key) && this.samples.size >= this.maxSeries) {
      throw new Error('operations metric series capacity exceeded')
    }
    this.samples.set(key, {
      name,
      value,
      labels: Object.freeze({ ...normalized }),
      observed_at: this.clock().toISOString(),
    })
  }
}

export type OperationsAlertSeverity = 'warning' | 'critical'

export interface OperationsAlert {
  key: string
  type:
    | 'stuck_job'
    | 'repeated_retries'
    | 'lost_process'
    | 'projection_lag'
    | 'remote_intent_stalled'
    | 'auth_flood'
    | 'pairing_replay'
    | 'step_up_replay'
    | 'lost_device_purge_failed'
    | 'token_storm'
    | 'rate_limit_storm'
  severity: OperationsAlertSeverity
  first_observed_at: string
  last_observed_at: string
  occurrences: number
  correlation_id?: string
  job_id?: string
  session_id?: string
  device_id?: string
  reason_code: string
}

export interface OperationsAlertSignals {
  jobs?: ReadonlyArray<{
    jobId: string
    correlationId?: string
    ageMs: number
    attempts: number
    status: 'queued' | 'running' | 'cancelling' | 'blocked'
  }>
  lostProcesses?: ReadonlyArray<{ sessionId: string; jobId?: string }>
  projectionLagMs?: number
  staleRemoteAuthorizedIntents?: number
  authenticationDenials?: number
  pairingReplays?: number
  stepUpReplays?: number
  failedLostDevicePurges?: number
  tokensPerMinute?: number
  rateLimitRejections?: number
  deviceId?: string
}

export interface OperationsAlertThresholds {
  stuckJobMs: number
  repeatedRetries: number
  projectionLagMs: number
  tokenStormPerMinute: number
  rateLimitStorm: number
  cooldownMs: number
}

export interface OperationsAlertEngineOptions {
  maxTrackedAlerts?: number
  stateTtlMs?: number
}

const DEFAULT_THRESHOLDS: OperationsAlertThresholds = Object.freeze({
  stuckJobMs: 15 * 60_000,
  repeatedRetries: 3,
  projectionLagMs: 60_000,
  tokenStormPerMinute: 100_000,
  rateLimitStorm: 25,
  cooldownMs: 5 * 60_000,
})

/** Evaluates explicit privacy-safe signals and deduplicates alerts by opaque resource ID. */
export class OperationsAlertEngine {
  private readonly state = new Map<string, OperationsAlert>()
  private readonly maxTrackedAlerts: number
  private readonly stateTtlMs: number

  constructor(
    private readonly thresholds: OperationsAlertThresholds = DEFAULT_THRESHOLDS,
    private readonly clock: () => Date = () => new Date(),
    options: OperationsAlertEngineOptions = {},
  ) {
    for (const value of Object.values(thresholds)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid alert threshold')
    }
    this.maxTrackedAlerts = boundedInteger(
      options.maxTrackedAlerts ?? 2_048,
      1,
      100_000,
      'tracked alert capacity',
    )
    this.stateTtlMs = boundedInteger(
      options.stateTtlMs ?? Math.max(24 * 60 * 60_000, thresholds.cooldownMs),
      Math.max(1, thresholds.cooldownMs),
      365 * 24 * 60 * 60_000,
      'alert state TTL',
    )
  }

  evaluate(signals: OperationsAlertSignals): OperationsAlert[] {
    const candidates: Array<Omit<OperationsAlert, 'first_observed_at' | 'last_observed_at' | 'occurrences'>> = []
    for (const job of signals.jobs ?? []) {
      const jobId = safeOperationalIdentifier(job.jobId)
      if (!jobId) continue
      if (job.ageMs >= this.thresholds.stuckJobMs) {
        candidates.push({
          key: `stuck_job:${jobId}`,
          type: 'stuck_job',
          severity: job.status === 'cancelling' ? 'critical' : 'warning',
          job_id: jobId,
          correlation_id: safeOperationalIdentifier(job.correlationId),
          reason_code: `job_${job.status}_too_long`,
        })
      }
      if (job.attempts >= this.thresholds.repeatedRetries) {
        candidates.push({
          key: `repeated_retries:${jobId}`,
          type: 'repeated_retries',
          severity: 'warning',
          job_id: jobId,
          correlation_id: safeOperationalIdentifier(job.correlationId),
          reason_code: 'retry_threshold_exceeded',
        })
      }
    }
    for (const process of signals.lostProcesses ?? []) {
      const sessionId = safeOperationalIdentifier(process.sessionId)
      if (!sessionId) continue
      candidates.push({
        key: `lost_process:${sessionId}`,
        type: 'lost_process',
        severity: 'critical',
        session_id: sessionId,
        job_id: safeOperationalIdentifier(process.jobId),
        reason_code: 'supervisor_process_missing',
      })
    }
    if ((signals.projectionLagMs ?? 0) >= this.thresholds.projectionLagMs) {
      candidates.push({
        key: 'projection_lag:global', type: 'projection_lag', severity: 'warning',
        reason_code: 'projection_lag_threshold_exceeded',
      })
    }
    if ((signals.staleRemoteAuthorizedIntents ?? 0) > 0) {
      candidates.push({
        key: 'remote_intent_stalled:global',
        type: 'remote_intent_stalled',
        severity: 'critical',
        reason_code: 'remote_authorized_intent_without_terminal_evidence',
      })
    }
    if ((signals.authenticationDenials ?? 0) >= this.thresholds.rateLimitStorm) {
      candidates.push({
        key: 'auth_flood:global', type: 'auth_flood', severity: 'critical',
        reason_code: 'remote_authentication_denial_storm',
      })
    }
    if ((signals.pairingReplays ?? 0) > 0) {
      candidates.push({
        key: 'pairing_replay:global', type: 'pairing_replay', severity: 'warning',
        reason_code: 'pairing_ticket_replay_observed',
      })
    }
    if ((signals.stepUpReplays ?? 0) > 0) {
      candidates.push({
        key: 'step_up_replay:global', type: 'step_up_replay', severity: 'critical',
        reason_code: 'remote_step_up_replay_observed',
      })
    }
    if ((signals.failedLostDevicePurges ?? 0) > 0) {
      candidates.push({
        key: 'lost_device_purge_failed:global', type: 'lost_device_purge_failed',
        severity: 'critical', reason_code: 'revoked_device_artifact_or_propagation_failure',
      })
    }
    if ((signals.tokensPerMinute ?? 0) >= this.thresholds.tokenStormPerMinute) {
      candidates.push({
        key: 'token_storm:global', type: 'token_storm', severity: 'critical',
        reason_code: 'token_rate_threshold_exceeded',
      })
    }
    if ((signals.rateLimitRejections ?? 0) >= this.thresholds.rateLimitStorm) {
      const deviceId = safeOperationalIdentifier(signals.deviceId)
      candidates.push({
        key: `rate_limit_storm:${deviceId ?? 'anonymous'}`,
        type: 'rate_limit_storm', severity: 'warning', device_id: deviceId,
        reason_code: 'rate_limit_rejection_storm',
      })
    }

    const now = this.clock().toISOString()
    const nowMs = Date.parse(now)
    this.evictExpired(nowMs)
    const emitted: OperationsAlert[] = []
    for (const candidate of candidates) {
      const existing = this.state.get(candidate.key)
      if (!existing) this.reserve(candidate.key)
      const alert: OperationsAlert = {
        ...candidate,
        first_observed_at: existing?.first_observed_at ?? now,
        last_observed_at: now,
        occurrences: (existing?.occurrences ?? 0) + 1,
      }
      this.state.set(candidate.key, alert)
      const elapsed = existing
        ? Date.parse(now) - Date.parse(existing.last_observed_at)
        : Number.POSITIVE_INFINITY
      if (!existing || elapsed >= this.thresholds.cooldownMs) emitted.push({ ...alert })
    }
    return emitted
  }

  statistics(): Readonly<{ tracked: number; capacity: number; state_ttl_ms: number }> {
    return Object.freeze({
      tracked: this.state.size,
      capacity: this.maxTrackedAlerts,
      state_ttl_ms: this.stateTtlMs,
    })
  }

  private evictExpired(nowMs: number): void {
    for (const [key, alert] of this.state) {
      if (nowMs - Date.parse(alert.last_observed_at) > this.stateTtlMs) this.state.delete(key)
    }
  }

  private reserve(key: string): void {
    if (this.state.has(key) || this.state.size < this.maxTrackedAlerts) return
    let oldestKey: string | undefined
    let oldestTimestamp = Number.POSITIVE_INFINITY
    for (const [candidateKey, alert] of this.state) {
      const timestamp = Date.parse(alert.last_observed_at)
      if (timestamp < oldestTimestamp) {
        oldestTimestamp = timestamp
        oldestKey = candidateKey
      }
    }
    if (oldestKey) this.state.delete(oldestKey)
  }
}

const ALLOWED_LABELS = new Set(['provider', 'result', 'priority', 'component'])

function normalizeLabels(labels: Record<string, string>): Record<string, string> {
  if (Object.keys(labels).length > 4) throw new Error('too many metric labels')
  const normalized: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(labels)) {
    if (!ALLOWED_LABELS.has(key)) throw new Error(`metric label not allowed: ${key}`)
    const value = safeOperationalIdentifier(rawValue)
    if (!value) throw new Error(`invalid metric label value: ${key}`)
    normalized[key] = value
  }
  return normalized
}

function metricKey(name: OperationsMetricName, labels: Readonly<Record<string, string>>): string {
  return `${name}|${Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join(',')}`
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

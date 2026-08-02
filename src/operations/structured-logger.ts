import {
  redactOperationsValue,
  safeOperationalEventName,
  safeOperationalIdentifier,
} from './redaction.js'

export type OperationsLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type OperationsLogOutcome = 'allowed' | 'denied' | 'succeeded' | 'failed' | 'degraded'

export interface OperationsLogContext {
  correlationId?: string | null
  jobId?: string | null
  sessionId?: string | null
  deviceId?: string | null
}

export interface OperationsLogInput extends OperationsLogContext {
  level: OperationsLogLevel
  event: string
  outcome?: OperationsLogOutcome
  component?: string
  reasonCode?: string
  attributes?: Record<string, unknown>
}

export interface StructuredOperationsLog {
  timestamp: string
  level: OperationsLogLevel
  event: string
  outcome?: OperationsLogOutcome
  component?: string
  reason_code?: string
  correlation_id?: string
  job_id?: string
  session_id?: string
  device_id?: string
  attributes: Record<string, unknown>
  redactions: number
}

export type OperationsLogSink = (entry: Readonly<StructuredOperationsLog>) => void

export interface StructuredOperationsLoggerOptions {
  capacity?: number
  clock?: () => Date
  sink?: OperationsLogSink
}

/**
 * A bounded, structured logger. It deliberately has no free-form message field: event names and
 * reason codes are stable vocabulary while arbitrary diagnostic material belongs in attributes
 * and is redacted before either memory retention or sink delivery.
 */
export class StructuredOperationsLogger {
  private readonly entries: StructuredOperationsLog[] = []
  private readonly capacity: number
  private readonly clock: () => Date
  private readonly sink?: OperationsLogSink
  private dropped = 0
  private sinkFailures = 0

  constructor(options: StructuredOperationsLoggerOptions = {}) {
    this.capacity = boundedInteger(options.capacity ?? 2_000, 1, 50_000, 'log capacity')
    this.clock = options.clock ?? (() => new Date())
    this.sink = options.sink
  }

  log(input: OperationsLogInput): Readonly<StructuredOperationsLog> {
    const redacted = redactOperationsValue(input.attributes ?? {})
    const entry = immutableClone(compact({
      timestamp: this.clock().toISOString(),
      level: input.level,
      event: safeOperationalEventName(input.event),
      outcome: input.outcome,
      component: safeOperationalIdentifier(input.component),
      reason_code: safeOperationalIdentifier(input.reasonCode),
      correlation_id: safeOperationalIdentifier(input.correlationId),
      job_id: safeOperationalIdentifier(input.jobId),
      session_id: safeOperationalIdentifier(input.sessionId),
      device_id: safeOperationalIdentifier(input.deviceId),
      attributes: redacted.value,
      redactions: redacted.redactions,
    })) as Readonly<StructuredOperationsLog>

    if (this.entries.length === this.capacity) {
      this.entries.shift()
      this.dropped += 1
    }
    this.entries.push(entry as StructuredOperationsLog)
    try {
      this.sink?.(immutableClone(entry))
    } catch {
      // The bounded in-memory entry remains available for diagnostics. Durable security audit is
      // a separate fail-closed boundary and must not rely on this observability sink.
      this.sinkFailures += 1
    }
    return immutableClone(entry)
  }

  recent(limit = 200): ReadonlyArray<Readonly<StructuredOperationsLog>> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('log limit must be a non-negative integer')
    const count = Math.min(limit, this.capacity)
    return this.entries.slice(Math.max(0, this.entries.length - count))
      .map((entry) => immutableClone(entry))
  }

  statistics(): Readonly<{
    retained: number
    dropped: number
    sink_failures: number
    capacity: number
  }> {
    return Object.freeze({
      retained: this.entries.length,
      dropped: this.dropped,
      sink_failures: this.sinkFailures,
      capacity: this.capacity,
    })
  }
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T
}

function immutableClone<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableClone(item))) as T
  }
  const clone = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, immutableClone(item)]),
  )
  return Object.freeze(clone) as T
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

import { redactOperationsValue } from './redaction.js'

export const OPERATIONS_HEALTH_COMPONENTS = Object.freeze([
  'database',
  'daemon_lease',
  'drivers',
  'providers',
  'pty_supervisor',
  'hooks',
  'tunnels',
  'credentials',
  'observability',
] as const)

export type OperationsHealthComponent = typeof OPERATIONS_HEALTH_COMPONENTS[number]
export type OperationsHealthStatus = 'ready' | 'degraded' | 'unavailable' | 'disabled'

export interface OperationsHealthProbeResult {
  status: OperationsHealthStatus
  reasonCode?: string
  observedAt?: string
  latencyMs?: number
  details?: Record<string, unknown>
}

export interface OperationsHealthProbe {
  component: OperationsHealthComponent
  required: boolean
  timeoutMs?: number
  check(): Promise<OperationsHealthProbeResult> | OperationsHealthProbeResult
}

export interface OperationsHealthComponentResult extends OperationsHealthProbeResult {
  component: OperationsHealthComponent
  required: boolean
}

export interface OperationsHealthSnapshot {
  status: 'ready' | 'degraded' | 'unavailable'
  checked_at: string
  duration_ms: number
  components: OperationsHealthComponentResult[]
}

export interface OperationsHealthServiceOptions {
  clock?: () => Date
  defaultTimeoutMs?: number
}

/** Runs every registered subsystem probe concurrently with a fail-closed timeout. */
export class OperationsHealthService {
  private readonly clock: () => Date
  private readonly defaultTimeoutMs: number

  constructor(
    private readonly probes: readonly OperationsHealthProbe[],
    options: OperationsHealthServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date())
    this.defaultTimeoutMs = boundedTimeout(options.defaultTimeoutMs ?? 2_000)
    const names = new Set<OperationsHealthComponent>()
    for (const probe of probes) {
      if (names.has(probe.component)) throw new Error(`duplicate health probe: ${probe.component}`)
      names.add(probe.component)
    }
    for (const component of OPERATIONS_HEALTH_COMPONENTS) {
      if (!names.has(component)) throw new Error(`missing health probe: ${component}`)
    }
  }

  async check(): Promise<OperationsHealthSnapshot> {
    const started = performance.now()
    const checkedAt = this.clock().toISOString()
    const components = await Promise.all(this.probes.map(async (probe) => {
      const componentStarted = performance.now()
      try {
        const result = await withTimeout(
          Promise.resolve().then(() => probe.check()),
          boundedTimeout(probe.timeoutMs ?? this.defaultTimeoutMs),
        )
        const status = normalizeStatus(result.status, probe.required)
        const redacted = redactOperationsValue(result.details ?? {})
        return {
          component: probe.component,
          required: probe.required,
          status,
          reasonCode: status === 'unavailable' && result.status === 'disabled' && probe.required
            ? 'required_component_disabled'
            : safeReasonCode(result.reasonCode),
          observedAt: result.observedAt ?? checkedAt,
          latencyMs: finiteLatency(result.latencyMs ?? performance.now() - componentStarted),
          details: redacted.value,
        } satisfies OperationsHealthComponentResult
      } catch (error) {
        return {
          component: probe.component,
          required: probe.required,
          status: 'unavailable',
          reasonCode: error instanceof ProbeTimeoutError ? 'probe_timeout' : 'probe_failed',
          observedAt: checkedAt,
          latencyMs: finiteLatency(performance.now() - componentStarted),
          details: {},
        } satisfies OperationsHealthComponentResult
      }
    }))

    const requiredUnavailable = components.some((item) =>
      item.required && item.status === 'unavailable')
    const anyImpaired = components.some((item) =>
      item.status === 'degraded' || item.status === 'unavailable')
    return Object.freeze({
      status: requiredUnavailable ? 'unavailable' : anyImpaired ? 'degraded' : 'ready',
      checked_at: checkedAt,
      duration_ms: finiteLatency(performance.now() - started),
      components,
    })
  }

  /** Public bootstrap representation: no component, provider, tunnel, or version fingerprint. */
  publicStatus(snapshot: OperationsHealthSnapshot): Readonly<{
    live: true
    ready: boolean
  }> {
    return Object.freeze({ live: true, ready: snapshot.status !== 'unavailable' })
  }
}

class ProbeTimeoutError extends Error {}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeoutError('health probe timed out')), timeoutMs)
    timer.unref()
    operation.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 30_000) {
    throw new Error('health timeout must be an integer from 10 to 30000 milliseconds')
  }
  return value
}

function finiteLatency(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : 0
}

function safeReasonCode(value: string | undefined): string | undefined {
  return value && /^[a-z][a-z0-9_.-]{0,63}$/.test(value) ? value : undefined
}

function normalizeStatus(value: unknown, required: boolean): OperationsHealthStatus {
  if (!['ready', 'degraded', 'unavailable', 'disabled'].includes(String(value))) {
    throw new Error('invalid health status')
  }
  return required && value === 'disabled' ? 'unavailable' : value as OperationsHealthStatus
}

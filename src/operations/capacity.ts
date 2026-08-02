import { privacySafePartition, safeOperationalIdentifier } from './redaction.js'

export type CapacityPriority = 'interactive' | 'normal' | 'background'
export type CapacityDecision = 'start' | 'queue' | 'reject'

export interface CapacityRequest {
  requestId: string
  provider: string
  priority: CapacityPriority
}

export interface CapacityAdmission {
  decision: CapacityDecision
  reason_code: 'capacity_available' | 'queued_backpressure' | 'queue_full' | 'provider_saturated'
  retry_after_ms?: number
}

export interface CapacityControllerOptions {
  maxActiveSessions: number
  maxQueueDepth: number
  maxActivePerProvider: number
  reservedInteractiveSlots?: number
  retryAfterMs?: number
}

/**
 * Bounded admission controller with interactive reserve and background load shedding. It holds
 * only opaque request IDs and never buffers command bodies, prompts, credentials, or PTY data.
 */
export class CapacityController {
  private readonly active = new Map<string, string>()
  private readonly activeByProvider = new Map<string, number>()
  private readonly queued = new Map<string, CapacityRequest>()
  private readonly options: Required<CapacityControllerOptions>

  constructor(options: CapacityControllerOptions) {
    this.options = {
      ...options,
      reservedInteractiveSlots: options.reservedInteractiveSlots ?? 1,
      retryAfterMs: options.retryAfterMs ?? 1_000,
    }
    validateCapacityOptions(this.options)
  }

  admit(request: CapacityRequest): CapacityAdmission {
    const normalized = normalizeCapacityRequest(request)
    if (this.active.has(normalized.requestId)) {
      return { decision: 'start', reason_code: 'capacity_available' }
    }
    if (this.queued.has(normalized.requestId)) {
      return { decision: 'queue', reason_code: 'queued_backpressure', retry_after_ms: this.options.retryAfterMs }
    }

    const providerActive = this.activeByProvider.get(normalized.provider) ?? 0
    const providerAvailable = providerActive < this.options.maxActivePerProvider
    const globalAvailable = this.hasGlobalSlot(normalized.priority)
    if (providerAvailable && globalAvailable) {
      this.active.set(normalized.requestId, normalized.provider)
      this.activeByProvider.set(normalized.provider, providerActive + 1)
      return { decision: 'start', reason_code: 'capacity_available' }
    }

    if (normalized.priority === 'background' || this.queued.size >= this.options.maxQueueDepth) {
      return {
        decision: 'reject',
        reason_code: this.queued.size >= this.options.maxQueueDepth ? 'queue_full' : 'provider_saturated',
        retry_after_ms: this.options.retryAfterMs,
      }
    }

    this.queued.set(normalized.requestId, normalized)
    return { decision: 'queue', reason_code: 'queued_backpressure', retry_after_ms: this.options.retryAfterMs }
  }

  release(requestId: string): void {
    const normalized = safeOperationalIdentifier(requestId)
    if (!normalized) return
    const provider = this.active.get(normalized)
    if (!provider) return
    this.active.delete(normalized)
    const next = Math.max(0, (this.activeByProvider.get(provider) ?? 1) - 1)
    if (next === 0) this.activeByProvider.delete(provider)
    else this.activeByProvider.set(provider, next)
  }

  /** Rebuilds active authority from durable sessions before evaluating a new launch. */
  reconcileActive(requests: readonly CapacityRequest[]): void {
    const next = new Map<string, string>()
    const counts = new Map<string, number>()
    for (const request of requests) {
      const normalized = normalizeCapacityRequest(request)
      if (next.has(normalized.requestId)) continue
      next.set(normalized.requestId, normalized.provider)
    }
    for (const provider of next.values()) counts.set(provider, (counts.get(provider) ?? 0) + 1)
    this.active.clear()
    this.activeByProvider.clear()
    for (const [id, provider] of next) this.active.set(id, provider)
    for (const [provider, count] of counts) this.activeByProvider.set(provider, count)
  }

  cancelQueued(requestId: string): boolean {
    const normalized = safeOperationalIdentifier(requestId)
    return normalized ? this.queued.delete(normalized) : false
  }

  drain(limit = 1): CapacityRequest[] {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.options.maxActiveSessions) {
      throw new Error('invalid drain limit')
    }
    const ranked = [...this.queued.values()].sort((left, right) =>
      priorityRank(left.priority) - priorityRank(right.priority))
    const started: CapacityRequest[] = []
    for (const request of ranked) {
      if (started.length >= limit) break
      const providerActive = this.activeByProvider.get(request.provider) ?? 0
      if (providerActive >= this.options.maxActivePerProvider || !this.hasGlobalSlot(request.priority)) continue
      this.queued.delete(request.requestId)
      this.active.set(request.requestId, request.provider)
      this.activeByProvider.set(request.provider, providerActive + 1)
      started.push({ ...request })
    }
    return started
  }

  snapshot(): Readonly<{
    active_sessions: number
    queue_depth: number
    max_active_sessions: number
    max_queue_depth: number
    active_by_provider: Readonly<Record<string, number>>
  }> {
    return Object.freeze({
      active_sessions: this.active.size,
      queue_depth: this.queued.size,
      max_active_sessions: this.options.maxActiveSessions,
      max_queue_depth: this.options.maxQueueDepth,
      active_by_provider: Object.freeze(Object.fromEntries(this.activeByProvider)),
    })
  }

  private hasGlobalSlot(priority: CapacityPriority): boolean {
    const ordinaryLimit = this.options.maxActiveSessions - this.options.reservedInteractiveSlots
    return priority === 'interactive'
      ? this.active.size < this.options.maxActiveSessions
      : this.active.size < ordinaryLimit
  }
}

export type RateLimitFamily = 'request' | 'command' | 'provider'

export interface RateLimitRule {
  family: RateLimitFamily
  limit: number
  windowMs: number
}

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  retry_after_ms: number
  partition: string
  reason_code: 'allowed' | 'limit_exceeded' | 'partition_capacity' | 'clock_unavailable'
}

export interface OperationsRateLimiterOptions {
  rules: readonly RateLimitRule[]
  partitionSalt: string
  maxPartitions?: number
  clock?: () => number
}

/** Fixed-window limiter for request, command, and provider families with hashed partitions. */
export class OperationsRateLimiter {
  private readonly rules = new Map<RateLimitFamily, RateLimitRule>()
  private readonly buckets = new Map<string, { count: number; resetAt: number }>()
  private readonly maxPartitions: number
  private readonly clock: () => number
  private lastNow = -1

  constructor(private readonly options: OperationsRateLimiterOptions) {
    this.maxPartitions = options.maxPartitions ?? 10_000
    this.clock = options.clock ?? (() => Date.now())
    if (!Number.isSafeInteger(this.maxPartitions) || this.maxPartitions < 1) {
      throw new Error('invalid rate-limit partition capacity')
    }
    for (const rule of options.rules) {
      if (this.rules.has(rule.family)) throw new Error(`duplicate rate-limit rule: ${rule.family}`)
      if (!Number.isSafeInteger(rule.limit) || rule.limit < 1
        || !Number.isSafeInteger(rule.windowMs) || rule.windowMs < 100) {
        throw new Error('invalid rate-limit rule')
      }
      this.rules.set(rule.family, { ...rule })
    }
    for (const family of ['request', 'command', 'provider'] as const) {
      if (!this.rules.has(family)) throw new Error(`missing rate-limit rule: ${family}`)
    }
  }

  consume(family: RateLimitFamily, rawPartition: string): RateLimitDecision {
    const rule = this.rules.get(family)
    if (!rule) throw new Error(`unknown rate-limit family: ${family}`)
    const partition = privacySafePartition(rawPartition, this.options.partitionSalt)
    const key = `${family}:${partition}`
    const now = this.clock()
    if (!Number.isSafeInteger(now) || now < 0 || now < this.lastNow
      || !Number.isSafeInteger(now + rule.windowMs)) {
      return {
        allowed: false,
        remaining: 0,
        retry_after_ms: rule.windowMs,
        partition,
        reason_code: 'clock_unavailable',
      }
    }
    this.lastNow = now
    let bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && this.buckets.size >= this.maxPartitions) this.evictExpired(now)
      if (!bucket && this.buckets.size >= this.maxPartitions) {
        return {
          allowed: false,
          remaining: 0,
          retry_after_ms: rule.windowMs,
          partition,
          reason_code: 'partition_capacity',
        }
      }
      bucket = { count: 0, resetAt: now + rule.windowMs }
      this.buckets.set(key, bucket)
    }
    bucket.count += 1
    const allowed = bucket.count <= rule.limit
    return {
      allowed,
      remaining: Math.max(0, rule.limit - bucket.count),
      retry_after_ms: allowed ? 0 : Math.max(1, bucket.resetAt - now),
      partition,
      reason_code: allowed ? 'allowed' : 'limit_exceeded',
    }
  }

  statistics(): Readonly<{ partitions: number; capacity: number }> {
    return Object.freeze({ partitions: this.buckets.size, capacity: this.maxPartitions })
  }

  private evictExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }
}

function normalizeCapacityRequest(request: CapacityRequest): CapacityRequest {
  const requestId = safeOperationalIdentifier(request.requestId)
  const provider = safeOperationalIdentifier(request.provider)
  if (!requestId || !provider) throw new Error('capacity request requires opaque request and provider identifiers')
  if (!['interactive', 'normal', 'background'].includes(request.priority)) {
    throw new Error('invalid capacity priority')
  }
  return { requestId, provider, priority: request.priority }
}

function validateCapacityOptions(options: Required<CapacityControllerOptions>): void {
  for (const [key, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid capacity option: ${key}`)
  }
  if (options.maxActiveSessions < 1 || options.maxActivePerProvider < 1) {
    throw new Error('capacity must allow at least one active session')
  }
  if (options.reservedInteractiveSlots >= options.maxActiveSessions) {
    throw new Error('interactive reserve must be lower than total active capacity')
  }
}

function priorityRank(priority: CapacityPriority): number {
  return priority === 'interactive' ? 0 : priority === 'normal' ? 1 : 2
}

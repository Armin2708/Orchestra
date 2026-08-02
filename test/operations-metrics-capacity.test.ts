import { describe, expect, it } from 'vitest'
import {
  CapacityController,
  OperationsAlertEngine,
  OperationsMetrics,
  OperationsRateLimiter,
} from '../src/operations/index.js'

describe('operations metrics, alerts, capacity and rate limits', () => {
  it('records the required bounded-cardinality metrics and rejects identity labels', () => {
    const metrics = new OperationsMetrics({
      clock: () => new Date('2026-08-02T11:00:00.000Z'),
      maxSeries: 12,
    })
    metrics.set('queue_depth', 12)
    metrics.set('launch_latency_ms', 420, { provider: 'codex' })
    metrics.set('active_sessions', 8, { provider: 'claude' })
    metrics.increment('provider_errors_total', 2, { provider: 'codex' })
    metrics.increment('recovery_results_total', 1, { result: 'reattached' })
    metrics.set('projection_lag_ms', 100)
    metrics.set('retry_attempts', 3)
    metrics.set('outbox_lag_ms', 2_000)
    metrics.set('device_revoke_propagation_pending', 1)
    metrics.increment('rate_limit_rejections_total', 1, { component: 'auth' })
    metrics.increment('capacity_rejections_total', 3, { priority: 'background' })
    metrics.increment('dropped_logs_total', 4)

    expect(metrics.snapshot()).toHaveLength(12)
    expect(metrics.value('provider_errors_total', { provider: 'codex' })).toBe(2)
    expect(() => metrics.increment('provider_errors_total', 1, { device_id: 'phone-a' }))
      .toThrow('metric label not allowed')
    expect(() => metrics.increment('provider_errors_total', 1, { provider: 'codex' }))
      .not.toThrow()
    expect(() => metrics.increment('provider_errors_total', 1, { provider: 'new-provider' }))
      .toThrow('series capacity exceeded')
  })

  it('emits deduplicated stuck/retry/lost/projection/token/rate alerts using identifiers only', () => {
    let now = Date.parse('2026-08-02T12:00:00.000Z')
    const engine = new OperationsAlertEngine({
      stuckJobMs: 1_000,
      repeatedRetries: 3,
      projectionLagMs: 500,
      tokenStormPerMinute: 1_000,
      rateLimitStorm: 10,
      cooldownMs: 5_000,
    }, () => new Date(now))
    const signals = {
      jobs: [{ jobId: 'job-1', correlationId: 'corr-1', ageMs: 2_000, attempts: 3, status: 'running' as const }],
      lostProcesses: [{ sessionId: 'session-1', jobId: 'job-1' }],
      projectionLagMs: 600,
      staleRemoteAuthorizedIntents: 1,
      authenticationDenials: 11,
      pairingReplays: 1,
      stepUpReplays: 1,
      failedLostDevicePurges: 1,
      tokensPerMinute: 2_000,
      rateLimitRejections: 11,
      deviceId: 'phone-a',
    }

    const first = engine.evaluate(signals)
    expect(first.map((item) => item.type).sort()).toEqual([
      'auth_flood', 'lost_device_purge_failed', 'lost_process', 'pairing_replay',
      'projection_lag', 'rate_limit_storm', 'remote_intent_stalled', 'repeated_retries',
      'step_up_replay', 'stuck_job', 'token_storm',
    ])
    expect(JSON.stringify(first)).not.toContain('ageMs')
    expect(engine.evaluate(signals)).toEqual([])
    now += 5_001
    expect(engine.evaluate(signals)).toHaveLength(11)
  })

  it('bounds and expires alert deduplication state under unique-identity storms', () => {
    let now = Date.parse('2026-08-02T12:00:00.000Z')
    const engine = new OperationsAlertEngine({
      stuckJobMs: 1_000,
      repeatedRetries: 3,
      projectionLagMs: 500,
      tokenStormPerMinute: 1_000,
      rateLimitStorm: 10,
      cooldownMs: 1_000,
    }, () => new Date(now), { maxTrackedAlerts: 2, stateTtlMs: 2_000 })

    for (const jobId of ['job-1', 'job-2', 'job-3', 'job-4']) {
      engine.evaluate({ jobs: [{ jobId, ageMs: 2_000, attempts: 1, status: 'running' }] })
      expect(engine.statistics().tracked).toBeLessThanOrEqual(2)
    }
    expect(engine.statistics()).toEqual({ tracked: 2, capacity: 2, state_ttl_ms: 2_000 })

    now += 2_001
    engine.evaluate({})
    expect(engine.statistics().tracked).toBe(0)
  })

  it('sheds background work, bounds queues, reserves interactive capacity, and drains by priority', () => {
    const capacity = new CapacityController({
      maxActiveSessions: 4,
      maxQueueDepth: 3,
      maxActivePerProvider: 4,
      reservedInteractiveSlots: 1,
    })
    for (const id of ['normal-1', 'normal-2', 'normal-3']) {
      expect(capacity.admit({ requestId: id, provider: 'codex', priority: 'normal' }).decision)
        .toBe('start')
    }
    expect(capacity.admit({ requestId: 'background-1', provider: 'codex', priority: 'background' }))
      .toMatchObject({ decision: 'reject', reason_code: 'provider_saturated' })
    expect(capacity.admit({ requestId: 'normal-4', provider: 'codex', priority: 'normal' }).decision)
      .toBe('queue')
    expect(capacity.admit({ requestId: 'interactive-1', provider: 'codex', priority: 'interactive' }).decision)
      .toBe('start')
    expect(capacity.admit({ requestId: 'interactive-2', provider: 'codex', priority: 'interactive' }).decision)
      .toBe('queue')
    expect(capacity.admit({ requestId: 'normal-5', provider: 'codex', priority: 'normal' }).decision)
      .toBe('queue')
    expect(capacity.admit({ requestId: 'overflow', provider: 'codex', priority: 'normal' }))
      .toMatchObject({ decision: 'reject', reason_code: 'queue_full' })

    capacity.release('normal-1')
    expect(capacity.drain(1).map((item) => item.requestId)).toEqual(['interactive-2'])
    expect(capacity.snapshot()).toMatchObject({ active_sessions: 4, queue_depth: 2 })
  })

  it('stays bounded during load and applies privacy-safe request/command/provider limits', () => {
    const capacity = new CapacityController({
      maxActiveSessions: 16,
      maxQueueDepth: 64,
      maxActivePerProvider: 16,
      reservedInteractiveSlots: 2,
    })
    for (let index = 0; index < 10_000; index += 1) {
      capacity.admit({ requestId: `load-${index}`, provider: 'codex', priority: 'normal' })
    }
    expect(capacity.snapshot()).toMatchObject({ active_sessions: 14, queue_depth: 64 })

    let now = 1_000
    const limiter = new OperationsRateLimiter({
      partitionSalt: 'rate-limit-private-salt',
      clock: () => now,
      maxPartitions: 4,
      rules: [
        { family: 'request', limit: 2, windowMs: 1_000 },
        { family: 'command', limit: 1, windowMs: 1_000 },
        { family: 'provider', limit: 1, windowMs: 1_000 },
      ],
    })
    const rawIdentity = '203.0.113.10|phone-secret'
    expect(limiter.consume('request', rawIdentity)).toMatchObject({ allowed: true, remaining: 1 })
    expect(limiter.consume('request', rawIdentity)).toMatchObject({ allowed: true, remaining: 0 })
    const denied = limiter.consume('request', rawIdentity)
    expect(denied).toMatchObject({ allowed: false, retry_after_ms: 1_000 })
    expect(denied.partition).not.toContain('203.0.113.10')
    expect(limiter.consume('command', rawIdentity).allowed).toBe(true)
    expect(limiter.consume('command', rawIdentity).allowed).toBe(false)
    expect(limiter.consume('provider', rawIdentity).allowed).toBe(true)
    now += 1_001
    expect(limiter.consume('request', rawIdentity).allowed).toBe(true)
    expect(limiter.statistics().partitions).toBeLessThanOrEqual(4)
  })

  it('fails closed without mutating rate-limit state when the trusted clock is invalid or regresses', () => {
    let now = Number.POSITIVE_INFINITY
    const limiter = new OperationsRateLimiter({
      partitionSalt: 'rate-limit-private-salt',
      clock: () => now,
      rules: [
        { family: 'request', limit: 1, windowMs: 1_000 },
        { family: 'command', limit: 1, windowMs: 1_000 },
        { family: 'provider', limit: 1, windowMs: 1_000 },
      ],
    })

    expect(limiter.consume('command', 'phone-a')).toMatchObject({
      allowed: false,
      remaining: 0,
      reason_code: 'clock_unavailable',
    })
    expect(limiter.statistics().partitions).toBe(0)

    now = 10_000
    expect(limiter.consume('command', 'phone-a')).toMatchObject({
      allowed: true,
      reason_code: 'allowed',
    })
    expect(limiter.statistics().partitions).toBe(1)

    now = 9_999
    expect(limiter.consume('command', 'phone-a')).toMatchObject({
      allowed: false,
      reason_code: 'clock_unavailable',
    })
    expect(limiter.statistics().partitions).toBe(1)

    now = Number.NaN
    expect(limiter.consume('command', 'phone-b')).toMatchObject({
      allowed: false,
      reason_code: 'clock_unavailable',
    })
    expect(limiter.statistics().partitions).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import {
  StructuredOperationsLogger,
  WITHHELD_OPERATIONAL_VALUE,
  privacySafePartition,
  redactOperationsValue,
} from '../src/operations/index.js'

describe('operations structured logging and privacy', () => {
  it('retains correlation/job/session/device attribution while withholding sensitive values', () => {
    const delivered: string[] = []
    const logger = new StructuredOperationsLogger({
      capacity: 2,
      clock: () => new Date('2026-08-02T08:00:00.000Z'),
      sink: (entry) => delivered.push(JSON.stringify(entry)),
    })
    const entry = logger.log({
      level: 'warn',
      event: 'remote.mutation.denied',
      outcome: 'denied',
      component: 'device_auth',
      reasonCode: 'step_up_required',
      correlationId: 'corr-123',
      jobId: 'job-456',
      sessionId: 'session-789',
      deviceId: 'device-phone-a',
      attributes: {
        provider: 'codex',
        attempts: 2,
        command: 'rm -rf /private/project',
        cwd: '/Users/person/private-project',
        prompt: 'read TOKEN=plain-secret',
        authorization: 'Bearer master-token-must-not-survive',
        nested: {
          approval_parameters: { answer: 'allow_session' },
          raw_response: 'private provider response',
        },
      },
    })

    expect(entry).toMatchObject({
      timestamp: '2026-08-02T08:00:00.000Z',
      event: 'remote.mutation.denied',
      outcome: 'denied',
      correlation_id: 'corr-123',
      job_id: 'job-456',
      session_id: 'session-789',
      device_id: 'device-phone-a',
      attributes: {
        provider: 'codex',
        attempts: 2,
        command: WITHHELD_OPERATIONAL_VALUE,
        cwd: WITHHELD_OPERATIONAL_VALUE,
        prompt: WITHHELD_OPERATIONAL_VALUE,
      },
    })
    expect(entry.redactions).toBeGreaterThanOrEqual(5)
    expect(delivered).toHaveLength(1)
    for (const secret of [
      'rm -rf', '/Users/person', 'plain-secret', 'master-token', 'allow_session',
      'private provider response',
    ]) expect(delivered[0]).not.toContain(secret)
  })

  it('is bounded, validates vocabulary, and drops malformed identifiers instead of logging them', () => {
    const logger = new StructuredOperationsLogger({ capacity: 2 })
    const first = logger.log({
      level: 'info', event: 'job.started', deviceId: 'https://leaky.invalid/?token=x',
    })
    logger.log({ level: 'info', event: 'job.finished' })
    logger.log({ level: 'error', event: 'job.failed' })

    expect(first.device_id).toBeUndefined()
    expect(logger.statistics()).toEqual({ retained: 2, dropped: 1, sink_failures: 0, capacity: 2 })
    expect(logger.recent(10).map((entry) => entry.event)).toEqual(['job.finished', 'job.failed'])
    expect(() => logger.log({ level: 'info', event: '../unsafe event' })).toThrow(
      'invalid operational event name',
    )
  })

  it('retains redacted evidence and counts an unavailable observability sink without crashing', () => {
    const logger = new StructuredOperationsLogger({
      sink: () => { throw new Error('sink unavailable with private detail') },
    })
    expect(() => logger.log({
      level: 'error', event: 'audit.sink.failed', attributes: { secret: 'must-not-survive' },
    })).not.toThrow()
    expect(logger.statistics()).toMatchObject({ retained: 1, sink_failures: 1 })
    expect(JSON.stringify(logger.recent())).not.toContain('must-not-survive')
  })

  it('deeply isolates and freezes retained evidence from sink, return, and recent mutations', () => {
    let delivered: Readonly<Record<string, unknown>> | undefined
    const logger = new StructuredOperationsLogger({
      sink: (entry) => { delivered = entry },
    })
    const returned = logger.log({
      level: 'info',
      event: 'audit.evidence.retained',
      attributes: { safe: { nested: 'original' } },
    })
    const firstRecent = logger.recent(1)[0]
    const returnedNested = returned.attributes.safe as Readonly<Record<string, unknown>>
    const recentNested = firstRecent.attributes.safe as Readonly<Record<string, unknown>>
    const deliveredEntry = delivered as typeof returned
    const deliveredNested = deliveredEntry.attributes.safe as Readonly<Record<string, unknown>>

    expect(deliveredEntry).not.toBe(returned)
    expect(firstRecent).not.toBe(returned)
    expect(deliveredNested).not.toBe(returnedNested)
    expect(recentNested).not.toBe(returnedNested)
    for (const candidate of [deliveredEntry, returned, firstRecent, deliveredNested, returnedNested, recentNested]) {
      expect(Object.isFrozen(candidate)).toBe(true)
    }

    for (const candidate of [deliveredNested, returnedNested, recentNested]) {
      expect(() => {
        (candidate as Record<string, unknown>).authorization = 'Bearer stolen-secret'
      }).toThrow()
      expect(() => {
        (candidate as Record<string, unknown>).nested = 'tampered'
      }).toThrow()
    }

    const retained = logger.recent(1)[0]
    expect(retained.attributes).toEqual({ safe: { nested: 'original' } })
    expect(JSON.stringify(retained)).not.toContain('stolen-secret')
    expect(JSON.stringify(retained)).not.toContain('tampered')
  })

  it('fails closed on cycles and hashes abuse partitions without retaining raw identity', () => {
    const cyclic: Record<string, unknown> = { status: 'active' }
    cyclic.self = cyclic
    const safe = redactOperationsValue(cyclic)
    expect(safe.redactions).toBeGreaterThan(0)
    expect(JSON.stringify(safe.value)).not.toContain('[object Object]')

    const raw = '203.0.113.10|device-secret-value'
    const partition = privacySafePartition(raw, 'local-secret-salt-value')
    expect(partition).toMatch(/^[0-9a-f]{24}$/)
    expect(partition).not.toContain('203.0.113.10')
    expect(privacySafePartition(raw, 'local-secret-salt-value')).toBe(partition)
    expect(() => privacySafePartition(raw, 'short')).toThrow('at least 16 characters')
  })
})

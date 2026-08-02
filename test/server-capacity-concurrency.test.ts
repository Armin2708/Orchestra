import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import {
  CapacityController,
  OperationsAlertEngine,
  OperationsMetrics,
  StructuredOperationsLogger,
} from '../src/operations/index.js'
import type { OperationsRuntime } from '../src/operations/runtime.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('production HTTP capacity reconciliation', () => {
  it('retains two held launch admissions while a concurrent request reconciles durable work', async () => {
    const db = openDb(':memory:')
    const capacity = new CapacityController({
      maxActiveSessions: 2,
      maxQueueDepth: 2,
      maxActivePerProvider: 2,
      reservedInteractiveSlots: 0,
    })
    const operations = {
      capacity,
      metrics: new OperationsMetrics(),
      logger: new StructuredOperationsLogger(),
      alerts: new OperationsAlertEngine(),
      checkHealth: async () => ({ status: 'ready', checked_at: new Date().toISOString(), duration_ms: 0, components: [] }),
      close: () => undefined,
      currentRateLimitRejections: () => 0,
      recordRateLimitRejection: () => [],
    } as unknown as OperationsRuntime
    const server = buildServer(db, undefined, { operations })
    const first = deferred()
    const second = deferred()
    const entered: string[] = []
    server.post<{ Body: { id: string } }>('/api/v1/test/launch', async (request) => {
      entered.push(request.body.id)
      await (request.body.id === 'first' ? first.promise : second.promise)
      return { ok: true }
    })
    try {
      const firstResponse = server.inject({
        method: 'POST', url: '/api/v1/test/launch', payload: { id: 'first', provider: 'codex' },
      })
      await vi.waitFor(() => expect(entered).toEqual(['first']))
      const secondResponse = server.inject({
        method: 'POST', url: '/api/v1/test/launch', payload: { id: 'second', provider: 'codex' },
      })
      await vi.waitFor(() => expect(entered).toEqual(['first', 'second']))
      expect(capacity.snapshot()).toMatchObject({
        active_sessions: 2,
        active_by_provider: { codex: 2 },
      })
      const rejected = await server.inject({
        method: 'POST', url: '/api/v1/test/launch', payload: { id: 'third', provider: 'codex' },
      })
      expect(rejected.statusCode).toBe(429)
      expect(entered).toEqual(['first', 'second'])
      first.resolve()
      second.resolve()
      expect((await firstResponse).statusCode).toBe(200)
      expect((await secondResponse).statusCode).toBe(200)
      expect(capacity.snapshot().active_sessions).toBe(0)
    } finally {
      first.resolve()
      second.resolve()
      await server.close()
      db.close()
    }
  })
})

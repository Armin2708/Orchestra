import { afterEach, expect, it, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { claudeUsage, _internals, _resetUsageState } from '../src/system.js'

const LIVE = {
  five_hour: { utilization: 42, resets_at: '2026-07-18T20:00:00Z' },
  seven_day: { utilization: 61, resets_at: '2026-07-21T00:00:00Z' },
}

afterEach(() => { _resetUsageState(); vi.restoreAllMocks(); vi.useRealTimers() })

it('success returns live usage, no error, and persists the payload', async () => {
  const db = openDb(':memory:')
  vi.spyOn(_internals, 'readToken').mockResolvedValue({ token: 't' })
  vi.spyOn(_internals, 'fetchUsage').mockResolvedValue(LIVE)
  const r = await claudeUsage(db)
  expect(r).toEqual({ usage: LIVE, usage_error: null, usage_error_since: null })
  const row = db.prepare(`SELECT value FROM kv WHERE key='last_usage'`).get() as any
  expect(JSON.parse(row.value)).toEqual(LIVE)
})

it('failure with a cached payload serves it stale-marked with the error reason', async () => {
  const db = openDb(':memory:')
  vi.spyOn(_internals, 'readToken').mockResolvedValue({ token: 't' })
  vi.spyOn(_internals, 'fetchUsage').mockResolvedValue(LIVE)
  await claudeUsage(db)
  _resetUsageState()

  vi.spyOn(_internals, 'fetchUsage').mockRejectedValue(new Error('timeout'))
  const r = await claudeUsage(db)
  expect(r.usage_error).toBe('offline')
  expect(r.usage_error_since).toBeTruthy()
  expect(r.usage?.stale_since).toBeTruthy()
  expect(r.usage?.five_hour).toEqual(LIVE.five_hour)
})

it('failure without cache yields usage null and the token-read reason', async () => {
  const db = openDb(':memory:')
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const reason of ['keychain', 'none'] as const) {
    _resetUsageState()
    vi.spyOn(_internals, 'readToken').mockResolvedValue({ reason })
    const r = await claudeUsage(db)
    expect(r).toMatchObject({ usage: null, usage_error: reason })
    expect(r.usage_error_since).toBeTruthy()
  }
  expect(err).toHaveBeenCalled() // failure reason logged at daemon level
})

it('logs once per failure streak and keeps the since-timestamp sticky', async () => {
  vi.useFakeTimers()
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(_internals, 'readToken').mockResolvedValue({ reason: 'keychain' })
  const first = await claudeUsage()
  vi.advanceTimersByTime(61_000) // past the result cache — a genuinely new poll
  const again = await claudeUsage()
  expect(err).toHaveBeenCalledTimes(1)
  expect(again.usage_error_since).toBe(first.usage_error_since)
})

it('GET /api/v1/system exposes the degraded payload shape', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(_internals, 'readToken').mockResolvedValue({ reason: 'keychain' })
  const server = buildServer(openDb(':memory:'))
  await server.ready()
  const sys = (await server.inject({ method: 'GET', url: '/api/v1/system' })).json()
  expect(sys.usage).toBeNull()
  expect(sys.usage_error).toBe('keychain')
  expect(sys.usage_error_since).toBeTruthy()
  expect(sys.injected).toBeDefined()
  await server.close()
})

import { describe, expect, it } from 'vitest'
import { resolveIdempotencyKey } from '../src/agent-os/idempotency.js'

describe('canonical idempotency key parsing', () => {
  it('normalizes one bounded key and accepts matching spellings', () => {
    expect(resolveIdempotencyKey({ header: ' replay-1 ', snake: 'replay-1', camel: 'replay-1' }))
      .toBe('replay-1')
    expect(resolveIdempotencyKey({})).toBeUndefined()
  })

  it('rejects conflicting, repeated, empty, non-string, overlong, and control-character keys', () => {
    expect(() => resolveIdempotencyKey({ snake: 'one', camel: 'two' })).toThrow(/must match/)
    expect(() => resolveIdempotencyKey({ header: ['one', 'one'] })).toThrow(/exactly once/)
    expect(() => resolveIdempotencyKey({ snake: '   ' })).toThrow(/must not be empty/)
    expect(() => resolveIdempotencyKey({ camel: 42 })).toThrow(/must be a string/)
    expect(() => resolveIdempotencyKey({ header: 'x'.repeat(201) })).toThrow(/at most 200/)
    expect(() => resolveIdempotencyKey({ header: 'unsafe\nkey' })).toThrow(/control characters/)
  })
})

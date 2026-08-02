import { describe, expect, it } from 'vitest'
import {
  OPERATIONS_FAILURE_POLICIES,
  PlatformCredentialUnavailableError,
  ProtectedCredentialVault,
  classifyOperationalFailure,
  type PlatformCredentialStore,
} from '../src/operations/index.js'

class TestPlatformStore implements PlatformCredentialStore {
  readonly facility = 'test-platform-secure-store'
  readonly values = new Map<string, Uint8Array>()
  available = true
  failDelete = false
  gets = 0
  replacements = 0

  async isAvailable(): Promise<boolean> { return this.available }
  async put(reference: string, secret: Uint8Array): Promise<void> {
    this.values.set(reference, Uint8Array.from(secret))
  }
  async get(reference: string): Promise<Uint8Array | null> {
    this.gets += 1
    const value = this.values.get(reference)
    return value ? Uint8Array.from(value) : null
  }
  async replace(currentReference: string, replacementReference: string, secret: Uint8Array): Promise<void> {
    this.replacements += 1
    if (this.failDelete) throw new Error('platform replace failed')
    if (!this.values.has(currentReference)) throw new Error('current credential missing')
    this.values.set(replacementReference, Uint8Array.from(secret))
    this.values.delete(currentReference)
  }
  async delete(reference: string): Promise<void> {
    if (this.failDelete) throw new Error('platform delete failed')
    this.values.delete(reference)
  }
}

describe('platform credential protection and operational failure policy', () => {
  it('fails closed without a platform facility and returns only opaque references', async () => {
    const store = new TestPlatformStore()
    store.available = false
    const vault = new ProtectedCredentialVault(store)
    await expect(vault.protect(Buffer.from('credential-secret-material'), 60_000))
      .rejects.toBeInstanceOf(PlatformCredentialUnavailableError)
    expect(store.values.size).toBe(0)

    store.available = true
    const reference = await vault.protect(Buffer.from('credential-secret-material'), 60_000)
    expect(reference).toMatchObject({ facility: store.facility })
    expect(JSON.stringify(reference)).not.toContain('credential-secret-material')
    expect(Buffer.from(await vault.resolve(reference))).toEqual(Buffer.from('credential-secret-material'))
  })

  it('rotates and individually revokes credentials without exposing or affecting unrelated entries', async () => {
    const store = new TestPlatformStore()
    const vault = new ProtectedCredentialVault(store)
    const phoneA = await vault.protect(Buffer.from('phone-a-secret-material'), 60_000)
    const phoneB = await vault.protect(Buffer.from('phone-b-secret-material'), 60_000)
    const rotatedA = await vault.rotate(phoneA, Buffer.from('phone-a-rotated-material'), 60_000)

    await expect(vault.resolve(phoneA)).rejects.toThrow('missing or revoked')
    expect(Buffer.from(await vault.resolve(rotatedA))).toEqual(Buffer.from('phone-a-rotated-material'))
    expect(Buffer.from(await vault.resolve(phoneB))).toEqual(Buffer.from('phone-b-secret-material'))
    await vault.revoke(rotatedA)
    await expect(vault.resolve(rotatedA)).rejects.toThrow('missing or revoked')
    expect(Buffer.from(await vault.resolve(phoneB))).toEqual(Buffer.from('phone-b-secret-material'))
  })

  it('rolls back replacement material when deletion fails during rotation', async () => {
    const store = new TestPlatformStore()
    const vault = new ProtectedCredentialVault(store)
    const current = await vault.protect(Buffer.from('current-secret-material'), 60_000)
    store.failDelete = true
    await expect(vault.rotate(current, Buffer.from('replacement-material'), 60_000))
      .rejects.toThrow('platform replace failed')
    expect(store.values.size).toBe(1)
    store.failDelete = false
    expect(Buffer.from(await vault.resolve(current))).toEqual(Buffer.from('current-secret-material'))
  })

  it('rejects malformed credential timestamps before secure-store access', async () => {
    const store = new TestPlatformStore()
    const now = new Date('2026-08-02T10:00:00.000Z')
    const vault = new ProtectedCredentialVault(store, 'orchestra', () => now)
    const current = await vault.protect(Buffer.from('current-secret-material'), 60_000)
    const malformed = Object.freeze({ ...current, expires_at: 'not-a-date' })

    await expect(vault.resolve(malformed)).rejects.toThrow('canonical UTC timestamp')
    expect(store.gets).toBe(0)
    await expect(vault.resolve({ ...current, expires_at: '2026-08-02T10:00:60.000Z' }))
      .rejects.toThrow('canonical UTC timestamp')
    await expect(vault.resolve({ ...current, expires_at: current.created_at }))
      .rejects.toThrow('invalid lifetime')
    expect(store.gets).toBe(0)
  })

  it('fails closed on an invalid credential clock and refuses expired-current rotation', async () => {
    const store = new TestPlatformStore()
    let now = new Date('2026-08-02T10:00:00.000Z')
    const vault = new ProtectedCredentialVault(store, 'orchestra', () => now)
    const current = await vault.protect(Buffer.from('current-secret-material'), 60_000)

    now = new Date(Number.NaN)
    await expect(vault.protect(Buffer.from('new-secret-material'), 60_000))
      .rejects.toThrow('trusted credential clock unavailable')
    await expect(vault.resolve(current)).rejects.toThrow('trusted credential clock unavailable')
    await expect(vault.rotate(current, Buffer.from('replacement-material'), 60_000))
      .rejects.toThrow('trusted credential clock unavailable')
    expect(store.gets).toBe(0)
    expect(store.replacements).toBe(0)

    now = new Date(current.expires_at)
    await expect(vault.rotate(current, Buffer.from('replacement-material'), 60_000))
      .rejects.toThrow('cannot rotate an expired credential reference')
    expect(store.replacements).toBe(0)
    expect(store.values.has(current.credential_ref)).toBe(true)
  })

  it('defines fail-closed disk-full, bounded DB/provider recovery, and explicit git-conflict behavior', () => {
    expect(classifyOperationalFailure({ code: 'ENOSPC', message: 'secret path' }, 'storage')).toBe('disk_full')
    expect(classifyOperationalFailure({ code: 'SQLITE_BUSY' }, 'database')).toBe('database_locked')
    expect(classifyOperationalFailure({ code: 'ETIMEDOUT' }, 'provider')).toBe('provider_unavailable')
    expect(classifyOperationalFailure({ code: 'GIT_CONFLICT' }, 'workspace')).toBe('git_conflict')
    expect(classifyOperationalFailure({ code: 'ETIMEDOUT' }, 'database')).toBe('unknown')
    expect(classifyOperationalFailure(new Error('unknown secret message'))).toBe('unknown')

    expect(OPERATIONS_FAILURE_POLICIES.disk_full).toMatchObject({
      mutation: 'fail_closed', retry_limit: 0, alert_severity: 'critical',
    })
    expect(OPERATIONS_FAILURE_POLICIES.database_locked).toMatchObject({
      mutation: 'bounded_retry', retry_limit: 3,
    })
    expect(OPERATIONS_FAILURE_POLICIES.provider_unavailable).toMatchObject({
      mutation: 'bounded_queue', retry_limit: 5,
    })
    expect(OPERATIONS_FAILURE_POLICIES.git_conflict).toMatchObject({
      mutation: 'block_job', retry_limit: 0,
    })
    expect(Object.isFrozen(OPERATIONS_FAILURE_POLICIES)).toBe(true)
  })
})

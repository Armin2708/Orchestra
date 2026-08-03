import { describe, expect, it } from 'vitest'
import { createLocalOwnerSessionStore } from '../web/src/localOwnerSession.js'

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

describe('local owner browser session', () => {
  it('survives a page refresh in tab storage until its server expiry', () => {
    const storage = new MemoryStorage()
    let now = Date.parse('2026-08-04T10:00:00.000Z')
    const session = 'a'.repeat(64)
    const expiresAt = '2026-08-04T22:00:00.000Z'

    const firstPage = createLocalOwnerSessionStore(storage, () => now)
    firstPage.set(session, expiresAt)
    expect(firstPage.get()).toBe(session)

    const refreshedPage = createLocalOwnerSessionStore(storage, () => now)
    expect(refreshedPage.get()).toBe(session)

    now = Date.parse(expiresAt) + 1
    expect(refreshedPage.get()).toBe('')
    expect(createLocalOwnerSessionStore(storage, () => now).get()).toBe('')
  })

  it('does not persist a password, invalid credential, or unbounded session', () => {
    const storage = new MemoryStorage()
    const now = Date.parse('2026-08-04T10:00:00.000Z')
    const store = createLocalOwnerSessionStore(storage, () => now)

    store.set('a password', '2026-08-04T11:00:00.000Z')
    expect(store.get()).toBe('a password')
    expect(createLocalOwnerSessionStore(storage, () => now).get()).toBe('')

    store.set('b'.repeat(64), '2026-08-05T10:01:01.000Z')
    expect(createLocalOwnerSessionStore(storage, () => now).get()).toBe('')
  })
})

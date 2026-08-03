const STORAGE_KEY = 'orchestra-local-owner-session-v1'
const MAX_SESSION_AGE_MS = 12 * 60 * 60 * 1_000
const CLOCK_SKEW_MS = 60_000

type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type StoredSession = { session: string; expires_at: string }

const parseExpiry = (value: string, now: number) => {
  const expiresAt = Date.parse(value)
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + MAX_SESSION_AGE_MS + CLOCK_SKEW_MS) return 0
  return expiresAt
}

const validSession = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)

/**
 * Keeps a short-lived loopback owner session through refreshes in this tab. The
 * password and the daemon's internal transport credential are never stored.
 */
export function createLocalOwnerSessionStore(storage: SessionStorage | null, now = () => Date.now()) {
  let session = ''
  let expiresAt = 0

  const clear = () => {
    session = ''
    expiresAt = 0
    try { storage?.removeItem(STORAGE_KEY) } catch { /* unavailable browser storage */ }
  }

  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (raw) {
      const stored = JSON.parse(raw) as Partial<StoredSession>
      if (validSession(stored.session) && typeof stored.expires_at === 'string') {
        const restoredExpiry = parseExpiry(stored.expires_at, now())
        if (restoredExpiry) {
          session = stored.session
          expiresAt = restoredExpiry
        } else {
          clear()
        }
      } else {
        clear()
      }
    }
  } catch {
    clear()
  }

  return {
    get() {
      if (expiresAt && expiresAt <= now()) clear()
      return session
    },
    set(value: string, expiresAtIso?: string) {
      const next = value.trim()
      if (!next) {
        clear()
        return
      }
      const sameSession = next === session
      session = next

      // Compatibility callers can re-accept an already persisted session
      // without shortening or accidentally making it permanent.
      if (sameSession && !expiresAtIso && expiresAt) return

      const nextExpiry = expiresAtIso ? parseExpiry(expiresAtIso, now()) : 0
      expiresAt = nextExpiry
      if (!validSession(next) || !nextExpiry) {
        try { storage?.removeItem(STORAGE_KEY) } catch { /* unavailable browser storage */ }
        return
      }
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify({ session: next, expires_at: expiresAtIso }))
      } catch { /* the live in-memory session still works */ }
    },
    clear,
  }
}

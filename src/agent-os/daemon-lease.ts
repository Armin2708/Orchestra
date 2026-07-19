import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type DaemonLease = {
  ownerId: string
  release(): void
}

const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Acquire the database-wide daemon lease before any persisted runtime reconciliation. */
export function acquireDaemonLease(db: Database.Database, name = 'orchestra-daemon'): DaemonLease {
  const ownerId = randomUUID()
  const now = new Date().toISOString()
  const acquire = db.transaction(() => {
    const existing = db.prepare('SELECT owner_id, pid FROM daemon_leases WHERE name=?')
      .get(name) as { owner_id: string; pid: number } | undefined
    if (existing && processIsAlive(existing.pid)) {
      throw new Error(`another Orchestra daemon already owns this data directory (pid ${existing.pid})`)
    }
    db.prepare(`INSERT INTO daemon_leases (name, owner_id, pid, acquired_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET owner_id=excluded.owner_id, pid=excluded.pid,
        acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at`)
      .run(name, ownerId, process.pid, now, now)
  })
  acquire.immediate()

  let released = false
  const timer = setInterval(() => {
    if (released) return
    try {
      db.prepare('UPDATE daemon_leases SET heartbeat_at=? WHERE name=? AND owner_id=?')
        .run(new Date().toISOString(), name, ownerId)
    } catch {
      // Shutdown may close the database before the timer observes release.
    }
  }, 5_000)
  timer.unref()

  return {
    ownerId,
    release: () => {
      if (released) return
      released = true
      clearInterval(timer)
      try { db.prepare('DELETE FROM daemon_leases WHERE name=? AND owner_id=?').run(name, ownerId) } catch { /* database is closing */ }
    },
  }
}

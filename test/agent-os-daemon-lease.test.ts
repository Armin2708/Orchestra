import { describe, expect, it } from 'vitest'
import { acquireDaemonLease } from '../src/agent-os/daemon-lease.js'
import { openDb } from '../src/db.js'

describe('Agent OS daemon lease', () => {
  it('admits exactly one live daemon and releases ownership cleanly', () => {
    const db = openDb(':memory:')
    const first = acquireDaemonLease(db)

    expect(() => acquireDaemonLease(db)).toThrow(/already owns/)
    first.release()
    const replacement = acquireDaemonLease(db)

    expect(replacement.ownerId).not.toBe(first.ownerId)
    replacement.release()
  })

  it('atomically steals a lease whose owner pid is no longer alive', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO daemon_leases (name, owner_id, pid, acquired_at, heartbeat_at)
      VALUES ('orchestra-daemon', 'dead-owner', 2147483647, datetime('now'), datetime('now'))`).run()

    const lease = acquireDaemonLease(db)

    expect((db.prepare("SELECT owner_id FROM daemon_leases WHERE name='orchestra-daemon'").get() as { owner_id: string }).owner_id)
      .toBe(lease.ownerId)
    lease.release()
  })
})

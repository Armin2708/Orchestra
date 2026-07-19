import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { openDb } from '../src/db.js'
import { Autowake, autowakeEnabled } from '../src/autowake.js'
import { survivors } from '../src/daemon.js'
import type { UsageResult } from '../src/system.js'

const usageAt = (utilization: number, resetsAt: string | null): UsageResult => ({
  usage: {
    five_hour: { utilization, resets_at: resetsAt },
    seven_day: { utilization: 10, resets_at: null },
  },
  usage_error: null,
  usage_error_since: null,
})

const T0 = Date.parse('2026-07-19T18:00:00Z')

function setup(opts: { usage: () => UsageResult; now?: () => number }) {
  const db = openDb(':memory:')
  const bus = new EventEmitter()
  const events: any[] = []
  bus.on('event', (e) => events.push(e))
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  const woken: number[] = []
  const wake = (boardId: number) => {
    woken.push(boardId)
    // mirror the real conductor: waking clears the paused rows it resumed
    db.prepare(`UPDATE agents SET status='active' WHERE board_id=? AND status='paused_limit'`).run(boardId)
    return { woke: ['fake-otter'], queued: [], skipped: [] }
  }
  const polls: number[] = []
  const auto = new Autowake(db, bus, wake, {
    usage: async () => { polls.push(1); return opts.usage() },
    now: opts.now ?? (() => T0),
    jitterMs: () => 60_000,
  })
  const pause = (name: string) => db.prepare(
    `INSERT INTO agents (board_id, name, kind, status) VALUES (1, ?, 'hired', 'paused_limit')`).run(name)
  return { db, bus, events, auto, woken, polls, pause }
}

beforeEach(() => { delete process.env.ORCHESTRA_AUTOWAKE })
afterEach(() => { delete process.env.ORCHESTRA_AUTOWAKE; vi.useRealTimers() })

it('is on by default and opts out with ORCHESTRA_AUTOWAKE=0', () => {
  expect(autowakeEnabled()).toBe(true)
  process.env.ORCHESTRA_AUTOWAKE = '0'
  expect(autowakeEnabled()).toBe(false)
})

it('schedules at the five-hour reset plus jitter when agents are paused', async () => {
  const resets = new Date(T0 + 30 * 60_000).toISOString()
  const t = setup({ usage: () => usageAt(100, resets) })
  t.pause('sleepy-otter')
  await t.auto.reschedule()
  expect(t.auto.scheduledAt()).toBe(new Date(Date.parse(resets) + 60_000).toISOString())
})

it('schedules nothing when no agent is paused, or when auto-wake is disabled', async () => {
  const t = setup({ usage: () => usageAt(100, new Date(T0 + 60_000).toISOString()) })
  await t.auto.reschedule()
  expect(t.auto.scheduledAt()).toBeNull() // nothing paused

  t.pause('sleepy-otter')
  process.env.ORCHESTRA_AUTOWAKE = '0'
  await t.auto.reschedule()
  expect(t.auto.scheduledAt()).toBeNull()
})

it('fires after the reset: re-polls usage, sees it dropped, wakes every paused board', async () => {
  let util = 100
  const t = setup({ usage: () => usageAt(util, new Date(T0 + 60_000).toISOString()) })
  t.pause('sleepy-otter')
  await t.auto.reschedule()
  util = 4 // the window actually reset
  await t.auto.fire()
  expect(t.woken).toEqual([1])
  expect(t.events.some((e) => e.type === 'autowake' && e.data.woke === 1)).toBe(true)
  expect(t.auto.scheduledAt()).toBeNull() // nothing left paused → no re-arm
})

it('skips and reschedules when the window still reads saturated', async () => {
  const t = setup({ usage: () => usageAt(100, new Date(T0 + 60_000).toISOString()) })
  t.pause('sleepy-otter')
  await t.auto.reschedule()
  await t.auto.fire()
  expect(t.woken).toHaveLength(0) // waking now would just re-kill them
  expect(t.db.prepare(`SELECT status FROM agents WHERE name='sleepy-otter'`).get()).toMatchObject({ status: 'paused_limit' })
  expect(t.auto.scheduledAt()).not.toBeNull() // re-armed for the next window
})

it('a queued wake leaves agents paused, so the timer re-arms for the next window', async () => {
  const db = openDb(':memory:')
  const bus = new EventEmitter()
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  db.prepare(`INSERT INTO agents (board_id, name, kind, status) VALUES (1, 'queued-otter', 'hired', 'paused_limit')`).run()
  const auto = new Autowake(db, bus, () => ({ woke: [], queued: ['queued-otter'], skipped: [] }), {
    usage: async () => usageAt(5, new Date(T0 + 60_000).toISOString()),
    now: () => T0,
    jitterMs: () => 60_000,
  })
  await auto.fire()
  expect(auto.scheduledAt()).not.toBeNull()
  auto.stop()
})

it('recomputes the timer from a fresh usage poll after a daemon restart — never persisted', async () => {
  const resets = new Date(T0 + 45 * 60_000).toISOString()
  const t = setup({ usage: () => usageAt(100, resets) })
  t.pause('sleepy-otter')
  await t.auto.reschedule()
  const before = t.auto.scheduledAt()
  t.auto.stop()
  expect(t.auto.scheduledAt()).toBeNull()

  // nothing about the timer was written to the db — a "restarted" instance re-derives it
  expect(t.db.prepare(`SELECT COUNT(*) AS n FROM kv WHERE key LIKE '%wake%'`).get()).toMatchObject({ n: 0 })
  const restarted = new Autowake(t.db, t.bus, () => ({ woke: [], queued: [], skipped: [] }), {
    usage: async () => usageAt(100, resets), now: () => T0, jitterMs: () => 60_000,
  })
  await restarted.reschedule()
  expect(restarted.scheduledAt()).toBe(before)
  restarted.stop()
})

it('retries soon when usage is unavailable rather than dropping the paused agents', async () => {
  const t = setup({ usage: () => ({ usage: null, usage_error: 'offline', usage_error_since: null }) })
  t.pause('sleepy-otter')
  await t.auto.reschedule()
  expect(Date.parse(t.auto.scheduledAt()!)).toBe(T0 + 5 * 60_000)
  t.auto.stop()
})

it('daemon restart resurrects live agents but leaves limit-paused ones for the timer', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  db.prepare(`INSERT INTO agents (board_id, name, kind, status) VALUES (1, 'busy-otter', 'hired', 'active')`).run()
  db.prepare(`INSERT INTO agents (board_id, name, kind, status) VALUES (1, 'idle-otter', 'hired', 'idle')`).run()
  db.prepare(`INSERT INTO agents (board_id, name, kind, status) VALUES (1, 'sleepy-otter', 'hired', 'paused_limit')`).run()
  db.prepare(`INSERT INTO agents (board_id, name, kind, status) VALUES (1, 'dead-otter', 'hired', 'gone')`).run()

  expect(survivors(db).map((s: any) => s.name).sort()).toEqual(['busy-otter', 'idle-otter'])
})

it('a limit_pause event arms the timer without an explicit reschedule call', async () => {
  const t = setup({ usage: () => usageAt(100, new Date(T0 + 60_000).toISOString()) })
  t.pause('sleepy-otter')
  t.bus.emit('event', { board_id: 1, type: 'limit_pause', data: { agent_id: 1 } })
  await new Promise((r) => setTimeout(r, 10))
  expect(t.auto.scheduledAt()).not.toBeNull()
  t.auto.stop()
})

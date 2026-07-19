import type Database from 'better-sqlite3'
import type { EventEmitter } from 'node:events'
import { claudeUsage, UsageResult } from './system.js'

// auto-wake is the default; ORCHESTRA_AUTOWAKE=0 leaves only the manual wake paths
export const autowakeEnabled = () => process.env.ORCHESTRA_AUTOWAKE !== '0'

type WakeFn = (boardId: number) => { woke: string[]; queued: string[]; skipped: string[] }

export interface AutowakeOptions {
  // injectable for tests — real timers, network usage polls, and randomness are unmockable inline
  usage?: (db: Database.Database) => Promise<UsageResult>
  now?: () => number
  jitterMs?: () => number
  retryMs?: number
}

// one in-memory timer that wakes every limit-paused agent when the five-hour window
// resets. Deliberately never persisted: a daemon restart recomputes it from the same
// source of truth (the live usage poll), so it cannot drift from reality.
export class Autowake {
  private timer: ReturnType<typeof setTimeout> | null = null
  private fireAt: number | null = null

  constructor(
    private db: Database.Database,
    private bus: EventEmitter,
    private wakeBoard: WakeFn,
    private opts: AutowakeOptions = {},
  ) {
    // a limit-pause anywhere (re)arms the timer; manual wakes may empty the board, so
    // an autowake event re-evaluates too (reschedule clears itself when nothing is paused)
    bus.on('event', (e: any) => { if (e?.type === 'limit_pause') void this.reschedule() })
  }

  pausedBoards(): { board_id: number; n: number }[] {
    return this.db.prepare(`
      SELECT board_id, COUNT(*) AS n FROM agents
      WHERE kind='hired' AND status='paused_limit' GROUP BY board_id`).all() as any[]
  }
  pausedCount(): number { return this.pausedBoards().reduce((s, b) => s + b.n, 0) }
  scheduledAt(): string | null { return this.fireAt !== null ? new Date(this.fireAt).toISOString() : null }
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.fireAt = null
  }

  async reschedule(): Promise<void> {
    this.stop()
    if (!autowakeEnabled() || this.pausedCount() === 0) return
    const now = this.opts.now ?? Date.now
    const usage = await (this.opts.usage ?? claudeUsage)(this.db)
    const resetsAt = usage.usage?.five_hour?.resets_at ? Date.parse(usage.usage.five_hour.resets_at) : NaN
    // fire past the reset, jittered, so the post-reset poll cannot see a pre-reset cache
    const jitter = this.opts.jitterMs?.() ?? 60_000 + Math.floor(Math.random() * 30_000)
    const at = Number.isFinite(resetsAt)
      ? Math.max(resetsAt, now()) + jitter
      : now() + (this.opts.retryMs ?? 5 * 60_000) // usage unavailable — poll again soon
    this.fireAt = at
    this.timer = setTimeout(() => void this.fire(), Math.max(0, at - now()))
    this.timer.unref?.()
  }

  // exposed for tests; production entry is the timer armed by reschedule()
  async fire(): Promise<void> {
    this.timer = null
    this.fireAt = null
    if (!autowakeEnabled()) return
    const boards = this.pausedBoards()
    if (boards.length === 0) return
    // the reset must be real: a stale clock or lagging poll still showing a saturated
    // window means waking now would just re-kill every agent — skip and re-arm
    const usage = await (this.opts.usage ?? claudeUsage)(this.db)
    const five = usage.usage?.five_hour
    if (!five || five.utilization >= 100) { await this.reschedule(); return }
    let woke = 0
    let queued = 0
    for (const b of boards) {
      const r = this.wakeBoard(b.board_id)
      woke += r.woke.length
      queued += r.queued.length
    }
    this.bus.emit('event', { board_id: boards[0].board_id, type: 'autowake', data: { woke, queued } })
    // queued wakes leave agents paused until a slot frees — keep the next window covered
    if (this.pausedCount() > 0) await this.reschedule()
  }
}

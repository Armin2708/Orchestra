import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'

const run = promisify(execFile)

export type ShipCandidate = {
  boardId: number
  cardId: number
  branch: string
  title: string
  // the launched agent's worktree — removed once its branch is on main
  worktree?: string | null
}

export type ShipHooks = {
  onEvent: (type: 'queued' | 'shipping' | 'shipped' | 'failed' | 'skipped', data: any) => void
  recordShipped: (cardId: number, hash: string) => Promise<void> | void
  onSuccess: (c: ShipCandidate, hash: string) => void
  onFailure: (c: ShipCandidate, reason: string, detail: string) => void
  runTests?: (cwd: string, changed: string[]) => Promise<{ ok: boolean; output: string }>
}

export const autoshipEnabled = () => process.env.ORCHESTRA_AUTOSHIP !== '0'

// single source of the card-worktree path convention — shared by launch (conductor),
// daemon resurrect, and #62's wake path, so restarts land agents back in their worktree
export const cardWorktree = (projectPath: string, cardId: number): string =>
  path.join(projectPath, '..', `${path.basename(projectPath)}-card-${cardId}`)

// pre-queue gate over #52 verifier verdicts (contract w/ coral-falcon, msgs #547-#577):
// newest card_event type='verification' is authoritative; only an unconfirmed fail blocks.
export function shipGate(db: Database.Database, cardId: number, decision: { confirmed?: boolean }): { queue: boolean; warn?: string; held?: string } {
  const row = db.prepare(`SELECT payload FROM card_events WHERE card_id=? AND type='verification' ORDER BY id DESC LIMIT 1`)
    .get(cardId) as { payload: string } | undefined
  if (!row) return { queue: true }
  let verdict = ''
  try { verdict = JSON.parse(row.payload)?.verdict ?? '' } catch { /* malformed payload — treat as absent */ }
  if (verdict === 'fail' && !decision.confirmed) return { queue: false, held: 'verifier verdict is fail — approve with explicit confirm to ship anyway' }
  if (verdict === 'gaps') return { queue: true, warn: 'verifier found gaps — shipping on approval' }
  return { queue: true }
}

// default gate command: full suite in the throwaway worktree, plus the web build when the
// candidate touches web/ or src/ (borrowed from #58's manual integration checklist)
export const defaultRunTests = (projectPath: string) => async (cwd: string, changed: string[]): Promise<{ ok: boolean; output: string }> => {
  try { await symlink(path.join(projectPath, 'node_modules'), path.join(cwd, 'node_modules')) } catch { /* repo without deps (tests) or link exists */ }
  let output = ''
  try {
    const t = await run('npm', ['test'], { cwd, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })
    output += t.stdout + t.stderr
  } catch (e: any) {
    return { ok: false, output: output + String(e?.stdout ?? '') + String(e?.stderr ?? e) }
  }
  if (changed.some((f) => f.startsWith('web/') || f.startsWith('src/'))) {
    try {
      await symlink(path.join(projectPath, 'web', 'node_modules'), path.join(cwd, 'web', 'node_modules'))
    } catch { /* no web dir or link exists */ }
    try {
      const b = await run('npm', ['run', '--if-present', 'build'], { cwd: path.join(cwd, 'web'), timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })
      output += b.stdout + b.stderr
    } catch (e: any) {
      if ((e as any)?.code === 'ENOENT') return { ok: true, output } // repo has no web/ package
      return { ok: false, output: output + String(e?.stdout ?? '') + String(e?.stderr ?? e) }
    }
  }
  return { ok: true, output }
}

// One integration at a time, drained on each approval — mirrors the launchQueue model.
// Never tests inside the live checkout: candidates merge + test in a throwaway detached
// worktree; only a green result repeats the same --no-ff merge on the real main.
export class ShipQueue {
  private queue: ShipCandidate[] = []
  private active = false
  shipping: number | null = null

  constructor(private projectPath: string, private hooks: ShipHooks) {}

  status(cardId: number): 'queued' | 'shipping' | null {
    if (this.shipping === cardId) return 'shipping'
    return this.queue.some((q) => q.cardId === cardId) ? 'queued' : null
  }

  list(): number[] { return [...(this.shipping !== null ? [this.shipping] : []), ...this.queue.map((q) => q.cardId)] }

  enqueue(c: ShipCandidate): { queued: boolean; reason?: string } {
    if (this.shipping === c.cardId || this.queue.some((q) => q.cardId === c.cardId)) {
      return { queued: false, reason: 'already queued' }
    }
    this.queue.push(c)
    this.hooks.onEvent('queued', { card_id: c.cardId, position: this.queue.length })
    void this.drain()
    return { queued: true }
  }

  private async drain(): Promise<void> {
    if (this.active) return
    this.active = true
    try {
      while (this.queue.length) {
        const c = this.queue.shift()!
        this.shipping = c.cardId
        this.hooks.onEvent('shipping', { card_id: c.cardId, branch: c.branch })
        try {
          const r = await this.ship(c)
          if (r.status === 'shipped') {
            this.hooks.onEvent('shipped', { card_id: c.cardId, hash: r.hash })
            this.hooks.onSuccess(c, r.hash!)
          } else if (r.status === 'skipped') {
            this.hooks.onEvent('skipped', { card_id: c.cardId, reason: r.reason })
          } else {
            this.hooks.onEvent('failed', { card_id: c.cardId, reason: r.reason, detail: r.detail })
            this.hooks.onFailure(c, r.reason!, r.detail ?? '')
          }
        } catch (e: any) {
          const detail = String(e?.stderr ?? e?.message ?? e)
          this.hooks.onEvent('failed', { card_id: c.cardId, reason: 'ship error', detail })
          this.hooks.onFailure(c, 'ship error', detail)
        } finally {
          this.shipping = null
        }
      }
    } finally {
      this.active = false
    }
  }

  private git(args: string[], cwd = this.projectPath) {
    return run('git', args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
  }

  // the registered worktree holding this branch (the launched agent's), if any
  private async worktreeFor(branch: string): Promise<string | null> {
    try {
      const out = (await this.git(['worktree', 'list', '--porcelain'])).stdout
      for (const block of out.split('\n\n')) {
        if (!block.includes(`branch refs/heads/${branch}\n`) && !block.trim().endsWith(`branch refs/heads/${branch}`)) continue
        const m = block.match(/^worktree (.+)$/m)
        if (m) return m[1]
      }
    } catch { /* no worktrees */ }
    return null
  }

  private async ship(c: ShipCandidate): Promise<{ status: 'shipped' | 'failed' | 'skipped'; hash?: string; reason?: string; detail?: string }> {
    let sha: string
    try {
      sha = (await this.git(['rev-parse', '--verify', `${c.branch}^{commit}`])).stdout.trim()
    } catch {
      return { status: 'skipped', reason: `branch not found: ${c.branch}` }
    }
    // re-approval of already-integrated work is a no-op (idempotency belt; #54's is braces)
    try {
      await this.git(['merge-base', '--is-ancestor', sha, 'main'])
      return { status: 'skipped', reason: 'already merged' }
    } catch { /* not an ancestor — proceed */ }

    // #58 checklist: the live checkout must be a clean main at a known tip before we touch it
    const liveBranch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    if (liveBranch !== 'main') return { status: 'failed', reason: 'live checkout not on main', detail: liveBranch }
    const dirty = (await this.git(['status', '--porcelain'])).stdout.trim()
    if (dirty) return { status: 'failed', reason: 'live checkout dirty', detail: dirty.slice(0, 2000) }
    const mainTip = (await this.git(['rev-parse', 'HEAD'])).stdout.trim()

    const tmp = await mkdtemp(path.join(os.tmpdir(), `orchestra-ship-${c.cardId}-`))
    const subject = `merge: ${c.title} (#${c.cardId})`
    try {
      await this.git(['worktree', 'add', '--detach', tmp, mainTip])
      try {
        await this.git(['merge', '--no-ff', sha, '-m', subject], tmp)
      } catch (e: any) {
        const files = (await this.git(['diff', '--name-only', '--diff-filter=U'], tmp)).stdout.trim()
        return { status: 'failed', reason: 'merge conflict', detail: files || String(e?.stderr ?? e) }
      }
      const changed = (await this.git(['diff', '--name-only', `${mainTip}..${sha}`])).stdout.trim().split('\n').filter(Boolean)
      const tests = await (this.hooks.runTests ?? defaultRunTests(this.projectPath))(tmp, changed)
      if (!tests.ok) return { status: 'failed', reason: 'tests failed', detail: tests.output.slice(-4000) }

      // green — repeat the identical merge on the real main, unless it moved under us
      const nowTip = (await this.git(['rev-parse', 'HEAD'])).stdout.trim()
      if (nowTip !== mainTip) return { status: 'failed', reason: 'main moved during integration', detail: `${mainTip} → ${nowTip}` }
      const agentWorktree = c.worktree ?? await this.worktreeFor(c.branch)
      await this.git(['merge', '--no-ff', sha, '-m', subject])
      const hash = (await this.git(['rev-parse', 'HEAD'])).stdout.trim()
      await this.hooks.recordShipped(c.cardId, hash)

      // the branch and its worktree become invisible plumbing once main has the work
      if (agentWorktree) { try { await this.git(['worktree', 'remove', '--force', agentWorktree]) } catch { /* already gone */ } }
      try { await this.git(['branch', '-d', c.branch]) } catch { /* deleted or unmerged-elsewhere — leave it */ }
      return { status: 'shipped', hash }
    } finally {
      try { await this.git(['worktree', 'remove', '--force', tmp]) } catch { /* not registered */ }
      try { await rm(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'

const run = promisify(execFile)

export type ShipCandidate = {
  boardId: number
  cardId: number
  branch: string
  title: string
  // immutable accepted-delivery tip; restart cleanup refuses a branch that moved
  sourceCommit?: string | null
  // the launched agent's worktree — removed once its branch is on main
  worktree?: string | null
}

type RegisteredWorktree = {
  path: string
  head: string
  branch: string | null
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
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (key.startsWith('GIT_')) delete environment[key]
    }
    environment.GIT_CONFIG_NOSYSTEM = '1'
    environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
    environment.GIT_NO_REPLACE_OBJECTS = '1'
    environment.GIT_OPTIONAL_LOCKS = '0'
    return run('git', args, {
      cwd,
      env: environment,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  }

  private async checkedBranch(branch: string): Promise<string> {
    const checked = (await this.git(['check-ref-format', '--branch', branch])).stdout.trim()
    if (checked !== branch) throw new Error(`candidate branch identity is invalid: ${branch}`)
    return branch
  }

  private async branchCommit(branch: string): Promise<string | null> {
    await this.checkedBranch(branch)
    const output = (await this.git([
      'for-each-ref', '--format=%(objectname)', '--count=2', `refs/heads/${branch}`,
    ])).stdout.trim()
    if (!output) return null
    const commits = output.split(/\r?\n/).filter(Boolean)
    if (commits.length !== 1) throw new Error(`candidate branch identity is ambiguous: ${branch}`)
    return commits[0].toLowerCase()
  }

  private async registeredWorktrees(): Promise<RegisteredWorktree[]> {
    const output = (await this.git(['worktree', 'list', '--porcelain', '-z'])).stdout
    return output.split('\0\0').filter(Boolean).map((block) => {
      const fields = block.split('\0').filter(Boolean)
      const worktree = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length)
      const head = fields.find((field) => field.startsWith('HEAD '))?.slice('HEAD '.length)
      const branch = fields.find((field) => field.startsWith('branch '))?.slice('branch '.length) ?? null
      if (!worktree || !head) throw new Error('git returned incomplete registered worktree identity')
      return { path: worktree, head: head.toLowerCase(), branch }
    })
  }

  // the unique registered worktree holding this exact branch, if any
  private async worktreeFor(branch: string): Promise<RegisteredWorktree | null> {
    await this.checkedBranch(branch)
    const matches = (await this.registeredWorktrees())
      .filter((entry) => entry.branch === `refs/heads/${branch}`)
    if (matches.length > 1) throw new Error(`multiple registered worktrees claim candidate branch ${branch}`)
    return matches[0] ?? null
  }

  private async cleanupCandidate(
    branch: string,
    sourceCommit: string,
    worktree: string | null,
  ): Promise<void> {
    const currentTip = await this.branchCommit(branch)
    if (currentTip !== null && currentTip !== sourceCommit) {
      throw new Error(`candidate branch moved after acceptance: ${branch}`)
    }
    const registered = await this.worktreeFor(branch)
    if (registered) {
      if (!worktree) throw new Error(`candidate worktree identity is missing for ${branch}`)
      const [expected, actual] = await Promise.all([realpath(worktree), realpath(registered.path)])
      if (expected !== actual) throw new Error(`registered worktree does not match candidate for ${branch}`)
      if (registered.head !== sourceCommit) {
        throw new Error(`registered worktree HEAD does not match accepted source commit for ${branch}`)
      }
      const dirty = (await this.git(
        ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'],
        registered.path,
      )).stdout.trim()
      if (dirty) throw new Error(`candidate worktree is dirty and was preserved for ${branch}`)
      await this.git(['worktree', 'remove', registered.path])
    }
    if (await this.worktreeFor(branch)) throw new Error(`worktree cleanup incomplete for ${branch}`)
    if (worktree) {
      try {
        await lstat(worktree)
        throw new Error(`candidate worktree path remains after cleanup for ${branch}`)
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    const beforeDelete = await this.branchCommit(branch)
    if (beforeDelete !== null && beforeDelete !== sourceCommit) {
      throw new Error(`candidate branch moved during cleanup: ${branch}`)
    }
    if (beforeDelete !== null) {
      await this.git(['update-ref', '-d', `refs/heads/${branch}`, sourceCommit])
    }
    if (await this.branchCommit(branch)) throw new Error(`branch cleanup incomplete for ${branch}`)
  }

  private async ship(c: ShipCandidate): Promise<{ status: 'shipped' | 'failed' | 'skipped'; hash?: string; reason?: string; detail?: string }> {
    let sha: string
    try {
      await this.checkedBranch(c.branch)
      sha = (await this.git([
        'rev-parse', '--verify', '--end-of-options', `refs/heads/${c.branch}^{commit}`,
      ])).stdout.trim().toLowerCase()
    } catch {
      if (c.sourceCommit) {
        return {
          status: 'failed',
          reason: 'candidate cleanup unresolved',
          detail: `accepted branch no longer resolves before exact worktree cleanup proof: ${c.branch}`,
        }
      }
      return { status: 'skipped', reason: `branch not found: ${c.branch}` }
    }
    if (c.sourceCommit !== undefined && c.sourceCommit !== null) {
      const accepted = c.sourceCommit.toLowerCase()
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(accepted) || accepted !== sha) {
        return {
          status: 'failed',
          reason: 'candidate identity changed',
          detail: `${c.branch}: accepted ${c.sourceCommit}, current ${sha}`,
        }
      }
    }
    // A restart can observe main after the merge but before cleanup/receipt recording. In that
    // state the exact accepted candidate is recovered, cleaned, and only then exposed as shipped.
    let alreadyMerged = false
    try {
      await this.git(['merge-base', '--is-ancestor', sha, 'main'])
      alreadyMerged = true
    } catch { /* not an ancestor — proceed through merge/test */ }
    if (alreadyMerged) {
      const liveBranch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
      if (liveBranch !== 'main') {
        return { status: 'failed', reason: 'live checkout not on main', detail: liveBranch }
      }
      const hash = (await this.git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim().toLowerCase()
      await this.cleanupCandidate(c.branch, sha, c.worktree ?? null)
      await this.hooks.recordShipped(c.cardId, hash)
      return { status: 'shipped', hash }
    }

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
      const agentWorktree = c.worktree ?? (await this.worktreeFor(c.branch))?.path ?? null
      await this.git(['merge', '--no-ff', sha, '-m', subject])
      const hash = (await this.git(['rev-parse', 'HEAD'])).stdout.trim()

      // Do not expose success while branch plumbing can still race consumers. Cleanup uses an
      // exact source-tip compare-and-delete, and any incomplete cleanup fails the queue item after
      // merge; the durable autoship intent can then reconcile the observed main HEAD on restart.
      await this.cleanupCandidate(c.branch, sha, agentWorktree)
      await this.hooks.recordShipped(c.cardId, hash)
      return { status: 'shipped', hash }
    } finally {
      try { await this.git(['worktree', 'remove', '--force', tmp]) } catch { /* not registered */ }
      try { await rm(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

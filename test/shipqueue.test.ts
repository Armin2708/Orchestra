import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { ShipQueue, shipGate, autoshipEnabled, ShipCandidate } from '../src/shipqueue.js'

const run = promisify(execFile)
const git = (cwd: string, ...args: string[]) => run('git', args, { cwd })

// a temp repo whose test suite goes red iff a file named broken.txt exists
async function mkRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orch-ship-repo-'))
  await git(dir, 'init', '-b', 'main')
  await git(dir, 'config', 'user.email', 't@t')
  await git(dir, 'config', 'user.name', 't')
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', scripts: { test: 'node check.js' } }))
  await writeFile(path.join(dir, 'check.js'), `process.exit(require('fs').existsSync('broken.txt') ? 1 : 0)`)
  await writeFile(path.join(dir, 'base.txt'), 'base\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-m', 'init')
  return dir
}

async function mkBranch(dir: string, name: string, files: Record<string, string>) {
  await git(dir, 'checkout', '-q', '-b', name)
  for (const [f, content] of Object.entries(files)) await writeFile(path.join(dir, f), content)
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-m', `work on ${name}`)
  await git(dir, 'checkout', '-q', 'main')
}

type Ev = { type: string; data: any }
function harness(dir: string, over: Partial<ConstructorParameters<typeof ShipQueue>[1]> = {}) {
  const events: Ev[] = []
  const shipped: [number, string][] = []
  const failures: [number, string, string][] = []
  const q = new ShipQueue(dir, {
    onEvent: (type, data) => events.push({ type, data }),
    recordShipped: (cardId, hash) => { shipped.push([cardId, hash]) },
    onSuccess: () => {},
    onFailure: (c, reason, detail) => failures.push([c.cardId, reason, detail]),
    ...over,
  })
  return { q, events, shipped, failures }
}

const until = async (cond: () => boolean, ms = 20000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition never became true')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const cand = (cardId: number, branch: string, title = 'a change'): ShipCandidate =>
  ({ boardId: 1, cardId, branch, title })

it('ships a green branch: --no-ff merge on main, shipped recorded, branch deleted', async () => {
  const dir = await mkRepo()
  await mkBranch(dir, 'card-7', { 'feature.txt': 'hi\n' })
  const h = harness(dir)
  expect(h.q.enqueue(cand(7, 'card-7', 'add feature'))).toMatchObject({ queued: true })
  await until(() => h.events.some((e) => e.type === 'shipped'))

  const subject = (await git(dir, 'log', '-1', '--pretty=%s')).stdout.trim()
  expect(subject).toBe('merge: add feature (#7)')
  const parents = (await git(dir, 'log', '-1', '--pretty=%P')).stdout.trim().split(' ')
  expect(parents).toHaveLength(2) // --no-ff even for a fast-forwardable branch
  expect((await git(dir, 'show', 'main:feature.txt')).stdout).toBe('hi\n')
  const head = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim()
  expect(h.shipped).toEqual([[7, head]])
  const branches = (await git(dir, 'branch', '--list', 'card-7')).stdout.trim()
  expect(branches).toBe('') // merged branch cleaned up
}, 30000)

it('does not expose shipment success until the candidate worktree and branch are both gone', async () => {
  const dir = await mkRepo()
  await mkBranch(dir, 'card-71', { 'cleanup-order.txt': 'safe\n' })
  const holder = await mkdtemp(path.join(os.tmpdir(), 'orch-ship-agent-worktree-'))
  const worktree = path.join(holder, 'card-71')
  await git(dir, 'worktree', 'add', worktree, 'card-71')
  let recordObservedCleanup = false
  const h = harness(dir, {
    recordShipped: async () => {
      const worktrees = (await git(dir, 'worktree', 'list', '--porcelain')).stdout
      const branch = (await git(dir, 'branch', '--list', 'card-71')).stdout.trim()
      expect(worktrees).not.toContain(worktree)
      expect(branch).toBe('')
      recordObservedCleanup = true
    },
  })

  h.q.enqueue({ ...cand(71, 'card-71'), worktree })
  await until(() => h.events.some((event) => ['shipped', 'failed'].includes(event.type)))

  expect(h.failures).toEqual([])
  expect(recordObservedCleanup).toBe(true)
}, 30000)

it('recovers an already-merged exact candidate by cleaning its registered worktree and branch first', async () => {
  const dir = await mkRepo()
  await mkBranch(dir, 'card-72', { 'restart-cleanup.txt': 'safe\n' })
  const sourceCommit = (await git(dir, 'rev-parse', 'card-72')).stdout.trim()
  const holder = await mkdtemp(path.join(os.tmpdir(), 'orch-ship-restart-worktree-'))
  const worktree = path.join(holder, 'card-72')
  await git(dir, 'worktree', 'add', worktree, 'card-72')
  await git(dir, 'merge', '--no-ff', 'card-72', '-m', 'merge before restart')
  let recordedAfterCleanup = false
  const h = harness(dir, {
    recordShipped: async () => {
      expect((await git(dir, 'worktree', 'list', '--porcelain')).stdout).not.toContain(worktree)
      expect((await git(dir, 'branch', '--list', 'card-72')).stdout.trim()).toBe('')
      recordedAfterCleanup = true
    },
  })

  h.q.enqueue({ ...cand(72, 'card-72'), sourceCommit, worktree })
  await until(() => h.events.some((event) => ['shipped', 'failed'].includes(event.type)))

  expect(h.failures).toEqual([])
  expect(recordedAfterCleanup).toBe(true)
}, 30000)

it('preserves candidate and unrelated worktrees when restart cleanup is given the wrong path', async () => {
  const dir = await mkRepo()
  await mkBranch(dir, 'card-73', { 'candidate.txt': 'candidate\n' })
  const sourceCommit = (await git(dir, 'rev-parse', 'card-73')).stdout.trim()
  await mkBranch(dir, 'card-730', { 'unrelated.txt': 'unrelated\n' })
  const holder = await mkdtemp(path.join(os.tmpdir(), 'orch-ship-identity-worktrees-'))
  const candidateWorktree = path.join(holder, 'candidate')
  const unrelatedWorktree = path.join(holder, 'unrelated')
  await git(dir, 'worktree', 'add', candidateWorktree, 'card-73')
  await git(dir, 'worktree', 'add', unrelatedWorktree, 'card-730')
  await git(dir, 'merge', '--no-ff', 'card-73', '-m', 'merge candidate before restart')
  const h = harness(dir)

  h.q.enqueue({ ...cand(73, 'card-73'), sourceCommit, worktree: unrelatedWorktree })
  await until(() => h.failures.length > 0)

  expect(h.failures[0][1]).toBe('ship error')
  expect(h.failures[0][2]).toMatch(/registered worktree does not match candidate/)
  const registrations = (await git(dir, 'worktree', 'list', '--porcelain')).stdout
  expect(registrations).toContain(candidateWorktree)
  expect(registrations).toContain(unrelatedWorktree)
  expect((await git(dir, 'branch', '--list', 'card-73')).stdout.trim()).not.toBe('')
  expect((await git(dir, 'branch', '--list', 'card-730')).stdout.trim()).not.toBe('')
  expect(h.shipped).toEqual([])
}, 30000)

it('preserves a branch that moved after the accepted source commit', async () => {
  const dir = await mkRepo()
  await mkBranch(dir, 'card-74', { 'accepted.txt': 'accepted\n' })
  const sourceCommit = (await git(dir, 'rev-parse', 'card-74')).stdout.trim()
  await git(dir, 'merge', '--no-ff', 'card-74', '-m', 'merge accepted source')
  await git(dir, 'branch', '-f', 'card-74', 'main')
  const movedCommit = (await git(dir, 'rev-parse', 'card-74')).stdout.trim()
  expect(movedCommit).not.toBe(sourceCommit)
  const h = harness(dir)

  h.q.enqueue({ ...cand(74, 'card-74'), sourceCommit })
  await until(() => h.failures.length > 0)

  expect(h.failures[0][1]).toBe('candidate identity changed')
  expect((await git(dir, 'rev-parse', 'card-74')).stdout.trim()).toBe(movedCommit)
  expect(h.shipped).toEqual([])
}, 30000)

it('preserves a dirty accepted worktree instead of forcing restart cleanup', async () => {
  const dir = await mkRepo()
  await mkBranch(dir, 'card-75', { 'accepted-clean.txt': 'accepted\n' })
  const sourceCommit = (await git(dir, 'rev-parse', 'card-75')).stdout.trim()
  const holder = await mkdtemp(path.join(os.tmpdir(), 'orch-ship-dirty-worktree-'))
  const worktree = path.join(holder, 'card-75')
  await git(dir, 'worktree', 'add', worktree, 'card-75')
  await git(dir, 'merge', '--no-ff', 'card-75', '-m', 'merge dirty candidate before restart')
  await writeFile(path.join(worktree, 'accepted-clean.txt'), 'tracked but uncommitted\n')
  await writeFile(path.join(worktree, 'uncommitted.txt'), 'preserve me\n')
  const h = harness(dir)

  h.q.enqueue({ ...cand(75, 'card-75'), sourceCommit, worktree })
  await until(() => h.failures.length > 0)

  expect(h.failures[0][1]).toBe('ship error')
  expect(h.failures[0][2]).toMatch(/dirty and was preserved/)
  expect((await git(dir, 'worktree', 'list', '--porcelain')).stdout).toContain(worktree)
  expect((await git(dir, 'branch', '--list', 'card-75')).stdout.trim()).not.toBe('')
  expect(h.shipped).toEqual([])
}, 30000)

it('blocks when the accepted branch vanished but its canonical worktree still exists', async () => {
  const dir = await mkRepo()
  await mkBranch(dir, 'card-76', { 'accepted-detached.txt': 'accepted\n' })
  const sourceCommit = (await git(dir, 'rev-parse', 'card-76')).stdout.trim()
  const holder = await mkdtemp(path.join(os.tmpdir(), 'orch-ship-detached-worktree-'))
  const worktree = path.join(holder, 'card-76')
  await git(dir, 'worktree', 'add', worktree, 'card-76')
  await git(dir, 'merge', '--no-ff', 'card-76', '-m', 'merge before detached cleanup failure')
  await git(worktree, 'checkout', '--detach', sourceCommit)
  await git(dir, 'branch', '-d', 'card-76')
  const h = harness(dir)

  h.q.enqueue({ ...cand(76, 'card-76'), sourceCommit, worktree })
  await until(() => h.failures.length > 0)

  expect(h.failures[0][1]).toBe('candidate cleanup unresolved')
  expect((await git(dir, 'worktree', 'list', '--porcelain')).stdout).toContain(worktree)
  expect(h.shipped).toEqual([])
}, 30000)

it('ignores ambient Git directory and worktree overrides during exact cleanup', async () => {
  const dir = await mkRepo()
  await mkBranch(dir, 'card-77', { 'sanitized-git-env.txt': 'safe\n' })
  const sourceCommit = (await git(dir, 'rev-parse', 'card-77')).stdout.trim()
  const h = harness(dir)
  process.env.GIT_DIR = path.join(dir, 'attacker-controlled-git-dir')
  process.env.GIT_WORK_TREE = path.join(dir, 'attacker-controlled-work-tree')
  try {
    h.q.enqueue({ ...cand(77, 'card-77'), sourceCommit })
    await until(() => h.events.some((event) => ['shipped', 'failed'].includes(event.type)))
  } finally {
    delete process.env.GIT_DIR
    delete process.env.GIT_WORK_TREE
  }

  expect(h.failures).toEqual([])
  expect(h.shipped).toHaveLength(1)
  expect((await git(dir, 'branch', '--list', 'card-77')).stdout.trim()).toBe('')
}, 30000)

it('a red suite leaves main untouched, keeps the branch, and reports the output', async () => {
  const dir = await mkRepo()
  const before = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim()
  await mkBranch(dir, 'card-8', { 'broken.txt': 'boom\n' })
  const h = harness(dir)
  h.q.enqueue(cand(8, 'card-8'))
  await until(() => h.failures.length > 0)

  expect(h.failures[0][0]).toBe(8)
  expect(h.failures[0][1]).toBe('tests failed')
  expect((await git(dir, 'rev-parse', 'HEAD')).stdout.trim()).toBe(before) // main untouched
  expect((await git(dir, 'branch', '--list', 'card-8')).stdout.trim()).not.toBe('') // preserved for the owner
  expect(h.shipped).toHaveLength(0)
}, 30000)

it('a merge conflict blocks with the conflicting file list, main untouched', async () => {
  const dir = await mkRepo()
  await mkBranch(dir, 'card-9', { 'base.txt': 'nine\n' })
  await mkBranch(dir, 'card-10', { 'base.txt': 'ten\n' })
  const h = harness(dir)
  h.q.enqueue(cand(9, 'card-9'))
  await until(() => h.events.some((e) => e.type === 'shipped'))
  h.q.enqueue(cand(10, 'card-10'))
  await until(() => h.failures.length > 0)

  expect(h.failures[0][1]).toBe('merge conflict')
  expect(h.failures[0][2]).toContain('base.txt')
  expect((await git(dir, 'show', 'main:base.txt')).stdout).toBe('nine\n') // only card-9 landed
}, 40000)

it('integrates strictly one at a time in arrival order', async () => {
  const dir = await mkRepo()
  await mkBranch(dir, 'card-11', { 'a.txt': 'a\n' })
  await mkBranch(dir, 'card-12', { 'b.txt': 'b\n' })
  let concurrent = 0, maxConcurrent = 0
  const h = harness(dir, {
    runTests: async () => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 150))
      concurrent--
      return { ok: true, output: '' }
    },
  })
  h.q.enqueue(cand(11, 'card-11'))
  h.q.enqueue(cand(12, 'card-12'))
  await until(() => h.events.filter((e) => e.type === 'shipped').length === 2)

  expect(maxConcurrent).toBe(1)
  const order = h.events.filter((e) => e.type === 'shipping').map((e) => e.data.card_id)
  expect(order).toEqual([11, 12])
  // both merges present, serialized on top of each other
  expect((await git(dir, 'show', 'main:a.txt')).stdout).toBe('a\n')
  expect((await git(dir, 'show', 'main:b.txt')).stdout).toBe('b\n')
}, 40000)

it('re-approving an already-merged branch is a no-op skip; double-enqueue dedupes', async () => {
  const dir = await mkRepo()
  await mkBranch(dir, 'card-13', { 'c.txt': 'c\n' })
  const h = harness(dir)
  h.q.enqueue(cand(13, 'card-13'))
  await until(() => h.events.some((e) => e.type === 'shipped'))
  h.q.enqueue(cand(13, 'card-13'))
  await until(() => h.events.some((e) => e.type === 'skipped'))
  expect(h.shipped).toHaveLength(1)
  expect(h.q.enqueue(cand(99, 'no-such-branch')).queued).toBe(true)
  await until(() => h.events.filter((e) => e.type === 'skipped').length === 2)
  expect(h.events.filter((e) => e.type === 'skipped').at(-1)?.data.reason).toContain('branch')
}, 30000)

it('shipGate blocks only unconfirmed-fail verdicts; gaps warn and queue', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  db.prepare(`INSERT INTO cards (board_id, title) VALUES (1, 'x')`).run()
  const verdict = (v: string) => db.prepare(
    `INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (1, NULL, 'verification', ?)`)
    .run(JSON.stringify({ criteria: [], verdict: v, tested: true }))

  expect(shipGate(db, 1, {})).toMatchObject({ queue: true }) // no verdict at all
  verdict('pass')
  expect(shipGate(db, 1, {})).toMatchObject({ queue: true })
  verdict('gaps')
  const gaps = shipGate(db, 1, {})
  expect(gaps.queue).toBe(true)
  expect(gaps.warn).toBeTruthy()
  verdict('fail')
  expect(shipGate(db, 1, {})).toMatchObject({ queue: false })
  expect(shipGate(db, 1, { confirmed: true })).toMatchObject({ queue: true }) // explicit-confirm approve
  verdict('pass') // newest verdict wins
  expect(shipGate(db, 1, {})).toMatchObject({ queue: true })
})

it('ORCHESTRA_AUTOSHIP=0 disables the queue trigger', () => {
  delete process.env.ORCHESTRA_AUTOSHIP
  expect(autoshipEnabled()).toBe(true)
  process.env.ORCHESTRA_AUTOSHIP = '0'
  expect(autoshipEnabled()).toBe(false)
  delete process.env.ORCHESTRA_AUTOSHIP
})

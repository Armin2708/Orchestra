import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Deploying Orchestra means replacing dist/ and web/dist/ under the daemon. Several agents
// share one checkout, and each of them also has a private worktree holding only their own
// branch — so a build made in a worktree contains main plus that one branch and NOTHING
// that anybody else has in flight. rsyncing such a build over the shared checkout silently
// reverts every peer's work in the running app while leaving their source untouched, which
// reads as "my feature vanished" rather than "someone deployed over me". It cost this
// project most of an afternoon, three times.
//
// The rule this module enforces: build the deploy from the shared checkout, which is the
// only tree that holds everyone's work at once, and never from a linked worktree.

export type DeployTarget = { label: string; artifact: string; build: string[] }

export const DEPLOY_TARGETS: DeployTarget[] = [
  { label: 'server', artifact: 'dist/cli.js', build: ['run', 'build'] },
  { label: 'web', artifact: 'web/dist/index.html', build: ['--prefix', 'web', 'run', 'build'] },
]

// source trees whose mtimes decide whether an artifact is stale
const SOURCE_DIRS = ['src', 'web/src']
const SOURCE_EXT = new Set(['.ts', '.tsx', '.css', '.html', '.json'])

export class DeployRefused extends Error {}

export function repoRoot(cwd = process.cwd()): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
}

// A linked worktree keeps its own .git dir under <common>/worktrees/<name>; the primary
// checkout is the one where the two resolve to the same place.
export function isLinkedWorktree(root: string): boolean {
  const at = (arg: string) =>
    path.resolve(root, execFileSync('git', ['rev-parse', arg], { cwd: root, encoding: 'utf8' }).trim())
  try { return at('--git-dir') !== at('--git-common-dir') } catch { return false }
}

export function newestSourceMtime(root: string): number {
  let newest = 0
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!SOURCE_EXT.has(path.extname(entry.name))) continue
      const { mtimeMs } = fs.statSync(full)
      if (mtimeMs > newest) newest = mtimeMs
    }
  }
  for (const dir of SOURCE_DIRS) walk(path.join(root, dir))
  return newest
}

export type DeployStatus = {
  root: string
  linkedWorktree: boolean
  newestSource: number
  artifacts: { label: string; artifact: string; builtAt: number | null; stale: boolean }[]
  stale: boolean
}

export function deployStatus(root = repoRoot()): DeployStatus {
  const newestSource = newestSourceMtime(root)
  const artifacts = DEPLOY_TARGETS.map((target) => {
    let builtAt: number | null = null
    try { builtAt = fs.statSync(path.join(root, target.artifact)).mtimeMs } catch { /* never built */ }
    return {
      label: target.label,
      artifact: target.artifact,
      builtAt,
      stale: builtAt === null || builtAt < newestSource,
    }
  })
  return {
    root,
    linkedWorktree: isLinkedWorktree(root),
    newestSource,
    artifacts,
    stale: artifacts.some((a) => a.stale),
  }
}

export function describeDeployStatus(status: DeployStatus): string {
  const lines = status.artifacts.map((a) => {
    const when = a.builtAt === null ? 'never built' : new Date(a.builtAt).toLocaleTimeString()
    return `  ${a.stale ? '✗' : '✓'} ${a.label.padEnd(6)} ${a.artifact} (${when})`
  })
  const head = status.stale
    ? 'the running build is older than the source in this checkout'
    : 'the build matches the source in this checkout'
  return [head, ...lines].join('\n')
}

// Refuse before anything is built, so a wrong-tree deploy costs nothing.
export function assertDeployable(status: DeployStatus): void {
  if (!status.linkedWorktree) return
  throw new DeployRefused(
    'refusing to deploy from a linked worktree.\n'
    + 'A worktree holds main plus your branch only, so its build would drop every other\n'
    + "agent's in-flight work from the running app while leaving their source in place.\n"
    + 'Run the deploy from the shared checkout instead (the one `git worktree list` shows first).',
  )
}

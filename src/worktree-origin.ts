import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * The main-repository root behind a LINKED git worktree, or null for anything else.
 *
 * The project's own workflow tells agents to isolate multi-file work in a worktree, and
 * autoship puts every launched card in one (`cardWorktree`). A linked worktree is a
 * SIBLING directory with its own git root, so board lookup's walk-up-to-an-ancestor never
 * reaches the project it belongs to — the agent 404s on every `orchestra` command.
 *
 * `--git-common-dir` points at the MAIN repo's .git from inside a linked worktree, which is
 * exactly the parent we need. Two conditions must BOTH hold, and together they exclude
 * every other repository shape:
 *   linked worktree → common-dir `<main>/.git`, git-dir `<main>/.git/worktrees/<n>`  (differ)
 *   main checkout   → common-dir === git-dir === `<main>/.git`                        (equal)
 *   submodule       → common-dir === git-dir === `<super>/.git/modules/<n>`           (equal, and not `.git`)
 *   bare repo       → no work tree at all; callers never reach here with a git root
 * so a main checkout, a submodule, a separate-git-dir checkout and a non-git folder all
 * return null and keep their current behaviour untouched.
 */
export function mainRepoOfWorktree(dir: string): string | null {
  let start: string
  try {
    start = path.resolve(dir)
    if (!fs.statSync(start).isDirectory()) return null
  } catch { return null }

  // rev-parse only: it reads refs and config but never the index, so none of git's
  // command-hook config knobs (fsmonitor, filters, hooks) can run off a caller-supplied path.
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync('git', args, {
        cwd: start, timeout: 5_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    } catch { return null }
  }

  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir')
  const own = git('rev-parse', '--path-format=absolute', '--git-dir')
  if (!common || !own || common === own) return null
  if (path.basename(common) !== '.git') return null

  const root = path.dirname(common)
  // the derived parent must itself be a real checkout, never a bare/other directory
  return fs.existsSync(path.join(root, '.git')) ? root : null
}

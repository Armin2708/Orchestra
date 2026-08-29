import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { mainRepoOfWorktree } from '../src/worktree-origin.js'

// Real git repositories: the whole point is the git-common-dir behaviour, so stubbing
// git would test the stub. Nothing here assumes a checkout name, branch or inode.
const temps: string[] = []
const tmpdir = (label: string) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `orchestra-${label}-`)))
  temps.push(dir)
  return dir
}
afterAll(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })

function repo(label: string): string {
  const root = path.join(tmpdir(label), 'project')
  fs.mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'test')
  fs.writeFileSync(path.join(root, 'README'), 'x')
  git(root, 'add', 'README')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

const resolve = async (s: Awaited<ReturnType<typeof buildServer>>, project_path: string) =>
  s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path } })

// THE BUG: agents are told to isolate work in a worktree and every launched card gets
// one, but a linked worktree is a SIBLING directory — the ancestor walk never reaches
// the project, so `orchestra card`/`mail`/`snapshot` 404 for the whole session.
it('resolve attaches a linked worktree session to its main repo board', async () => {
  const root = repo('wt')
  const wt = path.join(path.dirname(root), 'project-card-42')
  git(root, 'worktree', 'add', '-q', wt, '-b', 'card-42')

  const s = buildServer(openDb(':memory:')); await s.ready()
  const board = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve',
    payload: { project_path: root, create: true } })).json()

  const fromWorktree = await resolve(s, wt)
  expect(fromWorktree.statusCode).toBe(200)
  expect(fromWorktree.json().id).toBe(board.id)

  // a subfolder of the worktree resolves too — hooks post the raw session cwd
  fs.mkdirSync(path.join(wt, 'src'))
  expect((await resolve(s, path.join(wt, 'src'))).json().id).toBe(board.id)
})

// Creation is an operator act. A worktree must never mint a board for its main repo.
it('a worktree whose main repo is not a board stays untracked', async () => {
  const root = repo('unreg')
  const wt = path.join(path.dirname(root), 'project-card-7')
  git(root, 'worktree', 'add', '-q', wt, '-b', 'card-7')

  const s = buildServer(openDb(':memory:')); await s.ready()
  expect((await resolve(s, wt)).statusCode).toBe(404)
  expect((await s.inject({ method: 'GET', url: '/api/v1/boards' })).json()).toHaveLength(0)
})

// The main checkout, submodules and plain folders must behave exactly as before.
it('main checkouts, submodules and non-git folders are unaffected', async () => {
  const root = repo('main')
  expect(mainRepoOfWorktree(root)).toBeNull()

  const sub = repo('submod')
  const superRoot = repo('super')
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor'],
    { cwd: superRoot, stdio: ['ignore', 'pipe', 'ignore'] })
  expect(mainRepoOfWorktree(path.join(superRoot, 'vendor'))).toBeNull()

  const plain = tmpdir('plain')
  expect(mainRepoOfWorktree(plain)).toBeNull()
  expect(mainRepoOfWorktree(path.join(plain, 'missing'))).toBeNull()

  // a bare repo has no work tree, so nothing is derived from it
  const bare = path.join(tmpdir('bare'), 'x.git')
  execFileSync('git', ['init', '--bare', '-q', bare], { stdio: 'ignore' })
  expect(mainRepoOfWorktree(bare)).toBeNull()

  // and a registered main checkout still resolves by exact path
  const s = buildServer(openDb(':memory:')); await s.ready()
  const board = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve',
    payload: { project_path: root, create: true } })).json()
  expect((await resolve(s, root)).json().id).toBe(board.id)
})

// A worktree's own main repo beats an unrelated registered directory above it.
it('the main repo wins over a registered ancestor of the worktree', async () => {
  const root = repo('precedence')
  const parent = path.dirname(root)
  const wt = path.join(parent, 'project-card-9')
  git(root, 'worktree', 'add', '-q', wt, '-b', 'card-9')

  const s = buildServer(openDb(':memory:')); await s.ready()
  const ancestor = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve',
    payload: { project_path: parent, create: true } })).json()
  const project = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve',
    payload: { project_path: root, create: true } })).json()

  const got = (await resolve(s, wt)).json()
  expect(got.id).toBe(project.id)
  expect(got.id).not.toBe(ancestor.id)
})

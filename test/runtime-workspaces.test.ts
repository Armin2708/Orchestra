import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryWorkspaceStore, WorkspaceManager } from '../src/runtime/index.js'

const tempRoots: string[] = []

const command = (file: string, args: string[], cwd: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
  execFile(file, args, { cwd }, (error, stdout, stderr) => {
    if (error) reject(error)
    else resolve({ stdout: String(stdout), stderr: String(stderr) })
  })
})

const git = (cwd: string, ...args: string[]) => command('git', args, cwd)

async function repository() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'orchestra-runtime-workspaces-'))
  tempRoots.push(base)
  const repo = path.join(base, 'repo')
  const worktrees = path.join(base, 'worktrees')
  await mkdir(repo)
  await git(repo, 'init', '-b', 'main')
  await git(repo, 'config', 'user.email', 'runtime@test.invalid')
  await git(repo, 'config', 'user.name', 'Runtime Test')
  await writeFile(path.join(repo, 'README.md'), 'base\n')
  await git(repo, 'add', 'README.md')
  await git(repo, 'commit', '-m', 'initial')
  return { base, repo, worktrees }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WorkspaceManager', () => {
  it('reuses a shared workspace without changing the checkout', async () => {
    const { repo, worktrees } = await repository()
    const store = new MemoryWorkspaceStore()
    const manager = new WorkspaceManager({ store, worktreeRoot: worktrees })
    const before = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()

    const first = await manager.create({ boardId: 1, name: 'Shared', kind: 'shared', rootPath: repo })
    const second = await manager.create({ boardId: 1, name: 'Another label', kind: 'shared', rootPath: repo })

    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({ kind: 'shared', branch: 'main', worktreePath: null, status: 'active' })
    expect((await git(repo, 'rev-parse', 'HEAD')).stdout.trim()).toBe(before)
    expect((await git(repo, 'branch', '--show-current')).stdout.trim()).toBe('main')
  })

  it('creates and reuses an isolated worktree while leaving the shared branch untouched', async () => {
    const { repo, worktrees } = await repository()
    const store = new MemoryWorkspaceStore()
    const manager = new WorkspaceManager({ store, worktreeRoot: worktrees })

    const workspace = await manager.create({
      boardId: 1,
      cardId: 7,
      name: 'Feature Seven',
      kind: 'worktree',
      rootPath: repo,
      branch: 'agent/feature-seven',
      baseRef: 'main',
    })
    const reused = await manager.create({
      boardId: 1,
      cardId: 7,
      name: 'Feature Seven',
      kind: 'worktree',
      rootPath: repo,
      branch: 'agent/feature-seven',
    })

    expect(reused.id).toBe(workspace.id)
    expect(workspace.worktreePath).toBe(await realpath(path.join(worktrees, 'feature-seven')))
    expect((await git(repo, 'branch', '--show-current')).stdout.trim()).toBe('main')
    expect((await git(workspace.worktreePath!, 'branch', '--show-current')).stdout.trim()).toBe('agent/feature-seven')
  })

  it('adopts an already-registered matching worktree after a persistence restart', async () => {
    const { repo, worktrees } = await repository()
    const first = new WorkspaceManager({ store: new MemoryWorkspaceStore(), worktreeRoot: worktrees })
    const created = await first.create({
      boardId: 1, name: 'Durable', kind: 'worktree', rootPath: repo, branch: 'agent/durable',
    })
    const restarted = new WorkspaceManager({ store: new MemoryWorkspaceStore(), worktreeRoot: worktrees })

    const adopted = await restarted.create({
      boardId: 1, name: 'Durable', kind: 'worktree', rootPath: repo, branch: 'agent/durable',
    })

    expect(adopted.worktreePath).toBe(created.worktreePath)
    expect((await git(repo, 'worktree', 'list', '--porcelain')).stdout.match(/worktree /g)).toHaveLength(2)
  })

  it('never applies a fresh checkpoint fork into an already registered worktree', async () => {
    const { repo, worktrees } = await repository()
    const first = new WorkspaceManager({ store: new MemoryWorkspaceStore(), worktreeRoot: worktrees })
    const created = await first.create({
      boardId: 1, name: 'Existing', kind: 'worktree', rootPath: repo, branch: 'agent/existing',
    })
    const restarted = new WorkspaceManager({ store: new MemoryWorkspaceStore(), worktreeRoot: worktrees })

    await expect(restarted.create({
      boardId: 1,
      name: 'Checkpoint fork',
      kind: 'worktree',
      rootPath: repo,
      branch: 'agent/existing',
      worktreePath: created.worktreePath!,
      reuseExisting: false,
    })).rejects.toThrow(/already exists|already registered/)
    expect((await git(repo, 'worktree', 'list', '--porcelain')).stdout.match(/worktree /g)).toHaveLength(2)
  })

  it('refuses escape paths and preserves dirty worktrees during removal', async () => {
    const { base, repo, worktrees } = await repository()
    const store = new MemoryWorkspaceStore()
    const manager = new WorkspaceManager({ store, worktreeRoot: worktrees })
    await expect(manager.create({
      boardId: 1,
      name: 'Escape',
      kind: 'worktree',
      rootPath: repo,
      branch: 'agent/escape',
      worktreePath: path.join(base, 'outside'),
    })).rejects.toThrow('must stay under')

    const workspace = await manager.create({
      boardId: 1, name: 'Dirty', kind: 'worktree', rootPath: repo, branch: 'agent/dirty',
    })
    await writeFile(path.join(workspace.worktreePath!, 'uncommitted.txt'), 'keep me\n')
    await expect(manager.archive(workspace.id, { removeWorktree: true })).rejects.toThrow('dirty worktrees are preserved')
    expect((await stat(path.join(workspace.worktreePath!, 'uncommitted.txt'))).isFile()).toBe(true)

    const archived = await manager.archive(workspace.id)
    expect(archived.status).toBe('archived')
    expect((await stat(workspace.worktreePath!)).isDirectory()).toBe(true)
  })

  it('removes only a clean registered worktree and keeps its branch', async () => {
    const { repo, worktrees } = await repository()
    const manager = new WorkspaceManager({ store: new MemoryWorkspaceStore(), worktreeRoot: worktrees })
    const workspace = await manager.create({
      boardId: 1, name: 'Clean', kind: 'worktree', rootPath: repo, branch: 'agent/clean',
    })

    const archived = await manager.archive(workspace.id, { removeWorktree: true })

    expect(archived.status).toBe('archived')
    await expect(stat(workspace.worktreePath!)).rejects.toThrow()
    expect((await git(repo, 'branch', '--list', 'agent/clean')).stdout.trim()).toContain('agent/clean')
  })

  it('will not archive a workspace with a live process', async () => {
    const { repo, worktrees } = await repository()
    const manager = new WorkspaceManager({
      store: new MemoryWorkspaceStore(),
      worktreeRoot: worktrees,
      hasLiveProcesses: () => true,
    })
    const workspace = await manager.create({ boardId: 1, name: 'Busy', kind: 'shared', rootPath: repo })

    await expect(manager.archive(workspace.id)).rejects.toThrow('has live processes')
  })
})

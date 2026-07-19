import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  MaybePromise,
  OsId,
  WorkspaceEvent,
  WorkspaceRecord,
  WorkspaceStore,
} from './types.js'

export type CreateWorkspaceRequest = {
  boardId: number
  cardId?: number | null
  name: string
  kind: 'shared' | 'worktree'
  rootPath: string
  branch?: string
  baseRef?: string
  env?: Record<string, string>
  worktreePath?: string
  reuseExisting?: boolean
}

export type UpdateWorkspaceRequest = {
  cardId?: number | null
  name?: string
  baseRef?: string
  env?: Record<string, string>
}

export type ArchiveWorkspaceOptions = {
  removeWorktree?: boolean
}

export type WorkspaceManagerOptions = {
  store: WorkspaceStore
  worktreeRoot?: string | ((repoRoot: string) => string)
  gitTimeoutMs?: number
  hasLiveProcesses?: (workspaceId: OsId) => MaybePromise<boolean>
  onEvent?: (event: WorkspaceEvent) => MaybePromise<void>
}

type WorktreeEntry = {
  path: string
  branch: string | null
  detached: boolean
}

const safeName = (value: string): string => {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!normalized) throw new Error('workspace name must contain a letter or number')
  return normalized.slice(0, 80)
}

const isWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

const exists = async (target: string): Promise<boolean> => {
  try { await stat(target); return true } catch { return false }
}

export class WorkspaceManager {
  private readonly gitTimeoutMs: number

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.gitTimeoutMs = options.gitTimeoutMs ?? 30_000
  }

  async create(request: CreateWorkspaceRequest): Promise<WorkspaceRecord> {
    if (!Number.isInteger(request.boardId) || request.boardId <= 0) throw new Error('boardId must be a positive integer')
    const name = request.name.trim()
    if (!name) throw new Error('workspace name is required')
    const rootPath = await this.repoRoot(request.rootPath)
    const baseRef = request.baseRef?.trim() || 'HEAD'
    await this.git(rootPath, ['rev-parse', '--verify', `${baseRef}^{commit}`])

    if (request.kind === 'shared') return this.createShared({ ...request, name, rootPath, baseRef })
    return this.createWorktree({ ...request, name, rootPath, baseRef })
  }

  async list(filter: Parameters<WorkspaceStore['list']>[0] = {}): Promise<WorkspaceRecord[]> {
    return this.options.store.list(filter)
  }

  async get(id: OsId): Promise<WorkspaceRecord | undefined> {
    return this.options.store.get(id)
  }

  async update(id: OsId, patch: UpdateWorkspaceRequest): Promise<WorkspaceRecord> {
    const workspace = await this.required(id)
    if (workspace.status === 'archived') throw new Error(`workspace ${id} is archived`)
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('workspace name cannot be empty')
    if (patch.baseRef !== undefined) {
      const baseRef = patch.baseRef.trim()
      if (!baseRef) throw new Error('baseRef cannot be empty')
      await this.git(workspace.rootPath, ['rev-parse', '--verify', `${baseRef}^{commit}`])
    }
    const updated = await this.options.store.update(id, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.cardId !== undefined ? { cardId: patch.cardId } : {}),
      ...(patch.baseRef !== undefined ? { baseRef: patch.baseRef.trim() } : {}),
      ...(patch.env !== undefined ? { env: { ...patch.env } } : {}),
    })
    await this.emit(updated, 'workspace.updated', { fields: Object.keys(patch) })
    return updated
  }

  async archive(id: OsId, options: ArchiveWorkspaceOptions = {}): Promise<WorkspaceRecord> {
    const workspace = await this.required(id)
    if (workspace.status === 'archived') return workspace
    if (await this.options.hasLiveProcesses?.(id))
      throw new Error(`workspace ${id} has live processes and cannot be archived`)

    let removed = false
    if (options.removeWorktree) {
      if (workspace.kind !== 'worktree' || !workspace.worktreePath)
        throw new Error('shared workspaces are never removed')
      await this.assertSafeDestination(workspace.rootPath, workspace.worktreePath)
      const entries = await this.worktrees(workspace.rootPath)
      const registered = entries.find((entry) => path.resolve(entry.path) === path.resolve(workspace.worktreePath!))
      if (!registered) throw new Error(`worktree is not registered: ${workspace.worktreePath}`)
      const dirty = await this.git(workspace.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])
      if (dirty.stdout.trim()) throw new Error('dirty worktrees are preserved; commit, stash, or archive without removal')
      await this.git(workspace.rootPath, ['worktree', 'remove', workspace.worktreePath])
      removed = true
    }

    const archived = await this.options.store.update(id, { status: 'archived' })
    await this.emit(archived, removed ? 'workspace.removed' : 'workspace.archived', {
      worktreePreserved: workspace.kind === 'worktree' && !removed,
      branchPreserved: workspace.branch,
    })
    return archived
  }

  root(workspace: WorkspaceRecord): string {
    return workspace.worktreePath ?? workspace.rootPath
  }

  private async createShared(request: CreateWorkspaceRequest & { name: string; rootPath: string; baseRef: string }): Promise<WorkspaceRecord> {
    const current = await this.options.store.list({ boardId: request.boardId, status: 'active' })
    const existing = current.find((workspace) => workspace.kind === 'shared' && workspace.rootPath === request.rootPath)
    if (existing) {
      if (request.reuseExisting === false) throw new Error(`shared workspace already exists as ${existing.id}`)
      return existing
    }
    const branchResult = await this.git(request.rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)
    const workspace = await this.options.store.create({
      boardId: request.boardId,
      cardId: request.cardId ?? null,
      name: request.name,
      kind: 'shared',
      rootPath: request.rootPath,
      worktreePath: null,
      branch: branchResult.code === 0 ? branchResult.stdout.trim() || null : null,
      baseRef: request.baseRef,
      status: 'active',
      env: { ...(request.env ?? {}) },
    })
    await this.emit(workspace, 'workspace.created', { kind: 'shared', reused: false })
    return workspace
  }

  private async createWorktree(request: CreateWorkspaceRequest & { name: string; rootPath: string; baseRef: string }): Promise<WorkspaceRecord> {
    const branch = request.branch?.trim() || `orchestra/${safeName(request.name)}`
    await this.git(request.rootPath, ['check-ref-format', '--branch', branch])
    const allowedRoot = await this.ensureWorktreeRoot(request.rootPath)
    const destination = path.resolve(request.worktreePath ?? path.join(allowedRoot, safeName(request.name)))
    await this.assertSafeDestination(request.rootPath, destination)

    const current = await this.options.store.list({ boardId: request.boardId, status: 'active' })
    const existingRecord = current.find((workspace) => workspace.kind === 'worktree' &&
      workspace.worktreePath !== null && path.resolve(workspace.worktreePath) === destination)
    const entries = await this.worktrees(request.rootPath)
    const atDestination = entries.find((entry) => path.resolve(entry.path) === destination)
    if (existingRecord) {
      if (request.reuseExisting === false) throw new Error(`worktree workspace already exists as ${existingRecord.id}`)
      if (existingRecord.branch !== branch) throw new Error(`worktree path is already assigned to branch ${existingRecord.branch}`)
      if (atDestination?.branch === branch) return existingRecord
      if (atDestination)
        throw new Error(`registered worktree at ${destination} uses ${atDestination.branch ?? 'detached HEAD'}, not ${branch}`)
      await this.options.store.update(existingRecord.id, { status: 'missing' })
    }

    if (atDestination) {
      if (atDestination.branch !== branch)
        throw new Error(`registered worktree at ${destination} uses ${atDestination.branch ?? 'detached HEAD'}, not ${branch}`)
    } else {
      const branchElsewhere = entries.find((entry) => entry.branch === branch)
      if (branchElsewhere) throw new Error(`branch ${branch} is already checked out at ${branchElsewhere.path}`)
      if (await exists(destination)) {
        const info = await lstat(destination)
        if (info.isSymbolicLink()) throw new Error('worktree destination cannot be a symlink')
      }
      const branchExists = (await this.git(request.rootPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], true)).code === 0
      await this.git(request.rootPath, branchExists
        ? ['worktree', 'add', destination, branch]
        : ['worktree', 'add', destination, '-b', branch, request.baseRef])
    }

    try {
      const workspace = existingRecord
        ? await this.options.store.update(existingRecord.id, {
          cardId: request.cardId ?? null,
          name: request.name,
          baseRef: request.baseRef,
          status: 'active',
          env: { ...(request.env ?? {}) },
        })
        : await this.options.store.create({
          boardId: request.boardId,
          cardId: request.cardId ?? null,
          name: request.name,
          kind: 'worktree',
          rootPath: request.rootPath,
          worktreePath: destination,
          branch,
          baseRef: request.baseRef,
          status: 'active',
          env: { ...(request.env ?? {}) },
        })
      await this.emit(workspace, 'workspace.created', {
        kind: 'worktree', reused: Boolean(atDestination), recovered: Boolean(existingRecord),
      })
      return workspace
    } catch (error) {
      if (!atDestination) {
        await this.git(request.rootPath, ['worktree', 'remove', destination], true)
      }
      throw error
    }
  }

  private async required(id: OsId): Promise<WorkspaceRecord> {
    const workspace = await this.options.store.get(id)
    if (!workspace) throw new Error(`workspace ${id} not found`)
    return workspace
  }

  private async repoRoot(requested: string): Promise<string> {
    const resolved = await realpath(path.resolve(requested))
    const result = await this.git(resolved, ['rev-parse', '--show-toplevel'])
    return realpath(result.stdout.trim())
  }

  private worktreeRoot(repoRoot: string): string {
    const configured = this.options.worktreeRoot
    if (typeof configured === 'function') return path.resolve(configured(repoRoot))
    if (configured) return path.resolve(configured)
    return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-workspaces`)
  }

  private async ensureWorktreeRoot(repoRoot: string): Promise<string> {
    const root = this.worktreeRoot(repoRoot)
    if (path.resolve(root) === path.resolve(repoRoot) || isWithin(repoRoot, root))
      throw new Error('managed worktree root must be outside the shared checkout')
    await mkdir(root, { recursive: true })
    return realpath(root)
  }

  private async assertSafeDestination(repoRoot: string, destination: string): Promise<void> {
    const allowedRoot = await this.ensureWorktreeRoot(repoRoot)
    const target = path.resolve(destination)
    if (!isWithin(allowedRoot, target)) throw new Error(`worktree destination must stay under ${allowedRoot}`)

    let ancestor = target
    while (!(await exists(ancestor))) {
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw new Error('could not resolve worktree destination')
      ancestor = parent
    }
    const ancestorInfo = await lstat(ancestor)
    if (ancestorInfo.isSymbolicLink()) throw new Error('worktree destination cannot traverse a symlink')
    const canonicalAncestor = await realpath(ancestor)
    if (canonicalAncestor !== allowedRoot && !isWithin(allowedRoot, canonicalAncestor))
      throw new Error('worktree destination resolves outside the managed root')
  }

  private async worktrees(repoRoot: string): Promise<WorktreeEntry[]> {
    const result = await this.git(repoRoot, ['worktree', 'list', '--porcelain'])
    const entries: WorktreeEntry[] = []
    let current: WorktreeEntry | undefined
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current) entries.push(current)
        current = { path: line.slice('worktree '.length), branch: null, detached: false }
      } else if (current && line.startsWith('branch refs/heads/')) {
        current.branch = line.slice('branch refs/heads/'.length)
      } else if (current && line === 'detached') current.detached = true
    }
    if (current) entries.push(current)
    return entries
  }

  private async emit(workspace: WorkspaceRecord, kind: WorkspaceEvent['kind'], payload: Record<string, unknown>): Promise<void> {
    await this.options.onEvent?.({
      kind,
      workspaceId: workspace.id,
      boardId: workspace.boardId,
      at: new Date().toISOString(),
      payload,
    })
  }

  private git(cwd: string, args: string[], allowFailure = false): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout: this.gitTimeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
          ? (error as unknown as { code: number }).code : error ? 1 : 0
        const result = { stdout: String(stdout), stderr: String(stderr), code }
        if (!error || allowFailure) resolve(result)
        else reject(new Error(`git ${args[0]} failed: ${result.stderr.trim() || (error as Error).message}`))
      })
    })
  }
}

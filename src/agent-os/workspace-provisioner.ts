import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { WorkspaceStore, type Workspace } from './workspace-store.js'

export interface WorkspaceProvisioner {
  materialize(workspace: Workspace): Promise<Workspace>
}

type GitResult = { stdout: string; stderr: string; code: number }

/** Materializes an already-durable managed-worktree reservation after its DB transaction commits. */
export class GitWorkspaceProvisioner implements WorkspaceProvisioner {
  constructor(private readonly workspaces: WorkspaceStore) {}

  async materialize(workspace: Workspace): Promise<Workspace> {
    if (workspace.status === 'active') return workspace
    if (workspace.status !== 'reserved') throw new Error(`workspace ${workspace.id} is ${workspace.status}`)
    if (workspace.kind !== 'worktree' || !workspace.worktree_path || !workspace.branch) {
      throw new Error(`workspace ${workspace.id} is not a complete managed-worktree reservation`)
    }

    const root = await realpath(path.resolve(workspace.root_path))
    const repository = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (await realpath(repository) !== root) throw new Error('workspace root must be the repository root')
    await git(root, ['rev-parse', '--verify', `${workspace.base_ref ?? 'HEAD'}^{commit}`])
    await git(root, ['check-ref-format', '--branch', workspace.branch])

    const managedRoot = path.join(path.dirname(root), `${path.basename(root)}-workspaces`)
    await mkdir(managedRoot, { recursive: true })
    const allowedRoot = await realpath(managedRoot)
    const requestedDestination = path.resolve(workspace.worktree_path)
    await mkdir(path.dirname(requestedDestination), { recursive: true })
    const destination = path.join(await realpath(path.dirname(requestedDestination)), path.basename(requestedDestination))
    if (!isWithin(allowedRoot, destination)) {
      throw new Error(`worktree destination must stay under ${allowedRoot}`)
    }

    const registered = parseWorktrees((await git(root, ['worktree', 'list', '--porcelain'])).stdout)
    const existing = registered.find((item) => path.resolve(item.path) === destination)
    const expectedBranch = `refs/heads/${workspace.branch}`
    if (existing) {
      if (existing.branch !== expectedBranch) {
        throw new Error(`registered worktree at ${destination} uses ${existing.branch ?? 'detached HEAD'}`)
      }
      return this.workspaces.update(workspace.id, { status: 'active', worktree_path: destination })
    }
    if (registered.some((item) => item.branch === expectedBranch)) {
      throw new Error(`branch ${workspace.branch} is already checked out in another worktree`)
    }
    try {
      const info = await lstat(destination)
      if (info.isSymbolicLink()) throw new Error('worktree destination cannot be a symlink')
      throw new Error(`worktree destination already exists and is not registered: ${destination}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const branchExists = (await git(root, ['show-ref', '--verify', '--quiet', expectedBranch], [1])).code === 0
    await git(root, branchExists
      ? ['worktree', 'add', destination, workspace.branch]
      : ['worktree', 'add', destination, '-b', workspace.branch, workspace.base_ref ?? 'HEAD'])
    try {
      return this.workspaces.update(workspace.id, { status: 'active', worktree_path: destination })
    } catch (error) {
      await git(root, ['worktree', 'remove', '--force', destination], [1, 128]).catch(() => undefined)
      if (!branchExists) await git(root, ['branch', '-D', workspace.branch], [1, 128]).catch(() => undefined)
      throw error
    }
  }
}

function git(cwd: string, args: string[], allowed: number[] = []): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
          ? Number((error as NodeJS.ErrnoException).code) : error ? 1 : 0
        const result = { stdout: String(stdout), stderr: String(stderr), code }
        if (!error || allowed.includes(code)) resolve(result)
        else reject(new Error(`git ${args[0]} failed: ${result.stderr.trim() || (error as Error).message}`))
      })
  })
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function parseWorktrees(output: string): Array<{ path: string; branch: string | null }> {
  const records: Array<{ path: string; branch: string | null }> = []
  let current: { path: string; branch: string | null } | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current)
      current = { path: line.slice('worktree '.length), branch: null }
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length)
    } else if (!line && current) {
      records.push(current)
      current = null
    }
  }
  if (current) records.push(current)
  return records
}

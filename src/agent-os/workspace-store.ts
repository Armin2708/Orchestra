import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { pathsIntersect } from '../overlap.js'
import { NotFoundError, ValidationError } from './errors.js'
import { parseJson, timestamp } from './json.js'

export interface Workspace {
  id: string
  board_id: number
  card_id: number | null
  name: string
  kind: string
  root_path: string
  worktree_path: string | null
  branch: string | null
  base_ref: string | null
  status: string
  env: Record<string, string>
  created_at: string
  updated_at: string
}

export interface CreateWorkspace {
  boardId: number
  cardId?: number | null
  name: string
  kind?: string
  rootPath: string
  worktreePath?: string | null
  branch?: string | null
  baseRef?: string | null
  status?: string
  env?: Record<string, string>
}

export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateWorkspace): Workspace {
    this.assertScope(input.boardId, input.cardId)
    const kind = input.kind?.trim() || 'shared'
    if (!['shared', 'worktree'].includes(kind)) throw new ValidationError('workspace kind must be shared or worktree')
    if (!input.name.trim()) throw new ValidationError('workspace name is required')
    if (!input.rootPath.trim()) throw new ValidationError('rootPath is required')
    const at = timestamp()
    const row = {
      id: randomUUID(), board_id: input.boardId, card_id: input.cardId ?? null,
      name: input.name.trim(), kind, root_path: input.rootPath,
      worktree_path: input.worktreePath ?? null, branch: input.branch ?? null,
      base_ref: input.baseRef ?? null, status: workspaceStatus(input.status ?? 'active'),
      env_json: JSON.stringify(input.env ?? {}), created_at: at, updated_at: at,
    }
    this.db.prepare(`INSERT INTO workspaces
      (id, board_id, card_id, name, kind, root_path, worktree_path, branch, base_ref, status, env_json, created_at, updated_at)
      VALUES (@id, @board_id, @card_id, @name, @kind, @root_path, @worktree_path, @branch, @base_ref, @status, @env_json, @created_at, @updated_at)`)
      .run(row)
    return mapWorkspace(row)
  }

  listBoard(boardId: number, includeArchived = false): Workspace[] {
    const rows = this.db.prepare(`SELECT * FROM workspaces WHERE board_id=?
      ${includeArchived ? '' : "AND status!='archived'"} ORDER BY updated_at DESC, rowid DESC`).all(boardId) as Record<string, unknown>[]
    return rows.map(mapWorkspace)
  }

  get(id: string): Workspace | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? mapWorkspace(row) : null
  }

  update(id: string, patch: Record<string, unknown>): Workspace {
    const current = this.get(id)
    if (!current) throw new NotFoundError('workspace not found')
    const allowed = new Set(['name', 'status', 'branch', 'base_ref', 'worktree_path', 'env', 'card_id', 'cardId'])
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new ValidationError(`cannot update workspace field ${key}`)
    const name = patch.name === undefined ? current.name : String(patch.name).trim()
    if (!name) throw new ValidationError('workspace name cannot be empty')
    const env = patch.env === undefined ? current.env : validateEnv(patch.env)
    const changesCard = Object.hasOwn(patch, 'card_id') || Object.hasOwn(patch, 'cardId')
    const cardValue = Object.hasOwn(patch, 'card_id') ? patch.card_id : patch.cardId
    const cardId = changesCard ? nullableCardId(cardValue) : current.card_id
    this.assertScope(current.board_id, cardId)
    this.db.prepare(`UPDATE workspaces SET name=@name, card_id=@card_id, status=@status, branch=@branch,
      base_ref=@base_ref, worktree_path=@worktree_path, env_json=@env_json, updated_at=@updated_at WHERE id=@id`).run({
      id, name, card_id: cardId,
      status: patch.status === undefined ? current.status : workspaceStatus(patch.status),
      branch: patch.branch === undefined ? current.branch : nullableString(patch.branch),
      base_ref: patch.base_ref === undefined ? current.base_ref : nullableString(patch.base_ref),
      worktree_path: patch.worktree_path === undefined ? current.worktree_path : nullableString(patch.worktree_path),
      env_json: JSON.stringify(env), updated_at: timestamp(),
    })
    return this.get(id)!
  }

  archive(id: string): Workspace {
    if (!this.get(id)) throw new NotFoundError('workspace not found')
    this.db.prepare("UPDATE workspaces SET status='archived', updated_at=? WHERE id=?").run(timestamp(), id)
    return this.get(id)!
  }

  conflicts(boardId: number): Array<{ workspace_ids: [string, string]; kind: string; detail: string }> {
    const workspaces = this.listBoard(boardId)
    const cardPaths = new Map<number, string[]>()
    for (const row of this.db.prepare('SELECT id, paths FROM cards WHERE board_id=?').all(boardId) as Array<{ id: number; paths: string }>) {
      cardPaths.set(row.id, parseJson<string[]>(row.paths, []))
    }
    const conflicts: Array<{ workspace_ids: [string, string]; kind: string; detail: string }> = []
    for (let i = 0; i < workspaces.length; i++) for (let j = i + 1; j < workspaces.length; j++) {
      const left = workspaces[i], right = workspaces[j]
      const leftPath = left.worktree_path ?? left.root_path
      const rightPath = right.worktree_path ?? right.root_path
      if (leftPath === rightPath) {
        conflicts.push({ workspace_ids: [left.id, right.id], kind: 'execution_root', detail: `both use ${leftPath}` })
        continue
      }
      const leftOwned = left.card_id ? cardPaths.get(left.card_id) ?? [] : []
      const rightOwned = right.card_id ? cardPaths.get(right.card_id) ?? [] : []
      if (leftOwned.length && rightOwned.length && pathsIntersect(leftOwned, rightOwned)) {
        conflicts.push({ workspace_ids: [left.id, right.id], kind: 'owned_paths', detail: 'card path ownership overlaps' })
      }
    }
    return conflicts
  }

  private assertScope(boardId: number, cardId?: number | null): void {
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(boardId)) throw new NotFoundError('board not found')
    if (cardId) {
      const card = this.db.prepare('SELECT board_id FROM cards WHERE id=?').get(cardId) as { board_id: number } | undefined
      if (!card) throw new NotFoundError('card not found')
      if (card.board_id !== boardId) throw new ValidationError('card belongs to a different board')
    }
  }
}

function mapWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: String(row.id), board_id: Number(row.board_id), card_id: row.card_id == null ? null : Number(row.card_id),
    name: String(row.name), kind: String(row.kind), root_path: String(row.root_path),
    worktree_path: row.worktree_path == null ? null : String(row.worktree_path),
    branch: row.branch == null ? null : String(row.branch), base_ref: row.base_ref == null ? null : String(row.base_ref),
    status: String(row.status), env: parseJson<Record<string, string>>(row.env_json, {}),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  }
}

function nullableString(value: unknown): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ValidationError('value must be a string or null')
  return value
}

function validateEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('env must be an object')
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new ValidationError('env values must be strings')
    env[key] = item
  }
  return env
}

function workspaceStatus(value: unknown): string {
  if (typeof value !== 'string' || !['active', 'archived', 'missing', 'reserved', 'failed'].includes(value)) {
    throw new ValidationError('workspace status must be active, archived, missing, reserved, or failed')
  }
  return value
}

function nullableCardId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('card_id must be a positive integer or null')
  return id
}

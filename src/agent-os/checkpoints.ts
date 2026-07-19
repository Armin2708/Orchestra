import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ArtifactStore } from './artifact-store.js'
import { NotFoundError, UnsupportedError, ValidationError } from './errors.js'
import { parseJson, timestamp } from './json.js'
import { CreateWorkspace, Workspace, WorkspaceStore } from './workspace-store.js'

export interface Checkpoint {
  id: string
  workspace_id: string
  session_id: string | null
  name: string
  git_head: string
  patch_artifact_id: string | null
  context: Record<string, unknown>
  process_recipes: unknown[]
  created_at: string
}

export interface CreateCheckpoint {
  workspaceId: string
  sessionId?: string | null
  name: string
  gitHead: string
  patchArtifactId?: string | null
  context?: Record<string, unknown>
  processRecipes?: unknown[]
}

export type CheckpointForker = (checkpoint: Checkpoint, request: { name: string; branch?: string; targetPath?: string }) =>
  Promise<Workspace | Omit<CreateWorkspace, 'boardId' | 'cardId'>>

export class CheckpointService {
  private readonly artifacts: ArtifactStore
  private readonly workspaces: WorkspaceStore

  constructor(
    private readonly db: Database.Database,
    private readonly forker?: CheckpointForker,
  ) {
    this.artifacts = new ArtifactStore(db)
    this.workspaces = new WorkspaceStore(db)
  }

  create(input: CreateCheckpoint): Checkpoint {
    const workspace = this.workspaces.get(input.workspaceId)
    if (!workspace) throw new NotFoundError('workspace not found')
    if (!input.name.trim() || !input.gitHead.trim()) throw new ValidationError('checkpoint name and gitHead are required')
    if (input.patchArtifactId) {
      const artifact = this.artifacts.get(input.patchArtifactId)
      if (!artifact) throw new NotFoundError('patch artifact not found')
      if (artifact.workspace_id !== input.workspaceId) throw new ValidationError('patch artifact belongs to a different workspace')
    }
    const row = {
      id: randomUUID(), workspace_id: input.workspaceId, session_id: input.sessionId ?? null,
      name: input.name.trim(), git_head: input.gitHead.trim(), patch_artifact_id: input.patchArtifactId ?? null,
      context_json: JSON.stringify(input.context ?? {}), process_recipes: JSON.stringify(input.processRecipes ?? []),
      created_at: timestamp(),
    }
    this.db.prepare(`INSERT INTO checkpoints
      (id, workspace_id, session_id, name, git_head, patch_artifact_id, context_json, process_recipes, created_at)
      VALUES (@id, @workspace_id, @session_id, @name, @git_head, @patch_artifact_id, @context_json, @process_recipes, @created_at)`)
      .run(row)
    return mapCheckpoint(row)
  }

  get(id: string): Checkpoint | null {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? mapCheckpoint(row) : null
  }

  listWorkspace(workspaceId: string): Checkpoint[] {
    if (!this.workspaces.get(workspaceId)) throw new NotFoundError('workspace not found')
    return (this.db.prepare('SELECT * FROM checkpoints WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC')
      .all(workspaceId) as Record<string, unknown>[]).map(mapCheckpoint)
  }

  async fork(id: string, request: { name: string; branch?: string; targetPath?: string }): Promise<Workspace> {
    const checkpoint = this.get(id)
    if (!checkpoint) throw new NotFoundError('checkpoint not found')
    if (!this.forker) throw new UnsupportedError('checkpoint forking requires a workspace runtime')
    if (!request.name?.trim()) throw new ValidationError('fork name is required')
    const source = this.workspaces.get(checkpoint.workspace_id)
    if (!source) throw new NotFoundError('source workspace not found')
    const created = await this.forker(checkpoint, request)
    if ('id' in created) {
      const persisted = this.workspaces.get(created.id)
      if (!persisted) throw new ValidationError('checkpoint runtime returned a workspace that was not persisted')
      if (persisted.board_id !== source.board_id) throw new ValidationError('forked workspace belongs to a different board')
      return persisted
    }
    return this.workspaces.create({ ...created, boardId: source.board_id, cardId: source.card_id, kind: 'worktree' })
  }
}

function mapCheckpoint(row: Record<string, unknown>): Checkpoint {
  return {
    id: String(row.id), workspace_id: String(row.workspace_id), session_id: row.session_id == null ? null : String(row.session_id),
    name: String(row.name), git_head: String(row.git_head),
    patch_artifact_id: row.patch_artifact_id == null ? null : String(row.patch_artifact_id),
    context: parseJson<Record<string, unknown>>(row.context_json, {}),
    process_recipes: parseJson<unknown[]>(row.process_recipes, []), created_at: String(row.created_at),
  }
}

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ArtifactStore } from './artifact-store.js'
import {
  CommandIdempotencyStore,
  commandRequestIdentity,
} from './command-idempotency.js'
import {
  ConflictError,
  NotFoundError,
  UnsupportedError,
  ValidationError,
} from './errors.js'
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
  idempotencyKey?: string | null
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
    const normalized = {
      workspace_id: input.workspaceId,
      session_id: input.sessionId ?? null,
      name: input.name.trim(),
      git_head: input.gitHead.trim(),
      patch_artifact_id: input.patchArtifactId ?? null,
      context: input.context ?? {},
      process_recipes: input.processRecipes ?? [],
    }
    const identity = commandRequestIdentity({
      boardId: workspace.board_id,
      idempotencyKey: input.idempotencyKey,
      command: 'checkpoint.create',
      scopeId: input.workspaceId,
      request: normalized,
    })
    const commands = new CommandIdempotencyStore(this.db)
    const create = () => {
      if (identity) {
        const replay = commands.replay(identity)
        if (replay) {
          const checkpoint = this.get(commands.succeededResult(replay))
          if (!checkpoint) throw new ConflictError('idempotent checkpoint result is missing')
          return checkpoint
        }
      }
      if (input.patchArtifactId) {
        const artifact = this.artifacts.get(input.patchArtifactId)
        if (!artifact) throw new NotFoundError('patch artifact not found')
        if (artifact.workspace_id !== input.workspaceId) {
          throw new ValidationError('patch artifact belongs to a different workspace')
        }
      }
      const row = {
        id: randomUUID(),
        workspace_id: normalized.workspace_id,
        session_id: normalized.session_id,
        name: normalized.name,
        git_head: normalized.git_head,
        patch_artifact_id: normalized.patch_artifact_id,
        context_json: JSON.stringify(normalized.context),
        process_recipes: JSON.stringify(normalized.process_recipes),
        created_at: timestamp(),
      }
      this.db.prepare(`INSERT INTO checkpoints
        (id, workspace_id, session_id, name, git_head, patch_artifact_id, context_json, process_recipes, created_at)
        VALUES (@id, @workspace_id, @session_id, @name, @git_head, @patch_artifact_id, @context_json, @process_recipes, @created_at)`)
        .run(row)
      if (identity) commands.recordSucceeded(identity, row.id)
      return mapCheckpoint(row)
    }
    return identity ? this.db.transaction(create).immediate() : create()
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

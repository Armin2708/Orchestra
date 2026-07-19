import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { NotFoundError, ValidationError } from './errors.js'
import { parseJson, timestamp } from './json.js'

export interface Artifact {
  id: string
  board_id: number
  workspace_id: string | null
  card_id: number | null
  kind: string
  name: string
  mime_type: string
  path: string | null
  content: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export interface CreateArtifact {
  boardId: number
  workspaceId?: string | null
  cardId?: number | null
  kind: string
  name: string
  mimeType?: string
  path?: string | null
  content?: string | null
  metadata?: Record<string, unknown>
}

export class ArtifactStore {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateArtifact): Artifact {
    if (!input.kind.trim()) throw new ValidationError('artifact kind is required')
    if (!input.name.trim()) throw new ValidationError('artifact name is required')
    this.assertScope(input.boardId, input.workspaceId, input.cardId)
    const row = {
      id: randomUUID(),
      board_id: input.boardId,
      workspace_id: input.workspaceId ?? null,
      card_id: input.cardId ?? null,
      kind: input.kind.trim(),
      name: input.name.trim(),
      mime_type: input.mimeType?.trim() || 'application/octet-stream',
      path: input.path ?? null,
      content: input.content ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      created_at: timestamp(),
    }
    this.db.prepare(`INSERT INTO artifacts
      (id, board_id, workspace_id, card_id, kind, name, mime_type, path, content, metadata, created_at)
      VALUES (@id, @board_id, @workspace_id, @card_id, @kind, @name, @mime_type, @path, @content, @metadata, @created_at)`)
      .run(row)
    return mapArtifact(row)
  }

  get(id: string): Artifact | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? mapArtifact(row) : null
  }

  list(input: { boardId: number; workspaceId?: string; cardId?: number; kind?: string; limit?: number }): Artifact[] {
    const where = ['board_id=@board_id']
    const params: Record<string, unknown> = { board_id: input.boardId }
    if (input.workspaceId) { where.push('workspace_id=@workspace_id'); params.workspace_id = input.workspaceId }
    if (input.cardId) { where.push('card_id=@card_id'); params.card_id = input.cardId }
    if (input.kind) { where.push('kind=@kind'); params.kind = input.kind }
    params.limit = Math.min(500, Math.max(1, input.limit ?? 100))
    return (this.db.prepare(`SELECT * FROM artifacts WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, rowid DESC LIMIT @limit`).all(params) as Record<string, unknown>[]).map(mapArtifact)
  }

  private assertScope(boardId: number, workspaceId?: string | null, cardId?: number | null): void {
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(boardId)) throw new NotFoundError('board not found')
    if (workspaceId) {
      const workspace = this.db.prepare('SELECT board_id FROM workspaces WHERE id=?').get(workspaceId) as { board_id: number } | undefined
      if (!workspace) throw new NotFoundError('workspace not found')
      if (workspace.board_id !== boardId) throw new ValidationError('workspace belongs to a different board')
    }
    if (cardId) {
      const card = this.db.prepare('SELECT board_id FROM cards WHERE id=?').get(cardId) as { board_id: number } | undefined
      if (!card) throw new NotFoundError('card not found')
      if (card.board_id !== boardId) throw new ValidationError('card belongs to a different board')
    }
  }
}

function mapArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: String(row.id), board_id: Number(row.board_id),
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
    card_id: row.card_id == null ? null : Number(row.card_id),
    kind: String(row.kind), name: String(row.name), mime_type: String(row.mime_type),
    path: row.path == null ? null : String(row.path), content: row.content == null ? null : String(row.content),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}), created_at: String(row.created_at),
  }
}

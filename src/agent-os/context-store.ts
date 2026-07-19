import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { NotFoundError, ValidationError } from './errors.js'
import { parseJson, timestamp } from './json.js'

export interface ContextItem {
  id: string
  board_id: number
  workspace_id: string | null
  card_id: number | null
  kind: string
  source: string
  content: string
  tokens: number
  pinned: boolean
  provenance: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface PutContextItem {
  id?: string
  kind: string
  source: string
  content: string
  tokens?: number
  pinned?: boolean
  provenance?: Record<string, unknown>
}

export class ContextStore {
  constructor(private readonly db: Database.Database) {}

  listWorkspace(workspaceId: string): ContextItem[] {
    this.workspace(workspaceId)
    return (this.db.prepare(`SELECT * FROM context_items WHERE workspace_id=?
      ORDER BY pinned DESC, updated_at DESC, rowid DESC`).all(workspaceId) as Record<string, unknown>[]).map(mapContext)
  }

  putWorkspace(workspaceId: string, items: PutContextItem[]): ContextItem[] {
    const workspace = this.workspace(workspaceId)
    if (!Array.isArray(items)) throw new ValidationError('items must be an array')
    const existingIds = new Set((this.db.prepare('SELECT id FROM context_items WHERE workspace_id=?').all(workspaceId) as Array<{ id: string }>).map((row) => row.id))
    const keep = new Set<string>()
    const upsert = this.db.prepare(`INSERT INTO context_items
      (id, board_id, workspace_id, card_id, kind, source, content, tokens, pinned, provenance, created_at, updated_at)
      VALUES (@id, @board_id, @workspace_id, @card_id, @kind, @source, @content, @tokens, @pinned, @provenance, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, source=excluded.source, content=excluded.content,
        tokens=excluded.tokens, pinned=excluded.pinned, provenance=excluded.provenance, updated_at=excluded.updated_at`)
    const save = this.db.transaction(() => {
      for (const item of items) {
        if (!item || typeof item !== 'object') throw new ValidationError('context item must be an object')
        if (!item.kind?.trim() || !item.source?.trim()) throw new ValidationError('context kind and source are required')
        if (typeof item.content !== 'string') throw new ValidationError('context content must be a string')
        if (item.id && !existingIds.has(item.id)) throw new ValidationError('context id does not belong to this workspace')
        const id = item.id ?? randomUUID()
        keep.add(id)
        const at = timestamp()
        upsert.run({ id, board_id: workspace.board_id, workspace_id: workspaceId,
          card_id: workspace.card_id, kind: item.kind.trim(), source: item.source.trim(), content: item.content,
          tokens: Math.max(0, Math.floor(item.tokens ?? 0)), pinned: item.pinned ? 1 : 0,
          provenance: JSON.stringify(item.provenance ?? {}), created_at: at, updated_at: at })
      }
      // PUT replaces unpinned context but never drops a pinned item merely because a client omitted it.
      for (const id of existingIds) if (!keep.has(id)) {
        this.db.prepare('DELETE FROM context_items WHERE id=? AND pinned=0').run(id)
      }
    })
    save()
    return this.listWorkspace(workspaceId)
  }

  private workspace(id: string): { board_id: number; card_id: number | null } {
    const row = this.db.prepare('SELECT board_id, card_id FROM workspaces WHERE id=?').get(id) as { board_id: number; card_id: number | null } | undefined
    if (!row) throw new NotFoundError('workspace not found')
    return row
  }
}

function mapContext(row: Record<string, unknown>): ContextItem {
  return {
    id: String(row.id), board_id: Number(row.board_id), workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
    card_id: row.card_id == null ? null : Number(row.card_id), kind: String(row.kind), source: String(row.source),
    content: String(row.content), tokens: Number(row.tokens), pinned: Number(row.pinned) === 1,
    provenance: parseJson<Record<string, unknown>>(row.provenance, {}),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  }
}

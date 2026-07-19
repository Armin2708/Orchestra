import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { NotFoundError, ValidationError } from './errors.js'
import { timestamp } from './json.js'

export type AttentionSeverity = 'critical' | 'high' | 'medium' | 'low'

export interface AttentionItem {
  id: string
  board_id: number
  workspace_id: string | null
  card_id: number | null
  agent_id: number | null
  kind: string
  severity: AttentionSeverity
  title: string
  detail: string
  status: string
  created_at: string
  resolved_at: string | null
}

export interface CreateAttention {
  boardId: number
  workspaceId?: string | null
  cardId?: number | null
  agentId?: number | null
  kind: string
  severity?: AttentionSeverity
  title: string
  detail?: string
  dedupe?: boolean
}

export class AttentionService {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateAttention): AttentionItem {
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(input.boardId)) throw new NotFoundError('board not found')
    if (!input.kind.trim() || !input.title.trim()) throw new ValidationError('attention kind and title are required')
    const severity = input.severity ?? 'medium'
    if (!['critical', 'high', 'medium', 'low'].includes(severity)) throw new ValidationError('invalid attention severity')
    if (input.dedupe !== false) {
      const existing = this.db.prepare(`SELECT * FROM attention_items WHERE board_id=@board AND status='open'
        AND kind=@kind AND title=@title AND workspace_id IS @workspace AND card_id IS @card
        ORDER BY created_at DESC LIMIT 1`).get({ board: input.boardId, kind: input.kind.trim(), title: input.title.trim(),
          workspace: input.workspaceId ?? null, card: input.cardId ?? null }) as Record<string, unknown> | undefined
      if (existing) return mapAttention(existing)
    }
    const row = {
      id: randomUUID(), board_id: input.boardId, workspace_id: input.workspaceId ?? null,
      card_id: input.cardId ?? null, agent_id: input.agentId ?? null, kind: input.kind.trim(),
      severity, title: input.title.trim(), detail: input.detail ?? '', status: 'open',
      created_at: timestamp(), resolved_at: null,
    }
    this.db.prepare(`INSERT INTO attention_items
      (id, board_id, workspace_id, card_id, agent_id, kind, severity, title, detail, status, created_at, resolved_at)
      VALUES (@id, @board_id, @workspace_id, @card_id, @agent_id, @kind, @severity, @title, @detail, @status, @created_at, @resolved_at)`)
      .run(row)
    return mapAttention(row)
  }

  listBoard(boardId: number, status = 'open'): AttentionItem[] {
    return (this.db.prepare(`SELECT * FROM attention_items WHERE board_id=? AND status=?
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      created_at ASC, rowid ASC`).all(boardId, status) as Record<string, unknown>[]).map(mapAttention)
  }

  get(id: string): AttentionItem | null {
    const row = this.db.prepare('SELECT * FROM attention_items WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? mapAttention(row) : null
  }

  resolve(id: string): AttentionItem {
    const existing = this.db.prepare('SELECT * FROM attention_items WHERE id=?').get(id) as Record<string, unknown> | undefined
    if (!existing) throw new NotFoundError('attention item not found')
    if (existing.status === 'open') {
      this.db.prepare("UPDATE attention_items SET status='resolved', resolved_at=? WHERE id=?").run(timestamp(), id)
    }
    return mapAttention(this.db.prepare('SELECT * FROM attention_items WHERE id=?').get(id) as Record<string, unknown>)
  }
}

function mapAttention(row: Record<string, unknown>): AttentionItem {
  return {
    id: String(row.id), board_id: Number(row.board_id), workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
    card_id: row.card_id == null ? null : Number(row.card_id), agent_id: row.agent_id == null ? null : Number(row.agent_id),
    kind: String(row.kind), severity: String(row.severity) as AttentionSeverity, title: String(row.title),
    detail: String(row.detail), status: String(row.status), created_at: String(row.created_at),
    resolved_at: row.resolved_at == null ? null : String(row.resolved_at),
  }
}

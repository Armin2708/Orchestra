import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { NotFoundError, ValidationError } from './errors.js'
import { parseJson, timestamp } from './json.js'

export interface OsEvent {
  id: string
  board_id: number
  workspace_id: string | null
  card_id: number | null
  session_id: string | null
  process_id: string | null
  kind: string
  source: string
  payload: unknown
  created_at: string
}

export interface AppendEvent {
  boardId: number
  workspaceId?: string | null
  cardId?: number | null
  sessionId?: string | null
  processId?: string | null
  kind: string
  source: string
  payload?: unknown
  createdAt?: string
}

export interface EventFilters {
  workspaceId?: string
  cardId?: number
  kind?: string
  after?: string
  limit?: number
}

export class EventStore {
  constructor(private readonly db: Database.Database) {}

  append(input: AppendEvent): OsEvent {
    if (!Number.isSafeInteger(input.boardId) || input.boardId <= 0) throw new ValidationError('boardId is required')
    if (!input.kind.trim()) throw new ValidationError('event kind is required')
    if (!input.source.trim()) throw new ValidationError('event source is required')
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(input.boardId)) throw new NotFoundError('board not found')

    const row = {
      id: randomUUID(),
      board_id: input.boardId,
      workspace_id: input.workspaceId ?? null,
      card_id: input.cardId ?? null,
      session_id: input.sessionId ?? null,
      process_id: input.processId ?? null,
      kind: input.kind.trim(),
      source: input.source.trim(),
      payload: JSON.stringify(input.payload ?? {}),
      created_at: input.createdAt ?? timestamp(),
    }
    this.db.prepare(`INSERT INTO os_events
      (id, board_id, workspace_id, card_id, session_id, process_id, kind, source, payload, created_at)
      VALUES (@id, @board_id, @workspace_id, @card_id, @session_id, @process_id, @kind, @source, @payload, @created_at)`)
      .run(row)
    return mapEvent(row)
  }

  listBoard(boardId: number, filters: EventFilters = {}): OsEvent[] {
    const where = ['board_id=@board_id']
    const params: Record<string, unknown> = { board_id: boardId }
    if (filters.workspaceId) { where.push('workspace_id=@workspace_id'); params.workspace_id = filters.workspaceId }
    if (filters.cardId) { where.push('card_id=@card_id'); params.card_id = filters.cardId }
    if (filters.kind) { where.push('kind=@kind'); params.kind = filters.kind }
    let incremental = false
    if (filters.after) {
      const cursor = this.db.prepare('SELECT created_at, rowid FROM os_events WHERE board_id=? AND id=?')
        .get(boardId, filters.after) as { created_at: string; rowid: number } | undefined
      if (!cursor) throw new ValidationError('event cursor was not found on this board')
      where.push('(created_at>@cursor_time OR (created_at=@cursor_time AND rowid>@cursor_rowid))')
      params.cursor_time = cursor.created_at
      params.cursor_rowid = cursor.rowid
      incremental = true
    }
    params.limit = Math.min(500, Math.max(1, filters.limit ?? 100))
    const direction = incremental ? 'ASC' : 'DESC'
    const rows = this.db.prepare(`SELECT * FROM os_events WHERE ${where.join(' AND ')}
      ORDER BY created_at ${direction}, rowid ${direction} LIMIT @limit`).all(params) as Record<string, unknown>[]
    return rows.map(mapEvent)
  }
}

function mapEvent(row: Record<string, unknown>): OsEvent {
  return {
    id: String(row.id),
    board_id: Number(row.board_id),
    workspace_id: row.workspace_id === null || row.workspace_id === undefined ? null : String(row.workspace_id),
    card_id: row.card_id === null || row.card_id === undefined ? null : Number(row.card_id),
    session_id: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    process_id: row.process_id === null || row.process_id === undefined ? null : String(row.process_id),
    kind: String(row.kind),
    source: String(row.source),
    payload: parseJson(row.payload, {}),
    created_at: String(row.created_at),
  }
}

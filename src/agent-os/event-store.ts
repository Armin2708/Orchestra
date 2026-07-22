import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { parseJson, timestamp } from './json.js'

export interface OsEvent {
  id: string
  board_id: number
  workspace_id: string | null
  card_id: number | null
  session_id: string | null
  process_id: string | null
  job_id: string | null
  contract_id: string | null
  correlation_id: string | null
  causation_id: string | null
  idempotency_key: string | null
  event_version: number
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
  jobId?: string | null
  contractId?: string | null
  correlationId?: string | null
  causationId?: string | null
  idempotencyKey?: string | null
  eventVersion?: number
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

    const idempotencyKey = input.idempotencyKey?.trim() || null
    const payload = stableJson(input.payload ?? {})
    const eventVersion = input.eventVersion ?? 1
    if (!Number.isSafeInteger(eventVersion) || eventVersion < 1) {
      throw new ValidationError('eventVersion must be a positive integer')
    }
    if (idempotencyKey) {
      const existing = this.db.prepare('SELECT * FROM os_events WHERE board_id=? AND idempotency_key=?')
        .get(input.boardId, idempotencyKey) as Record<string, unknown> | undefined
      if (existing) {
        const same = String(existing.kind) === input.kind.trim()
          && String(existing.source) === input.source.trim()
          && (existing.workspace_id ?? null) === (input.workspaceId ?? null)
          && (existing.card_id ?? null) === (input.cardId ?? null)
          && (existing.session_id ?? null) === (input.sessionId ?? null)
          && (existing.process_id ?? null) === (input.processId ?? null)
          && (existing.job_id ?? null) === (input.jobId ?? null)
          && (existing.contract_id ?? null) === (input.contractId ?? null)
          && Number(existing.event_version ?? 1) === eventVersion
          && String(existing.payload) === payload
        if (!same) throw new ConflictError('event idempotency key was already used for a different event')
        return mapEvent(existing)
      }
    }
    const row = {
      id: randomUUID(),
      board_id: input.boardId,
      workspace_id: input.workspaceId ?? null,
      card_id: input.cardId ?? null,
      session_id: input.sessionId ?? null,
      process_id: input.processId ?? null,
      job_id: input.jobId ?? null,
      contract_id: input.contractId ?? null,
      correlation_id: input.correlationId ?? null,
      causation_id: input.causationId ?? null,
      idempotency_key: idempotencyKey,
      event_version: eventVersion,
      kind: input.kind.trim(),
      source: input.source.trim(),
      payload,
      created_at: input.createdAt ?? timestamp(),
    }
    this.db.prepare(`INSERT INTO os_events
      (id, board_id, workspace_id, card_id, session_id, process_id, job_id, contract_id,
       correlation_id, causation_id, idempotency_key, event_version, kind, source, payload, created_at)
      VALUES (@id, @board_id, @workspace_id, @card_id, @session_id, @process_id, @job_id, @contract_id,
       @correlation_id, @causation_id, @idempotency_key, @event_version, @kind, @source, @payload, @created_at)`)
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
    job_id: row.job_id === null || row.job_id === undefined ? null : String(row.job_id),
    contract_id: row.contract_id === null || row.contract_id === undefined ? null : String(row.contract_id),
    correlation_id: row.correlation_id === null || row.correlation_id === undefined ? null : String(row.correlation_id),
    causation_id: row.causation_id === null || row.causation_id === undefined ? null : String(row.causation_id),
    idempotency_key: row.idempotency_key === null || row.idempotency_key === undefined ? null : String(row.idempotency_key),
    event_version: Number(row.event_version ?? 1),
    kind: String(row.kind),
    source: String(row.source),
    payload: parseJson(row.payload, {}),
    created_at: String(row.created_at),
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? 'null'
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    const serializable = value as Record<string, unknown> & { toJSON?: () => unknown }
    if (typeof serializable.toJSON === 'function') return sortJson(serializable.toJSON())
    return Object.fromEntries(Object.entries(serializable)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]))
  }
  return value
}

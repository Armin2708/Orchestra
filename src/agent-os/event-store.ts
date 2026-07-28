import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  actorIdentity,
  boundedString,
  optionalBoundedString,
  type ActorIdentity,
} from './agent-home-support.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { parseJson, timestamp } from './json.js'

export interface OsEvent {
  id: string
  board_id: number
  actor_type: string
  actor_id: string | null
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
  actor?: ActorIdentity
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
  jobId?: string
  kind?: string
  after?: string
  limit?: number
}

export class EventStore {
  constructor(private readonly db: Database.Database) {}

  append(input: AppendEvent): OsEvent {
    if (!Number.isSafeInteger(input.boardId) || input.boardId <= 0) throw new ValidationError('boardId is required')
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(input.boardId)) throw new NotFoundError('board not found')

    const kind = boundedString(input.kind, 'event kind', 128)
    const source = boundedString(input.source, 'event source', 128)
    const actor = input.actor
      ? actorIdentity(input.actor)
      : actorFromPayload(input.payload) ?? { type: 'system', id: source }
    const workspaceId = optionalBoundedString(input.workspaceId, 'workspaceId', 512)
    const cardId = input.cardId ?? null
    if (cardId !== null && (!Number.isSafeInteger(cardId) || cardId <= 0)) {
      throw new ValidationError('cardId must be a positive integer')
    }
    const sessionId = optionalBoundedString(input.sessionId, 'sessionId', 512)
    const processId = optionalBoundedString(input.processId, 'processId', 512)
    const jobId = optionalBoundedString(input.jobId, 'jobId', 512)
    const contractId = optionalBoundedString(input.contractId, 'contractId', 512)
    const requestedCorrelationId = optionalBoundedString(
      input.correlationId,
      'correlationId',
      512,
    )
    const causationId = optionalBoundedString(input.causationId, 'causationId', 512)
    const idempotencyKey = optionalBoundedString(
      input.idempotencyKey,
      'idempotencyKey',
      512,
    )
    const payload = stableJson(input.payload ?? {})
    const eventVersion = input.eventVersion ?? 1
    if (!Number.isSafeInteger(eventVersion) || eventVersion < 1) {
      throw new ValidationError('eventVersion must be a positive integer')
    }
    if (idempotencyKey) {
      const existing = this.db.prepare('SELECT * FROM os_events WHERE board_id=? AND idempotency_key=?')
        .get(input.boardId, idempotencyKey) as Record<string, unknown> | undefined
      if (existing) {
        const existingCorrelationId = nullableString(existing.correlation_id)
        const replayCorrelationId = requestedCorrelationId ?? existingCorrelationId
        const same = String(existing.kind) === kind
          && String(existing.source) === source
          && String(existing.actor_type ?? 'system') === actor.type
          && nullableString(existing.actor_id) === actor.id
          && nullableString(existing.workspace_id) === workspaceId
          && nullableNumber(existing.card_id) === cardId
          && nullableString(existing.session_id) === sessionId
          && nullableString(existing.process_id) === processId
          && nullableString(existing.job_id) === jobId
          && nullableString(existing.contract_id) === contractId
          && existingCorrelationId === replayCorrelationId
          && nullableString(existing.causation_id) === causationId
          && Number(existing.event_version ?? 1) === eventVersion
          && String(existing.payload) === payload
        if (!same) throw new ConflictError('event idempotency key was already used for a different event')
        return mapEvent(existing)
      }
    }
    const id = randomUUID()
    const row = {
      id,
      board_id: input.boardId,
      actor_type: actor.type,
      actor_id: actor.id,
      workspace_id: workspaceId,
      card_id: cardId,
      session_id: sessionId,
      process_id: processId,
      job_id: jobId,
      contract_id: contractId,
      correlation_id: requestedCorrelationId ?? id,
      causation_id: causationId,
      idempotency_key: idempotencyKey,
      event_version: eventVersion,
      kind,
      source,
      payload,
      created_at: input.createdAt ?? timestamp(),
    }
    this.db.prepare(`INSERT INTO os_events
      (id, board_id, actor_type, actor_id, workspace_id, card_id, session_id, process_id,
       job_id, contract_id, correlation_id, causation_id, idempotency_key, event_version,
       kind, source, payload, created_at)
      VALUES (@id, @board_id, @actor_type, @actor_id, @workspace_id, @card_id, @session_id,
       @process_id, @job_id, @contract_id, @correlation_id, @causation_id, @idempotency_key,
       @event_version, @kind, @source, @payload, @created_at)`)
      .run(row)
    return mapEvent(row)
  }

  listBoard(boardId: number, filters: EventFilters = {}): OsEvent[] {
    const where = ['board_id=@board_id']
    const params: Record<string, unknown> = { board_id: boardId }
    if (filters.workspaceId) { where.push('workspace_id=@workspace_id'); params.workspace_id = filters.workspaceId }
    if (filters.cardId) { where.push('card_id=@card_id'); params.card_id = filters.cardId }
    if (filters.jobId) { where.push('job_id=@job_id'); params.job_id = filters.jobId }
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
    actor_type: String(row.actor_type ?? 'system'),
    actor_id: nullableString(row.actor_id),
    workspace_id: nullableString(row.workspace_id),
    card_id: nullableNumber(row.card_id),
    session_id: nullableString(row.session_id),
    process_id: nullableString(row.process_id),
    job_id: nullableString(row.job_id),
    contract_id: nullableString(row.contract_id),
    correlation_id: nullableString(row.correlation_id),
    causation_id: nullableString(row.causation_id),
    idempotency_key: nullableString(row.idempotency_key),
    event_version: Number(row.event_version ?? 1),
    kind: String(row.kind),
    source: String(row.source),
    payload: parseJson(row.payload, {}),
    created_at: String(row.created_at),
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function actorFromPayload(value: unknown): ActorIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = (value as Record<string, unknown>).actor
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const actor = candidate as Record<string, unknown>
  if (typeof actor.type !== 'string') return null
  const type = actor.type.trim()
  if (!type || type.length > 64) return null
  const id = typeof actor.id === 'string' ? actor.id.trim() : ''
  return {
    type,
    id: id && id.length <= 256 ? id : null,
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

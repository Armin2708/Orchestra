import type Database from 'better-sqlite3'
import {
  CONVERSATION_EVENT_KINDS,
  ConversationService,
  mapConversationEvent,
  type ConversationEvent,
  type ConversationEventKind,
} from './conversations.js'
import { ValidationError } from './errors.js'
import { AgentHomeLinkService, type AgentHomeLinks } from './agent-home-links.js'

export interface ConversationSearchFilters {
  query?: string
  after?: number
  limit?: number
  kinds?: ConversationEventKind[]
  actorType?: string
  actorId?: string
  tool?: string
  status?: string
  from?: string
  to?: string
  sessionId?: string
  includeArchived?: boolean
}

export interface ConversationSearchHit extends ConversationEvent {
  links: AgentHomeLinks
}

export interface ConversationSearchPage {
  events: ConversationSearchHit[]
  next_cursor: number | null
  has_more: boolean
  links: AgentHomeLinks
}

export class AgentHomeSearchService {
  private readonly conversations: ConversationService
  private readonly links: AgentHomeLinkService

  constructor(private readonly db: Database.Database) {
    this.conversations = new ConversationService(db)
    this.links = new AgentHomeLinkService(db)
  }

  search(conversationId: string, input: ConversationSearchFilters = {}): ConversationSearchPage {
    const conversation = this.conversations.requireConversation(conversationId)
    const after = integer(input.after ?? 0, 'after', 0, Number.MAX_SAFE_INTEGER)
    const limit = integer(input.limit ?? 100, 'limit', 1, 500)
    const query = optionalText(input.query, 'query', 500)
    const actorType = optionalText(input.actorType, 'actor_type', 64)
    const actorId = optionalText(input.actorId, 'actor_id', 256)
    const tool = optionalText(input.tool, 'tool', 200)
    const status = optionalText(input.status, 'status', 120)
    const from = optionalDate(input.from, 'from')
    const to = optionalDate(input.to, 'to')
    if (from && to && from > to) throw new ValidationError('from must not be after to')

    const where = ['conversation_id=@conversation_id', 'sequence>@after']
    const params: Record<string, unknown> = {
      conversation_id: conversation.id,
      after,
      page_limit: limit + 1,
    }
    if (!input.includeArchived) where.push('archived_at IS NULL')
    if (input.sessionId) {
      const session = this.conversations.requireSession(input.sessionId)
      if (session.conversation_id !== conversation.id) {
        throw new ValidationError('session does not belong to this conversation')
      }
      where.push('session_id=@session_id')
      params.session_id = session.id
    }
    const kinds = [...new Set(input.kinds ?? [])].map((kind) => {
      if (!CONVERSATION_EVENT_KINDS.includes(kind)) throw new ValidationError('event kind is invalid')
      return kind
    })
    if (kinds.length) {
      const placeholders = kinds.map((_, index) => `@kind_${index}`)
      kinds.forEach((kind, index) => { params[`kind_${index}`] = kind })
      where.push(`kind IN (${placeholders.join(',')})`)
    }
    if (query) {
      where.push("instr(lower(coalesce(projected_text, '')), lower(@query)) > 0")
      params.query = query
    }
    if (actorType) {
      where.push('actor_type=@actor_type')
      params.actor_type = actorType
    }
    if (actorId) {
      where.push('actor_id=@actor_id')
      params.actor_id = actorId
    }
    if (tool) {
      where.push(`lower(coalesce(
        json_extract(metadata_json, '$.tool'),
        json_extract(metadata_json, '$.tool_name'),
        json_extract(metadata_json, '$.name'),
        ''
      ))=lower(@tool)`)
      params.tool = tool
    }
    if (status) {
      where.push(`lower(coalesce(
        json_extract(metadata_json, '$.status'),
        json_extract(metadata_json, '$.state'),
        CASE WHEN kind='status' THEN projected_text END,
        ''
      ))=lower(@status)`)
      params.status = status
    }
    if (from) {
      where.push('created_at>=@from')
      params.from = from
    }
    if (to) {
      where.push('created_at<=@to')
      params.to = to
    }

    const rows = this.db.prepare(`SELECT * FROM conversation_events
      WHERE ${where.join(' AND ')}
      ORDER BY sequence ASC
      LIMIT @page_limit`).all(params) as Record<string, unknown>[]
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const events = pageRows.map((row) => {
      const event = mapConversationEvent(row)
      return {
        ...event,
        links: this.links.forEvent(event),
      }
    })
    return {
      events,
      next_cursor: hasMore && events.length ? events.at(-1)!.sequence : null,
      has_more: hasMore,
      links: this.links.forConversation(conversation.id),
    }
  }
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidationError(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function optionalText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`)
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > maximum) {
    throw new ValidationError(`${field} must be at most ${maximum} characters`)
  }
  return normalized
}

function optionalDate(value: unknown, field: string): string | undefined {
  const normalized = optionalText(value, field, 64)
  if (!normalized) return undefined
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) throw new ValidationError(`${field} must be an ISO date`)
  return parsed.toISOString()
}

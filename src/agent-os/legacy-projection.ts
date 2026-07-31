import type Database from 'better-sqlite3'
import { pathsIntersect } from '../overlap.js'
import { AttentionService } from './attention.js'
import { runCompatibilityMigrationOperation } from './compatibility-migration-instrumentation.js'
import { EventStore } from './event-store.js'
import { parseJson, timestamp } from './json.js'

export interface LegacyBusEvent {
  board_id: number
  type: string
  data: unknown
}

/** Fail-soft bridge that makes existing Orchestra activity part of the durable OS record. */
export class LegacyEventProjection {
  private readonly events: EventStore
  private readonly attention: AttentionService

  constructor(private readonly db: Database.Database) {
    this.events = new EventStore(db)
    this.attention = new AttentionService(db)
  }

  project(event: LegacyBusEvent): void {
    if (!event || !Number.isSafeInteger(event.board_id) || !event.type || event.type.startsWith('os:')) return
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    const cardId = numberOrNull(data.card_id ?? (event.type === 'card' ? data.id : null))
    const agentId = numberOrNull(data.agent_id ?? data.from_agent_id)
    // A live bus payload has no authenticated DOM-017 source-row identity. Even an id-shaped
    // payload field is caller/provider-controlled, so it cannot select a linked cohort.
    runCompatibilityMigrationOperation(this.db, {
      subject: { table: 'card_events' },
      success_operations: ['adapter_translation', 'canonical_write'],
      failure_diagnostic: 'translation_rejected',
    }, () => {
      const workspaceId = this.workspaceFor(event.board_id, cardId, agentId)
      this.events.append({
        boardId: event.board_id,
        workspaceId,
        cardId,
        kind: `legacy.${event.type}`,
        source: 'legacy_bus',
        payload: event.data,
      })
      this.projectAttention(event, data, cardId, agentId, workspaceId)
    })
  }

  private projectAttention(event: LegacyBusEvent, data: Record<string, unknown>, cardId: number | null,
    agentId: number | null, workspaceId: string | null): void {
    if (event.type === 'message') {
      const body = typeof data.body === 'string' ? data.body.trim() : ''
      const from = numberOrNull(data.from_agent_id)
      const to = numberOrNull(data.to_agent_id)
      if (from && !to && body.includes('?')) {
        this.attention.create({ boardId: event.board_id, workspaceId, cardId, agentId: from,
          kind: 'agent.question', severity: 'high', title: 'Agent needs an answer', detail: body })
      }
      const replyTo = numberOrNull(data.reply_to)
      if (!from && replyTo) {
        const original = this.db.prepare('SELECT from_agent_id, card_id FROM messages WHERE id=?').get(replyTo) as
          { from_agent_id: number | null; card_id: number | null } | undefined
        if (original?.from_agent_id) this.resolveMatching(event.board_id, 'agent.question', original.from_agent_id, original.card_id)
      }
      return
    }
    if (event.type === 'permission') {
      const requestId = String(data.request_id ?? '')
      if (data.status === 'pending') {
        this.attention.create({ boardId: event.board_id, workspaceId, cardId, agentId,
          kind: 'permission.request', severity: 'critical', title: `Permission needed: ${String(data.title ?? data.summary ?? data.tool ?? 'tool request')}`,
          detail: JSON.stringify({ request_id: requestId, tool: data.tool ?? null, summary: data.summary ?? null }) })
      } else if (requestId) this.resolveMatching(event.board_id, 'permission.request', agentId, null, requestId)
      return
    }
    if (event.type === 'review') {
      if (data.status === 'awaiting_approval') {
        this.attention.create({ boardId: event.board_id, workspaceId, cardId, agentId,
          kind: 'review.request', severity: 'high', title: `Review requested: ${String(data.card_title ?? `card #${cardId}`)}`,
          detail: String(data.summary ?? data.diffstat ?? '') })
      } else if (cardId && ['approved', 'sent_back'].includes(String(data.status))) {
        this.resolveMatching(event.board_id, 'review.request', null, cardId)
      }
      return
    }
    if (event.type === 'launch') {
      const status = String(data.status ?? '')
      const outcome = String(data.outcome ?? '')
      const blocked = status === 'paused' || (status === 'finished' && (outcome !== 'success' || data.to_column === 'blocked'))
      if (blocked) {
        this.attention.create({ boardId: event.board_id, workspaceId, cardId, agentId,
          kind: 'launch.blocked', severity: status === 'paused' ? 'critical' : 'high',
          title: status === 'paused' ? 'Agent paused at a usage limit' : 'Agent launch is blocked',
          detail: String(data.reason ?? data.summary ?? 'agent did not complete the task') })
      } else if (cardId && (status === 'started' || (status === 'finished' && outcome === 'success'))) {
        this.resolveMatching(event.board_id, 'launch.blocked', null, cardId)
      }
      return
    }
    if (event.type === 'ship' && ['held', 'failed', 'error'].includes(String(data.status))) {
      this.attention.create({ boardId: event.board_id, workspaceId, cardId, agentId,
        kind: 'shipping.blocked', severity: 'high', title: 'Shipping needs attention',
        detail: String(data.reason ?? data.error ?? data.status) })
      return
    }
    if (event.type === 'card') this.projectCardConflict(event.board_id, data, cardId, workspaceId)
  }

  private projectCardConflict(boardId: number, data: Record<string, unknown>, cardId: number | null, workspaceId: string | null): void {
    if (!cardId || data.deleted || data.pruned) return
    const row = this.db.prepare('SELECT paths, column_name FROM cards WHERE id=?').get(cardId) as { paths: string; column_name: string } | undefined
    if (!row || ['backlog', 'done'].includes(row.column_name)) {
      this.resolveMatching(boardId, 'path.conflict', null, cardId)
      return
    }
    const paths = parseJson<string[]>(row.paths, [])
    if (!paths.length) {
      this.resolveMatching(boardId, 'path.conflict', null, cardId)
      return
    }
    const peers = this.db.prepare(`SELECT id, title, paths FROM cards WHERE board_id=? AND id!=?
      AND column_name IN ('in_progress','blocked','review')`).all(boardId, cardId) as Array<{ id: number; title: string; paths: string }>
    const overlap = peers.find((peer) => pathsIntersect(paths, parseJson<string[]>(peer.paths, [])))
    if (!overlap) {
      this.resolveMatching(boardId, 'path.conflict', null, cardId)
      return
    }
    this.attention.create({ boardId, workspaceId, cardId, kind: 'path.conflict', severity: 'high',
      title: `Path ownership overlaps card #${overlap.id}`, detail: `Active card "${overlap.title}" owns an intersecting path.` })
  }

  private resolveMatching(boardId: number, kind: string, agentId: number | null, cardId: number | null, detailNeedle?: string): void {
    const where = [`board_id=@board`, `kind=@kind`, `status='open'`]
    const params: Record<string, unknown> = { board: boardId, kind }
    if (agentId) { where.push('agent_id=@agent'); params.agent = agentId }
    if (cardId) { where.push('card_id=@card'); params.card = cardId }
    if (detailNeedle) { where.push('detail LIKE @detail'); params.detail = `%${detailNeedle}%` }
    this.db.prepare(`UPDATE attention_items SET status='resolved', resolved_at=@now WHERE ${where.join(' AND ')}`)
      .run({ ...params, now: timestamp() })
  }

  private workspaceFor(boardId: number, cardId: number | null, agentId: number | null): string | null {
    if (cardId) {
      const row = this.db.prepare(`SELECT id FROM workspaces WHERE board_id=? AND card_id=? AND status!='archived'
        ORDER BY updated_at DESC LIMIT 1`).get(boardId, cardId) as { id: string } | undefined
      if (row) return row.id
    }
    if (agentId) {
      const row = this.db.prepare(`SELECT s.workspace_id AS id FROM agent_sessions s JOIN workspaces w ON w.id=s.workspace_id
        WHERE w.board_id=? AND s.agent_id=? AND s.status NOT IN ('stopped','failed') ORDER BY s.updated_at DESC LIMIT 1`)
        .get(boardId, agentId) as { id: string } | undefined
      if (row) return row.id
    }
    return null
  }
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

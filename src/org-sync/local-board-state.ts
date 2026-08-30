import type Database from 'better-sqlite3'
import type { HubSyncEvent } from './hub-client.js'
import type { QueuedOp } from './outbox.js'

export interface LocalBoardEvent {
  board_id: number
  type: 'agent' | 'card' | 'message' | 'milestone'
  data: unknown
}

export interface LocalBoardStateOptions {
  db: Database.Database
  orgId: string
  publish?: (event: LocalBoardEvent) => void
  localBoardId?: number
}

export interface LocalCardCreateOperation {
  op: 'card.create'
  payload: {
    board_id: string
    title: string
    description: string
    paths: string[]
    owner_agent: string | null
    _local_card_id: number
  }
  localCardId: number
}

export interface LocalSyncOperation {
  op: 'card.create' | 'card.update' | 'card.move' | 'card.claim' | 'card.milestone'
    | 'mail.send' | 'milestone.create' | 'milestone.update' | 'milestone.delete'
  payload: Record<string, unknown>
  localCardId?: number
  localMessageId?: number
  localMilestoneId?: number
}

/** The card fields the hub owns, in local vocabulary (milestone as the HUB id — the
 * local integer means nothing to a diff against hub state). Deciding whether a local
 * bus event is an echo of a hub projection or a genuine edit is a comparison against
 * the last state either side synced — this is that state, canonically serialized. */
interface CardSnapshot {
  title: string
  description: string
  column: string
  owner: string | null
  paths: string[]
  milestone: string | null
}

interface MilestoneSnapshot {
  title: string
  description: string
  status: string
}

const milestoneSnapshot = (milestone: {
  title: string; description: string; status?: string | null
}): string => JSON.stringify({
  title: milestone.title,
  description: milestone.description,
  status: milestone.status ?? 'open',
} satisfies MilestoneSnapshot)

type HubCard = {
  id: string
  title: string
  description: string
  column: string
  owner_agent: string | null
  paths: string[]
  milestone_id?: string | null
  version: number
}

type HubMilestone = {
  id: string
  title: string
  description: string
  status: string
  version: number
}

type HubAgent = {
  id: string
  name: string
  state?: string
}

type HubMail = {
  id: string
  card_id: string | null
  kind: string
  subject: string | null
  body: string
  from_agent: string
  to_agent: string | null
  to_human: boolean
}

/** Projects replayable hub events into the same SQLite tables and bus events used by
 * the local board. The cursor is still owned by SyncLoop; this layer only makes each
 * local transaction idempotent in case cursor persistence fails after apply. */
export class LocalBoardState {
  readonly #db: Database.Database
  readonly #orgId: string
  readonly #publish?: LocalBoardStateOptions['publish']
  readonly #localBoardId?: number

  constructor(options: LocalBoardStateOptions) {
    this.#db = options.db
    this.#orgId = options.orgId
    this.#publish = options.publish
    this.#localBoardId = options.localBoardId
    installLocalBoardSyncSchema(this.#db)
  }

  apply(event: HubSyncEvent): void {
    const eventKey = eventIdentity(event)
    const applied = this.#db.prepare(`SELECT 1 FROM org_sync_applied_events
      WHERE org_id=? AND event_key=?`).get(this.#orgId, eventKey)
    if (applied) return

    const changes = this.#db.transaction(() => {
      const repeated = this.#db.prepare(`SELECT 1 FROM org_sync_applied_events
        WHERE org_id=? AND event_key=?`).get(this.#orgId, eventKey)
      if (repeated) return [] as LocalBoardEvent[]

      const projected = this.#project(event)
      this.#db.prepare(`INSERT INTO org_sync_applied_events (org_id, event_key, seq)
        VALUES (?, ?, ?)`).run(this.#orgId, eventKey, event.seq)
      return projected
    }).immediate()

    for (const change of changes) this.#publish?.(change)
  }

  mapLocalChange(change: unknown, hubBoardId: string): LocalSyncOperation[] {
    const event = change as { type?: unknown; data?: Record<string, unknown> }
    if (event.type === 'message') return this.#mapLocalMessage(event.data, hubBoardId)
    if (event.type === 'milestone') return this.#mapLocalMilestone(event, hubBoardId)
    if (event.type !== 'card' || !Number.isInteger(event.data?.id)) return []
    const localCardId = Number(event.data!.id)
    const card = this.#db.prepare(`SELECT card.*, agent.name AS owner
      FROM cards card LEFT JOIN agents agent ON agent.id=card.owner_agent_id
      WHERE card.id=?`).get(localCardId) as any
    if (!card) return []
    // Only the organization's own local board is shared. The daemon subscribes to the
    // whole event bus — every project board on the machine — and without this check a
    // card created on any personal board was pushed to the org board teammates can see.
    // Local boards are personal; the org board is the one deliberate exception. Fails
    // closed: with no configured org board, nothing is shared.
    if (this.#localBoardId === undefined || card.board_id !== this.#localBoardId) return []
    const mapping = this.#db.prepare(`SELECT hub_card_id, hub_version, last_synced_snapshot
      FROM org_sync_card_mappings WHERE org_id=? AND local_card_id=?`)
      .get(this.#orgId, localCardId) as
      { hub_card_id: string | null; hub_version: number | null; last_synced_snapshot: string | null } | undefined
    if (!mapping) {
      return [{
        op: 'card.create',
        payload: {
          board_id: hubBoardId,
          title: card.title,
          description: card.description,
          paths: JSON.parse(card.paths),
          owner_agent: card.owner ?? null,
          _local_card_id: localCardId,
        },
        localCardId,
      }]
    }
    // A create is queued but its echo has not returned yet: there is no hub id to
    // address an update to. The echo overwrites local state when it lands; edits made
    // inside that window follow the next genuine local change.
    if (!mapping.hub_card_id || !Number.isInteger(mapping.hub_version)) return []
    // Pre-snapshot mapping rows have nothing to diff against. Adopt the current local
    // state as the baseline instead of guessing — the row converges on the next event
    // from either side rather than replaying its whole card as a spurious update.
    const current = this.#cardSnapshot(card)
    if (mapping.last_synced_snapshot === null) {
      this.#storeSnapshot(localCardId, current, mapping.hub_version!)
      return []
    }
    if (mapping.last_synced_snapshot === current) return []
    const before = JSON.parse(mapping.last_synced_snapshot) as CardSnapshot
    const after = JSON.parse(current) as CardSnapshot
    const ops: LocalSyncOperation[] = []
    // expected_version chains: each successful op bumps the hub version by exactly one,
    // so a batch from one local change addresses consecutive versions. A stale guess
    // 409s, the op is dropped, and the next inbound event restores local state — the
    // hub stays the source of truth on every conflict.
    let version = mapping.hub_version!
    if (after.title !== before.title || after.description !== before.description
      || JSON.stringify(after.paths) !== JSON.stringify(before.paths)) {
      ops.push({ op: 'card.update', payload: {
        card_id: mapping.hub_card_id, expected_version: version,
        title: after.title, description: after.description, paths: after.paths,
      }, localCardId })
      version += 1
    }
    if (after.column !== before.column) {
      ops.push({ op: 'card.move', payload: {
        card_id: mapping.hub_card_id, expected_version: version, column: after.column,
      }, localCardId })
      version += 1
    }
    if (after.milestone !== before.milestone) {
      ops.push({ op: 'card.milestone', payload: {
        card_id: mapping.hub_card_id, expected_version: version, milestone_id: after.milestone,
      }, localCardId })
      version += 1
    }
    // The hub has claim but no unclaim: releasing a card stays local until the hub
    // grows an op for it. Claim is last so its unconditional version bump cannot
    // invalidate the expected_version of the ops before it.
    if (after.owner !== before.owner && after.owner !== null) {
      ops.push({ op: 'card.claim', payload: {
        card_id: mapping.hub_card_id, agent: after.owner,
      }, localCardId })
      version += 1
    }
    if (ops.length > 0) this.#storeSnapshot(localCardId, current, version)
    return ops
  }

  #mapLocalMessage(data: Record<string, unknown> | undefined, hubBoardId: string): LocalSyncOperation[] {
    if (!data || !Number.isInteger(data.id)) return []
    const message = this.#db.prepare(`SELECT message.*,
        sender.name AS from_name, recipient.name AS to_name
      FROM messages message
      LEFT JOIN agents sender ON sender.id=message.from_agent_id
      LEFT JOIN agents recipient ON recipient.id=message.to_agent_id
      WHERE message.id=?`).get(Number(data.id)) as any
    if (!message) return []
    // Same personal/shared gate as cards, plus two echo gates: rows this class itself
    // projected from the hub (marked organization_sync), and rows already mapped.
    if (this.#localBoardId === undefined || message.board_id !== this.#localBoardId) return []
    if (message.mail_type === 'organization_sync') return []
    if (!message.from_name) return []
    const mapped = this.#db.prepare(`SELECT 1 FROM org_sync_mail_mappings
      WHERE org_id=? AND local_message_id=?`).get(this.#orgId, message.id)
    if (mapped) return []
    const hubCardId = Number.isInteger(message.card_id)
      ? (this.#db.prepare(`SELECT hub_card_id FROM org_sync_card_mappings
          WHERE org_id=? AND local_card_id=?`).get(this.#orgId, message.card_id) as
        { hub_card_id: string | null } | undefined)?.hub_card_id ?? null
      : null
    return [{
      op: 'mail.send',
      payload: {
        board_id: hubBoardId,
        from_agent: message.from_name,
        to_agent: message.to_name ?? null,
        to_human: Boolean(message.to_human),
        subject: message.subject ?? undefined,
        body: message.body,
        card_id: hubCardId,
        kind: message.kind,
      },
      localMessageId: Number(message.id),
    }]
  }

  #mapLocalMilestone(
    event: { board_id?: unknown; data?: Record<string, unknown> },
    hubBoardId: string,
  ): LocalSyncOperation[] {
    // Deletions carry only { deleted: id } — the row is gone, so the gate is the bus
    // event's own board_id (every emit carries it) rather than a lookup.
    if (this.#localBoardId === undefined || event.board_id !== this.#localBoardId) return []
    const data = event.data
    if (!data) return []
    if (Number.isInteger((data as { deleted?: unknown }).deleted)) {
      const localMilestoneId = Number((data as { deleted: number }).deleted)
      const mapped = this.#db.prepare(`SELECT hub_milestone_id FROM org_sync_milestone_mappings
        WHERE org_id=? AND local_milestone_id=?`).get(this.#orgId, localMilestoneId) as
        { hub_milestone_id: string | null } | undefined
      this.#db.prepare(`DELETE FROM org_sync_milestone_mappings
        WHERE org_id=? AND local_milestone_id=?`).run(this.#orgId, localMilestoneId)
      if (!mapped?.hub_milestone_id) return []
      return [{ op: 'milestone.delete', payload: { milestone_id: mapped.hub_milestone_id } }]
    }
    if (!Number.isInteger(data.id)) return []
    const milestone = this.#db.prepare('SELECT * FROM milestones WHERE id=?')
      .get(Number(data.id)) as any
    if (!milestone || milestone.board_id !== this.#localBoardId) return []
    const mapping = this.#db.prepare(`SELECT hub_milestone_id, hub_version, last_synced_snapshot
      FROM org_sync_milestone_mappings WHERE org_id=? AND local_milestone_id=?`)
      .get(this.#orgId, milestone.id) as
      { hub_milestone_id: string | null; hub_version: number | null; last_synced_snapshot: string | null } | undefined
    const current = milestoneSnapshot(milestone)
    if (!mapping) {
      return [{
        op: 'milestone.create',
        payload: {
          board_id: hubBoardId,
          title: milestone.title,
          description: milestone.description,
          _local_milestone_id: milestone.id,
        },
        localMilestoneId: Number(milestone.id),
      }]
    }
    if (!mapping.hub_milestone_id || !Number.isInteger(mapping.hub_version)) return []
    if (mapping.last_synced_snapshot === current) return []
    const op: LocalSyncOperation = {
      op: 'milestone.update',
      payload: {
        milestone_id: mapping.hub_milestone_id,
        expected_version: mapping.hub_version,
        title: milestone.title,
        description: milestone.description,
        status: milestone.status ?? 'open',
      },
    }
    this.#db.prepare(`UPDATE org_sync_milestone_mappings
      SET last_synced_snapshot=?, hub_version=? WHERE org_id=? AND local_milestone_id=?`)
      .run(current, mapping.hub_version! + 1, this.#orgId, milestone.id)
    return [op]
  }

  recordMilestoneOutboundEnqueued(localMilestoneId: number, idempotencyKey: string): void {
    const milestone = this.#db.prepare('SELECT * FROM milestones WHERE id=?')
      .get(localMilestoneId) as any
    this.#db.prepare(`INSERT INTO org_sync_milestone_mappings
      (org_id, local_milestone_id, outbound_idempotency_key, last_synced_snapshot)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(org_id, local_milestone_id) DO UPDATE SET
        outbound_idempotency_key=COALESCE(org_sync_milestone_mappings.outbound_idempotency_key,
          excluded.outbound_idempotency_key)`).run(
      this.#orgId, localMilestoneId, idempotencyKey,
      milestone ? milestoneSnapshot(milestone) : null)
  }

  #storeSnapshot(localCardId: number, snapshot: string, hubVersion: number): void {
    this.#db.prepare(`UPDATE org_sync_card_mappings
      SET last_synced_snapshot=?, hub_version=?, updated_at=datetime('now')
      WHERE org_id=? AND local_card_id=?`).run(snapshot, hubVersion, this.#orgId, localCardId)
  }

  recordOutboundEnqueued(localCardId: number, idempotencyKey: string): void {
    const card = this.#db.prepare(`SELECT card.*, agent.name AS owner
      FROM cards card LEFT JOIN agents agent ON agent.id=card.owner_agent_id
      WHERE card.id=?`).get(localCardId) as any
    this.#db.prepare(`INSERT INTO org_sync_card_mappings
      (org_id, local_card_id, outbound_idempotency_key, last_synced_snapshot)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(org_id, local_card_id) DO UPDATE SET
        outbound_idempotency_key=COALESCE(org_sync_card_mappings.outbound_idempotency_key,
          excluded.outbound_idempotency_key),
        last_synced_snapshot=COALESCE(org_sync_card_mappings.last_synced_snapshot,
          excluded.last_synced_snapshot),
        updated_at=datetime('now')`).run(
      this.#orgId, localCardId, idempotencyKey, card ? this.#cardSnapshot(card) : null)
  }

  #cardSnapshot(card: {
    title: string; description: string; column_name: string
    owner: string | null; paths: string; milestone_id: number | null
  }): string {
    return JSON.stringify({
      title: card.title,
      description: card.description,
      column: card.column_name,
      owner: card.owner ?? null,
      paths: JSON.parse(card.paths),
      milestone: this.#hubMilestoneId(card.milestone_id),
    } satisfies CardSnapshot)
  }

  #hubMilestoneId(localMilestoneId: number | null | undefined): string | null {
    if (!Number.isInteger(localMilestoneId)) return null
    const mapped = this.#db.prepare(`SELECT hub_milestone_id FROM org_sync_milestone_mappings
      WHERE org_id=? AND local_milestone_id=?`).get(this.#orgId, localMilestoneId) as
      { hub_milestone_id: string | null } | undefined
    return mapped?.hub_milestone_id ?? null
  }

  recordMailOutboundEnqueued(localMessageId: number, idempotencyKey: string): void {
    this.#db.prepare(`INSERT INTO org_sync_mail_mappings
      (org_id, local_message_id, outbound_idempotency_key)
      VALUES (?, ?, ?)
      ON CONFLICT(org_id, local_message_id) DO NOTHING`).run(
      this.#orgId, localMessageId, idempotencyKey)
  }

  reconcileOutbound(pending: QueuedOp[]): void {
    if (pending.length === 0) return
    const reconcile = this.#db.transaction((items: QueuedOp[]) => {
      for (const item of items) {
        if (item.op === 'card.create') {
          const payload = item.payload as { _local_card_id?: unknown } | null
          if (!Number.isInteger(payload?._local_card_id)) continue
          const localCardId = Number(payload!._local_card_id)
          if (!this.#db.prepare('SELECT 1 FROM cards WHERE id=?').get(localCardId)) continue
          this.recordOutboundEnqueued(localCardId, item.idempotencyKey)
        }
        if (item.op === 'milestone.create') {
          const payload = item.payload as { _local_milestone_id?: unknown } | null
          if (!Number.isInteger(payload?._local_milestone_id)) continue
          this.recordMilestoneOutboundEnqueued(Number(payload!._local_milestone_id), item.idempotencyKey)
        }
      }
    })
    reconcile.immediate(pending)
  }

  #project(event: HubSyncEvent): LocalBoardEvent[] {
    if (typeof event.kind !== 'string') return []
    if (event.kind.startsWith('card.')) return this.#projectCard(event)
    if (event.kind === 'agent.registered' || event.kind === 'agent.presence') {
      return this.#projectAgent(event)
    }
    if (event.kind === 'mail.sent') return this.#projectMail(event)
    if (event.kind.startsWith('milestone.')) return this.#projectMilestone(event)
    return []
  }

  #projectMilestone(event: HubSyncEvent): LocalBoardEvent[] {
    const boardId = this.#targetBoardId()
    if (event.kind === 'milestone.deleted') {
      const payload = event.payload as { id?: unknown } | null
      if (typeof payload?.id !== 'string') return []
      const mapped = this.#db.prepare(`SELECT local_milestone_id FROM org_sync_milestone_mappings
        WHERE org_id=? AND hub_milestone_id=?`).get(this.#orgId, payload.id) as
        { local_milestone_id: number } | undefined
      this.#db.prepare(`DELETE FROM org_sync_milestone_mappings
        WHERE org_id=? AND hub_milestone_id=?`).run(this.#orgId, payload.id)
      if (!mapped) return []
      this.#db.prepare(`UPDATE cards SET milestone_id=NULL, step_order=NULL WHERE milestone_id=?`)
        .run(mapped.local_milestone_id)
      const gone = this.#db.prepare('DELETE FROM milestones WHERE id=?').run(mapped.local_milestone_id)
      if (gone.changes === 0) return []
      return [{ board_id: boardId, type: 'milestone', data: { deleted: mapped.local_milestone_id } }]
    }

    const milestone = hubMilestone(event.payload)
    const idempotencyKey = stringOrNull(event.idempotency_key)
    const mapped = this.#db.prepare(`SELECT local_milestone_id, hub_milestone_id
      FROM org_sync_milestone_mappings
      WHERE org_id=? AND (hub_milestone_id=? OR (? IS NOT NULL AND outbound_idempotency_key=?))
      LIMIT 1`).get(this.#orgId, milestone.id, idempotencyKey, idempotencyKey) as
      { local_milestone_id: number; hub_milestone_id: string | null } | undefined

    // Our own milestone.create echoing back — same rule as cards: local edits made
    // while the echo was in flight win; the re-published row diffs into catch-up ops.
    if (mapped && mapped.hub_milestone_id === null) {
      this.#db.prepare(`INSERT INTO org_sync_milestone_mappings
        (org_id, local_milestone_id, hub_milestone_id, hub_version, outbound_idempotency_key, last_synced_snapshot)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(org_id, local_milestone_id) DO UPDATE SET
          hub_milestone_id=excluded.hub_milestone_id,
          hub_version=excluded.hub_version,
          last_synced_snapshot=excluded.last_synced_snapshot`).run(
        this.#orgId, mapped.local_milestone_id, milestone.id, milestone.version,
        idempotencyKey, milestoneSnapshot(milestone))
      const kept = this.#db.prepare('SELECT * FROM milestones WHERE id=?').get(mapped.local_milestone_id)
      return kept ? [{ board_id: boardId, type: 'milestone', data: kept }] : []
    }

    let localMilestoneId = mapped?.local_milestone_id
    if (localMilestoneId === undefined) {
      const inserted = this.#db.prepare(`INSERT INTO milestones (board_id, title, description, status)
        VALUES (?, ?, ?, ?)`).run(boardId, milestone.title, milestone.description, milestone.status)
      localMilestoneId = Number(inserted.lastInsertRowid)
    } else {
      this.#db.prepare(`UPDATE milestones SET title=?, description=?, status=? WHERE id=?`)
        .run(milestone.title, milestone.description, milestone.status, localMilestoneId)
    }
    this.#db.prepare(`INSERT INTO org_sync_milestone_mappings
      (org_id, local_milestone_id, hub_milestone_id, hub_version, outbound_idempotency_key, last_synced_snapshot)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, local_milestone_id) DO UPDATE SET
        hub_milestone_id=excluded.hub_milestone_id,
        hub_version=excluded.hub_version,
        outbound_idempotency_key=COALESCE(org_sync_milestone_mappings.outbound_idempotency_key,
          excluded.outbound_idempotency_key),
        last_synced_snapshot=excluded.last_synced_snapshot`).run(
      this.#orgId, localMilestoneId, milestone.id, milestone.version, idempotencyKey,
      milestoneSnapshot(milestone))
    const local = this.#db.prepare('SELECT * FROM milestones WHERE id=?').get(localMilestoneId)
    return [{ board_id: boardId, type: 'milestone', data: local }]
  }

  #localMilestoneId(hubMilestoneId: string | null): number | null {
    if (!hubMilestoneId) return null
    const mapped = this.#db.prepare(`SELECT local_milestone_id FROM org_sync_milestone_mappings
      WHERE org_id=? AND hub_milestone_id=?`).get(this.#orgId, hubMilestoneId) as
      { local_milestone_id: number } | undefined
    return mapped?.local_milestone_id ?? null
  }

  #projectCard(event: HubSyncEvent): LocalBoardEvent[] {
    const card = hubCard(event.payload)
    // Echo suppression depends on the hub preserving HubEvent.idempotency_key on the wire.
    const idempotencyKey = stringOrNull(event.idempotency_key)
    const mapping = this.#db.prepare(`SELECT local_card_id, hub_card_id FROM org_sync_card_mappings
      WHERE org_id=? AND (hub_card_id=? OR (? IS NOT NULL AND outbound_idempotency_key=?))
      LIMIT 1`).get(this.#orgId, card.id, idempotencyKey, idempotencyKey) as
      { local_card_id: number; hub_card_id: string | null } | undefined

    // The echo of our own card.create. The local row may already be AHEAD of the hub —
    // edited in the window before this echo landed — so overwriting it would silently
    // revert those edits. Keep the local row, record the hub's state as the synced
    // baseline, and re-publish the local row: its bus echo diffs local-vs-baseline and
    // queues catch-up ops, so the hub converges to the local edits instead.
    if (mapping && mapping.hub_card_id === null) {
      this.#db.prepare(`UPDATE org_sync_card_mappings SET hub_card_id=?, hub_version=?,
          last_synced_snapshot=?, updated_at=datetime('now')
        WHERE org_id=? AND local_card_id=?`).run(
        card.id, card.version,
        projectedSnapshot(card, localColumn(card.column),
          this.#localMilestoneId(card.milestone_id ?? null) === null ? null : card.milestone_id ?? null),
        this.#orgId, mapping.local_card_id,
      )
      const kept = this.#localCard(mapping.local_card_id)
      return [{ board_id: kept.board_id, type: 'card', data: kept }]
    }
    const ownerId = card.owner_agent ? this.#ensureAgent(card.owner_agent, undefined, 'idle').id : null
    const column = localColumn(card.column)
    const localMilestoneId = this.#localMilestoneId(card.milestone_id ?? null)
    let localCardId = mapping?.local_card_id

    if (localCardId === undefined) {
      const boardId = this.#targetBoardId()
      const inserted = this.#db.prepare(`INSERT INTO cards
        (board_id, title, description, column_name, owner_agent_id, paths, milestone_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`).run(
        boardId, card.title, card.description, column, ownerId, JSON.stringify(card.paths),
        localMilestoneId,
      )
      localCardId = Number(inserted.lastInsertRowid)
      this.#db.prepare(`INSERT INTO org_sync_card_mappings
        (org_id, local_card_id, hub_card_id, hub_version, outbound_idempotency_key, last_synced_snapshot)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        this.#orgId, localCardId, card.id, card.version, idempotencyKey,
        projectedSnapshot(card, column, localMilestoneId === null ? null : card.milestone_id ?? null),
      )
      this.#db.prepare(`INSERT INTO card_events (card_id, type, payload)
        VALUES (?, 'created', ?)`).run(localCardId, JSON.stringify({
        title: card.title, source: 'organization_sync', hub_card_id: card.id,
      }))
    } else {
      const updated = this.#db.prepare(`UPDATE cards SET title=?, description=?, column_name=?,
          owner_agent_id=?, paths=?, milestone_id=?, updated_at=datetime('now') WHERE id=?`).run(
        card.title, card.description, column, ownerId, JSON.stringify(card.paths),
        localMilestoneId, localCardId,
      )
      if (updated.changes !== 1) throw new Error('organization card mapping points to a missing local card')
      this.#db.prepare(`UPDATE org_sync_card_mappings SET hub_card_id=?, hub_version=?,
          outbound_idempotency_key=COALESCE(outbound_idempotency_key, ?),
          last_synced_snapshot=?, updated_at=datetime('now')
        WHERE org_id=? AND local_card_id=?`).run(
        card.id, card.version, idempotencyKey,
        projectedSnapshot(card, column, localMilestoneId === null ? null : card.milestone_id ?? null),
        this.#orgId, localCardId,
      )
      this.#db.prepare(`INSERT INTO card_events (card_id, type, payload)
        VALUES (?, 'updated', ?)`).run(localCardId, JSON.stringify({
        source: 'organization_sync', kind: event.kind, hub_card_id: card.id, version: card.version,
      }))
    }

    const local = this.#localCard(localCardId)
    return [{ board_id: local.board_id, type: 'card', data: local }]
  }

  #projectAgent(event: HubSyncEvent): LocalBoardEvent[] {
    const agent = hubAgent(event.payload)
    const local = this.#ensureAgent(agent.name, agent.id, localAgentStatus(agent.state))
    return [{ board_id: local.board_id, type: 'agent', data: local }]
  }

  #projectMail(event: HubSyncEvent): LocalBoardEvent[] {
    // Our own mail comes back on the stream like everyone else's. The idempotency key
    // recorded at enqueue identifies it; re-inserting would show the sender their
    // message twice.
    const idempotencyKey = stringOrNull(event.idempotency_key)
    if (idempotencyKey) {
      const ours = this.#db.prepare(`SELECT local_message_id FROM org_sync_mail_mappings
        WHERE org_id=? AND outbound_idempotency_key=?`).get(this.#orgId, idempotencyKey) as
        { local_message_id: number } | undefined
      if (ours) {
        this.#recordInboundMail(ours.local_message_id, event)
        return []
      }
    }
    const mail = hubMail(event.payload)
    const boardId = this.#targetBoardId()
    const from = this.#ensureAgent(mail.from_agent, undefined, 'idle')
    // Mail addressed to an agent that actually runs on THIS machine lands on that
    // agent's own board, where every existing delivery path (snapshot, hooks, inbox)
    // already looks. The org-board shadow insert is the fallback that keeps the mail
    // visible on machines that merely observe the exchange.
    const localRecipient = mail.to_agent
      ? this.#db.prepare(`SELECT id, board_id FROM agents
          WHERE name=? AND org_sync_remote_origin IS NULL AND status <> 'gone'
          ORDER BY last_seen DESC LIMIT 1`).get(mail.to_agent) as
        { id: number; board_id: number } | undefined
      : undefined
    const to = localRecipient ?? (mail.to_agent ? this.#ensureAgent(mail.to_agent, undefined, 'idle') : null)
    const targetBoardId = localRecipient?.board_id ?? boardId
    const mappedCard = mail.card_id
      ? this.#db.prepare(`SELECT local_card_id FROM org_sync_card_mappings
          WHERE org_id=? AND hub_card_id=?`).get(this.#orgId, mail.card_id) as
        { local_card_id: number } | undefined
      : undefined
    const inserted = this.#db.prepare(`INSERT INTO messages
      (board_id, from_agent_id, to_agent_id, card_id, kind, body, to_human, subject, mail_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'organization_sync')`).run(
      targetBoardId, from.id, to?.id ?? null, mappedCard?.local_card_id ?? null,
      mail.kind, mail.body, mail.to_human ? 1 : 0, mail.subject,
    )
    this.#recordInboundMail(Number(inserted.lastInsertRowid), event)
    const message = this.#db.prepare(`SELECT * FROM messages WHERE id=?`).get(inserted.lastInsertRowid)
    return [{ board_id: targetBoardId, type: 'message', data: message }]
  }

  #recordInboundMail(localMessageId: number, event: HubSyncEvent): void {
    const hubMailId = (event.payload as { id?: unknown } | null)?.id
    this.#db.prepare(`INSERT INTO org_sync_mail_mappings
      (org_id, local_message_id, hub_mail_id, outbound_idempotency_key)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(org_id, local_message_id) DO UPDATE SET
        hub_mail_id=COALESCE(org_sync_mail_mappings.hub_mail_id, excluded.hub_mail_id)`).run(
      this.#orgId, localMessageId, typeof hubMailId === 'string' ? hubMailId : null,
      stringOrNull(event.idempotency_key))
  }

  #ensureAgent(name: string, hubAgentId: string | undefined, status: string): { id: number; board_id: number; [key: string]: unknown } {
    const mapped = hubAgentId
      ? this.#db.prepare(`SELECT local_agent_id FROM org_sync_agent_mappings
          WHERE org_id=? AND hub_agent_id=?`).get(this.#orgId, hubAgentId) as
        { local_agent_id: number } | undefined
      : undefined
    let local = mapped
      ? this.#db.prepare(`SELECT * FROM agents WHERE id=?`).get(mapped.local_agent_id) as any
      : undefined
    const boardId = local?.board_id ?? this.#targetBoardId()
    local ??= this.#db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(boardId, name) as any
    if (!local) {
      const inserted = this.#db.prepare(`INSERT INTO agents
        (board_id, name, status, last_seen, org_sync_remote_origin)
        VALUES (?, ?, ?, datetime('now'), ?)`).run(boardId, name, status, this.#orgId)
      local = this.#db.prepare(`SELECT * FROM agents WHERE id=?`).get(inserted.lastInsertRowid) as any
    } else if (hubAgentId) {
      this.#db.prepare(`UPDATE agents SET status=?, last_seen=datetime('now'),
        org_sync_remote_origin=? WHERE id=?`).run(status, this.#orgId, local.id)
      local = this.#db.prepare(`SELECT * FROM agents WHERE id=?`).get(local.id) as any
    } else {
      this.#db.prepare('UPDATE agents SET org_sync_remote_origin=? WHERE id=?')
        .run(this.#orgId, local.id)
      local = this.#db.prepare(`SELECT * FROM agents WHERE id=?`).get(local.id) as any
    }
    if (hubAgentId) {
      this.#db.prepare(`INSERT INTO org_sync_agent_mappings (org_id, hub_agent_id, local_agent_id)
        VALUES (?, ?, ?) ON CONFLICT(org_id, hub_agent_id) DO UPDATE SET local_agent_id=excluded.local_agent_id`)
        .run(this.#orgId, hubAgentId, local.id)
    }
    return local
  }

  #targetBoardId(): number {
    if (this.#localBoardId === undefined) {
      throw new Error('organization sync has no configured local destination board')
    }
    const selected = this.#db.prepare('SELECT id FROM boards WHERE id=?').get(this.#localBoardId)
    if (!selected) throw new Error(`organization sync local board ${this.#localBoardId} does not exist`)
    return this.#localBoardId
  }

  #localCard(id: number): Record<string, unknown> & { board_id: number } {
    const card = this.#db.prepare(`SELECT card.*, agent.name AS owner
      FROM cards card LEFT JOIN agents agent ON agent.id=card.owner_agent_id WHERE card.id=?`).get(id) as any
    if (!card) throw new Error('organization sync could not read the applied local card')
    return { ...card, column: card.column_name, paths: JSON.parse(card.paths) }
  }
}

export function installLocalBoardSyncSchema(db: Database.Database): void {
  try { db.exec('ALTER TABLE agents ADD COLUMN org_sync_remote_origin TEXT') } catch { /* exists */ }
  db.exec(`
    -- Deliberately no FK to milestones: a local deletion must still find the hub id
    -- afterwards to send milestone.delete — a cascade would erase the address first.
    CREATE TABLE IF NOT EXISTS org_sync_milestone_mappings (
      org_id TEXT NOT NULL,
      local_milestone_id INTEGER NOT NULL,
      hub_milestone_id TEXT,
      hub_version INTEGER,
      outbound_idempotency_key TEXT,
      last_synced_snapshot TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(org_id, local_milestone_id),
      UNIQUE(org_id, hub_milestone_id),
      UNIQUE(org_id, outbound_idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS org_sync_mail_mappings (
      org_id TEXT NOT NULL,
      local_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      hub_mail_id TEXT,
      outbound_idempotency_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(org_id, local_message_id),
      UNIQUE(org_id, hub_mail_id),
      UNIQUE(org_id, outbound_idempotency_key)
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_sync_boards (
      org_id TEXT PRIMARY KEY,
      local_board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS org_sync_card_mappings (
      id INTEGER PRIMARY KEY,
      org_id TEXT NOT NULL,
      local_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      hub_card_id TEXT,
      hub_version INTEGER,
      outbound_idempotency_key TEXT,
      last_synced_snapshot TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id, local_card_id),
      UNIQUE(org_id, hub_card_id),
      UNIQUE(org_id, outbound_idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS org_sync_agent_mappings (
      org_id TEXT NOT NULL,
      hub_agent_id TEXT NOT NULL,
      local_agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY(org_id, hub_agent_id)
    );
    CREATE TABLE IF NOT EXISTS org_sync_applied_events (
      org_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(org_id, event_key),
      UNIQUE(org_id, seq)
    );
    UPDATE agents SET org_sync_remote_origin=(
      SELECT MIN(mapping.org_id) FROM org_sync_agent_mappings mapping
      WHERE mapping.local_agent_id=agents.id
    )
    WHERE org_sync_remote_origin IS NULL
      AND EXISTS (SELECT 1 FROM org_sync_agent_mappings mapping
        WHERE mapping.local_agent_id=agents.id);
  `)
  // After the CREATE above so a fresh install (which already has the column) and an
  // upgraded one (which needs it added) both end at the same schema.
  try { db.exec('ALTER TABLE org_sync_card_mappings ADD COLUMN last_synced_snapshot TEXT') } catch { /* exists */ }
}

export function ensureLocalOrgBoard(
  db: Database.Database,
  orgId: string,
  projectPath: string,
  orgName?: string,
): number {
  installLocalBoardSyncSchema(db)
  const displayName = orgName?.trim() || `Organization ${orgId}`
  return db.transaction(() => {
    const mapped = db.prepare(`SELECT board.id, board.name FROM org_sync_boards mapping
      JOIN boards board ON board.id=mapping.local_board_id
      WHERE mapping.org_id=?`).get(orgId) as { id: number; name: string } | undefined
    if (mapped) {
      // Boards created before the credential carried the org's name are stuck showing
      // the raw id in the project picker. Adopt the name — but only over the default
      // pattern, never over something a person renamed deliberately.
      if (mapped.name === `Organization ${orgId}` && mapped.name !== displayName) {
        db.prepare('UPDATE boards SET name=? WHERE id=?').run(displayName, mapped.id)
      }
      return mapped.id
    }

    const existing = db.prepare('SELECT id FROM boards WHERE project_path=?')
      .get(projectPath) as { id: number } | undefined
    const boardId = existing?.id ?? Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES (?, ?)`).run(projectPath, displayName).lastInsertRowid)
    db.prepare(`INSERT INTO org_sync_boards (org_id, local_board_id) VALUES (?, ?)
      ON CONFLICT(org_id) DO UPDATE SET local_board_id=excluded.local_board_id`).run(orgId, boardId)
    return boardId
  }).immediate()
}

const eventIdentity = (event: HubSyncEvent): string => {
  if (typeof event.id === 'string' && event.id) return event.id
  if (!Number.isInteger(event.seq) || event.seq < 0) throw new Error('hub event has an invalid sequence')
  return `seq:${event.seq}`
}

const hubCard = (value: unknown): HubCard => {
  const card = record(value)
  if (typeof card.id !== 'string' || typeof card.title !== 'string'
    || typeof card.description !== 'string' || typeof card.column !== 'string'
    || !Array.isArray(card.paths) || !card.paths.every((item) => typeof item === 'string')
    || !Number.isInteger(card.version)
    || (card.owner_agent !== null && typeof card.owner_agent !== 'string')
    || (card.milestone_id !== undefined && card.milestone_id !== null
      && typeof card.milestone_id !== 'string')) {
    throw new Error('hub sent an invalid card event')
  }
  return card as HubCard
}

const hubMilestone = (value: unknown): HubMilestone => {
  const milestone = record(value)
  if (typeof milestone.id !== 'string' || typeof milestone.title !== 'string'
    || typeof milestone.description !== 'string' || typeof milestone.status !== 'string'
    || !Number.isInteger(milestone.version)) {
    throw new Error('hub sent an invalid milestone event')
  }
  return milestone as HubMilestone
}

const hubAgent = (value: unknown): HubAgent => {
  const agent = record(value)
  if (typeof agent.id !== 'string' || typeof agent.name !== 'string'
    || (agent.state !== undefined && typeof agent.state !== 'string')) {
    throw new Error('hub sent an invalid agent event')
  }
  return agent as HubAgent
}

const hubMail = (value: unknown): HubMail => {
  const mail = record(value)
  if (typeof mail.id !== 'string' || typeof mail.kind !== 'string' || typeof mail.body !== 'string'
    || typeof mail.from_agent !== 'string' || typeof mail.to_human !== 'boolean'
    || (mail.subject !== null && typeof mail.subject !== 'string')
    || (mail.to_agent !== null && typeof mail.to_agent !== 'string')
    || (mail.card_id !== null && typeof mail.card_id !== 'string')) {
    throw new Error('hub sent an invalid mail event')
  }
  return mail as HubMail
}

const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('hub event payload is invalid')
  return value as Record<string, any>
}

/** The snapshot a projected hub card leaves behind — identical, byte for byte, to what
 * `cardSnapshot` computes when the projection's own bus echo re-reads the local row, so
 * the echo diffs to nothing. */
/** `milestone` is what the LOCAL row ended up referencing (the hub id when the
 * milestone is mapped locally, null when it is not) — not what the hub said. The
 * snapshot must equal what the projection's own bus echo will re-read, or the echo
 * diffs to a spurious op that clears the hub's milestone. */
const projectedSnapshot = (card: HubCard, column: string, milestone: string | null): string => JSON.stringify({
  title: card.title,
  description: card.description,
  column,
  owner: card.owner_agent,
  paths: card.paths,
  milestone,
} satisfies CardSnapshot)

const localColumn = (column: string): string => {
  if (column === 'todo') return 'backlog'
  return new Set(['backlog', 'in_progress', 'blocked', 'review', 'done']).has(column) ? column : 'backlog'
}

const localAgentStatus = (state: string | undefined): string => state === 'working' ? 'active' : 'idle'
const stringOrNull = (value: unknown): string | null => typeof value === 'string' && value ? value : null

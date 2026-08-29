import type Database from 'better-sqlite3'
import type { HubSyncEvent } from './hub-client.js'
import type { QueuedOp } from './outbox.js'

export interface LocalBoardEvent {
  board_id: number
  type: 'agent' | 'card' | 'message'
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

type HubCard = {
  id: string
  title: string
  description: string
  column: string
  owner_agent: string | null
  paths: string[]
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

  mapLocalChange(change: unknown, hubBoardId: string): LocalCardCreateOperation | null {
    const event = change as { type?: unknown; data?: Record<string, unknown> }
    if (event.type !== 'card' || !Number.isInteger(event.data?.id)) return null
    const localCardId = Number(event.data!.id)
    const mapped = this.#db.prepare(`SELECT 1 FROM org_sync_card_mappings
      WHERE org_id=? AND local_card_id=?`).get(this.#orgId, localCardId)
    if (mapped) return null
    const card = this.#db.prepare(`SELECT card.*, agent.name AS owner
      FROM cards card LEFT JOIN agents agent ON agent.id=card.owner_agent_id
      WHERE card.id=?`).get(localCardId) as any
    if (!card) return null
    return {
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
    }
  }

  recordOutboundEnqueued(localCardId: number, idempotencyKey: string): void {
    this.#db.prepare(`INSERT INTO org_sync_card_mappings
      (org_id, local_card_id, outbound_idempotency_key)
      VALUES (?, ?, ?)
      ON CONFLICT(org_id, local_card_id) DO UPDATE SET
        outbound_idempotency_key=COALESCE(org_sync_card_mappings.outbound_idempotency_key,
          excluded.outbound_idempotency_key),
        updated_at=datetime('now')`).run(this.#orgId, localCardId, idempotencyKey)
  }

  reconcileOutbound(pending: QueuedOp[]): void {
    const reconcile = this.#db.transaction((items: QueuedOp[]) => {
      for (const item of items) {
        if (item.op !== 'card.create') continue
        const payload = item.payload as { _local_card_id?: unknown } | null
        if (!Number.isInteger(payload?._local_card_id)) continue
        const localCardId = Number(payload!._local_card_id)
        if (!this.#db.prepare('SELECT 1 FROM cards WHERE id=?').get(localCardId)) continue
        this.recordOutboundEnqueued(localCardId, item.idempotencyKey)
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
    return []
  }

  #projectCard(event: HubSyncEvent): LocalBoardEvent[] {
    const card = hubCard(event.payload)
    const idempotencyKey = stringOrNull((event as Record<string, unknown>).idempotency_key)
    const mapping = this.#db.prepare(`SELECT local_card_id FROM org_sync_card_mappings
      WHERE org_id=? AND (hub_card_id=? OR (? IS NOT NULL AND outbound_idempotency_key=?))
      LIMIT 1`).get(this.#orgId, card.id, idempotencyKey, idempotencyKey) as
      { local_card_id: number } | undefined
    const ownerId = card.owner_agent ? this.#ensureAgent(card.owner_agent, undefined, 'idle').id : null
    const column = localColumn(card.column)
    let localCardId = mapping?.local_card_id

    if (localCardId === undefined) {
      const boardId = this.#targetBoardId()
      const inserted = this.#db.prepare(`INSERT INTO cards
        (board_id, title, description, column_name, owner_agent_id, paths, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`).run(
        boardId, card.title, card.description, column, ownerId, JSON.stringify(card.paths),
      )
      localCardId = Number(inserted.lastInsertRowid)
      this.#db.prepare(`INSERT INTO org_sync_card_mappings
        (org_id, local_card_id, hub_card_id, hub_version, outbound_idempotency_key)
        VALUES (?, ?, ?, ?, ?)`).run(
        this.#orgId, localCardId, card.id, card.version, idempotencyKey,
      )
      this.#db.prepare(`INSERT INTO card_events (card_id, type, payload)
        VALUES (?, 'created', ?)`).run(localCardId, JSON.stringify({
        title: card.title, source: 'organization_sync', hub_card_id: card.id,
      }))
    } else {
      const updated = this.#db.prepare(`UPDATE cards SET title=?, description=?, column_name=?,
          owner_agent_id=?, paths=?, updated_at=datetime('now') WHERE id=?`).run(
        card.title, card.description, column, ownerId, JSON.stringify(card.paths), localCardId,
      )
      if (updated.changes !== 1) throw new Error('organization card mapping points to a missing local card')
      this.#db.prepare(`UPDATE org_sync_card_mappings SET hub_card_id=?, hub_version=?,
          outbound_idempotency_key=COALESCE(outbound_idempotency_key, ?), updated_at=datetime('now')
        WHERE org_id=? AND local_card_id=?`).run(
        card.id, card.version, idempotencyKey, this.#orgId, localCardId,
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
    const mail = hubMail(event.payload)
    const boardId = this.#targetBoardId()
    const from = this.#ensureAgent(mail.from_agent, undefined, 'idle')
    const to = mail.to_agent ? this.#ensureAgent(mail.to_agent, undefined, 'idle') : null
    const mappedCard = mail.card_id
      ? this.#db.prepare(`SELECT local_card_id FROM org_sync_card_mappings
          WHERE org_id=? AND hub_card_id=?`).get(this.#orgId, mail.card_id) as
        { local_card_id: number } | undefined
      : undefined
    const inserted = this.#db.prepare(`INSERT INTO messages
      (board_id, from_agent_id, to_agent_id, card_id, kind, body, to_human, subject, mail_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'organization_sync')`).run(
      boardId, from.id, to?.id ?? null, mappedCard?.local_card_id ?? null,
      mail.kind, mail.body, mail.to_human ? 1 : 0, mail.subject,
    )
    const message = this.#db.prepare(`SELECT * FROM messages WHERE id=?`).get(inserted.lastInsertRowid)
    return [{ board_id: boardId, type: 'message', data: message }]
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
  `)
}

export function ensureLocalOrgBoard(
  db: Database.Database,
  orgId: string,
  projectPath: string,
): number {
  installLocalBoardSyncSchema(db)
  return db.transaction(() => {
    const mapped = db.prepare(`SELECT board.id FROM org_sync_boards mapping
      JOIN boards board ON board.id=mapping.local_board_id
      WHERE mapping.org_id=?`).get(orgId) as { id: number } | undefined
    if (mapped) return mapped.id

    const existing = db.prepare('SELECT id FROM boards WHERE project_path=?')
      .get(projectPath) as { id: number } | undefined
    const boardId = existing?.id ?? Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES (?, ?)`).run(projectPath, `Organization ${orgId}`).lastInsertRowid)
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
    || (card.owner_agent !== null && typeof card.owner_agent !== 'string')) {
    throw new Error('hub sent an invalid card event')
  }
  return card as HubCard
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

const localColumn = (column: string): string => {
  if (column === 'todo') return 'backlog'
  return new Set(['backlog', 'in_progress', 'blocked', 'review', 'done']).has(column) ? column : 'backlog'
}

const localAgentStatus = (state: string | undefined): string => state === 'working' ? 'active' : 'idle'
const stringOrNull = (value: unknown): string | null => typeof value === 'string' && value ? value : null

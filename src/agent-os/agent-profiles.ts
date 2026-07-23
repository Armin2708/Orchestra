import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { parseJson, timestamp } from './json.js'
import {
  accessProfile,
  actorIdentity,
  boundedString,
  canonicalHash,
  commandReplay,
  optionalBoundedString,
  providerIdentifier,
  stringList,
  type ActorIdentity,
  type AgentHomeAccessProfile,
} from './agent-home-support.js'

export interface AgentProfile {
  id: string
  board_id: number
  legacy_agent_id: number | null
  name: string
  role: string | null
  default_provider: string | null
  default_model: string | null
  default_effort: string | null
  default_access_profile: AgentHomeAccessProfile | null
  capabilities: string[]
  owner_actor_type: string
  owner_actor_id: string | null
  status: 'active' | 'archived'
  provenance: Record<string, unknown>
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface CreateAgentProfile {
  boardId: number
  name: string
  role?: string | null
  defaultProvider?: string | null
  defaultModel?: string | null
  defaultEffort?: string | null
  defaultAccessProfile?: AgentHomeAccessProfile | null
  capabilities?: string[]
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface UpdateAgentProfile {
  name?: string
  role?: string | null
  defaultProvider?: string | null
  defaultModel?: string | null
  defaultEffort?: string | null
  defaultAccessProfile?: AgentHomeAccessProfile | null
  capabilities?: string[]
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export class AgentProfileService {
  private readonly events: EventStore

  constructor(private readonly db: Database.Database, events = new EventStore(db)) {
    this.events = events
  }

  create(input: CreateAgentProfile): AgentProfile {
    const boardId = this.requireBoard(input.boardId)
    const actor = actorIdentity(input.actor)
    const normalized = {
      name: boundedString(input.name, 'name', 120),
      role: optionalBoundedString(input.role, 'role', 120),
      default_provider: providerIdentifier(input.defaultProvider, 'default provider'),
      default_model: optionalBoundedString(input.defaultModel, 'default model', 200),
      default_effort: optionalBoundedString(input.defaultEffort, 'default effort', 64),
      default_access_profile: accessProfile(input.defaultAccessProfile, 'default access profile'),
      capabilities: this.capabilities(input.capabilities),
    }
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const requestFingerprint = canonicalHash({ command: 'agent_profile.create', boardId, ...normalized })
    const replay = commandReplay(this.db, {
      boardId,
      idempotencyKey,
      kind: 'agent_profile.created',
      requestFingerprint,
    })
    if (replay) return this.replayedProfile(replay)

    const create = this.db.transaction(() => {
      const raced = commandReplay(this.db, {
        boardId,
        idempotencyKey,
        kind: 'agent_profile.created',
        requestFingerprint,
      })
      if (raced) return this.replayedProfile(raced)
      if (this.db.prepare('SELECT 1 FROM agent_profiles WHERE board_id=? AND name=?')
        .get(boardId, normalized.name)) {
        throw new ConflictError(`agent profile ${normalized.name} already exists on this board`)
      }

      const id = randomUUID()
      const conversationId = randomUUID()
      const at = timestamp()
      this.db.prepare(`INSERT INTO agent_profiles (
        id, board_id, legacy_agent_id, name, role, default_provider, default_model,
        default_effort, default_access_profile, capabilities_json, owner_actor_type,
        owner_actor_id, status, provenance_json, created_at, updated_at, archived_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '{}', ?, ?, NULL)`)
        .run(
          id,
          boardId,
          normalized.name,
          normalized.role,
          normalized.default_provider,
          normalized.default_model,
          normalized.default_effort,
          normalized.default_access_profile,
          JSON.stringify(normalized.capabilities),
          actor.type,
          actor.id,
          at,
          at,
        )
      this.db.prepare(`INSERT INTO agent_conversations (
        id, board_id, profile_id, title, status, is_default, next_sequence,
        created_by_actor_type, created_by_actor_id, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, 'active', 1, 1, ?, ?, ?, ?, NULL)`)
        .run(conversationId, boardId, id, `${normalized.name} conversation`, actor.type, actor.id, at, at)
      this.events.append({
        boardId,
        correlationId: input.correlationId ?? idempotencyKey,
        idempotencyKey,
        kind: 'agent_profile.created',
        source: 'agent-home',
        payload: {
          profile_id: id,
          default_conversation_id: conversationId,
          actor,
          request_fingerprint: requestFingerprint,
        },
      })
      return this.require(id)
    })
    return create.immediate()
  }

  get(id: string): AgentProfile | null {
    const profileId = boundedString(id, 'profile id', 200)
    const row = this.db.prepare('SELECT * FROM agent_profiles WHERE id=?')
      .get(profileId) as Record<string, unknown> | undefined
    return row ? mapAgentProfile(row) : null
  }

  require(id: string): AgentProfile {
    const profile = this.get(id)
    if (!profile) throw new NotFoundError('agent profile not found')
    return profile
  }

  listBoard(boardId: number, includeArchived = false): AgentProfile[] {
    this.requireBoard(boardId)
    const rows = this.db.prepare(`SELECT * FROM agent_profiles
      WHERE board_id=? ${includeArchived ? '' : "AND status='active'"}
      ORDER BY status, name, created_at`).all(boardId) as Record<string, unknown>[]
    return rows.map(mapAgentProfile)
  }

  update(id: string, input: UpdateAgentProfile): AgentProfile {
    const current = this.require(id)
    const actor = actorIdentity(input.actor)
    const patch: Record<string, unknown> = {}
    if (input.name !== undefined) patch.name = boundedString(input.name, 'name', 120)
    if (input.role !== undefined) patch.role = optionalBoundedString(input.role, 'role', 120)
    if (input.defaultProvider !== undefined) {
      patch.default_provider = providerIdentifier(input.defaultProvider, 'default provider')
    }
    if (input.defaultModel !== undefined) {
      patch.default_model = optionalBoundedString(input.defaultModel, 'default model', 200)
    }
    if (input.defaultEffort !== undefined) {
      patch.default_effort = optionalBoundedString(input.defaultEffort, 'default effort', 64)
    }
    if (input.defaultAccessProfile !== undefined) {
      patch.default_access_profile = accessProfile(input.defaultAccessProfile, 'default access profile')
    }
    if (input.capabilities !== undefined) patch.capabilities = this.capabilities(input.capabilities)
    if (!Object.keys(patch).length) throw new ValidationError('at least one agent profile field is required')

    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const requestFingerprint = canonicalHash({ command: 'agent_profile.update', profileId: current.id, patch })
    const replay = commandReplay(this.db, {
      boardId: current.board_id,
      idempotencyKey,
      kind: 'agent_profile.updated',
      requestFingerprint,
    })
    if (replay) return this.replayedProfile(replay)
    if (current.status === 'archived') throw new ConflictError('archived agent profiles cannot be updated')

    const update = this.db.transaction(() => {
      const latest = this.require(current.id)
      const raced = commandReplay(this.db, {
        boardId: latest.board_id,
        idempotencyKey,
        kind: 'agent_profile.updated',
        requestFingerprint,
      })
      if (raced) return this.replayedProfile(raced)
      if (latest.status === 'archived') throw new ConflictError('archived agent profiles cannot be updated')
      const nextName = String(patch.name ?? latest.name)
      const collision = this.db.prepare('SELECT id FROM agent_profiles WHERE board_id=? AND name=? AND id!=?')
        .get(latest.board_id, nextName, latest.id)
      if (collision) throw new ConflictError(`agent profile ${nextName} already exists on this board`)

      const at = timestamp()
      this.db.prepare(`UPDATE agent_profiles SET
        name=?, role=?, default_provider=?, default_model=?, default_effort=?,
        default_access_profile=?, capabilities_json=?, updated_at=?
        WHERE id=?`).run(
        nextName,
        Object.prototype.hasOwnProperty.call(patch, 'role') ? patch.role : latest.role,
        Object.prototype.hasOwnProperty.call(patch, 'default_provider')
          ? patch.default_provider : latest.default_provider,
        Object.prototype.hasOwnProperty.call(patch, 'default_model')
          ? patch.default_model : latest.default_model,
        Object.prototype.hasOwnProperty.call(patch, 'default_effort')
          ? patch.default_effort : latest.default_effort,
        Object.prototype.hasOwnProperty.call(patch, 'default_access_profile')
          ? patch.default_access_profile : latest.default_access_profile,
        JSON.stringify(patch.capabilities ?? latest.capabilities),
        at,
        latest.id,
      )
      if (patch.name !== undefined) {
        this.db.prepare(`UPDATE agent_conversations SET title=?, updated_at=?
          WHERE profile_id=? AND is_default=1 AND status='active' AND title=?`)
          .run(`${nextName} conversation`, at, latest.id, `${latest.name} conversation`)
      }
      this.events.append({
        boardId: latest.board_id,
        correlationId: input.correlationId ?? idempotencyKey,
        idempotencyKey,
        kind: 'agent_profile.updated',
        source: 'agent-home',
        payload: {
          profile_id: latest.id,
          changed_fields: Object.keys(patch).sort(),
          actor,
          request_fingerprint: requestFingerprint,
        },
      })
      return this.require(latest.id)
    })
    return update.immediate()
  }

  archive(
    id: string,
    input: { actor: ActorIdentity; idempotencyKey: string; correlationId?: string | null },
  ): AgentProfile {
    const current = this.require(id)
    const actor = actorIdentity(input.actor)
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const requestFingerprint = canonicalHash({ command: 'agent_profile.archive', profileId: current.id })
    const replay = commandReplay(this.db, {
      boardId: current.board_id,
      idempotencyKey,
      kind: 'agent_profile.archived',
      requestFingerprint,
    })
    if (replay) return this.replayedProfile(replay)

    const archive = this.db.transaction(() => {
      const latest = this.require(current.id)
      const raced = commandReplay(this.db, {
        boardId: latest.board_id,
        idempotencyKey,
        kind: 'agent_profile.archived',
        requestFingerprint,
      })
      if (raced) return this.replayedProfile(raced)
      const active = this.db.prepare(`SELECT id FROM agent_sessions
        WHERE profile_id=? AND status IN ('reserved','starting','running','idle','stopping')
        LIMIT 1`).get(latest.id)
      if (active) throw new ConflictError('agent profile has an active session')

      const at = timestamp()
      this.db.prepare(`UPDATE agent_profiles
        SET status='archived', archived_at=coalesce(archived_at, ?), updated_at=?
        WHERE id=?`).run(at, at, latest.id)
      this.db.prepare(`UPDATE agent_conversations
        SET status='archived', archived_at=coalesce(archived_at, ?), updated_at=?
        WHERE profile_id=? AND status='active'`).run(at, at, latest.id)
      this.events.append({
        boardId: latest.board_id,
        correlationId: input.correlationId ?? idempotencyKey,
        idempotencyKey,
        kind: 'agent_profile.archived',
        source: 'agent-home',
        payload: {
          profile_id: latest.id,
          actor,
          request_fingerprint: requestFingerprint,
        },
      })
      return this.require(latest.id)
    })
    return archive.immediate()
  }

  private requireBoard(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ValidationError('board id must be positive')
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(value)) throw new NotFoundError('board not found')
    return value
  }

  private capabilities(value: unknown): string[] {
    return stringList(value, 'capabilities').map((capability) =>
      boundedString(capability, 'capability', 120))
  }

  private replayedProfile(payload: Record<string, unknown>): AgentProfile {
    if (typeof payload.profile_id !== 'string') {
      throw new ConflictError('Agent Home replay event does not reference an agent profile')
    }
    return this.require(payload.profile_id)
  }
}

export function mapAgentProfile(row: Record<string, unknown>): AgentProfile {
  return {
    id: String(row.id),
    board_id: Number(row.board_id),
    legacy_agent_id: row.legacy_agent_id == null ? null : Number(row.legacy_agent_id),
    name: String(row.name),
    role: row.role == null ? null : String(row.role),
    default_provider: row.default_provider == null ? null : String(row.default_provider),
    default_model: row.default_model == null ? null : String(row.default_model),
    default_effort: row.default_effort == null ? null : String(row.default_effort),
    default_access_profile: row.default_access_profile == null
      ? null : String(row.default_access_profile) as AgentHomeAccessProfile,
    capabilities: parseJson<string[]>(row.capabilities_json, []),
    owner_actor_type: String(row.owner_actor_type),
    owner_actor_id: row.owner_actor_id == null ? null : String(row.owner_actor_id),
    status: String(row.status) as AgentProfile['status'],
    provenance: parseJson<Record<string, unknown>>(row.provenance_json, {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    archived_at: row.archived_at == null ? null : String(row.archived_at),
  }
}

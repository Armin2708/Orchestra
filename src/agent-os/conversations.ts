import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { parseJson, timestamp } from './json.js'
import { AgentProfileService, type AgentProfile } from './agent-profiles.js'
import {
  accessProfile,
  actorIdentity,
  boundedString,
  canonicalHash,
  commandReplay,
  historyState,
  jsonRecord,
  optionalBoundedString,
  providerIdentifier,
  recoveryState,
  sessionMode,
  stableJson,
  type ActorIdentity,
  type AgentHomeAccessProfile,
  type AgentSessionHistoryState,
  type AgentSessionMode,
  type AgentSessionRecoveryState,
} from './agent-home-support.js'
import { normalizeProjectedText } from './projected-text-redaction.js'
import {
  durableSessionEventScope,
  type DurableSessionEventScope,
} from './agent-home-event-scope.js'

export const CONVERSATION_EVENT_KINDS = [
  'user',
  'assistant',
  'system',
  'tool',
  'tool_result',
  'approval',
  'usage',
  'status',
  'error',
] as const
export type ConversationEventKind = (typeof CONVERSATION_EVENT_KINDS)[number]

const REDACTION_STATES = ['none', 'redacted', 'withheld'] as const
type RedactionState = (typeof REDACTION_STATES)[number]
const RETENTION_CLASSES = ['transcript', 'audit', 'ephemeral', 'pinned'] as const
type RetentionClass = (typeof RETENTION_CLASSES)[number]
const ACTIVE_SESSION_STATUSES = ['reserved', 'starting', 'running', 'idle', 'stopping'] as const

export interface AgentConversation {
  id: string
  board_id: number
  profile_id: string
  title: string
  status: 'active' | 'archived'
  is_default: boolean
  next_sequence: number
  created_by_actor_type: string
  created_by_actor_id: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface AgentSessionRecord {
  id: string
  workspace_id: string
  agent_id: number | null
  provider: string
  external_id: string | null
  model: string | null
  status: string
  context: Record<string, unknown>
  profile_id: string | null
  conversation_id: string | null
  job_id: string | null
  mode: AgentSessionMode
  driver_id: string | null
  effort: string | null
  access_profile: AgentHomeAccessProfile | null
  provider_thread_id: string | null
  provider_cursor: string | null
  recovery_state: AgentSessionRecoveryState
  recovery: Record<string, unknown>
  history_state: AgentSessionHistoryState
  display_name: string | null
  parent_session_id: string | null
  lineage_type: 'resume' | 'retry' | 'fork' | null
  control_state: 'active' | 'paused' | 'stopped' | 'archived'
  started_at: string | null
  ended_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface ConversationEvent {
  id: string
  board_id: number
  profile_id: string
  conversation_id: string
  session_id: string | null
  sequence: number
  provider: string | null
  provider_event_id: string | null
  provider_thread_id: string | null
  provider_turn_id: string | null
  provider_item_id: string | null
  provider_cursor: string | null
  kind: ConversationEventKind
  actor_type: string
  actor_id: string | null
  correlation_id: string | null
  causation_id: string | null
  projected_text: string | null
  metadata: Record<string, unknown>
  raw_artifact_id: string | null
  dedupe_key: string
  content_hash: string
  redaction_state: RedactionState
  retention_class: RetentionClass
  schema_version: number
  created_at: string
  archived_at: string | null
}

export interface CreateConversation {
  title?: string | null
  isDefault?: boolean
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface UpdateConversation {
  title: string
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface LinkAgentSession {
  profileId: string
  conversationId: string
  jobId?: string | null
  mode: AgentSessionMode
  driverId?: string | null
  effort?: string | null
  accessProfile?: AgentHomeAccessProfile | null
  providerThreadId?: string | null
  providerCursor?: string | null
  recoveryState?: AgentSessionRecoveryState
  recovery?: Record<string, unknown>
  historyState?: AgentSessionHistoryState
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface AppendConversationEvent {
  idempotencyKey: string
  dedupeKey: string
  kind: ConversationEventKind
  provider?: string | null
  providerEventId?: string | null
  providerThreadId?: string | null
  providerTurnId?: string | null
  providerItemId?: string | null
  providerCursor?: string | null
  projectedText?: string | null
  metadata?: Record<string, unknown>
  rawArtifactId?: string | null
  actor: ActorIdentity
  correlationId?: string | null
  causationId?: string | null
  redactionState?: RedactionState
  retentionClass?: RetentionClass
  schemaVersion?: number
}

export interface AppendConversationEventResult {
  event: ConversationEvent
  replayed: boolean
}

export interface AgentHomeSnapshot {
  profile: AgentProfile
  conversations: AgentConversation[]
  sessions: AgentSessionRecord[]
  active_session: AgentSessionRecord | null
  active_scope: {
    workspace: Record<string, unknown> | null
    job: Record<string, unknown> | null
    processes: Record<string, unknown>[]
    attention: Record<string, unknown>[]
  }
}

export class ConversationService {
  private readonly events: EventStore
  private readonly profiles: AgentProfileService

  constructor(private readonly db: Database.Database, events = new EventStore(db)) {
    this.events = events
    this.profiles = new AgentProfileService(db, events)
  }

  createConversation(profileId: string, input: CreateConversation): AgentConversation {
    const profile = this.profiles.require(profileId)
    const actor = actorIdentity(input.actor)
    const normalized = {
      title: optionalBoundedString(input.title, 'title', 200) ?? `${profile.name} conversation`,
      is_default: input.isDefault === true,
    }
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const requestFingerprint = canonicalHash({
      command: 'agent_conversation.create',
      profileId: profile.id,
      ...normalized,
    })
    const replay = commandReplay(this.db, {
      boardId: profile.board_id,
      idempotencyKey,
      kind: 'agent_conversation.created',
      requestFingerprint,
    })
    if (replay) return this.replayedConversation(replay)
    if (profile.status !== 'active') throw new ConflictError('archived agent profiles cannot create conversations')

    const create = this.db.transaction(() => {
      const latest = this.profiles.require(profile.id)
      const raced = commandReplay(this.db, {
        boardId: latest.board_id,
        idempotencyKey,
        kind: 'agent_conversation.created',
        requestFingerprint,
      })
      if (raced) return this.replayedConversation(raced)
      if (latest.status !== 'active') {
        throw new ConflictError('archived agent profiles cannot create conversations')
      }
      if (normalized.is_default && this.db.prepare(
        "SELECT 1 FROM agent_conversations WHERE profile_id=? AND is_default=1 AND status='active'",
      ).get(latest.id)) {
        throw new ConflictError('agent profile already has an active default conversation')
      }

      const id = randomUUID()
      const at = timestamp()
      this.db.prepare(`INSERT INTO agent_conversations (
        id, board_id, profile_id, title, status, is_default, next_sequence,
        created_by_actor_type, created_by_actor_id, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, 'active', ?, 1, ?, ?, ?, ?, NULL)`)
        .run(
          id,
          latest.board_id,
          latest.id,
          normalized.title,
          normalized.is_default ? 1 : 0,
          actor.type,
          actor.id,
          at,
          at,
        )
      this.events.append({
        boardId: latest.board_id,
        correlationId: input.correlationId ?? idempotencyKey,
        idempotencyKey,
        kind: 'agent_conversation.created',
        source: 'agent-home',
        payload: {
          profile_id: latest.id,
          conversation_id: id,
          actor,
          request_fingerprint: requestFingerprint,
        },
      })
      return this.requireConversation(id)
    })
    return create.immediate()
  }

  getConversation(id: string): AgentConversation | null {
    const conversationId = boundedString(id, 'conversation id', 200)
    const row = this.db.prepare('SELECT * FROM agent_conversations WHERE id=?')
      .get(conversationId) as Record<string, unknown> | undefined
    return row ? mapConversation(row) : null
  }

  requireConversation(id: string): AgentConversation {
    const conversation = this.getConversation(id)
    if (!conversation) throw new NotFoundError('agent conversation not found')
    return conversation
  }

  listConversations(profileId: string, includeArchived = false): AgentConversation[] {
    this.profiles.require(profileId)
    const rows = this.db.prepare(`SELECT * FROM agent_conversations
      WHERE profile_id=? ${includeArchived ? '' : "AND status='active'"}
      ORDER BY status, is_default DESC, updated_at DESC, rowid DESC`)
      .all(profileId) as Record<string, unknown>[]
    return rows.map(mapConversation)
  }

  updateConversation(id: string, input: UpdateConversation): AgentConversation {
    const current = this.requireConversation(id)
    const actor = actorIdentity(input.actor)
    const title = boundedString(input.title, 'title', 200)
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const requestFingerprint = canonicalHash({
      command: 'agent_conversation.update',
      conversationId: current.id,
      title,
    })
    const replay = commandReplay(this.db, {
      boardId: current.board_id,
      idempotencyKey,
      kind: 'agent_conversation.updated',
      requestFingerprint,
    })
    if (replay) return this.replayedConversation(replay)
    if (current.status !== 'active') throw new ConflictError('archived conversations cannot be updated')

    const update = this.db.transaction(() => {
      const latest = this.requireConversation(current.id)
      const raced = commandReplay(this.db, {
        boardId: latest.board_id,
        idempotencyKey,
        kind: 'agent_conversation.updated',
        requestFingerprint,
      })
      if (raced) return this.replayedConversation(raced)
      if (latest.status !== 'active') throw new ConflictError('archived conversations cannot be updated')
      const at = timestamp()
      this.db.prepare('UPDATE agent_conversations SET title=?, updated_at=? WHERE id=?')
        .run(title, at, latest.id)
      this.events.append({
        boardId: latest.board_id,
        correlationId: input.correlationId ?? idempotencyKey,
        idempotencyKey,
        kind: 'agent_conversation.updated',
        source: 'agent-home',
        payload: {
          profile_id: latest.profile_id,
          conversation_id: latest.id,
          actor,
          request_fingerprint: requestFingerprint,
        },
      })
      return this.requireConversation(latest.id)
    })
    return update.immediate()
  }

  archiveConversation(
    id: string,
    input: { actor: ActorIdentity; idempotencyKey: string; correlationId?: string | null },
  ): AgentConversation {
    const current = this.requireConversation(id)
    const actor = actorIdentity(input.actor)
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const requestFingerprint = canonicalHash({
      command: 'agent_conversation.archive',
      conversationId: current.id,
    })
    const replay = commandReplay(this.db, {
      boardId: current.board_id,
      idempotencyKey,
      kind: 'agent_conversation.archived',
      requestFingerprint,
    })
    if (replay) return this.replayedConversation(replay)

    const archive = this.db.transaction(() => {
      const latest = this.requireConversation(current.id)
      const raced = commandReplay(this.db, {
        boardId: latest.board_id,
        idempotencyKey,
        kind: 'agent_conversation.archived',
        requestFingerprint,
      })
      if (raced) return this.replayedConversation(raced)
      if (latest.status === 'active' && latest.is_default
        && this.profiles.require(latest.profile_id).status === 'active') {
        throw new ConflictError('the active default conversation cannot be archived')
      }
      const active = this.db.prepare(`SELECT 1 FROM agent_sessions
        WHERE conversation_id=? AND status IN ('reserved','starting','running','idle','stopping')
        LIMIT 1`).get(latest.id)
      if (active) throw new ConflictError('agent conversation has an active session')

      const at = timestamp()
      this.db.prepare(`UPDATE agent_conversations
        SET status='archived', archived_at=coalesce(archived_at, ?), updated_at=?
        WHERE id=?`).run(at, at, latest.id)
      this.events.append({
        boardId: latest.board_id,
        correlationId: input.correlationId ?? idempotencyKey,
        idempotencyKey,
        kind: 'agent_conversation.archived',
        source: 'agent-home',
        payload: {
          profile_id: latest.profile_id,
          conversation_id: latest.id,
          actor,
          request_fingerprint: requestFingerprint,
        },
      })
      return this.requireConversation(latest.id)
    })
    return archive.immediate()
  }

  getSession(id: string): AgentSessionRecord | null {
    const sessionId = boundedString(id, 'session id', 200)
    const row = this.db.prepare('SELECT * FROM agent_sessions WHERE id=?')
      .get(sessionId) as Record<string, unknown> | undefined
    return row ? mapAgentSession(row) : null
  }

  requireSession(id: string): AgentSessionRecord {
    const session = this.getSession(id)
    if (!session) throw new NotFoundError('agent session not found')
    return session
  }

  listSessions(profileId: string): AgentSessionRecord[] {
    this.profiles.require(profileId)
    const rows = this.db.prepare(`SELECT * FROM agent_sessions
      WHERE profile_id=?
      ORDER BY CASE WHEN status IN ('reserved','starting','running','idle','stopping')
        THEN 0 ELSE 1 END, updated_at DESC, rowid DESC`).all(profileId) as Record<string, unknown>[]
    return rows.map(mapAgentSession)
  }

  linkSession(sessionId: string, input: LinkAgentSession): AgentSessionRecord {
    const current = this.requireSession(sessionId)
    const scope = this.sessionScope(current)
    const profile = this.profiles.require(input.profileId)
    const conversation = this.requireConversation(input.conversationId)
    if (profile.board_id !== scope.board_id || conversation.board_id !== scope.board_id
      || conversation.profile_id !== profile.id) {
      throw new ValidationError('session, profile, conversation, and workspace must share one board scope')
    }
    if (current.profile_id && current.profile_id !== profile.id) {
      throw new ConflictError('agent session is already linked to another profile')
    }
    if (current.conversation_id && current.conversation_id !== conversation.id) {
      throw new ConflictError('agent session is already linked to another conversation')
    }

    const actor = actorIdentity(input.actor)
    const requested = {
      profile_id: profile.id,
      conversation_id: conversation.id,
      job_id: input.jobId === undefined
        ? undefined : optionalBoundedString(input.jobId, 'job id', 200),
      mode: sessionMode(input.mode),
      driver_id: input.driverId === undefined
        ? undefined : optionalBoundedString(input.driverId, 'driver id', 120),
      effort: input.effort === undefined
        ? undefined : optionalBoundedString(input.effort, 'effort', 64),
      access_profile: input.accessProfile === undefined
        ? undefined : accessProfile(input.accessProfile, 'access profile'),
      provider_thread_id: input.providerThreadId === undefined
        ? undefined
        : optionalBoundedString(input.providerThreadId, 'provider thread id', 512),
      provider_cursor: input.providerCursor === undefined
        ? undefined : optionalBoundedString(input.providerCursor, 'provider cursor', 2_000),
      recovery_state: input.recoveryState === undefined
        ? undefined : recoveryState(input.recoveryState),
      recovery: input.recovery === undefined ? undefined : jsonRecord(input.recovery, 'recovery'),
      history_state: input.historyState === undefined
        ? undefined : historyState(input.historyState),
    }
    const valuesFor = (
      session: AgentSessionRecord,
      eventScope: DurableSessionEventScope,
    ) => ({
      profile_id: requested.profile_id,
      conversation_id: requested.conversation_id,
      job_id: eventScope.jobId,
      mode: requested.mode,
      driver_id: requested.driver_id === undefined ? session.driver_id : requested.driver_id,
      effort: requested.effort === undefined ? session.effort : requested.effort,
      access_profile: requested.access_profile === undefined
        ? session.access_profile : requested.access_profile,
      provider_thread_id: requested.provider_thread_id === undefined
        ? session.provider_thread_id ?? session.external_id : requested.provider_thread_id,
      provider_cursor: requested.provider_cursor === undefined
        ? session.provider_cursor : requested.provider_cursor,
      recovery_state: requested.recovery_state === undefined
        ? session.recovery_state : requested.recovery_state,
      recovery: requested.recovery === undefined ? session.recovery : requested.recovery,
      history_state: requested.history_state === undefined
        ? session.history_state : requested.history_state,
    })
    const currentEventScope = durableSessionEventScope(this.db, current, {
      expectedBoardId: profile.board_id,
      expectedWorkspaceId: current.workspace_id,
      requestedJobId: requested.job_id,
    })
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const requestFingerprint = canonicalHash({
      command: 'agent_session.link',
      sessionId: current.id,
      ...requested,
    })
    const replayFor = (eventScope: DurableSessionEventScope): AgentSessionRecord | null => {
      const replay = commandReplay(this.db, {
        boardId: eventScope.boardId,
        idempotencyKey,
        kind: 'agent_session.linked',
        requestFingerprint,
      })
      if (!replay) {
        const displaced = this.db.prepare(`SELECT 1 FROM os_events
          WHERE board_id!=? AND session_id=? AND idempotency_key=? LIMIT 1`)
          .get(eventScope.boardId, current.id, idempotencyKey)
        if (displaced) {
          throw new ConflictError('agent session link replay scope is inconsistent')
        }
        return null
      }
      const expectedPayload = {
        profile_id: profile.id,
        conversation_id: conversation.id,
        session_id: current.id,
        actor,
        request_fingerprint: requestFingerprint,
      }
      if (canonicalHash(replay) !== canonicalHash(expectedPayload)) {
        throw new ConflictError('agent session link replay payload is inconsistent')
      }
      const event = this.db.prepare(`SELECT source, workspace_id, card_id, session_id,
        process_id, job_id, contract_id, correlation_id, causation_id, event_version
        FROM os_events WHERE board_id=? AND idempotency_key=?`)
        .get(eventScope.boardId, idempotencyKey) as {
          source: string
          workspace_id: string | null
          card_id: number | null
          session_id: string | null
          process_id: string | null
          job_id: string | null
          contract_id: string | null
          correlation_id: string | null
          causation_id: string | null
          event_version: number
        } | undefined
      const expectedCorrelationId = eventScope.correlationId
        ?? input.correlationId
        ?? idempotencyKey
      if (!event
        || event.source !== 'agent-home'
        || event.workspace_id !== eventScope.workspaceId
        || event.card_id !== eventScope.cardId
        || event.session_id !== current.id
        || event.process_id !== null
        || event.job_id !== eventScope.jobId
        || event.contract_id !== eventScope.contractId
        || event.correlation_id !== expectedCorrelationId
        || event.causation_id !== null
        || event.event_version !== 1) {
        throw new ConflictError('agent session link replay scope is inconsistent')
      }
      return this.replayedSession(replay)
    }
    const replay = replayFor(currentEventScope)
    if (replay) return replay
    if (profile.status !== 'active') throw new ConflictError('archived agent profiles cannot link sessions')
    if (conversation.status !== 'active') throw new ConflictError('archived conversations cannot link sessions')

    const link = this.db.transaction(() => {
      const latest = this.requireSession(current.id)
      const latestScope = this.sessionScope(latest)
      const eventScope = durableSessionEventScope(this.db, latest, {
        expectedBoardId: profile.board_id,
        expectedWorkspaceId: latest.workspace_id,
        requestedJobId: requested.job_id,
      })
      const raced = replayFor(eventScope)
      if (raced) return raced
      if (this.profiles.require(profile.id).status !== 'active') {
        throw new ConflictError('archived agent profiles cannot link sessions')
      }
      if (this.requireConversation(conversation.id).status !== 'active') {
        throw new ConflictError('archived conversations cannot link sessions')
      }
      if (latestScope.board_id !== profile.board_id) {
        throw new ValidationError('session workspace moved to a different board')
      }
      if (latest.profile_id && latest.profile_id !== profile.id) {
        throw new ConflictError('agent session is already linked to another profile')
      }
      if (latest.conversation_id && latest.conversation_id !== conversation.id) {
        throw new ConflictError('agent session is already linked to another conversation')
      }
      const values = valuesFor(latest, eventScope)

      const at = timestamp()
      const terminal = ['stopped', 'failed', 'lost', 'exited'].includes(latest.status)
      this.db.prepare(`UPDATE agent_sessions SET
        profile_id=?, conversation_id=?, job_id=?, mode=?, driver_id=?, effort=?,
        access_profile=?, provider_thread_id=?, provider_cursor=?, recovery_state=?,
        recovery_json=?, history_state=?, started_at=coalesce(started_at, created_at),
        ended_at=CASE WHEN ? THEN coalesce(ended_at, updated_at) ELSE ended_at END,
        updated_at=?
        WHERE id=?`).run(
        values.profile_id,
        values.conversation_id,
        values.job_id,
        values.mode,
        values.driver_id,
        values.effort,
        values.access_profile,
        values.provider_thread_id,
        values.provider_cursor,
        values.recovery_state,
        stableJson(values.recovery),
        values.history_state,
        terminal ? 1 : 0,
        at,
        latest.id,
      )
      this.events.append({
        boardId: eventScope.boardId,
        workspaceId: eventScope.workspaceId,
        cardId: eventScope.cardId,
        sessionId: latest.id,
        jobId: eventScope.jobId,
        contractId: eventScope.contractId,
        correlationId: eventScope.correlationId ?? input.correlationId ?? idempotencyKey,
        idempotencyKey,
        kind: 'agent_session.linked',
        source: 'agent-home',
        payload: {
          profile_id: profile.id,
          conversation_id: conversation.id,
          session_id: latest.id,
          actor,
          request_fingerprint: requestFingerprint,
        },
      })
      return this.requireSession(latest.id)
    })
    return link.immediate()
  }

  appendEvent(sessionId: string, input: AppendConversationEvent): AppendConversationEventResult {
    const session = this.requireSession(sessionId)
    if (!session.profile_id || !session.conversation_id) {
      throw new ConflictError('agent session must be linked before conversation events can be appended')
    }
    const profile = this.profiles.require(session.profile_id)
    const conversation = this.requireConversation(session.conversation_id)
    const scope = this.sessionScope(session)
    if (scope.board_id !== profile.board_id || conversation.board_id !== profile.board_id
      || conversation.profile_id !== profile.id) {
      throw new ConflictError('agent session has an inconsistent Agent Home scope')
    }

    const actor = actorIdentity(input.actor)
    const provider = providerIdentifier(input.provider ?? session.provider, 'provider')
    if (provider !== session.provider) throw new ValidationError('event provider must match the agent session provider')
    const requestedProviderThreadId = optionalBoundedString(
      input.providerThreadId,
      'provider thread id',
      512,
    )
    const projectedText = normalizeProjectedText(
      optionalProjectedText(input.projectedText),
      redactionState(input.redactionState),
    )
    const normalized = {
      provider,
      provider_event_id: optionalBoundedString(input.providerEventId, 'provider event id', 512),
      provider_thread_id: requestedProviderThreadId ?? session.provider_thread_id,
      provider_turn_id: optionalBoundedString(input.providerTurnId, 'provider turn id', 512),
      provider_item_id: optionalBoundedString(input.providerItemId, 'provider item id', 512),
      provider_cursor: optionalBoundedString(input.providerCursor, 'provider cursor', 2_000),
      kind: conversationEventKind(input.kind),
      actor,
      correlation_id: optionalBoundedString(input.correlationId, 'correlation id', 512),
      causation_id: optionalBoundedString(input.causationId, 'causation id', 512),
      projected_text: projectedText.value,
      metadata: jsonRecord(input.metadata, 'metadata'),
      raw_artifact_id: optionalBoundedString(input.rawArtifactId, 'raw artifact id', 200),
      dedupe_key: boundedString(input.dedupeKey, 'dedupe key', 512),
      redaction_state: projectedText.redactionState,
      retention_class: retentionClass(input.retentionClass),
      schema_version: positiveInteger(input.schemaVersion ?? 1, 'schema version'),
    }
    this.validateArtifactScope(normalized.raw_artifact_id, scope.board_id, session.workspace_id)
    const contentHash = canonicalHash({
      ...normalized,
      provider_thread_id: requestedProviderThreadId,
    })
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)

    const append = this.db.transaction((): AppendConversationEventResult | { conflictId: string } => {
      const latest = this.requireSession(session.id)
      if (latest.profile_id !== profile.id || latest.conversation_id !== conversation.id) {
        throw new ConflictError('agent session Agent Home scope changed during event append')
      }
      const latestConversation = this.requireConversation(conversation.id)
      const eventScope = durableSessionEventScope(this.db, latest, {
        expectedBoardId: profile.board_id,
        expectedWorkspaceId: latest.workspace_id,
      })
      const existing = this.db.prepare(
        'SELECT * FROM conversation_events WHERE conversation_id=? AND dedupe_key=?',
      ).get(conversation.id, normalized.dedupe_key) as Record<string, unknown> | undefined
      if (existing) {
        const canonical = mapConversationEvent(existing)
        if (canonical.content_hash !== contentHash) {
          return {
            conflictId: this.retainEventConflict({
              canonical,
              session: latest,
              contentHash,
              projectedText: normalized.projected_text,
              metadata: normalized.metadata,
              rawArtifactId: normalized.raw_artifact_id,
              actor,
              eventScope,
            }),
          }
        }
        const replay = this.replayEventCommand({
          eventScope,
          idempotencyKey,
          contentHash,
          sessionId: latest.id,
          dedupeKey: normalized.dedupe_key,
          correlationId: normalized.correlation_id,
          causationId: normalized.causation_id,
        })
        if (replay && replay.id !== canonical.id) {
          throw new ConflictError(
            'idempotency key was already used for a different conversation event',
          )
        }
        if (!replay) {
          this.events.append({
            boardId: eventScope.boardId,
            workspaceId: eventScope.workspaceId,
            cardId: eventScope.cardId,
            sessionId: latest.id,
            jobId: eventScope.jobId,
            contractId: eventScope.contractId,
            correlationId: eventScope.correlationId
              ?? normalized.correlation_id
              ?? `conversation-replay:${canonical.id}`,
            causationId: normalized.causation_id,
            idempotencyKey,
            kind: 'conversation.event_replayed',
            source: 'agent-home',
            payload: {
              profile_id: profile.id,
              conversation_id: conversation.id,
              session_id: latest.id,
              conversation_event_id: canonical.id,
              replay_of_event_id: canonical.id,
              sequence: canonical.sequence,
              dedupe_key: normalized.dedupe_key,
              content_hash: contentHash,
              request_fingerprint: contentHash,
            },
          })
        }
        return { event: canonical, replayed: true }
      }
      const commandReplay = this.replayEventCommand({
        eventScope,
        idempotencyKey,
        contentHash,
        sessionId: latest.id,
        dedupeKey: normalized.dedupe_key,
        correlationId: normalized.correlation_id,
        causationId: normalized.causation_id,
      })
      if (commandReplay) return { event: commandReplay, replayed: true }
      if (latestConversation.status !== 'active') {
        throw new ConflictError('archived conversations cannot receive new events')
      }

      const id = randomUUID()
      const at = timestamp()
      this.db.prepare(`INSERT INTO conversation_events (
        id, board_id, profile_id, conversation_id, session_id, sequence,
        provider, provider_event_id, provider_thread_id, provider_turn_id,
        provider_item_id, provider_cursor, kind, actor_type, actor_id,
        correlation_id, causation_id, projected_text, metadata_json, raw_artifact_id,
        dedupe_key, content_hash, redaction_state, retention_class, schema_version,
        created_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(
          id,
          eventScope.boardId,
          profile.id,
          conversation.id,
          latest.id,
          latestConversation.next_sequence,
          normalized.provider,
          normalized.provider_event_id,
          normalized.provider_thread_id,
          normalized.provider_turn_id,
          normalized.provider_item_id,
          normalized.provider_cursor,
          normalized.kind,
          actor.type,
          actor.id,
          normalized.correlation_id,
          normalized.causation_id,
          normalized.projected_text,
          stableJson(normalized.metadata),
          normalized.raw_artifact_id,
          normalized.dedupe_key,
          contentHash,
          normalized.redaction_state,
          normalized.retention_class,
          normalized.schema_version,
          at,
        )
      this.db.prepare(`UPDATE agent_conversations
        SET next_sequence=next_sequence+1, updated_at=? WHERE id=?`)
        .run(at, conversation.id)
      if (normalized.provider_thread_id || normalized.provider_cursor) {
        this.db.prepare(`UPDATE agent_sessions SET
          provider_thread_id=coalesce(provider_thread_id, ?),
          provider_cursor=coalesce(?, provider_cursor),
          updated_at=?
          WHERE id=?`).run(
          normalized.provider_thread_id,
          normalized.provider_cursor,
          at,
          latest.id,
        )
      }
      this.events.append({
        boardId: eventScope.boardId,
        workspaceId: eventScope.workspaceId,
        cardId: eventScope.cardId,
        sessionId: latest.id,
        jobId: eventScope.jobId,
        contractId: eventScope.contractId,
        correlationId: eventScope.correlationId
          ?? normalized.correlation_id
          ?? `conversation-event:${id}`,
        causationId: normalized.causation_id,
        idempotencyKey,
        kind: 'conversation.event_appended',
        source: 'agent-home',
        payload: {
          profile_id: profile.id,
          conversation_id: conversation.id,
          session_id: latest.id,
          conversation_event_id: id,
          sequence: latestConversation.next_sequence,
          dedupe_key: normalized.dedupe_key,
          content_hash: contentHash,
          request_fingerprint: contentHash,
        },
      })
      return {
        event: this.requireEvent(id),
        replayed: false,
      }
    })

    const result = append.immediate()
    if ('conflictId' in result) {
      throw new ConflictError(
        `conversation event conflicts with an existing dedupe key (conflict ${result.conflictId})`,
      )
    }
    return result
  }

  getEvent(id: string): ConversationEvent | null {
    const eventId = boundedString(id, 'conversation event id', 200)
    const row = this.db.prepare('SELECT * FROM conversation_events WHERE id=?')
      .get(eventId) as Record<string, unknown> | undefined
    return row ? mapConversationEvent(row) : null
  }

  requireEvent(id: string): ConversationEvent {
    const event = this.getEvent(id)
    if (!event) throw new NotFoundError('conversation event not found')
    return event
  }

  listEvents(
    conversationId: string,
    filters: {
      afterSequence?: number
      limit?: number
      kinds?: ConversationEventKind[]
      sessionId?: string
    } = {},
  ): ConversationEvent[] {
    this.requireConversation(conversationId)
    const after = nonNegativeInteger(filters.afterSequence ?? 0, 'after sequence')
    const limit = boundedInteger(filters.limit ?? 100, 'limit', 1, 500)
    const where = ['conversation_id=@conversation_id', 'sequence>@after_sequence']
    const params: Record<string, unknown> = {
      conversation_id: conversationId,
      after_sequence: after,
      limit,
    }
    if (filters.sessionId) {
      const session = this.requireSession(filters.sessionId)
      if (session.conversation_id !== conversationId) {
        throw new ValidationError('session does not belong to this conversation')
      }
      where.push('session_id=@session_id')
      params.session_id = filters.sessionId
    }
    const kinds = filters.kinds?.map(conversationEventKind) ?? []
    if (kinds.length) {
      const placeholders = kinds.map((_, index) => `@kind_${index}`)
      kinds.forEach((kind, index) => { params[`kind_${index}`] = kind })
      where.push(`kind IN (${placeholders.join(',')})`)
    }
    const rows = this.db.prepare(`SELECT * FROM conversation_events
      WHERE ${where.join(' AND ')}
      ORDER BY sequence ASC LIMIT @limit`).all(params) as Record<string, unknown>[]
    return rows.map(mapConversationEvent)
  }

  listSessionEvents(
    sessionId: string,
    filters: { afterSequence?: number; limit?: number; kinds?: ConversationEventKind[] } = {},
  ): ConversationEvent[] {
    const session = this.requireSession(sessionId)
    if (!session.conversation_id) return []
    return this.listEvents(session.conversation_id, { ...filters, sessionId: session.id })
  }

  home(profileId: string): AgentHomeSnapshot {
    const profile = this.profiles.require(profileId)
    const conversations = this.listConversations(profile.id, true)
    const sessions = this.listSessions(profile.id)
    const activeSession = sessions.find((session) =>
      ACTIVE_SESSION_STATUSES.includes(session.status as (typeof ACTIVE_SESSION_STATUSES)[number])) ?? null
    const scopedSession = activeSession ?? sessions[0] ?? null
    const workspace = scopedSession
      ? (this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(
          scopedSession.workspace_id,
        ) as Record<string, unknown> | undefined)
      : undefined
    const job = scopedSession?.job_id
      ? (this.db.prepare('SELECT * FROM jobs WHERE id=?').get(
          scopedSession.job_id,
        ) as Record<string, unknown> | undefined)
      : undefined
    const processes = scopedSession
      ? this.db.prepare(`SELECT * FROM processes WHERE workspace_id=?
          ORDER BY started_at DESC, rowid DESC`).all(scopedSession.workspace_id) as Record<string, unknown>[]
      : []
    const attention = this.db.prepare(`SELECT * FROM attention_items
      WHERE board_id=? AND status='open'
        AND (workspace_id IS NULL OR workspace_id=?)
      ORDER BY created_at DESC, rowid DESC LIMIT 100`)
      .all(profile.board_id, scopedSession?.workspace_id ?? null) as Record<string, unknown>[]
    return {
      profile,
      conversations,
      sessions,
      active_session: activeSession,
      active_scope: {
        workspace: workspace ?? null,
        job: job ?? null,
        processes,
        attention,
      },
    }
  }

  private replayEventCommand(input: {
    eventScope: DurableSessionEventScope
    idempotencyKey: string
    contentHash: string
    sessionId: string
    dedupeKey: string
    correlationId: string | null
    causationId: string | null
  }): ConversationEvent | null {
    const row = this.db.prepare(`SELECT kind, source, workspace_id, card_id, session_id,
      process_id, job_id, contract_id, correlation_id, causation_id, payload
      FROM os_events WHERE board_id=? AND idempotency_key=?`)
      .get(input.eventScope.boardId, input.idempotencyKey) as {
        kind: string
        source: string
        workspace_id: string | null
        card_id: number | null
        session_id: string | null
        process_id: string | null
        job_id: string | null
        contract_id: string | null
        correlation_id: string | null
        causation_id: string | null
        payload: string
      } | undefined
    if (!row) return null
    const payload = parseJson<Record<string, unknown>>(row.payload, {})
    if (!['conversation.event_appended', 'conversation.event_replayed'].includes(row.kind)
      || payload.request_fingerprint !== input.contentHash
      || payload.session_id !== input.sessionId
      || payload.dedupe_key !== input.dedupeKey
      || typeof payload.conversation_event_id !== 'string') {
      throw new ConflictError(
        'idempotency key was already used for a different conversation event',
      )
    }
    const fallbackCorrelationId = row.kind === 'conversation.event_appended'
      ? `conversation-event:${payload.conversation_event_id}`
      : `conversation-replay:${payload.conversation_event_id}`
    const expectedCorrelationId = input.eventScope.correlationId
      ?? input.correlationId
      ?? fallbackCorrelationId
    if (row.source !== 'agent-home'
      || row.workspace_id !== input.eventScope.workspaceId
      || row.card_id !== input.eventScope.cardId
      || row.session_id !== input.sessionId
      || row.process_id !== null
      || row.job_id !== input.eventScope.jobId
      || row.contract_id !== input.eventScope.contractId
      || row.correlation_id !== expectedCorrelationId
      || row.causation_id !== input.causationId) {
      throw new ConflictError('conversation event replay scope is inconsistent')
    }
    return this.requireEvent(payload.conversation_event_id)
  }

  private replayedConversation(payload: Record<string, unknown>): AgentConversation {
    if (typeof payload.conversation_id !== 'string') {
      throw new ConflictError('Agent Home replay event does not reference a conversation')
    }
    return this.requireConversation(payload.conversation_id)
  }

  private replayedSession(payload: Record<string, unknown>): AgentSessionRecord {
    if (typeof payload.session_id !== 'string') {
      throw new ConflictError('Agent Home replay event does not reference a session')
    }
    return this.requireSession(payload.session_id)
  }

  private sessionScope(session: AgentSessionRecord): { board_id: number } {
    const row = this.db.prepare('SELECT board_id FROM workspaces WHERE id=?')
      .get(session.workspace_id) as { board_id: number } | undefined
    if (!row) throw new ConflictError('agent session workspace was not found')
    return { board_id: Number(row.board_id) }
  }

  private validateJobScope(jobId: string | null, boardId: number, workspaceId: string): void {
    if (!jobId) return
    const row = this.db.prepare('SELECT board_id, workspace_id FROM jobs WHERE id=?')
      .get(jobId) as { board_id: number; workspace_id: string | null } | undefined
    if (!row) throw new NotFoundError('job not found')
    if (Number(row.board_id) !== boardId
      || (row.workspace_id !== null && row.workspace_id !== workspaceId)) {
      throw new ValidationError('job belongs to a different board or workspace')
    }
  }

  private validateArtifactScope(
    artifactId: string | null,
    boardId: number,
    workspaceId: string,
  ): void {
    if (!artifactId) return
    const row = this.db.prepare('SELECT board_id, workspace_id FROM artifacts WHERE id=?')
      .get(artifactId) as { board_id: number; workspace_id: string | null } | undefined
    if (!row) throw new NotFoundError('raw artifact not found')
    if (Number(row.board_id) !== boardId
      || (row.workspace_id !== null && row.workspace_id !== workspaceId)) {
      throw new ValidationError('raw artifact belongs to a different board or workspace')
    }
  }

  private retainEventConflict(input: {
    canonical: ConversationEvent
    session: AgentSessionRecord
    contentHash: string
    projectedText: string | null
    metadata: Record<string, unknown>
    rawArtifactId: string | null
    actor: ActorIdentity
    eventScope: DurableSessionEventScope
  }): string {
    const existing = this.db.prepare(`SELECT id FROM conversation_event_conflicts
      WHERE canonical_event_id=? AND received_content_hash=?`)
      .get(input.canonical.id, input.contentHash) as { id: string } | undefined
    const conflictId = existing?.id ?? randomUUID()
    if (!existing) {
      this.db.prepare(`INSERT INTO conversation_event_conflicts (
        id, board_id, profile_id, conversation_id, session_id, canonical_event_id,
        dedupe_key, received_content_hash, received_projected_text,
        received_metadata_json, raw_artifact_id, actor_type, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        conflictId,
        input.eventScope.boardId,
        input.canonical.profile_id,
        input.canonical.conversation_id,
        input.session.id,
        input.canonical.id,
        input.canonical.dedupe_key,
        input.contentHash,
        input.projectedText,
        stableJson(input.metadata),
        input.rawArtifactId,
        input.actor.type,
        input.actor.id,
        timestamp(),
      )
    }
    this.events.append({
      boardId: input.eventScope.boardId,
      workspaceId: input.eventScope.workspaceId,
      cardId: input.eventScope.cardId,
      sessionId: input.session.id,
      jobId: input.eventScope.jobId,
      contractId: input.eventScope.contractId,
      correlationId: input.eventScope.correlationId ?? `conversation-conflict:${conflictId}`,
      idempotencyKey: `conversation-conflict:${conflictId}`,
      kind: 'conversation.event_conflict',
      source: 'agent-home',
      payload: {
        conflict_id: conflictId,
        canonical_event_id: input.canonical.id,
        profile_id: input.canonical.profile_id,
        conversation_id: input.canonical.conversation_id,
        session_id: input.session.id,
        dedupe_key: input.canonical.dedupe_key,
        canonical_content_hash: input.canonical.content_hash,
        received_content_hash: input.contentHash,
      },
    })
    return conflictId
  }
}

export function mapConversation(row: Record<string, unknown>): AgentConversation {
  return {
    id: String(row.id),
    board_id: Number(row.board_id),
    profile_id: String(row.profile_id),
    title: String(row.title),
    status: String(row.status) as AgentConversation['status'],
    is_default: Number(row.is_default) === 1,
    next_sequence: Number(row.next_sequence),
    created_by_actor_type: String(row.created_by_actor_type),
    created_by_actor_id: row.created_by_actor_id == null ? null : String(row.created_by_actor_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    archived_at: row.archived_at == null ? null : String(row.archived_at),
  }
}

export function mapAgentSession(row: Record<string, unknown>): AgentSessionRecord {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    agent_id: row.agent_id == null ? null : Number(row.agent_id),
    provider: String(row.provider),
    external_id: row.external_id == null ? null : String(row.external_id),
    model: row.model == null ? null : String(row.model),
    status: String(row.status),
    context: parseJson<Record<string, unknown>>(row.context_json, {}),
    profile_id: row.profile_id == null ? null : String(row.profile_id),
    conversation_id: row.conversation_id == null ? null : String(row.conversation_id),
    job_id: row.job_id == null ? null : String(row.job_id),
    mode: String(row.mode) as AgentSessionMode,
    driver_id: row.driver_id == null ? null : String(row.driver_id),
    effort: row.effort == null ? null : String(row.effort),
    access_profile: row.access_profile == null
      ? null : String(row.access_profile) as AgentHomeAccessProfile,
    provider_thread_id: row.provider_thread_id == null ? null : String(row.provider_thread_id),
    provider_cursor: row.provider_cursor == null ? null : String(row.provider_cursor),
    recovery_state: String(row.recovery_state) as AgentSessionRecoveryState,
    recovery: parseJson<Record<string, unknown>>(row.recovery_json, {}),
    history_state: String(row.history_state) as AgentSessionHistoryState,
    display_name: row.display_name == null ? null : String(row.display_name),
    parent_session_id: row.parent_session_id == null ? null : String(row.parent_session_id),
    lineage_type: row.lineage_type == null
      ? null : String(row.lineage_type) as AgentSessionRecord['lineage_type'],
    control_state: String(row.control_state ?? 'active') as AgentSessionRecord['control_state'],
    started_at: row.started_at == null ? null : String(row.started_at),
    ended_at: row.ended_at == null ? null : String(row.ended_at),
    archived_at: row.archived_at == null ? null : String(row.archived_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

export function mapConversationEvent(row: Record<string, unknown>): ConversationEvent {
  return {
    id: String(row.id),
    board_id: Number(row.board_id),
    profile_id: String(row.profile_id),
    conversation_id: String(row.conversation_id),
    session_id: row.session_id == null ? null : String(row.session_id),
    sequence: Number(row.sequence),
    provider: row.provider == null ? null : String(row.provider),
    provider_event_id: row.provider_event_id == null ? null : String(row.provider_event_id),
    provider_thread_id: row.provider_thread_id == null ? null : String(row.provider_thread_id),
    provider_turn_id: row.provider_turn_id == null ? null : String(row.provider_turn_id),
    provider_item_id: row.provider_item_id == null ? null : String(row.provider_item_id),
    provider_cursor: row.provider_cursor == null ? null : String(row.provider_cursor),
    kind: String(row.kind) as ConversationEventKind,
    actor_type: String(row.actor_type),
    actor_id: row.actor_id == null ? null : String(row.actor_id),
    correlation_id: row.correlation_id == null ? null : String(row.correlation_id),
    causation_id: row.causation_id == null ? null : String(row.causation_id),
    projected_text: row.projected_text == null ? null : String(row.projected_text),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    raw_artifact_id: row.raw_artifact_id == null ? null : String(row.raw_artifact_id),
    dedupe_key: String(row.dedupe_key),
    content_hash: String(row.content_hash),
    redaction_state: String(row.redaction_state) as RedactionState,
    retention_class: String(row.retention_class) as RetentionClass,
    schema_version: Number(row.schema_version),
    created_at: String(row.created_at),
    archived_at: row.archived_at == null ? null : String(row.archived_at),
  }
}

function conversationEventKind(value: unknown): ConversationEventKind {
  const normalized = boundedString(value, 'event kind', 64)
  if (!CONVERSATION_EVENT_KINDS.includes(normalized as ConversationEventKind)) {
    throw new ValidationError('event kind is invalid')
  }
  return normalized as ConversationEventKind
}

function redactionState(value: unknown): RedactionState {
  if (value === undefined || value === null || value === '') return 'none'
  const normalized = boundedString(value, 'redaction state', 32)
  if (!REDACTION_STATES.includes(normalized as RedactionState)) {
    throw new ValidationError('redaction state is invalid')
  }
  return normalized as RedactionState
}

function retentionClass(value: unknown): RetentionClass {
  if (value === undefined || value === null || value === '') return 'transcript'
  const normalized = boundedString(value, 'retention class', 32)
  if (!RETENTION_CLASSES.includes(normalized as RetentionClass)) {
    throw new ValidationError('retention class is invalid')
  }
  return normalized as RetentionClass
}

function optionalProjectedText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new ValidationError('projected text must be a string')
  if (Buffer.byteLength(value, 'utf8') > 1_000_000) {
    throw new ValidationError('projected text must be at most 1000000 bytes')
  }
  return value
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  return parsed
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`)
  }
  return parsed
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidationError(`${field} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

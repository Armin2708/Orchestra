import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  ConversationService,
  type AgentSessionRecord,
} from './conversations.js'
import {
  AgentOsError,
  ConflictError,
  NotFoundError,
  UnsupportedError,
  ValidationError,
} from './errors.js'
import { EventStore } from './event-store.js'
import { AgentHomeLinkService, type AgentHomeLinks } from './agent-home-links.js'
import {
  actorIdentity,
  boundedString,
  canonicalHash,
  type ActorIdentity,
} from './agent-home-support.js'
import { parseJson, timestamp } from './json.js'
import type { OrchestrationService } from './orchestration-service.js'
import type { JobScheduler } from './scheduler.js'

export const AGENT_HOME_SESSION_ACTIONS = [
  'resume',
  'pause',
  'stop',
  'retry',
  'fork',
  'rename',
  'archive',
] as const
export type AgentHomeSessionAction = (typeof AGENT_HOME_SESSION_ACTIONS)[number]
export type ProviderSessionAction = Extract<
  AgentHomeSessionAction,
  'resume' | 'pause' | 'stop' | 'retry' | 'fork'
>

export interface RuntimeActionSupport {
  supported: boolean
  reason: string | null
}

export type RuntimeActionCapabilities = Record<ProviderSessionAction, RuntimeActionSupport>

export interface AgentHomeRuntimeControl {
  agentHomeSessionCapabilities(session: AgentSessionRecord): RuntimeActionCapabilities
  pauseAgentHomeSession(sessionId: string): Promise<void>
  resumeAgentHomeSession(sessionId: string): Promise<void>
  stopAgentHomeSession(sessionId: string): Promise<void>
}

export interface SessionActionCapability extends RuntimeActionSupport {
  allowed: boolean
  requires_operator: true
}

export interface SessionCapabilities {
  provider: string
  actions: Record<AgentHomeSessionAction, SessionActionCapability>
}

export interface SessionActionResult {
  action: {
    id: string
    type: AgentHomeSessionAction
    target_session_id: string
    replayed: boolean
  }
  session: AgentSessionRecord
  created_session: AgentSessionRecord | null
  capabilities: SessionCapabilities
  links: AgentHomeLinks
}

export interface RunSessionAction {
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
  name?: string
}

type ActionRow = {
  id: string
  board_id: number
  session_id: string
  result_session_id: string | null
  idempotency_key: string
  action: AgentHomeSessionAction
  request_fingerprint: string
  status: 'pending' | 'succeeded' | 'failed'
  lease_id: string
  error_code: string | null
  error_message: string | null
}

type ActionReservation = {
  row: ActionRow
  acquired: boolean
}

type ActionReservationInput = {
  boardId: number
  session: AgentSessionRecord
  action: AgentHomeSessionAction
  actor: ActorIdentity
  idempotencyKey: string
  requestFingerprint: string
  correlationId: string | null
  name?: string
}

type ActionRequestAudit = {
  id: string
  correlation_id: string | null
  payload: Record<string, unknown>
}

const ACTIVE_STATUSES = new Set(['reserved', 'starting', 'running', 'idle', 'stopping'])
const TERMINAL_STATUSES = new Set(['stopped', 'failed', 'lost', 'exited'])

export class AgentHomeLifecycleService {
  private readonly conversations: ConversationService
  private readonly events: EventStore
  private readonly links: AgentHomeLinkService
  private readonly actionLeaseId: string

  constructor(
    private readonly db: Database.Database,
    private readonly options: {
      runtime?: AgentHomeRuntimeControl
      orchestration?: OrchestrationService
      scheduler?: JobScheduler
      actionLeaseId?: string
    } = {},
  ) {
    this.conversations = new ConversationService(db)
    this.events = new EventStore(db)
    this.links = new AgentHomeLinkService(db)
    this.actionLeaseId = options.actionLeaseId ?? this.currentDaemonLeaseId() ?? randomUUID()
    this.reconcileInterruptedActions()
  }

  capabilities(sessionOrId: AgentSessionRecord | string, isOperator: boolean): SessionCapabilities {
    const session = typeof sessionOrId === 'string'
      ? this.conversations.requireSession(sessionOrId)
      : sessionOrId
    if (!session.profile_id || !session.conversation_id) {
      const linkRequired = unsupported(
        'session lifecycle controls require a linked Agent Home conversation',
      )
      return {
        provider: session.provider,
        actions: Object.fromEntries(AGENT_HOME_SESSION_ACTIONS.map((action) => [
          action,
          {
            ...linkRequired,
            allowed: false,
            requires_operator: true as const,
          },
        ])) as SessionCapabilities['actions'],
      }
    }
    const unavailable = (action: ProviderSessionAction): RuntimeActionSupport => ({
      supported: false,
      reason: `the ${session.provider} ${action} control is unavailable in this daemon`,
    })
    const runtime = this.options.runtime?.agentHomeSessionCapabilities(session) ?? {
      resume: unavailable('resume'),
      pause: unavailable('pause'),
      stop: unavailable('stop'),
      retry: unavailable('retry'),
      fork: unavailable('fork'),
    }
    const state = {
      resume: session.control_state === 'paused'
        ? runtime.resume
        : unsupported('resume requires a paused session'),
      pause: session.control_state === 'active' && ACTIVE_STATUSES.has(session.status)
        ? runtime.pause
        : unsupported('pause requires an active session'),
      stop: session.control_state !== 'archived'
        && (ACTIVE_STATUSES.has(session.status) || session.control_state === 'paused')
        ? runtime.stop
        : unsupported('stop requires an active or paused session'),
      retry: session.control_state === 'stopped' && TERMINAL_STATUSES.has(session.status)
        ? this.retrySupport(session, runtime.retry)
        : unsupported('retry requires a stopped, failed, lost, or exited session'),
      fork: runtime.fork,
      rename: session.control_state === 'archived'
        ? unsupported('archived sessions cannot be renamed')
        : supported(),
      archive: session.control_state === 'stopped' && TERMINAL_STATUSES.has(session.status)
        ? supported()
        : unsupported('archive requires a stopped, failed, lost, or exited session'),
    }
    return {
      provider: session.provider,
      actions: Object.fromEntries(AGENT_HOME_SESSION_ACTIONS.map((action) => [
        action,
        {
          ...state[action],
          allowed: isOperator && state[action].supported,
          requires_operator: true as const,
        },
      ])) as SessionCapabilities['actions'],
    }
  }

  async run(
    sessionId: string,
    action: AgentHomeSessionAction,
    input: RunSessionAction,
  ): Promise<SessionActionResult> {
    if (!AGENT_HOME_SESSION_ACTIONS.includes(action)) {
      throw new ValidationError('session action is invalid')
    }
    const initialSession = this.conversations.requireSession(sessionId)
    if (!initialSession.profile_id || !initialSession.conversation_id) {
      throw new ConflictError('session must be linked to an Agent Home before lifecycle actions')
    }
    const actor = actorIdentity(input.actor)
    const name = action === 'rename'
      ? boundedString(input.name, 'name', 200)
      : undefined
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const boardId = this.boardId(initialSession)
    const requestFingerprint = canonicalHash({
      command: `agent_session.${action}`,
      sessionId: initialSession.id,
      ...(name ? { name } : {}),
    })
    const reservation = this.reserve({
      boardId,
      session: initialSession,
      action,
      actor,
      idempotencyKey,
      requestFingerprint,
      correlationId: input.correlationId ?? idempotencyKey,
      name,
    })
    if (reservation.row.status === 'succeeded') return this.result(reservation.row, true)
    if (reservation.row.status === 'failed') throw storedError(reservation.row)
    if (reservation.row.result_session_id) {
      const completed = this.completeAppliedAction(reservation.row)
      return this.result(completed, true)
    }
    if (!reservation.acquired && action !== 'retry') {
      throw new ConflictError(`session ${action} action is already in progress`)
    }

    let effectApplied = false
    let resultId: string | null = null
    try {
      // The reservation is a per-session mutation lock. Read state again only after
      // acquiring it so capability checks cannot race a different lifecycle action.
      const session = this.conversations.requireSession(sessionId)
      const capability = this.capabilities(session, true).actions[action]
      if (!capability.supported) {
        if (isStateReason(capability.reason)) throw new ConflictError(capability.reason!)
        throw new UnsupportedError(capability.reason ?? `${action} is not supported`)
      }
      let resultSession = session
      if (action === 'pause') {
        await this.options.runtime!.pauseAgentHomeSession(session.id)
        effectApplied = true
        resultId = session.id
        this.markApplied(reservation.row.id, resultId)
        this.applySessionProjection(reservation.row)
      } else if (action === 'resume') {
        await this.options.runtime!.resumeAgentHomeSession(session.id)
        effectApplied = true
        resultId = session.id
        this.markApplied(reservation.row.id, resultId)
        this.applySessionProjection(reservation.row)
      } else if (action === 'stop') {
        await this.options.runtime!.stopAgentHomeSession(session.id)
        effectApplied = true
        resultId = session.id
        this.markApplied(reservation.row.id, resultId)
        this.applySessionProjection(reservation.row)
      } else if (action === 'retry') {
        resultSession = this.createRetry(session, reservation.row.id, actor)
        effectApplied = true
        resultId = resultSession.id
        this.markApplied(reservation.row.id, resultId)
      } else if (action === 'fork') {
        throw new UnsupportedError(
          `${session.provider} does not expose provenance-safe native session forking`,
        )
      } else if (action === 'rename') {
        resultId = session.id
        this.markApplied(reservation.row.id, resultId)
        effectApplied = true
        this.applySessionProjection(reservation.row)
      } else if (action === 'archive') {
        resultId = session.id
        this.markApplied(reservation.row.id, resultId)
        effectApplied = true
        this.applySessionProjection(reservation.row)
      }

      const completed = this.completeAppliedAction(this.requireAction(reservation.row.id))
      const response = this.result(completed, false)
      if (action === 'retry') {
        // The durable action result and retry lineage are committed before dispatch.
        // A daemon crash or tick failure therefore leaves a recoverable queued job.
        await this.options.scheduler!.tick().catch(() => undefined)
      }
      return response
    } catch (error) {
      let latest = this.requireAction(reservation.row.id)
      if (effectApplied && resultId && !latest.result_session_id) {
        // The provider/session mutation has already returned success. Persist the applied
        // marker again if the first acknowledgement failed, but never rewrite it as failed.
        try { this.markApplied(reservation.row.id, resultId) } catch { /* replay repairs it */ }
        latest = this.requireAction(reservation.row.id)
      }
      if (latest.status === 'pending' && !latest.result_session_id && !effectApplied) {
        this.fail(reservation.row.id, error)
      }
      throw error
    }
  }

  private retrySupport(
    session: AgentSessionRecord,
    runtime: RuntimeActionSupport,
  ): RuntimeActionSupport {
    if (!runtime.supported) return runtime
    if (!this.options.orchestration || !this.options.scheduler) {
      return unsupported('canonical retry orchestration is unavailable in this daemon')
    }
    if (!session.job_id) return unsupported('retry requires a canonical job')
    const job = this.db.prepare('SELECT card_id, status FROM jobs WHERE id=?').get(session.job_id) as
      { card_id: number | null; status: string } | undefined
    if (!job?.card_id) return unsupported('retry requires a card-backed canonical job')
    if (['queued', 'running', 'cancelling'].includes(job.status)) {
      return unsupported(`retry is unavailable while job ${session.job_id} is ${job.status}`)
    }
    const card = this.db.prepare('SELECT column_name FROM cards WHERE id=?').get(job.card_id) as
      { column_name: string } | undefined
    if (card?.column_name === 'done') return unsupported('completed cards cannot be retried')
    return supported()
  }

  private createRetry(
    parent: AgentSessionRecord,
    actionId: string,
    actor: ActorIdentity,
  ): AgentSessionRecord {
    if (!parent.job_id || !parent.profile_id || !parent.conversation_id
      || !this.options.orchestration || !this.options.scheduler) {
      throw new UnsupportedError('canonical retry orchestration is unavailable for this session')
    }
    const job = this.db.prepare(`SELECT card_id, board_id, workspace_id, provider,
      model, effort, access_profile, priority, max_attempts, budget_tokens, budget_cents
      FROM jobs WHERE id=?`).get(parent.job_id) as {
        card_id: number | null
        board_id: number
        workspace_id: string | null
        provider: string
        model: string | null
        effort: string | null
        access_profile: 'read_only' | 'workspace_write' | 'full_access'
        priority: number
        max_attempts: number
        budget_tokens: number | null
        budget_cents: number | null
      } | undefined
    if (!job?.card_id) throw new UnsupportedError('retry requires a card-backed canonical job')
    const snapshot = this.options.orchestration.createCardJob({
      cardId: job.card_id,
      expectedBoardId: job.board_id,
      provider: job.provider,
      model: job.model,
      effort: job.effort,
      accessProfile: job.access_profile,
      workspaceId: job.workspace_id,
      priority: job.priority,
      maxAttempts: job.max_attempts,
      budgetTokens: job.budget_tokens,
      budgetCents: job.budget_cents,
      idempotencyKey: `agent-home-retry:${actionId}`,
    })
    if (!snapshot.session) throw new ConflictError('retry reservation did not create a session')
    const child = this.conversations.requireSession(snapshot.session.id)
    const childContext = {
      ...child.context,
      parent_session_id: parent.id,
      lineage_type: 'retry',
    }
    this.db.prepare(`UPDATE agent_sessions SET parent_session_id=?, lineage_type='retry',
      display_name=?, control_state='active', context_json=?, updated_at=? WHERE id=?`).run(
      parent.id,
      `${parent.display_name ?? 'session'} retry`.slice(0, 200),
      JSON.stringify(childContext),
      timestamp(),
      child.id,
    )
    this.conversations.linkSession(child.id, {
      profileId: parent.profile_id,
      conversationId: parent.conversation_id,
      jobId: snapshot.job.id,
      mode: 'managed',
      driverId: snapshot.job.driver_id,
      effort: job.effort,
      accessProfile: job.access_profile,
      actor,
      idempotencyKey: `agent-home-action:${actionId}:link`,
      correlationId: actionId,
    })
    return this.conversations.requireSession(child.id)
  }

  private reserve(input: ActionReservationInput): ActionReservation {
    const reserve = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM agent_session_actions
        WHERE board_id=? AND idempotency_key=?`).get(input.boardId, input.idempotencyKey) as
        ActionRow | undefined
      if (existing) {
        if (existing.request_fingerprint !== input.requestFingerprint
          || existing.action !== input.action
          || existing.session_id !== input.session.id) {
          throw new ConflictError(
            'idempotency key was already used for a different Agent Home action',
          )
        }
        if (existing.status === 'pending' && existing.action === 'retry'
          && existing.lease_id !== this.actionLeaseId) {
          this.db.prepare(`UPDATE agent_session_actions SET lease_id=?, updated_at=?
            WHERE id=? AND status='pending'`).run(
            this.actionLeaseId,
            timestamp(),
            existing.id,
          )
          existing.lease_id = this.actionLeaseId
        }
        if (existing.status === 'pending') this.ensureActionRequestAudit(existing, input)
        return { row: existing, acquired: false }
      }
      const occupied = this.db.prepare(`SELECT kind FROM os_events
        WHERE board_id=? AND idempotency_key=?`).get(input.boardId, input.idempotencyKey) as
        { kind: string } | undefined
      if (occupied) {
        throw new ConflictError(`idempotency key was already used for ${occupied.kind}`)
      }
      const pending = this.db.prepare(`SELECT action FROM agent_session_actions
        WHERE session_id=? AND status='pending' LIMIT 1`).get(input.session.id) as
        { action: AgentHomeSessionAction } | undefined
      if (pending) {
        throw new ConflictError(`session ${pending.action} action is already in progress`)
      }
      const at = timestamp()
      const row: ActionRow = {
        id: randomUUID(),
        board_id: input.boardId,
        session_id: input.session.id,
        result_session_id: null,
        idempotency_key: input.idempotencyKey,
        action: input.action,
        request_fingerprint: input.requestFingerprint,
        status: 'pending',
        lease_id: this.actionLeaseId,
        error_code: null,
        error_message: null,
      }
      this.db.prepare(`INSERT INTO agent_session_actions (
        id, board_id, session_id, result_session_id, idempotency_key, action,
        request_fingerprint, status, lease_id, actor_type, actor_id, error_code, error_message,
        created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?, ?)`).run(
        row.id,
        row.board_id,
        row.session_id,
        row.idempotency_key,
        row.action,
        row.request_fingerprint,
        row.lease_id,
        input.actor.type,
        input.actor.id,
        at,
        at,
      )
      this.appendActionRequestAudit(row, input)
      return { row, acquired: true }
    })
    try {
      return reserve.immediate()
    } catch (error) {
      if (isPendingActionConstraint(error)) {
        throw new ConflictError('another session action is already in progress')
      }
      throw error
    }
  }

  private appendActionRequestAudit(row: ActionRow, input: ActionReservationInput): void {
    this.events.append({
      boardId: row.board_id,
      workspaceId: input.session.workspace_id,
      sessionId: row.session_id,
      jobId: input.session.job_id,
      correlationId: input.correlationId,
      idempotencyKey: row.idempotency_key,
      kind: 'agent_session.action_requested',
      source: 'agent-home',
      payload: {
        action_id: row.id,
        action: row.action,
        session_id: row.session_id,
        profile_id: input.session.profile_id,
        conversation_id: input.session.conversation_id,
        request_fingerprint: row.request_fingerprint,
        actor: input.actor,
        ...(input.name ? { name: input.name } : {}),
      },
    })
  }

  private ensureActionRequestAudit(row: ActionRow, input: ActionReservationInput): void {
    const occupied = this.db.prepare(`SELECT kind, payload FROM os_events
      WHERE board_id=? AND idempotency_key=?`).get(row.board_id, row.idempotency_key) as
      { kind: string; payload: string } | undefined
    if (!occupied) {
      this.appendActionRequestAudit(row, input)
      return
    }
    const payload = parseJson<Record<string, unknown>>(occupied.payload, {})
    if (occupied.kind !== 'agent_session.action_requested'
      || payload.action_id !== row.id
      || payload.request_fingerprint !== row.request_fingerprint) {
      throw new ConflictError('idempotency key was already used for a different event')
    }
  }

  private markApplied(actionId: string, resultSessionId: string): ActionRow {
    const current = this.requireAction(actionId)
    if (current.status !== 'pending') return current
    if (current.result_session_id && current.result_session_id !== resultSessionId) {
      throw new ConflictError('session action already recorded a different applied result')
    }
    this.db.prepare(`UPDATE agent_session_actions SET result_session_id=coalesce(result_session_id, ?),
      updated_at=? WHERE id=? AND status='pending'`).run(
      resultSessionId,
      timestamp(),
      actionId,
    )
    return this.requireAction(actionId)
  }

  private applySessionProjection(row: ActionRow): void {
    const request = this.actionRequestAudit(row)
    const at = timestamp()
    if (row.action === 'pause') {
      this.db.prepare(`UPDATE agent_sessions SET status='idle', control_state='paused',
        updated_at=? WHERE id=?`).run(at, row.session_id)
    } else if (row.action === 'resume') {
      this.db.prepare(`UPDATE agent_sessions SET status='running', control_state='active',
        ended_at=NULL, updated_at=? WHERE id=?`).run(at, row.session_id)
    } else if (row.action === 'stop') {
      this.db.prepare(`UPDATE agent_sessions SET status='stopped', control_state='stopped',
        ended_at=coalesce(ended_at, ?), updated_at=? WHERE id=?`)
        .run(at, at, row.session_id)
    } else if (row.action === 'rename') {
      const name = typeof request?.payload.name === 'string' ? request.payload.name : null
      if (!name) throw new ConflictError('rename action reservation is missing its requested name')
      this.db.prepare('UPDATE agent_sessions SET display_name=?, updated_at=? WHERE id=?')
        .run(name, at, row.session_id)
    } else if (row.action === 'archive') {
      this.db.prepare(`UPDATE agent_sessions SET control_state='archived',
        archived_at=coalesce(archived_at, ?), ended_at=coalesce(ended_at, ?), updated_at=?
        WHERE id=?`).run(at, at, at, row.session_id)
    }
  }

  private completeAppliedAction(row: ActionRow): ActionRow {
    if (row.status === 'succeeded') return row
    if (row.status === 'failed') throw storedError(row)
    if (!row.result_session_id) throw new ConflictError('session action has no applied result')
    this.applySessionProjection(row)

    const completionKey = `agent-home-action:${row.id}:completed`
    try {
      return this.commitActionCompletion(row.id, completionKey)
    } catch (error) {
      if (!isEventIdempotencyConflict(error)) throw error
      // The caller key is already reserved by action_requested. A hostile or stale writer
      // may still occupy the internal completion key after the provider returns, so retain
      // action scope while choosing a fresh ledger identity rather than falsifying failure.
      return this.commitActionCompletion(row.id, `${completionKey}:${randomUUID()}`)
    }
  }

  private commitActionCompletion(actionId: string, completionKey: string): ActionRow {
    const complete = this.db.transaction(() => {
      const current = this.requireAction(actionId)
      if (current.status === 'succeeded') return current
      if (current.status === 'failed') throw storedError(current)
      if (!current.result_session_id) throw new ConflictError('session action has no applied result')

      const target = this.conversations.requireSession(current.session_id)
      const created = this.conversations.requireSession(current.result_session_id)
      const request = this.actionRequestAudit(current)
      const actor = this.db.prepare(`SELECT actor_type, actor_id FROM agent_session_actions
        WHERE id=?`).get(current.id) as { actor_type: string; actor_id: string | null }
      this.events.append({
        boardId: current.board_id,
        workspaceId: target.workspace_id,
        sessionId: target.id,
        jobId: target.job_id,
        correlationId: request?.correlation_id ?? current.id,
        causationId: request?.id ?? null,
        idempotencyKey: completionKey,
        kind: `agent_session.${current.action}`,
        source: 'agent-home',
        payload: {
          action_id: current.id,
          action: current.action,
          session_id: target.id,
          result_session_id: created.id,
          profile_id: target.profile_id,
          conversation_id: target.conversation_id,
          request_fingerprint: current.request_fingerprint,
          actor: { type: actor.actor_type, id: actor.actor_id },
          ...(typeof request?.payload.name === 'string' ? { name: request.payload.name } : {}),
        },
      })
      const updated = this.db.prepare(`UPDATE agent_session_actions
        SET status='succeeded', error_code=NULL, error_message=NULL, updated_at=?
        WHERE id=? AND status='pending' AND result_session_id=?`).run(
        timestamp(),
        current.id,
        created.id,
      )
      if (updated.changes !== 1) {
        const raced = this.requireAction(current.id)
        if (raced.status !== 'succeeded') {
          throw new ConflictError('session action completion changed concurrently')
        }
      }
      return this.requireAction(current.id)
    })
    return complete.immediate()
  }

  private actionRequestAudit(row: ActionRow): ActionRequestAudit | null {
    const event = this.db.prepare(`SELECT id, kind, correlation_id, payload FROM os_events
      WHERE board_id=? AND idempotency_key=?`).get(row.board_id, row.idempotency_key) as
      { id: string; kind: string; correlation_id: string | null; payload: string } | undefined
    if (!event || event.kind !== 'agent_session.action_requested') return null
    return {
      id: event.id,
      correlation_id: event.correlation_id,
      payload: parseJson<Record<string, unknown>>(event.payload, {}),
    }
  }

  private fail(actionId: string, error: unknown): void {
    const code = error instanceof AgentOsError ? error.code : 'runtime_error'
    const message = error instanceof Error ? error.message : String(error)
    this.db.prepare(`UPDATE agent_session_actions SET status='failed', error_code=?,
      error_message=?, updated_at=? WHERE id=? AND status='pending'`)
      .run(code, message.slice(0, 2_000), timestamp(), actionId)
  }

  private requireAction(id: string): ActionRow {
    const row = this.db.prepare('SELECT * FROM agent_session_actions WHERE id=?')
      .get(id) as ActionRow | undefined
    if (!row) throw new NotFoundError('session action not found')
    return row
  }

  private result(row: ActionRow, replayed: boolean): SessionActionResult {
    if (row.status !== 'succeeded' || !row.result_session_id) {
      throw new ConflictError('session action has no completed result')
    }
    const target = this.conversations.requireSession(row.session_id)
    const result = this.conversations.requireSession(row.result_session_id)
    return {
      action: {
        id: row.id,
        type: row.action,
        target_session_id: row.session_id,
        replayed,
      },
      session: target,
      created_session: result.id === target.id ? null : result,
      capabilities: this.capabilities(result, true),
      links: this.links.forSession(result),
    }
  }

  private boardId(session: AgentSessionRecord): number {
    const row = this.db.prepare('SELECT board_id FROM workspaces WHERE id=?')
      .get(session.workspace_id) as { board_id: number } | undefined
    if (!row) throw new ConflictError('session workspace is missing')
    return Number(row.board_id)
  }

  private reconcileInterruptedActions(): void {
    const stale = this.db.prepare(`SELECT *
      FROM agent_session_actions
      WHERE status='pending' AND action!='retry' AND lease_id!=?
      ORDER BY created_at, rowid`).all(this.actionLeaseId) as ActionRow[]
    if (!stale.length) return
    for (const action of stale.filter((candidate) => candidate.result_session_id !== null)) {
      try {
        this.completeAppliedAction(action)
      } catch {
        // The action ledger retains an applied pending result. Replay or the next daemon
        // restart retries projection/audit without invoking the provider side effect again.
      }
    }
    const interrupted = stale.filter((candidate) => candidate.result_session_id === null)
    if (!interrupted.length) return
    const reconcile = this.db.transaction(() => {
      for (const action of interrupted) {
        const message = `session ${action.action} action was interrupted by a daemon restart`
        const updated = this.db.prepare(`UPDATE agent_session_actions
          SET status='failed', error_code='action_interrupted', error_message=?, updated_at=?
          WHERE id=? AND status='pending' AND lease_id!=?`).run(
          message,
          timestamp(),
          action.id,
          this.actionLeaseId,
        )
        if (updated.changes !== 1) continue
        this.events.append({
          boardId: action.board_id,
          sessionId: action.session_id,
          correlationId: action.id,
          idempotencyKey: `agent-home-action-reconciled:${action.id}`,
          kind: 'agent_session.action_interrupted',
          source: 'agent-home',
          payload: {
            action_id: action.id,
            action: action.action,
            session_id: action.session_id,
            previous_lease_id: action.lease_id,
            lease_id: this.actionLeaseId,
            reason: 'daemon_restart',
          },
        })
      }
    })
    reconcile.immediate()
  }

  private currentDaemonLeaseId(): string | null {
    const row = this.db.prepare(`SELECT owner_id FROM daemon_leases
      WHERE name='orchestra-daemon'`).get() as { owner_id: string } | undefined
    return row?.owner_id ?? null
  }
}

function supported(): RuntimeActionSupport {
  return { supported: true, reason: null }
}

function unsupported(reason: string): RuntimeActionSupport {
  return { supported: false, reason }
}

function isStateReason(reason: string | null): boolean {
  return !!reason && (
    reason.includes('requires ')
    || reason.includes('cannot be ')
    || reason.includes('while job ')
    || reason.includes('completed cards')
    || reason.includes('not attached')
    || reason.includes('no longer active')
  )
}

function storedError(row: ActionRow): Error {
  const message = row.error_message ?? `session ${row.action} action failed`
  if (row.error_code === 'not_supported') return new UnsupportedError(message)
  if (row.error_code === 'not_found') return new NotFoundError(message)
  if (row.error_code === 'validation_error') return new ValidationError(message)
  return new ConflictError(message)
}

function isPendingActionConstraint(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('UNIQUE constraint failed: agent_session_actions.session_id')
}

function isEventIdempotencyConflict(error: unknown): boolean {
  return error instanceof ConflictError
    && error.message.includes('event idempotency key')
}

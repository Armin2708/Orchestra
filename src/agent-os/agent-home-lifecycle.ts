import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { AttentionService } from './attention.js'
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
import {
  AgentHomeForkOutcomeUnknownError,
  forkTargetFromEffect,
  persistDetachedAgentHomeFork,
  type AgentHomeForkTarget,
  type AgentHomeKnownForkChild,
  type AgentHomeNativeForkResult,
} from './agent-home-fork.js'
import { AgentHomeLinkService, type AgentHomeLinks } from './agent-home-links.js'
import {
  actorIdentity,
  boundedString,
  canonicalHash,
  type ActorIdentity,
} from './agent-home-support.js'
import { durableSessionEventScope } from './agent-home-event-scope.js'
import { parseJson, timestamp } from './json.js'
import type { OrchestrationService } from './orchestration-service.js'
import { normalizeProjectedText } from './projected-text-redaction.js'
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
  prepareAgentHomeForkSession?(
    session: AgentSessionRecord,
    operation: AgentHomeForkOperation,
  ): Promise<AgentHomeForkTarget>
  forkAgentHomeSession?(
    session: AgentSessionRecord,
    operation: AgentHomeForkOperation & AgentHomeForkTarget,
  ): Promise<AgentHomeNativeForkResult>
  verifyAgentHomeForkChild?(
    session: AgentSessionRecord,
    child: AgentHomeKnownForkChild,
    operation: AgentHomeForkOperation & AgentHomeForkTarget,
  ): Promise<AgentHomeNativeForkResult>
  adoptAgentHomeForkSession?(
    parent: AgentSessionRecord,
    child: AgentSessionRecord,
    operation: AgentHomeForkOperation,
  ): Promise<void>
}

export interface AgentHomeForkOperation {
  actionId: string
  reservedSessionId: string
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

export type AgentHomeForkReconciliationResolution = 'verify_adopt' | 'confirm_absent'

export interface ReconcileAgentHomeFork {
  actor: ActorIdentity
  idempotencyKey: string
  resolution: AgentHomeForkReconciliationResolution
  note?: string | null
}

export interface AgentHomeForkReconciliationResult {
  reconciliation: {
    id: string
    action_id: string
    resolution: AgentHomeForkReconciliationResolution
    replayed: boolean
  }
  action: {
    id: string
    status: ActionRow['status']
    effect_state: ActionRow['effect_state']
  }
  session: AgentSessionRecord
  created_session: AgentSessionRecord | null
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
  reserved_session_id: string | null
  effect_state: 'reserved' | 'invoking' | 'applied' | 'completed' | 'outcome_unknown'
  effect_json: string
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

type ReconciliationRow = {
  id: string
  board_id: number
  action_id: string
  idempotency_key: string
  request_fingerprint: string
  resolution: AgentHomeForkReconciliationResolution
  status: 'pending' | 'succeeded' | 'failed'
  result_session_id: string | null
  actor_type: string
  actor_id: string | null
  note: string | null
  error_code: string | null
  error_message: string | null
}

type ActionRequestAudit = {
  id: string
  correlation_id: string | null
  payload: Record<string, unknown>
}

type ActionRequestAuditCandidate = {
  id: string
  board_id: number
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
  event_version: number
  payload: string
}

const ACTIVE_STATUSES = new Set(['reserved', 'starting', 'running', 'idle', 'stopping'])
const TERMINAL_STATUSES = new Set(['stopped', 'failed', 'lost', 'exited'])

export class AgentHomeLifecycleService {
  private readonly conversations: ConversationService
  private readonly events: EventStore
  private readonly links: AgentHomeLinkService
  private readonly attention: AttentionService
  private readonly actionLeaseId: string
  private readonly forkReconciliations = new Map<string, {
    requestIdentity: string
    promise: Promise<AgentHomeForkReconciliationResult>
  }>()

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
    this.attention = new AttentionService(db)
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
      fork: session.control_state === 'archived'
        ? unsupported('archived sessions cannot be forked')
        : this.forkSupport(session, runtime.fork),
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
      if (reservation.row.action === 'fork') {
        await this.ensureForkAdopted(reservation.row)
      }
      const completed = this.completeAppliedAction(
        this.requireAction(reservation.row.id),
      )
      return this.result(completed, true)
    }
    if (!reservation.acquired && action !== 'retry') {
      throw new ConflictError(`session ${action} action is already in progress`)
    }

    let effectApplied = false
    let resultId: string | null = null
    let returnedFork: AgentHomeNativeForkResult | null = null
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
        if (!reservation.row.reserved_session_id) {
          throw new ConflictError('fork action is missing its reserved child identity')
        }
        const operation = {
          actionId: reservation.row.id,
          reservedSessionId: reservation.row.reserved_session_id,
        }
        const target = await this.options.runtime!.prepareAgentHomeForkSession!(
          session,
          operation,
        )
        this.markForkTarget(reservation.row.id, target)
        this.markInvoking(reservation.row.id)
        returnedFork = await this.options.runtime!.forkAgentHomeSession!(session, {
          ...operation,
          ...target,
        })
        resultId = reservation.row.reserved_session_id
        resultSession = persistDetachedAgentHomeFork(this.db, {
          parent: session,
          actionId: reservation.row.id,
          reservedSessionId: resultId,
          actor,
          fork: returnedFork,
          target,
        })
        effectApplied = true
        await this.ensureForkAdopted(this.requireAction(reservation.row.id))
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
      if (action === 'fork' && latest.status === 'pending'
        && latest.effect_state === 'invoking' && !latest.result_session_id) {
        const outcome = error instanceof AgentHomeForkOutcomeUnknownError
          ? error
          : returnedFork
            ? outcomeUnknownFromReturnedFork(initialSession, returnedFork)
            : error
        this.markOutcomeUnknown(reservation.row.id, outcome)
        throw new ConflictError(
          'provider fork outcome is unknown and requires operator reconciliation',
        )
      }
      if (latest.status === 'pending' && !latest.result_session_id && !effectApplied) {
        this.fail(reservation.row.id, error)
      }
      throw error
    }
  }

  async reconcileFork(
    actionId: string,
    input: ReconcileAgentHomeFork,
  ): Promise<AgentHomeForkReconciliationResult> {
    const id = boundedString(actionId, 'action id', 200)
    if (!['verify_adopt', 'confirm_absent'].includes(input.resolution)) {
      throw new ValidationError('fork reconciliation resolution is invalid')
    }
    const actor = actorIdentity(input.actor)
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const rawNote = input.note == null || input.note === ''
      ? null
      : boundedString(input.note, 'note', 2_000)
    const note = rawNote === null
      ? null
      : normalizeProjectedText(rawNote, 'none').value
    const action = this.requireAction(id)
    if (action.action !== 'fork') throw new ConflictError('only fork actions can be reconciled')
    const fingerprint = canonicalHash({
      command: 'agent_session.fork_reconcile',
      actionId: action.id,
      resolution: input.resolution,
      note,
    })
    const requestIdentity = `${idempotencyKey}:${fingerprint}`
    const inFlight = this.forkReconciliations.get(action.id)
    if (inFlight) {
      if (inFlight.requestIdentity !== requestIdentity) {
        throw new ConflictError('another fork reconciliation is already in progress')
      }
      const replay = await inFlight.promise
      return {
        ...replay,
        reconciliation: { ...replay.reconciliation, replayed: true },
      }
    }
    const work = this.executeForkReconciliation(action, {
      actor,
      idempotencyKey,
      requestFingerprint: fingerprint,
      resolution: input.resolution,
      note,
    })
    this.forkReconciliations.set(action.id, {
      requestIdentity,
      promise: work,
    })
    try {
      return await work
    } finally {
      if (this.forkReconciliations.get(action.id)?.promise === work) {
        this.forkReconciliations.delete(action.id)
      }
    }
  }

  private async executeForkReconciliation(
    action: ActionRow,
    input: {
      actor: ActorIdentity
      idempotencyKey: string
      requestFingerprint: string
      resolution: AgentHomeForkReconciliationResolution
      note: string | null
    },
  ): Promise<AgentHomeForkReconciliationResult> {
    const reconciliation = this.reserveForkReconciliation(action, {
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resolution: input.resolution,
      note: input.note,
    })
    if (reconciliation.status === 'succeeded') {
      return this.reconciliationResult(reconciliation, true)
    }

    try {
      if (input.resolution === 'confirm_absent') {
        const completed = this.confirmForkAbsent(action, reconciliation)
        return this.reconciliationResult(completed, false)
      }

      const latest = this.requireAction(action.id)
      if (!latest.result_session_id) {
        if (latest.status !== 'failed' || latest.effect_state !== 'outcome_unknown') {
          throw new ConflictError('fork action no longer requires child reconciliation')
        }
        const knownChild = knownForkChildFromEffect(latest.effect_json)
        const target = forkTargetFromEffect(
          parseJson<Record<string, unknown>>(latest.effect_json, {}),
        )
        if (!knownChild || !target) {
          throw new ConflictError(
            'fork action has no exact known child and can only be closed as confirmed absent',
          )
        }
        if (!this.options.runtime?.verifyAgentHomeForkChild
          || !this.options.runtime.adoptAgentHomeForkSession) {
          throw new UnsupportedError('provider fork verification is unavailable in this daemon')
        }
        const parent = this.conversations.requireSession(latest.session_id)
        if (!latest.reserved_session_id) {
          throw new ConflictError('fork reconciliation is missing its reserved child identity')
        }
        const operation = {
          actionId: latest.id,
          reservedSessionId: latest.reserved_session_id,
          ...target,
        }
        const verified = await this.options.runtime.verifyAgentHomeForkChild(
          parent,
          knownChild,
          operation,
        )
        persistDetachedAgentHomeFork(this.db, {
          parent,
          actionId: latest.id,
          reservedSessionId: operation.reservedSessionId,
          actor: input.actor,
          fork: verified,
          target,
          allowOutcomeUnknown: true,
        })
      }

      const applied = this.requireAction(action.id)
      await this.ensureForkAdopted(applied)
      this.completeAppliedAction(this.requireAction(action.id))
      const completed = this.finishForkReconciliation(reconciliation.id)
      return this.reconciliationResult(completed, false)
    } catch (error) {
      this.failForkReconciliation(reconciliation.id, error)
      if (error instanceof AgentOsError) throw error
      throw new ConflictError('fork reconciliation did not complete')
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

  private forkSupport(
    session: AgentSessionRecord,
    runtime: RuntimeActionSupport,
  ): RuntimeActionSupport {
    if (!runtime.supported) return runtime
    if (!this.options.runtime?.prepareAgentHomeForkSession
      || !this.options.runtime.forkAgentHomeSession
      || !this.options.runtime.adoptAgentHomeForkSession) {
      return unsupported('native session fork persistence is unavailable in this daemon')
    }
    if (!session.external_id || !session.provider_thread_id) {
      return unsupported('fork requires durable provider session provenance')
    }
    const uncertain = this.db.prepare(`SELECT 1 FROM agent_session_actions
      WHERE session_id=? AND action='fork' AND effect_state='outcome_unknown'
      LIMIT 1`).get(session.id)
    if (uncertain) {
      return unsupported(
        'fork is locked because an earlier provider outcome requires operator reconciliation',
      )
    }
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
      const requestIdentityMatches = this.db.prepare(`SELECT * FROM agent_session_actions
        WHERE idempotency_key=? AND request_fingerprint=?
        ORDER BY rowid`).all(
        input.idempotencyKey,
        input.requestFingerprint,
      ) as ActionRow[]
      if (requestIdentityMatches.length > 1) {
        throw new ConflictError('session action request identity is ambiguous')
      }
      const anchored = requestIdentityMatches[0]
      if (anchored?.board_id !== undefined && anchored.board_id !== input.boardId) {
        throw new ConflictError('session action command board scope is inconsistent')
      }
      if (anchored
        && (anchored.session_id !== input.session.id || anchored.action !== input.action)) {
        throw new ConflictError('session action request identity scope is inconsistent')
      }
      const commandMatches = this.db.prepare(`SELECT * FROM agent_session_actions
        WHERE session_id=? AND action=? AND idempotency_key=?
        ORDER BY rowid`).all(
        input.session.id,
        input.action,
        input.idempotencyKey,
      ) as ActionRow[]
      if (commandMatches.length > 1) {
        throw new ConflictError('session action command identity is ambiguous')
      }
      const existing = commandMatches[0]
      if (existing) {
        if (anchored && anchored.id !== existing.id) {
          throw new ConflictError('session action command identity is ambiguous')
        }
        if (existing.board_id !== input.boardId) {
          throw new ConflictError('session action command board scope is inconsistent')
        }
        if (existing.request_fingerprint !== input.requestFingerprint) {
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
        this.ensureActionRequestAudit(existing, input)
        if (existing.status === 'succeeded') this.ensureActionCompletionAudit(existing)
        return { row: existing, acquired: false }
      }
      const localAction = this.db.prepare(`SELECT action FROM agent_session_actions
        WHERE board_id=? AND idempotency_key=?`).get(input.boardId, input.idempotencyKey) as
        { action: AgentHomeSessionAction } | undefined
      if (localAction) {
        throw new ConflictError(
          'idempotency key was already used for a different Agent Home action',
        )
      }
      const commandAudits = this.matchingActionRequestAudits(
        input.session.id,
        input.action,
        input.idempotencyKey,
        input.requestFingerprint,
      )
      if (commandAudits.length > 1) {
        throw new ConflictError('session action request audit identity is ambiguous')
      }
      if (commandAudits.length === 1) {
        throw new ConflictError(
          commandAudits[0]!.board_id === input.boardId
            ? 'session action request audit is orphaned from its command'
            : 'session action request audit board scope is inconsistent',
        )
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
      const reservedSessionId = input.action === 'fork' ? randomUUID() : null
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
        reserved_session_id: reservedSessionId,
        effect_state: 'reserved',
        effect_json: '{}',
        error_code: null,
        error_message: null,
      }
      this.db.prepare(`INSERT INTO agent_session_actions (
        id, board_id, session_id, result_session_id, idempotency_key, action,
        request_fingerprint, status, lease_id, reserved_session_id, effect_state,
        effect_json, actor_type, actor_id, error_code, error_message, created_at, updated_at
      ) VALUES (
        ?, ?, ?, NULL, ?, ?, ?, 'pending', ?, ?, 'reserved', '{}', ?, ?, NULL, NULL, ?, ?
      )`).run(
        row.id,
        row.board_id,
        row.session_id,
        row.idempotency_key,
        row.action,
        row.request_fingerprint,
        row.lease_id,
        row.reserved_session_id,
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

  private reserveForkReconciliation(
    action: ActionRow,
    input: {
      actor: ActorIdentity
      idempotencyKey: string
      requestFingerprint: string
      resolution: AgentHomeForkReconciliationResolution
      note: string | null
    },
  ): ReconciliationRow {
    const reserve = this.db.transaction(() => {
      const byKey = this.db.prepare(`SELECT * FROM agent_session_action_reconciliations
        WHERE board_id=? AND idempotency_key=?`).get(
        action.board_id,
        input.idempotencyKey,
      ) as ReconciliationRow | undefined
      if (byKey) {
        if (byKey.action_id !== action.id
          || byKey.request_fingerprint !== input.requestFingerprint
          || byKey.resolution !== input.resolution) {
          throw new ConflictError(
            'fork reconciliation idempotency key was used for a different request',
          )
        }
        if (byKey.status !== 'failed') return byKey
        const active = this.db.prepare(`SELECT id FROM agent_session_action_reconciliations
          WHERE action_id=? AND id!=? AND status IN ('pending','succeeded')
          LIMIT 1`).get(action.id, byKey.id)
        if (active) {
          throw new ConflictError(
            'fork reconciliation already has an active or completed decision',
          )
        }
        this.assertForkReconciliationRetryable(this.requireAction(action.id))
        const reset = this.db.prepare(`UPDATE agent_session_action_reconciliations
          SET status='pending', error_code=NULL, error_message=NULL, updated_at=?
          WHERE id=? AND status='failed'`).run(timestamp(), byKey.id)
        if (reset.changes !== 1) {
          throw new ConflictError('fork reconciliation retry changed concurrently')
        }
        return this.requireForkReconciliation(byKey.id)
      }
      const byAction = this.db.prepare(`SELECT * FROM agent_session_action_reconciliations
        WHERE action_id=? AND status IN ('pending','succeeded')
        ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(
        action.id,
      ) as ReconciliationRow | undefined
      if (byAction) {
        throw new ConflictError(
          'fork reconciliation already has an active or completed decision',
        )
      }
      this.assertForkReconciliationOpen(this.requireAction(action.id))
      const row: ReconciliationRow = {
        id: randomUUID(),
        board_id: action.board_id,
        action_id: action.id,
        idempotency_key: input.idempotencyKey,
        request_fingerprint: input.requestFingerprint,
        resolution: input.resolution,
        status: 'pending',
        result_session_id: null,
        actor_type: input.actor.type,
        actor_id: input.actor.id,
        note: input.note,
        error_code: null,
        error_message: null,
      }
      const at = timestamp()
      this.db.prepare(`INSERT INTO agent_session_action_reconciliations (
        id, board_id, action_id, idempotency_key, request_fingerprint, resolution,
        status, result_session_id, actor_type, actor_id, note, error_code,
        error_message, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL, NULL, ?, ?
      )`).run(
        row.id,
        row.board_id,
        row.action_id,
        row.idempotency_key,
        row.request_fingerprint,
        row.resolution,
        row.actor_type,
        row.actor_id,
        row.note,
        at,
        at,
      )
      return row
    })
    return reserve.immediate()
  }

  private assertForkReconciliationOpen(action: ActionRow): void {
    const unknown = action.status === 'failed'
      && action.effect_state === 'outcome_unknown'
      && action.result_session_id === null
    const applied = action.status === 'pending'
      && action.effect_state === 'applied'
      && action.result_session_id !== null
      && action.result_session_id === action.reserved_session_id
      && forkAdoptionState(action.effect_json) !== 'attached'
    if (!unknown && !applied) {
      throw new ConflictError('fork action does not require operator reconciliation')
    }
  }

  private assertForkReconciliationRetryable(action: ActionRow): void {
    const unknown = action.status === 'failed'
      && action.effect_state === 'outcome_unknown'
      && action.result_session_id === null
    const exactChild = action.result_session_id !== null
      && action.result_session_id === action.reserved_session_id
    const applied = action.status === 'pending'
      && action.effect_state === 'applied'
      && exactChild
    const completed = action.status === 'succeeded'
      && action.effect_state === 'completed'
      && exactChild
      && forkAdoptionState(action.effect_json) === 'attached'
    if (!unknown && !applied && !completed) {
      throw new ConflictError('fork reconciliation attempt is no longer retryable')
    }
  }

  private failForkReconciliation(
    reconciliationId: string,
    error: unknown,
  ): void {
    const code = error instanceof AgentOsError
      ? error.code
      : 'fork_reconciliation_failed'
    const message = 'fork reconciliation did not complete'
    this.db.prepare(`UPDATE agent_session_action_reconciliations
      SET status='failed', error_code=?, error_message=?, updated_at=?
      WHERE id=? AND status='pending'`).run(
      code,
      message.slice(0, 2_000),
      timestamp(),
      reconciliationId,
    )
  }

  private confirmForkAbsent(
    action: ActionRow,
    reconciliation: ReconciliationRow,
  ): ReconciliationRow {
    const confirm = this.db.transaction(() => {
      const current = this.requireAction(action.id)
      const currentReconciliation = this.requireForkReconciliation(reconciliation.id)
      if (currentReconciliation.status === 'succeeded') return currentReconciliation
      if (current.status !== 'failed' || current.effect_state !== 'outcome_unknown'
        || current.result_session_id) {
        throw new ConflictError('fork action can no longer be confirmed absent')
      }
      const effect = parseJson<Record<string, unknown>>(current.effect_json, {})
      const at = timestamp()
      const updated = this.db.prepare(`UPDATE agent_session_actions
        SET effect_state='completed', effect_json=?,
          error_code='action_outcome_confirmed_absent',
          error_message='operator confirmed that no provider child should be adopted',
          updated_at=?
        WHERE id=? AND status='failed' AND effect_state='outcome_unknown'
          AND result_session_id IS NULL`).run(
        JSON.stringify({
          ...effect,
          outcome: 'confirmed_absent',
          reconciliation: {
            id: currentReconciliation.id,
            resolution: 'confirm_absent',
          },
        }),
        at,
        current.id,
      )
      if (updated.changes !== 1) {
        throw new ConflictError('fork reconciliation changed concurrently')
      }
      this.appendForkReconciliationAudit(
        current,
        currentReconciliation,
        null,
      )
      this.db.prepare(`UPDATE agent_session_action_reconciliations
        SET status='succeeded', result_session_id=NULL, updated_at=?
        WHERE id=? AND status='pending'`).run(at, currentReconciliation.id)
      this.resolveForkAttention(current)
      return this.requireForkReconciliation(currentReconciliation.id)
    })
    return confirm.immediate()
  }

  private finishForkReconciliation(reconciliationId: string): ReconciliationRow {
    const finish = this.db.transaction(() => {
      const reconciliation = this.requireForkReconciliation(reconciliationId)
      if (reconciliation.status === 'succeeded') return reconciliation
      const action = this.requireAction(reconciliation.action_id)
      if (action.status !== 'succeeded' || !action.result_session_id) {
        throw new ConflictError('reconciled fork has not completed exact-child adoption')
      }
      this.appendForkReconciliationAudit(
        action,
        reconciliation,
        action.result_session_id,
      )
      const updated = this.db.prepare(`UPDATE agent_session_action_reconciliations
        SET status='succeeded', result_session_id=?, updated_at=?
        WHERE id=? AND status='pending'`).run(
        action.result_session_id,
        timestamp(),
        reconciliation.id,
      )
      if (updated.changes !== 1) {
        throw new ConflictError('fork reconciliation changed concurrently')
      }
      this.resolveForkAttention(action)
      return this.requireForkReconciliation(reconciliation.id)
    })
    return finish.immediate()
  }

  private appendForkReconciliationAudit(
    action: ActionRow,
    reconciliation: ReconciliationRow,
    resultSessionId: string | null,
  ): void {
    const session = this.conversations.requireSession(action.session_id)
    const eventScope = durableSessionEventScope(this.db, session, {
      expectedBoardId: action.board_id,
      expectedWorkspaceId: session.workspace_id,
    })
    const request = this.actionRequestAudit(action)
    this.events.append({
      boardId: eventScope.boardId,
      workspaceId: eventScope.workspaceId,
      cardId: eventScope.cardId,
      sessionId: session.id,
      jobId: eventScope.jobId,
      contractId: eventScope.contractId,
      correlationId: eventScope.correlationId ?? request?.correlation_id ?? action.id,
      causationId: request?.id ?? null,
      idempotencyKey: `agent-home-fork-reconciliation:${reconciliation.id}`,
      kind: 'agent_session.fork_reconciled',
      source: 'agent-home',
      payload: {
        reconciliation_id: reconciliation.id,
        action_id: action.id,
        session_id: session.id,
        resolution: reconciliation.resolution,
        result_session_id: resultSessionId,
        request_fingerprint: reconciliation.request_fingerprint,
        actor: {
          type: reconciliation.actor_type,
          id: reconciliation.actor_id,
        },
        ...(reconciliation.note ? { note: reconciliation.note } : {}),
      },
    })
  }

  private resolveForkAttention(action: ActionRow): void {
    this.db.prepare(`UPDATE attention_items
      SET status='resolved', resolved_at=?
      WHERE board_id=? AND kind='agent_session.fork_outcome_unknown'
        AND title=? AND status='open'`).run(
      timestamp(),
      action.board_id,
      forkAttentionTitle(action),
    )
  }

  private requireForkReconciliation(id: string): ReconciliationRow {
    const row = this.db.prepare(`SELECT * FROM agent_session_action_reconciliations
      WHERE id=?`).get(id) as ReconciliationRow | undefined
    if (!row) throw new NotFoundError('fork reconciliation not found')
    return row
  }

  private reconciliationResult(
    reconciliation: ReconciliationRow,
    replayed: boolean,
  ): AgentHomeForkReconciliationResult {
    const action = this.requireAction(reconciliation.action_id)
    const session = this.conversations.requireSession(action.session_id)
    return {
      reconciliation: {
        id: reconciliation.id,
        action_id: reconciliation.action_id,
        resolution: reconciliation.resolution,
        replayed,
      },
      action: {
        id: action.id,
        status: action.status,
        effect_state: action.effect_state,
      },
      session,
      created_session: action.result_session_id
        ? this.conversations.requireSession(action.result_session_id)
        : null,
    }
  }

  private appendActionRequestAudit(row: ActionRow, input: ActionReservationInput): void {
    const eventScope = durableSessionEventScope(this.db, input.session, {
      expectedBoardId: row.board_id,
      expectedWorkspaceId: input.session.workspace_id,
    })
    this.events.append({
      boardId: eventScope.boardId,
      workspaceId: eventScope.workspaceId,
      cardId: eventScope.cardId,
      sessionId: row.session_id,
      jobId: eventScope.jobId,
      contractId: eventScope.contractId,
      correlationId: eventScope.correlationId ?? input.correlationId,
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
    const eventScope = durableSessionEventScope(this.db, input.session, {
      expectedBoardId: row.board_id,
      expectedWorkspaceId: input.session.workspace_id,
    })
    const matching = this.matchingActionRequestAudits(
      row.session_id,
      row.action,
      row.idempotency_key,
      row.request_fingerprint,
    )
    if (matching.length > 1) {
      throw new ConflictError('session action request audit identity is ambiguous')
    }
    const occupied = matching[0]
    if (!occupied) {
      if (row.status === 'pending') {
        this.appendActionRequestAudit(row, input)
        return
      }
      if (row.status === 'failed' && row.error_code === 'action_interrupted') return
      throw new ConflictError('session action request audit is missing')
    }
    const expectedCorrelationId = eventScope.correlationId ?? input.correlationId
    const payload = parseJson<Record<string, unknown>>(occupied.payload, {})
    const expectedPayload = {
      action_id: row.id,
      action: row.action,
      session_id: row.session_id,
      profile_id: input.session.profile_id,
      conversation_id: input.session.conversation_id,
      request_fingerprint: row.request_fingerprint,
      actor: input.actor,
      ...(input.name ? { name: input.name } : {}),
    }
    if (occupied.kind !== 'agent_session.action_requested'
      || occupied.source !== 'agent-home'
      || occupied.workspace_id !== eventScope.workspaceId
      || occupied.card_id !== eventScope.cardId
      || occupied.session_id !== row.session_id
      || occupied.process_id !== null
      || occupied.job_id !== eventScope.jobId
      || occupied.contract_id !== eventScope.contractId
      || occupied.correlation_id !== expectedCorrelationId
      || occupied.causation_id !== null
      || occupied.event_version !== 1
      || occupied.board_id !== row.board_id
      || canonicalHash(payload) !== canonicalHash(expectedPayload)) {
      throw new ConflictError('session action request audit scope is inconsistent')
    }
  }

  private matchingActionRequestAudits(
    sessionId: string,
    action: AgentHomeSessionAction,
    idempotencyKey: string,
    requestFingerprint: string,
  ): ActionRequestAuditCandidate[] {
    return this.db.prepare(`SELECT id, board_id, kind, source, workspace_id, card_id,
      session_id, process_id, job_id, contract_id, correlation_id, causation_id,
      event_version, payload
      FROM os_events
      WHERE idempotency_key=?
        AND json_valid(payload)
        AND (
          json_extract(payload, '$.request_fingerprint')=?
          OR (
            json_extract(payload, '$.session_id')=?
            AND json_extract(payload, '$.action')=?
          )
        )
      ORDER BY rowid`).all(
      idempotencyKey,
      requestFingerprint,
      sessionId,
      action,
    ) as ActionRequestAuditCandidate[]
  }

  private ensureActionCompletionAudit(row: ActionRow): void {
    const session = this.conversations.requireSession(row.session_id)
    const eventScope = durableSessionEventScope(this.db, session, {
      expectedBoardId: row.board_id,
      expectedWorkspaceId: session.workspace_id,
    })
    const request = this.actionRequestAudit(row)
    if (!request || !row.result_session_id) {
      throw new ConflictError('session action completion audit is missing')
    }
    const expectedPayload = {
      action_id: row.id,
      action: row.action,
      session_id: row.session_id,
      result_session_id: row.result_session_id,
      profile_id: session.profile_id,
      conversation_id: session.conversation_id,
      request_fingerprint: row.request_fingerprint,
      actor: request.payload.actor,
      ...(typeof request.payload.name === 'string' ? { name: request.payload.name } : {}),
    }
    const events = this.db.prepare(`SELECT kind, source, workspace_id, card_id,
      session_id, process_id, job_id, contract_id, correlation_id, causation_id,
      event_version, payload FROM os_events
      WHERE board_id=? AND kind=? AND json_extract(payload, '$.action_id')=?`)
      .all(row.board_id, `agent_session.${row.action}`, row.id) as Array<{
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
        event_version: number
        payload: string
      }>
    const completion = events.length === 1 ? events[0] : undefined
    const expectedCorrelationId = eventScope.correlationId ?? request.correlation_id ?? row.id
    if (!completion
      || completion.kind !== `agent_session.${row.action}`
      || completion.source !== 'agent-home'
      || completion.workspace_id !== eventScope.workspaceId
      || completion.card_id !== eventScope.cardId
      || completion.session_id !== row.session_id
      || completion.process_id !== null
      || completion.job_id !== eventScope.jobId
      || completion.contract_id !== eventScope.contractId
      || completion.correlation_id !== expectedCorrelationId
      || completion.causation_id !== request.id
      || completion.event_version !== 1
      || canonicalHash(parseJson(completion.payload, {})) !== canonicalHash(expectedPayload)) {
      throw new ConflictError('session action completion audit scope is inconsistent')
    }
  }

  private markInvoking(actionId: string): ActionRow {
    const updated = this.db.prepare(`UPDATE agent_session_actions
      SET effect_state='invoking', updated_at=?
      WHERE id=? AND status='pending' AND effect_state='reserved'
        AND action='fork' AND reserved_session_id IS NOT NULL`).run(
      timestamp(),
      actionId,
    )
    if (updated.changes !== 1) {
      throw new ConflictError('fork action could not enter its provider invocation boundary')
    }
    return this.requireAction(actionId)
  }

  private markForkTarget(actionId: string, target: AgentHomeForkTarget): ActionRow {
    const workspaceId = boundedString(target.workspaceId, 'fork target workspace id', 200)
    const current = this.requireAction(actionId)
    if (current.action !== 'fork'
      || current.status !== 'pending'
      || current.effect_state !== 'reserved'
      || !current.reserved_session_id) {
      throw new ConflictError('fork action cannot reserve a target workspace')
    }
    const parent = this.conversations.requireSession(current.session_id)
    const parentWorkspace = this.db.prepare(`SELECT board_id, root_path,
      COALESCE(worktree_path, root_path) AS execution_path
      FROM workspaces WHERE id=? AND status='active'`).get(parent.workspace_id) as {
        board_id: number
        root_path: string
        execution_path: string
      } | undefined
    const targetWorkspace = this.db.prepare(`SELECT board_id, kind, root_path,
      worktree_path, status FROM workspaces WHERE id=?`).get(workspaceId) as {
        board_id: number
        kind: string
        root_path: string
        worktree_path: string | null
        status: string
      } | undefined
    if (!parentWorkspace || !targetWorkspace
      || workspaceId === parent.workspace_id
      || Number(targetWorkspace.board_id) !== Number(parentWorkspace.board_id)
      || targetWorkspace.kind !== 'worktree'
      || targetWorkspace.status !== 'active'
      || !targetWorkspace.worktree_path
      || canonicalFilesystemPath(targetWorkspace.root_path)
        !== canonicalFilesystemPath(parentWorkspace.root_path)
      || canonicalFilesystemPath(targetWorkspace.worktree_path)
        === canonicalFilesystemPath(parentWorkspace.execution_path)) {
      throw new ConflictError('fork target must be a distinct active managed worktree')
    }
    const updated = this.db.prepare(`UPDATE agent_session_actions
      SET effect_json=?, updated_at=?
      WHERE id=? AND status='pending' AND action='fork'
        AND effect_state='reserved' AND reserved_session_id IS NOT NULL`).run(
      JSON.stringify({ fork_target: { workspace_id: workspaceId } }),
      timestamp(),
      actionId,
    )
    if (updated.changes !== 1) {
      throw new ConflictError('fork target workspace changed concurrently')
    }
    return this.requireAction(actionId)
  }

  private async ensureForkAdopted(row: ActionRow): Promise<void> {
    if (row.action !== 'fork') return
    const current = this.requireAction(row.id)
    if (!current.result_session_id
      || current.result_session_id !== current.reserved_session_id
      || current.effect_state !== 'applied'
      || current.status !== 'pending') {
      if (current.status === 'succeeded'
        && forkAdoptionState(current.effect_json) === 'attached') return
      throw new ConflictError('fork child is not parked for exact-child adoption')
    }
    const target = forkTargetFromEffect(
      parseJson<Record<string, unknown>>(current.effect_json, {}),
    )
    if (!target) throw new ConflictError('fork action is missing its isolated target workspace')
    const parent = this.conversations.requireSession(current.session_id)
    const child = this.conversations.requireSession(current.result_session_id)
    assertExactForkChild(parent, child, current, target)
    if (forkAdoptionState(current.effect_json) === 'attached') return
    if (!this.options.runtime?.adoptAgentHomeForkSession) {
      throw new UnsupportedError('provider fork adoption is unavailable in this daemon')
    }

    await this.options.runtime.adoptAgentHomeForkSession(parent, child, {
      actionId: current.id,
      reservedSessionId: current.result_session_id,
    })

    const attach = this.db.transaction(() => {
      const latest = this.requireAction(current.id)
      if (latest.status === 'succeeded'
        && forkAdoptionState(latest.effect_json) === 'attached') return
      if (latest.status !== 'pending'
        || latest.effect_state !== 'applied'
        || latest.result_session_id !== child.id
        || latest.reserved_session_id !== child.id) {
        throw new ConflictError('fork action changed during exact-child adoption')
      }
      const durableChild = this.conversations.requireSession(child.id)
      assertExactForkChild(parent, durableChild, latest, target)
      const effect = closedAppliedForkEffect(latest.effect_json, target, 'attached')
      const context = {
        parent_session_id: parent.id,
        lineage_type: 'fork',
        fork_action_id: latest.id,
        adoption_state: 'attached',
      }
      const recovery = {
        state: 'adopted_native_fork',
        source_session_id: parent.id,
        source_provider_thread_id: effect.source_provider_thread_id,
        provider_thread_id: effect.provider_thread_id,
        ...effect.provenance,
      }
      const at = timestamp()
      const updatedChild = this.db.prepare(`UPDATE agent_sessions
        SET status='idle', control_state='active', context_json=?,
          recovery_state='attachable', recovery_json=?, updated_at=?
        WHERE id=? AND parent_session_id=? AND lineage_type='fork'
          AND workspace_id=? AND external_id=? AND provider_thread_id=?`).run(
        JSON.stringify(context),
        JSON.stringify(recovery),
        at,
        durableChild.id,
        parent.id,
        target.workspaceId,
        durableChild.external_id,
        durableChild.provider_thread_id,
      )
      if (updatedChild.changes !== 1) {
        throw new ConflictError('fork child binding changed during adoption')
      }
      const updatedAction = this.db.prepare(`UPDATE agent_session_actions
        SET effect_json=?, updated_at=?
        WHERE id=? AND status='pending' AND effect_state='applied'
          AND result_session_id=? AND reserved_session_id=?`).run(
        JSON.stringify(effect),
        at,
        latest.id,
        durableChild.id,
        durableChild.id,
      )
      if (updatedAction.changes !== 1) {
        throw new ConflictError('fork adoption state changed concurrently')
      }
    })
    attach.immediate()
  }

  private markApplied(actionId: string, resultSessionId: string): ActionRow {
    const current = this.requireAction(actionId)
    if (current.status !== 'pending') return current
    if (current.result_session_id && current.result_session_id !== resultSessionId) {
      throw new ConflictError('session action already recorded a different applied result')
    }
    this.db.prepare(`UPDATE agent_session_actions
      SET result_session_id=coalesce(result_session_id, ?), effect_state='applied',
        updated_at=? WHERE id=? AND status='pending'`).run(
      resultSessionId,
      timestamp(),
      actionId,
    )
    return this.requireAction(actionId)
  }

  private markOutcomeUnknown(actionId: string, error?: unknown): ActionRow {
    const before = this.requireAction(actionId)
    if (before.status !== 'pending' || before.result_session_id) return before
    const beforeTarget = this.conversations.requireSession(before.session_id)
    const known = error instanceof AgentHomeForkOutcomeUnknownError
      ? error.knownChild
      : knownForkChildFromEffect(before.effect_json)
    const priorEffect = parseJson<Record<string, unknown>>(before.effect_json, {})
    const priorTarget = forkTargetFromEffect(priorEffect)
    const effect = {
      outcome: 'unknown',
      source_session_id: beforeTarget.id,
      provider: beforeTarget.provider,
      ...(priorTarget
        ? { fork_target: { workspace_id: priorTarget.workspaceId } }
        : {}),
      ...(known ? {
        quarantined_child: {
          external_id: known.externalId,
          provider_thread_id: known.providerThreadId,
          forked_from_id: known.forkedFromId,
          provider_session_id: known.childProviderSessionId,
          subscription_released: known.subscriptionReleased,
        },
      } : {}),
    }
    if (known) {
      // Preserve the closed, non-secret child identity before reporting. If the
      // attention/event transaction is unavailable, restart reconciliation can
      // still quarantine the exact provider child without invoking fork again.
      this.db.prepare(`UPDATE agent_session_actions SET effect_json=?, updated_at=?
        WHERE id=? AND status='pending' AND effect_state='invoking'
          AND result_session_id IS NULL`).run(
        JSON.stringify(effect),
        timestamp(),
        actionId,
      )
    }
    const quarantine = (eventKey: string) => this.db.transaction(() => {
      const current = this.requireAction(actionId)
      if (current.status !== 'pending' || current.result_session_id) return current
      const target = this.conversations.requireSession(current.session_id)
      const message = 'provider fork outcome is unknown and requires operator reconciliation'
      const updated = this.db.prepare(`UPDATE agent_session_actions
        SET status='failed', effect_state='outcome_unknown', effect_json=?,
          error_code='action_outcome_unknown', error_message=?, updated_at=?
        WHERE id=? AND status='pending' AND result_session_id IS NULL`).run(
        JSON.stringify(effect),
        message,
        timestamp(),
        actionId,
      )
      if (updated.changes !== 1) return this.requireAction(actionId)
      const eventScope = durableSessionEventScope(this.db, target, {
        expectedBoardId: current.board_id,
        expectedWorkspaceId: target.workspace_id,
      })
      this.attention.create({
        boardId: eventScope.boardId,
        workspaceId: eventScope.workspaceId,
        cardId: eventScope.cardId,
        agentId: target.agent_id,
        kind: 'agent_session.fork_outcome_unknown',
        severity: 'high',
        title: forkAttentionTitle(current),
        detail: known
          ? 'The provider returned a child identity that was quarantined because lineage verification did not complete.'
          : 'The provider invocation may have created a child, but no verified child identity was durably confirmed.',
      })
      this.events.append({
        boardId: eventScope.boardId,
        workspaceId: eventScope.workspaceId,
        cardId: eventScope.cardId,
        sessionId: target.id,
        jobId: eventScope.jobId,
        contractId: eventScope.contractId,
        correlationId: eventScope.correlationId ?? current.id,
        idempotencyKey: eventKey,
        kind: 'agent_session.action_outcome_unknown',
        source: 'agent-home',
        payload: {
          action_id: current.id,
          action: current.action,
          session_id: target.id,
          quarantined_child_known: known !== null,
        },
      })
      return this.requireAction(actionId)
    }).immediate()
    const eventKey = `agent-home-action-outcome-unknown:${actionId}`
    try {
      return quarantine(eventKey)
    } catch (caught) {
      if (!isEventIdempotencyConflict(caught)) throw caught
      return quarantine(`${eventKey}:${randomUUID()}`)
    }
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
    if (row.action === 'fork' && forkAdoptionState(row.effect_json) !== 'attached') {
      throw new ConflictError('fork action cannot complete before exact-child adoption')
    }
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
      const eventScope = durableSessionEventScope(
        this.db,
        target,
        {
          expectedBoardId: current.board_id,
          expectedWorkspaceId: target.workspace_id,
        },
      )
      this.events.append({
        boardId: eventScope.boardId,
        workspaceId: eventScope.workspaceId,
        cardId: eventScope.cardId,
        sessionId: target.id,
        jobId: eventScope.jobId,
        contractId: eventScope.contractId,
        correlationId: eventScope.correlationId ?? request?.correlation_id ?? current.id,
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
        SET status='succeeded', effect_state='completed',
          error_code=NULL, error_message=NULL, updated_at=?
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
    this.db.prepare(`UPDATE agent_session_actions
      SET status='failed', effect_state='completed', error_code=?,
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
    for (const action of stale.filter((candidate) =>
      candidate.action === 'fork'
      && candidate.effect_state === 'invoking'
      && candidate.result_session_id === null)) {
      try {
        this.markOutcomeUnknown(action.id)
      } catch {
        // Keep the invoking ledger row intact when durable quarantine reporting fails.
        // A later replay or daemon restart must never repeat the provider mutation.
      }
    }
    const interrupted = stale.filter((candidate) =>
      candidate.result_session_id === null
      && !(candidate.action === 'fork' && candidate.effect_state === 'invoking'))
    if (!interrupted.length) return
    const reconcile = this.db.transaction(() => {
      for (const action of interrupted) {
        const message = `session ${action.action} action was interrupted by a daemon restart`
        const updated = this.db.prepare(`UPDATE agent_session_actions
          SET status='failed', effect_state='completed',
            error_code='action_interrupted', error_message=?, updated_at=?
          WHERE id=? AND status='pending' AND lease_id!=?`).run(
          message,
          timestamp(),
          action.id,
          this.actionLeaseId,
        )
        if (updated.changes !== 1) continue
        const session = this.conversations.requireSession(action.session_id)
        const eventScope = durableSessionEventScope(this.db, session, {
          expectedBoardId: action.board_id,
          expectedWorkspaceId: session.workspace_id,
        })
        this.events.append({
          boardId: eventScope.boardId,
          workspaceId: eventScope.workspaceId,
          cardId: eventScope.cardId,
          sessionId: action.session_id,
          jobId: eventScope.jobId,
          contractId: eventScope.contractId,
          correlationId: eventScope.correlationId ?? action.id,
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

function knownForkChildFromEffect(
  effectJson: string,
): AgentHomeForkOutcomeUnknownError['knownChild'] {
  const effect = parseJson<Record<string, unknown>>(effectJson, {})
  const value = effect.quarantined_child
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const child = value as Record<string, unknown>
  const externalId = typeof child.external_id === 'string'
    ? child.external_id.trim()
    : ''
  const providerThreadId = typeof child.provider_thread_id === 'string'
    ? child.provider_thread_id.trim()
    : ''
  const forkedFromId = child.forked_from_id == null
    ? null
    : typeof child.forked_from_id === 'string' && child.forked_from_id.trim()
      ? child.forked_from_id.trim()
      : undefined
  const childProviderSessionId = child.provider_session_id == null
    ? null
    : typeof child.provider_session_id === 'string' && child.provider_session_id.trim()
      ? child.provider_session_id.trim()
      : undefined
  if (!externalId || providerThreadId !== externalId
    || forkedFromId === undefined
    || childProviderSessionId === undefined
    || typeof child.subscription_released !== 'boolean') {
    return null
  }
  return {
    externalId,
    providerThreadId,
    forkedFromId,
    childProviderSessionId,
    subscriptionReleased: child.subscription_released,
  }
}

function outcomeUnknownFromReturnedFork(
  parent: AgentSessionRecord,
  fork: AgentHomeNativeForkResult,
): AgentHomeForkOutcomeUnknownError {
  return new AgentHomeForkOutcomeUnknownError(
    'provider fork returned a child that could not be durably adopted',
    parent.external_id ?? fork.sourceExternalId,
    parent.provider_thread_id ?? fork.sourceProviderThreadId,
    {
      externalId: fork.externalId,
      providerThreadId: fork.providerThreadId,
      forkedFromId: parent.provider_thread_id ?? parent.external_id,
      childProviderSessionId: null,
      subscriptionReleased: fork.provenance.subscription_released === true,
    },
  )
}

function forkAttentionTitle(action: Pick<ActionRow, 'id' | 'session_id'>): string {
  return `Fork outcome for session ${action.session_id} (action ${action.id})`
}

function forkAdoptionState(effectJson: string): 'pending' | 'attached' | null {
  const effect = parseJson<Record<string, unknown>>(effectJson, {})
  const adoption = effect.adoption
  if (!adoption || typeof adoption !== 'object' || Array.isArray(adoption)) return null
  const state = (adoption as Record<string, unknown>).state
  return state === 'pending' || state === 'attached' ? state : null
}

function assertExactForkChild(
  parent: AgentSessionRecord,
  child: AgentSessionRecord,
  action: ActionRow,
  target: AgentHomeForkTarget,
): void {
  if (action.session_id !== parent.id
    || !action.reserved_session_id
    || action.reserved_session_id !== child.id
    || action.result_session_id !== child.id
    || child.parent_session_id !== parent.id
    || child.lineage_type !== 'fork'
    || child.workspace_id !== target.workspaceId
    || child.workspace_id === parent.workspace_id
    || child.provider !== parent.provider
    || !child.external_id
    || !child.provider_thread_id
    || child.provider_thread_id !== child.external_id
    || child.external_id === parent.external_id
    || child.provider_thread_id === parent.provider_thread_id
    || !child.conversation_id
    || child.conversation_id === parent.conversation_id) {
    throw new ConflictError('fork child does not match its exact isolated reservation')
  }
}

type ClosedAppliedForkEffect = {
  child_session_id: string
  child_conversation_id: string
  source_session_id: string
  provider: string
  source_provider_thread_id: string
  provider_thread_id: string
  fork_target: { workspace_id: string }
  adoption: { state: 'pending' | 'attached' }
  provenance: Record<string, boolean | string>
}

function closedAppliedForkEffect(
  effectJson: string,
  target: AgentHomeForkTarget,
  adoptionState: 'pending' | 'attached',
): ClosedAppliedForkEffect {
  const effect = parseJson<Record<string, unknown>>(effectJson, {})
  const rawProvenance = effect.provenance
  if (!rawProvenance || typeof rawProvenance !== 'object'
    || Array.isArray(rawProvenance)) {
    throw new ConflictError('fork action provenance is missing')
  }
  const provenance = rawProvenance as Record<string, unknown>
  const historyBoundary = provenance.history_boundary
  if (historyBoundary !== 'full' && historyBoundary !== 'partial') {
    throw new ConflictError('fork action history boundary is invalid')
  }
  let closedProvenance: Record<string, boolean | string>
  if (provenance.fork_method === 'thread/fork'
    && typeof provenance.read_verified === 'boolean'
    && typeof provenance.subscription_released === 'boolean') {
    closedProvenance = {
      fork_method: 'thread/fork',
      history_boundary: historyBoundary,
      read_verified: provenance.read_verified,
      subscription_released: provenance.subscription_released,
    }
  } else if (provenance.fork_method === 'sdk.forkSession'
    && provenance.file_history_copied === false
    && provenance.undo_history_copied === false) {
    closedProvenance = {
      fork_method: 'sdk.forkSession',
      history_boundary: historyBoundary,
      file_history_copied: false,
      undo_history_copied: false,
    }
  } else {
    throw new ConflictError('fork action provenance is outside the closed contract')
  }
  return {
    child_session_id: requiredEffectString(effect, 'child_session_id'),
    child_conversation_id: requiredEffectString(effect, 'child_conversation_id'),
    source_session_id: requiredEffectString(effect, 'source_session_id'),
    provider: requiredEffectString(effect, 'provider'),
    source_provider_thread_id: requiredEffectString(effect, 'source_provider_thread_id'),
    provider_thread_id: requiredEffectString(effect, 'provider_thread_id'),
    fork_target: { workspace_id: target.workspaceId },
    adoption: { state: adoptionState },
    provenance: closedProvenance,
  }
}

function requiredEffectString(effect: Record<string, unknown>, field: string): string {
  const value = effect[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConflictError(`fork action ${field} is invalid`)
  }
  return value.trim()
}

function canonicalFilesystemPath(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
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

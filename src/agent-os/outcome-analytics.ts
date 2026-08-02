import { createHash, createHmac, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { applyOutcomeAnalyticsMigration } from './outcome-analytics-migration.js'
import { ProviderAcceptanceEvidenceStoreV1 } from '../provider-acceptance-evidence-store.js'

export type BillingMode = 'subscription' | 'api' | 'unknown'
export type CachedInputSemantics = 'subset' | 'additive'
export type OutcomeActivityCategory =
  | 'context.selected' | 'context.reused' | 'context.rejected' | 'context.refreshed'
  | 'coordination.wake' | 'coordination.fanout' | 'coordination.model_ack'
  | 'exploration.file_read' | 'exploration.duplicate'
  | 'result.first_useful' | 'delivery.evidence_gap' | 'delivery.retry'
  | 'delivery.human_override'
export type BudgetScopeKind = 'project' | 'team' | 'job'
export type BudgetEnforcement = 'soft' | 'hard'

export interface UsageObservationInput {
  id: string
  boardId: number
  sessionId: string
  jobId: string
  operationId?: string | null
  teamId?: string | null
  provider: string
  billingMode: BillingMode
  cachedInputSemantics: CachedInputSemantics
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  thinkingTokens?: number
  contextInjectionTokens?: number | null
  providerTotalTokens?: number
  observedAt?: string
}

export interface ActivityObservationInput {
  id: string
  boardId: number
  category: OutcomeActivityCategory
  sessionId?: string | null
  jobId?: string | null
  teamId?: string | null
  quantity?: number
  /** Raw identity is hashed before persistence and never returned. */
  resourceIdentity?: string | null
  occurredAt?: string
}

export interface ClaudeNativeReadObservationInput {
  identityHash: string
  boardId: number
  sessionId: string
  jobId: string
  inputFingerprint: string
  occurredAt: string
}

export interface BudgetPolicyInput {
  id: string
  boardId: number
  scopeKind: BudgetScopeKind
  scopeId: string
  maxProviderTokens?: number | null
  maxContextTokens?: number | null
  maxFanout?: number | null
  maxPlanningRoundTokens?: number | null
  warningMilli?: number
  enforcement: BudgetEnforcement
  actor: string
}

export interface OperationPlanInput {
  id: string
  boardId: number
  operationKind: 'swarm' | 'planning_round'
  fanout: number
  estimatedTokens: number
  reason: string
  requestedBy: string
  /** Opaque native execution identity. Only its SHA-256 digest is persisted. */
  executionKey: string
  teamId?: string | null
  jobId?: string | null
  ttlSeconds?: number
}

export interface OperationExecutionInput {
  id: string
  executionKey: string
  actor: string
  providerTokens: number
  contextTokens?: number | null
  fanout: number
  planningRoundTokens?: number
  at?: string
}

export interface BenchmarkObservationInput {
  id: string
  boardId: number
  suiteKey: string
  scenarioKey: string
  variant: 'before' | 'after'
  providerTokens: number
  contextTokens: number
  acceptedDeliveries: number
  qualityMilli: number
  durationMs: number
  evidenceRef: string
  observedAt?: string
}

export interface DashboardWindow {
  since?: string
  until?: string
}

const MAX_ID = 200
const MAX_TEXT = 1_000
const SHA256 = /^[a-f0-9]{64}$/u
const DEFAULT_HIGH_FANOUT = 8
const DEFAULT_COSTLY_PLANNING_TOKENS = 50_000
const CLAUDE_NATIVE_READ_ID_PREFIX = 'claude-native-read:'

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
}

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

const requestHash = (value: unknown): string => sha256(canonical(value))

const bounded = (value: unknown, field: string, maximum = MAX_TEXT): string => {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new ValidationError(`${field} is invalid`)
  }
  return normalized
}

const identifier = (value: unknown, field = 'id'): string =>
  bounded(value, field, MAX_ID)

const count = (value: unknown, field: string, maximum = 1_000_000_000_000): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new ValidationError(`${field} must be a bounded non-negative integer`)
  }
  return Number(value)
}

const positiveCount = (value: unknown, field: string, maximum = 1_000_000): number => {
  const normalized = count(value, field, maximum)
  if (normalized === 0) throw new ValidationError(`${field} must be positive`)
  return normalized
}

const timestamp = (value: unknown, field: string): string => {
  const normalized = bounded(value, field, 100)
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) throw new ValidationError(`${field} must be an ISO timestamp`)
  return parsed.toISOString()
}

const now = (): string => new Date().toISOString()

const numberValue = (value: unknown): number => Number(value ?? 0)

interface JobScope {
  board_id: number
  card_id: number
  contract_version: number | null
  session_job_id: string | null
  session_workspace_id: string
  job_workspace_id: string
  job_provider: string
  session_provider: string
  job_driver_id: string | null
  session_driver_id: string | null
  job_profile_id: string | null
  session_profile_id: string | null
  job_created_at: string
  session_created_at: string
  session_context_json: string
}

interface ProviderEvidenceBinding {
  evidence_id: string
  provider_id: string
  adapter_id: string
  mode_id: string
  runtime_mode: string
  billing_mode: 'personal_subscription' | 'usage_priced_api'
  platform: string
  source_commit: string
  evidence_sha256: string
}

interface OperationUsageReconciliation {
  operation_id: string
  provisional_provider_tokens: number
  provisional_context_tokens: number
  actual_provider_tokens: number
  actual_context_tokens: number | null
  provider_variance_tokens: number
  context_variance_tokens: number | null
  plan_overage_tokens: number | null
}

interface BudgetRow {
  id: string
  scope_kind: BudgetScopeKind
  scope_id: string
  max_provider_tokens: number | null
  max_context_tokens: number | null
  max_fanout: number | null
  max_planning_round_tokens: number | null
  warning_milli: number
  enforcement: BudgetEnforcement
}

export class OutcomeAnalyticsService {
  constructor(private readonly db: Database.Database) {
    applyOutcomeAnalyticsMigration(db)
  }

  recordUsage(input: UsageObservationInput): Record<string, unknown> {
    const scope = this.jobScope(input.boardId, input.jobId, input.sessionId)
    const id = identifier(input.id)
    const observedAt = this.validScopedTimestamp(
      this.observationTimestamp(
        'outcome_usage_observations', id, 'observed_at', input.observedAt, 'observed at',
      ),
      scope,
      'observed at',
    )
    const canonicalProvider = this.canonicalProvider(scope, input.provider)
    const canonicalBilling = this.canonicalBillingMode(scope, canonicalProvider, observedAt)
    if (billingMode(input.billingMode) !== canonicalBilling.mode) {
      throw new ValidationError('billing mode is not supported by canonical provider evidence')
    }
    const operationId = input.operationId == null
      ? null : identifier(input.operationId, 'operation id')
    const normalized = {
      id,
      board_id: positiveBoard(input.boardId),
      team_id: this.canonicalTeam(input.boardId, input.teamId, scope, observedAt),
      session_id: identifier(input.sessionId, 'session id'),
      job_id: identifier(input.jobId, 'job id'),
      contract_ref: this.contractRef(scope),
      provider: canonicalProvider,
      billing_mode: canonicalBilling.mode,
      operation_id: operationId,
      provider_evidence_id: canonicalBilling.binding?.evidence_id ?? null,
      cached_input_semantics: cachedSemantics(input.cachedInputSemantics),
      input_tokens: count(input.inputTokens, 'input tokens'),
      cached_input_tokens: count(input.cachedInputTokens, 'cached input tokens'),
      output_tokens: count(input.outputTokens, 'output tokens'),
      thinking_tokens: count(input.thinkingTokens ?? 0, 'thinking tokens'),
      context_injection_tokens: input.contextInjectionTokens == null
        ? null : count(input.contextInjectionTokens, 'context injection tokens'),
      observed_at: observedAt,
    }
    if (normalized.thinking_tokens > normalized.output_tokens) {
      throw new ValidationError('thinking tokens cannot exceed output tokens')
    }
    if (normalized.cached_input_semantics === 'subset'
      && normalized.cached_input_tokens > normalized.input_tokens) {
      throw new ValidationError('subset cached input cannot exceed input tokens')
    }
    const minimumTotal = normalized.input_tokens + normalized.output_tokens
      + (normalized.cached_input_semantics === 'additive' ? normalized.cached_input_tokens : 0)
    const providerTotal = input.providerTotalTokens === undefined
      ? minimumTotal : count(input.providerTotalTokens, 'provider total tokens')
    if (providerTotal < minimumTotal) {
      throw new ValidationError('provider total tokens are inconsistent with the token split')
    }
    const hash = requestHash({ ...normalized, provider_total_tokens: providerTotal })
    const prior = this.replayed('outcome_usage_observations', normalized.id, hash)
    if (prior) return this.usageResult(normalized.id)
    const createdAt = now()
    const transaction = this.db.transaction(() => {
      const consumption = operationId === null
        ? this.requireNoUnlinkedOperation(
          normalized.board_id, normalized.team_id, normalized.job_id, observedAt,
        )
        : this.operationUsageConsumption(
          operationId, normalized.id, normalized.board_id, normalized.team_id, normalized.job_id,
          providerTotal, normalized.context_injection_tokens, observedAt,
        )
      this.db.prepare(`INSERT INTO outcome_usage_observations
        (id, request_sha256, board_id, team_id, session_id, job_id, contract_ref,
         provider, billing_mode, cached_input_semantics, input_tokens, cached_input_tokens,
         output_tokens, thinking_tokens, context_injection_tokens, provider_total_tokens,
         observed_at, created_at)
        VALUES (@id, @request_sha256, @board_id, @team_id, @session_id, @job_id,
         @contract_ref, @provider, @billing_mode, @cached_input_semantics, @input_tokens,
         @cached_input_tokens, @output_tokens, @thinking_tokens, @context_injection_tokens,
         @provider_total_tokens, @observed_at, @created_at)`)
        .run({
          ...normalized,
          request_sha256: hash,
          context_injection_tokens: normalized.context_injection_tokens ?? 0,
          provider_total_tokens: providerTotal,
          created_at: createdAt,
        })
      this.db.prepare(`INSERT INTO outcome_usage_context_receipts
        (usage_id, availability, exact_tokens, created_at) VALUES (?, ?, ?, ?)`).run(
        normalized.id,
        normalized.context_injection_tokens === null ? 'unavailable' : 'exact',
        normalized.context_injection_tokens,
        createdAt,
      )
      if (canonicalBilling.binding) {
        this.db.prepare(`INSERT INTO outcome_usage_provider_bindings
          (usage_id, evidence_id, provider_id, adapter_id, mode_id, runtime_mode,
           billing_mode, platform, source_commit, evidence_sha256, created_at)
          VALUES (@usage_id, @evidence_id, @provider_id, @adapter_id, @mode_id,
           @runtime_mode, @billing_mode, @platform, @source_commit, @evidence_sha256,
           @created_at)`).run({
          usage_id: normalized.id,
          ...canonicalBilling.binding,
          created_at: createdAt,
        })
      }
      if (consumption) {
        this.db.prepare(`INSERT INTO outcome_operation_usage_links
          (operation_id, usage_id, linked_at) VALUES (?, ?, ?)`)
          .run(consumption.operation_id, normalized.id, createdAt)
        this.db.prepare(`INSERT INTO outcome_operation_usage_reconciliations
          (operation_id, provisional_provider_tokens, provisional_context_tokens,
           actual_provider_tokens, actual_context_tokens, provider_variance_tokens,
           context_variance_tokens, plan_overage_tokens, created_at)
          VALUES (@operation_id, @provisional_provider_tokens, @provisional_context_tokens,
           @actual_provider_tokens, @actual_context_tokens, @provider_variance_tokens,
           @context_variance_tokens, @plan_overage_tokens, @created_at)`)
          .run({
            ...consumption,
            actual_context_tokens: consumption.actual_context_tokens ?? 0,
            context_variance_tokens: consumption.context_variance_tokens ?? 0,
            plan_overage_tokens: consumption.plan_overage_tokens ?? 0,
            created_at: createdAt,
          })
      }
    })
    transaction.immediate()
    return this.usageResult(normalized.id)
  }

  recordActivity(input: ActivityObservationInput): Record<string, unknown> {
    if (identifier(input.id).startsWith(CLAUDE_NATIVE_READ_ID_PREFIX)) {
      throw new ValidationError('activity id is reserved for the Claude-native runtime')
    }
    return this.recordActivityObservation(input)
  }

  recordClaudeNativeRead(input: ClaudeNativeReadObservationInput): {
    read: Record<string, unknown>
    duplicate: Record<string, unknown> | null
  } {
    if (!SHA256.test(input.identityHash) || !SHA256.test(input.inputFingerprint)) {
      throw new ValidationError('Claude-native Read provenance is invalid')
    }
    const readId = `${CLAUDE_NATIVE_READ_ID_PREFIX}${input.identityHash}`
    const persist = this.db.transaction(() => {
      const retainedRead = this.db.prepare(`SELECT occurred_at
        FROM outcome_activity_observations WHERE id=?`).get(readId) as
        { occurred_at: string } | undefined
      const read = this.recordActivityObservation({
        id: readId,
        boardId: input.boardId,
        sessionId: input.sessionId,
        jobId: input.jobId,
        category: 'exploration.file_read',
        resourceIdentity: input.inputFingerprint,
        occurredAt: retainedRead?.occurred_at ?? input.occurredAt,
      })
      const resourceHash = read.resource_sha256
      if (typeof resourceHash !== 'string') return { read, duplicate: null }
      const prior = this.db.prepare(`SELECT 1
        FROM outcome_activity_observations current_observation
        JOIN outcome_activity_observations previous_observation
          ON previous_observation.board_id=current_observation.board_id
          AND previous_observation.session_id=current_observation.session_id
          AND previous_observation.job_id=current_observation.job_id
          AND previous_observation.category='exploration.file_read'
          AND previous_observation.resource_sha256=current_observation.resource_sha256
          AND previous_observation.rowid<current_observation.rowid
        WHERE current_observation.id=? AND current_observation.resource_sha256=? LIMIT 1`)
        .get(readId, resourceHash)
      if (!prior) return { read, duplicate: null }
      const duplicateId = `${readId}:duplicate`
      const retainedDuplicate = this.db.prepare(`SELECT occurred_at
        FROM outcome_activity_observations WHERE id=?`).get(duplicateId) as
        { occurred_at: string } | undefined
      const duplicate = this.recordActivityObservation({
        id: duplicateId,
        boardId: input.boardId,
        sessionId: input.sessionId,
        jobId: input.jobId,
        category: 'exploration.duplicate',
        resourceIdentity: input.inputFingerprint,
        occurredAt: retainedDuplicate?.occurred_at ?? String(read.occurred_at),
      })
      return { read, duplicate }
    })
    return persist.immediate()
  }

  private recordActivityObservation(input: ActivityObservationInput): Record<string, unknown> {
    const boardId = positiveBoard(input.boardId)
    const id = identifier(input.id)
    const jobId = input.jobId == null ? null : identifier(input.jobId, 'job id')
    const sessionId = input.sessionId == null ? null : identifier(input.sessionId, 'session id')
    let contractRef: string | null = null
    let scope: JobScope | null = null
    if ((jobId === null) !== (sessionId === null)) {
      throw new ValidationError('job id and session id must be supplied together')
    }
    if (jobId && sessionId) {
      scope = this.jobScope(boardId, jobId, sessionId)
      contractRef = this.contractRef(scope)
    }
    const category = activityCategory(input.category)
    const resource = input.resourceIdentity == null
      ? null : bounded(input.resourceIdentity, 'resource identity', 4_096)
    if ((category === 'exploration.file_read' || category === 'exploration.duplicate') && !resource) {
      throw new ValidationError('exploration observations require a resource identity')
    }
    const occurredAt = this.observationTimestamp(
      'outcome_activity_observations', id, 'occurred_at', input.occurredAt, 'occurred at',
    )
    if (Date.parse(occurredAt) > Date.now() + 5 * 60_000) {
      throw new ValidationError('occurred at is in the future')
    }
    if (scope) this.validScopedTimestamp(occurredAt, scope, 'occurred at')
    const normalized = {
      id,
      board_id: boardId,
      team_id: this.canonicalTeam(boardId, input.teamId, scope, occurredAt),
      session_id: sessionId,
      job_id: jobId,
      contract_ref: contractRef,
      category,
      quantity: positiveCount(input.quantity ?? 1, 'quantity'),
      resource_sha256: resource === null ? null : this.resourceHmac(resource),
      occurred_at: occurredAt,
    }
    const hash = requestHash(normalized)
    const prior = this.replayed('outcome_activity_observations', normalized.id, hash)
    if (prior) return prior
    this.db.prepare(`INSERT INTO outcome_activity_observations
      (id, request_sha256, board_id, team_id, session_id, job_id, contract_ref,
       category, quantity, resource_sha256, occurred_at, created_at)
      VALUES (@id, @request_sha256, @board_id, @team_id, @session_id, @job_id,
       @contract_ref, @category, @quantity, @resource_sha256, @occurred_at, @created_at)`)
      .run({ ...normalized, request_sha256: hash, created_at: now() })
    return this.row('outcome_activity_observations', normalized.id)
  }

  setBudget(input: BudgetPolicyInput): Record<string, unknown> {
    const normalized = {
      id: identifier(input.id),
      board_id: positiveBoard(input.boardId),
      scope_kind: budgetScope(input.scopeKind),
      scope_id: identifier(input.scopeId, 'scope id'),
      max_provider_tokens: optionalPositive(input.maxProviderTokens, 'max provider tokens'),
      max_context_tokens: optionalPositive(input.maxContextTokens, 'max context tokens'),
      max_fanout: optionalPositive(input.maxFanout, 'max fanout', 1_000_000),
      max_planning_round_tokens: optionalPositive(
        input.maxPlanningRoundTokens,
        'max planning round tokens',
      ),
      warning_milli: positiveCount(input.warningMilli ?? 800, 'warning milli', 1_000),
      enforcement: budgetEnforcement(input.enforcement),
      created_by: bounded(input.actor, 'actor', 256),
    }
    if ([normalized.max_provider_tokens, normalized.max_context_tokens, normalized.max_fanout,
      normalized.max_planning_round_tokens].every((value) => value === null)) {
      throw new ValidationError('budget must define at least one limit')
    }
    this.validateBudgetScope(normalized.board_id, normalized.scope_kind, normalized.scope_id)
    const existingById = this.db.prepare(`SELECT * FROM outcome_budget_policies WHERE id=?`)
      .get(normalized.id) as Record<string, unknown> | undefined
    if (existingById) {
      const comparable = pickBudget(existingById)
      if (canonical(comparable) !== canonical(normalized)) {
        throw new ConflictError('budget id is already bound to another policy')
      }
      return existingById
    }
    const createdAt = now()
    const transaction = this.db.transaction(() => {
      this.db.prepare(`UPDATE outcome_budget_policies SET superseded_at=?
        WHERE board_id=? AND scope_kind=? AND scope_id=? AND superseded_at IS NULL`)
        .run(createdAt, normalized.board_id, normalized.scope_kind, normalized.scope_id)
      this.db.prepare(`INSERT INTO outcome_budget_policies
        (id, board_id, scope_kind, scope_id, max_provider_tokens, max_context_tokens,
         max_fanout, max_planning_round_tokens, warning_milli, enforcement,
         created_by, created_at, superseded_at)
        VALUES (@id, @board_id, @scope_kind, @scope_id, @max_provider_tokens,
         @max_context_tokens, @max_fanout, @max_planning_round_tokens, @warning_milli,
         @enforcement, @created_by, @created_at, NULL)`)
        .run({ ...normalized, created_at: createdAt })
    })
    transaction.immediate()
    return this.row('outcome_budget_policies', normalized.id)
  }

  evaluateBudgets(input: {
    boardId: number
    jobId?: string | null
    teamId?: string | null
    additionalProviderTokens?: number
    additionalContextTokens?: number | null
    fanout?: number
    planningRoundTokens?: number
  }): Record<string, unknown> {
    const boardId = positiveBoard(input.boardId)
    const jobId = input.jobId == null ? null : identifier(input.jobId, 'job id')
    const teamId = this.optionalTeam(boardId, input.teamId)
    if (jobId) this.jobInBoard(boardId, jobId)
    const policies = this.activeBudgets(boardId, teamId, jobId)
    const projections = {
      provider_tokens: count(input.additionalProviderTokens ?? 0, 'additional provider tokens'),
      context_tokens: input.additionalContextTokens === null
        ? null : count(input.additionalContextTokens ?? 0, 'additional context tokens'),
      fanout: count(input.fanout ?? 0, 'fanout', 1_000_000),
      planning_round_tokens: count(input.planningRoundTokens ?? 0, 'planning round tokens'),
    }
    const evaluations = policies.map((policy) => {
      const used = this.budgetUsage(boardId, policy, teamId, jobId)
      const dimensions = [
        dimension('provider_tokens', used.provider_tokens + projections.provider_tokens, policy.max_provider_tokens, policy.warning_milli),
        dimension('context_tokens', used.context_tokens === null || projections.context_tokens === null
          ? null : used.context_tokens + projections.context_tokens,
        policy.max_context_tokens, policy.warning_milli),
        dimension('fanout', used.fanout + projections.fanout, policy.max_fanout, policy.warning_milli),
        dimension('planning_round_tokens', used.planning_round_tokens + projections.planning_round_tokens, policy.max_planning_round_tokens, policy.warning_milli),
      ].filter((item) => item.limit !== null)
      const exceeded = dimensions.some((item) => item.exceeded)
      const unavailable = dimensions.some((item) => !item.available)
      return {
        policy_id: policy.id,
        scope_kind: policy.scope_kind,
        scope_id: policy.scope_id,
        enforcement: policy.enforcement,
        warning: dimensions.some((item) => item.warning) || unavailable,
        exceeded,
        allowed: !((exceeded || unavailable) && policy.enforcement === 'hard'),
        dimensions,
      }
    })
    return {
      board_id: boardId,
      policies: evaluations,
      allowed: evaluations.every((item) => item.allowed),
      warning: evaluations.some((item) => item.warning),
      projected: projections,
    }
  }

  planOperation(input: OperationPlanInput): Record<string, unknown> {
    const boardId = positiveBoard(input.boardId)
    const teamId = this.optionalTeam(boardId, input.teamId)
    const jobId = input.jobId == null ? null : identifier(input.jobId, 'job id')
    if (jobId) this.jobInBoard(boardId, jobId)
    const operationKind = input.operationKind === 'swarm' || input.operationKind === 'planning_round'
      ? input.operationKind : invalid<'swarm'>('operation kind is invalid')
    const normalized = {
      id: identifier(input.id),
      board_id: boardId,
      team_id: teamId,
      job_id: jobId,
      operation_kind: operationKind,
      fanout: positiveCount(input.fanout, 'fanout'),
      estimated_tokens: count(input.estimatedTokens, 'estimated tokens'),
      reason: bounded(input.reason, 'reason'),
      requested_by: bounded(input.requestedBy, 'requested by', 256),
      execution_sha256: sha256(bounded(input.executionKey, 'execution key', 4_096)),
      ttl_seconds: positiveCount(input.ttlSeconds ?? 900, 'ttl seconds', 86_400),
    }
    const evaluation = this.evaluateBudgets({
      boardId,
      jobId,
      teamId,
      fanout: normalized.fanout,
      planningRoundTokens: operationKind === 'planning_round' ? normalized.estimated_tokens : 0,
      additionalProviderTokens: normalized.estimated_tokens,
    })
    if (evaluation.allowed !== true) throw new ConflictError('operation exceeds a hard budget')
    const policies = evaluation.policies as Array<Record<string, unknown>>
    const policyRequiresConfirmation = policies.some((policy) => policy.warning === true)
    const confirmationRequired = policyRequiresConfirmation
      || normalized.fanout >= DEFAULT_HIGH_FANOUT
      || (operationKind === 'planning_round'
        && normalized.estimated_tokens >= DEFAULT_COSTLY_PLANNING_TOKENS)
    const requestedAt = now()
    const expiresAt = new Date(Date.parse(requestedAt) + normalized.ttl_seconds * 1_000).toISOString()
    const persisted = {
      id: normalized.id,
      board_id: normalized.board_id,
      team_id: normalized.team_id,
      job_id: normalized.job_id,
      operation_kind: normalized.operation_kind,
      fanout: normalized.fanout,
      estimated_tokens: normalized.estimated_tokens,
      reason: normalized.reason,
      status: confirmationRequired ? 'awaiting_confirmation' : 'not_required',
      requested_by: normalized.requested_by,
      requested_at: requestedAt,
      confirmed_by: null,
      confirmed_at: null,
      expires_at: expiresAt,
    }
    const hash = requestHash({
      ...persisted,
      execution_sha256: normalized.execution_sha256,
      requested_at: undefined,
      expires_at: undefined,
      ttl_seconds: normalized.ttl_seconds,
    })
    const prior = this.replayed('outcome_operation_confirmations', persisted.id, hash)
    if (prior) return prior
    const transaction = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO outcome_operation_confirmations
        (id, request_sha256, board_id, team_id, job_id, operation_kind, fanout,
         estimated_tokens, reason, status, requested_by, requested_at, confirmed_by,
         confirmed_at, expires_at)
        VALUES (@id, @request_sha256, @board_id, @team_id, @job_id, @operation_kind,
         @fanout, @estimated_tokens, @reason, @status, @requested_by, @requested_at,
         @confirmed_by, @confirmed_at, @expires_at)`)
        .run({ ...persisted, request_sha256: hash })
      this.db.prepare(`INSERT INTO outcome_operation_bindings
        (operation_id, execution_sha256, confirmation_required, created_at)
        VALUES (?, ?, ?, ?)`)
        .run(persisted.id, normalized.execution_sha256, confirmationRequired ? 1 : 0, requestedAt)
    })
    transaction.immediate()
    return this.row('outcome_operation_confirmations', persisted.id)
  }

  confirmOperation(id: string, actor: string, at = now()): Record<string, unknown> {
    const normalizedId = identifier(id)
    const confirmedBy = bounded(actor, 'actor', 256)
    const confirmedAt = timestamp(at, 'confirmed at')
    const row = this.row('outcome_operation_confirmations', normalizedId)
    if (row.status === 'confirmed' || row.status === 'not_required') return row
    if (row.status !== 'awaiting_confirmation') throw new ConflictError('operation cannot be confirmed')
    if (String(row.requested_at) > confirmedAt) {
      throw new ValidationError('operation cannot be confirmed before it was requested')
    }
    if (String(row.expires_at) <= confirmedAt) {
      this.db.prepare(`UPDATE outcome_operation_confirmations SET status='expired'
        WHERE id=? AND status='awaiting_confirmation'`).run(normalizedId)
      throw new ConflictError('operation confirmation expired')
    }
    this.db.prepare(`UPDATE outcome_operation_confirmations
      SET status='confirmed', confirmed_by=?, confirmed_at=?
      WHERE id=? AND status='awaiting_confirmation'`)
      .run(confirmedBy, confirmedAt, normalizedId)
    return this.row('outcome_operation_confirmations', normalizedId)
  }

  consumeOperationExecution(input: OperationExecutionInput): Record<string, unknown> {
    const operationId = identifier(input.id)
    const executionSha256 = sha256(bounded(input.executionKey, 'execution key', 4_096))
    const actor = bounded(input.actor, 'actor', 256)
    const consumedAt = timestamp(input.at ?? now(), 'consumed at')
    const actual = {
      provider_tokens: count(input.providerTokens, 'provider tokens'),
      context_tokens: input.contextTokens == null
        ? null : count(input.contextTokens, 'context tokens'),
      fanout: positiveCount(input.fanout, 'fanout'),
      planning_round_tokens: count(input.planningRoundTokens ?? 0, 'planning round tokens'),
    }
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT confirmation.*, binding.execution_sha256,
          binding.confirmation_required
        FROM outcome_operation_confirmations confirmation
        JOIN outcome_operation_bindings binding ON binding.operation_id=confirmation.id
        WHERE confirmation.id=?`).get(operationId) as Record<string, unknown> | undefined
      if (!row) throw new NotFoundError('outcome operation not found')
      if (row.execution_sha256 !== executionSha256) {
        throw new ConflictError('operation authorization is bound to another execution')
      }
      if (String(row.requested_at) > consumedAt) {
        throw new ValidationError('operation cannot execute before it was planned')
      }
      if (String(row.expires_at) <= consumedAt) throw new ConflictError('operation authorization expired')
      if (row.status !== 'not_required' && row.status !== 'confirmed') {
        throw new ConflictError('operation requires explicit confirmation')
      }
      if (this.db.prepare(`SELECT 1 FROM outcome_operation_consumptions WHERE operation_id=?`)
        .get(operationId)) throw new ConflictError('operation authorization is already consumed')
      if (row.operation_kind !== 'planning_round' && actual.planning_round_tokens !== 0) {
        throw new ValidationError('planning round tokens require a planning operation')
      }
      const actualTokenEnvelope = actual.provider_tokens + (actual.context_tokens ?? 0)
      if (actual.fanout > Number(row.fanout)
        || actualTokenEnvelope > Number(row.estimated_tokens)
        || (row.operation_kind === 'planning_round'
          && actual.planning_round_tokens > Number(row.estimated_tokens))) {
        throw new ConflictError('actual operation exceeds its confirmed plan; a new confirmation is required')
      }
      const evaluation = this.evaluateBudgets({
        boardId: Number(row.board_id),
        teamId: row.team_id == null ? null : String(row.team_id),
        jobId: row.job_id == null ? null : String(row.job_id),
        additionalProviderTokens: actual.provider_tokens,
        additionalContextTokens: actual.context_tokens,
        fanout: actual.fanout,
        planningRoundTokens: actual.planning_round_tokens,
      })
      if (evaluation.allowed !== true) {
        throw new ConflictError('operation exceeds a hard budget at execution')
      }
      const actualWarning = evaluation.warning === true
        || actual.fanout >= DEFAULT_HIGH_FANOUT
        || (row.operation_kind === 'planning_round'
          && actual.planning_round_tokens >= DEFAULT_COSTLY_PLANNING_TOKENS)
      if (actualWarning && row.status !== 'confirmed') {
        throw new ConflictError('actual operation requires a new explicit confirmation')
      }
      this.db.prepare(`INSERT INTO outcome_operation_consumptions
        (operation_id, board_id, team_id, job_id, provider_tokens, context_tokens,
         fanout, planning_round_tokens, consumed_by, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(operationId, row.board_id, row.team_id, row.job_id, actual.provider_tokens,
          actual.context_tokens ?? 0, actual.fanout, actual.planning_round_tokens, actor, consumedAt)
      this.db.prepare(`INSERT INTO outcome_operation_context_receipts
        (operation_id, availability, exact_tokens, created_at) VALUES (?, ?, ?, ?)`)
        .run(operationId, actual.context_tokens === null ? 'unavailable' : 'exact',
          actual.context_tokens, consumedAt)
      const consumption = this.db.prepare(`SELECT * FROM outcome_operation_consumptions
        WHERE operation_id=?`).get(operationId) as Record<string, unknown>
      return {
        ...row,
        execution_sha256: undefined,
        consumption: {
          ...consumption,
          context_tokens: actual.context_tokens,
          context_availability: actual.context_tokens === null ? 'unavailable' : 'exact',
          provider_context_status: 'provisional_until_canonical_usage',
        },
      }
    })
    return transaction.immediate()
  }

  createTeamDigest(input: {
    id: string
    boardId: number
    teamId: string
    leaderProfileId?: string | null
    windowStart: string
    windowEnd: string
  }): Record<string, unknown> {
    const boardId = positiveBoard(input.boardId)
    const teamId = this.optionalTeam(boardId, input.teamId)
      ?? invalid<string>('team id is required')
    const windowStart = timestamp(input.windowStart, 'window start')
    const windowEnd = timestamp(input.windowEnd, 'window end')
    if (windowEnd <= windowStart) throw new ValidationError('digest window is invalid')
    const leader = input.leaderProfileId == null
      ? null : identifier(input.leaderProfileId, 'leader profile id')
    if (leader) this.profileExists(leader)
    const metrics = this.activityCounts(boardId, windowStart, windowEnd, teamId)
    const sourceCount = Object.values(metrics).reduce((sum, value) => sum + value, 0)
    const normalized = {
      id: identifier(input.id), board_id: boardId, team_id: teamId,
      leader_profile_id: leader, window_start: windowStart, window_end: windowEnd,
      metrics_json: canonical(metrics), source_count: sourceCount,
    }
    const hash = requestHash(normalized)
    const prior = this.replayed('outcome_team_digests', normalized.id, hash)
    if (prior) return prior
    this.db.prepare(`INSERT INTO outcome_team_digests
      (id, request_sha256, board_id, team_id, leader_profile_id, window_start,
       window_end, metrics_json, source_count, created_at)
      VALUES (@id, @request_sha256, @board_id, @team_id, @leader_profile_id,
       @window_start, @window_end, @metrics_json, @source_count, @created_at)`)
      .run({ ...normalized, request_sha256: hash, created_at: now() })
    return this.row('outcome_team_digests', normalized.id)
  }

  recordBenchmark(input: BenchmarkObservationInput): Record<string, unknown> {
    const id = identifier(input.id)
    const boardId = positiveBoard(input.boardId)
    const suiteKey = identifier(input.suiteKey, 'suite key')
    const scenarioKey = identifier(input.scenarioKey, 'scenario key')
    const variant = input.variant === 'before' || input.variant === 'after'
      ? input.variant : invalid<'before'>('benchmark variant is invalid')
    const evidenceRef = bounded(input.evidenceRef, 'evidence ref')
    const evidence = this.benchmarkEvidence(boardId, evidenceRef, {
      suite_key: suiteKey,
      scenario_key: scenarioKey,
      variant,
      provider_tokens: count(input.providerTokens, 'provider tokens'),
      context_tokens: count(input.contextTokens, 'context tokens'),
      accepted_deliveries: count(input.acceptedDeliveries, 'accepted deliveries', 1_000_000),
      quality_milli: count(input.qualityMilli, 'quality milli', 1_000),
      duration_ms: count(input.durationMs, 'duration ms', 31_536_000_000),
    })
    if (input.observedAt !== undefined && timestamp(input.observedAt, 'observed at') !== evidence.observed_at) {
      throw new ValidationError('benchmark observed at must match canonical artifact time')
    }
    const normalized = {
      id,
      board_id: boardId,
      ...evidence.metrics,
      evidence_ref: evidenceRef,
      observed_at: evidence.observed_at,
      artifact_sha256: evidence.binding.artifact_sha256,
      verifier_ref: evidence.binding.verifier_ref,
      provenance_sha256: evidence.binding.provenance_sha256,
    }
    const hash = requestHash(normalized)
    const prior = this.replayed('outcome_benchmark_observations', normalized.id, hash)
    if (prior) {
      if (!this.benchmarkEvidenceCurrent(normalized.id)) {
        throw new ConflictError('benchmark evidence artifact changed after observation')
      }
      return prior
    }
    try {
      const createdAt = now()
      const transaction = this.db.transaction(() => {
        this.db.prepare(`INSERT INTO outcome_benchmark_observations
          (id, request_sha256, board_id, suite_key, scenario_key, variant,
           provider_tokens, context_tokens, accepted_deliveries, quality_milli,
           duration_ms, evidence_ref, observed_at, created_at)
          VALUES (@id, @request_sha256, @board_id, @suite_key, @scenario_key,
           @variant, @provider_tokens, @context_tokens, @accepted_deliveries,
           @quality_milli, @duration_ms, @evidence_ref, @observed_at, @created_at)`)
          .run({ ...normalized, request_sha256: hash, created_at: createdAt })
        this.db.prepare(`INSERT INTO outcome_benchmark_evidence_bindings
          (observation_id, artifact_id, artifact_sha256, evidence_version,
           verifier_ref, provenance_sha256, artifact_created_at, created_at)
          VALUES (@observation_id, @artifact_id, @artifact_sha256, @evidence_version,
           @verifier_ref, @provenance_sha256, @artifact_created_at, @created_at)`)
          .run({ observation_id: normalized.id, ...evidence.binding, created_at: createdAt })
      })
      transaction.immediate()
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new ConflictError('benchmark scenario variant is already recorded')
      }
      throw error
    }
    return this.row('outcome_benchmark_observations', normalized.id)
  }

  benchmarkComparison(boardIdInput: number, suiteKeyInput: string): Record<string, unknown> {
    const boardId = positiveBoard(boardIdInput)
    const suiteKey = identifier(suiteKeyInput, 'suite key')
    const rows = this.db.prepare(`SELECT * FROM outcome_benchmark_observations
      WHERE board_id=? AND suite_key=? ORDER BY scenario_key, variant`)
      .all(boardId, suiteKey) as Array<Record<string, unknown>>
    const scenarios = new Map<string, { before?: Record<string, unknown>; after?: Record<string, unknown> }>()
    for (const row of rows) {
      row.evidence_current = this.benchmarkEvidenceCurrent(String(row.id))
      const scenario = scenarios.get(String(row.scenario_key)) ?? {}
      scenario[row.variant as 'before' | 'after'] = row
      scenarios.set(String(row.scenario_key), scenario)
    }
    const comparisons = [...scenarios.entries()].map(([scenarioKey, pair]) => {
      if (!pair.before || !pair.after) {
        return { scenario_key: scenarioKey, complete: false, passed: false, reason: 'missing_variant' }
      }
      if (pair.before.evidence_current !== true || pair.after.evidence_current !== true) {
        return {
          scenario_key: scenarioKey,
          complete: false,
          passed: false,
          reason: 'evidence_not_current',
        }
      }
      const beforeAccepted = numberValue(pair.before.accepted_deliveries)
      const afterAccepted = numberValue(pair.after.accepted_deliveries)
      const beforeTokens = numberValue(pair.before.provider_tokens) + numberValue(pair.before.context_tokens)
      const afterTokens = numberValue(pair.after.provider_tokens) + numberValue(pair.after.context_tokens)
      const beforeRate = beforeAccepted > 0 ? beforeTokens / beforeAccepted : null
      const afterRate = afterAccepted > 0 ? afterTokens / afterAccepted : null
      const qualityGuard = numberValue(pair.after.quality_milli) >= numberValue(pair.before.quality_milli)
        && afterAccepted >= beforeAccepted
      const efficiency = beforeRate !== null && afterRate !== null && afterRate < beforeRate
      return {
        scenario_key: scenarioKey,
        complete: true,
        before_tokens_per_accepted_delivery: beforeRate,
        after_tokens_per_accepted_delivery: afterRate,
        quality_before_milli: numberValue(pair.before.quality_milli),
        quality_after_milli: numberValue(pair.after.quality_milli),
        quality_guard_passed: qualityGuard,
        token_efficiency_improved: efficiency,
        passed: qualityGuard && efficiency,
        reason: !qualityGuard ? 'quality_declined' : efficiency ? 'improved' : 'tokens_not_reduced',
      }
    })
    return {
      board_id: boardId,
      suite_key: suiteKey,
      scenario_count: comparisons.length,
      complete: comparisons.length > 0 && comparisons.every((item) => item.complete),
      passed: comparisons.length > 0 && comparisons.every((item) => item.passed),
      representative_evidence_observed: false,
      gate_claimed: false,
      comparisons,
    }
  }

  dashboard(boardIdInput: number, window: DashboardWindow = {}): Record<string, unknown> {
    const boardId = positiveBoard(boardIdInput)
    this.requireBoard(boardId)
    const since = window.since === undefined ? '1970-01-01T00:00:00.000Z' : timestamp(window.since, 'since')
    const until = window.until === undefined ? now() : timestamp(window.until, 'until')
    if (until <= since) throw new ValidationError('dashboard window is invalid')
    const usage = this.db.prepare(`SELECT
        COALESCE(SUM(provider_total_tokens),0) AS provider_tokens,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens),0) AS cached_input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(thinking_tokens),0) AS thinking_tokens,
        COALESCE(SUM(context_injection_tokens),0) AS context_injection_tokens,
        COALESCE(SUM(CASE WHEN cached_input_semantics='additive'
          THEN input_tokens+cached_input_tokens ELSE input_tokens END),0) AS cache_denominator
      FROM outcome_usage_observations
      WHERE board_id=? AND observed_at>=? AND observed_at<?`).get(boardId, since, until) as Record<string, unknown>
    const accepted = this.db.prepare(`SELECT COUNT(*) AS count
      FROM delivery_reports WHERE board_id=? AND status='accepted'
        AND accepted_at>=? AND accepted_at<?`).get(boardId, since, until) as { count: number }
    const acceptedUsage = this.db.prepare(`SELECT COALESCE(SUM(usage.provider_total_tokens),0) AS tokens
      FROM outcome_usage_observations usage
      WHERE usage.board_id=? AND usage.observed_at>=? AND usage.observed_at<? AND EXISTS (
        SELECT 1 FROM delivery_reports report
        WHERE report.board_id=usage.board_id AND report.job_id=usage.job_id
          AND report.status='accepted' AND report.accepted_at>=? AND report.accepted_at<?
      )`).get(boardId, since, until, since, until) as { tokens: number }
    const delivery = this.deliveryMetrics(boardId, since, until)
    const activities = this.activityCounts(boardId, since, until)
    const contextReceipts = this.knowledgeContextCounts(boardId, since, until)
    const explorationReceipts = this.claudeNativeExplorationCounts(boardId, since, until)
    const firstUseful = this.averageDuration(boardId, since, until, 'first_useful')
    const verifiedDelivery = this.averageDuration(boardId, since, until, 'verified_delivery')
    const byJob = this.db.prepare(`SELECT usage.job_id, usage.contract_ref,
        COALESCE(SUM(usage.provider_total_tokens),0) AS provider_tokens,
        NULL AS context_tokens,
        MAX(CASE WHEN EXISTS (
          SELECT 1 FROM delivery_reports report
          WHERE report.board_id=usage.board_id AND report.job_id=usage.job_id
            AND report.status='accepted'
            AND report.accepted_at>=? AND report.accepted_at<?
        ) THEN 1 ELSE 0 END) AS accepted
      FROM outcome_usage_observations usage
      WHERE usage.board_id=? AND usage.observed_at>=? AND usage.observed_at<?
      GROUP BY usage.job_id, usage.contract_ref ORDER BY provider_tokens DESC, usage.job_id`)
      .all(since, until, boardId, since, until)
    const byTeam = this.db.prepare(`SELECT team_id,
        COALESCE(SUM(provider_total_tokens),0) AS provider_tokens,
        NULL AS context_tokens
      FROM outcome_usage_observations
      WHERE board_id=? AND observed_at>=? AND observed_at<? AND team_id IS NOT NULL
      GROUP BY team_id ORDER BY provider_tokens DESC, team_id`).all(boardId, since, until)
    const reconciliation = this.db.prepare(`SELECT
        COUNT(*) AS linked_operations,
        COALESCE(SUM(reconciliation.provider_variance_tokens),0) AS provider_variance_tokens,
        COALESCE(SUM(CASE WHEN receipt.availability='exact'
          AND provisional_context.availability='exact'
          THEN reconciliation.context_variance_tokens ELSE 0 END),0) AS context_variance_tokens,
        COALESCE(SUM(CASE WHEN receipt.availability='exact'
          THEN reconciliation.plan_overage_tokens ELSE 0 END),0) AS plan_overage_tokens,
        COALESCE(SUM(CASE WHEN receipt.availability='unavailable' THEN 1 ELSE 0 END),0)
          AS unavailable_actual_context_observations,
        COALESCE(SUM(CASE WHEN provisional_context.availability='unavailable'
          THEN 1 ELSE 0 END),0) AS unavailable_provisional_context_observations
      FROM outcome_operation_usage_reconciliations reconciliation
      JOIN outcome_operation_usage_links link
        ON link.operation_id=reconciliation.operation_id
      JOIN outcome_usage_observations usage ON usage.id=link.usage_id
      JOIN outcome_usage_context_receipts receipt ON receipt.usage_id=usage.id
      JOIN outcome_operation_context_receipts provisional_context
        ON provisional_context.operation_id=link.operation_id
      WHERE usage.board_id=? AND usage.observed_at>=? AND usage.observed_at<?`)
      .get(boardId, since, until) as Record<string, unknown>
    const budgetRows = this.db.prepare(`SELECT * FROM outcome_budget_policies
      WHERE board_id=? AND superseded_at IS NULL
      ORDER BY CASE scope_kind WHEN 'job' THEN 1 WHEN 'team' THEN 2 ELSE 3 END, scope_id`)
      .all(boardId) as BudgetRow[]
    const budgets = budgetRows.map((policy) => {
      const used = this.budgetUsage(
        boardId,
        policy,
        policy.scope_kind === 'team' ? policy.scope_id : null,
        policy.scope_kind === 'job' ? policy.scope_id : null,
      )
      const dimensions = [
        dimension('provider_tokens', used.provider_tokens, policy.max_provider_tokens, policy.warning_milli),
        dimension('context_tokens', used.context_tokens, policy.max_context_tokens, policy.warning_milli),
        dimension('fanout', used.fanout, policy.max_fanout, policy.warning_milli),
        dimension('planning_round_tokens', used.planning_round_tokens, policy.max_planning_round_tokens, policy.warning_milli),
      ].filter((item) => item.limit !== null)
      const exceeded = dimensions.some((item) => item.exceeded)
      const unavailable = dimensions.some((item) => !item.available)
      return {
        policy_id: policy.id,
        scope_kind: policy.scope_kind,
        scope_id: policy.scope_id,
        enforcement: policy.enforcement,
        warning: dimensions.some((item) => item.warning) || unavailable,
        exceeded,
        allowed: !((exceeded || unavailable) && policy.enforcement === 'hard'),
        dimensions,
      }
    })
    const cacheDenominator = numberValue(usage.cache_denominator)
    const explorationReads = explorationReceipts.reads
    const duplicates = explorationReceipts.duplicates
    return {
      board_id: boardId,
      window: { since, until },
      production_signals: {
        provider_usage: 'available',
        child_dispatch: 'available',
        context_injection: 'unavailable',
        context_selection: 'knowledge_context_use_receipts',
        exploration: 'claude_native_read_receipts',
        first_useful_result: 'accepted_delivery_receipts',
        model_acknowledgement: 'unavailable',
        high_fanout_preflight: 'operator_plan_only',
      },
      usage: {
        provider_tokens: numberValue(usage.provider_tokens),
        input_tokens: numberValue(usage.input_tokens),
        cached_input_tokens: numberValue(usage.cached_input_tokens),
        output_tokens: numberValue(usage.output_tokens),
        thinking_tokens: numberValue(usage.thinking_tokens),
        context_injection_tokens: null,
        cached_input_ratio: cacheDenominator === 0
          ? null : numberValue(usage.cached_input_tokens) / cacheDenominator,
        accepted_delivery_tokens: numberValue(acceptedUsage.tokens),
        accepted_deliveries: numberValue(accepted.count),
        tokens_per_accepted_delivery: accepted.count === 0
          ? null : numberValue(acceptedUsage.tokens) / accepted.count,
      },
      context: {
        selected: contextReceipts.selected,
        reused: contextReceipts.reused,
        rejected: contextReceipts.rejected,
        refreshed: contextReceipts.refreshed,
        uses: contextReceipts.uses,
      },
      coordination: {
        wakes: activities['coordination.wake'] ?? 0,
        fanout: activities['coordination.fanout'] ?? 0,
        model_acknowledgements: activities['coordination.model_ack'] ?? 0,
      },
      exploration: {
        reads: explorationReads,
        likely_duplicates: duplicates,
        duplicate_rate: explorationReads === 0 ? null : duplicates / explorationReads,
      },
      speed: {
        average_ms_to_first_useful_result: firstUseful,
        average_ms_to_verified_delivery: verifiedDelivery,
      },
      quality: delivery,
      operation_reconciliation: {
        linked_operations: numberValue(reconciliation.linked_operations),
        provider_variance_tokens: numberValue(reconciliation.provider_variance_tokens),
        context_variance_tokens:
          numberValue(reconciliation.unavailable_actual_context_observations) > 0
            || numberValue(reconciliation.unavailable_provisional_context_observations) > 0
          ? null : numberValue(reconciliation.context_variance_tokens),
        plan_overage_tokens: numberValue(reconciliation.unavailable_actual_context_observations) > 0
          ? null : numberValue(reconciliation.plan_overage_tokens),
      },
      budgets,
      by_job: byJob,
      by_team: byTeam,
    }
  }

  private jobScope(boardIdInput: number, jobId: string, sessionId: string): JobScope {
    const boardId = positiveBoard(boardIdInput)
    const row = this.db.prepare(`SELECT job.board_id, job.card_id, job.contract_version,
        session.job_id AS session_job_id, session.workspace_id AS session_workspace_id,
        job.workspace_id AS job_workspace_id, job.provider AS job_provider,
        session.provider AS session_provider, job.driver_id AS job_driver_id,
        session.driver_id AS session_driver_id,
        job.assigned_profile_id AS job_profile_id,
        COALESCE(session.assigned_profile_id, session.profile_id) AS session_profile_id,
        job.created_at AS job_created_at, session.created_at AS session_created_at,
        session.context_json AS session_context_json
      FROM jobs job JOIN agent_sessions session ON session.id=?
      WHERE job.id=?`).get(sessionId, jobId) as JobScope | undefined
    if (!row) throw new NotFoundError('job or session not found')
    if (row.board_id !== boardId || row.session_job_id !== jobId
      || row.session_workspace_id !== row.job_workspace_id) {
      throw new ValidationError('usage scope does not match the canonical job and session')
    }
    if (row.job_provider !== row.session_provider) {
      throw new ValidationError('canonical job and session providers disagree')
    }
    if (!row.job_driver_id || !row.session_driver_id
      || row.job_driver_id !== row.session_driver_id) {
      throw new ValidationError('canonical job and session drivers are missing or disagree')
    }
    if (row.job_profile_id && row.session_profile_id
      && row.job_profile_id !== row.session_profile_id) {
      throw new ValidationError('canonical job and session profiles disagree')
    }
    return row
  }

  private contractRef(scope: JobScope): string {
    const version = scope.contract_version ?? Number((this.db.prepare(`SELECT version
      FROM task_contracts WHERE card_id=?`).get(scope.card_id) as { version: number } | undefined)?.version ?? 1)
    return `card:${scope.card_id}:v${version}`
  }

  private optionalTeam(boardId: number, value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null
    const id = identifier(value, 'team id')
    const row = this.db.prepare(`SELECT team.id FROM os_teams team
      JOIN os_organizations organization ON organization.id=team.organization_id
      WHERE team.id=? AND organization.board_id=?`).get(id, boardId)
    if (!row) throw new ValidationError('team is outside the board')
    return id
  }

  private canonicalProvider(scope: JobScope, claimed: unknown): string {
    const provider = bounded(claimed, 'provider', 100)
    if (provider !== scope.job_provider || provider !== scope.session_provider) {
      throw new ValidationError('provider does not match the canonical job and session')
    }
    return scope.job_provider
  }

  private canonicalBillingMode(
    scope: JobScope,
    provider: string,
    observedAt: string,
  ): { mode: BillingMode; binding: ProviderEvidenceBinding | null } {
    let context: unknown
    try { context = JSON.parse(scope.session_context_json) } catch {
      throw new ValidationError('canonical session context is invalid')
    }
    const declared = context && typeof context === 'object' && !Array.isArray(context)
      ? (context as Record<string, unknown>).provider_acceptance : undefined
    if (declared === undefined) return { mode: 'unknown', binding: null }
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
      throw new ValidationError('canonical provider acceptance binding is invalid')
    }
    const tuple = declared as Record<string, unknown>
    const evidenceId = identifier(tuple.evidence_id, 'provider evidence id')
    let evidence: ReturnType<ProviderAcceptanceEvidenceStoreV1['list']>[number] | undefined
    try {
      evidence = new ProviderAcceptanceEvidenceStoreV1(this.db).list()
        .find((candidate) => candidate.id === evidenceId)
    } catch {
      throw new ValidationError('canonical provider acceptance evidence failed integrity verification')
    }
    if (!evidence) throw new ValidationError('canonical provider acceptance evidence is missing')
    const acceptanceMatrix = evidence.matrix
    const gates = acceptanceMatrix.gates
    if (!gates || typeof gates !== 'object' || Array.isArray(gates)
      || Object.values(gates as Record<string, unknown>).length === 0
      || Object.values(gates as Record<string, unknown>).some((gate) => {
        if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return true
        const record = gate as Record<string, unknown>
        return record.state !== 'passed'
          || !Array.isArray(record.evidence_refs) || record.evidence_refs.length === 0
      })) {
      throw new ValidationError('canonical provider evidence has not passed every acceptance gate')
    }
    const expected = {
      evidence_id: evidence.id,
      provider_id: acceptanceMatrix.provider_id,
      adapter_id: acceptanceMatrix.adapter_id,
      mode_id: acceptanceMatrix.mode_id,
      runtime_mode: acceptanceMatrix.runtime_mode,
      platform: acceptanceMatrix.platform,
      source_commit: acceptanceMatrix.source_commit,
    }
    if (canonical(tuple) !== canonical(expected)
      || acceptanceMatrix.provider_id !== provider
      || acceptanceMatrix.adapter_id !== scope.job_driver_id
      || acceptanceMatrix.adapter_id !== scope.session_driver_id
      || acceptanceMatrix.observed_at > observedAt) {
      throw new ValidationError('canonical provider acceptance tuple does not match the job and session')
    }
    const nativeMode = acceptanceMatrix.billing_mode === 'personal_subscription'
      ? 'subscription' : acceptanceMatrix.billing_mode === 'usage_priced_api' ? 'api' : null
    if (!nativeMode) throw new ValidationError('canonical provider billing evidence is invalid')
    const binding: ProviderEvidenceBinding = {
      ...expected,
      billing_mode: acceptanceMatrix.billing_mode as ProviderEvidenceBinding['billing_mode'],
      evidence_sha256: requestHash({
        id: evidence.id,
        matrix_sha256: evidence.matrix_sha256,
        artifact_ref: evidence.artifact_ref,
        artifact_sha256: evidence.artifact_sha256,
        recorded_at: evidence.recorded_at,
      }),
    }
    return { mode: nativeMode, binding }
  }

  private validScopedTimestamp(value: string, scope: JobScope, field: string): string {
    const minimum = Math.max(Date.parse(scope.job_created_at), Date.parse(scope.session_created_at))
    const parsed = Date.parse(value)
    if (parsed < minimum) throw new ValidationError(`${field} predates the canonical job or session`)
    if (parsed > Date.now() + 5 * 60_000) throw new ValidationError(`${field} is in the future`)
    return value
  }

  private canonicalTeam(
    boardId: number,
    claimed: unknown,
    scope: JobScope | null,
    observedAt: string,
  ): string | null {
    const profileId = scope?.job_profile_id ?? scope?.session_profile_id ?? null
    if (!profileId) {
      if (claimed !== undefined && claimed !== null && claimed !== '') {
        throw new ValidationError('team cannot be attributed without a canonical agent profile')
      }
      return null
    }
    const rows = this.db.prepare(`SELECT membership.team_id FROM os_team_memberships membership
      JOIN os_organizations organization ON organization.id=membership.organization_id
      WHERE membership.agent_profile_id=? AND organization.board_id=?
        AND membership.state='active' AND julianday(membership.effective_from)<=julianday(?)
        AND (membership.effective_until IS NULL OR julianday(membership.effective_until)>julianday(?))
      ORDER BY membership.team_id`)
      .all(profileId, boardId, observedAt, observedAt) as Array<{ team_id: string }>
    if (claimed !== undefined && claimed !== null && claimed !== '') {
      const teamId = identifier(claimed, 'team id')
      if (!rows.some((row) => row.team_id === teamId)) {
        throw new ValidationError('team is not an active canonical membership for the agent')
      }
      return teamId
    }
    return rows.length === 1 ? rows[0]!.team_id : null
  }

  private resourceHmac(resource: string): string {
    const secret = this.db.prepare(`SELECT hmac_key_hex FROM outcome_analytics_secrets
      WHERE singleton=1`).get() as { hmac_key_hex: string } | undefined
    if (!secret) throw new Error('outcome analytics privacy key is unavailable')
    return createHmac('sha256', Buffer.from(secret.hmac_key_hex, 'hex'))
      .update(resource, 'utf8').digest('hex')
  }

  private benchmarkEvidence(
    boardId: number,
    evidenceRef: string,
    claimed: Record<string, unknown>,
  ): {
    metrics: Record<string, unknown>
    observed_at: string
    binding: {
      artifact_id: string; artifact_sha256: string; evidence_version: number
      verifier_ref: string; provenance_sha256: string; artifact_created_at: string
    }
  } {
    const artifactId = evidenceRef.startsWith('artifact:') ? evidenceRef.slice('artifact:'.length) : evidenceRef
    const artifact = this.db.prepare(`SELECT * FROM artifacts WHERE id=? AND board_id=?`)
      .get(artifactId, boardId) as Record<string, unknown> | undefined
    if (!artifact || !['benchmark', 'test_report', 'verification'].includes(String(artifact.kind))) {
      throw new ValidationError('benchmark evidence must reference a same-board verification artifact')
    }
    let parsed: unknown
    try { parsed = JSON.parse(String(artifact.metadata)) } catch { parsed = null }
    const metrics = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).outcome_benchmark : null
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
      throw new ValidationError('benchmark artifact lacks canonical outcome metrics')
    }
    const canonicalMetrics = metrics as Record<string, unknown>
    if (canonical(claimed) !== canonical(canonicalMetrics)) {
      throw new ValidationError('benchmark observation disagrees with canonical artifact evidence')
    }
    const envelope = parsed as Record<string, unknown>
    const evidence = envelope.outcome_benchmark_evidence
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new ValidationError('benchmark artifact lacks verified evidence provenance')
    }
    const evidenceRecord = evidence as Record<string, unknown>
    if (evidenceRecord.version !== 1) {
      throw new ValidationError('benchmark evidence version is invalid')
    }
    const verifierRef = bounded(evidenceRecord.verifier_ref, 'benchmark verifier ref')
    const provenance = evidenceRecord.provenance
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
      throw new ValidationError('benchmark evidence provenance is invalid')
    }
    const sourceCommit = (provenance as Record<string, unknown>).source_commit
    if (typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceCommit)) {
      throw new ValidationError('benchmark evidence source commit is invalid')
    }
    const observedAt = timestamp(artifact.created_at, 'artifact created at')
    if (Date.parse(observedAt) > Date.now() + 5 * 60_000) {
      throw new ValidationError('benchmark artifact time is in the future')
    }
    return {
      metrics: canonicalMetrics,
      observed_at: observedAt,
      binding: {
        artifact_id: artifactId,
        artifact_sha256: this.artifactDigest(artifact),
        evidence_version: 1,
        verifier_ref: verifierRef,
        provenance_sha256: requestHash(provenance),
        artifact_created_at: observedAt,
      },
    }
  }

  private benchmarkEvidenceCurrent(observationId: string): boolean {
    const binding = this.db.prepare(`SELECT * FROM outcome_benchmark_evidence_bindings
      WHERE observation_id=?`).get(observationId) as Record<string, unknown> | undefined
    if (!binding) return false
    const artifact = this.db.prepare(`SELECT * FROM artifacts WHERE id=?`)
      .get(binding.artifact_id) as Record<string, unknown> | undefined
    return artifact !== undefined
      && Number(binding.evidence_version) === 1
      && String(binding.artifact_sha256) === this.artifactDigest(artifact)
      && String(binding.artifact_created_at) === timestamp(artifact.created_at, 'artifact created at')
  }

  private artifactDigest(artifact: Record<string, unknown>): string {
    return requestHash({
      id: artifact.id,
      board_id: artifact.board_id,
      workspace_id: artifact.workspace_id,
      card_id: artifact.card_id,
      kind: artifact.kind,
      name: artifact.name,
      mime_type: artifact.mime_type,
      path: artifact.path,
      content: artifact.content,
      metadata: artifact.metadata,
      created_at: artifact.created_at,
    })
  }

  private operationUsageConsumption(
    operationId: string,
    usageId: string,
    boardId: number,
    teamId: string | null,
    jobId: string,
    providerTokens: number,
    contextTokens: number | null,
    observedAt: string,
  ): OperationUsageReconciliation {
    const consumption = this.db.prepare(`SELECT consumption.*,
        link.usage_id AS linked_usage_id, confirmation.estimated_tokens,
        context.availability AS context_availability,
        context.exact_tokens AS exact_context_tokens
      FROM outcome_operation_consumptions consumption
      JOIN outcome_operation_confirmations confirmation
        ON confirmation.id=consumption.operation_id
      JOIN outcome_operation_context_receipts context
        ON context.operation_id=consumption.operation_id
      LEFT JOIN outcome_operation_usage_links link ON link.operation_id=consumption.operation_id
      WHERE consumption.operation_id=?`).get(operationId) as Record<string, unknown> | undefined
    if (!consumption) throw new ValidationError('operation usage requires a consumed execution')
    if (consumption.linked_usage_id != null && String(consumption.linked_usage_id) !== usageId) {
      throw new ConflictError('operation execution is already linked to canonical usage')
    }
    if (Number(consumption.board_id) !== boardId
      || String(consumption.job_id ?? '') !== jobId
      || (consumption.team_id == null ? null : String(consumption.team_id)) !== teamId) {
      throw new ValidationError('operation usage scope does not match its consumed execution')
    }
    if (String(consumption.consumed_at) > observedAt) {
      throw new ValidationError('canonical usage predates its consumed execution')
    }
    const provisionalProvider = Number(consumption.provider_tokens)
    const provisionalContext = consumption.context_availability === 'exact'
      ? Number(consumption.exact_context_tokens) : null
    return {
      operation_id: operationId,
      provisional_provider_tokens: provisionalProvider,
      provisional_context_tokens: provisionalContext ?? 0,
      actual_provider_tokens: providerTokens,
      actual_context_tokens: contextTokens,
      provider_variance_tokens: providerTokens - provisionalProvider,
      context_variance_tokens: contextTokens === null || provisionalContext === null
        ? null : contextTokens - provisionalContext,
      plan_overage_tokens: contextTokens === null
        ? null
        : Math.max(0, providerTokens + contextTokens - Number(consumption.estimated_tokens)),
    }
  }

  private requireNoUnlinkedOperation(
    boardId: number,
    teamId: string | null,
    jobId: string,
    observedAt: string,
  ): null {
    const unlinked = this.db.prepare(`SELECT consumption.operation_id
      FROM outcome_operation_consumptions consumption
      LEFT JOIN outcome_operation_usage_links link
        ON link.operation_id=consumption.operation_id
      WHERE consumption.board_id=? AND consumption.job_id=?
        AND consumption.team_id IS ? AND consumption.consumed_at<=?
        AND link.operation_id IS NULL
      ORDER BY consumption.consumed_at, consumption.operation_id LIMIT 1`)
      .get(boardId, jobId, teamId, observedAt) as { operation_id: string } | undefined
    if (unlinked) {
      throw new ValidationError(
        'operation id is required for usage from an unlinked consumed execution',
      )
    }
    return null
  }

  private usageResult(id: string): Record<string, unknown> {
    const usage = this.row('outcome_usage_observations', id)
    const context = this.db.prepare(`SELECT availability, exact_tokens
      FROM outcome_usage_context_receipts WHERE usage_id=?`).get(id) as
      { availability: 'exact' | 'unavailable'; exact_tokens: number | null } | undefined
    const contextTokens = context?.availability === 'exact'
      ? numberValue(context.exact_tokens) : null
    const reconciliation = this.db.prepare(`SELECT reconciliation.*
        , context.availability AS provisional_context_availability
      FROM outcome_operation_usage_links link
      JOIN outcome_operation_usage_reconciliations reconciliation
        ON reconciliation.operation_id=link.operation_id
      JOIN outcome_operation_context_receipts context
        ON context.operation_id=link.operation_id
      WHERE link.usage_id=?`).get(id) as Record<string, unknown> | undefined
    const visibleUsage = { ...usage, context_injection_tokens: contextTokens }
    if (!reconciliation) return visibleUsage
    return {
      ...visibleUsage,
      operation_reconciliation: contextTokens === null
        ? {
            ...reconciliation,
            actual_context_tokens: null,
            context_variance_tokens: null,
            plan_overage_tokens: null,
          }
        : reconciliation.provisional_context_availability === 'unavailable'
          ? {
              ...reconciliation,
              provisional_context_tokens: null,
              context_variance_tokens: null,
            }
          : reconciliation,
    }
  }

  private validateBudgetScope(boardId: number, kind: BudgetScopeKind, id: string): void {
    if (kind === 'project' && id !== String(boardId)) {
      throw new ValidationError('project budget scope id must equal the board id')
    }
    if (kind === 'team') this.optionalTeam(boardId, id)
    if (kind === 'job') this.jobInBoard(boardId, id)
  }

  private jobInBoard(boardId: number, jobId: string): void {
    if (!this.db.prepare(`SELECT 1 FROM jobs WHERE id=? AND board_id=?`).get(jobId, boardId)) {
      throw new ValidationError('job is outside the board')
    }
  }

  private requireBoard(boardId: number): void {
    if (!this.db.prepare(`SELECT 1 FROM boards WHERE id=?`).get(boardId)) {
      throw new NotFoundError('board not found')
    }
  }

  private profileExists(profileId: string): void {
    if (!this.db.prepare(`SELECT 1 FROM agent_profiles WHERE id=?`).get(profileId)) {
      throw new ValidationError('leader profile not found')
    }
  }

  private replayed(table: string, id: string, hash: string): Record<string, unknown> | null {
    const prior = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown> | undefined
    if (!prior) return null
    if (prior.request_sha256 !== hash) throw new ConflictError('observation id is already bound to another request')
    return prior
  }

  private observationTimestamp(
    table: string,
    id: string,
    column: string,
    supplied: unknown,
    field: string,
  ): string {
    if (supplied !== undefined) return timestamp(supplied, field)
    const prior = this.db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id=?`)
      .get(id) as { value: string } | undefined
    return prior ? String(prior.value) : now()
  }

  private row(table: string, id: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown> | undefined
    if (!row) throw new NotFoundError('outcome analytics record not found')
    return row
  }

  private activeBudgets(boardId: number, teamId: string | null, jobId: string | null): BudgetRow[] {
    const clauses = [`(scope_kind='project' AND scope_id=?)`]
    const values: unknown[] = [boardId, String(boardId)]
    if (teamId) { clauses.push(`(scope_kind='team' AND scope_id=?)`); values.push(teamId) }
    if (jobId) { clauses.push(`(scope_kind='job' AND scope_id=?)`); values.push(jobId) }
    return this.db.prepare(`SELECT * FROM outcome_budget_policies
      WHERE board_id=? AND superseded_at IS NULL AND (${clauses.join(' OR ')})
      ORDER BY CASE scope_kind WHEN 'job' THEN 1 WHEN 'team' THEN 2 ELSE 3 END, created_at, id`)
      .all(...values) as BudgetRow[]
  }

  private budgetUsage(boardId: number, policy: BudgetRow, teamId: string | null, jobId: string | null): {
    provider_tokens: number; context_tokens: number | null; fanout: number; planning_round_tokens: number
  } {
    let predicate = ''
    let value: string | null = null
    if (policy.scope_kind === 'team') { predicate = ' AND team_id=?'; value = teamId ?? policy.scope_id }
    if (policy.scope_kind === 'job') { predicate = ' AND job_id=?'; value = jobId ?? policy.scope_id }
    const values = value === null ? [boardId] : [boardId, value]
    const usage = this.db.prepare(`SELECT
        COALESCE(SUM(usage.provider_total_tokens),0) AS provider_tokens,
        COALESCE(SUM(receipt.exact_tokens),0) AS context_tokens,
        COALESCE(SUM(CASE WHEN receipt.availability='unavailable' THEN 1 ELSE 0 END),0)
          AS unavailable_context_observations
      FROM outcome_usage_observations usage
      JOIN outcome_usage_context_receipts receipt ON receipt.usage_id=usage.id
      WHERE usage.board_id=?${predicate}`)
      .get(...values) as Record<string, unknown>
    const operations = this.db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN link.operation_id IS NULL
          THEN consumption.provider_tokens ELSE 0 END),0) AS provider_tokens,
        COALESCE(SUM(CASE WHEN link.operation_id IS NULL AND context.availability='exact'
          THEN context.exact_tokens ELSE 0 END),0) AS context_tokens,
        COALESCE(SUM(CASE WHEN link.operation_id IS NULL AND context.availability='unavailable'
          THEN 1 ELSE 0 END),0) AS unavailable_context_consumptions,
        COALESCE(SUM(consumption.fanout),0) AS fanout,
        COALESCE(SUM(consumption.planning_round_tokens),0) AS planning_round_tokens
      FROM outcome_operation_consumptions consumption
      JOIN outcome_operation_context_receipts context
        ON context.operation_id=consumption.operation_id
      LEFT JOIN outcome_operation_usage_links link ON link.operation_id=consumption.operation_id
      WHERE consumption.board_id=?${predicate}`)
      .get(...values) as Record<string, unknown>
    return {
      provider_tokens: numberValue(usage.provider_tokens) + numberValue(operations.provider_tokens),
      context_tokens: numberValue(usage.unavailable_context_observations) > 0
          || numberValue(operations.unavailable_context_consumptions) > 0
        ? null : numberValue(usage.context_tokens) + numberValue(operations.context_tokens),
      fanout: numberValue(operations.fanout),
      planning_round_tokens: numberValue(operations.planning_round_tokens),
    }
  }

  private activityCounts(boardId: number, since: string, until: string, teamId?: string): Record<string, number> {
    const rows = this.db.prepare(`SELECT category, COALESCE(SUM(quantity),0) AS quantity
      FROM outcome_activity_observations
      WHERE board_id=? AND occurred_at>=? AND occurred_at<?${teamId ? ' AND team_id=?' : ''}
      GROUP BY category ORDER BY category`).all(...(teamId
        ? [boardId, since, until, teamId] : [boardId, since, until])) as Array<{ category: string; quantity: number }>
    return Object.fromEntries(rows.map((row) => [row.category, numberValue(row.quantity)]))
  }

  private knowledgeContextCounts(boardId: number, since: string, until: string): {
    selected: number
    reused: number
    rejected: number
    refreshed: number
    uses: number
  } {
    const row = this.db.prepare(`WITH window_uses AS (
        SELECT * FROM context_uses
        WHERE board_id=? AND injected_at>=? AND injected_at<?
      ), exact_refresh_uses AS (
        SELECT current_use.id
        FROM window_uses current_use
        JOIN outcome_context_refresh_receipts receipt
          ON receipt.board_id=current_use.board_id
          AND receipt.context_use_id=current_use.id
          AND receipt.context_build_id=current_use.context_build_id
        JOIN context_uses previous_use
          ON previous_use.board_id=receipt.board_id
          AND previous_use.id=receipt.previous_context_use_id
          AND previous_use.context_build_id=receipt.previous_context_build_id
          AND previous_use.job_id=current_use.job_id
          AND previous_use.session_id=current_use.session_id
        JOIN context_builds previous_build
          ON previous_build.board_id=previous_use.board_id
          AND previous_build.id=previous_use.context_build_id
          AND previous_build.manifest_fingerprint=previous_use.manifest_fingerprint
      )
      SELECT
        COUNT(DISTINCT use.id) AS uses,
        COALESCE(SUM(CASE WHEN entry.decision='selected' THEN 1 ELSE 0 END),0) AS selected,
        COALESCE(SUM(CASE WHEN entry.decision='omitted' AND entry.reason='duplicate'
          THEN 1 ELSE 0 END),0) AS reused,
        COALESCE(SUM(CASE WHEN entry.decision='omitted' AND entry.reason!='duplicate'
          THEN 1 ELSE 0 END),0) AS rejected,
        COALESCE(SUM(CASE WHEN refresh.id IS NOT NULL AND entry.decision='selected'
          THEN 1 ELSE 0 END),0) AS refreshed
      FROM window_uses use
      LEFT JOIN context_build_entries entry
        ON entry.board_id=use.board_id AND entry.context_build_id=use.context_build_id
      LEFT JOIN exact_refresh_uses refresh ON refresh.id=use.id`)
      .get(boardId, since, until) as Record<string, unknown>
    return {
      selected: numberValue(row.selected),
      reused: numberValue(row.reused),
      rejected: numberValue(row.rejected),
      refreshed: numberValue(row.refreshed),
      uses: numberValue(row.uses),
    }
  }

  private claudeNativeExplorationCounts(boardId: number, since: string, until: string): {
    reads: number
    duplicates: number
  } {
    const row = this.db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN category='exploration.file_read' THEN quantity ELSE 0 END),0)
          AS reads,
        COALESCE(SUM(CASE WHEN category='exploration.duplicate' THEN quantity ELSE 0 END),0)
          AS duplicates
      FROM outcome_activity_observations
      WHERE board_id=? AND occurred_at>=? AND occurred_at<?
        AND id GLOB 'claude-native-read:*'`)
      .get(boardId, since, until) as Record<string, unknown>
    return {
      reads: numberValue(row.reads),
      duplicates: numberValue(row.duplicates),
    }
  }

  private deliveryMetrics(boardId: number, since: string, until: string): Record<string, unknown> {
    const reports = this.db.prepare(`SELECT
        COUNT(*) AS reports,
        SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN json_array_length(gaps)>0
          OR EXISTS (SELECT 1 FROM delivery_deliverable_results deliverable
            WHERE deliverable.report_id=delivery_reports.id
              AND deliverable.outcome!='met' AND deliverable.override_actor IS NULL)
          OR EXISTS (SELECT 1 FROM delivery_criterion_results criterion
            WHERE criterion.report_id=delivery_reports.id
              AND criterion.outcome!='met' AND criterion.override_actor IS NULL)
        THEN 1 ELSE 0 END) AS evidence_gaps
      FROM delivery_reports WHERE board_id=? AND updated_at>=? AND updated_at<?`)
      .get(boardId, since, until) as Record<string, unknown>
    const overrides = this.db.prepare(`SELECT COUNT(DISTINCT report.id) AS count
      FROM delivery_reports report
      LEFT JOIN delivery_deliverable_results deliverable ON deliverable.report_id=report.id
      LEFT JOIN delivery_criterion_results criterion ON criterion.report_id=report.id
      WHERE report.board_id=? AND report.updated_at>=? AND report.updated_at<?
        AND (deliverable.override_actor IS NOT NULL OR criterion.override_actor IS NOT NULL)`)
      .get(boardId, since, until) as { count: number }
    const retries = this.db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE board_id=? AND kind='job.retry_queued' AND created_at>=? AND created_at<?`)
      .get(boardId, since, until) as { count: number }
    const total = numberValue(reports.reports)
    return {
      reports: total,
      accepted: numberValue(reports.accepted),
      rejected: numberValue(reports.rejected),
      evidence_gaps: numberValue(reports.evidence_gaps),
      retries: numberValue(retries.count),
      retry_source: 'os_events',
      human_overrides: numberValue(overrides.count),
      rejection_rate: total === 0 ? null : numberValue(reports.rejected) / total,
      evidence_gap_rate: total === 0 ? null : numberValue(reports.evidence_gaps) / total,
      human_override_rate: total === 0 ? null : numberValue(overrides.count) / total,
    }
  }

  private averageDuration(boardId: number, since: string, until: string, kind: 'first_useful' | 'verified_delivery'): number | null {
    const row = kind === 'first_useful'
      ? this.db.prepare(`SELECT AVG((julianday(report.accepted_at)-julianday(job.started_at))*86400000.0) AS average_ms
          FROM delivery_reports report JOIN jobs job ON job.id=report.job_id
          WHERE report.board_id=? AND report.status='accepted' AND report.accepted_at>=?
            AND report.accepted_at<? AND job.started_at IS NOT NULL`)
        .get(boardId, since, until) as { average_ms: number | null }
      : this.db.prepare(`SELECT AVG((julianday(report.verified_at)-julianday(job.started_at))*86400000.0) AS average_ms
          FROM delivery_reports report JOIN jobs job ON job.id=report.job_id
          WHERE report.board_id=? AND report.status IN ('verified','accepted')
            AND report.verified_at>=? AND report.verified_at<? AND job.started_at IS NOT NULL`)
        .get(boardId, since, until) as { average_ms: number | null }
    return row.average_ms === null ? null : Math.max(0, Math.round(Number(row.average_ms)))
  }
}

function positiveBoard(value: unknown): number {
  const parsed = positiveCount(value, 'board id', Number.MAX_SAFE_INTEGER)
  return parsed
}

function optionalPositive(value: unknown, field: string, maximum = 1_000_000_000_000): number | null {
  if (value === undefined || value === null) return null
  return positiveCount(value, field, maximum)
}

function activityCategory(value: unknown): OutcomeActivityCategory {
  const allowed = new Set<OutcomeActivityCategory>([
    'context.selected', 'context.reused', 'context.rejected', 'context.refreshed',
    'coordination.wake', 'coordination.fanout', 'coordination.model_ack',
    'exploration.file_read', 'exploration.duplicate', 'result.first_useful',
    'delivery.evidence_gap', 'delivery.retry', 'delivery.human_override',
  ])
  if (!allowed.has(value as OutcomeActivityCategory)) throw new ValidationError('activity category is invalid')
  return value as OutcomeActivityCategory
}

function billingMode(value: unknown): BillingMode {
  if (value !== 'subscription' && value !== 'api' && value !== 'unknown') {
    throw new ValidationError('billing mode is invalid')
  }
  return value
}

function cachedSemantics(value: unknown): CachedInputSemantics {
  if (value !== 'subset' && value !== 'additive') throw new ValidationError('cached input semantics are invalid')
  return value
}

function budgetScope(value: unknown): BudgetScopeKind {
  if (value !== 'project' && value !== 'team' && value !== 'job') throw new ValidationError('budget scope is invalid')
  return value
}

function budgetEnforcement(value: unknown): BudgetEnforcement {
  if (value !== 'soft' && value !== 'hard') throw new ValidationError('budget enforcement is invalid')
  return value
}

function pickBudget(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id, board_id: row.board_id, scope_kind: row.scope_kind, scope_id: row.scope_id,
    max_provider_tokens: row.max_provider_tokens, max_context_tokens: row.max_context_tokens,
    max_fanout: row.max_fanout, max_planning_round_tokens: row.max_planning_round_tokens,
    warning_milli: row.warning_milli, enforcement: row.enforcement, created_by: row.created_by,
  }
}

function dimension(name: string, used: number | null, limit: number | null, warningMilli: number): {
  name: string; used: number | null; limit: number | null; ratio: number | null
  available: boolean; warning: boolean; exceeded: boolean
} {
  return {
    name, used, limit,
    ratio: limit === null || used === null ? null : used / limit,
    available: used !== null,
    warning: limit !== null && used !== null && used * 1_000 >= limit * warningMilli,
    exceeded: limit !== null && used !== null && used > limit,
  }
}

function invalid<T>(message: string): T {
  throw new ValidationError(message)
}

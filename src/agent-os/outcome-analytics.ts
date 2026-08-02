import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { applyOutcomeAnalyticsMigration } from './outcome-analytics-migration.js'

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
  teamId?: string | null
  provider: string
  billingMode: BillingMode
  cachedInputSemantics: CachedInputSemantics
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  thinkingTokens?: number
  contextInjectionTokens?: number
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
  teamId?: string | null
  jobId?: string | null
  ttlSeconds?: number
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
    const normalized = {
      id,
      board_id: positiveBoard(input.boardId),
      team_id: this.optionalTeam(input.boardId, input.teamId),
      session_id: identifier(input.sessionId, 'session id'),
      job_id: identifier(input.jobId, 'job id'),
      contract_ref: this.contractRef(scope),
      provider: bounded(input.provider, 'provider', 100),
      billing_mode: billingMode(input.billingMode),
      cached_input_semantics: cachedSemantics(input.cachedInputSemantics),
      input_tokens: count(input.inputTokens, 'input tokens'),
      cached_input_tokens: count(input.cachedInputTokens, 'cached input tokens'),
      output_tokens: count(input.outputTokens, 'output tokens'),
      thinking_tokens: count(input.thinkingTokens ?? 0, 'thinking tokens'),
      context_injection_tokens: count(
        input.contextInjectionTokens ?? 0,
        'context injection tokens',
      ),
      observed_at: this.observationTimestamp(
        'outcome_usage_observations', id, 'observed_at', input.observedAt, 'observed at',
      ),
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
    if (prior) return prior
    const createdAt = now()
    this.db.prepare(`INSERT INTO outcome_usage_observations
      (id, request_sha256, board_id, team_id, session_id, job_id, contract_ref,
       provider, billing_mode, cached_input_semantics, input_tokens, cached_input_tokens,
       output_tokens, thinking_tokens, context_injection_tokens, provider_total_tokens,
       observed_at, created_at)
      VALUES (@id, @request_sha256, @board_id, @team_id, @session_id, @job_id,
       @contract_ref, @provider, @billing_mode, @cached_input_semantics, @input_tokens,
       @cached_input_tokens, @output_tokens, @thinking_tokens, @context_injection_tokens,
       @provider_total_tokens, @observed_at, @created_at)`)
      .run({ ...normalized, request_sha256: hash, provider_total_tokens: providerTotal, created_at: createdAt })
    return this.row('outcome_usage_observations', normalized.id)
  }

  recordActivity(input: ActivityObservationInput): Record<string, unknown> {
    const boardId = positiveBoard(input.boardId)
    const id = identifier(input.id)
    const jobId = input.jobId == null ? null : identifier(input.jobId, 'job id')
    const sessionId = input.sessionId == null ? null : identifier(input.sessionId, 'session id')
    let contractRef: string | null = null
    if ((jobId === null) !== (sessionId === null)) {
      throw new ValidationError('job id and session id must be supplied together')
    }
    if (jobId && sessionId) contractRef = this.contractRef(this.jobScope(boardId, jobId, sessionId))
    const category = activityCategory(input.category)
    const resource = input.resourceIdentity == null
      ? null : bounded(input.resourceIdentity, 'resource identity', 4_096)
    if ((category === 'exploration.file_read' || category === 'exploration.duplicate') && !resource) {
      throw new ValidationError('exploration observations require a resource identity')
    }
    const normalized = {
      id,
      board_id: boardId,
      team_id: this.optionalTeam(boardId, input.teamId),
      session_id: sessionId,
      job_id: jobId,
      contract_ref: contractRef,
      category,
      quantity: positiveCount(input.quantity ?? 1, 'quantity'),
      resource_sha256: resource === null ? null : sha256(resource),
      occurred_at: this.observationTimestamp(
        'outcome_activity_observations', id, 'occurred_at', input.occurredAt, 'occurred at',
      ),
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
    additionalContextTokens?: number
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
      context_tokens: count(input.additionalContextTokens ?? 0, 'additional context tokens'),
      fanout: count(input.fanout ?? 0, 'fanout', 1_000_000),
      planning_round_tokens: count(input.planningRoundTokens ?? 0, 'planning round tokens'),
    }
    const evaluations = policies.map((policy) => {
      const used = this.budgetUsage(boardId, policy, teamId, jobId)
      const dimensions = [
        dimension('provider_tokens', used.provider_tokens + projections.provider_tokens, policy.max_provider_tokens, policy.warning_milli),
        dimension('context_tokens', used.context_tokens + projections.context_tokens, policy.max_context_tokens, policy.warning_milli),
        dimension('fanout', projections.fanout, policy.max_fanout, policy.warning_milli),
        dimension('planning_round_tokens', projections.planning_round_tokens, policy.max_planning_round_tokens, policy.warning_milli),
      ].filter((item) => item.limit !== null)
      const exceeded = dimensions.some((item) => item.exceeded)
      return {
        policy_id: policy.id,
        scope_kind: policy.scope_kind,
        scope_id: policy.scope_id,
        enforcement: policy.enforcement,
        warning: dimensions.some((item) => item.warning),
        exceeded,
        allowed: !(exceeded && policy.enforcement === 'hard'),
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
      requested_at: undefined,
      expires_at: undefined,
      ttl_seconds: normalized.ttl_seconds,
    })
    const prior = this.replayed('outcome_operation_confirmations', persisted.id, hash)
    if (prior) return prior
    this.db.prepare(`INSERT INTO outcome_operation_confirmations
      (id, request_sha256, board_id, team_id, job_id, operation_kind, fanout,
       estimated_tokens, reason, status, requested_by, requested_at, confirmed_by,
       confirmed_at, expires_at)
      VALUES (@id, @request_sha256, @board_id, @team_id, @job_id, @operation_kind,
       @fanout, @estimated_tokens, @reason, @status, @requested_by, @requested_at,
       @confirmed_by, @confirmed_at, @expires_at)`)
      .run({ ...persisted, request_sha256: hash })
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

  assertOperationAuthorized(id: string, at = now()): Record<string, unknown> {
    const row = this.row('outcome_operation_confirmations', identifier(id))
    const checkedAt = timestamp(at, 'checked at')
    if (String(row.expires_at) <= checkedAt) throw new ConflictError('operation authorization expired')
    if (row.status !== 'not_required' && row.status !== 'confirmed') {
      throw new ConflictError('operation requires explicit confirmation')
    }
    return row
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
    const normalized = {
      id,
      board_id: positiveBoard(input.boardId),
      suite_key: identifier(input.suiteKey, 'suite key'),
      scenario_key: identifier(input.scenarioKey, 'scenario key'),
      variant: input.variant === 'before' || input.variant === 'after'
        ? input.variant : invalid<'before'>('benchmark variant is invalid'),
      provider_tokens: count(input.providerTokens, 'provider tokens'),
      context_tokens: count(input.contextTokens, 'context tokens'),
      accepted_deliveries: count(input.acceptedDeliveries, 'accepted deliveries', 1_000_000),
      quality_milli: count(input.qualityMilli, 'quality milli', 1_000),
      duration_ms: count(input.durationMs, 'duration ms', 31_536_000_000),
      evidence_ref: bounded(input.evidenceRef, 'evidence ref'),
      observed_at: this.observationTimestamp(
        'outcome_benchmark_observations', id, 'observed_at', input.observedAt, 'observed at',
      ),
    }
    const hash = requestHash(normalized)
    const prior = this.replayed('outcome_benchmark_observations', normalized.id, hash)
    if (prior) return prior
    try {
      this.db.prepare(`INSERT INTO outcome_benchmark_observations
        (id, request_sha256, board_id, suite_key, scenario_key, variant,
         provider_tokens, context_tokens, accepted_deliveries, quality_milli,
         duration_ms, evidence_ref, observed_at, created_at)
        VALUES (@id, @request_sha256, @board_id, @suite_key, @scenario_key,
         @variant, @provider_tokens, @context_tokens, @accepted_deliveries,
         @quality_milli, @duration_ms, @evidence_ref, @observed_at, @created_at)`)
        .run({ ...normalized, request_sha256: hash, created_at: now() })
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
      const scenario = scenarios.get(String(row.scenario_key)) ?? {}
      scenario[row.variant as 'before' | 'after'] = row
      scenarios.set(String(row.scenario_key), scenario)
    }
    const comparisons = [...scenarios.entries()].map(([scenarioKey, pair]) => {
      if (!pair.before || !pair.after) {
        return { scenario_key: scenarioKey, complete: false, passed: false, reason: 'missing_variant' }
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
      WHERE usage.board_id=? AND EXISTS (
        SELECT 1 FROM delivery_reports report
        WHERE report.board_id=usage.board_id AND report.job_id=usage.job_id
          AND report.status='accepted' AND report.accepted_at>=? AND report.accepted_at<?
      )`).get(boardId, since, until) as { tokens: number }
    const delivery = this.deliveryMetrics(boardId, since, until)
    const activities = this.activityCounts(boardId, since, until)
    const firstUseful = this.averageDuration(boardId, since, until, 'first_useful')
    const verifiedDelivery = this.averageDuration(boardId, since, until, 'verified_delivery')
    const byJob = this.db.prepare(`SELECT usage.job_id, usage.contract_ref,
        COALESCE(SUM(usage.provider_total_tokens),0) AS provider_tokens,
        COALESCE(SUM(usage.context_injection_tokens),0) AS context_tokens,
        MAX(CASE WHEN EXISTS (
          SELECT 1 FROM delivery_reports report
          WHERE report.board_id=usage.board_id AND report.job_id=usage.job_id
            AND report.status='accepted'
        ) THEN 1 ELSE 0 END) AS accepted
      FROM outcome_usage_observations usage
      WHERE usage.board_id=? AND usage.observed_at>=? AND usage.observed_at<?
      GROUP BY usage.job_id, usage.contract_ref ORDER BY provider_tokens DESC, usage.job_id`)
      .all(boardId, since, until)
    const byTeam = this.db.prepare(`SELECT team_id,
        COALESCE(SUM(provider_total_tokens),0) AS provider_tokens,
        COALESCE(SUM(context_injection_tokens),0) AS context_tokens
      FROM outcome_usage_observations
      WHERE board_id=? AND observed_at>=? AND observed_at<? AND team_id IS NOT NULL
      GROUP BY team_id ORDER BY provider_tokens DESC, team_id`).all(boardId, since, until)
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
        dimension('fanout', 0, policy.max_fanout, policy.warning_milli),
        dimension('planning_round_tokens', 0, policy.max_planning_round_tokens, policy.warning_milli),
      ].filter((item) => item.limit !== null)
      const exceeded = dimensions.some((item) => item.exceeded)
      return {
        policy_id: policy.id,
        scope_kind: policy.scope_kind,
        scope_id: policy.scope_id,
        enforcement: policy.enforcement,
        warning: dimensions.some((item) => item.warning),
        exceeded,
        allowed: !(exceeded && policy.enforcement === 'hard'),
        dimensions,
      }
    })
    const cacheDenominator = numberValue(usage.cache_denominator)
    const explorationReads = activities['exploration.file_read'] ?? 0
    const duplicates = activities['exploration.duplicate'] ?? 0
    return {
      board_id: boardId,
      window: { since, until },
      usage: {
        provider_tokens: numberValue(usage.provider_tokens),
        input_tokens: numberValue(usage.input_tokens),
        cached_input_tokens: numberValue(usage.cached_input_tokens),
        output_tokens: numberValue(usage.output_tokens),
        thinking_tokens: numberValue(usage.thinking_tokens),
        context_injection_tokens: numberValue(usage.context_injection_tokens),
        cached_input_ratio: cacheDenominator === 0
          ? null : numberValue(usage.cached_input_tokens) / cacheDenominator,
        accepted_delivery_tokens: numberValue(acceptedUsage.tokens),
        accepted_deliveries: numberValue(accepted.count),
        tokens_per_accepted_delivery: accepted.count === 0
          ? null : numberValue(acceptedUsage.tokens) / accepted.count,
      },
      context: {
        selected: activities['context.selected'] ?? 0,
        reused: activities['context.reused'] ?? 0,
        rejected: activities['context.rejected'] ?? 0,
        refreshed: activities['context.refreshed'] ?? 0,
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
      budgets,
      by_job: byJob,
      by_team: byTeam,
    }
  }

  private jobScope(boardIdInput: number, jobId: string, sessionId: string): JobScope {
    const boardId = positiveBoard(boardIdInput)
    const row = this.db.prepare(`SELECT job.board_id, job.card_id, job.contract_version,
        session.job_id AS session_job_id, session.workspace_id AS session_workspace_id,
        job.workspace_id AS job_workspace_id
      FROM jobs job JOIN agent_sessions session ON session.id=?
      WHERE job.id=?`).get(sessionId, jobId) as JobScope | undefined
    if (!row) throw new NotFoundError('job or session not found')
    if (row.board_id !== boardId || row.session_job_id !== jobId
      || row.session_workspace_id !== row.job_workspace_id) {
      throw new ValidationError('usage scope does not match the canonical job and session')
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
    provider_tokens: number; context_tokens: number
  } {
    let predicate = ''
    let value: string | null = null
    if (policy.scope_kind === 'team') { predicate = ' AND team_id=?'; value = teamId ?? policy.scope_id }
    if (policy.scope_kind === 'job') { predicate = ' AND job_id=?'; value = jobId ?? policy.scope_id }
    const row = this.db.prepare(`SELECT COALESCE(SUM(provider_total_tokens),0) AS provider_tokens,
        COALESCE(SUM(context_injection_tokens),0) AS context_tokens
      FROM outcome_usage_observations WHERE board_id=?${predicate}`)
      .get(...(value === null ? [boardId] : [boardId, value])) as Record<string, unknown>
    return { provider_tokens: numberValue(row.provider_tokens), context_tokens: numberValue(row.context_tokens) }
  }

  private activityCounts(boardId: number, since: string, until: string, teamId?: string): Record<string, number> {
    const rows = this.db.prepare(`SELECT category, COALESCE(SUM(quantity),0) AS quantity
      FROM outcome_activity_observations
      WHERE board_id=? AND occurred_at>=? AND occurred_at<?${teamId ? ' AND team_id=?' : ''}
      GROUP BY category ORDER BY category`).all(...(teamId
        ? [boardId, since, until, teamId] : [boardId, since, until])) as Array<{ category: string; quantity: number }>
    return Object.fromEntries(rows.map((row) => [row.category, numberValue(row.quantity)]))
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
    const retries = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN attempts>1 THEN attempts-1 ELSE 0 END),0) AS count
      FROM jobs WHERE board_id=? AND created_at>=? AND created_at<?`)
      .get(boardId, since, until) as { count: number }
    const total = numberValue(reports.reports)
    return {
      reports: total,
      accepted: numberValue(reports.accepted),
      rejected: numberValue(reports.rejected),
      evidence_gaps: numberValue(reports.evidence_gaps),
      retries: numberValue(retries.count),
      human_overrides: numberValue(overrides.count),
      rejection_rate: total === 0 ? null : numberValue(reports.rejected) / total,
      evidence_gap_rate: total === 0 ? null : numberValue(reports.evidence_gaps) / total,
      human_override_rate: total === 0 ? null : numberValue(overrides.count) / total,
    }
  }

  private averageDuration(boardId: number, since: string, until: string, kind: 'first_useful' | 'verified_delivery'): number | null {
    const row = kind === 'first_useful'
      ? this.db.prepare(`SELECT AVG((julianday(first.occurred_at)-julianday(job.started_at))*86400000.0) AS average_ms
          FROM jobs job JOIN (
            SELECT job_id, MIN(occurred_at) AS occurred_at FROM outcome_activity_observations
            WHERE board_id=? AND category='result.first_useful' AND occurred_at>=? AND occurred_at<?
            GROUP BY job_id
          ) first ON first.job_id=job.id WHERE job.board_id=? AND job.started_at IS NOT NULL`)
        .get(boardId, since, until, boardId) as { average_ms: number | null }
      : this.db.prepare(`SELECT AVG((julianday(report.accepted_at)-julianday(job.started_at))*86400000.0) AS average_ms
          FROM delivery_reports report JOIN jobs job ON job.id=report.job_id
          WHERE report.board_id=? AND report.status='accepted' AND report.accepted_at>=?
            AND report.accepted_at<? AND job.started_at IS NOT NULL`)
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

function dimension(name: string, used: number, limit: number | null, warningMilli: number): {
  name: string; used: number; limit: number | null; ratio: number | null; warning: boolean; exceeded: boolean
} {
  return {
    name, used, limit,
    ratio: limit === null ? null : used / limit,
    warning: limit !== null && used * 1_000 >= limit * warningMilli,
    exceeded: limit !== null && used > limit,
  }
}

function invalid<T>(message: string): T {
  throw new ValidationError(message)
}

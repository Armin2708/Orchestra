import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { DriverEvent } from '../runtime/index.js'
import { recordProviderUsage, type ProviderUsageSplit } from '../usage.js'
import { canonicalHash } from './agent-home-support.js'
import { ConflictError, ValidationError } from './errors.js'
import {
  OutcomeAnalyticsService,
  type BillingMode,
  type OutcomeActivityCategory,
} from './outcome-analytics.js'
import type { Job } from './scheduler.js'

type OutcomeEvent = {
  board_id: number
  type: 'outcome_analytics'
  data: { kind: string; id: string }
}

type SessionScope = {
  agent_id: number | null
  provider: string
  context_json: string
  board_id: number
  job_id: string | null
}

type PlannedOperation = {
  id: string
  operation_kind: 'swarm' | 'planning_round'
  fanout: number
  estimated_tokens: number
}

const safeInteger = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * The job id is the native scheduler execution identity. The raw value is never persisted by the
 * analytics schema; only its SHA-256 binding is retained by planOperation().
 */
export function nativeOutcomeExecutionKey(jobId: string): string {
  const normalized = jobId.trim()
  if (!normalized || normalized.length > 200) {
    throw new ValidationError('job id is invalid for outcome execution')
  }
  return `agent-os-job:${normalized}`
}

function deterministicEventId(
  kind: 'usage' | 'activity',
  job: Pick<Job, 'id' | 'driver_id'>,
  sessionId: string,
  event: DriverEvent,
  category?: OutcomeActivityCategory,
): string {
  return `outcome-${kind}-${canonicalHash({
    category: category ?? null,
    driver_id: job.driver_id,
    event_at: event.at,
    event_seq: event.seq,
    event_session_id: event.sessionId,
    event_type: event.type,
    item_id: typeof event.metadata?.itemId === 'string' ? event.metadata.itemId : null,
    job_id: job.id,
    native_method: typeof event.metadata?.nativeMethod === 'string'
      ? event.metadata.nativeMethod
      : typeof event.metadata?.method === 'string' ? event.metadata.method : null,
    session_id: sessionId,
    turn_id: typeof event.metadata?.turnId === 'string' ? event.metadata.turnId : null,
  })}`
}

function deterministicSubagentActivityId(
  job: Pick<Job, 'id' | 'driver_id'>,
  sessionId: string,
  subagentId: string,
  category: 'coordination.wake' | 'coordination.fanout',
): string {
  return `outcome-activity-${canonicalHash({
    category,
    driver_id: job.driver_id,
    job_id: job.id,
    session_id: sessionId,
    subagent_id: subagentId,
  })}`
}

function usageDelta(total: ProviderUsageSplit, prior: ProviderUsageSplit): ProviderUsageSplit {
  return {
    provider: total.provider,
    total_tokens: Math.max(0, total.total_tokens - prior.total_tokens),
    input_tokens: Math.max(0, total.input_tokens - prior.input_tokens),
    cached_input_tokens: Math.max(0, total.cached_input_tokens - prior.cached_input_tokens),
    cache_creation_input_tokens: Math.max(
      0,
      total.cache_creation_input_tokens - prior.cache_creation_input_tokens,
    ),
    output_tokens: Math.max(0, total.output_tokens - prior.output_tokens),
    reasoning_output_tokens: Math.max(
      0,
      total.reasoning_output_tokens - prior.reasoning_output_tokens,
    ),
    cost_cents: total.cost_cents === null
      ? null
      : Math.max(0, total.cost_cents - (prior.cost_cents ?? 0)),
  }
}

function hasUsage(value: ProviderUsageSplit): boolean {
  return value.total_tokens > 0
    || value.input_tokens > 0
    || value.cached_input_tokens > 0
    || value.cache_creation_input_tokens > 0
    || value.output_tokens > 0
    || value.reasoning_output_tokens > 0
    || value.cost_cents !== null
}

/** Production-only bridge from canonical runtime evidence into the analytics domain. */
export class OutcomeAnalyticsRuntimeBridge {
  private readonly service: OutcomeAnalyticsService

  constructor(
    private readonly db: Database.Database,
    private readonly publish?: (event: OutcomeEvent) => void,
  ) {
    this.service = new OutcomeAnalyticsService(db)
  }

  /**
   * Consume exactly one active operation bound to this native job immediately before launch.
   * No operation id is synthesized: an ambiguous set of retained plans fails closed.
   */
  consumeBeforeProviderLaunch(job: Job, at = new Date().toISOString()): Record<string, unknown> | null {
    const executionKey = nativeOutcomeExecutionKey(job.id)
    const rows = this.db.prepare(`SELECT confirmation.id, confirmation.operation_kind,
        confirmation.fanout, confirmation.estimated_tokens
      FROM outcome_operation_confirmations confirmation
      JOIN outcome_operation_bindings binding ON binding.operation_id=confirmation.id
      LEFT JOIN outcome_operation_consumptions consumption
        ON consumption.operation_id=confirmation.id
      WHERE confirmation.job_id=? AND binding.execution_sha256=?
        AND confirmation.status IN ('not_required','awaiting_confirmation','confirmed')
        AND confirmation.expires_at>? AND consumption.operation_id IS NULL
      ORDER BY confirmation.requested_at, confirmation.id LIMIT 2`)
      .all(job.id, sha256(executionKey), at) as PlannedOperation[]
    if (rows.length > 1) {
      throw new ConflictError('multiple native outcome operations are eligible for one provider launch')
    }
    const operation = rows[0]
    if (!operation) return null
    const result = this.service.consumeOperationExecution({
      id: operation.id,
      executionKey,
      actor: `runtime:${job.driver_id}`,
      providerTokens: operation.estimated_tokens,
      contextTokens: 0,
      fanout: operation.fanout,
      planningRoundTokens: operation.operation_kind === 'planning_round'
        ? operation.estimated_tokens : 0,
      at,
    })
    this.changed(job.board_id, 'operation.consumed', operation.id)
    return result
  }

  /**
   * Persist the exact normalized provider delta and its legacy projection atomically. Codex
   * cached-input tokens are a subset of input; no aggregate counter is reclassified as a segment.
   */
  recordNormalizedProviderUsage(
    job: Job,
    sessionId: string,
    event: DriverEvent,
    total: ProviderUsageSplit,
  ): Record<string, unknown> | null {
    const scope = this.sessionScope(job, sessionId)
    if (scope.provider !== total.provider || total.provider !== 'codex') {
      throw new ValidationError('normalized provider usage does not match the canonical runtime')
    }
    let context: Record<string, unknown>
    try {
      context = JSON.parse(scope.context_json) as Record<string, unknown>
    } catch {
      throw new ValidationError('canonical session context is invalid')
    }
    const prior = context.usage_total && typeof context.usage_total === 'object'
      ? this.codexUsage(context.usage_total)
      : this.codexUsage({})
    const delta = usageDelta(total, prior)
    if (!hasUsage(delta)) return null
    if (delta.total_tokens < delta.input_tokens + delta.output_tokens) {
      throw new ValidationError('normalized provider total is inconsistent with its exact segments')
    }
    const operationId = this.unlinkedOperation(job.id, event.at)
    const contextTokens = safeInteger(event.metadata?.outcomeContextInjectionTokens) ?? 0
    const billingMode = this.billingMode(context)
    const id = deterministicEventId('usage', job, sessionId, event)
    const persist = this.db.transaction(() => {
      const result = this.service.recordUsage({
        id,
        boardId: job.board_id,
        sessionId,
        jobId: job.id,
        operationId,
        provider: total.provider,
        billingMode,
        cachedInputSemantics: 'subset',
        inputTokens: delta.input_tokens,
        cachedInputTokens: delta.cached_input_tokens,
        outputTokens: delta.output_tokens,
        thinkingTokens: delta.reasoning_output_tokens,
        contextInjectionTokens: contextTokens,
        providerTotalTokens: delta.total_tokens,
        observedAt: event.at,
      })
      if (scope.agent_id) {
        recordProviderUsage(this.db, scope.board_id, scope.agent_id, delta)
      }
      context.usage_total = total
      const updated = this.db.prepare(`UPDATE agent_sessions
        SET context_json=?, updated_at=datetime('now') WHERE id=? AND job_id=?`)
        .run(JSON.stringify(context), sessionId, job.id)
      if (updated.changes !== 1) {
        throw new ConflictError('canonical usage session changed before persistence')
      }
      return result
    }).immediate()
    this.changed(job.board_id, 'usage.recorded', id)
    return persist
  }

  /**
   * Record only exact child dispatch evidence. A child lifecycle is keyed by its provider-native
   * identity, so Codex item/started and item/completed projections cannot count it twice.
   * Dispatch does not prove model acknowledgement or useful output; those remain unavailable.
   */
  recordExactEventActivities(job: Job, sessionId: string, event: DriverEvent): string[] {
    this.sessionScope(job, sessionId)
    const subagentIds = this.exactSubagentIds(event)
    if (subagentIds.length === 0) return []
    const categories = [
      'coordination.wake',
      'coordination.fanout',
    ] as const satisfies readonly OutcomeActivityCategory[]
    const persisted = this.db.transaction(() => {
      const inserted: string[] = []
      for (const subagentId of subagentIds) {
        for (const category of categories) {
          const id = deterministicSubagentActivityId(job, sessionId, subagentId, category)
          if (this.db.prepare(`SELECT 1 FROM outcome_activity_observations WHERE id=?`).get(id)) {
            continue
          }
          this.service.recordActivity({
            id,
            boardId: job.board_id,
            sessionId,
            jobId: job.id,
            category,
            quantity: 1,
            occurredAt: event.at,
          })
          inserted.push(id)
        }
      }
      return inserted
    }).immediate()
    for (const id of persisted) this.changed(job.board_id, 'activity.recorded', id)
    return persisted
  }

  private sessionScope(job: Job, sessionId: string): SessionScope {
    const row = this.db.prepare(`SELECT session.agent_id, session.provider,
        session.context_json, job.board_id, session.job_id
      FROM agent_sessions session JOIN jobs job ON job.id=?
      WHERE session.id=? AND session.job_id=job.id`).get(job.id, sessionId) as
      SessionScope | undefined
    if (!row || row.board_id !== job.board_id || row.job_id !== job.id) {
      throw new ValidationError('provider event is outside the canonical job session')
    }
    return row
  }

  private unlinkedOperation(jobId: string, observedAt: string): string | null {
    const rows = this.db.prepare(`SELECT consumption.operation_id
      FROM outcome_operation_consumptions consumption
      LEFT JOIN outcome_operation_usage_links link
        ON link.operation_id=consumption.operation_id
      WHERE consumption.job_id=? AND consumption.consumed_at<=?
        AND link.operation_id IS NULL
      ORDER BY consumption.consumed_at, consumption.operation_id LIMIT 2`)
      .all(jobId, observedAt) as Array<{ operation_id: string }>
    if (rows.length > 1) {
      throw new ConflictError('provider usage is ambiguous across consumed outcome operations')
    }
    return rows[0]?.operation_id ?? null
  }

  private billingMode(context: Record<string, unknown>): BillingMode {
    const binding = context.provider_acceptance
    if (binding === undefined) return 'unknown'
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new ValidationError('canonical provider acceptance binding is invalid')
    }
    const evidenceId = (binding as Record<string, unknown>).evidence_id
    if (typeof evidenceId !== 'string' || !evidenceId.trim()) {
      throw new ValidationError('canonical provider acceptance binding is invalid')
    }
    const row = this.db.prepare(`SELECT billing_mode FROM provider_acceptance_evidence
      WHERE id=?`).get(evidenceId) as { billing_mode: string } | undefined
    if (row?.billing_mode === 'personal_subscription') return 'subscription'
    if (row?.billing_mode === 'usage_priced_api') return 'api'
    throw new ValidationError('canonical provider acceptance evidence is missing')
  }

  private codexUsage(value: unknown): ProviderUsageSplit {
    const row = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Partial<ProviderUsageSplit> : {}
    return {
      provider: 'codex',
      total_tokens: safeInteger(row.total_tokens) ?? 0,
      input_tokens: safeInteger(row.input_tokens) ?? 0,
      cached_input_tokens: safeInteger(row.cached_input_tokens) ?? 0,
      cache_creation_input_tokens: 0,
      output_tokens: safeInteger(row.output_tokens) ?? 0,
      reasoning_output_tokens: safeInteger(row.reasoning_output_tokens) ?? 0,
      cost_cents: safeInteger(row.cost_cents) ?? null,
    }
  }

  private exactSubagentIds(event: DriverEvent): string[] {
    if (event.metadata?.subagentStatus !== 'started'
      || typeof event.metadata.subagentId !== 'string'
      || !event.metadata.subagentId.trim()) return []
    const unique = new Set([event.metadata.subagentId.trim()])
    const container = event.metadata.subagents
    if (!container || typeof container !== 'object' || Array.isArray(container)) return [...unique]
    const receiverIds = (container as Record<string, unknown>).receiverThreadIds
    if (!Array.isArray(receiverIds)) return [...unique]
    for (const value of receiverIds) {
      if (typeof value === 'string' && value.trim()) unique.add(value.trim())
    }
    return [...unique].sort()
  }

  private changed(boardId: number, kind: string, id: string): void {
    this.publish?.({ board_id: boardId, type: 'outcome_analytics', data: { kind, id } })
  }
}

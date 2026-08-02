import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { ConflictError, ValidationError } from '../src/agent-os/errors.js'
import {
  OutcomeAnalyticsService,
  type UsageObservationInput,
} from '../src/agent-os/outcome-analytics.js'
import {
  applyOutcomeAnalyticsMigration,
  assertOutcomeAnalyticsSchema,
} from '../src/agent-os/outcome-analytics-migration.js'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
  ProviderAdapterRegistryV1,
  type DeclaredProviderAcceptanceMatrixV1,
} from '../src/provider-adapter-registry.js'
import { ProviderAcceptanceEvidenceStoreV1 } from '../src/provider-acceptance-evidence-store.js'

const START = '2026-08-01T10:00:00.000Z'
const FIRST = '2026-08-01T10:01:00.000Z'
const ACCEPTED = '2026-08-01T10:10:00.000Z'

function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/outcome', 'Outcome')`).run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title)
    VALUES (?, 'Ship a verified feature')`).run(boardId).lastInsertRowid)
  db.prepare(`INSERT INTO task_contracts
    (card_id, objective, acceptance_criteria, dependencies, base_ref, verify_commands,
     budget_tokens, budget_cents, priority, policy_id, workspace_id, updated_at,
     deliverables, non_goals, risks, version)
    VALUES (?, 'Ship', '[]', '[]', 'main', '[]', 10000, NULL, 10, NULL, NULL,
      ?, '[]', '[]', '[]', 3)`).run(cardId, START)
  db.prepare(`INSERT INTO workspaces
    (id, board_id, card_id, name, kind, root_path, worktree_path, branch, base_ref,
     status, env_json, created_at, updated_at)
    VALUES ('workspace-1', ?, ?, 'lane', 'worktree', '/repo', '/repo-lane',
      'lane', 'main', 'running', '{}', ?, ?)`).run(boardId, cardId, START, START)
  db.prepare(`INSERT INTO jobs
    (id, board_id, card_id, workspace_id, provider, model, priority, status,
     attempts, max_attempts, budget_tokens, budget_cents, scheduled_at, started_at,
     finished_at, error, created_at, spent_tokens, spent_cents, contract_version)
    VALUES ('job-1', ?, ?, 'workspace-1', 'codex', 'gpt', 10, 'running',
      2, 3, 10000, NULL, ?, ?, NULL, NULL, ?, 0, 0, 3)`)
    .run(boardId, cardId, START, START, START)
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, model, status, context_json, created_at, updated_at, job_id)
    VALUES ('session-1', 'workspace-1', 'codex', 'gpt', 'running', '{}', ?, ?,
      'job-1')`)
    .run(START, START)
  db.prepare(`INSERT INTO os_organizations
    (id, board_id, organization_key, name, mission, status, created_at, updated_at)
    VALUES ('org-1', ?, 'orchestra', 'Orchestra', 'Ship outcomes', 'active', ?, ?)`)
    .run(boardId, START, START)
  db.prepare(`INSERT INTO os_teams
    (id, organization_id, team_key, name, mission, status, created_at, updated_at)
    VALUES ('team-1', 'org-1', 'product', 'Product', 'Own outcomes', 'active', ?, ?)`)
    .run(START, START)
  return { db, boardId, cardId, service: new OutcomeAnalyticsService(db) }
}

const usage = (boardId: number, overrides: Partial<UsageObservationInput> = {}): UsageObservationInput => ({
  id: 'usage-1',
  boardId,
  sessionId: 'session-1',
  jobId: 'job-1',
  provider: 'codex',
  billingMode: 'unknown',
  cachedInputSemantics: 'subset',
  inputTokens: 1_000,
  cachedInputTokens: 600,
  outputTokens: 300,
  thinkingTokens: 100,
  contextInjectionTokens: 200,
  providerTotalTokens: 1_300,
  observedAt: FIRST,
  ...overrides,
})

function acceptDelivery(db: Database.Database, boardId: number, cardId: number, overrides = false) {
  db.prepare(`INSERT INTO delivery_reports
    (id, lineage_id, sequence, board_id, card_id, job_id, session_id, workspace_id,
     status, asked_snapshot, summary, delivered_items, claims_json, changed_files,
     commits, artifact_ids, gaps, created_by, accepted_by, created_at, updated_at,
     accepted_at)
    VALUES ('report-1', 'lineage-1', 1, ?, ?, 'job-1', 'session-1', 'workspace-1',
      'accepted', '{}', 'done', '[]', '[]', '[]', '[]', '[]', '[]', 'agent',
      'operator', ?, ?, ?)`).run(boardId, cardId, START, ACCEPTED, ACCEPTED)
  if (overrides) {
    db.prepare(`INSERT INTO delivery_criterion_results
      (report_id, criterion_id, outcome, note, evidence_refs, override_actor,
       override_reason, override_at, actor, created_at, updated_at)
      VALUES ('report-1', 'criterion-1', 'partial', 'gap', '[]', 'operator',
       'accepted risk', ?, 'operator', ?, ?)`).run(ACCEPTED, ACCEPTED, ACCEPTED)
  }
}

describe('outcome analytics migration and privacy boundary', () => {
  it('is replay-safe, verifies exact columns, and rejects a forged schema marker', () => {
    const { db } = fixture()
    expect(() => applyOutcomeAnalyticsMigration(db)).not.toThrow()
    expect(() => assertOutcomeAnalyticsSchema(db)).not.toThrow()
    db.prepare(`UPDATE outcome_analytics_schema SET schema_sha256=? WHERE singleton=1`)
      .run('0'.repeat(64))
    expect(() => applyOutcomeAnalyticsMigration(db)).toThrow(/schema marker is incompatible/)
  })

  it('makes observations update-immutable, retention-deletable and HMAC pseudonymous', () => {
    const { db, boardId, service } = fixture()
    service.recordUsage(usage(boardId))
    const read = {
      id: 'read-1', boardId, jobId: 'job-1', sessionId: 'session-1',
      category: 'exploration.file_read', resourceIdentity: '/secret/project/file.ts',
    } as const
    service.recordActivity(read)
    expect(service.recordActivity(read).id).toBe('read-1')
    expect(() => db.prepare(`UPDATE outcome_usage_observations SET output_tokens=0
      WHERE id='usage-1'`).run()).toThrow(/immutable/)
    const activity = db.prepare(`SELECT * FROM outcome_activity_observations WHERE id='read-1'`)
      .get() as Record<string, unknown>
    expect(activity.resource_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(activity)).not.toContain('/secret/project/file.ts')
    const second = fixture()
    second.service.recordActivity({ ...read, boardId: second.boardId })
    const secondHash = second.db.prepare(`SELECT resource_sha256 FROM outcome_activity_observations
      WHERE id='read-1'`).pluck().get()
    expect(secondHash).not.toBe(activity.resource_sha256)
    expect(db.prepare(`DELETE FROM outcome_activity_observations WHERE id='read-1'`).run().changes)
      .toBe(1)
    expect(() => db.prepare(`DELETE FROM outcome_analytics_secrets WHERE singleton=1`).run())
      .toThrow(/secret is required/)
    second.db.close()
  })

  it('allows board retention cascades and detects owned schema SQL drift', () => {
    const { db, service } = fixture()
    const emptyBoard = Number(db.prepare(`INSERT INTO boards(project_path, name)
      VALUES ('/retention', 'Retention')`).run().lastInsertRowid)
    service.recordActivity({ id: 'board-only', boardId: emptyBoard, category: 'coordination.wake' })
    expect(db.prepare(`DELETE FROM boards WHERE id=?`).run(emptyBoard).changes).toBe(1)
    expect(db.prepare(`SELECT COUNT(*) FROM outcome_activity_observations`).pluck().get()).toBe(0)
    const drifted = fixture()
    drifted.db.exec(`CREATE INDEX outcome_unexpected_index ON outcome_usage_observations(id)`)
    expect(() => applyOutcomeAnalyticsMigration(drifted.db)).toThrow(/schema marker is incompatible/)
    drifted.db.close()
    const forged = fixture()
    forged.db.exec(`DROP TRIGGER outcome_budget_update_guard;
      CREATE TRIGGER outcome_budget_update_guard BEFORE UPDATE ON outcome_budget_policies
      BEGIN SELECT RAISE(ABORT, 'forged'); END`)
    expect(() => assertOutcomeAnalyticsSchema(forged.db)).toThrow(/budget_update_guard SQL/)
    forged.db.close()
  })
})

describe('durable scoped token and outcome attribution', () => {
  it('attributes every token bucket to the canonical session, job, contract and team', () => {
    const { db, boardId, service } = fixture()
    const recorded = service.recordUsage(usage(boardId))
    expect(recorded).toMatchObject({
      board_id: boardId,
      session_id: 'session-1',
      job_id: 'job-1',
      contract_ref: expect.stringMatching(/^card:\d+:v3$/),
      team_id: null,
      input_tokens: 1_000,
      cached_input_tokens: 600,
      output_tokens: 300,
      thinking_tokens: 100,
      context_injection_tokens: 200,
      billing_mode: 'unknown',
    })
    expect(service.recordUsage(usage(boardId))).toEqual(recorded)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM outcome_usage_observations`).get())
      .toEqual({ count: 1 })
    expect(() => service.recordUsage(usage(boardId, { outputTokens: 299 })))
      .toThrow(ConflictError)
  })

  it('derives subscription billing only from retained provider acceptance evidence', () => {
    const { db, boardId, service } = fixture()
    const matrix: DeclaredProviderAcceptanceMatrixV1 = {
      contract_version: 1,
      provider_id: 'codex',
      adapter_id: 'codex-app-server',
      adapter_version: '1.0.0',
      mode_id: 'native_subscription',
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      credential_kind: 'provider_account_session',
      executable_version: '0.144.6',
      platform: 'darwin-arm64',
      source_commit: 'a'.repeat(40),
      observed_at: START,
      gates: Object.fromEntries(DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.map((gateId) => [
        gateId, { state: 'passed' as const, evidence_refs: [`evidence/${gateId}.json`] },
      ])) as DeclaredProviderAcceptanceMatrixV1['gates'],
    }
    new ProviderAcceptanceEvidenceStoreV1(db).record(
      new ProviderAdapterRegistryV1(), matrix,
      { artifact_ref: 'evidence/codex/subscription.json', artifact_sha256: 'b'.repeat(64) },
    )
    expect(service.recordUsage(usage(boardId, {
      id: 'subscription-usage', billingMode: 'subscription',
    }))).toMatchObject({ billing_mode: 'subscription', provider: 'codex' })
  })

  it('fails closed for cross-scope identity and inconsistent provider semantics', () => {
    const { db, boardId, service } = fixture()
    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status, env_json)
      VALUES ('workspace-2', ?, 'other', 'shared', '/other', 'active', '{}')`).run(boardId)
    db.prepare(`INSERT INTO jobs
      (id, board_id, card_id, workspace_id, provider, model, priority, status,
       attempts, max_attempts, scheduled_at, created_at, spent_tokens, spent_cents)
      VALUES ('job-2', ?, NULL, 'workspace-2', 'codex', 'gpt', 0, 'running',
       1, 1, ?, ?, 0, 0)`).run(boardId, START, START)
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, status, context_json, job_id)
      VALUES ('session-2', 'workspace-2', 'codex', 'running', '{}', 'job-2')`).run()
    expect(() => service.recordUsage(usage(boardId, { sessionId: 'session-2' })))
      .toThrow(/scope does not match/)
    expect(() => service.recordUsage(usage(boardId, { cachedInputTokens: 1_001 })))
      .toThrow(/subset cached input/)
    expect(() => service.recordUsage(usage(boardId, {
      cachedInputSemantics: 'additive', providerTotalTokens: 1_300,
    }))).toThrow(/provider total tokens/)
    expect(() => service.recordUsage(usage(boardId, { thinkingTokens: 301 })))
      .toThrow(/thinking tokens/)
    expect(() => service.recordUsage(usage(boardId, { provider: 'other' })))
      .toThrow(/canonical job and session/)
    expect(() => service.recordUsage(usage(boardId, { billingMode: 'subscription' })))
      .toThrow(/canonical provider evidence/)
    expect(() => service.recordUsage(usage(boardId, { observedAt: '2026-07-31T10:00:00.000Z' })))
      .toThrow(/predates/)
    expect(() => service.recordActivity({
      id: 'contaminated-team', boardId, teamId: 'team-1', category: 'coordination.wake',
    })).toThrow(/canonical agent profile/)
    expect(() => service.recordActivity({
      id: 'future-activity', boardId, category: 'coordination.wake',
      occurredAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    })).toThrow(/future/)
  })

  it('derives tokens per accepted delivery, cache reuse, speed, retries and overrides', () => {
    const { db, boardId, cardId, service } = fixture()
    service.recordUsage(usage(boardId))
    acceptDelivery(db, boardId, cardId, true)
    for (const [id, category, quantity] of [
      ['selected', 'context.selected', 4],
      ['reused', 'context.reused', 3],
      ['rejected', 'context.rejected', 1],
      ['refreshed', 'context.refreshed', 1],
      ['wake', 'coordination.wake', 2],
      ['fanout', 'coordination.fanout', 6],
      ['ack', 'coordination.model_ack', 1],
      ['useful', 'result.first_useful', 1],
    ] as const) {
      service.recordActivity({
        id, boardId, jobId: 'job-1', sessionId: 'session-1', category,
        quantity, occurredAt: category === 'result.first_useful' ? FIRST : ACCEPTED,
      })
    }
    service.recordActivity({
      id: 'read', boardId, jobId: 'job-1', sessionId: 'session-1',
      category: 'exploration.file_read', quantity: 4, resourceIdentity: 'src/a.ts',
      occurredAt: FIRST,
    })
    service.recordActivity({
      id: 'duplicate', boardId, jobId: 'job-1', sessionId: 'session-1',
      category: 'exploration.duplicate', quantity: 1, resourceIdentity: 'src/a.ts',
      occurredAt: FIRST,
    })
    db.prepare(`INSERT INTO os_events
      (id, board_id, workspace_id, session_id, job_id, kind, source, payload, created_at)
      VALUES ('retry-1', ?, 'workspace-1', 'session-1', 'job-1', 'job.retry_queued',
        'scheduler', '{}', ?)`).run(boardId, FIRST)
    const dashboard = service.dashboard(boardId, {
      since: '2026-08-01T09:00:00.000Z', until: '2026-08-01T11:00:00.000Z',
    }) as any
    expect(dashboard.usage).toMatchObject({
      accepted_deliveries: 1,
      accepted_delivery_tokens: 1_300,
      tokens_per_accepted_delivery: 1_300,
      cached_input_ratio: 0.6,
    })
    expect(dashboard.context).toEqual({ selected: 4, reused: 3, rejected: 1, refreshed: 1 })
    expect(dashboard.coordination).toEqual({ wakes: 2, fanout: 6, model_acknowledgements: 1 })
    expect(dashboard.exploration).toMatchObject({ reads: 4, likely_duplicates: 1, duplicate_rate: 0.25 })
    expect(dashboard.speed).toEqual({
      average_ms_to_first_useful_result: 60_000,
      average_ms_to_verified_delivery: 600_000,
    })
    expect(dashboard.quality).toMatchObject({
      accepted: 1, retries: 1, retry_source: 'os_events', human_overrides: 1,
    })
    expect(dashboard.by_job[0]).toMatchObject({ job_id: 'job-1', accepted: 1 })
    const beforeAcceptance = service.dashboard(boardId, {
      since: START, until: ACCEPTED,
    }) as any
    expect(beforeAcceptance.usage).toMatchObject({
      accepted_deliveries: 0, accepted_delivery_tokens: 0, tokens_per_accepted_delivery: null,
    })
    expect(beforeAcceptance.by_job[0]).toMatchObject({ accepted: 0 })
    expect(beforeAcceptance.quality).toMatchObject({ retries: 1 })
  })
})

describe('budgets, confirmations and leader digests', () => {
  it('enforces project, team and job budgets with warnings and hard stops', () => {
    const { db, boardId, service } = fixture()
    service.recordUsage(usage(boardId))
    service.setBudget({
      id: 'project-budget', boardId, scopeKind: 'project', scopeId: String(boardId),
      maxProviderTokens: 2_000, maxFanout: 10, warningMilli: 750,
      enforcement: 'soft', actor: 'operator',
    })
    service.setBudget({
      id: 'team-budget', boardId, scopeKind: 'team', scopeId: 'team-1',
      maxProviderTokens: 1_500, enforcement: 'hard', actor: 'operator',
    })
    service.setBudget({
      id: 'job-budget', boardId, scopeKind: 'job', scopeId: 'job-1',
      maxProviderTokens: 1_400, enforcement: 'hard', actor: 'operator',
    })
    const warning = service.evaluateBudgets({
      boardId, teamId: 'team-1', jobId: 'job-1', additionalProviderTokens: 50, fanout: 8,
    }) as any
    expect(warning.allowed).toBe(true)
    expect(warning.warning).toBe(true)
    const blocked = service.evaluateBudgets({
      boardId, teamId: 'team-1', jobId: 'job-1', additionalProviderTokens: 200,
    }) as any
    expect(blocked.allowed).toBe(false)
    expect(blocked.policies.find((item: any) => item.policy_id === 'job-budget'))
      .toMatchObject({ exceeded: true, allowed: false })
    const reserved = service.planOperation({
      id: 'budget-operation-1', boardId, operationKind: 'swarm', fanout: 6,
      estimatedTokens: 50, reason: 'Bounded batch', requestedBy: 'operator',
      executionKey: 'budget-execution-1', teamId: 'team-1', jobId: 'job-1',
    })
    if (reserved.status === 'awaiting_confirmation') service.confirmOperation('budget-operation-1', 'operator')
    service.consumeOperationExecution({
      id: 'budget-operation-1', executionKey: 'budget-execution-1', actor: 'runner',
      providerTokens: 50, fanout: 6,
    })
    const cumulative = service.evaluateBudgets({
      boardId, teamId: 'team-1', jobId: 'job-1', fanout: 5,
    }) as any
    expect(cumulative.policies.find((item: any) => item.policy_id === 'project-budget')
      .dimensions.find((item: any) => item.name === 'fanout')).toMatchObject({ used: 11, exceeded: true })
    const late = service.planOperation({
      id: 'budget-operation-2', boardId, operationKind: 'swarm', fanout: 1,
      estimatedTokens: 10, reason: 'Late execution', requestedBy: 'operator',
      executionKey: 'budget-execution-2', teamId: 'team-1', jobId: 'job-1',
    })
    if (late.status === 'awaiting_confirmation') service.confirmOperation('budget-operation-2', 'operator')
    expect(() => service.consumeOperationExecution({
      id: 'budget-operation-2', executionKey: 'budget-execution-2', actor: 'runner',
      providerTokens: 100, fanout: 1,
    })).toThrow(/hard budget at execution/)
    expect(() => db.prepare(`UPDATE outcome_budget_policies SET max_provider_tokens=999999
      WHERE id='job-budget'`).run()).toThrow(/identity is immutable/)
  })

  it('requires explicit expiring confirmation for high fanout and costly planning', () => {
    const { db, boardId, service } = fixture()
    const plan = service.planOperation({
      id: 'operation-1', boardId, operationKind: 'swarm', fanout: 8,
      estimatedTokens: 10_000, reason: 'Run independent reviews', requestedBy: 'operator',
      executionKey: 'native-execution-1', teamId: 'team-1', jobId: 'job-1', ttlSeconds: 900,
    })
    expect(plan.status).toBe('awaiting_confirmation')
    expect(() => service.consumeOperationExecution({
      id: 'operation-1', executionKey: 'native-execution-1', actor: 'runner',
      providerTokens: 100, fanout: 8,
    })).toThrow(/requires explicit/)
    expect(service.confirmOperation('operation-1', 'operator').status).toBe('confirmed')
    expect(() => service.consumeOperationExecution({
      id: 'operation-1', executionKey: 'wrong-execution', actor: 'runner',
      providerTokens: 100, fanout: 8,
    })).toThrow(/another execution/)
    expect(service.consumeOperationExecution({
      id: 'operation-1', executionKey: 'native-execution-1', actor: 'runner',
      providerTokens: 100, fanout: 8,
    })).toMatchObject({ status: 'confirmed', consumption: { operation_id: 'operation-1' } })
    expect(() => service.consumeOperationExecution({
      id: 'operation-1', executionKey: 'native-execution-1', actor: 'runner',
      providerTokens: 100, fanout: 8,
    })).toThrow(/already consumed/)
    expect(() => db.prepare(`UPDATE outcome_operation_confirmations SET reason='changed'
      WHERE id='operation-1'`).run()).toThrow(/transition is invalid/)
    const small = service.planOperation({
      id: 'operation-2', boardId, operationKind: 'swarm', fanout: 2,
      estimatedTokens: 500, reason: 'Pair review', requestedBy: 'operator',
      executionKey: 'native-execution-2',
    })
    expect(small.status).toBe('not_required')
  })

  it('creates a compact metrics-only team digest without activity payloads', () => {
    const { db, boardId, service } = fixture()
    service.recordActivity({
      id: 'wake-1', boardId, category: 'coordination.wake',
      quantity: 4, occurredAt: FIRST,
    })
    const digest = service.createTeamDigest({
      id: 'digest-1', boardId, teamId: 'team-1',
      windowStart: START, windowEnd: ACCEPTED,
    })
    expect(JSON.parse(String(digest.metrics_json))).toEqual({})
    expect(digest.source_count).toBe(0)
    expect(() => db.prepare(`UPDATE outcome_team_digests SET source_count=0
      WHERE id='digest-1'`).run()).toThrow(/immutable/)
  })
})

describe('quality-aware controlled benchmarks', () => {
  const observation = (boardId: number, scenario: string, variant: 'before' | 'after', values: {
    tokens: number; accepted: number; quality: number
  }) => ({
    id: `${scenario}-${variant}`, boardId, suiteKey: 'controlled-suite', scenarioKey: scenario,
    variant, providerTokens: values.tokens, contextTokens: 0,
    acceptedDeliveries: values.accepted, qualityMilli: values.quality,
    durationMs: 1_000, evidenceRef: `artifact:${scenario}-${variant}-artifact`, observedAt: FIRST,
  })

  const attest = (db: Database.Database, input: ReturnType<typeof observation>) => {
    const metrics = {
      suite_key: input.suiteKey, scenario_key: input.scenarioKey, variant: input.variant,
      provider_tokens: input.providerTokens, context_tokens: input.contextTokens,
      accepted_deliveries: input.acceptedDeliveries, quality_milli: input.qualityMilli,
      duration_ms: input.durationMs,
    }
    db.prepare(`INSERT INTO artifacts
      (id, board_id, kind, name, metadata, created_at)
      VALUES (?, ?, 'benchmark', ?, ?, ?)`).run(
      input.evidenceRef.slice('artifact:'.length), input.boardId,
      `${input.scenarioKey}-${input.variant}`, JSON.stringify({ outcome_benchmark: metrics }), FIRST,
    )
  }

  it('passes only paired scenarios with lower tokens and non-declining quality', () => {
    const { db, boardId, service } = fixture()
    const before = observation(boardId, 'healthy', 'before', { tokens: 1_000, accepted: 1, quality: 900 })
    const after = observation(boardId, 'healthy', 'after', { tokens: 700, accepted: 1, quality: 920 })
    attest(db, before); attest(db, after)
    service.recordBenchmark(before)
    service.recordBenchmark(after)
    const comparison = service.benchmarkComparison(boardId, 'controlled-suite') as any
    expect(comparison).toMatchObject({ complete: true, passed: true, gate_claimed: false })
    expect(comparison.comparisons[0]).toMatchObject({
      quality_guard_passed: true, token_efficiency_improved: true, passed: true,
    })
  })

  it('never reports success when tokens fall but quality or accepted deliveries decline', () => {
    const { db, boardId, service } = fixture()
    const before = observation(boardId, 'quality-drop', 'before', { tokens: 1_000, accepted: 2, quality: 950 })
    const after = observation(boardId, 'quality-drop', 'after', { tokens: 300, accepted: 1, quality: 800 })
    attest(db, before); attest(db, after)
    service.recordBenchmark(before)
    service.recordBenchmark(after)
    const comparison = service.benchmarkComparison(boardId, 'controlled-suite') as any
    expect(comparison.passed).toBe(false)
    expect(comparison.comparisons[0]).toMatchObject({
      quality_guard_passed: false, passed: false, reason: 'quality_declined',
    })
  })

  it('rejects unattested quality and timestamps', () => {
    const { db, boardId, service } = fixture()
    const canonicalInput = observation(boardId, 'tamper', 'before', {
      tokens: 1_000, accepted: 1, quality: 900,
    })
    attest(db, canonicalInput)
    expect(() => service.recordBenchmark({ ...canonicalInput, qualityMilli: 950 }))
      .toThrow(/disagrees with canonical artifact/)
    expect(() => service.recordBenchmark({
      ...canonicalInput, id: 'tamper-time', observedAt: ACCEPTED,
    })).toThrow(/must match canonical artifact time/)
  })

  it('does not overclaim MET-GATE from deterministic unit evidence', () => {
    const { boardId, service } = fixture()
    const comparison = service.benchmarkComparison(boardId, 'controlled-suite') as any
    expect(comparison).toMatchObject({
      scenario_count: 0,
      complete: false,
      passed: false,
      representative_evidence_observed: false,
      gate_claimed: false,
    })
  })
})

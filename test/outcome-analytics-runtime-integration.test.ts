import { EventEmitter } from 'node:events'
import type Database from 'better-sqlite3'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { ConflictError, ValidationError } from '../src/agent-os/errors.js'
import { assertOutcomeAnalyticsSchema } from '../src/agent-os/outcome-analytics-migration.js'
import {
  nativeOutcomeExecutionKey,
  OutcomeAnalyticsRuntimeBridge,
} from '../src/agent-os/outcome-analytics-runtime.js'
import { OutcomeAnalyticsService } from '../src/agent-os/outcome-analytics.js'
import { registerAgentOsRoutes } from '../src/agent-os/routes.js'
import type { Job } from '../src/agent-os/scheduler.js'
import type { DriverEvent } from '../src/runtime/index.js'
import type { ProviderUsageSplit } from '../src/usage.js'

const databases: Database.Database[] = []
const servers: FastifyInstance[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  const startedAt = new Date(Date.now() - 60_000).toISOString()
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/production-outcome', 'Production outcome')`).run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title)
    VALUES (?, 'Ship measured runtime')`).run(boardId).lastInsertRowid)
  db.prepare(`INSERT INTO task_contracts
    (card_id, objective, acceptance_criteria, dependencies, base_ref, verify_commands,
     budget_tokens, budget_cents, priority, updated_at, deliverables, non_goals, risks, version)
    VALUES (?, 'Measure runtime', '[]', '[]', 'main', '[]', 10000, NULL, 1,
      ?, '[]', '[]', '[]', 4)`).run(cardId, startedAt)
  db.prepare(`INSERT INTO workspaces
    (id, board_id, card_id, name, kind, root_path, status, env_json, created_at, updated_at)
    VALUES ('runtime-workspace', ?, ?, 'runtime', 'shared', '/runtime', 'running', '{}', ?, ?)`)
    .run(boardId, cardId, startedAt, startedAt)
  const agentId = Number(db.prepare(`INSERT INTO agents
    (board_id, name, kind, status, provider, created_at, last_seen)
    VALUES (?, 'metrics-agent', 'hired', 'active', 'codex', ?, ?)`)
    .run(boardId, startedAt, startedAt).lastInsertRowid)
  db.prepare(`INSERT INTO jobs
    (id, board_id, card_id, workspace_id, provider, model, priority, status, attempts,
     max_attempts, scheduled_at, started_at, created_at, spent_tokens, spent_cents,
     contract_version, driver_id)
    VALUES ('runtime-job', ?, ?, 'runtime-workspace', 'codex', 'gpt', 1, 'running', 1,
      2, ?, ?, ?, 0, 0, 4, 'codex-app-server')`).run(
    boardId, cardId, startedAt, startedAt, startedAt,
  )
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, model, status, context_json, job_id, agent_id,
     created_at, updated_at, driver_id)
    VALUES ('runtime-session', 'runtime-workspace', 'codex', 'gpt', 'running', '{}',
      'runtime-job', ?, ?, ?, 'codex-app-server')`).run(agentId, startedAt, startedAt)
  const job = db.prepare(`SELECT * FROM jobs WHERE id='runtime-job'`).get() as Job
  return { db, boardId, cardId, agentId, job, service: new OutcomeAnalyticsService(db) }
}

function driverEvent(overrides: Partial<DriverEvent> = {}): DriverEvent {
  return {
    sessionId: 'provider-session',
    seq: 7,
    type: 'status',
    at: new Date(Date.now() + 1_000).toISOString(),
    data: 'usage',
    metadata: { nativeMethod: 'thread/tokenUsage/updated', turnId: 'turn-1' },
    ...overrides,
  }
}

const usageTotal = (overrides: Partial<ProviderUsageSplit> = {}): ProviderUsageSplit => ({
  provider: 'codex',
  total_tokens: 120,
  input_tokens: 100,
  cached_input_tokens: 60,
  cache_creation_input_tokens: 0,
  output_tokens: 20,
  reasoning_output_tokens: 5,
  cost_cents: null,
  ...overrides,
})

function planNativeOperation(
  service: OutcomeAnalyticsService,
  boardId: number,
  id = 'runtime-operation',
) {
  return service.planOperation({
    id,
    boardId,
    jobId: 'runtime-job',
    operationKind: 'swarm',
    fanout: 2,
    estimatedTokens: 100,
    reason: 'Exact runtime launch',
    requestedBy: 'operator',
    executionKey: nativeOutcomeExecutionKey('runtime-job'),
  })
}

describe('production outcome analytics composition', () => {
  it('installs the schema through openDb and mounts routes through the central registrar', async () => {
    const { db, boardId } = fixture()
    expect(() => assertOutcomeAnalyticsSchema(db)).not.toThrow()
    const server = Fastify()
    const bus = new EventEmitter()
    const published: unknown[] = []
    bus.on('event', (event) => published.push(event))
    server.decorate('bus', bus)
    server.decorateRequest('orchestraPrincipal', null)
    server.addHook('preValidation', async (request) => {
      request.orchestraPrincipal = request.headers.authorization === 'Bearer operator'
        ? 'operator' : null
    })
    registerAgentOsRoutes(server, {
      db,
      isOperator: (request: FastifyRequest) => request.orchestraPrincipal === 'operator',
    })
    await server.ready()
    servers.push(server)

    const dashboard = await server.inject({
      method: 'GET', url: `/api/v1/os/boards/${boardId}/outcomes/dashboard`,
    })
    expect(dashboard.statusCode, dashboard.body).toBe(200)
    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/outcomes/activity`,
      payload: { id: 'forbidden-activity', category: 'coordination.wake' },
    })
    expect(forbidden.statusCode).toBe(403)
    const recorded = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/outcomes/activity`,
      headers: { authorization: 'Bearer operator' },
      payload: { id: 'central-activity', category: 'coordination.wake' },
    })
    expect(recorded.statusCode, recorded.body).toBe(201)
    expect(published).toContainEqual({
      board_id: boardId,
      type: 'outcome_analytics',
      data: { kind: 'activity.recorded', id: 'central-activity' },
    })
  })

  it('consumes the native operation immediately before launch and atomically reconciles usage', () => {
    const { db, boardId, agentId, job, service } = fixture()
    const published: unknown[] = []
    const bridge = new OutcomeAnalyticsRuntimeBridge(db, (event) => published.push(event))
    planNativeOperation(service, boardId)

    const consumed = bridge.consumeBeforeProviderLaunch(job)
    expect(consumed).toMatchObject({
      id: 'runtime-operation',
      job_id: 'runtime-job',
      consumption: {
        operation_id: 'runtime-operation',
        provider_tokens: 100,
        provider_context_status: 'provisional_until_canonical_usage',
      },
    })
    expect(bridge.consumeBeforeProviderLaunch(job)).toBeNull()

    const event = driverEvent()
    const recorded = bridge.recordNormalizedProviderUsage(
      job, 'runtime-session', event, usageTotal(),
    )
    expect(recorded).toMatchObject({
      board_id: boardId,
      session_id: 'runtime-session',
      job_id: 'runtime-job',
      contract_ref: `card:${job.card_id}:v4`,
      provider: 'codex',
      billing_mode: 'unknown',
      cached_input_semantics: 'subset',
      input_tokens: 100,
      cached_input_tokens: 60,
      output_tokens: 20,
      thinking_tokens: 5,
      provider_total_tokens: 120,
      observed_at: event.at,
    })
    expect(db.prepare(`SELECT operation_id, actual_provider_tokens, provider_variance_tokens
      FROM outcome_operation_usage_reconciliations`).get()).toEqual({
      operation_id: 'runtime-operation',
      actual_provider_tokens: 120,
      provider_variance_tokens: 20,
    })
    expect(db.prepare(`SELECT agent_id, input_tokens, cache_read, cached_input_tokens,
      output_tokens, total_tokens FROM agent_usage`).get()).toEqual({
      agent_id: agentId,
      input_tokens: 100,
      cache_read: 0,
      cached_input_tokens: 60,
      output_tokens: 20,
      total_tokens: 120,
    })
    expect(JSON.parse(String(db.prepare(`SELECT context_json FROM agent_sessions
      WHERE id='runtime-session'`).pluck().get()))).toMatchObject({ usage_total: usageTotal() })
    expect(bridge.recordNormalizedProviderUsage(
      job, 'runtime-session', event, usageTotal(),
    )).toBeNull()
    expect(db.prepare(`SELECT COUNT(*) FROM outcome_usage_observations`).pluck().get()).toBe(1)
    expect(published).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: { kind: 'operation.consumed', id: 'runtime-operation' } }),
      expect.objectContaining({ data: expect.objectContaining({ kind: 'usage.recorded' }) }),
    ]))
  })

  it('records only exact first-useful-output and subagent activities without replay inflation', () => {
    const { db, job } = fixture()
    const bridge = new OutcomeAnalyticsRuntimeBridge(db)
    const output = driverEvent({
      seq: 1,
      type: 'output',
      data: 'Useful answer',
      metadata: { nativeMethod: 'item/agentMessage/delta', turnId: 'turn-1' },
    })
    expect(bridge.recordExactEventActivities(job, 'runtime-session', output)).toHaveLength(1)
    expect(bridge.recordExactEventActivities(job, 'runtime-session', output)).toEqual([])
    expect(bridge.recordExactEventActivities(job, 'runtime-session', {
      ...output, seq: 2, data: 'More output',
    })).toEqual([])

    const subagents = driverEvent({
      seq: 3,
      type: 'tool',
      data: 'spawn_agent',
      metadata: {
        nativeMethod: 'item/completed',
        itemId: 'collab-1',
        subagentId: 'thread-child-a',
        subagentStatus: 'started',
        subagents: { receiverThreadIds: ['thread-child-a', 'thread-child-b', 'thread-child-a'] },
      },
    })
    expect(bridge.recordExactEventActivities(job, 'runtime-session', subagents)).toHaveLength(3)
    expect(bridge.recordExactEventActivities(job, 'runtime-session', subagents)).toHaveLength(3)
    expect(db.prepare(`SELECT category, quantity FROM outcome_activity_observations
      ORDER BY category`).all()).toEqual([
      { category: 'coordination.fanout', quantity: 2 },
      { category: 'coordination.model_ack', quantity: 2 },
      { category: 'coordination.wake', quantity: 2 },
      { category: 'result.first_useful', quantity: 1 },
    ])
  })

  it('fails closed before launch when more than one native operation is eligible', () => {
    const { db, boardId, job, service } = fixture()
    const bridge = new OutcomeAnalyticsRuntimeBridge(db)
    planNativeOperation(service, boardId, 'runtime-operation-a')
    planNativeOperation(service, boardId, 'runtime-operation-b')
    expect(() => bridge.consumeBeforeProviderLaunch(job)).toThrow(ConflictError)
    expect(db.prepare(`SELECT COUNT(*) FROM outcome_operation_consumptions`).pluck().get()).toBe(0)
  })

  it('fails closed and rolls back projections for ambiguous provider evidence', () => {
    const { db, boardId, job, service } = fixture()
    const bridge = new OutcomeAnalyticsRuntimeBridge(db)
    planNativeOperation(service, boardId, 'runtime-operation-a')
    service.consumeOperationExecution({
      id: 'runtime-operation-a', executionKey: nativeOutcomeExecutionKey(job.id),
      actor: 'runtime', providerTokens: 100, fanout: 2,
    })
    planNativeOperation(service, boardId, 'runtime-operation-b')
    service.consumeOperationExecution({
      id: 'runtime-operation-b', executionKey: nativeOutcomeExecutionKey(job.id),
      actor: 'runtime', providerTokens: 100, fanout: 2,
    })
    expect(() => bridge.recordNormalizedProviderUsage(
      job, 'runtime-session', driverEvent(), usageTotal(),
    )).toThrow(ConflictError)
    expect(db.prepare(`SELECT COUNT(*) FROM outcome_usage_observations`).pluck().get()).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) FROM agent_usage`).pluck().get()).toBe(0)
    expect(db.prepare(`SELECT context_json FROM agent_sessions
      WHERE id='runtime-session'`).pluck().get()).toBe('{}')
  })

  it('rejects malformed provider segments without creating either projection', () => {
    const { db, job } = fixture()
    const bridge = new OutcomeAnalyticsRuntimeBridge(db)
    expect(() => bridge.recordNormalizedProviderUsage(
      job, 'runtime-session', driverEvent(), usageTotal({ total_tokens: 100 }),
    )).toThrow(ValidationError)
    expect(db.prepare(`SELECT COUNT(*) FROM outcome_usage_observations`).pluck().get()).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) FROM agent_usage`).pluck().get()).toBe(0)
  })
})

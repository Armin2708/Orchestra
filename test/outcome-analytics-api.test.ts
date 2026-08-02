import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { outcomeAnalyticsPlugin } from '../src/agent-os/outcome-analytics-routes.js'
import { nativeOutcomeExecutionKey } from '../src/agent-os/outcome-analytics-runtime.js'

const operator = { authorization: 'Bearer operator' }
const servers: FastifyInstance[] = []
const databases: Database.Database[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  for (const db of databases.splice(0)) db.close()
})

async function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/api-outcome', 'API outcome')`).run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title)
    VALUES (?, 'Measured delivery')`).run(boardId).lastInsertRowid)
  db.prepare(`INSERT INTO task_contracts
    (card_id, objective, acceptance_criteria, dependencies, base_ref, verify_commands,
     budget_tokens, budget_cents, priority, updated_at, deliverables, non_goals, risks, version)
    VALUES (?, 'Measure', '[]', '[]', 'main', '[]', 10000, NULL, 1,
      '2026-08-01T10:00:00.000Z', '[]', '[]', '[]', 2)`).run(cardId)
  db.prepare(`INSERT INTO workspaces
    (id, board_id, card_id, name, kind, root_path, status, env_json)
    VALUES ('api-workspace', ?, ?, 'api', 'shared', '/api', 'running', '{}')`)
    .run(boardId, cardId)
  db.prepare(`INSERT INTO jobs
    (id, board_id, card_id, workspace_id, provider, priority, status, attempts,
     max_attempts, scheduled_at, started_at, created_at, spent_tokens, spent_cents,
     contract_version, driver_id)
    VALUES ('api-job', ?, ?, 'api-workspace', 'codex', 1, 'running', 1, 2,
      '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:00:00.000Z', 0, 0, 2, 'codex-app-server')`).run(boardId, cardId)
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, status, context_json, job_id, created_at, updated_at,
     driver_id)
    VALUES ('api-session', 'api-workspace', 'codex', 'running', '{}', 'api-job',
      '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z',
      'codex-app-server')`).run()
  const server = Fastify()
  const published: unknown[] = []
  server.decorateRequest('orchestraPrincipal', 'operator')
  await server.register(outcomeAnalyticsPlugin, {
    prefix: '/api/v1/os',
    db,
    isOperator: (request: FastifyRequest) => request.headers.authorization === 'Bearer operator',
    publish: (event) => { published.push(event) },
  })
  await server.ready()
  servers.push(server)
  return { server, db, boardId, published }
}

describe('outcome analytics focused registrar', () => {
  it('fails closed for mutations while keeping the dashboard readable', async () => {
    const { server, boardId } = await fixture()
    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/outcomes/activity`,
      payload: { id: 'forbidden', category: 'coordination.wake' },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json()).toMatchObject({ code: 'forbidden' })
    const dashboard = await server.inject({
      method: 'GET', url: `/api/v1/os/boards/${boardId}/outcomes/dashboard`,
    })
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json()).toMatchObject({
      board_id: boardId,
      usage: { provider_tokens: 0, tokens_per_accepted_delivery: null },
    })
  })

  it('records scoped observations and exposes the derived dashboard contract', async () => {
    const { server, boardId, published } = await fixture()
    const usage = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/outcomes/usage`,
      headers: operator,
      payload: {
        id: 'api-usage', sessionId: 'api-session', jobId: 'api-job', provider: 'codex',
        billingMode: 'unknown', cachedInputSemantics: 'subset',
        inputTokens: 900, cachedInputTokens: 400, outputTokens: 100,
        thinkingTokens: 20, contextInjectionTokens: 80, providerTotalTokens: 1000,
        observedAt: '2026-08-01T10:01:00.000Z',
      },
    })
    expect(usage.statusCode, usage.body).toBe(201)
    expect(usage.json().result).toMatchObject({ job_id: 'api-job', contract_ref: expect.stringMatching(/:v2$/) })
    expect(published).toContainEqual({
      board_id: boardId,
      type: 'outcome_analytics',
      data: { kind: 'usage.recorded', id: 'api-usage' },
    })
    const activity = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/outcomes/activity`,
      headers: operator,
      payload: {
        id: 'api-context', sessionId: 'api-session', jobId: 'api-job',
        category: 'context.selected', quantity: 3,
        occurredAt: '2026-08-01T10:01:00.000Z',
      },
    })
    expect(activity.statusCode, activity.body).toBe(201)
    const dashboard = await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/outcomes/dashboard?since=2026-08-01T10:00:00.000Z&until=2026-08-01T11:00:00.000Z`,
    })
    expect(dashboard.statusCode, dashboard.body).toBe(200)
    expect(dashboard.json()).toMatchObject({
      production_signals: {
        provider_usage: 'available',
        child_dispatch: 'available',
        context_injection: 'unavailable',
        context_selection: 'unavailable',
        exploration: 'unavailable',
        first_useful_result: 'unavailable',
        model_acknowledgement: 'unavailable',
        high_fanout_preflight: 'operator_plan_only',
      },
      usage: { provider_tokens: 1000, cached_input_tokens: 400 },
      context: { selected: 3 },
      by_job: [{ job_id: 'api-job', provider_tokens: 1000 }],
    })
  })

  it('requires confirmation for high fanout and exposes authorization only afterward', async () => {
    const { server, boardId } = await fixture()
    const planned = await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/outcomes/operations`,
      headers: operator,
      payload: {
        id: 'api-operation', operationKind: 'swarm', fanout: 10,
        estimatedTokens: 5000, reason: 'Parallel review', jobId: 'api-job',
        executionKey: 'api-native-execution',
      },
    })
    expect(planned.statusCode, planned.body).toBe(201)
    expect(planned.json().result.status).toBe('awaiting_confirmation')
    const blocked = await server.inject({
      method: 'POST', url: '/api/v1/os/outcomes/operations/api-operation/consume',
      headers: operator,
      payload: {
        executionKey: nativeOutcomeExecutionKey('api-job'), providerTokens: 5000, fanout: 10,
      },
    })
    expect(blocked.statusCode).toBe(409)
    const confirmed = await server.inject({
      method: 'POST', url: '/api/v1/os/outcomes/operations/api-operation/confirm',
      headers: operator, payload: {},
    })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect(confirmed.json().result.status).toBe('confirmed')
    const callerSuppliedKey = await server.inject({
      method: 'POST', url: '/api/v1/os/outcomes/operations/api-operation/consume',
      headers: operator,
      payload: { executionKey: 'api-native-execution', providerTokens: 5000, fanout: 10 },
    })
    expect(callerSuppliedKey.statusCode).toBe(409)
    const authorized = await server.inject({
      method: 'POST', url: '/api/v1/os/outcomes/operations/api-operation/consume',
      headers: operator,
      payload: {
        executionKey: nativeOutcomeExecutionKey('api-job'), providerTokens: 5000, fanout: 10,
      },
    })
    expect(authorized.statusCode, authorized.body).toBe(200)
  })

  it('publishes quality-aware benchmark comparison without claiming the beta gate', async () => {
    const { server, db, boardId } = await fixture()
    for (const [variant, tokens, quality] of [['before', 1000, 950], ['after', 600, 900]] as const) {
      const artifactId = `api-benchmark-${variant}-artifact`
      db.prepare(`INSERT INTO artifacts(id, board_id, kind, name, metadata, created_at)
        VALUES (?, ?, 'benchmark', ?, ?, '2026-08-01T10:01:00.000Z')`).run(
        artifactId, boardId, variant, JSON.stringify({ outcome_benchmark: {
          suite_key: 'api-suite', scenario_key: 'scenario', variant,
          provider_tokens: tokens, context_tokens: 0, accepted_deliveries: 1,
          quality_milli: quality, duration_ms: 1000,
        }, outcome_benchmark_evidence: {
          version: 1,
          verifier_ref: `api-test:${variant}`,
          provenance: { source_commit: 'c'.repeat(40), command: 'api benchmark' },
        } }),
      )
      const response = await server.inject({
        method: 'POST', url: `/api/v1/os/boards/${boardId}/outcomes/benchmarks`,
        headers: operator,
        payload: {
          id: `api-benchmark-${variant}`, suiteKey: 'api-suite', scenarioKey: 'scenario',
          variant, providerTokens: tokens, contextTokens: 0, acceptedDeliveries: 1,
          qualityMilli: quality, durationMs: 1000,
          evidenceRef: `artifact:${artifactId}`, observedAt: '2026-08-01T10:01:00.000Z',
        },
      })
      expect(response.statusCode, response.body).toBe(201)
    }
    const comparison = await server.inject({
      method: 'GET', url: `/api/v1/os/boards/${boardId}/outcomes/benchmarks/api-suite`,
    })
    expect(comparison.statusCode).toBe(200)
    expect(comparison.json()).toMatchObject({
      passed: false,
      representative_evidence_observed: false,
      gate_claimed: false,
      comparisons: [{ reason: 'quality_declined' }],
    })
  })
})

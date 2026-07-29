import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { JobMarketService } from '../src/agent-os/job-market.js'
import { openWorkPlugin } from '../src/agent-os/open-work-routes.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'
import { openDb } from '../src/db.js'

const actor = { type: 'operator' as const, id: 'open-work-api-test' }
const servers: FastifyInstance[] = []
const databases: Database.Database[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  while (databases.length) databases.pop()!.close()
})

async function fixture(options: { withOperatorHook?: boolean } = {}) {
  const db = openDb(':memory:')
  databases.push(db)
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/open-work-api', 'Open Work API')",
  ).run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'API candidate', 'Exercise the Open Work API')`).run(boardId).lastInsertRowid)
  const workspaceId = new WorkspaceStore(db).create({
    boardId,
    cardId,
    name: 'api-worktree',
    kind: 'worktree',
    rootPath: '/open-work-api',
    worktreePath: '/tmp/open-work-api',
    branch: 'test/open-work-api',
    baseRef: 'main',
  }).id
  const market = new JobMarketService(db).update(cardId, {
    objective: 'Exercise the Open Work API',
    deliverables: [{
      id: 'api-delivery',
      text: 'A stable API response',
      required: true,
    }],
    acceptance_criteria: [{
      id: 'api-criterion',
      text: 'The API is verified',
      required: true,
      deliverable_ids: ['api-delivery'],
      description: 'Run the API test',
      verifier: { kind: 'command', command: 'npm test -- open-work-api' },
      required_artifacts: [{ kind: 'test-log', name: 'open-work-api' }],
      priority: 5,
    }],
    required_capabilities: ['sqlite', 'typescript'],
    provider_constraints: ['codex'],
    model_constraints: ['gpt-5.4'],
    access_needs: ['workspace_write'],
    budget_tokens: 1_000,
    budget_cents: 100,
    budget_time_seconds: 300,
    priority: -2,
    workspace_id: workspaceId,
    base_ref: 'main',
    verify_commands: ['npm test -- open-work-api'],
  }, actor.id)
  const selected = new AgentProfileService(db).create({
    boardId,
    name: 'API agent',
    defaultProvider: 'codex',
    defaultModel: 'gpt-5.4',
    defaultAccessProfile: 'workspace_write',
    capabilities: ['sqlite', 'typescript'],
    actor,
    idempotencyKey: 'open-work-api:profile',
  })
  const scheduler = new JobScheduler(db)
  const orchestration = new OrchestrationService(db, scheduler)
  const server = Fastify()
  server.decorateRequest('orchestraPrincipal', 'operator')
  await server.register(openWorkPlugin, {
    prefix: '/api/v1/os',
    db,
    orchestration,
    supportedProviders: ['codex'],
    ...(options.withOperatorHook === false
      ? {}
      : {
          isOperator: (request: FastifyRequest) =>
            request.headers.authorization === 'Bearer operator',
        }),
  })
  servers.push(server)
  await server.ready()
  return { db, boardId, cardId, workspaceId, market, selected, server }
}

function snapshot(db: Database.Database, cardId: number): string {
  return JSON.stringify({
    contract: db.prepare('SELECT * FROM task_contracts WHERE card_id=?').get(cardId),
    market: db.prepare('SELECT * FROM job_market_contracts WHERE card_id=?').get(cardId),
    criteria: db.prepare(
      'SELECT * FROM job_market_criteria WHERE card_id=? ORDER BY criterion_id',
    ).all(cardId),
    dependencies: db.prepare(
      'SELECT * FROM job_market_dependencies WHERE card_id=? ORDER BY dependency_card_id',
    ).all(cardId),
    events: db.prepare('SELECT * FROM os_events WHERE card_id=? ORDER BY rowid').all(cardId),
  })
}

describe('Open Work API', () => {
  it('parses repeated capabilities, signed exact priority, and non-negative budgets', async () => {
    const { cardId, server } = await fixture()
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/os/open-work'
        + '?repository=%2Fopen-work-api'
        + '&capability=typescript'
        + '&capability=sqlite'
        + '&priority=-2'
        + '&dependency_readiness=ready'
        + '&max_tokens=1000'
        + '&max_cost_cents=100'
        + '&max_time_seconds=300',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      items: [{
        card_id: cardId,
        repository: '/open-work-api',
        priority: -2,
        dependency_readiness: 'ready',
        eligible_agent_count: 1,
      }],
      graph: {
        nodes: [expect.objectContaining({ card_id: cardId, readiness: 'ready' })],
        edges: [],
      },
    })
    const zero = await server.inject({
      method: 'GET',
      url: '/api/v1/os/open-work?max_tokens=0&max_cost_cents=0&max_time_seconds=0',
    })
    expect(zero.statusCode).toBe(200)
    expect(zero.json().items).toEqual([])
    expect((await server.inject({
      method: 'GET',
      url: '/api/v1/os/open-work?max_tokens=-1',
    })).statusCode).toBe(400)
  })

  it('previews without writes and enforces match compare-and-set at the route', async () => {
    const { db, cardId, market, selected, server } = await fixture()
    const before = snapshot(db, cardId)
    const preview = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/brief-preview`,
      payload: {
        contract: { objective: 'Preview-only API objective' },
        expected_market_version: market.market_version,
      },
    })

    expect(preview.statusCode).toBe(200)
    expect(preview.json().preview).toMatchObject({
      validation: { mode: 'publish', valid: true },
      agent_brief_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(preview.json().preview.agent_brief).toContain('Preview-only API objective')
    expect(snapshot(db, cardId)).toBe(before)

    const missingCas = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/open-work/match`,
      payload: {},
    })
    expect(missingCas.statusCode).toBe(400)
    expect(missingCas.json().error).toMatch(/expected_market_version is required/)
    const stale = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/open-work/match`,
      payload: { expected_market_version: market.market_version + 1 },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatch(/stale/)

    const matched = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/open-work/match`,
      payload: { expected_market_version: market.market_version },
    })
    expect(matched.statusCode).toBe(200)
    expect(matched.json().match).toMatchObject({
      card_id: cardId,
      market_version: market.market_version,
      eligible: true,
      eligible_agent_count: 1,
      selected_agent: {
        profile_id: selected.id,
        provider: 'codex',
        model: 'gpt-5.4',
      },
      decision_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it('guards dispatch authorization, route identity, confirmation, and idempotency', async () => {
    const { cardId, market, server } = await fixture()
    const matched = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/open-work/match`,
      payload: { expected_market_version: market.market_version },
    })
    const match = matched.json().match

    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/open-work/dispatch`,
      payload: { match, confirm: true },
    })
    expect(forbidden.statusCode).toBe(403)
    const wrongCard = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/open-work/dispatch`,
      headers: { authorization: 'Bearer operator', 'idempotency-key': 'api-wrong-card' },
      payload: { match: { ...match, card_id: cardId + 1 }, confirm: true },
    })
    expect(wrongCard.statusCode).toBe(400)
    expect(wrongCard.json().error).toMatch(/route card id/)
    const missingKey = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/open-work/dispatch`,
      headers: { authorization: 'Bearer operator' },
      payload: { match, confirm: true },
    })
    expect(missingKey.statusCode).toBe(400)
    expect(missingKey.json().error).toMatch(/Idempotency-Key/)
    const unconfirmed = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/open-work/dispatch`,
      headers: { authorization: 'Bearer operator', 'idempotency-key': 'api-unconfirmed' },
      payload: { match, confirm: false },
    })
    expect(unconfirmed.statusCode).toBe(400)
    expect(unconfirmed.json().error).toMatch(/confirm must be true/)
  })

  it('fails dispatch closed when composition omits the operator hook', async () => {
    const { cardId, market, server } = await fixture({ withOperatorHook: false })
    const matched = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/open-work/match`,
      payload: { expected_market_version: market.market_version },
    })
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/open-work/dispatch`,
      headers: {
        authorization: 'Bearer operator',
        'idempotency-key': 'api-missing-operator-hook',
      },
      payload: { match: matched.json().match, confirm: true },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toMatch(/operator authorization is required/)
  })
})

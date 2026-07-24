import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { JobMarketService } from '../src/agent-os/job-market.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { buildServer } from '../src/server.js'

function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/job-market', 'job-market')",
  ).run().lastInsertRowid)
  const otherBoardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/job-market-other', 'other')",
  ).run().lastInsertRowid)
  const cardId = Number(db.prepare(
    "INSERT INTO cards (board_id, title, description) VALUES (?, 'Ship typed work', 'Build the domain')",
  ).run(boardId).lastInsertRowid)
  const dependencyId = Number(db.prepare(
    "INSERT INTO cards (board_id, title, description, column_name) VALUES (?, 'Foundation', 'Finish first', 'done')",
  ).run(boardId).lastInsertRowid)
  const foreignCardId = Number(db.prepare(
    "INSERT INTO cards (board_id, title) VALUES (?, 'Foreign dependency')",
  ).run(otherBoardId).lastInsertRowid)
  return { db, boardId, cardId, dependencyId, foreignCardId }
}

describe('typed Job Market domain', () => {
  it('adds migration 009 without rewriting legacy contract rows', () => {
    const { db, cardId } = fixture()
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    )
    for (const table of [
      'job_market_contracts',
      'job_market_criteria',
      'job_market_dependencies',
    ]) expect(tables.has(table), table).toBe(true)
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id='009-job-market-domain'")
        .get() as { count: number }).count,
    ).toBe(1)

    const market = new JobMarketService(db).get(cardId)
    expect(market).toMatchObject({
      card_id: cardId,
      status: 'open',
      market_version: 1,
      contract: { objective: 'Build the domain' },
    })
    expect(market.criteria[0]).toMatchObject({
      description: 'Satisfy objective: Build the domain',
      verifier: { kind: 'human' },
      required_artifacts: [],
      priority: 0,
      owner: null,
    })
    db.close()
  })

  it('stores typed criteria, constraints, budgets, dependency rules, and granular audit events', () => {
    const { db, boardId, cardId, dependencyId, foreignCardId } = fixture()
    const events = new EventStore(db)
    const service = new JobMarketService(db, events)
    const workspaceId = 'job-market-workspace'
    db.prepare(`INSERT INTO workspaces (id, board_id, card_id, name, kind, root_path)
      VALUES (?, ?, ?, 'job market', 'shared', '/job-market')`)
      .run(workspaceId, boardId, cardId)

    const updated = service.update(cardId, {
      objective: 'Deliver the typed Job Market contract',
      deliverables: [{ id: 'deliverable-domain', text: 'Typed domain', required: true }],
      acceptance_criteria: [{
        id: 'criterion-tests',
        text: 'All focused tests pass',
        required: true,
        deliverable_ids: ['deliverable-domain'],
        description: 'Run the focused Job Market test suite.',
        verifier: { kind: 'command', command: 'npm test -- job-market' },
        required_artifacts: [{ kind: 'test-log', name: 'job-market-tests' }],
        priority: 9,
        owner: 'agent:verifier',
      }],
      dependency_rules: [{
        card_id: dependencyId,
        blocking_reason: 'The storage foundation must already be complete.',
        completion_condition: 'card_done',
      }],
      required_capabilities: ['typescript', 'sqlite'],
      provider_constraints: ['codex'],
      model_constraints: ['gpt-5.4'],
      access_needs: ['workspace_write'],
      budget_tokens: 20_000,
      budget_cents: 500,
      budget_time_seconds: 3_600,
      budget_retries: 2,
      budget_coordination_tokens: 2_000,
      budget_coordination_messages: 20,
      workspace_id: workspaceId,
    }, 'agent:planner')

    expect(updated).toMatchObject({
      market_version: 2,
      status: 'open',
      constraints: {
        required_capabilities: ['typescript', 'sqlite'],
        provider_constraints: ['codex'],
        model_constraints: ['gpt-5.4'],
        access_needs: ['workspace_write'],
      },
      budgets: {
        tokens: 20_000,
        cost_cents: 500,
        time_seconds: 3_600,
        retries: 2,
        coordination_tokens: 2_000,
        coordination_messages: 20,
      },
    })
    expect(updated.criteria).toEqual([expect.objectContaining({
      id: 'criterion-tests',
      description: 'Run the focused Job Market test suite.',
      verifier: { kind: 'command', command: 'npm test -- job-market' },
      required_artifacts: [{
        kind: 'test-log',
        name: 'job-market-tests',
        description: null,
      }],
      priority: 9,
      owner: 'agent:verifier',
    })])
    expect(updated.dependency_rules).toEqual([{
      card_id: dependencyId,
      blocking_reason: 'The storage foundation must already be complete.',
      completion_condition: 'card_done',
    }])

    expect(service.validate(cardId, 'launch', {
      provider: 'claude',
      model: 'claude-opus',
      accessProfile: 'workspace_write',
    })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringMatching(/provider claude/)]),
    })
    expect(service.validate(cardId, 'launch', {
      provider: 'codex',
      model: 'gpt-5.4',
      accessProfile: 'workspace_write',
    })).toMatchObject({
      valid: true,
      errors: [],
      warnings: [expect.stringMatching(/capabilities/)],
    })

    const auditKinds = events.listBoard(boardId, { cardId, limit: 100 })
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith('job_market.'))
    expect(auditKinds).toEqual(expect.arrayContaining([
      'job_market.scope_changed',
      'job_market.criterion_changed',
      'job_market.owner_changed',
      'job_market.dependency_changed',
      'job_market.budget_changed',
    ]))
    expect(
      events.listBoard(boardId, { workspaceId, cardId, limit: 100 })
        .filter((event) => event.kind.startsWith('job_market.')),
    ).toHaveLength(auditKinds.length)
    expect(() => service.update(cardId, {
      dependency_rules: [{
        card_id: foreignCardId,
        blocking_reason: 'Cross board',
        completion_condition: 'card_done',
      }],
    })).toThrow(/same board/)
    expect(() => service.update(cardId, {
      objective: 'This partial core update must roll back',
      budget_time_seconds: -1,
    })).toThrow(/positive integer/)
    expect(service.get(cardId).contract.objective).toBe('Deliver the typed Job Market contract')
    db.close()
  })

  it('blocks publish and canonical launch until every card_done dependency is done', () => {
    const { db, cardId, boardId } = fixture()
    const pendingDependencyId = Number(db.prepare(
      `INSERT INTO cards (board_id, title, description, column_name)
       VALUES (?, 'Still pending', 'Not done yet', 'backlog')`,
    ).run(boardId).lastInsertRowid)
    const service = new JobMarketService(db)
    service.update(cardId, {
      dependency_rules: [{
        card_id: pendingDependencyId,
        blocking_reason: 'The pending foundation must finish first.',
        completion_condition: 'card_done',
      }],
    })

    expect(service.validate(cardId, 'publish')).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([`dependency ${pendingDependencyId} is not complete`]),
    })
    expect(() => service.publish(cardId)).toThrow(/dependency .* is not complete/)
    expect(() => new OrchestrationService(db, new JobScheduler(db)).createCardJob({
      cardId,
      provider: 'claude',
    })).toThrow(/dependency .* is not complete/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })

    db.prepare("UPDATE cards SET column_name='done' WHERE id=?").run(pendingDependencyId)
    expect(service.validate(cardId, 'publish')).toMatchObject({ valid: true, errors: [] })
    expect(service.publish(cardId).status).toBe('open')
    db.close()
  })

  it('enforces the complete lifecycle state machine and audits transitions', () => {
    const { db, boardId, cardId } = fixture()
    const events = new EventStore(db)
    const service = new JobMarketService(db, events)

    expect(service.transition(cardId, 'cancelled', 'human', 'deprioritized').status).toBe('cancelled')
    expect(service.transition(cardId, 'draft', 'human', 'rewrite').status).toBe('draft')
    expect(service.publish(cardId, 'human').status).toBe('open')
    const assigned = service.transition(cardId, 'assigned', 'scheduler')
    expect(assigned.status).toBe('assigned')
    expect(service.transition(cardId, 'assigned', 'scheduler')).toEqual(assigned)
    expect(service.transition(cardId, 'running', 'runtime').status).toBe('running')
    expect(service.transition(cardId, 'submitted', 'agent').status).toBe('submitted')
    expect(service.transition(cardId, 'rejected', 'reviewer', 'missing proof').status).toBe('rejected')
    expect(service.transition(cardId, 'draft', 'human').status).toBe('draft')
    expect(service.publish(cardId, 'human').status).toBe('open')
    expect(service.transition(cardId, 'assigned', 'scheduler').status).toBe('assigned')
    expect(service.transition(cardId, 'running', 'runtime').status).toBe('running')
    expect(service.transition(cardId, 'submitted', 'agent').status).toBe('submitted')
    expect(service.transition(cardId, 'accepted', 'reviewer').status).toBe('accepted')
    expect(service.transition(cardId, 'archived', 'human').status).toBe('archived')
    expect(() => service.transition(cardId, 'open', 'human')).toThrow(/cannot transition/)

    const transitions = events.listBoard(boardId, {
      cardId,
      kind: 'job_market.lifecycle_changed',
      limit: 100,
    })
    expect(transitions).toHaveLength(14)
    db.close()
  })

  it('rejects stale lifecycle writes instead of applying an invalid concurrent transition', () => {
    const { db, cardId } = fixture()
    const service = new JobMarketService(db)
    const stale = service.get(cardId)
    service.transition(cardId, 'assigned', 'scheduler')

    expect(() => (
      service as unknown as {
        setStatus(
          current: ReturnType<JobMarketService['get']>,
          status: 'cancelled',
          actor: string,
        ): unknown
      }
    ).setStatus(stale, 'cancelled', 'stale-writer')).toThrow(/changed concurrently/)
    expect(service.get(cardId).status).toBe('assigned')
    db.close()
  })

  it('round-trips the exact nested constraints and budgets returned by the domain', () => {
    const { db, cardId } = fixture()
    const service = new JobMarketService(db)
    const configured = service.update(cardId, {
      required_capabilities: ['typescript'],
      provider_constraints: ['codex'],
      model_constraints: ['gpt-5.4'],
      access_needs: ['workspace_write'],
      budget_time_seconds: 3_600,
      budget_retries: 2,
      budget_coordination_tokens: 1_000,
      budget_coordination_messages: 10,
    })

    const roundTripped = service.update(cardId, {
      constraints: configured.constraints,
      budgets: configured.budgets,
    })
    expect(roundTripped.constraints).toEqual(configured.constraints)
    expect(roundTripped.budgets).toEqual(configured.budgets)
    expect(roundTripped.market_version).toBe(configured.market_version)
    const nestedBudgetUpdate = service.update(cardId, {
      budgets: {
        ...configured.budgets,
        tokens: 30_000,
        cost_cents: 750,
      },
    })
    expect(nestedBudgetUpdate.budgets).toEqual({
      ...configured.budgets,
      tokens: 30_000,
      cost_cents: 750,
    })
    expect(() => service.update(cardId, { constraints: [] })).toThrow(/constraints must be an object/)
    db.close()
  })

  it('blocks canonical launch when provider, model, or access constraints do not match', () => {
    const { db, cardId } = fixture()
    const market = new JobMarketService(db)
    market.update(cardId, {
      provider_constraints: ['codex'],
      model_constraints: ['gpt-5.4'],
      access_needs: ['workspace_write'],
    })
    const orchestration = new OrchestrationService(db, new JobScheduler(db))

    expect(() => orchestration.createCardJob({
      cardId,
      provider: 'claude',
      model: 'claude-opus',
    })).toThrow(/not launchable.*provider claude/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })

    const created = orchestration.createCardJob({
      cardId,
      provider: 'codex',
      model: 'gpt-5.4',
    })
    expect(created.job).toMatchObject({ provider: 'codex', model: 'gpt-5.4', status: 'queued' })
    db.close()
  })

  it('preserves the legacy TaskContract wire value and keeps default-open launches compatible', () => {
    const { db, cardId } = fixture()
    const legacy = new TaskContractService(db).getOrCreate(cardId)
    const market = new JobMarketService(db).get(cardId)

    expect(market.contract).toEqual(legacy)
    expect(market.status).toBe('open')
    expect(new JobMarketService(db).validate(cardId, 'launch', {
      provider: 'claude',
      model: null,
      accessProfile: 'workspace_write',
    })).toMatchObject({ valid: true, errors: [] })

    const created = new OrchestrationService(db, new JobScheduler(db)).createCardJob({
      cardId,
      provider: 'claude',
    })
    expect(created).toMatchObject({
      contract: {
        card_id: legacy.card_id,
        objective: legacy.objective,
        version: legacy.version,
      },
      job: { card_id: cardId, provider: 'claude', status: 'queued' },
    })
    db.close()
  })

  it('treats malformed legacy extension metadata as inert compatibility data', () => {
    const { db, cardId } = fixture()
    new TaskContractService(db).put(cardId, {
      acceptance_criteria: [{
        id: 'legacy-extension',
        text: 'Legacy metadata remains readable',
        metadata: {
          verifier: 'not-a-verifier-object',
          required_artifacts: { malformed: true },
        },
      }],
    })

    const market = new JobMarketService(db).get(cardId)
    expect(market.criteria[0]).toMatchObject({
      id: 'legacy-extension',
      verifier: { kind: 'human' },
      required_artifacts: [],
    })
    expect(market.contract.acceptance_criteria[0].metadata).toMatchObject({
      verifier: 'not-a-verifier-object',
      required_artifacts: { malformed: true },
    })
    db.close()
  })

  it('exposes typed update, validation, publish, and transition contracts over HTTP', async () => {
    const { db, boardId, cardId } = fixture()
    const token = 'job-market-token'
    const headers = { authorization: `Bearer ${token}` }
    const server = buildServer(db, undefined, { token })
    await server.ready()
    try {
      const updated = await server.inject({
        method: 'PUT',
        url: `/api/v1/os/cards/${cardId}/contract`,
        headers,
        payload: {
          acceptance_criteria: [{
            id: 'criterion-api',
            text: 'API works',
            description: 'Exercise the typed API.',
            verifier: { kind: 'human' },
            required_artifacts: ['http-log'],
            priority: 5,
            owner: 'agent:api-reviewer',
          }],
          providers: ['ignored'],
          provider_constraints: ['codex'],
          actor: 'agent:planner',
        },
      })
      expect(updated.statusCode).toBe(200)
      expect(updated.json()).toMatchObject({
        contract: { card_id: cardId },
        job_market: {
          criteria: [{
            id: 'criterion-api',
            description: 'Exercise the typed API.',
            owner: 'agent:api-reviewer',
          }],
          constraints: { provider_constraints: ['codex'] },
        },
      })

      const validation = await server.inject({
        method: 'GET',
        url: `/api/v1/os/cards/${cardId}/contract/validate?mode=launch&provider=codex&model=gpt-5.4&access_profile=workspace_write`,
        headers,
      })
      expect(validation.statusCode).toBe(200)
      expect(validation.json().validation.valid).toBe(true)

      const cancelled = await server.inject({
        method: 'POST',
        url: `/api/v1/os/cards/${cardId}/contract/transition`,
        headers,
        payload: { status: 'cancelled', actor: 'human', reason: 'pause' },
      })
      expect(cancelled.json().job_market.status).toBe('cancelled')
      const drafted = await server.inject({
        method: 'POST',
        url: `/api/v1/os/cards/${cardId}/contract/transition`,
        headers,
        payload: { status: 'draft', actor: 'human' },
      })
      expect(drafted.json().job_market.status).toBe('draft')
      const published = await server.inject({
        method: 'POST',
        url: `/api/v1/os/cards/${cardId}/contract/publish`,
        headers,
        payload: { actor: 'human' },
      })
      expect(published.json().job_market.status).toBe('open')
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM os_events WHERE board_id=? AND kind LIKE ?')
          .get(boardId, 'job_market.%') as { count: number }).count,
      ).toBeGreaterThan(0)
    } finally {
      await server.close()
      db.close()
    }
  })
})

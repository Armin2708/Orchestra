import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeAgentDefaults } from '../src/agent-defaults.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { JobScheduler, type Job, type JobExecutionResult, type JobExecutor } from '../src/agent-os/scheduler.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'
import { openDb } from '../src/db.js'
import { buildServer, type ConductorLike } from '../src/server.js'

type LaunchCall = Parameters<ConductorLike['launch']>[0]

class LifecycleExecutor implements JobExecutor {
  readonly launches: Job[] = []

  constructor(
    private readonly db: Database.Database,
    private readonly providers: readonly string[] = ['claude', 'codex'],
    private readonly beforeExecute?: (job: Job) => Promise<void> | void,
  ) {}

  supportedProviders(): readonly string[] {
    return this.providers
  }

  async execute(job: Job): Promise<JobExecutionResult> {
    this.launches.push(job)
    await this.beforeExecute?.(job)
    if (!job.card_id) return { status: 'running' }

    const board = this.db.prepare('SELECT project_path FROM boards WHERE id=?').get(job.board_id) as
      { project_path: string }
    const workspaces = new WorkspaceStore(this.db)
    const workspace = job.workspace_id
      ? workspaces.get(job.workspace_id)!
      : workspaces.create({
          boardId: job.board_id,
          cardId: job.card_id,
          name: `job-${job.card_id}`,
          kind: 'shared',
          rootPath: board.project_path,
        })
    new TaskContractService(this.db).put(job.card_id, { workspace_id: workspace.id })
    this.db.prepare('UPDATE jobs SET workspace_id=? WHERE id=?').run(workspace.id, job.id)

    const agentId = Number(this.db.prepare(`INSERT INTO agents
      (board_id, name, session_id, kind, status, provider, model, access_profile)
      VALUES (?, ?, ?, 'hired', 'active', ?, ?, 'workspace_write')`).run(
        job.board_id,
        `${job.provider}-job-${job.card_id}`,
        `agent-os:${job.id}`,
        job.provider,
        job.model,
      ).lastInsertRowid)
    const sessionId = `session-${job.id}`
    this.db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, agent_id, provider, external_id, model, status, context_json,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, datetime('now'), datetime('now'))`).run(
        sessionId,
        workspace.id,
        agentId,
        job.provider,
        `external-${job.id}`,
        job.model,
        JSON.stringify({ job_id: job.id, card_id: job.card_id }),
      )
    this.db.prepare(`UPDATE cards SET owner_agent_id=?, column_name='in_progress', updated_at=datetime('now')
      WHERE id=?`).run(agentId, job.card_id)
    return { status: 'running', detail: { workspace_id: workspace.id, session_id: sessionId } }
  }
}

const servers: FastifyInstance[] = []

afterEach(async () => {
  delete process.env.ORCHESTRA_CANONICAL_LAUNCH
  delete process.env.ORCHESTRA_MAX_LAUNCHED
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
})

async function fixture(options: {
  supportedProviders?: string[]
  beforeExecute?: (job: Job) => Promise<void> | void
  includeJobExecutor?: boolean
  includeScheduler?: boolean
} = {}) {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/repo', 'repo')")
    .run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Canonical route', 'Create one durable lifecycle')`).run(boardId).lastInsertRowid)
  const executor = new LifecycleExecutor(db, options.supportedProviders, options.beforeExecute)
  const scheduler = new JobScheduler(db, executor)
  const orchestration = new OrchestrationService(db, scheduler)
  const legacyCalls: LaunchCall[] = []
  const legacy: ConductorLike = {
    isHired: () => false,
    hire: () => ({}),
    deliver: () => true,
    task: () => true,
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => true,
    fire: async () => true,
    launch: (request) => {
      legacyCalls.push(request)
      return {
        agent: { id: 91, name: 'legacy-agent', provider: request.provider ?? 'claude' },
        card: { id: request.cardId, column: 'in_progress' },
      }
    },
    isLaunched: () => false,
    providerCatalog: async () => [
      {
        id: 'claude', name: 'Claude', available: options.supportedProviders?.includes('claude') ?? true,
        models: [], source: 'live', updated_at: null,
      },
      {
        id: 'codex', name: 'Codex', available: options.supportedProviders?.includes('codex') ?? true,
        models: [], source: 'live', updated_at: null,
      },
    ],
  }
  const drivers = ['claude', 'codex'].map((id) => ({
    id,
    available: executor.supportedProviders().includes(id),
    capabilities: ['launch', 'attach', 'send', 'interrupt', 'events'],
  }))
  const server = buildServer(db, () => legacy, {
    agentOs: {
      ...(options.includeJobExecutor === false ? {} : { jobExecutor: executor }),
      ...(options.includeScheduler === false ? {} : { scheduler }),
      orchestration,
      drivers,
    },
  })
  servers.push(server)
  await server.ready()
  return { db, boardId, cardId, executor, scheduler, orchestration, legacyCalls, server }
}

const lifecycleCounts = (db: Database.Database, cardId: number) => ({
  contracts: (db.prepare('SELECT COUNT(*) AS count FROM task_contracts WHERE card_id=?').get(cardId) as { count: number }).count,
  jobs: (db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE card_id=?').get(cardId) as { count: number }).count,
  workspaces: (db.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE card_id=?').get(cardId) as { count: number }).count,
  sessions: (db.prepare(`SELECT COUNT(*) AS count FROM agent_sessions
    WHERE json_extract(context_json, '$.card_id')=?`).get(cardId) as { count: number }).count,
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const dispatchIds = (dispatch: {
  started: string[]
  completed: string[]
  blocked: string[]
  deferred: string[]
}) => [...dispatch.started, ...dispatch.completed, ...dispatch.blocked, ...dispatch.deferred]

describe('canonical card launch routes', () => {
  it('keeps the feature gate off on the exact legacy launch path', async () => {
    const { db, boardId, cardId, legacyCalls, server } = await fixture()

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/cards/${cardId}/launch`,
      payload: { provider: 'claude', model: 'legacy-model', effort: 'low', access_profile: 'read_only' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      agent: { id: 91, name: 'legacy-agent', provider: 'claude' },
      card: { id: cardId, column: 'in_progress' },
    })
    expect(legacyCalls).toHaveLength(1)
    expect(legacyCalls[0]).toMatchObject({
      boardId,
      cardId,
      cwd: '/repo',
      provider: 'claude',
      model: 'legacy-model',
      effort: 'low',
      accessProfile: 'read_only',
    })
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })
  })

  it('creates one linked contract, job, workspace, session, agent, and card lifecycle when gated on', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const { db, boardId, cardId, executor, legacyCalls, server } = await fixture()

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/cards/${cardId}/launch`,
      payload: { provider: 'codex', model: 'gpt-route' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({
      mode: 'canonical',
      provider: 'codex',
      queued: false,
      contract: { card_id: cardId, objective: 'Create one durable lifecycle' },
      job: { board_id: boardId, card_id: cardId, provider: 'codex', model: 'gpt-route', status: 'running' },
      workspace: { board_id: boardId, card_id: cardId, status: 'active' },
      session: { provider: 'codex', model: 'gpt-route', status: 'running' },
      agent: { provider: 'codex', model: 'gpt-route', status: 'active' },
      card: { id: cardId, column: 'in_progress' },
    })
    expect(body.contract.workspace_id).toBe(body.workspace.id)
    expect(body.job.workspace_id).toBe(body.workspace.id)
    expect(body.session.workspace_id).toBe(body.workspace.id)
    expect(body.session.context).toMatchObject({ job_id: body.job.id, card_id: cardId })
    expect(body.session.agent_id).toBe(body.agent.id)
    expect(executor.launches.map((job) => job.id)).toEqual([body.job.id])
    expect(legacyCalls).toHaveLength(0)
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 1, jobs: 1, workspaces: 1, sessions: 1 })
  })

  it('delegates card-linked Agent OS job creation to the same orchestration service', async () => {
    const { db, boardId, cardId, executor, server } = await fixture()
    writeAgentDefaults(db, {
      worker: { provider: 'codex', model: 'gpt-default', effort: null },
      specialist: { provider: 'claude', model: null, effort: null },
    })
    const workspace = new WorkspaceStore(db).create({
      boardId,
      cardId,
      name: 'contract workspace',
      rootPath: '/repo',
    })
    new TaskContractService(db).put(cardId, {
      workspace_id: workspace.id,
      priority: 7,
      budget_tokens: 4_000,
      budget_cents: 125,
    })

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/jobs`,
      payload: { card_id: cardId, provider: 'codex' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().job).toMatchObject({
      board_id: boardId,
      card_id: cardId,
      workspace_id: workspace.id,
      provider: 'codex',
      model: null,
      priority: 7,
      budget_tokens: 4_000,
      budget_cents: 125,
      status: 'running',
    })
    expect(response.json()).toMatchObject({
      dispatch: { started: [response.json().job.id], completed: [], blocked: [], deferred: [] },
      dispatch_error: null,
    })
    expect(executor.launches).toHaveLength(1)
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 1, jobs: 1, workspaces: 1, sessions: 1 })
  })

  it('allows only one lifecycle when Board and Agent OS endpoints race for the same card', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const { db, boardId, cardId, executor, server } = await fixture()

    const [boardResponse, osResponse] = await Promise.all([
      server.inject({ method: 'POST', url: `/api/v1/cards/${cardId}/launch`, payload: { provider: 'claude' } }),
      server.inject({ method: 'POST', url: `/api/v1/os/boards/${boardId}/jobs`, payload: { card_id: cardId, provider: 'claude' } }),
    ])

    const responses = [boardResponse, osResponse]
    expect(responses.filter((response) => response.statusCode >= 200 && response.statusCode < 300)).toHaveLength(1)
    const conflict = responses.find((response) => response.statusCode === 409)
    expect(conflict?.json()).toMatchObject({ error: expect.stringMatching(/active job|already launched/) })
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 1, jobs: 1, workspaces: 1, sessions: 1 })
    expect(executor.launches).toHaveLength(1)
  })

  it('rejects a cross-board Agent OS card command before writing any lifecycle records', async () => {
    const { db, cardId, executor, legacyCalls, server } = await fixture()
    const otherBoardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/other', 'other')")
      .run().lastInsertRowid)

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${otherBoardId}/jobs`,
      payload: { card_id: cardId, provider: 'claude' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: expect.stringMatching(/different board/), code: 'validation_error' })
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })
    expect(executor.launches).toHaveLength(0)
    expect(legacyCalls).toHaveLength(0)
  })

  it('keeps a committed canonical job discoverable when the scheduler kick fails', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const { db, cardId, executor, legacyCalls, scheduler, server } = await fixture()
    vi.spyOn(scheduler, 'tick').mockRejectedValueOnce(new Error('scheduler kick failed'))

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/cards/${cardId}/launch`,
      payload: { provider: 'claude' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      mode: 'canonical',
      queued: true,
      job: { card_id: cardId, status: 'queued' },
      dispatch: { started: [], completed: [], blocked: [], deferred: [] },
      dispatch_error: 'scheduler kick failed',
    })
    expect(db.prepare('SELECT id, status FROM jobs WHERE card_id=?').get(cardId)).toEqual({
      id: response.json().job.id,
      status: 'queued',
    })
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 1, jobs: 1, workspaces: 0, sessions: 0 })
    expect(executor.launches).toHaveLength(0)
    expect(legacyCalls).toHaveLength(0)
  })

  it('returns only request-local job IDs even when a scheduler tick dispatches other boards', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const { db, cardId, scheduler, server } = await fixture()
    const otherBoardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/other', 'other')")
      .run().lastInsertRowid)
    const unrelated = scheduler.create({ boardId: otherBoardId, provider: 'claude', priority: 99 })

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/cards/${cardId}/launch`,
      payload: { provider: 'claude' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.job.status).toBe('running')
    expect(dispatchIds(body.dispatch)).toEqual([body.job.id])
    expect(dispatchIds(body.dispatch)).not.toContain(unrelated.id)
    expect(scheduler.get(unrelated.id)?.status).toBe('running')
  })

  it('reports honestly queued when an already-active scheduler tick cannot see the new job', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const entered = deferred()
    const release = deferred()
    const setup = await fixture({
      beforeExecute: async (job) => {
        if (job.card_id === null) {
          entered.resolve()
          await release.promise
        }
      },
    })
    setup.scheduler.create({ boardId: setup.boardId, provider: 'claude', priority: 99 })
    const activeTick = setup.scheduler.tick()
    await entered.promise

    const responsePromise = setup.server.inject({
      method: 'POST',
      url: `/api/v1/cards/${setup.cardId}/launch`,
      payload: { provider: 'claude' },
    })
    await vi.waitFor(() => {
      expect(setup.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 2 })
    })
    release.resolve()
    await activeTick
    const response = await responsePromise

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      mode: 'canonical',
      queued: true,
      job: { card_id: setup.cardId, status: 'queued' },
      dispatch: { started: [], completed: [], blocked: [], deferred: [] },
      dispatch_error: null,
    })
    expect(lifecycleCounts(setup.db, setup.cardId)).toEqual({ contracts: 1, jobs: 1, workspaces: 0, sessions: 0 })
  })

  it('rechecks Board launchability inside the canonical transaction after route prechecks', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const { db, cardId, legacyCalls, orchestration, server } = await fixture()
    const launchCard = orchestration.launchCard.bind(orchestration)
    vi.spyOn(orchestration, 'launchCard').mockImplementation(async (input) => {
      db.prepare("UPDATE cards SET column_name='done' WHERE id=?").run(cardId)
      return launchCard(input)
    })

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/cards/${cardId}/launch`,
      payload: { provider: 'claude' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: expect.stringMatching(/already done/), code: 'validation_error' })
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })
    expect(legacyCalls).toHaveLength(0)
  })

  it('preserves the legacy missing-card envelope before the gated canonical branch', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const { db, legacyCalls, server } = await fixture()

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/cards/999999/launch',
      payload: { provider: 'claude' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'not found' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_contracts').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })
    expect(legacyCalls).toHaveLength(0)
  })

  it('rejects unsupported Board controls and unavailable providers before writing canonical records', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const { db, cardId, executor, legacyCalls, server } = await fixture({ supportedProviders: ['claude'] })

    const effort = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/launch`, payload: { provider: 'claude', effort: 'high' },
    })
    expect(effort.statusCode).toBe(501)
    expect(effort.json()).toMatchObject({ error: expect.stringMatching(/do not persist effort/), code: 'not_supported' })
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })

    const access = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/launch`, payload: { provider: 'claude', access_profile: 'full_access' },
    })
    expect(access.statusCode).toBe(501)
    expect(access.json()).toMatchObject({ error: expect.stringMatching(/accessProfile/), code: 'not_supported' })
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })

    const unavailable = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/launch`, payload: { provider: 'codex' },
    })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json()).toMatchObject({ error: expect.stringMatching(/codex.*unavailable/i), provider: 'codex' })
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })
    expect(executor.launches).toHaveLength(0)
    expect(legacyCalls).toHaveLength(0)
  })

  it('does not treat the raw shell driver as a Board agent provider', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const { db, cardId, executor, legacyCalls, server } = await fixture({
      supportedProviders: ['claude', 'shell'],
    })

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/cards/${cardId}/launch`,
      payload: { provider: 'shell' },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: expect.stringMatching(/shell.*unavailable/i), provider: 'shell' })
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })
    expect(executor.launches).toHaveLength(0)
    expect(legacyCalls).toHaveLength(0)
  })

  it('reports missing canonical executor configuration as unsupported instead of provider downtime', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const { db, cardId, legacyCalls, server } = await fixture({ includeJobExecutor: false })

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/cards/${cardId}/launch`,
      payload: { provider: 'claude' },
    })

    expect(response.statusCode).toBe(501)
    expect(response.json()).toMatchObject({
      error: expect.stringMatching(/executor.*not available|configuration/i),
      code: 'not_supported',
    })
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })
    expect(legacyCalls).toHaveLength(0)
  })

  it('fails server readiness when an injected orchestration service is not paired with its scheduler', async () => {
    let readinessError: unknown
    try {
      await fixture({ includeScheduler: false })
    } catch (error) {
      readinessError = error
    }
    expect(String(readinessError)).toMatch(/orchestration.*scheduler|scheduler.*required/i)
  })

  it('preserves Agent OS unsupported-provider deferral and leaves cardless jobs on the scheduler path', async () => {
    const unsupported = await fixture({ supportedProviders: ['claude'] })
    const deferred = await unsupported.server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${unsupported.boardId}/jobs`,
      payload: { card_id: unsupported.cardId, provider: 'codex' },
    })

    expect(deferred.statusCode).toBe(201)
    expect(deferred.json().job).toMatchObject({
      card_id: unsupported.cardId,
      provider: 'codex',
      status: 'queued',
      error: expect.stringMatching(/unavailable/),
    })
    expect(lifecycleCounts(unsupported.db, unsupported.cardId)).toEqual({
      contracts: 1, jobs: 1, workspaces: 0, sessions: 0,
    })

    const cardless = await fixture()
    const response = await cardless.server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${cardless.boardId}/jobs`,
      payload: { provider: 'claude' },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().job).toMatchObject({ card_id: null, provider: 'claude', status: 'running' })
    expect(cardless.db.prepare('SELECT COUNT(*) AS count FROM task_contracts').get()).toEqual({ count: 0 })
  })
})

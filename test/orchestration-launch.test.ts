import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeAgentDefaults } from '../src/agent-defaults.js'
import { AgentHomeLifecycleService } from '../src/agent-os/agent-home-lifecycle.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { ConversationService } from '../src/agent-os/conversations.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { JobScheduler, type Job, type JobExecutionResult, type JobExecutor } from '../src/agent-os/scheduler.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'
import { openDb } from '../src/db.js'
import { buildServer, type ConductorLike } from '../src/server.js'
import {
  normalizeCanonicalLifecycleRecord,
  normalizeCanonicalLifecycleResponse,
} from '../web/src/osApi.js'

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

    const workspaces = new WorkspaceStore(this.db)
    const workspace = workspaces.get(job.workspace_id!)!
    new TaskContractService(this.db).put(job.card_id, { workspace_id: workspace.id })
    this.db.prepare('UPDATE jobs SET workspace_id=? WHERE id=?').run(workspace.id, job.id)

    const agentId = Number(this.db.prepare(`INSERT INTO agents
      (board_id, name, session_id, kind, status, provider, model, effort, access_profile)
      VALUES (?, ?, ?, 'hired', 'active', ?, ?, ?, ?)`).run(
        job.board_id,
        `${job.provider}-job-${job.card_id}`,
        `agent-os:${job.id}`,
        job.provider,
        job.model,
        job.effort,
        job.access_profile,
      ).lastInsertRowid)
    const reserved = this.db.prepare(`SELECT id, context_json FROM agent_sessions
      WHERE json_extract(context_json, '$.job_id')=?`).get(job.id) as { id: string; context_json: string }
    const sessionId = reserved.id
    this.db.prepare(`UPDATE agent_sessions SET agent_id=?, external_id=?, status='running', context_json=?,
      updated_at=datetime('now') WHERE id=?`).run(
        agentId,
        `external-${job.id}`,
        JSON.stringify({ ...JSON.parse(reserved.context_json), managed_identity: true }),
        sessionId,
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
  const workspaces = new WorkspaceStore(db)
  const orchestration = new OrchestrationService(db, scheduler, {
    materialize: async (workspace) => workspaces.update(workspace.id, { status: 'active' }),
  })
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
      mode: 'legacy',
      orchestration: {
        lifecycle: 'legacy',
        contract_attached: false,
        job_id: null,
        workspace_id: null,
        session_id: null,
      },
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
      orchestration: {
        lifecycle: 'canonical',
        contract_attached: true,
        job_id: expect.any(String),
        workspace_id: expect.any(String),
        session_id: expect.any(String),
      },
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
    expect(body.orchestration).toEqual({
      lifecycle: 'canonical',
      contract_attached: true,
      job_id: body.job.id,
      workspace_id: body.workspace.id,
      session_id: body.session.id,
      contract_id: `card:${cardId}:v${body.contract.version}`,
      contract_version: body.contract.version,
      correlation_id: body.session.context.correlation_id,
      idempotency_key: null,
    })
    expect(body.delivery.contract_id).toBe(body.orchestration.contract_id)
    expect(body.session.agent_id).toBe(body.agent.id)
    expect(executor.launches.map((job) => job.id)).toEqual([body.job.id])
    expect(legacyCalls).toHaveLength(0)
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 1, jobs: 1, workspaces: 1, sessions: 1 })

    const tasked = await server.inject({
      method: 'POST',
      url: `/api/v1/agents/${body.agent.id}/task`,
      payload: { text: 'continue the contracted work' },
    })
    expect(tasked.json()).toEqual({
      ok: true,
      mode: 'canonical',
      orchestration: {
        lifecycle: 'canonical',
        contract_attached: true,
        job_id: body.job.id,
        workspace_id: body.workspace.id,
        session_id: body.session.id,
      },
    })
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
      mode: 'canonical',
      orchestration: {
        lifecycle: 'canonical',
        contract_attached: true,
        job_id: response.json().job.id,
        workspace_id: workspace.id,
        session_id: response.json().session.id,
      },
      contract: { card_id: cardId },
      workspace: { id: workspace.id, card_id: cardId },
      session: { provider: 'codex', workspace_id: workspace.id },
      dispatch: { started: [response.json().job.id], completed: [], blocked: [], deferred: [] },
      dispatch_error: null,
    })
    const created = response.json()
    expect(normalizeCanonicalLifecycleResponse(created).job.id).toBe(created.job.id)
    expect(created.orchestration).toMatchObject({
      contract_id: `card:${cardId}:v${created.contract.version}`,
      contract_version: created.contract.version,
      correlation_id: created.session.context.correlation_id,
      idempotency_key: null,
    })
    expect(created.delivery.contract_id).toBe(created.orchestration.contract_id)

    new EventStore(db).append({
      boardId,
      jobId: 'unrelated-job',
      kind: 'job.queued',
      source: 'test',
      payload: { job_id: 'unrelated-job' },
    })
    const lifecycle = await server.inject({
      method: 'GET',
      url: `/api/v1/os/jobs/${created.job.id}`,
    })
    expect(lifecycle.statusCode).toBe(200)
    expect(normalizeCanonicalLifecycleRecord(lifecycle.json()).job.id).toBe(created.job.id)
    expect(lifecycle.json()).toMatchObject({
      mode: 'canonical',
      orchestration: {
        job_id: created.job.id,
        workspace_id: created.workspace.id,
        session_id: created.session.id,
        contract_id: created.orchestration.contract_id,
      },
      job: { id: created.job.id },
      workspace: { id: created.workspace.id },
      session: { id: created.session.id },
      delivery: { id: created.delivery.id, contract_id: created.orchestration.contract_id },
      events: expect.any(Array),
    })
    expect(lifecycle.json().events.length).toBeGreaterThan(0)
    expect(lifecycle.json().events.every((event: { job_id: string }) => event.job_id === created.job.id)).toBe(true)
    expect(lifecycle.json().events.some((event: { job_id: string }) => event.job_id === 'unrelated-job')).toBe(false)

    new EventStore(db).append({
      boardId,
      cardId,
      jobId: created.job.id,
      workspaceId: 'wrong-workspace',
      contractId: created.orchestration.contract_id,
      correlationId: created.orchestration.correlation_id,
      kind: 'job.started',
      source: 'test',
      payload: { job_id: created.job.id },
    })
    const corruptLifecycle = await server.inject({
      method: 'GET',
      url: `/api/v1/os/jobs/${created.job.id}`,
    })
    expect(corruptLifecycle.statusCode).toBe(409)
    expect(corruptLifecycle.json().error).toMatch(/event scope is missing or inconsistent/)
    expect(executor.launches).toHaveLength(1)
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 1, jobs: 1, workspaces: 1, sessions: 1 })
  })

  it('keeps Agent Home audits inside the exact canonical job scope', async () => {
    const { db, boardId, cardId, server } = await fixture()
    const launch = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/jobs`,
      payload: { card_id: cardId, provider: 'codex' },
    })
    expect(launch.statusCode).toBe(201)
    const created = launch.json()

    const profiles = new AgentProfileService(db)
    const conversations = new ConversationService(db)
    const profile = profiles.create({
      boardId,
      name: 'Canonical transcript',
      actor: { type: 'system', id: 'test-runtime' },
      idempotencyKey: 'canonical-transcript:profile',
    })
    const conversation = conversations.listConversations(profile.id)[0]
    const linkedWithoutJobInput = conversations.linkSession(created.session.id, {
      profileId: profile.id,
      conversationId: conversation.id,
      mode: 'managed',
      actor: { type: 'system', id: 'test-runtime' },
      idempotencyKey: 'canonical-transcript:link',
      correlationId: 'provider-link-correlation',
    })
    expect(linkedWithoutJobInput.job_id).toBe(created.job.id)
    const replayCanonicalLink = () => conversations.linkSession(created.session.id, {
      profileId: profile.id,
      conversationId: conversation.id,
      mode: 'managed',
      actor: { type: 'system', id: 'test-runtime' },
      idempotencyKey: 'canonical-transcript:link',
      correlationId: 'provider-link-correlation',
    })
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, status, context_json)
      VALUES ('canonical-link-replay-other-session', ?, 'codex', 'running', '{}')`)
      .run(created.workspace.id)
    const canonicalLinkAudit = db.prepare(`SELECT source, workspace_id, card_id,
      session_id, process_id, job_id, contract_id, correlation_id, causation_id,
      event_version, payload
      FROM os_events
      WHERE board_id=? AND idempotency_key='canonical-transcript:link'`)
      .get(boardId) as Record<string, unknown>
    const envelopeMutations = [
      ['source', 'hostile'],
      ['workspace_id', 'wrong-workspace'],
      ['card_id', cardId + 100],
      ['session_id', 'canonical-link-replay-other-session'],
      ['process_id', 'wrong-process'],
      ['job_id', 'wrong-job'],
      ['contract_id', 'wrong-contract'],
      ['correlation_id', 'stale-link-correlation'],
      ['causation_id', 'wrong-causation'],
      ['event_version', 2],
    ] as const
    for (const [column, corruptValue] of envelopeMutations) {
      db.prepare(`UPDATE os_events SET ${column}=?
        WHERE board_id=? AND idempotency_key='canonical-transcript:link'`)
        .run(corruptValue, boardId)
      expect(replayCanonicalLink).toThrow(/replay scope is inconsistent/)
      db.prepare(`UPDATE os_events SET ${column}=?
        WHERE board_id=? AND idempotency_key='canonical-transcript:link'`)
        .run(canonicalLinkAudit[column], boardId)
    }
    const payloadMutations = [
      ['$.session_id', 'canonical-link-replay-other-session'],
      ['$.profile_id', 'wrong-profile'],
      ['$.conversation_id', 'wrong-conversation'],
      ['$.actor.id', 'hostile-actor'],
    ] as const
    for (const [path, corruptValue] of payloadMutations) {
      db.prepare(`UPDATE os_events SET payload=json_set(payload, ?, ?)
        WHERE board_id=? AND idempotency_key='canonical-transcript:link'`)
        .run(path, corruptValue, boardId)
      expect(replayCanonicalLink).toThrow(/replay payload is inconsistent/)
      db.prepare(`UPDATE os_events SET payload=?
        WHERE board_id=? AND idempotency_key='canonical-transcript:link'`)
        .run(canonicalLinkAudit.payload, boardId)
    }
    expect(replayCanonicalLink().id).toBe(created.session.id)
    expect(conversations.linkSession(created.session.id, {
      profileId: profile.id,
      conversationId: conversation.id,
      jobId: null,
      mode: 'managed',
      actor: { type: 'system', id: 'test-runtime' },
      idempotencyKey: 'canonical-transcript:link-null-job',
      correlationId: 'provider-link-correlation',
    }).job_id).toBe(created.job.id)
    expect(() => conversations.linkSession(created.session.id, {
      profileId: profile.id,
      conversationId: conversation.id,
      jobId: 'different-job',
      mode: 'managed',
      actor: { type: 'system', id: 'test-runtime' },
      idempotencyKey: 'canonical-transcript:link-request-mismatch',
    })).toThrow(/job identities are inconsistent/)
    const canonicalContext = conversations.requireSession(created.session.id).context
    db.prepare('UPDATE agent_sessions SET context_json=? WHERE id=?')
      .run(JSON.stringify({ ...canonicalContext, job_id: 'different-job' }), created.session.id)
    expect(() => conversations.linkSession(created.session.id, {
      profileId: profile.id,
      conversationId: conversation.id,
      mode: 'managed',
      actor: { type: 'system', id: 'test-runtime' },
      idempotencyKey: 'canonical-transcript:link-session-mismatch',
    })).toThrow(/job identities are inconsistent/)
    db.prepare('UPDATE agent_sessions SET context_json=? WHERE id=?')
      .run(JSON.stringify(canonicalContext), created.session.id)

    const initial = conversations.appendEvent(created.session.id, {
      idempotencyKey: 'canonical-transcript:event',
      dedupeKey: 'provider:event:canonical',
      kind: 'assistant',
      projectedText: 'One durable response',
      actor: { type: 'agent', id: 'codex' },
      correlationId: 'provider-turn-correlation',
    })
    db.prepare(`UPDATE os_events SET correlation_id='stale-conversation-correlation'
      WHERE board_id=? AND idempotency_key='canonical-transcript:event'`).run(boardId)
    expect(() => conversations.appendEvent(created.session.id, {
      idempotencyKey: 'canonical-transcript:event',
      dedupeKey: 'provider:event:canonical',
      kind: 'assistant',
      projectedText: 'One durable response',
      actor: { type: 'agent', id: 'codex' },
      correlationId: 'provider-turn-correlation',
    })).toThrow(/replay scope is inconsistent/)
    db.prepare(`UPDATE os_events SET correlation_id=?
      WHERE board_id=? AND idempotency_key='canonical-transcript:event'`)
      .run(created.orchestration.correlation_id, boardId)
    expect(conversations.appendEvent(created.session.id, {
      idempotencyKey: 'canonical-transcript:event',
      dedupeKey: 'provider:event:canonical',
      kind: 'assistant',
      projectedText: 'One durable response',
      actor: { type: 'agent', id: 'codex' },
      correlationId: 'provider-turn-correlation',
    })).toMatchObject({ replayed: true, event: { id: initial.event.id } })
    expect(conversations.appendEvent(created.session.id, {
      idempotencyKey: 'canonical-transcript:event-replay',
      dedupeKey: 'provider:event:canonical',
      kind: 'assistant',
      projectedText: 'One durable response',
      actor: { type: 'agent', id: 'codex' },
      correlationId: 'provider-turn-correlation',
    })).toMatchObject({ replayed: true, event: { id: initial.event.id } })
    expect(() => conversations.appendEvent(created.session.id, {
      idempotencyKey: 'canonical-transcript:event-conflict',
      dedupeKey: 'provider:event:canonical',
      kind: 'assistant',
      projectedText: 'A conflicting response',
      actor: { type: 'agent', id: 'codex' },
      correlationId: 'provider-conflict-correlation',
    })).toThrow(/conflict/)

    const lifecycle = new AgentHomeLifecycleService(db, {
      actionLeaseId: 'canonical-scope-daemon-before-restart',
    })
    const renamed = await lifecycle.run(created.session.id, 'rename', {
      actor: { type: 'operator', id: 'canonical-scope-test' },
      idempotencyKey: 'canonical-transcript:rename',
      correlationId: 'operator-action-correlation',
      name: 'Durable canonical transcript',
    })
    expect(renamed.session.display_name).toBe('Durable canonical transcript')
    db.prepare(`UPDATE os_events SET correlation_id='stale-action-correlation'
      WHERE board_id=? AND idempotency_key='canonical-transcript:rename'`).run(boardId)
    await expect(lifecycle.run(created.session.id, 'rename', {
      actor: { type: 'operator', id: 'canonical-scope-test' },
      idempotencyKey: 'canonical-transcript:rename',
      correlationId: 'operator-action-correlation',
      name: 'Durable canonical transcript',
    })).rejects.toThrow(/request audit scope is inconsistent/)
    db.prepare(`UPDATE os_events SET correlation_id=?
      WHERE board_id=? AND idempotency_key='canonical-transcript:rename'`)
      .run(created.orchestration.correlation_id, boardId)
    const replayCanonicalRename = () => lifecycle.run(created.session.id, 'rename', {
      actor: { type: 'operator', id: 'canonical-scope-test' },
      idempotencyKey: 'canonical-transcript:rename',
      correlationId: 'operator-action-correlation',
      name: 'Durable canonical transcript',
    })
    const canonicalCompletionAudit = db.prepare(`SELECT source, workspace_id, card_id,
      session_id, process_id, job_id, contract_id, correlation_id, causation_id,
      event_version, payload
      FROM os_events
      WHERE board_id=? AND kind='agent_session.rename'
        AND json_extract(payload, '$.action_id')=?`)
      .get(boardId, renamed.action.id) as Record<string, unknown>
    const completionEnvelopeMutations = [
      ['source', 'hostile'],
      ['workspace_id', 'wrong-workspace'],
      ['card_id', cardId + 100],
      ['session_id', 'canonical-link-replay-other-session'],
      ['process_id', 'wrong-process'],
      ['job_id', 'wrong-job'],
      ['contract_id', 'wrong-contract'],
      ['correlation_id', 'stale-completion-correlation'],
      ['causation_id', 'wrong-causation'],
      ['event_version', 2],
    ] as const
    for (const [column, corruptValue] of completionEnvelopeMutations) {
      db.prepare(`UPDATE os_events SET ${column}=?
        WHERE board_id=? AND kind='agent_session.rename'
          AND json_extract(payload, '$.action_id')=?`)
        .run(corruptValue, boardId, renamed.action.id)
      await expect(replayCanonicalRename()).rejects
        .toThrow(/completion audit scope is inconsistent/)
      db.prepare(`UPDATE os_events SET ${column}=?
        WHERE board_id=? AND kind='agent_session.rename'
          AND json_extract(payload, '$.action_id')=?`)
        .run(canonicalCompletionAudit[column], boardId, renamed.action.id)
    }
    const completionPayloadMutations = [
      ['$.session_id', 'canonical-link-replay-other-session'],
      ['$.result_session_id', 'canonical-link-replay-other-session'],
      ['$.profile_id', 'wrong-profile'],
      ['$.conversation_id', 'wrong-conversation'],
      ['$.action', 'pause'],
      ['$.request_fingerprint', 'wrong-fingerprint'],
      ['$.actor.id', 'hostile-actor'],
    ] as const
    for (const [path, corruptValue] of completionPayloadMutations) {
      db.prepare(`UPDATE os_events SET payload=json_set(payload, ?, ?)
        WHERE board_id=? AND kind='agent_session.rename'
          AND json_extract(payload, '$.action_id')=?`)
        .run(path, corruptValue, boardId, renamed.action.id)
      await expect(replayCanonicalRename()).rejects
        .toThrow(/completion audit scope is inconsistent/)
      db.prepare(`UPDATE os_events SET payload=?
        WHERE board_id=? AND kind='agent_session.rename'
          AND json_extract(payload, '$.action_id')=?`)
        .run(canonicalCompletionAudit.payload, boardId, renamed.action.id)
    }
    expect((await replayCanonicalRename()).action.replayed).toBe(true)

    db.prepare(`INSERT INTO agent_session_actions (
      id, board_id, session_id, result_session_id, idempotency_key, action,
      request_fingerprint, status, lease_id, actor_type, actor_id, created_at, updated_at
    ) VALUES (
      'canonical-interrupted-action', ?, ?, NULL, 'canonical-transcript:interrupted',
      'rename', 'canonical-interrupted-fingerprint', 'pending',
      'canonical-scope-daemon-before-restart', 'operator', 'canonical-scope-test',
      datetime('now'), datetime('now')
    )`).run(boardId, created.session.id)
    new AgentHomeLifecycleService(db, {
      actionLeaseId: 'canonical-scope-daemon-after-restart',
    })
    expect(db.prepare(`SELECT status, error_code FROM agent_session_actions
      WHERE id='canonical-interrupted-action'`).get()).toEqual({
      status: 'failed',
      error_code: 'action_interrupted',
    })

    const snapshot = await server.inject({
      method: 'GET',
      url: `/api/v1/os/jobs/${created.job.id}`,
    })
    expect(snapshot.statusCode).toBe(200)
    const agentHomeEvents = snapshot.json().events.filter(
      (event: { source: string }) => event.source === 'agent-home',
    )
    expect(agentHomeEvents.map((event: { kind: string }) => event.kind)).toEqual([
      'agent_session.action_interrupted',
      'agent_session.rename',
      'agent_session.action_requested',
      'conversation.event_conflict',
      'conversation.event_replayed',
      'conversation.event_appended',
      'agent_session.linked',
      'agent_session.linked',
    ])
    for (const event of agentHomeEvents) {
      expect(event).toMatchObject({
        workspace_id: created.workspace.id,
        card_id: cardId,
        session_id: created.session.id,
        job_id: created.job.id,
        contract_id: created.orchestration.contract_id,
        correlation_id: created.orchestration.correlation_id,
      })
    }
  })

  it('fails closed when a stale no-job action claims another board', async () => {
    const { db, boardId } = await fixture()
    const workspaceId = 'cross-board-no-job-workspace'
    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status)
      VALUES (?, ?, 'No-job workspace', 'shared', '/cross-board-no-job', 'active')`)
      .run(workspaceId, boardId)
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, status, context_json)
      VALUES ('cross-board-no-job-session', ?, 'codex', 'running', '{}')`)
      .run(workspaceId)
    const otherBoardId = Number(db.prepare(`
      INSERT INTO boards (project_path, name)
      VALUES ('/cross-board-stale-action', 'Cross-board stale action')
    `).run().lastInsertRowid)
    db.prepare(`INSERT INTO agent_session_actions (
      id, board_id, session_id, result_session_id, idempotency_key, action,
      request_fingerprint, status, lease_id, actor_type, actor_id, created_at, updated_at
    ) VALUES (
      'cross-board-stale-action', ?, 'cross-board-no-job-session', NULL,
      'cross-board-stale-action:request', 'rename', 'cross-board-stale-fingerprint',
      'pending', 'stale-daemon-lease', 'operator', 'cross-board-test',
      datetime('now'), datetime('now')
    )`).run(otherBoardId)

    expect(() => new AgentHomeLifecycleService(db, {
      actionLeaseId: 'replacement-daemon-lease',
    })).toThrow(/board scope is inconsistent/)
    expect(db.prepare(`SELECT status, error_code FROM agent_session_actions
      WHERE id='cross-board-stale-action'`).get()).toEqual({
      status: 'pending',
      error_code: null,
    })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE idempotency_key='agent-home-action-reconciled:cross-board-stale-action'`)
      .get()).toEqual({ count: 0 })
  })

  it('replays and reads the frozen contract after the editable contract advances', async () => {
    const { db, boardId, cardId, server } = await fixture()
    const request = {
      card_id: cardId,
      provider: 'codex',
      idempotency_key: 'frozen-contract-replay',
    }
    const first = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/jobs`,
      payload: request,
    })
    expect(first.statusCode).toBe(201)
    const original = normalizeCanonicalLifecycleResponse(first.json())

    const editable = new TaskContractService(db).put(cardId, { objective: 'A later contract revision' })
    expect(editable.version).toBeGreaterThan(original.contract.version!)

    const replay = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/jobs`,
      payload: request,
    })
    const refreshed = await server.inject({
      method: 'GET',
      url: `/api/v1/os/jobs/${original.job.id}`,
    })

    expect(replay.statusCode).toBe(201)
    expect(refreshed.statusCode).toBe(200)
    const replayed = normalizeCanonicalLifecycleResponse(replay.json())
    const lifecycle = normalizeCanonicalLifecycleRecord(refreshed.json())
    for (const snapshot of [replayed, lifecycle]) {
      expect(snapshot.job.id).toBe(original.job.id)
      expect(snapshot.contract).toMatchObject({
        version: original.contract.version,
        objective: original.contract.objective,
      })
      expect(snapshot.orchestration.contract_id).toBe(original.orchestration.contract_id)
    }
    expect(new TaskContractService(db).getOrCreate(cardId)).toMatchObject({
      version: editable.version,
      objective: 'A later contract revision',
    })
  })

  it('does not manufacture canonical contract or delivery records for a scheduler-only job', async () => {
    const { db, boardId, cardId, scheduler, server } = await fixture()
    const job = scheduler.create({ boardId, cardId, provider: 'codex' })
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 0, jobs: 1, workspaces: 0, sessions: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM delivery_reports WHERE job_id=?').get(job.id))
      .toEqual({ count: 0 })

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/os/jobs/${job.id}`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/no durable delivery report/)
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 0, jobs: 1, workspaces: 0, sessions: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM delivery_reports WHERE job_id=?').get(job.id))
      .toEqual({ count: 0 })
  })

  it('forwards one idempotency key through Board and Agent OS canonical entrypoints', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const board = await fixture()
    const boardLaunch = vi.spyOn(board.orchestration, 'launchCard')

    const boardResponse = await board.server.inject({
      method: 'POST',
      url: `/api/v1/cards/${board.cardId}/launch`,
      headers: { 'idempotency-key': 'board-request-1' },
      payload: { provider: 'claude' },
    })

    expect(boardResponse.statusCode).toBe(200)
    expect(boardLaunch).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'board-request-1' }))

    const api = await fixture()
    const apiLaunch = vi.spyOn(api.orchestration, 'launchCard')
    const apiResponse = await api.server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${api.boardId}/jobs`,
      payload: { card_id: api.cardId, provider: 'codex', idempotency_key: 'api-request-1' },
    })

    expect(apiResponse.statusCode).toBe(201)
    expect(apiLaunch).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'api-request-1' }))
  })

  it('rejects conflicting header and body idempotency keys before creating canonical work', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const board = await fixture()
    const boardResponse = await board.server.inject({
      method: 'POST',
      url: `/api/v1/cards/${board.cardId}/launch`,
      headers: { 'idempotency-key': 'header-key' },
      payload: { provider: 'claude', idempotency_key: 'body-key' },
    })
    expect(boardResponse.statusCode).toBe(400)
    expect(lifecycleCounts(board.db, board.cardId)).toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })

    const api = await fixture()
    const apiResponse = await api.server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${api.boardId}/jobs`,
      headers: { 'idempotency-key': 'header-key' },
      payload: { card_id: api.cardId, provider: 'claude', idempotency_key: 'body-key' },
    })
    expect(apiResponse.statusCode).toBe(400)
    expect(lifecycleCounts(api.db, api.cardId)).toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })
  })

  it('rejects coalesced duplicate headers and singleton body arrays before creating canonical work', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const setup = await fixture()

    const repeatedHeader = await setup.server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${setup.boardId}/jobs`,
      headers: { 'idempotency-key': ['one', 'two'] },
      payload: { card_id: setup.cardId, provider: 'codex' },
    })
    const snakeArray = await setup.server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${setup.boardId}/jobs`,
      payload: { card_id: setup.cardId, provider: 'codex', idempotency_key: ['one'] },
    })
    const camelArray = await setup.server.inject({
      method: 'POST',
      url: `/api/v1/cards/${setup.cardId}/launch`,
      payload: { provider: 'codex', idempotencyKey: ['one'] },
    })

    expect([repeatedHeader.statusCode, snakeArray.statusCode, camelArray.statusCode]).toEqual([400, 400, 400])
    expect(repeatedHeader.json().error).toMatch(/exactly once/)
    expect(snakeArray.json().error).toMatch(/must be a string/)
    expect(camelArray.json().error).toMatch(/must be a string/)
    expect(lifecycleCounts(setup.db, setup.cardId))
      .toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })
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
    expect(lifecycleCounts(db, cardId)).toEqual({ contracts: 1, jobs: 1, workspaces: 1, sessions: 1 })
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
    expect(lifecycleCounts(setup.db, setup.cardId)).toEqual({ contracts: 1, jobs: 1, workspaces: 1, sessions: 1 })
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

  it('persists Board launch controls and still rejects unavailable providers before canonical writes', async () => {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    const effortSetup = await fixture({ supportedProviders: ['claude'] })

    const effort = await effortSetup.server.inject({
      method: 'POST', url: `/api/v1/cards/${effortSetup.cardId}/launch`,
      payload: { provider: 'claude', effort: 'high', access_profile: 'full_access' },
    })
    expect(effort.statusCode).toBe(200)
    expect(effort.json().job).toMatchObject({ effort: 'high', access_profile: 'full_access', status: 'running' })
    expect(effortSetup.executor.launches[0]).toMatchObject({ effort: 'high', access_profile: 'full_access' })

    const unavailableSetup = await fixture({ supportedProviders: ['claude'] })
    const unavailable = await unavailableSetup.server.inject({
      method: 'POST', url: `/api/v1/cards/${unavailableSetup.cardId}/launch`, payload: { provider: 'codex' },
    })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json()).toMatchObject({ error: expect.stringMatching(/codex.*unavailable/i), provider: 'codex' })
    expect(lifecycleCounts(unavailableSetup.db, unavailableSetup.cardId))
      .toEqual({ contracts: 0, jobs: 0, workspaces: 0, sessions: 0 })
    expect(unavailableSetup.executor.launches).toHaveLength(0)
    expect(unavailableSetup.legacyCalls).toHaveLength(0)
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
      contracts: 1, jobs: 1, workspaces: 1, sessions: 1,
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

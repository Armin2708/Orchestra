import { Command } from 'commander'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAgentOsCommands, type AgentOsCliDeps } from '../src/agent-os-cli.js'
import { createAgentOsRuntime, type AgentOsRuntime } from '../src/agent-os/runtime-integration.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { JobScheduler, type Job, type JobExecutionResult, type JobExecutor } from '../src/agent-os/scheduler.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'
import { openDb } from '../src/db.js'
import { buildServer, type ConductorLike } from '../src/server.js'

type EntryPoint = 'board' | 'api' | 'cli'

class AcceptanceExecutor implements JobExecutor {
  constructor(private readonly db: Database.Database) {}

  supportedProviders(): readonly string[] {
    return ['claude', 'codex']
  }

  async execute(job: Job): Promise<JobExecutionResult> {
    if (!job.card_id) return { status: 'running' }
    const workspace = new WorkspaceStore(this.db).create({
      boardId: job.board_id,
      cardId: job.card_id,
      name: `card-${job.card_id}`,
      kind: 'worktree',
      rootPath: '/repo',
      worktreePath: `/repo-card-${job.card_id}`,
      branch: `card-${job.card_id}`,
      baseRef: 'main',
    })
    new TaskContractService(this.db).put(job.card_id, { workspace_id: workspace.id })
    this.db.prepare('UPDATE jobs SET workspace_id=? WHERE id=?').run(workspace.id, job.id)
    const agentId = Number(this.db.prepare(`INSERT INTO agents
      (board_id, name, session_id, kind, status, provider, model, access_profile)
      VALUES (?, ?, ?, 'hired', 'active', ?, ?, 'workspace_write')`).run(
      job.board_id, `${job.provider}-acceptance`, `agent-os:${job.id}`, job.provider, job.model,
    ).lastInsertRowid)
    const sessionId = `session-${job.id}`
    this.db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, agent_id, provider, external_id, model, status, context_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, datetime('now'), datetime('now'))`).run(
      sessionId, workspace.id, agentId, job.provider, `external-${job.id}`, job.model,
      JSON.stringify({ job_id: job.id, card_id: job.card_id, workspace_id: workspace.id }),
    )
    this.db.prepare("UPDATE cards SET owner_agent_id=?, column_name='in_progress' WHERE id=?").run(agentId, job.card_id)
    return { status: 'running', detail: { workspace_id: workspace.id, session_id: sessionId } }
  }
}

const servers: FastifyInstance[] = []
const runtimes: AgentOsRuntime[] = []

afterEach(async () => {
  delete process.env.ORCHESTRA_CANONICAL_LAUNCH
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.shutdown()))
})

async function acceptanceFixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/repo', 'Acceptance')")
    .run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Canonical acceptance', 'Prove equivalent durable lifecycle')`).run(boardId).lastInsertRowid)
  const executor = new AcceptanceExecutor(db)
  const scheduler = new JobScheduler(db, executor)
  const orchestration = new OrchestrationService(db, scheduler)
  const conductor: ConductorLike = {
    isHired: () => false,
    hire: () => ({}),
    deliver: () => true,
    task: () => true,
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => true,
    fire: async () => true,
    launch: () => { throw new Error('legacy launch must not run in canonical acceptance') },
    isLaunched: () => false,
    providerCatalog: async () => [],
  }
  const server = buildServer(db, () => conductor, {
    agentOs: {
      jobExecutor: executor,
      scheduler,
      orchestration,
      drivers: ['claude', 'codex'].map((id) => ({ id, available: true, capabilities: ['launch'] })),
    },
  })
  servers.push(server)
  await server.ready()
  return { db, boardId, cardId, server }
}

const responseBody = async (server: FastifyInstance, method: string, url: string, body?: unknown) => {
  const response = await server.inject({ method, url, ...(body === undefined ? {} : { payload: body }) })
  const parsed = response.json()
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(parsed.error ?? `HTTP ${response.statusCode}`)
  return parsed
}

async function launch(entry: EntryPoint, fixture: Awaited<ReturnType<typeof acceptanceFixture>>) {
  const { boardId, cardId, server } = fixture
  if (entry === 'board') {
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'
    return responseBody(server, 'POST', `/api/v1/cards/${cardId}/launch`, { provider: 'codex', model: 'gpt-acceptance' })
  }
  if (entry === 'api') {
    return responseBody(server, 'POST', `/api/v1/os/boards/${boardId}/jobs`, {
      card_id: cardId, provider: 'codex', model: 'gpt-acceptance',
    })
  }
  const output: string[] = []
  const deps: AgentOsCliDeps = {
    api: (method, path, body) => responseBody(server, method, `/api/v1${path}`, body),
    ensureReady: async () => {},
    resolveBoard: async () => ({ id: boardId }),
    output: (line) => output.push(line),
    readStdin: () => '',
    attachProcess: async () => {},
  }
  const program = new Command().name('orchestra').exitOverride()
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
  registerAgentOsCommands(program, deps)
  await program.parseAsync([
    'node', 'orchestra', 'job', 'create', String(cardId), '--board', String(boardId),
    '--provider', 'codex', '--model', 'gpt-acceptance', '--json',
  ])
  return JSON.parse(output.at(-1) ?? '{}')
}

const replaceIds = (value: unknown, ids: Record<string, string>): unknown => {
  if (Array.isArray(value)) return value.map((item) => replaceIds(item, ids))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceIds(item, ids)]))
  }
  if (typeof value === 'string' && ids[value]) return ids[value]
  return value
}

function durableSnapshot(db: Database.Database, boardId: number, cardId: number) {
  const contract = db.prepare('SELECT * FROM task_contracts WHERE card_id=?').get(cardId) as Record<string, unknown>
  const job = db.prepare('SELECT * FROM jobs WHERE card_id=? ORDER BY rowid DESC LIMIT 1').get(cardId) as Record<string, unknown>
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(job.workspace_id) as Record<string, unknown>
  const session = db.prepare(`SELECT * FROM agent_sessions
    WHERE json_extract(context_json, '$.job_id')=? ORDER BY rowid DESC LIMIT 1`).get(job.id) as Record<string, unknown>
  const delivery = db.prepare('SELECT id FROM delivery_reports WHERE job_id=? ORDER BY rowid DESC LIMIT 1')
    .get(job.id) as { id: string }
  const ids = {
    [String(job.id)]: '$job',
    [String(workspace.id)]: '$workspace',
    [String(session.id)]: '$session',
    [String(session.external_id)]: '$external',
    [String(delivery.id)]: '$delivery',
  }
  const events = (db.prepare('SELECT * FROM os_events WHERE board_id=? ORDER BY rowid').all(boardId) as Record<string, unknown>[])
    .map((event) => ({
      workspace_id: replaceIds(event.workspace_id, ids),
      card_id: event.card_id,
      session_id: replaceIds(event.session_id, ids),
      kind: event.kind,
      source: event.source,
      payload: replaceIds(JSON.parse(String(event.payload)), ids),
    }))
  return {
    contract: {
      objective: contract.objective,
      workspace_id: replaceIds(contract.workspace_id, ids),
      version: contract.version,
    },
    job: {
      id: '$job', board_id: job.board_id, card_id: job.card_id,
      workspace_id: replaceIds(job.workspace_id, ids), provider: job.provider, model: job.model,
      priority: job.priority, status: job.status, attempts: job.attempts,
    },
    workspace: {
      id: '$workspace', board_id: workspace.board_id, card_id: workspace.card_id, kind: workspace.kind,
      root_path: workspace.root_path, worktree_path: workspace.worktree_path, branch: workspace.branch,
      base_ref: workspace.base_ref, status: workspace.status,
    },
    session: {
      id: '$session', workspace_id: replaceIds(session.workspace_id, ids), agent_id: Number(session.agent_id),
      provider: session.provider, external_id: '$external', model: session.model, status: session.status,
      context: replaceIds(JSON.parse(String(session.context_json)), ids),
    },
    events,
  }
}

describe('Milestone A canonical orchestration acceptance', () => {
  it('produces an equivalent contract/job/workspace/session/event snapshot from Board, API, and CLI', async () => {
    const snapshots: Record<EntryPoint, ReturnType<typeof durableSnapshot>> = {} as Record<EntryPoint, ReturnType<typeof durableSnapshot>>
    for (const entry of ['board', 'api', 'cli'] as const) {
      const fixture = await acceptanceFixture()
      const response = await launch(entry, fixture)
      const snapshot = durableSnapshot(fixture.db, fixture.boardId, fixture.cardId)
      expect(response.job.id).toBe((fixture.db.prepare('SELECT id FROM jobs WHERE card_id=?').get(fixture.cardId) as { id: string }).id)
      expect([...response.dispatch.started, ...response.dispatch.completed]).toContain(response.job.id)
      expect(snapshot.events.map((event) => event.kind)).toEqual(expect.arrayContaining(['job.queued', 'job.started']))
      snapshots[entry] = snapshot
    }

    expect(snapshots.api).toEqual(snapshots.board)
    expect(snapshots.cli).toEqual(snapshots.board)
  })

  it('allows only one durable lifecycle when Board, API, and CLI race on one card', async () => {
    const fixture = await acceptanceFixture()
    const results = await Promise.allSettled([
      launch('board', fixture),
      launch('api', fixture),
      launch('cli', fixture),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(2)
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM task_contracts WHERE card_id=?').get(fixture.cardId))
      .toEqual({ count: 1 })
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE card_id=?').get(fixture.cardId))
      .toEqual({ count: 1 })
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE card_id=?').get(fixture.cardId))
      .toEqual({ count: 1 })
    expect(fixture.db.prepare(`SELECT COUNT(*) AS count FROM agent_sessions
      WHERE json_extract(context_json, '$.card_id')=?`).get(fixture.cardId)).toEqual({ count: 1 })
  })

  it('reconciles a non-resumable running lifecycle after daemon restart without duplicating it', async () => {
    const fixture = await acceptanceFixture()
    await launch('api', fixture)
    const before = durableSnapshot(fixture.db, fixture.boardId, fixture.cardId)
    await fixture.server.close()
    servers.splice(servers.indexOf(fixture.server), 1)

    const restarted = createAgentOsRuntime(fixture.db)
    runtimes.push(restarted)
    const result = await restarted.reconcileJobs()
    const after = durableSnapshot(fixture.db, fixture.boardId, fixture.cardId)

    expect(result).toEqual({ resumed: [], recovered: [expect.any(String)] })
    expect(after.job.id).toBe(before.job.id)
    expect(after.workspace.id).toBe(before.workspace.id)
    expect(after.session.id).toBe(before.session.id)
    expect(after.job).toMatchObject({ status: 'blocked', attempts: 1 })
    expect(after.session).toMatchObject({ status: 'failed' })
    expect(after.events.filter((event) => event.kind === 'job.blocked')).toHaveLength(1)
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE card_id=?').get(fixture.cardId))
      .toEqual({ count: 1 })
  })
})

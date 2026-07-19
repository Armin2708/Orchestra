import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { writeAgentDefaults } from '../src/agent-defaults.js'
import { createAgentOsRuntime } from '../src/agent-os/runtime-integration.js'
import { openDb } from '../src/db.js'
import {
  CODEX_CAPABILITIES,
  CodexManagedAgentRuntime,
  ProviderAgentManager,
  ProviderUnavailableError,
  type ManagedAgentDriver,
} from '../src/provider-agent-manager.js'
import type {
  DriverCapabilities,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
} from '../src/runtime/types.js'
import { buildServer, type ConductorLike } from '../src/server.js'

type Feed = {
  queue: DriverEvent[]
  waiting: Array<() => void>
  closed: boolean
}

class FakeCodexDriver implements ManagedAgentDriver {
  readonly id = 'codex'
  readonly launches: DriverLaunchRequest[] = []
  readonly sends: Array<[string, string]> = []
  readonly updates: Array<[string, Record<string, unknown>]> = []
  readonly approvals: Array<[string, string, string, string | undefined]> = []
  readonly sessions = new Map<string, DriverSession>()
  private readonly feeds = new Map<string, Feed>()
  private sequence = 0

  capabilities(): DriverCapabilities & { tokenBudget: true; costBudget: false } {
    return {
      attach: true,
      streaming: true,
      interrupt: true,
      stop: true,
      rawTerminal: false,
      resume: true,
      tokenBudget: true,
      costBudget: false,
    }
  }

  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    this.launches.push(request)
    const n = ++this.sequence
    const session: DriverSession = {
      id: `codex:${n}`,
      externalId: request.externalId ?? `thread-${n}`,
      driverId: this.id,
      workspaceId: request.workspaceId,
      status: 'running',
      startedAt: new Date().toISOString(),
      metadata: { ...request.metadata },
    }
    this.sessions.set(session.id, session)
    this.feeds.set(session.id, { queue: [], waiting: [], closed: false })
    return session
  }

  async attach(externalId: string): Promise<DriverSession | null> {
    return [...this.sessions.values()].find((session) => session.externalId === externalId) ?? null
  }

  async send(sessionId: string, text: string): Promise<void> {
    this.sends.push([sessionId, text])
  }

  async interrupt(sessionId: string): Promise<void> {
    this.emit(sessionId, { type: 'status', data: 'interrupted', metadata: { turnActive: false } })
  }

  async stop(sessionId: string): Promise<void> {
    this.emit(sessionId, { type: 'exit', data: 'Codex session stopped' })
    const feed = this.feeds.get(sessionId)
    if (feed) { feed.closed = true; feed.waiting.splice(0).forEach((wake) => wake()) }
  }

  async *events(sessionId: string): AsyncIterable<DriverEvent> {
    const feed = this.feeds.get(sessionId)
    if (!feed) throw new Error(`missing feed ${sessionId}`)
    while (true) {
      while (feed.queue.length) yield feed.queue.shift()!
      if (feed.closed) return
      await new Promise<void>((resolve) => feed.waiting.push(resolve))
    }
  }

  async updateSession(sessionId: string, update: Record<string, unknown>): Promise<void> {
    this.updates.push([sessionId, update])
  }

  async resolveApproval(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'allow_session' | 'deny' | 'cancel',
    message?: string,
  ): Promise<boolean> {
    this.approvals.push([sessionId, requestId, decision, message])
    return true
  }

  emit(sessionId: string, event: Omit<DriverEvent, 'sessionId' | 'seq' | 'at'>): void {
    const feed = this.feeds.get(sessionId)
    if (!feed) throw new Error(`missing feed ${sessionId}`)
    feed.queue.push({
      sessionId,
      seq: feed.queue.length + 1,
      at: new Date().toISOString(),
      ...event,
    })
    feed.waiting.shift()?.()
  }
}

const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition never became true')
}

const claudeStub = (db: ReturnType<typeof openDb>) => {
  const calls: any[] = []
  const live = new Set<number>()
  const stub: ConductorLike = {
    isHired: (id) => live.has(id),
    hire: (options) => {
      calls.push(options)
      db.prepare(`INSERT INTO agents (board_id, name, kind, provider, status)
        VALUES (?, ?, 'hired', 'claude', 'active')
        ON CONFLICT(board_id, name) DO UPDATE SET status='active', provider='claude'`)
        .run(options.boardId, options.name ?? `claude-${calls.length}`)
      const row = db.prepare('SELECT * FROM agents WHERE board_id=? ORDER BY id DESC LIMIT 1').get(options.boardId) as any
      live.add(row.id)
      return row
    },
    deliver: () => true,
    task: () => true,
    transcript: () => ({ lines: [], working: null, info: { permissionMode: 'bypassPermissions' } }),
    subagents: () => [],
    interruptAgent: async (id) => live.has(id),
    fire: async (id) => live.delete(id),
    launch: (request) => ({ agent: stub.hire({ ...request, provider: 'claude' }) }),
    isLaunched: () => false,
    setPermissionMode: async (id) => live.has(id),
    resolvePermission: () => true,
    setModel: async (id) => live.has(id),
    setEffort: async (id) => live.has(id) ? 'ok' : 'not-found',
    providerCatalog: async () => [{
      id: 'claude', name: 'Claude', available: true, models: [], source: 'unavailable', updated_at: null,
    }],
  }
  return { stub, calls, live }
}

const setup = () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/project', 'project')").run()
  const bus = new EventEmitter()
  const driver = new FakeCodexDriver()
  const codex = new CodexManagedAgentRuntime(db, bus, driver)
  const claude = claudeStub(db)
  const manager = new ProviderAgentManager(db, bus, claude.stub, codex)
  return { db, bus, driver, codex, claude, manager }
}

it('routes the stored worker default to Codex and queues work until the thread is ready', async () => {
  const t = setup()
  writeAgentDefaults(t.db, {
    worker: { provider: 'codex', model: 'gpt-5.4', effort: 'high' },
    specialist: { provider: 'claude', model: null, effort: null },
  })

  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'codex-owl' })
  expect(agent).toMatchObject({ provider: 'codex', status: 'starting', access_profile: 'workspace_write' })
  expect(t.claude.calls).toHaveLength(0)
  expect(t.manager.task(agent.id, 'implement the card')).toBe(true)

  await until(() => t.driver.sends.length === 1)
  expect(t.driver.launches[0]).toMatchObject({ model: 'gpt-5.4', accessProfile: 'workspace_write' })
  expect(t.driver.launches[0].metadata).toMatchObject({ agentId: agent.id, effort: 'high' })
  expect(t.driver.sends[0][1]).toBe('implement the card')
  expect(t.db.prepare('SELECT status, external_session_id FROM agents WHERE id=?').get(agent.id))
    .toMatchObject({ status: 'active', external_session_id: 'thread-1' })

  t.driver.emit('codex:1', { type: 'output', data: 'working', metadata: { turnId: 'turn-1' } })
  await until(() => t.manager.transcript(agent.id).lines.some((line: any) => line.text === 'working'))
  expect(t.manager.transcript(agent.id).info).toMatchObject({
    provider: 'codex', model: 'gpt-5.4', effort: 'high', accessProfile: 'workspace_write',
  })

  expect(await t.manager.setModel(agent.id, 'gpt-5.5')).toBe(true)
  expect(await t.manager.setEffort(agent.id, 'xhigh')).toBe('ok')
  expect(await t.manager.setAccessProfile(agent.id, 'read_only')).toBe(true)
  expect(t.driver.updates).toEqual([
    ['codex:1', { model: 'gpt-5.5' }],
    ['codex:1', { effort: 'xhigh' }],
    ['codex:1', { accessProfile: 'read_only' }],
  ])
})

it('never falls back to Claude when the selected Codex provider is unavailable', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/project', 'project')").run()
  writeAgentDefaults(db, {
    worker: { provider: 'codex', model: null, effort: null },
    specialist: { provider: 'codex', model: null, effort: null },
  })
  const claude = claudeStub(db)
  const manager = new ProviderAgentManager(db, new EventEmitter(), claude.stub)

  expect(() => manager.hire({ boardId: 1, cwd: '/project' })).toThrow(ProviderUnavailableError)
  expect(claude.calls).toHaveLength(0)
  expect(db.prepare('SELECT COUNT(*) count FROM agents').get()).toMatchObject({ count: 0 })

  const driver = new FakeCodexDriver()
  const codex = new CodexManagedAgentRuntime(db, new EventEmitter(), driver)
  const disconnected = new ProviderAgentManager(db, new EventEmitter(), claude.stub, codex, {
    id: 'codex',
    name: 'Codex',
    capabilities: CODEX_CAPABILITIES,
    isRuntimeAvailable: () => false,
    catalog: async () => ({ id: 'codex', name: 'Codex', available: false, models: [], source: 'unavailable', updated_at: null }),
    health: async () => ({ available: false, status: 'unavailable', updated_at: new Date().toISOString() }),
  })
  expect(() => disconnected.hire({ boardId: 1, cwd: '/project', provider: 'codex' })).toThrow(ProviderUnavailableError)
  expect(db.prepare('SELECT COUNT(*) count FROM agents').get()).toMatchObject({ count: 0 })

  const explicit = manager.hire({ boardId: 1, cwd: '/project', provider: 'claude', name: 'claude-fox' })
  expect(explicit.provider).toBe('claude')
  expect(claude.calls[0]).toMatchObject({ provider: 'claude', name: 'claude-fox' })
  expect(claude.calls[0].model).toBeUndefined()
})

it('uses specialist provider defaults for verifier agents', async () => {
  const t = setup()
  writeAgentDefaults(t.db, {
    worker: { provider: 'claude', model: null, effort: null },
    specialist: { provider: 'codex', model: 'gpt-5.4', effort: 'medium' },
  })

  const verifier = t.manager.hire({ boardId: 1, cwd: '/project', role: 'verifier', ephemeral: true })
  expect(verifier.provider).toBe('codex')
  await until(() => t.driver.launches.length === 1)
  expect(t.driver.launches[0]).toMatchObject({ model: 'gpt-5.4' })
  expect(t.driver.launches[0].metadata).toMatchObject({ role: 'verifier', effort: 'medium' })
})

it('parks Codex on a retrying provider limit and restores active state when the turn resumes', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', provider: 'codex', name: 'limited-codex' })
  await until(() => t.driver.launches.length === 1)
  t.driver.emit('codex:1', {
    type: 'error',
    data: 'rate limit reached; retry scheduled',
    metadata: { willRetry: true },
  })
  await until(() => (t.db.prepare('SELECT status FROM agents WHERE id=?').get(agent.id) as any).status === 'paused_provider')
  expect(JSON.parse((t.db.prepare('SELECT provider_state_json FROM agents WHERE id=?').get(agent.id) as any).provider_state_json))
    .toMatchObject({ rate_limit_pause: { at: expect.any(String) } })

  t.driver.emit('codex:1', {
    type: 'status',
    data: 'turn resumed',
    metadata: { turnActive: true, turnId: 'turn-retry' },
  })
  await until(() => (t.db.prepare('SELECT status FROM agents WHERE id=?').get(agent.id) as any).status === 'active')
  expect(JSON.parse((t.db.prepare('SELECT provider_state_json FROM agents WHERE id=?').get(agent.id) as any).provider_state_json))
    .toMatchObject({ rate_limit_pause: null })
})

it('finishes a Codex card in review and records reported totals without cached-input duplication', async () => {
  const t = setup()
  writeAgentDefaults(t.db, {
    worker: { provider: 'codex', model: null, effort: null },
    specialist: { provider: 'codex', model: null, effort: null },
  })
  t.db.prepare(`INSERT INTO cards (id, board_id, title, description) VALUES (7, 1, 'Codex card', 'Do it')`).run()

  const result = t.manager.launch({ boardId: 1, cardId: 7, cwd: '/project', brief: 'finish card 7' })
  expect(result.agent.provider).toBe('codex')
  expect(t.db.prepare('SELECT owner_agent_id, column_name FROM cards WHERE id=7').get())
    .toMatchObject({ owner_agent_id: result.agent.id, column_name: 'in_progress' })
  await until(() => t.driver.sends.length === 1)

  t.driver.emit('codex:1', {
    type: 'status',
    data: 'turn completed',
    metadata: {
      method: 'turn/completed',
      turnCompleted: true,
      turnActive: false,
      status: 'completed',
      tokenUsage: {
        total: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 80, outputTokens: 50, reasoningOutputTokens: 20 },
      },
    },
  })

  await until(() => (t.db.prepare('SELECT column_name FROM cards WHERE id=7').get() as any).column_name === 'review')
  expect(t.db.prepare('SELECT owner_agent_id, column_name FROM cards WHERE id=7').get())
    .toMatchObject({ owner_agent_id: null, column_name: 'review' })
  expect(t.db.prepare('SELECT status FROM agents WHERE id=?').get(result.agent.id)).toMatchObject({ status: 'gone' })
  expect(t.db.prepare('SELECT provider, total_tokens, input_tokens, cached_input_tokens FROM agent_usage').get())
    .toMatchObject({ provider: 'codex', total_tokens: 150, input_tokens: 100, cached_input_tokens: 80 })
})

it('accepts provider and access-profile controls through the server API', async () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/project', 'project')").run()
  const driver = new FakeCodexDriver()
  let manager: ProviderAgentManager
  const server = buildServer(db, (bus) => {
    const codex = new CodexManagedAgentRuntime(db, bus, driver)
    manager = new ProviderAgentManager(db, bus, claudeStub(db).stub, codex)
    return manager
  })
  await server.ready()

  const hire = await server.inject({
    method: 'POST',
    url: '/api/v1/boards/1/hire',
    payload: { provider: 'codex', name: 'api-owl', model: 'gpt-5.4', effort: 'ultra' },
  })
  expect(hire.statusCode).toBe(200)
  expect(hire.json()).toMatchObject({ provider: 'codex', access_profile: 'workspace_write' })
  const id = hire.json().id
  await until(() => driver.launches.length === 1)
  expect(driver.launches[0]).toMatchObject({ model: 'gpt-5.4' })
  expect(driver.launches[0].metadata).toMatchObject({ effort: 'ultra' })

  const access = await server.inject({
    method: 'POST',
    url: `/api/v1/agents/${id}/access-profile`,
    payload: { profile: 'read_only' },
  })
  expect(access.statusCode).toBe(200)
  expect(db.prepare('SELECT access_profile FROM agents WHERE id=?').get(id)).toMatchObject({ access_profile: 'read_only' })

  driver.emit('codex:1', {
    type: 'status',
    data: 'approve command',
    metadata: { approval: true, kind: 'approval', requestId: 'approval-1', approvalKind: 'command' },
  })
  await until(() => manager.transcript(id).permissions.length === 1)
  const approval = await server.inject({
    method: 'POST',
    url: `/api/v1/agents/${id}/approvals/approval-1`,
    payload: { decision: 'allow_session' },
  })
  expect(approval.statusCode).toBe(200)
  expect(driver.approvals).toEqual([['codex:1', 'approval-1', 'allow_session', undefined]])
  expect((await server.inject({
    method: 'POST', url: `/api/v1/agents/${id}/approvals/missing`, payload: { decision: 'forever' },
  })).statusCode).toBe(400)

  const bad = await server.inject({
    method: 'POST',
    url: `/api/v1/agents/${id}/access-profile`,
    payload: { profile: 'unsafe' },
  })
  expect(bad.statusCode).toBe(400)
  expect((await server.inject({
    method: 'POST', url: '/api/v1/boards/1/hire', payload: { provider: 'codex', access_profile: 'unsafe' },
  })).statusCode).toBe(400)
  expect((await server.inject({
    method: 'POST', url: '/api/v1/boards/1/hire', payload: { provider: 'codex', effort: 'not valid!' },
  })).statusCode).toBe(400)
  await server.close()
})

it('runs a durable Agent OS Codex job through completion, usage, identity, and card release', async () => {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO boards (id, project_path, name) VALUES (1, ?, ?)').run(process.cwd(), 'project')
  db.prepare("INSERT INTO cards (id, board_id, title, description) VALUES (9, 1, 'Agent OS Codex', 'ship it')").run()
  const runtime = createAgentOsRuntime(db)
  const driver = new FakeCodexDriver()
  runtime.registerDriver(driver)
  const workspace = await runtime.workspaceManager.create({
    boardId: 1,
    cardId: 9,
    name: 'codex-job-workspace',
    kind: 'shared',
    rootPath: process.cwd(),
    baseRef: 'HEAD',
  })
  const job = runtime.scheduler.create({
    boardId: 1,
    cardId: 9,
    workspaceId: workspace.id,
    provider: 'codex',
    budgetTokens: 200,
    maxAttempts: 1,
  })

  await runtime.scheduler.tick()
  await until(() => driver.launches.length === 1)
  expect(driver.launches[0].metadata).toMatchObject({ agentId: expect.any(Number), jobId: job.id, cardId: 9 })
  const agentId = Number(driver.launches[0].metadata?.agentId)
  expect(db.prepare('SELECT provider, status FROM agents WHERE id=?').get(agentId))
    .toMatchObject({ provider: 'codex', status: 'active' })

  driver.emit('codex:1', {
    type: 'status',
    data: 'usage',
    metadata: {
      tokenUsage: {
        total: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 80, outputTokens: 50, reasoningOutputTokens: 20 },
      },
    },
  })
  driver.emit('codex:1', {
    type: 'status',
    data: 'completed',
    metadata: { method: 'turn/completed', turnCompleted: true, status: 'completed' },
  })

  await until(() => runtime.scheduler.get(job.id)?.status === 'succeeded')
  expect(runtime.scheduler.get(job.id)).toMatchObject({ spent_tokens: 150 })
  expect(db.prepare('SELECT owner_agent_id, column_name FROM cards WHERE id=9').get())
    .toMatchObject({ owner_agent_id: null, column_name: 'review' })
  expect(db.prepare('SELECT status FROM agents WHERE id=?').get(agentId)).toMatchObject({ status: 'gone' })
  expect(db.prepare('SELECT provider, total_tokens, cached_input_tokens FROM agent_usage WHERE agent_id=?').get(agentId))
    .toMatchObject({ provider: 'codex', total_tokens: 150, cached_input_tokens: 80 })
  await runtime.shutdown()
})

it('interrupts an Agent OS Codex job at its durable token budget and rejects unsupported cost budgets', async () => {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO boards (id, project_path, name) VALUES (1, ?, ?)').run(process.cwd(), 'project')
  const runtime = createAgentOsRuntime(db)
  const driver = new FakeCodexDriver()
  runtime.registerDriver(driver)
  const workspace = await runtime.workspaceManager.create({
    boardId: 1,
    name: 'codex-budget-workspace',
    kind: 'shared',
    rootPath: process.cwd(),
    baseRef: 'HEAD',
  })
  const tokenJob = runtime.scheduler.create({
    boardId: 1,
    workspaceId: workspace.id,
    provider: 'codex',
    budgetTokens: 100,
    maxAttempts: 1,
  })
  await runtime.scheduler.tick()
  await until(() => driver.launches.length === 1)
  driver.emit('codex:1', {
    type: 'status',
    data: 'usage',
    metadata: {
      tokenUsage: {
        total: { totalTokens: 100, inputTokens: 70, cachedInputTokens: 50, outputTokens: 30, reasoningOutputTokens: 10 },
      },
    },
  })
  await until(() => runtime.scheduler.get(tokenJob.id)?.status === 'blocked')
  expect(runtime.scheduler.get(tokenJob.id)?.error).toMatch(/budget exhausted/)

  const costJob = runtime.scheduler.create({
    boardId: 1,
    workspaceId: workspace.id,
    provider: 'codex',
    budgetCents: 25,
    maxAttempts: 1,
  })
  await runtime.scheduler.tick()
  expect(runtime.scheduler.get(costJob.id)).toMatchObject({ status: 'blocked' })
  expect(runtime.scheduler.get(costJob.id)?.error).toMatch(/authoritative cost budget/)
  expect(driver.launches).toHaveLength(1)
  await runtime.shutdown()
})

it('requeues a managed Codex job cleanly when its provider is unavailable during restart', async () => {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO boards (id, project_path, name) VALUES (1, ?, ?)').run(process.cwd(), 'project')
  db.prepare("INSERT INTO cards (id, board_id, title, description, column_name) VALUES (12, 1, 'Recover Codex', 'resume it', 'in_progress')").run()
  const runtime = createAgentOsRuntime(db)
  const workspace = await runtime.workspaceManager.create({
    boardId: 1,
    cardId: 12,
    name: 'recovery-workspace',
    kind: 'shared',
    rootPath: process.cwd(),
    baseRef: 'HEAD',
  })
  const job = runtime.scheduler.create({
    boardId: 1,
    cardId: 12,
    workspaceId: workspace.id,
    provider: 'codex',
    maxAttempts: 2,
  })
  db.prepare("UPDATE jobs SET status='running', attempts=1, started_at=datetime('now') WHERE id=?").run(job.id)
  const agentId = Number(db.prepare(`INSERT INTO agents
    (board_id, name, kind, provider, status, external_session_id)
    VALUES (1, 'recovering-codex', 'hired', 'codex', 'active', 'thread-recovery')`).run().lastInsertRowid)
  db.prepare("UPDATE cards SET owner_agent_id=? WHERE id=12").run(agentId)
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, agent_id, provider, external_id, status, context_json)
    VALUES ('session-recovery', ?, ?, 'codex', 'thread-recovery', 'running', ?)`)
    .run(workspace.id, agentId, JSON.stringify({ job_id: job.id, managed_identity: true }))

  expect(await runtime.reconcileJobs()).toEqual({ resumed: [], recovered: [job.id] })
  expect(runtime.scheduler.get(job.id)).toMatchObject({ status: 'queued' })
  expect(db.prepare('SELECT owner_agent_id, column_name FROM cards WHERE id=12').get())
    .toMatchObject({ owner_agent_id: null, column_name: 'backlog' })
  expect(db.prepare('SELECT status FROM agents WHERE id=?').get(agentId)).toMatchObject({ status: 'gone' })
  await runtime.shutdown()
})

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeAgentDefaults } from '../src/agent-defaults.js'
import { writeProviderModelCache } from '../src/agent-providers.js'
import { DeliveryReportService } from '../src/agent-os/delivery-reports.js'
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
import { loadManagedAgentSessionCredential } from '../src/agent-session-credential.js'

let credentialHome = ''
const previousOrchestraHome = process.env.ORCHESTRA_HOME
beforeEach(() => {
  credentialHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-codex-credentials-'))
  process.env.ORCHESTRA_HOME = credentialHome
})
afterEach(() => {
  fs.rmSync(credentialHome, { recursive: true, force: true })
  if (previousOrchestraHome === undefined) delete process.env.ORCHESTRA_HOME
  else process.env.ORCHESTRA_HOME = previousOrchestraHome
  delete process.env.ORCHESTRA_MANAGED_AGENT
  delete process.env.ORCHESTRA_AGENT_ID
  delete process.env.ORCHESTRA_NAME
})

type Feed = {
  queue: DriverEvent[]
  waiting: Array<() => void>
  closed: boolean
}

class FakeCodexDriver implements ManagedAgentDriver {
  readonly id = 'codex'
  readonly launches: DriverLaunchRequest[] = []
  readonly sends: Array<[string, string]> = []
  readonly interrupts: string[] = []
  readonly updates: Array<[string, Record<string, unknown>]> = []
  readonly approvals: Array<[string, string, string, string | undefined]> = []
  readonly approvalAnswers: Array<Record<string, string[]> | undefined> = []
  readonly detaches: string[] = []
  readonly sessions = new Map<string, DriverSession>()
  updateError: Error | null = null
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
    this.interrupts.push(sessionId)
    this.emit(sessionId, { type: 'status', data: 'interrupted', metadata: { turnActive: false } })
  }

  async stop(sessionId: string): Promise<void> {
    this.emit(sessionId, { type: 'exit', data: 'Codex session stopped' })
    const feed = this.feeds.get(sessionId)
    if (feed) { feed.closed = true; feed.waiting.splice(0).forEach((wake) => wake()) }
  }

  async detach(sessionId: string): Promise<void> {
    this.detaches.push(sessionId)
    this.emit(sessionId, { type: 'exit', data: 'Codex session detached', metadata: { detached: true } })
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
    if (this.updateError) throw this.updateError
    this.updates.push([sessionId, update])
  }

  async resolveApproval(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'allow_session' | 'deny' | 'cancel',
    message?: string,
    answers?: Record<string, string[]>,
  ): Promise<boolean> {
    this.approvals.push([sessionId, requestId, decision, message])
    this.approvalAnswers.push(answers)
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
        ON CONFLICT(board_id, name) DO UPDATE SET status='active', provider='claude',
          sdk_session=NULL, external_session_id=NULL, provider_state_json='{}'`)
        .run(options.boardId, options.name ?? `claude-${calls.length}`)
      const row = db.prepare('SELECT * FROM agents WHERE board_id=? ORDER BY id DESC LIMIT 1').get(options.boardId) as any
      live.add(row.id)
      return row
    },
    deliver: () => true,
    task: () => true,
    transcript: () => ({
      lines: [], working: null,
      info: { model: 'claude-resolved', permissionMode: 'bypassPermissions' },
    }),
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

it('keeps Claude provider-default intent separate from its resolved runtime model', () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'claude-owl', provider: 'claude' })

  expect(t.manager.transcript(agent.id).info).toMatchObject({
    model: 'claude-resolved',
    requestedModel: null,
    resolvedModel: 'claude-resolved',
  })
})

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
  expect(t.db.prepare(`SELECT profile_id, external_id FROM agent_sessions
    WHERE agent_id=? AND provider='codex'`).get(agent.id)).toMatchObject({
    profile_id: expect.any(String),
    external_id: 'thread-1',
  })
  expect(t.db.prepare('SELECT hook_token_hash FROM agents WHERE id=?').get(agent.id))
    .toMatchObject({ hook_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
  process.env.ORCHESTRA_MANAGED_AGENT = '1'
  process.env.ORCHESTRA_AGENT_ID = String(agent.id)
  process.env.ORCHESTRA_NAME = 'codex-owl'
  expect(loadManagedAgentSessionCredential('/project')).toMatchObject({
    agentId: agent.id,
    provider: 'codex',
    sessionId: 'thread-1',
    sessionToken: expect.any(String),
  })
  Object.assign(t.driver.sessions.get('codex:1')!.metadata, {
    resolvedModel: 'gpt-5.4-runtime',
    resolvedEffort: 'medium',
  })

  t.driver.emit('codex:1', { type: 'output', data: 'working', metadata: { turnId: 'turn-1' } })
  await until(() => t.manager.transcript(agent.id).lines.some((line: any) => line.text === 'working'))
  expect(t.manager.transcript(agent.id).info).toMatchObject({
    provider: 'codex', model: 'gpt-5.4', requestedModel: 'gpt-5.4', resolvedModel: 'gpt-5.4-runtime',
    effort: 'high', resolvedEffort: 'medium', accessProfile: 'workspace_write',
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

it('renders Codex streaming output as a readable transcript instead of a protocol event log', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', provider: 'codex', name: 'readable-codex' })
  await until(() => t.driver.launches.length === 1)

  t.driver.emit('codex:1', {
    type: 'status', data: 'mcpServer/startupStatus/updated',
    metadata: { method: 'mcpServer/startupStatus/updated', unknownNativeEvent: true },
  })
  t.driver.emit('codex:1', {
    type: 'status', data: 'Codex token usage updated',
    metadata: {
      method: 'thread/tokenUsage/updated',
      tokenUsage: { total: { totalTokens: 7, inputTokens: 4, outputTokens: 3 } },
    },
  })
  for (const [seq, delta] of ['Hello', '!', ' I', ' am', ' Codex', '.'].entries()) {
    t.driver.emit('codex:1', {
      type: 'output', data: delta,
      metadata: { method: 'item/agentMessage/delta', itemId: 'message-1', seq },
    })
  }
  t.driver.emit('codex:1', {
    type: 'status', data: 'Codex turn completed',
    metadata: { method: 'turn/completed', turnCompleted: true, turnActive: false, status: 'completed' },
  })

  await until(() => t.manager.transcript(agent.id).lines.some((line: any) => line.text === 'Hello! I am Codex.'))
  const transcript = t.manager.transcript(agent.id)
  expect(transcript.info.tokens).toBe(7)
  expect(transcript.lines.filter((line: any) => line.kind === 'text')).toEqual([
    expect.objectContaining({ text: 'Hello! I am Codex.' }),
  ])
  expect(transcript.lines.map((line: any) => line.text)).not.toContain('mcpServer/startupStatus/updated')
  expect(transcript.lines.map((line: any) => line.text)).not.toContain('Codex token usage updated')
  expect(transcript.lines.map((line: any) => line.text)).toContain('turn finished (completed)')
})

it('detaches managed Codex threads on daemon shutdown without marking agents gone', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', provider: 'codex', name: 'resumable-codex' })
  await until(() => t.driver.launches.length === 1)

  await t.manager.shutdown()

  expect(t.driver.detaches).toEqual(['codex:1'])
  expect(t.db.prepare('SELECT status, external_session_id FROM agents WHERE id=?').get(agent.id))
    .toMatchObject({ status: 'active', external_session_id: 'thread-1' })
  expect(JSON.parse((t.db.prepare('SELECT provider_state_json FROM agents WHERE id=?').get(agent.id) as any).provider_state_json))
    .toMatchObject({ lifecycle: 'detached', thread_id: 'thread-1' })
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
  expect(t.driver.launches[0]).toMatchObject({ model: 'gpt-5.4', accessProfile: 'read_only' })
  expect(t.driver.launches[0].metadata).toMatchObject({
    role: 'verifier',
    effort: 'medium',
    developerInstructions: expect.stringMatching(/read-only.*never modify files/i),
  })
})

it('does not let a stable specialist name pin an old provider default', () => {
  const t = setup()
  t.db.prepare(`INSERT INTO agents (board_id, name, kind, role, status, provider, external_session_id)
    VALUES (1, 'stable-verifier', 'hired', 'verifier', 'gone', 'codex', 'old-codex-thread')`).run()
  writeAgentDefaults(t.db, {
    worker: { provider: 'codex', model: null, effort: null },
    specialist: { provider: 'claude', model: 'claude-specialist', effort: null },
  })

  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'stable-verifier', role: 'verifier' })

  expect(agent).toMatchObject({ provider: 'claude', external_session_id: null, access_profile: 'read_only' })
  expect(t.claude.calls[0]).toMatchObject({ model: 'claude-specialist', permissionMode: 'plan' })
})

it('clears stale Codex session state on a fresh same-name rehire', async () => {
  const t = setup()
  const first = t.manager.hire({ boardId: 1, cwd: '/project', provider: 'codex', name: 'fresh-codex' })
  await until(() => t.driver.launches.length === 1)
  t.driver.emit('codex:1', {
    type: 'status', data: 'usage',
    metadata: { tokenUsage: { total: { totalTokens: 10, inputTokens: 6, outputTokens: 4 } } },
  })
  await until(() => t.manager.transcript(first.id).info.tokens === 10)
  expect(await t.manager.fire(first.id)).toBe(true)

  const fresh = t.manager.hire({ boardId: 1, cwd: '/project', provider: 'codex', name: 'fresh-codex' })
  expect(fresh).toMatchObject({ external_session_id: null, status: 'starting' })
  expect(JSON.parse(fresh.provider_state_json)).toMatchObject({ lifecycle: 'starting', active_turn_id: null })
  expect(JSON.parse(fresh.provider_state_json)).not.toHaveProperty('usage_total')
  await until(() => t.driver.launches.length === 2)
  expect(t.db.prepare('SELECT external_session_id FROM agents WHERE id=?').get(first.id))
    .toMatchObject({ external_session_id: 'thread-2' })
})

it('enforces one owner and one active consumer for every resumed Codex thread', async () => {
  const t = setup()
  const owner = t.manager.hire({ boardId: 1, cwd: '/project', provider: 'codex', name: 'thread-owner' })
  await until(() => t.driver.launches.length === 1)
  await t.manager.fire(owner.id)

  expect(() => t.manager.hire({
    boardId: 1, cwd: '/project', provider: 'codex', name: 'thread-thief', resumeSession: 'thread-1',
  })).toThrow(/already belongs to agent thread-owner/)

  t.db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, base_ref) VALUES ('owned-workspace', 1, 'owned', 'shared', '/project', 'HEAD')`).run()
  t.db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, external_id, status) VALUES ('owned-session', 'owned-workspace', 'codex', 'agent-os-thread', 'running')`).run()
  expect(() => t.manager.hire({
    boardId: 1, cwd: '/project', provider: 'codex', name: 'agent-os-thief', resumeSession: 'agent-os-thread',
  })).toThrow(/active Agent OS job/)
})

it('reapplies persisted overrides on resume and refuses to persist rejected live updates', async () => {
  const t = setup()
  await t.driver.launch({ workspaceId: 'legacy-agent:44', cwd: '/project', externalId: 'thread-resume' })
  t.db.prepare(`INSERT INTO agents
    (id, board_id, name, kind, status, provider, external_session_id, access_profile, model, effort)
    VALUES (44, 1, 'resume-codex', 'hired', 'active', 'codex', 'thread-resume', 'read_only', 'gpt-resume', 'high')`).run()
  const resumed = t.manager.hire({
    boardId: 1,
    cwd: '/project',
    name: 'resume-codex',
    provider: 'codex',
    resumeSession: 'thread-resume',
    accessProfile: 'read_only',
    model: 'gpt-resume',
    effort: 'high',
  })
  await until(() => t.driver.updates.length === 1)
  expect(t.driver.updates[0]).toEqual(['codex:1', {
    model: 'gpt-resume', effort: 'high', accessProfile: 'read_only',
  }])

  t.driver.updateError = new Error('provider rejected update')
  expect(await t.manager.setModel(resumed.id, 'rejected-model')).toBe(false)
  expect(await t.manager.setEffort(resumed.id, 'ultra')).toBe('bad-level')
  expect(await t.manager.setAccessProfile(resumed.id, 'full_access')).toBe(false)
  expect(t.db.prepare('SELECT model, effort, access_profile FROM agents WHERE id=?').get(resumed.id))
    .toMatchObject({ model: 'gpt-resume', effort: 'high', access_profile: 'read_only' })
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

it('projects the final legacy Codex assistant output into the compatibility Trackbook', async () => {
  const previousCanonicalLaunch = process.env.ORCHESTRA_CANONICAL_LAUNCH
  const previousAutoship = process.env.ORCHESTRA_AUTOSHIP
  delete process.env.ORCHESTRA_CANONICAL_LAUNCH
  process.env.ORCHESTRA_AUTOSHIP = '0'
  const db = openDb(':memory:')
  db.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/project', 'project')").run()
  db.prepare(`INSERT INTO cards (id, board_id, title, description)
    VALUES (7, 1, 'Legacy Codex delivery', 'Preserve the final answer')`).run()
  const driver = new FakeCodexDriver()
  const server = buildServer(db, (bus) => {
    const codex = new CodexManagedAgentRuntime(db, bus, driver)
    return new ProviderAgentManager(db, bus, claudeStub(db).stub, codex)
  })

  try {
    await server.ready()
    const launched = await server.inject({
      method: 'POST', url: '/api/v1/cards/7/launch', payload: { provider: 'codex' },
    })
    expect(launched.statusCode).toBe(200)
    await until(() => driver.sends.length === 1)
    driver.emit('codex:1', {
      type: 'output', data: 'Delivery summary: implemented ',
      metadata: { method: 'item/agentMessage/delta', itemId: 'final-answer' },
    })
    driver.emit('codex:1', {
      type: 'output', data: 'the requested behavior.\nEvidence: npm test passed.',
      metadata: { method: 'item/agentMessage/delta', itemId: 'final-answer' },
    })
    driver.emit('codex:1', {
      type: 'status', data: 'turn completed',
      metadata: { method: 'turn/completed', turnCompleted: true, turnActive: false, status: 'completed' },
    })

    const reports = new DeliveryReportService(db)
    await until(() => reports.currentForCard(7)?.status === 'submitted')
    const delivery = reports.currentForCard(7)!
    const expected = 'Delivery summary: implemented the requested behavior.\nEvidence: npm test passed.'
    expect(delivery.summary).toBe('Delivery summary: implemented the requested behavior. Evidence: npm test passed.')
    expect(delivery.claims).toEqual([expect.objectContaining({ text: expected })])
  } finally {
    await server.close()
    if (previousCanonicalLaunch === undefined) delete process.env.ORCHESTRA_CANONICAL_LAUNCH
    else process.env.ORCHESTRA_CANONICAL_LAUNCH = previousCanonicalLaunch
    if (previousAutoship === undefined) delete process.env.ORCHESTRA_AUTOSHIP
    else process.env.ORCHESTRA_AUTOSHIP = previousAutoship
  }
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
  expect(driver.approvalAnswers).toEqual([undefined])
  expect((await server.inject({
    method: 'POST', url: `/api/v1/agents/${id}/approvals/missing`, payload: { decision: 'forever' },
  })).statusCode).toBe(400)
  driver.emit('codex:1', {
    type: 'tool',
    data: 'answer questions',
    metadata: { approval: true, kind: 'approval', requestId: 'questions-1', approvalKind: 'user-input' },
  })
  await until(() => manager.transcript(id).permissions.some((permission: any) => permission.id === 'questions-1'))
  expect((await server.inject({
    method: 'POST',
    url: `/api/v1/agents/${id}/approvals/questions-1`,
    payload: { decision: 'allow', answers: { framework: ['React'], notes: ['Accessible'] } },
  })).statusCode).toBe(200)
  expect(driver.approvalAnswers.at(-1)).toEqual({ framework: ['React'], notes: ['Accessible'] })
  expect((await server.inject({
    method: 'POST',
    url: `/api/v1/agents/${id}/approvals/missing`,
    payload: { decision: 'allow', answers: { bad: [42] } },
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

it('routes board controls and transcripts to Agent OS-owned Codex agents', async () => {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO boards (id, project_path, name) VALUES (1, ?, ?)').run(process.cwd(), 'project')
  const bus = new EventEmitter()
  const runtime = createAgentOsRuntime(db)
  runtime.setBus(bus)
  const driver = new FakeCodexDriver()
  runtime.registerDriver(driver)
  const manager = new ProviderAgentManager(
    db,
    bus,
    claudeStub(db).stub,
    new CodexManagedAgentRuntime(db, bus, driver),
    undefined,
    runtime.jobExecutor,
  )
  writeProviderModelCache(db, [{
    id: 'gpt-controlled', model: 'gpt-controlled', displayName: 'GPT Controlled',
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
  }], 'codex')
  const workspace = await runtime.workspaceManager.create({
    boardId: 1,
    name: 'controlled-codex',
    kind: 'shared',
    rootPath: process.cwd(),
    baseRef: 'HEAD',
  })
  const job = runtime.scheduler.create({ boardId: 1, workspaceId: workspace.id, provider: 'codex', maxAttempts: 1 })
  await runtime.scheduler.tick()
  await until(() => driver.launches.length === 1)
  const agentId = Number(driver.launches[0].metadata?.agentId)

  expect(manager.isHired(agentId)).toBe(true)
  expect(manager.task(agentId, 'continue from the board')).toBe(true)
  await until(() => driver.sends.some(([, text]) => text === 'continue from the board'))
  driver.emit('codex:1', {
    type: 'status', data: 'hook/started', metadata: { method: 'hook/started', unknownNativeEvent: true },
  })
  driver.emit('codex:1', {
    type: 'output', data: 'Agent OS output ',
    metadata: { method: 'item/agentMessage/delta', itemId: 'agent-os-message' },
  })
  driver.emit('codex:1', {
    type: 'output', data: 'is visible',
    metadata: { method: 'item/agentMessage/delta', itemId: 'agent-os-message' },
  })
  await until(() => manager.transcript(agentId).lines.some((line: any) => line.text === 'Agent OS output is visible'))
  expect(manager.transcript(agentId).lines.map((line: any) => line.text)).not.toContain('hook/started')
  expect(manager.transcript(agentId).info).toMatchObject({
    provider: 'codex', accessProfile: 'workspace_write',
    models: [expect.objectContaining({ value: 'gpt-controlled', supportedEffortLevels: ['high'] })],
  })

  expect(await manager.setModel(agentId, 'gpt-controlled')).toBe(true)
  expect(await manager.setEffort(agentId, 'high')).toBe('ok')
  expect(await manager.setAccessProfile(agentId, 'read_only')).toBe(true)
  expect(driver.updates.slice(-3)).toEqual([
    ['codex:1', { model: 'gpt-controlled' }],
    ['codex:1', { effort: 'high' }],
    ['codex:1', { accessProfile: 'read_only' }],
  ])

  driver.emit('codex:1', {
    type: 'tool',
    data: 'approve command',
    metadata: { approval: true, kind: 'approval', requestId: 'agent-os-approval', approvalKind: 'command' },
  })
  await until(() => manager.transcript(agentId).permissions.length === 1)
  expect(await manager.resolveApproval(agentId, 'agent-os-approval', 'allow')).toBe(true)
  expect(driver.approvals.at(-1)).toEqual(['codex:1', 'agent-os-approval', 'allow', undefined])
  expect(await manager.interruptAgent(agentId)).toBe(true)
  expect(driver.interrupts).toContain('codex:1')
  expect(await manager.fire(agentId)).toBe(true)
  await until(() => runtime.scheduler.get(job.id)?.status === 'cancelled')
  expect(manager.isHired(agentId)).toBe(false)

  // Reusing the durable agent name for a fresh non-Agent-OS session must route
  // controls to the new runtime, not its historical job session.
  const name = (db.prepare('SELECT name FROM agents WHERE id=?').get(agentId) as { name: string }).name
  await until(() => (db.prepare('SELECT status FROM agents WHERE id=?').get(agentId) as { status: string }).status === 'gone')
  const rehired = manager.hire({ boardId: 1, cwd: '/project', provider: 'codex', name })
  expect(rehired.id).toBe(agentId)
  await until(() => driver.launches.length === 2)
  expect(manager.task(agentId, 'fresh session control')).toBe(true)
  await until(() => driver.sends.some(([sessionId, text]) => sessionId === 'codex:2' && text === 'fresh session control'))
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

it('preserves a running Agent OS Codex job when the daemon detaches its driver', async () => {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO boards (id, project_path, name) VALUES (1, ?, ?)').run(process.cwd(), 'project')
  const runtime = createAgentOsRuntime(db)
  const driver = new FakeCodexDriver()
  runtime.registerDriver(driver)
  const workspace = await runtime.workspaceManager.create({
    boardId: 1,
    name: 'codex-detach-workspace',
    kind: 'shared',
    rootPath: process.cwd(),
    baseRef: 'HEAD',
  })
  const job = runtime.scheduler.create({
    boardId: 1,
    workspaceId: workspace.id,
    provider: 'codex',
    maxAttempts: 1,
  })
  await runtime.scheduler.tick()
  await until(() => driver.launches.length === 1)
  const session = db.prepare("SELECT id, agent_id FROM agent_sessions WHERE json_extract(context_json, '$.job_id')=?")
    .get(job.id) as { id: string; agent_id: number }

  await runtime.shutdown()
  await driver.detach('codex:1')
  await new Promise((resolve) => setTimeout(resolve, 10))

  expect(runtime.scheduler.get(job.id)).toMatchObject({ status: 'running' })
  expect(db.prepare('SELECT status FROM agent_sessions WHERE id=?').get(session.id)).toMatchObject({ status: 'running' })
  expect(db.prepare('SELECT status FROM agents WHERE id=?').get(session.agent_id)).toMatchObject({ status: 'active' })

  db.prepare(`UPDATE agents SET model='gpt-restored', effort='high', access_profile='read_only' WHERE id=?`)
    .run(session.agent_id)
  driver.updates.length = 0
  const resumedRuntime = createAgentOsRuntime(db)
  resumedRuntime.registerDriver(driver)

  expect(await resumedRuntime.reconcileJobs()).toEqual({ resumed: [job.id], recovered: [] })
  expect(driver.updates).toEqual([['codex:1', {
    model: 'gpt-restored', effort: 'high', accessProfile: 'read_only',
  }]])
  await resumedRuntime.shutdown()
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

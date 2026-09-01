import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  OpenCodeManagedAgentRuntime,
  OPENCODE_CAPABILITIES,
  ProviderAgentManager,
} from '../src/provider-agent-manager.js'
import type {
  AgentDriver,
  DriverCapabilities,
  DriverEvent,
  DriverLaunchRequest,
  DriverRecoveryRequest,
  DriverSession,
} from '../src/runtime/types.js'
import type { ConductorLike } from '../src/server.js'

let credentialHome = ''
const previousOrchestraHome = process.env.ORCHESTRA_HOME
beforeEach(() => {
  credentialHome = `/tmp/orchestra-opencode-credentials-${Date.now()}-${Math.random().toString(16).slice(2)}`
  process.env.ORCHESTRA_HOME = credentialHome
})
afterEach(() => {
  if (previousOrchestraHome === undefined) delete process.env.ORCHESTRA_HOME
  else process.env.ORCHESTRA_HOME = previousOrchestraHome
  delete process.env.ORCHESTRA_MANAGED_AGENT
  delete process.env.ORCHESTRA_AGENT_ID
  delete process.env.ORCHESTRA_NAME
})

type Feed = { queue: DriverEvent[]; waiting: Array<() => void>; closed: boolean }

// Mirrors the real OpenCodeAgentDriver's key structural difference from
// Qwen's: launch() always creates a brand-new session (never accepts an
// externalId to resume) and session ids are known immediately at creation —
// resume is recover()-only, via session.get().
class FakeOpenCodeDriver implements AgentDriver {
  readonly id = 'opencode'
  readonly launches: DriverLaunchRequest[] = []
  readonly recoveries: DriverRecoveryRequest[] = []
  readonly sends: Array<[string, string]> = []
  readonly interrupts: string[] = []
  readonly stops: string[] = []
  private readonly feeds = new Map<string, Feed>()
  private sequence = 0

  capabilities(): DriverCapabilities {
    return {
      attach: false,
      streaming: true,
      interrupt: true,
      stop: true,
      rawTerminal: false,
      resume: true,
    }
  }

  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    this.launches.push(request)
    const n = ++this.sequence
    const session: DriverSession = {
      id: `opencode:${n}`,
      externalId: `ext-${n}`,
      driverId: this.id,
      workspaceId: request.workspaceId,
      status: 'idle',
      startedAt: new Date().toISOString(),
      metadata: { ...request.metadata },
    }
    this.feeds.set(session.id, { queue: [], waiting: [], closed: false })
    return session
  }

  async attach(): Promise<DriverSession | null> {
    return null
  }

  async recover(request: DriverRecoveryRequest): Promise<DriverSession | null> {
    this.recoveries.push(request)
    const n = ++this.sequence
    const session: DriverSession = {
      id: `opencode:${n}`,
      externalId: request.externalId,
      driverId: this.id,
      workspaceId: request.workspaceId,
      status: 'idle',
      startedAt: new Date().toISOString(),
      metadata: { ...request.metadata },
    }
    this.feeds.set(session.id, { queue: [], waiting: [], closed: false })
    return session
  }

  async send(sessionId: string, text: string): Promise<void> {
    this.sends.push([sessionId, text])
  }

  async interrupt(sessionId: string): Promise<void> {
    this.interrupts.push(sessionId)
  }

  async stop(sessionId: string): Promise<void> {
    this.stops.push(sessionId)
    this.emit(sessionId, { type: 'exit', data: 'OpenCode session stopped' })
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

  emit(sessionId: string, event: Omit<DriverEvent, 'sessionId' | 'seq' | 'at'>): void {
    const feed = this.feeds.get(sessionId)
    if (!feed) throw new Error(`missing feed ${sessionId}`)
    feed.queue.push({ sessionId, seq: feed.queue.length + 1, at: new Date().toISOString(), ...event })
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

const claudeStub = (db: ReturnType<typeof openDb>): ConductorLike & { calls: unknown[] } => {
  const calls: any[] = []
  return {
    calls,
    isHired: () => false,
    hire: (options) => { calls.push(options); throw new Error('claude must not be hired') },
    deliver: () => true,
    task: () => true,
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => false,
    fire: async () => false,
    launch: (request) => { calls.push(request); throw new Error('claude must not launch') },
    isLaunched: () => false,
    providerCatalog: async () => [{
      id: 'claude', name: 'Claude', available: true, models: [], source: 'unavailable', updated_at: null,
    }],
  } as never
}

const setup = () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/project', 'project')").run()
  const bus = new EventEmitter()
  const driver = new FakeOpenCodeDriver()
  const opencode = new OpenCodeManagedAgentRuntime(db, bus, driver)
  const claude = claudeStub(db)
  const manager = new ProviderAgentManager(db, bus, claude, undefined, undefined, undefined, undefined, opencode)
  return { db, bus, driver, opencode, claude, manager }
}

const emitAssistantUsage = (driver: FakeOpenCodeDriver, sessionId: string, usage?: Record<string, unknown>) => {
  driver.emit(sessionId, {
    type: 'status', data: 'OpenCode message updated',
    metadata: {
      phase: 'message_updated',
      effectiveModel: 'anthropic/claude-sonnet',
      usage: usage ?? { cost: 0.12, input_tokens: 100, output_tokens: 20, reasoning_tokens: 0, cache_read_tokens: 60, cache_write_tokens: 0 },
    },
  })
}

const emitTurnCompleted = (driver: FakeOpenCodeDriver, sessionId: string) => {
  driver.emit(sessionId, { type: 'status', data: 'OpenCode turn completed', metadata: { phase: 'turn_completed' } })
}

it('hires an OpenCode agent on the shared server runtime and routes work to its driver', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'opencode-owl', provider: 'opencode', model: 'anthropic/claude-sonnet' })

  expect(agent).toMatchObject({ provider: 'opencode', status: 'starting', access_profile: 'full_access' })
  expect((t.claude as { calls: unknown[] }).calls).toHaveLength(0)
  await until(() => t.driver.launches.length === 1)
  expect(t.driver.launches[0]).toMatchObject({
    cwd: '/project',
    model: 'anthropic/claude-sonnet',
    accessProfile: 'full_access',
  })
  expect(t.driver.launches[0].metadata).toMatchObject({ agentId: agent.id })

  // OpenCode's session.create() returns a real id immediately — unlike Qwen,
  // no later event is required to bind external_session_id.
  await until(() => {
    const row = t.db.prepare('SELECT external_session_id, status FROM agents WHERE id=?').get(agent.id) as any
    return row.external_session_id === 'ext-1' && row.status === 'idle'
  })

  expect(t.manager.task(agent.id, 'implement the card')).toBe(true)
  await until(() => t.driver.sends.length === 1)
  expect(t.driver.sends[0][1]).toBe('implement the card')

  const sessionRow = t.db.prepare('SELECT provider, external_id FROM agent_sessions WHERE agent_id=?')
    .get(agent.id) as { provider: string; external_id: string }
  expect(sessionRow.provider).toBe('opencode')
})

it('records real per-message cost/token usage reported by OpenCode', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'opencode-meter', provider: 'opencode' })
  await until(() => t.driver.launches.length === 1)
  t.manager.task(agent.id, 'do it')
  await until(() => t.driver.sends.length === 1)

  emitAssistantUsage(t.driver, 'opencode:1')

  await until(() => {
    const usage = t.manager.transcript(agent.id).info.usage.session
    return usage.total_tokens === 120
  })
  const usage = t.manager.transcript(agent.id).info.usage.session
  expect(usage).toMatchObject({ provider: 'opencode', total_tokens: 120, input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, cost_cents: 12 })
  expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens)
})

it('resumes an existing OpenCode session through recover(), not launch()', async () => {
  const t = setup()
  const agent = t.manager.hire({
    boardId: 1, cwd: '/project', name: 'opencode-resume', provider: 'opencode', resumeSession: 'sess-42',
  })
  await until(() => t.driver.recoveries.length === 1)
  expect(t.driver.launches).toHaveLength(0)
  expect(t.driver.recoveries[0]).toMatchObject({ externalId: 'sess-42', cwd: '/project' })
  await until(() => {
    const row = t.db.prepare('SELECT external_session_id FROM agents WHERE id=?').get(agent.id) as any
    return row.external_session_id === 'sess-42'
  })
})

it('interrupts, controls, and refuses approvals for OpenCode agents', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'opencode-controls', provider: 'opencode', model: 'anthropic/claude-sonnet' })
  await until(() => t.driver.launches.length === 1)

  expect(await t.manager.interruptAgent(agent.id)).toBe(true)
  expect(t.driver.interrupts).toEqual(['opencode:1'])

  expect(await t.manager.setModel(agent.id, 'openai/gpt-5')).toBe(true)
  expect(t.db.prepare('SELECT model FROM agents WHERE id=?').get(agent.id)).toMatchObject({ model: 'openai/gpt-5' })

  expect(await t.manager.setEffort(agent.id, 'high')).toBe('bad-level')
  expect(await t.manager.setAccessProfile(agent.id, 'read_only')).toBe(true)
  expect(await t.manager.resolveApproval(agent.id, 'req-1', 'allow')).toBe(false)
  expect(await t.manager.resolvePermission(agent.id, 'req-1', 'allow')).toBe(false)
})

it('finalizes a launched card when the OpenCode turn completes', async () => {
  const t = setup()
  t.db.prepare("INSERT INTO cards (id, board_id, title, description) VALUES (5, 1, 'OpenCode card', 'do it')").run()

  t.manager.launch({ boardId: 1, cardId: 5, cwd: '/project', brief: 'implement', provider: 'opencode' })
  await until(() => t.driver.sends.length === 1)
  expect(t.driver.sends[0][1]).toContain('implement')

  t.driver.emit('opencode:1', { type: 'output', data: 'Done: shipped the change.' })
  emitTurnCompleted(t.driver, 'opencode:1')

  await until(() => {
    const card = t.db.prepare('SELECT column_name, owner_agent_id FROM cards WHERE id=5').get() as any
    return card.column_name === 'review' && card.owner_agent_id === null
  })
  await until(() => (t.db.prepare('SELECT status FROM agents WHERE provider=?').get('opencode') as any).status === 'gone')
})

it('pauses on provider rate-limit errors and recovers on the next turn start', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'opencode-limited', provider: 'opencode' })
  await until(() => t.driver.launches.length === 1)
  t.manager.task(agent.id, 'work')
  await until(() => t.driver.sends.length === 1)

  t.driver.emit('opencode:1', { type: 'error', data: '429 Too Many Requests' })
  await until(() => (t.db.prepare('SELECT status FROM agents WHERE id=?').get(agent.id) as any).status === 'paused_provider')

  t.driver.emit('opencode:1', { type: 'status', data: 'OpenCode turn started', metadata: { phase: 'turn_started' } })
  await until(() => (t.db.prepare('SELECT status FROM agents WHERE id=?').get(agent.id) as any).status === 'active')
  expect(agent).toBeTruthy()
})

it('publishes OpenCode in the provider catalog with honest capability gates', async () => {
  const t = setup()
  const catalogs = await t.manager.providerCatalog()
  const opencode = catalogs.find((catalog) => catalog.id === 'opencode')
  expect(opencode).toMatchObject({ id: 'opencode', name: 'OpenCode', available: true })
  expect(opencode?.capabilities).toEqual(OPENCODE_CAPABILITIES)
  // Unlike Qwen, OpenCode has no hardcoded fallback model list — its catalog
  // is only populated once the live provider adapter's model discovery runs
  // and caches results, which is out of scope for this in-memory manager test.
  expect(opencode?.models).toEqual([])

  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'opencode-caps', provider: 'opencode' })
  const capabilities = t.manager.capabilities(agent.id)
  expect(capabilities).toContain('model')
  expect(capabilities).toContain('interrupt')
  // The distinguishing capability vs. Qwen: OpenCode genuinely reports usage.
  expect(capabilities).toContain('usage')
  expect(capabilities).not.toContain('effort')
  expect(capabilities).not.toContain('approvals')
})

it('fires an OpenCode agent and marks it gone', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'opencode-fire', provider: 'opencode' })
  await until(() => t.driver.launches.length === 1)
  expect(await t.manager.fire(agent.id)).toBe(true)
  expect(t.driver.stops).toContain('opencode:1')
  await until(() => (t.db.prepare('SELECT status FROM agents WHERE id=?').get(agent.id) as any).status === 'gone')
})

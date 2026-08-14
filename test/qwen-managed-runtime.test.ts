import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  ProviderAgentManager,
  QwenManagedAgentRuntime,
  QWEN_CAPABILITIES,
} from '../src/provider-agent-manager.js'
import type {
  AgentDriver,
  DriverCapabilities,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
} from '../src/runtime/types.js'
import type { ConductorLike } from '../src/server.js'

let credentialHome = ''
const previousOrchestraHome = process.env.ORCHESTRA_HOME
beforeEach(() => {
  credentialHome = `/tmp/orchestra-qwen-credentials-${Date.now()}-${Math.random().toString(16).slice(2)}`
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

class FakeQwenDriver implements AgentDriver {
  readonly id = 'qwen'
  readonly launches: DriverLaunchRequest[] = []
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
      id: `qwen:${n}`,
      externalId: request.externalId ?? '',
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
    this.emit(sessionId, { type: 'exit', data: 'Qwen session stopped' })
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
  const driver = new FakeQwenDriver()
  const qwen = new QwenManagedAgentRuntime(db, bus, driver)
  const claude = claudeStub(db)
  const manager = new ProviderAgentManager(db, bus, claude, undefined, undefined, undefined, qwen)
  return { db, bus, driver, qwen, claude, manager }
}

const emitTurn = (driver: FakeQwenDriver, sessionId: string, usage?: Record<string, unknown>) => {
  driver.emit(sessionId, {
    type: 'status', data: 'Qwen turn completed',
    metadata: {
      phase: 'result',
      usage: usage ?? { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60, total_tokens: 120 },
    },
  })
}

it('hires a Qwen agent on the coding-plan runtime and routes work to its CLI driver', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'qwen-owl', provider: 'qwen', model: 'qwen3-coder-plus' })

  expect(agent).toMatchObject({ provider: 'qwen', status: 'starting', access_profile: 'full_access' })
  expect((t.claude as { calls: unknown[] }).calls).toHaveLength(0)
  await until(() => t.driver.launches.length === 1)
  expect(t.driver.launches[0]).toMatchObject({
    cwd: '/project',
    model: 'qwen3-coder-plus',
    accessProfile: 'full_access',
  })
  expect(t.driver.launches[0].metadata).toMatchObject({ agentId: agent.id })

  expect(t.manager.task(agent.id, 'implement the card')).toBe(true)
  await until(() => t.driver.sends.length === 1)
  expect(t.driver.sends[0][1]).toBe('implement the card')

  const sessionRow = t.db.prepare('SELECT provider, external_id FROM agent_sessions WHERE agent_id=?')
    .get(agent.id) as { provider: string; external_id: string }
  expect(sessionRow.provider).toBe('qwen')
})

it('records the provider session id and usage reported by stream-json result events', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'qwen-meter', provider: 'qwen' })
  await until(() => t.driver.launches.length === 1)
  t.manager.task(agent.id, 'do it')
  await until(() => t.driver.sends.length === 1)

  t.driver.emit('qwen:1', {
    type: 'status', data: 'Qwen session initialized',
    metadata: { phase: 'session_init', providerSessionId: 'qsess-77', model: 'qwen3-coder-plus' },
  })
  emitTurn(t.driver, 'qwen:1')

  await until(() => {
    const row = t.db.prepare('SELECT external_session_id, status FROM agents WHERE id=?').get(agent.id) as any
    return row.external_session_id === 'qsess-77' && row.status === 'idle'
  })
  const usage = t.manager.transcript(agent.id).info.usage.session
  expect(usage).toMatchObject({ provider: 'qwen', total_tokens: 120, input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 })
  // codex-style accounting: cached input is a subset of input, never additive
  expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens)
})

it('resumes an existing Qwen session through the hire modal path', async () => {
  const t = setup()
  const agent = t.manager.hire({
    boardId: 1, cwd: '/project', name: 'qwen-resume', provider: 'qwen', resumeSession: 'qsess-42',
  })
  await until(() => t.driver.launches.length === 1)
  expect(t.driver.launches[0].externalId).toBe('qsess-42')
  expect(t.db.prepare('SELECT external_session_id FROM agents WHERE id=?').get(agent.id))
    .toMatchObject({ external_session_id: 'qsess-42' })
})

it('interrupts, controls, and refuses approvals for Qwen agents', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'qwen-controls', provider: 'qwen', model: 'qwen3-coder-plus' })
  await until(() => t.driver.launches.length === 1)

  expect(await t.manager.interruptAgent(agent.id)).toBe(true)
  expect(t.driver.interrupts).toEqual(['qwen:1'])

  expect(await t.manager.setModel(agent.id, 'qwen3.7-plus')).toBe(true)
  expect(t.db.prepare('SELECT model FROM agents WHERE id=?').get(agent.id)).toMatchObject({ model: 'qwen3.7-plus' })

  expect(await t.manager.setEffort(agent.id, 'high')).toBe('bad-level')
  expect(await t.manager.setAccessProfile(agent.id, 'read_only')).toBe(true)
  expect(await t.manager.resolveApproval(agent.id, 'req-1', 'allow')).toBe(false)
  expect(await t.manager.resolvePermission(agent.id, 'req-1', 'allow')).toBe(false)
})

it('finalizes a launched card when the Qwen turn completes', async () => {
  const t = setup()
  t.db.prepare("INSERT INTO cards (id, board_id, title, description) VALUES (5, 1, 'Qwen card', 'do it')").run()

  t.manager.launch({ boardId: 1, cardId: 5, cwd: '/project', brief: 'implement', provider: 'qwen' })
  await until(() => t.driver.sends.length === 1)
  expect(t.driver.sends[0][1]).toContain('implement')

  t.driver.emit('qwen:1', { type: 'output', data: 'Done: shipped the change.' })
  emitTurn(t.driver, 'qwen:1')

  await until(() => {
    const card = t.db.prepare('SELECT column_name, owner_agent_id FROM cards WHERE id=5').get() as any
    return card.column_name === 'review' && card.owner_agent_id === null
  })
  await until(() => (t.db.prepare('SELECT status FROM agents WHERE provider=?').get('qwen') as any).status === 'gone')
})

it('pauses on provider rate-limit errors and recovers on the next output', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'qwen-limited', provider: 'qwen' })
  await until(() => t.driver.launches.length === 1)
  t.manager.task(agent.id, 'work')
  await until(() => t.driver.sends.length === 1)

  t.driver.emit('qwen:1', { type: 'error', data: '429 Too Many Requests' })
  await until(() => (t.db.prepare('SELECT status FROM agents WHERE id=?').get(agent.id) as any).status === 'paused_provider')

  t.driver.emit('qwen:1', { type: 'status', data: 'Qwen turn started', metadata: { phase: 'turn_started' } })
  await until(() => (t.db.prepare('SELECT status FROM agents WHERE id=?').get(agent.id) as any).status === 'active')
  expect(agent).toBeTruthy()
})

it('publishes Qwen in the provider catalog with honest capability gates', async () => {
  const t = setup()
  const catalogs = await t.manager.providerCatalog()
  const qwen = catalogs.find((catalog) => catalog.id === 'qwen')
  expect(qwen).toMatchObject({ id: 'qwen', name: 'Qwen Code', available: true })
  expect(qwen?.capabilities).toEqual(QWEN_CAPABILITIES)
  expect(qwen?.models.length).toBeGreaterThan(0)

  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'qwen-caps', provider: 'qwen' })
  const capabilities = t.manager.capabilities(agent.id)
  expect(capabilities).toContain('model')
  expect(capabilities).toContain('interrupt')
  expect(capabilities).not.toContain('effort')
  expect(capabilities).not.toContain('approvals')
})

it('survives consecutive hires before any provider session id exists', async () => {
  const t = setup()
  const first = t.manager.hire({ boardId: 1, cwd: '/project', name: 'qwen-first', provider: 'qwen' })
  await until(() => t.driver.launches.length === 1)
  const second = t.manager.hire({ boardId: 1, cwd: '/project', name: 'qwen-second', provider: 'qwen' })
  await until(() => t.driver.launches.length === 2)
  await new Promise((resolve) => setTimeout(resolve, 100))
  // the agents table carries UNIQUE(provider, external_session_id); qwen sessions
  // have no provider id until the first init event, so both must stay NULL, not ''
  const rows = t.db.prepare("SELECT id, status, external_session_id FROM agents WHERE provider='qwen' ORDER BY id").all() as Array<{
    id: number
    status: string
    external_session_id: string | null
  }>
  expect(rows.map((row) => row.status)).toEqual(['idle', 'idle'])
  expect(rows.map((row) => row.external_session_id)).toEqual([null, null])
  expect(first.id).not.toBe(second.id)
})

it('fires a Qwen agent and marks it gone', async () => {
  const t = setup()
  const agent = t.manager.hire({ boardId: 1, cwd: '/project', name: 'qwen-fire', provider: 'qwen' })
  await until(() => t.driver.launches.length === 1)
  expect(await t.manager.fire(agent.id)).toBe(true)
  expect(t.driver.stops).toContain('qwen:1')
  await until(() => (t.db.prepare('SELECT status FROM agents WHERE id=?').get(agent.id) as any).status === 'gone')
})

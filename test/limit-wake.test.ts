import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { openDb } from '../src/db.js'
import { isUsageLimitError } from '../src/limits.js'

// the SDK spawns a real claude subprocess — tests drive a hand-cranked session instead
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Conductor } from '../src/conductor.js'

function fakeSession() {
  const msgs: any[] = []
  let notify: (() => void) | null = null
  let closed = false
  const wake = () => { notify?.(); notify = null }
  return {
    emit(m: any) { msgs.push(m); wake() },
    close() { closed = true; wake() },
    query: {
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (msgs.length) yield msgs.shift()
          if (closed) return
          await new Promise<void>((r) => { notify = r })
        }
      },
    },
  }
}

function setup() {
  const db = openDb(':memory:')
  const bus = new EventEmitter()
  const events: any[] = []
  bus.on('event', (e) => events.push(e))
  const sessions: ReturnType<typeof fakeSession>[] = []
  ;(query as any).mockImplementation(() => {
    const s = fakeSession()
    sessions.push(s)
    return s.query
  })
  const conductor = new Conductor(db, bus)
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  const mkCard = (title: string) => {
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO cards (board_id, title, description) VALUES (1, ?, 'trivial ticket')`).run(title)
    return Number(lastInsertRowid)
  }
  const card = (id: number) => db.prepare(`SELECT * FROM cards WHERE id=?`).get(id) as any
  const agentRow = (id: number) => db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as any
  const cardEvents = (id: number) =>
    db.prepare(`SELECT * FROM card_events WHERE card_id=? ORDER BY id`).all(id) as any[]
  return { db, bus, events, sessions, conductor, mkCard, card, agentRow, cardEvents }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('condition never became true')
}

beforeEach(() => { delete process.env.ORCHESTRA_MAX_LAUNCHED; process.env.ORCHESTRA_AUTOSHIP = '0' })
afterEach(() => { delete process.env.ORCHESTRA_MAX_LAUNCHED; delete process.env.ORCHESTRA_AUTOSHIP })

// ── classification ────────────────────────────────────────────────────────

it('classifies usage-limit signals and nothing else', () => {
  expect(isUsageLimitError('Claude usage limit reached ∙ resets 9pm')).toBe(true)
  expect(isUsageLimitError('API Error: 429 rate_limit_error')).toBe(true)
  expect(isUsageLimitError('overloaded_error: Overloaded')).toBe(true)
  expect(isUsageLimitError('5-hour limit reached')).toBe(true)
  expect(isUsageLimitError('weekly limit exhausted: out of usage')).toBe(true)
  expect(isUsageLimitError('error_max_turns')).toBe(false)
  expect(isUsageLimitError('TypeError: cannot read foo of undefined')).toBe(false)
  expect(isUsageLimitError('')).toBe(false)
  expect(isUsageLimitError(null)).toBe(false)
})

// ── limit-death → paused_limit + parked ticket ────────────────────────────

async function launchAndLimitKill(t: ReturnType<typeof setup>, cardId: number) {
  const res = t.conductor.launch({ boardId: 1, cardId, cwd: '/p', brief: 'do it' })
  const s = t.sessions[t.sessions.length - 1]
  s.emit({ type: 'system', subtype: 'init', session_id: `sess-${cardId}`, model: 'fable' })
  s.emit({ type: 'result', subtype: 'error_during_execution', result: 'Claude usage limit reached ∙ resets 9pm' })
  s.close()
  await until(() => t.agentRow(res.agent.id).status === 'paused_limit')
  return res.agent
}

it('limit-death parks the agent paused_limit and the ticket blocked, keeping owner and session', async () => {
  const t = setup()
  const id = t.mkCard('gets limit-killed')
  const agent = await launchAndLimitKill(t, id)

  const a = t.agentRow(agent.id)
  expect(a.status).toBe('paused_limit')
  expect(a.sdk_session).toBe(`sess-${id}`) // memory survives the pause
  const c = t.card(id)
  expect(c.column_name).toBe('blocked')
  expect(c.owner_agent_id).toBe(agent.id) // the ticket remembers its agent
  expect(t.cardEvents(id).some((e) => e.type === 'limit_paused' && JSON.parse(e.payload).reason === 'usage-limit')).toBe(true)
  expect(t.events.some((e) => e.type === 'limit_pause' && e.data.agent_id === agent.id)).toBe(true)
  // cards were NOT pruned and the exit did not delete history
  expect(t.cardEvents(id).length).toBeGreaterThan(0)
})

it('limit-death does not bounce pending mail — it stays undelivered for the wake', async () => {
  const t = setup()
  const id = t.mkCard('with mail in flight')
  const agent = await launchAndLimitKill(t, id)
  // mail sent while paused (simulates the window where the agent has no live session)
  t.db.prepare(`INSERT INTO messages (board_id, to_agent_id, body) VALUES (1, ?, 'psst: codeword is quetzal')`).run(agent.id)
  const mail = t.db.prepare(`SELECT * FROM messages WHERE to_agent_id=?`).all(agent.id) as any[]
  expect(mail).toHaveLength(1)
  expect(mail[0].delivered_at).toBeNull()
  // no system bounce reply was minted for anything addressed to this agent
  expect(t.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE from_agent_id IS NULL AND reply_to IS NOT NULL`).get()).toMatchObject({ n: 0 })
})

it('a real (non-limit) error still goes gone via the normal exit path', async () => {
  const t = setup()
  const id = t.mkCard('crashes hard')
  const res = t.conductor.launch({ boardId: 1, cardId: id, cwd: '/p', brief: 'do it' })
  const s = t.sessions[0]
  s.emit({ type: 'system', subtype: 'init', session_id: 's1' })
  s.emit({ type: 'result', subtype: 'error_during_execution', result: 'TypeError: boom' })
  s.close()
  await until(() => t.agentRow(res.agent.id).status === 'gone')
  expect(t.card(id).column_name).toBe('blocked')
  expect(t.card(id).owner_agent_id).toBeNull() // normal path releases ownership
})

it('a limit-killed ephemeral verifier stays dead — never paused, never wakeable', async () => {
  const t = setup()
  const agent = t.conductor.hire({ boardId: 1, cwd: '/p', role: 'verifier', ephemeral: true })
  const s = t.sessions[0]
  s.emit({ type: 'system', subtype: 'init', session_id: 'v1' })
  s.emit({ type: 'result', subtype: 'error_during_execution', result: '429 rate limit' })
  s.close()
  await until(() => t.agentRow(agent.id).status === 'gone')
  // and even a hand-forged paused verifier row is not woken (belt and braces)
  t.db.prepare(`UPDATE agents SET status='paused_limit' WHERE id=?`).run(agent.id)
  const r = t.conductor.wake(1)
  expect(r.woke).toHaveLength(0)
})

// ── wake mechanics ────────────────────────────────────────────────────────

it('wake resumes the paused agent with its session and returns the ticket to in_progress', async () => {
  const t = setup()
  const id = t.mkCard('resumes after reset')
  const agent = await launchAndLimitKill(t, id)
  // mail that arrived during the pause — must ride in on the wake via the #61 seam
  t.db.prepare(`INSERT INTO messages (board_id, to_agent_id, body) VALUES (1, ?, 'codeword is quetzal')`).run(agent.id)

  const callsBefore = (query as any).mock.calls.length
  const r = t.conductor.wake(1)
  expect(r.woke).toEqual([agent.name])
  expect(r.queued).toHaveLength(0)

  // resumed with the saved session and identity — the #41 recipe
  const opts = (query as any).mock.calls[callsBefore][0].options
  expect(opts.resume).toBe(`sess-${id}`)
  const a = t.agentRow(agent.id)
  expect(a.status).toBe('active')
  const c = t.card(id)
  expect(c.column_name).toBe('in_progress')
  expect(c.owner_agent_id).toBe(agent.id) // same agent, same ticket
  expect(t.cardEvents(id).some((e) => e.type === 'limit_resumed')).toBe(true)

  // the resume brief and the stranded mail both landed in the resumed conversation
  const lines = t.conductor.transcript(agent.id).lines.map((l) => l.text).join('\n')
  expect(lines).toContain('resumed with memory intact')
  expect(lines).toContain('codeword is quetzal')
  expect((t.db.prepare(`SELECT delivered_at FROM messages WHERE body LIKE '%quetzal%'`).get() as any).delivered_at).not.toBeNull()
})

it('wake is idempotent: live agents are skipped, a second wake does nothing', async () => {
  const t = setup()
  const id = t.mkCard('woken once')
  const agent = await launchAndLimitKill(t, id)
  expect(t.conductor.wake(1).woke).toEqual([agent.name])
  const again = t.conductor.wake(1)
  expect(again.woke).toHaveLength(0)
  expect(again.queued).toHaveLength(0)
  // still exactly one live session for this agent
  expect(t.conductor.list(1).filter((x) => x === agent.id)).toHaveLength(1)
})

it('5 paused with maxLaunched=3 wakes 3 and queues 2, draining as slots free', async () => {
  process.env.ORCHESTRA_MAX_LAUNCHED = '3'
  const t = setup()
  const agents: any[] = []
  for (let i = 0; i < 5; i++) {
    const id = t.mkCard(`ticket ${i}`)
    agents.push(await launchAndLimitKill(t, id))
  }
  const r = t.conductor.wake(1)
  expect(r.woke).toHaveLength(3)
  expect(r.queued).toHaveLength(2)
  // card-priority order: oldest tickets wake first
  expect(r.woke).toEqual(agents.slice(0, 3).map((a) => a.name))
  expect(r.queued).toEqual(agents.slice(3).map((a) => a.name))

  // a woken agent finishing its ticket frees a slot — the queue resumes a paused one
  const woken = agents[0]
  const s = t.sessions[t.sessions.length - 3] // first of the three wake sessions
  s.emit({ type: 'result', subtype: 'success', result: 'done' })
  s.close()
  await until(() => t.agentRow(agents[3].id).status === 'active')
  expect(t.agentRow(woken.id).status).toBe('gone')
  expect(t.agentRow(agents[4].id).status).toBe('paused_limit') // still waiting for the next slot
})

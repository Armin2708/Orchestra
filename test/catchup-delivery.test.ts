import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { openDb } from '../src/db.js'

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
      setPermissionMode: vi.fn(async () => {}),
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
  const sessions: ReturnType<typeof fakeSession>[] = []
  ;(query as any).mockImplementation(() => {
    const s = fakeSession()
    sessions.push(s)
    return s.query
  })
  const conductor = new Conductor(db, new EventEmitter())
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  return { db, sessions, conductor }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('condition never became true')
}

it('drains mail that arrived while the agent had no live session', () => {
  const t = setup()
  // the agent row exists (e.g. daemon died after hire) but no Hired record is live
  t.db.prepare(`INSERT INTO agents (board_id, name, kind, status) VALUES (1, 'echo-fox', 'hired', 'idle')`).run()
  t.db.prepare(`INSERT INTO agents (board_id, name) VALUES (1, 'asker-owl')`).run()
  t.db.prepare(`INSERT INTO messages (board_id, from_agent_id, to_agent_id, body) VALUES (1, 2, 1, 'still on for the merge?')`).run()

  const a = t.conductor.hire({ boardId: 1, cwd: '/p', name: 'echo-fox' })
  expect(a.id).toBe(1) // upsert-by-name reused the row

  const msg = t.db.prepare(`SELECT * FROM messages WHERE id=1`).get() as any
  expect(msg.delivered_at).not.toBeNull()
  expect(t.db.prepare(`SELECT * FROM deliveries WHERE message_id=1 AND agent_id=1`).get()).toBeTruthy()
  const userLines = t.conductor.transcript(a.id).lines.filter((l) => l.kind === 'user')
  expect(userLines.some((l) => l.text.includes('still on for the merge?') && l.text.includes('asker-owl'))).toBe(true)
})

it('leaves bounced and already-delivered mail alone', () => {
  const t = setup()
  t.db.prepare(`INSERT INTO agents (board_id, name, kind, status) VALUES (1, 'echo-fox', 'hired', 'idle')`).run()
  // dead-lettered while gone: has a system bounce reply — the sender was already told
  t.db.prepare(`INSERT INTO messages (board_id, from_agent_id, to_agent_id, body) VALUES (1, NULL, 1, 'old assignment')`).run()
  t.db.prepare(`INSERT INTO messages (board_id, from_agent_id, to_agent_id, body, reply_to) VALUES (1, NULL, NULL, '⚠ undeliverable: …', 1)`).run()
  // consumed long ago
  t.db.prepare(`INSERT INTO messages (board_id, from_agent_id, to_agent_id, body, delivered_at) VALUES (1, NULL, 1, 'seen already', datetime('now'))`).run()

  const a = t.conductor.hire({ boardId: 1, cwd: '/p', name: 'echo-fox' })
  expect((t.db.prepare(`SELECT delivered_at FROM messages WHERE id=1`).get() as any).delivered_at).toBeNull()
  expect(t.conductor.transcript(a.id).lines.filter((l) => l.kind === 'user')).toHaveLength(0)
})

it('an effort-restart handoff drains mail posted during the swap gap', async () => {
  const t = setup()
  const a = t.conductor.hire({ boardId: 1, cwd: '/p', name: 'echo-fox' })
  t.sessions[0].emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5' })
  await until(() => t.conductor.transcript(a.id).info?.model === 'claude-fable-5')

  // mail lands while the swap is about to happen — no instant-delivery, delivered_at stays NULL
  t.db.prepare(`INSERT INTO messages (board_id, from_agent_id, to_agent_id, body) VALUES (1, NULL, ?, 'mid-swap question')`).run(a.id)

  const p = t.conductor.setEffort(a.id, 'high')
  await new Promise((r) => setTimeout(r, 15))
  t.sessions[0].close() // hand-crank the superseded session shut
  expect(await p).toBe('ok')

  await until(() => (t.db.prepare(`SELECT delivered_at FROM messages WHERE body='mid-swap question'`).get() as any).delivered_at !== null)
  const successor = t.conductor.transcript(a.id)
  expect(successor.lines.some((l) => l.kind === 'user' && l.text.includes('mid-swap question'))).toBe(true)
})

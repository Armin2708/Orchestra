import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { reap, bounceDeadLetters } from '../src/reaper.js'
import { buildServer } from '../src/server.js'

it('rejects a message to a gone agent at send time', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })
  const a2 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })).json()
  await s.inject({ method: 'POST', url: `/api/v1/agents/${a2.id}/leave` })

  const res = await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', to: 'jade-lynx', body: 'anyone home?' } })
  expect(res.statusCode).toBe(409)
  expect(res.json().error).toContain('gone')
  expect(res.json().error).toContain('jade-lynx')
})

it('bounces undelivered messages into the thread when the recipient leaves', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a1 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const a2 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })).json()
  const q = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', to: 'jade-lynx', body: 'is the SSE path final?' } })).json()
  expect(q.delivered_at).toBeNull() // session agents only get mail via pulse

  await s.inject({ method: 'POST', url: `/api/v1/agents/${a2.id}/leave` })

  // the bounce closes the open question and reaches the asker on next pulse
  const snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snap.open_questions.map((m: any) => m.id)).not.toContain(q.id)
  expect(snap.dead_letters).toHaveLength(1)
  expect(snap.dead_letters[0]).toMatchObject({ id: q.id, to_name: 'jade-lynx', bounced: 1 })
  const thread = snap.threads.find((t: any) => t.id === q.id)
  expect(thread.answered).toBe(true)
  expect(thread.replies[0].body).toContain('undeliverable')

  const pulse = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a1.id}/pulse` })).json()
  expect(pulse.messages.some((m: any) => m.reply_to === q.id && m.body.includes('undeliverable'))).toBe(true)

  // leaving again must not double-bounce
  await s.inject({ method: 'POST', url: `/api/v1/agents/${a2.id}/leave` })
  const again = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(again.threads.find((t: any) => t.id === q.id).replies).toHaveLength(1)
})

it('does not bounce delivered or already-answered messages', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  db.prepare(`INSERT INTO agents (board_id, name) VALUES (1, 'sender')`).run()
  db.prepare(`INSERT INTO agents (board_id, name, status) VALUES (1, 'gone-otter', 'gone')`).run()
  db.prepare(`INSERT INTO messages (board_id, from_agent_id, to_agent_id, body, delivered_at) VALUES (1, 1, 2, 'read in time', datetime('now'))`).run()
  db.prepare(`INSERT INTO messages (board_id, from_agent_id, to_agent_id, body) VALUES (1, 1, 2, 'answered elsewhere')`).run()
  db.prepare(`INSERT INTO messages (board_id, from_agent_id, to_agent_id, body, reply_to) VALUES (1, 1, 1, 'handled', 2)`).run()
  expect(bounceDeadLetters(db, 2)).toHaveLength(0)
})

it('reap bounces dead letters of staled-out agents', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  db.prepare(`INSERT INTO agents (board_id, name) VALUES (1, 'asker')`).run()
  db.prepare(`INSERT INTO agents (board_id, name, last_seen) VALUES (1, 'stale-otter', datetime('now', '-40 minutes'))`).run()
  db.prepare(`INSERT INTO messages (board_id, from_agent_id, to_agent_id, body) VALUES (1, 1, 2, 'still there?')`).run()
  reap(db)
  const bounce = db.prepare(`SELECT * FROM messages WHERE reply_to=1`).get() as any
  expect(bounce.body).toContain('stale-otter left the board')
  expect(bounce.to_agent_id).toBe(1) // routed back to the asker
})

it('a bounce whose sender is unknown becomes a board broadcast', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  db.prepare(`INSERT INTO agents (board_id, name, status) VALUES (1, 'gone-otter', 'gone')`).run()
  // e.g. an undelivered assignment brief from the human (from_agent_id NULL)
  db.prepare(`INSERT INTO messages (board_id, to_agent_id, body) VALUES (1, 1, 'you are assigned card #9')`).run()
  const [bounce] = bounceDeadLetters(db, 1) as any[]
  expect(bounce.to_agent_id).toBeNull()
  expect(bounce.reply_to).toBe(1)
})

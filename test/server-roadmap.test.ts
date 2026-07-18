import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer, ConductorLike, Bus } from '../src/server.js'

it('ideas promote to tickets and assignment briefs the agent', async () => {
  const db = openDb(':memory:')
  const tasked: any[] = []
  const stub = (_bus: Bus): ConductorLike => ({
    isHired: (id) => Boolean(db.prepare(`SELECT 1 FROM agents WHERE id=? AND kind='hired'`).get(id)),
    hire: () => ({}),
    deliver: (id, msg) => { tasked.push({ id, text: msg.body }); return true },
    task: () => true,
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => true,
    fire: async () => true,
  })
  const s = buildServer(db, stub); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  db.prepare(`INSERT INTO agents (board_id, name, kind) VALUES (?, 'amber-fox', 'hired')`).run(b.id)
  const hiredId = (db.prepare(`SELECT id FROM agents WHERE name='amber-fox'`).get() as any).id
  await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })

  // capture ideas
  const idea = (await s.inject({ method: 'POST', url: '/api/v1/ideas', payload: {
    board_id: b.id, text: 'Dark mode toggle\nRespect system preference, persist choice' } })).json()
  let snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snap.ideas).toHaveLength(1)

  // promote + assign to a hired agent → card in_progress, owner set, task delivered
  const r = (await s.inject({ method: 'POST', url: `/api/v1/ideas/${idea.id}/promote`, payload: { agent: 'amber-fox' } })).json()
  expect(r.card.title).toBe('Dark mode toggle')
  expect(r.card.owner).toBe('amber-fox')
  expect(r.card.column).toBe('in_progress')
  expect(tasked).toHaveLength(1)
  expect(tasked[0].id).toBe(hiredId)
  expect(tasked[0].text).toContain('Dark mode toggle')
  snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snap.ideas).toHaveLength(0) // idea consumed

  // reassign to a terminal agent → message queued for hook delivery
  await s.inject({ method: 'POST', url: `/api/v1/cards/${r.card.id}/assign`, payload: { agent: 'jade-lynx' } })
  const jade = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
    .agents.find((a: any) => a.name === 'jade-lynx')
  const pulse = (await s.inject({ method: 'POST', url: `/api/v1/agents/${jade.id}/pulse` })).json()
  expect(pulse.messages.some((m: any) => m.body.includes("You've been assigned card"))).toBe(true)

  // unknown agent fails loudly
  expect((await s.inject({ method: 'POST', url: `/api/v1/cards/${r.card.id}/assign`, payload: { agent: 'ghost' } })).statusCode).toBe(400)

  // done cards can be restored: back to backlog, unowned
  await s.inject({ method: 'POST', url: `/api/v1/cards/${r.card.id}/move`, payload: { column: 'done' } })
  const restored = (await s.inject({ method: 'POST', url: `/api/v1/cards/${r.card.id}/restore` })).json()
  expect(restored.card.column).toBe('backlog')
  expect(restored.card.owner).toBeNull()
})

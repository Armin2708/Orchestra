import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('deletes messages, cards, agents, and boards', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const card = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: b.id, title: 'X', agent: 'amber-fox' } })).json().card
  const q = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, to: 'amber-fox', body: 'q?' } })).json()
  await s.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, from: 'amber-fox', body: 'a', reply_to: q.id } })

  // deleting a question removes its replies too
  await s.inject({ method: 'DELETE', url: `/api/v1/messages/${q.id}` })
  let snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snap.threads).toHaveLength(0)

  await s.inject({ method: 'DELETE', url: `/api/v1/cards/${card.id}` })
  snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snap.cards).toHaveLength(0)

  await s.inject({ method: 'DELETE', url: `/api/v1/agents/${a.id}` })
  snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snap.agents).toHaveLength(0)

  await s.inject({ method: 'DELETE', url: `/api/v1/boards/${b.id}` })
  const boards = (await s.inject({ method: 'GET', url: '/api/v1/boards' })).json()
  expect(boards).toHaveLength(0)
  expect((await s.inject({ method: 'DELETE', url: '/api/v1/cards/999' })).statusCode).toBe(404)
})

it('board delete cascades every board-linked table and spares other boards', async () => {
  const db = openDb(':memory:')
  const s = buildServer(db); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/doomed' } })).json()
  const keep = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/kept' } })).json()
  const a = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const card = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: b.id, title: 'X', agent: 'amber-fox' } })).json().card
  await s.inject({ method: 'POST', url: '/api/v1/milestones', payload: { board_id: b.id, title: 'M' } })
  await s.inject({ method: 'POST', url: '/api/v1/ideas', payload: { board_id: b.id, text: 'idea' } })
  db.prepare(`INSERT INTO teams (board_id, name, spec_json) VALUES (?, 'crew', '{}')`).run(b.id)
  db.prepare(`INSERT INTO review_decisions (board_id, card_id, decision) VALUES (?, ?, 'approve')`).run(b.id, card.id)
  db.prepare(`INSERT INTO token_telemetry (board_id, agent_id, hook_event, day) VALUES (?, ?, 'x', '2026-01-01')`).run(b.id, a.id)
  db.prepare(`INSERT INTO agent_usage (board_id, agent_id, day) VALUES (?, ?, '2026-01-01')`).run(b.id, a.id)
  db.prepare(`INSERT INTO agent_transcripts (agent_id, lines) VALUES (?, '[]')`).run(a.id)
  const keepAgent = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: keep.id, name: 'blue-owl' } })).json()
  db.prepare(`INSERT INTO agent_transcripts (agent_id, lines) VALUES (?, '[]')`).run(keepAgent.id)

  const res = await s.inject({ method: 'DELETE', url: `/api/v1/boards/${b.id}` })
  expect(res.statusCode).toBe(200)
  for (const [table, column] of [
    ['agents', 'board_id'], ['cards', 'board_id'], ['messages', 'board_id'], ['milestones', 'board_id'],
    ['ideas', 'board_id'], ['teams', 'board_id'], ['review_decisions', 'board_id'],
    ['token_telemetry', 'board_id'], ['agent_usage', 'board_id'],
  ] as const)
    expect(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(b.id), table).toEqual({ n: 0 })
  expect(db.prepare(`SELECT count(*) AS n FROM agent_transcripts WHERE agent_id=?`).get(a.id)).toEqual({ n: 0 })
  // the surviving board keeps its rows
  expect(db.prepare(`SELECT count(*) AS n FROM agent_transcripts WHERE agent_id=?`).get(keepAgent.id)).toEqual({ n: 1 })
  const boards = (await s.inject({ method: 'GET', url: '/api/v1/boards' })).json()
  expect(boards.map((x: any) => x.id)).toEqual([keep.id])
})

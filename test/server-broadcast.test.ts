import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('emits one board-created event so clients do not need discovery polling', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const emitted: Array<{ board_id: number; type: string; data: unknown }> = []
  s.bus.on('event', (event) => emitted.push(event))
  const first = (await s.inject({
    method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/new-board' },
  })).json()
  await s.inject({
    method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/new-board' },
  })
  expect(emitted).toEqual([{ board_id: first.id, type: 'board', data: first }])
})

it('announcements wake nobody; confirmed swarms reach only their snapshotted recipients', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a1 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const a2 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })).json()
  const a3 = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'onyx-crane' } })).json()
  const paused = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'sleepy-ibis' } })).json()
  s.db.prepare(`UPDATE agents SET status='paused_limit' WHERE id=?`).run(paused.id)

  // no-target messages are safe board announcements by default
  const announcement = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', body: 'rebasing main now',
  } })).json()
  expect(announcement.kind).toBe('announce')
  for (const a of [a1, a2, a3]) {
    const p = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a.id}/pulse` })).json()
    expect(p.messages).toHaveLength(0)
  }
  const snapAfterAnnouncement = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snapAfterAnnouncement.open_questions.map((m: any) => m.id)).not.toContain(announcement.id)

  // an explicit swarm exposes its amplification before it can wake anyone
  const unconfirmed = await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', kind: 'swarm', body: 'audit the release',
  } })
  expect(unconfirmed.statusCode).toBe(409)
  expect(unconfirmed.json().recipient_count).toBe(2)

  const swarm = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', kind: 'swarm', confirm: true, body: 'audit the release',
  } })).json()
  expect(swarm).toMatchObject({ kind: 'swarm', recipient_count: 2 })

  // each snapshotted peer receives it once
  const p2 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a2.id}/pulse` })).json()
  expect(p2.messages.map((m: any) => m.body)).toContain('audit the release')
  const p3 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a3.id}/pulse` })).json()
  expect(p3.messages.map((m: any) => m.body)).toContain('audit the release')
  expect((await s.inject({ method: 'POST', url: `/api/v1/agents/${a3.id}/pulse` })).json().messages).toHaveLength(0)

  // sender and agents joining after the send never receive it
  const p1 = (await s.inject({ method: 'POST', url: `/api/v1/agents/${a1.id}/pulse` })).json()
  expect(p1.messages).toHaveLength(0)
  const late = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'late-wren' } })).json()
  expect((await s.inject({ method: 'POST', url: `/api/v1/agents/${late.id}/pulse` })).json().messages).toHaveLength(0)

  const snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  const thread = snap.threads.find((t: any) => t.id === swarm.id)
  expect(thread).toMatchObject({ recipient_count: 2, delivered_count: 2 })
  expect(snap.open_questions.map((m: any) => m.id)).not.toContain(swarm.id)

  // typo'd recipient fails loudly instead of silently broadcasting
  const bad = await s.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, to: 'no-such-agent', body: 'hi' } })
  expect(bad.statusCode).toBe(400)
  expect(bad.json().error).toContain('no-such-agent')
})

it('an explicit no-target ask is for the human, not every agent', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const asker = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  const peer = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })).json()
  const q = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', kind: 'ask', body: 'which database should I use?',
  } })).json()

  expect((await s.inject({ method: 'POST', url: `/api/v1/agents/${peer.id}/pulse` })).json().messages).toHaveLength(0)
  expect((await s.inject({ method: 'POST', url: `/api/v1/agents/${asker.id}/pulse` })).json().messages).toHaveLength(0)
  const snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json()
  expect(snap.open_questions.map((m: any) => m.id)).toContain(q.id)
})

it('rejects contradictory message intent instead of guessing', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })

  const invalid = await s.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, kind: 'explode', body: 'x' } })
  const targetlessNotify = await s.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, kind: 'notify', body: 'x' } })
  const targetedSwarm = await s.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, to: 'jade-lynx', kind: 'swarm', confirm: true, body: 'x' } })

  expect(invalid.statusCode).toBe(400)
  expect(targetlessNotify.statusCode).toBe(400)
  expect(targetedSwarm.statusCode).toBe(400)
  expect((await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/snapshot` })).json().threads).toHaveLength(0)
})

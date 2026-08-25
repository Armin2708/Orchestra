import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('assembles the delivery ledger from existing records only', async () => {
  const db = openDb(':memory:')
  const server = buildServer(db)
  await server.ready()
  await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' , create: true } })
  db.prepare(`INSERT INTO agents (board_id, name) VALUES (1, 'builder-otter')`).run()
  const epicId = Number(db.prepare(`INSERT INTO milestones (board_id, title) VALUES (1, 'Big effort')`).run().lastInsertRowid)

  const card = (await server.inject({
    method: 'POST', url: '/api/v1/cards',
    payload: { board_id: 1, title: 'traced work', agent: 'builder-otter' },
  })).json().card
  db.prepare(`UPDATE cards SET milestone_id=?, branch='feat/traced' WHERE id=?`).run(epicId, card.id)
  await server.inject({
    method: 'PUT', url: `/api/v1/cards/${card.id}/contract`,
    payload: { objective: 'Trace it', acceptance_criteria: ['ledger renders'] },
  })
  const ev = db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, 1, ?, ?)`)
  ev.run(card.id, 'shipped', JSON.stringify({ hash: 'abc1234def', subject: 'feat: traced work', by: 'builder-otter' }))
  ev.run(card.id, 'verification', JSON.stringify({ verdict: 'pass', criteria: [{ text: 'ledger renders', met: true }] }))
  db.prepare(`INSERT INTO review_decisions (board_id, card_id, decision, note) VALUES (1, ?, 'approve', 'lgtm')`).run(card.id)

  const res = await server.inject({ url: `/api/v1/cards/${card.id}/ledger` })
  expect(res.statusCode).toBe(200)
  const ledger = res.json()
  expect(ledger.origin).toMatchObject({ creator: 'builder-otter', epic: { title: 'Big effort' } })
  expect(ledger.contract).toMatchObject({ objective: 'Trace it', criteria: ['ledger renders'], version: 1 })
  expect(ledger.work).toMatchObject({ branch: 'feat/traced' })
  expect(ledger.work.commits[0]).toMatchObject({ hash: 'abc1234def', subject: 'feat: traced work' })
  expect(ledger.reviews[0]).toMatchObject({ decision: 'approve', note: 'lgtm' })
  expect(ledger.verification).toMatchObject({ verdict: 'pass' })
  expect(ledger.timeline.map((e: any) => e.type)).toContain('contract')
})

it('404s for unknown cards and returns null sections when sparse', async () => {
  const db = openDb(':memory:')
  const server = buildServer(db)
  await server.ready()
  await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' , create: true } })
  expect((await server.inject({ url: '/api/v1/cards/999/ledger' })).statusCode).toBe(404)

  const bare = (await server.inject({
    method: 'POST', url: '/api/v1/cards', payload: { board_id: 1, title: 'bare' },
  })).json().card
  const ledger = (await server.inject({ url: `/api/v1/cards/${bare.id}/ledger` })).json()
  expect(ledger.contract).toBeNull()
  expect(ledger.verification).toBeNull()
  expect(ledger.reviews).toEqual([])
  expect(ledger.work.commits).toEqual([])
})

import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

async function seed() {
  const db = openDb(':memory:')
  const s = buildServer(db); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const fox = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()
  await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'jade-lynx' } })
  return { db, s, b, fox }
}
const backdate = (db: any, table: string, col: string, id: number, minutes: number) =>
  db.prepare(`UPDATE ${table} SET ${col} = datetime('now', ?) WHERE id = ?`).run(`-${minutes} minutes`, id)
const timeline = async (s: any, boardId: number, q = '') =>
  (await s.inject({ method: 'GET', url: `/api/v1/boards/${boardId}/timeline${q}` })).json()

it('merges all four sources reverse-chronologically', async () => {
  const { db, s, b } = await seed()
  const { card } = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Build feed', column: 'in_progress', agent: 'amber-fox' } })).json()
  const created = db.prepare(`SELECT id FROM card_events WHERE card_id=? AND type='created'`).get(card.id) as any
  const ms = db.prepare(`INSERT INTO milestones (board_id, title, description) VALUES (?, 'v1 launch', 'ship it')`).run(b.id)
  const msg = (await s.inject({ method: 'POST', url: '/api/v1/messages', payload: {
    board_id: b.id, from: 'amber-fox', to: 'jade-lynx', body: 'feed is up' } })).json()
  const rev = db.prepare(`INSERT INTO review_decisions (board_id, card_id, decision, note) VALUES (?, ?, 'approve', 'nice')`).run(b.id, card.id)

  backdate(db, 'milestones', 'created_at', Number(ms.lastInsertRowid), 180)
  backdate(db, 'card_events', 'created_at', created.id, 120)
  backdate(db, 'messages', 'created_at', msg.id, 60)
  backdate(db, 'review_decisions', 'decided_at', Number(rev.lastInsertRowid), 30)

  const r = await timeline(s, b.id)
  expect(r.items.map((i: any) => i.source)).toEqual(['review', 'message', 'card', 'milestone'])
  expect(r.items[0].summary).toContain('approved "Build feed"')
  expect(r.items[1].summary).toBe('amber-fox → jade-lynx: feed is up')
  expect(r.items[2].summary).toBe('created "Build feed"')
  expect(r.items[3].summary).toContain('milestone "v1 launch"')
  expect(r.has_more).toBe(false)
  expect(r.next_cursor).toBeNull()
})

it('cursor walk has no dups or gaps, even with same-second timestamps and mid-walk inserts', async () => {
  const { db, s, b } = await seed()
  const { card } = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Busy card', column: 'in_progress', agent: 'amber-fox' } })).json()
  for (let i = 0; i < 7; i++) {
    await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/move`, payload: { column: i % 2 ? 'review' : 'in_progress', agent: 'amber-fox' } })
  }
  // half the rows share one backdated second, half another — exercises the (source,id) tiebreak
  const events = db.prepare(`SELECT id FROM card_events ORDER BY id`).all() as any[]
  events.forEach((e, i) => backdate(db, 'card_events', 'created_at', e.id, i < 4 ? 40 : 20))
  const all = await timeline(s, b.id, '?limit=200')
  const expected = all.items.map((i: any) => `${i.source}:${i.id}`)
  expect(expected.length).toBe(events.length)

  const walked: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const page = await timeline(s, b.id, `?limit=3${cursor ? `&cursor=${cursor}` : ''}`)
    walked.push(...page.items.map((i: any) => `${i.source}:${i.id}`))
    cursor = page.next_cursor
    // concurrent insert mid-walk: newer rows must not shift or duplicate later pages
    if (pages === 0) await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/move`, payload: { column: 'done', agent: 'amber-fox' } })
    pages++
  } while (cursor)
  expect(walked).toEqual(expected) // no dups, no gaps, stable order
  expect(new Set(walked).size).toBe(walked.length)
})

it('filters by agent, card, and type server-side', async () => {
  const { db, s, b } = await seed()
  const { card } = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Fox work', column: 'in_progress', agent: 'amber-fox' } })).json()
  const { card: other } = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Lynx work', column: 'in_progress', agent: 'jade-lynx' } })).json()
  await s.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, from: 'jade-lynx', to: 'amber-fox', body: 'ping' } })
  db.prepare(`INSERT INTO milestones (board_id, title) VALUES (?, 'M1')`).run(b.id)

  const byAgent = await timeline(s, b.id, '?agent=amber-fox')
  expect(byAgent.items.length).toBeGreaterThan(0)
  // matches actor or message peer, never jade-lynx's own card event
  expect(byAgent.items.every((i: any) => i.agent === 'amber-fox' || i.summary.includes('→ amber-fox'))).toBe(true)
  expect(byAgent.items.some((i: any) => i.card_id === other.id)).toBe(false)

  const byCard = await timeline(s, b.id, `?card=${card.id}`)
  expect(byCard.items.length).toBeGreaterThan(0)
  expect(byCard.items.every((i: any) => i.card_id === card.id)).toBe(true)

  const byType = await timeline(s, b.id, '?type=message')
  expect(byType.items.length).toBe(1)
  expect(byType.items[0].source).toBe('message')

  const byMilestone = await timeline(s, b.id, '?type=milestone')
  expect(byMilestone.items.map((i: any) => i.summary)).toEqual(['milestone "M1"'])
})

it('clamps limit, rejects bad cursors, renders shipped payloads', async () => {
  const { db, s, b } = await seed()
  const { card } = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Ship me', column: 'in_progress', agent: 'amber-fox' } })).json()
  await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/move`, payload: { column: 'done', agent: 'amber-fox' } })
  db.prepare(`INSERT INTO card_events (card_id, type, payload) VALUES (?, 'shipped', ?)`)
    .run(card.id, JSON.stringify({ hash: 'abc1234def5678', subject: 'feat: feed' }))

  const one = await timeline(s, b.id, '?limit=1')
  expect(one.items.length).toBe(1)
  expect(one.has_more).toBe(true)
  expect(one.next_cursor).toBeTruthy()
  expect(one.items[0].summary).toBe('shipped "Ship me" @ abc1234 — feat: feed')

  const bad = await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/timeline?cursor=%%%` })
  expect(bad.statusCode).toBe(400)

  const zero = await timeline(s, b.id, '?limit=0') // falls back to default, still valid
  expect(zero.items.length).toBeGreaterThan(0)
})

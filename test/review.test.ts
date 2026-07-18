import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer, ConductorLike, Bus } from '../src/server.js'
import { diffStat } from '../src/review.js'

const stubConductor = (db: any, delivered: any[]) => (_bus: Bus): ConductorLike => ({
  isHired: (id) => Boolean(db.prepare(`SELECT 1 FROM agents WHERE id=? AND kind='hired'`).get(id)),
  hire: () => ({}),
  deliver: (id, msg) => { delivered.push({ id, text: msg.body }); return true },
  task: () => true,
  transcript: () => ({ lines: [], working: null }),
  interruptAgent: async () => true,
  fire: async () => true,
})

it('a two-step milestone requires approval between steps', async () => {
  const db = openDb(':memory:')
  const delivered: any[] = []
  const s = buildServer(db, stubConductor(db, delivered)); await s.ready()
  const reviews: any[] = []
  s.bus.on('event', (e: any) => { if (e.type === 'review') reviews.push(e.data) })

  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/nowhere' } })).json()
  db.prepare(`INSERT INTO agents (board_id, name, kind) VALUES (?, 'amber-fox', 'hired')`).run(b.id)
  const agentId = (db.prepare(`SELECT id FROM agents WHERE name='amber-fox'`).get() as any).id

  const m = (await s.inject({ method: 'POST', url: '/api/v1/milestones', payload: { board_id: b.id, title: 'Ship it' } })).json()
  const step1 = (await s.inject({ method: 'POST', url: `/api/v1/milestones/${m.id}/steps`, payload: { title: 'Step one' } })).json().card
  const step2 = (await s.inject({ method: 'POST', url: `/api/v1/milestones/${m.id}/steps`, payload: { title: 'Step two' } })).json().card

  // the gate: step two can't be launched while step one is unfinished
  const locked = await s.inject({ method: 'POST', url: `/api/v1/cards/${step2.id}/launch` })
  expect(locked.statusCode).toBe(409)
  expect(locked.json().blocking.map((x: any) => x.id)).toContain(step1.id)

  // agent runs step one and parks it in review (simulating the conductor exit handler's move)
  await s.inject({ method: 'POST', url: `/api/v1/cards/${step1.id}/assign`, payload: { agent: 'amber-fox' } })
  await s.inject({ method: 'POST', url: `/api/v1/cards/${step1.id}/move`, payload: { column: 'review', agent: 'amber-fox' } })
  expect(reviews.at(-1)).toMatchObject({ card_id: step1.id, status: 'awaiting_approval' })
  const events1 = (await s.inject({ method: 'GET', url: `/api/v1/cards/${step1.id}/events` })).json()
  expect(events1.some((e: any) => e.type === 'review_request')).toBe(true)

  // still locked while step one awaits approval
  expect((await s.inject({ method: 'POST', url: `/api/v1/cards/${step2.id}/launch` })).statusCode).toBe(409)

  // send back with a note → card reopens and the note reaches the agent's context
  const sb = await s.inject({ method: 'POST', url: `/api/v1/cards/${step1.id}/send-back`, payload: { note: 'tests are missing' } })
  expect(sb.statusCode).toBe(200)
  expect(sb.json().card.column).toBe('in_progress')
  expect(delivered.some((d) => d.id === agentId && d.text.includes('tests are missing'))).toBe(true)
  expect(reviews.at(-1)).toMatchObject({ card_id: step1.id, status: 'sent_back', note: 'tests are missing' })

  // a note is mandatory on send-back; approve refuses cards not in review
  await s.inject({ method: 'POST', url: `/api/v1/cards/${step1.id}/move`, payload: { column: 'review' } })
  expect((await s.inject({ method: 'POST', url: `/api/v1/cards/${step1.id}/send-back`, payload: {} })).statusCode).toBe(400)
  expect((await s.inject({ method: 'POST', url: `/api/v1/cards/${step2.id}/approve` })).statusCode).toBe(409)

  // approve → step one done, step two unlocked (the gate no longer 409s)
  const ap = (await s.inject({ method: 'POST', url: `/api/v1/cards/${step1.id}/approve`, payload: { note: 'lgtm' } })).json()
  expect(ap.card.column).toBe('done')
  expect(ap.unlocked.id).toBe(step2.id)
  expect(reviews.at(-1)).toMatchObject({ card_id: step1.id, status: 'approved' })
  const unlockedRes = await s.inject({ method: 'POST', url: `/api/v1/cards/${step2.id}/launch` })
  expect(unlockedRes.statusCode).not.toBe(409) // 404 until the launch route lands — the gate stands aside

  // decision history is queryable per card and per board
  const hist = (await s.inject({ method: 'GET', url: `/api/v1/cards/${step1.id}/reviews` })).json()
  expect(hist.map((d: any) => d.decision)).toEqual(['approve', 'send_back'])
  expect(hist[1].note).toBe('tests are missing')
  const boardHist = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/reviews` })).json()
  expect(boardHist).toHaveLength(2)
  expect(boardHist[0].card_title).toBe('Step one')
})

it('a conductor launch-finished event enriches the parked card', async () => {
  const db = openDb(':memory:')
  const s = buildServer(db, stubConductor(db, [])); await s.ready()
  const reviews: any[] = []
  s.bus.on('event', (e: any) => { if (e.type === 'review') reviews.push(e.data) })

  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/nowhere' } })).json()
  const card = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: b.id, title: 'Launched step' } })).json().card
  // the exit handler moves the card itself, then announces it on the bus
  db.prepare(`UPDATE cards SET column_name='review' WHERE id=?`).run(card.id)
  s.bus.emit('event', { board_id: b.id, type: 'launch', data: {
    card_id: card.id, agent_id: 1, agent_name: 'amber-fox', status: 'finished', outcome: 'success', to_column: 'review', summary: 'built the thing' } })
  await new Promise((r) => setTimeout(r, 100))

  const events = (await s.inject({ method: 'GET', url: `/api/v1/cards/${card.id}/events` })).json()
  const reqEvent = events.find((e: any) => e.type === 'review_request')
  expect(JSON.parse(reqEvent.payload).summary).toBe('built the thing')
  expect(reviews.at(-1)).toMatchObject({ card_id: card.id, status: 'awaiting_approval', summary: 'built the thing' })

  // a second announcement for the same cycle does not duplicate the request
  s.bus.emit('event', { board_id: b.id, type: 'launch', data: {
    card_id: card.id, agent_id: 1, agent_name: 'amber-fox', status: 'finished', outcome: 'success', to_column: 'review', summary: 'built the thing' } })
  await new Promise((r) => setTimeout(r, 100))
  const again = (await s.inject({ method: 'GET', url: `/api/v1/cards/${card.id}/events` })).json()
  expect(again.filter((e: any) => e.type === 'review_request')).toHaveLength(1)
})

it('diffStat reports changed paths inside a git repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-review-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
  git('init'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  git('add', '.'); git('commit', '-m', 'init')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n')
  expect(await diffStat(dir)).toContain('a.txt')          // working-tree changes
  git('add', '.'); git('commit', '-m', 'change')
  expect(await diffStat(dir)).toContain('a.txt')          // falls back to the last commit
  expect(await diffStat('/nonexistent-path-xyz')).toBe('') // not a repo → empty, not an error
})

import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { Conductor } from '../src/conductor.js'

// #143: an operator ask to a hired agent auto-creates a tracking card; a turn that
// does no file work deletes it again so questions never pollute the board.

function setup() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/auto-card', 'AutoCard')`).run()
  db.prepare(`INSERT INTO agents (board_id, name, status) VALUES (1, 'worker', 'active')`).run()
  const bus = new EventEmitter()
  const events: any[] = []
  bus.on('event', (e) => events.push(e))
  const maestro = new Conductor(db, bus)
  const pushed: string[] = []
  const hired: any = {
    agentId: 1, boardId: 1, name: 'worker', cwd: '/auto-card',
    push: (text: string) => pushed.push(text),
    cardId: null, ephemeral: false, role: undefined,
    autoCardId: null, turnEdits: 0,
    pending: new Map(), subs: new Map(), transcript: [],
  }
  ;(maestro as any).hired.set(1, hired)
  return { db, maestro, hired, pushed, events }
}

const cards = (db: any) => db.prepare(`SELECT * FROM cards`).all()

it('task() from the operator creates an in_progress card and tells the agent', () => {
  const { db, maestro, hired, pushed, events } = setup()
  expect(maestro.task(1, 'fix the login redirect on mobile')).toBe(true)

  const rows = cards(db)
  expect(rows).toHaveLength(1)
  expect(rows[0].column_name).toBe('in_progress')
  expect(rows[0].owner_agent_id).toBe(1)
  expect(rows[0].title).toBe('fix the login redirect on mobile')
  expect(hired.autoCardId).toBe(rows[0].id)
  expect(pushed[0]).toContain(`card #${rows[0].id} was auto-created`)
  expect(events.some((e) => e.type === 'card' && e.data?.id === rows[0].id)).toBe(true)
})

it('deliver() auto-cards operator asks but not agent asks or replies', () => {
  const { db, maestro, hired } = setup()
  maestro.deliver(1, { id: 9, body: 'peer question', kind: 'ask', from_name: 'other-agent' })
  expect(cards(db)).toHaveLength(0)
  maestro.deliver(1, { id: 10, body: 'answering you', kind: 'reply', from_name: null, reply_to: 4 })
  expect(cards(db)).toHaveLength(0)
  maestro.deliver(1, { id: 11, body: 'please rename the settings tab', kind: 'ask', from_name: null })
  expect(cards(db)).toHaveLength(1)
  expect(hired.autoCardId).not.toBeNull()
})

it('skips slash commands, launched/ephemeral agents, and agents already on a card', () => {
  const { db, maestro, hired } = setup()
  expect(maestro.task(1, '/model opus')).toBe(true)
  expect(cards(db)).toHaveLength(0)

  hired.cardId = 42
  maestro.task(1, 'do something')
  expect(cards(db)).toHaveLength(0)
  hired.cardId = null

  hired.ephemeral = true
  maestro.task(1, 'do something')
  expect(cards(db)).toHaveLength(0)
  hired.ephemeral = false

  db.prepare(`INSERT INTO cards (board_id, title, column_name, owner_agent_id) VALUES (1, 'busy', 'in_progress', 1)`).run()
  maestro.task(1, 'a second ask while busy')
  expect(cards(db)).toHaveLength(1) // only the pre-existing card
})

it('deletes the auto-card after a clean turn with no file work', () => {
  const { db, maestro, hired, events } = setup()
  maestro.task(1, 'what does the reaper do?')
  const cardId = hired.autoCardId
  expect(cardId).not.toBeNull()

  ;(maestro as any).resolveAutoCard(hired, true)
  expect(cards(db)).toHaveLength(0)
  expect(hired.autoCardId).toBeNull()
  expect(events.some((e) => e.type === 'card' && e.data?.deleted === cardId)).toBe(true)
})

it('keeps the auto-card when the turn edited files', () => {
  const { db, maestro, hired } = setup()
  maestro.task(1, 'fix the flaky test')
  hired.turnEdits = 3
  ;(maestro as any).resolveAutoCard(hired, true)
  expect(cards(db)).toHaveLength(1)
  expect(hired.autoCardId).toBeNull() // resolved either way
})

it('keeps the auto-card when the agent engaged with it or the turn errored', () => {
  const { db, maestro, hired } = setup()
  maestro.task(1, 'ship the thing')
  const cardId = hired.autoCardId

  // agent moved the card: an extra card_event marks engagement
  db.prepare(`INSERT INTO card_events (card_id, agent_id, type) VALUES (?, 1, 'moved')`).run(cardId)
  ;(maestro as any).resolveAutoCard(hired, true)
  expect(cards(db)).toHaveLength(1)

  // errored turn keeps the tracker for the interrupted ask
  hired.autoCardId = cardId
  db.prepare(`DELETE FROM card_events WHERE type='moved'`).run()
  ;(maestro as any).resolveAutoCard(hired, false)
  expect(cards(db)).toHaveLength(1)
})

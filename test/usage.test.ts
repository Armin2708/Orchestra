import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { emptyUsage, fromSdkUsage, addUsage, turnUsage, recordUsage, boardUsage, usageTotal, hasUsage } from '../src/usage.js'

const RESULT_USAGE = { input_tokens: 1200, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 4000, output_tokens: 3100 }

it('maps SDK usage fields and ignores garbage', () => {
  expect(fromSdkUsage(RESULT_USAGE)).toEqual({ input_tokens: 1200, cache_read: 90_000, cache_creation: 4000, output_tokens: 3100 })
  expect(fromSdkUsage({ input_tokens: 'nope', output_tokens: -5 })).toEqual(emptyUsage())
  expect(fromSdkUsage(undefined)).toEqual(emptyUsage())
})

it('accumulates turns and prefers authoritative result usage over the fallback', () => {
  // per-assistant-message accrual is the fallback path for results without usage
  const fallback = emptyUsage()
  addUsage(fallback, fromSdkUsage({ input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 40 }))
  addUsage(fallback, fromSdkUsage({ input_tokens: 12, cache_read_input_tokens: 140, output_tokens: 60 }))
  expect(fallback).toEqual({ input_tokens: 22, cache_read: 240, cache_creation: 0, output_tokens: 100 })

  expect(turnUsage(RESULT_USAGE, fallback).cache_read).toBe(90_000) // result present → result wins
  expect(turnUsage(undefined, fallback)).toEqual(fallback)          // result lacks usage → fallback
  expect(turnUsage(undefined, fallback)).not.toBe(fallback)         // copy, not alias
})

it('rolls up per agent per day, skipping empty splits', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  db.prepare(`INSERT INTO agents (board_id, name) VALUES (1, 'busy-fox')`).run()
  db.prepare(`INSERT INTO agents (board_id, name) VALUES (1, 'idle-owl')`).run()

  recordUsage(db, 1, 1, fromSdkUsage(RESULT_USAGE))
  recordUsage(db, 1, 1, fromSdkUsage(RESULT_USAGE)) // second turn, same day — accumulates
  expect(hasUsage(emptyUsage())).toBe(false)
  recordUsage(db, 1, 2, emptyUsage())               // no-op: nothing consumed

  const rows = db.prepare(`SELECT * FROM agent_usage`).all() as any[]
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ agent_id: 1, input_tokens: 2400, cache_read: 180_000, cache_creation: 8000, output_tokens: 6200 })

  const board = boardUsage(db, 1)
  expect(board.total).toMatchObject({ output_tokens: 6200 })
  expect(board.by_agent).toHaveLength(1)
  expect(board.by_agent[0]).toMatchObject({ agent_name: 'busy-fox', cache_read: 180_000 })
  expect(board.days).toHaveLength(1)
  expect(usageTotal(db).input_tokens).toBe(2400)
})

it('serves the split on telemetry and system endpoints under separate keys', async () => {
  const db = openDb(':memory:')
  const s = buildServer(db); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'busy-fox' } })).json()
  recordUsage(db, b.id, a.id, fromSdkUsage(RESULT_USAGE))

  const tel = (await s.inject({ method: 'GET', url: `/api/v1/boards/${b.id}/telemetry` })).json()
  expect(tel.usage.total).toMatchObject({ input_tokens: 1200, cache_read: 90_000, cache_creation: 4000, output_tokens: 3100 })
  expect(tel.usage.by_agent[0].agent_name).toBe('busy-fox')
  expect(tel.total).toBeDefined() // injected-context metric untouched alongside

  const sys = (await s.inject({ method: 'GET', url: '/api/v1/system' })).json()
  expect(sys.agent_usage).toMatchObject({ input_tokens: 1200, output_tokens: 3100 })
  expect(sys.injected).toBeDefined() // the two metrics stay distinct keys
})

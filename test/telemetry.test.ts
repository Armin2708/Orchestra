import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { estimateTokens, recordTelemetry, boardTelemetry, injectedTotal } from '../src/telemetry.js'

it('estimates tokens as ceil(chars/4)', () => {
  expect(estimateTokens(1)).toBe(1)
  expect(estimateTokens(4)).toBe(1)
  expect(estimateTokens(5)).toBe(2)
  expect(estimateTokens(400)).toBe(100)
})

it('aggregates per board/agent/event/day and skips junk entries', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  db.prepare(`INSERT INTO agents (board_id, name) VALUES (1, 'a1'), (1, 'a2')`).run()

  recordTelemetry(db, 1, 1, [
    { event: 'session_start', chars: 1000 },
    { event: 'stop', chars: 10 },
    { event: 'bogus_event', chars: 50 },   // unknown event → skipped
    { event: 'stop', chars: 0 },           // empty → skipped
    { event: 'stop', chars: NaN as any },  // junk → skipped
  ])
  recordTelemetry(db, 1, 1, [{ event: 'stop', chars: 10 }]) // same day upserts
  recordTelemetry(db, 1, 2, [{ event: 'post_tool_use', chars: 7 }])

  const t = boardTelemetry(db, 1) as any
  expect(t.total).toEqual({ chars: 1027, tokens: 258, count: 4 }) // 250 + 3+3 + 2
  const stop = t.by_event.find((e: any) => e.hook_event === 'stop')
  expect(stop).toMatchObject({ chars: 20, tokens: 6, count: 2 })
  expect(t.by_event.map((e: any) => e.hook_event)).not.toContain('bogus_event')
  const a1 = t.by_agent.find((a: any) => a.agent_name === 'a1')
  expect(a1).toMatchObject({ chars: 1020, tokens: 256, count: 3 })
  expect(t.days).toHaveLength(1)
  expect(injectedTotal(db).tokens).toBe(258)
})

async function boot() {
  const server = buildServer(openDb(':memory:'))
  await server.ready()
  const board = (await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/tmp/tel' } })).json()
  const agent = (await server.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: board.id, session_id: 'tel1' } })).json()
  return { server, board, agent }
}

it('pulse and heartbeat piggyback telemetry; endpoint returns per-event counts', async () => {
  const { server, board, agent } = await boot()

  const pulse = await server.inject({
    method: 'POST', url: `/api/v1/agents/${agent.id}/pulse`,
    payload: { telemetry: [{ event: 'session_start', chars: 2400 }, { event: 'user_prompt_submit', chars: 120 }] },
  })
  expect(pulse.statusCode).toBe(200)
  const hb = await server.inject({
    method: 'POST', url: `/api/v1/agents/${agent.id}/heartbeat`,
    payload: { telemetry: [{ event: 'stop', chars: 400 }] },
  })
  expect(hb.statusCode).toBe(200)

  const t = (await server.inject({ method: 'GET', url: `/api/v1/boards/${board.id}/telemetry` })).json()
  expect(t.total.tokens).toBe(600 + 30 + 100)
  expect(t.total.count).toBe(3)
  const byEvent = Object.fromEntries(t.by_event.map((e: any) => [e.hook_event, e.tokens]))
  expect(byEvent).toEqual({ session_start: 600, user_prompt_submit: 30, stop: 100 })
  expect(t.by_agent[0]).toMatchObject({ agent_id: agent.id, agent_name: agent.name, tokens: 730 })

  // bodyless calls (other callers) keep working and record nothing new
  expect((await server.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/heartbeat` })).statusCode).toBe(200)
  expect((await server.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/pulse` })).statusCode).toBe(200)
  const t2 = (await server.inject({ method: 'GET', url: `/api/v1/boards/${board.id}/telemetry` })).json()
  expect(t2.total.count).toBe(3)

  // system meter exposes the global injected total
  const sys = (await server.inject({ method: 'GET', url: '/api/v1/system' })).json()
  expect(sys.injected).toMatchObject({ tokens: 730, count: 3 })
  await server.close()
})

it('leave flushes trailing telemetry before the agent goes gone', async () => {
  const { server, board, agent } = await boot()
  const res = await server.inject({
    method: 'POST', url: `/api/v1/agents/${agent.id}/leave`,
    payload: { telemetry: [{ event: 'stop', chars: 100 }] },
  })
  expect(res.statusCode).toBe(200)
  const t = (await server.inject({ method: 'GET', url: `/api/v1/boards/${board.id}/telemetry` })).json()
  expect(t.total).toMatchObject({ chars: 100, tokens: 25, count: 1 })
  await server.close()
})

import { describe, expect, it, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const servers: FastifyInstance[] = []
afterEach(async () => { while (servers.length) await servers.pop()!.close() })

const fixture = async () => {
  const db = openDb(':memory:')
  const server = buildServer(db, undefined, { token: 'owner-secret' })
  servers.push(server)
  await server.ready()
  const operator = { host: 'localhost', authorization: 'Bearer owner-secret' }
  const board = (await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', headers: operator, payload: { project_path: '/p' , create: true } })).json()
  const agent = (await server.inject({ method: 'POST', url: '/api/v1/agents/register', headers: operator, payload: { board_id: board.id, name: 'amber-fox' } })).json()
  return { server, db, board, agent, operator }
}

describe('agent rename (#129)', () => {
  it('renames and reflects the new name everywhere the row is read', async () => {
    const { server, db, agent, operator } = await fixture()
    const response = await server.inject({
      method: 'POST', url: `/api/v1/agents/${agent.id}/rename`, headers: operator, payload: { name: 'scout' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, name: 'scout' })
    expect((db.prepare('SELECT name FROM agents WHERE id=?').get(agent.id) as { name: string }).name).toBe('scout')
  })

  it('rejects invalid names and per-board collisions', async () => {
    const { server, board, agent, operator } = await fixture()
    await server.inject({ method: 'POST', url: '/api/v1/agents/register', headers: operator, payload: { board_id: board.id, name: 'jade-lynx' } })
    const upper = await server.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/rename`, headers: operator, payload: { name: 'UPPER' } })
    expect(upper.json()).toEqual({ ok: true, name: 'upper' }) // case-normalized, not rejected
    for (const bad of ['', 'a b', '-lead', 'trail-', 'x'.repeat(33)]) {
      const r = await server.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/rename`, headers: operator, payload: { name: bad } })
      expect(r.statusCode, bad).toBe(400)
    }
    const clash = await server.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/rename`, headers: operator, payload: { name: 'jade-lynx' } })
    expect(clash.statusCode).toBe(409)
  })

  it('lets a renamed session re-register under its stale env name', async () => {
    const { server, db, board, agent, operator } = await fixture()
    db.prepare('UPDATE agents SET external_session_id=?, provider=? WHERE id=?').run('sess-1', 'claude', agent.id)
    await server.inject({ method: 'POST', url: `/api/v1/agents/${agent.id}/rename`, headers: operator, payload: { name: 'scout' } })
    // hooks still carry the old ORCHESTRA_NAME — must resolve to the bound identity, not 409
    const again = await server.inject({
      method: 'POST', url: '/api/v1/agents/register', headers: operator,
      payload: { board_id: board.id, name: 'amber-fox', external_session_id: 'sess-1', provider: 'claude' },
    })
    expect(again.statusCode).toBe(200)
    expect(again.json().name).toBe('scout')
  })
})

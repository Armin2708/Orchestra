import { describe, expect, it, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { listLocalPresenceAgents } from '../src/org-sync/daemon-integration.js'

const servers: FastifyInstance[] = []
afterEach(async () => { while (servers.length) await servers.pop()!.close() })

const fixture = async () => {
  const db = openDb(':memory:')
  const server = buildServer(db, undefined, { token: 'owner-secret' })
  servers.push(server)
  await server.ready()
  const operator = { host: 'localhost', authorization: 'Bearer owner-secret' }
  const board = (await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', headers: operator, payload: { project_path: '/p', create: true } })).json()
  const agent = (await server.inject({ method: 'POST', url: '/api/v1/agents/register', headers: operator, payload: { board_id: board.id, name: 'amber-fox' } })).json()
  return { server, db, board, agent, operator }
}

describe('per-agent cloud sharing (#319)', () => {
  it('is off by default: an unshared agent never reaches presence', async () => {
    const { db } = await fixture()
    expect(listLocalPresenceAgents(db)).toEqual([])
  })

  it('sharing publishes the agent; unsharing withdraws it', async () => {
    const { server, db, agent, operator } = await fixture()
    const on = await server.inject({
      method: 'POST', url: `/api/v1/agents/${agent.id}/org-share`, headers: operator, payload: { shared: true },
    })
    expect(on.statusCode).toBe(200)
    expect(listLocalPresenceAgents(db).map((a) => a.name)).toEqual(['amber-fox'])

    const off = await server.inject({
      method: 'POST', url: `/api/v1/agents/${agent.id}/org-share`, headers: operator, payload: { shared: false },
    })
    expect(off.statusCode).toBe(200)
    expect(listLocalPresenceAgents(db)).toEqual([])
  })

  it('refuses to share another machine\'s projected agent, and validates the body', async () => {
    const { server, db, board, agent, operator } = await fixture()
    db.prepare(`UPDATE agents SET org_sync_remote_origin='org_x' WHERE id=?`).run(agent.id)
    const remote = await server.inject({
      method: 'POST', url: `/api/v1/agents/${agent.id}/org-share`, headers: operator, payload: { shared: true },
    })
    expect(remote.statusCode).toBe(400)

    const local = (await server.inject({ method: 'POST', url: '/api/v1/agents/register', headers: operator, payload: { board_id: board.id, name: 'plain' } })).json()
    const bad = await server.inject({
      method: 'POST', url: `/api/v1/agents/${local.id}/org-share`, headers: operator, payload: {},
    })
    expect(bad.statusCode).toBe(400)
  })
})

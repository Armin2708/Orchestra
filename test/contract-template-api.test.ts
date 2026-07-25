import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { registerAgentOsRoutes } from '../src/agent-os/routes.js'
import { buildServer } from '../src/server.js'

const TOKEN = 'contract-template-api-token'
const auth = { authorization: `Bearer ${TOKEN}` }
const variables = {
  objective: 'Stop duplicate dispatch',
  affected_area: 'the scheduler dispatch loop',
  reproduction: 'Two workers claim the same exclusive job',
}
const servers: FastifyInstance[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

function database() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/template-api', 'template api')",
  ).run().lastInsertRowid)
  const cardId = Number(db.prepare(
    "INSERT INTO cards (board_id, title, description) VALUES (?, 'Template API', 'Initial contract')",
  ).run(boardId).lastInsertRowid)
  return { db, boardId, cardId }
}

describe('task contract template API', () => {
  it('lists, previews, conflict-checks, explicitly applies, and deterministically reapplies templates', async () => {
    const { db, boardId, cardId } = database()
    const server = buildServer(db, undefined, { token: TOKEN })
    servers.push(server)
    await server.ready()

    expect((await server.inject({ method: 'GET', url: '/api/v1/os/contract-templates' })).statusCode).toBe(401)
    const listed = await server.inject({ method: 'GET', url: '/api/v1/os/contract-templates', headers: auth })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().templates.map((template: { id: string }) => template.id)).toEqual([
      'bug-fix',
      'feature',
      'research',
      'review',
      'test',
      'release',
    ])

    const previewed = await server.inject({
      method: 'POST',
      url: '/api/v1/os/contract-templates/bug-fix/preview',
      headers: auth,
      payload: { variables },
    })
    expect(previewed.statusCode).toBe(200)
    expect(previewed.json().preview).toMatchObject({
      template: { id: 'bug-fix', publishes_contract: false },
      variables,
      contract: { objective: variables.objective, verify_commands: ['npm test'] },
    })
    expect((await server.inject({
      method: 'POST',
      url: '/api/v1/os/contract-templates/bug-fix/preview',
      headers: auth,
      payload: { variables: {} },
    })).statusCode).toBe(400)
    expect((await server.inject({
      method: 'POST',
      url: '/api/v1/os/contract-templates/not-a-template/preview',
      headers: auth,
      payload: { variables },
    })).statusCode).toBe(404)

    const rejected = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: { variables, conflict_strategy: 'reject', actor: 'agent:planner' },
    })
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json().error).toMatch(/conflict_strategy=replace/)

    const applied = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: { variables, conflict_strategy: 'replace', actor: 'agent:planner' },
    })
    expect(applied.statusCode).toBe(200)
    expect(applied.json()).toMatchObject({
      template: { id: 'bug-fix', publishes_contract: false },
      conflict_strategy: 'replace',
      changed: true,
      contract: { objective: variables.objective },
      job_market: { card_id: cardId },
    })
    const lifecycleCount = (db.prepare(
      "SELECT COUNT(*) AS count FROM os_events WHERE board_id=? AND card_id=? AND kind='job_market.lifecycle_changed'",
    ).get(boardId, cardId) as { count: number }).count
    expect(lifecycleCount).toBe(0)

    const reapplied = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: { variables },
    })
    expect(reapplied.statusCode).toBe(200)
    expect(reapplied.json()).toMatchObject({ changed: false, replaced_fields: [] })
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM os_events WHERE board_id=? AND card_id=? AND kind='job_market.template_applied'",
    ).get(boardId, cardId) as { count: number }).count).toBe(1)

    expect((await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: { variables, conflict_strategy: 'overwrite' },
    })).statusCode).toBe(400)
  })

  it('keeps replacement behind the existing operator boundary', async () => {
    const { db, cardId } = database()
    const server = Fastify()
    registerAgentOsRoutes(server, { db, isOperator: () => false })
    servers.push(server)
    await server.ready()

    expect((await server.inject({
      method: 'GET',
      url: '/api/v1/os/contract-templates',
    })).statusCode).toBe(200)
    const denied = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      payload: { variables, conflict_strategy: 'replace' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().code).toBe('forbidden')
  })
})

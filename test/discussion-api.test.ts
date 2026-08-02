import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { installDiscussionSchema } from '../src/agent-os/discussion-migration.js'
import { discussionPlugin } from '../src/agent-os/discussion-routes.js'
import { openDb } from '../src/db.js'

const databases: Database.Database[] = []
const servers: FastifyInstance[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  for (const db of databases.splice(0)) db.close()
})

async function fixture() {
  const db = openDb(':memory:')
  installDiscussionSchema(db)
  databases.push(db)
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/discussion-api', 'Discussion API')`).run().lastInsertRowid)
  const server = Fastify()
  server.decorateRequest('orchestraPrincipal', 'authenticated-reviewer')
  await server.register(discussionPlugin, {
    prefix: '/api/v1/os',
    db,
    isOperator: (request: FastifyRequest) => request.headers.authorization === 'Bearer operator',
  })
  await server.ready()
  servers.push(server)
  return { db, boardId, server }
}

describe('Discussion API', () => {
  it('derives mutation authority from authentication and exposes bounded search/detail routes', async () => {
    const { db, boardId, server } = await fixture()
    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/discussions`,
      headers: { 'idempotency-key': 'api:forbidden' },
      payload: { type: 'question', title: 'No auth', body: 'Must fail.' },
    })
    expect(forbidden.statusCode).toBe(403)

    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/discussions`,
      headers: {
        authorization: 'Bearer operator',
        'idempotency-key': 'api:discussion:create',
      },
      payload: {
        type: 'question',
        title: 'Authenticated principal',
        body: 'Request-body actor spoofing must be ignored.',
        tags: ['security'],
        actor: { type: 'service', id: 'attacker' },
      },
    })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json().discussion).toMatchObject({
      created_by_type: 'operator',
      created_by_id: 'authenticated-reviewer',
    })
    const discussionId = created.json().discussion.id as string
    const event = db.prepare(`SELECT actor_type, actor_id, correlation_id, causation_id
      FROM os_discussion_events WHERE discussion_id=?`).get(discussionId)
    expect(event).toEqual({
      actor_type: 'operator',
      actor_id: 'authenticated-reviewer',
      correlation_id: 'api:discussion:create',
      causation_id: null,
    })

    const replay = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/discussions`,
      headers: {
        authorization: 'Bearer operator',
        'idempotency-key': 'api:discussion:create',
      },
      payload: {
        type: 'question', title: 'Authenticated principal',
        body: 'Request-body actor spoofing must be ignored.', tags: ['security'],
      },
    })
    expect(replay.statusCode).toBe(201)
    expect(replay.json()).toEqual(created.json())

    const search = await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/discussions?q=authenticated&limit=10`,
    })
    expect(search.statusCode).toBe(200)
    expect(search.json().discussions).toEqual([
      expect.objectContaining({ id: discussionId }),
    ])
    const invalidCursor = await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/discussions?offset=1000001`,
    })
    expect(invalidCursor.statusCode).toBe(400)
  })
})

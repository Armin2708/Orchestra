import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { organizationPlugin } from '../src/agent-os/organization-routes.js'
import { openDb } from '../src/db.js'

const operatorHeaders = { authorization: 'Bearer operator' }
const servers: FastifyInstance[] = []
const databases: Database.Database[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  for (const db of databases.splice(0)) db.close()
})

async function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/organization-api', 'Organization API')`).run().lastInsertRowid)
  const server = Fastify()
  server.decorateRequest('orchestraPrincipal', 'operator')
  await server.register(organizationPlugin, {
    prefix: '/api/v1/os',
    db,
    isOperator: (request: FastifyRequest) =>
      request.headers.authorization === 'Bearer operator',
  })
  await server.ready()
  servers.push(server)
  return { db, boardId, server }
}

async function createOrganization(server: FastifyInstance, boardId: number) {
  return server.inject({
    method: 'POST',
    url: `/api/v1/os/boards/${boardId}/organizations`,
    headers: { ...operatorHeaders, 'idempotency-key': 'api:organization:create' },
    payload: {
      key: 'orchestra',
      name: 'Orchestra',
      mission: 'Coordinate bounded agent teams.',
      actor: { type: 'attacker', id: 'spoofed' },
    },
  })
}

describe('Organization control-plane API', () => {
  it('creates, safely replays, lists, and exposes the complete control center', async () => {
    const { db, boardId, server } = await fixture()
    const created = await createOrganization(server, boardId)
    expect(created.statusCode).toBe(201)
    expect(created.json().result).toMatchObject({
      board_id: boardId,
      organization_key: 'orchestra',
      name: 'Orchestra',
    })
    const organizationId = created.json().result.id as string

    const replayed = await createOrganization(server, boardId)
    expect(replayed.statusCode).toBe(201)
    expect(replayed.json()).toEqual(created.json())
    const event = db.prepare(`SELECT payload FROM os_events
      WHERE board_id=? AND idempotency_key='api:organization:create'`).get(boardId) as
      { payload: string }
    expect(event.payload).toContain('operator')
    expect(event.payload).not.toContain('spoofed')

    const team = await server.inject({
      method: 'POST',
      url: `/api/v1/os/organizations/${organizationId}/core/team.create`,
      headers: { ...operatorHeaders, 'idempotency-key': 'api:team:create' },
      payload: {
        key: 'product',
        name: 'Product',
        mission: 'Own product outcomes.',
      },
    })
    expect(team.statusCode).toBe(201)
    expect(team.json().result).toMatchObject({ team_key: 'product' })

    const objective = await server.inject({
      method: 'POST',
      url: `/api/v1/os/organizations/${organizationId}/coordination/objective.create`,
      headers: { ...operatorHeaders, 'idempotency-key': 'api:objective:create' },
      payload: {
        key: 'activation',
        version: 1,
        statement: 'Improve successful agent-team deliveries.',
        outcomeDefinition: { metric: 'accepted_delivery_rate', target: 0.9 },
        customerEvidenceRefs: ['research://operator/1'],
        ownerTeamId: team.json().result.id,
      },
    })
    expect(objective.statusCode).toBe(201)
    expect(objective.json().result).toMatchObject({ objective_key: 'activation' })

    const trace = await server.inject({
      method: 'POST',
      url: `/api/v1/os/organizations/${organizationId}/assurance/trace.node.add`,
      headers: { ...operatorHeaders, 'idempotency-key': 'api:trace:add' },
      payload: {
        kind: 'objective',
        externalRef: 'objective://activation/1',
        version: '1',
        sha256: 'a'.repeat(64),
      },
    })
    expect(trace.statusCode).toBe(201)
    expect(trace.json().result).toMatchObject({ node_kind: 'objective' })

    const list = await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/organizations`,
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().organizations).toHaveLength(1)

    const center = await server.inject({
      method: 'GET',
      url: `/api/v1/os/organizations/${organizationId}/control-center`,
    })
    expect(center.statusCode, center.body).toBe(200)
    expect(center.json()).toMatchObject({
      organization: {
        organization: { id: organizationId },
        teams: [{ id: team.json().result.id }],
      },
      coordination: {
        objectives: [{ id: objective.json().result.id }],
      },
      assurance: {
        organization_id: organizationId,
      },
    })
  })

  it('fails closed for mutations and rejects unknown commands', async () => {
    const { boardId, server } = await fixture()
    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/organizations`,
      headers: { 'idempotency-key': 'api:forbidden' },
      payload: { key: 'bad', name: 'Bad', mission: 'Must not be created.' },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json()).toMatchObject({ code: 'forbidden' })

    const created = await createOrganization(server, boardId)
    const organizationId = created.json().result.id as string
    const unknown = await server.inject({
      method: 'POST',
      url: `/api/v1/os/organizations/${organizationId}/core/not-a-command`,
      headers: { ...operatorHeaders, 'idempotency-key': 'api:unknown' },
      payload: {},
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ code: 'not_found' })

    const missingKey = await server.inject({
      method: 'POST',
      url: `/api/v1/os/organizations/${organizationId}/core/team.create`,
      headers: operatorHeaders,
      payload: { key: 'product', name: 'Product', mission: 'Ship.' },
    })
    expect(missingKey.statusCode).toBe(400)
    expect(missingKey.json().error).toMatch(/idempotency key/i)
  })
})

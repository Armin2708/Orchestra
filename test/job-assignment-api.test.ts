import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { JobMarketService } from '../src/agent-os/job-market.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const OPERATOR_TOKEN = 'job-assignment-operator'
const AGENT_TOKEN = 'job-assignment-agent'
const operator = { authorization: `Bearer ${OPERATOR_TOKEN}` }
const agent = { authorization: `Bearer ${AGENT_TOKEN}` }
const servers: FastifyInstance[] = []
const databases: Database.Database[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) db.close()
})

async function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/assignment-api', 'assignment api')",
  ).run().lastInsertRowid)
  const cardId = Number(db.prepare(
    `INSERT INTO cards (board_id, title, description)
      VALUES (?, 'Assignment API', 'Exercise canonical API ownership')`,
  ).run(boardId).lastInsertRowid)
  const profiles = new AgentProfileService(db)
  const first = profiles.create({
    boardId,
    name: 'API first',
    capabilities: ['typescript'],
    actor: { type: 'operator', id: 'fixture' },
    idempotencyKey: 'assignment-api:profile:first',
  })
  const second = profiles.create({
    boardId,
    name: 'API second',
    capabilities: ['typescript'],
    actor: { type: 'operator', id: 'fixture' },
    idempotencyKey: 'assignment-api:profile:second',
  })
  const market = new JobMarketService(db)
  const contract = market.get(cardId)
  const server = buildServer(db, undefined, {
    token: OPERATOR_TOKEN,
    agentToken: AGENT_TOKEN,
  })
  servers.push(server)
  await server.ready()
  return { db, boardId, cardId, first, second, contract, server }
}

describe('canonical Job Market assignment API', () => {
  it('inherits authentication, allows agent reads, and restricts mutation to operators', async () => {
    const { boardId, cardId, first, contract, server } = await fixture()
    expect((await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/assignments`,
    })).statusCode).toBe(401)
    expect((await server.inject({
      method: 'GET',
      url: `/api/v1/os/cards/${cardId}/assignments/current`,
      headers: agent,
    })).json()).toEqual({ assignment: null })

    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/assignments/claim`,
      headers: { ...agent, 'idempotency-key': 'assignment-api:forbidden' },
      payload: {
        profile_id: first.id,
        expected_market_version: contract.market_version,
      },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json()).toMatchObject({ code: 'forbidden' })
  })

  it('claims with a server-derived actor and safely replays header or body idempotency', async () => {
    const { db, boardId, cardId, first, contract, server } = await fixture()
    const request = {
      method: 'POST' as const,
      url: `/api/v1/os/cards/${cardId}/assignments/claim`,
      headers: { ...operator, 'idempotency-key': 'assignment-api:claim' },
      payload: {
        profile_id: first.id,
        expected_market_version: contract.market_version,
        actor: { type: 'attacker', id: 'spoofed' },
        raw_parameters: { secret: 'must-not-persist' },
      },
    }
    const claimed = await server.inject(request)
    expect(claimed.statusCode).toBe(201)
    expect(claimed.json()).toMatchObject({
      replayed: false,
      assignment: {
        card_id: cardId,
        profile_id: first.id,
        status: 'active',
        origin: 'claim',
      },
      market: { status: 'assigned', market_version: contract.market_version + 1 },
    })
    const replayed = await server.inject(request)
    expect(replayed.statusCode).toBe(200)
    expect(replayed.json()).toEqual({ ...claimed.json(), replayed: true })

    const event = db.prepare(`SELECT payload FROM os_events
      WHERE board_id=? AND idempotency_key='assignment-api:claim'`).get(boardId) as
      { payload: string }
    expect(JSON.parse(event.payload)).toMatchObject({
      actor: { type: 'operator', id: 'operator' },
    })
    expect(event.payload).not.toContain('spoofed')
    expect(event.payload).not.toContain('must-not-persist')

    const headerBodyMismatch = await server.inject({
      ...request,
      headers: { ...operator, 'idempotency-key': 'assignment-api:header' },
      payload: {
        profile_id: first.id,
        expected_market_version: contract.market_version,
        idempotency_key: 'assignment-api:body',
      },
    })
    expect(headerBodyMismatch.statusCode).toBe(400)
    expect(headerBodyMismatch.json().error).toMatch(/must match/)
  })

  it('exposes board, current, and history reads and applies release compare-and-set', async () => {
    const { boardId, cardId, first, contract, server } = await fixture()
    const claimed = (await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/assignments/assign`,
      headers: operator,
      payload: {
        profile_id: first.id,
        expected_market_version: contract.market_version,
        idempotency_key: 'assignment-api:assign-body-key',
      },
    })).json()
    expect(claimed.assignment.origin).toBe('assign')

    const current = await server.inject({
      method: 'GET',
      url: `/api/v1/os/cards/${cardId}/assignments/current`,
      headers: agent,
    })
    expect(current.json().assignment.id).toBe(claimed.assignment.id)
    const history = await server.inject({
      method: 'GET',
      url: `/api/v1/os/cards/${cardId}/assignments`,
      headers: agent,
    })
    expect(history.json().assignments).toEqual([claimed.assignment])
    const listed = await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/assignments`
        + `?status=active&profile_id=${encodeURIComponent(first.id)}&card_id=${cardId}`,
      headers: agent,
    })
    expect(listed.json().assignments).toEqual([claimed.assignment])

    const stale = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/assignments/${claimed.assignment.id}/release`,
      headers: operator,
      payload: {
        expected_market_version: claimed.market.market_version - 1,
        expected_assignment_version: claimed.assignment.version,
        idempotency_key: 'assignment-api:stale-release',
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatch(/version is stale/)

    const released = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/assignments/${claimed.assignment.id}/release`,
      headers: { ...operator, 'idempotency-key': 'assignment-api:release' },
      payload: {
        expected_market_version: claimed.market.market_version,
        expected_assignment_version: claimed.assignment.version,
        reason: 'operator returned work',
      },
    })
    expect(released.statusCode).toBe(200)
    expect(released.json()).toMatchObject({
      assignment: {
        id: claimed.assignment.id,
        status: 'released',
        version: 2,
      },
      market: {
        status: 'open',
        market_version: claimed.market.market_version + 1,
      },
    })
  })

  it('reassigns atomically and reports validation, scope, and idempotency conflicts', async () => {
    const { cardId, first, second, contract, server } = await fixture()
    const claimed = (await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/assignments/claim`,
      headers: { ...operator, 'idempotency-key': 'assignment-api:claim-reassign' },
      payload: {
        profile_id: first.id,
        expected_market_version: contract.market_version,
      },
    })).json()

    const reassigned = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/assignments/${claimed.assignment.id}/reassign`,
      headers: operator,
      payload: {
        profile_id: second.id,
        expected_market_version: claimed.market.market_version,
        expected_assignment_version: claimed.assignment.version,
        idempotency_key: 'assignment-api:reassign',
        reason: 'better fit',
      },
    })
    expect(reassigned.statusCode).toBe(201)
    expect(reassigned.json()).toMatchObject({
      assignment: {
        profile_id: second.id,
        status: 'active',
        predecessor_assignment_id: claimed.assignment.id,
      },
      market: {
        status: 'assigned',
        market_version: claimed.market.market_version + 1,
      },
    })

    const reusedKey = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/assignments/${reassigned.json().assignment.id}/release`,
      headers: operator,
      payload: {
        expected_market_version: reassigned.json().market.market_version,
        expected_assignment_version: reassigned.json().assignment.version,
        idempotency_key: 'assignment-api:reassign',
      },
    })
    expect(reusedKey.statusCode).toBe(409)
    expect(reusedKey.json().error).toMatch(/different assignment command/)

    const invalid = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/assignments/${reassigned.json().assignment.id}/release`,
      headers: operator,
      payload: {
        expected_market_version: 0,
        expected_assignment_version: 1,
        idempotency_key: 'assignment-api:invalid',
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().code).toBe('validation_error')
  })
})

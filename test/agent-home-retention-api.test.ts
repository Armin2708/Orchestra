import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const OPERATOR_TOKEN = 'retention-operator'
const AGENT_TOKEN = 'retention-agent'
const operator = { authorization: `Bearer ${OPERATOR_TOKEN}` }
const agent = { authorization: `Bearer ${AGENT_TOKEN}` }
const servers: FastifyInstance[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

describe('Agent Home retention API', () => {
  it('keeps policy and compaction controls operator-only and replay-safe', async () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare(
      "INSERT INTO boards (project_path, name) VALUES ('/retention-api', 'retention api')",
    ).run().lastInsertRowid)
    const server = buildServer(db, undefined, {
      token: OPERATOR_TOKEN,
      agentToken: AGENT_TOKEN,
    })
    servers.push(server)
    await server.ready()

    expect((await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/retention`,
    })).statusCode).toBe(401)
    const agentRead = await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/retention`,
      headers: agent,
    })
    expect(agentRead.statusCode).toBe(403)
    expect(agentRead.json()).toMatchObject({
      code: 'forbidden',
      error: expect.stringMatching(/operator authorization/),
    })
    const defaults = await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/retention`,
      headers: operator,
    })
    expect(defaults.statusCode).toBe(200)
    expect(defaults.json().policy).toMatchObject({
      transcript_days: 90,
      ephemeral_days: 7,
      raw_artifact_days: 30,
      audit_retention: 'forever',
      pinned_retention: 'forever',
    })

    const missingKey = await server.inject({
      method: 'PUT',
      url: `/api/v1/os/boards/${boardId}/retention`,
      headers: operator,
      payload: { transcript_days: 120 },
    })
    expect(missingKey.statusCode).toBe(400)
    expect(missingKey.json().error).toMatch(/Idempotency-Key/)
    const configured = await server.inject({
      method: 'PUT',
      url: `/api/v1/os/boards/${boardId}/retention`,
      headers: { ...operator, 'idempotency-key': 'api:retention:configure' },
      payload: {
        transcript_days: 120,
        ephemeral_days: 14,
        raw_artifact_days: 45,
      },
    })
    const configuredReplay = await server.inject({
      method: 'PUT',
      url: `/api/v1/os/boards/${boardId}/retention`,
      headers: { ...operator, 'idempotency-key': 'api:retention:configure' },
      payload: {
        transcript_days: 120,
        ephemeral_days: 14,
        raw_artifact_days: 45,
      },
    })
    expect(configured.statusCode).toBe(200)
    expect(configured.json()).toMatchObject({
      replayed: false,
      policy: {
        transcript_days: 120,
        ephemeral_days: 14,
        raw_artifact_days: 45,
      },
    })
    expect(configuredReplay.json()).toMatchObject({
      replayed: true,
      policy: configured.json().policy,
    })

    const forbiddenRun = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/retention/run`,
      headers: { ...agent, 'idempotency-key': 'agent:retention:run' },
      payload: { as_of: '2026-07-25T12:00:00.000Z' },
    })
    expect(forbiddenRun.statusCode).toBe(403)
    const run = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/retention/run`,
      headers: { ...operator, 'idempotency-key': 'api:retention:run' },
      payload: { as_of: '2026-07-25T12:00:00.000Z' },
    })
    const runReplay = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/retention/run`,
      headers: { ...operator, 'idempotency-key': 'api:retention:run' },
      payload: { as_of: '2026-07-25T12:00:00.000Z' },
    })
    expect(run.statusCode).toBe(200)
    expect(run.json().run).toMatchObject({
      transcript_events_archived: 0,
      ephemeral_events_archived: 0,
      raw_artifacts_compacted: 0,
      replayed: false,
    })
    expect(runReplay.json().run).toMatchObject({
      id: run.json().run.id,
      replayed: true,
    })
    db.close()
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

    const previewTables = [
      'task_contracts',
      'job_market_contracts',
      'job_market_criteria',
      'job_market_dependencies',
      'os_events',
    ]
    const previewRowCounts = () => previewTables.map((table) =>
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE card_id=?`)
        .get(cardId) as { count: number }).count)
    const beforePreview = previewRowCounts()
    const previewed = await server.inject({
      method: 'POST',
      url: '/api/v1/os/contract-templates/bug-fix/preview',
      headers: auth,
      payload: { card_id: cardId, variables },
    })
    expect(previewed.statusCode).toBe(200)
    expect(previewed.json().preview).toMatchObject({
      template: { id: 'bug-fix', publishes_contract: false },
      variables,
      contract: { objective: variables.objective, verify_commands: ['npm test'] },
      expected_state: {
        card_id: cardId,
        market_version: 1,
        contract_version: 1,
        template_id: 'bug-fix',
        template_version: 1,
      },
    })
    expect(previewRowCounts()).toEqual(beforePreview)
    const expectedState = previewed.json().preview.expected_state
    expect(expectedState.state_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(expectedState.preview_hash).toMatch(/^[a-f0-9]{64}$/)
    expect((await server.inject({
      method: 'POST',
      url: '/api/v1/os/contract-templates/bug-fix/preview',
      headers: auth,
      payload: { card_id: cardId, variables: {} },
    })).statusCode).toBe(400)
    expect((await server.inject({
      method: 'POST',
      url: '/api/v1/os/contract-templates/bug-fix/preview',
      headers: auth,
      payload: { variables },
    })).statusCode).toBe(400)
    expect((await server.inject({
      method: 'POST',
      url: '/api/v1/os/contract-templates/not-a-template/preview',
      headers: auth,
      payload: { card_id: cardId, variables },
    })).statusCode).toBe(404)

    const mismatchedPreview = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: {
        variables: { ...variables, objective: 'A different rendered preview' },
        expected_state: expectedState,
        conflict_strategy: 'replace',
      },
    })
    expect(mismatchedPreview.statusCode).toBe(409)
    expect(mismatchedPreview.json().error).toMatch(/rendered template changed/)
    expect(previewRowCounts()).toEqual(beforePreview)

    const rejected = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: {
        variables,
        expected_state: expectedState,
        conflict_strategy: 'reject',
        actor: 'agent:planner',
      },
    })
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json().error).toMatch(/conflict_strategy=replace/)

    const applyPayload = {
      variables,
      expected_state: expectedState,
      conflict_strategy: 'replace',
      actor: 'agent:planner',
    }
    const applied = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: applyPayload,
    })
    expect(applied.statusCode).toBe(200)
    expect(applied.json()).toMatchObject({
      template: { id: 'bug-fix', publishes_contract: false },
      conflict_strategy: 'replace',
      changed: true,
      contract: { objective: variables.objective },
      job_market: { card_id: cardId },
    })
    const nextExpectedState = applied.json().next_expected_state
    const lifecycleCount = (db.prepare(
      "SELECT COUNT(*) AS count FROM os_events WHERE board_id=? AND card_id=? AND kind='job_market.lifecycle_changed'",
    ).get(boardId, cardId) as { count: number }).count
    expect(lifecycleCount).toBe(0)

    const reapplied = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: applyPayload,
    })
    expect(reapplied.statusCode).toBe(200)
    expect(reapplied.json()).toMatchObject({
      changed: false,
      replaced_fields: [],
      expected_state: expectedState,
      next_expected_state: nextExpectedState,
    })
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM os_events WHERE board_id=? AND card_id=? AND kind='job_market.template_applied'",
    ).get(boardId, cardId) as { count: number }).count).toBe(1)

    const arbitraryStale = await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: {
        ...applyPayload,
        expected_state: { ...expectedState, state_hash: 'f'.repeat(64) },
      },
    })
    expect(arbitraryStale.statusCode).toBe(409)
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM os_events WHERE board_id=? AND card_id=? AND kind='job_market.template_applied'",
    ).get(boardId, cardId) as { count: number }).count).toBe(1)
    expect((await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: { ...applyPayload, actor: 'agent:not-the-original-request' },
    })).statusCode).toBe(409)

    expect((await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: { variables, expected_state: nextExpectedState, conflict_strategy: 'overwrite' },
    })).statusCode).toBe(400)
    expect((await server.inject({
      method: 'POST',
      url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
      headers: auth,
      payload: { variables },
    })).statusCode).toBe(400)
  })

  it('rejects a two-client stale replace atomically without writes or audit events', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentboard-template-cas-'))
    const databaseFile = join(directory, 'shared.sqlite')
    const firstDb = openDb(databaseFile)
    const boardId = Number(firstDb.prepare(
      "INSERT INTO boards (project_path, name) VALUES ('/template-cas', 'template cas')",
    ).run().lastInsertRowid)
    const cardId = Number(firstDb.prepare(
      "INSERT INTO cards (board_id, title, description) VALUES (?, 'Template CAS', 'Initial objective')",
    ).run(boardId).lastInsertRowid)
    const secondDb = openDb(databaseFile)
    const firstClient = buildServer(firstDb, undefined, { token: TOKEN })
    const secondClient = buildServer(secondDb, undefined, { token: TOKEN })

    try {
      await Promise.all([firstClient.ready(), secondClient.ready()])
      const previewed = await firstClient.inject({
        method: 'POST',
        url: '/api/v1/os/contract-templates/bug-fix/preview',
        headers: auth,
        payload: { card_id: cardId, variables },
      })
      expect(previewed.statusCode).toBe(200)
      const staleExpectedState = previewed.json().preview.expected_state
      expect(staleExpectedState).toMatchObject({
        market_version: 1,
        contract_version: 1,
      })

      const concurrentUpdate = await secondClient.inject({
        method: 'PUT',
        url: `/api/v1/os/cards/${cardId}/contract`,
        headers: auth,
        payload: { objective: 'Objective written by the second client' },
      })
      expect(concurrentUpdate.statusCode).toBe(200)
      const concurrentState = concurrentUpdate.json().job_market
      expect(concurrentState).toMatchObject({
        market_version: 2,
        contract: {
          objective: 'Objective written by the second client',
          version: 2,
        },
      })
      const eventCountBeforeStaleApply = (firstDb.prepare(
        'SELECT COUNT(*) AS count FROM os_events WHERE board_id=? AND card_id=?',
      ).get(boardId, cardId) as { count: number }).count

      const staleApply = await firstClient.inject({
        method: 'POST',
        url: `/api/v1/os/cards/${cardId}/contract/templates/bug-fix/apply`,
        headers: auth,
        payload: {
          variables,
          expected_state: staleExpectedState,
          conflict_strategy: 'replace',
          actor: 'agent:stale-client',
        },
      })
      expect(staleApply.statusCode).toBe(409)
      expect(staleApply.json().error).toMatch(/changed since preview/)

      const persisted = await secondClient.inject({
        method: 'GET',
        url: `/api/v1/os/cards/${cardId}/contract`,
        headers: auth,
      })
      expect(persisted.statusCode).toBe(200)
      expect(persisted.json().job_market).toMatchObject(concurrentState)
      expect((firstDb.prepare(
        'SELECT COUNT(*) AS count FROM os_events WHERE board_id=? AND card_id=?',
      ).get(boardId, cardId) as { count: number }).count).toBe(eventCountBeforeStaleApply)
      expect((firstDb.prepare(
        "SELECT COUNT(*) AS count FROM os_events WHERE board_id=? AND card_id=? AND kind='job_market.template_applied'",
      ).get(boardId, cardId) as { count: number }).count).toBe(0)
    } finally {
      await Promise.allSettled([firstClient.close(), secondClient.close()])
      firstDb.close()
      secondDb.close()
      rmSync(directory, { recursive: true, force: true })
    }
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

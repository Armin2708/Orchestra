import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer, type ConductorLike } from '../src/server.js'
import { ensureAgentToken, ensureToken, loadClientToken } from '../src/token.js'

const OPERATOR_TOKEN = 'operator-token'
const AGENT_TOKEN = 'agent-token'
const operator = { authorization: `Bearer ${OPERATOR_TOKEN}` }
const agent = { authorization: `Bearer ${AGENT_TOKEN}` }
const servers: FastifyInstance[] = []

afterEach(async () => {
  delete process.env.ORCHESTRA_AGENT_TOKEN
  delete process.env.ORCHESTRA_MANAGED_AGENT
  delete process.env.ORCHESTRA_HOME
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
})

describe('operator and agent API principals', () => {
  it('prevents an agent credential from launching, hiring, steering, or cancelling work', async () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/operator-auth', 'auth')")
      .run().lastInsertRowid)
    const cardId = Number(db.prepare("INSERT INTO cards (board_id, title) VALUES (?, 'Privileged work')")
      .run(boardId).lastInsertRowid)
    const calls: string[] = []
    const conductor: ConductorLike = {
      isHired: () => true,
      hire: () => { calls.push('hire'); return { id: 1, name: 'privileged-agent' } },
      deliver: () => true,
      task: () => { calls.push('task'); return true },
      transcript: () => ({ lines: [], working: null }),
      subagents: () => [],
      interruptAgent: async () => true,
      fire: async () => true,
      launch: () => { calls.push('launch'); return { queued: false } },
      isLaunched: () => false,
    }
    const server = buildServer(db, () => conductor, { token: OPERATOR_TOKEN, agentToken: AGENT_TOKEN })
    servers.push(server)
    await server.ready()

    const attempts = await Promise.all([
      server.inject({
        method: 'POST', url: `/api/v1/boards/${boardId}/hire`, headers: agent,
        payload: { cwd: '/tmp/escalated', permissionMode: 'bypassPermissions', access_profile: 'full_access' },
      }),
      server.inject({ method: 'POST', url: `/api/v1/cards/${cardId}/launch`, headers: agent }),
      server.inject({
        method: 'POST', url: `/api/v1/os/boards/${boardId}/jobs`, headers: agent,
        payload: { card_id: cardId, provider: 'claude' },
      }),
      server.inject({ method: 'POST', url: '/api/v1/agents/1/task', headers: agent, payload: { text: 'escalate' } }),
      server.inject({ method: 'POST', url: '/api/v1/os/jobs/unknown/cancel', headers: agent }),
    ])

    expect(attempts.map((response) => response.statusCode)).toEqual([403, 403, 403, 403, 403])
    expect(calls).toEqual([])
  })

  it('keeps normal agent reporting open but reserves acceptance and done for the operator', async () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/operator-auth', 'auth')")
      .run().lastInsertRowid)
    const cardId = Number(db.prepare("INSERT INTO cards (board_id, title, description) VALUES (?, 'Scoped delivery', 'Test role gates')")
      .run(boardId).lastInsertRowid)
    const server = buildServer(db, undefined, { token: OPERATOR_TOKEN, agentToken: AGENT_TOKEN })
    servers.push(server)
    await server.ready()

    expect((await server.inject({
      method: 'PUT', url: `/api/v1/os/cards/${cardId}/contract`, headers: operator,
      payload: {
        deliverables: [{ id: 'output', text: 'Create the output', required: true }],
        acceptance_criteria: [{ id: 'tested', text: 'The output is tested', required: true }],
      },
    })).statusCode).toBe(200)
    const launched = await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/jobs`, headers: operator,
      payload: { card_id: cardId, provider: 'test-provider' },
    })
    const { job, delivery } = launched.json()
    const artifact = (await server.inject({
      method: 'POST', url: `/api/v1/os/cards/${cardId}/evidence`, headers: agent,
      payload: { kind: 'test_report', name: 'tests.txt', content: 'pass' },
    })).json().artifact

    expect((await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${job.id}/deliveries/submit`, headers: agent,
      payload: {
        actor: 'worker', summary: 'Output and tests are ready.',
        items: [{ deliverableId: 'output', status: 'delivered' }],
        artifact_ids: [artifact.id],
      },
    })).statusCode).toBe(200)
    expect((await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${delivery.id}/verify`, headers: agent,
      payload: {
        actor: 'worker',
        criteria: [{ criterionId: 'tested', outcome: 'missed', override: { actor: 'worker', reason: 'trust me' } }],
      },
    })).statusCode).toBe(403)
    expect((await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${delivery.id}/verify`, headers: agent,
      payload: {
        actor: 'verifier',
        criteria: [{ criterionId: 'tested', outcome: 'met', evidence: [artifact.id] }],
        deliverable_results: [{ deliverableId: 'output', outcome: 'met', evidence: [artifact.id] }],
      },
    })).statusCode).toBe(200)

    expect((await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${delivery.id}/accept`, headers: agent,
      payload: { actor: 'human' },
    })).statusCode).toBe(403)
    const accepted = await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${delivery.id}/accept`, headers: operator,
      payload: { actor: 'forged-agent-label', note: 'Reviewed.' },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().delivery).toMatchObject({ status: 'accepted', accepted_by: 'human' })

    expect((await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/move`, headers: agent, payload: { column: 'done' },
    })).statusCode).toBe(403)
    expect((await server.inject({
      method: 'POST', url: '/api/v1/cards', headers: agent,
      payload: { board_id: boardId, title: 'Bypass', column: 'done' },
    })).statusCode).toBe(403)
    const moved = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/move`, headers: operator, payload: { column: 'done' },
    })
    expect(moved.statusCode).toBe(200)
    expect(moved.json().card.column).toBe('done')
  })

  it('mints a distinct scoped token and makes agent subprocess clients prefer it', () => {
    process.env.ORCHESTRA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-principals-'))
    const operatorToken = ensureToken()
    const agentToken = ensureAgentToken()
    expect(agentToken).not.toBe(operatorToken)
    process.env.ORCHESTRA_AGENT_TOKEN = agentToken
    expect(loadClientToken()).toBe(agentToken)
    process.env.ORCHESTRA_MANAGED_AGENT = '1'
    delete process.env.ORCHESTRA_AGENT_TOKEN
    expect(loadClientToken()).toBeUndefined()
  })
})

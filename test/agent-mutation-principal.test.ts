import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  requireAgentOwnsDelivery,
  resolveAgentMutationPrincipal,
} from '../src/agent-os/agent-mutation-principal.js'
import { buildServer } from '../src/server.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { JobAssignmentService } from '../src/agent-os/job-assignments.js'
import { JobMarketService } from '../src/agent-os/job-market.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { DeliveryReportService } from '../src/agent-os/delivery-reports.js'

const databases: ReturnType<typeof openDb>[] = []
const servers: FastifyInstance[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  while (databases.length) databases.pop()?.close()
})

function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  const token = 'per-session-secret'
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const boardId = Number(db.prepare(
    `INSERT INTO boards (project_path, name) VALUES ('/identity', 'identity')`,
  ).run().lastInsertRowid)
  const agentId = Number(db.prepare(`INSERT INTO agents
      (board_id, name, session_id, kind, provider, external_session_id,
       hook_token_hash, status)
      VALUES (?, 'Ada', 'provider-session', 'session', 'codex',
        'provider-session', ?, 'active')`)
    .run(boardId, tokenHash).lastInsertRowid)
  db.prepare(`INSERT INTO agent_profiles
      (id, board_id, legacy_agent_id, name, capabilities_json,
       owner_actor_type, owner_actor_id, status, provenance_json, created_at, updated_at)
      VALUES ('profile-ada', ?, ?, 'Ada', '[]', 'operator', 'test',
        'active', '{}', datetime('now'), datetime('now'))`).run(boardId, agentId)
  db.prepare(`INSERT INTO agent_conversations
      (id, board_id, profile_id, title, status, is_default, next_sequence,
       created_by_actor_type, created_by_actor_id, created_at, updated_at)
      VALUES ('conversation-ada', ?, 'profile-ada', 'Ada', 'active', 1, 1,
        'operator', 'test', datetime('now'), datetime('now'))`).run(boardId)
  db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status, created_at, updated_at)
      VALUES ('workspace-ada', ?, 'Ada', 'shared', '/identity', 'active',
        datetime('now'), datetime('now'))`).run(boardId)
  db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, agent_id, provider, external_id, status, profile_id,
       conversation_id, mode)
      VALUES ('session-ada', 'workspace-ada', ?, 'codex', 'provider-session',
        'running', 'profile-ada', 'conversation-ada', 'managed')`).run(agentId)
  return { db, boardId, agentId, token }
}

function request(
  agentId: number,
  token: string,
  patch: Record<string, string> = {},
): FastifyRequest {
  return {
    orchestraPrincipal: 'agent',
    headers: {
      'x-orchestra-agent-id': String(agentId),
      'x-orchestra-provider': 'codex',
      'x-orchestra-session-id': 'provider-session',
      'x-orchestra-session-token': token,
      ...patch,
    },
  } as unknown as FastifyRequest
}

describe('exact agent mutation principal', () => {
  it('resolves a session credential through agent, profile, and canonical session identity', () => {
    const { db, boardId, agentId, token } = fixture()

    expect(resolveAgentMutationPrincipal(db, request(agentId, token))).toEqual({
      agentId,
      boardId,
      profileId: 'profile-ada',
      provider: 'codex',
      providerSessionId: 'provider-session',
      sessionId: 'session-ada',
      jobId: null,
      jobAssignmentId: null,
      assignmentMarketVersion: null,
    })
  })

  it('fails closed for shared-token identity, wrong secrets, and cross-session claims', () => {
    const { db, agentId, token } = fixture()
    expect(resolveAgentMutationPrincipal(db, {
      orchestraPrincipal: 'agent',
      headers: {},
    } as unknown as FastifyRequest)).toBeNull()
    expect(resolveAgentMutationPrincipal(db, request(agentId, 'wrong'))).toBeNull()
    expect(resolveAgentMutationPrincipal(db, request(agentId, token, {
      'x-orchestra-session-id': 'another-session',
    }))).toBeNull()
  })

  it('never resolves an operator request as an agent principal', () => {
    const { db, agentId, token } = fixture()
    const value = request(agentId, token)
    value.orchestraPrincipal = 'operator'
    expect(resolveAgentMutationPrincipal(db, value)).toBeNull()
  })

  it('allows canonical Discussion mutation only with the exact session-bound agent identity', async () => {
    const { db, boardId, agentId, token } = fixture()
    const server = buildServer(db, undefined, {
      token: 'operator-token',
      agentToken: 'shared-agent-token',
    })
    servers.push(server)
    await server.ready()
    const payload = {
      type: 'question',
      title: 'Can this exact session collaborate?',
      body: 'The author must resolve through profile and session provenance.',
    }
    const sharedOnly = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/discussions`,
      headers: {
        authorization: 'Bearer shared-agent-token',
        'idempotency-key': 'agent-auth:shared-only',
      },
      payload,
    })
    expect(sharedOnly.statusCode).toBe(403)

    const exact = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/discussions`,
      headers: {
        authorization: 'Bearer shared-agent-token',
        'idempotency-key': 'agent-auth:exact-session',
        'x-orchestra-agent-id': String(agentId),
        'x-orchestra-provider': 'codex',
        'x-orchestra-session-id': 'provider-session',
        'x-orchestra-session-token': token,
      },
      payload,
    })
    expect(exact.statusCode, exact.body).toBe(201)
    expect(exact.json()).toMatchObject({
      discussion: {
        board_id: boardId,
        created_by_type: 'agent',
        created_by_id: `agent:${agentId}`,
        created_by_profile_id: 'profile-ada',
      },
    })
  })

  it('binds agent Delivery mutation to the same profile, job, and exclusive assignment tuple', () => {
    const db = openDb(':memory:')
    databases.push(db)
    const boardId = Number(db.prepare(
      `INSERT INTO boards (project_path, name) VALUES ('/delivery-owner', 'delivery owner')`,
    ).run().lastInsertRowid)
    const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
      VALUES (?, 'Owned delivery', 'Exact assignment ownership')`).run(boardId).lastInsertRowid)
    const workspaceId = 'delivery-owner-workspace'
    db.prepare(`INSERT INTO workspaces
      (id, board_id, card_id, name, kind, root_path, status)
      VALUES (?, ?, ?, 'owner', 'shared', '/delivery-owner', 'active')`)
      .run(workspaceId, boardId, cardId)
    new TaskContractService(db).put(cardId, {
      objective: 'Prove exact Delivery ownership.',
      deliverables: [{ id: 'proof', text: 'Owned proof', required: true }],
      acceptance_criteria: [{
        id: 'owned',
        text: 'Only the exact assignee mutates evidence',
        required: true,
        deliverable_ids: ['proof'],
      }],
      verify_commands: ['npm test'],
    })
    const profile = new AgentProfileService(db).create({
      boardId,
      name: 'Assigned profile',
      actor: { type: 'operator', id: 'test' },
      idempotencyKey: 'delivery-owner:profile',
    })
    const market = new JobMarketService(db)
    const assignment = new JobAssignmentService(db).claim({
      cardId,
      profileId: profile.id,
      workspaceId,
      expectedMarketVersion: market.get(cardId).market_version,
      actor: { type: 'operator', id: 'test' },
      idempotencyKey: 'delivery-owner:assignment',
    }).assignment
    const jobId = 'delivery-owner-job'
    db.prepare(`INSERT INTO jobs
      (id, board_id, card_id, workspace_id, provider, status,
       job_assignment_id, assigned_profile_id, assignment_market_version)
      VALUES (?, ?, ?, ?, 'codex', 'queued', ?, ?, ?)`).run(
      jobId,
      boardId,
      cardId,
      workspaceId,
      assignment.id,
      assignment.profile_id,
      assignment.assigned_market_version,
    )
    const report = new DeliveryReportService(db).prepareForJob(jobId)
    const principal = {
      agentId: 7,
      boardId,
      profileId: profile.id,
      provider: 'codex',
      providerSessionId: 'provider-owner',
      sessionId: 'session-owner',
      jobId,
      jobAssignmentId: assignment.id,
      assignmentMarketVersion: assignment.assigned_market_version,
    }
    expect(() => requireAgentOwnsDelivery(db, principal, report.id)).not.toThrow()
    expect(() => requireAgentOwnsDelivery(db, {
      ...principal,
      profileId: 'another-profile',
    }, report.id)).toThrow(/does not own/)
  })
})

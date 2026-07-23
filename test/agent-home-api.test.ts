import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const OPERATOR_TOKEN = 'agent-home-operator'
const AGENT_TOKEN = 'agent-home-agent'
const operator = {
  authorization: `Bearer ${OPERATOR_TOKEN}`,
  'idempotency-key': '',
}
const agent = { authorization: `Bearer ${AGENT_TOKEN}` }
const servers: FastifyInstance[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

describe('Agent Home API', () => {
  it('inherits auth, restricts mutations, and exposes durable home reads to agents', async () => {
    const fixture = await apiFixture()
    const { server, boardId } = fixture
    expect((await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/agent-profiles`,
    })).statusCode).toBe(401)

    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/agent-profiles`,
      headers: { ...agent, 'idempotency-key': 'agent-cannot-create' },
      payload: { name: 'Forbidden profile' },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().code).toBe('forbidden')

    const missingKey = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/agent-profiles`,
      headers: { authorization: operator.authorization },
      payload: { name: 'Missing key' },
    })
    expect(missingKey.statusCode).toBe(400)
    expect(missingKey.json().error).toMatch(/Idempotency-Key/)

    const created = await createProfile(server, boardId)
    const profile = created.json().profile
    expect(created.statusCode).toBe(201)
    expect(profile).toMatchObject({
      name: 'API builder',
      default_provider: 'codex',
      default_access_profile: 'workspace_write',
      capabilities: ['code', 'review'],
    })

    const replay = await createProfile(server, boardId)
    expect(replay.statusCode).toBe(201)
    expect(replay.json().profile.id).toBe(profile.id)
    const keyConflict = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/agent-profiles`,
      headers: { ...operator, 'idempotency-key': 'api:profile:create' },
      payload: { name: 'Different profile' },
    })
    expect(keyConflict.statusCode).toBe(409)

    const agentRead = await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/agent-profiles`,
      headers: agent,
    })
    expect(agentRead.statusCode).toBe(200)
    expect(agentRead.json().profiles).toEqual([
      expect.objectContaining({ id: profile.id, name: 'API builder' }),
    ])
    expect((await server.inject({
      method: 'GET',
      url: `/api/v1/os/agent-profiles/${profile.id}`,
      headers: agent,
    })).statusCode).toBe(200)
    expect((await server.inject({
      method: 'GET',
      url: `/api/v1/os/agent-profiles/${profile.id}/home`,
      headers: agent,
    })).json().home).toMatchObject({
      profile: { id: profile.id },
      conversations: [expect.objectContaining({ is_default: true })],
      sessions: [],
      active_session: null,
    })
  })

  it('links sessions, validates scope, and returns exact ordered transcript replay and conflicts', async () => {
    const {
      db,
      server,
      boardId,
      sessionId,
      otherSessionId,
      jobId,
      artifactId,
    } = await apiFixture()
    const profile = (await createProfile(server, boardId)).json().profile
    const conversations = await server.inject({
      method: 'GET',
      url: `/api/v1/os/agent-profiles/${profile.id}/conversations`,
      headers: agent,
    })
    const defaultConversation = conversations.json().conversations[0]

    const thread = await server.inject({
      method: 'POST',
      url: `/api/v1/os/agent-profiles/${profile.id}/conversations`,
      headers: { ...operator, 'idempotency-key': 'api:conversation:create' },
      payload: { title: 'API review thread' },
    })
    expect(thread.statusCode).toBe(201)
    const renamed = await server.inject({
      method: 'PATCH',
      url: `/api/v1/os/conversations/${thread.json().conversation.id}`,
      headers: { ...operator, 'idempotency-key': 'api:conversation:update' },
      payload: { title: 'API review and verification' },
    })
    expect(renamed.json().conversation.title).toBe('API review and verification')

    const crossBoard = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${otherSessionId}/link`,
      headers: { ...operator, 'idempotency-key': 'api:session:cross-board' },
      payload: {
        profile_id: profile.id,
        conversation_id: defaultConversation.id,
        mode: 'managed',
      },
    })
    expect(crossBoard.statusCode).toBe(400)
    expect(crossBoard.json().error).toMatch(/board scope/)

    const linked = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${sessionId}/link`,
      headers: { ...operator, 'idempotency-key': 'api:session:link' },
      payload: {
        profile_id: profile.id,
        conversation_id: defaultConversation.id,
        job_id: jobId,
        mode: 'managed',
        driver_id: 'codex-app-server',
        access_profile: 'workspace_write',
        provider_thread_id: 'api-thread',
        recovery_state: 'attachable',
        recovery: { source: 'api-test' },
        history_state: 'complete',
      },
    })
    expect(linked.statusCode).toBe(200)
    expect(linked.json().session).toMatchObject({
      id: sessionId,
      profile_id: profile.id,
      conversation_id: defaultConversation.id,
      job_id: jobId,
      mode: 'managed',
      recovery: { source: 'api-test' },
    })
    const linkedReplay = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${sessionId}/link`,
      headers: { ...operator, 'idempotency-key': 'api:session:link' },
      payload: {
        profile_id: profile.id,
        conversation_id: defaultConversation.id,
        job_id: jobId,
        mode: 'managed',
        driver_id: 'codex-app-server',
        access_profile: 'workspace_write',
        provider_thread_id: 'api-thread',
        recovery_state: 'attachable',
        recovery: { source: 'api-test' },
        history_state: 'complete',
      },
    })
    expect(linkedReplay.json().session.id).toBe(sessionId)

    const appended = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${sessionId}/events`,
      headers: { ...operator, 'idempotency-key': 'api:event:one' },
      payload: {
        dedupe_key: 'provider-api-event-1',
        kind: 'assistant',
        provider_event_id: 'provider-1',
        provider_thread_id: 'api-thread',
        provider_cursor: 'cursor-1',
        projected_text: 'API answer',
        metadata: { usage: 10 },
        raw_artifact_id: artifactId,
        correlation_id: 'api-turn-1',
      },
    })
    expect(appended.statusCode).toBe(201)
    expect(appended.json()).toMatchObject({
      replayed: false,
      event: {
        sequence: 1,
        projected_text: 'API answer',
        actor_type: 'operator',
      },
    })

    const eventReplay = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${sessionId}/events`,
      headers: { ...operator, 'idempotency-key': 'api:event:one' },
      payload: {
        dedupe_key: 'provider-api-event-1',
        kind: 'assistant',
        provider_event_id: 'provider-1',
        provider_thread_id: 'api-thread',
        provider_cursor: 'cursor-1',
        projected_text: 'API answer',
        metadata: { usage: 10 },
        raw_artifact_id: artifactId,
        correlation_id: 'api-turn-1',
      },
    })
    expect(eventReplay.statusCode).toBe(200)
    expect(eventReplay.json()).toMatchObject({
      replayed: true,
      event: { id: appended.json().event.id, sequence: 1 },
    })

    const conflict = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${sessionId}/events`,
      headers: { ...operator, 'idempotency-key': 'api:event:conflict' },
      payload: {
        dedupe_key: 'provider-api-event-1',
        kind: 'assistant',
        projected_text: 'Mutated API answer',
      },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error).toMatch(/conflict/)
    expect((db.prepare(
      'SELECT received_projected_text FROM conversation_event_conflicts',
    ).get() as any).received_projected_text).toBe('Mutated API answer')

    const readByAgent = await server.inject({
      method: 'GET',
      url: `/api/v1/os/conversations/${defaultConversation.id}/events?after=0&limit=10`,
      headers: agent,
    })
    expect(readByAgent.statusCode).toBe(200)
    expect(readByAgent.json()).toMatchObject({
      next_sequence: 1,
      events: [{
        id: appended.json().event.id,
        sequence: 1,
        projected_text: 'API answer',
      }],
    })
    const sessionRead = await server.inject({
      method: 'GET',
      url: `/api/v1/os/sessions/${sessionId}/events?kind=assistant`,
      headers: agent,
    })
    expect(sessionRead.json().events).toHaveLength(1)
    expect((await server.inject({
      method: 'GET',
      url: `/api/v1/os/agent-profiles/${profile.id}/home`,
      headers: agent,
    })).json().home).toMatchObject({
      active_session: { id: sessionId },
      active_scope: {
        job: { id: jobId },
      },
    })

    const bodyHeaderMismatch = await server.inject({
      method: 'POST',
      url: `/api/v1/os/agent-profiles/${profile.id}/conversations`,
      headers: { ...operator, 'idempotency-key': 'header-key' },
      payload: { title: 'Mismatch', idempotency_key: 'body-key' },
    })
    expect(bodyHeaderMismatch.statusCode).toBe(400)
    expect(bodyHeaderMismatch.json().error).toMatch(/must match/)
  })
})

async function apiFixture(): Promise<{
  db: ReturnType<typeof openDb>
  server: FastifyInstance
  boardId: number
  otherBoardId: number
  sessionId: string
  otherSessionId: string
  jobId: string
  artifactId: string
}> {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/agent-home-api', 'Agent Home API')",
  ).run().lastInsertRowid)
  const otherBoardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/agent-home-api-other', 'Other API')",
  ).run().lastInsertRowid)
  db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES ('api-workspace', ?, 'API workspace', 'shared', '/agent-home-api', 'active')`)
    .run(boardId)
  db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES ('api-workspace-other', ?, 'Other workspace', 'shared', '/agent-home-api-other', 'active')`)
    .run(otherBoardId)
  const sessionId = 'api-agent-session'
  const otherSessionId = 'api-agent-session-other'
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, external_id, status, context_json)
    VALUES (?, 'api-workspace', 'codex', 'api-thread', 'running', '{}')`).run(sessionId)
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, external_id, status, context_json)
    VALUES (?, 'api-workspace-other', 'claude', 'other-thread', 'running', '{}')`)
    .run(otherSessionId)
  const jobId = 'api-job'
  db.prepare(`INSERT INTO jobs
    (id, board_id, workspace_id, provider, status)
    VALUES (?, ?, 'api-workspace', 'codex', 'running')`).run(jobId, boardId)
  const artifactId = 'api-artifact'
  db.prepare(`INSERT INTO artifacts
    (id, board_id, workspace_id, kind, name, mime_type, metadata)
    VALUES (?, ?, 'api-workspace', 'transcript', 'event.json', 'application/json', '{}')`)
    .run(artifactId, boardId)
  const server = buildServer(db, undefined, {
    token: OPERATOR_TOKEN,
    agentToken: AGENT_TOKEN,
  })
  servers.push(server)
  await server.ready()
  return {
    db,
    server,
    boardId,
    otherBoardId,
    sessionId,
    otherSessionId,
    jobId,
    artifactId,
  }
}

function createProfile(server: FastifyInstance, boardId: number) {
  return server.inject({
    method: 'POST',
    url: `/api/v1/os/boards/${boardId}/agent-profiles`,
    headers: { ...operator, 'idempotency-key': 'api:profile:create' },
    payload: {
      name: 'API builder',
      role: 'implementation',
      default_provider: 'codex',
      default_model: 'codex-model',
      default_effort: 'high',
      default_access_profile: 'workspace_write',
      capabilities: ['code', 'review'],
    },
  })
}

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  consumeManagedAgentLaunchBootstrap,
  issueManagedAgentLaunchBootstrap,
  loadManagedAgentSessionCredential,
  managedAgentCredentialHash,
  type ManagedAgentBootstrapRegistration,
} from '../src/agent-session-credential.js'
import { discussionPlugin } from '../src/agent-os/discussion-routes.js'
import type { DiscussionActor } from '../src/agent-os/discussions.js'
import { api } from '../src/client.js'
import { Conductor } from '../src/conductor.js'
import { openDb } from '../src/db.js'
import { _internals as hookInternals, runHook } from '../src/hooks.js'
import { buildServer } from '../src/server.js'
import { runHookToCompletion } from './helpers/scoped-hook-state.js'

const environmentKeys = [
  'ORCHESTRA_HOME',
  'ORCHESTRA_MANAGED_AGENT',
  'ORCHESTRA_AGENT_TOKEN',
  'ORCHESTRA_AGENT_ID',
  'ORCHESTRA_AGENT_HOME_SESSION_ID',
  'ORCHESTRA_BOARD_ID',
  'ORCHESTRA_NAME',
  'ORCHESTRA_PORT',
  'ORCHESTRA_SESSION_BOOTSTRAP',
] as const
const savedEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]))
const homes: string[] = []
const databases: ReturnType<typeof openDb>[] = []
const servers: ReturnType<typeof Fastify>[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  while (databases.length) databases.pop()?.close()
  while (homes.length) fs.rmSync(homes.pop()!, { recursive: true, force: true })
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function inertQuery() {
  return {
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { await new Promise(() => {}) },
  }
}

function dbFixture() {
  const db = openDb(':memory:')
  databases.push(db)
  const projectPath = process.cwd()
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES (?, 'Managed launch auth')`).run(projectPath).lastInsertRowid)
  return { db, boardId, projectPath }
}

function insertHired(
  db: ReturnType<typeof openDb>,
  boardId: number,
  name: string,
  bootstrapHash: string,
): number {
  return Number(db.prepare(`INSERT INTO agents
    (board_id, name, session_id, kind, provider, status, hook_token_hash, last_seen)
    VALUES (?, ?, 'hired:test', 'hired', 'claude', 'active', ?, datetime('now'))`)
    .run(boardId, name, bootstrapHash).lastInsertRowid)
}

function registration(input: Partial<ManagedAgentBootstrapRegistration> & {
  agentId: number
  boardId: number
  agentName: string
  bootstrapNonce: string
}): ManagedAgentBootstrapRegistration {
  return {
    provider: 'claude',
    externalSessionId: 'provider-session',
    ...input,
  }
}

describe('managed launch bootstrap authorization', () => {
  it('mints and rotates a launch-only bootstrap for fresh and resumed hired sessions', () => {
    const { db, boardId, projectPath } = dbFixture()
    ;(query as any).mockImplementation(inertQuery)
    const firstConductor = new Conductor(db, new EventEmitter(), 'shared-agent-token')
    const first = firstConductor.hire({
      boardId,
      cwd: projectPath,
      name: 'managed-claude',
      env: {
        ...process.env,
        ORCHESTRA_AGENT_TOKEN: 'inherited-shared-agent-token',
        ORCHESTRA_TOKEN: 'inherited-operator-token',
      },
    })
    const firstEnvironment = (query as any).mock.calls.at(-1)[0].options.env as
      Record<string, string | undefined>
    const firstNonce = firstEnvironment.ORCHESTRA_SESSION_BOOTSTRAP
    expect(firstNonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(firstEnvironment).toMatchObject({
      ORCHESTRA_MANAGED_AGENT: '1',
      ORCHESTRA_AGENT_ID: String(first.id),
      ORCHESTRA_BOARD_ID: String(boardId),
      ORCHESTRA_NAME: 'managed-claude',
    })
    expect(firstEnvironment.ORCHESTRA_AGENT_TOKEN).toBeUndefined()
    expect(firstEnvironment.ORCHESTRA_TOKEN).toBeUndefined()
    expect(db.prepare(`SELECT external_session_id, hook_token_hash FROM agents WHERE id=?`)
      .get(first.id)).toEqual({
      external_session_id: null,
      hook_token_hash: managedAgentCredentialHash(firstNonce),
    })

    const resumedConductor = new Conductor(db, new EventEmitter(), 'shared-agent-token')
    resumedConductor.hire({
      boardId,
      cwd: projectPath,
      name: 'managed-claude',
      resumeSession: 'provider-session',
    })
    const resumedEnvironment = (query as any).mock.calls.at(-1)[0].options.env as
      Record<string, string | undefined>
    expect(resumedEnvironment.ORCHESTRA_SESSION_BOOTSTRAP).not.toBe(firstNonce)
    expect(db.prepare(`SELECT external_session_id, hook_token_hash FROM agents WHERE id=?`)
      .get(first.id)).toEqual({
      external_session_id: 'provider-session',
      hook_token_hash: managedAgentCredentialHash(
        resumedEnvironment.ORCHESTRA_SESSION_BOOTSTRAP!,
      ),
    })
  })

  it('atomically rejects wrong, cross-agent, and replayed bootstrap nonces', () => {
    const { db, boardId } = dbFixture()
    const firstBootstrap = issueManagedAgentLaunchBootstrap()
    const secondBootstrap = issueManagedAgentLaunchBootstrap()
    const firstId = insertHired(db, boardId, 'first-managed', firstBootstrap.hash)
    const secondId = insertHired(db, boardId, 'second-managed', secondBootstrap.hash)
    expect(consumeManagedAgentLaunchBootstrap(db, registration({
      agentId: firstId,
      boardId,
      agentName: 'first-managed',
      bootstrapNonce: 'wrong-bootstrap',
    }))).toBeNull()
    expect(consumeManagedAgentLaunchBootstrap(db, registration({
      agentId: secondId,
      boardId,
      agentName: 'second-managed',
      bootstrapNonce: firstBootstrap.nonce,
    }))).toBeNull()
    expect(db.prepare(`SELECT external_session_id, hook_token_hash FROM agents WHERE id=?`)
      .get(firstId)).toEqual({
      external_session_id: null,
      hook_token_hash: firstBootstrap.hash,
    })

    const consumed = consumeManagedAgentLaunchBootstrap(db, registration({
      agentId: firstId,
      boardId,
      agentName: 'first-managed',
      bootstrapNonce: firstBootstrap.nonce,
    }))
    expect(consumed?.sessionToken).toEqual(expect.any(String))
    expect(db.prepare(`SELECT external_session_id, hook_token_hash FROM agents WHERE id=?`)
      .get(firstId)).toEqual({
      external_session_id: 'provider-session',
      hook_token_hash: managedAgentCredentialHash(consumed!.sessionToken),
    })
    expect(consumeManagedAgentLaunchBootstrap(db, registration({
      agentId: firstId,
      boardId,
      agentName: 'first-managed',
      bootstrapNonce: firstBootstrap.nonce,
    }))).toBeNull()
  })

  it('admits only the exact one-time bootstrap through anonymous registration', async () => {
    const { db, boardId } = dbFixture()
    const firstBootstrap = issueManagedAgentLaunchBootstrap()
    const secondBootstrap = issueManagedAgentLaunchBootstrap()
    const firstId = insertHired(db, boardId, 'first-route-managed', firstBootstrap.hash)
    const secondId = insertHired(db, boardId, 'second-route-managed', secondBootstrap.hash)
    const server = buildServer(db, undefined, {
      token: 'operator-transport',
      agentToken: 'legacy-shared-agent-transport',
    })
    servers.push(server)
    await server.ready()

    const arbitrary = await server.inject({
      method: 'POST', url: '/api/v1/agents/register',
      payload: { board_id: boardId, name: 'anonymous-claim', session_id: 'anonymous-session' },
    })
    expect(arbitrary.statusCode).toBe(401)

    const crossAgent = await server.inject({
      method: 'POST', url: '/api/v1/agents/register',
      payload: {
        board_id: boardId, name: 'second-route-managed', provider: 'claude',
        session_id: 'provider-session', agent_id: secondId,
        bootstrap_nonce: firstBootstrap.nonce,
      },
    })
    expect(crossAgent.statusCode).toBe(401)

    const registered = await server.inject({
      method: 'POST', url: '/api/v1/agents/register',
      payload: {
        board_id: boardId, name: 'first-route-managed', provider: 'claude',
        session_id: 'provider-session', agent_id: firstId,
        bootstrap_nonce: firstBootstrap.nonce,
      },
    })
    expect(registered.statusCode).toBe(200)
    expect(registered.json()).toMatchObject({
      id: firstId,
      external_session_id: 'provider-session',
      session_token: expect.any(String),
    })
    expect(registered.json()).not.toHaveProperty('hook_token_hash')

    const replay = await server.inject({
      method: 'POST', url: '/api/v1/agents/register',
      payload: {
        board_id: boardId, name: 'first-route-managed', provider: 'claude',
        session_id: 'provider-session', agent_id: firstId,
        bootstrap_nonce: firstBootstrap.nonce,
      },
    })
    expect(replay.statusCode).toBe(401)

    const legacyClaim = await server.inject({
      method: 'POST', url: '/api/v1/agents/register',
      headers: { authorization: 'Bearer legacy-shared-agent-transport' },
      payload: {
        board_id: boardId, name: 'second-route-managed', provider: 'claude',
        session_id: 'claimed-session',
      },
    })
    expect(legacyClaim.statusCode).toBe(409)
  })

  it('rolls back canonical binding when an otherwise matching bootstrap is expired', () => {
    const { db, boardId, projectPath } = dbFixture()
    const bootstrap = issueManagedAgentLaunchBootstrap()
    const agentId = insertHired(db, boardId, 'expired-managed', bootstrap.hash)
    db.prepare(`UPDATE agents SET last_seen=datetime('now', '-11 minutes') WHERE id=?`)
      .run(agentId)
    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status, created_at, updated_at)
      VALUES ('expired-workspace', ?, 'Expired', 'shared', ?, 'active',
        datetime('now'), datetime('now'))`).run(boardId, projectPath)
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, external_id, status, mode)
      VALUES ('expired-home-session', 'expired-workspace', 'claude', NULL,
        'starting', 'managed')`).run()

    expect(consumeManagedAgentLaunchBootstrap(db, registration({
      agentId,
      boardId,
      agentName: 'expired-managed',
      bootstrapNonce: bootstrap.nonce,
      agentHomeSessionId: 'expired-home-session',
    }))).toBeNull()
    expect(db.prepare(`SELECT agent_id, external_id, status FROM agent_sessions WHERE id=?`)
      .get('expired-home-session')).toEqual({
      agent_id: null,
      external_id: null,
      status: 'starting',
    })
    expect(db.prepare(`SELECT external_session_id, hook_token_hash FROM agents WHERE id=?`)
      .get(agentId)).toEqual({
      external_session_id: null,
      hook_token_hash: bootstrap.hash,
    })
  })

  it('launches, registers through hooks, persists exact credentials, and mutates via client',
    async () => {
      const { db, boardId, projectPath } = dbFixture()
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-managed-launch-auth-'))
      homes.push(home)
      db.prepare(`INSERT INTO agent_profiles
        (id, board_id, name, capabilities_json, owner_actor_type, owner_actor_id,
         status, provenance_json, created_at, updated_at)
        VALUES ('managed-profile', ?, 'Managed profile', '[]', 'operator', 'test',
          'active', '{}', datetime('now'), datetime('now'))`).run(boardId)
      db.prepare(`INSERT INTO agent_conversations
        (id, board_id, profile_id, title, status, is_default, next_sequence,
         created_by_actor_type, created_by_actor_id, created_at, updated_at)
        VALUES ('managed-conversation', ?, 'managed-profile', 'Managed', 'active', 1, 1,
          'operator', 'test', datetime('now'), datetime('now'))`).run(boardId)
      db.prepare(`INSERT INTO workspaces
        (id, board_id, name, kind, root_path, status, created_at, updated_at)
        VALUES ('managed-workspace', ?, 'Managed', 'shared', ?, 'active',
          datetime('now'), datetime('now'))`).run(boardId, projectPath)
      db.prepare(`INSERT INTO agent_sessions
        (id, workspace_id, provider, external_id, status, profile_id,
         conversation_id, mode)
        VALUES ('managed-home-session', 'managed-workspace', 'claude', NULL, 'starting',
          'managed-profile', 'managed-conversation', 'managed')`).run()

      ;(query as any).mockImplementation(inertQuery)
      const conductor = new Conductor(db, new EventEmitter(), 'shared-agent-token')
      const launched = conductor.hire({
        boardId,
        cwd: projectPath,
        name: 'managed-claude',
        env: { ...process.env, ORCHESTRA_HOME: home },
        agentHome: {
          agentHomeSessionId: 'managed-home-session',
          agentProfileId: 'managed-profile',
          agentConversationId: 'managed-conversation',
        },
      })
      const launchEnvironment = (query as any).mock.calls.at(-1)[0].options.env as
        Record<string, string | undefined>
      const registrationBodies: Record<string, unknown>[] = []
      let boardResolveCalls = 0
      const app = Fastify()
      servers.push(app)
      app.get('/health', () => ({ ok: true }))
      app.post('/api/v1/boards/resolve', () => {
        boardResolveCalls += 1
        return { id: boardId, project_path: projectPath, name: 'Managed launch auth' }
      })
      app.post<{ Body: Record<string, unknown> }>('/api/v1/agents/register', (request, reply) => {
        registrationBodies.push(request.body)
        const body = request.body
        const result = consumeManagedAgentLaunchBootstrap(db, {
          agentId: Number(body.agent_id),
          boardId: Number(body.board_id),
          agentName: String(body.name),
          provider: String(body.provider),
          externalSessionId: String(body.session_id),
          bootstrapNonce: String(body.bootstrap_nonce),
          agentHomeSessionId: body.agent_home_session_id == null
            ? null : String(body.agent_home_session_id),
        })
        if (!result) return reply.code(401).send({ error: 'invalid managed bootstrap' })
        const row = db.prepare(`SELECT * FROM agents WHERE id=?`).get(result.agentId) as
          Record<string, unknown>
        const { hook_token_hash: _secret, ...agent } = row
        return { ...agent, session_token: result.sessionToken }
      })
      app.get(`/api/v1/boards/${boardId}/snapshot`, () => ({
        board: db.prepare(`SELECT * FROM boards WHERE id=?`).get(boardId),
        agents: db.prepare(`SELECT * FROM agents WHERE board_id=?`).all(boardId),
        cards: [],
        open_questions: [],
      }))
      await app.register(discussionPlugin, {
        prefix: '/api/v1/os',
        db,
        resolveActor: (request) => managedPrincipal(db, request),
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })

      for (const key of environmentKeys) {
        const value = launchEnvironment[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      process.env.ORCHESTRA_HOME = home
      process.env.ORCHESTRA_PORT = String(new URL(address).port)
      delete process.env.ORCHESTRA_AGENT_TOKEN
      vi.spyOn(hookInternals, 'readStdin').mockResolvedValue(JSON.stringify({
        session_id: 'real-provider-session',
        cwd: projectPath,
      }))
      vi.spyOn(console, 'log').mockImplementation(() => {})
      await runHookToCompletion({ runHook }, 'session-start', 'claude')

      expect(boardResolveCalls).toBe(0)
      expect(registrationBodies).toEqual([expect.objectContaining({
        agent_id: launched.id,
        board_id: boardId,
        name: 'managed-claude',
        provider: 'claude',
        session_id: 'real-provider-session',
        agent_home_session_id: 'managed-home-session',
        bootstrap_nonce: launchEnvironment.ORCHESTRA_SESSION_BOOTSTRAP,
      })])
      expect(db.prepare(`SELECT agent_id, external_id, status FROM agent_sessions WHERE id=?`)
        .get('managed-home-session')).toEqual({
        agent_id: launched.id,
        external_id: 'real-provider-session',
        status: 'running',
      })
      const credential = loadManagedAgentSessionCredential(projectPath)
      expect(credential).toMatchObject({
        agentId: launched.id,
        provider: 'claude',
        sessionId: 'real-provider-session',
      })
      const credentialPath = path.join(home, 'sessions', 'real-provider-session.json')
      expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600)

      const created = await api('POST', `/os/boards/${boardId}/discussions`, {
        type: 'question',
        title: 'Can a launched agent collaborate without a shared bearer?',
        body: 'The shared client uses only the exact persisted provider-session credential.',
        idempotency_key: 'managed-launch-auth:discussion:create',
      })
      expect(created.discussion).toMatchObject({
        board_id: boardId,
        created_by_type: 'agent',
        created_by_id: `agent:${launched.id}`,
        created_by_profile_id: 'managed-profile',
      })
    })
})

function managedPrincipal(
  db: ReturnType<typeof openDb>,
  request: FastifyRequest,
): DiscussionActor | null {
  const agentId = Number(request.headers['x-orchestra-agent-id'])
  const provider = String(request.headers['x-orchestra-provider'] ?? '')
  const externalSessionId = String(request.headers['x-orchestra-session-id'] ?? '')
  const sessionToken = String(request.headers['x-orchestra-session-token'] ?? '')
  if (!Number.isSafeInteger(agentId) || agentId <= 0 || !sessionToken) return null
  const row = db.prepare(`SELECT agent.hook_token_hash, session.id AS canonical_session_id,
      session.profile_id
    FROM agents agent JOIN agent_sessions session ON session.agent_id=agent.id
      AND session.provider=agent.provider AND session.external_id=agent.external_session_id
    WHERE agent.id=? AND agent.kind='hired' AND agent.provider=?
      AND agent.external_session_id=? AND agent.status='active'
      AND session.status='running'`).get(agentId, provider, externalSessionId) as {
        hook_token_hash: string
        canonical_session_id: string
        profile_id: string
      } | undefined
  if (!row || row.hook_token_hash !== managedAgentCredentialHash(sessionToken)) return null
  return {
    type: 'agent',
    id: `agent:${agentId}`,
    profileId: row.profile_id,
    provider,
    sessionId: row.canonical_session_id,
  }
}

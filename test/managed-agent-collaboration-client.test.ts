import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  issueManagedAgentLaunchBootstrap,
  loadManagedAgentSessionCredential,
} from '../src/agent-session-credential.js'
import { api } from '../src/client.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const temporary: string[] = []
const servers: FastifyInstance[] = []
const databases: ReturnType<typeof openDb>[] = []
const savedEnvironment = new Map<string, string | undefined>()
for (const key of [
  'ORCHESTRA_HOME',
  'ORCHESTRA_MANAGED_AGENT',
  'ORCHESTRA_AGENT_TOKEN',
  'ORCHESTRA_AGENT_ID',
  'ORCHESTRA_NAME',
  'ORCHESTRA_PORT',
]) savedEnvironment.set(key, process.env[key])

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  while (databases.length) databases.pop()?.close()
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true })
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function home(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'orchestra-agent-credential-'))
  temporary.push(directory)
  process.env.ORCHESTRA_HOME = directory
  process.env.ORCHESTRA_MANAGED_AGENT = '1'
  return directory
}

function saveCredential(directory: string, value: Record<string, unknown>, suffix = 'session'): void {
  const target = path.join(directory, 'sessions', 'codex')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, `${suffix}.json`), JSON.stringify(value), { mode: 0o600 })
}

describe('managed collaboration client identity', () => {
  it('fails closed when cwd-only credentials are ambiguous', () => {
    const directory = home()
    delete process.env.ORCHESTRA_NAME
    const cwd = process.cwd()
    saveCredential(directory, {
      agent_id: 1,
      agent_name: 'first',
      provider: 'codex',
      session_id: 'first-session',
      session_token: 'first-secret',
      cwd,
    }, 'first')
    saveCredential(directory, {
      agent_id: 2,
      agent_name: 'second',
      provider: 'codex',
      session_id: 'second-session',
      session_token: 'second-secret',
      cwd,
    }, 'second')

    expect(loadManagedAgentSessionCredential(cwd)).toBeNull()
  })

  it('registers a real hired hook session and automatically authenticates Discussion mutation',
    async () => {
      const directory = home()
      const db = openDb(':memory:')
      databases.push(db)
      const bootstrap = issueManagedAgentLaunchBootstrap()
      const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
        VALUES (?, 'Managed collaboration')`).run(process.cwd()).lastInsertRowid)
      const agentId = Number(db.prepare(`INSERT INTO agents
        (board_id, name, session_id, kind, provider, external_session_id, status,
         hook_token_hash)
        VALUES (?, 'managed-codex', 'agent-os:job', 'hired', 'codex',
          NULL, 'active', ?)`).run(boardId, bootstrap.hash).lastInsertRowid)
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
          datetime('now'), datetime('now'))`).run(boardId, process.cwd())
      db.prepare(`INSERT INTO agent_sessions
        (id, workspace_id, agent_id, provider, external_id, status, profile_id,
         conversation_id, mode)
        VALUES ('managed-session', 'managed-workspace', ?, 'codex', 'provider-session',
          'running', 'managed-profile', 'managed-conversation', 'managed')`).run(agentId)

      const server = buildServer(db, undefined, {
        token: 'operator-secret',
        agentToken: 'shared-agent-secret',
      })
      servers.push(server)
      const address = await server.listen({ host: '127.0.0.1', port: 0 })
      process.env.ORCHESTRA_PORT = String(new URL(address).port)
      process.env.ORCHESTRA_AGENT_TOKEN = 'shared-agent-secret'
      process.env.ORCHESTRA_NAME = 'managed-codex'

      const registered = await server.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        payload: {
          board_id: boardId,
          name: 'managed-codex',
          provider: 'codex',
          session_id: 'provider-session',
          agent_id: agentId,
          agent_home_session_id: 'managed-session',
          bootstrap_nonce: bootstrap.nonce,
        },
      })
      expect(registered.statusCode, registered.body).toBe(200)
      const sessionToken = registered.json().session_token as string
      expect(sessionToken).toEqual(expect.any(String))
      expect(db.prepare('SELECT kind, hook_token_hash FROM agents WHERE id=?').get(agentId))
        .toMatchObject({ kind: 'hired', hook_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
      saveCredential(directory, {
        agent_id: agentId,
        agent_name: 'managed-codex',
        board_id: boardId,
        provider: 'codex',
        session_id: 'provider-session',
        session_token: sessionToken,
        cwd: process.cwd(),
      })

      const created = await api('POST', `/os/boards/${boardId}/discussions`, {
        type: 'question',
        title: 'Can the launched managed agent collaborate?',
        body: 'The shared client must attach the exact signed provider-session identity.',
        idempotency_key: 'managed-client:discussion:create',
      })
      expect(created.discussion).toMatchObject({
        board_id: boardId,
        created_by_type: 'agent',
        created_by_id: `agent:${agentId}`,
        created_by_profile_id: 'managed-profile',
      })
    })
})

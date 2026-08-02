import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  ToolCapabilityRegistry,
  buildDeclaredProviderCapabilityMatrix,
  type ToolCapability,
} from '../src/tool-capabilities.js'
import { sessionToolPlugin } from '../src/agent-os/session-tool-routes.js'

const servers: ReturnType<typeof Fastify>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const tool: ToolCapability = {
  schema_version: 1,
  id: 'native:test-tool',
  name: 'Test tool',
  kind: 'native',
  provider_id: 'codex',
  session_id: null,
  status: 'ready',
  managed_support: 'supported',
  direct_terminal_available: false,
  capabilities: ['test'],
  permission: { requested: 'approval_required', effective: 'allow', source: 'provider' },
  provenance: {
    evidence: 'observed', observed_at: '2026-08-02T10:00:00.000Z',
    executable: null, package: null, provider_native_id: 'test-tool',
  },
  error: null,
}

async function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/route-tools', 'route tools')`).run().lastInsertRowid)
  db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
    VALUES ('route-workspace', ?, 'route', 'shared', '/route-tools', 'active')`).run(boardId)
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, status, mode, access_profile)
    VALUES ('route-session', 'route-workspace', 'codex', 'running', 'managed', 'workspace_write')`).run()
  const server = Fastify()
  servers.push(server)
  server.register(sessionToolPlugin, {
    db,
    registry: new ToolCapabilityRegistry([tool]),
    providerMatrix: buildDeclaredProviderCapabilityMatrix(),
    isOperator: (request) => request.headers['x-operator'] === '1',
    prefix: '/api/v1/os',
  })
  await server.ready()
  return { server, db }
}

describe('session tool routes', () => {
  it('exposes effective controls, enforces operator policy mutation, and routes approval', async () => {
    const { server, db } = await fixture()
    const matrix = await server.inject({ method: 'GET', url: '/api/v1/os/provider-tool-capabilities' })
    expect(matrix.statusCode).toBe(200)
    expect(matrix.json().providers).toHaveLength(4)

    const read = await server.inject({ method: 'GET', url: '/api/v1/os/sessions/route-session/tools' })
    expect(read.statusCode).toBe(200)
    expect(read.json().tools).toMatchObject({
      direct_terminal_is_source_of_truth: true,
      policy: { revision: 0, default_decision: 'approval_required' },
    })

    const forbidden = await server.inject({
      method: 'PUT',
      url: '/api/v1/os/sessions/route-session/tools/policy',
      payload: {
        default_decision: 'allow', expected_revision: 0, idempotency_key: 'route-policy-forbidden',
      },
    })
    expect(forbidden.statusCode).toBe(403)

    const policy = await server.inject({
      method: 'PUT',
      url: '/api/v1/os/sessions/route-session/tools/policy',
      headers: { 'x-operator': '1', 'idempotency-key': 'x' },
      payload: { default_decision: 'approval_required', expected_revision: 0 },
    })
    expect(policy.statusCode).toBe(200)
    expect(policy.json().policy.revision).toBe(1)

    const approval = await server.inject({
      method: 'POST',
      url: '/api/v1/os/sessions/route-session/tools/authorize',
      headers: { 'idempotency-key': 'route-authorize-1' },
      payload: { tool_id: 'native:test-tool', request_id: 'route-approval-1', actor_id: 'agent-1' },
    })
    expect(approval.statusCode).toBe(200)
    expect(approval.json().authorization).toMatchObject({
      decision: 'approval_required', approval_request_id: 'route-approval-1',
      attention: { kind: 'tool.approval.request' },
    })

    const provenance = await server.inject({
      method: 'POST',
      url: '/api/v1/os/sessions/route-session/tools/invocations',
      headers: { 'idempotency-key': 'route-invocation-1' },
      payload: {
        tool_id: 'native:test-tool', status: 'failed', actor_id: 'agent-1',
        arguments: { token: 'ROUTE-SECRET' }, error_code: 'provider_failed',
      },
    })
    expect(provenance.statusCode).toBe(201)
    expect(provenance.json().invocation).toMatchObject({
      input_state: 'withheld', output_state: 'withheld', error_code: 'provider_failed',
    })
    expect(JSON.stringify(db.prepare(`SELECT payload FROM os_events
      WHERE kind='session.tool_invocation.recorded'`).all())).not.toContain('ROUTE-SECRET')
    db.close()
  })
})

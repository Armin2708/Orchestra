import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer, type ConductorLike } from '../src/server.js'
import type { AgentOsRuntimeAdapter } from '../src/agent-os/routes.js'
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
      interruptAgent: async () => { calls.push('interrupt'); return true },
      fire: async () => { calls.push('fire'); return true },
      launch: () => { calls.push('launch'); return { queued: false } },
      isLaunched: () => false,
      setPermissionMode: async () => { calls.push('permission-mode'); return true },
      resolvePermission: async () => { calls.push('permission'); return true },
      resolveApproval: async () => { calls.push('approval'); return true },
      setAccessProfile: async () => { calls.push('access-profile'); return true },
      setModel: async () => { calls.push('model'); return true },
      setEffort: async () => { calls.push('effort'); return 'ok' },
      mcpStatus: async () => [],
      toggleMcpServer: async () => { calls.push('mcp-toggle'); return [] },
      reconnectMcpServer: async () => { calls.push('mcp-reconnect'); return [] },
      reloadPlugins: async () => { calls.push('plugin-reload'); return { plugins: [] } },
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
      server.inject({ method: 'POST', url: '/api/v1/agents/1/interrupt', headers: agent }),
      server.inject({ method: 'POST', url: '/api/v1/agents/1/fire', headers: agent }),
      server.inject({
        method: 'POST', url: '/api/v1/agents/1/permission-mode', headers: agent, payload: { mode: 'plan' },
      }),
      server.inject({
        method: 'POST', url: '/api/v1/agents/1/access-profile', headers: agent, payload: { profile: 'read_only' },
      }),
      server.inject({
        method: 'POST', url: '/api/v1/agents/1/permissions/request-1', headers: agent, payload: { behavior: 'allow' },
      }),
      server.inject({
        method: 'POST', url: '/api/v1/agents/1/approvals/request-2', headers: agent, payload: { decision: 'allow' },
      }),
      server.inject({ method: 'POST', url: '/api/v1/agents/1/model', headers: agent, payload: { model: 'test-model' } }),
      server.inject({ method: 'POST', url: '/api/v1/agents/1/effort', headers: agent, payload: { level: 'high' } }),
      server.inject({
        method: 'POST', url: '/api/v1/agents/1/mcp/github/toggle', headers: agent, payload: { enabled: false },
      }),
      server.inject({ method: 'POST', url: '/api/v1/agents/1/mcp/github/reconnect', headers: agent }),
      server.inject({ method: 'POST', url: '/api/v1/agents/1/plugins/reload', headers: agent }),
    ])

    expect(attempts.map((response) => response.statusCode)).toEqual(new Array(attempts.length).fill(403))
    expect(calls).toEqual([])
  })

  it('allows the operator to use live Agent Home controls while agent credentials remain read-only', async () => {
    const db = openDb(':memory:')
    const calls: string[] = []
    const conductor: ConductorLike = {
      isHired: () => true,
      hire: () => ({ id: 1 }),
      deliver: () => true,
      task: () => true,
      transcript: () => ({
        lines: [{ kind: 'status', text: 'ready' }],
        working: null,
        permissions: [{
          id: 'approval-secret',
          native: { command: 'LIVE_APPROVAL_SECRET_MUST_NOT_CROSS_AGENT_BOUNDARY' },
        }],
      }),
      subagents: () => [],
      interruptAgent: async () => { calls.push('interrupt'); return true },
      fire: async () => { calls.push('fire'); return true },
      launch: () => ({}),
      isLaunched: () => false,
      setPermissionMode: async () => { calls.push('permission-mode'); return true },
      setAccessProfile: async () => { calls.push('access-profile'); return true },
      setModel: async () => { calls.push('model'); return true },
      setEffort: async () => { calls.push('effort'); return 'ok' },
      resolvePermission: async () => { calls.push('permission'); return true },
      resolveApproval: async () => { calls.push('approval'); return true },
      mcpStatus: async () => [{ name: 'github', status: 'connected', tools: [] }],
      toggleMcpServer: async () => { calls.push('mcp-toggle'); return [] },
      reconnectMcpServer: async () => { calls.push('mcp-reconnect'); return [] },
      reloadPlugins: async () => { calls.push('plugin-reload'); return { plugins: [] } },
    }
    const server = buildServer(db, () => conductor, { token: OPERATOR_TOKEN, agentToken: AGENT_TOKEN })
    servers.push(server)
    await server.ready()

    const controls = await Promise.all([
      server.inject({ method: 'POST', url: '/api/v1/agents/1/interrupt', headers: operator }),
      server.inject({ method: 'POST', url: '/api/v1/agents/1/fire', headers: operator }),
      server.inject({
        method: 'POST', url: '/api/v1/agents/1/permission-mode', headers: operator, payload: { mode: 'plan' },
      }),
      server.inject({
        method: 'POST', url: '/api/v1/agents/1/access-profile', headers: operator, payload: { profile: 'read_only' },
      }),
      server.inject({
        method: 'POST', url: '/api/v1/agents/1/permissions/request-1', headers: operator, payload: { behavior: 'allow' },
      }),
      server.inject({
        method: 'POST', url: '/api/v1/agents/1/approvals/request-2', headers: operator, payload: { decision: 'allow' },
      }),
      server.inject({ method: 'POST', url: '/api/v1/agents/1/model', headers: operator, payload: { model: 'test-model' } }),
      server.inject({ method: 'POST', url: '/api/v1/agents/1/effort', headers: operator, payload: { level: 'high' } }),
      server.inject({
        method: 'POST', url: '/api/v1/agents/1/mcp/github/toggle', headers: operator, payload: { enabled: false },
      }),
      server.inject({ method: 'POST', url: '/api/v1/agents/1/mcp/github/reconnect', headers: operator }),
      server.inject({ method: 'POST', url: '/api/v1/agents/1/plugins/reload', headers: operator }),
    ])

    expect(controls.map((response) => response.statusCode)).toEqual(new Array(controls.length).fill(200))
    expect([...calls].sort()).toEqual([
      'interrupt',
      'fire',
      'permission-mode',
      'access-profile',
      'permission',
      'approval',
      'model',
      'effort',
      'mcp-toggle',
      'mcp-reconnect',
      'plugin-reload',
    ].sort())
    const agentTranscript = await server.inject({
      method: 'GET', url: '/api/v1/agents/1/transcript', headers: agent,
    })
    const operatorTranscript = await server.inject({
      method: 'GET', url: '/api/v1/agents/1/transcript', headers: operator,
    })
    const agentEvents = await server.inject({
      method: 'GET', url: '/api/v1/events', headers: agent,
    })
    const agentBoardEvents = await server.inject({
      method: 'GET', url: '/api/v1/boards/1/events', headers: agent,
    })
    const mcpStatus = await server.inject({ method: 'GET', url: '/api/v1/agents/1/mcp', headers: agent })
    expect(agentTranscript.statusCode).toBe(403)
    expect(agentTranscript.body).not.toContain('LIVE_APPROVAL_SECRET_MUST_NOT_CROSS_AGENT_BOUNDARY')
    expect(operatorTranscript.statusCode).toBe(200)
    expect(operatorTranscript.body).toContain('LIVE_APPROVAL_SECRET_MUST_NOT_CROSS_AGENT_BOUNDARY')
    expect(agentEvents.statusCode).toBe(403)
    expect(agentBoardEvents.statusCode).toBe(403)
    expect(mcpStatus.statusCode).toBe(200)
  })

  it('keeps PTY state readable while reserving every process mutation for the operator', async () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/operator-pty', 'pty')")
      .run().lastInsertRowid)
    const workspaceId = 'operator-pty-workspace'
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES (?, ?, 'operator pty', 'shared', '/operator-pty', 'active')`).run(workspaceId, boardId)
    db.prepare(`INSERT INTO processes (
      id, workspace_id, name, command, cwd, status, restartable, cols, rows
    ) VALUES ('operator-pty-process', ?, 'shell', 'zsh', '/operator-pty', 'running', 1, 80, 24)`)
      .run(workspaceId)
    db.prepare(`INSERT INTO process_output (process_id, seq, stream, data)
      VALUES ('operator-pty-process', 1, 'pty', 'ready')`).run()

    const calls: string[] = []
    const processRecord = {
      id: 'operator-pty-process',
      workspace_id: workspaceId,
      name: 'shell',
      command: 'zsh',
      cwd: '/operator-pty',
      status: 'running',
      pid: 123,
      exit_code: null,
      cols: 80,
      rows: 24,
      restartable: true,
      started_at: '2026-07-23T00:00:00Z',
      ended_at: null,
    }
    const runtime: AgentOsRuntimeAdapter = {
      spawnProcess: async () => { calls.push('spawn'); return processRecord },
      restartProcess: async () => { calls.push('restart'); return processRecord },
      writeProcessInput: async () => { calls.push('input') },
      resizeProcess: async () => { calls.push('resize') },
      signalProcess: async () => { calls.push('signal') },
    }
    const server = buildServer(db, undefined, {
      token: OPERATOR_TOKEN,
      agentToken: AGENT_TOKEN,
      agentOs: { runtime },
    })
    servers.push(server)
    await server.ready()

    const readable = await Promise.all([
      server.inject({
        method: 'GET',
        url: `/api/v1/os/workspaces/${workspaceId}/processes`,
        headers: agent,
      }),
      server.inject({
        method: 'GET',
        url: '/api/v1/os/processes/operator-pty-process',
        headers: agent,
      }),
      server.inject({
        method: 'GET',
        url: '/api/v1/os/processes/operator-pty-process/output',
        headers: agent,
      }),
    ])
    expect(readable.map((response) => response.statusCode)).toEqual([200, 200, 200])

    const attempts = await Promise.all([
      server.inject({
        method: 'POST',
        url: `/api/v1/os/workspaces/${workspaceId}/processes`,
        headers: agent,
        payload: { interactive: true },
      }),
      server.inject({
        method: 'POST',
        url: '/api/v1/os/processes/operator-pty-process/restart',
        headers: agent,
      }),
      server.inject({
        method: 'POST',
        url: '/api/v1/os/processes/operator-pty-process/input',
        headers: agent,
        payload: { data: 'rm -rf .' },
      }),
      server.inject({
        method: 'POST',
        url: '/api/v1/os/processes/operator-pty-process/resize',
        headers: agent,
        payload: { cols: 120, rows: 40 },
      }),
      server.inject({
        method: 'POST',
        url: '/api/v1/os/processes/operator-pty-process/signal',
        headers: agent,
        payload: { signal: 'SIGTERM' },
      }),
    ])
    expect(attempts.map((response) => response.statusCode)).toEqual([403, 403, 403, 403, 403])
    expect(calls).toEqual([])

    const missingResourceAttempts = await Promise.all([
      server.inject({
        method: 'POST',
        url: '/api/v1/os/workspaces/missing-workspace/processes',
        headers: agent,
        payload: { interactive: true },
      }),
      server.inject({
        method: 'POST',
        url: '/api/v1/os/processes/missing-process/restart',
        headers: agent,
      }),
      server.inject({
        method: 'POST',
        url: '/api/v1/os/processes/missing-process/input',
        headers: agent,
        payload: { data: 'whoami\r' },
      }),
      server.inject({
        method: 'POST',
        url: '/api/v1/os/processes/missing-process/resize',
        headers: agent,
        payload: { cols: 120, rows: 40 },
      }),
      server.inject({
        method: 'POST',
        url: '/api/v1/os/processes/missing-process/signal',
        headers: agent,
        payload: { signal: 'SIGTERM' },
      }),
    ])
    expect(missingResourceAttempts.map((response) => response.statusCode))
      .toEqual([403, 403, 403, 403, 403])
    expect(calls).toEqual([])

    const noRuntimeServer = buildServer(db, undefined, {
      token: OPERATOR_TOKEN,
      agentToken: AGENT_TOKEN,
    })
    servers.push(noRuntimeServer)
    await noRuntimeServer.ready()
    const unavailableRuntimeAttempts = await Promise.all([
      noRuntimeServer.inject({
        method: 'POST',
        url: `/api/v1/os/workspaces/${workspaceId}/processes`,
        headers: agent,
        payload: { interactive: true },
      }),
      noRuntimeServer.inject({
        method: 'POST',
        url: '/api/v1/os/processes/operator-pty-process/restart',
        headers: agent,
      }),
      noRuntimeServer.inject({
        method: 'POST',
        url: '/api/v1/os/processes/operator-pty-process/input',
        headers: agent,
        payload: { data: 'whoami\r' },
      }),
      noRuntimeServer.inject({
        method: 'POST',
        url: '/api/v1/os/processes/operator-pty-process/resize',
        headers: agent,
        payload: { cols: 120, rows: 40 },
      }),
      noRuntimeServer.inject({
        method: 'POST',
        url: '/api/v1/os/processes/operator-pty-process/signal',
        headers: agent,
        payload: { signal: 'SIGTERM' },
      }),
    ])
    expect(unavailableRuntimeAttempts.map((response) => response.statusCode))
      .toEqual([403, 403, 403, 403, 403])

    const operatorInput = await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/operator-pty-process/input',
      headers: operator,
      payload: { data: 'pwd\r' },
    })
    expect(operatorInput.statusCode).toBe(200)
    expect(calls).toEqual(['input'])
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

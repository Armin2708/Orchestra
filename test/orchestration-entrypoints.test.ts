import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer, type ConductorLike } from '../src/server.js'

const ambientIdentity = {
  lifecycle: 'ambient',
  contract_attached: false,
  job_id: null,
  job_assignment_id: null,
  assigned_profile_id: null,
  assignment_market_version: null,
  workspace_id: null,
  session_id: null,
}

const servers: ReturnType<typeof buildServer>[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
})

describe('orchestration compatibility entrypoints', () => {
  it('projects canonical task identity from the relational session job before mutable context', async () => {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/repo', 'repo')").run()
    db.prepare(`INSERT INTO workspaces (
      id, board_id, name, kind, root_path, status
    ) VALUES ('relational-workspace', 1, 'relational', 'shared', '/repo', 'active')`).run()
    db.prepare(`INSERT INTO jobs (
      id, board_id, workspace_id, provider, driver_id, status
    ) VALUES
      ('relational-job', 1, 'relational-workspace', 'claude', 'claude', 'running'),
      ('forged-context-job', 1, 'relational-workspace', 'claude', 'claude', 'queued')`).run()
    const agentId = Number(db.prepare(`INSERT INTO agents (
      board_id, name, session_id, kind, provider, status
    ) VALUES (
      1, 'relational-agent', 'agent-os:forged-context-job', 'hired', 'claude', 'active'
    )`).run().lastInsertRowid)
    db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, agent_id, provider, external_id, status, context_json, job_id
    ) VALUES (
      'relational-session', 'relational-workspace', ?, 'claude', 'thread-relational',
      'running', json_object('job_id', 'forged-context-job'), 'relational-job'
    )`).run(agentId)
    const conductor: ConductorLike = {
      isHired: () => true,
      hire: () => ({}),
      deliver: () => true,
      task: () => true,
      transcript: () => ({ lines: [], working: null }),
      subagents: () => [],
      interruptAgent: async () => true,
      fire: async () => true,
      launch: () => ({ queued: false }),
      isLaunched: () => false,
    }
    const server = buildServer(db, () => conductor)
    servers.push(server)
    await server.ready()

    const forged = await server.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/task`,
      payload: { text: 'must not project the forged context job' },
    })
    expect(forged.json()).toMatchObject({
      mode: 'ambient',
      orchestration: { lifecycle: 'ambient', job_id: null, session_id: null },
    })

    db.prepare(`UPDATE agents SET session_id='agent-os:relational-job' WHERE id=?`)
      .run(agentId)
    const relational = await server.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/task`,
      payload: { text: 'project the relational session job' },
    })
    expect(relational.json()).toMatchObject({
      mode: 'canonical',
      orchestration: {
        lifecycle: 'canonical',
        job_id: 'relational-job',
        workspace_id: 'relational-workspace',
        session_id: 'relational-session',
      },
    })
  })

  it('uses durable launch evidence instead of card ownership to classify direct task steering', async () => {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/repo', 'repo')").run()
    const agentId = Number(db.prepare(`INSERT INTO agents (board_id, name, kind, provider, status)
      VALUES (1, 'ambient-owl', 'hired', 'claude', 'active')`).run().lastInsertRowid)
    const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, owner_agent_id, column_name)
      VALUES (1, 'Manually assigned', ?, 'in_progress')`).run(agentId).lastInsertRowid)
    const conductor: ConductorLike = {
      isHired: () => true,
      hire: () => ({}),
      deliver: () => true,
      task: () => true,
      transcript: () => ({ lines: [], working: null }),
      subagents: () => [],
      interruptAgent: async () => true,
      fire: async () => true,
      launch: () => ({ queued: false }),
      isLaunched: () => false,
    }
    const server = buildServer(db, () => conductor)
    servers.push(server)
    await server.ready()

    const ambient = await server.inject({
      method: 'POST', url: `/api/v1/agents/${agentId}/task`, payload: { text: 'continue manually assigned work' },
    })
    expect(ambient.json()).toMatchObject({ mode: 'ambient', orchestration: { lifecycle: 'ambient' } })

    db.prepare("INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, 'launched', '{}')")
      .run(cardId, agentId)
    const legacy = await server.inject({
      method: 'POST', url: `/api/v1/agents/${agentId}/task`, payload: { text: 'continue legacy launch' },
    })
    expect(legacy.json()).toMatchObject({ mode: 'legacy', orchestration: { lifecycle: 'legacy' } })
  })

  it('authenticates direct hire/task while identifying them as ambient, not canonical work', async () => {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/repo', 'repo')").run()
    const task = vi.fn(() => true)
    const conductor: ConductorLike = {
      isHired: () => true,
      hire: ({ boardId, name, provider }) => {
        const id = Number(db.prepare(`INSERT INTO agents (board_id, name, kind, provider, status)
          VALUES (?, ?, 'hired', ?, 'active')`).run(boardId, name ?? 'ambient-owl', provider ?? 'claude').lastInsertRowid)
        return db.prepare('SELECT * FROM agents WHERE id=?').get(id)
      },
      deliver: () => true,
      task,
      transcript: () => ({ lines: [], working: null }),
      subagents: () => [],
      interruptAgent: async () => true,
      fire: async () => true,
      launch: () => ({ queued: false }),
      isLaunched: () => false,
    }
    const server = buildServer(db, () => conductor, { token: 'operator-token', agentToken: 'agent-token' })
    servers.push(server)
    await server.ready()

    const unauthorized = await server.inject({
      method: 'POST',
      url: '/api/v1/boards/1/hire',
      payload: { name: 'ambient-owl' },
    })
    expect(unauthorized.statusCode).toBe(401)

    const hire = await server.inject({
      method: 'POST',
      url: '/api/v1/boards/1/hire',
      headers: { authorization: 'Bearer operator-token' },
      payload: { name: 'ambient-owl', provider: 'codex' },
    })
    expect(hire.statusCode).toBe(200)
    expect(hire.json()).toMatchObject({
      id: expect.any(Number),
      name: 'ambient-owl',
      provider: 'codex',
      mode: 'ambient',
      orchestration: ambientIdentity,
    })

    const tasked = await server.inject({
      method: 'POST',
      url: `/api/v1/agents/${hire.json().id}/task`,
      headers: { authorization: 'Bearer operator-token' },
      payload: { text: 'inspect the repository' },
    })
    expect(tasked.statusCode).toBe(200)
    expect(tasked.json()).toEqual({ ok: true, mode: 'ambient', orchestration: ambientIdentity })
    expect(task).toHaveBeenCalledWith(hire.json().id, 'inspect the repository')
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_contracts').get()).toEqual({ count: 0 })
  })
})

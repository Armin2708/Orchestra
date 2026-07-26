import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { AgentOsRuntimeAdapter, registerAgentOsRoutes } from '../src/agent-os/routes.js'

const TOKEN = 'agent-os-test-token'
const auth = { authorization: `Bearer ${TOKEN}` }
const servers: FastifyInstance[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

async function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/repo-api', 'api')").run().lastInsertRowid)
  const otherBoardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/other-api', 'other')").run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description, paths)
    VALUES (?, 'API card', 'Exercise OS routes', '["src/**"]')`).run(boardId).lastInsertRowid)
  const otherCardId = Number(db.prepare("INSERT INTO cards (board_id, title) VALUES (?, 'Other')").run(otherBoardId).lastInsertRowid)
  const server = buildServer(db, undefined, { token: TOKEN })
  servers.push(server)
  await server.ready()
  return { db, boardId, otherBoardId, cardId, otherCardId, server }
}

describe('Agent OS API', () => {
  it('inherits API auth and exposes drivers and plugins', async () => {
    const { server } = await fixture()
    expect((await server.inject({ method: 'GET', url: '/api/v1/os/drivers' })).statusCode).toBe(401)
    expect((await server.inject({ method: 'GET', url: '/api/v1/os/providers' })).statusCode).toBe(401)
    const drivers = await server.inject({ method: 'GET', url: '/api/v1/os/drivers', headers: auth })
    expect(drivers.statusCode).toBe(200)
    expect(drivers.json().drivers.map((driver: any) => driver.id)).toEqual(['claude', 'codex', 'shell'])
    expect(drivers.json().drivers.find((driver: any) => driver.id === 'codex')).toMatchObject({ available: false })
    const providers = await server.inject({ method: 'GET', url: '/api/v1/os/providers', headers: auth })
    expect(providers.statusCode).toBe(200)
    expect(providers.json().providers).toEqual([
      expect.objectContaining({ id: 'claude', name: 'Claude', available: false, models: [] }),
      expect.objectContaining({ id: 'codex', name: 'Codex', available: false, models: [] }),
    ])
    expect((await server.inject({ method: 'GET', url: '/api/v1/os/plugins', headers: auth })).json().plugins[0].id)
      .toBe('agent-os-core')
  })

  it('persists validated worker and specialist agent defaults', async () => {
    const { server } = await fixture()
    const initial = await server.inject({ method: 'GET', url: '/api/v1/os/settings/agent-defaults', headers: auth })
    expect(initial.statusCode).toBe(200)
    expect(initial.json()).toMatchObject({
      defaults: {
        worker: { provider: 'claude', model: null, effort: null },
        specialist: { provider: 'claude', model: null, effort: null },
      },
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    })

    const saved = await server.inject({
      method: 'PUT', url: '/api/v1/os/settings/agent-defaults', headers: auth,
      payload: {
        worker: { provider: 'claude', model: '  worker-model  ', effort: 'medium' },
        specialist: { provider: 'claude', model: 'specialist-model', effort: 'xhigh' },
      },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().defaults).toEqual({
      worker: { provider: 'claude', model: 'worker-model', effort: 'medium' },
      specialist: { provider: 'claude', model: 'specialist-model', effort: 'xhigh' },
    })
    expect((await server.inject({ method: 'GET', url: '/api/v1/os/settings/agent-defaults', headers: auth })).json().defaults)
      .toEqual(saved.json().defaults)

    const invalid = await server.inject({
      method: 'PUT', url: '/api/v1/os/settings/agent-defaults', headers: auth,
      payload: {
        worker: { model: null, effort: 'not valid!' },
        specialist: { model: null, effort: null },
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toMatch(/worker effort/)
  })

  it('covers workspace, process, context, contract, evidence, policy, checkpoint, job, conflict, and attention routes', async () => {
    const { db, boardId, otherBoardId, cardId, otherCardId, server } = await fixture()
    const invalid = await server.inject({ method: 'POST', url: `/api/v1/os/boards/${boardId}/workspaces`, headers: auth,
      payload: { name: '', card_id: cardId } })
    expect(invalid.statusCode).toBe(400)

    const createdResponse = await server.inject({ method: 'POST', url: `/api/v1/os/boards/${boardId}/workspaces`, headers: auth,
      payload: { name: 'primary', card_id: cardId } })
    expect(createdResponse.statusCode).toBe(201)
    const workspace = createdResponse.json().workspace
    expect(workspace).toMatchObject({ root_path: '/repo-api', status: 'active', card_id: cardId })
    const second = (await server.inject({ method: 'POST', url: `/api/v1/os/boards/${boardId}/workspaces`, headers: auth,
      payload: { name: 'overlap', root_path: '/repo-api' } })).json().workspace
    expect(second.id).not.toBe(workspace.id)
    expect((await server.inject({ method: 'GET', url: `/api/v1/os/boards/${otherBoardId}/workspaces`, headers: auth })).json().workspaces)
      .toEqual([])
    expect((await server.inject({ method: 'GET', url: `/api/v1/os/boards/${boardId}/conflicts`, headers: auth })).json().conflicts)
      .toEqual([expect.objectContaining({ kind: 'execution_root' })])
    expect((await server.inject({ method: 'PATCH', url: `/api/v1/os/workspaces/${workspace.id}`, headers: auth,
      payload: { card_id: otherCardId } })).statusCode).toBe(400)
    expect((await server.inject({ method: 'PATCH', url: `/api/v1/os/workspaces/${second.id}`, headers: auth,
      payload: { card_id: cardId } })).json().workspace.card_id).toBe(cardId)

    expect((await server.inject({ method: 'POST', url: `/api/v1/os/workspaces/${workspace.id}/processes`, headers: auth,
      payload: { command: 'npm test' } })).statusCode).toBe(501)
    db.prepare(`INSERT INTO processes (id, workspace_id, name, command, cwd, status, exit_code, started_at, ended_at)
      VALUES ('proc-1', ?, 'tests', 'npm test', '/repo-api', 'exited', 0, '2026-07-19T12:00:00Z', '2026-07-19T12:01:00Z')`).run(workspace.id)
    db.prepare("INSERT INTO process_output (process_id, seq, stream, data) VALUES ('proc-1', 1, 'stdout', 'one')").run()
    db.prepare("INSERT INTO process_output (process_id, seq, stream, data) VALUES ('proc-1', 2, 'stdout', 'two')").run()
    expect((await server.inject({ method: 'GET', url: `/api/v1/os/workspaces/${workspace.id}/processes`, headers: auth })).json().processes)
      .toHaveLength(1)
    expect((await server.inject({ method: 'GET', url: '/api/v1/os/processes/proc-1', headers: auth })).json().process)
      .toMatchObject({ id: 'proc-1', status: 'exited' })
    expect((await server.inject({ method: 'GET', url: '/api/v1/os/processes/proc-1/output?after=1', headers: auth })).json())
      .toMatchObject({ next_seq: 2, output: [{ seq: 2, data: 'two' }] })

    const contextPut = await server.inject({ method: 'PUT', url: `/api/v1/os/workspaces/${workspace.id}/context`, headers: auth,
      payload: { items: [{ kind: 'file', source: 'README.md', content: 'context', pinned: true, tokens: 12 }] } })
    expect(contextPut.statusCode).toBe(200)
    expect(contextPut.json().context[0]).toMatchObject({ source: 'README.md', pinned: true })

    expect((await server.inject({ method: 'GET', url: `/api/v1/os/cards/${cardId}/contract`, headers: auth })).json().contract.objective)
      .toBe('Exercise OS routes')
    const isolated = await server.inject({ method: 'PUT', url: `/api/v1/os/cards/${cardId}/contract`, headers: auth,
      payload: { dependencies: [otherCardId] } })
    expect(isolated.statusCode).toBe(400)
    const contract = await server.inject({ method: 'PUT', url: `/api/v1/os/cards/${cardId}/contract`, headers: auth,
      payload: { workspace_id: workspace.id, verify_commands: ['npm test'], acceptance_criteria: ['green'] } })
    expect(contract.statusCode).toBe(200)

    const attached = await server.inject({ method: 'POST', url: `/api/v1/os/cards/${cardId}/evidence`, headers: auth,
      payload: { workspace_id: workspace.id, kind: 'diff', name: 'api.diff', content: 'diff --git a/src/api.ts b/src/api.ts',
        mime_type: 'text/x-diff', metadata: { changed_files: ['src/api.ts'] } } })
    expect(attached.statusCode).toBe(201)
    expect(attached.json().artifact.kind).toBe('diff')
    const generated = await server.inject({ method: 'POST', url: `/api/v1/os/cards/${cardId}/evidence`, headers: auth })
    expect(generated.statusCode).toBe(201)
    expect(generated.json().artifact.kind).toBe('evidence_bundle')
    expect((await server.inject({ method: 'GET', url: `/api/v1/os/cards/${cardId}/evidence`, headers: auth })).json().evidence.changed_files)
      .toEqual(['src/api.ts'])

    const policy = (await server.inject({ method: 'POST', url: `/api/v1/os/boards/${boardId}/policies`, headers: auth,
      payload: { name: 'API policy', file_globs: ['src/**'], command_globs: ['npm test'] } })).json().policy
    const evaluation = await server.inject({ method: 'POST', url: `/api/v1/os/policies/${policy.id}/evaluate`, headers: auth,
      payload: { kind: 'secret', value: 'DATABASE_URL' } })
    expect(evaluation.json().evaluation.decision).toBe('ask')
    expect((await server.inject({ method: 'GET', url: `/api/v1/os/boards/${boardId}/policies`, headers: auth })).json().policies)
      .toHaveLength(1)

    const checkpoint = await server.inject({ method: 'POST', url: `/api/v1/os/workspaces/${workspace.id}/checkpoints`, headers: auth,
      payload: { name: 'API checkpoint', git_head: 'deadbeef', process_recipes: [{ command: 'npm test' }] } })
    expect(checkpoint.statusCode).toBe(201)
    expect((await server.inject({ method: 'GET', url: `/api/v1/os/workspaces/${workspace.id}/checkpoints`, headers: auth })).json().checkpoints)
      .toHaveLength(1)
    expect((await server.inject({ method: 'POST', url: `/api/v1/os/checkpoints/${checkpoint.json().checkpoint.id}/fork`, headers: auth,
      payload: { name: 'fork' } })).statusCode).toBe(501)

    const jobResponse = await server.inject({ method: 'POST', url: `/api/v1/os/boards/${boardId}/jobs`, headers: auth,
      payload: { card_id: cardId, workspace_id: workspace.id, provider: 'future-provider', priority: 3 } })
    expect(jobResponse.statusCode).toBe(201)
    expect(jobResponse.json().job).toMatchObject({ status: 'queued' })
    expect(jobResponse.json().job.error).toMatch(/unavailable/)
    expect((await server.inject({ method: 'GET', url: `/api/v1/os/boards/${boardId}/jobs`, headers: auth })).json().jobs)
      .toHaveLength(1)

    server.bus.emit('event', { board_id: boardId, type: 'review', data: {
      card_id: cardId, card_title: 'API card', status: 'awaiting_approval', summary: 'ready',
    } })
    const durable = (await server.inject({ method: 'GET', url: `/api/v1/os/boards/${boardId}/events`, headers: auth })).json().events
    expect(durable.some((event: any) => event.kind === 'legacy.review')).toBe(true)
    const attention = (await server.inject({ method: 'GET', url: `/api/v1/os/boards/${boardId}/attention`, headers: auth })).json().attention
    expect(attention.map((item: any) => item.kind)).toEqual(expect.arrayContaining(['policy.approval', 'job.unsupported_provider', 'review.request']))
    const resolved = await server.inject({ method: 'POST', url: `/api/v1/os/attention/${attention[0].id}/resolve`, headers: auth,
      payload: { resolution: 'approved by operator' } })
    expect(resolved.json().attention.status).toBe('resolved')
    const afterResolution = (await server.inject({ method: 'GET', url: `/api/v1/os/boards/${boardId}/events`, headers: auth })).json().events
    expect(afterResolution.some((event: any) => event.kind === 'attention.resolved' && event.payload.resolution === 'approved by operator')).toBe(true)

    expect((await server.inject({ method: 'PATCH', url: `/api/v1/os/workspaces/${workspace.id}`, headers: auth,
      payload: { status: 'ready' } })).statusCode).toBe(400)
    expect((await server.inject({ method: 'PATCH', url: `/api/v1/os/workspaces/${workspace.id}`, headers: auth,
      payload: { branch: 'unsafe-rewrite' } })).statusCode).toBe(400)
    expect((await server.inject({ method: 'DELETE', url: `/api/v1/os/workspaces/${workspace.id}`, headers: auth })).json().workspace.status)
      .toBe('archived')
    expect((await server.inject({ method: 'GET', url: `/api/v1/os/boards/${boardId}/workspaces?status=archived`, headers: auth })).json().workspaces)
      .toEqual([expect.objectContaining({ id: workspace.id, status: 'archived' })])
  })

  it('passes terminal input bytes through without trimming control or whitespace input', async () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/pty', 'pty')").run().lastInsertRowid)
    const workspaceId = 'pty-workspace'
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES (?, ?, 'pty', 'shared', '/pty', 'active')`).run(workspaceId, boardId)
    db.prepare(`INSERT INTO processes (id, workspace_id, name, command, cwd, status)
      VALUES ('pty-process', ?, 'shell', 'zsh', '/pty', 'running')`).run(workspaceId)
    const written: string[] = []
    const runtime: AgentOsRuntimeAdapter = {
      spawnProcess: async () => { throw new Error('not used') },
      writeProcessInput: async (_id, data) => { written.push(data) },
      resizeProcess: async () => {}, signalProcess: async () => {},
    }
    const server = Fastify()
    server.decorate('bus', new EventEmitter())
    registerAgentOsRoutes(server, { db, runtime })
    servers.push(server)
    await server.ready()
    const inputs = ['', '\r', '\n', '   ', '\u001b[A', 'a\u0000b']
    for (const data of inputs) {
      const response = await server.inject({ method: 'POST', url: '/api/v1/os/processes/pty-process/input', payload: { data } })
      expect(response.statusCode).toBe(200)
    }
    expect(written).toEqual(inputs)
  })

  it('does not forward resize requests for a completed PTY to the runtime', async () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/resize', 'resize')").run().lastInsertRowid)
    const workspaceId = 'resize-workspace'
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES (?, ?, 'resize', 'shared', '/resize', 'active')`).run(workspaceId, boardId)
    db.prepare(`INSERT INTO processes (id, workspace_id, name, command, cwd, status, cols, rows)
      VALUES ('completed-process', ?, 'done', 'pwd', '/resize', 'exited', 100, 30)`).run(workspaceId)
    const resizes: Array<{ id: string; cols: number; rows: number }> = []
    const runtime: AgentOsRuntimeAdapter = {
      spawnProcess: async () => { throw new Error('not used') },
      writeProcessInput: async () => {},
      resizeProcess: async (id, cols, rows) => { resizes.push({ id, cols, rows }) },
      signalProcess: async () => {},
    }
    const server = Fastify()
    server.decorate('bus', new EventEmitter())
    registerAgentOsRoutes(server, { db, runtime })
    servers.push(server)
    await server.ready()

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/completed-process/resize',
      payload: { cols: 160, rows: 50 },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ok: true, skipped: true, status: 'exited', cols: 100, rows: 30,
    })
    expect(resizes).toEqual([])
  })

  it('only suppresses a resize failure when the durable PTY concurrently becomes terminal', async () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/resize-race', 'resize race')")
      .run().lastInsertRowid)
    const workspaceId = 'resize-race-workspace'
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES (?, ?, 'resize race', 'shared', '/resize-race', 'active')`).run(workspaceId, boardId)
    const insert = db.prepare(`INSERT INTO processes (
      id, workspace_id, name, command, cwd, status, pid, cols, rows
    ) VALUES (?, ?, 'shell', 'zsh', '/resize-race', 'running', 123, 100, 30)`)
    insert.run('concurrent-exit', workspaceId)
    insert.run('active-failure', workspaceId)
    const runtime: AgentOsRuntimeAdapter = {
      spawnProcess: async () => { throw new Error('not used') },
      writeProcessInput: async () => {},
      resizeProcess: async (id) => {
        if (id === 'concurrent-exit') {
          db.prepare(`UPDATE processes
            SET status='exited', pid=NULL, exit_code=0, cols=101, rows=31, ended_at='2026-07-25T22:00:00Z'
            WHERE id=?`).run(id)
          throw new Error('process concurrently exited before resize')
        }
        throw new Error('active PTY resize failed')
      },
      signalProcess: async () => {},
    }
    const server = Fastify()
    server.decorate('bus', new EventEmitter())
    registerAgentOsRoutes(server, { db, runtime })
    servers.push(server)
    await server.ready()

    const raced = await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/concurrent-exit/resize',
      payload: { cols: 160, rows: 50 },
    })
    expect(raced.statusCode).toBe(200)
    expect(raced.json()).toEqual({
      ok: true, skipped: true, status: 'exited', cols: 101, rows: 31,
    })

    const activeFailure = await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/active-failure/resize',
      payload: { cols: 160, rows: 50 },
    })
    expect(activeFailure.statusCode).toBe(500)
    expect(activeFailure.json().message).toBe('active PTY resize failed')
    expect(db.prepare('SELECT status, cols, rows FROM processes WHERE id=?').get('active-failure'))
      .toEqual({ status: 'running', cols: 100, rows: 30 })
  })

  it('launches an interactive shell without requiring a client-selected command', async () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/shell', 'shell')").run().lastInsertRowid)
    const workspaceId = 'shell-workspace'
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES (?, ?, 'shell', 'shared', '/shell', 'active')`).run(workspaceId, boardId)
    let launch: Parameters<AgentOsRuntimeAdapter['spawnProcess']>[0] | null = null
    const runtime: AgentOsRuntimeAdapter = {
      spawnProcess: async (input) => {
        launch = input
        return {
          id: 'interactive-shell', workspace_id: workspaceId, name: input.name, command: '/bin/zsh -l',
          cwd: input.cwd, status: 'running', pid: 123, exit_code: null, cols: input.cols, rows: input.rows,
          restartable: input.restartable, started_at: '2026-07-19T12:00:00Z', ended_at: null,
        }
      },
      writeProcessInput: async () => {}, resizeProcess: async () => {}, signalProcess: async () => {},
    }
    const server = Fastify()
    server.decorate('bus', new EventEmitter())
    registerAgentOsRoutes(server, { db, runtime })
    servers.push(server)
    await server.ready()

    const response = await server.inject({
      method: 'POST', url: `/api/v1/os/workspaces/${workspaceId}/processes`,
      payload: { interactive: true, restartable: true },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().process).toMatchObject({ name: 'shell', command: '/bin/zsh -l', status: 'running' })
    expect(launch).toMatchObject({ interactive: true, name: 'shell', cwd: '/shell', restartable: true })
    expect(launch).not.toHaveProperty('command')
    const event = db.prepare("SELECT payload FROM os_events WHERE process_id='interactive-shell' AND kind='process.spawned'").get() as { payload: string }
    expect(JSON.parse(event.payload)).toMatchObject({ command: '/bin/zsh -l', name: 'shell', interactive: true })
  })
})

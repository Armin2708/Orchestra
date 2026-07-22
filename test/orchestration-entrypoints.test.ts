import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer, type ConductorLike } from '../src/server.js'

const ambientIdentity = {
  lifecycle: 'ambient',
  contract_attached: false,
  job_id: null,
  workspace_id: null,
  session_id: null,
}

const servers: ReturnType<typeof buildServer>[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
})

describe('orchestration compatibility entrypoints', () => {
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

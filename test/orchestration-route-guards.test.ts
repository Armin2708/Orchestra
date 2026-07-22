import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { JobScheduler, type JobExecutor } from '../src/agent-os/scheduler.js'
import { openDb } from '../src/db.js'
import { buildServer, type ConductorLike } from '../src/server.js'

const servers: FastifyInstance[] = []

afterEach(async () => {
  delete process.env.ORCHESTRA_CANONICAL_LAUNCH
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
})

const conductor = (): ConductorLike => ({
  isHired: () => false,
  hire: () => ({}),
  deliver: () => true,
  task: () => true,
  transcript: () => ({ lines: [], working: null }),
  subagents: () => [],
  interruptAgent: async () => true,
  fire: async () => true,
  launch: () => ({ agent: {} }),
  isLaunched: () => false,
})

async function routeFixture(supportedProviders: string[], exposeExecutor: boolean) {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/repo', 'repo')")
    .run().lastInsertRowid)
  const cardId = Number(db.prepare("INSERT INTO cards (board_id, title) VALUES (?, 'guarded launch')")
    .run(boardId).lastInsertRowid)
  const executor: JobExecutor = {
    supportedProviders: () => supportedProviders,
    execute: async () => ({ status: 'running' }),
  }
  const scheduler = new JobScheduler(db, executor)
  const orchestration = new OrchestrationService(db, scheduler)
  const server = buildServer(db, () => conductor(), {
    agentOs: {
      scheduler,
      orchestration,
      ...(exposeExecutor ? { jobExecutor: executor } : {}),
    },
  })
  servers.push(server)
  await server.ready()
  return { db, cardId, server }
}

function expectNoCanonicalWrites(db: ReturnType<typeof openDb>): void {
  expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })
  expect(db.prepare('SELECT COUNT(*) AS count FROM task_contracts').get()).toEqual({ count: 0 })
}

describe('canonical route configuration guards', () => {
  it('rejects shell Board launches even when the executor advertises shell', async () => {
    const { db, cardId, server } = await routeFixture(['shell'], true)
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/cards/${cardId}/launch`,
      payload: { provider: 'shell' },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ provider: 'shell', error: expect.stringContaining('unavailable') })
    expectNoCanonicalWrites(db)
  })

  it('fails closed with 501 when canonical Board launch has no executor wiring', async () => {
    const { db, cardId, server } = await routeFixture(['claude'], false)
    process.env.ORCHESTRA_CANONICAL_LAUNCH = '1'

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/cards/${cardId}/launch`,
      payload: { provider: 'claude' },
    })

    expect(response.statusCode).toBe(501)
    expect(response.json()).toMatchObject({ code: 'not_supported', error: expect.stringContaining('job executor') })
    expectNoCanonicalWrites(db)
  })

  it('rejects an injected orchestration service without its matching scheduler', async () => {
    const db = openDb(':memory:')
    const scheduler = new JobScheduler(db)
    const server = buildServer(db, undefined, {
      agentOs: { orchestration: new OrchestrationService(db, scheduler) },
    })
    servers.push(server)

    await expect(server.ready()).rejects.toThrow('Agent OS orchestration requires its matching scheduler')
  })
})

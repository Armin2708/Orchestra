import { describe, expect, it, vi } from 'vitest'
import { JobMarketService } from '../src/agent-os/job-market.js'
import { createAgentOsRuntime } from '../src/agent-os/runtime-integration.js'
import { openDb } from '../src/db.js'
import type { AgentDriver, DriverSession } from '../src/runtime/index.js'

const eventually = async (condition: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('runtime deadline and cancellation recovery remediation', () => {
  it('bounds provider launch inside the absolute job deadline and stops a late launch', async () => {
    const db = openDb(':memory:')
    const repositoryPath = process.cwd()
    const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES (?, 'runtime launch deadline')`).run(repositoryPath).lastInsertRowid)
    const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
      VALUES (?, 'Bound provider launch', 'stop a launch that resolves after its deadline')`)
      .run(boardId).lastInsertRowid)
    const market = new JobMarketService(db)
    market.get(cardId)
    db.prepare('UPDATE job_market_contracts SET budget_time_seconds=1 WHERE card_id=?')
      .run(cardId)
    const runtime = createAgentOsRuntime(db)
    const workspace = await runtime.workspaceManager.create({
      boardId,
      cardId,
      name: 'runtime-launch-deadline',
      kind: 'shared',
      rootPath: repositoryPath,
      baseRef: 'HEAD',
    })
    let resolveLaunch!: (session: DriverSession) => void
    const pendingLaunch = new Promise<DriverSession>((resolve) => { resolveLaunch = resolve })
    const stopped: string[] = []
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async () => pendingLaunch,
      attach: async () => null,
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async (sessionId) => { stopped.push(sessionId) },
      events: async function* () {},
    }
    runtime.registerDriver(driver)
    const job = runtime.scheduler.create({
      boardId,
      cardId,
      workspaceId: workspace.id,
      provider: 'claude',
      maxAttempts: 1,
    })

    try {
      const tick = runtime.scheduler.tick()
      await eventually(() => runtime.scheduler.get(job.id)?.status === 'cancelling')
      await tick
      expect(runtime.scheduler.get(job.id)?.error).toMatch(/provider launch remained pending/)

      resolveLaunch({
        id: 'claude:late-launch',
        externalId: 'late-launch-thread',
        driverId: 'claude',
        workspaceId: workspace.id,
        status: 'running',
        startedAt: new Date().toISOString(),
        metadata: {},
      })
      await eventually(() => runtime.scheduler.get(job.id)?.status === 'cancelled')
      expect(stopped).toEqual(['claude:late-launch'])
      expect(db.prepare(`SELECT status FROM agent_sessions
        WHERE json_extract(context_json, '$.job_id')=?`).get(job.id)).toEqual({ status: 'stopped' })
    } finally {
      await runtime.shutdown()
      db.close()
    }
  })

  it('uses bounded shell stop when reconciling a cancelling job after restart', async () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/runtime-shell-recovery', 'runtime shell recovery')`).run().lastInsertRowid)
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES ('runtime-shell-workspace', ?, 'runtime shell', 'shared', '/runtime-shell-recovery', 'active')`)
      .run(boardId)
    db.prepare(`INSERT INTO jobs (
      id, board_id, workspace_id, provider, driver_id, status, attempts, max_attempts,
      started_at
    ) VALUES (
      'runtime-shell-cancelling', ?, 'runtime-shell-workspace', 'shell', 'shell',
      'cancelling', 1, 1, datetime('now')
    )`).run(boardId)
    db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, provider, external_id, status, context_json, job_id
    ) VALUES (
      'runtime-shell-session', 'runtime-shell-workspace', 'shell', 'runtime-shell-process',
      'running', json_object('job_id', 'runtime-shell-cancelling'), 'runtime-shell-cancelling'
    )`).run()
    const runtime = createAgentOsRuntime(db)
    const shellDriver = runtime.drivers.require('shell')
    const attach = vi.spyOn(shellDriver, 'attach').mockResolvedValue({
      id: 'shell:runtime-shell-process',
      externalId: 'runtime-shell-process',
      driverId: 'shell',
      workspaceId: 'runtime-shell-workspace',
      status: 'running',
      startedAt: new Date().toISOString(),
      metadata: {},
    })
    const stop = vi.spyOn(shellDriver, 'stop').mockResolvedValue(undefined)

    try {
      expect(await runtime.reconcileJobs()).toEqual({
        resumed: [],
        recovered: ['runtime-shell-cancelling'],
      })
      expect(attach).toHaveBeenCalledWith('runtime-shell-process')
      expect(stop).toHaveBeenCalledWith('shell:runtime-shell-process')
      expect(runtime.scheduler.get('runtime-shell-cancelling')).toMatchObject({
        status: 'cancelled',
        error: null,
      })
      expect(db.prepare('SELECT status FROM agent_sessions WHERE id=?')
        .get('runtime-shell-session')).toEqual({ status: 'stopped' })
    } finally {
      await runtime.shutdown()
      db.close()
    }
  })
})

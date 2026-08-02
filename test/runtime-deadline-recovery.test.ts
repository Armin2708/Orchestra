import { spawn } from 'node:child_process'
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

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
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

  it('preserves then terminates a real cancelling shell process in daemon restart order', async () => {
    if (process.platform === 'win32') return
    const db = openDb(':memory:')
    const repositoryPath = process.cwd()
    const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES (?, 'real shell restart recovery')`).run(repositoryPath).lastInsertRowid)
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES ('real-shell-workspace', ?, 'real shell', 'shared', ?, 'active')`)
      .run(boardId, repositoryPath)
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      cwd: repositoryPath,
      detached: true,
      stdio: 'ignore',
    })
    orphan.unref()
    const orphanPid = orphan.pid!
    await eventually(() => processExists(orphanPid))
    const processId = 'real-shell-process'
    db.prepare(`INSERT INTO processes (
      id, workspace_id, name, command, cwd, status, pid, exit_code,
      cols, rows, restartable, started_at, ended_at
    ) VALUES (?, 'real-shell-workspace', 'real persisted shell process', ?, ?,
      'running', ?, NULL, 120, 32, 1, ?, NULL)`)
      .run(
        processId,
        `${process.execPath} -e setInterval`,
        repositoryPath,
        orphanPid,
        new Date().toISOString(),
      )
    db.prepare(`INSERT INTO jobs (
      id, board_id, workspace_id, provider, driver_id, status, attempts, max_attempts,
      started_at
    ) VALUES (
      'real-shell-cancelling', ?, 'real-shell-workspace', 'shell', 'shell',
      'cancelling', 1, 1, datetime('now')
    )`).run(boardId)
    db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, provider, driver_id, external_id, status, context_json, job_id
    ) VALUES (
      'real-shell-session', 'real-shell-workspace', 'shell', 'shell', ?, 'running',
      json_object('job_id', 'real-shell-cancelling'), 'real-shell-cancelling'
    )`).run(processId)
    const afterCrash = createAgentOsRuntime(db)

    try {
      expect(await afterCrash.reconcileLost()).toEqual([])
      expect(db.prepare('SELECT status, pid FROM processes WHERE id=?').get(processId))
        .toMatchObject({ status: 'running', pid: orphanPid })
      expect(await afterCrash.reconcileJobs()).toEqual({
        resumed: [],
        recovered: ['real-shell-cancelling'],
      })
      await eventually(() => !processExists(orphanPid))
      expect(afterCrash.scheduler.get('real-shell-cancelling')).toMatchObject({
        status: 'cancelled',
        error: null,
      })
      expect(db.prepare('SELECT status, pid FROM processes WHERE id=?').get(processId))
        .toEqual({ status: 'stopped', pid: null })
      expect(db.prepare(`SELECT payload FROM os_events
        WHERE process_id=? AND kind='process.stopped'
        ORDER BY rowid DESC LIMIT 1`).get(processId)).toMatchObject({
        payload: expect.stringContaining('"termination_proof":"observed-exit"'),
      })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM jobs
        WHERE status IN ('running','cancelling')`).get()).toEqual({ count: 0 })
    } finally {
      await afterCrash.shutdown()
      if (processExists(orphanPid)) {
        try { process.kill(-orphanPid, 'SIGKILL') } catch {}
      }
      db.close()
    }
  }, 15_000)

  it('fails closed without signalling when a persisted pid identity does not match', async () => {
    if (process.platform === 'win32') return
    const db = openDb(':memory:')
    const repositoryPath = process.cwd()
    const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES (?, 'pid identity mismatch')`).run(repositoryPath).lastInsertRowid)
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
      VALUES ('pid-mismatch-workspace', ?, 'pid mismatch', 'shared', ?, 'active')`)
      .run(boardId, repositoryPath)
    const owner = createAgentOsRuntime(db)
    const processRecord = await owner.supervisor.spawn({
      workspaceId: 'pid-mismatch-workspace',
      name: 'identity mismatch process',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      cwd: repositoryPath,
      shell: false,
    })
    db.prepare(`UPDATE processes SET started_at='2000-01-01T00:00:00.000Z' WHERE id=?`)
      .run(processRecord.id)
    const restarted = createAgentOsRuntime(db)

    try {
      await expect(restarted.supervisor.stop(processRecord.id))
        .rejects.toThrow(/identity does not match/)
      expect(processExists(processRecord.pid!)).toBe(true)
      expect(db.prepare('SELECT status, pid FROM processes WHERE id=?').get(processRecord.id))
        .toMatchObject({ status: 'running', pid: processRecord.pid })
    } finally {
      await owner.shutdown()
      await restarted.shutdown()
      db.close()
    }
  }, 15_000)
})

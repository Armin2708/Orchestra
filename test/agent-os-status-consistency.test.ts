import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagedAgentSessionBinder } from '../src/agent-os/managed-session-binding.js'
import { createAgentOsRuntime, type AgentOsRuntime } from '../src/agent-os/runtime-integration.js'
import { openDb } from '../src/db.js'
import type { AgentDriver, DriverSession } from '../src/runtime/index.js'
import { buildServer } from '../src/server.js'

type Fixture = {
  db: Database.Database
  runtime: AgentOsRuntime
  server: FastifyInstance
}

const fixtures: Fixture[] = []

const pendingEvents = async function* () {
  await new Promise<void>(() => undefined)
}

const fixture = async (
  attach: () => Promise<DriverSession | null>,
  maxAttempts = 1,
) => {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES (?, 'PTY status consistency')",
  ).run(process.cwd()).lastInsertRowid)
  const workspaceId = 'pty-status-workspace'
  db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, 'PTY status workspace', 'shared', ?, 'active')`)
    .run(workspaceId, boardId, process.cwd())

  const runtime = createAgentOsRuntime(db)
  const attachCalls: string[] = []
  const driver: AgentDriver = {
    id: 'codex-status-fixture',
    capabilities: () => ({
      attach: true,
      streaming: true,
      interrupt: true,
      stop: true,
      rawTerminal: false,
      resume: true,
    }),
    launch: async () => { throw new Error('status fixture does not launch') },
    attach: async (externalId) => {
      attachCalls.push(externalId)
      return attach()
    },
    send: async () => undefined,
    interrupt: async () => undefined,
    stop: async () => undefined,
    events: pendingEvents,
  }
  runtime.registerDriver(driver)

  const job = runtime.scheduler.create({
    boardId,
    workspaceId,
    provider: driver.id,
    maxAttempts,
  })
  db.prepare("UPDATE jobs SET status='running', attempts=1, started_at=datetime('now') WHERE id=?")
    .run(job.id)
  const binding = new ManagedAgentSessionBinder(db).bind({
    jobId: job.id,
    boardId,
    workspaceId,
    provider: driver.id,
    driverId: driver.id,
    profileName: 'PTY status agent',
    model: 'status-model',
    effort: 'high',
    accessProfile: 'workspace_write',
    context: { status_fixture: true, managed_identity: true },
  })
  const agentId = Number(db.prepare(`INSERT INTO agents (
    board_id, name, session_id, kind, status, provider, provider_state_json
  ) VALUES (?, 'PTY status provider', ?, 'hired', 'active', ?, ?)`).run(
    boardId,
    `agent-os:${job.id}`,
    driver.id,
    JSON.stringify({ job_id: job.id, workspace_id: workspaceId, lifecycle: 'active' }),
  ).lastInsertRowid)
  db.prepare(`UPDATE agent_sessions SET
    agent_id=?, external_id='provider-thread-status', provider_thread_id='provider-thread-status',
    status='running', control_state='active', recovery_state='attachable', history_state='complete',
    started_at=coalesce(started_at, datetime('now')), updated_at=datetime('now')
    WHERE id=?`).run(agentId, binding.agentHomeSessionId)
  db.prepare(`INSERT INTO processes (
    id, workspace_id, name, command, cwd, status, pid, restartable, started_at
  ) VALUES (
    'pty-status-process', ?, 'status terminal', 'status-fixture', ?, 'running', 999999, 1, datetime('now')
  )`).run(workspaceId, process.cwd())

  const server = buildServer(db, undefined, {
    agentOs: {
      runtime: runtime.adapter,
      jobExecutor: runtime.jobExecutor,
      scheduler: runtime.scheduler,
      drivers: () => runtime.descriptors(),
    },
  })
  runtime.setBus(server.bus)
  await server.ready()
  fixtures.push({ db, runtime, server })
  return {
    db,
    runtime,
    server,
    boardId,
    workspaceId,
    jobId: job.id,
    sessionId: binding.agentHomeSessionId,
    profileId: binding.agentProfileId,
    agentId,
    attachCalls,
  }
}

const statusMatrix = (db: Database.Database, ids: {
  workspaceId: string
  jobId: string
  sessionId: string
  agentId: number
}) => ({
  workspace: db.prepare('SELECT status FROM workspaces WHERE id=?').get(ids.workspaceId),
  process: db.prepare("SELECT status FROM processes WHERE id='pty-status-process'").get(),
  provider: db.prepare('SELECT status FROM agents WHERE id=?').get(ids.agentId),
  session: db.prepare(`SELECT status, control_state, recovery_state
    FROM agent_sessions WHERE id=?`).get(ids.sessionId),
  job: db.prepare('SELECT status FROM jobs WHERE id=?').get(ids.jobId),
})

afterEach(async () => {
  for (const current of fixtures.splice(0)) {
    await current.server.close()
    await current.runtime.shutdown()
    current.db.close()
  }
})

describe('Agent OS active-session status consistency', () => {
  it('restores one running provider/session/job scope after successful daemon reattach', async () => {
    const attachedSession: DriverSession = {
      id: 'driver-session-reattached',
      externalId: 'provider-thread-status',
      driverId: 'codex-status-fixture',
      workspaceId: 'pty-status-workspace',
      status: 'running',
      startedAt: new Date().toISOString(),
      metadata: { reattached: true },
    }
    const setup = await fixture(async () => attachedSession)

    expect(await setup.runtime.reconcileJobs()).toEqual({
      resumed: [setup.jobId],
      recovered: [],
    })
    expect(setup.attachCalls).toEqual(['provider-thread-status'])
    expect(attachedSession.status).toBe('running')
    expect(statusMatrix(setup.db, setup)).toEqual({
      workspace: { status: 'active' },
      process: { status: 'running' },
      provider: { status: 'active' },
      session: { status: 'running', control_state: 'active', recovery_state: 'attachable' },
      job: { status: 'running' },
    })

    const home = (await setup.server.inject({
      method: 'GET',
      url: `/api/v1/os/agent-profiles/${setup.profileId}/home`,
    })).json().home
    expect(home).toMatchObject({
      active_session: {
        id: setup.sessionId,
        workspace_id: setup.workspaceId,
        job_id: setup.jobId,
        status: 'running',
      },
      active_scope: {
        workspace: { id: setup.workspaceId, status: 'active' },
        job: { id: setup.jobId, status: 'running' },
        processes: [{ id: 'pty-status-process', status: 'running' }],
      },
    })
  })

  it('marks both the provider session and raw PTY honestly lost when neither can reattach', async () => {
    const setup = await fixture(async () => null)

    expect(await setup.runtime.reconcileLost()).toEqual([
      expect.objectContaining({ id: 'pty-status-process', status: 'lost', pid: null }),
    ])
    expect(await setup.runtime.reconcileJobs()).toEqual({
      resumed: [],
      recovered: [setup.jobId],
    })
    expect(setup.attachCalls).toEqual(['provider-thread-status'])
    expect(statusMatrix(setup.db, setup)).toEqual({
      workspace: { status: 'active' },
      process: { status: 'lost' },
      provider: { status: 'gone' },
      session: { status: 'lost', control_state: 'stopped', recovery_state: 'lost' },
      job: { status: 'blocked' },
    })

    const home = (await setup.server.inject({
      method: 'GET',
      url: `/api/v1/os/agent-profiles/${setup.profileId}/home`,
    })).json().home
    expect(home).toMatchObject({
      active_session: null,
      sessions: [expect.objectContaining({
        id: setup.sessionId,
        status: 'lost',
        control_state: 'stopped',
        recovery_state: 'lost',
      })],
      active_scope: {
        workspace: { id: setup.workspaceId, status: 'active' },
        job: { id: setup.jobId, status: 'blocked' },
        processes: [{ id: 'pty-status-process', status: 'lost' }],
        attention: expect.arrayContaining([
          expect.objectContaining({ kind: 'process.lost', status: 'open' }),
          expect.objectContaining({ kind: 'job.blocked', status: 'open' }),
        ]),
      },
    })
    expect(setup.db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE job_id=? AND kind='job.blocked'`).get(setup.jobId)).toEqual({ count: 1 })
  })

  it('terminalizes the lost provider identity while requeueing a retryable job', async () => {
    const setup = await fixture(async () => null, 2)

    await setup.runtime.reconcileLost()
    expect(await setup.runtime.reconcileJobs()).toEqual({
      resumed: [],
      recovered: [setup.jobId],
    })
    expect(statusMatrix(setup.db, setup)).toEqual({
      workspace: { status: 'active' },
      process: { status: 'lost' },
      provider: { status: 'gone' },
      session: { status: 'lost', control_state: 'stopped', recovery_state: 'lost' },
      job: { status: 'queued' },
    })
    expect(setup.db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE job_id=? AND kind='job.retry_queued'`).get(setup.jobId)).toEqual({ count: 1 })

    const home = (await setup.server.inject({
      method: 'GET',
      url: `/api/v1/os/agent-profiles/${setup.profileId}/home`,
    })).json().home
    expect(home).toMatchObject({
      active_session: null,
      sessions: [expect.objectContaining({
        id: setup.sessionId,
        status: 'lost',
        control_state: 'stopped',
        recovery_state: 'lost',
      })],
      active_scope: {
        workspace: { id: setup.workspaceId, status: 'active' },
        job: { id: setup.jobId, status: 'queued' },
        processes: [{ id: 'pty-status-process', status: 'lost' }],
      },
    })
  })
})

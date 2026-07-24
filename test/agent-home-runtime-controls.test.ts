import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationService } from '../src/agent-os/conversations.js'
import {
  createAgentOsRuntime,
  type AgentOsRuntime,
} from '../src/agent-os/runtime-integration.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'
import { openDb } from '../src/db.js'
import type {
  AgentDriver,
  DriverLaunchRequest,
  DriverSession,
} from '../src/runtime/index.js'

const runtimes: AgentOsRuntime[] = []
const roots: string[] = []
const databases: Database.Database[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown()
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Agent Home real runtime controls', () => {
  it('maps pause, resume, and stop to the attached provider and canonical scheduler', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-runtime-controls-'))
    roots.push(root)
    const db = openDb(':memory:')
    databases.push(db)
    const boardId = Number(db.prepare(
      'INSERT INTO boards (project_path, name) VALUES (?, ?)',
    ).run(root, 'Runtime controls').lastInsertRowid)
    const cardId = Number(db.prepare(`INSERT INTO cards
      (board_id, title, description) VALUES (?, 'Runtime controls', 'provider controls')`)
      .run(boardId).lastInsertRowid)
    const workspace = new WorkspaceStore(db).create({
      boardId,
      cardId,
      name: 'Runtime controls',
      kind: 'shared',
      rootPath: root,
      status: 'active',
    })
    const runtime = createAgentOsRuntime(db)
    runtimes.push(runtime)
    const launches: DriverLaunchRequest[] = []
    const interrupts: string[] = []
    const sends: Array<{ sessionId: string; text: string }> = []
    const stops: string[] = []
    let releaseInterrupt: (() => void) | undefined
    const interrupted = new Promise<void>((resolve) => { releaseInterrupt = resolve })
    let releaseEvents: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => { releaseEvents = resolve })
    let liveSession: DriverSession | null = null
    const driver: AgentDriver = {
      id: 'codex',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async (request) => {
        launches.push(request)
        liveSession = {
          id: 'codex-control-session',
          externalId: 'codex-control-thread',
          driverId: 'codex',
          workspaceId: request.workspaceId,
          status: 'running',
          startedAt: new Date().toISOString(),
          metadata: {},
        }
        return liveSession
      },
      attach: async (externalId) =>
        liveSession?.externalId === externalId ? liveSession : null,
      send: async (sessionId, text) => {
        sends.push({ sessionId, text })
      },
      interrupt: async (sessionId) => {
        interrupts.push(sessionId)
        releaseInterrupt?.()
      },
      stop: async (sessionId) => {
        stops.push(sessionId)
        releaseEvents?.()
      },
      events: async function* (sessionId) {
        await interrupted
        yield {
          sessionId,
          seq: 1,
          type: 'error',
          at: new Date().toISOString(),
          data: 'Codex turn interrupted',
          metadata: {
            turnCompleted: true,
            turnActive: false,
            status: 'interrupted',
          },
        }
        await stopped
        yield {
          sessionId,
          seq: 2,
          type: 'exit',
          at: new Date().toISOString(),
          data: 'process.stopped',
          metadata: { exitCode: 0 },
        }
      },
    }
    runtime.registerDriver(driver)
    const orchestration = new OrchestrationService(db, runtime.scheduler, {
      materialize: async (item) => item,
    })
    const reserved = orchestration.createCardJob({
      cardId,
      workspaceId: workspace.id,
      provider: 'codex',
      accessProfile: 'read_only',
      maxAttempts: 1,
    })
    expect((await runtime.scheduler.tick()).started).toEqual([reserved.job.id])
    await until(() => new ConversationService(db).requireSession(reserved.session!.id).status === 'running')

    const session = new ConversationService(db).requireSession(reserved.session!.id)
    const capabilities = runtime.jobExecutor.agentHomeSessionCapabilities(session)
    expect(capabilities).toEqual({
      pause: { supported: true, reason: null },
      resume: { supported: true, reason: null },
      stop: { supported: true, reason: null },
      retry: { supported: true, reason: null },
      fork: {
        supported: false,
        reason: 'codex does not expose provenance-safe native session forking',
      },
    })
    expect(launches[0].metadata).toMatchObject({
      agentHomeSessionId: session.id,
      agentProfileId: session.profile_id,
      agentConversationId: session.conversation_id,
    })

    await runtime.jobExecutor.pauseAgentHomeSession(session.id)
    await until(() => Number((db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE job_id=? AND kind='driver.error'`).get(reserved.job.id) as { count: number }).count) === 1)
    expect(runtime.scheduler.get(reserved.job.id)?.status).toBe('running')
    expect(new ConversationService(db).requireSession(session.id).status).toBe('running')
    expect(runtime.jobExecutor.agentHomeSessionCapabilities(
      new ConversationService(db).requireSession(session.id),
    ).resume).toEqual({ supported: true, reason: null })

    await runtime.jobExecutor.resumeAgentHomeSession(session.id)
    expect(interrupts).toEqual(['codex-control-session'])
    expect(sends).toEqual([{
      sessionId: 'codex-control-session',
      text: expect.stringContaining('Resume the current Orchestra assignment'),
    }])

    await runtime.jobExecutor.stopAgentHomeSession(session.id)
    await until(() => runtime.scheduler.get(reserved.job.id)?.status === 'cancelled')
    expect(stops).toEqual(['codex-control-session'])
    expect(new ConversationService(db).requireSession(session.id)).toMatchObject({
      status: 'stopped',
      control_state: 'stopped',
    })
    expect(runtime.jobExecutor.agentHomeSessionCapabilities(
      new ConversationService(db).requireSession(session.id),
    )).toMatchObject({
      pause: { supported: false },
      resume: { supported: false },
      stop: { supported: false },
      retry: { supported: true },
      fork: { supported: false },
    })
  })

  it('rehydrates paused Codex intent before attach replays an interrupted turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-paused-codex-restart-'))
    roots.push(root)
    const db = openDb(':memory:')
    databases.push(db)
    const runtime = createAgentOsRuntime(db)
    runtimes.push(runtime)
    let releaseStop: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => { releaseStop = resolve })
    const updates: string[] = []
    const driver: AgentDriver & {
      updateSession(sessionId: string): Promise<void>
    } = {
      id: 'codex',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async () => { throw new Error('not used') },
      attach: async () => ({
        id: 'codex:restart-paused',
        externalId: 'codex-paused-thread',
        driverId: 'codex',
        workspaceId: 'paused-codex-workspace',
        status: 'idle',
        startedAt: new Date().toISOString(),
        metadata: {},
      }),
      updateSession: async (sessionId) => { updates.push(sessionId) },
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async () => { releaseStop?.() },
      events: async function* (sessionId) {
        yield {
          sessionId,
          seq: 1,
          type: 'error',
          at: new Date().toISOString(),
          data: 'Codex turn interrupted',
          metadata: {
            turnCompleted: true,
            turnActive: false,
            status: 'interrupted',
            replayed: true,
            reconnectReason: 'daemon-attach',
          },
        }
        await stopped
        yield {
          sessionId,
          seq: 2,
          type: 'exit',
          at: new Date().toISOString(),
          data: 'process.stopped',
          metadata: { exitCode: 0 },
        }
      },
    }
    runtime.registerDriver(driver)
    const { jobId, sessionId } = seedPausedRuntimeJob(db, root, 'codex')

    expect(await runtime.reconcileJobs()).toEqual({ resumed: [jobId], recovered: [] })
    await until(() => Number((db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE job_id=? AND kind='driver.error'`).get(jobId) as { count: number }).count) === 1)
    expect(runtime.scheduler.get(jobId)?.status).toBe('running')
    expect(new ConversationService(db).requireSession(sessionId)).toMatchObject({
      status: 'idle',
      control_state: 'paused',
    })
    expect(updates).toEqual(['codex:restart-paused'])
    expect(runtime.jobExecutor.agentHomeSessionCapabilities(
      new ConversationService(db).requireSession(sessionId),
    ).resume).toEqual({ supported: true, reason: null })

    await runtime.jobExecutor.stopAgentHomeSession(sessionId)
    await until(() => runtime.scheduler.get(jobId)?.status === 'cancelled')
  })

  it('reattaches a paused Claude session without sending a restart continuation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-paused-claude-restart-'))
    roots.push(root)
    const db = openDb(':memory:')
    databases.push(db)
    const runtime = createAgentOsRuntime(db)
    runtimes.push(runtime)
    const sent: string[] = []
    let releaseStop: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => { releaseStop = resolve })
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
      launch: async () => { throw new Error('not used') },
      attach: async () => ({
        id: 'claude:restart-paused',
        externalId: 'claude-paused-thread',
        driverId: 'claude',
        workspaceId: 'paused-claude-workspace',
        status: 'idle',
        startedAt: new Date().toISOString(),
        metadata: {},
      }),
      send: async (_sessionId, text) => { sent.push(text) },
      interrupt: async () => undefined,
      stop: async () => { releaseStop?.() },
      events: async function* (sessionId) {
        await stopped
        yield {
          sessionId,
          seq: 1,
          type: 'exit',
          at: new Date().toISOString(),
          data: 'process.stopped',
          metadata: { exitCode: 0 },
        }
      },
    }
    runtime.registerDriver(driver)
    const { jobId, sessionId } = seedPausedRuntimeJob(db, root, 'claude')

    expect(await runtime.reconcileJobs()).toEqual({ resumed: [jobId], recovered: [] })
    expect(sent).toEqual([])
    expect(new ConversationService(db).requireSession(sessionId)).toMatchObject({
      status: 'idle',
      control_state: 'paused',
    })

    await runtime.jobExecutor.stopAgentHomeSession(sessionId)
    await until(() => runtime.scheduler.get(jobId)?.status === 'cancelled')
  })
})

function seedPausedRuntimeJob(
  db: Database.Database,
  root: string,
  provider: 'codex' | 'claude',
): { jobId: string; sessionId: string } {
  const boardId = Number(db.prepare(
    'INSERT INTO boards (project_path, name) VALUES (?, ?)',
  ).run(root, `Paused ${provider}`).lastInsertRowid)
  const workspaceId = `paused-${provider}-workspace`
  db.prepare(`INSERT INTO workspaces (
    id, board_id, name, kind, root_path, status
  ) VALUES (?, ?, ?, 'shared', ?, 'active')`).run(
    workspaceId,
    boardId,
    `Paused ${provider}`,
    root,
  )
  const jobId = `paused-${provider}-job`
  db.prepare(`INSERT INTO jobs (
    id, board_id, workspace_id, provider, driver_id, access_profile, priority,
    status, attempts, max_attempts, started_at
  ) VALUES (?, ?, ?, ?, ?, 'read_only', 0, 'running', 1, 1, datetime('now'))`)
    .run(jobId, boardId, workspaceId, provider, provider)
  const sessionId = `paused-${provider}-session`
  db.prepare(`INSERT INTO agent_sessions (
    id, workspace_id, provider, external_id, status, context_json, control_state,
    started_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'idle', ?, 'paused', datetime('now'), datetime('now'),
    datetime('now'))`).run(
    sessionId,
    workspaceId,
    provider,
    `${provider}-paused-thread`,
    JSON.stringify({ job_id: jobId }),
  )
  return { jobId, sessionId }
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

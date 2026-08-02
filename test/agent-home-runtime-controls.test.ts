import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationService } from '../src/agent-os/conversations.js'
import { AgentHomeForkOutcomeUnknownError } from '../src/agent-os/agent-home-fork.js'
import { AgentHomeLifecycleService } from '../src/agent-os/agent-home-lifecycle.js'
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
  it('maps a live native Codex fork through a closed provenance contract', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-runtime-fork-'))
    roots.push(root)
    roots.push(`${root}-workspaces`)
    initializeGit(root)
    const db = openDb(':memory:')
    databases.push(db)
    const boardId = Number(db.prepare(
      'INSERT INTO boards (project_path, name) VALUES (?, ?)',
    ).run(root, 'Runtime fork').lastInsertRowid)
    const cardId = Number(db.prepare(`INSERT INTO cards
      (board_id, title, description) VALUES (?, 'Runtime fork', 'native fork mapping')`)
      .run(boardId).lastInsertRowid)
    const workspace = new WorkspaceStore(db).create({
      boardId,
      cardId,
      name: 'Runtime fork',
      kind: 'shared',
      rootPath: root,
      status: 'active',
    })
    const runtime = createAgentOsRuntime(db)
    runtimes.push(runtime)
    let releaseSourceEvents: (() => void) | undefined
    const sourceStopped = new Promise<void>((resolve) => {
      releaseSourceEvents = resolve
    })
    let releaseChildEvents: (() => void) | undefined
    const childStopped = new Promise<void>((resolve) => {
      releaseChildEvents = resolve
    })
    const forkCalls: Array<{
      sessionId: string
      options: {
        sourceExternalId: string
        sourceWorkspaceId: string
        sourceCwd: string
        targetWorkspaceId: string
        targetCwd: string
        workspaceId: string
        cwd: string
      }
    }> = []
    let unknown = false
    let metadataOverrides: Record<string, unknown> = {}
    let latestTargetWorkspaceId: string | null = null
    let returnParentBindingForChild = false
    const attachCalls: string[] = []
    const detachCalls: string[] = []
    const verifyCalls: Array<{
      sourceExternalId: string
      childExternalId: string
      childProviderThreadId: string
      childProviderSessionId: string | null
      sourceWorkspaceId: string
      sourceCwd: string
      targetWorkspaceId: string
      targetCwd: string
    }> = []
    const driver: AgentDriver & {
      forkSession(
        sessionId: string,
        options: {
          sourceExternalId: string
          sourceWorkspaceId: string
          sourceCwd: string
          targetWorkspaceId: string
          targetCwd: string
          workspaceId: string
          cwd: string
        },
      ): Promise<{
        sourceExternalId: string
        externalId: string
        providerThreadId: string
        sourceProviderThreadId: string
        metadata: Record<string, unknown>
      }>
      updateSession(sessionId: string): Promise<void>
      verifyForkSession(options: {
        sourceExternalId: string
        childExternalId: string
        childProviderThreadId: string
        childProviderSessionId: string | null
        sourceWorkspaceId: string
        sourceCwd: string
        targetWorkspaceId: string
        targetCwd: string
      }): Promise<{
        sourceExternalId: string
        externalId: string
        providerThreadId: string
        sourceProviderThreadId: string
        metadata: Record<string, unknown>
      }>
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
      launch: async (request) => ({
        id: 'codex:runtime-fork-source',
        externalId: 'runtime-fork-source',
        driverId: 'codex',
        workspaceId: request.workspaceId,
        status: 'running',
        startedAt: new Date().toISOString(),
        metadata: {},
      }),
      attach: async (externalId) => {
        attachCalls.push(externalId)
        if (externalId === 'runtime-fork-source'
          || returnParentBindingForChild) {
          return {
            id: 'codex:runtime-fork-source',
            externalId: 'runtime-fork-source',
            driverId: 'codex',
            workspaceId: workspace.id,
            status: 'running',
            startedAt: new Date().toISOString(),
            metadata: {},
          }
        }
        if (externalId === 'runtime-fork-child' && latestTargetWorkspaceId) {
          return {
            id: 'codex:runtime-fork-child',
            externalId,
            driverId: 'codex',
            workspaceId: latestTargetWorkspaceId,
            status: 'idle',
            startedAt: new Date().toISOString(),
            metadata: {},
          }
        }
        return null
      },
      detach: async (sessionId) => { detachCalls.push(sessionId) },
      updateSession: async () => undefined,
      send: async () => undefined,
      interrupt: async () => undefined,
      cancel: async (sessionId) => {
        if (sessionId.includes('child')) releaseChildEvents?.()
        else releaseSourceEvents?.()
      },
      stop: async (sessionId) => {
        if (sessionId.includes('child')) releaseChildEvents?.()
        else releaseSourceEvents?.()
      },
      forkSession: async (sessionId, options) => {
        forkCalls.push({ sessionId, options })
        latestTargetWorkspaceId = options.targetWorkspaceId
        if (unknown) {
          const error = Object.assign(new Error('RAW_RPC_ERROR_MUST_NOT_ESCAPE'), {
            outcomeUnknown: true as const,
            sourceExternalId: 'runtime-fork-source',
            sourceProviderThreadId: 'runtime-fork-source',
            knownChild: {
              externalId: 'runtime-fork-quarantined-child',
              providerThreadId: 'runtime-fork-quarantined-child',
              forkedFromId: 'runtime-fork-source',
              childProviderSessionId: 'runtime-fork-child-session',
              subscriptionReleased: true,
            },
            rawRpcPayload: { authorization: 'Bearer RAW_SECRET' },
          })
          throw error
        }
        return {
          sourceExternalId: 'runtime-fork-source',
          externalId: 'runtime-fork-child',
          providerThreadId: 'runtime-fork-child',
          sourceProviderThreadId: 'runtime-fork-source',
          metadata: {
            forkMethod: 'thread/fork',
            forkedFromId: 'runtime-fork-source',
            providerSessionId: 'runtime-fork-child-session',
            childCwd: options.targetCwd,
            targetWorkspaceAttestation: {
              value: options.targetWorkspaceId,
              authority: 'orchestrator',
            },
            readVerified: true,
            subscriptionReleased: true,
            cwdVerified: true,
            threadReadVerified: true,
            childUnsubscribeVerified: true,
            rawRpcPayload: { authorization: 'Bearer RAW_SECRET' },
            ...metadataOverrides,
          },
        }
      },
      verifyForkSession: async (options) => {
        verifyCalls.push(options)
        return {
          sourceExternalId: options.sourceExternalId,
          externalId: options.childExternalId,
          providerThreadId: options.childProviderThreadId,
          sourceProviderThreadId: 'runtime-fork-source',
          metadata: {
            forkMethod: 'thread/fork',
            forkedFromId: 'runtime-fork-source',
            providerSessionId: options.childProviderSessionId,
            childCwd: options.targetCwd,
            targetWorkspaceAttestation: {
              value: options.targetWorkspaceId,
              authority: 'orchestrator',
            },
            readVerified: true,
            cwdVerified: true,
            threadReadVerified: true,
          },
        }
      },
      events: async function* (sessionId) {
        if (sessionId.includes('child')) {
          await childStopped
          return
        }
        await sourceStopped
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
    db.prepare(`UPDATE agent_sessions SET provider_thread_id=external_id
      WHERE id=?`).run(reserved.session!.id)
    const session = new ConversationService(db).requireSession(reserved.session!.id)

    expect(runtime.jobExecutor.agentHomeSessionCapabilities(session).fork)
      .toEqual({ supported: true, reason: null })
    const operation = {
      actionId: 'runtime-fork-action',
      reservedSessionId: 'runtime-fork-child-session-id',
    }
    const target = await runtime.jobExecutor.prepareAgentHomeForkSession(session, operation)
    const fork = await runtime.jobExecutor.forkAgentHomeSession(session, {
      ...operation,
      ...target,
    })
    expect(fork).toEqual({
      sourceExternalId: 'runtime-fork-source',
      externalId: 'runtime-fork-child',
      providerThreadId: 'runtime-fork-child',
      sourceProviderThreadId: 'runtime-fork-source',
      provenance: {
        fork_method: 'thread/fork',
        history_boundary: 'full',
        read_verified: true,
        subscription_released: true,
      },
    })
    expect(JSON.stringify(fork)).not.toContain('RAW_SECRET')
    expect(forkCalls[0]).toEqual({
      sessionId: 'codex:runtime-fork-source',
      options: {
        sourceExternalId: 'runtime-fork-source',
        sourceWorkspaceId: workspace.id,
        sourceCwd: root,
        targetWorkspaceId: target.workspaceId,
        targetCwd: expect.stringContaining('runtime-fork-child-session-id'),
        workspaceId: workspace.id,
        cwd: root,
      },
    })
    const providerCallsBeforeVerification = forkCalls.length
    expect(await runtime.jobExecutor.verifyAgentHomeForkChild(
      session,
      {
        externalId: 'runtime-fork-verified-child',
        providerThreadId: 'runtime-fork-verified-child',
        forkedFromId: 'runtime-fork-source',
        childProviderSessionId: 'runtime-fork-verified-provider-session',
        subscriptionReleased: true,
      },
      {
        ...operation,
        ...target,
      },
    )).toEqual({
      sourceExternalId: 'runtime-fork-source',
      externalId: 'runtime-fork-verified-child',
      providerThreadId: 'runtime-fork-verified-child',
      sourceProviderThreadId: 'runtime-fork-source',
      provenance: {
        fork_method: 'thread/fork',
        history_boundary: 'full',
        read_verified: true,
        subscription_released: true,
      },
    })
    expect(verifyCalls).toEqual([{
      sourceExternalId: 'runtime-fork-source',
      childExternalId: 'runtime-fork-verified-child',
      childProviderThreadId: 'runtime-fork-verified-child',
      childProviderSessionId: 'runtime-fork-verified-provider-session',
      sourceWorkspaceId: workspace.id,
      sourceCwd: root,
      targetWorkspaceId: target.workspaceId,
      targetCwd: expect.stringContaining('runtime-fork-child-session-id'),
    }])
    expect(forkCalls).toHaveLength(providerCallsBeforeVerification)

    const incompleteProofs: Array<Record<string, unknown>> = [
      { forkedFromId: 'another-source' },
      { providerSessionId: null },
      { cwdVerified: false },
      { targetWorkspaceAttestation: null },
      { threadReadVerified: false },
      { childUnsubscribeVerified: false },
      { readVerified: false },
      { subscriptionReleased: false },
    ]
    for (const override of incompleteProofs) {
      metadataOverrides = override
      let invalid: unknown
      try {
        await runtime.jobExecutor.forkAgentHomeSession(session, {
          ...operation,
          ...target,
        })
      } catch (error) {
        invalid = error
      }
      expect(invalid).toBeInstanceOf(AgentHomeForkOutcomeUnknownError)
      expect(invalid).toMatchObject({
        message: 'provider fork returned an incomplete or unsupported provenance contract',
        sourceExternalId: 'runtime-fork-source',
        sourceProviderThreadId: 'runtime-fork-source',
        knownChild: {
          externalId: 'runtime-fork-child',
          providerThreadId: 'runtime-fork-child',
          subscriptionReleased: override.subscriptionReleased !== false,
        },
      })
      expect(JSON.stringify(invalid)).not.toContain('RAW_SECRET')
    }
    metadataOverrides = {}
    unknown = true
    let caught: unknown
    try {
      await runtime.jobExecutor.forkAgentHomeSession(session, {
        ...operation,
        ...target,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AgentHomeForkOutcomeUnknownError)
    expect(caught).toMatchObject({
      message: 'provider fork outcome is unknown',
      sourceExternalId: 'runtime-fork-source',
      sourceProviderThreadId: 'runtime-fork-source',
      knownChild: {
        externalId: 'runtime-fork-quarantined-child',
        providerThreadId: 'runtime-fork-quarantined-child',
        forkedFromId: 'runtime-fork-source',
        childProviderSessionId: 'runtime-fork-child-session',
        subscriptionReleased: true,
      },
    })
    expect(JSON.stringify(caught)).not.toContain('RAW_SECRET')
    expect(JSON.stringify(caught)).not.toContain('RAW_RPC_ERROR_MUST_NOT_ESCAPE')

    unknown = false
    returnParentBindingForChild = true
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime: runtime.jobExecutor,
    })
    const lifecycleInput = {
      actor: { type: 'operator', id: 'runtime-test' },
      idempotencyKey: 'runtime-fork-adoption-replay',
    }
    const providerCallsBeforeLifecycle = forkCalls.length
    await expect(lifecycle.run(session.id, 'fork', lifecycleInput))
      .rejects.toThrow('provider attached a different or non-isolated fork child')
    const pendingAction = db.prepare(`SELECT id, result_session_id, status,
      effect_state FROM agent_session_actions WHERE idempotency_key=?`).get(
      lifecycleInput.idempotencyKey,
    ) as {
      id: string
      result_session_id: string
      status: string
      effect_state: string
    }
    expect(pendingAction).toMatchObject({
      status: 'pending',
      effect_state: 'applied',
    })
    expect(new ConversationService(db).requireSession(pendingAction.result_session_id))
      .toMatchObject({
        parent_session_id: session.id,
        status: 'idle',
        control_state: 'paused',
        recovery_state: 'attachable',
      })

    returnParentBindingForChild = false
    const [adopted, concurrentReplay] = await Promise.all([
      lifecycle.run(session.id, 'fork', lifecycleInput),
      lifecycle.run(session.id, 'fork', lifecycleInput),
    ])
    expect(adopted.action).toMatchObject({
      id: pendingAction.id,
      replayed: true,
    })
    expect(concurrentReplay.action).toMatchObject({
      id: pendingAction.id,
      replayed: true,
    })
    expect(forkCalls).toHaveLength(providerCallsBeforeLifecycle + 1)
    expect(adopted.created_session).toMatchObject({
      id: pendingAction.result_session_id,
      parent_session_id: session.id,
      status: 'idle',
      control_state: 'active',
      recovery_state: 'attachable',
      context: {
        fork_action_id: pendingAction.id,
        adoption_state: 'attached',
      },
    })

    await runtime.shutdown()
    runtimes.splice(runtimes.indexOf(runtime), 1)
    expect(detachCalls).toContain('codex:runtime-fork-child')
    const restartedRuntime = createAgentOsRuntime(db)
    runtimes.push(restartedRuntime)
    restartedRuntime.registerDriver(driver)
    expect(await restartedRuntime.reconcileJobs()).toEqual({
      resumed: [reserved.job.id, pendingAction.result_session_id],
      recovered: [],
    })
    expect(attachCalls.filter((externalId) =>
      externalId === 'runtime-fork-child')).toHaveLength(3)
    expect(restartedRuntime.jobExecutor.agentHomeSessionCapabilities(
      new ConversationService(db).requireSession(pendingAction.result_session_id),
    )).toMatchObject({
      pause: { supported: true },
      resume: { supported: true },
      stop: { supported: true },
    })

    await restartedRuntime.jobExecutor.stopAgentHomeSession(pendingAction.result_session_id)
    expect(new ConversationService(db).requireSession(pendingAction.result_session_id))
      .toMatchObject({
        status: 'stopped',
        control_state: 'stopped',
      })
    expect(Number((db.prepare(`SELECT COUNT(*) AS count FROM attention_items
      WHERE board_id=? AND kind IN ('agent_session.failed','agent_session.lost')
        AND title LIKE ?`).get(
      boardId,
      `%${pendingAction.result_session_id}%`,
    ) as { count: number }).count)).toBe(0)

    await restartedRuntime.jobExecutor.stopAgentHomeSession(session.id)
    await until(() => restartedRuntime.scheduler.get(reserved.job.id)?.status === 'cancelled')
  })

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
      cancel: async (sessionId) => {
        stops.push(sessionId)
        releaseEvents?.()
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
      cancel: async () => { releaseStop?.() },
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
      cancel: async () => { releaseStop?.() },
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

function initializeGit(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', [
    '-c',
    'user.email=agent-home-runtime@test.invalid',
    '-c',
    'user.name=Agent Home Runtime Test',
    'commit',
    '--allow-empty',
    '-qm',
    'initial',
  ], { cwd: root })
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

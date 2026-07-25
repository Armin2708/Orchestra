import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAgentOsCommands } from '../src/agent-os-cli.js'
import { AgentHomeTranscriptExporter } from '../src/agent-os/agent-home-export.js'
import {
  AgentHomeLifecycleService,
  type AgentHomeRuntimeControl,
  type RuntimeActionCapabilities,
} from '../src/agent-os/agent-home-lifecycle.js'
import { AgentHomeSearchService } from '../src/agent-os/agent-home-search.js'
import { canonicalHash } from '../src/agent-os/agent-home-support.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { ArtifactStore } from '../src/agent-os/artifact-store.js'
import { ConversationService } from '../src/agent-os/conversations.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import {
  JobScheduler,
  type Job,
  type JobExecutionResult,
  type JobExecutor,
} from '../src/agent-os/scheduler.js'
import { openDb } from '../src/db.js'
import { api as clientApi } from '../src/client.js'
import { buildServer } from '../src/server.js'

const OPERATOR_TOKEN = 'agent-home-controls-operator'
const AGENT_TOKEN = 'agent-home-controls-agent'
const operatorHeaders = { authorization: `Bearer ${OPERATOR_TOKEN}` }
const agentHeaders = { authorization: `Bearer ${AGENT_TOKEN}` }
const actor = { type: 'operator' as const, id: 'controls-test' }
const servers: FastifyInstance[] = []
const databases: Database.Database[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) db.close()
})

class FakeAgentHomeRuntime implements AgentHomeRuntimeControl {
  pauseCalls: string[] = []
  resumeCalls: string[] = []
  stopCalls: string[] = []

  agentHomeSessionCapabilities(): RuntimeActionCapabilities {
    return {
      pause: { supported: true, reason: null },
      resume: { supported: true, reason: null },
      stop: { supported: true, reason: null },
      retry: { supported: true, reason: null },
      fork: {
        supported: false,
        reason: 'codex does not expose provenance-safe native session forking',
      },
    }
  }

  async pauseAgentHomeSession(sessionId: string): Promise<void> {
    this.pauseCalls.push(sessionId)
  }

  async resumeAgentHomeSession(sessionId: string): Promise<void> {
    this.resumeCalls.push(sessionId)
  }

  async stopAgentHomeSession(sessionId: string): Promise<void> {
    this.stopCalls.push(sessionId)
  }
}

class HookedAgentHomeRuntime extends FakeAgentHomeRuntime {
  constructor(private readonly onPause: (sessionId: string) => void | Promise<void>) {
    super()
  }

  override async pauseAgentHomeSession(sessionId: string): Promise<void> {
    this.pauseCalls.push(sessionId)
    await this.onPause(sessionId)
  }
}

class ReplacementExecutor implements JobExecutor {
  readonly jobs: Job[] = []

  supportedProviders(): readonly string[] {
    return ['codex']
  }

  async execute(job: Job): Promise<JobExecutionResult> {
    this.jobs.push(job)
    return { status: 'running' }
  }
}

describe('Agent Home lifecycle, search, and export controls', () => {
  it('keeps reads agent-visible, restricts mutations to operators, and replays actions', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const fixture = seedHome(db)
    appendTranscriptFixture(db, fixture)
    const runtime = new FakeAgentHomeRuntime()
    const server = buildServer(db, undefined, {
      token: OPERATOR_TOKEN,
      agentToken: AGENT_TOKEN,
      agentOs: { agentHomeLifecycle: runtime },
    })
    servers.push(server)
    await server.ready()

    const read = await server.inject({
      method: 'GET',
      url: `/api/v1/os/sessions/${fixture.sessionId}`,
      headers: agentHeaders,
    })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({
      session: {
        id: fixture.sessionId,
        control_state: 'active',
      },
      capabilities: {
        provider: 'codex',
        actions: {
          pause: {
            supported: true,
            allowed: false,
            requires_operator: true,
          },
          fork: {
            supported: false,
            allowed: false,
            requires_operator: true,
          },
        },
      },
      links: {
        profile_id: fixture.profileId,
        conversation_id: fixture.conversationId,
        session_id: fixture.sessionId,
        job_id: fixture.jobId,
      },
    })

    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${fixture.sessionId}/pause`,
      headers: { ...agentHeaders, 'idempotency-key': 'agent:pause' },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(runtime.pauseCalls).toEqual([])

    const pause = await sessionAction(server, fixture.sessionId, 'pause', 'operator:pause')
    expect(pause.statusCode).toBe(200)
    expect(pause.json()).toMatchObject({
      action: { type: 'pause', replayed: false },
      session: { status: 'idle', control_state: 'paused' },
    })
    expect(runtime.pauseCalls).toEqual([fixture.sessionId])

    const replay = await sessionAction(server, fixture.sessionId, 'pause', 'operator:pause')
    expect(replay.statusCode).toBe(200)
    expect(replay.json().action).toMatchObject({ type: 'pause', replayed: true })
    expect(runtime.pauseCalls).toEqual([fixture.sessionId])

    const reusedKey = await sessionAction(server, fixture.sessionId, 'resume', 'operator:pause')
    expect(reusedKey.statusCode).toBe(409)
    expect(reusedKey.json().error).toMatch(/idempotency key/)

    const resume = await sessionAction(server, fixture.sessionId, 'resume', 'operator:resume')
    expect(resume.json().session).toMatchObject({ status: 'running', control_state: 'active' })
    expect(runtime.resumeCalls).toEqual([fixture.sessionId])

    const renamed = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${fixture.sessionId}/rename`,
      headers: { ...operatorHeaders, 'idempotency-key': 'operator:rename' },
      payload: { name: 'Release verifier' },
    })
    expect(renamed.json().session.display_name).toBe('Release verifier')

    const stopped = await sessionAction(server, fixture.sessionId, 'stop', 'operator:stop')
    expect(stopped.json().session).toMatchObject({
      status: 'stopped',
      control_state: 'stopped',
    })
    expect(runtime.stopCalls).toEqual([fixture.sessionId])

    const archived = await sessionAction(server, fixture.sessionId, 'archive', 'operator:archive')
    expect(archived.json().session).toMatchObject({
      status: 'stopped',
      control_state: 'archived',
    })
    expect(archived.json().session.archived_at).toEqual(expect.any(String))

    const fork = await sessionAction(server, fixture.sessionId, 'fork', 'operator:fork')
    expect(fork.statusCode).toBe(501)
    expect(fork.json()).toMatchObject({ code: 'not_supported' })
    expect(fork.json().error).toMatch(/provenance-safe native session forking/)

    const actions = db.prepare(`SELECT action, status FROM agent_session_actions
      ORDER BY created_at, rowid`).all()
    expect(actions).toEqual([
      { action: 'pause', status: 'succeeded' },
      { action: 'resume', status: 'succeeded' },
      { action: 'rename', status: 'succeeded' },
      { action: 'stop', status: 'succeeded' },
      { action: 'archive', status: 'succeeded' },
      { action: 'fork', status: 'failed' },
    ])
  })

  it('reserves the caller audit identity before provider effects and preserves global conflicts', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const fixture = seedHome(db)
    const events = new EventStore(db)
    const runtime = new FakeAgentHomeRuntime()
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'caller-audit-reservation',
    })
    events.append({
      boardId: fixture.boardId,
      idempotencyKey: 'occupied:caller-key',
      kind: 'unrelated.command',
      source: 'test',
    })

    await expect(lifecycle.run(fixture.sessionId, 'pause', {
      actor,
      idempotencyKey: 'occupied:caller-key',
    })).rejects.toThrow(/idempotency key was already used/)
    expect(runtime.pauseCalls).toEqual([])

    const callerKey = 'pause:caller-key-reserved'
    let competingError: unknown
    const racingRuntime = new HookedAgentHomeRuntime(() => {
      try {
        events.append({
          boardId: fixture.boardId,
          idempotencyKey: callerKey,
          kind: 'competing.event',
          source: 'test',
        })
      } catch (error) {
        competingError = error
      }
    })
    const racingLifecycle = new AgentHomeLifecycleService(db, {
      runtime: racingRuntime,
      actionLeaseId: 'caller-audit-reservation',
    })
    const result = await racingLifecycle.run(fixture.sessionId, 'pause', {
      actor,
      idempotencyKey: callerKey,
    })
    const replay = await racingLifecycle.run(fixture.sessionId, 'pause', {
      actor,
      idempotencyKey: callerKey,
    })

    expect(competingError).toEqual(expect.objectContaining({
      message: expect.stringMatching(/event idempotency key/),
    }))
    expect(result.action.replayed).toBe(false)
    expect(replay.action.replayed).toBe(true)
    expect(racingRuntime.pauseCalls).toEqual([fixture.sessionId])
    expect(db.prepare(`SELECT kind FROM os_events
      WHERE board_id=? AND idempotency_key=?`).get(fixture.boardId, callerKey))
      .toEqual({ kind: 'agent_session.action_requested' })
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE board_id=? AND kind='agent_session.pause'`).get(fixture.boardId) as
      { count: number }).count).toBe(1)
  })

  it('uses an action-scoped completion identity after a provider-side collision', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const fixture = seedHome(db)
    const events = new EventStore(db)
    let collidedKey = ''
    const runtime = new HookedAgentHomeRuntime(() => {
      const action = db.prepare(`SELECT id FROM agent_session_actions
        WHERE session_id=? AND status='pending'`).get(fixture.sessionId) as { id: string }
      collidedKey = `agent-home-action:${action.id}:completed`
      events.append({
        boardId: fixture.boardId,
        idempotencyKey: collidedKey,
        kind: 'competing.event',
        source: 'test',
      })
    })
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'completion-key-collision',
    })

    const result = await lifecycle.run(fixture.sessionId, 'pause', {
      actor,
      idempotencyKey: 'pause:completion-key-collision',
    })
    const replay = await lifecycle.run(fixture.sessionId, 'pause', {
      actor,
      idempotencyKey: 'pause:completion-key-collision',
    })
    const action = db.prepare(`SELECT id, status, result_session_id FROM agent_session_actions
      WHERE idempotency_key='pause:completion-key-collision'`).get() as {
        id: string
        status: string
        result_session_id: string | null
      }
    const completion = db.prepare(`SELECT idempotency_key FROM os_events
      WHERE board_id=? AND kind='agent_session.pause'`).get(fixture.boardId) as {
        idempotency_key: string
      }

    expect(result.action.id).toBe(action.id)
    expect(result.action.replayed).toBe(false)
    expect(replay.action.replayed).toBe(true)
    expect(runtime.pauseCalls).toEqual([fixture.sessionId])
    expect(action).toEqual({
      id: result.action.id,
      status: 'succeeded',
      result_session_id: fixture.sessionId,
    })
    expect(db.prepare(`SELECT kind FROM os_events
      WHERE board_id=? AND idempotency_key=?`).get(fixture.boardId, collidedKey))
      .toEqual({ kind: 'competing.event' })
    expect(completion.idempotency_key).toMatch(
      new RegExp(`^agent-home-action:${result.action.id}:completed:`),
    )
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE board_id=? AND kind IN ('agent_session.action_requested','agent_session.pause')`)
      .get(fixture.boardId) as { count: number }).count).toBe(2)
  })

  it('recovers truthful completion after audit persistence fails post-provider success', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const fixture = seedHome(db)
    const runtime = new FakeAgentHomeRuntime()
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'daemon-before-audit-failure',
    })
    db.exec(`
      CREATE TRIGGER reject_agent_home_completion
      BEFORE INSERT ON os_events
      WHEN NEW.kind='agent_session.pause'
      BEGIN
        SELECT RAISE(ABORT, 'completion audit unavailable');
      END;
    `)

    await expect(lifecycle.run(fixture.sessionId, 'pause', {
      actor,
      idempotencyKey: 'pause:audit-persistence-failure',
    })).rejects.toThrow(/completion audit unavailable/)
    expect(runtime.pauseCalls).toEqual([fixture.sessionId])
    expect(db.prepare(`SELECT status, result_session_id FROM agent_session_actions
      WHERE idempotency_key='pause:audit-persistence-failure'`).get()).toEqual({
      status: 'pending',
      result_session_id: fixture.sessionId,
    })
    expect(new ConversationService(db).requireSession(fixture.sessionId)).toMatchObject({
      status: 'idle',
      control_state: 'paused',
    })

    db.exec('DROP TRIGGER reject_agent_home_completion')
    const restarted = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'daemon-after-audit-failure',
    })
    const replay = await restarted.run(fixture.sessionId, 'pause', {
      actor,
      idempotencyKey: 'pause:audit-persistence-failure',
    })

    expect(replay.action.replayed).toBe(true)
    expect(runtime.pauseCalls).toEqual([fixture.sessionId])
    expect(db.prepare(`SELECT status, result_session_id FROM agent_session_actions
      WHERE idempotency_key='pause:audit-persistence-failure'`).get()).toEqual({
      status: 'succeeded',
      result_session_id: fixture.sessionId,
    })
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE board_id=? AND kind IN ('agent_session.action_requested','agent_session.pause')`)
      .get(fixture.boardId) as { count: number }).count).toBe(2)
  })

  it('searches with stable cursors and every requested filter while preserving exact links', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const fixture = seedHome(db)
    const events = appendTranscriptFixture(db, fixture)
    const search = new AgentHomeSearchService(db)

    const firstPage = search.search(fixture.conversationId, { limit: 1 })
    expect(firstPage).toMatchObject({
      has_more: true,
      next_cursor: 1,
      events: [{
        id: events.assistantId,
        sequence: 1,
        links: {
          profile_id: fixture.profileId,
          conversation_id: fixture.conversationId,
          session_id: fixture.sessionId,
          event_id: events.assistantId,
        },
      }],
    })
    expect(firstPage.links).toMatchObject({
      board_id: fixture.boardId,
      profile_id: fixture.profileId,
      conversation_id: fixture.conversationId,
      session_id: null,
      job_id: null,
      workspace_id: null,
      event_id: null,
      process_id: null,
      href: `/?board=${fixture.boardId}&agent=${fixture.profileId}`
        + `&conversation=${fixture.conversationId}`,
    })
    expect(firstPage.events[0].links.href).toBe(
      `/?board=${fixture.boardId}&agent=${fixture.profileId}`
      + `&conversation=${fixture.conversationId}&session=${fixture.sessionId}`
      + `&job=${fixture.jobId}&workspace=${fixture.workspaceId}`
      + `&event=${events.assistantId}`,
    )
    expect(search.search(fixture.conversationId, {
      after: firstPage.next_cursor!,
      limit: 1,
    })).toMatchObject({
      has_more: true,
      next_cursor: 2,
      events: [{ id: events.toolId, sequence: 2 }],
    })
    expect(search.search(fixture.conversationId, { query: 'deploy alpha' }).events)
      .toEqual([expect.objectContaining({ id: events.assistantId })])
    const toolPage = search.search(fixture.conversationId, {
      kinds: ['tool'],
      actorType: 'agent',
      actorId: 'codex-worker',
      tool: 'terminal',
      status: 'succeeded',
      from: '2026-07-24T10:30:00.000Z',
      to: '2026-07-24T11:30:00.000Z',
      sessionId: fixture.sessionId,
    })
    expect(toolPage.events).toEqual([expect.objectContaining({ id: events.toolId })])
    expect(toolPage.events[0].links).toMatchObject({
      process_id: fixture.processId,
      process_ids: [fixture.processId],
      href: `/?board=${fixture.boardId}&agent=${fixture.profileId}`
        + `&conversation=${fixture.conversationId}&session=${fixture.sessionId}`
        + `&job=${fixture.jobId}&workspace=${fixture.workspaceId}`
        + `&process=${fixture.processId}&event=${events.toolId}`,
    })
    expect(search.search(fixture.conversationId, {
      kinds: ['status'],
      actorType: 'system',
      status: 'failed',
    }).events).toEqual([expect.objectContaining({ id: events.statusId })])
    expect(search.search(fixture.conversationId, {
      from: '2026-07-24T13:00:00.000Z',
    }).events).toEqual([])

    const server = buildServer(db, undefined, {
      token: OPERATOR_TOKEN,
      agentToken: AGENT_TOKEN,
    })
    servers.push(server)
    await server.ready()
    const apiSearch = await server.inject({
      method: 'GET',
      url: `/api/v1/os/sessions/${fixture.sessionId}/search`
        + '?query=npm&kind=tool&actor_type=agent&actor_id=codex-worker'
        + '&tool=terminal&status=succeeded&from=2026-07-24T10%3A30%3A00.000Z'
        + '&to=2026-07-24T11%3A30%3A00.000Z&limit=10',
      headers: agentHeaders,
    })
    expect(apiSearch.statusCode).toBe(200)
    expect(apiSearch.json().events).toEqual([
      expect.objectContaining({ id: events.toolId, projected_text: 'npm test' }),
    ])

    db.prepare('UPDATE conversation_events SET sequence=5001 WHERE id=?').run(events.toolId)
    const exact = await server.inject({
      method: 'GET',
      url: `/api/v1/os/conversations/${fixture.conversationId}/events/${events.toolId}`,
      headers: agentHeaders,
    })
    expect(exact.statusCode).toBe(200)
    expect(exact.json()).toMatchObject({
      event: {
        id: events.toolId,
        conversation_id: fixture.conversationId,
        session_id: fixture.sessionId,
        sequence: 5001,
      },
      links: {
        board_id: fixture.boardId,
        profile_id: fixture.profileId,
        conversation_id: fixture.conversationId,
        session_id: fixture.sessionId,
        job_id: fixture.jobId,
        workspace_id: fixture.workspaceId,
        process_id: fixture.processId,
        event_id: events.toolId,
      },
    })
    expect(exact.json().links.href).toContain(`event=${events.toolId}`)

    const otherConversation = new ConversationService(db).createConversation(fixture.profileId, {
      title: 'Other conversation',
      actor,
      idempotencyKey: 'controls:other-conversation',
    })
    const mismatched = await server.inject({
      method: 'GET',
      url: `/api/v1/os/conversations/${otherConversation.id}/events/${events.toolId}`,
      headers: agentHeaders,
    })
    expect(mismatched.statusCode).toBe(404)
    expect(mismatched.json()).toMatchObject({
      code: 'not_found',
      error: 'conversation event not found',
    })
  })

  it('exports redacted human and JSON transcripts without dropping provenance', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const fixture = seedHome(db)
    const events = appendTranscriptFixture(db, fixture)
    const exporter = new AgentHomeTranscriptExporter(db)
    const document = exporter.document(fixture.conversationId, fixture.sessionId)
    const serialized = JSON.stringify(document)

    expect(serialized).not.toContain('RAW_ARTIFACT_MUST_NOT_LEAK')
    expect(serialized).not.toContain('sk-secret-token-1234567890')
    expect(serialized).not.toContain('top-secret-value')
    expect(serialized).not.toContain('CAMEL_API_KEY_MUST_NOT_LEAK')
    expect(serialized).not.toContain('CAMEL_ACCESS_TOKEN_MUST_NOT_LEAK')
    expect(serialized).not.toContain('CAMEL_PRIVATE_KEY_MUST_NOT_LEAK')
    expect(serialized).not.toContain('CAMEL_RAW_RESPONSE_MUST_NOT_LEAK')
    expect(serialized).not.toContain('SET_COOKIE_MUST_NOT_LEAK')
    expect(serialized).toContain('[REDACTED]')
    expect(document).toMatchObject({
      redaction_policy: {
        raw_artifact_content_included: false,
      },
      provenance: {
        board_id: fixture.boardId,
        profile_id: fixture.profileId,
        conversation_id: fixture.conversationId,
        session_ids: [fixture.sessionId],
        event_ids: [events.assistantId, events.toolId, events.statusId],
      },
      events: [
        {
          id: events.assistantId,
          raw_artifact_id: fixture.artifactId,
          provider_thread_id: 'thread-controls',
          provider_cursor: 'cursor-1',
          export_redacted: true,
        },
        expect.objectContaining({ id: events.toolId }),
        expect.objectContaining({
          id: events.statusId,
          projected_text: '[WITHHELD BY RETENTION POLICY]',
          export_redacted: true,
        }),
      ],
    })
    expect(document.redaction_policy.redactions_applied).toBeGreaterThanOrEqual(9)

    const human = exporter.renderHuman(document)
    expect(human).toContain(`event=${events.assistantId}`)
    expect(human).toContain(`session=${fixture.sessionId}`)
    expect(human).toContain(document.events[0].content_hash)
    expect(human).toContain(`/?board=${fixture.boardId}&agent=${fixture.profileId}`)
    expect(human).not.toContain('RAW_ARTIFACT_MUST_NOT_LEAK')
    expect(human).not.toContain('top-secret-value')

    const created = exporter.createArtifact({
      conversationId: fixture.conversationId,
      sessionId: fixture.sessionId,
      format: 'json',
      actor,
      idempotencyKey: 'transcript:artifact',
    })
    const replay = exporter.createArtifact({
      conversationId: fixture.conversationId,
      sessionId: fixture.sessionId,
      format: 'json',
      actor,
      idempotencyKey: 'transcript:artifact',
    })
    expect(created).toMatchObject({
      artifact: {
        kind: 'agent_home_transcript',
        mime_type: 'application/json; charset=utf-8',
      },
      export: {
        format: 'json',
        event_count: 3,
        replayed: false,
      },
    })
    expect(replay.artifact.id).toBe(created.artifact.id)
    expect(replay.export.replayed).toBe(true)
    expect(created.artifact.content).not.toContain('RAW_ARTIFACT_MUST_NOT_LEAK')
    expect((db.prepare(`SELECT COUNT(*) AS count FROM artifacts
      WHERE kind='agent_home_transcript'`).get() as { count: number }).count).toBe(1)

    const server = buildServer(db, undefined, {
      token: OPERATOR_TOKEN,
      agentToken: AGENT_TOKEN,
    })
    servers.push(server)
    await server.ready()
    const agentRead = await server.inject({
      method: 'GET',
      url: `/api/v1/os/sessions/${fixture.sessionId}/export?format=human`,
      headers: agentHeaders,
    })
    expect(agentRead.statusCode).toBe(200)
    expect(agentRead.body).toContain(`event=${events.assistantId}`)
    expect(agentRead.body).not.toContain('RAW_ARTIFACT_MUST_NOT_LEAK')
    const agentWrite = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${fixture.sessionId}/export`,
      headers: { ...agentHeaders, 'idempotency-key': 'agent:export' },
      payload: { format: 'human' },
    })
    expect(agentWrite.statusCode).toBe(403)
    const operatorWrite = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${fixture.sessionId}/export`,
      headers: { ...operatorHeaders, 'idempotency-key': 'operator:export' },
      payload: { format: 'human' },
    })
    const operatorReplay = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${fixture.sessionId}/export`,
      headers: { ...operatorHeaders, 'idempotency-key': 'operator:export' },
      payload: { format: 'human' },
    })
    expect(operatorWrite.statusCode).toBe(201)
    expect(operatorReplay.statusCode).toBe(200)
    expect(operatorReplay.json()).toMatchObject({
      artifact: { id: operatorWrite.json().artifact.id },
      export: { replayed: true },
    })
  })

  it('prints a human transcript through the real HTTP client and CLI command', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const fixture = seedHome(db)
    const events = appendTranscriptFixture(db, fixture)
    const server = buildServer(db)
    servers.push(server)
    await server.listen({ host: '127.0.0.1', port: 0 })
    const address = server.server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    const previousPort = process.env.ORCHESTRA_PORT
    const previousHome = process.env.ORCHESTRA_HOME
    const clientHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-cli-client-'))
    const output: string[] = []
    try {
      process.env.ORCHESTRA_PORT = String(address.port)
      process.env.ORCHESTRA_HOME = clientHome
      const program = new Command().name('orchestra').exitOverride()
      program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
      registerAgentOsCommands(program, {
        api: clientApi,
        ensureReady: async () => {},
        resolveBoard: async () => ({ id: fixture.boardId }),
        output: (line) => output.push(line),
      })

      await program.parseAsync([
        'node',
        'orchestra',
        'session',
        'export',
        fixture.sessionId,
      ])
    } finally {
      if (previousPort === undefined) delete process.env.ORCHESTRA_PORT
      else process.env.ORCHESTRA_PORT = previousPort
      if (previousHome === undefined) delete process.env.ORCHESTRA_HOME
      else process.env.ORCHESTRA_HOME = previousHome
      fs.rmSync(clientHome, { recursive: true, force: true })
    }

    expect(output).toHaveLength(1)
    expect(output[0]).toContain('# Agent Home transcript')
    expect(output[0]).toContain(`event=${events.assistantId}`)
    expect(output[0]).not.toContain('[object Object]')
    expect(output[0]).not.toContain('RAW_ARTIFACT_MUST_NOT_LEAK')
  })

  it('creates one canonical retry child with durable lineage and idempotent replay', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const fixture = seedHome(db)
    db.prepare(`UPDATE agent_sessions SET status='stopped', control_state='stopped',
      ended_at=datetime('now') WHERE id=?`).run(fixture.sessionId)
    db.prepare(`UPDATE jobs SET status='cancelled', finished_at=datetime('now')
      WHERE id=?`).run(fixture.jobId)
    const executor = new ReplacementExecutor()
    const scheduler = new JobScheduler(db, executor)
    const orchestration = new OrchestrationService(db, scheduler, {
      materialize: async (workspace) => workspace,
    })
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime: new FakeAgentHomeRuntime(),
      orchestration,
      scheduler,
    })
    const dispatch = scheduler.tick.bind(scheduler)
    scheduler.tick = async () => {
      throw new Error('simulated scheduler tick failure')
    }

    const result = await lifecycle.run(fixture.sessionId, 'retry', {
      actor,
      idempotencyKey: 'session:retry',
    })
    expect((db.prepare(`SELECT status FROM agent_session_actions
      WHERE idempotency_key='session:retry'`).get() as { status: string }).status)
      .toBe('succeeded')
    expect(scheduler.get(result.created_session!.job_id!)?.status).toBe('queued')
    scheduler.tick = dispatch
    await scheduler.tick()
    const replay = await lifecycle.run(fixture.sessionId, 'retry', {
      actor,
      idempotencyKey: 'session:retry',
    })

    expect(result.created_session).toMatchObject({
      profile_id: fixture.profileId,
      conversation_id: fixture.conversationId,
      parent_session_id: fixture.sessionId,
      lineage_type: 'retry',
      control_state: 'active',
    })
    expect(result.created_session?.id).not.toBe(fixture.sessionId)
    expect(result.created_session?.job_id).not.toBe(fixture.jobId)
    expect(result.links).toMatchObject({
      profile_id: fixture.profileId,
      conversation_id: fixture.conversationId,
      session_id: result.created_session?.id,
      job_id: result.created_session?.job_id,
    })
    expect(replay.action.replayed).toBe(true)
    expect(replay.created_session?.id).toBe(result.created_session?.id)
    expect(executor.jobs).toHaveLength(1)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM agent_sessions
      WHERE parent_session_id=? AND lineage_type='retry'`).get(fixture.sessionId) as
      { count: number }).count).toBe(1)
  })

  it('recovers a pending retry after child creation without duplicating lineage', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const fixture = seedHome(db)
    db.prepare(`UPDATE agent_sessions SET status='stopped', control_state='stopped',
      ended_at=datetime('now') WHERE id=?`).run(fixture.sessionId)
    db.prepare(`UPDATE jobs SET status='cancelled', finished_at=datetime('now')
      WHERE id=?`).run(fixture.jobId)
    const executor = new ReplacementExecutor()
    const scheduler = new JobScheduler(db, executor)
    const orchestration = new OrchestrationService(db, scheduler, {
      materialize: async (workspace) => workspace,
    })
    const actionId = 'pending-retry-action'
    const idempotencyKey = 'session:retry:recover'
    const snapshot = orchestration.createCardJob({
      cardId: fixture.cardId,
      expectedBoardId: fixture.boardId,
      provider: 'codex',
      model: null,
      effort: null,
      accessProfile: 'read_only',
      workspaceId: fixture.workspaceId,
      priority: 0,
      maxAttempts: 1,
      budgetTokens: null,
      budgetCents: null,
      idempotencyKey: `agent-home-retry:${actionId}`,
    })
    if (!snapshot.session) throw new Error('recovery fixture did not reserve a child session')
    db.prepare(`UPDATE agent_sessions SET parent_session_id=?, lineage_type='retry',
      control_state='active' WHERE id=?`).run(fixture.sessionId, snapshot.session.id)
    new ConversationService(db).linkSession(snapshot.session.id, {
      profileId: fixture.profileId,
      conversationId: fixture.conversationId,
      jobId: snapshot.job.id,
      mode: 'managed',
      driverId: snapshot.job.driver_id,
      effort: null,
      accessProfile: 'read_only',
      actor,
      idempotencyKey: `agent-home-action:${actionId}:link`,
      correlationId: actionId,
    })
    db.prepare(`INSERT INTO agent_session_actions (
      id, board_id, session_id, result_session_id, idempotency_key, action,
      request_fingerprint, status, lease_id, actor_type, actor_id, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, 'retry', ?, 'pending', 'crashed-daemon', 'operator', ?,
      datetime('now'), datetime('now'))`).run(
      actionId,
      fixture.boardId,
      fixture.sessionId,
      idempotencyKey,
      canonicalHash({
        command: 'agent_session.retry',
        sessionId: fixture.sessionId,
      }),
      actor.id,
    )

    const recovered = await new AgentHomeLifecycleService(db, {
      runtime: new FakeAgentHomeRuntime(),
      orchestration,
      scheduler,
    }).run(fixture.sessionId, 'retry', {
      actor,
      idempotencyKey,
    })

    expect(recovered.created_session?.id).toBe(snapshot.session.id)
    expect(executor.jobs).toHaveLength(1)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM agent_sessions
      WHERE parent_session_id=? AND lineage_type='retry'`).get(fixture.sessionId) as
      { count: number }).count).toBe(1)
    expect((db.prepare(`SELECT status, result_session_id FROM agent_session_actions
      WHERE id=?`).get(actionId) as { status: string; result_session_id: string }))
      .toEqual({ status: 'succeeded', result_session_id: snapshot.session.id })
  })

  it('serializes different lifecycle mutations for the same session', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const fixture = seedHome(db)
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime: new FakeAgentHomeRuntime(),
      actionLeaseId: 'active-daemon',
    })
    db.prepare(`INSERT INTO agent_session_actions (
      id, board_id, session_id, result_session_id, idempotency_key, action,
      request_fingerprint, status, lease_id, actor_type, actor_id, created_at, updated_at
    ) VALUES ('pending-pause', ?, ?, NULL, 'pending:pause', 'pause', 'fingerprint',
      'pending', 'active-daemon', 'operator', 'controls-test', datetime('now'), datetime('now'))`)
      .run(fixture.boardId, fixture.sessionId)

    await expect(lifecycle.run(fixture.sessionId, 'rename', {
      actor,
      idempotencyKey: 'concurrent:rename',
      name: 'Must not win',
    })).rejects.toThrow(/already in progress/)
    expect(new ConversationService(db).requireSession(fixture.sessionId).display_name).toBeNull()
    expect(() => db.prepare(`INSERT INTO agent_session_actions (
      id, board_id, session_id, result_session_id, idempotency_key, action,
      request_fingerprint, status, lease_id, actor_type, actor_id, created_at, updated_at
    ) VALUES ('second-pending', ?, ?, NULL, 'pending:stop', 'stop', 'fingerprint-2',
      'pending', 'active-daemon', 'operator', 'controls-test', datetime('now'), datetime('now'))`)
      .run(fixture.boardId, fixture.sessionId)).toThrow(/UNIQUE constraint/)
  })

  it('keeps migration and action replay durable after database reopen', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-controls-reopen-'))
    const file = path.join(directory, 'orchestra.db')
    try {
      const db = openDb(file)
      const fixture = seedHome(db)
      const lifecycle = new AgentHomeLifecycleService(db, {
        actionLeaseId: 'daemon-before-crash',
      })
      const first = await lifecycle.run(fixture.sessionId, 'rename', {
        actor,
        idempotencyKey: 'reopen:rename',
        name: 'Durable name',
      })
      expect(first.action.replayed).toBe(false)
      db.prepare(`INSERT INTO agent_session_actions (
        id, board_id, session_id, result_session_id, idempotency_key, action,
        request_fingerprint, status, lease_id, actor_type, actor_id, created_at, updated_at
      ) VALUES (
        'interrupted-rename', ?, ?, NULL, 'reopen:interrupted-rename', 'rename', ?,
        'pending', 'daemon-before-crash', 'operator', 'controls-test', datetime('now'),
        datetime('now')
      )`).run(
        fixture.boardId,
        fixture.sessionId,
        canonicalHash({
          command: 'agent_session.rename',
          sessionId: fixture.sessionId,
          name: 'Interrupted name',
        }),
      )
      db.close()

      const reopened = openDb(file)
      applyAgentOsMigrations(reopened)
      applyAgentOsMigrations(reopened)
      const restartedLifecycle = new AgentHomeLifecycleService(reopened, {
        actionLeaseId: 'daemon-after-restart',
      })
      const replay = await restartedLifecycle.run(
        fixture.sessionId,
        'rename',
        {
          actor,
          idempotencyKey: 'reopen:rename',
          name: 'Durable name',
        },
      )
      expect(replay.action.replayed).toBe(true)
      expect(replay.session).toMatchObject({
        display_name: 'Durable name',
        control_state: 'active',
      })
      await expect(restartedLifecycle.run(fixture.sessionId, 'rename', {
        actor,
        idempotencyKey: 'reopen:interrupted-rename',
        name: 'Interrupted name',
      })).rejects.toThrow(/interrupted by a daemon restart/)
      const replacement = await restartedLifecycle.run(fixture.sessionId, 'rename', {
        actor,
        idempotencyKey: 'reopen:replacement-rename',
        name: 'Recovered name',
      })
      expect(replacement.session.display_name).toBe('Recovered name')
      expect((reopened.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations`)
        .get() as { count: number }).count).toBe(12)
      expect((reopened.prepare(`SELECT status FROM agent_session_actions
        WHERE idempotency_key='reopen:rename'`).get() as { status: string }).status)
        .toBe('succeeded')
      expect(reopened.prepare(`SELECT status, error_code FROM agent_session_actions
        WHERE idempotency_key='reopen:interrupted-rename'`).get()).toEqual({
        status: 'failed',
        error_code: 'action_interrupted',
      })
      expect((reopened.prepare(`SELECT COUNT(*) AS count FROM os_events
        WHERE kind='agent_session.action_interrupted'`).get() as { count: number }).count).toBe(1)
      const columns = reopened.prepare(`PRAGMA table_info(agent_sessions)`).all() as
        Array<{ name: string }>
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'display_name',
        'parent_session_id',
        'lineage_type',
        'control_state',
      ]))
      reopened.close()
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

function seedHome(db: Database.Database): {
  boardId: number
  cardId: number
  workspaceId: string
  processId: string
  sessionId: string
  jobId: string
  profileId: string
  conversationId: string
  artifactId: string
} {
  const boardId = Number(db.prepare(
    `INSERT INTO boards (project_path, name) VALUES ('/agent-home-controls', 'Controls')`,
  ).run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards
    (board_id, title, description) VALUES (?, 'Agent Home controls', 'exercise controls')`)
    .run(boardId).lastInsertRowid)
  const workspaceId = 'controls-workspace'
  db.prepare(`INSERT INTO workspaces
    (id, board_id, card_id, name, kind, root_path, status)
    VALUES (?, ?, ?, 'Controls workspace', 'shared', '/agent-home-controls', 'active')`)
    .run(workspaceId, boardId, cardId)
  const processId = 'controls-process'
  db.prepare(`INSERT INTO processes
    (id, workspace_id, name, command, cwd, status, restartable)
    VALUES (?, ?, 'terminal', 'npm test', '/agent-home-controls', 'running', 1)`)
    .run(processId, workspaceId)
  const jobId = 'controls-job'
  db.prepare(`INSERT INTO jobs
    (id, board_id, card_id, workspace_id, provider, driver_id, access_profile,
      priority, status, max_attempts)
    VALUES (?, ?, ?, ?, 'codex', 'codex', 'read_only', 0, 'running', 1)`)
    .run(jobId, boardId, cardId, workspaceId)
  const sessionId = 'controls-session'
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, external_id, status, context_json)
    VALUES (?, ?, 'codex', 'thread-controls', 'running', ?)`).run(
    sessionId,
    workspaceId,
    JSON.stringify({ job_id: jobId }),
  )
  const profiles = new AgentProfileService(db)
  const profile = profiles.create({
    boardId,
    name: 'Controls agent',
    defaultProvider: 'codex',
    actor,
    idempotencyKey: 'controls:profile',
  })
  const conversations = new ConversationService(db)
  const conversation = conversations.listConversations(profile.id)[0]
  conversations.linkSession(sessionId, {
    profileId: profile.id,
    conversationId: conversation.id,
    jobId,
    mode: 'managed',
    driverId: 'codex',
    providerThreadId: 'thread-controls',
    recoveryState: 'attachable',
    historyState: 'complete',
    accessProfile: 'read_only',
    actor,
    idempotencyKey: 'controls:link',
  })
  db.prepare(`UPDATE agent_conversations SET title=? WHERE id=?`).run(
    'Release password=top-secret-value',
    conversation.id,
  )
  const artifact = new ArtifactStore(db).create({
    boardId,
    workspaceId,
    cardId,
    kind: 'provider_raw_event',
    name: 'raw-event.json',
    mimeType: 'application/json',
    content: 'RAW_ARTIFACT_MUST_NOT_LEAK',
  })
  return {
    boardId,
    cardId,
    workspaceId,
    processId,
    sessionId,
    jobId,
    profileId: profile.id,
    conversationId: conversation.id,
    artifactId: artifact.id,
  }
}

function appendTranscriptFixture(
  db: Database.Database,
  fixture: ReturnType<typeof seedHome>,
): {
  assistantId: string
  toolId: string
  statusId: string
} {
  const conversations = new ConversationService(db)
  const assistant = conversations.appendEvent(fixture.sessionId, {
    idempotencyKey: 'controls:event:assistant',
    dedupeKey: 'controls:provider:assistant',
    kind: 'assistant',
    providerEventId: 'provider-event-1',
    providerThreadId: 'thread-controls',
    providerCursor: 'cursor-1',
    projectedText: 'Deploy alpha using sk-secret-token-1234567890',
    metadata: {
      status: 'ready',
      api_key: 'top-secret-value',
    },
    rawArtifactId: fixture.artifactId,
    actor: { type: 'agent', id: 'codex-worker' },
  }).event
  const tool = conversations.appendEvent(fixture.sessionId, {
    idempotencyKey: 'controls:event:tool',
    dedupeKey: 'controls:provider:tool',
    kind: 'tool',
    providerEventId: 'provider-event-2',
    providerThreadId: 'thread-controls',
    providerCursor: 'cursor-2',
    projectedText: 'npm test',
    metadata: {
      tool: 'terminal',
      status: 'succeeded',
      authorization: 'Bearer secret-token-1234567890',
      process_id: fixture.processId,
      apiKey: 'CAMEL_API_KEY_MUST_NOT_LEAK',
      accessToken: 'CAMEL_ACCESS_TOKEN_MUST_NOT_LEAK',
      privateKey: 'CAMEL_PRIVATE_KEY_MUST_NOT_LEAK',
      rawResponse: 'CAMEL_RAW_RESPONSE_MUST_NOT_LEAK',
      'set-cookie': 'SET_COOKIE_MUST_NOT_LEAK',
    },
    actor: { type: 'agent', id: 'codex-worker' },
  }).event
  const status = conversations.appendEvent(fixture.sessionId, {
    idempotencyKey: 'controls:event:status',
    dedupeKey: 'controls:provider:status',
    kind: 'status',
    providerEventId: 'provider-event-3',
    projectedText: 'Sensitive retained status',
    metadata: { status: 'failed' },
    redactionState: 'withheld',
    actor: { type: 'system', id: 'retention' },
  }).event
  db.prepare('UPDATE conversation_events SET created_at=? WHERE id=?')
    .run('2026-07-24T10:00:00.000Z', assistant.id)
  db.prepare('UPDATE conversation_events SET created_at=? WHERE id=?')
    .run('2026-07-24T11:00:00.000Z', tool.id)
  db.prepare('UPDATE conversation_events SET created_at=? WHERE id=?')
    .run('2026-07-24T12:00:00.000Z', status.id)
  return {
    assistantId: assistant.id,
    toolId: tool.id,
    statusId: status.id,
  }
}

function sessionAction(
  server: FastifyInstance,
  sessionId: string,
  action: 'resume' | 'pause' | 'stop' | 'retry' | 'fork' | 'archive',
  idempotencyKey: string,
) {
  return server.inject({
    method: 'POST',
    url: `/api/v1/os/sessions/${sessionId}/${action}`,
    headers: { ...operatorHeaders, 'idempotency-key': idempotencyKey },
  })
}

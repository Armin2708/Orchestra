import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { AgentHomeClaudeNativeEventSink } from '../src/agent-os/claude-native-events.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import {
  ConversationService,
  type ConversationEvent,
} from '../src/agent-os/conversations.js'
import { Conductor } from '../src/conductor.js'
import { openDb } from '../src/db.js'
import {
  ClaudeAgentDriverAdapter,
  type ClaudeAgentHomeBinding,
  type ClaudeNativeEvent,
} from '../src/runtime/drivers/claude.js'
import { claudeNativePayloads } from './fixtures/claude-native-events.js'

const actor = { type: 'operator', id: 'claude-native-test' } as const
const databases = new Set<Database.Database>()
const tempDirectories: string[] = []
let scopeSequence = 0
let captureSequence = 0

type Scope = {
  db: Database.Database
  boardId: number
  workspaceId: string
  agentId: number
  agentName: string
  sessionId: string
  profileId: string
  conversationId: string
  binding: ClaudeAgentHomeBinding
  conversations: ConversationService
  sink: AgentHomeClaudeNativeEventSink
}

type NativeEventInput = {
  kind: ClaudeNativeEvent['kind']
  direction: ClaudeNativeEvent['direction']
  payload: unknown
  captureId?: string
  providerSessionId?: string | null
  resumed?: boolean
  explicitBinding?: boolean
  at?: string
}

function createScope(
  database = ':memory:',
  sinkOptions: ConstructorParameters<typeof AgentHomeClaudeNativeEventSink>[2] = {},
): Scope {
  const db = openDb(database)
  databases.add(db)
  const suffix = ++scopeSequence
  const projectPath = `/claude-native-${suffix}`
  const boardId = Number(db.prepare(
    'INSERT INTO boards (project_path, name) VALUES (?, ?)',
  ).run(projectPath, `claude-native-${suffix}`).lastInsertRowid)
  const workspaceId = `claude-native-workspace-${suffix}`
  db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, 'Claude native', 'shared', ?, 'active')`)
    .run(workspaceId, boardId, projectPath)
  const agentName = `claude-native-${suffix}`
  const agentId = Number(db.prepare(`INSERT INTO agents
    (board_id, name, kind, provider, status)
    VALUES (?, ?, 'hired', 'claude', 'active')`)
    .run(boardId, agentName).lastInsertRowid)
  const sessionId = `claude-native-session-${suffix}`
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, agent_id, provider, external_id, model, status, context_json)
    VALUES (?, ?, ?, 'claude', NULL, 'claude-test', 'running', '{}')`)
    .run(sessionId, workspaceId, agentId)

  const profiles = new AgentProfileService(db)
  const profile = profiles.create({
    boardId,
    name: `Claude native profile ${suffix}`,
    defaultProvider: 'claude',
    defaultModel: 'claude-test',
    defaultAccessProfile: 'workspace_write',
    actor,
    idempotencyKey: `claude-native:${suffix}:profile`,
  })
  const conversations = new ConversationService(db)
  const conversation = conversations.listConversations(profile.id)[0]
  conversations.linkSession(sessionId, {
    profileId: profile.id,
    conversationId: conversation.id,
    mode: 'managed',
    driverId: 'claude',
    accessProfile: 'workspace_write',
    recoveryState: 'unknown',
    historyState: 'unavailable',
    actor,
    idempotencyKey: `claude-native:${suffix}:link`,
  })
  const binding = {
    agentHomeSessionId: sessionId,
    agentProfileId: profile.id,
    agentConversationId: conversation.id,
  }
  return {
    db,
    boardId,
    workspaceId,
    agentId,
    agentName,
    sessionId,
    profileId: profile.id,
    conversationId: conversation.id,
    binding,
    conversations,
    sink: new AgentHomeClaudeNativeEventSink(db, conversations, sinkOptions),
  }
}

function reopenedScope(previous: Scope, db: Database.Database): Scope {
  const conversations = new ConversationService(db)
  return {
    ...previous,
    db,
    conversations,
    sink: new AgentHomeClaudeNativeEventSink(db, conversations),
  }
}

function closeDb(db: Database.Database): void {
  if (!databases.delete(db)) return
  db.close()
}

function nativeEvent(scope: Scope, input: NativeEventInput): ClaudeNativeEvent {
  const payload = input.payload && typeof input.payload === 'object'
    ? input.payload as Record<string, unknown> : {}
  const payloadSessionId = typeof payload.session_id === 'string' ? payload.session_id : null
  const payloadUuid = typeof payload.uuid === 'string' ? payload.uuid : null
  return {
    captureId: input.captureId ?? payloadUuid ?? `capture-${++captureSequence}`,
    agentId: scope.agentId,
    agentName: scope.agentName,
    ...(input.explicitBinding === false ? {} : { agentHome: scope.binding }),
    kind: input.kind,
    direction: input.direction,
    at: input.at ?? '2026-07-24T10:00:00.000Z',
    providerSessionId: input.providerSessionId === undefined
      ? payloadSessionId : input.providerSessionId,
    resumed: input.resumed === true,
    payload: input.payload,
  }
}

function append(scope: Scope, input: NativeEventInput): void {
  scope.sink.append(nativeEvent(scope, input))
}

function events(scope: Scope): ConversationEvent[] {
  return scope.conversations.listEvents(scope.conversationId, { limit: 500 })
}

function fakeSdkSession() {
  const messages: unknown[] = []
  let notify: (() => void) | null = null
  let closed = false
  const wake = () => {
    notify?.()
    notify = null
  }
  return {
    emit(message: unknown) {
      messages.push(message)
      wake()
    },
    close() {
      closed = true
      wake()
    },
    query: {
      interrupt: vi.fn(async () => {}),
      supportedCommands: vi.fn(async () => []),
      supportedModels: vi.fn(async () => []),
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (messages.length) yield messages.shift()
          if (closed) return
          await new Promise<void>((resolve) => { notify = resolve })
        }
      },
    },
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition never became true')
}

beforeEach(() => {
  vi.mocked(query).mockReset()
})

afterEach(() => {
  for (const db of [...databases]) closeDb(db)
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Claude provider-native Agent Home capture', () => {
  it('normalizes native fixtures to the provider-neutral Agent Home parity contract', () => {
    const scope = createScope()
    append(scope, {
      kind: 'session_start',
      direction: 'lifecycle',
      captureId: 'claude-capture-start',
      providerSessionId: null,
      payload: {
        model: 'claude-test',
        effort: 'high',
        permission_mode: 'acceptEdits',
        access_profile: 'workspace_write',
      },
    })
    append(scope, {
      kind: 'outbound_user',
      direction: 'outbound',
      captureId: 'claude-outbound-1',
      providerSessionId: null,
      payload: { text: 'Inspect the repository', source: 'orchestra', notification_ids: [7] },
    })
    append(scope, { kind: 'provider_message', direction: 'inbound', payload: claudeNativePayloads.init })
    append(scope, { kind: 'provider_message', direction: 'inbound', payload: claudeNativePayloads.assistant })
    append(scope, { kind: 'provider_message', direction: 'inbound', payload: claudeNativePayloads.toolResult })
    append(scope, {
      kind: 'approval_request',
      direction: 'inbound',
      captureId: 'approval:claude-approval-request:request',
      providerSessionId: 'claude-session-native',
      payload: {
        request_id: 'claude-approval-request',
        tool_use_id: 'claude-tool-approval',
        tool_name: 'Write',
        input: { file_path: '/claude-native/file.ts' },
      },
    })
    append(scope, {
      kind: 'approval_response',
      direction: 'outbound',
      captureId: 'approval:claude-approval-request:response',
      providerSessionId: 'claude-session-native',
      payload: {
        request_id: 'claude-approval-request',
        tool_use_id: 'claude-tool-approval',
        tool_name: 'Write',
        behavior: 'allow',
        source: 'operator',
      },
    })
    append(scope, { kind: 'provider_message', direction: 'inbound', payload: claudeNativePayloads.result })
    append(scope, { kind: 'provider_message', direction: 'inbound', payload: claudeNativePayloads.retryError })
    append(scope, {
      kind: 'error',
      direction: 'inbound',
      captureId: 'claude-stream-error',
      providerSessionId: 'claude-session-native',
      payload: { name: 'Error', message: 'transport closed unexpectedly' },
    })
    append(scope, {
      kind: 'session_end',
      direction: 'lifecycle',
      captureId: 'claude-capture-end',
      providerSessionId: 'claude-session-native',
      payload: { handoff: true, limit_hit: false, outcome: 'success', reason: null },
    })

    const captured = events(scope)
    expect(captured.map((event) => event.kind)).toEqual([
      'status',
      'user',
      'system',
      'assistant',
      'system',
      'tool',
      'tool_result',
      'approval',
      'approval',
      'status',
      'usage',
      'approval',
      'error',
      'error',
      'status',
    ])
    expect(captured.map((event) => event.sequence)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    )
    expect(captured.every((event) =>
      event.provider === 'claude'
      && event.dedupe_key.startsWith(`claude-native:${scope.sessionId}:`)
      && event.content_hash.length === 64
      && event.metadata.provider_native === true
      && event.metadata.provider_native_schema === 'claude-agent-sdk-message'
      && event.raw_artifact_id === null
      && event.schema_version === 1)).toBe(true)

    const assistant = captured.find((event) => event.kind === 'assistant')!
    expect(assistant).toMatchObject({
      provider_event_id: 'claude-event-assistant',
      provider_thread_id: 'claude-session-native',
      provider_turn_id: 'claude-message-1',
      projected_text: 'I will inspect the repository.',
    })
    expect(assistant.metadata).toMatchObject({
      native_request_id: 'claude-request-1',
      native_message_id: 'claude-message-1',
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
        output_tokens: 30,
      },
      raw_payload_state: 'withheld',
    })
    const thinking = captured.find((event) =>
      event.metadata.native_block_type === 'thinking')!
    expect(thinking).toMatchObject({ projected_text: null, redaction_state: 'withheld' })
    expect(JSON.stringify(thinking)).not.toContain('private chain of thought')

    const tool = captured.find((event) => event.kind === 'tool')!
    expect(tool).toMatchObject({
      provider_event_id: 'claude-event-assistant',
      provider_turn_id: 'claude-message-1',
      provider_item_id: 'claude-tool-1',
      projected_text: 'Bash(git status --short)',
    })
    expect(captured.find((event) => event.kind === 'tool_result')).toMatchObject({
      provider_event_id: 'claude-event-tool-result',
      provider_item_id: 'claude-tool-1',
      projected_text: 'working tree clean',
    })

    const approvalRequest = captured.find((event) =>
      event.metadata.approval_phase === 'request')!
    const approvalResponse = captured.find((event) =>
      event.metadata.approval_phase === 'response')!
    expect(approvalRequest).toMatchObject({ provider_item_id: 'claude-tool-approval' })
    expect(approvalRequest.metadata).toMatchObject({
      native_request_id: 'claude-approval-request',
      request_id: 'claude-approval-request',
      tool_use_id: 'claude-tool-approval',
    })
    expect(approvalResponse.metadata).toMatchObject({
      native_request_id: 'claude-approval-request',
      behavior: 'allow',
      decision_source: 'operator',
    })

    const usage = captured.find((event) => event.kind === 'usage')!
    expect(usage.metadata).toMatchObject({
      total_cost_usd: 0.014,
      usage: { input_tokens: 120, output_tokens: 55 },
      model_usage: { 'claude-test': { costUSD: 0.014, contextWindow: 200_000 } },
    })
    const resultDenial = captured.find((event) =>
      event.metadata.approval_phase === 'result_denial')!
    expect(resultDenial).toMatchObject({ provider_item_id: 'claude-tool-denied' })
    expect(resultDenial.metadata).toMatchObject({
      tool_name: 'Write',
      tool_use_id: 'claude-tool-denied',
    })
    const retry = captured.find((event) =>
      event.provider_event_id === 'claude-event-retry')!
    expect(retry).toMatchObject({ kind: 'error', projected_text: 'overloaded' })
    expect(retry.metadata).toMatchObject({
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 1_000,
      error_status: 529,
    })

    expect(scope.conversations.requireSession(scope.sessionId)).toMatchObject({
      provider_thread_id: 'claude-session-native',
      recovery_state: 'detached',
      history_state: 'complete',
    })
  })

  it('appends a provider UUID or local outbound capture exactly once on replay', () => {
    const scope = createScope()
    append(scope, {
      kind: 'provider_message',
      direction: 'inbound',
      payload: claudeNativePayloads.assistant,
      at: '2026-07-24T10:00:00.000Z',
    })
    append(scope, {
      kind: 'provider_message',
      direction: 'inbound',
      payload: claudeNativePayloads.assistant,
      resumed: true,
      at: '2026-07-24T10:30:00.000Z',
    })
    const outbound: NativeEventInput = {
      kind: 'outbound_user',
      direction: 'outbound',
      captureId: 'claude-outbound-replay',
      providerSessionId: 'claude-session-native',
      payload: { text: 'Same outbound prompt', source: 'orchestra', notification_ids: [] },
    }
    append(scope, outbound)
    append(scope, { ...outbound, at: '2026-07-24T10:31:00.000Z' })
    const messageIdentityOnly = structuredClone(claudeNativePayloads.assistant)
    delete (messageIdentityOnly as { uuid?: string }).uuid
    messageIdentityOnly.message.id = 'claude-message-without-event-uuid'
    append(scope, {
      kind: 'provider_message',
      direction: 'inbound',
      captureId: 'claude-message-fallback-first',
      payload: messageIdentityOnly,
    })
    append(scope, {
      kind: 'provider_message',
      direction: 'inbound',
      captureId: 'claude-message-fallback-replayed',
      payload: messageIdentityOnly,
      at: '2026-07-24T10:32:00.000Z',
    })

    expect(events(scope)).toHaveLength(7)
    expect(events(scope).filter((event) =>
      event.metadata.replay_identity_state === 'provider_message_id')).toHaveLength(3)
    expect((scope.db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE kind='conversation.event_appended'`).get() as { count: number }).count).toBe(7)
    expect((scope.db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_event_conflicts',
    ).get() as { count: number }).count).toBe(0)
  })

  it('stores redacted raw artifacts with provenance without leaking secrets', () => {
    const scope = createScope(':memory:', { rawArtifactMode: 'redacted' })
    const secret = 'sk-ant-1234567890ABCDEF'
    const outbound: NativeEventInput = {
      kind: 'outbound_user',
      direction: 'outbound',
      captureId: 'claude-redacted-outbound',
      providerSessionId: null,
      payload: {
        text: `Use ${secret} with Bearer top.secret.value`,
        source: 'orchestra',
        api_key: secret,
        notification_ids: [],
      },
    }
    append(scope, outbound)
    append(scope, { ...outbound, at: '2026-07-24T11:00:00.000Z' })

    const captured = events(scope)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      projected_text: 'Use [REDACTED] with Bearer [REDACTED]',
      redaction_state: 'redacted',
    })
    expect(captured[0].raw_artifact_id).toMatch(/^[0-9a-f-]{36}$/)
    const artifact = scope.db.prepare(
      'SELECT kind, mime_type, content, metadata FROM artifacts WHERE id=?',
    ).get(captured[0].raw_artifact_id) as {
      kind: string
      mime_type: string
      content: string
      metadata: string
    }
    expect(artifact).toMatchObject({
      kind: 'provider_event',
      mime_type: 'application/json',
    })
    expect(artifact.content).toContain('[REDACTED]')
    expect(artifact.content).not.toContain(secret)
    expect(artifact.content).not.toContain('top.secret.value')
    expect(JSON.parse(artifact.metadata)).toMatchObject({
      provider: 'claude',
      source: '@anthropic-ai/claude-agent-sdk',
      source_kind: 'outbound_user',
      direction: 'outbound',
      redaction_state: 'redacted',
    })
    expect((scope.db.prepare(
      "SELECT COUNT(*) AS count FROM artifacts WHERE kind='provider_event'",
    ).get() as { count: number }).count).toBe(1)
  })

  it('reopens the same conversation on restart and honestly marks the resume gap', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-native-restart-'))
    tempDirectories.push(directory)
    const database = path.join(directory, 'orchestra.db')
    const first = createScope(database)
    append(first, {
      kind: 'session_start',
      direction: 'lifecycle',
      captureId: 'claude-first-start',
      providerSessionId: null,
      payload: { model: 'claude-test' },
    })
    append(first, { kind: 'provider_message', direction: 'inbound', payload: claudeNativePayloads.init })
    append(first, { kind: 'provider_message', direction: 'inbound', payload: claudeNativePayloads.assistant })
    expect(events(first)).toHaveLength(5)
    const durableConversationId = first.conversationId
    const durableSessionId = first.sessionId
    closeDb(first.db)

    const reopenedDb = openDb(database)
    databases.add(reopenedDb)
    const second = reopenedScope(first, reopenedDb)
    append(second, {
      kind: 'session_start',
      direction: 'lifecycle',
      captureId: 'claude-resumed-start',
      providerSessionId: 'claude-session-native',
      resumed: true,
      explicitBinding: false,
      at: '2026-07-24T12:00:00.000Z',
      payload: { model: 'claude-test', resume_requested: true },
    })
    append(second, {
      kind: 'provider_message',
      direction: 'inbound',
      payload: claudeNativePayloads.assistant,
      resumed: true,
      explicitBinding: false,
    })
    append(second, {
      kind: 'provider_message',
      direction: 'inbound',
      payload: claudeNativePayloads.init,
      resumed: true,
      explicitBinding: false,
    })
    append(second, {
      kind: 'provider_message',
      direction: 'inbound',
      payload: claudeNativePayloads.result,
      resumed: true,
      explicitBinding: false,
    })

    expect(second.conversationId).toBe(durableConversationId)
    expect(second.sessionId).toBe(durableSessionId)
    const reopenedEvents = events(second)
    expect(reopenedEvents).toHaveLength(9)
    expect(reopenedEvents.map((event) => event.sequence)).toEqual(
      Array.from({ length: 9 }, (_, index) => index + 1),
    )
    expect(reopenedEvents.filter((event) =>
      event.provider_event_id === 'claude-event-assistant')).toHaveLength(3)
    expect(reopenedEvents.filter((event) =>
      event.provider_event_id === 'claude-event-init')).toHaveLength(1)
    const session = second.conversations.requireSession(durableSessionId)
    expect(session).toMatchObject({
      provider_thread_id: 'claude-session-native',
      recovery_state: 'attachable',
      history_state: 'partial',
    })
    expect(session.recovery).toMatchObject({
      native_capture: {
        provider: 'claude',
        resume_requested: true,
        resume_session_id: 'claude-session-native',
        gap: {
          state: 'possible',
          reason: 'claude_resume_has_no_transport_event_cursor',
          detected_at: '2026-07-24T12:00:00.000Z',
        },
      },
    })
  })

  it('persists every SDK event before the Conductor drops bounded transcript lines', async () => {
    const scope = createScope()
    const sdk = fakeSdkSession()
    vi.mocked(query).mockReturnValue(sdk.query as ReturnType<typeof query>)
    const conductor = new Conductor(
      scope.db,
      new EventEmitter(),
      undefined,
      { nativeEventSink: scope.sink },
    )
    const driver = new ClaudeAgentDriverAdapter({ conductor, pollIntervalMs: 25 })
    await driver.launch({
      workspaceId: scope.workspaceId,
      boardId: scope.boardId,
      cwd: `/claude-native-${scopeSequence}`,
      name: scope.agentName,
      prompt: 'Capture every event',
      metadata: {
        agentHomeSessionId: scope.sessionId,
        agentProfileId: scope.profileId,
        agentConversationId: scope.conversationId,
      },
    })
    sdk.emit(claudeNativePayloads.init)
    for (let index = 0; index < 520; index += 1) {
      sdk.emit({
        type: 'assistant',
        uuid: `claude-overflow-${index}`,
        session_id: 'claude-session-native',
        request_id: `claude-overflow-request-${index}`,
        message: {
          id: `claude-overflow-message-${index}`,
          role: 'assistant',
          model: 'claude-test',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: `durable line ${index}` }],
        },
      })
    }
    await until(() => (scope.db.prepare(`SELECT COUNT(*) AS count
      FROM conversation_events WHERE conversation_id=? AND kind='assistant'`)
      .get(scope.conversationId) as { count: number }).count === 520)

    expect(conductor.transcript(scope.agentId).lines).toHaveLength(500)
    expect((scope.db.prepare(`SELECT COUNT(*) AS count FROM conversation_events
      WHERE conversation_id=?`).get(scope.conversationId) as { count: number }).count).toBe(523)
    expect((scope.db.prepare(`SELECT MIN(sequence) AS minimum, MAX(sequence) AS maximum
      FROM conversation_events WHERE conversation_id=? AND kind='assistant'`)
      .get(scope.conversationId) as { minimum: number; maximum: number })).toEqual({
      minimum: 4,
      maximum: 523,
    })

    sdk.close()
    await until(() => !conductor.isHired(scope.agentId))
    expect((scope.db.prepare(`SELECT COUNT(*) AS count FROM conversation_events
      WHERE conversation_id=?`).get(scope.conversationId) as { count: number }).count).toBe(524)
  })

  it('captures exact SDK approval request and operator response identities', async () => {
    const scope = createScope()
    const sdk = fakeSdkSession()
    let queryInput: {
      options: {
        canUseTool: (
          toolName: string,
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<unknown>
      }
    } | null = null
    vi.mocked(query).mockImplementation(((input: typeof queryInput) => {
      queryInput = input
      return sdk.query
    }) as typeof query)
    const conductor = new Conductor(
      scope.db,
      new EventEmitter(),
      undefined,
      { nativeEventSink: scope.sink },
    )
    const agent = conductor.hire({
      boardId: scope.boardId,
      cwd: `/claude-native-${scopeSequence}`,
      name: scope.agentName,
      permissionMode: 'acceptEdits',
      agentHome: scope.binding,
    })
    const approval = queryInput!.options.canUseTool(
      'Write',
      { file_path: '/claude-native/file.ts', content: 'durable' },
      {
        toolUseID: 'claude-live-tool-approval',
        requestId: 'claude-live-request-approval',
        title: 'Claude wants to write file.ts',
        agentID: 'claude-subagent-1',
        signal: new AbortController().signal,
      },
    )
    expect(conductor.resolvePermission(
      agent.id,
      'claude-live-tool-approval',
      'allow',
      'approved in Agent Home',
    )).toBe(true)
    await expect(approval).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/claude-native/file.ts', content: 'durable' },
    })

    const approvals = events(scope).filter((event) => event.kind === 'approval')
    expect(approvals).toHaveLength(2)
    expect(approvals[0]).toMatchObject({
      provider_item_id: 'claude-live-tool-approval',
      actor_type: 'provider',
    })
    expect(approvals[0].metadata).toMatchObject({
      native_request_id: 'claude-live-request-approval',
      request_id: 'claude-live-request-approval',
      tool_use_id: 'claude-live-tool-approval',
      approval_phase: 'request',
    })
    expect(approvals[1]).toMatchObject({
      provider_item_id: 'claude-live-tool-approval',
      actor_type: 'system',
    })
    expect(approvals[1].metadata).toMatchObject({
      native_request_id: 'claude-live-request-approval',
      behavior: 'allow',
      decision_source: 'operator',
      approval_phase: 'response',
    })

    sdk.close()
    await until(() => !conductor.isHired(scope.agentId))
  })

  it('marks the durable session lost instead of silently accepting a changed provider replay', () => {
    const scope = createScope()
    append(scope, {
      kind: 'provider_message',
      direction: 'inbound',
      payload: claudeNativePayloads.assistant,
    })
    const changed = structuredClone(claudeNativePayloads.assistant)
    changed.message.content[0].text = 'Different content under the same provider UUID'
    expect(() => append(scope, {
      kind: 'provider_message',
      direction: 'inbound',
      payload: changed,
      at: '2026-07-24T13:00:00.000Z',
    })).toThrow(/conflicts with an existing dedupe key/)

    expect(events(scope)).toHaveLength(3)
    expect((scope.db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_event_conflicts',
    ).get() as { count: number }).count).toBe(1)
    const session = scope.conversations.requireSession(scope.sessionId)
    expect(session).toMatchObject({ recovery_state: 'lost', history_state: 'partial' })
    expect(session.recovery).toMatchObject({
      native_capture: {
        gap: {
          state: 'confirmed',
          reason: 'native_event_persistence_failed',
          event_kind: 'provider_message',
          capture_id: 'claude-event-assistant',
        },
      },
    })
  })
})

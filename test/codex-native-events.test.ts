import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHomeCodexNativeEventSink } from '../src/agent-os/codex-native-events.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { ConversationService } from '../src/agent-os/conversations.js'
import { CODEX_REQUEST_UNHANDLED } from '../src/codex/client.js'
import type {
  CodexServerNotification,
  CodexServerRequest,
  CodexThread,
  CodexThreadStartResponse,
} from '../src/codex/protocol.js'
import type { CodexRuntimeService } from '../src/codex/service.js'
import type { CodexUnsubscribe } from '../src/codex/transport.js'
import {
  bindCodexAgentHomeForThread,
  codexAgentHomeForThread,
} from '../src/daemon.js'
import { openDb } from '../src/db.js'
import {
  CodexAgentDriver,
  type CodexNativeEvent,
  type CodexNativeEventSink,
} from '../src/runtime/drivers/codex.js'
import type { DriverEvent } from '../src/runtime/types.js'
import { codexNativeNotifications } from './fixtures/codex-native-notifications.js'

const actor = { type: 'operator', id: 'codex-native-test' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const nativeId = (params: Record<string, unknown>, direct: string, nested: string): string | null => {
  if (typeof params[direct] === 'string') return params[direct]
  const container = params[nested]
  return isRecord(container) && typeof container.id === 'string' ? container.id : null
}

type NativeScope = {
  db: Database.Database
  conversations: ConversationService
  sink: AgentHomeCodexNativeEventSink
  binding: Pick<CodexNativeEvent, 'agentHomeSessionId' | 'agentProfileId' | 'agentConversationId'>
}

const createScope = (): NativeScope => {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/codex-native', 'codex-native')",
  ).run().lastInsertRowid)
  const workspaceId = 'workspace-codex-native'
  const sessionId = 'session-codex-native'
  db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, 'codex-native', 'shared', '/codex-native', 'active')`)
    .run(workspaceId, boardId)
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, external_id, model, status, context_json)
    VALUES (?, ?, 'codex', 'thread-native-1', 'gpt-test', 'running', '{}')`)
    .run(sessionId, workspaceId)
  const profiles = new AgentProfileService(db)
  const conversations = new ConversationService(db)
  const profile = profiles.create({
    boardId,
    name: 'Codex native agent',
    defaultProvider: 'codex',
    actor,
    idempotencyKey: 'codex-native-profile',
  })
  const conversation = conversations.listConversations(profile.id)[0]
  conversations.linkSession(sessionId, {
    profileId: profile.id,
    conversationId: conversation.id,
    mode: 'managed',
    driverId: 'codex',
    providerThreadId: 'thread-native-1',
    recoveryState: 'attachable',
    historyState: 'complete',
    actor,
    idempotencyKey: 'codex-native-session-link',
  })
  return {
    db,
    conversations,
    sink: new AgentHomeCodexNativeEventSink(db, conversations),
    binding: {
      agentHomeSessionId: sessionId,
      agentProfileId: profile.id,
      agentConversationId: conversation.id,
    },
  }
}

const capture = (
  binding: NativeScope['binding'],
  notification: CodexServerNotification,
  captureCursor = 'orchestra-codex:1',
): CodexNativeEvent => {
  const params = isRecord(notification.params) ? notification.params : {}
  const threadId = nativeId(params, 'threadId', 'thread')
  if (!threadId) throw new Error('fixture requires a thread identity')
  return {
    ...binding,
    captureCursor,
    threadId,
    turnId: nativeId(params, 'turnId', 'turn'),
    itemId: nativeId(params, 'itemId', 'item'),
    method: notification.method,
    params: notification.params,
    receivedAt: notification.receivedAt,
  }
}

describe('Agent Home Codex native event capture', () => {
  it('preserves native identity, replays exact duplicates, and retains changed-content conflicts', () => {
    const scope = createScope()
    try {
      const original = capture(scope.binding, codexNativeNotifications.assistantCompleted)
      scope.sink.append(original)
      scope.sink.append(original)

      const events = scope.conversations.listSessionEvents(scope.binding.agentHomeSessionId)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        sequence: 1,
        provider: 'codex',
        provider_thread_id: 'thread-native-1',
        provider_turn_id: 'turn-native-1',
        provider_item_id: 'message-native-final',
        kind: 'assistant',
        projected_text: 'Canonical final answer',
        raw_artifact_id: null,
        redaction_state: 'none',
        metadata: {
          native_method: 'item/completed',
          raw_payload_state: 'withheld',
          replay_identity_state: 'native_structural',
          item_type: 'agentMessage',
          item_phase: 'completed',
        },
      })
      expect(events[0].provider_event_id).toMatch(/^codex:[a-f0-9]{64}$/)

      expect(() => scope.sink.append(capture(
        scope.binding,
        codexNativeNotifications.assistantCompletedChanged,
      ))).toThrow(/conflicts with an existing dedupe key/)
      expect((scope.db.prepare(
        'SELECT COUNT(*) AS count FROM conversation_event_conflicts',
      ).get() as { count: number }).count).toBe(1)
      expect(scope.db.prepare(`SELECT received_projected_text
        FROM conversation_event_conflicts`).get()).toEqual({
        received_projected_text: 'Conflicting final answer',
      })
      expect(scope.conversations.listSessionEvents(scope.binding.agentHomeSessionId)).toHaveLength(1)
    } finally {
      scope.db.close()
    }
  })

  it('keeps safe projections visible, redacts credentials, and withholds reasoning text', () => {
    const scope = createScope()
    try {
      const credential = 'sk-abcdefghijklmnopqrstuvwxyz123456'
      scope.sink.append(capture(scope.binding, {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-native-1',
          turnId: 'turn-native-redaction',
          itemId: 'message-native-redaction',
          delta: `Visible answer using ${credential}`,
        },
        receivedAt: '2026-07-24T08:05:00.000Z',
      }, 'orchestra-codex:redaction:1'))
      scope.sink.append(capture(scope.binding, {
        method: 'item/reasoning/textDelta',
        params: {
          threadId: 'thread-native-1',
          turnId: 'turn-native-redaction',
          itemId: 'reasoning-native-redaction',
          delta: `Private reasoning using ${credential}`,
        },
        receivedAt: '2026-07-24T08:05:00.100Z',
      }, 'orchestra-codex:redaction:2'))

      const events = scope.conversations.listSessionEvents(scope.binding.agentHomeSessionId)
      expect(events).toEqual([
        expect.objectContaining({
          kind: 'assistant',
          projected_text: 'Visible answer using [REDACTED]',
          redaction_state: 'redacted',
          metadata: expect.objectContaining({
            raw_payload_state: 'withheld',
          }),
        }),
        expect.objectContaining({
          kind: 'status',
          projected_text: null,
          redaction_state: 'withheld',
          metadata: expect.objectContaining({
            native_method: 'item/reasoning/textDelta',
            reasoning: true,
            raw_payload_state: 'withheld',
          }),
        }),
      ])
      expect(JSON.stringify(events)).not.toContain(credential)
      expect(JSON.stringify(events)).not.toContain('Private reasoning')
    } finally {
      scope.db.close()
    }
  })

  it('uses an explicit durable session ordinal for cursorless repeated deltas', () => {
    const scope = createScope()
    try {
      const first = capture(scope.binding, codexNativeNotifications.assistantDelta, 'orchestra-codex:1')
      const second = capture(scope.binding, codexNativeNotifications.assistantDelta, 'orchestra-codex:2')
      scope.sink.append(first)
      scope.sink.append(second)
      scope.sink.append(first)

      const events = scope.conversations.listSessionEvents(scope.binding.agentHomeSessionId)
      expect(events).toHaveLength(2)
      expect(events.map((event) => event.provider_cursor)).toEqual([
        'orchestra-codex:1',
        'orchestra-codex:2',
      ])
      expect(events.map((event) => event.projected_text)).toEqual([
        'Durable hello',
        'Durable hello',
      ])
      expect(events.every((event) =>
        event.metadata.replay_identity_state === 'orchestra_session_ordinal')).toBe(true)
      expect(events.every((event) =>
        event.metadata.replay_guarantee === 'ordered_live_capture_not_transport_redelivery')).toBe(true)

      scope.db.prepare('UPDATE agent_sessions SET provider_cursor=? WHERE id=?')
        .run('eventId:provider-native-latest', scope.binding.agentHomeSessionId)
      expect(codexAgentHomeForThread(scope.db, 'thread-native-1')).toMatchObject({
        ...scope.binding,
        providerCursor: 'eventId:provider-native-latest',
        captureCursor: 'orchestra-codex:2',
      })
    } finally {
      scope.db.close()
    }
  })

  it('keeps parent session ownership while distinguishing subagent thread starts', () => {
    const scope = createScope()
    try {
      const first = {
        ...capture(scope.binding, codexNativeNotifications.childThreadStarted),
        threadId: 'thread-native-1',
      }
      const second = {
        ...first,
        params: {
          thread: {
            ...codexNativeNotifications.childThreadStarted.params.thread,
            id: 'thread-native-child-2',
            agentNickname: 'tester',
          },
        },
        receivedAt: '2026-07-24T08:00:02.000Z',
        captureCursor: 'orchestra-codex:2',
      }
      scope.sink.append(first)
      scope.sink.append(second)

      const events = scope.conversations.listSessionEvents(scope.binding.agentHomeSessionId)
      expect(events).toHaveLength(2)
      expect(events.map((event) => event.provider_thread_id)).toEqual([
        'thread-native-1',
        'thread-native-1',
      ])
      expect(events.map((event) => event.metadata.child_thread_id)).toEqual([
        'thread-native-child',
        'thread-native-child-2',
      ])
      expect(scope.conversations.requireSession(scope.binding.agentHomeSessionId).provider_thread_id)
        .toBe('thread-native-1')
    } finally {
      scope.db.close()
    }
  })

  it('keeps mixed native ordering and safely retains unknown methods without raw payloads', () => {
    const scope = createScope()
    try {
      const ordered = [
        codexNativeNotifications.turnStarted,
        codexNativeNotifications.assistantDelta,
        codexNativeNotifications.toolCompleted,
        codexNativeNotifications.usage,
        codexNativeNotifications.unknown,
        codexNativeNotifications.turnCompleted,
      ]
      ordered.forEach((notification, index) => {
        scope.sink.append(capture(scope.binding, notification, `orchestra-codex:${index + 1}`))
      })

      const events = scope.conversations.listSessionEvents(scope.binding.agentHomeSessionId)
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
      expect(events.map((event) => event.metadata.native_method)).toEqual(ordered.map(({ method }) => method))
      expect(events.map((event) => event.kind)).toEqual([
        'status',
        'assistant',
        'tool_result',
        'usage',
        'status',
        'status',
      ])
      expect(events[1]).toMatchObject({
        provider_turn_id: 'turn-native-1',
        provider_item_id: 'message-native-1',
        projected_text: 'Durable hello',
      })
      expect(events[2]).toMatchObject({
        provider_item_id: 'command-native-1',
        projected_text: 'Codex commandExecution completed',
      })
      expect(events[3].metadata).toMatchObject({
        raw_payload_state: 'withheld',
        token_usage: {
          total_tokens: 144,
          cached_input_tokens: 30,
          last_total_tokens: 44,
        },
      })
      expect(events[4]).toMatchObject({
        projected_text: 'future/threadFeature',
        metadata: {
          raw_payload_state: 'withheld',
          unknown_native_method: true,
        },
      })
      const stored = JSON.stringify(events)
      expect(stored).not.toContain('must-never-be-stored')
      expect(stored).not.toContain('npm test -- --runInBand')
      expect(stored).not.toContain('all tests passed')

      expect(() => scope.sink.append(capture(scope.binding, {
        ...codexNativeNotifications.unknown,
        params: {
          ...codexNativeNotifications.unknown.params,
          futureValue: false,
          unredactedSecret: 'different-secret-that-is-also-not-stored',
        },
        receivedAt: '2026-07-24T09:00:00.000Z',
      }, 'orchestra-codex:99'))).toThrow(/conflicts with an existing dedupe key/)
      const conflict = scope.db.prepare(`SELECT received_metadata_json
        FROM conversation_event_conflicts`).get() as { received_metadata_json: string }
      expect(JSON.parse(conflict.received_metadata_json)).toMatchObject({
        native_method: 'future/threadFeature',
        raw_payload_state: 'withheld',
        unknown_native_method: true,
        native_payload_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(conflict.received_metadata_json).not.toContain('different-secret-that-is-also-not-stored')
    } finally {
      scope.db.close()
    }
  })
})

const nativeThread = (
  turns: CodexThread['turns'] = [],
  status: CodexThread['status'] = { type: 'idle' },
): CodexThread => ({
  id: 'thread-native-1',
  sessionId: 'codex-session-native-1',
  parentThreadId: null,
  status,
  cwd: '/codex-native',
  cliVersion: '0.144.6',
  turns,
})

class NativeService {
  private readonly notificationListeners = new Set<(notification: CodexServerNotification) => void>()
  private readonly serverRequestListeners = new Set<
    (request: CodexServerRequest) => unknown | Promise<unknown>
  >()
  thread = nativeThread()
  resumeCalls = 0
  readCalls = 0
  unsubscribeCalls = 0

  async startThread(): Promise<CodexThreadStartResponse> {
    return {
      thread: this.thread,
      model: 'gpt-test',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: '/codex-native',
      instructionSources: [],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite' },
      reasoningEffort: 'high',
    }
  }

  async resumeThread(): Promise<CodexThreadStartResponse> {
    this.resumeCalls += 1
    return this.startThread()
  }

  async readThread(): Promise<{ thread: CodexThread }> {
    this.readCalls += 1
    return { thread: this.thread }
  }

  async unsubscribeThread(): Promise<{ status: string }> {
    this.unsubscribeCalls += 1
    return { status: 'unsubscribed' }
  }

  onNotification(listener: (notification: CodexServerNotification) => void): CodexUnsubscribe {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onServerRequest(
    listener: (request: CodexServerRequest) => unknown | Promise<unknown>,
  ): CodexUnsubscribe {
    this.serverRequestListeners.add(listener)
    return () => this.serverRequestListeners.delete(listener)
  }

  emit(notification: CodexServerNotification): void {
    for (const listener of [...this.notificationListeners]) listener(notification)
  }

  async request(request: CodexServerRequest): Promise<unknown> {
    for (const listener of [...this.serverRequestListeners]) {
      const response = await listener(request)
      if (response !== CODEX_REQUEST_UNHANDLED) return response
    }
    return CODEX_REQUEST_UNHANDLED
  }

  asPort(): CodexRuntimeService {
    return this as unknown as CodexRuntimeService
  }
}

const drivers: CodexAgentDriver[] = []

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.dispose()
})

const nextDriverEvent = async (iterator: AsyncIterator<DriverEvent>): Promise<DriverEvent> => {
  const result = await iterator.next()
  if (result.done) throw new Error('driver event stream ended')
  return result.value
}

describe('Codex driver durable notification boundary', () => {
  it('materializes one exact legacy Agent Home identity before attach capture and reuses it after restart', async () => {
    const db = openDb(':memory:')
    try {
      db.prepare(`INSERT INTO boards (id, project_path, name)
        VALUES (1, '/codex-native', 'codex-native')`).run()
      db.prepare(`INSERT INTO agents (
        id, board_id, name, kind, status, provider, external_session_id,
        provider_state_json, access_profile, model, effort
      ) VALUES (
        91, 1, 'legacy-codex', 'hired', 'active', 'codex', 'thread-native-1',
        '{"cwd":"/codex-native"}', 'workspace_write', 'gpt-test', 'high'
      )`).run()

      const firstService = new NativeService()
      const firstDriver = new CodexAgentDriver({
        service: firstService.asPort(),
        nativeEventSink: new AgentHomeCodexNativeEventSink(db),
        agentHomeForThread: (threadId, thread, context) => {
          expect(firstService.resumeCalls).toBe(1)
          expect(firstService.readCalls).toBe(1)
          return bindCodexAgentHomeForThread(db, threadId, thread, context)
        },
      })
      drivers.push(firstDriver)
      const firstSession = await firstDriver.attach('thread-native-1')
      expect(firstSession).toMatchObject({
        externalId: 'thread-native-1',
        workspaceId: 'legacy-agent:91',
        metadata: {
          agentHomeSessionId: expect.stringMatching(/^legacy-codex-session:91:/),
          agentProfileId: 'legacy-agent:91',
          agentConversationId: 'legacy-conversation:91',
          nativeCaptureResume: {
            reason: 'daemon-attach',
            priorCaptureCursor: null,
          },
        },
      })

      firstService.emit(codexNativeNotifications.assistantDelta)
      const durableSession = db.prepare(`SELECT id, workspace_id, agent_id, external_id,
          profile_id, conversation_id, provider_thread_id, history_state, recovery_json
        FROM agent_sessions WHERE provider='codex'`).get() as Record<string, unknown>
      expect(durableSession).toMatchObject({
        workspace_id: 'legacy-agent:91',
        agent_id: 91,
        external_id: 'thread-native-1',
        profile_id: 'legacy-agent:91',
        conversation_id: 'legacy-conversation:91',
        provider_thread_id: 'thread-native-1',
        history_state: 'partial',
      })
      expect(JSON.parse(String(durableSession.recovery_json))).toMatchObject({
        codex_native_capture: {
          state: 'bound',
          mode: 'attach',
          thread_id: 'thread-native-1',
          unobserved_interval: true,
        },
      })
      expect(new ConversationService(db).listSessionEvents(String(durableSession.id))
        .map((event) => [event.metadata.native_method, event.provider_cursor])).toEqual([
        ['orchestra/captureGap', 'orchestra-codex:1'],
        ['item/agentMessage/delta', 'orchestra-codex:2'],
      ])
      await firstDriver.detach(firstSession!.id)

      const secondService = new NativeService()
      const secondDriver = new CodexAgentDriver({
        service: secondService.asPort(),
        nativeEventSink: new AgentHomeCodexNativeEventSink(db),
        agentHomeForThread: (threadId, thread, context) =>
          bindCodexAgentHomeForThread(db, threadId, thread, context),
      })
      drivers.push(secondDriver)
      const restarted = await secondDriver.attach('thread-native-1')
      expect(restarted?.metadata).toMatchObject({
        agentHomeSessionId: durableSession.id,
        nativeCaptureResume: {
          priorCaptureCursor: 'orchestra-codex:2',
        },
      })
      expect(new ConversationService(db).listSessionEvents(String(durableSession.id))
        .map((event) => [event.metadata.native_method, event.provider_cursor])).toEqual([
        ['orchestra/captureGap', 'orchestra-codex:1'],
        ['item/agentMessage/delta', 'orchestra-codex:2'],
        ['orchestra/captureGap', 'orchestra-codex:3'],
      ])
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_conversations').get()).toEqual({ count: 1 })
    } finally {
      db.close()
    }
  })

  it('binds a fresh legacy launch before the driver state can project native events', async () => {
    const db = openDb(':memory:')
    try {
      db.prepare(`INSERT INTO boards (id, project_path, name)
        VALUES (1, '/codex-native', 'codex-native')`).run()
      db.prepare(`INSERT INTO agents (
        id, board_id, name, kind, status, provider, provider_state_json, access_profile
      ) VALUES (
        92, 1, 'fresh-codex', 'hired', 'starting', 'codex',
        '{"cwd":"/codex-native"}', 'workspace_write'
      )`).run()
      const service = new NativeService()
      const driver = new CodexAgentDriver({
        service: service.asPort(),
        nativeEventSink: new AgentHomeCodexNativeEventSink(db),
        agentHomeForThread: (threadId, thread, context) =>
          bindCodexAgentHomeForThread(db, threadId, thread, context),
      })
      drivers.push(driver)

      const session = await driver.launch({
        workspaceId: 'legacy-agent:92',
        boardId: 1,
        cwd: '/codex-native',
        metadata: { agentId: 92 },
      })
      expect(session.metadata).toMatchObject({
        agentHomeSessionId: expect.stringMatching(/^legacy-codex-session:92:/),
        agentProfileId: 'legacy-agent:92',
        agentConversationId: 'legacy-conversation:92',
      })
      service.emit(codexNativeNotifications.assistantDelta)
      const event = db.prepare(`SELECT event.provider_thread_id, event.provider_turn_id,
          event.provider_item_id, event.projected_text
        FROM conversation_events event`).get()
      expect(event).toEqual({
        provider_thread_id: 'thread-native-1',
        provider_turn_id: 'turn-native-1',
        provider_item_id: 'message-native-1',
        projected_text: 'Durable hello',
      })
      expect(db.prepare(`SELECT history_state FROM agent_sessions
        WHERE id=?`).get(session.metadata.agentHomeSessionId)).toEqual({
        history_state: 'complete',
      })
      await expect(driver.reconcileSessions()).resolves.toEqual({
        resumed: ['thread-native-1'],
        failed: [],
      })
      const reconnected = db.prepare(`SELECT history_state, recovery_json
        FROM agent_sessions WHERE id=?`).get(session.metadata.agentHomeSessionId) as {
        history_state: string
        recovery_json: string
      }
      expect(reconnected.history_state).toBe('partial')
      expect(JSON.parse(reconnected.recovery_json)).toMatchObject({
        codex_native_capture_gap: {
          provider: 'codex',
          thread_id: 'thread-native-1',
          reason: 'app-server-reconnect',
          capture_cursor: 'orchestra-codex:2',
        },
      })
      expect(new ConversationService(db).listSessionEvents(
        String(session.metadata.agentHomeSessionId),
      ).map((event) => event.metadata.native_method)).toEqual([
        'item/agentMessage/delta',
        'orchestra/captureGap',
      ])
    } finally {
      db.close()
    }
  })

  it('fails closed when attach ownership is ambiguous and captures no false canonical event', async () => {
    const db = openDb(':memory:')
    try {
      db.prepare(`INSERT INTO boards (id, project_path, name)
        VALUES (1, '/codex-native', 'codex-native')`).run()
      for (const [id, status] of [
        ['ambiguous-workspace-1', 'running'],
        ['ambiguous-workspace-2', 'stopped'],
      ] as const) {
        db.prepare(`INSERT INTO workspaces (
          id, board_id, name, kind, root_path, status
        ) VALUES (?, 1, ?, 'shared', '/codex-native', 'active')`)
          .run(id, id)
        db.prepare(`INSERT INTO agent_sessions (
          id, workspace_id, provider, external_id, status, context_json
        ) VALUES (?, ?, 'codex', 'thread-native-1', ?, '{}')`)
          .run(`session-${id}`, id, status)
      }
      const service = new NativeService()
      const captured: CodexNativeEvent[] = []
      const driver = new CodexAgentDriver({
        service: service.asPort(),
        nativeEventSink: {
          append: (event) => {
            captured.push(event)
            return undefined
          },
        },
        agentHomeForThread: (threadId, thread, context) =>
          bindCodexAgentHomeForThread(db, threadId, thread, context),
      })
      drivers.push(driver)

      await expect(driver.attach('thread-native-1')).rejects.toThrow(
        /multiple Agent Home sessions reference Codex thread/,
      )
      expect(captured).toEqual([])
      expect(service.unsubscribeCalls).toBe(1)
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get()).toEqual({ count: 2 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('rejects a configured sink when launch has no durable Agent Home binding', async () => {
    const service = new NativeService()
    const driver = new CodexAgentDriver({
      service: service.asPort(),
      nativeEventSink: { append: () => undefined },
    })
    drivers.push(driver)

    await expect(driver.launch({
      workspaceId: 'workspace-codex-native',
      cwd: '/codex-native',
    })).rejects.toThrow(/has no durable Agent Home binding/)
    expect(service.unsubscribeCalls).toBe(1)
  })

  it('captures bound native notifications synchronously in provider order before projection', async () => {
    const service = new NativeService()
    const captured: CodexNativeEvent[] = []
    const nativeEventSink: CodexNativeEventSink = {
      append: (event) => {
        captured.push(structuredClone(event))
        return undefined
      },
    }
    const driver = new CodexAgentDriver({ service: service.asPort(), nativeEventSink })
    drivers.push(driver)
    const session = await driver.launch({
      workspaceId: 'workspace-codex-native',
      cwd: '/codex-native',
      metadata: {
        agentHomeSessionId: 'session-codex-native',
        agentProfileId: 'profile-codex-native',
        agentConversationId: 'conversation-codex-native',
      },
    })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()

    service.emit(codexNativeNotifications.assistantDelta)
    service.emit(codexNativeNotifications.unknown)
    service.emit(codexNativeNotifications.childThreadStarted)

    expect(captured.map(({ method }) => method)).toEqual([
      'item/agentMessage/delta',
      'future/threadFeature',
      'thread/started',
    ])
    expect(captured[0]).toMatchObject({
      agentHomeSessionId: 'session-codex-native',
      agentProfileId: 'profile-codex-native',
      agentConversationId: 'conversation-codex-native',
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      itemId: 'message-native-1',
    })
    expect(captured[2]).toMatchObject({
      threadId: 'thread-native-1',
      method: 'thread/started',
      params: { thread: { id: 'thread-native-child', parentThreadId: 'thread-native-1' } },
    })
    expect(await nextDriverEvent(iterator)).toMatchObject({
      type: 'output',
      data: 'Durable hello',
      metadata: { nativeMethod: 'item/agentMessage/delta' },
    })
    expect(await nextDriverEvent(iterator)).toMatchObject({
      type: 'status',
      data: 'future/threadFeature',
      metadata: { unknownNativeEvent: true },
    })
    expect(await nextDriverEvent(iterator)).toMatchObject({
      type: 'tool',
      data: 'Codex subagent started',
      metadata: { subagentId: 'thread-native-child' },
    })
  })

  it('persists provider approval requests before exposing their lossy driver projection', async () => {
    const scope = createScope()
    try {
      const service = new NativeService()
      const driver = new CodexAgentDriver({
        service: service.asPort(),
        nativeEventSink: scope.sink,
        onApprovalRequest: () => ({ decision: 'accept' }),
      })
      drivers.push(driver)
      const session = await driver.launch({
        workspaceId: 'workspace-codex-native',
        cwd: '/codex-native',
        metadata: scope.binding,
      })
      const iterator = driver.events(session.id)[Symbol.asyncIterator]()

      await expect(service.request({
        id: 'approval-native-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-native-1',
          turnId: 'turn-native-1',
          itemId: 'command-native-approval',
          command: 'secret command that must not be persisted',
        },
        receivedAt: '2026-07-24T10:00:00.000Z',
      })).resolves.toEqual({ decision: 'accept' })

      const events = scope.conversations.listSessionEvents(scope.binding.agentHomeSessionId)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: 'approval',
        provider_thread_id: 'thread-native-1',
        provider_turn_id: 'turn-native-1',
        provider_item_id: 'command-native-approval',
        provider_cursor: 'eventId:approval-native-1',
        projected_text: 'Codex command approval requested',
        redaction_state: 'none',
        metadata: {
          native_method: 'item/commandExecution/requestApproval',
          approval_kind: 'command',
          provider_request_id: 'approval-native-1',
          raw_payload_state: 'withheld',
        },
      })
      expect(JSON.stringify(events)).not.toContain('secret command')
      expect(await nextDriverEvent(iterator)).toMatchObject({
        type: 'tool',
        metadata: {
          approval: true,
          requestId: 'approval-native-1',
          approvalKind: 'command',
        },
      })
    } finally {
      scope.db.close()
    }
  })

  it('does not enqueue a projection when its durable append fails', async () => {
    const service = new NativeService()
    const nativeEventSink: CodexNativeEventSink = {
      append: () => {
        throw new Error('durable append failed')
      },
    }
    const driver = new CodexAgentDriver({ service: service.asPort(), nativeEventSink })
    drivers.push(driver)
    const session = await driver.launch({
      workspaceId: 'workspace-codex-native',
      cwd: '/codex-native',
      metadata: {
        agentHomeSessionId: 'session-codex-native',
        agentProfileId: 'profile-codex-native',
        agentConversationId: 'conversation-codex-native',
      },
    })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()

    expect(() => service.emit(codexNativeNotifications.assistantDelta)).not.toThrow()
    expect(await nextDriverEvent(iterator)).toMatchObject({
      type: 'error',
      data: 'Codex native event was not persisted: durable append failed',
      metadata: {
        nativeCaptureFailed: true,
        failedNativeMethod: 'item/agentMessage/delta',
        captureCursor: 'orchestra-codex:1',
      },
    })
    expect(session.metadata.nativeCaptureFailure).toMatchObject({
      method: 'item/agentMessage/delta',
      detail: 'durable append failed',
    })
    await driver.stop(session.id)
    expect(await nextDriverEvent(iterator)).toMatchObject({
      type: 'exit',
      data: 'Codex session stopped',
    })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })
})

import type Database from 'better-sqlite3'
import type {
  CodexNativeEvent,
  CodexNativeEventSink,
} from '../runtime/drivers/codex.js'
import { canonicalHash } from './agent-home-support.js'
import {
  ConversationService,
  type ConversationEventKind,
} from './conversations.js'
import { ConflictError } from './errors.js'

type NativeProjection = {
  kind: ConversationEventKind
  projectedText: string | null
  metadata?: Record<string, unknown>
}

const TOOL_OUTPUT_METHODS = new Set([
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'process/outputDelta',
  'command/exec/outputDelta',
])

const REASONING_METHODS = new Set([
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
])

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
])

const CURSOR_SENSITIVE_METHODS = new Set([
  'item/agentMessage/delta',
  ...TOOL_OUTPUT_METHODS,
  ...REASONING_METHODS,
  'thread/tokenUsage/updated',
  'turn/diff/updated',
  'turn/plan/updated',
  'thread/status/changed',
  'error',
  'orchestra/captureGap',
  ...APPROVAL_METHODS,
])

const KNOWN_METHODS = new Set([
  'thread/started',
  'turn/started',
  'turn/completed',
  'item/agentMessage/delta',
  ...TOOL_OUTPUT_METHODS,
  'item/started',
  'item/completed',
  'thread/tokenUsage/updated',
  'turn/diff/updated',
  'turn/plan/updated',
  ...REASONING_METHODS,
  'thread/status/changed',
  'error',
  'thread/closed',
  'thread/deleted',
  'orchestra/captureGap',
  ...APPROVAL_METHODS,
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const safeScalar = (value: unknown, maximum = 512): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.trim()
  if (normalized.length <= maximum) return normalized
  return `sha256:${canonicalHash(normalized)}`
}

const safeText = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null
  return value.length > 64_000 ? `${value.slice(0, 63_997)}...` : value
}

const nativeEventTime = (params: Record<string, unknown>): string | null => {
  for (const key of ['completedAtMs', 'startedAtMs']) {
    const value = params[key]
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  }
  const turn = isRecord(params.turn) ? params.turn : {}
  for (const key of ['completedAt', 'startedAt']) {
    const value = turn[key]
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1_000).toISOString()
  }
  return null
}

const scalarCursor = (params: Record<string, unknown>): string | null => {
  for (const key of ['cursor', 'eventId', 'sequence', 'seq', 'index', 'offset']) {
    const value = params[key]
    if ((typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value))) {
      const normalized = String(value)
      if (normalized.length <= 2_000) return `${key}:${normalized}`
    }
  }
  return null
}

const itemProjection = (
  method: 'item/started' | 'item/completed',
  params: Record<string, unknown>,
): NativeProjection => {
  const item = isRecord(params.item) ? params.item : {}
  const itemType = safeScalar(item.type, 120) ?? 'unknown'
  const completed = method === 'item/completed'
  if (itemType === 'agentMessage') {
    return {
      kind: 'assistant',
      projectedText: safeText(item.text),
      metadata: { item_type: itemType, item_phase: completed ? 'completed' : 'started' },
    }
  }
  if (itemType === 'userMessage') {
    return {
      kind: 'user',
      projectedText: safeText(item.text),
      metadata: { item_type: itemType, item_phase: completed ? 'completed' : 'started' },
    }
  }
  if (itemType === 'hookPrompt') {
    return {
      kind: 'system',
      projectedText: 'Codex hook prompt',
      metadata: { item_type: itemType, item_phase: completed ? 'completed' : 'started' },
    }
  }
  return {
    kind: completed ? 'tool_result' : 'tool',
    projectedText: `Codex ${itemType} ${completed ? 'completed' : 'started'}`,
    metadata: { item_type: itemType, item_phase: completed ? 'completed' : 'started' },
  }
}

const usageMetadata = (params: Record<string, unknown>): Record<string, unknown> => {
  const usage = isRecord(params.tokenUsage) ? params.tokenUsage : {}
  const total = isRecord(usage.total) ? usage.total : {}
  const last = isRecord(usage.last) ? usage.last : {}
  const numeric = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  return {
    token_usage: {
      total_tokens: numeric(total.totalTokens),
      input_tokens: numeric(total.inputTokens),
      cached_input_tokens: numeric(total.cachedInputTokens),
      output_tokens: numeric(total.outputTokens),
      reasoning_output_tokens: numeric(total.reasoningOutputTokens),
      last_total_tokens: numeric(last.totalTokens),
      model_context_window: numeric(usage.modelContextWindow),
    },
  }
}

const errorText = (value: unknown): string => {
  if (typeof value === 'string' && value.length > 0) return safeText(value) ?? 'Codex error'
  if (isRecord(value)) {
    return safeText(value.message) ?? safeText(value.additionalDetails) ?? 'Codex error'
  }
  return 'Codex error'
}

const projectNativeEvent = (
  method: string,
  params: Record<string, unknown>,
): NativeProjection => {
  if (method === 'item/agentMessage/delta') {
    return { kind: 'assistant', projectedText: safeText(params.delta) }
  }
  if (TOOL_OUTPUT_METHODS.has(method)) {
    return { kind: 'tool_result', projectedText: safeText(params.delta) }
  }
  if (method === 'item/started' || method === 'item/completed') {
    return itemProjection(method, params)
  }
  if (method === 'thread/tokenUsage/updated') {
    return { kind: 'usage', projectedText: 'Codex token usage updated', metadata: usageMetadata(params) }
  }
  if (method === 'turn/started') {
    return { kind: 'status', projectedText: 'Codex turn started' }
  }
  if (method === 'turn/completed') {
    const turn = isRecord(params.turn) ? params.turn : {}
    const status = safeScalar(turn.status, 120) ?? 'completed'
    return {
      kind: status === 'failed' || status === 'interrupted' ? 'error' : 'status',
      projectedText: status === 'interrupted' ? 'Codex turn interrupted' : `Codex turn ${status}`,
      metadata: { turn_status: status },
    }
  }
  if (method === 'turn/diff/updated') {
    return { kind: 'status', projectedText: 'Codex working tree diff updated' }
  }
  if (method === 'turn/plan/updated') {
    return { kind: 'status', projectedText: 'Codex plan updated' }
  }
  if (REASONING_METHODS.has(method)) {
    return { kind: 'status', projectedText: safeText(params.delta) ?? method, metadata: { reasoning: true } }
  }
  if (method === 'thread/status/changed') {
    const status = isRecord(params.status) ? safeScalar(params.status.type, 120) ?? 'unknown' : 'unknown'
    return {
      kind: status === 'systemError' ? 'error' : 'status',
      projectedText: `Codex thread ${status}`,
      metadata: { thread_status: status },
    }
  }
  if (method === 'error') {
    return {
      kind: 'error',
      projectedText: errorText(params.error),
      metadata: { will_retry: params.willRetry === true },
    }
  }
  if (method === 'thread/started') {
    return { kind: 'status', projectedText: 'Codex subagent started' }
  }
  if (method === 'thread/closed' || method === 'thread/deleted') {
    return { kind: 'status', projectedText: method === 'thread/closed' ? 'Codex thread closed' : 'Codex thread deleted' }
  }
  if (method === 'orchestra/captureGap') {
    const reason = safeScalar(params.reason, 120) ?? 'provider-reconnect'
    return {
      kind: 'status',
      projectedText: 'Codex durable capture resumed after an unobserved interval',
      metadata: {
        capture_gap: true,
        capture_gap_reason: reason,
      },
    }
  }
  if (APPROVAL_METHODS.has(method)) {
    const kind = method === 'item/commandExecution/requestApproval'
      ? 'command'
      : method === 'item/fileChange/requestApproval'
        ? 'file-change'
        : method === 'item/permissions/requestApproval'
          ? 'permissions'
          : method === 'item/tool/requestUserInput'
            ? 'user-input'
            : 'mcp-elicitation'
    return {
      kind: 'approval',
      projectedText: `Codex ${kind} approval requested`,
      metadata: {
        approval_kind: kind,
        provider_request_id: safeScalar(params.eventId, 512),
      },
    }
  }
  return {
    kind: 'status',
    projectedText: method,
    metadata: { unknown_native_method: true },
  }
}

/**
 * Synchronous by design: better-sqlite3 and ConversationService commit the native
 * event before the Codex driver is allowed to enqueue its lossy projection.
 */
export class AgentHomeCodexNativeEventSink implements CodexNativeEventSink {
  private readonly conversations: ConversationService

  constructor(
    private readonly db: Database.Database,
    conversations = new ConversationService(db),
  ) {
    this.conversations = conversations
  }

  append(event: CodexNativeEvent): undefined {
    try {
      this.appendDurable(event)
      return undefined
    } catch (error) {
      this.markCaptureFailure(event, error)
      throw error
    }
  }

  private appendDurable(event: CodexNativeEvent): void {
    const sessionId = safeScalar(event.agentHomeSessionId, 200)
    const profileId = safeScalar(event.agentProfileId, 200)
    const conversationId = safeScalar(event.agentConversationId, 200)
    if (!sessionId || !profileId || !conversationId) {
      throw new ConflictError('Codex native event Agent Home binding is invalid')
    }
    const session = this.conversations.requireSession(sessionId)
    if (session.profile_id !== profileId || session.conversation_id !== conversationId) {
      throw new ConflictError('Codex native event Agent Home binding does not match the durable session')
    }
    if (session.provider !== 'codex') throw new ConflictError('Codex native events require a Codex agent session')

    const params = isRecord(event.params) ? event.params : {}
    const method = safeScalar(event.method, 512) ?? `sha256:${canonicalHash(event.method)}`
    const threadId = safeScalar(event.threadId, 512)
    const turnId = safeScalar(event.turnId, 512)
    const itemId = safeScalar(event.itemId, 512)
    if (!threadId) throw new ConflictError('Codex native event thread identity is invalid')
    const childThreadId = event.method === 'thread/started' && isRecord(params.thread)
      ? safeScalar(params.thread.id, 512)
      : null
    const nativeCursor = scalarCursor(params)
    const providerCursor = nativeCursor
      ?? (CURSOR_SENSITIVE_METHODS.has(event.method) ? safeScalar(event.captureCursor, 2_000) : null)
    const identity = canonicalHash({
      provider: 'codex',
      session_id: sessionId,
      method,
      thread_id: threadId,
      turn_id: turnId,
      item_id: itemId,
      child_thread_id: childThreadId,
      provider_cursor: providerCursor,
    })
    const projection = projectNativeEvent(method, params)
    const providerEventId = `codex:${identity}`
    const eventTime = nativeEventTime(params)
    const unknown = !KNOWN_METHODS.has(event.method)

    if (event.method === 'orchestra/captureGap') {
      this.markCaptureGap(event, params)
    }
    this.conversations.appendEvent(sessionId, {
      idempotencyKey: `codex-native:${identity}`,
      dedupeKey: `codex-native:${sessionId}:${identity}`,
      kind: projection.kind,
      provider: 'codex',
      providerEventId,
      providerThreadId: threadId,
      providerTurnId: turnId,
      providerItemId: itemId,
      providerCursor,
      projectedText: projection.projectedText,
      metadata: {
        native_method: method,
        raw_payload_state: 'withheld',
        native_payload_fingerprint: canonicalHash(params),
        replay_identity_state: nativeCursor
          ? 'provider_cursor'
          : providerCursor ? 'orchestra_session_ordinal' : 'native_structural',
        ...(!nativeCursor && providerCursor ? {
          replay_guarantee: 'ordered_live_capture_not_transport_redelivery',
        } : {}),
        ...(eventTime ? { native_event_time: eventTime } : {}),
        ...(providerCursor ? { native_cursor: providerCursor } : {}),
        ...(childThreadId ? { child_thread_id: childThreadId } : {}),
        ...projection.metadata,
        ...(unknown ? {
          unknown_native_method: true,
        } : {}),
      },
      actor: { type: 'provider', id: 'codex' },
      correlationId: `codex:${canonicalHash({
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
      })}`,
      redactionState: 'withheld',
      retentionClass: projection.kind === 'usage' ? 'audit' : 'transcript',
      schemaVersion: 1,
    })
  }

  private markCaptureGap(
    event: CodexNativeEvent,
    params: Record<string, unknown>,
  ): void {
    const reason = safeScalar(params.reason, 120) ?? 'provider-reconnect'
    const at = safeScalar(event.receivedAt, 120) ?? new Date().toISOString()
    this.db.prepare(`UPDATE agent_sessions SET
      history_state='partial',
      recovery_json=json_set(
        CASE WHEN json_valid(recovery_json) THEN recovery_json ELSE '{}' END,
        '$.codex_native_capture_gap',
        json_object(
          'provider', 'codex',
          'thread_id', ?,
          'reason', ?,
          'capture_cursor', ?,
          'detected_at', ?
        )
      ),
      updated_at=datetime('now')
      WHERE id=?`).run(
      safeScalar(event.threadId, 512),
      reason,
      safeScalar(event.captureCursor, 2_000),
      at,
      event.agentHomeSessionId,
    )
  }

  private markCaptureFailure(event: CodexNativeEvent, error: unknown): void {
    const method = safeScalar(event.method, 512) ?? 'unknown'
    const detail = safeScalar(error instanceof Error ? error.message : String(error), 1_000) ?? 'capture failed'
    try {
      this.db.prepare(`UPDATE agent_sessions SET
        history_state='partial',
        recovery_json=json_set(
          CASE WHEN json_valid(recovery_json) THEN recovery_json ELSE '{}' END,
          '$.native_capture_failure',
          json_object(
            'provider', 'codex',
            'method', ?,
            'capture_cursor', ?,
            'reason', ?
          )
        ),
        updated_at=datetime('now')
        WHERE id=?`).run(method, safeScalar(event.captureCursor, 2_000), detail, event.agentHomeSessionId)
    } catch {
      // The driver emits a visible failure event even if the database itself is unavailable.
    }
  }
}

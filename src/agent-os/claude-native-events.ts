import type Database from 'better-sqlite3'
import type {
  ClaudeAgentHomeBinding,
  ClaudeNativeEvent,
  ClaudeNativeEventSink,
} from '../runtime/drivers/claude.js'
import { ArtifactStore } from './artifact-store.js'
import { canonicalHash, stableJson } from './agent-home-support.js'
import {
  ConversationService,
  type ConversationEventKind,
} from './conversations.js'
import { ConflictError } from './errors.js'

export type ClaudeRawArtifactMode = 'withheld' | 'redacted' | 'full'

export type AgentHomeClaudeNativeEventSinkOptions = {
  rawArtifactMode?: ClaudeRawArtifactMode
  redactRawPayload?: (payload: unknown) => unknown
}

type ResolvedBinding = ClaudeAgentHomeBinding & {
  boardId: number
  workspaceId: string
  cardId: number | null
  conversationId: string
}

type NativeProjection = {
  part: string
  kind: ConversationEventKind
  projectedText: string | null
  providerItemId?: string | null
  providerTurnId?: string | null
  metadata?: Record<string, unknown>
  retentionClass?: 'transcript' | 'audit'
  forceWithheld?: boolean
}

type CanonicalEventStorage = {
  provider_cursor: string | null
  raw_artifact_id: string | null
  redaction_state: 'none' | 'redacted' | 'withheld'
  metadata_json: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const stringValue = (value: unknown, maximum = 2_000): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null
  return value.length <= maximum ? value : `sha256:${canonicalHash(value)}`
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const safeText = (value: unknown, maximum = 256_000): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`
}

const scalarSummary = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

const textFromContent = (content: unknown): string | null => {
  if (typeof content === 'string') return safeText(content, 64_000)
  if (!Array.isArray(content)) return null
  const text = content.flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    if (!isRecord(entry)) return []
    const value = entry.text ?? entry.content
    return typeof value === 'string' ? [value] : []
  }).join('\n')
  return safeText(text, 64_000)
}

const numericShape = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return null
  if (finiteNumber(value) !== null) return value
  if (typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.map((entry) => numericShape(entry, depth + 1))
  if (!isRecord(value)) return undefined
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const normalized = numericShape(entry, depth + 1)
    return normalized === undefined ? [] : [[key, normalized]]
  }))
}

const toolSummary = (name: string, input: unknown): string => {
  const record = isRecord(input) ? input : {}
  const argument = record.command
    ?? record.file_path
    ?? record.path
    ?? record.pattern
    ?? record.url
    ?? record.query
  const detail = scalarSummary(argument)
  if (!detail) return name
  return `${name}(${detail.length > 500 ? `${detail.slice(0, 497)}...` : detail})`
}

const nativeMessage = (payload: Record<string, unknown>): Record<string, unknown> =>
  isRecord(payload.message) ? payload.message : {}

const nativeEventId = (payload: Record<string, unknown>): string | null =>
  stringValue(payload.uuid, 512)

const nativeSessionId = (event: ClaudeNativeEvent, payload: Record<string, unknown>): string | null =>
  stringValue(payload.session_id, 512) ?? stringValue(event.providerSessionId, 512)

const nativeMessageId = (payload: Record<string, unknown>): string | null =>
  stringValue(nativeMessage(payload).id, 512)

const nativeRequestId = (payload: Record<string, unknown>): string | null =>
  stringValue(payload.request_id, 512) ?? stringValue(payload.requestId, 512)

const nativeCursor = (payload: Record<string, unknown>): string | null => {
  const fields = [
    ['cursor', payload.cursor],
    ['resume_token', payload.resume_token],
    ['resumeToken', payload.resumeToken],
    ['checkpoint_id', payload.checkpoint_id],
  ] as const
  for (const [key, value] of fields) {
    if ((typeof value === 'string' && value.length > 0)
      || (typeof value === 'number' && Number.isFinite(value))) {
      return stringValue(`${key}:${String(value)}`, 2_000)
    }
  }
  if (payload.type === 'user' && typeof payload.uuid === 'string' && payload.uuid) {
    return stringValue(`checkpoint_uuid:${payload.uuid}`, 2_000)
  }
  return null
}

const assistantProjections = (payload: Record<string, unknown>): NativeProjection[] => {
  const message = nativeMessage(payload)
  const turnId = stringValue(message.id, 512)
  const content = Array.isArray(message.content) ? message.content : []
  const usage = numericShape(message.usage)
  const projections = content.map((rawBlock, index): NativeProjection => {
    const block = isRecord(rawBlock) ? rawBlock : {}
    const blockType = stringValue(block.type, 120) ?? 'unknown'
    const itemId = stringValue(block.id, 512)
    const baseMetadata = {
      native_block_type: blockType,
      block_index: index,
      ...(index === 0 && usage !== undefined ? { usage } : {}),
    }
    if (blockType === 'text') {
      return {
        part: `assistant:${index}:text`,
        kind: 'assistant',
        projectedText: safeText(block.text),
        providerTurnId: turnId,
        metadata: baseMetadata,
      }
    }
    if (blockType === 'tool_use' || blockType === 'server_tool_use') {
      const name = stringValue(block.name, 200) ?? 'Claude tool'
      return {
        part: `assistant:${index}:tool:${itemId ?? name}`,
        kind: 'tool',
        projectedText: toolSummary(name, block.input),
        providerTurnId: turnId,
        providerItemId: itemId,
        metadata: {
          ...baseMetadata,
          tool_name: name,
          tool_input_fingerprint: canonicalHash(block.input ?? null),
        },
      }
    }
    if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      return {
        part: `assistant:${index}:${blockType}`,
        kind: 'system',
        projectedText: null,
        providerTurnId: turnId,
        providerItemId: itemId,
        metadata: baseMetadata,
        forceWithheld: true,
      }
    }
    return {
      part: `assistant:${index}:${blockType}`,
      kind: 'status',
      projectedText: `Claude assistant block (${blockType})`,
      providerTurnId: turnId,
      providerItemId: itemId,
      metadata: baseMetadata,
      retentionClass: 'audit',
    }
  })
  const error = stringValue(payload.error, 200)
  if (error) {
    projections.push({
      part: 'assistant:error',
      kind: 'error',
      projectedText: `Claude assistant error: ${error}`,
      providerTurnId: turnId,
      metadata: { assistant_error: error },
      retentionClass: 'audit',
    })
  }
  if (projections.length > 0) return projections
  return [{
    part: 'assistant:empty',
    kind: error ? 'error' : 'assistant',
    projectedText: error ? `Claude assistant error: ${error}` : null,
    providerTurnId: turnId,
    metadata: usage === undefined ? undefined : { usage },
  }]
}

const userProjections = (payload: Record<string, unknown>): NativeProjection[] => {
  const message = nativeMessage(payload)
  const content = message.content
  if (typeof content === 'string') {
    return [{
      part: 'user:text',
      kind: 'user',
      projectedText: safeText(content),
      metadata: {
        replayed: payload.isReplay === true,
        synthetic: payload.isSynthetic === true,
      },
    }]
  }
  if (!Array.isArray(content)) {
    return [{
      part: 'user:unknown',
      kind: 'user',
      projectedText: null,
      metadata: { replayed: payload.isReplay === true },
    }]
  }
  return content.map((rawBlock, index): NativeProjection => {
    const block = isRecord(rawBlock) ? rawBlock : {}
    const blockType = stringValue(block.type, 120) ?? 'unknown'
    if (blockType === 'tool_result') {
      const toolUseId = stringValue(block.tool_use_id, 512)
      return {
        part: `user:${index}:tool_result:${toolUseId ?? 'unknown'}`,
        kind: 'tool_result',
        projectedText: textFromContent(block.content),
        providerItemId: toolUseId,
        metadata: {
          native_block_type: blockType,
          block_index: index,
          is_error: block.is_error === true,
          tool_result_fingerprint: canonicalHash(block.content ?? null),
        },
      }
    }
    if (blockType === 'text') {
      return {
        part: `user:${index}:text`,
        kind: 'user',
        projectedText: safeText(block.text),
        metadata: { native_block_type: blockType, block_index: index },
      }
    }
    return {
      part: `user:${index}:${blockType}`,
      kind: 'status',
      projectedText: `Claude user block (${blockType})`,
      metadata: { native_block_type: blockType, block_index: index },
      retentionClass: 'audit',
    }
  })
}

const resultProjections = (payload: Record<string, unknown>): NativeProjection[] => {
  const subtype = stringValue(payload.subtype, 120) ?? 'unknown'
  const failed = subtype !== 'success' || payload.is_error === true
  const projections: NativeProjection[] = [{
    part: 'result',
    kind: failed ? 'error' : 'status',
    projectedText: failed
      ? `Claude turn failed (${subtype})`
      : 'Claude turn finished (success)',
    metadata: {
      result_subtype: subtype,
      duration_ms: finiteNumber(payload.duration_ms),
      duration_api_ms: finiteNumber(payload.duration_api_ms),
      num_turns: finiteNumber(payload.num_turns),
      stop_reason: stringValue(payload.stop_reason, 200),
      terminal_reason: stringValue(payload.terminal_reason, 200),
      permission_denial_count: Array.isArray(payload.permission_denials)
        ? payload.permission_denials.length : 0,
    },
    retentionClass: 'audit',
  }]
  if (isRecord(payload.usage) || isRecord(payload.modelUsage)) {
    projections.push({
      part: 'result:usage',
      kind: 'usage',
      projectedText: 'Claude usage reported',
      metadata: {
        usage: numericShape(payload.usage),
        model_usage: numericShape(payload.modelUsage),
        total_cost_usd: finiteNumber(payload.total_cost_usd),
      },
      retentionClass: 'audit',
    })
  }
  if (Array.isArray(payload.permission_denials)) {
    payload.permission_denials.forEach((rawDenial, index) => {
      const denial = isRecord(rawDenial) ? rawDenial : {}
      const toolUseId = stringValue(denial.tool_use_id, 512)
      const toolName = stringValue(denial.tool_name, 200) ?? 'tool'
      projections.push({
        part: `result:permission_denial:${toolUseId ?? index}`,
        kind: 'approval',
        projectedText: `Claude denied ${toolName}`,
        providerItemId: toolUseId,
        metadata: {
          approval_phase: 'result_denial',
          tool_name: toolName,
          tool_use_id: toolUseId,
          tool_input_fingerprint: canonicalHash(denial.tool_input ?? null),
        },
        retentionClass: 'audit',
      })
    })
  }
  return projections
}

const systemProjection = (payload: Record<string, unknown>): NativeProjection => {
  const subtype = stringValue(payload.subtype, 160) ?? 'unknown'
  if (subtype === 'init') {
    const model = stringValue(payload.model, 200)
    return {
      part: 'system:init',
      kind: 'system',
      projectedText: `Claude session started${model ? ` · ${model}` : ''}`,
      metadata: {
        system_subtype: subtype,
        model,
        permission_mode: stringValue(payload.permissionMode, 120),
        claude_code_version: stringValue(payload.claude_code_version, 120),
        capability_count: Array.isArray(payload.capabilities) ? payload.capabilities.length : 0,
      },
      retentionClass: 'audit',
    }
  }
  if (subtype === 'permission_denied') {
    return {
      part: 'system:permission_denied',
      kind: 'approval',
      projectedText: `Claude denied ${stringValue(payload.tool_name, 200) ?? 'tool use'}`,
      providerItemId: stringValue(payload.tool_use_id, 512),
      metadata: {
        system_subtype: subtype,
        decision_reason_type: stringValue(payload.decision_reason_type, 120),
        decision_reason: stringValue(payload.decision_reason, 1_000),
      },
      retentionClass: 'audit',
    }
  }
  const errorLike = subtype === 'mirror_error'
    || subtype === 'api_retry'
    || (subtype === 'status' && typeof payload.compact_error === 'string')
  const detail = safeText(payload.error, 4_000)
    ?? safeText(payload.compact_error, 4_000)
    ?? safeText(payload.text, 4_000)
  return {
    part: `system:${subtype}`,
    kind: errorLike ? 'error' : 'status',
    projectedText: detail ?? `Claude system event (${subtype})`,
    providerItemId: stringValue(payload.tool_use_id, 512)
      ?? stringValue(payload.task_id, 512),
    metadata: {
      system_subtype: subtype,
      request_id: stringValue(payload.request_id, 512),
      task_id: stringValue(payload.task_id, 512),
      tool_use_id: stringValue(payload.tool_use_id, 512),
      state: stringValue(payload.state, 120),
      status: stringValue(payload.status, 120),
      attempt: finiteNumber(payload.attempt),
      max_retries: finiteNumber(payload.max_retries),
      retry_delay_ms: finiteNumber(payload.retry_delay_ms),
      error_status: finiteNumber(payload.error_status),
    },
    retentionClass: 'audit',
  }
}

const projectProviderMessage = (payload: Record<string, unknown>): NativeProjection[] => {
  const type = stringValue(payload.type, 160) ?? 'unknown'
  if (type === 'assistant') return assistantProjections(payload)
  if (type === 'user') return userProjections(payload)
  if (type === 'result') return resultProjections(payload)
  if (type === 'system') return [systemProjection(payload)]
  if (type === 'tool_progress') {
    const toolUseId = stringValue(payload.tool_use_id, 512)
    return [{
      part: `tool_progress:${toolUseId ?? 'unknown'}`,
      kind: 'tool',
      projectedText: `${stringValue(payload.tool_name, 200) ?? 'Claude tool'} in progress`,
      providerItemId: toolUseId,
      metadata: {
        elapsed_time_seconds: finiteNumber(payload.elapsed_time_seconds),
        task_id: stringValue(payload.task_id, 512),
      },
    }]
  }
  if (type === 'tool_use_summary') {
    return [{
      part: 'tool_use_summary',
      kind: 'tool_result',
      projectedText: safeText(payload.summary, 64_000),
      metadata: {
        preceding_tool_use_ids: Array.isArray(payload.preceding_tool_use_ids)
          ? payload.preceding_tool_use_ids.filter((id): id is string => typeof id === 'string').slice(0, 200)
          : [],
      },
    }]
  }
  if (type === 'rate_limit_event') {
    const rate = isRecord(payload.rate_limit_info) ? payload.rate_limit_info : {}
    return [{
      part: 'rate_limit_event',
      kind: 'usage',
      projectedText: `Claude rate limit ${stringValue(rate.status, 120) ?? 'updated'}`,
      metadata: { rate_limit: numericShape(rate) },
      retentionClass: 'audit',
    }]
  }
  if (type === 'auth_status' && typeof payload.error === 'string') {
    return [{
      part: 'auth_status:error',
      kind: 'error',
      projectedText: safeText(payload.error, 4_000),
      metadata: { authenticating: payload.isAuthenticating === true },
      retentionClass: 'audit',
    }]
  }
  if (type === 'stream_event') {
    const stream = isRecord(payload.event) ? payload.event : {}
    const delta = isRecord(stream.delta) ? stream.delta : {}
    const deltaType = stringValue(delta.type, 160)
    const text = safeText(delta.text) ?? safeText(delta.thinking)
    return [{
      part: `stream_event:${stringValue(stream.type, 160) ?? 'unknown'}:${deltaType ?? 'none'}`,
      kind: deltaType === 'text_delta' ? 'assistant' : 'status',
      projectedText: deltaType === 'thinking_delta' ? null : text,
      metadata: {
        stream_event_type: stringValue(stream.type, 160),
        delta_type: deltaType,
      },
      forceWithheld: deltaType === 'thinking_delta',
    }]
  }
  return [{
    part: `provider:${type}:${stringValue(payload.subtype, 160) ?? 'none'}`,
    kind: 'status',
    projectedText: `Claude event (${type}${
      typeof payload.subtype === 'string' ? `/${payload.subtype}` : ''
    })`,
    metadata: { unknown_native_type: true },
    retentionClass: 'audit',
  }]
}

const projectEvent = (event: ClaudeNativeEvent): NativeProjection[] => {
  const payload = isRecord(event.payload) ? event.payload : {}
  if (event.kind === 'provider_message') return projectProviderMessage(payload)
  if (event.kind === 'outbound_user') {
    return [{
      part: 'outbound_user',
      kind: 'user',
      projectedText: safeText(payload.text),
      metadata: {
        source: stringValue(payload.source, 120) ?? 'orchestra',
        notification_ids: Array.isArray(payload.notification_ids)
          ? payload.notification_ids.filter((id) => Number.isSafeInteger(id)).slice(0, 500)
          : [],
      },
    }]
  }
  if (event.kind === 'approval_request' || event.kind === 'approval_response') {
    const requestId = stringValue(payload.request_id, 512)
    const toolUseId = stringValue(payload.tool_use_id, 512)
    const toolName = stringValue(payload.tool_name, 200) ?? 'tool'
    const response = event.kind === 'approval_response'
    return [{
      part: `${event.kind}:${requestId ?? toolUseId ?? event.captureId}`,
      kind: 'approval',
      projectedText: response
        ? `Claude ${toolName} permission ${stringValue(payload.behavior, 120) ?? 'resolved'}`
        : `Claude requests permission for ${toolName}`,
      providerItemId: toolUseId,
      metadata: {
        request_id: requestId,
        tool_use_id: toolUseId,
        tool_name: toolName,
        approval_phase: response ? 'response' : 'request',
        behavior: stringValue(payload.behavior, 120),
        decision_source: stringValue(payload.source, 120),
        tool_input_fingerprint: response ? null : canonicalHash(payload.input ?? null),
      },
      retentionClass: 'audit',
    }]
  }
  if (event.kind === 'session_start') {
    return [{
      part: 'session_start',
      kind: 'status',
      projectedText: event.resumed
        ? 'Claude session resume requested'
        : 'Claude durable capture started',
      metadata: {
        lifecycle: 'session_start',
        resume_requested: event.resumed === true,
        model: stringValue(payload.model, 200),
        effort: stringValue(payload.effort, 120),
        permission_mode: stringValue(payload.permission_mode, 120),
        access_profile: stringValue(payload.access_profile, 120),
      },
      retentionClass: 'audit',
    }]
  }
  if (event.kind === 'session_end') {
    return [{
      part: 'session_end',
      kind: 'status',
      projectedText: payload.handoff === true
        ? 'Claude session detached for handoff'
        : 'Claude session transport ended',
      metadata: {
        lifecycle: 'session_end',
        handoff: payload.handoff === true,
        limit_hit: payload.limit_hit === true,
        outcome: stringValue(payload.outcome, 120),
        reason: stringValue(payload.reason, 1_000),
      },
      retentionClass: 'audit',
    }]
  }
  return [{
    part: 'capture_error',
    kind: 'error',
    projectedText: safeText(payload.message, 4_000) ?? 'Claude provider stream failed',
    metadata: {
      error_name: stringValue(payload.name, 200),
      lifecycle: 'capture_error',
    },
    retentionClass: 'audit',
  }]
}

const sensitiveKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replaceAll('-', '_')
  return normalized === 'authorization'
    || normalized === 'password'
    || normalized === 'secret'
    || normalized === 'cookie'
    || normalized === 'api_key'
    || normalized === 'access_token'
    || normalized === 'refresh_token'
    || normalized === 'id_token'
    || (normalized.endsWith('_token') && !normalized.endsWith('_tokens'))
}

const redactString = (value: string): string => value
  .replace(/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')

const redactValue = (value: unknown, depth = 0): unknown => {
  if (depth > 30) return '[REDACTED:DEPTH]'
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1))
  if (!isRecord(value)) return String(value)
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    sensitiveKey(key) ? '[REDACTED]' : redactValue(entry, depth + 1),
  ]))
}

/**
 * Persists Claude Agent SDK events into the already-bound Agent Home conversation.
 *
 * The sink is deliberately synchronous: a managed provider event either commits
 * before the Conductor creates its bounded presentation, or the session is marked
 * as having a durable capture gap and the provider operation fails closed.
 */
export class AgentHomeClaudeNativeEventSink implements ClaudeNativeEventSink {
  private readonly conversations: ConversationService
  private readonly artifacts: ArtifactStore
  private readonly rawArtifactMode: ClaudeRawArtifactMode

  constructor(
    private readonly db: Database.Database,
    conversations = new ConversationService(db),
    private readonly options: AgentHomeClaudeNativeEventSinkOptions = {},
  ) {
    this.conversations = conversations
    this.artifacts = new ArtifactStore(db)
    this.rawArtifactMode = options.rawArtifactMode ?? 'withheld'
  }

  append(event: ClaudeNativeEvent): void {
    const binding = this.resolveBinding(event)
    if (!binding) return
    try {
      this.persist(binding, event)
    } catch (error) {
      this.markCaptureGap(binding, event, error)
      throw error
    }
  }

  private persist(binding: ResolvedBinding, event: ClaudeNativeEvent): void {
    this.updateRecoveryBeforeCapture(binding, event)
    const persistProjections = (): string | null => {
      const payload = isRecord(event.payload) ? event.payload : {}
      const providerEventId = nativeEventId(payload)
      const providerThreadId = nativeSessionId(event, payload)
      const messageId = nativeMessageId(payload)
      const requestId = nativeRequestId(payload)
      const projections = projectEvent(event)
      const suppliedCursor = nativeCursor(payload)
      const identities = projections.map((projection) => this.identity(
        binding,
        event,
        projection,
        providerEventId,
        messageId,
        requestId,
        suppliedCursor,
      ))
      const canonicalStorage = identities.map(({ dedupeKey }) =>
        this.canonicalStorage(binding.conversationId, dedupeKey))
      const existingArtifactId = canonicalStorage.map((canonical) => canonical?.raw_artifact_id)
        .find((artifactId): artifactId is string => typeof artifactId === 'string')
      const rawArtifactId = canonicalStorage.some(Boolean)
        ? existingArtifactId ?? null
        : this.createRawArtifact(binding, event, providerEventId ?? event.captureId)
      const rawPayloadState = rawArtifactId
        ? this.rawArtifactMode === 'full' ? 'stored' : 'redacted'
        : 'withheld'
      projections.forEach((projection, index) => {
        const identity = identities[index]
        const canonical = this.canonicalStorage(binding.conversationId, identity.dedupeKey)
        let canonicalMetadata: Record<string, unknown> = {}
        if (canonical) {
          try { canonicalMetadata = JSON.parse(canonical.metadata_json) as Record<string, unknown> }
          catch { canonicalMetadata = {} }
        }
        const providerCursor = canonical?.provider_cursor
          ?? suppliedCursor
          ?? this.nextCaptureCursor(binding.agentHomeSessionId)
        const redactionState = projection.forceWithheld
          ? 'withheld'
          : canonical?.redaction_state
            ?? (this.rawArtifactMode === 'full' ? 'none'
              : this.rawArtifactMode === 'redacted' ? 'redacted' : 'withheld')
        const metadata = {
          provider_native: true,
          provider_native_schema: 'claude-agent-sdk-message',
          native_event_kind: event.kind,
          native_direction: event.direction,
          native_type: stringValue(payload.type, 160),
          native_subtype: stringValue(payload.subtype, 160),
          native_event_id: providerEventId,
          native_session_id: providerThreadId,
          native_message_id: messageId,
          native_request_id: requestId,
          parent_tool_use_id: stringValue(payload.parent_tool_use_id, 512),
          capture_id: canonicalMetadata.capture_id ?? event.captureId,
          raw_payload_state: canonicalMetadata.raw_payload_state ?? rawPayloadState,
          native_payload_fingerprint: canonicalHash(event.payload),
          replay_identity_state: providerEventId
            ? 'provider_event_id'
            : messageId ? 'provider_message_id'
              : requestId ? 'provider_request_id'
                : suppliedCursor ? 'provider_cursor' : 'orchestra_capture_id',
          ...(event.kind === 'session_start' && event.resumed ? {
            resumed_transport: true,
            replay_guarantee: 'resume_token_without_transport_event_cursor',
          } : {}),
          ...projection.metadata,
        }
        const projectedText = this.rawArtifactMode === 'redacted' && projection.projectedText
          ? redactString(projection.projectedText)
          : projection.projectedText
        this.conversations.appendEvent(binding.agentHomeSessionId, {
          idempotencyKey: `claude-native:${identity.hash}`,
          dedupeKey: identity.dedupeKey,
          kind: projection.kind,
          provider: 'claude',
          providerEventId,
          providerThreadId,
          providerTurnId: projection.providerTurnId ?? messageId,
          providerItemId: projection.providerItemId ?? null,
          providerCursor,
          projectedText,
          metadata,
          rawArtifactId: canonical ? canonical.raw_artifact_id : rawArtifactId,
          actor: event.direction === 'inbound'
            ? { type: 'provider', id: 'claude' }
            : { type: 'system', id: 'agent-os-runtime' },
          correlationId: `claude:${canonicalHash({
            session_id: binding.agentHomeSessionId,
            provider_session_id: providerThreadId,
            message_id: messageId,
            request_id: requestId,
            replay_id: providerEventId
              ?? messageId
              ?? requestId
              ?? suppliedCursor
              ?? event.captureId,
          })}`,
          redactionState,
          retentionClass: projection.retentionClass ?? 'transcript',
          schemaVersion: 1,
        })
      })
      return providerThreadId
    }
    const providerThreadId = persistProjections()
    this.updateRecoveryAfterCapture(binding, event, providerThreadId)
  }

  private resolveBinding(event: ClaudeNativeEvent): ResolvedBinding | null {
    const explicit = event.agentHome
    const rows = explicit
      ? this.db.prepare(`SELECT session.id, session.profile_id, session.conversation_id,
          session.workspace_id, workspace.board_id,
          (SELECT card_id FROM jobs WHERE id=session.job_id) AS card_id
        FROM agent_sessions session
        JOIN workspaces workspace ON workspace.id=session.workspace_id
        WHERE session.id=? AND session.provider='claude' AND session.mode='managed'`)
          .all(explicit.agentHomeSessionId)
      : this.db.prepare(`SELECT session.id, session.profile_id, session.conversation_id,
          session.workspace_id, workspace.board_id,
          (SELECT card_id FROM jobs WHERE id=session.job_id) AS card_id
        FROM agent_sessions session
        JOIN workspaces workspace ON workspace.id=session.workspace_id
        WHERE session.agent_id=? AND session.provider='claude' AND session.mode='managed'
          AND session.profile_id IS NOT NULL AND session.conversation_id IS NOT NULL
          AND session.status IN ('reserved','starting','running','idle','stopping')
        ORDER BY session.updated_at DESC, session.rowid DESC LIMIT 2`)
          .all(event.agentId)
    if (rows.length === 0) {
      if (explicit) throw new ConflictError('managed Claude Agent Home session was not found')
      return null
    }
    if (rows.length > 1) {
      throw new ConflictError(`multiple active managed Claude sessions reference agent ${event.agentId}`)
    }
    const row = rows[0] as {
      id: string
      profile_id: string | null
      conversation_id: string | null
      workspace_id: string
      board_id: number
      card_id: number | null
    }
    if (!row.profile_id || !row.conversation_id) {
      throw new ConflictError('managed Claude session has an incomplete Agent Home identity')
    }
    if (explicit && (
      row.profile_id !== explicit.agentProfileId
      || row.conversation_id !== explicit.agentConversationId
    )) {
      throw new ConflictError('managed Claude event does not match its Agent Home binding')
    }
    return {
      agentHomeSessionId: row.id,
      agentProfileId: row.profile_id,
      agentConversationId: row.conversation_id,
      boardId: Number(row.board_id),
      workspaceId: row.workspace_id,
      cardId: row.card_id == null ? null : Number(row.card_id),
      conversationId: row.conversation_id,
    }
  }

  private identity(
    binding: ResolvedBinding,
    event: ClaudeNativeEvent,
    projection: NativeProjection,
    providerEventId: string | null,
    providerMessageId: string | null,
    providerRequestId: string | null,
    providerCursor: string | null,
  ): { hash: string; dedupeKey: string } {
    const hash = canonicalHash({
      provider: 'claude',
      session_id: binding.agentHomeSessionId,
      replay_id: providerEventId
        ?? providerMessageId
        ?? providerRequestId
        ?? providerCursor
        ?? event.captureId,
      direction: event.direction,
      kind: event.kind,
      part: projection.part,
      provider_turn_id: projection.providerTurnId ?? providerMessageId,
      provider_item_id: projection.providerItemId ?? null,
    })
    return {
      hash,
      dedupeKey: `claude-native:${binding.agentHomeSessionId}:${hash}`,
    }
  }

  private canonicalStorage(conversationId: string, dedupeKey: string): CanonicalEventStorage | null {
    return this.db.prepare(`SELECT provider_cursor, raw_artifact_id, redaction_state, metadata_json
      FROM conversation_events WHERE conversation_id=? AND dedupe_key=?`)
      .get(conversationId, dedupeKey) as CanonicalEventStorage | undefined ?? null
  }

  private nextCaptureCursor(sessionId: string): string {
    const row = this.db.prepare(`SELECT MAX(
        CASE WHEN provider_cursor GLOB 'orchestra-claude:[0-9]*'
          THEN CAST(substr(provider_cursor, 18) AS INTEGER) ELSE NULL END
      ) AS sequence
      FROM conversation_events WHERE session_id=?`)
      .get(sessionId) as { sequence: number | null }
    return `orchestra-claude:${Number(row.sequence ?? 0) + 1}`
  }

  private createRawArtifact(
    binding: ResolvedBinding,
    event: ClaudeNativeEvent,
    identity: string,
  ): string | null {
    if (this.rawArtifactMode === 'withheld') return null
    const envelope = {
      provider: 'claude',
      source: '@anthropic-ai/claude-agent-sdk',
      kind: event.kind,
      direction: event.direction,
      provider_session_id: event.providerSessionId ?? null,
      resumed: event.resumed === true,
      payload: event.payload,
    }
    const transformed = this.rawArtifactMode === 'full'
      ? envelope
      : redactValue(this.options.redactRawPayload
        ? this.options.redactRawPayload(envelope)
        : envelope)
    return this.artifacts.create({
      boardId: binding.boardId,
      workspaceId: binding.workspaceId,
      cardId: binding.cardId,
      kind: 'provider_event',
      name: `claude-${canonicalHash(identity).slice(0, 16)}.json`,
      mimeType: 'application/json',
      content: stableJson(transformed),
      metadata: {
        provider: 'claude',
        source: '@anthropic-ai/claude-agent-sdk',
        source_kind: event.kind,
        direction: event.direction,
        redaction_state: this.rawArtifactMode === 'full' ? 'none' : 'redacted',
        payload_fingerprint: canonicalHash(event.payload),
      },
    }).id
  }

  private updateRecoveryBeforeCapture(binding: ResolvedBinding, event: ClaudeNativeEvent): void {
    if (event.kind !== 'session_start') return
    const session = this.conversations.requireSession(binding.agentHomeSessionId)
    const priorCapture = isRecord(session.recovery.native_capture)
      ? session.recovery.native_capture : {}
    const recovery = {
      ...session.recovery,
      native_capture: {
        ...priorCapture,
        provider: 'claude',
        source: '@anthropic-ai/claude-agent-sdk',
        started_at: event.at,
        resume_requested: event.resumed === true,
        resume_session_id: event.providerSessionId ?? null,
        ...(event.resumed ? {
          gap: {
            state: 'possible',
            reason: 'claude_resume_has_no_transport_event_cursor',
            detected_at: event.at,
          },
        } : {}),
      },
    }
    const historyState = event.resumed
      ? 'partial'
      : session.history_state === 'partial' ? 'partial' : 'complete'
    this.db.prepare(`UPDATE agent_sessions SET
      recovery_state=?,
      recovery_json=?,
      history_state=?,
      updated_at=datetime('now')
      WHERE id=?`).run(
        event.providerSessionId ? 'detached' : 'unknown',
        stableJson(recovery),
        historyState,
        binding.agentHomeSessionId,
      )
  }

  private updateRecoveryAfterCapture(
    binding: ResolvedBinding,
    event: ClaudeNativeEvent,
    providerSessionId: string | null,
  ): void {
    const session = this.conversations.requireSession(binding.agentHomeSessionId)
    const priorCapture = isRecord(session.recovery.native_capture)
      ? session.recovery.native_capture : {}
    const recovery = {
      ...session.recovery,
      native_capture: {
        ...priorCapture,
        provider: 'claude',
        source: '@anthropic-ai/claude-agent-sdk',
        last_capture_id: event.captureId,
        last_capture_at: event.at,
        last_native_event_id: isRecord(event.payload)
          ? nativeEventId(event.payload) : null,
        ...(event.kind === 'session_end' ? {
          ended_at: event.at,
          end_reason: isRecord(event.payload)
            ? stringValue(event.payload.reason, 1_000) : null,
        } : {}),
      },
    }
    const initialized = event.kind === 'provider_message'
      && isRecord(event.payload)
      && event.payload.type === 'system'
      && event.payload.subtype === 'init'
    const ended = event.kind === 'session_end'
    this.db.prepare(`UPDATE agent_sessions SET
      provider_thread_id=coalesce(provider_thread_id, ?),
      recovery_state=CASE
        WHEN ? THEN CASE
          WHEN recovery_state='lost' THEN 'lost'
          WHEN ? IS NULL THEN 'lost'
          ELSE 'detached'
        END
        WHEN ? THEN 'attachable'
        ELSE recovery_state
      END,
      recovery_json=?,
      history_state=CASE
        WHEN history_state='unavailable' THEN 'complete'
        ELSE history_state
      END,
      updated_at=datetime('now')
      WHERE id=?`).run(
        providerSessionId,
        ended ? 1 : 0,
        providerSessionId,
        initialized ? 1 : 0,
        stableJson(recovery),
        binding.agentHomeSessionId,
      )
  }

  private markCaptureGap(binding: ResolvedBinding, event: ClaudeNativeEvent, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    try {
      const session = this.conversations.requireSession(binding.agentHomeSessionId)
      const recovery = {
        ...session.recovery,
        native_capture: {
          ...(isRecord(session.recovery.native_capture) ? session.recovery.native_capture : {}),
          provider: 'claude',
          source: '@anthropic-ai/claude-agent-sdk',
          gap: {
            state: 'confirmed',
            reason: 'native_event_persistence_failed',
            event_kind: event.kind,
            capture_id: event.captureId,
            detected_at: event.at,
            detail: detail.length > 1_000 ? `${detail.slice(0, 997)}...` : detail,
          },
        },
      }
      this.db.prepare(`UPDATE agent_sessions SET
        recovery_state='lost',
        history_state='partial',
        recovery_json=?,
        updated_at=datetime('now')
        WHERE id=?`).run(stableJson(recovery), binding.agentHomeSessionId)
    } catch {
      // If the database itself is unavailable, the Conductor still fails the provider operation.
    }
  }
}

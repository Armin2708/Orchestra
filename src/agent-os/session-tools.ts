import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { AttentionService, type AttentionItem } from './attention.js'
import { actorIdentity, type ActorIdentity } from './agent-home-support.js'
import { EventStore } from './event-store.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { parseJson } from './json.js'
import {
  TOOL_CAPABILITY_KINDS,
  TOOL_POLICY_DECISIONS,
  type DeclaredProviderCapabilityMatrixRow,
  type ToolCapability,
  type ToolCapabilityKind,
  type ToolCapabilityRegistry,
  type ToolPolicyDecision,
} from '../tool-capabilities.js'

export type SessionToolPolicyRule = {
  target: string
  decision: ToolPolicyDecision
}

export type SessionToolPolicy = {
  schema_version: 1
  session_id: string
  revision: number
  default_decision: ToolPolicyDecision
  rules: readonly SessionToolPolicyRule[]
  updated_by: string
  updated_at: string | null
}

export type ToolPermissionDrift = {
  tool_id: string
  requested: ToolPolicyDecision
  effective: ToolPolicyDecision | 'unknown'
  status: 'aligned' | 'unknown' | 'more_restrictive' | 'more_permissive'
  reason: string
}

export type ToolInvocationProvenance = {
  schema_version: 1
  invocation_id: string
  session_id: string
  tool_id: string
  provider_id: string | null
  provider_call_id: string | null
  provider_event_id: string | null
  status: 'requested' | 'started' | 'completed' | 'failed' | 'denied'
  argument_digest: string | null
  argument_count: number
  input_state: 'withheld'
  output_state: 'withheld'
  error_code: string | null
  observed_at: string
}

export type SessionToolSnapshot = {
  schema_version: 1
  session: {
    id: string
    provider: string
    workspace_id: string
    board_id: number
    mode: string
    access_profile: string | null
  }
  provider: DeclaredProviderCapabilityMatrixRow | null
  policy: SessionToolPolicy
  tools: ToolCapability[]
  permission_drift: ToolPermissionDrift[]
  invocations: ToolInvocationProvenance[]
  approvals: AttentionItem[]
  direct_terminal_is_source_of_truth: true
}

export type SessionToolAuthorization = {
  decision: ToolPolicyDecision
  reason: string
  tool: ToolCapability
  attention: AttentionItem | null
  approval_request_id: string | null
}

export type SetSessionToolPolicyInput = {
  defaultDecision: ToolPolicyDecision
  rules?: readonly SessionToolPolicyRule[]
  expectedRevision: number
  actor: ActorIdentity
  idempotencyKey: string
}

export type RequestToolInvocationInput = {
  toolId: string
  actor: ActorIdentity
  requestId?: string
  idempotencyKey: string
}

export type RecordToolInvocationInput = {
  invocationId?: string
  toolId: string
  status: ToolInvocationProvenance['status']
  arguments?: unknown
  providerCallId?: string | null
  providerEventId?: string | null
  errorCode?: string | null
  observedAt?: string
  actor: ActorIdentity
  idempotencyKey: string
}

type SessionScope = {
  id: string
  workspace_id: string
  provider: string
  mode: string
  access_profile: string | null
  board_id: number
  card_id: number | null
  agent_id: number | null
}

const safeIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,511}$/
const policyTargetPattern = /^(?:\*|kind:(?:cli|mcp_server|plugin|skill|native)|[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,511})$/
const invocationStatuses = new Set<ToolInvocationProvenance['status']>([
  'requested',
  'started',
  'completed',
  'failed',
  'denied',
])

const stableEventId = (prefix: string, idempotencyKey: string): string =>
  `${prefix}-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`

const safeId = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !safeIdPattern.test(value)) {
    throw new ValidationError(`${name} is invalid`)
  }
  return value
}

const durableActor = (value: ActorIdentity, name: string): ActorIdentity & { id: string } => {
  const actor = actorIdentity(value)
  return { ...actor, id: safeId(actor.id, `${name} id`) }
}

const optionalSafeId = (value: unknown, name: string): string | null =>
  value === null || value === undefined ? null : safeId(value, name)

const policyDecision = (value: unknown, name: string): ToolPolicyDecision => {
  if (!(TOOL_POLICY_DECISIONS as readonly unknown[]).includes(value)) {
    throw new ValidationError(`${name} must be allow, approval_required, or deny`)
  }
  return value as ToolPolicyDecision
}

const nonNegativeInteger = (value: unknown, name: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${name} must be a non-negative integer`)
  }
  return parsed
}

const normalizeRules = (
  input: readonly SessionToolPolicyRule[] | undefined,
): readonly SessionToolPolicyRule[] => {
  if (input === undefined) return Object.freeze([])
  if (!Array.isArray(input) || input.length > 256) {
    throw new ValidationError('tool policy rules must be an array with at most 256 entries')
  }
  const seen = new Set<string>()
  const rules = input.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new ValidationError('tool policy rule is invalid')
    }
    const target = String(rule.target ?? '').trim()
    if (!policyTargetPattern.test(target)) {
      throw new ValidationError('tool policy target is invalid')
    }
    if (seen.has(target)) throw new ValidationError('tool policy target is duplicated')
    seen.add(target)
    return Object.freeze({
      target,
      decision: policyDecision(rule.decision, 'tool policy decision'),
    })
  })
  return Object.freeze(rules.sort((left, right) => left.target.localeCompare(right.target)))
}

const stableJson = (value: unknown): string => {
  const seen = new Set<object>()
  const sort = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(sort)
    if (candidate && typeof candidate === 'object') {
      if (seen.has(candidate)) throw new ValidationError('tool arguments must not be cyclic')
      seen.add(candidate)
      const output = Object.fromEntries(Object.entries(candidate)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sort(entry)]))
      seen.delete(candidate)
      return output
    }
    if (typeof candidate === 'bigint' || typeof candidate === 'symbol'
      || typeof candidate === 'function' || candidate === undefined) {
      return null
    }
    return candidate
  }
  const serialized = JSON.stringify(sort(value)) ?? 'null'
  if (Buffer.byteLength(serialized) > 1024 * 1024) {
    throw new ValidationError('tool arguments exceed the 1 MiB provenance limit')
  }
  return serialized
}

const argumentCount = (value: unknown): number => {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return value === undefined ? 0 : 1
}

const invocationDigest = (value: unknown): string | null => {
  if (value === undefined) return null
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

const permissionDrift = (tool: ToolCapability): ToolPermissionDrift => {
  const requested = tool.permission.requested
  const effective = tool.permission.effective
  if (effective === 'unknown') {
    return {
      tool_id: tool.id,
      requested,
      effective,
      status: 'unknown',
      reason: 'effective provider permission is unavailable',
    }
  }
  if (requested === effective) {
    return {
      tool_id: tool.id,
      requested,
      effective,
      status: 'aligned',
      reason: 'requested and effective permissions agree',
    }
  }
  const rank: Record<ToolPolicyDecision, number> = {
    deny: 0,
    approval_required: 1,
    allow: 2,
  }
  const status = rank[effective] < rank[requested]
    ? 'more_restrictive'
    : 'more_permissive'
  return {
    tool_id: tool.id,
    requested,
    effective,
    status,
    reason: status === 'more_permissive'
      ? 'provider permission is broader than the requested session policy'
      : 'provider permission is narrower than the requested session policy',
  }
}

const decisionFor = (
  policy: SessionToolPolicy,
  tool: ToolCapability,
): ToolPolicyDecision => policy.rules.find((rule) => rule.target === tool.id)?.decision
  ?? policy.rules.find((rule) => rule.target === `kind:${tool.kind}`)?.decision
  ?? policy.rules.find((rule) => rule.target === '*')?.decision
  ?? policy.default_decision

const mapInvocation = (payload: unknown): ToolInvocationProvenance | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const row = payload as Record<string, unknown>
  try {
    const status = row.status as ToolInvocationProvenance['status']
    if (!invocationStatuses.has(status)) return null
    const argumentCountValue = nonNegativeInteger(row.argument_count, 'argument count')
    return {
      schema_version: 1,
      invocation_id: safeId(row.invocation_id, 'invocation id'),
      session_id: safeId(row.session_id, 'session id'),
      tool_id: safeId(row.tool_id, 'tool id'),
      provider_id: optionalSafeId(row.provider_id, 'provider id'),
      provider_call_id: optionalSafeId(row.provider_call_id, 'provider call id'),
      provider_event_id: optionalSafeId(row.provider_event_id, 'provider event id'),
      status,
      argument_digest: optionalDigest(row.argument_digest),
      argument_count: argumentCountValue,
      input_state: 'withheld',
      output_state: 'withheld',
      error_code: optionalSafeId(row.error_code, 'error code'),
      observed_at: safeTimestamp(row.observed_at),
    }
  } catch {
    return null
  }
}

const optionalDigest = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ValidationError('argument digest is invalid')
  }
  return value
}

const safeTimestamp = (value: unknown): string => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || value.length > 64) {
    throw new ValidationError('observed timestamp is invalid')
  }
  return value
}

/**
 * Restart-safe tool control built on the existing causal event ledger. Direct terminal
 * execution is deliberately outside this managed authorization path.
 */
export class SessionToolService {
  readonly #events: EventStore
  readonly #attention: AttentionService

  constructor(
    private readonly db: Database.Database,
    private readonly capabilityRegistry: ToolCapabilityRegistry,
    private readonly providerMatrix: readonly DeclaredProviderCapabilityMatrixRow[],
  ) {
    this.#events = new EventStore(db)
    this.#attention = new AttentionService(db)
  }

  snapshot(sessionId: string): SessionToolSnapshot {
    const session = this.#session(sessionId)
    const policy = this.policy(session.id)
    const tools = this.capabilityRegistry.list({ sessionId: session.id })
      .filter((tool) => tool.provider_id === null || tool.provider_id === session.provider)
      .map((tool) => ({
        ...tool,
        permission: {
          ...tool.permission,
          requested: decisionFor(policy, tool),
          source: 'session_policy' as const,
        },
      }))
    const permissionDrifts = tools.map(permissionDrift)
    return {
      schema_version: 1,
      session: {
        id: session.id,
        provider: session.provider,
        workspace_id: session.workspace_id,
        board_id: session.board_id,
        mode: session.mode,
        access_profile: session.access_profile,
      },
      provider: this.providerMatrix.find((row) => row.provider_id === session.provider) ?? null,
      policy,
      tools,
      permission_drift: permissionDrifts,
      invocations: this.#invocations(session.id),
      approvals: this.#approvals(session),
      direct_terminal_is_source_of_truth: true,
    }
  }

  policy(sessionId: string): SessionToolPolicy {
    this.#session(sessionId)
    const event = this.db.prepare(`SELECT payload, created_at FROM os_events
      WHERE session_id=? AND kind='session.tool_policy.updated'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sessionId) as {
        payload: string
        created_at: string
      } | undefined
    if (!event) {
      return Object.freeze({
        schema_version: 1,
        session_id: sessionId,
        revision: 0,
        default_decision: 'approval_required',
        rules: Object.freeze([]),
        updated_by: 'system',
        updated_at: null,
      })
    }
    return this.#policyFromPayload(
      sessionId,
      parseJson<Record<string, unknown>>(event.payload, {}),
      event.created_at,
    )
  }

  #policyFromPayload(
    sessionId: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ): SessionToolPolicy {
    return Object.freeze({
      schema_version: 1,
      session_id: sessionId,
      revision: nonNegativeInteger(payload.revision, 'tool policy revision'),
      default_decision: policyDecision(payload.default_decision, 'default tool decision'),
      rules: normalizeRules(payload.rules as SessionToolPolicyRule[] | undefined),
      updated_by: safeId(payload.updated_by, 'tool policy actor'),
      updated_at: createdAt,
    })
  }

  setPolicy(sessionId: string, input: SetSessionToolPolicyInput): SessionToolPolicy {
    const session = this.#session(sessionId)
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expected revision')
    const rules = normalizeRules(input.rules)
    const actor = durableActor(input.actor, 'tool policy actor')
    const idempotencyKey = safeId(input.idempotencyKey, 'idempotency key')
    const next = {
      schema_version: 1 as const,
      session_id: session.id,
      revision: expectedRevision + 1,
      default_decision: policyDecision(input.defaultDecision, 'default tool decision'),
      rules,
      updated_by: actor.id,
    }
    const replay = this.#eventForIdempotency(
      session.board_id,
      idempotencyKey,
      'session.tool_policy.updated',
    )
    if (replay) {
      if (stableJson(replay.payload) !== stableJson(next)) {
        throw new ConflictError('event idempotency key was already used for a different event')
      }
      return this.#policyFromPayload(
        session.id,
        replay.payload as Record<string, unknown>,
        replay.created_at,
      )
    }
    const current = this.policy(session.id)
    if (expectedRevision !== current.revision) {
      throw new ConflictError('tool policy revision changed; reload before updating')
    }
    this.#events.append({
      boardId: session.board_id,
      actor,
      workspaceId: session.workspace_id,
      cardId: session.card_id,
      sessionId: session.id,
      idempotencyKey,
      kind: 'session.tool_policy.updated',
      source: 'tool-policy',
      payload: next,
    })
    return this.policy(session.id)
  }

  requestInvocation(
    sessionId: string,
    input: RequestToolInvocationInput,
  ): SessionToolAuthorization {
    const session = this.#session(sessionId)
    const snapshot = this.snapshot(session.id)
    const toolId = safeId(input.toolId, 'tool id')
    const tool = snapshot.tools.find((candidate) => candidate.id === toolId)
    if (!tool) throw new NotFoundError('tool is not available in this session')
    const actor = durableActor(input.actor, 'tool request actor')
    const idempotencyKey = safeId(input.idempotencyKey, 'idempotency key')
    const requestId = input.requestId === undefined
      ? stableEventId('tool-approval', idempotencyKey)
      : safeId(input.requestId, 'tool approval request id')
    const requested = tool.permission.requested
    const effective = tool.permission.effective

    let decision: ToolPolicyDecision = requested
    let reason = 'session policy requires approval'
    if (requested === 'deny') {
      decision = 'deny'
      reason = 'session policy denies this tool'
    } else if (tool.managed_support !== 'supported' || tool.status !== 'ready') {
      decision = 'deny'
      reason = 'managed tool support is not accepted for this exact provider evidence'
    } else if (effective === 'deny') {
      decision = 'deny'
      reason = 'effective provider permission denies this tool'
    } else if (requested === 'allow' && effective === 'allow') {
      decision = 'allow'
      reason = 'session policy and effective provider permission allow this tool'
    } else if (effective === 'unknown') {
      decision = 'approval_required'
      reason = 'effective provider permission is unknown and fails closed to approval'
    } else if (effective === 'approval_required') {
      decision = 'approval_required'
      reason = 'effective provider permission requires approval'
    }

    const event = this.#events.append({
      boardId: session.board_id,
      actor,
      workspaceId: session.workspace_id,
      cardId: session.card_id,
      sessionId: session.id,
      idempotencyKey,
      kind: decision === 'approval_required'
        ? 'session.tool_approval.requested'
        : 'session.tool_authorization.decided',
      source: 'tool-policy',
      payload: {
        request_id: requestId,
        tool_id: tool.id,
        provider_id: session.provider,
        decision,
        reason_code: reason.replaceAll(' ', '_'),
      },
    })
    const eventPayload = event.payload as Record<string, unknown>
    const durableRequestId = safeId(eventPayload.request_id, 'tool request id')
    const durableDecision = policyDecision(eventPayload.decision, 'tool authorization decision')
    let attention: AttentionItem | null = null
    if (durableDecision === 'approval_required') {
      attention = this.#approvalForRequest(session, durableRequestId)
        ?? this.#attention.create({
          boardId: session.board_id,
          workspaceId: session.workspace_id,
          cardId: session.card_id,
          agentId: session.agent_id,
          kind: 'tool.approval.request',
          severity: 'critical',
          title: `Tool approval needed: ${tool.name}`,
          detail: JSON.stringify({
            request_id: durableRequestId,
            session_id: session.id,
            tool_id: tool.id,
            provider_id: session.provider,
          }),
          dedupe: false,
        })
    }
    return {
      decision: durableDecision,
      reason,
      tool,
      attention,
      approval_request_id: durableDecision === 'approval_required'
        ? durableRequestId
        : null,
    }
  }

  recordInvocation(
    sessionId: string,
    input: RecordToolInvocationInput,
  ): ToolInvocationProvenance {
    const session = this.#session(sessionId)
    const toolId = safeId(input.toolId, 'tool id')
    const tool = this.snapshot(session.id).tools.find((candidate) => candidate.id === toolId)
    if (!tool) throw new NotFoundError('tool is not available in this session')
    if (!invocationStatuses.has(input.status)) {
      throw new ValidationError('tool invocation status is invalid')
    }
    const idempotencyKey = safeId(input.idempotencyKey, 'idempotency key')
    const replay = this.#eventForIdempotency(
      session.board_id,
      idempotencyKey,
      'session.tool_invocation.recorded',
    )
    const replayProvenance = replay === null ? null : mapInvocation(replay.payload)
    const provenance: ToolInvocationProvenance = {
      schema_version: 1,
      invocation_id: input.invocationId === undefined
        ? stableEventId('tool-invocation', idempotencyKey)
        : safeId(input.invocationId, 'invocation id'),
      session_id: session.id,
      tool_id: tool.id,
      provider_id: tool.provider_id,
      provider_call_id: optionalSafeId(input.providerCallId, 'provider call id'),
      provider_event_id: optionalSafeId(input.providerEventId, 'provider event id'),
      status: input.status,
      argument_digest: invocationDigest(input.arguments),
      argument_count: argumentCount(input.arguments),
      input_state: 'withheld',
      output_state: 'withheld',
      error_code: optionalSafeId(input.errorCode, 'tool error code'),
      observed_at: input.observedAt === undefined
        ? replayProvenance?.observed_at ?? new Date().toISOString()
        : safeTimestamp(input.observedAt),
    }
    const event = this.#events.append({
      boardId: session.board_id,
      actor: durableActor(input.actor, 'tool invocation actor'),
      workspaceId: session.workspace_id,
      cardId: session.card_id,
      sessionId: session.id,
      idempotencyKey,
      kind: 'session.tool_invocation.recorded',
      source: 'tool-runtime',
      payload: provenance,
    })
    const persisted = mapInvocation(event.payload)
    if (!persisted) throw new ConflictError('durable tool invocation provenance is invalid')
    return persisted
  }

  #session(sessionId: string): SessionScope {
    const id = safeId(sessionId, 'session id')
    const row = this.db.prepare(`SELECT s.id, s.workspace_id, s.provider, s.mode,
      s.access_profile, s.agent_id, w.board_id, w.card_id
      FROM agent_sessions s JOIN workspaces w ON w.id=s.workspace_id
      WHERE s.id=?`).get(id) as SessionScope | undefined
    if (!row) throw new NotFoundError('agent session not found')
    return {
      ...row,
      id: String(row.id),
      workspace_id: String(row.workspace_id),
      provider: String(row.provider),
      mode: String(row.mode),
      access_profile: row.access_profile === null ? null : String(row.access_profile),
      board_id: Number(row.board_id),
      card_id: row.card_id === null ? null : Number(row.card_id),
      agent_id: row.agent_id === null ? null : Number(row.agent_id),
    }
  }

  #invocations(sessionId: string): ToolInvocationProvenance[] {
    const rows = this.db.prepare(`SELECT payload FROM os_events
      WHERE session_id=? AND kind='session.tool_invocation.recorded'
      ORDER BY created_at DESC, rowid DESC LIMIT 100`).all(sessionId) as Array<{ payload: string }>
    return rows.map((row) => mapInvocation(parseJson(row.payload, {})))
      .filter((row): row is ToolInvocationProvenance => row !== null)
  }

  #eventForIdempotency(
    boardId: number,
    idempotencyKey: string,
    expectedKind: string,
  ): { payload: unknown; created_at: string } | null {
    const row = this.db.prepare(`SELECT kind, payload, created_at FROM os_events
      WHERE board_id=? AND idempotency_key=?`).get(boardId, idempotencyKey) as {
        kind: string
        payload: string
        created_at: string
      } | undefined
    if (!row) return null
    if (row.kind !== expectedKind) {
      throw new ConflictError('event idempotency key was already used for a different event')
    }
    return { payload: parseJson(row.payload, {}), created_at: row.created_at }
  }

  #approvals(session: SessionScope): AttentionItem[] {
    return this.#attention.listBoard(session.board_id, 'open').filter((item) => {
      if (item.kind !== 'tool.approval.request') return false
      try {
        const detail = JSON.parse(item.detail) as Record<string, unknown>
        return detail.session_id === session.id
      } catch {
        return false
      }
    })
  }

  #approvalForRequest(session: SessionScope, requestId: string): AttentionItem | null {
    return this.#approvals(session).find((item) => {
      try {
        const detail = JSON.parse(item.detail) as Record<string, unknown>
        return detail.request_id === requestId
      } catch {
        return false
      }
    }) ?? null
  }
}

export const isToolCapabilityKind = (value: unknown): value is ToolCapabilityKind =>
  typeof value === 'string'
  && (TOOL_CAPABILITY_KINDS as readonly string[]).includes(value)

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ConflictError, ValidationError } from './errors.js'
import { parseJson } from './json.js'

export interface ActorIdentity {
  type: string
  id: string | null
}

export const ACCESS_PROFILES = ['read_only', 'workspace_write', 'full_access'] as const
export type AgentHomeAccessProfile = (typeof ACCESS_PROFILES)[number]

export const SESSION_MODES = ['managed', 'ambient', 'compatibility'] as const
export type AgentSessionMode = (typeof SESSION_MODES)[number]

export const RECOVERY_STATES = ['unknown', 'attachable', 'detached', 'lost', 'unsupported'] as const
export type AgentSessionRecoveryState = (typeof RECOVERY_STATES)[number]

export const HISTORY_STATES = ['complete', 'partial', 'unavailable'] as const
export type AgentSessionHistoryState = (typeof HISTORY_STATES)[number]

export function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field} is required`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw new ValidationError(`${field} must be at most ${maximum} characters`)
  return normalized
}

export function optionalBoundedString(
  value: unknown,
  field: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value === '') return null
  return boundedString(value, field, maximum)
}

export function nullablePatchString(
  value: unknown,
  field: string,
  maximum: number,
): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return boundedString(value, field, maximum)
}

export function providerIdentifier(value: unknown, field: string): string | null {
  const provider = optionalBoundedString(value, field, 64)
  if (provider !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider)) {
    throw new ValidationError(`${field} must be a provider identifier`)
  }
  return provider
}

export function actorIdentity(value: ActorIdentity): ActorIdentity {
  return {
    type: boundedString(value.type, 'actor type', 64),
    id: optionalBoundedString(value.id, 'actor id', 256),
  }
}

export function stringList(value: unknown, field: string, maximum = 100): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== 'string')) {
    throw new ValidationError(`${field} must be an array of at most ${maximum} strings`)
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

export function jsonRecord(value: unknown, field: string, maximumBytes = 64_000): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`)
  }
  const serialized = stableJson(value)
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new ValidationError(`${field} must be at most ${maximumBytes} bytes`)
  }
  return value as Record<string, unknown>
}

export function accessProfile(value: unknown, field: string): AgentHomeAccessProfile | null {
  const normalized = optionalBoundedString(value, field, 32)
  if (normalized === null) return null
  if (!ACCESS_PROFILES.includes(normalized as AgentHomeAccessProfile)) {
    throw new ValidationError(`${field} must be read_only, workspace_write, or full_access`)
  }
  return normalized as AgentHomeAccessProfile
}

export function sessionMode(value: unknown): AgentSessionMode {
  const normalized = boundedString(value, 'mode', 32)
  if (!SESSION_MODES.includes(normalized as AgentSessionMode)) {
    throw new ValidationError('mode must be managed, ambient, or compatibility')
  }
  return normalized as AgentSessionMode
}

export function recoveryState(value: unknown): AgentSessionRecoveryState {
  const normalized = boundedString(value, 'recovery state', 32)
  if (!RECOVERY_STATES.includes(normalized as AgentSessionRecoveryState)) {
    throw new ValidationError('recovery state is invalid')
  }
  return normalized as AgentSessionRecoveryState
}

export function historyState(value: unknown): AgentSessionHistoryState {
  const normalized = boundedString(value, 'history state', 32)
  if (!HISTORY_STATES.includes(normalized as AgentSessionHistoryState)) {
    throw new ValidationError('history state is invalid')
  }
  return normalized as AgentSessionHistoryState
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? 'null'
}

export function commandReplay(
  db: Database.Database,
  input: {
    boardId: number
    idempotencyKey: string
    kind: string
    requestFingerprint: string
  },
): Record<string, unknown> | null {
  const row = db.prepare('SELECT kind, payload FROM os_events WHERE board_id=? AND idempotency_key=?')
    .get(input.boardId, input.idempotencyKey) as { kind: string; payload: string } | undefined
  if (!row) return null
  const payload = parseJson<Record<string, unknown>>(row.payload, {})
  if (row.kind !== input.kind || payload.request_fingerprint !== input.requestFingerprint) {
    throw new ConflictError('idempotency key was already used for a different Agent Home command')
  }
  return payload
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    const serializable = value as Record<string, unknown> & { toJSON?: () => unknown }
    if (typeof serializable.toJSON === 'function') return sortJson(serializable.toJSON())
    return Object.fromEntries(
      Object.entries(serializable)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    )
  }
  return value
}

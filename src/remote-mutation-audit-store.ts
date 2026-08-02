import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  REMOTE_RESOURCE_TYPES,
  REMOTE_SCOPES,
  type RemoteAuthorizationDenialCode,
  type RemoteMutationAuditEnvelope,
  type RemoteMutationDenialAuditEnvelope,
  type RemoteResourceType,
} from './remote-authorization-policy.js'

export type RemoteDeviceLifecycleAuditDenialCode =
  | 'new_public_key_required'
  | 'new_public_key_invalid'
  | 'new_public_key_reused'
  | 'new_key_proof_invalid'
  | 'invalid_request_id'
  | 'credential_rotation_denied'

interface RemoteDeviceLifecycleAuditBase {
  schema_version: 1
  occurred_at: string
  operation: 'device.credential.rotate'
  rule_id: 'device.credential.rotate.proof-bound'
  resource_type: 'device'
  resource_id: string
  device_session_id: string
  authenticated_user_id: string
  credential_version: number
  request_id: string
  correlation_id: string
  request_digest: string
  tunnel_origin: string
  sensitive_values_retained: false
}

export type RemoteDeviceLifecycleAuditEnvelope =
  | (RemoteDeviceLifecycleAuditBase & {
    outcome: 'succeeded' | 'failed'
    attributed_scope: null
    step_up_grant_id: null
  })
  | (RemoteDeviceLifecycleAuditBase & {
    outcome: 'denied'
    denial_code: RemoteDeviceLifecycleAuditDenialCode
  })

export type PersistableRemoteMutationAuditEnvelope =
  | RemoteMutationAuditEnvelope
  | RemoteMutationDenialAuditEnvelope
  | RemoteDeviceLifecycleAuditEnvelope

export interface RemoteMutationAuditSink {
  persist(envelope: PersistableRemoteMutationAuditEnvelope): string
}

const BASE_KEYS = [
  'authenticated_user_id',
  'correlation_id',
  'credential_version',
  'device_session_id',
  'occurred_at',
  'operation',
  'outcome',
  'request_digest',
  'request_id',
  'resource_id',
  'resource_type',
  'rule_id',
  'schema_version',
  'sensitive_values_retained',
  'tunnel_origin',
] as const

const SUCCESS_KEYS = [...BASE_KEYS, 'attributed_scope', 'step_up_grant_id'].sort()
const DENIAL_KEYS = [...BASE_KEYS, 'denial_code'].sort()
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u
const REQUEST_DIGEST = /^sha256:[0-9a-f]{64}$/u
const REMOTE_RESOURCE_TYPE_SET = new Set<string>(REMOTE_RESOURCE_TYPES)
const MUTATION_SCOPE_SET = new Set<string>(REMOTE_SCOPES.filter((scope) => scope !== 'observe'))
const LIFECYCLE_DENIAL_CODES = new Set<RemoteDeviceLifecycleAuditDenialCode>([
  'new_public_key_required',
  'new_public_key_invalid',
  'new_public_key_reused',
  'new_key_proof_invalid',
  'invalid_request_id',
  'credential_rotation_denied',
])
const AUTHORIZATION_DENIAL_CODES = new Set<RemoteAuthorizationDenialCode>([
  'unclassified_operation',
  'invalid_clock',
  'principal_invalid',
  'local_operator_not_allowed',
  'device_inactive',
  'device_expired',
  'credential_expired',
  'scope_missing',
  'resource_unverified',
  'resource_mismatch',
  'resource_grant_missing',
  'data_class_denied',
  'field_denied',
  'recent_authentication_required',
  'request_digest_required',
  'step_up_required',
  'step_up_inactive',
  'step_up_mismatch',
  'step_up_expired',
  'step_up_replayed',
  'step_up_claim_required',
  'rate_limit_exceeded',
  'invalid_request',
])

const EXPECTED_COLUMNS = Object.freeze([
  ['id', 'TEXT', 0, 1],
  ['occurred_at', 'TEXT', 1, 0],
  ['operation', 'TEXT', 1, 0],
  ['rule_id', 'TEXT', 0, 0],
  ['outcome', 'TEXT', 1, 0],
  ['denial_code', 'TEXT', 0, 0],
  ['resource_type', 'TEXT', 0, 0],
  ['resource_id', 'TEXT', 0, 0],
  ['device_session_id', 'TEXT', 1, 0],
  ['authenticated_user_id', 'TEXT', 1, 0],
  ['credential_generation', 'INTEGER', 1, 0],
  ['attributed_scope', 'TEXT', 0, 0],
  ['step_up_grant_id', 'TEXT', 0, 0],
  ['request_id', 'TEXT', 1, 0],
  ['correlation_id', 'TEXT', 1, 0],
  ['request_digest', 'TEXT', 0, 0],
  ['tunnel_origin', 'TEXT', 1, 0],
  ['sensitive_values_retained', 'INTEGER', 1, 0],
] as const)

type TableInfo = {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  if (Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)
    || Object.getOwnPropertySymbols(value).length > 0) return false
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

const canonicalInstant = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try { return new Date(value).toISOString() === value } catch { return false }
}

const validOrigin = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    const parsed = new URL(value)
    const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname)
    return parsed.origin === value
      && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))
  } catch { return false }
}

const assertBaseEnvelope = (
  envelope: PersistableRemoteMutationAuditEnvelope,
): void => {
  if (envelope.schema_version !== 1 || envelope.sensitive_values_retained !== false
    || !canonicalInstant(envelope.occurred_at)
    || !SAFE_LABEL.test(envelope.operation)
    || (envelope.rule_id !== null && !SAFE_LABEL.test(envelope.rule_id))
    || !OPAQUE_ID.test(envelope.device_session_id)
    || !OPAQUE_ID.test(envelope.authenticated_user_id)
    || !Number.isSafeInteger(envelope.credential_version) || envelope.credential_version <= 0
    || !OPAQUE_ID.test(envelope.request_id) || !OPAQUE_ID.test(envelope.correlation_id)
    || !validOrigin(envelope.tunnel_origin)) {
    throw new RemoteMutationAuditPersistenceError('invalid closed remote audit envelope')
  }
  if (envelope.resource_type !== null
    && !REMOTE_RESOURCE_TYPE_SET.has(envelope.resource_type)) {
    throw new RemoteMutationAuditPersistenceError('invalid remote audit resource type')
  }
  if (envelope.resource_id !== null && !OPAQUE_ID.test(envelope.resource_id)) {
    throw new RemoteMutationAuditPersistenceError('invalid remote audit resource id')
  }
  if (envelope.request_digest !== null && !REQUEST_DIGEST.test(envelope.request_digest)) {
    throw new RemoteMutationAuditPersistenceError('invalid remote audit request digest')
  }
}

const assertExactEnvelope = (
  envelope: PersistableRemoteMutationAuditEnvelope,
): void => {
  const keys = envelope.outcome === 'denied' ? DENIAL_KEYS : SUCCESS_KEYS
  if (!exactKeys(envelope, keys)) {
    throw new RemoteMutationAuditPersistenceError('remote audit envelope is not exact and closed')
  }
  assertBaseEnvelope(envelope)
  if (envelope.outcome === 'denied') {
    const lifecycle = envelope.operation === 'device.credential.rotate'
    if (envelope.rule_id !== (lifecycle ? 'device.credential.rotate.proof-bound' : envelope.rule_id)
      || (lifecycle
        ? !LIFECYCLE_DENIAL_CODES.has(envelope.denial_code as RemoteDeviceLifecycleAuditDenialCode)
        : !AUTHORIZATION_DENIAL_CODES.has(envelope.denial_code as RemoteAuthorizationDenialCode))) {
      throw new RemoteMutationAuditPersistenceError('invalid remote audit denial code')
    }
    return
  }
  const lifecycle = envelope.operation === 'device.credential.rotate'
  if (lifecycle) {
    if (envelope.rule_id !== 'device.credential.rotate.proof-bound'
      || envelope.attributed_scope !== null || envelope.step_up_grant_id !== null) {
      throw new RemoteMutationAuditPersistenceError('invalid credential lifecycle audit envelope')
    }
  } else if (!MUTATION_SCOPE_SET.has(envelope.attributed_scope as string)) {
    throw new RemoteMutationAuditPersistenceError('invalid remote audit attributed scope')
  }
}

const assertExactAuditTable = (db: Database.Database): void => {
  const columns = db.prepare('PRAGMA table_info(os_remote_mutation_audit)').all() as TableInfo[]
  if (columns.length !== EXPECTED_COLUMNS.length) {
    throw new RemoteMutationAuditPersistenceError('remote mutation audit schema is unavailable')
  }
  for (const [index, expected] of EXPECTED_COLUMNS.entries()) {
    const actual = columns[index]
    if (!actual || actual.name !== expected[0] || actual.type.toUpperCase() !== expected[1]
      || actual.notnull !== expected[2] || actual.pk !== expected[3]) {
      throw new RemoteMutationAuditPersistenceError('remote mutation audit schema is incompatible')
    }
  }
}

export class RemoteMutationAuditPersistenceError extends Error {
  override readonly name = 'RemoteMutationAuditPersistenceError'
}

/**
 * Persists only the two policy-produced envelope shapes and the proof-bound credential lifecycle
 * shape. Extra request values, secrets, payloads, JWKs, and signatures are rejected at runtime.
 */
export class SqliteRemoteMutationAuditStore implements RemoteMutationAuditSink {
  constructor(
    private readonly db: Database.Database,
    private readonly createId: () => string = randomUUID,
  ) {
    installRemoteMutationAuditImmutability(db)
  }

  persist(envelope: PersistableRemoteMutationAuditEnvelope): string {
    assertExactEnvelope(envelope)
    const id = this.createId()
    if (!OPAQUE_ID.test(id)) throw new RemoteMutationAuditPersistenceError('invalid audit id')
    const denialCode = envelope.outcome === 'denied' ? envelope.denial_code : null
    const attributedScope = envelope.outcome === 'denied' ? null : envelope.attributed_scope
    const stepUpGrantId = envelope.outcome === 'denied' ? null : envelope.step_up_grant_id
    try {
      const result = this.db.prepare(`INSERT INTO os_remote_mutation_audit (
        id, occurred_at, operation, rule_id, outcome, denial_code, resource_type, resource_id,
        device_session_id, authenticated_user_id, credential_generation, attributed_scope,
        step_up_grant_id, request_id, correlation_id, request_digest, tunnel_origin,
        sensitive_values_retained
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
        id,
        envelope.occurred_at,
        envelope.operation,
        envelope.rule_id,
        envelope.outcome,
        denialCode,
        envelope.resource_type,
        envelope.resource_id,
        envelope.device_session_id,
        envelope.authenticated_user_id,
        envelope.credential_version - 1,
        attributedScope,
        stepUpGrantId,
        envelope.request_id,
        envelope.correlation_id,
        envelope.request_digest,
        envelope.tunnel_origin,
      )
      if (result.changes !== 1) throw new Error('audit insert did not persist exactly one row')
      return id
    } catch (error) {
      if (error instanceof RemoteMutationAuditPersistenceError) throw error
      throw new RemoteMutationAuditPersistenceError('remote mutation audit persistence failed', {
        cause: error,
      })
    }
  }
}

const REMOTE_MUTATION_AUDIT_NO_UPDATE_SQL = `CREATE TRIGGER IF NOT EXISTS os_remote_mutation_audit_no_update
  BEFORE UPDATE ON os_remote_mutation_audit
  BEGIN SELECT RAISE(ABORT, 'remote mutation audit is append-only'); END`

const REMOTE_MUTATION_AUDIT_NO_DELETE_SQL = `CREATE TRIGGER IF NOT EXISTS os_remote_mutation_audit_no_delete
  BEFORE DELETE ON os_remote_mutation_audit
  BEGIN SELECT RAISE(ABORT, 'remote mutation audit is append-only'); END`

export const REMOTE_MUTATION_AUDIT_IMMUTABILITY_SQL = `
  ${REMOTE_MUTATION_AUDIT_NO_UPDATE_SQL};
  ${REMOTE_MUTATION_AUDIT_NO_DELETE_SQL};
`

const normalizedSql = (value: string): string => value.replace(/\s+/gu, ' ')
  .replace(/;\s*$/u, '').trim()
  .replace(/^CREATE TRIGGER IF NOT EXISTS /u, 'CREATE TRIGGER ')

const expectedTriggerSql = new Map([
  ['os_remote_mutation_audit_no_update', normalizedSql(REMOTE_MUTATION_AUDIT_NO_UPDATE_SQL)],
  ['os_remote_mutation_audit_no_delete', normalizedSql(REMOTE_MUTATION_AUDIT_NO_DELETE_SQL)],
])

const assertExactAuditTriggers = (db: Database.Database, allowMissing: boolean): void => {
  for (const [name, expectedSql] of expectedTriggerSql) {
    const row = db.prepare(`SELECT type, sql FROM sqlite_master WHERE name=?`).get(name) as {
      type: string
      sql: string | null
    } | undefined
    if (!row) {
      if (!allowMissing) {
        throw new RemoteMutationAuditPersistenceError('remote mutation audit guard is missing')
      }
      continue
    }
    if (row.type !== 'trigger' || !row.sql || normalizedSql(row.sql) !== expectedSql) {
      throw new RemoteMutationAuditPersistenceError('remote mutation audit guard is incompatible')
    }
  }
}

/** Exact replay-safe installer for mandatory append-only audit guards. */
export function installRemoteMutationAuditImmutability(db: Database.Database): void {
  const install = db.transaction(() => {
    assertExactAuditTable(db)
    assertExactAuditTriggers(db, true)
    db.exec(REMOTE_MUTATION_AUDIT_IMMUTABILITY_SQL)
    assertExactAuditTriggers(db, false)
  })
  install.immediate()
}

export function remoteDeviceLifecycleResource(
  resourceId: string,
): { resource_type: RemoteResourceType; resource_id: string } {
  if (!OPAQUE_ID.test(resourceId)) throw new Error('device resource id must be a bounded opaque id')
  return Object.freeze({ resource_type: 'device', resource_id: resourceId })
}

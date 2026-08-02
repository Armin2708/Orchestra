import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import type Database from 'better-sqlite3'

export const OPERATIONS_RECOVERY_SCHEMA_ID = '031-operations-recovery-foundation'

/**
 * Migration integration contract for the lane root. This module deliberately does not register
 * the migration: the integration owner must apply it after the DeviceSession migration and add
 * the migration id to the canonical checksum register.
 */
export const OPERATIONS_RECOVERY_SCHEMA_SQL = `
  CREATE TABLE ops_outbox (
    id TEXT PRIMARY KEY,
    board_id INTEGER REFERENCES boards(id) ON DELETE CASCADE,
    event_id TEXT,
    destination TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','delivering','delivered','dead')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 100),
    available_at TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    UNIQUE(destination, dedupe_key),
    CHECK((status='delivering') = (lease_owner IS NOT NULL)),
    CHECK((status='delivering') = (lease_expires_at IS NOT NULL)),
    CHECK((status='delivered') = (delivered_at IS NOT NULL))
  );

  CREATE INDEX idx_ops_outbox_ready
    ON ops_outbox(status, available_at, created_at, id);
  CREATE INDEX idx_ops_outbox_event
    ON ops_outbox(event_id, destination);

  CREATE TABLE ops_event_consumptions (
    consumer TEXT NOT NULL,
    event_id TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
    consumed_at TEXT NOT NULL,
    PRIMARY KEY(consumer, event_id)
  ) WITHOUT ROWID;

  CREATE TABLE ops_recovery_runs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    CHECK((completed_at IS NULL) = (result_json IS NULL))
  );

  CREATE TABLE ops_retention_policies (
    board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
    event_days INTEGER NOT NULL CHECK(event_days BETWEEN 1 AND 36500),
    transcript_days INTEGER NOT NULL CHECK(transcript_days BETWEEN 1 AND 36500),
    pty_days INTEGER NOT NULL CHECK(pty_days BETWEEN 1 AND 36500),
    artifact_days INTEGER NOT NULL CHECK(artifact_days BETWEEN 1 AND 36500),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE ops_compaction_archives (
    id TEXT PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN ('event','pty','artifact')),
    subject_id TEXT NOT NULL,
    first_item TEXT,
    last_item TEXT,
    item_count INTEGER NOT NULL CHECK(item_count > 0),
    original_bytes INTEGER NOT NULL CHECK(original_bytes >= 0),
    content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
    content_encoding TEXT NOT NULL DEFAULT 'gzip' CHECK(content_encoding='gzip'),
    content_gzip BLOB NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(category, subject_id, first_item, last_item)
  );
`

type SchemaColumn = readonly [
  name: string,
  type: string,
  notnull: number,
  defaultValue: string | null,
  primaryKey: number,
]

const schemaColumns = (columns: readonly SchemaColumn[]): readonly SchemaColumn[] =>
  Object.freeze(columns)

const OPERATIONS_RECOVERY_COLUMNS: Readonly<Record<string, readonly SchemaColumn[]>> = Object.freeze({
  ops_outbox: schemaColumns([
    ['id', 'TEXT', 0, null, 1],
    ['board_id', 'INTEGER', 0, null, 0],
    ['event_id', 'TEXT', 0, null, 0],
    ['destination', 'TEXT', 1, null, 0],
    ['dedupe_key', 'TEXT', 1, null, 0],
    ['payload_json', 'TEXT', 1, null, 0],
    ['payload_sha256', 'TEXT', 1, null, 0],
    ['status', 'TEXT', 1, "'pending'", 0],
    ['attempts', 'INTEGER', 1, '0', 0],
    ['max_attempts', 'INTEGER', 1, null, 0],
    ['available_at', 'TEXT', 1, null, 0],
    ['lease_owner', 'TEXT', 0, null, 0],
    ['lease_expires_at', 'TEXT', 0, null, 0],
    ['last_error', 'TEXT', 0, null, 0],
    ['created_at', 'TEXT', 1, null, 0],
    ['delivered_at', 'TEXT', 0, null, 0],
  ]),
  ops_event_consumptions: schemaColumns([
    ['consumer', 'TEXT', 1, null, 1],
    ['event_id', 'TEXT', 1, null, 2],
    ['payload_sha256', 'TEXT', 1, null, 0],
    ['consumed_at', 'TEXT', 1, null, 0],
  ]),
  ops_recovery_runs: schemaColumns([
    ['id', 'TEXT', 0, null, 1],
    ['owner_id', 'TEXT', 1, null, 0],
    ['started_at', 'TEXT', 1, null, 0],
    ['completed_at', 'TEXT', 0, null, 0],
    ['result_json', 'TEXT', 0, null, 0],
  ]),
  ops_retention_policies: schemaColumns([
    ['board_id', 'INTEGER', 0, null, 1],
    ['event_days', 'INTEGER', 1, null, 0],
    ['transcript_days', 'INTEGER', 1, null, 0],
    ['pty_days', 'INTEGER', 1, null, 0],
    ['artifact_days', 'INTEGER', 1, null, 0],
    ['updated_at', 'TEXT', 1, null, 0],
  ]),
  ops_compaction_archives: schemaColumns([
    ['id', 'TEXT', 0, null, 1],
    ['board_id', 'INTEGER', 1, null, 0],
    ['category', 'TEXT', 1, null, 0],
    ['subject_id', 'TEXT', 1, null, 0],
    ['first_item', 'TEXT', 0, null, 0],
    ['last_item', 'TEXT', 0, null, 0],
    ['item_count', 'INTEGER', 1, null, 0],
    ['original_bytes', 'INTEGER', 1, null, 0],
    ['content_sha256', 'TEXT', 1, null, 0],
    ['content_encoding', 'TEXT', 1, "'gzip'", 0],
    ['content_gzip', 'BLOB', 1, null, 0],
    ['created_at', 'TEXT', 1, null, 0],
  ]),
})

const normalizeSchemaSql = (sql: string): string =>
  sql.replace(/\s+/gu, ' ').replace(/;\s*$/u, '').trim()

const OPERATIONS_RECOVERY_OBJECTS = Object.freeze(
  OPERATIONS_RECOVERY_SCHEMA_SQL.split(';')
    .map((sql) => sql.trim())
    .filter(Boolean)
    .map((sql) => {
      const match = /^CREATE\s+(TABLE|INDEX)\s+([a-z0-9_]+)/iu.exec(sql)
      if (!match) throw new Error('operations recovery schema contains an unrecognized object')
      return Object.freeze({
        type: match[1]!.toLowerCase() as 'table' | 'index',
        name: match[2]!,
        sql: normalizeSchemaSql(sql),
      })
    }),
)

export const OPERATIONS_RECOVERY_SCHEMA_SHA256 = createHash('sha256')
  .update(OPERATIONS_RECOVERY_OBJECTS.map((object) => object.sql).join('\n'))
  .digest('hex')

/** Attest every table/index owned by migration 031 without repairing or weakening it. */
export function attestOperationsRecoverySchema(db: Database.Database): void {
  const names = OPERATIONS_RECOVERY_OBJECTS.map((object) => object.name)
  const placeholders = names.map(() => '?').join(',')
  const rows = db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE name IN (${placeholders})`).all(...names) as Array<{
      type: string
      name: string
      sql: string | null
    }>
  const byName = new Map(rows.map((row) => [row.name, row]))
  for (const expected of OPERATIONS_RECOVERY_OBJECTS) {
    const existing = byName.get(expected.name)
    if (!existing) throw new Error(`operations recovery schema object is missing: ${expected.name}`)
    if (existing.type !== expected.type || existing.sql === null
      || normalizeSchemaSql(existing.sql) !== expected.sql) {
      throw new Error(`operations recovery schema object does not match: ${expected.name}`)
    }
    if (expected.type !== 'table') continue
    const expectedColumns = OPERATIONS_RECOVERY_COLUMNS[expected.name]
    if (!expectedColumns) throw new Error(`operations recovery column attestation is missing: ${expected.name}`)
    const columns = db.prepare(`SELECT cid, name, type, "notnull",
        dflt_value, pk FROM pragma_table_info(?) ORDER BY cid`).all(expected.name) as Array<{
          cid: number
          name: string
          type: string
          notnull: number
          dflt_value: string | null
          pk: number
        }>
    const actual = columns.map((column) => [
      column.name,
      column.type,
      column.notnull,
      column.dflt_value,
      column.pk,
    ] as const)
    if (JSON.stringify(actual) !== JSON.stringify(expectedColumns)) {
      throw new Error(`operations recovery table columns do not match: ${expected.name}`)
    }
  }
}

/**
 * Install migration 031 only when every owned object is absent. Any partial or same-name schema
 * fails before mutation; marker-loss replay is an exact attestation and no-op.
 */
export function installOperationsRecoverySchema(db: Database.Database): {
  created: boolean
  replayed: boolean
  schemaSha256: string
} {
  const install = db.transaction(() => {
    const names = OPERATIONS_RECOVERY_OBJECTS.map((object) => object.name)
    const placeholders = names.map(() => '?').join(',')
    const present = (db.prepare(`SELECT count(*) AS count FROM sqlite_master
      WHERE name IN (${placeholders})`).get(...names) as { count: number }).count
    if (present === 0) db.exec(OPERATIONS_RECOVERY_SCHEMA_SQL)
    attestOperationsRecoverySchema(db)
    return {
      created: present === 0,
      replayed: present === OPERATIONS_RECOVERY_OBJECTS.length,
      schemaSha256: OPERATIONS_RECOVERY_SCHEMA_SHA256,
    }
  })
  return install.immediate()
}

export type OutboxInput = {
  id?: string
  boardId?: number | null
  eventId?: string | null
  destination: string
  dedupeKey: string
  payload: unknown
  maxAttempts?: number
  availableAt?: string
}

export type OutboxDelivery = {
  id: string
  eventId: string | null
  destination: string
  dedupeKey: string
  /** Stable across every retry; downstream delivery must use this as its idempotency key. */
  idempotencyKey: string
  payload: unknown
  attempt: number
}

export type DispatchResult = {
  delivered: string[]
  retried: string[]
  dead: string[]
}

export type OrphanReconciliationResult = {
  runId: string
  lostProcesses: string[]
  lostSessions: string[]
  recoveredJobs: string[]
  blockedJobs: string[]
  cancelledJobs: string[]
  missingWorkspaces: string[]
  releasedLeases: string[]
}

export type OperationsRetentionPolicy = {
  board_id: number
  event_days: number
  transcript_days: number
  pty_days: number
  artifact_days: number
  updated_at: string
}

export type FailureMode =
  | 'disk_full'
  | 'database_locked'
  | 'database_corrupt'
  | 'provider_unavailable'
  | 'git_conflict'
  | 'path_violation'
  | 'unknown'

export type FailureDisposition = {
  mode: FailureMode
  retryable: boolean
  failClosed: boolean
  preserveActiveAuthority: boolean
  operatorAction: string
}

const timestamp = (): string => new Date().toISOString()
const bounded = (value: string, name: string, max = 512): string => {
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /[\0-\x1f\x7f]/u.test(normalized)) {
    throw new Error(`${name} is invalid`)
  }
  return normalized
}
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const stableJson = (value: unknown): string => JSON.stringify(sortJson(value)) ?? 'null'
const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]))
  }
  return value
}

const failureCode = (error: unknown): string => {
  if (!error || typeof error !== 'object') return ''
  const candidate = error as { operationsCode?: unknown; code?: unknown }
  return String(candidate.operationsCode ?? candidate.code ?? '').toUpperCase()
}

/** A fixed, non-secret operational disposition for predictable failure classes. */
export function classifyOperationsFailure(error: unknown): FailureDisposition {
  const code = failureCode(error)
  if (code === 'SQLITE_FULL' || code === 'ENOSPC' || code === 'DISK_FULL') return {
    mode: 'disk_full', retryable: false, failClosed: true, preserveActiveAuthority: true,
    operatorAction: 'Stop new writes, preserve active identities, free disk space, then run integrity checks.',
  }
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'DATABASE_LOCKED') return {
    mode: 'database_locked', retryable: true, failClosed: true, preserveActiveAuthority: true,
    operatorAction: 'Back off with jitter; never start a competing daemon or duplicate the mutation.',
  }
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || code === 'DATABASE_CORRUPT') return {
    mode: 'database_corrupt', retryable: false, failClosed: true, preserveActiveAuthority: false,
    operatorAction: 'Quiesce the daemon, quarantine state, verify a checksummed backup, and restore offline.',
  }
  if (code === 'PROVIDER_UNAVAILABLE' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') return {
    mode: 'provider_unavailable', retryable: true, failClosed: true, preserveActiveAuthority: true,
    operatorAction: 'Keep the frozen provider/job identity and retry within the recorded attempt budget.',
  }
  if (code === 'GIT_CONFLICT' || code === 'GIT_NON_FAST_FORWARD') return {
    mode: 'git_conflict', retryable: false, failClosed: true, preserveActiveAuthority: true,
    operatorAction: 'Preserve the worktree and branch; require explicit conflict resolution.',
  }
  if (code === 'PATH_VIOLATION' || code === 'PATH_ESCAPE' || code === 'SYMLINK_ESCAPE') return {
    mode: 'path_violation', retryable: false, failClosed: true, preserveActiveAuthority: false,
    operatorAction: 'Reject the operation without filesystem mutation and inspect the configured path.',
  }
  return {
    mode: 'unknown', retryable: false, failClosed: true, preserveActiveAuthority: true,
    operatorAction: 'Stop the affected mutation, preserve evidence, and require operator diagnosis.',
  }
}

/** Durable recovery, transactional-outbox, and replay boundary. */
export class OperationsRecoveryService {
  constructor(private readonly db: Database.Database) {}

  enqueue(input: OutboxInput): { id: string; replayed: boolean } {
    const destination = bounded(input.destination, 'outbox destination', 128)
    const dedupeKey = bounded(input.dedupeKey, 'outbox dedupe key', 512)
    const payloadJson = stableJson(input.payload)
    const payloadSha256 = sha256(payloadJson)
    const id = input.id ? bounded(input.id, 'outbox id', 512) : randomUUID()
    const maxAttempts = input.maxAttempts ?? 8
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error('maxAttempts must be between 1 and 100')
    }
    const availableAt = input.availableAt ?? timestamp()
    if (Number.isNaN(Date.parse(availableAt))) throw new Error('availableAt must be an ISO timestamp')
    const result = this.db.prepare(`INSERT OR IGNORE INTO ops_outbox (
      id, board_id, event_id, destination, dedupe_key, payload_json, payload_sha256,
      status, attempts, max_attempts, available_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`).run(
      id,
      input.boardId ?? null,
      input.eventId ?? null,
      destination,
      dedupeKey,
      payloadJson,
      payloadSha256,
      maxAttempts,
      availableAt,
      timestamp(),
    )
    if (result.changes === 1) return { id, replayed: false }
    const existing = this.db.prepare(`SELECT id, payload_sha256 FROM ops_outbox
      WHERE destination=? AND dedupe_key=?`).get(destination, dedupeKey) as {
        id: string
        payload_sha256: string
      } | undefined
    if (!existing || existing.payload_sha256 !== payloadSha256) {
      throw new Error('outbox dedupe key was reused with a different payload')
    }
    return { id: existing.id, replayed: true }
  }

  /** Run the source mutation and durable enqueue in one immediate SQLite transaction. */
  transact<T>(mutation: () => T, outbox: OutboxInput | ((result: T) => OutboxInput)): {
    result: T
    outboxId: string
    replayed: boolean
  } {
    const execute = this.db.transaction(() => {
      const result = mutation()
      const enqueued = this.enqueue(typeof outbox === 'function' ? outbox(result) : outbox)
      return { result, outboxId: enqueued.id, replayed: enqueued.replayed }
    })
    return execute.immediate()
  }

  /**
   * A database projection consumer is replayed exactly once. The callback must only mutate this
   * database; external effects belong in the outbox and receive a stable delivery key.
   */
  consumeIdempotently<T>(input: {
    consumer: string
    eventId: string
    payload: unknown
  }, project: () => T): { replayed: boolean; result?: T } {
    const consumer = bounded(input.consumer, 'consumer', 128)
    const eventId = bounded(input.eventId, 'event id', 512)
    const payloadSha256 = sha256(stableJson(input.payload))
    const execute = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT payload_sha256 FROM ops_event_consumptions
        WHERE consumer=? AND event_id=?`).get(consumer, eventId) as {
          payload_sha256: string
        } | undefined
      if (existing) {
        if (existing.payload_sha256 !== payloadSha256) {
          throw new Error('event identity replayed with different content')
        }
        return { replayed: true } as { replayed: boolean; result?: T }
      }
      const result = project()
      this.db.prepare(`INSERT INTO ops_event_consumptions
        (consumer, event_id, payload_sha256, consumed_at) VALUES (?, ?, ?, ?)`)
        .run(consumer, eventId, payloadSha256, timestamp())
      return { replayed: false, result }
    })
    return execute.immediate()
  }

  async dispatch(input: {
    ownerId: string
    deliver: (delivery: OutboxDelivery) => Promise<void>
    limit?: number
    leaseMs?: number
    now?: Date
  }): Promise<DispatchResult> {
    const ownerId = bounded(input.ownerId, 'outbox owner', 128)
    const limit = Math.min(1_000, Math.max(1, Math.floor(input.limit ?? 100)))
    const leaseMs = Math.min(300_000, Math.max(1_000, Math.floor(input.leaseMs ?? 30_000)))
    const now = input.now ?? new Date()
    this.db.prepare(`UPDATE ops_outbox SET status='pending', lease_owner=NULL,
      lease_expires_at=NULL, available_at=?
      WHERE status='delivering' AND lease_expires_at<=?`).run(now.toISOString(), now.toISOString())
    const result: DispatchResult = { delivered: [], retried: [], dead: [] }
    for (let index = 0; index < limit; index += 1) {
      const claimed = this.claim(ownerId, now, leaseMs)
      if (!claimed) break
      try {
        await input.deliver({
          id: claimed.id,
          eventId: claimed.event_id,
          destination: claimed.destination,
          dedupeKey: claimed.dedupe_key,
          idempotencyKey: `orchestra-outbox:${claimed.id}`,
          payload: JSON.parse(claimed.payload_json) as unknown,
          attempt: claimed.attempts,
        })
        const acknowledged = this.db.prepare(`UPDATE ops_outbox SET status='delivered',
          lease_owner=NULL, lease_expires_at=NULL, delivered_at=?, last_error=NULL
          WHERE id=? AND status='delivering' AND lease_owner=?`).run(timestamp(), claimed.id, ownerId)
        if (acknowledged.changes !== 1) throw new Error('outbox delivery lease was lost before acknowledgement')
        result.delivered.push(claimed.id)
      } catch (error) {
        const dead = claimed.attempts >= claimed.max_attempts
        const delayMs = Math.min(300_000, 250 * (2 ** Math.min(10, claimed.attempts - 1)))
        const failure = classifyOperationsFailure(error)
        this.db.prepare(`UPDATE ops_outbox SET status=?, lease_owner=NULL,
          lease_expires_at=NULL, available_at=?, last_error=?
          WHERE id=? AND status='delivering' AND lease_owner=?`).run(
          dead ? 'dead' : 'pending',
          new Date(now.getTime() + delayMs).toISOString(),
          `delivery_failed:${failure.mode}`,
          claimed.id,
          ownerId,
        )
        ;(dead ? result.dead : result.retried).push(claimed.id)
      }
    }
    return result
  }

  reconcileOrphans(input: {
    ownerId: string
    processAlive?: (pid: number) => boolean
    ownsProcess?: (process: { id: string; pid: number | null }) => boolean
    ownsDaemonLease?: (lease: {
      name: string
      ownerId: string
      pid: number
      acquiredAt: string
      heartbeatAt: string
    }) => boolean
    pathExists?: (target: string) => boolean
    now?: Date
  }): OrphanReconciliationResult {
    const ownerId = bounded(input.ownerId, 'recovery owner', 128)
    const processAlive = input.processAlive ?? defaultProcessAlive
    const ownsProcess = input.ownsProcess ?? (() => false)
    const ownsDaemonLease = input.ownsDaemonLease ?? (() => false)
    const pathExists = input.pathExists ?? fs.existsSync
    const at = (input.now ?? new Date()).toISOString()
    const execute = this.db.transaction(() => {
      const runId = randomUUID()
      this.db.prepare(`INSERT INTO ops_recovery_runs (id, owner_id, started_at)
        VALUES (?, ?, ?)`).run(runId, ownerId, at)
      const result: OrphanReconciliationResult = {
        runId,
        lostProcesses: [],
        lostSessions: [],
        recoveredJobs: [],
        blockedJobs: [],
        cancelledJobs: [],
        missingWorkspaces: [],
        releasedLeases: [],
      }

      const leases = this.db.prepare(`SELECT name, owner_id, pid, acquired_at, heartbeat_at
        FROM daemon_leases WHERE owner_id<>? ORDER BY name`).all(ownerId) as Array<{
          name: string
          owner_id: string
          pid: number
          acquired_at: string
          heartbeat_at: string
        }>
      for (const lease of leases) {
        const proof = {
          name: lease.name,
          ownerId: lease.owner_id,
          pid: lease.pid,
          acquiredAt: lease.acquired_at,
          heartbeatAt: lease.heartbeat_at,
        }
        if (processAlive(lease.pid) && ownsDaemonLease(proof)) continue
        if (this.db.prepare(`DELETE FROM daemon_leases
          WHERE name=? AND owner_id=? AND pid=? AND heartbeat_at=?`)
          .run(lease.name, lease.owner_id, lease.pid, lease.heartbeat_at).changes === 1) {
          result.releasedLeases.push(lease.name)
        }
      }

      const workspaces = this.db.prepare(`SELECT id, root_path, worktree_path FROM workspaces
        WHERE status='active' ORDER BY id`).all() as Array<{
          id: string
          root_path: string
          worktree_path: string | null
        }>
      for (const workspace of workspaces) {
        const executionRoot = workspace.worktree_path ?? workspace.root_path
        if (pathExists(executionRoot)) continue
        if (this.db.prepare(`UPDATE workspaces SET status='missing', updated_at=?
          WHERE id=? AND status='active'`).run(at, workspace.id).changes === 1) {
          result.missingWorkspaces.push(workspace.id)
        }
      }

      const processes = this.db.prepare(`SELECT id, pid FROM processes
        WHERE status IN ('starting','running','stopping') ORDER BY id`)
        .all() as Array<{ id: string; pid: number | null }>
      for (const processRecord of processes) {
        if (ownsProcess(processRecord)) continue
        if (this.db.prepare(`UPDATE processes SET status='lost', pid=NULL,
          exit_code=NULL, ended_at=coalesce(ended_at, ?)
          WHERE id=? AND status IN ('starting','running','stopping')`)
          .run(at, processRecord.id).changes === 1) result.lostProcesses.push(processRecord.id)
      }

      const sessions = this.db.prepare(`SELECT session.id, session.job_id
        FROM agent_sessions session
        LEFT JOIN jobs job ON job.id=session.job_id
        LEFT JOIN workspaces workspace ON workspace.id=session.workspace_id
        WHERE session.status IN ('starting','running','idle')
          AND session.control_state IN ('active','paused')
          AND ((session.job_id IS NOT NULL
              AND (job.id IS NULL OR job.status NOT IN ('running','cancelling')))
            OR workspace.id IS NULL OR workspace.status<>'active')
        ORDER BY session.id`).all() as Array<{ id: string; job_id: string | null }>
      for (const session of sessions) {
        if (this.db.prepare(`UPDATE agent_sessions SET status='lost',
          control_state='stopped', recovery_state='lost',
          ended_at=coalesce(ended_at, ?), updated_at=?
          WHERE id=? AND status IN ('starting','running','idle')
            AND control_state IN ('active','paused')`).run(at, at, session.id).changes === 1) {
          result.lostSessions.push(session.id)
        }
      }

      const jobs = this.db.prepare(`SELECT job.id, job.status, job.attempts, job.max_attempts,
          job.workspace_id, count(session.id) AS active_sessions
        FROM jobs job
        LEFT JOIN workspaces workspace ON workspace.id=job.workspace_id
        LEFT JOIN agent_sessions session ON session.job_id=job.id
          AND session.status IN ('starting','running','idle')
          AND session.control_state IN ('active','paused')
        WHERE job.status IN ('running','cancelling')
        GROUP BY job.id
        HAVING active_sessions<>1 OR workspace.id IS NULL OR workspace.status<>'active'
        ORDER BY job.id`).all() as Array<{
          id: string
          status: 'running' | 'cancelling'
          attempts: number
          max_attempts: number
          workspace_id: string | null
          active_sessions: number
      }>
      for (const job of jobs) {
        const cancelling = job.status === 'cancelling'
        const retry = !cancelling && job.attempts < job.max_attempts && job.workspace_id !== null
          && !result.missingWorkspaces.includes(job.workspace_id)
        const reason = job.active_sessions > 1
          ? 'recovery found multiple active sessions; authority revoked before retry'
          : 'recovery found no single active session/workspace binding'
        const targetStatus = cancelling ? 'cancelled' : retry ? 'queued' : 'blocked'
        const update = this.db.prepare(`UPDATE jobs SET status=?, error=?,
          scheduled_at=CASE WHEN ?='queued' THEN ? ELSE scheduled_at END,
          started_at=CASE WHEN ?='queued' THEN NULL ELSE started_at END,
          finished_at=CASE WHEN ? IN ('blocked','cancelled') THEN ? ELSE NULL END
          WHERE id=? AND status IN ('running','cancelling')`).run(
          targetStatus,
          cancelling ? null : reason,
          targetStatus,
          at,
          targetStatus,
          targetStatus,
          at,
          job.id,
        )
        if (update.changes !== 1) continue
        this.db.prepare(`UPDATE workspace_assignments SET status=?, updated_at=?, released_at=?
          WHERE job_id=?`).run(
          retry ? 'reserved' : cancelling ? 'released' : 'failed',
          at,
          retry ? null : at,
          job.id,
        )
        ;(cancelling ? result.cancelledJobs : retry ? result.recoveredJobs : result.blockedJobs)
          .push(job.id)
      }

      for (const session of this.db.prepare(`SELECT session.id FROM agent_sessions session
        JOIN jobs job ON job.id=session.job_id
        WHERE session.status IN ('starting','running','idle')
          AND session.control_state IN ('active','paused')
          AND job.status NOT IN ('running','cancelling') ORDER BY session.id`)
        .all() as Array<{ id: string }>) {
        if (this.db.prepare(`UPDATE agent_sessions SET status='lost',
          control_state='stopped', recovery_state='lost',
          ended_at=coalesce(ended_at, ?), updated_at=? WHERE id=?`)
          .run(at, at, session.id).changes === 1 && !result.lostSessions.includes(session.id)) {
          result.lostSessions.push(session.id)
        }
      }

      for (const jobId of [...result.recoveredJobs, ...result.blockedJobs, ...result.cancelledJobs]) {
        this.enqueue({
          boardId: (this.db.prepare('SELECT board_id FROM jobs WHERE id=?').get(jobId) as { board_id: number }).board_id,
          eventId: `recovery:${jobId}`,
          destination: 'attention',
          dedupeKey: `job-recovery:${jobId}`,
          payload: {
            kind: 'job.recovered',
            job_id: jobId,
            disposition: result.recoveredJobs.includes(jobId)
              ? 'queued'
              : result.cancelledJobs.includes(jobId) ? 'cancelled' : 'blocked',
          },
        })
      }
      this.db.prepare(`UPDATE ops_recovery_runs SET completed_at=?, result_json=? WHERE id=?`)
        .run(at, stableJson(result), runId)
      return result
    })
    return execute.immediate()
  }

  private claim(ownerId: string, now: Date, leaseMs: number): OutboxRow | undefined {
    const claim = this.db.transaction(() => this.db.prepare(`UPDATE ops_outbox
      SET status='delivering', attempts=attempts+1, lease_owner=?, lease_expires_at=?
      WHERE id=(SELECT id FROM ops_outbox WHERE status='pending' AND available_at<=?
        ORDER BY available_at, created_at, rowid LIMIT 1)
        AND status='pending'
      RETURNING *`).get(
      ownerId,
      new Date(now.getTime() + leaseMs).toISOString(),
      now.toISOString(),
    ) as OutboxRow | undefined)
    return claim.immediate()
  }
}

type OutboxRow = {
  id: string
  event_id: string | null
  destination: string
  dedupe_key: string
  payload_json: string
  attempts: number
  max_attempts: number
}

const defaultProcessAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type ActiveWorkRegistration = {
  id: string
  settle: () => Promise<void>
  onDeadline: 'detach' | 'stop'
  detach?: () => Promise<void>
  stop?: () => Promise<void>
}

const settlesWithin = async (operation: Promise<void>, timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = operation.then(() => true, () => false)
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const result = await Promise.race([outcome, timeout])
  if (timer) clearTimeout(timer)
  return result
}

/** Rejects new mutations first, then drains or explicitly detaches/stops each frozen work item. */
export class SafeShutdownCoordinator {
  private state: 'accepting' | 'draining' | 'closed' = 'accepting'
  private readonly work = new Map<string, ActiveWorkRegistration>()
  private shutdown?: Promise<{ completed: string[]; detached: string[]; stopped: string[]; unresolved: string[] }>

  admitMutation(): void {
    if (this.state !== 'accepting') throw new Error('daemon is draining; new mutations are disabled')
  }

  register(input: ActiveWorkRegistration): () => void {
    this.admitMutation()
    const id = bounded(input.id, 'active work id', 512)
    if (this.work.has(id)) throw new Error(`active work ${id} is already registered`)
    this.work.set(id, { ...input, id })
    return () => { this.work.delete(id) }
  }

  /** Freezes admission synchronously so callers can stop background producers before draining. */
  closeAdmission(): void {
    if (this.state === 'accepting') this.state = 'draining'
  }

  begin(deadlineMs = 30_000, actionTimeoutMs = 5_000): Promise<{
    completed: string[]
    detached: string[]
    stopped: string[]
    unresolved: string[]
  }> {
    if (this.shutdown) return this.shutdown
    this.closeAdmission()
    this.shutdown = this.drain(
      Math.min(300_000, Math.max(0, Math.floor(deadlineMs))),
      Math.min(60_000, Math.max(0, Math.floor(actionTimeoutMs))),
    )
    return this.shutdown
  }

  private async drain(deadlineMs: number, actionTimeoutMs: number): Promise<{
    completed: string[]
    detached: string[]
    stopped: string[]
    unresolved: string[]
  }> {
    const result = { completed: [] as string[], detached: [] as string[], stopped: [] as string[], unresolved: [] as string[] }
    const entries = [...this.work.values()]
    await Promise.all(entries.map(async (entry) => {
      const settled = await settlesWithin(Promise.resolve().then(entry.settle), deadlineMs)
      if (settled) {
        result.completed.push(entry.id)
        this.work.delete(entry.id)
        return
      }
      const action = entry.onDeadline === 'detach' ? entry.detach : entry.stop
      if (!action) {
        result.unresolved.push(entry.id)
        return
      }
      const acted = await settlesWithin(Promise.resolve().then(action), actionTimeoutMs)
      if (acted) {
        ;(entry.onDeadline === 'detach' ? result.detached : result.stopped).push(entry.id)
        this.work.delete(entry.id)
      } else {
        result.unresolved.push(entry.id)
      }
    }))
    this.state = 'closed'
    return result
  }
}

/**
 * Lossless compression for durable events plus recoverable PTY/artifact compaction. Transcript
 * archival remains delegated to AgentHomeRetentionService so its evidence-reference guards stay
 * authoritative; the shared policy supplies that service's transcript duration.
 */
export class OperationsRetentionService {
  constructor(private readonly db: Database.Database) {}

  configure(input: {
    boardId: number
    eventDays: number
    transcriptDays: number
    ptyDays: number
    artifactDays: number
    now?: Date
  }): OperationsRetentionPolicy {
    if (!Number.isSafeInteger(input.boardId) || input.boardId <= 0) throw new Error('boardId must be positive')
    const values = [input.eventDays, input.transcriptDays, input.ptyDays, input.artifactDays]
    if (values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 36_500)) {
      throw new Error('retention days must be integers between 1 and 36500')
    }
    const at = (input.now ?? new Date()).toISOString()
    this.db.prepare(`INSERT INTO ops_retention_policies (
      board_id, event_days, transcript_days, pty_days, artifact_days, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(board_id) DO UPDATE SET event_days=excluded.event_days,
      transcript_days=excluded.transcript_days, pty_days=excluded.pty_days,
      artifact_days=excluded.artifact_days, updated_at=excluded.updated_at`).run(
      input.boardId,
      input.eventDays,
      input.transcriptDays,
      input.ptyDays,
      input.artifactDays,
      at,
    )
    return this.policy(input.boardId)
  }

  policy(boardId: number): OperationsRetentionPolicy {
    const row = this.db.prepare('SELECT * FROM ops_retention_policies WHERE board_id=?')
      .get(boardId) as OperationsRetentionPolicy | undefined
    if (!row) throw new Error('operations retention policy is not configured')
    return row
  }

  listPolicies(): OperationsRetentionPolicy[] {
    return this.db.prepare('SELECT * FROM ops_retention_policies ORDER BY board_id')
      .all() as OperationsRetentionPolicy[]
  }

  run(input: { boardId: number; now?: Date; limit?: number }): {
    events: number
    ptyChunks: number
    artifacts: number
    hasMore: boolean
  } {
    const policy = this.policy(input.boardId)
    const now = input.now ?? new Date()
    const limit = Math.min(5_000, Math.max(1, Math.floor(input.limit ?? 500)))
    const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
    const execute = this.db.transaction(() => {
      let remaining = limit
      let events = 0
      let ptyChunks = 0
      let artifacts = 0
      const eventRows = this.db.prepare(`SELECT id, payload FROM os_events
        WHERE board_id=? AND created_at<=?
          AND payload NOT LIKE '{"compacted_archive_id":%'
        ORDER BY created_at, id LIMIT ?`).all(
        input.boardId,
        before(policy.event_days),
        remaining + 1,
      ) as Array<{ id: string; payload: string }>
      const eventHasMore = eventRows.length > remaining
      for (const row of eventRows.slice(0, remaining)) {
        const archiveId = this.archive(input.boardId, 'event', row.id, null, null, row.payload, now)
        this.db.prepare('UPDATE os_events SET payload=? WHERE id=?').run(stableJson({
          compacted_archive_id: archiveId,
          content_sha256: sha256(row.payload),
        }), row.id)
        events += 1
      }
      remaining -= events

      const ptyRows = remaining > 0
        ? this.db.prepare(`SELECT output.id, output.process_id, output.seq, output.stream,
              output.data, output.created_at
            FROM process_output output
            JOIN processes process ON process.id=output.process_id
            JOIN workspaces workspace ON workspace.id=process.workspace_id
            WHERE workspace.board_id=? AND output.created_at<=?
            ORDER BY output.created_at, output.id LIMIT ?`).all(
            input.boardId,
            before(policy.pty_days),
            remaining + 1,
          ) as Array<{
            id: number
            process_id: string
            seq: number
            stream: string
            data: string
            created_at: string
          }>
        : []
      const ptyHasMore = ptyRows.length > remaining
      for (const row of ptyRows.slice(0, remaining)) {
        this.archive(
          input.boardId,
          'pty',
          row.process_id,
          String(row.seq),
          String(row.seq),
          stableJson(row),
          now,
        )
        this.db.prepare('DELETE FROM process_output WHERE id=?').run(row.id)
        ptyChunks += 1
      }
      remaining -= ptyChunks

      const artifactRows = remaining > 0
        ? this.db.prepare(`SELECT id, content FROM artifacts
            WHERE board_id=? AND content IS NOT NULL AND created_at<=?
            ORDER BY created_at, id LIMIT ?`).all(
            input.boardId,
            before(policy.artifact_days),
            remaining + 1,
          ) as Array<{ id: string; content: string }>
        : []
      const artifactHasMore = artifactRows.length > remaining
      for (const row of artifactRows.slice(0, remaining)) {
        this.archive(input.boardId, 'artifact', row.id, null, null, row.content, now)
        this.db.prepare('UPDATE artifacts SET content=NULL WHERE id=? AND content IS NOT NULL').run(row.id)
        artifacts += 1
      }
      return {
        events,
        ptyChunks,
        artifacts,
        hasMore: eventHasMore || ptyHasMore || artifactHasMore,
      }
    })
    return execute.immediate()
  }

  readArchive(id: string): string {
    const row = this.db.prepare(`SELECT content_gzip, content_sha256
      FROM ops_compaction_archives WHERE id=?`).get(bounded(id, 'archive id', 512)) as {
        content_gzip: Buffer
        content_sha256: string
      } | undefined
    if (!row) throw new Error('compaction archive not found')
    const content = gunzipSync(row.content_gzip).toString('utf8')
    if (sha256(content) !== row.content_sha256) throw new Error('compaction archive checksum failed')
    return content
  }

  private archive(
    boardId: number,
    category: 'event' | 'pty' | 'artifact',
    subjectId: string,
    firstItem: string | null,
    lastItem: string | null,
    content: string,
    now: Date,
  ): string {
    const id = randomUUID()
    this.db.prepare(`INSERT INTO ops_compaction_archives (
      id, board_id, category, subject_id, first_item, last_item, item_count,
      original_bytes, content_sha256, content_encoding, content_gzip, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'gzip', ?, ?)`).run(
      id,
      boardId,
      category,
      subjectId,
      firstItem,
      lastItem,
      Buffer.byteLength(content),
      sha256(content),
      gzipSync(content, { level: 9 }),
      now.toISOString(),
    )
    return id
  }
}

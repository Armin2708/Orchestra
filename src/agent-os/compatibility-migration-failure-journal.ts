import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID,
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE,
  AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS,
  AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS,
  recordCompatibilityMigrationTelemetry,
  type CompatibilityMigrationFailureDiagnostic,
  type CompatibilityMigrationTelemetryCohort,
} from './compatibility-migration-telemetry.js'
import {
  AGENT_OS_LEGACY_COMPATIBILITY_TABLES,
  type AgentOsLegacyCompatibilityTable,
} from './compatibility-projection-contract.js'

export const AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID =
  '024-compatibility-migration-failure-journal'

export const AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE =
  'os_compatibility_failure_journal_state'
export const AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE =
  'os_compatibility_failure_success_receipts'
export const AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE =
  'os_compatibility_failure_day_seal_receipts'

const MAIN_GUARD_FUNCTION =
  'orchestra_compatibility_failure_journal_guard'
const ZERO_HASH = '0'.repeat(64)
const JOURNAL_SCHEMA_VERSION = 1
const DEFAULT_CAPACITY = 1_024
const MAX_CAPACITY = 100_000
const MAX_DAY_SEALS = 3_650
const MAX_PROCESS_ID = 2_147_483_647
const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_PATTERN = /^[0-9a-f]{64}$/

type SchemaObject = Readonly<{
  type: 'table' | 'trigger'
  name: string
  sql: string
}>

const MAIN_SCHEMA = Object.freeze([
  {
    type: 'table',
    name: AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE,
    sql: `CREATE TABLE ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1),
      journal_generation TEXT NOT NULL
        CHECK (length(journal_generation)=36),
      applied_through_sequence INTEGER NOT NULL
        CHECK (
          applied_through_sequence>=0
          AND applied_through_sequence<=9007199254740991
        ),
      applied_envelope_hash TEXT NOT NULL
        CHECK (
          length(applied_envelope_hash)=64
          AND applied_envelope_hash NOT GLOB '*[^0-9a-f]*'
        )
    ) STRICT, WITHOUT ROWID`,
  },
  {
    type: 'table',
    name: AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE,
    sql: `CREATE TABLE ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE} (
      journal_generation TEXT NOT NULL
        CHECK (length(journal_generation)=36),
      sequence INTEGER NOT NULL
        CHECK (sequence>=1 AND sequence<=9007199254740991),
      envelope_hash TEXT NOT NULL
        CHECK (
          length(envelope_hash)=64
          AND envelope_hash NOT GLOB '*[^0-9a-f]*'
        ),
      PRIMARY KEY (journal_generation, sequence)
    ) STRICT, WITHOUT ROWID`,
  },
  {
    type: 'table',
    name: AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE,
    sql: `CREATE TABLE ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE} (
      day TEXT PRIMARY KEY
        CHECK (
          day GLOB '????-??-??'
          AND COALESCE(strftime('%Y-%m-%d', day), '')=day
        ),
      journal_generation TEXT NOT NULL
        CHECK (length(journal_generation)=36),
      sealed_through_sequence INTEGER NOT NULL
        CHECK (
          sealed_through_sequence>=0
          AND sealed_through_sequence<=9007199254740991
        ),
      sealed_envelope_hash TEXT NOT NULL
        CHECK (
          length(sealed_envelope_hash)=64
          AND sealed_envelope_hash NOT GLOB '*[^0-9a-f]*'
        ),
      collector_schema_version INTEGER NOT NULL
        CHECK (
          collector_schema_version>=1
          AND collector_schema_version<=9007199254740991
        )
    ) STRICT, WITHOUT ROWID`,
  },
  {
    type: 'trigger',
    name: 'trg_os_compatibility_failure_journal_state_insert_guard',
    sql: `CREATE TRIGGER trg_os_compatibility_failure_journal_state_insert_guard
      BEFORE INSERT ON ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE}
      WHEN ${MAIN_GUARD_FUNCTION}()<>'initialize'
      BEGIN
        SELECT RAISE(ABORT, 'compatibility failure journal state insert is guarded');
      END`,
  },
  {
    type: 'trigger',
    name: 'trg_os_compatibility_failure_journal_state_update_guard',
    sql: `CREATE TRIGGER trg_os_compatibility_failure_journal_state_update_guard
      BEFORE UPDATE ON ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE}
      WHEN ${MAIN_GUARD_FUNCTION}()<>'reconcile'
      BEGIN
        SELECT RAISE(ABORT, 'compatibility failure journal state update is guarded');
      END`,
  },
  {
    type: 'trigger',
    name: 'trg_os_compatibility_failure_journal_state_delete_guard',
    sql: `CREATE TRIGGER trg_os_compatibility_failure_journal_state_delete_guard
      BEFORE DELETE ON ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'compatibility failure journal state is immutable');
      END`,
  },
  {
    type: 'trigger',
    name: 'trg_os_compatibility_failure_journal_success_insert_guard',
    sql: `CREATE TRIGGER trg_os_compatibility_failure_journal_success_insert_guard
      BEFORE INSERT ON ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
      WHEN ${MAIN_GUARD_FUNCTION}()<>'success-receipt'
      BEGIN
        SELECT RAISE(ABORT, 'compatibility failure journal success insert is guarded');
      END`,
  },
  {
    type: 'trigger',
    name: 'trg_os_compatibility_failure_journal_success_update_guard',
    sql: `CREATE TRIGGER trg_os_compatibility_failure_journal_success_update_guard
      BEFORE UPDATE ON ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'compatibility failure journal success receipt is immutable');
      END`,
  },
  {
    type: 'trigger',
    name: 'trg_os_compatibility_failure_journal_success_delete_guard',
    sql: `CREATE TRIGGER trg_os_compatibility_failure_journal_success_delete_guard
      BEFORE DELETE ON ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
      WHEN ${MAIN_GUARD_FUNCTION}()<>'reconcile'
      BEGIN
        SELECT RAISE(ABORT, 'compatibility failure journal success delete is guarded');
      END`,
  },
  {
    type: 'trigger',
    name: 'trg_os_compatibility_failure_journal_seal_insert_guard',
    sql: `CREATE TRIGGER trg_os_compatibility_failure_journal_seal_insert_guard
      BEFORE INSERT ON ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE}
      WHEN ${MAIN_GUARD_FUNCTION}()<>'seal-receipt'
      BEGIN
        SELECT RAISE(ABORT, 'compatibility failure journal seal insert is guarded');
      END`,
  },
  {
    type: 'trigger',
    name: 'trg_os_compatibility_failure_journal_seal_update_guard',
    sql: `CREATE TRIGGER trg_os_compatibility_failure_journal_seal_update_guard
      BEFORE UPDATE ON ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'compatibility failure journal seal receipt is immutable');
      END`,
  },
  {
    type: 'trigger',
    name: 'trg_os_compatibility_failure_journal_seal_delete_guard',
    sql: `CREATE TRIGGER trg_os_compatibility_failure_journal_seal_delete_guard
      BEFORE DELETE ON ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'compatibility failure journal seal receipt is immutable');
      END`,
  },
] satisfies readonly SchemaObject[])

const MAIN_OWNED_TABLES = Object.freeze([
  AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE,
  AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE,
  AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE,
])

export const
  AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_SCHEMA_OBJECT_NAMES =
    Object.freeze(MAIN_SCHEMA.map(({ name }) => name))

export const AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_REASONS = Object.freeze([
  'main_schema_incompatible',
  'sidecar_unavailable',
  'sidecar_schema_incompatible',
  'binding_uninitialized',
  'generation_mismatch',
  'high_water_mismatch',
  'envelope_chain_malformed',
  'receipt_mismatch',
  'outcome_mismatch',
  'pending_attempt',
  'reconcile_in_transaction',
  'reconcile_blocked',
  'capacity_exhausted',
  'session_capacity_exhausted',
  'day_already_sealed',
  'day_order_mismatch',
  'seal_mismatch',
  'seal_capacity_exhausted',
  'coverage_receipt_missing',
  'collector_epoch_mismatch',
] as const)

export type CompatibilityMigrationFailureJournalReason =
  typeof AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_REASONS[number]

export class CompatibilityMigrationTelemetryEvidenceIncompleteError
  extends Error {
  readonly code = 'evidence_incomplete' as const
  readonly reason: CompatibilityMigrationFailureJournalReason

  constructor(
    reason: CompatibilityMigrationFailureJournalReason,
    options?: ErrorOptions,
  ) {
    super(
      `compatibility migration telemetry evidence is incomplete (${reason})`,
      options,
    )
    this.name = 'CompatibilityMigrationTelemetryEvidenceIncompleteError'
    this.reason = reason
  }
}

export class CompatibilityMigrationFailureJournalCapacityError
  extends CompatibilityMigrationTelemetryEvidenceIncompleteError {
  constructor() {
    super('capacity_exhausted')
    this.name = 'CompatibilityMigrationFailureJournalCapacityError'
  }
}

export interface CompatibilityMigrationFailureReservationInput {
  readonly observed_at: Date
  readonly table: AgentOsLegacyCompatibilityTable
  readonly cohort: CompatibilityMigrationTelemetryCohort
  readonly fallback_diagnostic: CompatibilityMigrationFailureDiagnostic
}

export interface CompatibilityMigrationFailureReservation {
  readonly journal_generation: string
  readonly sequence: number
  readonly envelope_hash: string
}

export interface CompatibilityMigrationFailureJournalDrainResult {
  readonly journal_generation: string
  readonly applied_through_sequence: number
  readonly applied_envelope_hash: string
  readonly failures_imported: number
  readonly successes_reconciled: number
  readonly attempts_pruned: number
}

export interface CompatibilityMigrationFailureDaySealEvidence {
  readonly day: string
  readonly journal_generation: string
  readonly sealed_through_sequence: number
  readonly sealed_envelope_hash: string
  readonly collector_schema_version: number
}

export interface CompatibilityMigrationFailureJournalBinding {
  readonly journal_generation: string
  drain(): CompatibilityMigrationFailureJournalDrainResult
  prepareDaySeal(day: string): CompatibilityMigrationFailureDaySealEvidence
  writeDaySealReceipt(
    evidence: CompatibilityMigrationFailureDaySealEvidence,
  ): void
  assertCoverageReceipts(fromDay: string, throughDay: string): void
  assertRollupReady(retainFromDay: string): void
}

export interface OpenCompatibilityMigrationFailureJournalInput {
  readonly journal_path: string
  readonly capacity?: number
  readonly runtime_instance?: string
}

export interface CompatibilityMigrationFailureJournalDurabilityProfile {
  readonly journal_mode: 'delete'
  readonly synchronous: 3
  readonly fullfsync: 1
  readonly cell_size_check: 1
  readonly secure_delete: 1
}

type MainGuardMode =
  | 'idle'
  | 'initialize'
  | 'success-receipt'
  | 'reconcile'
  | 'seal-receipt'

const MAIN_GUARD_STATES =
  new WeakMap<Database.Database, { mode: MainGuardMode }>()

function ensureMainGuard(db: Database.Database): { mode: MainGuardMode } {
  const existing = MAIN_GUARD_STATES.get(db)
  if (existing) {
    db.function(MAIN_GUARD_FUNCTION, () => existing.mode)
    return existing
  }
  const state: { mode: MainGuardMode } = { mode: 'idle' }
  db.function(MAIN_GUARD_FUNCTION, () => state.mode)
  MAIN_GUARD_STATES.set(db, state)
  return state
}

function withMainGuard<Result>(
  db: Database.Database,
  mode: Exclude<MainGuardMode, 'idle'>,
  work: () => Result,
): Result {
  const guard = ensureMainGuard(db)
  if (guard.mode !== 'idle') {
    throw new Error('compatibility failure journal guard is already active')
  }
  guard.mode = mode
  try {
    return work()
  } finally {
    guard.mode = 'idle'
  }
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
  `).get(table)
}

function assertNoProtectedTempObjects(db: Database.Database): void {
  const placeholders = MAIN_OWNED_TABLES.map(() => '?').join(',')
  const objects = db.prepare(`
    SELECT type, name
    FROM sqlite_temp_master
    WHERE sql IS NOT NULL
      AND (
        name LIKE 'os_compatibility_failure_%'
        OR name LIKE 'trg_os_compatibility_failure_journal_%'
        OR (
          type='trigger'
          AND tbl_name IN (${placeholders})
        )
      )
  `).all(...MAIN_OWNED_TABLES)
  if (objects.length !== 0) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'main_schema_incompatible',
    )
  }
}

export function assertCompatibilityMigrationFailureJournalSchemaCompatible(
  db: Database.Database,
): void {
  assertNoProtectedTempObjects(db)
  const placeholders = MAIN_OWNED_TABLES.map(() => '?').join(',')
  const actual = db.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL
      AND (
        name LIKE 'os_compatibility_failure_%'
        OR name LIKE 'trg_os_compatibility_failure_journal_%'
        OR (
          type='trigger'
          AND tbl_name IN (${placeholders})
        )
      )
    ORDER BY type, name
  `).all(...MAIN_OWNED_TABLES) as Array<{
    type: string
    name: string
    sql: string
  }>
  const byName = new Map(actual.map((object) => [object.name, object]))
  const exact = actual.length === MAIN_SCHEMA.length
    && MAIN_SCHEMA.every((expected) => {
      const candidate = byName.get(expected.name)
      return candidate?.type === expected.type
        && normalizeSchemaSql(candidate.sql)
          === normalizeSchemaSql(expected.sql)
    })
  if (!exact) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'main_schema_incompatible',
    )
  }
  assertNoProtectedTempObjects(db)
}

export function applyCompatibilityMigrationFailureJournalMigration(
  db: Database.Database,
): void {
  if (!tableExists(db, 'os_schema_migrations')) {
    throw new Error(
      `migration ${AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID}`
      + ' requires os_schema_migrations',
    )
  }
  const predecessor = db.prepare(`
    SELECT 1 FROM os_schema_migrations WHERE id=?
  `).get(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)
  if (!predecessor) {
    throw new Error(
      `migration ${AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID}`
      + ` requires ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID}`,
    )
  }

  const hasAnyObject = MAIN_SCHEMA.some(({ name }) => !!db.prepare(`
    SELECT 1 FROM sqlite_master WHERE name=?
  `).get(name))
  if (!hasAnyObject) {
    db.exec(MAIN_SCHEMA.map(({ sql }) => `${sql};`).join('\n'))
  }
  assertCompatibilityMigrationFailureJournalSchemaCompatible(db)
}

function assertPlainObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || !(
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    )
  ) {
    throw new TypeError('compatibility failure journal input must be plain')
  }
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.has(key))
  ) {
    throw new TypeError('compatibility failure journal input keys are invalid')
  }
}

function assertSafeInteger(
  name: string,
  value: unknown,
  minimum = 0,
): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < minimum
  ) {
    throw new Error(`${name} is not a safe integer`)
  }
  return value
}

function assertUtcDay(name: string, value: unknown): asserts value is string {
  const timestamp = typeof value === 'string'
    ? Date.parse(`${value}T00:00:00.000Z`)
    : Number.NaN
  if (
    typeof value !== 'string'
    || !UTC_DAY_PATTERN.test(value)
    || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError(`${name} must be a canonical UTC day`)
  }
}

function assertHash(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`${name} is not a canonical envelope hash`)
  }
}

function assertUuid(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a UUID`)
  }
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function sqlEnum(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',')
}

const SIDECAR_STATE_TABLE = 'compatibility_failure_journal_state'
const SIDECAR_SESSIONS_TABLE = 'compatibility_failure_journal_sessions'
const SIDECAR_ATTEMPTS_TABLE = 'compatibility_failure_journal_attempts'
const SIDECAR_FAILURES_TABLE = 'compatibility_failure_journal_failures'
const SIDECAR_DAY_SEALS_TABLE = 'compatibility_failure_journal_day_seals'

const SIDECAR_SCHEMA = Object.freeze([
  {
    type: 'table',
    name: SIDECAR_STATE_TABLE,
    sql: `CREATE TABLE ${SIDECAR_STATE_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1),
      schema_version INTEGER NOT NULL CHECK (schema_version=1),
      journal_generation TEXT NOT NULL CHECK (length(journal_generation)=36),
      capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND ${MAX_CAPACITY}),
      next_sequence INTEGER NOT NULL
        CHECK (next_sequence BETWEEN 1 AND 9007199254740991),
      pruned_through_sequence INTEGER NOT NULL
        CHECK (
          pruned_through_sequence>=0
          AND pruned_through_sequence<next_sequence
        ),
      pruned_envelope_hash TEXT NOT NULL
        CHECK (
          length(pruned_envelope_hash)=64
          AND pruned_envelope_hash NOT GLOB '*[^0-9a-f]*'
        ),
      last_envelope_hash TEXT NOT NULL
        CHECK (
          length(last_envelope_hash)=64
          AND last_envelope_hash NOT GLOB '*[^0-9a-f]*'
        ),
      last_observed_day TEXT
        CHECK (
          last_observed_day IS NULL
          OR (
            last_observed_day GLOB '????-??-??'
            AND COALESCE(
              strftime('%Y-%m-%d', last_observed_day),
              ''
            )=last_observed_day
          )
        )
    ) STRICT, WITHOUT ROWID`,
  },
  {
    type: 'table',
    name: SIDECAR_SESSIONS_TABLE,
    sql: `CREATE TABLE ${SIDECAR_SESSIONS_TABLE} (
      producer_instance TEXT PRIMARY KEY CHECK (length(producer_instance)=36),
      process_id INTEGER NOT NULL
        CHECK (process_id BETWEEN 1 AND ${MAX_PROCESS_ID}),
      opened_at TEXT NOT NULL CHECK (length(opened_at) BETWEEN 20 AND 32),
      closed_at TEXT CHECK (
        closed_at IS NULL OR length(closed_at) BETWEEN 20 AND 32
      )
    ) STRICT, WITHOUT ROWID`,
  },
  {
    type: 'table',
    name: SIDECAR_ATTEMPTS_TABLE,
    sql: `CREATE TABLE ${SIDECAR_ATTEMPTS_TABLE} (
      sequence INTEGER PRIMARY KEY
        CHECK (sequence BETWEEN 1 AND 9007199254740991),
      previous_envelope_hash TEXT NOT NULL
        CHECK (
          length(previous_envelope_hash)=64
          AND previous_envelope_hash NOT GLOB '*[^0-9a-f]*'
        ),
      envelope_hash TEXT NOT NULL UNIQUE
        CHECK (
          length(envelope_hash)=64
          AND envelope_hash NOT GLOB '*[^0-9a-f]*'
        ),
      observed_day TEXT NOT NULL
        CHECK (
          observed_day GLOB '????-??-??'
          AND COALESCE(strftime('%Y-%m-%d', observed_day), '')=observed_day
        ),
      table_name TEXT NOT NULL
        CHECK (table_name IN (${sqlEnum(AGENT_OS_LEGACY_COMPATIBILITY_TABLES)})),
      cohort TEXT NOT NULL
        CHECK (
          cohort IN (${sqlEnum(
            Object.values(AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS)
              .flat(),
          )})
        ),
      fallback_diagnostic TEXT NOT NULL
        CHECK (
          fallback_diagnostic IN (${sqlEnum(
            AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS,
          )})
        ),
      producer_instance TEXT NOT NULL
        REFERENCES ${SIDECAR_SESSIONS_TABLE}(producer_instance),
      reserved_at TEXT NOT NULL CHECK (length(reserved_at) BETWEEN 20 AND 32),
      operation_returned_at TEXT CHECK (
        operation_returned_at IS NULL
        OR length(operation_returned_at) BETWEEN 20 AND 32
      ),
      return_marker_hash TEXT CHECK (
        (
          operation_returned_at IS NULL
          AND return_marker_hash IS NULL
        )
        OR (
          operation_returned_at IS NOT NULL
          AND length(return_marker_hash)=64
          AND return_marker_hash NOT GLOB '*[^0-9a-f]*'
        )
      )
    ) STRICT, WITHOUT ROWID`,
  },
  {
    type: 'table',
    name: SIDECAR_FAILURES_TABLE,
    sql: `CREATE TABLE ${SIDECAR_FAILURES_TABLE} (
      sequence INTEGER PRIMARY KEY
        REFERENCES ${SIDECAR_ATTEMPTS_TABLE}(sequence) ON DELETE CASCADE,
      diagnostic_code TEXT NOT NULL
        CHECK (
          diagnostic_code IN (${sqlEnum(
            AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS,
          )})
      ),
      failed_at TEXT NOT NULL CHECK (length(failed_at) BETWEEN 20 AND 32),
      outcome_hash TEXT NOT NULL
        CHECK (
          length(outcome_hash)=64
          AND outcome_hash NOT GLOB '*[^0-9a-f]*'
        )
    ) STRICT, WITHOUT ROWID`,
  },
  {
    type: 'table',
    name: SIDECAR_DAY_SEALS_TABLE,
    sql: `CREATE TABLE ${SIDECAR_DAY_SEALS_TABLE} (
      day TEXT PRIMARY KEY
        CHECK (
          day GLOB '????-??-??'
          AND COALESCE(strftime('%Y-%m-%d', day), '')=day
        ),
      sealed_through_sequence INTEGER NOT NULL
        CHECK (
          sealed_through_sequence>=0
          AND sealed_through_sequence<=9007199254740991
        ),
      sealed_envelope_hash TEXT NOT NULL
        CHECK (
          length(sealed_envelope_hash)=64
          AND sealed_envelope_hash NOT GLOB '*[^0-9a-f]*'
        ),
      collector_schema_version INTEGER NOT NULL
        CHECK (
          collector_schema_version>=1
          AND collector_schema_version<=9007199254740991
      ),
      sealed_at TEXT NOT NULL CHECK (length(sealed_at) BETWEEN 20 AND 32),
      seal_hash TEXT NOT NULL
        CHECK (
          length(seal_hash)=64
          AND seal_hash NOT GLOB '*[^0-9a-f]*'
        )
    ) STRICT, WITHOUT ROWID`,
  },
] satisfies readonly SchemaObject[])

type StoredMainState = {
  singleton: number
  journal_generation: string
  applied_through_sequence: number
  applied_envelope_hash: string
}

type StoredSidecarState = {
  singleton: number
  schema_version: number
  journal_generation: string
  capacity: number
  next_sequence: number
  pruned_through_sequence: number
  pruned_envelope_hash: string
  last_envelope_hash: string
  last_observed_day: string | null
}

type StoredAttempt = {
  sequence: number
  previous_envelope_hash: string
  envelope_hash: string
  observed_day: string
  table_name: AgentOsLegacyCompatibilityTable
  cohort: CompatibilityMigrationTelemetryCohort
  fallback_diagnostic: CompatibilityMigrationFailureDiagnostic
  producer_instance: string
  reserved_at: string
  operation_returned_at: string | null
  return_marker_hash: string | null
}

type StoredFailure = {
  sequence: number
  diagnostic_code: CompatibilityMigrationFailureDiagnostic
  failed_at: string
  outcome_hash: string
}

type StoredSuccessReceipt = {
  journal_generation: string
  sequence: number
  envelope_hash: string
}

type StoredDaySeal = {
  day: string
  sealed_through_sequence: number
  sealed_envelope_hash: string
  collector_schema_version: number
  sealed_at: string
  seal_hash: string
}

function envelopeHash(
  generation: string,
  attempt: Omit<
    StoredAttempt,
    'envelope_hash' | 'operation_returned_at' | 'return_marker_hash'
  >,
): string {
  const canonical = JSON.stringify([
    JOURNAL_SCHEMA_VERSION,
    generation,
    attempt.sequence,
    attempt.previous_envelope_hash,
    attempt.observed_day,
    attempt.table_name,
    attempt.cohort,
    attempt.fallback_diagnostic,
    attempt.producer_instance,
    attempt.reserved_at,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

function returnMarkerHash(
  generation: string,
  attempt: Pick<StoredAttempt, 'sequence' | 'envelope_hash'>,
  returnedAt: string,
): string {
  return createHash('sha256').update(JSON.stringify([
    JOURNAL_SCHEMA_VERSION,
    'operation-returned',
    generation,
    attempt.sequence,
    attempt.envelope_hash,
    returnedAt,
  ])).digest('hex')
}

function failureOutcomeHash(
  generation: string,
  attempt: Pick<StoredAttempt, 'sequence' | 'envelope_hash'>,
  diagnostic: CompatibilityMigrationFailureDiagnostic,
  failedAt: string,
): string {
  return createHash('sha256').update(JSON.stringify([
    JOURNAL_SCHEMA_VERSION,
    'failure',
    generation,
    attempt.sequence,
    attempt.envelope_hash,
    diagnostic,
    failedAt,
  ])).digest('hex')
}

function daySealHash(
  generation: string,
  seal: Omit<StoredDaySeal, 'seal_hash'>,
): string {
  return createHash('sha256').update(JSON.stringify([
    JOURNAL_SCHEMA_VERSION,
    'day-seal',
    generation,
    seal.day,
    seal.sealed_through_sequence,
    seal.sealed_envelope_hash,
    seal.collector_schema_version,
    seal.sealed_at,
  ])).digest('hex')
}

function assertStoredDaySeal(
  generation: string,
  seal: StoredDaySeal,
): void {
  assertUtcDay('sealed day', seal.day)
  assertSafeInteger(
    'sealed_through_sequence',
    seal.sealed_through_sequence,
  )
  assertHash('sealed_envelope_hash', seal.sealed_envelope_hash)
  assertSafeInteger(
    'collector_schema_version',
    seal.collector_schema_version,
    1,
  )
  assertIsoTimestamp('sealed_at', seal.sealed_at)
  assertHash('seal_hash', seal.seal_hash)
  if (
    daySealHash(generation, {
      day: seal.day,
      sealed_through_sequence: seal.sealed_through_sequence,
      sealed_envelope_hash: seal.sealed_envelope_hash,
      collector_schema_version: seal.collector_schema_version,
      sealed_at: seal.sealed_at,
    }) !== seal.seal_hash
  ) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'seal_mismatch',
    )
  }
}

function runAtomically<Result>(
  db: Database.Database,
  work: () => Result,
): Result {
  return db.transaction(work).immediate()
}

function assertSidecarSchemaCompatible(db: Database.Database): void {
  const actual = db.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL
      AND (
        name LIKE 'compatibility_failure_journal_%'
        OR (
          type='trigger'
          AND tbl_name LIKE 'compatibility_failure_journal_%'
        )
      )
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string; sql: string }>
  const byName = new Map(actual.map((object) => [object.name, object]))
  const exact = actual.length === SIDECAR_SCHEMA.length
    && SIDECAR_SCHEMA.every((expected) => {
      const candidate = byName.get(expected.name)
      return candidate?.type === expected.type
        && normalizeSchemaSql(candidate.sql)
          === normalizeSchemaSql(expected.sql)
    })
  if (!exact) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'sidecar_schema_incompatible',
    )
  }
}

function readMainState(
  db: Database.Database,
): StoredMainState | undefined {
  const rows = db.prepare(`
    SELECT singleton, journal_generation, applied_through_sequence,
      applied_envelope_hash
    FROM ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE}
    ORDER BY singleton
  `).all() as StoredMainState[]
  if (rows.length > 1) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'high_water_mismatch',
    )
  }
  const state = rows[0]
  if (!state) return undefined
  if (state.singleton !== 1) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'high_water_mismatch',
    )
  }
  assertUuid('journal_generation', state.journal_generation)
  assertSafeInteger(
    'applied_through_sequence',
    state.applied_through_sequence,
  )
  assertHash('applied_envelope_hash', state.applied_envelope_hash)
  if (
    state.applied_through_sequence === 0
    && state.applied_envelope_hash !== ZERO_HASH
  ) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'high_water_mismatch',
    )
  }
  return state
}

function readSidecarState(db: Database.Database): StoredSidecarState {
  const rows = db.prepare(`
    SELECT singleton, schema_version, journal_generation, capacity,
      next_sequence, pruned_through_sequence, pruned_envelope_hash,
      last_envelope_hash, last_observed_day
    FROM ${SIDECAR_STATE_TABLE}
    ORDER BY singleton
  `).all() as StoredSidecarState[]
  if (rows.length !== 1 || rows[0]?.singleton !== 1) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'binding_uninitialized',
    )
  }
  const state = rows[0]
  if (state.schema_version !== JOURNAL_SCHEMA_VERSION) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'sidecar_schema_incompatible',
    )
  }
  assertUuid('journal_generation', state.journal_generation)
  assertSafeInteger('capacity', state.capacity, 1)
  assertSafeInteger('next_sequence', state.next_sequence, 1)
  assertSafeInteger(
    'pruned_through_sequence',
    state.pruned_through_sequence,
  )
  assertHash('pruned_envelope_hash', state.pruned_envelope_hash)
  assertHash('last_envelope_hash', state.last_envelope_hash)
  if (state.last_observed_day !== null) {
    assertUtcDay('last_observed_day', state.last_observed_day)
  }
  if (
    state.capacity > MAX_CAPACITY
    || state.pruned_through_sequence >= state.next_sequence
    || (
      state.pruned_through_sequence === 0
      && state.pruned_envelope_hash !== ZERO_HASH
    )
    || (state.next_sequence === 1 && state.last_observed_day !== null)
    || (state.next_sequence > 1 && state.last_observed_day === null)
  ) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'envelope_chain_malformed',
    )
  }
  return state
}

function assertIsoTimestamp(name: string, value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length < 20
    || value.length > 32
    || !Number.isFinite(new Date(value).getTime())
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${name} is not a canonical timestamp`)
  }
}

function validateAttempt(
  generation: string,
  attempt: StoredAttempt,
  expectedSequence: number,
  expectedPreviousHash: string,
): void {
  if (
    assertSafeInteger('attempt sequence', attempt.sequence, 1)
      !== expectedSequence
  ) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'envelope_chain_malformed',
    )
  }
  assertHash('previous_envelope_hash', attempt.previous_envelope_hash)
  assertHash('envelope_hash', attempt.envelope_hash)
  assertUtcDay('observed_day', attempt.observed_day)
  assertUuid('producer_instance', attempt.producer_instance)
  assertIsoTimestamp('reserved_at', attempt.reserved_at)
  if (attempt.operation_returned_at !== null) {
    assertIsoTimestamp(
      'operation_returned_at',
      attempt.operation_returned_at,
    )
    assertHash('return_marker_hash', attempt.return_marker_hash)
    if (
      returnMarkerHash(
        generation,
        attempt,
        attempt.operation_returned_at,
      ) !== attempt.return_marker_hash
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'outcome_mismatch',
      )
    }
  } else if (attempt.return_marker_hash !== null) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'outcome_mismatch',
    )
  }
  const cohorts = AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS[
    attempt.table_name
  ] as readonly CompatibilityMigrationTelemetryCohort[] | undefined
  if (
    !AGENT_OS_LEGACY_COMPATIBILITY_TABLES.includes(attempt.table_name)
    || !cohorts?.includes(attempt.cohort)
    || !AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS.includes(
      attempt.fallback_diagnostic,
    )
    || attempt.previous_envelope_hash !== expectedPreviousHash
    || envelopeHash(generation, {
      sequence: attempt.sequence,
      previous_envelope_hash: attempt.previous_envelope_hash,
      observed_day: attempt.observed_day,
      table_name: attempt.table_name,
      cohort: attempt.cohort,
      fallback_diagnostic: attempt.fallback_diagnostic,
      producer_instance: attempt.producer_instance,
      reserved_at: attempt.reserved_at,
    }) !== attempt.envelope_hash
  ) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'envelope_chain_malformed',
    )
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    if (code === 'ESRCH') return false
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'envelope_chain_malformed',
      { cause: error },
    )
  }
}

function reapInactiveSessions(sidecar: Database.Database): void {
  runAtomically(sidecar, () => {
    const sessions = sidecar.prepare(`
      SELECT producer_instance, process_id, opened_at, closed_at
      FROM ${SIDECAR_SESSIONS_TABLE}
      ORDER BY producer_instance
    `).all() as Array<{
      producer_instance: string
      process_id: number
      opened_at: string
      closed_at: string | null
    }>
    for (const session of sessions) {
      assertUuid('producer_instance', session.producer_instance)
      if (
        assertSafeInteger('session process_id', session.process_id, 1)
          > MAX_PROCESS_ID
      ) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'envelope_chain_malformed',
        )
      }
      assertIsoTimestamp('session opened_at', session.opened_at)
      if (session.closed_at !== null) {
        assertIsoTimestamp('session closed_at', session.closed_at)
        continue
      }
      if (!isProcessAlive(session.process_id)) {
        sidecar.prepare(`
          UPDATE ${SIDECAR_SESSIONS_TABLE}
          SET closed_at=?
          WHERE producer_instance=? AND closed_at IS NULL
        `).run(new Date().toISOString(), session.producer_instance)
      }
    }
    sidecar.prepare(`
      DELETE FROM ${SIDECAR_SESSIONS_TABLE}
      WHERE closed_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${SIDECAR_ATTEMPTS_TABLE}
          WHERE producer_instance=
            ${SIDECAR_SESSIONS_TABLE}.producer_instance
        )
    `).run()
  })
}

export class CompatibilityMigrationFailureJournal
implements CompatibilityMigrationFailureJournalBinding {
  readonly journal_generation: string
  readonly #main: Database.Database
  readonly #sidecar: Database.Database
  readonly #runtimeInstance: string
  #closed = false

  constructor(
    main: Database.Database,
    sidecar: Database.Database,
    runtimeInstance: string,
    generation: string,
  ) {
    this.#main = main
    this.#sidecar = sidecar
    this.#runtimeInstance = runtimeInstance
    this.journal_generation = generation
  }

  #assertOpen(): void {
    if (this.#closed || !this.#sidecar.open) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'sidecar_unavailable',
      )
    }
  }

  #assertBinding(): {
    main: StoredMainState
    sidecar: StoredSidecarState
  } {
    this.#assertOpen()
    assertCompatibilityMigrationFailureJournalSchemaCompatible(this.#main)
    assertSidecarSchemaCompatible(this.#sidecar)
    const main = readMainState(this.#main)
    if (!main) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'binding_uninitialized',
      )
    }
    const sidecar = readSidecarState(this.#sidecar)
    if (
      main.journal_generation !== this.journal_generation
      || sidecar.journal_generation !== this.journal_generation
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'generation_mismatch',
      )
    }
    const foreignReceipts = this.#main.prepare(`
      SELECT (
        SELECT COUNT(*)
        FROM ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
        WHERE journal_generation<>?
      ) + (
        SELECT COUNT(*)
        FROM ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE}
        WHERE journal_generation<>?
      ) AS count
    `).get(
      this.journal_generation,
      this.journal_generation,
    ) as { count: number }
    if (assertSafeInteger('foreign receipt count', foreignReceipts.count) > 0) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'generation_mismatch',
      )
    }
    return { main, sidecar }
  }

  #validatedAttempts(state: StoredSidecarState): readonly StoredAttempt[] {
    const attempts = this.#sidecar.prepare(`
      SELECT sequence, previous_envelope_hash, envelope_hash, observed_day,
        table_name, cohort, fallback_diagnostic, producer_instance, reserved_at,
        operation_returned_at, return_marker_hash
      FROM ${SIDECAR_ATTEMPTS_TABLE}
      ORDER BY sequence
    `).all() as StoredAttempt[]
    const expectedCount =
      state.next_sequence - state.pruned_through_sequence - 1
    if (attempts.length !== expectedCount) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'envelope_chain_malformed',
      )
    }
    let previousHash = state.pruned_envelope_hash
    let sequence = state.pruned_through_sequence + 1
    for (const attempt of attempts) {
      validateAttempt(
        state.journal_generation,
        attempt,
        sequence,
        previousHash,
      )
      previousHash = attempt.envelope_hash
      sequence += 1
    }
    if (previousHash !== state.last_envelope_hash) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'envelope_chain_malformed',
      )
    }
    return Object.freeze(attempts)
  }

  #bindingSnapshot(): {
    main: StoredMainState
    sidecar: StoredSidecarState
    attempts: readonly StoredAttempt[]
  } {
    return this.#sidecar.transaction(() => {
      const { main, sidecar } = this.#assertBinding()
      return {
        main,
        sidecar,
        attempts: this.#validatedAttempts(sidecar),
      }
    }).deferred()
  }

  #assertReservation(
    reservation: CompatibilityMigrationFailureReservation,
  ): StoredAttempt {
    assertPlainObject(
      reservation,
      ['journal_generation', 'sequence', 'envelope_hash'],
    )
    assertUuid(
      'reservation journal_generation',
      reservation.journal_generation,
    )
    assertSafeInteger('reservation sequence', reservation.sequence, 1)
    assertHash('reservation envelope_hash', reservation.envelope_hash)
    if (reservation.journal_generation !== this.journal_generation) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'generation_mismatch',
      )
    }
    this.#assertBinding()
    const attempt = this.#sidecar.prepare(`
      SELECT sequence, previous_envelope_hash, envelope_hash, observed_day,
        table_name, cohort, fallback_diagnostic, producer_instance, reserved_at,
        operation_returned_at, return_marker_hash
      FROM ${SIDECAR_ATTEMPTS_TABLE}
      WHERE sequence=?
    `).get(reservation.sequence) as StoredAttempt | undefined
    if (!attempt || attempt.envelope_hash !== reservation.envelope_hash) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'receipt_mismatch',
      )
    }
    return attempt
  }

  reserve(
    input: CompatibilityMigrationFailureReservationInput,
  ): CompatibilityMigrationFailureReservation {
    assertPlainObject(
      input,
      ['observed_at', 'table', 'cohort', 'fallback_diagnostic'],
    )
    if (
      !(input.observed_at instanceof Date)
      || !Number.isFinite(input.observed_at.getTime())
    ) {
      throw new TypeError('observed_at must be a valid Date')
    }
    if (!AGENT_OS_LEGACY_COMPATIBILITY_TABLES.includes(input.table)) {
      throw new TypeError('table is not a compatibility table')
    }
    const cohorts = AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS[
      input.table
    ] as readonly CompatibilityMigrationTelemetryCohort[]
    if (!cohorts.includes(input.cohort)) {
      throw new TypeError('cohort is not supported for the compatibility table')
    }
    if (
      !AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS.includes(
        input.fallback_diagnostic,
      )
    ) {
      throw new TypeError('fallback_diagnostic is not bounded')
    }

    const observedDay = utcDay(input.observed_at)
    const reservedAt = new Date().toISOString()
    const reservation = runAtomically(this.#sidecar, () => {
      const { sidecar } = this.#assertBinding()
      const pendingCount =
        sidecar.next_sequence - sidecar.pruned_through_sequence - 1
      if (pendingCount >= sidecar.capacity) {
        throw new CompatibilityMigrationFailureJournalCapacityError()
      }
      const sealed = this.#sidecar.prepare(`
        SELECT 1 FROM ${SIDECAR_DAY_SEALS_TABLE}
        WHERE day>=?
        LIMIT 1
      `).get(observedDay)
      if (sealed) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'day_already_sealed',
        )
      }
      if (
        sidecar.last_observed_day !== null
        && observedDay < sidecar.last_observed_day
      ) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'day_order_mismatch',
        )
      }
      const attemptWithoutHash: Omit<StoredAttempt, 'envelope_hash'> = {
        sequence: sidecar.next_sequence,
        previous_envelope_hash: sidecar.last_envelope_hash,
        observed_day: observedDay,
        table_name: input.table,
        cohort: input.cohort,
        fallback_diagnostic: input.fallback_diagnostic,
        producer_instance: this.#runtimeInstance,
        reserved_at: reservedAt,
        operation_returned_at: null,
        return_marker_hash: null,
      }
      const hash = envelopeHash(
        sidecar.journal_generation,
        attemptWithoutHash,
      )
      const insert = this.#sidecar.prepare(`
        INSERT INTO ${SIDECAR_ATTEMPTS_TABLE} (
          sequence, previous_envelope_hash, envelope_hash, observed_day,
          table_name, cohort, fallback_diagnostic, producer_instance,
          reserved_at, operation_returned_at, return_marker_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        attemptWithoutHash.sequence,
        attemptWithoutHash.previous_envelope_hash,
        hash,
        attemptWithoutHash.observed_day,
        attemptWithoutHash.table_name,
        attemptWithoutHash.cohort,
        attemptWithoutHash.fallback_diagnostic,
        attemptWithoutHash.producer_instance,
        attemptWithoutHash.reserved_at,
      )
      const update = this.#sidecar.prepare(`
        UPDATE ${SIDECAR_STATE_TABLE}
        SET next_sequence=?, last_envelope_hash=?, last_observed_day=?
        WHERE singleton=1
          AND next_sequence=?
          AND last_envelope_hash=?
      `).run(
        sidecar.next_sequence + 1,
        hash,
        observedDay,
        sidecar.next_sequence,
        sidecar.last_envelope_hash,
      )
      if (insert.changes !== 1 || update.changes !== 1) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'envelope_chain_malformed',
        )
      }
      return Object.freeze({
        journal_generation: sidecar.journal_generation,
        sequence: sidecar.next_sequence,
        envelope_hash: hash,
      })
    })
    return reservation
  }

  #markFailureSequence(
    sequence: number,
    diagnostic: CompatibilityMigrationFailureDiagnostic,
  ): void {
    runAtomically(this.#sidecar, () => {
      const attempt = this.#sidecar.prepare(`
        SELECT sequence, envelope_hash
        FROM ${SIDECAR_ATTEMPTS_TABLE}
        WHERE sequence=?
      `).get(sequence) as Pick<
        StoredAttempt,
        'sequence' | 'envelope_hash'
      > | undefined
      if (!attempt) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'outcome_mismatch',
        )
      }
      const existing = this.#sidecar.prepare(`
        SELECT sequence, diagnostic_code, failed_at, outcome_hash
        FROM ${SIDECAR_FAILURES_TABLE}
        WHERE sequence=?
      `).get(sequence) as StoredFailure | undefined
      if (existing) {
        assertIsoTimestamp('failed_at', existing.failed_at)
        if (
          existing.diagnostic_code !== diagnostic
          || failureOutcomeHash(
            this.journal_generation,
            attempt,
            existing.diagnostic_code,
            existing.failed_at,
          ) !== existing.outcome_hash
        ) {
          throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
            'outcome_mismatch',
          )
        }
        return
      }
      const failedAt = new Date().toISOString()
      const outcomeHash = failureOutcomeHash(
        this.journal_generation,
        attempt,
        diagnostic,
        failedAt,
      )
      const insert = this.#sidecar.prepare(`
        INSERT INTO ${SIDECAR_FAILURES_TABLE} (
          sequence, diagnostic_code, failed_at, outcome_hash
        ) VALUES (?, ?, ?, ?)
      `).run(sequence, diagnostic, failedAt, outcomeHash)
      if (insert.changes !== 1) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'outcome_mismatch',
        )
      }
    })
  }

  markFailed(
    reservation: CompatibilityMigrationFailureReservation,
    diagnostic?: CompatibilityMigrationFailureDiagnostic,
  ): void {
    const attempt = this.#assertReservation(reservation)
    const boundedDiagnostic = diagnostic ?? attempt.fallback_diagnostic
    if (
      !AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS.includes(
        boundedDiagnostic,
      )
    ) {
      throw new TypeError('diagnostic is not a bounded failure diagnostic')
    }
    this.#markFailureSequence(attempt.sequence, boundedDiagnostic)
    this.#markOperationReturned(reservation)
  }

  #markOperationReturned(
    reservation: CompatibilityMigrationFailureReservation,
  ): void {
    const attempt = this.#assertReservation(reservation)
    if (attempt.operation_returned_at !== null) {
      assertIsoTimestamp(
        'operation_returned_at',
        attempt.operation_returned_at,
      )
      if (
        attempt.return_marker_hash === null
        || returnMarkerHash(
          this.journal_generation,
          attempt,
          attempt.operation_returned_at,
        ) !== attempt.return_marker_hash
      ) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'outcome_mismatch',
        )
      }
      return
    }
    const returnedAt = new Date().toISOString()
    const markerHash = returnMarkerHash(
      this.journal_generation,
      attempt,
      returnedAt,
    )
    const updated = this.#sidecar.prepare(`
      UPDATE ${SIDECAR_ATTEMPTS_TABLE}
      SET operation_returned_at=?, return_marker_hash=?
      WHERE sequence=?
        AND envelope_hash=?
        AND operation_returned_at IS NULL
        AND return_marker_hash IS NULL
    `).run(
      returnedAt,
      markerHash,
      attempt.sequence,
      attempt.envelope_hash,
    )
    if (updated.changes !== 1) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'outcome_mismatch',
      )
    }
  }

  recordSuccessReceipt(
    reservation: CompatibilityMigrationFailureReservation,
  ): void {
    const attempt = this.#assertReservation(reservation)
    const failure = this.#sidecar.prepare(`
      SELECT 1 FROM ${SIDECAR_FAILURES_TABLE} WHERE sequence=?
    `).get(attempt.sequence)
    if (failure) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'receipt_mismatch',
      )
    }
    this.#markOperationReturned(reservation)

    runAtomically(this.#main, () => {
      this.#assertBinding()
      const existing = this.#main.prepare(`
        SELECT journal_generation, sequence, envelope_hash
        FROM ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
        WHERE journal_generation=? AND sequence=?
      `).get(
        this.journal_generation,
        attempt.sequence,
      ) as StoredSuccessReceipt | undefined
      if (existing) {
        if (existing.envelope_hash !== attempt.envelope_hash) {
          throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
            'receipt_mismatch',
          )
        }
        return
      }
      const inserted = withMainGuard(
        this.#main,
        'success-receipt',
        () => this.#main.prepare(`
          INSERT INTO ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE} (
            journal_generation, sequence, envelope_hash
          ) VALUES (?, ?, ?)
        `).run(
          this.journal_generation,
          attempt.sequence,
          attempt.envelope_hash,
        ),
      )
      if (inserted.changes !== 1) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'receipt_mismatch',
        )
      }
    })
  }

  #storedFailure(attempt: StoredAttempt): StoredFailure | undefined {
    const failure = this.#sidecar.prepare(`
      SELECT sequence, diagnostic_code, failed_at, outcome_hash
      FROM ${SIDECAR_FAILURES_TABLE}
      WHERE sequence=?
    `).get(attempt.sequence) as StoredFailure | undefined
    if (failure) {
      if (
        !AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS.includes(
          failure.diagnostic_code,
        )
      ) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'envelope_chain_malformed',
        )
      }
      assertIsoTimestamp('failed_at', failure.failed_at)
      assertHash('outcome_hash', failure.outcome_hash)
      if (
        failureOutcomeHash(
          this.journal_generation,
          attempt,
          failure.diagnostic_code,
          failure.failed_at,
        ) !== failure.outcome_hash
      ) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'outcome_mismatch',
        )
      }
    }
    return failure
  }

  #storedSuccessReceipt(sequence: number): StoredSuccessReceipt | undefined {
    const receipt = this.#main.prepare(`
      SELECT journal_generation, sequence, envelope_hash
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
      WHERE journal_generation=? AND sequence=?
    `).get(
      this.journal_generation,
      sequence,
    ) as StoredSuccessReceipt | undefined
    if (receipt) {
      assertHash('success receipt envelope_hash', receipt.envelope_hash)
    }
    return receipt
  }

  #producerIsActive(producerInstance: string): boolean {
    const session = this.#sidecar.prepare(`
      SELECT process_id, opened_at, closed_at
      FROM ${SIDECAR_SESSIONS_TABLE}
      WHERE producer_instance=?
    `).get(producerInstance) as {
      process_id: number
      opened_at: string
      closed_at: string | null
    } | undefined
    if (!session) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'envelope_chain_malformed',
      )
    }
    if (
      assertSafeInteger('session process_id', session.process_id, 1)
        > MAX_PROCESS_ID
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'envelope_chain_malformed',
      )
    }
    assertIsoTimestamp('session opened_at', session.opened_at)
    if (session.closed_at !== null) {
      assertIsoTimestamp('session closed_at', session.closed_at)
      return false
    }
    if (isProcessAlive(session.process_id)) return true
    this.#sidecar.prepare(`
      UPDATE ${SIDECAR_SESSIONS_TABLE}
      SET closed_at=?
      WHERE producer_instance=? AND closed_at IS NULL
    `).run(new Date().toISOString(), producerInstance)
    return false
  }

  #advanceFailure(
    previous: StoredMainState,
    attempt: StoredAttempt,
    failure: StoredFailure,
  ): void {
    try {
      runAtomically(this.#main, () => {
        assertCompatibilityMigrationFailureJournalSchemaCompatible(this.#main)
        const current = readMainState(this.#main)
        if (
          !current
          || current.journal_generation !== this.journal_generation
          || current.applied_through_sequence
            !== previous.applied_through_sequence
          || current.applied_envelope_hash !== previous.applied_envelope_hash
        ) {
          throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
            'high_water_mismatch',
          )
        }
        if (this.#storedSuccessReceipt(attempt.sequence)) {
          throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
            'receipt_mismatch',
          )
        }
        recordCompatibilityMigrationTelemetry(this.#main, {
          observed_at: new Date(`${attempt.observed_day}T12:00:00.000Z`),
          table: attempt.table_name,
          operation: 'failure',
          cohort: attempt.cohort,
          diagnostic_code: failure.diagnostic_code,
        })
        const update = withMainGuard(
          this.#main,
          'reconcile',
          () => this.#main.prepare(`
            UPDATE ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE}
            SET applied_through_sequence=?, applied_envelope_hash=?
            WHERE singleton=1
              AND journal_generation=?
              AND applied_through_sequence=?
              AND applied_envelope_hash=?
          `).run(
            attempt.sequence,
            attempt.envelope_hash,
            this.journal_generation,
            previous.applied_through_sequence,
            previous.applied_envelope_hash,
          ),
        )
        if (update.changes !== 1) {
          throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
            'high_water_mismatch',
          )
        }
      })
    } catch (error) {
      if (
        error
          instanceof CompatibilityMigrationTelemetryEvidenceIncompleteError
      ) {
        throw error
      }
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'reconcile_blocked',
        { cause: error },
      )
    }
  }

  #advanceSuccess(
    previous: StoredMainState,
    attempt: StoredAttempt,
    receipt: StoredSuccessReceipt,
  ): void {
    if (receipt.envelope_hash !== attempt.envelope_hash) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'receipt_mismatch',
      )
    }
    try {
      runAtomically(this.#main, () => {
        const current = readMainState(this.#main)
        if (
          !current
          || current.journal_generation !== this.journal_generation
          || current.applied_through_sequence
            !== previous.applied_through_sequence
          || current.applied_envelope_hash !== previous.applied_envelope_hash
        ) {
          throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
            'high_water_mismatch',
          )
        }
        const changes = withMainGuard(this.#main, 'reconcile', () => {
          const update = this.#main.prepare(`
            UPDATE ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE}
            SET applied_through_sequence=?, applied_envelope_hash=?
            WHERE singleton=1
              AND journal_generation=?
              AND applied_through_sequence=?
              AND applied_envelope_hash=?
          `).run(
            attempt.sequence,
            attempt.envelope_hash,
            this.journal_generation,
            previous.applied_through_sequence,
            previous.applied_envelope_hash,
          )
          const deleted = this.#main.prepare(`
            DELETE FROM ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
            WHERE journal_generation=? AND sequence=? AND envelope_hash=?
          `).run(
            this.journal_generation,
            attempt.sequence,
            attempt.envelope_hash,
          )
          return { updated: update.changes, deleted: deleted.changes }
        })
        if (changes.updated !== 1 || changes.deleted !== 1) {
          throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
            'receipt_mismatch',
          )
        }
      })
    } catch (error) {
      if (
        error
          instanceof CompatibilityMigrationTelemetryEvidenceIncompleteError
      ) {
        throw error
      }
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'reconcile_blocked',
        { cause: error },
      )
    }
  }

  #pruneThrough(sequence: number, hash: string): number {
    return runAtomically(this.#sidecar, () => {
      const state = readSidecarState(this.#sidecar)
      if (sequence <= state.pruned_through_sequence) return 0
      if (sequence >= state.next_sequence) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'high_water_mismatch',
        )
      }
      const boundary = this.#sidecar.prepare(`
        SELECT envelope_hash
        FROM ${SIDECAR_ATTEMPTS_TABLE}
        WHERE sequence=?
      `).get(sequence) as { envelope_hash: string } | undefined
      if (!boundary || boundary.envelope_hash !== hash) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'high_water_mismatch',
        )
      }
      const update = this.#sidecar.prepare(`
        UPDATE ${SIDECAR_STATE_TABLE}
        SET pruned_through_sequence=?, pruned_envelope_hash=?
        WHERE singleton=1
          AND pruned_through_sequence=?
          AND pruned_envelope_hash=?
      `).run(
        sequence,
        hash,
        state.pruned_through_sequence,
        state.pruned_envelope_hash,
      )
      const deleted = this.#sidecar.prepare(`
        DELETE FROM ${SIDECAR_ATTEMPTS_TABLE}
        WHERE sequence<=?
      `).run(sequence)
      this.#sidecar.prepare(`
        DELETE FROM ${SIDECAR_SESSIONS_TABLE}
        WHERE closed_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${SIDECAR_ATTEMPTS_TABLE}
            WHERE producer_instance=
              ${SIDECAR_SESSIONS_TABLE}.producer_instance
          )
      `).run()
      if (update.changes !== 1) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'high_water_mismatch',
        )
      }
      return deleted.changes
    })
  }

  #reconcileThrough(
    targetSequence: number,
  ): CompatibilityMigrationFailureJournalDrainResult {
    if (this.#main.inTransaction) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'reconcile_in_transaction',
      )
    }
    let { main, sidecar, attempts } = this.#bindingSnapshot()
    const lastSequence = sidecar.next_sequence - 1
    if (targetSequence < 0 || targetSequence > lastSequence) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'high_water_mismatch',
      )
    }
    if (
      main.applied_through_sequence < sidecar.pruned_through_sequence
      || main.applied_through_sequence > lastSequence
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'high_water_mismatch',
      )
    }

    let attemptsPruned = 0
    if (main.applied_through_sequence > sidecar.pruned_through_sequence) {
      const boundary = attempts.find(
        ({ sequence }) => sequence === main.applied_through_sequence,
      )
      if (!boundary || boundary.envelope_hash !== main.applied_envelope_hash) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'high_water_mismatch',
        )
      }
      attemptsPruned += this.#pruneThrough(
        main.applied_through_sequence,
        main.applied_envelope_hash,
      )
      const snapshot = this.#bindingSnapshot()
      main = snapshot.main
      sidecar = snapshot.sidecar
      attempts = snapshot.attempts
    } else if (
      main.applied_envelope_hash !== sidecar.pruned_envelope_hash
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'high_water_mismatch',
      )
    }

    let failuresImported = 0
    let successesReconciled = 0
    while (main.applied_through_sequence < targetSequence) {
      const expectedSequence = main.applied_through_sequence + 1
      const attempt = attempts.find(
        ({ sequence }) => sequence === expectedSequence,
      )
      if (
        !attempt
        || attempt.previous_envelope_hash !== main.applied_envelope_hash
      ) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'envelope_chain_malformed',
        )
      }
      let failure = this.#storedFailure(attempt)
      const receipt = this.#storedSuccessReceipt(expectedSequence)
      if (failure && receipt) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'receipt_mismatch',
        )
      }
      if (!failure && !receipt) {
        if (
          attempt.operation_returned_at === null
          && this.#producerIsActive(attempt.producer_instance)
        ) {
          throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
            'pending_attempt',
          )
        }
        this.#markFailureSequence(expectedSequence, 'unexpected_failure')
        failure = this.#storedFailure(attempt)
      }
      if (failure) {
        this.#advanceFailure(main, attempt, failure)
        failuresImported += 1
      } else if (receipt) {
        this.#advanceSuccess(main, attempt, receipt)
        successesReconciled += 1
      } else {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'pending_attempt',
        )
      }
      main = readMainState(this.#main) as StoredMainState
      attemptsPruned += this.#pruneThrough(
        main.applied_through_sequence,
        main.applied_envelope_hash,
      )
      const snapshot = this.#bindingSnapshot()
      main = snapshot.main
      sidecar = snapshot.sidecar
      attempts = snapshot.attempts
    }

    return Object.freeze({
      journal_generation: this.journal_generation,
      applied_through_sequence: main.applied_through_sequence,
      applied_envelope_hash: main.applied_envelope_hash,
      failures_imported: failuresImported,
      successes_reconciled: successesReconciled,
      attempts_pruned: attemptsPruned,
    })
  }

  drain(): CompatibilityMigrationFailureJournalDrainResult {
    const { sidecar } = this.#assertBinding()
    return this.#reconcileThrough(sidecar.next_sequence - 1)
  }

  durabilityProfile():
  CompatibilityMigrationFailureJournalDurabilityProfile {
    this.#assertOpen()
    const profile = {
      journal_mode: String(
        this.#sidecar.pragma('journal_mode', { simple: true }),
      ).toLowerCase(),
      synchronous: Number(
        this.#sidecar.pragma('synchronous', { simple: true }),
      ),
      fullfsync: Number(
        this.#sidecar.pragma('fullfsync', { simple: true }),
      ),
      cell_size_check: Number(
        this.#sidecar.pragma('cell_size_check', { simple: true }),
      ),
      secure_delete: Number(
        this.#sidecar.pragma('secure_delete', { simple: true }),
      ),
    }
    if (
      profile.journal_mode !== 'delete'
      || profile.synchronous !== 3
      || profile.fullfsync !== 1
      || profile.cell_size_check !== 1
      || profile.secure_delete !== 1
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'sidecar_unavailable',
      )
    }
    return Object.freeze(
      profile,
    ) as CompatibilityMigrationFailureJournalDurabilityProfile
  }

  #collectorSchemaVersion(): number {
    const rows = this.#main.prepare(`
      SELECT collector_schema_version
      FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
      ORDER BY singleton
    `).all() as Array<{ collector_schema_version: number }>
    if (rows.length !== 1) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'collector_epoch_mismatch',
      )
    }
    const version = assertSafeInteger(
      'collector_schema_version',
      rows[0]?.collector_schema_version,
      1,
    )
    const current = assertSafeInteger(
      'SQLite schema_version',
      this.#main.pragma('schema_version', { simple: true }),
      1,
    )
    if (version !== current) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'collector_epoch_mismatch',
      )
    }
    return version
  }

  prepareDaySeal(
    day: string,
  ): CompatibilityMigrationFailureDaySealEvidence {
    assertUtcDay('day', day)
    if (this.#main.inTransaction) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'reconcile_in_transaction',
      )
    }
    const collectorSchemaVersion = this.#collectorSchemaVersion()
    const seal = runAtomically(this.#sidecar, () => {
      const { sidecar } = this.#assertBinding()
      const existing = this.#sidecar.prepare(`
        SELECT day, sealed_through_sequence, sealed_envelope_hash,
          collector_schema_version, sealed_at, seal_hash
        FROM ${SIDECAR_DAY_SEALS_TABLE}
        WHERE day=?
      `).get(day) as StoredDaySeal | undefined
      if (existing) {
        assertStoredDaySeal(this.journal_generation, existing)
        if (
          existing.collector_schema_version !== collectorSchemaVersion
        ) {
          throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
            'collector_epoch_mismatch',
          )
        }
        return existing
      }
      const count = this.#sidecar.prepare(`
        SELECT COUNT(*) AS count FROM ${SIDECAR_DAY_SEALS_TABLE}
      `).get() as { count: number }
      if (
        assertSafeInteger('sidecar day seal count', count.count)
          >= MAX_DAY_SEALS
      ) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'seal_capacity_exhausted',
        )
      }
      const retainedBoundary = this.#sidecar.prepare(`
        SELECT sequence, envelope_hash
        FROM ${SIDECAR_ATTEMPTS_TABLE}
        WHERE observed_day<=?
        ORDER BY sequence DESC
        LIMIT 1
      `).get(day) as {
        sequence: number
        envelope_hash: string
      } | undefined
      const insertedWithoutHash: Omit<StoredDaySeal, 'seal_hash'> = {
        day,
        sealed_through_sequence:
          retainedBoundary?.sequence ?? sidecar.pruned_through_sequence,
        sealed_envelope_hash:
          retainedBoundary?.envelope_hash ?? sidecar.pruned_envelope_hash,
        collector_schema_version: collectorSchemaVersion,
        sealed_at: new Date().toISOString(),
      }
      const inserted: StoredDaySeal = {
        ...insertedWithoutHash,
        seal_hash: daySealHash(
          this.journal_generation,
          insertedWithoutHash,
        ),
      }
      const result = this.#sidecar.prepare(`
        INSERT INTO ${SIDECAR_DAY_SEALS_TABLE} (
          day, sealed_through_sequence, sealed_envelope_hash,
          collector_schema_version, sealed_at, seal_hash
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        inserted.day,
        inserted.sealed_through_sequence,
        inserted.sealed_envelope_hash,
        inserted.collector_schema_version,
        inserted.sealed_at,
        inserted.seal_hash,
      )
      if (result.changes !== 1) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'seal_mismatch',
        )
      }
      return inserted
    })
    this.#reconcileThrough(seal.sealed_through_sequence)
    return Object.freeze({
      day: seal.day,
      journal_generation: this.journal_generation,
      sealed_through_sequence: seal.sealed_through_sequence,
      sealed_envelope_hash: seal.sealed_envelope_hash,
      collector_schema_version: seal.collector_schema_version,
    })
  }

  #assertSealEvidence(
    evidence: CompatibilityMigrationFailureDaySealEvidence,
  ): StoredDaySeal {
    assertPlainObject(evidence, [
      'day',
      'journal_generation',
      'sealed_through_sequence',
      'sealed_envelope_hash',
      'collector_schema_version',
    ])
    assertUtcDay('seal day', evidence.day)
    assertUuid('seal journal_generation', evidence.journal_generation)
    assertSafeInteger(
      'sealed_through_sequence',
      evidence.sealed_through_sequence,
    )
    assertHash('sealed_envelope_hash', evidence.sealed_envelope_hash)
    assertSafeInteger(
      'collector_schema_version',
      evidence.collector_schema_version,
      1,
    )
    if (evidence.journal_generation !== this.journal_generation) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'generation_mismatch',
      )
    }
    this.#assertBinding()
    const stored = this.#sidecar.prepare(`
      SELECT day, sealed_through_sequence, sealed_envelope_hash,
        collector_schema_version, sealed_at, seal_hash
      FROM ${SIDECAR_DAY_SEALS_TABLE}
      WHERE day=?
    `).get(evidence.day) as StoredDaySeal | undefined
    if (
      !stored
      || stored.sealed_through_sequence
        !== evidence.sealed_through_sequence
      || stored.sealed_envelope_hash !== evidence.sealed_envelope_hash
      || stored.collector_schema_version
        !== evidence.collector_schema_version
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'seal_mismatch',
      )
    }
    assertStoredDaySeal(this.journal_generation, stored)
    return stored
  }

  writeDaySealReceipt(
    evidence: CompatibilityMigrationFailureDaySealEvidence,
  ): void {
    this.#assertSealEvidence(evidence)
    const main = readMainState(this.#main)
    if (
      !main
      || main.applied_through_sequence < evidence.sealed_through_sequence
      || (
        main.applied_through_sequence === evidence.sealed_through_sequence
        && main.applied_envelope_hash !== evidence.sealed_envelope_hash
      )
      || this.#collectorSchemaVersion() !== evidence.collector_schema_version
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'seal_mismatch',
      )
    }
    const existing = this.#main.prepare(`
      SELECT day, journal_generation, sealed_through_sequence,
        sealed_envelope_hash, collector_schema_version
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE}
      WHERE day=?
    `).get(evidence.day) as (
      CompatibilityMigrationFailureDaySealEvidence | undefined
    )
    if (existing) {
      if (
        existing.journal_generation !== evidence.journal_generation
        || existing.sealed_through_sequence
          !== evidence.sealed_through_sequence
        || existing.sealed_envelope_hash !== evidence.sealed_envelope_hash
        || existing.collector_schema_version
          !== evidence.collector_schema_version
      ) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'seal_mismatch',
        )
      }
      return
    }
    const inserted = withMainGuard(
      this.#main,
      'seal-receipt',
      () => this.#main.prepare(`
        INSERT INTO ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE} (
          day, journal_generation, sealed_through_sequence,
          sealed_envelope_hash, collector_schema_version
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        evidence.day,
        evidence.journal_generation,
        evidence.sealed_through_sequence,
        evidence.sealed_envelope_hash,
        evidence.collector_schema_version,
      ),
    )
    if (inserted.changes !== 1) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'seal_mismatch',
      )
    }
  }

  #assertReceiptForDay(day: string): void {
    const epoch = this.#collectorSchemaVersion()
    const main = readMainState(this.#main)
    const receipt = this.#main.prepare(`
      SELECT day, journal_generation, sealed_through_sequence,
        sealed_envelope_hash, collector_schema_version
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE}
      WHERE day=?
    `).get(day) as (
      CompatibilityMigrationFailureDaySealEvidence | undefined
    )
    if (
      !main
      || !receipt
      || receipt.journal_generation !== this.journal_generation
      || receipt.collector_schema_version !== epoch
      || receipt.sealed_through_sequence > main.applied_through_sequence
      || (
        receipt.sealed_through_sequence === main.applied_through_sequence
        && receipt.sealed_envelope_hash !== main.applied_envelope_hash
      )
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'coverage_receipt_missing',
      )
    }
    const stored = this.#sidecar.prepare(`
      SELECT day, sealed_through_sequence, sealed_envelope_hash,
        collector_schema_version, sealed_at, seal_hash
      FROM ${SIDECAR_DAY_SEALS_TABLE}
      WHERE day=?
    `).get(day) as StoredDaySeal | undefined
    if (
      !stored
      || stored.sealed_through_sequence !== receipt.sealed_through_sequence
      || stored.sealed_envelope_hash !== receipt.sealed_envelope_hash
      || stored.collector_schema_version !== receipt.collector_schema_version
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'seal_mismatch',
      )
    }
    assertStoredDaySeal(this.journal_generation, stored)
  }

  assertCoverageReceipts(fromDay: string, throughDay: string): void {
    assertUtcDay('from_day', fromDay)
    assertUtcDay('through_day', throughDay)
    if (fromDay > throughDay) {
      throw new RangeError('from_day must not be after through_day')
    }
    this.#assertBinding()
    const days = this.#main.prepare(`
      SELECT DISTINCT day
      FROM os_compatibility_migration_telemetry_coverage
      WHERE day BETWEEN ? AND ?
      ORDER BY day
    `).all(fromDay, throughDay) as Array<{ day: string }>
    for (const { day } of days) this.#assertReceiptForDay(day)
  }

  assertRollupReady(retainFromDay: string): void {
    assertUtcDay('retain_from_day', retainFromDay)
    this.#assertBinding()
    const days = this.#main.prepare(`
      SELECT day
      FROM os_compatibility_migration_telemetry_coverage
      WHERE day<?
      GROUP BY day
      HAVING COUNT(*)=${AGENT_OS_LEGACY_COMPATIBILITY_TABLES.length}
      ORDER BY day
    `).all(retainFromDay) as Array<{ day: string }>
    for (const { day } of days) this.#assertReceiptForDay(day)
  }

  close(): void {
    if (this.#closed) return
    try {
      if (this.#sidecar.open) {
        runAtomically(this.#sidecar, () => {
          this.#sidecar.prepare(`
            UPDATE ${SIDECAR_SESSIONS_TABLE}
            SET closed_at=?
            WHERE producer_instance=? AND closed_at IS NULL
          `).run(new Date().toISOString(), this.#runtimeInstance)
          this.#sidecar.prepare(`
            DELETE FROM ${SIDECAR_SESSIONS_TABLE}
            WHERE producer_instance=?
              AND NOT EXISTS (
                SELECT 1 FROM ${SIDECAR_ATTEMPTS_TABLE}
                WHERE producer_instance=?
              )
          `).run(this.#runtimeInstance, this.#runtimeInstance)
        })
      }
    } finally {
      this.#closed = true
      if (this.#sidecar.open) this.#sidecar.close()
    }
  }
}

export function openCompatibilityMigrationFailureJournal(
  main: Database.Database,
  input: OpenCompatibilityMigrationFailureJournalInput,
): CompatibilityMigrationFailureJournal {
  assertPlainObject(input, ['journal_path'], ['capacity', 'runtime_instance'])
  if (
    typeof input.journal_path !== 'string'
    || !path.isAbsolute(input.journal_path)
  ) {
    throw new TypeError('journal_path must be absolute')
  }
  const capacity = input.capacity ?? DEFAULT_CAPACITY
  assertSafeInteger('capacity', capacity, 1)
  if (capacity > MAX_CAPACITY) {
    throw new RangeError(`capacity must not exceed ${MAX_CAPACITY}`)
  }
  const runtimeInstance = input.runtime_instance ?? randomUUID()
  assertUuid('runtime_instance', runtimeInstance)

  assertCompatibilityMigrationFailureJournalSchemaCompatible(main)
  ensureMainGuard(main)
  const preexistingMainState = readMainState(main)
  const existed = fs.existsSync(input.journal_path)
  if (!existed && preexistingMainState) {
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      'sidecar_unavailable',
    )
  }
  fs.mkdirSync(path.dirname(input.journal_path), {
    recursive: true,
    mode: 0o700,
  })

  let sidecar: Database.Database | undefined
  try {
    sidecar = new Database(input.journal_path)
    sidecar.pragma('journal_mode = DELETE')
    sidecar.pragma('synchronous = EXTRA')
    sidecar.pragma('fullfsync = ON')
    sidecar.pragma('cell_size_check = ON')
    sidecar.pragma('secure_delete = ON')
    sidecar.pragma('foreign_keys = ON')
    sidecar.pragma('trusted_schema = OFF')
    sidecar.pragma('busy_timeout = 5000')
    fs.chmodSync(input.journal_path, 0o600)

    if (!existed) {
      sidecar.exec(SIDECAR_SCHEMA.map(({ sql }) => `${sql};`).join('\n'))
      const generation = randomUUID()
      sidecar.prepare(`
        INSERT INTO ${SIDECAR_STATE_TABLE} (
          singleton, schema_version, journal_generation, capacity,
          next_sequence, pruned_through_sequence, pruned_envelope_hash,
          last_envelope_hash, last_observed_day
        ) VALUES (1, ?, ?, ?, 1, 0, ?, ?, NULL)
      `).run(
        JOURNAL_SCHEMA_VERSION,
        generation,
        capacity,
        ZERO_HASH,
        ZERO_HASH,
      )
    }
    assertSidecarSchemaCompatible(sidecar)
    const sidecarState = readSidecarState(sidecar)
    if (sidecarState.capacity !== capacity) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'generation_mismatch',
      )
    }

    let mainState = preexistingMainState
    if (!mainState) {
      if (
        sidecarState.next_sequence !== 1
        || sidecarState.pruned_through_sequence !== 0
        || sidecarState.pruned_envelope_hash !== ZERO_HASH
        || sidecarState.last_envelope_hash !== ZERO_HASH
        || sidecarState.last_observed_day !== null
      ) {
        throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
          'binding_uninitialized',
        )
      }
      runAtomically(main, () => {
        const inserted = withMainGuard(
          main,
          'initialize',
          () => main.prepare(`
            INSERT INTO ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE} (
              singleton, journal_generation, applied_through_sequence,
              applied_envelope_hash
            ) VALUES (1, ?, 0, ?)
          `).run(sidecarState.journal_generation, ZERO_HASH),
        )
        if (inserted.changes !== 1) {
          throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
            'binding_uninitialized',
          )
        }
      })
      mainState = readMainState(main)
    }
    if (
      !mainState
      || mainState.journal_generation !== sidecarState.journal_generation
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'generation_mismatch',
      )
    }

    reapInactiveSessions(sidecar)
    const activeSessions = sidecar.prepare(`
      SELECT COUNT(*) AS count
      FROM ${SIDECAR_SESSIONS_TABLE}
      WHERE closed_at IS NULL
    `).get() as { count: number }
    if (
      assertSafeInteger('active journal session count', activeSessions.count)
        >= capacity
    ) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'session_capacity_exhausted',
      )
    }
    const existingSession = sidecar.prepare(`
      SELECT 1 FROM ${SIDECAR_SESSIONS_TABLE}
      WHERE producer_instance=?
    `).get(runtimeInstance)
    if (existingSession) {
      throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
        'binding_uninitialized',
      )
    }
    sidecar.prepare(`
      INSERT INTO ${SIDECAR_SESSIONS_TABLE} (
        producer_instance, process_id, opened_at, closed_at
      ) VALUES (?, ?, ?, NULL)
    `).run(runtimeInstance, process.pid, new Date().toISOString())

    const journal = new CompatibilityMigrationFailureJournal(
      main,
      sidecar,
      runtimeInstance,
      sidecarState.journal_generation,
    )
    journal.durabilityProfile()
    return journal
  } catch (error) {
    if (sidecar?.open) sidecar.close()
    if (
      error instanceof CompatibilityMigrationTelemetryEvidenceIncompleteError
      || error instanceof TypeError
      || error instanceof RangeError
    ) {
      throw error
    }
    throw new CompatibilityMigrationTelemetryEvidenceIncompleteError(
      existed ? 'sidecar_schema_incompatible' : 'sidecar_unavailable',
      { cause: error },
    )
  }
}

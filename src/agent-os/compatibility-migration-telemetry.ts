import type Database from 'better-sqlite3'
import {
  AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
} from './compatibility-forward-migration.js'
import {
  AGENT_OS_LEGACY_COMPATIBILITY_TABLES,
  type AgentOsLegacyCompatibilityTable,
} from './compatibility-projection-contract.js'
import type {
  CompatibilityMigrationFailureJournalBinding,
} from './compatibility-migration-failure-journal.js'

export const AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID =
  '023-compatibility-migration-telemetry'

export const AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS = Object.freeze([
  'legacy_read',
  'canonical_read',
  'legacy_write',
  'canonical_write',
  'adapter_translation',
  'projection_refresh',
  'mismatch',
  'failure',
] as const)

export type CompatibilityMigrationTelemetryOperation =
  typeof AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS[number]

export const AGENT_OS_COMPATIBILITY_TELEMETRY_COHORTS = Object.freeze([
  'shared_scope',
  'legacy_only',
  'canonical_linked',
  'canonical_unlinked',
  'migration_quarantined',
  'deferred_replacement',
] as const)

export type CompatibilityMigrationTelemetryCohort =
  typeof AGENT_OS_COMPATIBILITY_TELEMETRY_COHORTS[number]

const CANONICAL_LINK_COHORTS = Object.freeze([
  'canonical_linked',
  'canonical_unlinked',
  'migration_quarantined',
] as const)

export const AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS = Object.freeze({
  boards: Object.freeze(['shared_scope'] as const),
  task_contracts: CANONICAL_LINK_COHORTS,
  agent_usage: CANONICAL_LINK_COHORTS,
  agents: CANONICAL_LINK_COHORTS,
  cards: CANONICAL_LINK_COHORTS,
  card_events: CANONICAL_LINK_COHORTS,
  messages: Object.freeze(['legacy_only'] as const),
  message_targets: Object.freeze(['legacy_only'] as const),
  deliveries: Object.freeze(['legacy_only'] as const),
  milestones: Object.freeze(['deferred_replacement'] as const),
  ideas: Object.freeze(['deferred_replacement'] as const),
  review_decisions: CANONICAL_LINK_COHORTS,
  token_telemetry: Object.freeze(['legacy_only'] as const),
  agent_transcripts: Object.freeze(['legacy_only'] as const),
  teams: Object.freeze(['legacy_only'] as const),
} satisfies Readonly<
  Record<
    AgentOsLegacyCompatibilityTable,
    readonly CompatibilityMigrationTelemetryCohort[]
  >
>)

const LEGACY_TARGET_OPERATIONS = Object.freeze([
  'legacy_read',
  'legacy_write',
  'adapter_translation',
  'failure',
] as const)

export const AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_OPERATIONS = Object.freeze({
  boards: AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS,
  task_contracts: AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS,
  agent_usage: AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS,
  agents: AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS,
  cards: AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS,
  card_events: AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS,
  messages: LEGACY_TARGET_OPERATIONS,
  message_targets: LEGACY_TARGET_OPERATIONS,
  deliveries: LEGACY_TARGET_OPERATIONS,
  milestones: LEGACY_TARGET_OPERATIONS,
  ideas: LEGACY_TARGET_OPERATIONS,
  review_decisions: AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS,
  token_telemetry: LEGACY_TARGET_OPERATIONS,
  agent_transcripts: LEGACY_TARGET_OPERATIONS,
  teams: LEGACY_TARGET_OPERATIONS,
} satisfies Readonly<
  Record<
    AgentOsLegacyCompatibilityTable,
    readonly CompatibilityMigrationTelemetryOperation[]
  >
>)

export const AGENT_OS_COMPATIBILITY_TELEMETRY_MISMATCH_DIAGNOSTICS =
  Object.freeze([
    'missing_legacy_row',
    'missing_canonical_row',
    'value_mismatch',
    'scope_mismatch',
    'lifecycle_mismatch',
    'projection_stale',
  ] as const)

export type CompatibilityMigrationMismatchDiagnostic =
  typeof AGENT_OS_COMPATIBILITY_TELEMETRY_MISMATCH_DIAGNOSTICS[number]

export const AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS =
  Object.freeze([
    'translation_rejected',
    'projection_refresh_rejected',
    'schema_incompatible',
    'database_locked',
    'unexpected_failure',
  ] as const)

export type CompatibilityMigrationFailureDiagnostic =
  typeof AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS[number]

export const AGENT_OS_COMPATIBILITY_TELEMETRY_DIAGNOSTICS = Object.freeze([
  'none',
  ...AGENT_OS_COMPATIBILITY_TELEMETRY_MISMATCH_DIAGNOSTICS,
  ...AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS,
] as const)

export type CompatibilityMigrationTelemetryDiagnostic =
  typeof AGENT_OS_COMPATIBILITY_TELEMETRY_DIAGNOSTICS[number]

const NORMAL_OPERATIONS = Object.freeze(
  AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS.slice(0, 6),
) as readonly Exclude<
  CompatibilityMigrationTelemetryOperation,
  'mismatch' | 'failure'
>[]

const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER
const UTC_DAY_MILLISECONDS = 86_400_000

export const AGENT_OS_COMPATIBILITY_TELEMETRY_RETENTION_RULE = Object.freeze({
  schema_version: 1 as const,
  minimum_daily_retention_days: 90 as const,
  maximum_daily_retention_days: 3_650 as const,
  rollup_boundary: 'strictly_before_retained_utc_day' as const,
  historical_dimensions: Object.freeze([
    'table',
    'operation',
    'cohort',
    'diagnostic_code',
  ] as const),
  preserves_mismatch_and_failure_counts: true as const,
})

export const AGENT_OS_COMPATIBILITY_WRITER_OBSERVATION_RULE = Object.freeze({
  schema_version: 1 as const,
  minimum_complete_utc_days: 30 as const,
  requires_explicit_completed_day_coverage: true as const,
  zero_required_operations: Object.freeze([
    'legacy_write',
    'mismatch',
    'failure',
  ] as const),
  writer_removal_authorized: false as const,
  operator_gate: 'ORC-020' as const,
})

export interface CompatibilityMigrationTelemetryObservation {
  readonly observed_at: Date
  readonly table: AgentOsLegacyCompatibilityTable
  readonly operation: CompatibilityMigrationTelemetryOperation
  readonly cohort: CompatibilityMigrationTelemetryCohort
  readonly diagnostic_code: CompatibilityMigrationTelemetryDiagnostic
  readonly count?: number
}

export interface CompatibilityMigrationTelemetryDailyRow {
  readonly day: string
  readonly table: AgentOsLegacyCompatibilityTable
  readonly operation: CompatibilityMigrationTelemetryOperation
  readonly cohort: CompatibilityMigrationTelemetryCohort
  readonly diagnostic_code: CompatibilityMigrationTelemetryDiagnostic
  readonly count: number
}

export interface CompatibilityMigrationTelemetrySummaryRow {
  readonly table: AgentOsLegacyCompatibilityTable
  readonly operation: CompatibilityMigrationTelemetryOperation
  readonly cohort: CompatibilityMigrationTelemetryCohort
  readonly diagnostic_code: CompatibilityMigrationTelemetryDiagnostic
  readonly count: number
}

export interface CompatibilityMigrationTelemetryTotals {
  readonly total_count: number
  readonly operation_totals: Readonly<
    Record<CompatibilityMigrationTelemetryOperation, number>
  >
  readonly mismatch_count: number
  readonly failure_count: number
}

export interface CompatibilityMigrationTelemetryDailyQuery {
  readonly from_day: string
  readonly through_day: string
  readonly table?: AgentOsLegacyCompatibilityTable
}

export interface CompatibilityMigrationTelemetryDailyResult
  extends CompatibilityMigrationTelemetryTotals {
  readonly from_day: string
  readonly through_day: string
  readonly table: AgentOsLegacyCompatibilityTable | null
  readonly rows: readonly CompatibilityMigrationTelemetryDailyRow[]
}

export interface CompatibilityMigrationTelemetrySummaryResult
  extends CompatibilityMigrationTelemetryTotals {
  readonly historical_first_day: string | null
  readonly historical_through_day: string | null
  readonly retained_daily_first_day: string | null
  readonly retained_daily_through_day: string | null
  readonly rows: readonly CompatibilityMigrationTelemetrySummaryRow[]
}

export interface CompatibilityMigrationTelemetryRollupInput {
  readonly now: Date
  readonly retain_days?: number
}

export interface CompatibilityMigrationTelemetryRollupResult {
  readonly retain_from_day: string
  readonly compacted_through_day: string | null
  readonly rows_compacted: number
  readonly count_compacted: number
  readonly mismatch_count_compacted: number
  readonly failure_count_compacted: number
}

export interface CompatibilityMigrationTelemetryCollectorEpochRefreshInput {
  readonly now: Date
}

export interface CompatibilityMigrationTelemetryCollectorEpoch {
  readonly installed_day: string
  readonly collector_schema_version: number
  readonly valid_from_day: string
  readonly refreshed: boolean
}

export interface CompatibilityMigrationWriterObservationQuery {
  readonly table: AgentOsLegacyCompatibilityTable
  readonly from_day: string
  readonly through_day: string
}

export const AGENT_OS_COMPATIBILITY_WRITER_OBSERVATION_STATUSES =
  Object.freeze([
    'insufficient_observation',
    'legacy_writer_observed',
    'diagnostic_risk_observed',
    'eligible_for_operator_review',
  ] as const)

export type CompatibilityMigrationWriterObservationStatus =
  typeof AGENT_OS_COMPATIBILITY_WRITER_OBSERVATION_STATUSES[number]

export const AGENT_OS_COMPATIBILITY_WRITER_OBSERVATION_REASONS =
  Object.freeze([
    'window_too_short',
    'coverage_gap',
    'legacy_write_nonzero',
    'diagnostic_nonzero',
    'operator_review_required',
  ] as const)

export type CompatibilityMigrationWriterObservationReason =
  typeof AGENT_OS_COMPATIBILITY_WRITER_OBSERVATION_REASONS[number]

export interface CompatibilityMigrationWriterObservationResult {
  readonly table: AgentOsLegacyCompatibilityTable
  readonly from_day: string
  readonly through_day: string
  readonly calendar_days: number
  readonly covered_days: number
  readonly required_days:
    typeof AGENT_OS_COMPATIBILITY_WRITER_OBSERVATION_RULE.minimum_complete_utc_days
  readonly legacy_write_count: number
  readonly mismatch_count: number
  readonly failure_count: number
  readonly status: CompatibilityMigrationWriterObservationStatus
  readonly reason: CompatibilityMigrationWriterObservationReason
  readonly writer_removal_authorized: false
  readonly operator_gate: 'ORC-020'
}

type SchemaObject = Readonly<{
  type: 'table' | 'index' | 'trigger'
  name: string
  sql: string
}>

type LegacyMutation = 'insert' | 'update' | 'delete'

const TELEMETRY_DAILY_TABLE = 'os_compatibility_migration_telemetry_daily'
const TELEMETRY_HISTORY_TABLE =
  'os_compatibility_migration_telemetry_history'
const TELEMETRY_COVERAGE_TABLE =
  'os_compatibility_migration_telemetry_coverage'
export const AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE =
  'os_compatibility_migration_telemetry_state'
const TELEMETRY_GUARD_FUNCTION =
  'orchestra_compatibility_migration_telemetry_guard'
const TELEMETRY_SEAL_GUARD_FUNCTION =
  'orchestra_compatibility_migration_telemetry_seal_guard'
const TELEMETRY_ROLLUP_DELETE_GUARD_FUNCTION =
  'orchestra_compatibility_migration_telemetry_rollup_delete_guard'

type TelemetryMutationGuard =
  | 'idle'
  | 'epoch'
  | 'seal'
  | 'rollup-history'
  | 'rollup-delete'

type TelemetryGuardState = {
  mode: TelemetryMutationGuard
  sealDay: string | null
  sealTable: AgentOsLegacyCompatibilityTable | null
  rollupRetainFromDay: string | null
}

const TELEMETRY_GUARD_STATES =
  new WeakMap<Database.Database, TelemetryGuardState>()

function sqlEnum(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',')
}

function sqlTableValueContract(
  column: string,
  contract: Readonly<
    Record<AgentOsLegacyCompatibilityTable, readonly string[]>
  >,
): string {
  return AGENT_OS_LEGACY_COMPATIBILITY_TABLES
    .map((table) => (
      `(table_name='${table}' AND ${column} IN (${sqlEnum(contract[table])}))`
    ))
    .join('\n          OR ')
}

const TABLE_ENUM_SQL = sqlEnum(AGENT_OS_LEGACY_COMPATIBILITY_TABLES)
const OPERATION_ENUM_SQL = sqlEnum(
  AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS,
)
const COHORT_ENUM_SQL = sqlEnum(AGENT_OS_COMPATIBILITY_TELEMETRY_COHORTS)
const DIAGNOSTIC_ENUM_SQL = sqlEnum(
  AGENT_OS_COMPATIBILITY_TELEMETRY_DIAGNOSTICS,
)
const NORMAL_OPERATION_ENUM_SQL = sqlEnum(NORMAL_OPERATIONS)
const MISMATCH_DIAGNOSTIC_ENUM_SQL = sqlEnum(
  AGENT_OS_COMPATIBILITY_TELEMETRY_MISMATCH_DIAGNOSTICS,
)
const FAILURE_DIAGNOSTIC_ENUM_SQL = sqlEnum(
  AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS,
)
const BLOCKING_OPERATION_ENUM_SQL = sqlEnum([
  'legacy_write',
  'mismatch',
  'failure',
])
const TABLE_COHORT_CHECK_SQL = sqlTableValueContract(
  'cohort',
  AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS,
)
const TABLE_OPERATION_CHECK_SQL = sqlTableValueContract(
  'operation',
  AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_OPERATIONS,
)

const UTC_DAY_CHECK_SQL = (column: string): string => `
      length(${column})=10
      AND ${column} GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(${column}, '+0 days')=${column}
  `

const LINK_AWARE_KEY_SQL: Readonly<
  Partial<Record<
    AgentOsLegacyCompatibilityTable,
    Readonly<Record<'NEW' | 'OLD', string>>
  >>
> = Object.freeze({
  task_contracts: Object.freeze({
    NEW: 'CAST(NEW.card_id AS TEXT)',
    OLD: 'CAST(OLD.card_id AS TEXT)',
  }),
  agent_usage: Object.freeze({
    NEW: "printf('%d:%d:%s', NEW.board_id, NEW.agent_id, NEW.day)",
    OLD: "printf('%d:%d:%s', OLD.board_id, OLD.agent_id, OLD.day)",
  }),
  agents: Object.freeze({
    NEW: 'CAST(NEW.id AS TEXT)',
    OLD: 'CAST(OLD.id AS TEXT)',
  }),
  cards: Object.freeze({
    NEW: 'CAST(NEW.id AS TEXT)',
    OLD: 'CAST(OLD.id AS TEXT)',
  }),
  card_events: Object.freeze({
    NEW: 'CAST(NEW.id AS TEXT)',
    OLD: 'CAST(OLD.id AS TEXT)',
  }),
  review_decisions: Object.freeze({
    NEW: 'CAST(NEW.id AS TEXT)',
    OLD: 'CAST(OLD.id AS TEXT)',
  }),
})

function triggerCohortSql(
  table: AgentOsLegacyCompatibilityTable,
  rowReference: 'NEW' | 'OLD',
): string {
  const allowedCohorts =
    AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS[table]
  if (allowedCohorts.length === 1) return `'${allowedCohorts[0]}'`

  const key = LINK_AWARE_KEY_SQL[table]?.[rowReference]
  if (!key) {
    throw new Error(`telemetry trigger cohort is undefined for ${table}`)
  }
  return `CASE
        WHEN EXISTS (
          SELECT 1 FROM os_compatibility_projection_quarantine
          WHERE migration_id='${AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID}'
            AND source_table='${table}'
            AND source_key=${key}
        ) THEN 'migration_quarantined'
        WHEN EXISTS (
          SELECT 1 FROM os_compatibility_projection_links
          WHERE migration_id='${AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID}'
            AND source_table='${table}'
            AND source_key=${key}
        ) THEN 'canonical_linked'
        ELSE 'canonical_unlinked'
      END`
}

function telemetryTrigger(
  table: AgentOsLegacyCompatibilityTable,
  mutation: LegacyMutation,
): SchemaObject {
  const suffix = mutation === 'insert'
    ? 'ai'
    : mutation === 'update'
      ? 'au'
      : 'ad'
  const rowReference = mutation === 'delete' ? 'OLD' : 'NEW'
  const name = `trg_os_compatibility_telemetry_${table}_${suffix}`
  const cohort = triggerCohortSql(table, rowReference)
  return Object.freeze({
    type: 'trigger' as const,
    name,
    sql: `CREATE TRIGGER ${name}
      BEFORE ${mutation.toUpperCase()} ON ${table}
      BEGIN
        INSERT INTO ${TELEMETRY_DAILY_TABLE} (
          day, table_name, operation, cohort, diagnostic_code, count
        ) VALUES (
          date('now'), '${table}', 'legacy_write',
          ${cohort}, 'none',
          COALESCE((
            SELECT count FROM ${TELEMETRY_DAILY_TABLE}
            WHERE day=date('now')
              AND table_name='${table}'
              AND operation='legacy_write'
              AND cohort=${cohort}
              AND diagnostic_code='none'
          ), 0)+1
        )
        ON CONFLICT(
          day, table_name, operation, cohort, diagnostic_code
        ) DO UPDATE SET count=excluded.count;
        SELECT CASE WHEN changes()<>1
          THEN RAISE(ABORT, 'compatibility telemetry collector write failed')
        END;
      END`,
  })
}

const BASE_SCHEMA = Object.freeze([
  Object.freeze({
    type: 'table' as const,
    name: TELEMETRY_DAILY_TABLE,
    sql: `CREATE TABLE ${TELEMETRY_DAILY_TABLE} (
      day TEXT NOT NULL CHECK(${UTC_DAY_CHECK_SQL('day')}),
      table_name TEXT NOT NULL CHECK(table_name IN (${TABLE_ENUM_SQL})),
      operation TEXT NOT NULL CHECK(operation IN (${OPERATION_ENUM_SQL})),
      cohort TEXT NOT NULL CHECK(cohort IN (${COHORT_ENUM_SQL})),
      diagnostic_code TEXT NOT NULL
        CHECK(diagnostic_code IN (${DIAGNOSTIC_ENUM_SQL})),
      count INTEGER NOT NULL
        CHECK(typeof(count)='integer' AND count BETWEEN 1 AND ${MAX_SAFE_COUNT}),
      PRIMARY KEY(day, table_name, operation, cohort, diagnostic_code),
      CHECK(
        ${TABLE_COHORT_CHECK_SQL}
      ),
      CHECK(
        ${TABLE_OPERATION_CHECK_SQL}
      ),
      CHECK(
        (
          operation IN (${NORMAL_OPERATION_ENUM_SQL})
          AND diagnostic_code='none'
        )
        OR (
          operation='mismatch'
          AND diagnostic_code IN (${MISMATCH_DIAGNOSTIC_ENUM_SQL})
        )
        OR (
          operation='failure'
          AND diagnostic_code IN (${FAILURE_DIAGNOSTIC_ENUM_SQL})
        )
      )
    ) STRICT, WITHOUT ROWID`,
  }),
  Object.freeze({
    type: 'table' as const,
    name: TELEMETRY_HISTORY_TABLE,
    sql: `CREATE TABLE ${TELEMETRY_HISTORY_TABLE} (
      table_name TEXT NOT NULL CHECK(table_name IN (${TABLE_ENUM_SQL})),
      operation TEXT NOT NULL CHECK(operation IN (${OPERATION_ENUM_SQL})),
      cohort TEXT NOT NULL CHECK(cohort IN (${COHORT_ENUM_SQL})),
      diagnostic_code TEXT NOT NULL
        CHECK(diagnostic_code IN (${DIAGNOSTIC_ENUM_SQL})),
      first_day TEXT NOT NULL CHECK(${UTC_DAY_CHECK_SQL('first_day')}),
      last_day TEXT NOT NULL CHECK(${UTC_DAY_CHECK_SQL('last_day')}),
      count INTEGER NOT NULL
        CHECK(typeof(count)='integer' AND count BETWEEN 1 AND ${MAX_SAFE_COUNT}),
      PRIMARY KEY(table_name, operation, cohort, diagnostic_code),
      CHECK(first_day<=last_day),
      CHECK(
        ${TABLE_COHORT_CHECK_SQL}
      ),
      CHECK(
        ${TABLE_OPERATION_CHECK_SQL}
      ),
      CHECK(
        (
          operation IN (${NORMAL_OPERATION_ENUM_SQL})
          AND diagnostic_code='none'
        )
        OR (
          operation='mismatch'
          AND diagnostic_code IN (${MISMATCH_DIAGNOSTIC_ENUM_SQL})
        )
        OR (
          operation='failure'
          AND diagnostic_code IN (${FAILURE_DIAGNOSTIC_ENUM_SQL})
        )
      )
    ) STRICT, WITHOUT ROWID`,
  }),
  Object.freeze({
    type: 'table' as const,
    name: TELEMETRY_COVERAGE_TABLE,
    sql: `CREATE TABLE ${TELEMETRY_COVERAGE_TABLE} (
      day TEXT NOT NULL CHECK(${UTC_DAY_CHECK_SQL('day')}),
      table_name TEXT NOT NULL CHECK(table_name IN (${TABLE_ENUM_SQL})),
      legacy_write_count INTEGER NOT NULL
        CHECK(
          typeof(legacy_write_count)='integer'
          AND legacy_write_count BETWEEN 0 AND ${MAX_SAFE_COUNT}
        ),
      mismatch_count INTEGER NOT NULL
        CHECK(
          typeof(mismatch_count)='integer'
          AND mismatch_count BETWEEN 0 AND ${MAX_SAFE_COUNT}
        ),
      failure_count INTEGER NOT NULL
        CHECK(
          typeof(failure_count)='integer'
          AND failure_count BETWEEN 0 AND ${MAX_SAFE_COUNT}
        ),
      PRIMARY KEY(day, table_name)
    ) STRICT, WITHOUT ROWID`,
  }),
  Object.freeze({
    type: 'table' as const,
    name: AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE,
    sql: `CREATE TABLE ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE} (
      singleton INTEGER PRIMARY KEY
        CHECK(typeof(singleton)='integer' AND singleton=1),
      installed_day TEXT NOT NULL CHECK(${UTC_DAY_CHECK_SQL('installed_day')}),
      collector_schema_version INTEGER NOT NULL
        CHECK(
          typeof(collector_schema_version)='integer'
          AND collector_schema_version>=0
        ),
      valid_from_day TEXT NOT NULL CHECK(${UTC_DAY_CHECK_SQL('valid_from_day')}),
      CHECK(installed_day<=valid_from_day)
    ) STRICT, WITHOUT ROWID`,
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'idx_os_compatibility_telemetry_daily_table_day',
    sql: `CREATE INDEX idx_os_compatibility_telemetry_daily_table_day
      ON ${TELEMETRY_DAILY_TABLE}(table_name, day)`,
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'idx_os_compatibility_telemetry_history_operation',
    sql: `CREATE INDEX idx_os_compatibility_telemetry_history_operation
      ON ${TELEMETRY_HISTORY_TABLE}(operation, table_name)`,
  }),
  Object.freeze({
    type: 'index' as const,
    name: 'idx_os_compatibility_telemetry_coverage_table_day',
    sql: `CREATE INDEX idx_os_compatibility_telemetry_coverage_table_day
      ON ${TELEMETRY_COVERAGE_TABLE}(table_name, day)`,
  }),
] satisfies readonly SchemaObject[])

const MUTATIONS = Object.freeze([
  'insert',
  'update',
  'delete',
] as const satisfies readonly LegacyMutation[])

const TELEMETRY_TRIGGERS = Object.freeze(
  AGENT_OS_LEGACY_COMPATIBILITY_TABLES.flatMap((table) => (
    MUTATIONS.map((mutation) => telemetryTrigger(table, mutation))
  )),
)

const TELEMETRY_INTEGRITY_TRIGGERS = Object.freeze([
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_daily_sealed_insert',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_daily_sealed_insert
      BEFORE INSERT ON ${TELEMETRY_DAILY_TABLE}
      WHEN EXISTS (
        SELECT 1 FROM ${TELEMETRY_COVERAGE_TABLE}
        WHERE day=NEW.day AND table_name=NEW.table_name
      )
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry day is sealed');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_daily_sealed_update',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_daily_sealed_update
      BEFORE UPDATE ON ${TELEMETRY_DAILY_TABLE}
      WHEN EXISTS (
        SELECT 1 FROM ${TELEMETRY_COVERAGE_TABLE}
        WHERE day=OLD.day AND table_name=OLD.table_name
      ) OR EXISTS (
        SELECT 1 FROM ${TELEMETRY_COVERAGE_TABLE}
        WHERE day=NEW.day AND table_name=NEW.table_name
      )
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry day is sealed');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_daily_guard_delete',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_daily_guard_delete
      BEFORE DELETE ON ${TELEMETRY_DAILY_TABLE}
      WHEN ${TELEMETRY_ROLLUP_DELETE_GUARD_FUNCTION}(
          OLD.day,
          OLD.table_name
        )<>1
        OR NOT EXISTS (
          SELECT 1 FROM ${TELEMETRY_COVERAGE_TABLE}
          WHERE day=OLD.day AND table_name=OLD.table_name
        )
        OR (
          SELECT COUNT(*) FROM ${TELEMETRY_COVERAGE_TABLE}
          WHERE day=OLD.day
        )<>${AGENT_OS_LEGACY_COMPATIBILITY_TABLES.length}
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry daily deletion is rollup-managed');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_daily_blocking_insert',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_daily_blocking_insert
      BEFORE INSERT ON ${TELEMETRY_DAILY_TABLE}
      WHEN NEW.operation IN (${BLOCKING_OPERATION_ENUM_SQL})
        AND EXISTS (
          SELECT 1 FROM ${TELEMETRY_DAILY_TABLE}
          WHERE day=NEW.day
            AND table_name=NEW.table_name
            AND operation=NEW.operation
            AND cohort=NEW.cohort
            AND diagnostic_code=NEW.diagnostic_code
            AND count>NEW.count
        )
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry blocking evidence cannot decrease');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_daily_blocking_update',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_daily_blocking_update
      BEFORE UPDATE ON ${TELEMETRY_DAILY_TABLE}
      WHEN (
          OLD.operation IN (${BLOCKING_OPERATION_ENUM_SQL})
          OR NEW.operation IN (${BLOCKING_OPERATION_ENUM_SQL})
        )
        AND (
          NEW.day<>OLD.day
          OR NEW.table_name<>OLD.table_name
          OR NEW.operation<>OLD.operation
          OR NEW.cohort<>OLD.cohort
          OR NEW.diagnostic_code<>OLD.diagnostic_code
          OR NEW.count<OLD.count
        )
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry blocking evidence is monotonic');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_coverage_immutable_insert',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_coverage_immutable_insert
      BEFORE INSERT ON ${TELEMETRY_COVERAGE_TABLE}
      WHEN ${TELEMETRY_SEAL_GUARD_FUNCTION}(
          NEW.day,
          NEW.table_name
        )<>1
        OR EXISTS (
          SELECT 1 FROM ${TELEMETRY_COVERAGE_TABLE}
          WHERE day=NEW.day AND table_name=NEW.table_name
        )
        OR NEW.legacy_write_count<>COALESCE((
          SELECT SUM(count) FROM ${TELEMETRY_DAILY_TABLE}
          WHERE day=NEW.day
            AND table_name=NEW.table_name
            AND operation='legacy_write'
        ), 0)
        OR NEW.mismatch_count<>COALESCE((
          SELECT SUM(count) FROM ${TELEMETRY_DAILY_TABLE}
          WHERE day=NEW.day
            AND table_name=NEW.table_name
            AND operation='mismatch'
        ), 0)
        OR NEW.failure_count<>COALESCE((
          SELECT SUM(count) FROM ${TELEMETRY_DAILY_TABLE}
          WHERE day=NEW.day
            AND table_name=NEW.table_name
            AND operation='failure'
        ), 0)
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry coverage is immutable; inserts are seal-managed');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_coverage_immutable_update',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_coverage_immutable_update
      BEFORE UPDATE ON ${TELEMETRY_COVERAGE_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry coverage is immutable');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_coverage_immutable_delete',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_coverage_immutable_delete
      BEFORE DELETE ON ${TELEMETRY_COVERAGE_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry coverage is immutable');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_history_guard_insert',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_history_guard_insert
      BEFORE INSERT ON ${TELEMETRY_HISTORY_TABLE}
      WHEN ${TELEMETRY_GUARD_FUNCTION}()<>'rollup-history'
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry history mutation is guarded');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_history_guard_update',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_history_guard_update
      BEFORE UPDATE ON ${TELEMETRY_HISTORY_TABLE}
      WHEN ${TELEMETRY_GUARD_FUNCTION}()<>'rollup-history'
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry history mutation is guarded');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_history_guard_delete',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_history_guard_delete
      BEFORE DELETE ON ${TELEMETRY_HISTORY_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry history mutation is guarded');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_state_guard_insert',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_state_guard_insert
      BEFORE INSERT ON ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
      WHEN ${TELEMETRY_GUARD_FUNCTION}()<>'epoch'
        OR EXISTS (
          SELECT 1
          FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
          WHERE singleton=NEW.singleton
        )
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry state mutation is guarded');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_state_guard_update',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_state_guard_update
      BEFORE UPDATE ON ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
      WHEN ${TELEMETRY_GUARD_FUNCTION}()<>'epoch'
        OR NEW.singleton<>OLD.singleton
        OR NEW.installed_day<>OLD.installed_day
        OR NEW.valid_from_day<OLD.valid_from_day
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry state mutation is guarded');
      END`,
  }),
  Object.freeze({
    type: 'trigger' as const,
    name: 'trg_os_compatibility_telemetry_state_guard_delete',
    sql: `CREATE TRIGGER trg_os_compatibility_telemetry_state_guard_delete
      BEFORE DELETE ON ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'compatibility telemetry state mutation is guarded');
      END`,
  }),
] satisfies readonly SchemaObject[])

const COMPATIBILITY_TELEMETRY_SCHEMA = Object.freeze([
  ...BASE_SCHEMA,
  ...TELEMETRY_TRIGGERS,
  ...TELEMETRY_INTEGRITY_TRIGGERS,
] satisfies readonly SchemaObject[])

const TELEMETRY_OWNED_TABLES = Object.freeze([
  TELEMETRY_DAILY_TABLE,
  TELEMETRY_HISTORY_TABLE,
  TELEMETRY_COVERAGE_TABLE,
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE,
])

const TELEMETRY_PROTECTED_TABLES = Object.freeze([
  ...AGENT_OS_LEGACY_COMPATIBILITY_TABLES,
  ...TELEMETRY_OWNED_TABLES,
  'os_compatibility_projection_links',
  'os_compatibility_projection_quarantine',
  'os_schema_migrations',
])

export const AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES =
  Object.freeze(
    COMPATIBILITY_TELEMETRY_SCHEMA.map(({ name }) => name),
  )

export const AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES =
  Object.freeze(
    TELEMETRY_TRIGGERS.map(({ name }) => name),
  )

export const
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_INTEGRITY_TRIGGER_NAMES =
    Object.freeze(
      TELEMETRY_INTEGRITY_TRIGGERS.map(({ name }) => name),
    )

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
  `).get(table)
}

function assertTelemetryPrerequisites(db: Database.Database): void {
  const predecessor = db.prepare(`
    SELECT 1 FROM os_schema_migrations WHERE id=?
  `).get(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)
  if (!predecessor) {
    throw new Error(
      `migration ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID}`
      + ` requires ${AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID}`,
    )
  }

  const requiredTables = [
    ...AGENT_OS_LEGACY_COMPATIBILITY_TABLES,
    'os_compatibility_projection_links',
    'os_compatibility_projection_quarantine',
  ]
  const missing = requiredTables.filter((table) => !tableExists(db, table))
  if (missing.length) {
    throw new Error(
      `migration ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID}`
      + ` requires predecessor tables: ${missing.join(',')}`,
    )
  }
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
}

function assertNoProtectedTempSchemaObjects(db: Database.Database): void {
  const protectedTablePlaceholders =
    TELEMETRY_PROTECTED_TABLES.map(() => '?').join(',')
  const protectedTempObjects = db.prepare(`
    SELECT type, name, tbl_name FROM sqlite_temp_master
    WHERE sql IS NOT NULL
      AND (
        (
          type='trigger'
          AND lower(tbl_name) IN (${protectedTablePlaceholders})
        )
        OR lower(name) IN (${protectedTablePlaceholders})
        OR lower(name) LIKE 'os_compatibility_migration_telemetry_%'
        OR lower(name) LIKE 'idx_os_compatibility_telemetry_%'
        OR lower(name) LIKE 'trg_os_compatibility_telemetry_%'
      )
    ORDER BY type, name
  `).all(
    ...TELEMETRY_PROTECTED_TABLES,
    ...TELEMETRY_PROTECTED_TABLES,
  )
  if (protectedTempObjects.length !== 0) {
    throw new Error(
      'compatibility telemetry found a protected TEMP schema object',
    )
  }
}

export function assertCompatibilityMigrationTelemetrySchemaCompatible(
  db: Database.Database,
): void {
  assertNoProtectedTempSchemaObjects(db)
  const ownedTablePlaceholders =
    TELEMETRY_OWNED_TABLES.map(() => '?').join(',')
  const actualOwnedObjects = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE sql IS NOT NULL
      AND (
        (
          type IN ('index', 'trigger')
          AND tbl_name IN (${ownedTablePlaceholders})
        )
        OR name LIKE 'os_compatibility_migration_telemetry_%'
        OR name LIKE 'idx_os_compatibility_telemetry_%'
        OR name LIKE 'trg_os_compatibility_telemetry_%'
      )
    ORDER BY type, name
  `).all(...TELEMETRY_OWNED_TABLES) as Array<{
    type: string
    name: string
    sql: string
  }>
  const actualByName = new Map(
    actualOwnedObjects.map((actual) => [actual.name, actual]),
  )
  for (const expected of COMPATIBILITY_TELEMETRY_SCHEMA) {
    const actual = actualByName.get(expected.name)
    if (
      !actual
      || actual.type !== expected.type
      || normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(expected.sql)
    ) {
      throw new Error(
        `migration ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID}`
        + ` found incompatible ${expected.name} schema`,
      )
    }
  }
  if (actualOwnedObjects.length !== COMPATIBILITY_TELEMETRY_SCHEMA.length) {
    throw new Error(
      `migration ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID}`
      + ' found unexpected telemetry integrity triggers or owned schema objects',
    )
  }
  assertNoProtectedTempSchemaObjects(db)
}

/**
 * Create the migration-telemetry schema inside the caller's migration transaction.
 *
 * This function deliberately starts no transaction. `applyAgentOsMigrations` owns the outer
 * all-migrations transaction and records the 023 marker only after this function returns.
 */
export function applyCompatibilityMigrationTelemetryMigration(
  db: Database.Database,
): void {
  assertTelemetryPrerequisites(db)
  const hasAnyTelemetryObject = COMPATIBILITY_TELEMETRY_SCHEMA.some(
    ({ name }) => !!db.prepare(`
      SELECT 1 FROM sqlite_master WHERE name=?
    `).get(name),
  )
  if (hasAnyTelemetryObject) {
    assertCompatibilityMigrationTelemetrySchemaCompatible(db)
    return
  }

  db.exec(
    COMPATIBILITY_TELEMETRY_SCHEMA
      .map(({ sql }) => `${sql};`)
      .join('\n'),
  )
  assertCompatibilityMigrationTelemetrySchemaCompatible(db)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError('compatibility telemetry input must be a plain object')
  }
  const keys = Object.keys(value).sort()
  const allowed = new Set([...required, ...optional])
  const missing = required.filter((key) => !Object.hasOwn(value, key))
  const extra = keys.filter((key) => !allowed.has(key))
  if (missing.length || extra.length) {
    throw new TypeError(
      `compatibility telemetry input keys are invalid`
      + ` (missing_count=${missing.length}`
      + ` unexpected_count=${extra.length})`,
    )
  }
}

function assertEnum<Value extends string>(
  name: string,
  value: unknown,
  allowed: readonly Value[],
): asserts value is Value {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    throw new TypeError(`${name} is not a supported compatibility telemetry value`)
  }
}

function assertValidDate(name: string, value: unknown): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`)
  }
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function isUtcDay(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && utcDay(date) === value
}

function assertUtcDay(name: string, value: unknown): asserts value is string {
  if (!isUtcDay(value)) {
    throw new TypeError(`${name} must be an exact UTC YYYY-MM-DD day`)
  }
}

function assertSafeCount(name: string, value: unknown, minimum = 0): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < minimum
  ) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`)
  }
  return value
}

function assertDiagnosticCompatibility(
  operation: CompatibilityMigrationTelemetryOperation,
  diagnostic: CompatibilityMigrationTelemetryDiagnostic,
): void {
  if (NORMAL_OPERATIONS.includes(
    operation as typeof NORMAL_OPERATIONS[number],
  )) {
    if (diagnostic !== 'none') {
      throw new TypeError(
        'normal compatibility telemetry operations require diagnostic_code=none',
      )
    }
    return
  }
  if (
    operation === 'mismatch'
    && !AGENT_OS_COMPATIBILITY_TELEMETRY_MISMATCH_DIAGNOSTICS.includes(
      diagnostic as CompatibilityMigrationMismatchDiagnostic,
    )
  ) {
    throw new TypeError(
      'mismatch compatibility telemetry requires a bounded mismatch diagnostic',
    )
  }
  if (
    operation === 'failure'
    && !AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS.includes(
      diagnostic as CompatibilityMigrationFailureDiagnostic,
    )
  ) {
    throw new TypeError(
      'failure compatibility telemetry requires a bounded failure diagnostic',
    )
  }
}

function assertTableTelemetryContract(
  table: AgentOsLegacyCompatibilityTable,
  operation: CompatibilityMigrationTelemetryOperation,
  cohort: CompatibilityMigrationTelemetryCohort,
): void {
  const cohorts = (
    AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS[table]
  ) as readonly CompatibilityMigrationTelemetryCohort[]
  if (!cohorts.includes(cohort)) {
    throw new TypeError(
      `cohort is not supported for compatibility telemetry table ${table}`,
    )
  }
  const operations = (
    AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_OPERATIONS[table]
  ) as readonly CompatibilityMigrationTelemetryOperation[]
  if (!operations.includes(operation)) {
    throw new TypeError(
      `operation is not supported for compatibility telemetry table ${table}`,
    )
  }
}

export function recordCompatibilityMigrationTelemetry(
  db: Database.Database,
  input: CompatibilityMigrationTelemetryObservation,
): CompatibilityMigrationTelemetryDailyRow {
  assertExactKeys(
    input,
    ['observed_at', 'table', 'operation', 'cohort', 'diagnostic_code'],
    ['count'],
  )
  assertValidDate('observed_at', input.observed_at)
  assertEnum('table', input.table, AGENT_OS_LEGACY_COMPATIBILITY_TABLES)
  assertEnum(
    'operation',
    input.operation,
    AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS,
  )
  assertEnum('cohort', input.cohort, AGENT_OS_COMPATIBILITY_TELEMETRY_COHORTS)
  assertTableTelemetryContract(input.table, input.operation, input.cohort)
  assertEnum(
    'diagnostic_code',
    input.diagnostic_code,
    AGENT_OS_COMPATIBILITY_TELEMETRY_DIAGNOSTICS,
  )
  assertDiagnosticCompatibility(input.operation, input.diagnostic_code)
  const count = input.count === undefined
    ? 1
    : assertSafeCount('count', input.count, 1)
  const day = utcDay(input.observed_at)

  return runAtomically(db, () => {
    assertCompatibilityMigrationTelemetrySchemaCompatible(db)
    const write = db.prepare(`
      INSERT INTO ${TELEMETRY_DAILY_TABLE} (
        day, table_name, operation, cohort, diagnostic_code, count
      ) VALUES (
        @day,
        @table_name,
        @operation,
        @cohort,
        @diagnostic_code,
        COALESCE((
          SELECT count FROM ${TELEMETRY_DAILY_TABLE}
          WHERE day=@day
            AND table_name=@table_name
            AND operation=@operation
            AND cohort=@cohort
            AND diagnostic_code=@diagnostic_code
        ), 0)+@count
      )
      ON CONFLICT(
        day, table_name, operation, cohort, diagnostic_code
      ) DO UPDATE SET count=excluded.count
    `).run({
      day,
      table_name: input.table,
      operation: input.operation,
      cohort: input.cohort,
      diagnostic_code: input.diagnostic_code,
      count,
    })
    if (write.changes !== 1) {
      throw new Error(
        'compatibility telemetry aggregation write was suppressed',
      )
    }

    const row = db.prepare(`
      SELECT day, table_name AS "table", operation, cohort,
        diagnostic_code, count
      FROM ${TELEMETRY_DAILY_TABLE}
      WHERE day=? AND table_name=? AND operation=? AND cohort=?
        AND diagnostic_code=?
    `).get(
      day,
      input.table,
      input.operation,
      input.cohort,
      input.diagnostic_code,
    ) as CompatibilityMigrationTelemetryDailyRow | undefined
    if (!row) {
      throw new Error('compatibility telemetry aggregation did not persist')
    }
    assertCompatibilityMigrationTelemetrySchemaCompatible(db)
    return Object.freeze({
      ...row,
      count: assertSafeCount('stored telemetry count', row.count),
    })
  })
}

function assertDayRange(fromDay: string, throughDay: string): void {
  assertUtcDay('from_day', fromDay)
  assertUtcDay('through_day', throughDay)
  if (fromDay > throughDay) {
    throw new RangeError('from_day must not be after through_day')
  }
}

function emptyOperationTotals(): Record<
  CompatibilityMigrationTelemetryOperation,
  number
> {
  return {
    legacy_read: 0,
    canonical_read: 0,
    legacy_write: 0,
    canonical_write: 0,
    adapter_translation: 0,
    projection_refresh: 0,
    mismatch: 0,
    failure: 0,
  }
}

function totalsForRows(
  rows: readonly CompatibilityMigrationTelemetrySummaryRow[],
): CompatibilityMigrationTelemetryTotals {
  const operationTotals = emptyOperationTotals()
  let totalCount = 0
  for (const row of rows) {
    const count = assertSafeCount('telemetry count', row.count)
    operationTotals[row.operation] = assertSafeCount(
      `${row.operation} total`,
      operationTotals[row.operation] + count,
    )
    totalCount = assertSafeCount('telemetry total', totalCount + count)
  }
  return {
    total_count: totalCount,
    operation_totals: Object.freeze(operationTotals),
    mismatch_count: operationTotals.mismatch,
    failure_count: operationTotals.failure,
  }
}

export function queryCompatibilityMigrationTelemetryDaily(
  db: Database.Database,
  query: CompatibilityMigrationTelemetryDailyQuery,
  failureJournal?: CompatibilityMigrationFailureJournalBinding,
): CompatibilityMigrationTelemetryDailyResult {
  assertExactKeys(query, ['from_day', 'through_day'], ['table'])
  assertDayRange(query.from_day, query.through_day)
  if (query.table !== undefined) {
    assertEnum('table', query.table, AGENT_OS_LEGACY_COMPATIBILITY_TABLES)
  }
  failureJournal?.drain()
  assertCompatibilityMigrationTelemetrySchemaCompatible(db)

  const rows = (query.table === undefined
    ? db.prepare(`
        SELECT day, table_name AS "table", operation, cohort,
          diagnostic_code, count
        FROM ${TELEMETRY_DAILY_TABLE}
        WHERE day BETWEEN ? AND ?
        ORDER BY day, table_name, operation, cohort, diagnostic_code
      `).all(query.from_day, query.through_day)
    : db.prepare(`
        SELECT day, table_name AS "table", operation, cohort,
          diagnostic_code, count
        FROM ${TELEMETRY_DAILY_TABLE}
        WHERE day BETWEEN ? AND ? AND table_name=?
        ORDER BY day, table_name, operation, cohort, diagnostic_code
      `).all(query.from_day, query.through_day, query.table)
  ) as CompatibilityMigrationTelemetryDailyRow[]

  const frozenRows = Object.freeze(rows.map((row) => Object.freeze({
    ...row,
    count: assertSafeCount('stored telemetry count', row.count),
  })))
  const totals = totalsForRows(frozenRows)
  const result = Object.freeze({
    from_day: query.from_day,
    through_day: query.through_day,
    table: query.table ?? null,
    rows: frozenRows,
    ...totals,
  })
  assertCompatibilityMigrationTelemetrySchemaCompatible(db)
  return result
}

function dayBounds(
  db: Database.Database,
  table: string,
  firstColumn: string,
  lastColumn: string,
): { first_day: string | null; last_day: string | null } {
  return db.prepare(`
    SELECT MIN(${firstColumn}) AS first_day, MAX(${lastColumn}) AS last_day
    FROM ${table}
  `).get() as { first_day: string | null; last_day: string | null }
}

export function queryCompatibilityMigrationTelemetrySummary(
  db: Database.Database,
  failureJournal?: CompatibilityMigrationFailureJournalBinding,
): CompatibilityMigrationTelemetrySummaryResult {
  failureJournal?.drain()
  return runReadSnapshot(db, () => {
    assertCompatibilityMigrationTelemetrySchemaCompatible(db)
    const rows = db.prepare(`
      SELECT table_name AS "table", operation, cohort, diagnostic_code,
        SUM(count) AS count
      FROM (
        SELECT table_name, operation, cohort, diagnostic_code, count
        FROM ${TELEMETRY_HISTORY_TABLE}
        UNION ALL
        SELECT table_name, operation, cohort, diagnostic_code, count
        FROM ${TELEMETRY_DAILY_TABLE}
      )
      GROUP BY table_name, operation, cohort, diagnostic_code
      ORDER BY table_name, operation, cohort, diagnostic_code
    `).all() as CompatibilityMigrationTelemetrySummaryRow[]
    const frozenRows = Object.freeze(rows.map((row) => Object.freeze({
      ...row,
      count: assertSafeCount('summary telemetry count', row.count),
    })))
    const historical = dayBounds(
      db,
      TELEMETRY_HISTORY_TABLE,
      'first_day',
      'last_day',
    )
    const daily = dayBounds(db, TELEMETRY_DAILY_TABLE, 'day', 'day')
    const totals = totalsForRows(frozenRows)
    const result = Object.freeze({
      rows: frozenRows,
      historical_first_day: historical.first_day,
      historical_through_day: historical.last_day,
      retained_daily_first_day: daily.first_day,
      retained_daily_through_day: daily.last_day,
      ...totals,
    })
    assertCompatibilityMigrationTelemetrySchemaCompatible(db)
    return result
  })
}

function addUtcDays(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return utcDay(date)
}

function calendarDayCount(fromDay: string, throughDay: string): number {
  const from = new Date(`${fromDay}T00:00:00.000Z`).getTime()
  const through = new Date(`${throughDay}T00:00:00.000Z`).getTime()
  return ((through - from) / UTC_DAY_MILLISECONDS) + 1
}

function runAtomically<Result>(
  db: Database.Database,
  work: () => Result,
): Result {
  return db.transaction(work).immediate()
}

function runReadSnapshot<Result>(
  db: Database.Database,
  work: () => Result,
): Result {
  return db.transaction(work).deferred()
}

type StoredCompatibilityMigrationTelemetryCollectorEpoch = {
  singleton: number
  installed_day: string
  collector_schema_version: number
  valid_from_day: string
}

function ensureTelemetryGuardState(
  db: Database.Database,
): TelemetryGuardState {
  const existing = TELEMETRY_GUARD_STATES.get(db)
  if (existing) {
    db.function(TELEMETRY_GUARD_FUNCTION, () => existing.mode)
    db.function(
      TELEMETRY_SEAL_GUARD_FUNCTION,
      (day: unknown, table: unknown) => Number(
        existing.mode === 'seal'
        && existing.sealDay === day
        && existing.sealTable === table,
      ),
    )
    db.function(
      TELEMETRY_ROLLUP_DELETE_GUARD_FUNCTION,
      (day: unknown, table: unknown) => Number(
        existing.mode === 'rollup-delete'
        && typeof day === 'string'
        && existing.rollupRetainFromDay !== null
        && day < existing.rollupRetainFromDay
        && AGENT_OS_LEGACY_COMPATIBILITY_TABLES.includes(
          table as AgentOsLegacyCompatibilityTable,
        ),
      ),
    )
    return existing
  }

  const state: TelemetryGuardState = {
    mode: 'idle',
    sealDay: null,
    sealTable: null,
    rollupRetainFromDay: null,
  }
  db.function(TELEMETRY_GUARD_FUNCTION, () => state.mode)
  db.function(
    TELEMETRY_SEAL_GUARD_FUNCTION,
    (day: unknown, table: unknown) => Number(
      state.mode === 'seal'
      && state.sealDay === day
      && state.sealTable === table,
    ),
  )
  db.function(
    TELEMETRY_ROLLUP_DELETE_GUARD_FUNCTION,
    (day: unknown, table: unknown) => Number(
      state.mode === 'rollup-delete'
      && typeof day === 'string'
      && state.rollupRetainFromDay !== null
      && day < state.rollupRetainFromDay
      && AGENT_OS_LEGACY_COMPATIBILITY_TABLES.includes(
        table as AgentOsLegacyCompatibilityTable,
      ),
    ),
  )
  TELEMETRY_GUARD_STATES.set(db, state)
  return state
}

function withTelemetryMutationGuard<Result>(
  db: Database.Database,
  mode: Exclude<TelemetryMutationGuard, 'idle'>,
  work: () => Result,
): Result {
  const state = ensureTelemetryGuardState(db)
  if (state.mode !== 'idle') {
    throw new Error('compatibility telemetry mutation guard is already active')
  }
  state.mode = mode
  try {
    return work()
  } finally {
    state.sealDay = null
    state.sealTable = null
    state.rollupRetainFromDay = null
    state.mode = 'idle'
  }
}

function sqliteSchemaVersion(db: Database.Database): number {
  return assertSafeCount(
    'SQLite schema_version',
    db.pragma('schema_version', { simple: true }),
  )
}

function telemetryMigrationMarker(
  db: Database.Database,
): { applied_at: string } | undefined {
  const marker = db.prepare(`
    SELECT applied_at FROM os_schema_migrations WHERE id=?
  `).get(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID) as {
    applied_at: unknown
  } | undefined
  if (!marker) return undefined
  if (typeof marker.applied_at !== 'string') {
    throw new Error('compatibility telemetry migration marker is malformed')
  }
  return { applied_at: marker.applied_at }
}

function storedCompatibilityMigrationTelemetryCollectorEpoch(
  db: Database.Database,
): StoredCompatibilityMigrationTelemetryCollectorEpoch {
  const rows = db.prepare(`
    SELECT singleton, installed_day, collector_schema_version, valid_from_day
    FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    ORDER BY singleton
  `).all() as StoredCompatibilityMigrationTelemetryCollectorEpoch[]
  if (rows.length !== 1 || rows[0]?.singleton !== 1) {
    throw new Error('compatibility telemetry collector epoch is uninitialized')
  }
  const row = rows[0]
  assertUtcDay('collector installed_day', row.installed_day)
  assertUtcDay('collector valid_from_day', row.valid_from_day)
  assertSafeCount(
    'collector_schema_version',
    row.collector_schema_version,
  )
  if (row.installed_day > row.valid_from_day) {
    throw new Error('compatibility telemetry collector epoch is malformed')
  }
  return row
}

function assertCompatibilityMigrationTelemetryCollectorEpochCurrent(
  db: Database.Database,
): StoredCompatibilityMigrationTelemetryCollectorEpoch {
  assertCompatibilityMigrationTelemetrySchemaCompatible(db)
  if (!telemetryMigrationMarker(db)) {
    throw new Error(
      `coverage requires migration ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID}`,
    )
  }
  const epoch = storedCompatibilityMigrationTelemetryCollectorEpoch(db)
  if (epoch.collector_schema_version !== sqliteSchemaVersion(db)) {
    throw new Error(
      'compatibility telemetry collector schema epoch requires startup refresh',
    )
  }
  return epoch
}

/**
 * Validate the exact collector schema after all startup migrations and advance the collector
 * epoch only when SQLite reports a schema change. Advancing the epoch conservatively forfeits
 * every unsealed day through `now`; a stable restart performs no write.
 */
export function refreshCompatibilityMigrationTelemetryCollectorEpoch(
  db: Database.Database,
  input: CompatibilityMigrationTelemetryCollectorEpochRefreshInput,
): CompatibilityMigrationTelemetryCollectorEpoch {
  assertExactKeys(input, ['now'])
  assertValidDate('now', input.now)
  const observedDay = utcDay(input.now)

  ensureTelemetryGuardState(db)
  return runAtomically(db, () => {
    assertCompatibilityMigrationTelemetrySchemaCompatible(db)
    const marker = telemetryMigrationMarker(db)
    if (!marker) {
      throw new Error(
        `collector epoch requires migration `
        + AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID,
      )
    }
    const markerDay = marker.applied_at.slice(0, 10)
    assertUtcDay('migration applied_at day', markerDay)
    const currentSchemaVersion = sqliteSchemaVersion(db)
    const rows = db.prepare(`
      SELECT singleton, installed_day, collector_schema_version, valid_from_day
      FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
      ORDER BY singleton
    `).all() as StoredCompatibilityMigrationTelemetryCollectorEpoch[]
    if (rows.length > 1) {
      throw new Error('compatibility telemetry collector epoch is malformed')
    }

    const existing = rows[0]
    if (!existing) {
      const validFromDay = markerDay > observedDay
        ? markerDay
        : observedDay
      const insertState = db.prepare(`
        INSERT INTO ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE} (
          singleton, installed_day, collector_schema_version, valid_from_day
        ) VALUES (1, ?, ?, ?)
      `)
      const insert = withTelemetryMutationGuard(
        db,
        'epoch',
        () => insertState.run(
          markerDay,
          currentSchemaVersion,
          validFromDay,
        ),
      )
      if (insert.changes !== 1) {
        throw new Error(
          'compatibility telemetry collector epoch insert was suppressed',
        )
      }
      const stored = storedCompatibilityMigrationTelemetryCollectorEpoch(db)
      if (
        stored.installed_day !== markerDay
        || stored.collector_schema_version !== currentSchemaVersion
        || stored.valid_from_day !== validFromDay
      ) {
        throw new Error(
          'compatibility telemetry collector epoch insert diverged',
        )
      }
      assertCompatibilityMigrationTelemetrySchemaCompatible(db)
      if (sqliteSchemaVersion(db) !== currentSchemaVersion) {
        throw new Error(
          'compatibility telemetry collector schema changed during refresh',
        )
      }
      return Object.freeze({
        installed_day: markerDay,
        collector_schema_version: currentSchemaVersion,
        valid_from_day: validFromDay,
        refreshed: true,
      })
    }

    assertUtcDay('collector installed_day', existing.installed_day)
    assertUtcDay('collector valid_from_day', existing.valid_from_day)
    assertSafeCount(
      'collector_schema_version',
      existing.collector_schema_version,
    )
    if (existing.installed_day > existing.valid_from_day) {
      throw new Error('compatibility telemetry collector epoch is malformed')
    }
    if (existing.collector_schema_version === currentSchemaVersion) {
      assertCompatibilityMigrationTelemetrySchemaCompatible(db)
      if (sqliteSchemaVersion(db) !== currentSchemaVersion) {
        throw new Error(
          'compatibility telemetry collector schema changed during refresh',
        )
      }
      return Object.freeze({
        installed_day: existing.installed_day,
        collector_schema_version: existing.collector_schema_version,
        valid_from_day: existing.valid_from_day,
        refreshed: false,
      })
    }

    const validFromDay = existing.valid_from_day > observedDay
      ? existing.valid_from_day
      : observedDay
    const updateState = db.prepare(`
      UPDATE ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
      SET collector_schema_version=?, valid_from_day=?
      WHERE singleton=1
        AND installed_day=?
        AND collector_schema_version=?
        AND valid_from_day=?
    `)
    const update = withTelemetryMutationGuard(
      db,
      'epoch',
      () => updateState.run(
        currentSchemaVersion,
        validFromDay,
        existing.installed_day,
        existing.collector_schema_version,
        existing.valid_from_day,
      ),
    )
    if (update.changes !== 1) {
      throw new Error('compatibility telemetry collector epoch update raced')
    }
    const stored = storedCompatibilityMigrationTelemetryCollectorEpoch(db)
    if (
      stored.installed_day !== existing.installed_day
      || stored.collector_schema_version !== currentSchemaVersion
      || stored.valid_from_day !== validFromDay
    ) {
      throw new Error(
        'compatibility telemetry collector epoch update diverged',
      )
    }
    assertCompatibilityMigrationTelemetrySchemaCompatible(db)
    if (sqliteSchemaVersion(db) !== currentSchemaVersion) {
      throw new Error(
        'compatibility telemetry collector schema changed during refresh',
      )
    }
    return Object.freeze({
      installed_day: existing.installed_day,
      collector_schema_version: currentSchemaVersion,
      valid_from_day: validFromDay,
      refreshed: true,
    })
  })
}

/**
 * Mark one fully observed UTC day only after it is complete and after 023 was active beforehand.
 *
 * All 13 table coverage rows are inserted atomically. Missing or incompatible triggers prevent a
 * coverage claim, so an absent usage counter alone is never evidence of zero legacy writes.
 */
export function sealCompletedCompatibilityMigrationTelemetryDay(
  db: Database.Database,
  day: string,
  failureJournal?: CompatibilityMigrationFailureJournalBinding,
): void {
  assertUtcDay('day', day)
  const today = utcDay(new Date())
  if (day >= today) {
    throw new RangeError('only a completed UTC day can be sealed')
  }
  const failureJournalSeal = failureJournal?.prepareDaySeal(day)

  withTelemetryMutationGuard(db, 'seal', () => {
    const guardState = ensureTelemetryGuardState(db)
    runAtomically(db, () => {
      const epoch =
        assertCompatibilityMigrationTelemetryCollectorEpochCurrent(db)
      const existing = db.prepare(`
      SELECT table_name, legacy_write_count, mismatch_count, failure_count
      FROM ${TELEMETRY_COVERAGE_TABLE}
      WHERE day=?
      ORDER BY table_name
    `).all(day) as Array<{
      table_name: string
      legacy_write_count: number
      mismatch_count: number
      failure_count: number
    }>
      if (existing.length !== 0) {
        if (existing.length !== AGENT_OS_LEGACY_COMPATIBILITY_TABLES.length) {
          throw new Error(
            'compatibility telemetry coverage day is only partially sealed',
          )
        }
        for (const row of existing) {
          assertSafeCount(
            'coverage legacy_write_count',
            row.legacy_write_count,
          )
          assertSafeCount('coverage mismatch_count', row.mismatch_count)
          assertSafeCount('coverage failure_count', row.failure_count)
        }
        assertCompatibilityMigrationTelemetryCollectorEpochCurrent(db)
        if (failureJournal && failureJournalSeal) {
          failureJournal.writeDaySealReceipt(failureJournalSeal)
        }
        return
      }
      if (day <= epoch.valid_from_day) {
        throw new RangeError(
          'coverage day must begin after the current collector epoch',
        )
      }

      const tableValues = AGENT_OS_LEGACY_COMPATIBILITY_TABLES
        .map((table) => `('${table}')`)
        .join(',')
      const snapshots = db.prepare(`
      WITH legacy_tables(table_name) AS (VALUES ${tableValues})
      SELECT
        legacy_tables.table_name,
        COALESCE(SUM(
          CASE WHEN daily.operation='legacy_write' THEN daily.count ELSE 0 END
        ), 0) AS legacy_write_count,
        COALESCE(SUM(
          CASE WHEN daily.operation='mismatch' THEN daily.count ELSE 0 END
        ), 0) AS mismatch_count,
        COALESCE(SUM(
          CASE WHEN daily.operation='failure' THEN daily.count ELSE 0 END
        ), 0) AS failure_count
      FROM legacy_tables
      LEFT JOIN ${TELEMETRY_DAILY_TABLE} AS daily
        ON daily.day=?
        AND daily.table_name=legacy_tables.table_name
      GROUP BY legacy_tables.table_name
      ORDER BY legacy_tables.table_name
    `).all(day) as Array<{
      table_name: AgentOsLegacyCompatibilityTable
      legacy_write_count: number
      mismatch_count: number
      failure_count: number
    }>
      if (snapshots.length !== AGENT_OS_LEGACY_COMPATIBILITY_TABLES.length) {
        throw new Error(
          'compatibility telemetry coverage snapshot is incomplete',
        )
      }

      const insert = db.prepare(`
      INSERT INTO ${TELEMETRY_COVERAGE_TABLE} (
        day, table_name, legacy_write_count, mismatch_count, failure_count
      ) VALUES (?, ?, ?, ?, ?)
    `)
      for (const snapshot of snapshots) {
        guardState.sealDay = day
        guardState.sealTable = snapshot.table_name
        try {
          const result = insert.run(
            day,
            snapshot.table_name,
            assertSafeCount(
              'coverage legacy_write_count',
              snapshot.legacy_write_count,
            ),
            assertSafeCount(
              'coverage mismatch_count',
              snapshot.mismatch_count,
            ),
            assertSafeCount(
              'coverage failure_count',
              snapshot.failure_count,
            ),
          )
          if (result.changes !== 1) {
            throw new Error(
              'compatibility telemetry coverage insert was suppressed',
            )
          }
        } finally {
          guardState.sealTable = null
        }
      }

      const sealed = db.prepare(`
        SELECT table_name, legacy_write_count, mismatch_count, failure_count
        FROM ${TELEMETRY_COVERAGE_TABLE}
        WHERE day=?
        ORDER BY table_name
      `).all(day) as typeof snapshots
      const matchesSnapshot =
        sealed.length === snapshots.length
        && sealed.every((row, index) => {
          const snapshot = snapshots[index]
          return !!snapshot
            && row.table_name === snapshot.table_name
            && row.legacy_write_count === snapshot.legacy_write_count
            && row.mismatch_count === snapshot.mismatch_count
            && row.failure_count === snapshot.failure_count
        })
      if (!matchesSnapshot) {
        throw new Error(
          'compatibility telemetry coverage did not match its snapshot',
        )
      }
      assertCompatibilityMigrationTelemetryCollectorEpochCurrent(db)
      if (failureJournal && failureJournalSeal) {
        failureJournal.writeDaySealReceipt(failureJournalSeal)
      }
    })
  })
}

type TelemetryConservationRow = {
  table_name: AgentOsLegacyCompatibilityTable
  operation: CompatibilityMigrationTelemetryOperation
  cohort: CompatibilityMigrationTelemetryCohort
  diagnostic_code: CompatibilityMigrationTelemetryDiagnostic
  first_day: string
  last_day: string
  count: number
}

function compatibilityMigrationTelemetryConservationSnapshot(
  db: Database.Database,
): readonly TelemetryConservationRow[] {
  const rows = db.prepare(`
    SELECT table_name, operation, cohort, diagnostic_code,
      MIN(first_day) AS first_day,
      MAX(last_day) AS last_day,
      SUM(count) AS count
    FROM (
      SELECT table_name, operation, cohort, diagnostic_code,
        first_day, last_day, count
      FROM ${TELEMETRY_HISTORY_TABLE}
      UNION ALL
      SELECT table_name, operation, cohort, diagnostic_code,
        day AS first_day, day AS last_day, count
      FROM ${TELEMETRY_DAILY_TABLE}
    )
    GROUP BY table_name, operation, cohort, diagnostic_code
    ORDER BY table_name, operation, cohort, diagnostic_code
  `).all() as TelemetryConservationRow[]
  return Object.freeze(rows.map((row) => Object.freeze({
    ...row,
    count: assertSafeCount('conserved telemetry count', row.count),
  })))
}

function assertCompatibilityMigrationTelemetryConserved(
  before: readonly TelemetryConservationRow[],
  after: readonly TelemetryConservationRow[],
): void {
  const matches = before.length === after.length && before.every(
    (row, index) => {
      const candidate = after[index]
      return !!candidate
        && candidate.table_name === row.table_name
        && candidate.operation === row.operation
        && candidate.cohort === row.cohort
        && candidate.diagnostic_code === row.diagnostic_code
        && candidate.first_day === row.first_day
        && candidate.last_day === row.last_day
        && candidate.count === row.count
    },
  )
  if (!matches) {
    throw new Error('compatibility telemetry rollup failed conservation')
  }
}

export function rollupCompatibilityMigrationTelemetry(
  db: Database.Database,
  input: CompatibilityMigrationTelemetryRollupInput,
  failureJournal?: CompatibilityMigrationFailureJournalBinding,
): CompatibilityMigrationTelemetryRollupResult {
  assertExactKeys(input, ['now'], ['retain_days'])
  assertValidDate('now', input.now)
  const retainDays = input.retain_days
    ?? AGENT_OS_COMPATIBILITY_TELEMETRY_RETENTION_RULE.minimum_daily_retention_days
  assertSafeCount('retain_days', retainDays, 1)
  if (
    retainDays
      < AGENT_OS_COMPATIBILITY_TELEMETRY_RETENTION_RULE.minimum_daily_retention_days
    || retainDays
      > AGENT_OS_COMPATIBILITY_TELEMETRY_RETENTION_RULE.maximum_daily_retention_days
  ) {
    throw new RangeError(
      'retain_days is outside the bounded compatibility telemetry retention rule',
    )
  }
  const retainFromDay = addUtcDays(utcDay(input.now), -(retainDays - 1))
  failureJournal?.drain()
  failureJournal?.assertRollupReady(retainFromDay)
  const eligibleDaysSql = `
    SELECT day
    FROM ${TELEMETRY_COVERAGE_TABLE}
    WHERE day<?
    GROUP BY day
    HAVING COUNT(*)=${AGENT_OS_LEGACY_COMPATIBILITY_TABLES.length}
  `

  ensureTelemetryGuardState(db)
  return runAtomically(db, () => {
    assertCompatibilityMigrationTelemetryCollectorEpochCurrent(db)
    const before = compatibilityMigrationTelemetryConservationSnapshot(db)
    const aggregate = db.prepare(`
      WITH eligible_days(day) AS (${eligibleDaysSql})
      SELECT
        COUNT(*) AS rows_compacted,
        COALESCE(SUM(count), 0) AS count_compacted,
        COALESCE(SUM(CASE WHEN operation='mismatch' THEN count ELSE 0 END), 0)
          AS mismatch_count_compacted,
        COALESCE(SUM(CASE WHEN operation='failure' THEN count ELSE 0 END), 0)
          AS failure_count_compacted,
        MAX(day) AS compacted_through_day
      FROM ${TELEMETRY_DAILY_TABLE}
      WHERE day IN (SELECT day FROM eligible_days)
    `).get(retainFromDay) as {
      rows_compacted: number
      count_compacted: number
      mismatch_count_compacted: number
      failure_count_compacted: number
      compacted_through_day: string | null
    }

    const historyWrite = db.prepare(`
      WITH eligible_days(day) AS (${eligibleDaysSql})
      INSERT INTO ${TELEMETRY_HISTORY_TABLE} (
        table_name, operation, cohort, diagnostic_code,
        first_day, last_day, count
      )
      SELECT table_name, operation, cohort, diagnostic_code,
        MIN(day), MAX(day), SUM(count)
      FROM ${TELEMETRY_DAILY_TABLE}
      WHERE day IN (SELECT day FROM eligible_days)
      GROUP BY table_name, operation, cohort, diagnostic_code
      ON CONFLICT(
        table_name, operation, cohort, diagnostic_code
      ) DO UPDATE SET
        first_day=MIN(first_day, excluded.first_day),
        last_day=MAX(last_day, excluded.last_day),
        count=count+excluded.count
    `)
    withTelemetryMutationGuard(db, 'rollup-history', () => {
      historyWrite.run(retainFromDay)
    })

    const dailyDelete = db.prepare(`
      WITH eligible_days(day) AS (${eligibleDaysSql})
      DELETE FROM ${TELEMETRY_DAILY_TABLE}
      WHERE day IN (SELECT day FROM eligible_days)
    `)
    const guardState = ensureTelemetryGuardState(db)
    guardState.rollupRetainFromDay = retainFromDay
    const deleted = withTelemetryMutationGuard(
      db,
      'rollup-delete',
      () => dailyDelete.run(retainFromDay),
    )
    if (deleted.changes !== aggregate.rows_compacted) {
      throw new Error(
        'compatibility telemetry compaction deleted an unexpected row count',
      )
    }
    const after = compatibilityMigrationTelemetryConservationSnapshot(db)
    assertCompatibilityMigrationTelemetryConserved(before, after)
    assertCompatibilityMigrationTelemetryCollectorEpochCurrent(db)

    return Object.freeze({
      retain_from_day: retainFromDay,
      compacted_through_day: aggregate.compacted_through_day,
      rows_compacted: assertSafeCount(
        'rows_compacted',
        aggregate.rows_compacted,
      ),
      count_compacted: assertSafeCount(
        'count_compacted',
        aggregate.count_compacted,
      ),
      mismatch_count_compacted: assertSafeCount(
        'mismatch_count_compacted',
        aggregate.mismatch_count_compacted,
      ),
      failure_count_compacted: assertSafeCount(
        'failure_count_compacted',
        aggregate.failure_count_compacted,
      ),
    })
  })
}

export function queryCompatibilityMigrationWriterObservation(
  db: Database.Database,
  query: CompatibilityMigrationWriterObservationQuery,
  failureJournal?: CompatibilityMigrationFailureJournalBinding,
): CompatibilityMigrationWriterObservationResult {
  assertExactKeys(query, ['table', 'from_day', 'through_day'])
  assertEnum('table', query.table, AGENT_OS_LEGACY_COMPATIBILITY_TABLES)
  assertDayRange(query.from_day, query.through_day)
  const calendarDays = calendarDayCount(query.from_day, query.through_day)
  failureJournal?.drain()
  failureJournal?.assertCoverageReceipts(
    query.from_day,
    query.through_day,
  )

  return runReadSnapshot(db, () => {
    const epoch =
      assertCompatibilityMigrationTelemetryCollectorEpochCurrent(db)
    const snapshot = db.prepare(`
      SELECT
        COUNT(*) AS covered_days,
        COALESCE(SUM(legacy_write_count), 0) AS legacy_write_count,
        COALESCE(SUM(mismatch_count), 0) AS mismatch_count,
        COALESCE(SUM(failure_count), 0) AS failure_count
      FROM ${TELEMETRY_COVERAGE_TABLE}
      WHERE table_name=? AND day BETWEEN ? AND ?
    `).get(query.table, query.from_day, query.through_day) as {
      covered_days: number
      legacy_write_count: number
      mismatch_count: number
      failure_count: number
    }

    const coveredDays = assertSafeCount(
      'covered_days',
      snapshot.covered_days,
    )
    const legacyWriteCount = assertSafeCount(
      'legacy_write_count',
      snapshot.legacy_write_count,
    )
    const mismatchCount = assertSafeCount(
      'mismatch_count',
      snapshot.mismatch_count,
    )
    const failureCount = assertSafeCount(
      'failure_count',
      snapshot.failure_count,
    )

    let status: CompatibilityMigrationWriterObservationStatus
    let reason: CompatibilityMigrationWriterObservationReason
    if (legacyWriteCount > 0) {
      status = 'legacy_writer_observed'
      reason = 'legacy_write_nonzero'
    } else if (mismatchCount > 0 || failureCount > 0) {
      status = 'diagnostic_risk_observed'
      reason = 'diagnostic_nonzero'
    } else if (
      calendarDays
        < AGENT_OS_COMPATIBILITY_WRITER_OBSERVATION_RULE.minimum_complete_utc_days
    ) {
      status = 'insufficient_observation'
      reason = 'window_too_short'
    } else if (
      query.from_day <= epoch.valid_from_day
      || coveredDays !== calendarDays
    ) {
      status = 'insufficient_observation'
      reason = 'coverage_gap'
    } else {
      status = 'eligible_for_operator_review'
      reason = 'operator_review_required'
    }

    const result = Object.freeze({
      table: query.table,
      from_day: query.from_day,
      through_day: query.through_day,
      calendar_days: calendarDays,
      covered_days: coveredDays,
      required_days:
        AGENT_OS_COMPATIBILITY_WRITER_OBSERVATION_RULE.minimum_complete_utc_days,
      legacy_write_count: legacyWriteCount,
      mismatch_count: mismatchCount,
      failure_count: failureCount,
      status,
      reason,
      writer_removal_authorized: false,
      operator_gate: 'ORC-020',
    })
    assertCompatibilityMigrationTelemetryCollectorEpochCurrent(db)
    return result
  })
}

import type Database from 'better-sqlite3'
import {
  AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
} from './compatibility-forward-migration.js'
import {
  AGENT_OS_LEGACY_COMPATIBILITY_TABLES,
  type AgentOsLegacyCompatibilityTable,
} from './compatibility-projection-contract.js'

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

function sqlEnum(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',')
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

const STATIC_TRIGGER_COHORTS: Readonly<
  Partial<
    Record<AgentOsLegacyCompatibilityTable, CompatibilityMigrationTelemetryCohort>
  >
> = Object.freeze({
  boards: 'shared_scope',
  messages: 'legacy_only',
  message_targets: 'legacy_only',
  deliveries: 'legacy_only',
  milestones: 'deferred_replacement',
  ideas: 'deferred_replacement',
  token_telemetry: 'legacy_only',
})

function triggerCohortSql(
  table: AgentOsLegacyCompatibilityTable,
  rowReference: 'NEW' | 'OLD',
): string {
  const cohort = STATIC_TRIGGER_COHORTS[table]
  if (cohort) return `'${cohort}'`

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
  return Object.freeze({
    type: 'trigger' as const,
    name,
    sql: `CREATE TRIGGER ${name}
      AFTER ${mutation.toUpperCase()} ON ${table}
      BEGIN
        INSERT INTO ${TELEMETRY_DAILY_TABLE} (
          day, table_name, operation, cohort, diagnostic_code, count
        ) VALUES (
          date('now'), '${table}', 'legacy_write',
          ${triggerCohortSql(table, rowReference)}, 'none', 1
        )
        ON CONFLICT(
          day, table_name, operation, cohort, diagnostic_code
        ) DO UPDATE SET count=count+1;
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
    ) STRICT`,
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
    ) STRICT`,
  }),
  Object.freeze({
    type: 'table' as const,
    name: TELEMETRY_COVERAGE_TABLE,
    sql: `CREATE TABLE ${TELEMETRY_COVERAGE_TABLE} (
      day TEXT NOT NULL CHECK(${UTC_DAY_CHECK_SQL('day')}),
      table_name TEXT NOT NULL CHECK(table_name IN (${TABLE_ENUM_SQL})),
      PRIMARY KEY(day, table_name)
    ) STRICT`,
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

const COMPATIBILITY_TELEMETRY_SCHEMA = Object.freeze([
  ...BASE_SCHEMA,
  ...TELEMETRY_TRIGGERS,
] satisfies readonly SchemaObject[])

export const AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES =
  Object.freeze(
    COMPATIBILITY_TELEMETRY_SCHEMA.map(({ name }) => name),
  )

export const AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES =
  Object.freeze(
    TELEMETRY_TRIGGERS.map(({ name }) => name),
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
    .toLowerCase()
}

export function assertCompatibilityMigrationTelemetrySchemaCompatible(
  db: Database.Database,
): void {
  for (const expected of COMPATIBILITY_TELEMETRY_SCHEMA) {
    const actual = db.prepare(`
      SELECT type, sql FROM sqlite_master WHERE name=?
    `).get(expected.name) as {
      type: string
      sql: string | null
    } | undefined
    if (
      !actual
      || actual.type !== expected.type
      || normalizeSchemaSql(actual.sql ?? '') !== normalizeSchemaSql(expected.sql)
    ) {
      throw new Error(
        `migration ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID}`
        + ` found incompatible ${expected.name} schema`,
      )
    }
  }

  const actualTelemetryTriggers = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='trigger'
      AND lower(coalesce(sql, ''))
        LIKE '%${TELEMETRY_DAILY_TABLE}%'
    ORDER BY name
  `).all() as Array<{ name: string }>
  const expectedTelemetryTriggers = [...AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES]
    .sort()
  if (
    actualTelemetryTriggers.length !== expectedTelemetryTriggers.length
    || actualTelemetryTriggers.some(
      ({ name }, index) => name !== expectedTelemetryTriggers[index],
    )
  ) {
    throw new Error(
      `migration ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID}`
      + ' found unexpected legacy mutation telemetry triggers',
    )
  }
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
      + ` (missing=${missing.join(',') || 'none'}`
      + ` extra=${extra.join(',') || 'none'})`,
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

  db.prepare(`
    INSERT INTO ${TELEMETRY_DAILY_TABLE} (
      day, table_name, operation, cohort, diagnostic_code, count
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(
      day, table_name, operation, cohort, diagnostic_code
    ) DO UPDATE SET count=count+excluded.count
  `).run(
    day,
    input.table,
    input.operation,
    input.cohort,
    input.diagnostic_code,
    count,
  )

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
  return Object.freeze({
    ...row,
    count: assertSafeCount('stored telemetry count', row.count),
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
): CompatibilityMigrationTelemetryDailyResult {
  assertExactKeys(query, ['from_day', 'through_day'], ['table'])
  assertDayRange(query.from_day, query.through_day)
  if (query.table !== undefined) {
    assertEnum('table', query.table, AGENT_OS_LEGACY_COMPATIBILITY_TABLES)
  }

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
  return Object.freeze({
    from_day: query.from_day,
    through_day: query.through_day,
    table: query.table ?? null,
    rows: frozenRows,
    ...totals,
  })
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
): CompatibilityMigrationTelemetrySummaryResult {
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
  return Object.freeze({
    rows: frozenRows,
    historical_first_day: historical.first_day,
    historical_through_day: historical.last_day,
    retained_daily_first_day: daily.first_day,
    retained_daily_through_day: daily.last_day,
    ...totals,
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

/**
 * Mark one fully observed UTC day only after it is complete and after 023 was active beforehand.
 *
 * All 13 table coverage rows are inserted atomically. Missing or incompatible triggers prevent a
 * coverage claim, so an absent usage counter alone is never evidence of zero legacy writes.
 */
export function sealCompletedCompatibilityMigrationTelemetryDay(
  db: Database.Database,
  day: string,
): void {
  assertUtcDay('day', day)
  const today = utcDay(new Date())
  if (day >= today) {
    throw new RangeError('only a completed UTC day can be sealed')
  }
  assertCompatibilityMigrationTelemetrySchemaCompatible(db)
  const marker = db.prepare(`
    SELECT applied_at FROM os_schema_migrations WHERE id=?
  `).get(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID) as {
    applied_at: string
  } | undefined
  if (!marker) {
    throw new Error(
      `coverage requires migration ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID}`,
    )
  }
  const appliedDay = marker.applied_at.slice(0, 10)
  assertUtcDay('migration applied_at day', appliedDay)
  if (day <= appliedDay) {
    throw new RangeError(
      'coverage day must begin after the telemetry migration installation day',
    )
  }

  runAtomically(db, () => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO ${TELEMETRY_COVERAGE_TABLE} (day, table_name)
      VALUES (?, ?)
    `)
    for (const table of AGENT_OS_LEGACY_COMPATIBILITY_TABLES) {
      insert.run(day, table)
    }
  })
}

export function rollupCompatibilityMigrationTelemetry(
  db: Database.Database,
  input: CompatibilityMigrationTelemetryRollupInput,
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

  return runAtomically(db, () => {
    const aggregate = db.prepare(`
      SELECT
        COUNT(*) AS rows_compacted,
        COALESCE(SUM(count), 0) AS count_compacted,
        COALESCE(SUM(CASE WHEN operation='mismatch' THEN count ELSE 0 END), 0)
          AS mismatch_count_compacted,
        COALESCE(SUM(CASE WHEN operation='failure' THEN count ELSE 0 END), 0)
          AS failure_count_compacted,
        MAX(day) AS compacted_through_day
      FROM ${TELEMETRY_DAILY_TABLE}
      WHERE day<?
    `).get(retainFromDay) as {
      rows_compacted: number
      count_compacted: number
      mismatch_count_compacted: number
      failure_count_compacted: number
      compacted_through_day: string | null
    }

    db.prepare(`
      INSERT INTO ${TELEMETRY_HISTORY_TABLE} (
        table_name, operation, cohort, diagnostic_code,
        first_day, last_day, count
      )
      SELECT table_name, operation, cohort, diagnostic_code,
        MIN(day), MAX(day), SUM(count)
      FROM ${TELEMETRY_DAILY_TABLE}
      WHERE day<?
      GROUP BY table_name, operation, cohort, diagnostic_code
      ON CONFLICT(
        table_name, operation, cohort, diagnostic_code
      ) DO UPDATE SET
        first_day=MIN(first_day, excluded.first_day),
        last_day=MAX(last_day, excluded.last_day),
        count=count+excluded.count
    `).run(retainFromDay)
    db.prepare(`
      DELETE FROM ${TELEMETRY_DAILY_TABLE} WHERE day<?
    `).run(retainFromDay)
    db.prepare(`
      DELETE FROM ${TELEMETRY_COVERAGE_TABLE} WHERE day<?
    `).run(retainFromDay)

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
): CompatibilityMigrationWriterObservationResult {
  assertExactKeys(query, ['table', 'from_day', 'through_day'])
  assertEnum('table', query.table, AGENT_OS_LEGACY_COMPATIBILITY_TABLES)
  assertDayRange(query.from_day, query.through_day)
  const calendarDays = calendarDayCount(query.from_day, query.through_day)
  const coverage = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ${TELEMETRY_COVERAGE_TABLE}
    WHERE table_name=? AND day BETWEEN ? AND ?
  `).get(query.table, query.from_day, query.through_day) as { count: number }
  const counts = db.prepare(`
    SELECT
      COALESCE(SUM(
        CASE WHEN operation='legacy_write' THEN count ELSE 0 END
      ), 0) AS legacy_write_count,
      COALESCE(SUM(
        CASE WHEN operation='mismatch' THEN count ELSE 0 END
      ), 0) AS mismatch_count,
      COALESCE(SUM(
        CASE WHEN operation='failure' THEN count ELSE 0 END
      ), 0) AS failure_count
    FROM ${TELEMETRY_DAILY_TABLE}
    WHERE table_name=? AND day BETWEEN ? AND ?
  `).get(query.table, query.from_day, query.through_day) as {
    legacy_write_count: number
    mismatch_count: number
    failure_count: number
  }

  const coveredDays = assertSafeCount('covered_days', coverage.count)
  const legacyWriteCount = assertSafeCount(
    'legacy_write_count',
    counts.legacy_write_count,
  )
  const mismatchCount = assertSafeCount(
    'mismatch_count',
    counts.mismatch_count,
  )
  const failureCount = assertSafeCount(
    'failure_count',
    counts.failure_count,
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
  } else if (coveredDays !== calendarDays) {
    status = 'insufficient_observation'
    reason = 'coverage_gap'
  } else {
    status = 'eligible_for_operator_review'
    reason = 'operator_review_required'
  }

  return Object.freeze({
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
}

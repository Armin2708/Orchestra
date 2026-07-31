import type Database from 'better-sqlite3'
import {
  recordCompatibilityMigrationTelemetry,
  type CompatibilityMigrationFailureDiagnostic,
  type CompatibilityMigrationTelemetryCohort,
  type CompatibilityMigrationTelemetryOperation,
} from './compatibility-migration-telemetry.js'
import {
  AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
} from './compatibility-forward-migration.js'
import type {
  AgentOsLegacyCompatibilityTable,
} from './compatibility-projection-contract.js'

type CompatibilityTelemetrySubject =
  | Readonly<{ table: 'boards' }>
  | Readonly<{ table: 'task_contracts'; card_id?: number }>
  | Readonly<{
    table: 'agent_usage'
    board_id?: number
    agent_id?: number
    day?: string
  }>
  | Readonly<{ table: 'agents'; agent_id?: number }>
  | Readonly<{ table: 'cards'; card_id?: number }>
  | Readonly<{ table: 'card_events'; source_id?: number }>
  | Readonly<{ table: 'messages' }>
  | Readonly<{ table: 'message_targets' }>
  | Readonly<{ table: 'deliveries' }>
  | Readonly<{ table: 'milestones' }>
  | Readonly<{ table: 'ideas' }>
  | Readonly<{ table: 'review_decisions'; decision_id?: number }>
  | Readonly<{ table: 'token_telemetry' }>

type CompatibilityTelemetrySuccessOperation = Exclude<
  CompatibilityMigrationTelemetryOperation,
  'mismatch' | 'failure' | 'legacy_write'
>

export interface CompatibilityMigrationOperationInput {
  readonly subject: CompatibilityTelemetrySubject
  readonly success_operations: readonly CompatibilityTelemetrySuccessOperation[]
  readonly failure_diagnostic: CompatibilityMigrationFailureDiagnostic
}

const SINGLE_COHORTS = Object.freeze({
  boards: 'shared_scope',
  messages: 'legacy_only',
  message_targets: 'legacy_only',
  deliveries: 'legacy_only',
  milestones: 'deferred_replacement',
  ideas: 'deferred_replacement',
  token_telemetry: 'legacy_only',
} as const satisfies Readonly<
  Partial<
    Record<
      AgentOsLegacyCompatibilityTable,
      CompatibilityMigrationTelemetryCohort
    >
  >
>)

const UTC_DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

/**
 * Resolve only the bounded DOM-017 disposition needed for telemetry bucketing.
 *
 * Source keys are constructed in memory from typed internal identities, used only as bound query
 * parameters, and never returned, persisted in telemetry, or included in an error.
 */
export function resolveCompatibilityMigrationTelemetryCohort(
  db: Database.Database,
  subject: CompatibilityTelemetrySubject,
): CompatibilityMigrationTelemetryCohort {
  const fixed = SINGLE_COHORTS[subject.table as keyof typeof SINGLE_COHORTS]
  if (fixed) return fixed

  const sourceKey = compatibilitySourceKey(subject)
  if (sourceKey === null) return 'canonical_unlinked'

  const evidence = db.prepare(`
    SELECT
      EXISTS (
        SELECT 1 FROM os_compatibility_projection_links
        WHERE migration_id=@migration_id
          AND source_table=@source_table
          AND source_key=@source_key
      ) AS linked,
      EXISTS (
        SELECT 1 FROM os_compatibility_projection_quarantine
        WHERE migration_id=@migration_id
          AND source_table=@source_table
          AND source_key=@source_key
      ) AS quarantined
  `).get({
    migration_id: AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    source_table: subject.table,
    source_key: sourceKey,
  }) as { linked: number; quarantined: number }
  if (evidence.linked && evidence.quarantined) {
    throw new Error('compatibility telemetry cohort evidence is contradictory')
  }
  if (evidence.quarantined) return 'migration_quarantined'
  if (evidence.linked) return 'canonical_linked'
  return 'canonical_unlinked'
}

/**
 * Commit a real domain write and its bounded success observations together.
 *
 * Legacy-write observations are deliberately excluded: migration 023's persistent BEFORE
 * triggers already count every successful legacy-table mutation exactly once.
 */
export function runCompatibilityMigrationOperation<Result>(
  db: Database.Database,
  input: CompatibilityMigrationOperationInput,
  operation: () => Result,
): Result {
  assertSuccessOperations(input.success_operations)
  const observedAt = new Date()
  try {
    return db.transaction(() => {
      const cohort = resolveCompatibilityMigrationTelemetryCohort(
        db,
        input.subject,
      )
      const result = operation()
      for (const successOperation of input.success_operations) {
        recordCompatibilityMigrationTelemetry(db, {
          observed_at: observedAt,
          table: input.subject.table,
          operation: successOperation,
          cohort,
          diagnostic_code: 'none',
        })
      }
      return result
    }).immediate()
  } catch (error) {
    recordFailureWithoutMasking(db, input, observedAt, error)
    throw error
  }
}

function compatibilitySourceKey(
  subject: CompatibilityTelemetrySubject,
): string | null {
  switch (subject.table) {
    case 'task_contracts':
      return positiveIntegerKey(subject.card_id)
    case 'agent_usage': {
      const board = positiveIntegerKey(subject.board_id)
      const agent = positiveIntegerKey(subject.agent_id)
      const day = validUtcDay(subject.day)
      return board && agent && day ? `${board}:${agent}:${day}` : null
    }
    case 'agents':
      return positiveIntegerKey(subject.agent_id)
    case 'cards':
      return positiveIntegerKey(subject.card_id)
    case 'card_events':
      return positiveIntegerKey(subject.source_id)
    case 'review_decisions':
      return positiveIntegerKey(subject.decision_id)
    default:
      return null
  }
}

function positiveIntegerKey(value: unknown): string | null {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? String(value)
    : null
}

function validUtcDay(value: unknown): string | null {
  if (typeof value !== 'string' || !UTC_DAY.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value
    ? value
    : null
}

function assertSuccessOperations(
  operations: readonly CompatibilityTelemetrySuccessOperation[],
): void {
  const unique = new Set(operations)
  if (unique.size !== operations.length) {
    throw new TypeError('compatibility telemetry success operations must be unique')
  }
}

function recordFailureWithoutMasking(
  db: Database.Database,
  input: CompatibilityMigrationOperationInput,
  observedAt: Date,
  operationError: unknown,
): void {
  try {
    const cohort = resolveCompatibilityMigrationTelemetryCohort(
      db,
      input.subject,
    )
    recordCompatibilityMigrationTelemetry(db, {
      observed_at: observedAt,
      table: input.subject.table,
      operation: 'failure',
      cohort,
      diagnostic_code: diagnosticForFailure(
        operationError,
        input.failure_diagnostic,
      ),
    })
  } catch {
    // The real operation already failed closed. Preserve its public error instead of leaking
    // database/schema details from the secondary diagnostic attempt.
  }
}

function diagnosticForFailure(
  error: unknown,
  fallback: CompatibilityMigrationFailureDiagnostic,
): CompatibilityMigrationFailureDiagnostic {
  const code = error && typeof error === 'object'
    ? String((error as { code?: unknown }).code ?? '')
    : ''
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
    return 'database_locked'
  }
  const message = error instanceof Error ? error.message.toLocaleLowerCase('en-US') : ''
  if (
    message.includes('schema')
    || message.includes('no such table')
    || message.includes('no such column')
    || message.includes('database disk image is malformed')
  ) {
    return 'schema_incompatible'
  }
  return fallback
}

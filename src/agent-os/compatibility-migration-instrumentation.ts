import type Database from 'better-sqlite3'
import {
  AGENT_OS_COMPATIBILITY_TELEMETRY_MISMATCH_DIAGNOSTICS,
  AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS,
  AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_OPERATIONS,
  recordCompatibilityMigrationTelemetry,
  type CompatibilityMigrationFailureDiagnostic,
  type CompatibilityMigrationMismatchDiagnostic,
  type CompatibilityMigrationTelemetryCohort,
  type CompatibilityMigrationTelemetryOperation,
} from './compatibility-migration-telemetry.js'
import type {
  CompatibilityMigrationFailureJournal,
} from './compatibility-migration-failure-journal.js'
import {
  AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
} from './compatibility-forward-migration.js'
import {
  AGENT_OS_LEGACY_COMPATIBILITY_TABLES,
  type AgentOsLegacyCompatibilityTable,
} from './compatibility-projection-contract.js'

export type CompatibilityTelemetrySubject =
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

type NormalSuccessOperation = Exclude<
  CompatibilityMigrationTelemetryOperation,
  'legacy_write' | 'mismatch' | 'failure'
>

export type CompatibilityMigrationSuccessObservation =
  | Readonly<{
    operation: NormalSuccessOperation
    diagnostic_code?: 'none'
  }>
  | Readonly<{
    operation: 'mismatch'
    diagnostic_code: CompatibilityMigrationMismatchDiagnostic
  }>

export interface CompatibilityMigrationOperationInput {
  readonly observed_at?: Date
  readonly subject: CompatibilityTelemetrySubject
  readonly success_observations:
    readonly CompatibilityMigrationSuccessObservation[]
  readonly failure_diagnostic: CompatibilityMigrationFailureDiagnostic
}

const FAILURE_JOURNALS = new WeakMap<
  Database.Database,
  CompatibilityMigrationFailureJournal
>()

/** Bind the daemon-owned failure journal to real compatibility operations on one database. */
export function bindCompatibilityMigrationFailureJournal(
  db: Database.Database,
  failureJournal: CompatibilityMigrationFailureJournal,
): () => void {
  const existing = FAILURE_JOURNALS.get(db)
  if (existing) {
    throw new Error('compatibility failure journal is already bound')
  }
  FAILURE_JOURNALS.set(db, failureJournal)
  let active = true
  return () => {
    if (!active) return
    active = false
    if (FAILURE_JOURNALS.get(db) === failureJournal) {
      FAILURE_JOURNALS.delete(db)
    }
  }
}

/** Instrument a real operation when the daemon has bound its durable journal. */
export function runBoundCompatibilityMigrationOperation<Result>(
  db: Database.Database,
  input: CompatibilityMigrationOperationInput,
  operation: () => Result,
): Result {
  const failureJournal = FAILURE_JOURNALS.get(db)
  return failureJournal
    ? runCompatibilityMigrationOperation(db, failureJournal, input, operation)
    : db.transaction(operation).immediate()
}

const SINGLE_COHORTS = Object.freeze({
  boards: 'shared_scope',
  messages: 'legacy_only',
  message_targets: 'legacy_only',
  deliveries: 'legacy_only',
  milestones: 'deferred_replacement',
  ideas: 'deferred_replacement',
  token_telemetry: 'legacy_only',
  agent_transcripts: 'legacy_only',
  teams: 'legacy_only',
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
 * Source keys are constructed from typed internal identities, used only as bound query
 * parameters, and never returned or persisted in telemetry or journal evidence.
 */
export function resolveCompatibilityMigrationTelemetryCohort(
  db: Database.Database,
  subject: CompatibilityTelemetrySubject,
): CompatibilityMigrationTelemetryCohort {
  if (!AGENT_OS_LEGACY_COMPATIBILITY_TABLES.includes(subject.table)) {
    throw new TypeError('table is not a compatibility table')
  }
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
 * Execute one real compatibility operation with durable failure admission.
 *
 * The sidecar reservation precedes domain work. Successful domain writes, bounded observations,
 * and the main success receipt share the caller's main transaction. A later outer rollback leaves
 * the authenticated returned marker but removes the receipt, so the next drain records one
 * `unexpected_failure` instead of false success. Failed operations are marked in the independent
 * journal and imported only after the main database is writable again.
 */
export function runCompatibilityMigrationOperation<Result>(
  db: Database.Database,
  failureJournal: CompatibilityMigrationFailureJournal,
  input: CompatibilityMigrationOperationInput,
  operation: () => Result,
): Result {
  assertSuccessObservations(input)
  const observedAt = input.observed_at === undefined
    ? new Date()
    : new Date(input.observed_at.getTime())
  if (!Number.isFinite(observedAt.getTime())) {
    throw new TypeError('observed_at must be a valid Date')
  }
  const cohort = resolveCompatibilityMigrationTelemetryCohort(
    db,
    input.subject,
  )

  // Reconcile earlier outcomes before consuming another bounded slot. A caller-owned main
  // transaction cannot safely drain; its operation is still admitted and reconciled afterward.
  if (!db.inTransaction) failureJournal.drain()
  const reservation = failureJournal.reserve({
    observed_at: observedAt,
    table: input.subject.table,
    cohort,
    fallback_diagnostic: input.failure_diagnostic,
  })

  try {
    return db.transaction(() => {
      const result = operation()
      for (const observation of input.success_observations) {
        recordCompatibilityMigrationTelemetry(db, {
          observed_at: observedAt,
          table: input.subject.table,
          operation: observation.operation,
          cohort,
          diagnostic_code: observation.diagnostic_code ?? 'none',
        })
      }
      failureJournal.recordSuccessReceipt(reservation)
      return result
    }).immediate()
  } catch (error) {
    failureJournal.markFailed(
      reservation,
      diagnosticForFailure(error, input.failure_diagnostic),
    )
    throw error
  }
}

function assertSuccessObservations(
  input: CompatibilityMigrationOperationInput,
): void {
  if (!Array.isArray(input.success_observations)
    || input.success_observations.length === 0) {
    throw new TypeError(
      'compatibility telemetry requires at least one success observation',
    )
  }
  const allowed = AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_OPERATIONS[
    input.subject.table
  ] as readonly CompatibilityMigrationTelemetryOperation[]
  const unique = new Set<string>()
  for (const observation of input.success_observations) {
    if (!observation || typeof observation !== 'object') {
      throw new TypeError('compatibility success observation must be an object')
    }
    if (!AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS.includes(
      observation.operation,
    )) {
      throw new TypeError('compatibility success operation is not bounded')
    }
    if (
      observation.operation === 'legacy_write'
      || observation.operation === 'failure'
      || !allowed.includes(observation.operation)
    ) {
      throw new TypeError(
        'operation is not a supported compatibility success observation',
      )
    }
    const diagnostic = observation.diagnostic_code ?? 'none'
    if (
      observation.operation === 'mismatch'
        ? !AGENT_OS_COMPATIBILITY_TELEMETRY_MISMATCH_DIAGNOSTICS.includes(
          diagnostic as CompatibilityMigrationMismatchDiagnostic,
        )
        : diagnostic !== 'none'
    ) {
      throw new TypeError(
        'diagnostic is incompatible with compatibility success operation',
      )
    }
    const key = `${observation.operation}:${diagnostic}`
    if (unique.has(key)) {
      throw new TypeError(
        'compatibility telemetry success observations must be unique',
      )
    }
    unique.add(key)
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
  const message = error instanceof Error
    ? error.message.toLocaleLowerCase('en-US')
    : ''
  if (
    message.includes('schema')
    || message.includes('no such table')
    || message.includes('no such column')
    || message.includes('database disk image is malformed')
    || message.includes('protected temp')
  ) {
    return 'schema_incompatible'
  }
  return fallback
}

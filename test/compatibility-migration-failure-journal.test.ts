import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE,
  AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE,
  AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE,
  AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID,
  AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_SCHEMA_OBJECT_NAMES,
  CompatibilityMigrationFailureJournal,
  CompatibilityMigrationFailureJournalCapacityError,
  CompatibilityMigrationTelemetryEvidenceIncompleteError,
  applyCompatibilityMigrationFailureJournalMigration,
  assertCompatibilityMigrationFailureJournalSchemaCompatible,
  openCompatibilityMigrationFailureJournal,
} from '../src/agent-os/compatibility-migration-failure-journal.js'
import {
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID,
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES,
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE,
  applyCompatibilityMigrationTelemetryMigration,
  assertCompatibilityMigrationTelemetrySchemaCompatible,
  queryCompatibilityMigrationTelemetryDaily,
  queryCompatibilityMigrationTelemetrySummary,
  queryCompatibilityMigrationWriterObservation,
  refreshCompatibilityMigrationTelemetryCollectorEpoch,
  rollupCompatibilityMigrationTelemetry,
  sealCompletedCompatibilityMigrationTelemetryDay,
} from '../src/agent-os/compatibility-migration-telemetry.js'
import { openDb } from '../src/db.js'

const ZERO_HASH = '0'.repeat(64)
const tempDirs: string[] = []
const databases: Database.Database[] = []
const journals: CompatibilityMigrationFailureJournal[] = []

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close()
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

afterEach(() => {
  vi.useRealTimers()
})

function tempFiles(prefix: string): {
  directory: string
  main: string
  journal: string
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(directory)
  return {
    directory,
    main: path.join(directory, 'orchestra.db'),
    journal: path.join(directory, 'compatibility-failures.db'),
  }
}

function trackedDb(file: string): Database.Database {
  const db = openDb(file)
  databases.push(db)
  return db
}

function trackedJournal(
  db: Database.Database,
  journalPath: string,
  capacity = 16,
): CompatibilityMigrationFailureJournal {
  const journal = openCompatibilityMigrationFailureJournal(db, {
    journal_path: journalPath,
    capacity,
    runtime_instance: randomUUID(),
  })
  journals.push(journal)
  return journal
}

function failureInput(
  observedAt = '2025-04-01T12:00:00.000Z',
) {
  return {
    observed_at: new Date(observedAt),
    table: 'cards' as const,
    cohort: 'canonical_linked' as const,
    fallback_diagnostic: 'unexpected_failure' as const,
  }
}

function dropOwnedSchema(
  db: Database.Database,
  names: readonly string[],
): void {
  const placeholders = names.map(() => '?').join(',')
  const objects = db.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE name IN (${placeholders})
    ORDER BY CASE type
      WHEN 'trigger' THEN 1
      WHEN 'index' THEN 2
      ELSE 3
    END
  `).all(...names) as Array<{
    type: 'table' | 'index' | 'trigger'
    name: string
  }>
  for (const object of objects) {
    const name = `"${object.name.replaceAll('"', '""')}"`
    db.exec(`DROP ${object.type.toUpperCase()} IF EXISTS ${name}`)
  }
}

function reinstallTelemetryAt(
  db: Database.Database,
  appliedAt: string,
): void {
  dropOwnedSchema(
    db,
    AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_SCHEMA_OBJECT_NAMES,
  )
  db.prepare('DELETE FROM os_schema_migrations WHERE id=?')
    .run(AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID)
  dropOwnedSchema(
    db,
    AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES,
  )
  db.prepare('DELETE FROM os_schema_migrations WHERE id=?')
    .run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)

  applyCompatibilityMigrationTelemetryMigration(db)
  db.prepare(`
    INSERT INTO os_schema_migrations (id, applied_at) VALUES (?, ?)
  `).run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID, appliedAt)
  applyCompatibilityMigrationFailureJournalMigration(db)
  db.prepare(`
    INSERT INTO os_schema_migrations (id, applied_at) VALUES (?, ?)
  `).run(AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID, appliedAt)
  refreshCompatibilityMigrationTelemetryCollectorEpoch(db, {
    now: new Date(`${appliedAt.replace(' ', 'T')}Z`),
  })
}

function sidecarTableColumns(
  sidecar: Database.Database,
  table: string,
): string[] {
  return (sidecar.prepare(`
    SELECT name FROM pragma_table_info(?) ORDER BY cid
  `).all(table) as Array<{ name: string }>).map(({ name }) => name)
}

describe('DOM-019 compatibility migration failure journal Phase A', () => {
  it('[audit 5] upgrades additively without entering the migration-023 matcher and rejects impossible days', () => {
    const files = tempFiles('orchestra-dom019-journal-schema-')
    const db = trackedDb(files.main)

    expect(db.prepare(`
      SELECT id FROM os_schema_migrations WHERE id=?
    `).get(AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID)).toEqual({
      id: AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID,
    })
    assertCompatibilityMigrationTelemetrySchemaCompatible(db)
    assertCompatibilityMigrationFailureJournalSchemaCompatible(db)
    applyCompatibilityMigrationFailureJournalMigration(db)

    const names = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN (${
        AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_SCHEMA_OBJECT_NAMES
          .map(() => '?').join(',')
      })
      ORDER BY name
    `).all(
      ...AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_SCHEMA_OBJECT_NAMES,
    ) as Array<{ name: string }>
    expect(names).toHaveLength(
      AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_SCHEMA_OBJECT_NAMES
        .length,
    )
    for (const { name } of names) {
      expect(name).not.toMatch(/^os_compatibility_migration_telemetry_/)
      expect(name).not.toMatch(/^idx_os_compatibility_telemetry_/)
      expect(name).not.toMatch(/^trg_os_compatibility_telemetry_/)
    }

    const journal = trackedJournal(db, files.journal)
    for (const invalid of ['2026-99-99', '2026-02-30', '2025-02-29']) {
      expect(() => journal.prepareDaySeal(invalid)).toThrow(TypeError)
      expect(() => journal.assertCoverageReceipts(invalid, invalid))
        .toThrow(TypeError)
    }
    expect(() => journal.assertCoverageReceipts(
      '2024-02-29',
      '2024-02-29',
    )).not.toThrow()
    const collector = db.prepare(`
      SELECT collector_schema_version
      FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get() as { collector_schema_version: number }
    db.function(
      'orchestra_compatibility_failure_journal_guard',
      () => 'seal-receipt',
    )
    const insertMainDay = db.prepare(`
      INSERT INTO ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE} (
        day, journal_generation, sealed_through_sequence,
        sealed_envelope_hash, collector_schema_version
      ) VALUES (?, ?, 0, ?, ?)
    `)
    for (const invalid of ['2026-99-99', '2026-02-30', '2025-02-29']) {
      expect(() => insertMainDay.run(
        invalid,
        journal.journal_generation,
        ZERO_HASH,
        collector.collector_schema_version,
      )).toThrow(/CHECK constraint failed/)
    }
    db.exec('BEGIN')
    expect(insertMainDay.run(
      '2024-02-29',
      journal.journal_generation,
      ZERO_HASH,
      collector.collector_schema_version,
    ).changes).toBe(1)
    db.exec('ROLLBACK')

    const sidecar = new Database(files.journal)
    const insertSidecarDay = sidecar.prepare(`
      INSERT INTO compatibility_failure_journal_day_seals (
        day, sealed_through_sequence, sealed_envelope_hash,
        collector_schema_version, sealed_at, seal_hash
      ) VALUES (?, 0, ?, ?, ?, ?)
    `)
    for (const invalid of ['2026-99-99', '2026-02-30', '2025-02-29']) {
      expect(() => insertSidecarDay.run(
        invalid,
        ZERO_HASH,
        collector.collector_schema_version,
        new Date().toISOString(),
        ZERO_HASH,
      )).toThrow(/CHECK constraint failed/)
    }
    sidecar.exec('BEGIN')
    expect(insertSidecarDay.run(
      '2024-02-29',
      ZERO_HASH,
      collector.collector_schema_version,
      new Date().toISOString(),
      ZERO_HASH,
    ).changes).toBe(1)
    sidecar.exec('ROLLBACK')
    sidecar.close()
  })

  it('[audit 6] keeps the sidecar STRICT, mode-0600, and limited to privacy-safe bounded fields', () => {
    const files = tempFiles('orchestra-dom019-journal-privacy-')
    const db = trackedDb(files.main)
    const journal = trackedJournal(db, files.journal)

    expect(fs.statSync(files.journal).mode & 0o777).toBe(0o600)
    expect(journal.durabilityProfile()).toEqual({
      journal_mode: 'delete',
      synchronous: 3,
      fullfsync: 1,
      cell_size_check: 1,
      secure_delete: 1,
    })
    const sidecar = new Database(files.journal)
    const strict = new Map(
      (sidecar.prepare(`
        SELECT name, strict FROM pragma_table_list
        WHERE name LIKE 'compatibility_failure_journal_%'
      `).all() as Array<{ name: string; strict: number }>)
        .map(({ name, strict }) => [name, strict]),
    )
    expect([...strict.values()]).toEqual([1, 1, 1, 1, 1])
    expect(sidecarTableColumns(
      sidecar,
      'compatibility_failure_journal_state',
    )).toEqual([
      'singleton',
      'schema_version',
      'journal_generation',
      'binding_state',
      'journal_binding',
      'activated_day',
      'capacity',
      'next_sequence',
      'pruned_through_sequence',
      'pruned_envelope_hash',
      'last_envelope_hash',
      'last_observed_day',
    ])
    expect(sidecarTableColumns(
      sidecar,
      'compatibility_failure_journal_sessions',
    )).toEqual([
      'producer_instance',
      'process_id',
      'process_identity',
      'opened_at',
      'closed_at',
    ])
    expect(sidecarTableColumns(
      sidecar,
      'compatibility_failure_journal_attempts',
    )).toEqual([
      'sequence',
      'previous_envelope_hash',
      'envelope_hash',
      'observed_day',
      'table_name',
      'cohort',
      'fallback_diagnostic',
      'producer_instance',
      'reserved_at',
      'operation_returned_at',
      'return_marker_hash',
    ])
    expect(sidecarTableColumns(
      sidecar,
      'compatibility_failure_journal_failures',
    )).toEqual([
      'sequence',
      'diagnostic_code',
      'failed_at',
      'outcome_hash',
    ])
    const allColumns = (sidecar.prepare(`
      SELECT columns.name AS name
      FROM pragma_table_list AS tables
      JOIN pragma_table_info(tables.name) AS columns
      WHERE tables.name LIKE 'compatibility_failure_journal_%'
    `).all() as Array<{ name: string }>).map(({ name }) => name)
    for (const column of allColumns) {
      expect(column).not.toMatch(
        /(?:raw|error|message|payload|content|source|path|value|token|key)/i,
      )
    }
    const mainStrict = db.prepare(`
      SELECT name, strict FROM pragma_table_list
      WHERE name IN (?, ?, ?)
      ORDER BY name
    `).all(
      AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE,
      AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE,
      AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE,
    ) as Array<{ name: string; strict: number }>
    expect(mainStrict.map(({ strict: value }) => value)).toEqual([1, 1, 1])
    expect((db.prepare(`
      SELECT name
      FROM pragma_table_info(?)
      ORDER BY cid
    `).all(
      AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE,
    ) as Array<{ name: string }>).map(({ name }) => name)).toEqual([
      'singleton',
      'journal_generation',
      'journal_binding',
      'activated_day',
      'applied_through_sequence',
      'applied_envelope_hash',
    ])
    sidecar.close()
  })

  it('[audit 7] fails capacity before the domain callback can run', () => {
    const files = tempFiles('orchestra-dom019-journal-capacity-')
    const db = trackedDb(files.main)
    const journal = trackedJournal(db, files.journal, 2)
    let domainRuns = 0
    const execute = () => {
      const reservation = journal.reserve(failureInput())
      domainRuns += 1
      return reservation
    }

    execute()
    execute()
    expect(() => execute())
      .toThrow(CompatibilityMigrationFailureJournalCapacityError)
    expect(domainRuns).toBe(2)
    expect(() => journal.drain()).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'pending_attempt',
      }),
    )
  })

  it('[audit 8] imports a durable FAILED envelope exactly once and prunes only after the main high-water commits', () => {
    const files = tempFiles('orchestra-dom019-journal-failure-')
    const db = trackedDb(files.main)
    const journal = trackedJournal(db, files.journal)
    const reservation = journal.reserve(failureInput())
    journal.markFailed(reservation, 'database_locked')

    const daily = queryCompatibilityMigrationTelemetryDaily(db, {
      from_day: '2025-04-01',
      through_day: '2025-04-01',
      table: 'cards',
    }, journal)
    expect(daily.failure_count).toBe(1)
    expect(daily.rows).toEqual([
      expect.objectContaining({
        day: '2025-04-01',
        table: 'cards',
        operation: 'failure',
        diagnostic_code: 'database_locked',
        count: 1,
      }),
    ])
    expect(journal.drain()).toMatchObject({
      applied_through_sequence: reservation.sequence,
      failures_imported: 0,
      successes_reconciled: 0,
      attempts_pruned: 0,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(db, journal))
      .toMatchObject({ failure_count: 1 })

    const sidecar = new Database(files.journal)
    expect(sidecar.prepare(`
      SELECT COUNT(*) AS count
      FROM compatibility_failure_journal_attempts
    `).get()).toEqual({ count: 0 })
    expect(sidecar.prepare(`
      SELECT pruned_through_sequence, pruned_envelope_hash
      FROM compatibility_failure_journal_state
    `).get()).toEqual({
      pruned_through_sequence: reservation.sequence,
      pruned_envelope_hash: reservation.envelope_hash,
    })
    sidecar.close()
  })

  it('[audit 9] reconciles a success receipt committed with its outer transaction without importing a failure', () => {
    const files = tempFiles('orchestra-dom019-journal-success-')
    const db = trackedDb(files.main)
    const journal = trackedJournal(db, files.journal)
    let reservation: ReturnType<typeof journal.reserve> | undefined

    db.transaction(() => {
      reservation = journal.reserve(failureInput())
      journal.recordSuccessReceipt(reservation)
    }).immediate()
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
    `).get()).toEqual({ count: 1 })
    expect(journal.drain()).toMatchObject({
      applied_through_sequence: reservation?.sequence,
      failures_imported: 0,
      successes_reconciled: 1,
      attempts_pruned: 1,
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
    `).get()).toEqual({ count: 0 })
    expect(queryCompatibilityMigrationTelemetrySummary(db, journal))
      .toMatchObject({ failure_count: 0 })
  })

  it('[audit 10] resolves returned rollback and caught-failure lifecycles while the producer remains alive', () => {
    const files = tempFiles('orchestra-dom019-journal-rollback-')
    const db = trackedDb(files.main)
    const journal = trackedJournal(db, files.journal)

    let rolledBack: ReturnType<typeof journal.reserve> | undefined
    expect(() => db.transaction(() => {
      rolledBack = journal.reserve(failureInput())
      journal.recordSuccessReceipt(rolledBack)
      throw new Error('bounded rollback sentinel')
    }).immediate()).toThrow('bounded rollback sentinel')
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
    `).get()).toEqual({ count: 0 })
    expect(journal.drain()).toMatchObject({
      applied_through_sequence: 1,
      failures_imported: 1,
      successes_reconciled: 0,
      attempts_pruned: 1,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(db, journal))
      .toMatchObject({ failure_count: 1 })

    let caught: ReturnType<typeof journal.reserve> | undefined
    db.transaction(() => {
      caught = journal.reserve(failureInput())
      try {
        throw new Error('caught domain failure')
      } catch {
        journal.markFailed(caught, 'translation_rejected')
      }
    }).immediate()
    expect(journal.drain()).toMatchObject({
      applied_through_sequence: 2,
      failures_imported: 1,
      attempts_pruned: 1,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(db, journal))
      .toMatchObject({ failure_count: 2 })
    expect(journal.drain()).toMatchObject({
      failures_imported: 0,
      successes_reconciled: 0,
    })
  })

  it('[audit 11] orders concurrent producers and fails closed while the first RESERVED attempt remains active', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-03-31T12:00:00.000Z'))
    const files = tempFiles('orchestra-dom019-journal-concurrency-')
    const db = trackedDb(files.main)
    const first = trackedJournal(db, files.journal)
    const second = trackedJournal(db, files.journal)
    const firstReservation = first.reserve(failureInput())
    const secondReservation = second.reserve(failureInput(
      '2025-04-02T12:00:00.000Z',
    ))

    expect([
      firstReservation.sequence,
      secondReservation.sequence,
    ]).toEqual([1, 2])
    expect(() => second.drain()).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'pending_attempt',
      }),
    )
    first.markFailed(firstReservation, 'translation_rejected')
    vi.setSystemTime(new Date('2025-04-03T12:00:00.000Z'))
    expect(first.prepareDaySeal('2025-04-01')).toMatchObject({
      sealed_through_sequence: firstReservation.sequence,
      sealed_envelope_hash: firstReservation.envelope_hash,
    })
    expect(() => second.drain()).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'pending_attempt',
      }),
    )
    second.markFailed(secondReservation, 'projection_refresh_rejected')
    expect(first.drain()).toMatchObject({
      applied_through_sequence: 2,
      failures_imported: 1,
      attempts_pruned: 1,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(db, first))
      .toMatchObject({ failure_count: 2 })
  })

  it('[audit 12] seals against an immutable sidecar barrier and rejects unreceipted coverage before writer observation or rollup', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T12:00:00.000Z'))
    const files = tempFiles('orchestra-dom019-journal-seal-')
    const db = trackedDb(files.main)
    reinstallTelemetryAt(db, '2025-01-01 00:00:00')
    const journal = trackedJournal(db, files.journal)
    const failure = journal.reserve(failureInput(
      '2025-01-02T12:00:00.000Z',
    ))
    journal.markFailed(failure, 'schema_incompatible')
    journal.drain()
    const futureAttempt = journal.reserve(failureInput(
      '2025-01-03T12:00:00.000Z',
    ))
    vi.setSystemTime(new Date('2025-01-04T12:00:00.000Z'))
    expect(journal.prepareDaySeal('2025-01-02')).toMatchObject({
      sealed_through_sequence: failure.sequence,
      sealed_envelope_hash: failure.envelope_hash,
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE}
    `).get()).toEqual({ count: 0 })

    sealCompletedCompatibilityMigrationTelemetryDay(
      db,
      '2025-01-02',
      journal,
    )
    expect(db.prepare(`
      SELECT day, journal_generation, sealed_through_sequence,
        sealed_envelope_hash, collector_schema_version
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE}
      WHERE day='2025-01-02'
    `).get()).toEqual({
      day: '2025-01-02',
      journal_generation: journal.journal_generation,
      sealed_through_sequence: failure.sequence,
      sealed_envelope_hash: failure.envelope_hash,
      collector_schema_version: Number(
        db.pragma('schema_version', { simple: true }),
      ),
    })
    journal.recordSuccessReceipt(futureAttempt)
    expect(journal.drain()).toMatchObject({
      applied_through_sequence: futureAttempt.sequence,
      successes_reconciled: 1,
    })
    expect(queryCompatibilityMigrationWriterObservation(db, {
      table: 'cards',
      from_day: '2025-01-02',
      through_day: '2025-01-02',
    }, journal)).toMatchObject({
      covered_days: 1,
      failure_count: 1,
      status: 'diagnostic_risk_observed',
    })
    expect(() => journal.reserve(failureInput(
      '2025-01-02T23:59:59.000Z',
    ))).toThrow(
      expect.objectContaining({ reason: 'day_already_sealed' }),
    )
    expect(rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-05-01T00:00:00.000Z'),
      retain_days: 90,
    }, journal)).toMatchObject({
      compacted_through_day: '2025-01-02',
      count_compacted: 1,
      failure_count_compacted: 1,
    })

    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-01-03')
    expect(() => queryCompatibilityMigrationWriterObservation(db, {
      table: 'cards',
      from_day: '2025-01-02',
      through_day: '2025-01-03',
    }, journal)).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'coverage_receipt_missing',
      }),
    )
    expect(() => rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-05-02T00:00:00.000Z'),
      retain_days: 90,
    }, journal)).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'coverage_receipt_missing',
      }),
    )
  })

  it('[audit 13] preserves a failure beside a held WAL writer, then imports it after release and detects malformed replay state', () => {
    const files = tempFiles('orchestra-dom019-journal-held-wal-')
    const db = trackedDb(files.main)
    db.pragma('busy_timeout = 25')
    const journal = trackedJournal(db, files.journal)
    const locker = new Database(files.main)
    locker.pragma('journal_mode = WAL')
    locker.pragma('busy_timeout = 25')
    locker.exec('BEGIN IMMEDIATE')

    const reservation = journal.reserve(failureInput())
    journal.markFailed(reservation, 'database_locked')
    expect(() => journal.drain()).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'reconcile_blocked',
      }),
    )
    const sidecar = new Database(files.journal)
    expect(sidecar.prepare(`
      SELECT COUNT(*) AS count
      FROM compatibility_failure_journal_failures
    `).get()).toEqual({ count: 1 })
    sidecar.close()
    locker.exec('ROLLBACK')
    locker.close()

    expect(journal.drain()).toMatchObject({
      failures_imported: 1,
      attempts_pruned: 1,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(db, journal))
      .toMatchObject({ failure_count: 1 })

    const malformed = journal.reserve(failureInput(
      '2025-04-03T12:00:00.000Z',
    ))
    journal.close()
    const raw = new Database(files.journal)
    raw.pragma('ignore_check_constraints = ON')
    raw.prepare(`
      UPDATE compatibility_failure_journal_attempts
      SET envelope_hash=?
      WHERE sequence=?
    `).run('f'.repeat(64), malformed.sequence)
    raw.close()
    const reopened = trackedJournal(db, files.journal)
    expect(() => reopened.drain()).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'envelope_chain_malformed',
      }),
    )
  })

  it('[review P1] leaves a returned attempt unpoisoned while its success receipt is uncommitted', () => {
    const files = tempFiles('orchestra-dom019-journal-return-race-')
    const writerDb = trackedDb(files.main)
    const drainerDb = trackedDb(files.main)
    writerDb.pragma('busy_timeout = 25')
    drainerDb.pragma('busy_timeout = 25')
    const writer = trackedJournal(writerDb, files.journal)
    const drainer = trackedJournal(drainerDb, files.journal)

    writerDb.exec('BEGIN IMMEDIATE')
    const reservation = writer.reserve(failureInput())
    writer.recordSuccessReceipt(reservation)
    expect(() => drainer.drain()).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'reconcile_blocked',
      }),
    )

    const sidecar = new Database(files.journal)
    expect(sidecar.prepare(`
      SELECT COUNT(*) AS count
      FROM compatibility_failure_journal_failures
    `).get()).toEqual({ count: 0 })
    sidecar.close()

    writerDb.exec('COMMIT')
    expect(drainer.drain()).toMatchObject({
      applied_through_sequence: reservation.sequence,
      failures_imported: 0,
      successes_reconciled: 1,
      attempts_pruned: 1,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(drainerDb, drainer))
      .toMatchObject({ failure_count: 0 })
  })

  it('[rereview P1] locks main before publishing the returned-success marker', () => {
    const files = tempFiles('orchestra-dom019-journal-return-marker-race-')
    const writerDb = trackedDb(files.main)
    const drainerDb = trackedDb(files.main)
    writerDb.pragma('busy_timeout = 25')
    drainerDb.pragma('busy_timeout = 25')
    const writer = trackedJournal(writerDb, files.journal)
    const drainer = trackedJournal(drainerDb, files.journal)
    const reservation = writer.reserve(failureInput())
    const originalPrepare = Database.prototype.prepare
    let interleavedResult:
      ReturnType<CompatibilityMigrationFailureJournal['drain']> | undefined
    let interleavedError: unknown

    Database.prototype.prepare = function (
      this: Database.Database,
      source: string,
    ) {
      const statement = originalPrepare.call(this, source)
      const normalized = source.replace(/\s+/g, ' ').trim()
      if (
        normalized !==
          'UPDATE compatibility_failure_journal_attempts'
          + ' SET operation_returned_at=?, return_marker_hash=?'
          + ' WHERE sequence=?'
          + ' AND envelope_hash=?'
          + ' AND operation_returned_at IS NULL'
          + ' AND return_marker_hash IS NULL'
      ) {
        return statement
      }
      const mutable = statement as unknown as {
        run: (...parameters: unknown[]) => unknown
      }
      const originalRun = mutable.run.bind(mutable)
      mutable.run = (...parameters: unknown[]) => {
        const result = originalRun(...parameters)
        try {
          interleavedResult = drainer.drain()
        } catch (error) {
          interleavedError = error
        }
        return result
      }
      return statement
    } as typeof Database.prototype.prepare

    try {
      writer.recordSuccessReceipt(reservation)
    } finally {
      Database.prototype.prepare = originalPrepare
    }

    expect(interleavedResult).toBeUndefined()
    expect(interleavedError).toEqual(expect.objectContaining({
      code: 'evidence_incomplete',
      reason: 'reconcile_blocked',
    }))
    expect(drainer.drain()).toMatchObject({
      applied_through_sequence: reservation.sequence,
      failures_imported: 0,
      successes_reconciled: 1,
      attempts_pruned: 1,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(drainerDb, drainer))
      .toMatchObject({ failure_count: 0 })
    expect(writerDb.prepare(`
      SELECT COUNT(*) AS count
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
    `).get()).toEqual({ count: 0 })
  })

  it('[rereview P1] rejects orphan success receipts at applied high water', () => {
    const files = tempFiles('orchestra-dom019-journal-orphan-receipt-')
    const db = trackedDb(files.main)
    const journal = trackedJournal(db, files.journal)
    const reservation = journal.reserve(failureInput())
    journal.recordSuccessReceipt(reservation)
    expect(journal.drain()).toMatchObject({
      applied_through_sequence: reservation.sequence,
      successes_reconciled: 1,
    })

    db.function(
      'orchestra_compatibility_failure_journal_guard',
      () => 'success-receipt',
    )
    db.prepare(`
      INSERT INTO ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE} (
        journal_generation, sequence, envelope_hash
      ) VALUES (?, ?, ?)
    `).run(
      journal.journal_generation,
      reservation.sequence,
      reservation.envelope_hash,
    )

    expect(() => journal.drain()).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'receipt_mismatch',
      }),
    )
  })

  it('[review P1] refuses receipts for coverage sealed before journal activation', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-02-02T12:00:00.000Z'))
    const files = tempFiles('orchestra-dom019-journal-retroactive-seal-')
    const db = trackedDb(files.main)
    reinstallTelemetryAt(db, '2025-01-01 00:00:00')
    const days = Array.from(
      { length: 30 },
      (_, index) => `2025-01-${String(index + 2).padStart(2, '0')}`,
    )
    for (const day of days) {
      sealCompletedCompatibilityMigrationTelemetryDay(db, day)
    }

    const journal = trackedJournal(db, files.journal)
    expect(() => {
      for (const day of days) {
        sealCompletedCompatibilityMigrationTelemetryDay(db, day, journal)
      }
    }).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'coverage_receipt_missing',
      }),
    )
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_DAY_SEAL_RECEIPTS_TABLE}
    `).get()).toEqual({ count: 0 })
    expect(() => queryCompatibilityMigrationWriterObservation(db, {
      table: 'cards',
      from_day: days[0],
      through_day: days.at(-1),
    }, journal)).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'coverage_receipt_missing',
      }),
    )
  })

  it('[review P1] rejects a bound seal-only sidecar copied to an uninitialized main database', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T12:00:00.000Z'))
    const sourceFiles = tempFiles('orchestra-dom019-journal-bound-source-')
    const sourceDb = trackedDb(sourceFiles.main)
    reinstallTelemetryAt(sourceDb, '2025-01-01 00:00:00')
    const sourceJournal = trackedJournal(sourceDb, sourceFiles.journal)
    vi.setSystemTime(new Date('2025-01-03T12:00:00.000Z'))
    sourceJournal.prepareDaySeal('2025-01-02')
    sourceJournal.close()

    const targetFiles = tempFiles('orchestra-dom019-journal-bound-target-')
    const targetDb = trackedDb(targetFiles.main)
    fs.copyFileSync(sourceFiles.journal, targetFiles.journal)
    let openingError: unknown
    try {
      journals.push(openCompatibilityMigrationFailureJournal(targetDb, {
        journal_path: targetFiles.journal,
        capacity: 16,
        runtime_instance: randomUUID(),
      }))
    } catch (error) {
      openingError = error
    }
    expect(openingError).toEqual(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'binding_uninitialized',
      }),
    )
    expect(targetDb.prepare(`
      SELECT COUNT(*) AS count
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE}
    `).get()).toEqual({ count: 0 })

    const copied = new Database(targetFiles.journal)
    copied.prepare(`
      UPDATE compatibility_failure_journal_state
      SET binding_state='unbound', journal_binding=NULL, activated_day=NULL
      WHERE singleton=1
    `).run()
    copied.close()
    let unboundEvidenceError: unknown
    try {
      journals.push(openCompatibilityMigrationFailureJournal(targetDb, {
        journal_path: targetFiles.journal,
        capacity: 16,
        runtime_instance: randomUUID(),
      }))
    } catch (error) {
      unboundEvidenceError = error
    }
    expect(unboundEvidenceError).toEqual(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'binding_uninitialized',
      }),
    )
    expect(targetDb.prepare(`
      SELECT COUNT(*) AS count
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE}
    `).get()).toEqual({ count: 0 })
  })

  it('[review P1] recovers a pristine main-first binding crash without accepting foreign evidence', () => {
    const files = tempFiles('orchestra-dom019-journal-binding-recovery-')
    const db = trackedDb(files.main)
    const first = trackedJournal(db, files.journal)
    first.close()
    const mainState = db.prepare(`
      SELECT journal_binding, activated_day
      FROM ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE}
    `).get() as {
      journal_binding: string
      activated_day: string
    }

    const sidecar = new Database(files.journal)
    sidecar.prepare(`
      UPDATE compatibility_failure_journal_state
      SET binding_state='unbound', journal_binding=NULL, activated_day=NULL
      WHERE singleton=1
    `).run()
    sidecar.close()

    const recovered = trackedJournal(db, files.journal)
    expect(recovered.drain()).toMatchObject({
      applied_through_sequence: 0,
    })
    const rebound = new Database(files.journal)
    expect(rebound.prepare(`
      SELECT binding_state, journal_binding, activated_day
      FROM compatibility_failure_journal_state
    `).get()).toEqual({
      binding_state: 'bound',
      journal_binding: mainState.journal_binding,
      activated_day: mainState.activated_day,
    })
    rebound.close()
  })

  it('[review P2] reaps a crashed producer when its PID belongs to a different process lifetime', () => {
    const files = tempFiles('orchestra-dom019-journal-pid-reuse-')
    const db = trackedDb(files.main)
    const first = trackedJournal(db, files.journal)
    first.reserve(failureInput())
    first.close()

    const sidecar = new Database(files.journal)
    sidecar.prepare(`
      UPDATE compatibility_failure_journal_sessions
      SET process_id=?, process_identity=?, closed_at=NULL
    `).run(process.pid, 'f'.repeat(64))
    sidecar.close()

    const recovered = trackedJournal(db, files.journal)
    expect(recovered.drain()).toMatchObject({
      applied_through_sequence: 1,
      failures_imported: 1,
      attempts_pruned: 1,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(db, recovered))
      .toMatchObject({ failure_count: 1 })
  })

  it('[review P2] performs session reap, capacity check, and admission in one immediate transaction', () => {
    const files = tempFiles('orchestra-dom019-journal-session-atomic-')
    const db = trackedDb(files.main)
    const originalPrepare = Database.prototype.prepare
    let observedCountOutsideTransaction = false
    let reentering = false
    let interleaved: CompatibilityMigrationFailureJournal | undefined
    Database.prototype.prepare = function (
      this: Database.Database,
      source: string,
    ) {
      const statement = originalPrepare.call(this, source)
      const normalized = source.replace(/\s+/g, ' ').trim()
      if (
        normalized !==
          'SELECT COUNT(*) AS count'
          + ' FROM compatibility_failure_journal_sessions'
          + ' WHERE closed_at IS NULL'
      ) {
        return statement
      }
      const mutable = statement as unknown as {
        get: (...parameters: unknown[]) => unknown
      }
      const originalGet = mutable.get.bind(mutable)
      mutable.get = (...parameters: unknown[]) => {
        const result = originalGet(...parameters)
        if (!this.inTransaction && !reentering) {
          observedCountOutsideTransaction = true
          reentering = true
          try {
            interleaved = openCompatibilityMigrationFailureJournal(db, {
              journal_path: files.journal,
              capacity: 1,
              runtime_instance: randomUUID(),
            })
            journals.push(interleaved)
          } finally {
            reentering = false
          }
        }
        return result
      }
      return statement
    } as typeof Database.prototype.prepare

    try {
      journals.push(openCompatibilityMigrationFailureJournal(db, {
        journal_path: files.journal,
        capacity: 1,
        runtime_instance: randomUUID(),
      }))
    } finally {
      Database.prototype.prepare = originalPrepare
    }

    expect(observedCountOutsideTransaction).toBe(false)
    expect(interleaved).toBeUndefined()
    expect(() => openCompatibilityMigrationFailureJournal(db, {
      journal_path: files.journal,
      capacity: 1,
      runtime_instance: randomUUID(),
    })).toThrow(
      expect.objectContaining({ reason: 'session_capacity_exhausted' }),
    )
    const sidecar = new Database(files.journal)
    expect(sidecar.prepare(`
      SELECT COUNT(*) AS count
      FROM compatibility_failure_journal_sessions
      WHERE closed_at IS NULL
    `).get()).toEqual({ count: 1 })
    sidecar.close()
  })

  it('[review P3] rejects current and future direct seals without blocking a current reservation', () => {
    const files = tempFiles('orchestra-dom019-journal-future-seal-')
    const db = trackedDb(files.main)
    const journal = trackedJournal(db, files.journal)
    const today = new Date().toISOString().slice(0, 10)

    expect(() => journal.prepareDaySeal(today)).toThrow(RangeError)
    expect(() => journal.prepareDaySeal('2099-01-01')).toThrow(RangeError)
    const sidecar = new Database(files.journal)
    expect(sidecar.prepare(`
      SELECT COUNT(*) AS count
      FROM compatibility_failure_journal_day_seals
    `).get()).toEqual({ count: 0 })
    sidecar.close()
    expect(journal.reserve(failureInput(
      `${today}T12:00:00.000Z`,
    ))).toMatchObject({ sequence: 1 })
  })

  it('fails closed without creating a replacement for a missing or copied sidecar, then accepts the restored generation', () => {
    const firstFiles = tempFiles('orchestra-dom019-journal-restore-a-')
    const firstDb = trackedDb(firstFiles.main)
    const first = trackedJournal(firstDb, firstFiles.journal)
    first.close()
    const missingBackup = `${firstFiles.journal}.missing-backup`
    fs.renameSync(firstFiles.journal, missingBackup)

    expect(() => openCompatibilityMigrationFailureJournal(firstDb, {
      journal_path: firstFiles.journal,
      capacity: 16,
    })).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'sidecar_unavailable',
      }),
    )
    expect(fs.existsSync(firstFiles.journal)).toBe(false)
    fs.renameSync(missingBackup, firstFiles.journal)
    const restored = trackedJournal(firstDb, firstFiles.journal)
    expect(restored.drain()).toMatchObject({
      applied_through_sequence: 0,
    })
    restored.close()

    const secondFiles = tempFiles('orchestra-dom019-journal-restore-b-')
    const secondDb = trackedDb(secondFiles.main)
    const second = trackedJournal(secondDb, secondFiles.journal)
    second.close()
    const correctCopy = `${firstFiles.journal}.correct-copy`
    fs.copyFileSync(firstFiles.journal, correctCopy)
    fs.copyFileSync(secondFiles.journal, firstFiles.journal)
    expect(() => openCompatibilityMigrationFailureJournal(firstDb, {
      journal_path: firstFiles.journal,
      capacity: 16,
    })).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'generation_mismatch',
      }),
    )
    fs.copyFileSync(correctCopy, firstFiles.journal)
    expect(trackedJournal(firstDb, firstFiles.journal).drain())
      .toMatchObject({ applied_through_sequence: 0 })
  })

  it('recovers reserved-only dead producers and a committed main high-water left before sidecar prune', () => {
    const files = tempFiles('orchestra-dom019-journal-crash-windows-')
    const db = trackedDb(files.main)
    const first = trackedJournal(db, files.journal)
    first.reserve(failureInput())
    first.close()
    const crashedSession = new Database(files.journal)
    crashedSession.prepare(`
      UPDATE compatibility_failure_journal_sessions
      SET process_id=2147483647, closed_at=NULL
    `).run()
    crashedSession.close()

    const recovered = trackedJournal(db, files.journal)
    expect(recovered.drain()).toMatchObject({
      applied_through_sequence: 1,
      failures_imported: 1,
      attempts_pruned: 1,
    })
    const success = recovered.reserve(failureInput(
      '2025-04-02T12:00:00.000Z',
    ))
    recovered.recordSuccessReceipt(success)

    db.function(
      'orchestra_compatibility_failure_journal_guard',
      () => 'reconcile',
    )
    db.transaction(() => {
      expect(db.prepare(`
        UPDATE ${AGENT_OS_COMPATIBILITY_FAILURE_JOURNAL_STATE_TABLE}
        SET applied_through_sequence=?, applied_envelope_hash=?
        WHERE singleton=1 AND applied_through_sequence=1
      `).run(success.sequence, success.envelope_hash).changes).toBe(1)
      expect(db.prepare(`
        DELETE FROM ${AGENT_OS_COMPATIBILITY_FAILURE_SUCCESS_RECEIPTS_TABLE}
        WHERE journal_generation=? AND sequence=? AND envelope_hash=?
      `).run(
        recovered.journal_generation,
        success.sequence,
        success.envelope_hash,
      ).changes).toBe(1)
    }).immediate()

    expect(recovered.drain()).toMatchObject({
      applied_through_sequence: success.sequence,
      failures_imported: 0,
      successes_reconciled: 0,
      attempts_pruned: 1,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(db, recovered))
      .toMatchObject({ failure_count: 1 })
  })

  it('allows capacity-one recovery and reaps empty closed sessions without admission exhaustion', () => {
    const files = tempFiles('orchestra-dom019-journal-session-reap-')
    const db = trackedDb(files.main)
    const first = trackedJournal(db, files.journal, 1)
    expect(() => openCompatibilityMigrationFailureJournal(db, {
      journal_path: files.journal,
      capacity: 1,
      runtime_instance: randomUUID(),
    })).toThrow(
      expect.objectContaining({ reason: 'session_capacity_exhausted' }),
    )
    const admissionCheck = new Database(files.journal)
    expect(() => admissionCheck.prepare(`
      INSERT INTO compatibility_failure_journal_sessions (
        producer_instance, process_id, process_identity, opened_at, closed_at
      ) VALUES (?, 2147483648, ?, ?, NULL)
    `).run(
      randomUUID(),
      '0'.repeat(64),
      new Date().toISOString(),
    )).toThrow(/CHECK constraint failed/)
    expect(admissionCheck.prepare(`
      SELECT COUNT(*) AS count
      FROM compatibility_failure_journal_sessions
    `).get()).toEqual({ count: 1 })
    admissionCheck.close()
    first.reserve(failureInput())
    first.close()

    const recovery = trackedJournal(db, files.journal, 1)
    expect(recovery.drain()).toMatchObject({
      failures_imported: 1,
      attempts_pruned: 1,
    })
    recovery.close()
    const stale = new Database(files.journal)
    stale.prepare(`
      INSERT INTO compatibility_failure_journal_sessions (
        producer_instance, process_id, process_identity, opened_at, closed_at
      ) VALUES (?, 2147483647, ?, ?, NULL)
    `).run(
      randomUUID(),
      '0'.repeat(64),
      new Date().toISOString(),
    )
    stale.close()
    for (let index = 0; index < 8; index += 1) {
      trackedJournal(db, files.journal, 1).close()
    }
    const final = trackedJournal(db, files.journal, 1)
    expect(final.drain()).toMatchObject({
      applied_through_sequence: 1,
    })
    const sidecar = new Database(files.journal)
    expect(sidecar.prepare(`
      SELECT COUNT(*) AS count
      FROM compatibility_failure_journal_sessions
    `).get()).toEqual({ count: 1 })
    sidecar.close()
  })

  it('authenticates valid-value failure and day-seal outcomes against sidecar tamper', () => {
    const failureFiles = tempFiles('orchestra-dom019-journal-outcome-tamper-')
    const failureDb = trackedDb(failureFiles.main)
    const failureJournal = trackedJournal(
      failureDb,
      failureFiles.journal,
    )
    const reservation = failureJournal.reserve(failureInput())
    failureJournal.markFailed(reservation, 'database_locked')
    failureJournal.close()
    const rawFailure = new Database(failureFiles.journal)
    rawFailure.prepare(`
      UPDATE compatibility_failure_journal_failures
      SET diagnostic_code='schema_incompatible'
      WHERE sequence=?
    `).run(reservation.sequence)
    rawFailure.close()
    const reopenedFailure = trackedJournal(
      failureDb,
      failureFiles.journal,
    )
    expect(() => reopenedFailure.drain()).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'outcome_mismatch',
      }),
    )

    const sealFiles = tempFiles('orchestra-dom019-journal-seal-tamper-')
    const sealDb = trackedDb(sealFiles.main)
    reinstallTelemetryAt(sealDb, '2025-01-01 00:00:00')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T12:00:00.000Z'))
    const sealJournal = trackedJournal(sealDb, sealFiles.journal)
    vi.setSystemTime(new Date('2025-01-03T12:00:00.000Z'))
    sealJournal.prepareDaySeal('2025-01-02')
    sealJournal.close()
    const rawSeal = new Database(sealFiles.journal)
    rawSeal.prepare(`
      UPDATE compatibility_failure_journal_day_seals
      SET sealed_envelope_hash=?
      WHERE day='2025-01-02'
    `).run('f'.repeat(64))
    rawSeal.close()
    const reopenedSeal = trackedJournal(sealDb, sealFiles.journal)
    expect(() => reopenedSeal.prepareDaySeal('2025-01-02')).toThrow(
      expect.objectContaining({
        code: 'evidence_incomplete',
        reason: 'seal_mismatch',
      }),
    )
  })

  it('detects protected TEMP, main-schema, and sidecar-schema tamper', () => {
    const tempFilesForTamper = tempFiles(
      'orchestra-dom019-journal-temp-tamper-',
    )
    const tempDb = trackedDb(tempFilesForTamper.main)
    tempDb.exec(`
      CREATE TEMP TABLE os_compatibility_failure_shadow (value TEXT)
    `)
    expect(() => assertCompatibilityMigrationFailureJournalSchemaCompatible(
      tempDb,
    )).toThrow(
      expect.objectContaining({ reason: 'main_schema_incompatible' }),
    )

    const mainFiles = tempFiles('orchestra-dom019-journal-main-tamper-')
    const mainDb = trackedDb(mainFiles.main)
    mainDb.exec(`
      DROP TRIGGER trg_os_compatibility_failure_journal_state_update_guard
    `)
    expect(() => assertCompatibilityMigrationFailureJournalSchemaCompatible(
      mainDb,
    )).toThrow(
      expect.objectContaining({ reason: 'main_schema_incompatible' }),
    )

    const sidecarFiles = tempFiles(
      'orchestra-dom019-journal-sidecar-tamper-',
    )
    const sidecarDb = trackedDb(sidecarFiles.main)
    const sidecarJournal = trackedJournal(
      sidecarDb,
      sidecarFiles.journal,
    )
    sidecarJournal.close()
    const rawSidecar = new Database(sidecarFiles.journal)
    rawSidecar.exec(`
      CREATE TABLE compatibility_failure_journal_shadow (
        singleton INTEGER PRIMARY KEY
      ) STRICT, WITHOUT ROWID
    `)
    rawSidecar.close()
    expect(() => openCompatibilityMigrationFailureJournal(sidecarDb, {
      journal_path: sidecarFiles.journal,
      capacity: 16,
    })).toThrow(
      expect.objectContaining({ reason: 'sidecar_schema_incompatible' }),
    )
  })
})

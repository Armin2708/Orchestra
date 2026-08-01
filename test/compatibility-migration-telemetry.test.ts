import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb as openApplicationDb } from '../src/db.js'
import {
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID,
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_INTEGRITY_TRIGGER_NAMES,
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES,
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE,
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES,
  AGENT_OS_COMPATIBILITY_TELEMETRY_COHORTS,
  AGENT_OS_COMPATIBILITY_TELEMETRY_DIAGNOSTICS,
  AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS,
  AGENT_OS_COMPATIBILITY_TELEMETRY_MISMATCH_DIAGNOSTICS,
  AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS,
  AGENT_OS_COMPATIBILITY_TELEMETRY_RETENTION_RULE,
  AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS,
  AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_OPERATIONS,
  AGENT_OS_COMPATIBILITY_WRITER_OBSERVATION_RULE,
  applyCompatibilityMigrationTelemetryMigration,
  assertCompatibilityMigrationTelemetrySchemaCompatible,
  queryCompatibilityMigrationTelemetryDaily,
  queryCompatibilityMigrationTelemetrySummary,
  queryCompatibilityMigrationWriterObservation,
  recordCompatibilityMigrationTelemetry,
  refreshCompatibilityMigrationTelemetryCollectorEpoch,
  rollupCompatibilityMigrationTelemetry,
  sealCompletedCompatibilityMigrationTelemetryDay,
  type CompatibilityMigrationTelemetryObservation,
} from '../src/agent-os/compatibility-migration-telemetry.js'
import {
  AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
} from '../src/agent-os/compatibility-forward-migration.js'
import {
  AGENT_OS_LEGACY_COMPATIBILITY_TABLES,
} from '../src/agent-os/compatibility-projection-contract.js'

const DAILY_TABLE = 'os_compatibility_migration_telemetry_daily'
const HISTORY_TABLE = 'os_compatibility_migration_telemetry_history'
const COVERAGE_TABLE = 'os_compatibility_migration_telemetry_coverage'
const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function installTelemetry(
  db: Database.Database,
  appliedAt = '2025-01-01 00:00:00',
): void {
  applyCompatibilityMigrationTelemetryMigration(db)
  db.prepare(`
    INSERT OR IGNORE INTO os_schema_migrations (id, applied_at)
    VALUES (?, ?)
  `).run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID, appliedAt)
  const appliedAtUtc = appliedAt.endsWith('Z')
    ? appliedAt
    : `${appliedAt.replace(' ', 'T')}Z`
  refreshCompatibilityMigrationTelemetryCollectorEpoch(db, {
    now: new Date(appliedAtUtc),
  })
}

function openDbBeforeTelemetry(file: string): Database.Database {
  const db = openApplicationDb(file)
  const placeholders =
    AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES
      .map(() => '?')
      .join(',')
  const objects = db.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE name IN (${placeholders})
    ORDER BY CASE type
      WHEN 'trigger' THEN 1
      WHEN 'index' THEN 2
      ELSE 3
    END
  `).all(
    ...AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES,
  ) as Array<{
    type: 'table' | 'index' | 'trigger'
    name: string
  }>
  for (const object of objects) {
    const name = `"${object.name.replaceAll('"', '""')}"`
    db.exec(`DROP ${object.type.toUpperCase()} IF EXISTS ${name}`)
  }
  db.prepare('DELETE FROM os_schema_migrations WHERE id=?')
    .run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)
  return db
}

// Store-unit tests control the historical installation day explicitly. Integration coverage below
// uses openApplicationDb directly to exercise production migration registration and refresh.
const openDb = openDbBeforeTelemetry

function schemaObjectCount(db: Database.Database): number {
  const placeholders =
    AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES
      .map(() => '?')
      .join(',')
  return Number((db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE name IN (${placeholders})
  `).get(
    ...AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES,
  ) as { count: number }).count)
}

function dayOffset(day: string, offset: number): string {
  const value = new Date(`${day}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

function observation(
  overrides: Partial<CompatibilityMigrationTelemetryObservation> = {},
): CompatibilityMigrationTelemetryObservation {
  return {
    observed_at: new Date('2025-04-01T12:00:00.000Z'),
    table: 'cards',
    operation: 'canonical_read',
    cohort: 'canonical_linked',
    diagnostic_code: 'none',
    ...overrides,
  }
}

function tempDatabaseFile(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(directory)
  return path.join(directory, 'orchestra.db')
}

type StatementMethod = 'all' | 'get' | 'run'

function observeDatabaseStatements(
  db: Database.Database,
  observer: (
    sql: string,
    method: StatementMethod,
    inTransaction: boolean,
  ) => void,
): Database.Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql)
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              ) as unknown
              if (
                (
                  statementProperty === 'all'
                  || statementProperty === 'get'
                  || statementProperty === 'run'
                )
                && typeof value === 'function'
              ) {
                return (...args: unknown[]) => {
                  observer(
                    sql,
                    statementProperty,
                    target.inTransaction,
                  )
                  return Reflect.apply(value, statementTarget, args)
                }
              }
              return typeof value === 'function'
                ? value.bind(statementTarget)
                : value
            },
          })
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Database.Database
}

function insertAllLegacyRows(db: Database.Database): {
  boardId: number
  agentId: number
  cardId: number
  eventId: number
  messageId: number
  milestoneId: number
  ideaId: number
  reviewId: number
} {
  const boardId = Number(db.prepare(`
    INSERT INTO boards (project_path, name)
    VALUES ('/dom019-all-surfaces', 'DOM-019 all surfaces')
  `).run().lastInsertRowid)
  const agentId = Number(db.prepare(`
    INSERT INTO agents (board_id, name, provider)
    VALUES (?, 'dom019-agent', 'codex')
  `).run(boardId).lastInsertRowid)
  const cardId = Number(db.prepare(`
    INSERT INTO cards (board_id, title, description, owner_agent_id)
    VALUES (?, 'DOM-019 card', 'bounded fixture', ?)
  `).run(boardId, agentId).lastInsertRowid)
  const eventId = Number(db.prepare(`
    INSERT INTO card_events (card_id, agent_id, type, payload)
    VALUES (?, ?, 'updated', '{"bounded":true}')
  `).run(cardId, agentId).lastInsertRowid)
  db.prepare(`
    INSERT INTO task_contracts (
      card_id, objective, deliverables, acceptance_criteria,
      dependencies, verify_commands, non_goals, risks, updated_at
    ) VALUES (
      ?, 'Observe compatibility',
      '[{"id":"deliverable-1","text":"Counters","required":true}]',
      '[{"id":"criterion-1","text":"Bounded","required":true,"deliverable_ids":["deliverable-1"]}]',
      '[]', '["npm test"]', '[]', '[]', '2025-04-01T00:00:00.000Z'
    )
  `).run(cardId)
  db.prepare(`
    INSERT INTO agent_usage (
      board_id, agent_id, day, provider, total_tokens
    ) VALUES (?, ?, '2025-04-01', 'codex', 1)
  `).run(boardId, agentId)
  const messageId = Number(db.prepare(`
    INSERT INTO messages (board_id, kind, body)
    VALUES (?, 'notify', 'bounded transport fixture')
  `).run(boardId).lastInsertRowid)
  db.prepare(`
    INSERT INTO message_targets (message_id, agent_id) VALUES (?, ?)
  `).run(messageId, agentId)
  db.prepare(`
    INSERT INTO deliveries (message_id, agent_id) VALUES (?, ?)
  `).run(messageId, agentId)
  const milestoneId = Number(db.prepare(`
    INSERT INTO milestones (board_id, title)
    VALUES (?, 'Deferred planning')
  `).run(boardId).lastInsertRowid)
  const ideaId = Number(db.prepare(`
    INSERT INTO ideas (board_id, text)
    VALUES (?, 'Deferred roadmap')
  `).run(boardId).lastInsertRowid)
  const reviewId = Number(db.prepare(`
    INSERT INTO review_decisions (
      board_id, card_id, decision, note, decided_at
    ) VALUES (?, ?, 'approve', 'legacy review', '2025-04-01T00:00:00.000Z')
  `).run(boardId, cardId).lastInsertRowid)
  db.prepare(`
    INSERT INTO token_telemetry (
      board_id, agent_id, hook_event, day, chars, tokens, count
    ) VALUES (?, ?, 'session_start', '2025-04-01', 1, 1, 1)
  `).run(boardId, agentId)
  return {
    boardId,
    agentId,
    cardId,
    eventId,
    messageId,
    milestoneId,
    ideaId,
    reviewId,
  }
}

function updateAllLegacyRows(
  db: Database.Database,
  fixture: ReturnType<typeof insertAllLegacyRows>,
): void {
  db.prepare('UPDATE boards SET name=name WHERE id=?').run(fixture.boardId)
  db.prepare('UPDATE task_contracts SET objective=objective WHERE card_id=?')
    .run(fixture.cardId)
  db.prepare(`
    UPDATE agent_usage SET total_tokens=total_tokens
    WHERE board_id=? AND agent_id=? AND day='2025-04-01'
  `).run(fixture.boardId, fixture.agentId)
  db.prepare('UPDATE agents SET name=name WHERE id=?').run(fixture.agentId)
  db.prepare('UPDATE cards SET title=title WHERE id=?').run(fixture.cardId)
  db.prepare('UPDATE card_events SET type=type WHERE id=?').run(fixture.eventId)
  db.prepare('UPDATE messages SET body=body WHERE id=?').run(fixture.messageId)
  db.prepare(`
    UPDATE message_targets SET agent_id=agent_id
    WHERE message_id=? AND agent_id=?
  `).run(fixture.messageId, fixture.agentId)
  db.prepare(`
    UPDATE deliveries SET delivered_at=delivered_at
    WHERE message_id=? AND agent_id=?
  `).run(fixture.messageId, fixture.agentId)
  db.prepare('UPDATE milestones SET title=title WHERE id=?')
    .run(fixture.milestoneId)
  db.prepare('UPDATE ideas SET text=text WHERE id=?').run(fixture.ideaId)
  db.prepare('UPDATE review_decisions SET decision=decision WHERE id=?')
    .run(fixture.reviewId)
  db.prepare(`
    UPDATE token_telemetry SET count=count
    WHERE board_id=? AND agent_id=? AND hook_event='session_start'
      AND day='2025-04-01'
  `).run(fixture.boardId, fixture.agentId)
}

function deleteAllLegacyRows(
  db: Database.Database,
  fixture: ReturnType<typeof insertAllLegacyRows>,
): void {
  db.prepare('DELETE FROM task_contracts WHERE card_id=?').run(fixture.cardId)
  db.prepare(`
    DELETE FROM agent_usage
    WHERE board_id=? AND agent_id=? AND day='2025-04-01'
  `).run(fixture.boardId, fixture.agentId)
  db.prepare(`
    DELETE FROM token_telemetry
    WHERE board_id=? AND agent_id=? AND hook_event='session_start'
      AND day='2025-04-01'
  `).run(fixture.boardId, fixture.agentId)
  db.prepare('DELETE FROM review_decisions WHERE id=?').run(fixture.reviewId)
  db.prepare(`
    DELETE FROM deliveries WHERE message_id=? AND agent_id=?
  `).run(fixture.messageId, fixture.agentId)
  db.prepare(`
    DELETE FROM message_targets WHERE message_id=? AND agent_id=?
  `).run(fixture.messageId, fixture.agentId)
  db.prepare('DELETE FROM messages WHERE id=?').run(fixture.messageId)
  db.prepare('DELETE FROM card_events WHERE id=?').run(fixture.eventId)
  db.prepare('DELETE FROM ideas WHERE id=?').run(fixture.ideaId)
  db.prepare('DELETE FROM milestones WHERE id=?').run(fixture.milestoneId)
  db.prepare('DELETE FROM cards WHERE id=?').run(fixture.cardId)
  db.prepare('DELETE FROM agents WHERE id=?').run(fixture.agentId)
  db.prepare('DELETE FROM boards WHERE id=?').run(fixture.boardId)
}

describe('DOM-019 compatibility migration telemetry schema and store', () => {
  it('pins the exact 13 tables, eight operations, six cohorts, and bounded diagnostics', () => {
    expect(AGENT_OS_LEGACY_COMPATIBILITY_TABLES).toEqual([
      'boards',
      'task_contracts',
      'agent_usage',
      'agents',
      'cards',
      'card_events',
      'messages',
      'message_targets',
      'deliveries',
      'milestones',
      'ideas',
      'review_decisions',
      'token_telemetry',
    ])
    expect(AGENT_OS_COMPATIBILITY_TELEMETRY_OPERATIONS).toEqual([
      'legacy_read',
      'canonical_read',
      'legacy_write',
      'canonical_write',
      'adapter_translation',
      'projection_refresh',
      'mismatch',
      'failure',
    ])
    expect(AGENT_OS_COMPATIBILITY_TELEMETRY_COHORTS).toEqual([
      'shared_scope',
      'legacy_only',
      'canonical_linked',
      'canonical_unlinked',
      'migration_quarantined',
      'deferred_replacement',
    ])
    expect(AGENT_OS_COMPATIBILITY_TELEMETRY_DIAGNOSTICS).toEqual([
      'none',
      ...AGENT_OS_COMPATIBILITY_TELEMETRY_MISMATCH_DIAGNOSTICS,
      ...AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS,
    ])
    expect(new Set(AGENT_OS_COMPATIBILITY_TELEMETRY_DIAGNOSTICS).size)
      .toBe(12)
    expect(AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS).toEqual({
      boards: ['shared_scope'],
      task_contracts: [
        'canonical_linked',
        'canonical_unlinked',
        'migration_quarantined',
      ],
      agent_usage: [
        'canonical_linked',
        'canonical_unlinked',
        'migration_quarantined',
      ],
      agents: [
        'canonical_linked',
        'canonical_unlinked',
        'migration_quarantined',
      ],
      cards: [
        'canonical_linked',
        'canonical_unlinked',
        'migration_quarantined',
      ],
      card_events: [
        'canonical_linked',
        'canonical_unlinked',
        'migration_quarantined',
      ],
      messages: ['legacy_only'],
      message_targets: ['legacy_only'],
      deliveries: ['legacy_only'],
      milestones: ['deferred_replacement'],
      ideas: ['deferred_replacement'],
      review_decisions: [
        'canonical_linked',
        'canonical_unlinked',
        'migration_quarantined',
      ],
      token_telemetry: ['legacy_only'],
    })
    expect(Object.isFrozen(
      AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS,
    )).toBe(true)
    for (
      const cohorts of Object.values(
        AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_COHORTS,
      )
    ) {
      expect(Object.isFrozen(cohorts)).toBe(true)
    }
    expect(AGENT_OS_COMPATIBILITY_TELEMETRY_TABLE_OPERATIONS.messages)
      .toEqual([
        'legacy_read',
        'legacy_write',
        'adapter_translation',
        'failure',
      ])
    expect(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)
      .toBe('023-compatibility-migration-telemetry')
  })

  it('registers migration 023 and refreshes collector drift once at startup', () => {
    const file = tempDatabaseFile('orchestra-dom019-startup-')
    const today = new Date().toISOString().slice(0, 10)
    const first = openApplicationDb(file)
    expect(first.prepare(`
      SELECT id FROM os_schema_migrations WHERE id=?
    `).get(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)).toEqual({
      id: AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID,
    })
    expect(first.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations
    `).get()).toEqual({ count: 25 })
    expect(schemaObjectCount(first))
      .toBe(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES.length)
    const before = first.prepare(`
      SELECT installed_day, collector_schema_version, valid_from_day
      FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get() as {
      installed_day: string
      collector_schema_version: number
      valid_from_day: string
    }
    expect(before).toMatchObject({
      installed_day: today,
      valid_from_day: today,
    })
    first.close()

    const drift = new Database(file)
    const trigger =
      AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES[0]!
    const triggerSql = (drift.prepare(`
      SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?
    `).get(trigger) as { sql: string }).sql
    drift.exec(`DROP TRIGGER ${trigger}`)
    drift.exec(triggerSql)
    const driftedSchemaVersion =
      Number(drift.pragma('schema_version', { simple: true }))
    expect(driftedSchemaVersion).not.toBe(before.collector_schema_version)
    drift.close()

    const refreshed = openApplicationDb(file)
    const afterRefresh = refreshed.prepare(`
      SELECT installed_day, collector_schema_version, valid_from_day
      FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get()
    expect(afterRefresh).toEqual({
      installed_day: today,
      collector_schema_version: driftedSchemaVersion,
      valid_from_day: today,
    })
    expect(refreshed.prepare(`
      SELECT total_changes() AS count
    `).get()).toEqual({ count: 1 })
    refreshed.close()

    const stable = openApplicationDb(file)
    expect(stable.prepare(`
      SELECT installed_day, collector_schema_version, valid_from_day
      FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get()).toEqual(afterRefresh)
    expect(stable.prepare(`
      SELECT total_changes() AS count
    `).get()).toEqual({ count: 0 })
    stable.close()
  })

  it('applies idempotently after 022 and creates one exact 39-trigger set', () => {
    const db = openDb(':memory:')
    expect(db.prepare(`
      SELECT id FROM os_schema_migrations WHERE id=?
    `).get(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)).toEqual({
      id: AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    })

    expect(() => applyCompatibilityMigrationTelemetryMigration(db))
      .not.toThrow()
    expect(() => applyCompatibilityMigrationTelemetryMigration(db))
      .not.toThrow()
    expect(schemaObjectCount(db))
      .toBe(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES.length)
    expect(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES)
      .toHaveLength(13 * 3)
    expect(new Set(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES).size)
      .toBe(13 * 3)
    expect(
      AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_INTEGRITY_TRIGGER_NAMES,
    ).toHaveLength(14)
    expect(new Set(
      AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_INTEGRITY_TRIGGER_NAMES,
    ).size).toBe(14)
    expect(() => assertCompatibilityMigrationTelemetrySchemaCompatible(db))
      .not.toThrow()
    db.close()
  })

  it('keeps a stable collector epoch refresh read-only', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 00:00:00')
    const beforeState = db.prepare(`
      SELECT * FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get() as {
      installed_day: string
      collector_schema_version: number
      valid_from_day: string
    }
    const beforeChanges = db.prepare(`
      SELECT total_changes() AS count
    `).get() as { count: number }

    expect(refreshCompatibilityMigrationTelemetryCollectorEpoch(db, {
      now: new Date('2025-03-01T12:00:00.000Z'),
    })).toEqual({
      installed_day: '2025-01-01',
      collector_schema_version: beforeState.collector_schema_version,
      valid_from_day: '2025-01-01',
      refreshed: false,
    })
    expect(db.prepare(`
      SELECT total_changes() AS count
    `).get()).toEqual(beforeChanges)
    expect(db.prepare(`
      SELECT * FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get()).toEqual(beforeState)
    db.close()
  })

  it('keeps epoch reads unprivileged and forbids valid-from regression during refresh', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 00:00:00')
    const trigger =
      AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES[0]!
    const triggerSql = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?
    `).get(trigger) as { sql: string }).sql
    db.exec(`DROP TRIGGER ${trigger}`)
    db.exec(triggerSql)
    refreshCompatibilityMigrationTelemetryCollectorEpoch(db, {
      now: new Date('2025-02-01T12:00:00.000Z'),
    })

    let earlyAttempted = false
    let earlyError = ''
    const observed = observeDatabaseStatements(
      db,
      () => {
        if (earlyAttempted) return
        earlyAttempted = true
        try {
          db.prepare(`
            UPDATE ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
            SET valid_from_day='2025-01-01'
          `).run()
        } catch (error) {
          earlyError = String(error)
        }
      },
    )
    expect(refreshCompatibilityMigrationTelemetryCollectorEpoch(observed, {
      now: new Date('2025-02-02T12:00:00.000Z'),
    })).toMatchObject({
      valid_from_day: '2025-02-01',
      refreshed: false,
    })
    expect(earlyAttempted).toBe(true)
    expect(earlyError).toMatch(/state mutation is guarded/)
    expect(db.prepare(`
      SELECT valid_from_day
      FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get()).toEqual({ valid_from_day: '2025-02-01' })
    expect(() => sealCompletedCompatibilityMigrationTelemetryDay(
      db,
      '2025-02-01',
    )).toThrow(/must begin after the current collector epoch/)

    db.exec('CREATE TABLE dom019_epoch_drift (id INTEGER PRIMARY KEY)')
    let writeAttempted = false
    let writeError = ''
    const observedWrite = observeDatabaseStatements(
      db,
      (sql, method) => {
        if (
          writeAttempted
          || method !== 'run'
          || !sql.includes(
            `UPDATE ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}`,
          )
        ) return
        writeAttempted = true
        try {
          db.prepare(`
            UPDATE ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
            SET valid_from_day='2025-01-01'
          `).run()
        } catch (error) {
          writeError = String(error)
        }
      },
    )
    expect(refreshCompatibilityMigrationTelemetryCollectorEpoch(
      observedWrite,
      { now: new Date('2025-03-01T12:00:00.000Z') },
    )).toMatchObject({
      valid_from_day: '2025-03-01',
      refreshed: true,
    })
    expect(writeAttempted).toBe(true)
    expect(writeError).toMatch(/state mutation is guarded|cannot|monotonic/i)
    expect(db.prepare(`
      SELECT valid_from_day
      FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get()).toEqual({ valid_from_day: '2025-03-01' })
    db.close()
  })

  it('guards collector epoch state against every raw mutation shape', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    const before = db.prepare(`
      SELECT * FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get()
    const mutations = [
      `UPDATE ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
        SET collector_schema_version=collector_schema_version+1`,
      `DELETE FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}`,
      `INSERT OR REPLACE INTO
        ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
        SELECT * FROM
        ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}`,
    ]

    for (const mutation of mutations) {
      expect(() => db.exec(mutation))
        .toThrow(/compatibility telemetry .*state/i)
    }
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get()).toEqual({ count: 1 })
    expect(db.prepare(`
      SELECT * FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get()).toEqual(before)
    db.close()
  })

  it('requires marker 022 before creating any telemetry object', () => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM os_schema_migrations WHERE id=?')
      .run(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)

    const migrate = db.transaction(() => {
      applyCompatibilityMigrationTelemetryMigration(db)
      db.prepare('INSERT INTO os_schema_migrations (id) VALUES (?)')
        .run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)
    })
    expect(() => migrate()).toThrow(
      /requires 022-legacy-projection-forward-plan/,
    )
    expect(schemaObjectCount(db)).toBe(0)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?
    `).get(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID))
      .toEqual({ count: 0 })
    db.close()
  })

  it('uses the caller transaction and rolls all schema DDL back on later failure', () => {
    const db = openDb(':memory:')
    const outerMigration = db.transaction(() => {
      applyCompatibilityMigrationTelemetryMigration(db)
      db.prepare('INSERT INTO os_schema_migrations (id) VALUES (?)')
        .run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)
      throw new Error('simulated later migration failure')
    })

    expect(() => outerMigration()).toThrow(/simulated later migration failure/)
    expect(schemaObjectCount(db)).toBe(0)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?
    `).get(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID))
      .toEqual({ count: 0 })
    db.close()
  })

  it('fails closed on a partially preexisting or altered schema', () => {
    const partial = openDb(':memory:')
    partial.exec(`
      CREATE TABLE ${DAILY_TABLE} (
        day TEXT,
        arbitrary_detail TEXT
      )
    `)
    const migrate = partial.transaction(() => {
      applyCompatibilityMigrationTelemetryMigration(partial)
      partial.prepare('INSERT INTO os_schema_migrations (id) VALUES (?)')
        .run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)
    })
    expect(() => migrate()).toThrow(/incompatible .*telemetry_daily schema/)
    expect(schemaObjectCount(partial)).toBe(1)
    expect(partial.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?
    `).get(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID))
      .toEqual({ count: 0 })
    partial.close()

    const altered = openDb(':memory:')
    installTelemetry(altered)
    const trigger =
      AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES[0]
    altered.exec(`DROP TRIGGER ${trigger}`)
    expect(() => applyCompatibilityMigrationTelemetryMigration(altered))
      .toThrow(new RegExp(`incompatible ${trigger} schema`))
    altered.close()
  })

  it('preserves quoted-literal case during exact schema comparison', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    db.unsafeMode(true)
    db.pragma('writable_schema = ON')
    db.prepare(`
      UPDATE sqlite_master
      SET sql=replace(sql, '''legacy_only''', '''LEGACY_ONLY''')
      WHERE name=?
    `).run(DAILY_TABLE)
    db.pragma('writable_schema = OFF')
    db.unsafeMode(false)

    expect(() => assertCompatibilityMigrationTelemetrySchemaCompatible(db))
      .toThrow(new RegExp(`incompatible ${DAILY_TABLE} schema`))
    db.close()
  })

  it('forfeits transient trigger-drift days until the collector epoch refreshes', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 00:00:00')
    const trigger =
      AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES[0]!
    const triggerSql = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?
    `).get(trigger) as { sql: string }).sql
    const beforeEpoch = db.prepare(`
      SELECT collector_schema_version
      FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get() as { collector_schema_version: number }

    db.exec(`DROP TRIGGER ${trigger}`)
    db.prepare(`
      INSERT INTO boards (project_path, name)
      VALUES ('/dom019-transient-trigger-gap', 'Uncounted during gap')
    `).run()
    db.exec(triggerSql)
    expect(db.prepare(`
      SELECT COALESCE(SUM(count), 0) AS count
      FROM ${DAILY_TABLE}
      WHERE table_name='boards' AND operation='legacy_write'
    `).get()).toEqual({ count: 0 })

    const staleEpochError =
      /collector.*(?:schema|epoch).*(?:changed|refresh)|refresh.*collector/i
    expect(() => sealCompletedCompatibilityMigrationTelemetryDay(
      db,
      '2025-02-01',
    )).toThrow(staleEpochError)
    expect(() => queryCompatibilityMigrationWriterObservation(db, {
      table: 'boards',
      from_day: '2025-02-01',
      through_day: dayOffset('2025-02-01', 29),
    })).toThrow(staleEpochError)

    const refreshed =
      refreshCompatibilityMigrationTelemetryCollectorEpoch(db, {
        now: new Date('2025-02-02T12:00:00.000Z'),
      })
    expect(refreshed).toMatchObject({
      installed_day: '2025-01-01',
      valid_from_day: '2025-02-02',
      refreshed: true,
    })
    expect(refreshed.collector_schema_version)
      .not.toBe(beforeEpoch.collector_schema_version)
    for (const forfeitedDay of ['2025-02-01', '2025-02-02']) {
      expect(() => sealCompletedCompatibilityMigrationTelemetryDay(
        db,
        forfeitedDay,
      )).toThrow(/must begin after|collector epoch|valid_from/i)
    }

    expect(() => sealCompletedCompatibilityMigrationTelemetryDay(
      db,
      '2025-02-03',
    )).not.toThrow()
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ${COVERAGE_TABLE}
      WHERE day='2025-02-03'
    `).get()).toEqual({ count: 13 })
    db.close()
  })

  it('acknowledges a legacy write before a transient TEMP AFTER trigger suppresses later programs', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    const schemaVersion = Number(
      db.pragma('schema_version', { simple: true }),
    )
    db.exec(`
      CREATE TEMP TRIGGER test_dom019_temp_after_legacy
      AFTER INSERT ON main.boards
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `)

    db.prepare(`
      INSERT INTO boards (project_path, name)
      VALUES ('/dom019-temp-after', 'TEMP after')
    `).run()
    db.exec('DROP TRIGGER temp.test_dom019_temp_after_legacy')

    expect(Number(db.pragma('schema_version', { simple: true })))
      .toBe(schemaVersion)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM boards
      WHERE project_path='/dom019-temp-after'
    `).get()).toEqual({ count: 1 })
    expect(db.prepare(`
      SELECT SUM(count) AS count FROM ${DAILY_TABLE}
      WHERE table_name='boards' AND operation='legacy_write'
    `).get()).toEqual({ count: 1 })
    expect(() => assertCompatibilityMigrationTelemetrySchemaCompatible(db))
      .not.toThrow()
    db.close()
  })

  it('rolls a legacy mutation back when TEMP daily triggers suppress or rewrite its acknowledgment', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    db.exec(`
      CREATE TEMP TRIGGER test_dom019_temp_suppress_daily
      BEFORE INSERT ON main.${DAILY_TABLE}
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `)

    expect(() => db.prepare(`
      INSERT INTO boards (project_path, name)
      VALUES ('/dom019-temp-suppressed', 'TEMP suppressed')
    `).run()).toThrow(/collector write failed/)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM boards
      WHERE project_path='/dom019-temp-suppressed'
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ${DAILY_TABLE}
      WHERE table_name='boards' AND operation='legacy_write'
    `).get()).toEqual({ count: 0 })
    db.exec('DROP TRIGGER temp.test_dom019_temp_suppress_daily')

    db.exec(`
      CREATE TEMP TRIGGER test_dom019_temp_rewrite_daily
      AFTER INSERT ON main.${DAILY_TABLE}
      WHEN NEW.operation='legacy_write'
      BEGIN
        UPDATE ${DAILY_TABLE}
        SET operation='canonical_read'
        WHERE day=NEW.day
          AND table_name=NEW.table_name
          AND operation=NEW.operation
          AND cohort=NEW.cohort
          AND diagnostic_code=NEW.diagnostic_code;
      END
    `)
    expect(() => db.prepare(`
      INSERT INTO boards (project_path, name)
      VALUES ('/dom019-temp-rewritten', 'TEMP rewritten')
    `).run()).toThrow(/blocking evidence is monotonic/)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM boards
      WHERE project_path='/dom019-temp-rewritten'
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ${DAILY_TABLE}
      WHERE table_name='boards'
    `).get()).toEqual({ count: 0 })
    db.exec('DROP TRIGGER temp.test_dom019_temp_rewrite_daily')
    db.close()
  })

  it('rolls a repeated legacy write back when TEMP suppresses the collector update', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    const boardId = Number(db.prepare(`
      INSERT INTO boards (project_path, name)
      VALUES ('/dom019-temp-update', 'Before')
    `).run().lastInsertRowid)
    db.exec(`
      CREATE TEMP TRIGGER test_dom019_temp_suppress_daily_update
      BEFORE UPDATE ON main.${DAILY_TABLE}
      WHEN OLD.operation='legacy_write'
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `)

    expect(() => db.prepare(`
      UPDATE boards SET name='After' WHERE id=?
    `).run(boardId)).toThrow(/collector write failed/)
    expect(db.prepare(`
      SELECT name FROM boards WHERE id=?
    `).get(boardId)).toEqual({ name: 'Before' })
    expect(db.prepare(`
      SELECT count FROM ${DAILY_TABLE}
      WHERE table_name='boards' AND operation='legacy_write'
    `).get()).toEqual({ count: 1 })
    db.exec('DROP TRIGGER temp.test_dom019_temp_suppress_daily_update')
    db.close()
  })

  it('rejects active TEMP objects attached to protected telemetry surfaces', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    db.exec(`
      CREATE TEMP TRIGGER arbitrary_temp_board_trigger
      AFTER UPDATE ON main.boards
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `)

    expect(() => assertCompatibilityMigrationTelemetrySchemaCompatible(db))
      .toThrow(/protected TEMP schema object/)
    expect(() => queryCompatibilityMigrationTelemetryDaily(db, {
      from_day: '2025-02-01',
      through_day: '2025-02-01',
    })).toThrow(/protected TEMP schema object/)

    db.exec('DROP TRIGGER temp.arbitrary_temp_board_trigger')
    db.exec('CREATE TEMP TABLE BOARDS (arbitrary_detail TEXT)')
    expect(() => assertCompatibilityMigrationTelemetrySchemaCompatible(db))
      .toThrow(/protected TEMP schema object/)
    db.exec('DROP TABLE temp.BOARDS')
    expect(() => assertCompatibilityMigrationTelemetrySchemaCompatible(db))
      .not.toThrow()
    db.close()
  })

  it('keeps blocking evidence monotonic without a replaceable rowid', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 00:00:00')
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-02-01T12:00:00.000Z'),
      table: 'boards',
      operation: 'legacy_write',
      cohort: 'shared_scope',
      count: 5,
    }))

    expect(() => db.prepare(`
      SELECT rowid FROM ${DAILY_TABLE}
    `).all()).toThrow(/rowid/)
    expect(() => db.exec(`
      INSERT OR REPLACE INTO ${DAILY_TABLE} (
        day, table_name, operation, cohort, diagnostic_code, count
      )
      SELECT day, table_name, operation, cohort, diagnostic_code, 1
      FROM ${DAILY_TABLE}
      WHERE operation='legacy_write'
    `)).toThrow(/blocking evidence cannot decrease/)
    expect(() => db.prepare(`
      UPDATE ${DAILY_TABLE}
      SET operation='canonical_read'
      WHERE operation='legacy_write'
    `).run()).toThrow(/blocking evidence is monotonic/)
    expect(() => db.prepare(`
      UPDATE ${DAILY_TABLE}
      SET count=count-1
      WHERE operation='legacy_write'
    `).run()).toThrow(/blocking evidence is monotonic/)
    expect(db.prepare(`
      UPDATE ${DAILY_TABLE}
      SET count=count+1
      WHERE operation='legacy_write'
    `).run().changes).toBe(1)

    db.exec(`
      INSERT OR REPLACE INTO ${DAILY_TABLE} (
        day, table_name, operation, cohort, diagnostic_code, count
      )
      SELECT day, table_name, 'canonical_read', cohort, 'none', count
      FROM ${DAILY_TABLE}
      WHERE operation='legacy_write'
    `)
    expect(db.prepare(`
      SELECT count FROM ${DAILY_TABLE}
      WHERE table_name='boards' AND operation='legacy_write'
    `).get()).toEqual({ count: 6 })

    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-02-01')
    expect(db.prepare(`
      SELECT legacy_write_count FROM ${COVERAGE_TABLE}
      WHERE day='2025-02-01' AND table_name='boards'
    `).get()).toEqual({ legacy_write_count: 6 })
    db.close()
  })

  it('rolls back a record when a reentrant TEMP trigger suppresses its exact write', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    let injected = false
    const observed = observeDatabaseStatements(
      db,
      (sql, method) => {
        if (
          !injected
          && method === 'run'
          && sql.includes(`INSERT INTO ${DAILY_TABLE}`)
        ) {
          injected = true
          db.exec(`
            CREATE TEMP TRIGGER test_dom019_reentrant_record_suppress
            BEFORE INSERT ON main.${DAILY_TABLE}
            BEGIN
              SELECT RAISE(IGNORE);
            END
          `)
        }
      },
    )

    expect(() => recordCompatibilityMigrationTelemetry(
      observed,
      observation(),
    )).toThrow(/aggregation write was suppressed/)
    expect(injected).toBe(true)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ${DAILY_TABLE}
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_temp_master
      WHERE name='test_dom019_reentrant_record_suppress'
    `).get()).toEqual({ count: 0 })
    db.close()
  })

  it('rolls back sealing when a reentrant TEMP trigger suppresses coverage', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 00:00:00')
    let injected = false
    const observed = observeDatabaseStatements(
      db,
      (sql, method) => {
        if (
          !injected
          && method === 'run'
          && sql.includes(`INSERT INTO ${COVERAGE_TABLE}`)
        ) {
          injected = true
          db.exec(`
            CREATE TEMP TRIGGER test_dom019_reentrant_seal_suppress
            BEFORE INSERT ON main.${COVERAGE_TABLE}
            BEGIN
              SELECT RAISE(IGNORE);
            END
          `)
        }
      },
    )

    expect(() => sealCompletedCompatibilityMigrationTelemetryDay(
      observed,
      '2025-01-02',
    )).toThrow(/coverage insert was suppressed/)
    expect(injected).toBe(true)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ${COVERAGE_TABLE}
      WHERE day='2025-01-02'
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_temp_master
      WHERE name='test_dom019_reentrant_seal_suppress'
    `).get()).toEqual({ count: 0 })
    db.close()
  })

  it('rolls back sealing when reentrant work changes a blocking snapshot', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 00:00:00')
    let injected = false
    const observed = observeDatabaseStatements(
      db,
      (sql, method) => {
        if (
          !injected
          && method === 'run'
          && sql.includes(`INSERT INTO ${COVERAGE_TABLE}`)
        ) {
          injected = true
          db.exec(`
            CREATE TEMP TRIGGER test_dom019_reentrant_seal_rewrite
            BEFORE INSERT ON main.${COVERAGE_TABLE}
            WHEN NEW.table_name='boards'
            BEGIN
              INSERT INTO ${DAILY_TABLE} (
                day, table_name, operation, cohort, diagnostic_code, count
              ) VALUES (
                NEW.day, 'boards', 'legacy_write', 'shared_scope', 'none', 1
              );
            END
          `)
        }
      },
    )

    expect(() => sealCompletedCompatibilityMigrationTelemetryDay(
      observed,
      '2025-01-02',
    )).toThrow(/coverage is immutable|snapshot/)
    expect(injected).toBe(true)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ${COVERAGE_TABLE}
      WHERE day='2025-01-02'
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ${DAILY_TABLE}
      WHERE day='2025-01-02'
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_temp_master
      WHERE name='test_dom019_reentrant_seal_rewrite'
    `).get()).toEqual({ count: 0 })
    db.close()
  })

  it('replays a lost 023 marker without duplicating triggers or counters', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    const boardId = Number(db.prepare(`
      INSERT INTO boards (project_path, name)
      VALUES ('/dom019-replay', 'Replay')
    `).run().lastInsertRowid)
    const before = db.prepare(`
      SELECT count FROM ${DAILY_TABLE}
      WHERE table_name='boards' AND operation='legacy_write'
    `).get()

    db.prepare('DELETE FROM os_schema_migrations WHERE id=?')
      .run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)
    const replay = db.transaction(() => {
      applyCompatibilityMigrationTelemetryMigration(db)
      db.prepare('INSERT INTO os_schema_migrations (id) VALUES (?)')
        .run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)
    })
    replay()

    expect(db.prepare(`
      SELECT count FROM ${DAILY_TABLE}
      WHERE table_name='boards' AND operation='legacy_write'
    `).get()).toEqual(before)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='trigger' AND name IN (
        ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES
          .map(() => '?')
          .join(',')}
      )
    `).get(
      ...AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES,
    )).toEqual({ count: 39 })
    db.prepare('UPDATE boards SET name=name WHERE id=?').run(boardId)
    expect(db.prepare(`
      SELECT count FROM ${DAILY_TABLE}
      WHERE table_name='boards' AND operation='legacy_write'
    `).get()).toEqual({ count: 2 })
    db.close()
  })

  it('keeps an existing sealed day idempotent after lost-marker replay', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 00:00:00')
    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-01-02')
    const beforeCoverage = db.prepare(`
      SELECT * FROM ${COVERAGE_TABLE}
      WHERE day='2025-01-02'
      ORDER BY table_name
    `).all()
    const beforeState = db.prepare(`
      SELECT * FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get()

    db.prepare('DELETE FROM os_schema_migrations WHERE id=?')
      .run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)
    const replay = db.transaction(() => {
      applyCompatibilityMigrationTelemetryMigration(db)
      db.prepare('INSERT INTO os_schema_migrations (id) VALUES (?)')
        .run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID)
    })
    replay()

    expect(() => sealCompletedCompatibilityMigrationTelemetryDay(
      db,
      '2025-01-02',
    )).not.toThrow()
    expect(db.prepare(`
      SELECT * FROM ${COVERAGE_TABLE}
      WHERE day='2025-01-02'
      ORDER BY table_name
    `).all()).toEqual(beforeCoverage)
    expect(db.prepare(`
      SELECT * FROM ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_STATE_TABLE}
    `).get()).toEqual(beforeState)
    db.close()
  })

  it('counts INSERT, UPDATE, and DELETE on every one of the 13 legacy tables', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    const fixture = insertAllLegacyRows(db)
    updateAllLegacyRows(db, fixture)
    deleteAllLegacyRows(db, fixture)

    const coverage = db.prepare(`
      SELECT table_name AS "table", SUM(count) AS count
      FROM ${DAILY_TABLE}
      WHERE operation='legacy_write'
      GROUP BY table_name
      ORDER BY table_name
    `).all() as Array<{ table: string; count: number }>
    expect(coverage.map(({ table }) => table)).toEqual(
      [...AGENT_OS_LEGACY_COMPATIBILITY_TABLES].sort(),
    )
    for (const row of coverage) {
      expect(row.count, row.table).toBeGreaterThanOrEqual(3)
    }

    const triggerCoverage = db.prepare(`
      SELECT tbl_name AS "table", COUNT(*) AS count
      FROM sqlite_master
      WHERE type='trigger'
        AND name LIKE 'trg_os_compatibility_telemetry_%'
        AND tbl_name IN (
          ${AGENT_OS_LEGACY_COMPATIBILITY_TABLES.map(() => '?').join(',')}
        )
      GROUP BY tbl_name
      ORDER BY tbl_name
    `).all(...AGENT_OS_LEGACY_COMPATIBILITY_TABLES)
    expect(triggerCoverage).toEqual(
      [...AGENT_OS_LEGACY_COMPATIBILITY_TABLES]
        .sort()
        .map((table) => ({ table, count: 3 })),
    )
    db.close()
  })

  it('assigns only bounded static and link-aware trigger cohorts', () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare(`
      INSERT INTO boards (project_path, name)
      VALUES ('/dom019-cohorts', 'Cohorts')
    `).run().lastInsertRowid)
    const linkedCard = Number(db.prepare(`
      INSERT INTO cards (board_id, title)
      VALUES (?, 'Linked before telemetry')
    `).run(boardId).lastInsertRowid)
    const quarantinedCard = Number(db.prepare(`
      INSERT INTO cards (board_id, title)
      VALUES (?, 'Quarantined before telemetry')
    `).run(boardId).lastInsertRowid)
    db.prepare(`
      INSERT INTO os_compatibility_projection_links (
        migration_id, source_table, source_key, source_hash,
        target_table, target_key, target_hash, disposition
      ) VALUES (?, 'cards', ?, ?, 'cards', ?, ?, 'test_link')
    `).run(
      AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
      String(linkedCard),
      'a'.repeat(64),
      String(linkedCard),
      'b'.repeat(64),
    )
    db.prepare(`
      INSERT INTO os_compatibility_projection_quarantine (
        migration_id, source_table, source_key, source_hash,
        reason_code, safe_detail
      ) VALUES (?, 'cards', ?, ?, 'test_quarantine', 'bounded test')
    `).run(
      AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
      String(quarantinedCard),
      'c'.repeat(64),
    )
    installTelemetry(db)

    db.prepare('UPDATE boards SET name=name WHERE id=?').run(boardId)
    db.prepare('UPDATE cards SET title=title WHERE id=?').run(linkedCard)
    db.prepare('UPDATE cards SET title=title WHERE id=?').run(quarantinedCard)
    db.prepare(`
      INSERT INTO cards (board_id, title) VALUES (?, 'Unlinked after telemetry')
    `).run(boardId)
    db.prepare(`
      INSERT INTO messages (board_id, body) VALUES (?, 'legacy only')
    `).run(boardId)
    db.prepare(`
      INSERT INTO milestones (board_id, title) VALUES (?, 'deferred')
    `).run(boardId)

    expect(db.prepare(`
      SELECT table_name AS "table", cohort, SUM(count) AS count
      FROM ${DAILY_TABLE}
      GROUP BY table_name, cohort
      ORDER BY table_name, cohort
    `).all()).toEqual([
      { table: 'boards', cohort: 'shared_scope', count: 1 },
      { table: 'cards', cohort: 'canonical_linked', count: 1 },
      { table: 'cards', cohort: 'canonical_unlinked', count: 1 },
      { table: 'cards', cohort: 'migration_quarantined', count: 1 },
      { table: 'messages', cohort: 'legacy_only', count: 1 },
      { table: 'milestones', cohort: 'deferred_replacement', count: 1 },
    ])
    db.close()
  })

  it('enforces identical table/cohort and table/operation matrices in TypeScript', () => {
    const db = openDb(':memory:')
    installTelemetry(db)

    const invalid = [
      observation({ table: 'boards', cohort: 'canonical_linked' }),
      observation({ table: 'cards', cohort: 'shared_scope' }),
      observation({
        table: 'messages',
        operation: 'canonical_read',
        cohort: 'legacy_only',
      }),
      observation({
        table: 'message_targets',
        operation: 'canonical_write',
        cohort: 'legacy_only',
      }),
      observation({
        table: 'deliveries',
        operation: 'projection_refresh',
        cohort: 'legacy_only',
      }),
      observation({
        table: 'milestones',
        operation: 'mismatch',
        cohort: 'deferred_replacement',
        diagnostic_code: 'value_mismatch',
      }),
      observation({
        table: 'ideas',
        operation: 'canonical_read',
        cohort: 'deferred_replacement',
      }),
      observation({
        table: 'token_telemetry',
        operation: 'mismatch',
        cohort: 'legacy_only',
        diagnostic_code: 'scope_mismatch',
      }),
    ]
    for (const input of invalid) {
      expect(
        () => recordCompatibilityMigrationTelemetry(db, input),
      ).toThrow(/not supported for compatibility telemetry table/)
    }

    expect(recordCompatibilityMigrationTelemetry(db, observation({
      table: 'messages',
      operation: 'adapter_translation',
      cohort: 'legacy_only',
    }))).toMatchObject({
      table: 'messages',
      operation: 'adapter_translation',
      cohort: 'legacy_only',
      count: 1,
    })
    expect(recordCompatibilityMigrationTelemetry(db, observation({
      table: 'milestones',
      operation: 'failure',
      cohort: 'deferred_replacement',
      diagnostic_code: 'translation_rejected',
    }))).toMatchObject({
      table: 'milestones',
      operation: 'failure',
      cohort: 'deferred_replacement',
      count: 1,
    })
    db.close()
  })

  it('aggregates safely across restart without storing replay state in memory', () => {
    const file = tempDatabaseFile('orchestra-dom019-restart-')
    const first = openDb(file)
    installTelemetry(first)
    expect(recordCompatibilityMigrationTelemetry(first, observation({
      count: 2,
    }))).toMatchObject({ count: 2 })
    first.close()

    const reopened = new Database(file)
    expect(recordCompatibilityMigrationTelemetry(reopened, observation({
      count: 3,
    }))).toMatchObject({ count: 5 })
    expect(queryCompatibilityMigrationTelemetrySummary(reopened))
      .toMatchObject({
        total_count: 5,
        operation_totals: { canonical_read: 5 },
      })
    reopened.close()
  })

  it('uses atomic SQLite UPSERT behavior across two database connections', () => {
    const file = tempDatabaseFile('orchestra-dom019-connections-')
    const first = openDb(file)
    installTelemetry(first)
    const second = new Database(file)
    first.pragma('busy_timeout = 0')
    second.pragma('busy_timeout = 0')

    first.exec('BEGIN IMMEDIATE')
    recordCompatibilityMigrationTelemetry(first, observation())
    expect(() => recordCompatibilityMigrationTelemetry(second, observation()))
      .toThrow(/database is locked/)
    first.exec('COMMIT')
    recordCompatibilityMigrationTelemetry(second, observation({ count: 2 }))

    expect(queryCompatibilityMigrationTelemetrySummary(first))
      .toMatchObject({
        total_count: 3,
        operation_totals: { canonical_read: 3 },
      })
    second.close()
    first.close()
  })

  it('keeps record UPSERT and SELECT in one immediate transaction or savepoint', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    const statements: Array<{
      sql: string
      method: StatementMethod
      inTransaction: boolean
    }> = []
    const observed = observeDatabaseStatements(
      db,
      (sql, method, inTransaction) => {
        statements.push({ sql, method, inTransaction })
        if (sql.includes('SELECT day, table_name AS "table"')) {
          throw new Error('simulated post-upsert read failure')
        }
      },
    )

    const outer = db.transaction(() => {
      db.prepare(`
        INSERT INTO kv (key, value) VALUES ('record-before', 'preserved')
      `).run()
      expect(
        () => recordCompatibilityMigrationTelemetry(
          observed,
          observation({ count: 2 }),
        ),
      ).toThrow(/simulated post-upsert read failure/)
      db.prepare(`
        INSERT INTO kv (key, value) VALUES ('record-after', 'committed')
      `).run()
    })
    outer()

    expect(statements.some(({ sql }) => sql.includes('INSERT INTO'))).toBe(true)
    expect(statements.some(({ sql }) => (
      sql.includes('SELECT day, table_name AS "table"')
    ))).toBe(true)
    expect(statements.every(({ inTransaction }) => inTransaction)).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${DAILY_TABLE}`).get())
      .toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT key FROM kv
      WHERE key IN ('record-before', 'record-after')
      ORDER BY key
    `).all()).toEqual([
      { key: 'record-after' },
      { key: 'record-before' },
    ])
    db.close()
  })

  it('rejects malformed inputs and arbitrary detail before SQLite persistence', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    const attempts: unknown[] = [
      { ...observation(), table: 'unknown_table' },
      { ...observation(), operation: 'read' },
      { ...observation(), cohort: 'board-123' },
      { ...observation(), observed_at: new Date('invalid') },
      { ...observation(), count: 0 },
      { ...observation(), count: 1.5 },
      {
        ...observation(),
        diagnostic_code: 'value_mismatch',
      },
      {
        ...observation({ operation: 'mismatch' }),
        diagnostic_code: 'none',
      },
      {
        ...observation({ operation: 'failure' }),
        diagnostic_code: 'value_mismatch',
      },
      {
        ...observation(),
        detail: 'PRIVATE_KEY=should-never-be-stored',
      },
    ]
    for (const attempt of attempts) {
      expect(
        () => recordCompatibilityMigrationTelemetry(
          db,
          attempt as CompatibilityMigrationTelemetryObservation,
        ),
      ).toThrow()
    }
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${DAILY_TABLE}`).get())
      .toEqual({ count: 0 })
    db.close()
  })

  it('never echoes a secret-bearing unexpected key in validation errors', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    const secretKey = [
      'PRIVATE',
      'KEY',
      'DOM019',
      'NEVER',
      'ECHO',
      'THIS',
      'KEY',
    ].join('_')
    const secretValue = ['DOM019', 'NEVER', 'ECHO', 'THIS', 'VALUE'].join('_')
    let message = ''

    try {
      recordCompatibilityMigrationTelemetry(
        db,
        {
          ...observation(),
          [secretKey]: secretValue,
        } as unknown as CompatibilityMigrationTelemetryObservation,
      )
    } catch (error) {
      message = String(error)
    }

    expect(message).toMatch(/compatibility telemetry input keys are invalid/)
    expect(message).not.toContain(secretKey)
    expect(message).not.toContain(secretValue)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${DAILY_TABLE}`).get())
      .toEqual({ count: 0 })
    db.close()
  })

  it('enforces the same enums and diagnostic compatibility in SQLite CHECKs', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    const insert = db.prepare(`
      INSERT INTO ${DAILY_TABLE} (
        day, table_name, operation, cohort, diagnostic_code, count
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    const invalidRows = [
      ['2025-02-30', 'cards', 'legacy_read', 'canonical_linked', 'none', 1],
      ['2025-02-01', 'unknown', 'legacy_read', 'canonical_linked', 'none', 1],
      ['2025-02-01', 'cards', 'read', 'canonical_linked', 'none', 1],
      ['2025-02-01', 'cards', 'legacy_read', 'custom', 'none', 1],
      [
        '2025-02-01',
        'cards',
        'legacy_read',
        'canonical_linked',
        'value_mismatch',
        1,
      ],
      ['2025-02-01', 'cards', 'mismatch', 'canonical_linked', 'none', 1],
      [
        '2025-02-01',
        'cards',
        'failure',
        'canonical_linked',
        'value_mismatch',
        1,
      ],
      ['2025-02-01', 'cards', 'legacy_read', 'canonical_linked', 'none', 0],
      ['2025-02-01', 'cards', 'legacy_read', 'canonical_linked', 'none', 1.5],
    ]
    for (const row of invalidRows) {
      expect(() => insert.run(...row)).toThrow()
    }
    const invalidMatrixRows = [
      ['2025-02-01', 'boards', 'legacy_read', 'canonical_linked', 'none', 1],
      ['2025-02-01', 'cards', 'legacy_read', 'shared_scope', 'none', 1],
      ['2025-02-01', 'messages', 'canonical_read', 'legacy_only', 'none', 1],
      [
        '2025-02-01',
        'message_targets',
        'canonical_write',
        'legacy_only',
        'none',
        1,
      ],
      [
        '2025-02-01',
        'deliveries',
        'projection_refresh',
        'legacy_only',
        'none',
        1,
      ],
      [
        '2025-02-01',
        'milestones',
        'mismatch',
        'deferred_replacement',
        'value_mismatch',
        1,
      ],
      [
        '2025-02-01',
        'ideas',
        'canonical_read',
        'deferred_replacement',
        'none',
        1,
      ],
      [
        '2025-02-01',
        'token_telemetry',
        'mismatch',
        'legacy_only',
        'scope_mismatch',
        1,
      ],
    ]
    const historyInsert = db.prepare(`
      INSERT INTO ${HISTORY_TABLE} (
        table_name, operation, cohort, diagnostic_code,
        first_day, last_day, count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const row of invalidMatrixRows) {
      expect(() => insert.run(...row)).toThrow()
      expect(() => historyInsert.run(
        row[1],
        row[2],
        row[3],
        row[4],
        row[0],
        row[0],
        row[5],
      )).toThrow()
    }
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${DAILY_TABLE}`).get())
      .toEqual({ count: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${HISTORY_TABLE}`).get())
      .toEqual({ count: 0 })
    db.close()
  })

  it('rejects valid initial coverage inserts outside the sealing path', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 00:00:00')

    expect(() => db.prepare(`
      INSERT INTO ${COVERAGE_TABLE} (
        day, table_name, legacy_write_count, mismatch_count, failure_count
      ) VALUES ('2025-01-02', 'boards', 0, 0, 0)
    `).run()).toThrow(/coverage.*seal|coverage.*managed/i)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ${COVERAGE_TABLE}
    `).get()).toEqual({ count: 0 })
    db.close()
  })

  it('rejects direct daily deletion while preserving guarded rollup', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2024-12-31 00:00:00')
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-01-01T12:00:00.000Z'),
      operation: 'legacy_write',
      count: 2,
    }))

    expect(() => db.prepare(`
      DELETE FROM ${DAILY_TABLE} WHERE day='2025-01-01'
    `).run()).toThrow(/daily.*rollup|daily.*managed/i)
    expect(db.prepare(`
      SELECT count FROM ${DAILY_TABLE} WHERE day='2025-01-01'
    `).get()).toEqual({ count: 2 })

    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-01-01')
    expect(rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })).toMatchObject({
      rows_compacted: 1,
      count_compacted: 2,
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ${DAILY_TABLE}
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT count FROM ${HISTORY_TABLE}
    `).get()).toEqual({ count: 2 })
    db.close()
  })

  it('seals immutable retained snapshots and rejects late API, SQL, and trigger writes', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 00:00:00')
    const rawCoverage = db.prepare(`
      INSERT INTO ${COVERAGE_TABLE} (
        day, table_name, legacy_write_count, mismatch_count, failure_count
      ) VALUES ('2025-01-02', 'boards', ?, ?, ?)
    `)
    expect(() => rawCoverage.run(-1, 0, 0)).toThrow()
    expect(() => rawCoverage.run(0, 1.5, 0)).toThrow()
    expect(
      () => rawCoverage.run(0, 0, Number.MAX_SAFE_INTEGER + 1),
    ).toThrow()
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-02-05T12:00:00.000Z'),
      operation: 'legacy_write',
      count: 2,
    }))
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-02-05T12:00:00.000Z'),
      operation: 'mismatch',
      diagnostic_code: 'projection_stale',
      count: 3,
    }))
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-02-05T12:00:00.000Z'),
      operation: 'failure',
      diagnostic_code: 'unexpected_failure',
      count: 4,
    }))

    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-02-05')
    expect(db.prepare(`
      SELECT legacy_write_count, mismatch_count, failure_count
      FROM ${COVERAGE_TABLE}
      WHERE day='2025-02-05' AND table_name='cards'
    `).get()).toEqual({
      legacy_write_count: 2,
      mismatch_count: 3,
      failure_count: 4,
    })
    expect(() => db.prepare(`
      UPDATE ${COVERAGE_TABLE}
      SET legacy_write_count=0
      WHERE day='2025-02-05' AND table_name='cards'
    `).run()).toThrow(/coverage is immutable/)
    expect(() => db.prepare(`
      DELETE FROM ${COVERAGE_TABLE}
      WHERE day='2025-02-05' AND table_name='cards'
    `).run()).toThrow(/coverage is immutable/)
    expect(() => db.prepare(`
      INSERT OR REPLACE INTO ${COVERAGE_TABLE} (
        day, table_name, legacy_write_count, mismatch_count, failure_count
      ) VALUES ('2025-02-05', 'cards', 0, 0, 0)
    `).run()).toThrow(/coverage is immutable/)
    expect(() => recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-02-05T20:00:00.000Z'),
      operation: 'legacy_write',
    }))).toThrow(/day is sealed/)
    expect(() => db.prepare(`
      INSERT INTO ${DAILY_TABLE} (
        day, table_name, operation, cohort, diagnostic_code, count
      ) VALUES (
        '2025-02-05', 'cards', 'canonical_read',
        'canonical_linked', 'none', 1
      )
    `).run()).toThrow(/day is sealed/)
    expect(() => db.prepare(`
      UPDATE ${DAILY_TABLE}
      SET count=count+1
      WHERE day='2025-02-05' AND table_name='cards'
    `).run()).toThrow(/day is sealed/)

    db.exec(`
      CREATE TRIGGER test_dom019_late_trigger_write
      AFTER INSERT ON boards
      BEGIN
        INSERT INTO ${DAILY_TABLE} (
          day, table_name, operation, cohort, diagnostic_code, count
        ) VALUES (
          '2025-02-05', 'boards', 'legacy_write', 'shared_scope', 'none', 1
        )
        ON CONFLICT(
          day, table_name, operation, cohort, diagnostic_code
        ) DO UPDATE SET count=count+1;
      END
    `)
    expect(() => db.prepare(`
      INSERT INTO boards (project_path, name)
      VALUES ('/dom019-sealed-trigger', 'Sealed trigger')
    `).run()).toThrow(/day is sealed/)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM boards
      WHERE project_path='/dom019-sealed-trigger'
    `).get()).toEqual({ count: 0 })
    db.exec('DROP TRIGGER test_dom019_late_trigger_write')
    db.close()
  })

  it('persists no payload, identifier, arbitrary detail, or secret in telemetry SQLite', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    const secret = 'DOM019_SUPER_SECRET_PRIVATE_KEY'
    const boardId = Number(db.prepare(`
      INSERT INTO boards (project_path, name)
      VALUES ('/dom019-privacy', 'Privacy')
    `).run().lastInsertRowid)
    db.prepare(`
      INSERT INTO messages (board_id, kind, body)
      VALUES (?, 'ask', ?)
    `).run(boardId, secret)
    recordCompatibilityMigrationTelemetry(db, observation({
      operation: 'failure',
      diagnostic_code: 'translation_rejected',
    }))

    const expectedColumns = {
      [DAILY_TABLE]: [
        'day',
        'table_name',
        'operation',
        'cohort',
        'diagnostic_code',
        'count',
      ],
      [HISTORY_TABLE]: [
        'table_name',
        'operation',
        'cohort',
        'diagnostic_code',
        'first_day',
        'last_day',
        'count',
      ],
      [COVERAGE_TABLE]: [
        'day',
        'table_name',
        'legacy_write_count',
        'mismatch_count',
        'failure_count',
      ],
    }
    const forbiddenColumns = new Set([
      'board_id',
      'card_id',
      'agent_id',
      'session_id',
      'message_id',
      'job_id',
      'contract_id',
      'provider',
      'payload',
      'body',
      'detail',
      'content',
    ])
    let telemetrySqlite = ''
    for (const [table, columns] of Object.entries(expectedColumns)) {
      const actualColumns = db.prepare(`PRAGMA table_info('${table}')`)
        .all()
        .map((column) => String((column as { name: string }).name))
      expect(actualColumns).toEqual(columns)
      expect(actualColumns.some((column) => forbiddenColumns.has(column)))
        .toBe(false)
      telemetrySqlite += JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())
    }
    telemetrySqlite += JSON.stringify(db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE name IN (
        ${AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES
          .map(() => '?')
          .join(',')}
      )
      ORDER BY name
    `).all(...AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES))

    expect(telemetrySqlite).not.toContain(secret)
    expect(telemetrySqlite).not.toContain('/dom019-privacy')
    expect(telemetrySqlite).not.toContain('PRIVATE KEY')
    db.close()
  })

  it('returns deterministic daily and all-time summaries with exact totals', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-04-02T20:00:00.000Z'),
      table: 'cards',
      operation: 'canonical_read',
      count: 4,
    }))
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-04-01T20:00:00.000Z'),
      table: 'boards',
      operation: 'legacy_read',
      cohort: 'shared_scope',
      count: 2,
    }))
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-04-02T20:00:00.000Z'),
      table: 'boards',
      operation: 'failure',
      cohort: 'shared_scope',
      diagnostic_code: 'database_locked',
    }))
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-04-01T20:00:00.000Z'),
      table: 'cards',
      operation: 'mismatch',
      diagnostic_code: 'value_mismatch',
      count: 3,
    }))

    const daily = queryCompatibilityMigrationTelemetryDaily(db, {
      from_day: '2025-04-01',
      through_day: '2025-04-02',
    })
    expect(daily.rows.map((row) => (
      `${row.day}:${row.table}:${row.operation}:${row.diagnostic_code}`
    ))).toEqual([
      '2025-04-01:boards:legacy_read:none',
      '2025-04-01:cards:mismatch:value_mismatch',
      '2025-04-02:boards:failure:database_locked',
      '2025-04-02:cards:canonical_read:none',
    ])
    expect(daily).toMatchObject({
      total_count: 10,
      mismatch_count: 3,
      failure_count: 1,
      operation_totals: {
        legacy_read: 2,
        canonical_read: 4,
        mismatch: 3,
        failure: 1,
      },
    })

    const cards = queryCompatibilityMigrationTelemetryDaily(db, {
      from_day: '2025-04-01',
      through_day: '2025-04-02',
      table: 'cards',
    })
    expect(cards.total_count).toBe(7)
    expect(cards.rows).toHaveLength(2)

    const summary = queryCompatibilityMigrationTelemetrySummary(db)
    expect(summary.rows.map((row) => (
      `${row.table}:${row.operation}:${row.diagnostic_code}:${row.count}`
    ))).toEqual([
      'boards:failure:database_locked:1',
      'boards:legacy_read:none:2',
      'cards:canonical_read:none:4',
      'cards:mismatch:value_mismatch:3',
    ])
    expect(summary).toMatchObject({
      total_count: 10,
      mismatch_count: 3,
      failure_count: 1,
      retained_daily_first_day: '2025-04-01',
      retained_daily_through_day: '2025-04-02',
      historical_first_day: null,
      historical_through_day: null,
    })
    db.close()
  })

  it('reads summary rows and both bounds from one deferred snapshot', () => {
    const file = tempDatabaseFile('orchestra-dom019-summary-snapshot-')
    const first = openDb(file)
    installTelemetry(first)
    recordCompatibilityMigrationTelemetry(first, observation({
      observed_at: new Date('2025-04-01T12:00:00.000Z'),
      count: 1,
    }))
    const second = new Database(file)
    second.pragma('busy_timeout = 1000')
    const statements: Array<{
      sql: string
      inTransaction: boolean
    }> = []
    let interleaved = false
    const observed = observeDatabaseStatements(
      first,
      (sql, _method, inTransaction) => {
        statements.push({ sql, inTransaction })
        if (!interleaved && sql.includes('SELECT MIN(')) {
          interleaved = true
          recordCompatibilityMigrationTelemetry(second, observation({
            observed_at: new Date('2025-04-03T12:00:00.000Z'),
            count: 2,
          }))
        }
      },
    )

    const during = queryCompatibilityMigrationTelemetrySummary(observed)
    expect(interleaved).toBe(true)
    expect(statements.length).toBeGreaterThanOrEqual(3)
    expect(statements.every(({ inTransaction }) => inTransaction)).toBe(true)
    expect(during).toMatchObject({
      total_count: 1,
      retained_daily_first_day: '2025-04-01',
      retained_daily_through_day: '2025-04-01',
    })
    expect(queryCompatibilityMigrationTelemetrySummary(first)).toMatchObject({
      total_count: 3,
      retained_daily_first_day: '2025-04-01',
      retained_daily_through_day: '2025-04-03',
    })
    second.close()
    first.close()
  })

  it('rolls expired rows up atomically without losing mismatch or failure counts', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2024-12-31 00:00:00')
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-01-01T00:00:00.000Z'),
      operation: 'canonical_read',
      count: 2,
    }))
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-01-02T00:00:00.000Z'),
      operation: 'mismatch',
      diagnostic_code: 'projection_stale',
      count: 3,
    }))
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-01-02T00:00:00.000Z'),
      operation: 'failure',
      diagnostic_code: 'unexpected_failure',
      count: 5,
    }))
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-06-30T00:00:00.000Z'),
      operation: 'legacy_write',
      count: 7,
    }))
    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-01-01')
    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-01-02')
    const before = queryCompatibilityMigrationTelemetrySummary(db)

    const rolled = rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-07-01T12:00:00.000Z'),
      retain_days: 90,
    })
    expect(rolled).toEqual({
      retain_from_day: '2025-04-03',
      compacted_through_day: '2025-01-02',
      rows_compacted: 3,
      count_compacted: 10,
      mismatch_count_compacted: 3,
      failure_count_compacted: 5,
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ${DAILY_TABLE} WHERE day<'2025-04-03'
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT operation, count FROM ${HISTORY_TABLE}
      ORDER BY operation
    `).all()).toEqual([
      { operation: 'canonical_read', count: 2 },
      { operation: 'failure', count: 5 },
      { operation: 'mismatch', count: 3 },
    ])

    const after = queryCompatibilityMigrationTelemetrySummary(db)
    expect(after.total_count).toBe(before.total_count)
    expect(after.operation_totals).toEqual(before.operation_totals)
    expect(after).toMatchObject({
      historical_first_day: '2025-01-01',
      historical_through_day: '2025-01-02',
      retained_daily_first_day: '2025-06-30',
      retained_daily_through_day: '2025-06-30',
    })
    db.close()
  })

  it('rejects an unexpected history trigger before rollup can mutate data', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2024-12-31 00:00:00')
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-01-01T12:00:00.000Z'),
      operation: 'failure',
      diagnostic_code: 'schema_incompatible',
      count: 2,
    }))
    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-01-01')
    db.exec(`
      CREATE TRIGGER test_dom019_unexpected_history_trigger
      BEFORE INSERT ON ${HISTORY_TABLE}
      BEGIN
        SELECT 1;
      END
    `)

    const unexpectedTriggerError = /unexpected telemetry integrity triggers/i
    expect(() => assertCompatibilityMigrationTelemetrySchemaCompatible(db))
      .toThrow(unexpectedTriggerError)
    expect(() => rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })).toThrow(unexpectedTriggerError)
    expect(db.prepare(`
      SELECT count FROM ${DAILY_TABLE} WHERE day='2025-01-01'
    `).get()).toEqual({ count: 2 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${HISTORY_TABLE}`).get())
      .toEqual({ count: 0 })
    db.close()
  })

  it('keeps rollup guards idle through its baseline and rolls injected early deletion back', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2024-12-31 00:00:00')
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-01-01T12:00:00.000Z'),
      operation: 'legacy_write',
      count: 7,
    }))
    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-01-01')

    let earlyAttempted = false
    let earlyError = ''
    let deletePhaseAttempted = false
    let injectedDeleteChanges = 0
    const observed = observeDatabaseStatements(
      db,
      (sql, method) => {
        if (!earlyAttempted) {
          earlyAttempted = true
          try {
            db.prepare(`
              DELETE FROM ${DAILY_TABLE}
              WHERE day='2025-01-01' AND operation='legacy_write'
            `).run()
          } catch (error) {
            earlyError = String(error)
          }
          return
        }
        if (
          !deletePhaseAttempted
          && method === 'run'
          && sql.includes(`DELETE FROM ${DAILY_TABLE}`)
        ) {
          deletePhaseAttempted = true
          injectedDeleteChanges = db.prepare(`
            DELETE FROM ${DAILY_TABLE}
            WHERE day='2025-01-01' AND operation='legacy_write'
          `).run().changes
        }
      },
    )

    expect(() => rollupCompatibilityMigrationTelemetry(observed, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })).toThrow(/deleted an unexpected row count/)
    expect(earlyAttempted).toBe(true)
    expect(earlyError).toMatch(/daily deletion is rollup-managed/)
    expect(deletePhaseAttempted).toBe(true)
    expect(injectedDeleteChanges).toBe(1)
    expect(db.prepare(`
      SELECT count FROM ${DAILY_TABLE}
      WHERE day='2025-01-01' AND operation='legacy_write'
    `).get()).toEqual({ count: 7 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${HISTORY_TABLE}`).get())
      .toEqual({ count: 0 })
    const summary = queryCompatibilityMigrationTelemetrySummary(db)
    expect(summary.total_count).toBe(7)
    expect(summary.operation_totals.legacy_write).toBe(7)
    db.close()
  })

  it('rolls all compaction writes back when DELETE silently ignores rows', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2024-12-31 00:00:00')
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-01-01T12:00:00.000Z'),
      operation: 'failure',
      diagnostic_code: 'schema_incompatible',
      count: 2,
    }))
    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-01-01')
    let injected = false
    const observed = observeDatabaseStatements(
      db,
      (sql, method, inTransaction) => {
        if (
          !injected
          && method === 'run'
          && sql.includes(`DELETE FROM ${DAILY_TABLE}`)
        ) {
          expect(inTransaction).toBe(true)
          injected = true
          db.exec(`
            CREATE TRIGGER test_dom019_ignore_rollup_delete
            BEFORE DELETE ON ${DAILY_TABLE}
            BEGIN
              SELECT RAISE(IGNORE);
            END
          `)
        }
      },
    )

    expect(() => rollupCompatibilityMigrationTelemetry(observed, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })).toThrow(/conservation|compaction.*delete|delete.*compaction/i)
    expect(injected).toBe(true)
    expect(db.prepare(`
      SELECT count FROM ${DAILY_TABLE} WHERE day='2025-01-01'
    `).get()).toEqual({ count: 2 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${HISTORY_TABLE}`).get())
      .toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='trigger' AND name='test_dom019_ignore_rollup_delete'
    `).get()).toEqual({ count: 0 })

    expect(rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })).toMatchObject({
      rows_compacted: 1,
      count_compacted: 2,
      failure_count_compacted: 2,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(db)).toMatchObject({
      total_count: 2,
      failure_count: 2,
    })
    db.close()
  })

  it('leaves unsealed expired rows visible until they can be snapshotted', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2024-12-31 00:00:00')
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-01-01T12:00:00.000Z'),
      operation: 'legacy_write',
      count: 6,
    }))

    expect(rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })).toEqual({
      retain_from_day: '2025-04-03',
      compacted_through_day: null,
      rows_compacted: 0,
      count_compacted: 0,
      mismatch_count_compacted: 0,
      failure_count_compacted: 0,
    })
    expect(db.prepare(`
      SELECT count FROM ${DAILY_TABLE}
      WHERE day='2025-01-01' AND table_name='cards'
        AND operation='legacy_write'
    `).get()).toEqual({ count: 6 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${HISTORY_TABLE}`).get())
      .toEqual({ count: 0 })

    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-01-01')
    expect(db.prepare(`
      SELECT legacy_write_count FROM ${COVERAGE_TABLE}
      WHERE day='2025-01-01' AND table_name='cards'
    `).get()).toEqual({ legacy_write_count: 6 })
    expect(rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })).toMatchObject({
      compacted_through_day: '2025-01-01',
      rows_compacted: 1,
      count_compacted: 6,
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ${DAILY_TABLE}
      WHERE day='2025-01-01'
    `).get()).toEqual({ count: 0 })
    expect(queryCompatibilityMigrationWriterObservation(db, {
      table: 'cards',
      from_day: '2025-01-01',
      through_day: '2025-01-01',
    })).toMatchObject({
      covered_days: 1,
      legacy_write_count: 6,
      status: 'legacy_writer_observed',
      reason: 'legacy_write_nonzero',
    })
    db.close()
  })

  it('makes rollup replay and restart safe', () => {
    const file = tempDatabaseFile('orchestra-dom019-rollup-')
    const first = openDb(file)
    installTelemetry(first, '2024-12-31 00:00:00')
    recordCompatibilityMigrationTelemetry(first, observation({
      observed_at: new Date('2025-01-01T00:00:00.000Z'),
      operation: 'mismatch',
      diagnostic_code: 'scope_mismatch',
      count: 4,
    }))
    sealCompletedCompatibilityMigrationTelemetryDay(first, '2025-01-01')
    const firstRollup = rollupCompatibilityMigrationTelemetry(first, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })
    expect(firstRollup.count_compacted).toBe(4)
    first.close()

    const reopened = new Database(file)
    const replay = rollupCompatibilityMigrationTelemetry(reopened, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })
    expect(replay).toMatchObject({
      compacted_through_day: null,
      rows_compacted: 0,
      count_compacted: 0,
      mismatch_count_compacted: 0,
      failure_count_compacted: 0,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(reopened))
      .toMatchObject({
        total_count: 4,
        mismatch_count: 4,
      })
    reopened.close()
  })

  it('retains coverage and blocking counts across rollup, reopen, and reseal', () => {
    const file = tempDatabaseFile('orchestra-dom019-coverage-rollup-')
    const first = openDb(file)
    installTelemetry(first, '2025-01-01 00:00:00')
    recordCompatibilityMigrationTelemetry(first, observation({
      observed_at: new Date('2025-02-01T12:00:00.000Z'),
      operation: 'legacy_write',
      count: 2,
    }))
    recordCompatibilityMigrationTelemetry(first, observation({
      observed_at: new Date('2025-02-01T12:00:00.000Z'),
      operation: 'mismatch',
      diagnostic_code: 'scope_mismatch',
      count: 3,
    }))
    recordCompatibilityMigrationTelemetry(first, observation({
      observed_at: new Date('2025-02-01T12:00:00.000Z'),
      operation: 'failure',
      diagnostic_code: 'schema_incompatible',
      count: 4,
    }))
    for (let offset = 0; offset < 30; offset += 1) {
      sealCompletedCompatibilityMigrationTelemetryDay(
        first,
        dayOffset('2025-02-01', offset),
      )
    }
    expect(first.prepare(`
      SELECT COUNT(*) AS count FROM ${COVERAGE_TABLE}
    `).get()).toEqual({ count: 13 * 30 })

    rollupCompatibilityMigrationTelemetry(first, {
      now: new Date('2025-07-01T12:00:00.000Z'),
      retain_days: 90,
    })
    expect(first.prepare(`
      SELECT COUNT(*) AS count FROM ${DAILY_TABLE}
      WHERE day BETWEEN '2025-02-01' AND '2025-03-02'
    `).get()).toEqual({ count: 0 })
    expect(first.prepare(`
      SELECT COUNT(*) AS count FROM ${COVERAGE_TABLE}
    `).get()).toEqual({ count: 13 * 30 })
    first.close()

    const reopened = new Database(file)
    for (let offset = 0; offset < 30; offset += 1) {
      sealCompletedCompatibilityMigrationTelemetryDay(
        reopened,
        dayOffset('2025-02-01', offset),
      )
    }
    const observedStatements: Array<{
      sql: string
      inTransaction: boolean
    }> = []
    const observedDb = observeDatabaseStatements(
      reopened,
      (sql, _method, inTransaction) => {
        observedStatements.push({ sql, inTransaction })
      },
    )
    const result = queryCompatibilityMigrationWriterObservation(observedDb, {
      table: 'cards',
      from_day: '2025-02-01',
      through_day: dayOffset('2025-02-01', 29),
    })
    expect(result).toMatchObject({
      covered_days: 30,
      legacy_write_count: 2,
      mismatch_count: 3,
      failure_count: 4,
      status: 'legacy_writer_observed',
      reason: 'legacy_write_nonzero',
      writer_removal_authorized: false,
    })
    const coverageReads = observedStatements.filter(
      ({ sql }) => sql.includes(`FROM ${COVERAGE_TABLE}`),
    )
    expect(coverageReads).toHaveLength(1)
    expect(coverageReads[0]?.sql).not.toContain(DAILY_TABLE)
    expect(coverageReads[0]?.sql).not.toContain(HISTORY_TABLE)
    expect(observedStatements.every(({ inTransaction }) => inTransaction))
      .toBe(true)
    expect(reopened.prepare(`
      SELECT COUNT(*) AS count FROM ${COVERAGE_TABLE}
    `).get()).toEqual({ count: 13 * 30 })
    reopened.close()
  })

  it('rolls history insertion back if the daily delete cannot complete', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2024-12-31 00:00:00')
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-01-01T00:00:00.000Z'),
      operation: 'failure',
      diagnostic_code: 'schema_incompatible',
      count: 2,
    }))
    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-01-01')
    let injected = false
    const observed = observeDatabaseStatements(
      db,
      (sql, method, inTransaction) => {
        if (
          !injected
          && method === 'run'
          && sql.includes(`DELETE FROM ${DAILY_TABLE}`)
        ) {
          expect(inTransaction).toBe(true)
          injected = true
          db.exec(`
            CREATE TRIGGER test_dom019_abort_rollup
            BEFORE DELETE ON ${DAILY_TABLE}
            BEGIN
              SELECT RAISE(ABORT, 'simulated rollup delete failure');
            END
          `)
        }
      },
    )

    expect(() => rollupCompatibilityMigrationTelemetry(observed, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })).toThrow(/simulated rollup delete failure/)
    expect(injected).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${DAILY_TABLE}`).get())
      .toEqual({ count: 1 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${HISTORY_TABLE}`).get())
      .toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='trigger' AND name='test_dom019_abort_rollup'
    `).get()).toEqual({ count: 0 })
    expect(rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    }).count_compacted).toBe(2)
    db.close()
  })

  it('uses a nested savepoint when a caught rollup failure commits its outer transaction', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2024-12-31 00:00:00')
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-01-01T00:00:00.000Z'),
      operation: 'failure',
      diagnostic_code: 'schema_incompatible',
      count: 2,
    }))
    sealCompletedCompatibilityMigrationTelemetryDay(db, '2025-01-01')
    let injected = false
    const observed = observeDatabaseStatements(
      db,
      (sql, method, inTransaction) => {
        if (
          !injected
          && method === 'run'
          && sql.includes(`DELETE FROM ${DAILY_TABLE}`)
        ) {
          expect(inTransaction).toBe(true)
          injected = true
          db.exec(`
            CREATE TRIGGER test_dom019_abort_nested_rollup
            BEFORE DELETE ON ${DAILY_TABLE}
            BEGIN
              SELECT RAISE(ABORT, 'simulated nested rollup delete failure');
            END
          `)
        }
      },
    )

    const outer = db.transaction(() => {
      db.prepare(`
        INSERT INTO kv (key, value) VALUES ('dom019-before', 'preserved')
      `).run()
      expect(() => rollupCompatibilityMigrationTelemetry(observed, {
        now: new Date('2025-07-01T00:00:00.000Z'),
      })).toThrow(/simulated nested rollup delete failure/)
      db.prepare(`
        INSERT INTO kv (key, value) VALUES ('dom019-after', 'committed')
      `).run()
    })
    outer()
    expect(injected).toBe(true)

    expect(db.prepare(`
      SELECT key AS marker, value FROM kv
      WHERE key IN ('dom019-before', 'dom019-after')
      ORDER BY key
    `).all()).toEqual([
      { marker: 'dom019-after', value: 'committed' },
      { marker: 'dom019-before', value: 'preserved' },
    ])
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${DAILY_TABLE}`).get())
      .toEqual({ count: 1 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${HISTORY_TABLE}`).get())
      .toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='trigger' AND name='test_dom019_abort_nested_rollup'
    `).get()).toEqual({ count: 0 })
    expect(rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })).toMatchObject({
      rows_compacted: 1,
      count_compacted: 2,
      failure_count_compacted: 2,
    })
    expect(rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-07-01T00:00:00.000Z'),
    })).toMatchObject({
      rows_compacted: 0,
      count_compacted: 0,
      failure_count_compacted: 0,
    })
    expect(queryCompatibilityMigrationTelemetrySummary(db)).toMatchObject({
      total_count: 2,
      failure_count: 2,
    })
    expect(db.prepare(`
      SELECT operation, count FROM ${HISTORY_TABLE}
    `).all()).toEqual([
      { operation: 'failure', count: 2 },
    ])
    db.close()
  })

  it('enforces the bounded retention window', () => {
    const db = openDb(':memory:')
    installTelemetry(db)
    expect(AGENT_OS_COMPATIBILITY_TELEMETRY_RETENTION_RULE)
      .toMatchObject({
        minimum_daily_retention_days: 90,
        maximum_daily_retention_days: 3_650,
        preserves_mismatch_and_failure_counts: true,
      })
    expect(() => rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('2025-07-01T00:00:00.000Z'),
      retain_days: 89,
    })).toThrow(/outside the bounded/)
    expect(() => rollupCompatibilityMigrationTelemetry(db, {
      now: new Date('invalid'),
    })).toThrow(/valid Date/)
    db.close()
  })

  it('never treats absent counters as proof that a legacy writer is removable', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 00:00:00')
    const query = {
      table: 'cards' as const,
      from_day: '2025-02-01',
      through_day: dayOffset('2025-02-01', 29),
    }

    expect(queryCompatibilityMigrationWriterObservation(db, query))
      .toEqual({
        ...query,
        calendar_days: 30,
        covered_days: 0,
        required_days: 30,
        legacy_write_count: 0,
        mismatch_count: 0,
        failure_count: 0,
        status: 'insufficient_observation',
        reason: 'coverage_gap',
        writer_removal_authorized: false,
        operator_gate: 'ORC-020',
      })

    for (let offset = 0; offset < 30; offset += 1) {
      sealCompletedCompatibilityMigrationTelemetryDay(
        db,
        dayOffset('2025-02-01', offset),
      )
    }
    expect(queryCompatibilityMigrationWriterObservation(db, query))
      .toMatchObject({
        covered_days: 30,
        legacy_write_count: 0,
        status: 'eligible_for_operator_review',
        reason: 'operator_review_required',
        writer_removal_authorized: false,
        operator_gate: 'ORC-020',
      })
    expect(AGENT_OS_COMPATIBILITY_WRITER_OBSERVATION_RULE)
      .toMatchObject({
        minimum_complete_utc_days: 30,
        requires_explicit_completed_day_coverage: true,
        writer_removal_authorized: false,
        operator_gate: 'ORC-020',
      })
    db.close()
  })

  it('keeps usage, diagnostic risk, short windows, and coverage gaps non-removable', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 00:00:00')
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-02-05T12:00:00.000Z'),
      table: 'cards',
      operation: 'legacy_write',
      count: 1,
    }))
    recordCompatibilityMigrationTelemetry(db, observation({
      observed_at: new Date('2025-02-05T12:00:00.000Z'),
      table: 'agents',
      operation: 'mismatch',
      diagnostic_code: 'lifecycle_mismatch',
    }))
    for (let offset = 0; offset < 30; offset += 1) {
      sealCompletedCompatibilityMigrationTelemetryDay(
        db,
        dayOffset('2025-02-01', offset),
      )
    }

    expect(queryCompatibilityMigrationWriterObservation(db, {
      table: 'cards',
      from_day: '2025-02-01',
      through_day: dayOffset('2025-02-01', 29),
    })).toMatchObject({
      status: 'legacy_writer_observed',
      reason: 'legacy_write_nonzero',
      legacy_write_count: 1,
      writer_removal_authorized: false,
    })
    expect(queryCompatibilityMigrationWriterObservation(db, {
      table: 'agents',
      from_day: '2025-02-01',
      through_day: dayOffset('2025-02-01', 29),
    })).toMatchObject({
      status: 'diagnostic_risk_observed',
      reason: 'diagnostic_nonzero',
      mismatch_count: 1,
      writer_removal_authorized: false,
    })
    expect(queryCompatibilityMigrationWriterObservation(db, {
      table: 'boards',
      from_day: '2025-02-01',
      through_day: '2025-02-02',
    })).toMatchObject({
      status: 'insufficient_observation',
      reason: 'window_too_short',
      writer_removal_authorized: false,
    })
    expect(queryCompatibilityMigrationWriterObservation(db, {
      table: 'boards',
      from_day: '2025-02-01',
      through_day: dayOffset('2025-02-01', 30),
    })).toMatchObject({
      covered_days: 30,
      status: 'insufficient_observation',
      reason: 'coverage_gap',
      writer_removal_authorized: false,
    })
    db.close()
  })

  it('holds the schema boundary and rolls partial sealing back in a nested savepoint', () => {
    const file = tempDatabaseFile('orchestra-dom019-seal-boundary-')
    const first = openDb(file)
    installTelemetry(first, '2025-01-01 00:00:00')
    const second = new Database(file)
    second.pragma('busy_timeout = 0')
    const protectedTrigger =
      AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES[0]!
    const statements: Array<{
      sql: string
      inTransaction: boolean
    }> = []
    let boundaryAttempted = false
    let boundaryError = ''
    let failPartialSeal = false
    let coverageInsertRuns = 0
    const observed = observeDatabaseStatements(
      first,
      (sql, method, inTransaction) => {
        statements.push({ sql, inTransaction })
        if (
          !boundaryAttempted
          && sql.includes('SELECT type, name, sql FROM sqlite_master')
        ) {
          boundaryAttempted = true
          try {
            second.exec(`DROP TRIGGER ${protectedTrigger}`)
          } catch (error) {
            boundaryError = String(error)
          }
        }
        if (
          failPartialSeal
          && method === 'run'
          && sql.includes(`INSERT INTO ${COVERAGE_TABLE}`)
        ) {
          coverageInsertRuns += 1
          if (coverageInsertRuns === 5) {
            throw new Error('simulated coverage insert failure')
          }
        }
      },
    )

    sealCompletedCompatibilityMigrationTelemetryDay(
      observed,
      '2025-01-02',
    )
    expect(boundaryAttempted).toBe(true)
    expect(boundaryError).toMatch(/database is locked/)
    expect(statements.length).toBeGreaterThan(13)
    expect(statements.every(({ inTransaction }) => inTransaction)).toBe(true)
    expect(() => assertCompatibilityMigrationTelemetrySchemaCompatible(first))
      .not.toThrow()
    expect(first.prepare(`
      SELECT COUNT(*) AS count FROM ${COVERAGE_TABLE}
      WHERE day='2025-01-02'
    `).get()).toEqual({ count: 13 })

    failPartialSeal = true
    const outer = first.transaction(() => {
      first.prepare(`
        INSERT INTO kv (key, value) VALUES ('seal-before', 'preserved')
      `).run()
      expect(() => sealCompletedCompatibilityMigrationTelemetryDay(
        observed,
        '2025-01-03',
      )).toThrow(/simulated coverage insert failure/)
      first.prepare(`
        INSERT INTO kv (key, value) VALUES ('seal-after', 'committed')
      `).run()
    })
    outer()
    expect(first.prepare(`
      SELECT COUNT(*) AS count FROM ${COVERAGE_TABLE}
      WHERE day='2025-01-03'
    `).get()).toEqual({ count: 0 })
    expect(first.prepare(`
      SELECT key FROM kv
      WHERE key IN ('seal-before', 'seal-after')
      ORDER BY key
    `).all()).toEqual([
      { key: 'seal-after' },
      { key: 'seal-before' },
    ])
    second.close()
    first.close()
  })

  it('refuses to seal the install day, current day, or an incompatible trigger set', () => {
    const db = openDb(':memory:')
    installTelemetry(db, '2025-01-01 12:00:00')
    expect(() => sealCompletedCompatibilityMigrationTelemetryDay(
      db,
      '2025-01-01',
    )).toThrow(/must begin after/)
    expect(() => sealCompletedCompatibilityMigrationTelemetryDay(
      db,
      new Date().toISOString().slice(0, 10),
    )).toThrow(/completed UTC day/)

    const trigger =
      AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_TRIGGER_NAMES.at(-1)!
    db.exec(`DROP TRIGGER ${trigger}`)
    expect(() => sealCompletedCompatibilityMigrationTelemetryDay(
      db,
      '2025-01-02',
    )).toThrow(new RegExp(`incompatible ${trigger} schema`))
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${COVERAGE_TABLE}`).get())
      .toEqual({ count: 0 })
    db.close()
  })
})

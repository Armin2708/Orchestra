import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  resolveCompatibilityMigrationTelemetryCohort,
} from '../src/agent-os/compatibility-migration-instrumentation.js'
import {
  AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
} from '../src/agent-os/compatibility-forward-migration.js'
import { LegacyEventProjection } from '../src/agent-os/legacy-projection.js'

const databases: Array<ReturnType<typeof openDb>> = []
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function database(location = ':memory:') {
  const db = openDb(location)
  databases.push(db)
  return db
}

function boardAndCard(db: ReturnType<typeof openDb>) {
  const boardId = Number(db.prepare(`
    INSERT INTO boards (project_path, name)
    VALUES ('/instrumentation', 'instrumentation')
  `).run().lastInsertRowid)
  const cardId = Number(db.prepare(`
    INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Instrument', 'Observe a real adapter write')
  `).run(boardId).lastInsertRowid)
  return { boardId, cardId }
}

function cardEventTelemetry(db: ReturnType<typeof openDb>) {
  return db.prepare(`
    SELECT operation, cohort, diagnostic_code, count
    FROM os_compatibility_migration_telemetry_daily
    WHERE table_name='card_events'
    ORDER BY operation, cohort, diagnostic_code
  `).all()
}

describe('DOM-019 real compatibility instrumentation', () => {
  it('records only a real legacy-event translation and canonical EventStore write', () => {
    const db = database()
    const { boardId, cardId } = boardAndCard(db)
    const privatePayload = [
      'provider',
      'credential',
      'must',
      'stay',
      'out',
    ].join('_')
    const sourceHash = '0'.repeat(64)
    db.prepare(`
      INSERT INTO os_compatibility_projection_links (
        migration_id, source_table, source_key, source_hash,
        target_table, target_key, target_hash, disposition
      ) VALUES (?, 'card_events', '41', ?, 'os_events', 'event-41', ?, 'test')
    `).run(
      AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
      sourceHash,
      sourceHash,
    )

    new LegacyEventProjection(db).project({
      board_id: boardId,
      type: 'launch',
      data: {
        card_id: cardId,
        status: 'started',
        source_id: 41,
        provider_payload: privatePayload,
      },
    })

    expect(cardEventTelemetry(db)).toEqual([
      {
        operation: 'adapter_translation',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'none',
        count: 1,
      },
      {
        operation: 'canonical_write',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'none',
        count: 1,
      },
    ])
    expect(db.prepare(`
      SELECT kind, source FROM os_events WHERE board_id=?
    `).get(boardId)).toEqual({
      kind: 'legacy.launch',
      source: 'legacy_bus',
    })

    const telemetryOnly = JSON.stringify({
      daily: db.prepare(`
        SELECT * FROM os_compatibility_migration_telemetry_daily
      `).all(),
      history: db.prepare(`
        SELECT * FROM os_compatibility_migration_telemetry_history
      `).all(),
      coverage: db.prepare(`
        SELECT * FROM os_compatibility_migration_telemetry_coverage
      `).all(),
    })
    expect(telemetryOnly).not.toContain(privatePayload)
    const telemetryColumns = db.prepare(`
      SELECT m.name AS table_name, p.name AS column_name
      FROM sqlite_master m
      JOIN pragma_table_info(m.name) p
      WHERE m.type='table'
        AND m.name LIKE 'os_compatibility_migration_telemetry_%'
      ORDER BY m.name, p.cid
    `).all() as Array<{ table_name: string; column_name: string }>
    expect(telemetryColumns.map((column) => column.column_name))
      .not.toContain('source_key')
  })

  it('rolls back false success and persists one bounded real failure diagnostic', () => {
    const db = database()
    const { boardId, cardId } = boardAndCard(db)
    const privateFailureDetail = [
      'caller',
      'controlled',
      'insert',
      'rejection',
    ].join('_')
    db.exec(`
      CREATE TEMP TRIGGER reject_legacy_projection_event
      BEFORE INSERT ON os_events
      BEGIN
        SELECT RAISE(ABORT, '${privateFailureDetail}');
      END
    `)

    expect(() => new LegacyEventProjection(db).project({
      board_id: boardId,
      type: 'launch',
      data: {
        card_id: cardId,
        status: 'started',
        provider_detail: privateFailureDetail,
      },
    })).toThrow(privateFailureDetail)

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
    expect(cardEventTelemetry(db)).toEqual([
      {
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'translation_rejected',
        count: 1,
      },
    ])
    expect(JSON.stringify(cardEventTelemetry(db)))
      .not.toContain(privateFailureDetail)
  })

  it('rolls back the event and success telemetry when attention projection fails', () => {
    const db = database()
    const { boardId } = boardAndCard(db)
    const privateFailureDetail = [
      'attention',
      'projection',
      'rejection',
    ].join('_')
    db.exec(`
      CREATE TEMP TRIGGER reject_legacy_projection_attention
      BEFORE INSERT ON attention_items
      BEGIN
        SELECT RAISE(ABORT, '${privateFailureDetail}');
      END
    `)

    expect(() => new LegacyEventProjection(db).project({
      board_id: boardId,
      type: 'permission',
      data: {
        request_id: 'request-1',
        status: 'pending',
        title: 'Approve bounded operation',
      },
    })).toThrow(privateFailureDetail)

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM attention_items
    `).get()).toEqual({ count: 0 })
    expect(cardEventTelemetry(db)).toEqual([
      {
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'translation_rejected',
        count: 1,
      },
    ])
    expect(JSON.stringify(cardEventTelemetry(db)))
      .not.toContain(privateFailureDetail)
  })

  it('records schema failure when workspace resolution cannot run', () => {
    const db = database()
    const { boardId, cardId } = boardAndCard(db)
    db.exec('DROP TABLE workspaces')

    expect(() => new LegacyEventProjection(db).project({
      board_id: boardId,
      type: 'launch',
      data: { card_id: cardId, status: 'started' },
    })).toThrow(/no such table/i)

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
    expect(cardEventTelemetry(db)).toEqual([
      {
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'schema_incompatible',
        count: 1,
      },
    ])
  })

  it('does not fabricate counters for ignored or structurally invalid bus events', () => {
    const db = database()
    const { boardId } = boardAndCard(db)
    const projection = new LegacyEventProjection(db)

    projection.project({
      board_id: boardId,
      type: 'os:already-canonical',
      data: {},
    })
    projection.project({
      board_id: Number.NaN,
      type: 'launch',
      data: {},
    })
    projection.project({
      board_id: boardId,
      type: '',
      data: {},
    })

    expect(cardEventTelemetry(db)).toEqual([])
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
  })

  it('resolves bounded cohorts from DOM-017 link and quarantine evidence', () => {
    const db = database()
    const hash = '0'.repeat(64)
    db.prepare(`
      INSERT INTO os_compatibility_projection_links (
        migration_id, source_table, source_key, source_hash,
        target_table, target_key, target_hash, disposition
      ) VALUES (?, 'card_events', '41', ?, 'os_events', 'event-41', ?, 'test')
    `).run(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID, hash, hash)
    db.prepare(`
      INSERT INTO os_compatibility_projection_quarantine (
        migration_id, source_table, source_key, source_hash,
        reason_code, safe_detail
      ) VALUES (?, 'card_events', '42', ?, 'test', 'bounded safe detail')
    `).run(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID, hash)

    expect(resolveCompatibilityMigrationTelemetryCohort(
      db,
      { table: 'card_events', source_id: 41 },
    )).toBe('canonical_linked')
    expect(resolveCompatibilityMigrationTelemetryCohort(
      db,
      { table: 'card_events', source_id: 42 },
    )).toBe('migration_quarantined')
    expect(resolveCompatibilityMigrationTelemetryCohort(
      db,
      { table: 'card_events', source_id: 43 },
    )).toBe('canonical_unlinked')
    expect(resolveCompatibilityMigrationTelemetryCohort(
      db,
      { table: 'card_events' },
    )).toBe('canonical_unlinked')
    expect(resolveCompatibilityMigrationTelemetryCohort(
      db,
      { table: 'messages' },
    )).toBe('legacy_only')
    expect(resolveCompatibilityMigrationTelemetryCohort(
      db,
      { table: 'milestones' },
    )).toBe('deferred_replacement')
  })

  it('treats malformed agent-usage days as unlinked instead of throwing', () => {
    const db = database()

    expect(resolveCompatibilityMigrationTelemetryCohort(db, {
      table: 'agent_usage',
      board_id: 1,
      agent_id: 1,
      day: '2026-99-99',
    })).toBe('canonical_unlinked')
    expect(resolveCompatibilityMigrationTelemetryCohort(db, {
      table: 'agent_usage',
      board_id: 1,
      agent_id: 1,
      day: '2026-02-30',
    })).toBe('canonical_unlinked')
  })

  it('aggregates exact adapter evidence across a clean database restart', () => {
    const directory = fs.mkdtempSync(path.join(
      os.tmpdir(),
      'agentboard-dom019-instrumentation-',
    ))
    temporaryDirectories.push(directory)
    const location = path.join(directory, 'agentboard.sqlite')
    const first = database(location)
    const { boardId, cardId } = boardAndCard(first)

    new LegacyEventProjection(first).project({
      board_id: boardId,
      type: 'launch',
      data: { card_id: cardId, status: 'started' },
    })
    first.close()

    const reopened = database(location)
    new LegacyEventProjection(reopened).project({
      board_id: boardId,
      type: 'launch',
      data: { card_id: cardId, status: 'finished', outcome: 'success' },
    })

    expect(cardEventTelemetry(reopened)).toEqual([
      {
        operation: 'adapter_translation',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'none',
        count: 2,
      },
      {
        operation: 'canonical_write',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'none',
        count: 2,
      },
    ])
    expect(reopened.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 2 })
  })
})

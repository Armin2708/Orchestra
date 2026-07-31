import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import {
  openCompatibilityMigrationFailureJournal,
  type CompatibilityMigrationFailureJournal,
} from '../src/agent-os/compatibility-migration-failure-journal.js'
import {
  queryCompatibilityMigrationTelemetrySummary,
} from '../src/agent-os/compatibility-migration-telemetry.js'
import {
  resolveCompatibilityMigrationTelemetryCohort,
} from '../src/agent-os/compatibility-migration-instrumentation.js'
import {
  AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
} from '../src/agent-os/compatibility-forward-migration.js'
import { LegacyEventProjection } from '../src/agent-os/legacy-projection.js'

type OpenDatabase = ReturnType<typeof openDb>

interface Fixture {
  readonly directory: string
  readonly databasePath: string
  readonly journalPath: string
  db: OpenDatabase
  journal: CompatibilityMigrationFailureJournal
}

const databases = new Set<OpenDatabase>()
const journals = new Set<CompatibilityMigrationFailureJournal>()
const servers = new Set<FastifyInstance>()
const temporaryDirectories = new Set<string>()

afterEach(async () => {
  for (const server of servers) await server.close()
  servers.clear()
  for (const journal of journals) journal.close()
  journals.clear()
  for (const db of databases) {
    if (db.open) db.close()
  }
  databases.clear()
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
  temporaryDirectories.clear()
})

function fixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'agentboard-dom019-instrumentation-',
  ))
  temporaryDirectories.add(directory)
  const databasePath = path.join(directory, 'agentboard.sqlite')
  const journalPath = path.join(directory, 'compatibility-failures.sqlite')
  const db = openDb(databasePath)
  databases.add(db)
  const journal = openCompatibilityMigrationFailureJournal(db, {
    journal_path: journalPath,
  })
  journals.add(journal)
  return { directory, databasePath, journalPath, db, journal }
}

function reopen(resource: Fixture): void {
  resource.journal.close()
  journals.delete(resource.journal)
  resource.db.close()
  databases.delete(resource.db)
  resource.db = openDb(resource.databasePath)
  databases.add(resource.db)
  resource.journal = openCompatibilityMigrationFailureJournal(resource.db, {
    journal_path: resource.journalPath,
  })
  journals.add(resource.journal)
}

function boardAndCard(db: OpenDatabase): {
  boardId: number
  cardId: number
} {
  const boardId = Number(db.prepare(`
    INSERT INTO boards (project_path, name)
    VALUES ('/dom019-instrumentation', 'DOM-019 instrumentation')
  `).run().lastInsertRowid)
  const cardId = Number(db.prepare(`
    INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Instrument', 'Observe one real compatibility adapter')
  `).run(boardId).lastInsertRowid)
  return { boardId, cardId }
}

function project(
  resource: Fixture,
  boardId: number,
  cardId: number,
  data: Record<string, unknown> = {},
): void {
  new LegacyEventProjection(resource.db, resource.journal).project({
    board_id: boardId,
    type: 'launch',
    data: {
      card_id: cardId,
      status: 'started',
      ...data,
    },
  })
}

function cardEventTelemetry(resource: Fixture): Array<{
  operation: string
  cohort: string
  diagnostic_code: string
  count: number
}> {
  queryCompatibilityMigrationTelemetrySummary(resource.db, resource.journal)
  return resource.db.prepare(`
    SELECT operation, cohort, diagnostic_code, count
    FROM os_compatibility_migration_telemetry_daily
    WHERE table_name='card_events'
    ORDER BY operation, cohort, diagnostic_code
  `).all() as Array<{
    operation: string
    cohort: string
    diagnostic_code: string
    count: number
  }>
}

describe('DOM-019 real compatibility instrumentation', () => {
  it('records a real legacy-event translation and canonical event write', () => {
    const resource = fixture()
    const { boardId, cardId } = boardAndCard(resource.db)

    project(resource, boardId, cardId)

    expect(cardEventTelemetry(resource)).toEqual([
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
    expect(resource.db.prepare(`
      SELECT kind, source FROM os_events WHERE source='legacy_bus'
    `).all()).toEqual([
      { kind: 'legacy.launch', source: 'legacy_bus' },
    ])
  })

  it('rolls back false success and drains one bounded failure diagnostic', () => {
    const resource = fixture()
    const { boardId, cardId } = boardAndCard(resource.db)
    const privateFailure = [
      'caller',
      'controlled',
      'projection',
      'detail',
    ].join('_')
    resource.db.exec(`
      CREATE TEMP TRIGGER reject_legacy_projection_event
      BEFORE INSERT ON os_events
      BEGIN
        SELECT RAISE(ABORT, '${privateFailure}');
      END
    `)

    expect(() => project(resource, boardId, cardId))
      .toThrow(privateFailure)

    expect(resource.db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
    expect(cardEventTelemetry(resource)).toEqual([
      {
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'translation_rejected',
        count: 1,
      },
    ])
    expect(JSON.stringify(cardEventTelemetry(resource)))
      .not.toContain(privateFailure)
  })

  it('recovers a held-WAL failure across a clean journal restart', () => {
    const resource = fixture()
    const { boardId, cardId } = boardAndCard(resource.db)
    resource.db.pragma('busy_timeout = 1')
    const contender = openDb(resource.databasePath)
    databases.add(contender)
    contender.pragma('busy_timeout = 1')
    contender.exec('BEGIN IMMEDIATE')
    let operationError: unknown
    try {
      project(resource, boardId, cardId)
    } catch (error) {
      operationError = error
    } finally {
      contender.exec('ROLLBACK')
      contender.close()
      databases.delete(contender)
    }

    expect(String(
      operationError && typeof operationError === 'object'
        ? (operationError as { code?: unknown }).code
        : '',
    )).toMatch(/^SQLITE_BUSY/)
    reopen(resource)

    expect(cardEventTelemetry(resource)).toEqual([
      {
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'database_locked',
        count: 1,
      },
    ])
    expect(resource.db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
  })

  it('turns a caller-owned outer rollback into one unexpected failure', () => {
    const resource = fixture()
    const { boardId, cardId } = boardAndCard(resource.db)
    const callerFailure = new Error('caller-owned rollback')

    expect(() => resource.db.transaction(() => {
      project(resource, boardId, cardId)
      throw callerFailure
    })()).toThrow(callerFailure)

    expect(resource.db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
    expect(cardEventTelemetry(resource)).toEqual([
      {
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'unexpected_failure',
        count: 1,
      },
    ])
  })

  it('turns a caller-owned outer IMMEDIATE rollback into one unexpected failure', () => {
    const resource = fixture()
    const { boardId, cardId } = boardAndCard(resource.db)
    const callerFailure = new Error('caller-owned immediate rollback')

    expect(() => resource.db.transaction(() => {
      project(resource, boardId, cardId)
      throw callerFailure
    }).immediate()).toThrow(callerFailure)

    expect(resource.db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
    expect(cardEventTelemetry(resource)).toEqual([
      {
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'unexpected_failure',
        count: 1,
      },
    ])
  })

  it('survives protected TEMP telemetry rejection without false success', () => {
    const resource = fixture()
    const { boardId, cardId } = boardAndCard(resource.db)
    resource.db.exec(`
      CREATE TEMP TRIGGER reject_projection_telemetry
      BEFORE INSERT ON os_compatibility_migration_telemetry_daily
      BEGIN
        SELECT RAISE(ABORT, 'private protected telemetry rejection');
      END
    `)

    expect(() => project(resource, boardId, cardId))
      .toThrow(/protected TEMP schema object/i)
    expect(resource.db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
    resource.db.exec('DROP TRIGGER temp.reject_projection_telemetry')

    expect(cardEventTelemetry(resource)).toEqual([
      {
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'schema_incompatible',
        count: 1,
      },
    ])
  })

  it('never persists provider payloads or arbitrary details in telemetry or the journal', () => {
    const resource = fixture()
    const { boardId, cardId } = boardAndCard(resource.db)
    const privatePayload = [
      'provider',
      'credential',
      'payload',
      'must',
      'stay',
      'private',
    ].join('_')

    project(resource, boardId, cardId, { provider_payload: privatePayload })
    cardEventTelemetry(resource)

    const telemetry = JSON.stringify({
      daily: resource.db.prepare(`
        SELECT * FROM os_compatibility_migration_telemetry_daily
      `).all(),
      history: resource.db.prepare(`
        SELECT * FROM os_compatibility_migration_telemetry_history
      `).all(),
      coverage: resource.db.prepare(`
        SELECT * FROM os_compatibility_migration_telemetry_coverage
      `).all(),
    })
    const sidecar = new Database(resource.journalPath, { readonly: true })
    const journalRows = JSON.stringify(
      (sidecar.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'compatibility_failure_journal_%'
        ORDER BY name
      `).all() as Array<{ name: string }>).map(({ name }) => ({
        name,
        rows: sidecar.prepare(`SELECT * FROM "${name}"`).all(),
      })),
    )
    sidecar.close()

    expect(telemetry).not.toContain(privatePayload)
    expect(journalRows).not.toContain(privatePayload)
  })

  it('does not fabricate observations for ignored or structurally invalid bus events', () => {
    const resource = fixture()
    const { boardId } = boardAndCard(resource.db)
    const projection = new LegacyEventProjection(resource.db, resource.journal)

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

    expect(cardEventTelemetry(resource)).toEqual([])
  })

  it('resolves only bounded DOM-017 cohorts from trusted source identities', () => {
    const resource = fixture()
    const hash = '0'.repeat(64)
    resource.db.prepare(`
      INSERT INTO os_compatibility_projection_links (
        migration_id, source_table, source_key, source_hash,
        target_table, target_key, target_hash, disposition
      ) VALUES (?, 'card_events', '41', ?, 'os_events', 'event-41', ?, 'test')
    `).run(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID, hash, hash)
    resource.db.prepare(`
      INSERT INTO os_compatibility_projection_quarantine (
        migration_id, source_table, source_key, source_hash,
        reason_code, safe_detail
      ) VALUES (?, 'card_events', '42', ?, 'test', 'bounded')
    `).run(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID, hash)

    expect(resolveCompatibilityMigrationTelemetryCohort(
      resource.db,
      { table: 'card_events', source_id: 41 },
    )).toBe('canonical_linked')
    expect(resolveCompatibilityMigrationTelemetryCohort(
      resource.db,
      { table: 'card_events', source_id: 42 },
    )).toBe('migration_quarantined')
    expect(resolveCompatibilityMigrationTelemetryCohort(
      resource.db,
      { table: 'card_events', source_id: 43 },
    )).toBe('canonical_unlinked')
    expect(resolveCompatibilityMigrationTelemetryCohort(
      resource.db,
      { table: 'messages' },
    )).toBe('legacy_only')
    expect(resolveCompatibilityMigrationTelemetryCohort(
      resource.db,
      { table: 'milestones' },
    )).toBe('deferred_replacement')
    expect(resolveCompatibilityMigrationTelemetryCohort(
      resource.db,
      {
        table: 'agent_usage',
        board_id: 1,
        agent_id: 1,
        day: '2026-99-99',
      },
    )).toBe('canonical_unlinked')
  })

  it('drains pending failures through the real operator route binding', async () => {
    const resource = fixture()
    const { boardId, cardId } = boardAndCard(resource.db)
    const server = buildServer(resource.db, undefined, {
      agentOs: {
        compatibilityFailureJournal: resource.journal,
      },
    })
    servers.add(server)
    await server.ready()
    resource.db.exec(`
      CREATE TEMP TRIGGER reject_route_projection_event
      BEFORE INSERT ON os_events
      BEGIN
        SELECT RAISE(ABORT, 'route projection rejection');
      END
    `)

    server.bus.emit('event', {
      board_id: boardId,
      type: 'launch',
      data: { card_id: cardId, status: 'started' },
    })

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/os/compatibility-migration-telemetry/summary',
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().telemetry.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'card_events',
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'translation_rejected',
        count: 1,
      }),
    ]))
  })
})

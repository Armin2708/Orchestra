import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  bindCompatibilityMigrationFailureJournal,
  resolveCompatibilityMigrationTelemetryCohort,
} from '../src/agent-os/compatibility-migration-instrumentation.js'
import {
  AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
  applyCompatibilityForwardMigration,
} from '../src/agent-os/compatibility-forward-migration.js'
import { LegacyEventProjection } from '../src/agent-os/legacy-projection.js'
import { recordProviderUsage } from '../src/usage.js'

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
const journalBindings = new Set<() => void>()
const temporaryDirectories = new Set<string>()

afterEach(async () => {
  for (const server of servers) await server.close()
  servers.clear()
  for (const unbind of journalBindings) unbind()
  journalBindings.clear()
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

function bindJournal(resource: Fixture): () => void {
  const unbind = bindCompatibilityMigrationFailureJournal(
    resource.db,
    resource.journal,
  )
  journalBindings.add(unbind)
  return unbind
}

function agentUsageFixture(resource: Fixture): {
  boardId: number
  agentId: number
} {
  const boardId = Number(resource.db.prepare(`
    INSERT INTO boards (project_path, name)
    VALUES ('/dom019-provider-usage', 'DOM-019 provider usage')
  `).run().lastInsertRowid)
  const agentId = Number(resource.db.prepare(`
    INSERT INTO agents (board_id, name, provider)
    VALUES (?, 'usage-otter', 'codex')
  `).run(boardId).lastInsertRowid)
  return { boardId, agentId }
}

function recordUsage(
  resource: Fixture,
  boardId: number,
  agentId: number,
): void {
  recordProviderUsage(resource.db, boardId, agentId, {
    provider: 'codex',
    total_tokens: 150,
    input_tokens: 100,
    cached_input_tokens: 80,
    cache_creation_input_tokens: 0,
    output_tokens: 50,
    reasoning_output_tokens: 20,
    cost_cents: null,
  })
}

function agentUsageTelemetry(resource: Fixture): Array<{
  operation: string
  cohort: string
  diagnostic_code: string
  count: number
}> {
  queryCompatibilityMigrationTelemetrySummary(resource.db, resource.journal)
  return resource.db.prepare(`
    SELECT operation, cohort, diagnostic_code, count
    FROM os_compatibility_migration_telemetry_daily
    WHERE table_name='agent_usage'
    ORDER BY operation, cohort, diagnostic_code
  `).all() as Array<{
    operation: string
    cohort: string
    diagnostic_code: string
    count: number
  }>
}

describe('DOM-019 real compatibility instrumentation', () => {
  it('observes production legacy reads for all 13 compatibility tables without payloads', async () => {
    const resource = fixture()
    const { boardId, cardId } = boardAndCard(resource.db)
    const agentId = Number(resource.db.prepare(`
      INSERT INTO agents (board_id, name, provider)
      VALUES (?, 'read-observer', 'codex')
    `).run(boardId).lastInsertRowid)
    bindJournal(resource)
    const server = buildServer(resource.db)
    servers.add(server)
    await server.ready()

    for (const url of [
      '/api/v1/boards',
      `/api/v1/boards/${boardId}/snapshot`,
      `/api/v1/boards/${boardId}/telemetry`,
      `/api/v1/boards/${boardId}/timeline`,
      `/api/v1/boards/${boardId}/shipped`,
      `/api/v1/cards/${cardId}/events`,
      `/api/v1/agents/${agentId}/inbox`,
      `/api/v1/os/cards/${cardId}/contract`,
    ]) {
      const response = await server.inject({ method: 'GET', url })
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200)
    }

    const tables = resource.db.prepare(`
      SELECT table_name FROM os_compatibility_migration_telemetry_daily
      WHERE operation='legacy_read' ORDER BY table_name
    `).all().map((row) => (row as { table_name: string }).table_name)
    expect(tables).toEqual([
      'agent_usage', 'agents', 'boards', 'card_events', 'cards', 'deliveries',
      'ideas', 'message_targets', 'messages', 'milestones', 'review_decisions',
      'task_contracts', 'token_telemetry',
    ])
  })

  it('attributes the legacy snapshot only to the tables its implementation reads', async () => {
    const resource = fixture()
    const { boardId } = boardAndCard(resource.db)
    bindJournal(resource)
    const server = buildServer(resource.db)
    servers.add(server)
    await server.ready()

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/boards/${boardId}/snapshot`,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(resource.db.prepare(`SELECT table_name
      FROM os_compatibility_migration_telemetry_daily
      WHERE operation='legacy_read' ORDER BY table_name`).all()).toEqual([
      { table_name: 'agents' },
      { table_name: 'boards' },
      { table_name: 'cards' },
      { table_name: 'deliveries' },
      { table_name: 'ideas' },
      { table_name: 'message_targets' },
      { table_name: 'messages' },
      { table_name: 'milestones' },
    ])
  })

  it('binds canonical read routes and privacy-safe mismatch diagnostics to real responses', async () => {
    const resource = fixture()
    const { boardId, cardId } = boardAndCard(resource.db)
    const agentId = Number(resource.db.prepare(`INSERT INTO agents
      (board_id, name, provider) VALUES (?, 'canonical-read', 'codex')`)
      .run(boardId).lastInsertRowid)
    applyCompatibilityForwardMigration(resource.db)
    resource.db.prepare("UPDATE boards SET name='legitimate current name' WHERE id=?").run(boardId)
    resource.db.prepare(`UPDATE os_compatibility_projection_links SET target_key='999999'
      WHERE migration_id=? AND source_table='cards' AND source_key=?`).run(
      AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
      String(cardId),
    )
    bindJournal(resource)
    const server = buildServer(resource.db)
    servers.add(server)
    await server.ready()

    const events = await server.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${boardId}/events`,
    })
    expect(events.statusCode, events.body).toBe(200)
    const openWork = await server.inject({ method: 'GET', url: '/api/v1/os/open-work' })
    expect(openWork.statusCode, openWork.body).toBe(200)
    const contract = await server.inject({
      method: 'GET',
      url: `/api/v1/os/cards/${cardId}/contract`,
    })
    expect(contract.statusCode, contract.body).toBe(200)
    const profile = await server.inject({
      method: 'GET',
      url: `/api/v1/os/agent-profiles/legacy-agent:${agentId}`,
    })
    expect(profile.statusCode, profile.body).toBe(200)

    expect(resource.db.prepare(`
      SELECT table_name, operation, diagnostic_code
      FROM os_compatibility_migration_telemetry_daily
      WHERE operation IN ('canonical_read', 'mismatch')
      ORDER BY table_name, operation
    `).all()).toEqual(expect.arrayContaining([
      { table_name: 'boards', operation: 'canonical_read', diagnostic_code: 'none' },
      { table_name: 'card_events', operation: 'canonical_read', diagnostic_code: 'none' },
      { table_name: 'cards', operation: 'canonical_read', diagnostic_code: 'none' },
      { table_name: 'cards', operation: 'mismatch', diagnostic_code: 'missing_canonical_row' },
      { table_name: 'task_contracts', operation: 'canonical_read', diagnostic_code: 'none' },
      { table_name: 'agents', operation: 'canonical_read', diagnostic_code: 'none' },
    ]))
    expect(resource.db.prepare(`SELECT COUNT(*) AS count
      FROM os_compatibility_migration_telemetry_daily
      WHERE table_name='boards' AND operation='mismatch'`).get()).toEqual({ count: 0 })
  })

  it('records the real provider-usage translation and projection refresh atomically', () => {
    const resource = fixture()
    const { boardId, agentId } = agentUsageFixture(resource)
    bindJournal(resource)

    recordUsage(resource, boardId, agentId)
    recordUsage(resource, boardId, agentId)

    expect(resource.db.prepare(`
      SELECT provider, total_tokens, cached_input_tokens
      FROM agent_usage WHERE board_id=? AND agent_id=?
    `).get(boardId, agentId)).toEqual({
      provider: 'codex',
      total_tokens: 300,
      cached_input_tokens: 160,
    })
    expect(agentUsageTelemetry(resource)).toEqual([
      {
        operation: 'adapter_translation',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'none',
        count: 2,
      },
      {
        operation: 'legacy_write',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'none',
        count: 2,
      },
      {
        operation: 'projection_refresh',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'none',
        count: 2,
      },
    ])
  })

  it('rolls back rejected provider usage and drains one bounded failure', () => {
    const resource = fixture()
    const { boardId, agentId } = agentUsageFixture(resource)
    const privateFailure = 'private_provider_usage_rejection_detail'
    bindJournal(resource)
    resource.db.exec(`
      CREATE TEMP TRIGGER reject_provider_usage
      BEFORE INSERT ON agent_usage
      BEGIN
        SELECT RAISE(ABORT, '${privateFailure}');
      END
    `)

    expect(() => recordUsage(resource, boardId, agentId))
      .toThrow(privateFailure)

    expect(resource.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_usage
    `).get()).toEqual({ count: 0 })
    resource.db.exec('DROP TRIGGER temp.reject_provider_usage')
    expect(agentUsageTelemetry(resource)).toEqual([
      {
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'projection_refresh_rejected',
        count: 1,
      },
    ])
    expect(JSON.stringify(agentUsageTelemetry(resource)))
      .not.toContain(privateFailure)
  })

  it('turns an outer provider-usage rollback into one unexpected failure', () => {
    const resource = fixture()
    const { boardId, agentId } = agentUsageFixture(resource)
    const callerFailure = new Error('caller-owned provider usage rollback')
    bindJournal(resource)

    expect(() => resource.db.transaction(() => {
      recordUsage(resource, boardId, agentId)
      throw callerFailure
    })()).toThrow(callerFailure)

    expect(resource.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_usage
    `).get()).toEqual({ count: 0 })
    expect(agentUsageTelemetry(resource)).toEqual([
      {
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'unexpected_failure',
        count: 1,
      },
    ])
  })

  it('fails closed instead of splitting provider telemetry across UTC days', () => {
    const resource = fixture()
    const { boardId, agentId } = agentUsageFixture(resource)
    const sqliteDay = (resource.db.prepare(`
      SELECT date('now') AS day
    `).get() as { day: string }).day
    const priorDay = new Date(`${sqliteDay}T00:00:00.000Z`)
    priorDay.setUTCDate(priorDay.getUTCDate() - 1)
    priorDay.setUTCHours(23, 59, 59, 900)
    bindJournal(resource)
    vi.useFakeTimers({ now: priorDay })
    try {
      expect(() => recordUsage(resource, boardId, agentId))
        .toThrow(/crossed a UTC day boundary/)
    } finally {
      vi.useRealTimers()
    }

    expect(resource.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_usage
    `).get()).toEqual({ count: 0 })
    expect(agentUsageTelemetry(resource)).toEqual([
      {
        operation: 'failure',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'projection_refresh_rejected',
        count: 1,
      },
    ])
  })

  it('keeps journal ownership single and stops instrumentation after unbind', () => {
    const resource = fixture()
    const { boardId, agentId } = agentUsageFixture(resource)
    const unbind = bindJournal(resource)

    expect(() => bindCompatibilityMigrationFailureJournal(
      resource.db,
      resource.journal,
    )).toThrow(/already bound/)

    unbind()
    resource.journal.close()
    journals.delete(resource.journal)
    let observedTransaction = false
    resource.db.function('observe_provider_usage_transaction', () => {
      observedTransaction = resource.db.inTransaction
      return 1
    })
    resource.db.exec(`
      CREATE TEMP TRIGGER observe_unbound_provider_usage_transaction
      BEFORE INSERT ON agent_usage
      BEGIN
        SELECT observe_provider_usage_transaction();
      END
    `)
    expect(() => recordUsage(resource, boardId, agentId)).not.toThrow()
    expect(observedTransaction).toBe(true)

    expect(resource.db.prepare(`
      SELECT operation, cohort, diagnostic_code, count
      FROM os_compatibility_migration_telemetry_daily
      WHERE table_name='agent_usage'
      ORDER BY operation
    `).all()).toEqual([
      {
        operation: 'legacy_write',
        cohort: 'canonical_unlinked',
        diagnostic_code: 'none',
        count: 1,
      },
    ])
  })

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

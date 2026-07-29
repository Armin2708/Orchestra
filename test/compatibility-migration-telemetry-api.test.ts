import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID,
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_SCHEMA_OBJECT_NAMES,
  AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS,
  AGENT_OS_COMPATIBILITY_TELEMETRY_MISMATCH_DIAGNOSTICS,
  applyCompatibilityMigrationTelemetryMigration,
  recordCompatibilityMigrationTelemetry,
  refreshCompatibilityMigrationTelemetryCollectorEpoch,
} from '../src/agent-os/compatibility-migration-telemetry.js'
import { registerAgentOsRoutes } from '../src/agent-os/routes.js'

const OPERATOR_HEADERS = { 'x-test-operator': 'true' }
const servers: FastifyInstance[] = []
const databases: Database.Database[] = []
const tempDirectories: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

async function fixtureForDatabase(db: Database.Database) {
  databases.push(db)
  const server = Fastify()
  server.decorate('bus', new EventEmitter())
  registerAgentOsRoutes(server, {
    db,
    isOperator: (request) =>
      request.headers['x-test-operator'] === 'true',
  })
  servers.push(server)
  await server.ready()
  return { db, server }
}

async function fixture(filename = ':memory:') {
  return fixtureForDatabase(openDb(filename))
}

async function release(
  resource: Awaited<ReturnType<typeof fixture>>,
): Promise<void> {
  const serverIndex = servers.indexOf(resource.server)
  if (serverIndex !== -1) servers.splice(serverIndex, 1)
  await resource.server.close()
  const databaseIndex = databases.indexOf(resource.db)
  if (databaseIndex !== -1) databases.splice(databaseIndex, 1)
  resource.db.close()
}

function utcDayOffset(day: string, offset: number): string {
  const value = new Date(`${day}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

function recordDiagnostics(db: Database.Database, day: string): void {
  const observedAt = new Date(`${day}T12:00:00.000Z`)
  recordCompatibilityMigrationTelemetry(db, {
    observed_at: observedAt,
    table: 'cards',
    operation: 'mismatch',
    cohort: 'canonical_linked',
    diagnostic_code: 'value_mismatch',
    count: 2,
  })
  recordCompatibilityMigrationTelemetry(db, {
    observed_at: observedAt,
    table: 'cards',
    operation: 'failure',
    cohort: 'canonical_linked',
    diagnostic_code: 'unexpected_failure',
    count: 3,
  })
}

function reinstallTelemetry(
  db: Database.Database,
  appliedAt: string,
): void {
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
  applyCompatibilityMigrationTelemetryMigration(db)
  db.prepare(`
    INSERT INTO os_schema_migrations (id, applied_at)
    VALUES (?, ?)
  `).run(AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID, appliedAt)
  refreshCompatibilityMigrationTelemetryCollectorEpoch(db, {
    now: new Date(appliedAt.replace(' ', 'T') + 'Z'),
  })
}

describe('compatibility migration telemetry API', () => {
  it('exposes bounded operator queries, diagnostics, retention, and rollup', async () => {
    const { db, server } = await fixture()
    const today = new Date().toISOString().slice(0, 10)
    recordDiagnostics(db, today)

    const summary = await server.inject({
      method: 'GET',
      url: '/api/v1/os/compatibility-migration-telemetry/summary',
      headers: OPERATOR_HEADERS,
    })
    expect(summary.statusCode).toBe(200)
    expect(summary.json()).toMatchObject({
      telemetry: {
        total_count: 5,
        mismatch_count: 2,
        failure_count: 3,
      },
      diagnostics: {
        mismatch: [...AGENT_OS_COMPATIBILITY_TELEMETRY_MISMATCH_DIAGNOSTICS],
        failure: [...AGENT_OS_COMPATIBILITY_TELEMETRY_FAILURE_DIAGNOSTICS],
      },
      retention_rule: {
        minimum_daily_retention_days: 90,
        maximum_daily_retention_days: 3_650,
      },
      writer_observation_rule: {
        minimum_complete_utc_days: 30,
        writer_removal_authorized: false,
        operator_gate: 'ORC-020',
      },
    })
    expect(summary.json().telemetry.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'cards',
        operation: 'mismatch',
        diagnostic_code: 'value_mismatch',
        count: 2,
      }),
      expect.objectContaining({
        table: 'cards',
        operation: 'failure',
        diagnostic_code: 'unexpected_failure',
        count: 3,
      }),
    ]))

    const daily = await server.inject({
      method: 'GET',
      url: `/api/v1/os/compatibility-migration-telemetry/daily`
        + `?from_day=${today}&through_day=${today}&table=cards`,
      headers: OPERATOR_HEADERS,
    })
    expect(daily.statusCode).toBe(200)
    expect(daily.json().telemetry).toMatchObject({
      from_day: today,
      through_day: today,
      table: 'cards',
      total_count: 5,
      mismatch_count: 2,
      failure_count: 3,
    })

    const writerObservation = await server.inject({
      method: 'GET',
      url: `/api/v1/os/compatibility-migration-telemetry/writer-observation`
        + `?table=cards&from_day=${utcDayOffset(today, -29)}`
        + `&through_day=${today}`,
      headers: OPERATOR_HEADERS,
    })
    expect(writerObservation.statusCode).toBe(200)
    expect(writerObservation.json().observation).toMatchObject({
      table: 'cards',
      calendar_days: 30,
      status: 'insufficient_observation',
      reason: 'coverage_gap',
      writer_removal_authorized: false,
      operator_gate: 'ORC-020',
    })

    const rollup = await server.inject({
      method: 'POST',
      url: '/api/v1/os/compatibility-migration-telemetry/rollup',
      headers: OPERATOR_HEADERS,
      payload: { retain_days: 90 },
    })
    expect(rollup.statusCode).toBe(200)
    expect(rollup.json().rollup).toMatchObject({
      retain_from_day: utcDayOffset(today, -89),
      rows_compacted: 0,
      count_compacted: 0,
      mismatch_count_compacted: 0,
      failure_count_compacted: 0,
    })

    const currentDaySeal = await server.inject({
      method: 'POST',
      url: '/api/v1/os/compatibility-migration-telemetry/seal',
      headers: OPERATOR_HEADERS,
      payload: { day: today },
    })
    expect(currentDaySeal.statusCode).toBe(400)
    expect(currentDaySeal.json()).toMatchObject({
      code: 'validation_error',
      error: 'only a completed UTC day can be sealed',
    })
  })

  it('requires operator authority before every query or mutation', async () => {
    const { db, server } = await fixture()
    const today = new Date().toISOString().slice(0, 10)
    const before = db.prepare(`
      SELECT COUNT(*) AS count
      FROM os_compatibility_migration_telemetry_coverage
    `).get()
    const requests = [
      {
        method: 'GET' as const,
        url: '/api/v1/os/compatibility-migration-telemetry/summary',
      },
      {
        method: 'GET' as const,
        url: `/api/v1/os/compatibility-migration-telemetry/daily`
          + `?from_day=${today}&through_day=${today}`,
      },
      {
        method: 'GET' as const,
        url: `/api/v1/os/compatibility-migration-telemetry/writer-observation`
          + `?table=cards&from_day=${today}&through_day=${today}`,
      },
      {
        method: 'POST' as const,
        url: '/api/v1/os/compatibility-migration-telemetry/seal',
        payload: { day: utcDayOffset(today, -1) },
      },
      {
        method: 'POST' as const,
        url: '/api/v1/os/compatibility-migration-telemetry/rollup',
        payload: { retain_days: 90 },
      },
    ]

    for (const request of requests) {
      const response = await server.inject(request)
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({
        code: 'forbidden',
        error: expect.stringMatching(/operator authorization/),
      })
    }
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM os_compatibility_migration_telemetry_coverage
    `).get()).toEqual(before)
  })

  it('seals a completed day idempotently and exposes diagnostic coverage', async () => {
    const { db, server } = await fixture()
    reinstallTelemetry(db, '2026-01-01 12:00:00')
    expect(db.prepare(`
      SELECT valid_from_day
      FROM os_compatibility_migration_telemetry_state
    `).get()).toEqual({ valid_from_day: '2026-01-01' })
    recordDiagnostics(db, '2026-01-02')

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sealed = await server.inject({
        method: 'POST',
        url: '/api/v1/os/compatibility-migration-telemetry/seal',
        headers: OPERATOR_HEADERS,
        payload: { day: '2026-01-02' },
      })
      expect(sealed.statusCode, sealed.body).toBe(200)
      expect(sealed.json()).toEqual({ sealed_day: '2026-01-02' })
    }
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM os_compatibility_migration_telemetry_coverage
      WHERE day='2026-01-02'
    `).get()).toEqual({ count: 13 })

    const observation = await server.inject({
      method: 'GET',
      url: '/api/v1/os/compatibility-migration-telemetry/writer-observation'
        + '?table=cards&from_day=2026-01-02&through_day=2026-01-02',
      headers: OPERATOR_HEADERS,
    })
    expect(observation.statusCode).toBe(200)
    expect(observation.json().observation).toMatchObject({
      covered_days: 1,
      mismatch_count: 2,
      failure_count: 3,
      status: 'diagnostic_risk_observed',
      reason: 'diagnostic_nonzero',
      writer_removal_authorized: false,
    })
  })

  it('rejects malformed or secret-shaped input without echoing it', async () => {
    const { server } = await fixture()
    const today = new Date().toISOString().slice(0, 10)
    const sensitiveKey =
      ['PRIVATE', '_KEY=', 'dom019', '-test-input'].join('')

    const extraQuery = await server.inject({
      method: 'GET',
      url: `/api/v1/os/compatibility-migration-telemetry/daily`
        + `?from_day=${today}&through_day=${today}`
        + `&${encodeURIComponent(sensitiveKey)}=ignored`,
      headers: OPERATOR_HEADERS,
    })
    expect(extraQuery.statusCode).toBe(400)
    expect(extraQuery.body).not.toContain(sensitiveKey)
    expect(extraQuery.json()).toMatchObject({
      code: 'validation_error',
      error: 'query keys are invalid (missing_count=0 unexpected_count=1)',
    })

    const invalidTable = await server.inject({
      method: 'GET',
      url: `/api/v1/os/compatibility-migration-telemetry/daily`
        + `?from_day=${today}&through_day=${today}`
        + `&table=${encodeURIComponent(sensitiveKey)}`,
      headers: OPERATOR_HEADERS,
    })
    expect(invalidTable.statusCode).toBe(400)
    expect(invalidTable.body).not.toContain(sensitiveKey)
    expect(invalidTable.json()).toMatchObject({
      code: 'validation_error',
      error: 'table is not a supported compatibility telemetry value',
    })

    const extraBody = await server.inject({
      method: 'POST',
      url: '/api/v1/os/compatibility-migration-telemetry/rollup',
      headers: OPERATOR_HEADERS,
      payload: { retain_days: 90, [sensitiveKey]: 'ignored' },
    })
    expect(extraBody.statusCode).toBe(400)
    expect(extraBody.body).not.toContain(sensitiveKey)
    expect(extraBody.json()).toMatchObject({
      code: 'validation_error',
      error: 'request body keys are invalid'
        + ' (missing_count=0 unexpected_count=1)',
    })
  })

  it('preserves operator query evidence across a database restart', async () => {
    const directory = fs.mkdtempSync(path.join(
      os.tmpdir(),
      'orchestra-dom019-api-restart-',
    ))
    tempDirectories.push(directory)
    const filename = path.join(directory, 'orchestra.db')
    const first = await fixture(filename)
    const today = new Date().toISOString().slice(0, 10)
    recordDiagnostics(first.db, today)
    const before = await first.server.inject({
      method: 'GET',
      url: '/api/v1/os/compatibility-migration-telemetry/summary',
      headers: OPERATOR_HEADERS,
    })
    expect(before.statusCode).toBe(200)
    await release(first)

    const reopened = await fixture(filename)
    const after = await reopened.server.inject({
      method: 'GET',
      url: '/api/v1/os/compatibility-migration-telemetry/summary',
      headers: OPERATOR_HEADERS,
    })
    expect(after.statusCode).toBe(200)
    expect(after.json().telemetry).toEqual(before.json().telemetry)
  })
})

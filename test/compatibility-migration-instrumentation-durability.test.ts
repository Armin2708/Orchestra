import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
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

function fileDatabase() {
  const directory = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'agentboard-dom019-durability-',
  ))
  temporaryDirectories.push(directory)
  const location = path.join(directory, 'agentboard.sqlite')
  const db = openDb(location)
  databases.push(db)
  db.pragma('busy_timeout = 1')
  return { db, location }
}

function boardAndCard(db: ReturnType<typeof openDb>) {
  const boardId = Number(db.prepare(`
    INSERT INTO boards (project_path, name)
    VALUES ('/durability', 'durability')
  `).run().lastInsertRowid)
  const cardId = Number(db.prepare(`
    INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Instrument', 'Require durable failure evidence')
  `).run(boardId).lastInsertRowid)
  return { boardId, cardId }
}

function project(
  db: ReturnType<typeof openDb>,
  boardId: number,
  cardId: number,
) {
  new LegacyEventProjection(db).project({
    board_id: boardId,
    type: 'launch',
    data: { card_id: cardId, status: 'started' },
  })
}

function failureTelemetry(db: ReturnType<typeof openDb>) {
  return db.prepare(`
    SELECT cohort, diagnostic_code, count
    FROM os_compatibility_migration_telemetry_daily
    WHERE table_name='card_events' AND operation='failure'
    ORDER BY cohort, diagnostic_code
  `).all()
}

// RED: these are release acceptance regressions, not assertions that false-zero behavior is valid.
// They require the reviewed independent collector plus query/seal integration before this
// candidate can be integrated.
describe('DOM-019 durable event-projection failure evidence', () => {
  it('persists database_locked after another SQLite writer releases WAL', () => {
    const { db, location } = fileDatabase()
    const contender = openDb(location)
    databases.push(contender)
    contender.pragma('busy_timeout = 1')
    const { boardId, cardId } = boardAndCard(db)
    contender.exec('BEGIN IMMEDIATE')
    let operationError: unknown
    try {
      project(db, boardId, cardId)
    } catch (error) {
      operationError = error
    } finally {
      contender.exec('ROLLBACK')
    }

    expect(String(
      operationError && typeof operationError === 'object'
        ? (operationError as { code?: unknown }).code
        : '',
    )).toMatch(/^SQLITE_BUSY/)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
    expect(failureTelemetry(db)).toEqual([
      {
        cohort: 'canonical_unlinked',
        diagnostic_code: 'database_locked',
        count: 1,
      },
    ])
  })

  it('persists failure evidence after a caller-owned outer rollback', () => {
    const { db } = fileDatabase()
    const { boardId, cardId } = boardAndCard(db)
    const callerFailure = new Error('caller-owned rollback')
    let observedError: unknown

    try {
      db.transaction(() => {
        project(db, boardId, cardId)
        throw callerFailure
      })()
    } catch (error) {
      observedError = error
    }

    expect(observedError).toBe(callerFailure)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COALESCE(SUM(count), 0) AS count
      FROM os_compatibility_migration_telemetry_daily
      WHERE table_name='card_events' AND operation='failure'
    `).get()).toEqual({ count: 1 })
  })

  it('persists schema failure through a protected connection-local TEMP trigger', () => {
    const { db } = fileDatabase()
    const { boardId, cardId } = boardAndCard(db)
    db.exec(`
      CREATE TEMP TRIGGER reject_projection_telemetry
      BEFORE INSERT ON os_compatibility_migration_telemetry_daily
      BEGIN
        SELECT RAISE(ABORT, 'protected telemetry rejection');
      END
    `)
    let operationError: unknown

    try {
      project(db, boardId, cardId)
    } catch (error) {
      operationError = error
    }

    expect(operationError).toBeInstanceOf(Error)
    expect((operationError as Error).message)
      .toMatch(/protected TEMP schema object/i)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_events WHERE source='legacy_bus'
    `).get()).toEqual({ count: 0 })
    expect(failureTelemetry(db)).toEqual([
      {
        cohort: 'canonical_unlinked',
        diagnostic_code: 'schema_incompatible',
        count: 1,
      },
    ])
  })
})

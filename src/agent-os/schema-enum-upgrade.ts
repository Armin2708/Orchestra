import type Database from 'better-sqlite3'

// Upgrade path for constraint-only schema drift (#123): governance contracts occasionally
// grow their CHECK constraints (e.g. new legacy tables joining the telemetry table enums
// and gaining per-table OR-branches). The exact-schema asserts then reject every existing
// database even though no column changed. This module rebuilds drifted objects to the
// expected text — and refuses anything whose COLUMN shape differs. Data is copied through
// the new constraints, so rows that would violate the new schema abort the upgrade.

export type ExpectedSchemaObject = {
  readonly type: string
  readonly name: string
  readonly sql: string
}

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()
}

function columnShape(db: Database.Database, table: string): string {
  const columns = db.pragma(`table_info(${JSON.stringify(table)})`) as ColumnInfo[]
  return JSON.stringify(columns.map((column) => [
    column.name, column.type, column.notnull, column.dflt_value, column.pk,
  ]))
}

/**
 * Bring every expected object whose stored schema text drifted back to the expected text:
 * tables are rebuilt in place (create-new → copy → drop-old → rename) when their column
 * shape is unchanged; owned triggers/indexes are dropped and recreated; objects the
 * contract gained are created. Any column-shape change throws — no blind rewrites.
 *
 * Returns the names of upgraded objects (empty when the schema already matches).
 */
export function upgradeEnumOnlySchemaDrift(
  db: Database.Database,
  expectedObjects: readonly ExpectedSchemaObject[],
): string[] {
  const drifted: ExpectedSchemaObject[] = []
  const missing: ExpectedSchemaObject[] = []
  for (const expected of expectedObjects) {
    const actual = db.prepare(`
      SELECT type, name, sql FROM sqlite_master WHERE name=? AND sql IS NOT NULL
    `).get(expected.name) as { type: string; name: string; sql: string } | undefined
    if (!actual) { missing.push(expected); continue }
    if (actual.type !== expected.type) {
      throw new Error(`schema upgrade refused: ${expected.name} is a ${actual.type}, expected ${expected.type}`)
    }
    if (normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(expected.sql)) drifted.push(expected)
  }
  if (!drifted.length && !missing.length) return []

  const upgrade = db.transaction(() => {
    // every owned trigger/index comes off first: integrity triggers on OTHER tables
    // reference the tables being rebuilt, and all of them are recreated verbatim below
    for (const object of expectedObjects) {
      if (object.type !== 'trigger' && object.type !== 'index') continue
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE name=? AND type=?`)
        .get(object.name, object.type)
      if (exists) db.exec(`DROP ${object.type.toUpperCase()} ${object.name}`)
    }

    for (const object of drifted) {
      if (object.type !== 'table') continue
      // rename the old table aside so the replacement is created from the verbatim
      // expected SQL — the stored schema text ends up exactly what the asserts compare
      const scratch = `${object.name}__enum_upgrade_old`
      db.exec(`ALTER TABLE ${object.name} RENAME TO ${scratch}`)
      db.exec(`${object.sql};`)
      if (columnShape(db, scratch) !== columnShape(db, object.name)) {
        throw new Error(`schema upgrade refused: ${object.name} column shape differs from the expected schema`)
      }
      // copying re-validates every row against the new constraints; violations abort here
      db.exec(`INSERT INTO ${object.name} SELECT * FROM ${scratch}`)
      db.exec(`DROP TABLE ${scratch}`)
    }

    // recreate the dropped triggers/indexes and create contract-new objects
    for (const object of expectedObjects) {
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE name=?`).get(object.name)
      if (!exists) db.exec(`${object.sql};`)
    }
  })
  // the rename-aside must not rewrite other tables' REFERENCES clauses to the scratch
  // name: that requires BOTH foreign_keys=OFF (a no-op inside a transaction, so set here)
  // AND legacy_alter_table=ON — either alone still rewrites
  const foreignKeysWereOn = db.pragma('foreign_keys', { simple: true }) === 1
  if (foreignKeysWereOn) db.pragma('foreign_keys = OFF')
  db.pragma('legacy_alter_table = ON')
  try {
    upgrade.immediate()
  } finally {
    db.pragma('legacy_alter_table = OFF')
    if (foreignKeysWereOn) db.pragma('foreign_keys = ON')
  }

  const check = db.pragma('quick_check', { simple: true })
  if (check !== 'ok') {
    throw new Error(`schema upgrade left the database unhealthy: ${String(check)}`)
  }
  const fkViolations = db.pragma('foreign_key_check') as unknown[]
  if (foreignKeysWereOn && fkViolations.length) {
    throw new Error(`schema upgrade left ${fkViolations.length} foreign key violation(s)`)
  }
  return [...drifted, ...missing].map((object) => object.name)
}

import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { upgradeEnumOnlySchemaDrift } from '../src/agent-os/schema-enum-upgrade.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'

const TELEMETRY_TABLES = [
  'os_compatibility_migration_telemetry_daily',
  'os_compatibility_migration_telemetry_history',
  'os_compatibility_migration_telemetry_coverage',
]

// Rewrites the live schema text to the pre-teams shape: drops 'agent_transcripts' and
// 'teams' from every IN (...) list, reproducing a production DB created before 9e8e601.
function downgradeToPreTeamsShape(db: Database.Database): string[] {
  const objects = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND (name LIKE 'os_compatibility_migration_telemetry_%'
      OR name LIKE 'trg_os_compatibility_telemetry_%')
  `).all() as Array<{ type: string; name: string; sql: string }>
  // objects that only exist because of the teams contract growth would not exist at all
  // in a pre-teams database — drop them outright
  for (const object of objects) {
    if (/agent_transcripts|teams/.test(object.name)) {
      db.exec(`DROP ${object.type.toUpperCase()} ${object.name}`)
    }
  }
  const remaining = objects.filter((object) => !/agent_transcripts|teams/.test(object.name))
  const downgraded = remaining
    .map((object) => ({
      ...object,
      sql: object.sql
        .replace(/'agent_transcripts'\s*,\s*/g, '')
        .replace(/,\s*'agent_transcripts'/g, '')
        .replace(/'teams'\s*,\s*/g, '')
        .replace(/,\s*'teams'/g, ''),
    }))
    .filter((object, index) => object.sql !== remaining[index].sql)
  db.unsafeMode(true)
  db.pragma('writable_schema = ON')
  const update = db.prepare(`UPDATE sqlite_master SET sql=? WHERE name=? AND type=?`)
  for (const object of downgraded) update.run(object.sql, object.name, object.type)
  db.pragma('writable_schema = RESET')
  db.unsafeMode(false)
  return downgraded.map((object) => object.name)
}

it('boots a pre-teams database by upgrading enum-only telemetry schema drift in place', () => {
  const db = openDb(':memory:')
  const coverageBefore = (db.prepare(`
    SELECT COUNT(*) AS c FROM os_compatibility_migration_telemetry_coverage
  `).get() as { c: number }).c

  const downgraded = downgradeToPreTeamsShape(db)
  expect(downgraded.length).toBeGreaterThan(0)

  // pre-teams schema text is live: the boot-time migration path must upgrade, not crash
  applyAgentOsMigrations(db)

  for (const table of TELEMETRY_TABLES) {
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name=?`).get(table) as { sql: string } | undefined)?.sql
    if (!sql) continue
    if (sql.includes("'token_telemetry'")) expect(sql).toContain("'teams'")
  }
  // existing rows survive the upgrade
  expect((db.prepare(`
    SELECT COUNT(*) AS c FROM os_compatibility_migration_telemetry_coverage
  `).get() as { c: number }).c).toBe(coverageBefore)
})

it('rebuilding a referenced parent table keeps child REFERENCES clauses on the final name', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('a')))`)
  db.exec(`CREATE TABLE child (id INTEGER PRIMARY KEY REFERENCES parent(id) ON DELETE CASCADE)`)
  db.prepare(`INSERT INTO parent (id, kind) VALUES (1, 'a')`).run()
  db.prepare(`INSERT INTO child (id) VALUES (1)`).run()

  const upgraded = upgradeEnumOnlySchemaDrift(db, [
    { type: 'table', name: 'parent', sql: `CREATE TABLE parent (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('a','b')))` },
    { type: 'table', name: 'child', sql: `CREATE TABLE child (id INTEGER PRIMARY KEY REFERENCES parent(id) ON DELETE CASCADE)` },
  ])
  expect(upgraded).toEqual(['parent'])
  const childSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='child'`).get() as { sql: string }).sql
  expect(childSql).toContain('REFERENCES parent(id)')
  expect(childSql).not.toContain('enum_upgrade')
  // FK still works against the rebuilt parent
  db.prepare(`DELETE FROM parent WHERE id=1`).run()
  expect((db.prepare(`SELECT COUNT(*) AS c FROM child`).get() as { c: number }).c).toBe(0)
})

it('refuses non-enum drift and enum shrinkage', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE guarded (kind TEXT NOT NULL CHECK (kind IN ('a','b')))`)
  db.prepare(`INSERT INTO guarded (kind) VALUES ('a')`).run()

  // superset growth is allowed and preserves rows
  const grown = upgradeEnumOnlySchemaDrift(db, [{
    type: 'table', name: 'guarded',
    sql: `CREATE TABLE guarded (kind TEXT NOT NULL CHECK (kind IN ('a','b','c')))`,
  }])
  expect(grown).toEqual(['guarded'])
  db.prepare(`INSERT INTO guarded (kind) VALUES ('c')`).run()
  expect((db.prepare(`SELECT COUNT(*) AS c FROM guarded`).get() as { c: number }).c).toBe(2)

  // shrinking the list below stored values fails row re-validation: refused
  expect(() => upgradeEnumOnlySchemaDrift(db, [{
    type: 'table', name: 'guarded',
    sql: `CREATE TABLE guarded (kind TEXT NOT NULL CHECK (kind IN ('a')))`,
  }])).toThrow(/CHECK/)

  // column drift: refused before any data is touched
  expect(() => upgradeEnumOnlySchemaDrift(db, [{
    type: 'table', name: 'guarded',
    sql: `CREATE TABLE guarded (kind TEXT NOT NULL CHECK (kind IN ('a','b','c')), extra TEXT)`,
  }])).toThrow(/column shape differs/)

  // matching schema is a no-op
  expect(upgradeEnumOnlySchemaDrift(db, [{
    type: 'table', name: 'guarded',
    sql: `CREATE TABLE guarded (kind TEXT NOT NULL CHECK (kind IN ('a','b','c')))`,
  }])).toEqual([])
})

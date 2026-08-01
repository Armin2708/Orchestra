import { describe, expect, it } from 'vitest'
import {
  AGENT_OS_ORGANIZATION_COORDINATION_MIGRATION_ID,
  AGENT_OS_ORGANIZATION_COORDINATION_TABLES,
} from '../src/agent-os/organization-coordination-migration.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { openDb } from '../src/db.js'

describe('organization coordination migration', () => {
  it('installs all coordination records and replays compatibly', () => {
    const db = openDb(':memory:')
    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ name: string }>).map((row) => row.name))
    for (const table of AGENT_OS_ORGANIZATION_COORDINATION_TABLES) {
      expect(tables.has(table), table).toBe(true)
    }
    expect(db.prepare('SELECT 1 FROM os_schema_migrations WHERE id=?')
      .get(AGENT_OS_ORGANIZATION_COORDINATION_MIGRATION_ID)).toBeTruthy()
    db.prepare('DELETE FROM os_schema_migrations WHERE id=?')
      .run(AGENT_OS_ORGANIZATION_COORDINATION_MIGRATION_ID)
    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    db.close()
  })

  it('fails closed on a displaced coordination table', () => {
    const db = openDb(':memory:')
    db.exec(`
      DROP TABLE os_capacity_snapshots;
      CREATE TABLE os_capacity_snapshots (id TEXT PRIMARY KEY);
      DELETE FROM os_schema_migrations WHERE id='028-agent-organization-coordination';
    `)
    expect(() => applyAgentOsMigrations(db))
      .toThrow(/os_capacity_snapshots has an incompatible schema/)
    expect(db.prepare(`SELECT 1 FROM os_schema_migrations
      WHERE id='028-agent-organization-coordination'`).get()).toBeUndefined()
    db.close()
  })
})

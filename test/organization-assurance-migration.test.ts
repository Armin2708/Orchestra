import { describe, expect, it } from 'vitest'
import {
  AGENT_OS_ORGANIZATION_ASSURANCE_MIGRATION_ID,
  AGENT_OS_ORGANIZATION_ASSURANCE_TABLES,
} from '../src/agent-os/organization-assurance-migration.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { openDb } from '../src/db.js'

describe('organization assurance migration', () => {
  it('installs and replays every assurance table', () => {
    const db = openDb(':memory:')
    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ name: string }>).map((row) => row.name))
    for (const table of AGENT_OS_ORGANIZATION_ASSURANCE_TABLES) {
      expect(tables.has(table), table).toBe(true)
    }
    expect(db.prepare('SELECT 1 FROM os_schema_migrations WHERE id=?')
      .get(AGENT_OS_ORGANIZATION_ASSURANCE_MIGRATION_ID)).toBeTruthy()
    db.prepare('DELETE FROM os_schema_migrations WHERE id=?')
      .run(AGENT_OS_ORGANIZATION_ASSURANCE_MIGRATION_ID)
    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    db.close()
  })

  it('fails closed on incompatible assurance state', () => {
    const db = openDb(':memory:')
    db.exec(`
      DROP TABLE os_trace_edges;
      CREATE TABLE os_trace_edges (id TEXT PRIMARY KEY);
      DELETE FROM os_schema_migrations WHERE id='029-agent-organization-assurance';
    `)
    expect(() => applyAgentOsMigrations(db))
      .toThrow(/os_trace_edges has an incompatible schema/)
    expect(db.prepare(`SELECT 1 FROM os_schema_migrations
      WHERE id='029-agent-organization-assurance'`).get()).toBeUndefined()
    db.close()
  })
})

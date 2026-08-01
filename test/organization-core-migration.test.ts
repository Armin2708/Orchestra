import { describe, expect, it } from 'vitest'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import {
  AGENT_OS_ORGANIZATION_CORE_MIGRATION_ID,
  AGENT_OS_ORGANIZATION_CORE_TABLES,
} from '../src/agent-os/organization-migration.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { openDb } from '../src/db.js'

describe('organization core migration', () => {
  it('installs the complete compatible schema and safely replays it', () => {
    const db = openDb(':memory:')

    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table'`).all() as Array<{ name: string }>).map((row) => row.name))
    for (const table of AGENT_OS_ORGANIZATION_CORE_TABLES) {
      expect(tables.has(table), table).toBe(true)
    }
    expect((db.prepare(`SELECT id FROM os_schema_migrations ORDER BY rowid DESC LIMIT 1`)
      .get() as { id: string }).id).toBe(AGENT_OS_ORGANIZATION_CORE_MIGRATION_ID)

    db.prepare('DELETE FROM os_schema_migrations WHERE id=?')
      .run(AGENT_OS_ORGANIZATION_CORE_MIGRATION_ID)
    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?`)
      .get(AGENT_OS_ORGANIZATION_CORE_MIGRATION_ID) as { count: number }).count).toBe(1)
    db.close()
  })

  it('fails closed when an existing organization table has an incompatible shape', () => {
    const db = openDb(':memory:')
    db.exec(`
      DROP TABLE os_team_ownerships;
      CREATE TABLE os_team_ownerships (id TEXT PRIMARY KEY);
      DELETE FROM os_schema_migrations WHERE id='027-agent-organization-core';
    `)

    expect(() => applyAgentOsMigrations(db))
      .toThrow(/os_team_ownerships has an incompatible schema/)
    expect(db.prepare(`SELECT 1 FROM os_schema_migrations
      WHERE id='027-agent-organization-core'`).get()).toBeUndefined()
    db.close()
  })

  it('rejects cross-board membership inserts and cross-organization updates', () => {
    const db = openDb(':memory:')
    const firstBoardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/organization-a', 'Organization A')`).run().lastInsertRowid)
    const secondBoardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/organization-b', 'Organization B')`).run().lastInsertRowid)
    const profiles = new AgentProfileService(db)
    const firstProfile = profiles.create({
      boardId: firstBoardId,
      name: 'Builder',
      actor: { type: 'human', id: 'owner' },
      idempotencyKey: 'profile-builder',
    })
    const secondProfile = profiles.create({
      boardId: secondBoardId,
      name: 'Outsider',
      actor: { type: 'human', id: 'owner' },
      idempotencyKey: 'profile-outsider',
    })
    const now = '2026-08-01T20:00:00.000Z'
    db.prepare(`INSERT INTO os_organizations
      (id, board_id, organization_key, name, mission, status, created_at, updated_at)
      VALUES ('org-a', ?, 'a', 'A', 'Mission A', 'active', ?, ?),
             ('org-a2', ?, 'a2', 'A2', 'Mission A2', 'active', ?, ?)`)
      .run(firstBoardId, now, now, firstBoardId, now, now)
    db.prepare(`INSERT INTO os_teams
      (id, organization_id, team_key, name, mission, status, created_at, updated_at)
      VALUES ('team-a', 'org-a', 'a', 'Team A', 'Own A', 'active', ?, ?),
             ('team-a2', 'org-a2', 'a2', 'Team A2', 'Own A2', 'active', ?, ?)`)
      .run(now, now, now, now)

    const insertMembership = db.prepare(`INSERT INTO os_team_memberships
      (id, organization_id, team_id, agent_profile_id, state, allocation_milli,
       effective_from, created_at, updated_at)
      VALUES (?, 'org-a', 'team-a', ?, 'active', 100000, ?, ?, ?)`)
    expect(() => insertMembership.run('bad-membership', secondProfile.id, now, now, now))
      .toThrow(/membership scope is inconsistent/)

    insertMembership.run('membership', firstProfile.id, now, now, now)
    expect(() => db.prepare(`UPDATE os_team_memberships
      SET team_id='team-a2' WHERE id='membership'`).run())
      .toThrow(/membership scope is inconsistent/)
    db.close()
  })
})

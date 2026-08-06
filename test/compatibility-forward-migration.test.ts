import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
  AGENT_OS_COMPATIBILITY_FORWARD_PLAN,
  AGENT_OS_COMPATIBILITY_VALIDATION_QUERIES,
  applyCompatibilityForwardMigration,
  compatibilityForwardPlanCoverage,
  validateCompatibilityForwardMigration,
} from '../src/agent-os/compatibility-forward-migration.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function removeMarker(db: Database.Database): void {
  db.prepare('DELETE FROM os_schema_migrations WHERE id=?')
    .run(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)
}

function insertLegacyFixture(db: Database.Database): {
  boardId: number
  agentId: number
  cardId: number
} {
  const boardId = Number(db.prepare(`
    INSERT INTO boards (project_path, name)
    VALUES ('/compatibility-forward', 'Compatibility forward')
  `).run().lastInsertRowid)
  const agentId = Number(db.prepare(`
    INSERT INTO agents (
      board_id, name, role, provider, model, effort, access_profile
    ) VALUES (?, 'legacy-builder', 'builder', 'codex', 'gpt-5.4',
      'high', 'workspace_write')
  `).run(boardId).lastInsertRowid)
  const cardId = Number(db.prepare(`
    INSERT INTO cards (
      board_id, title, description, owner_agent_id
    ) VALUES (?, 'Migrate legacy state', 'Preserve exact meaning', ?)
  `).run(boardId, agentId).lastInsertRowid)
  db.prepare(`
    INSERT INTO task_contracts (
      card_id, objective, deliverables, acceptance_criteria,
      dependencies, verify_commands, non_goals, risks, updated_at
    ) VALUES (?, 'Preserve exact meaning',
      '[{"id":"deliverable-1","text":"Migrated state","required":true}]',
      '[{"id":"criterion-1","text":"Hashes match","required":true,"deliverable_ids":["deliverable-1"]}]',
      '[]', '["npm test"]', '[]', '[]', '2026-07-29T06:00:00.000Z')
  `).run(cardId)
  db.prepare(`
    INSERT INTO card_events (
      card_id, agent_id, type, payload, created_at
    ) VALUES (?, ?, 'commented', '{"safe":"legacy payload"}',
      '2026-07-29T06:01:00.000Z')
  `).run(cardId, agentId)
  db.prepare(`
    INSERT INTO agent_usage (
      board_id, agent_id, day, provider, total_tokens,
      input_tokens, output_tokens
    ) VALUES (?, ?, '2026-07-29', 'codex', 150, 100, 50)
  `).run(boardId, agentId)
  db.prepare(`
    INSERT INTO review_decisions (
      board_id, card_id, decision, note, decided_at
    ) VALUES (?, ?, 'approve', 'Legacy-only review',
      '2026-07-29T06:02:00.000Z')
  `).run(boardId, cardId)
  return { boardId, agentId, cardId }
}

describe('DOM-017 compatibility forward migration', () => {
  it('covers all 15 legacy surfaces with a frozen forward-only plan', () => {
    const coverage = compatibilityForwardPlanCoverage()

    expect(coverage.actual).toEqual(coverage.expected)
    expect(coverage.actual).toHaveLength(15)
    expect(new Set(coverage.actual).size).toBe(15)
    expect(AGENT_OS_COMPATIBILITY_FORWARD_PLAN).toMatchObject({
      schema_version: 1,
      backlog_item: 'DOM-017',
      migration_id: AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
      prior_schema: '021-command-idempotency-coverage',
    })
    expect(Object.isFrozen(AGENT_OS_COMPATIBILITY_FORWARD_PLAN)).toBe(true)
    expect(Object.isFrozen(AGENT_OS_COMPATIBILITY_FORWARD_PLAN.entries))
      .toBe(true)

    for (const entry of AGENT_OS_COMPATIBILITY_FORWARD_PLAN.entries) {
      expect(Object.isFrozen(entry), entry.source_table).toBe(true)
      expect(entry.prerequisites.length, entry.source_table).toBeGreaterThan(0)
      expect(entry.validation_categories.length, entry.source_table)
        .toBeGreaterThan(0)
      expect(entry.command_order.trim(), entry.source_table).not.toBe('')
      expect(entry.compatibility_range.trim(), entry.source_table).not.toBe('')
      expect(entry.fail_closed.trim(), entry.source_table).not.toBe('')
      expect(entry.rollback.data_policy, entry.source_table)
        .toContain('No automatic down migration')
      expect(entry.rollback.actions.join(' '), entry.source_table)
        .toContain('Keep canonical writes')
    }

    expect(AGENT_OS_COMPATIBILITY_VALIDATION_QUERIES.map((query) => (
      query.category
    ))).toEqual(['count', 'key', 'scope', 'lifecycle'])
  })

  it('deterministically links valid rows, imports events, and records five clean checks', () => {
    const db = openDb(':memory:')
    removeMarker(db)
    const fixture = insertLegacyFixture(db)

    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    expect(db.prepare(`
      SELECT id FROM os_schema_migrations WHERE id=?
    `).get(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)).toEqual({
      id: AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM os_compatibility_projection_links
      WHERE migration_id=?
    `).get(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)).toEqual({ count: 7 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM os_compatibility_projection_quarantine
      WHERE migration_id=?
    `).get(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT id, board_id, card_id, actor_type, actor_id, kind, source,
        payload, created_at
      FROM os_events WHERE id=?
    `).get('legacy-card-event:1')).toEqual({
      id: 'legacy-card-event:1',
      board_id: fixture.boardId,
      card_id: fixture.cardId,
      actor_type: 'legacy_agent',
      actor_id: String(fixture.agentId),
      kind: 'legacy.card_event.commented',
      source: 'legacy_card_events',
      payload: '{"legacy_agent_id":1,"legacy_card_event_id":1,"legacy_payload":{"safe":"legacy payload"}}',
      created_at: '2026-07-29T06:01:00.000Z',
    })
    expect(db.prepare(`
      SELECT id, board_id, legacy_agent_id, name
      FROM agent_profiles WHERE legacy_agent_id=?
    `).get(fixture.agentId)).toEqual({
      id: `legacy-agent:${fixture.agentId}`,
      board_id: fixture.boardId,
      legacy_agent_id: fixture.agentId,
      name: 'legacy-builder',
    })
    expect(db.prepare(`
      SELECT category, issue_count
      FROM os_compatibility_migration_checks
      WHERE migration_id=?
      ORDER BY category
    `).all(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)).toEqual([
      { category: 'count', issue_count: 0 },
      { category: 'hash', issue_count: 0 },
      { category: 'key', issue_count: 0 },
      { category: 'lifecycle', issue_count: 0 },
      { category: 'scope', issue_count: 0 },
    ])
    expect(validateCompatibilityForwardMigration(db)
      .every((result) => result.issue_count === 0)).toBe(true)
    db.close()
  })

  it('quarantines ambiguous rows without guessing canonical state', () => {
    const db = openDb(':memory:')
    removeMarker(db)
    const boardId = Number(db.prepare(`
      INSERT INTO boards (project_path, name)
      VALUES ('/compatibility-quarantine', 'Compatibility quarantine')
    `).run().lastInsertRowid)
    const cardId = Number(db.prepare(`
      INSERT INTO cards (board_id, title)
      VALUES (?, 'Ambiguous compatibility rows')
    `).run(boardId).lastInsertRowid)
    const agentId = Number(db.prepare(`
      INSERT INTO agents (board_id, name)
      VALUES (?, 'conflicting-agent')
    `).run(boardId).lastInsertRowid)
    db.prepare(`
      INSERT INTO agent_profiles (
        id, board_id, name, owner_actor_type, status,
        provenance_json, created_at, updated_at
      ) VALUES (
        'existing-profile', ?, 'conflicting-agent', 'operator', 'active',
        '{}', '2026-07-29T06:09:00.000Z', '2026-07-29T06:09:00.000Z'
      )
    `).run(boardId)
    db.prepare(`
      INSERT INTO task_contracts (
        card_id, objective, deliverables, acceptance_criteria,
        dependencies, verify_commands, updated_at
      ) VALUES (?, 'Ambiguous contract', 'not-json', '[]', '[]', '[]',
        '2026-07-29T06:10:00.000Z')
    `).run(cardId)
    db.prepare(`
      INSERT INTO card_events (card_id, type, payload)
      VALUES (?, 'broken', 'not-json')
    `).run(cardId)
    db.prepare(`
      INSERT INTO agent_usage (
        board_id, agent_id, day, provider
      ) VALUES (?, 999, '2026-07-29', 'codex')
    `).run(boardId)

    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    expect(db.prepare(`
      SELECT source_table, reason_code
      FROM os_compatibility_projection_quarantine
      WHERE migration_id=?
      ORDER BY source_table
    `).all(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)).toEqual([
      {
        source_table: 'agent_usage',
        reason_code: 'invalid_usage_scope',
      },
      {
        source_table: 'agents',
        reason_code: 'ambiguous_agent_identity',
      },
      {
        source_table: 'card_events',
        reason_code: 'invalid_legacy_event',
      },
      {
        source_table: 'task_contracts',
        reason_code: 'ambiguous_contract_backfill',
      },
    ])
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_events
      WHERE source='legacy_card_events'
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM job_market_contracts WHERE card_id=?
    `).get(cardId)).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_profiles WHERE legacy_agent_id=?
    `).get(agentId)).toEqual({ count: 0 })
    expect(validateCompatibilityForwardMigration(db)
      .every((result) => result.issue_count === 0)).toBe(true)
    db.close()
  })

  it('survives restart and marker-loss replay without duplicating durable rows', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'orchestra-dom017-replay-'),
    )
    tempDirs.push(directory)
    const file = path.join(directory, 'orchestra.db')
    const first = openDb(file)
    removeMarker(first)
    insertLegacyFixture(first)
    applyAgentOsMigrations(first)
    const before = {
      links: first.prepare(`
        SELECT COUNT(*) AS count FROM os_compatibility_projection_links
      `).get(),
      events: first.prepare(`
        SELECT COUNT(*) AS count FROM os_events
        WHERE source='legacy_card_events'
      `).get(),
      profiles: first.prepare(`
        SELECT COUNT(*) AS count FROM agent_profiles
        WHERE owner_actor_type='migration'
      `).get(),
    }
    removeMarker(first)
    first.close()

    const reopened = openDb(file)
    expect({
      links: reopened.prepare(`
        SELECT COUNT(*) AS count FROM os_compatibility_projection_links
      `).get(),
      events: reopened.prepare(`
        SELECT COUNT(*) AS count FROM os_events
        WHERE source='legacy_card_events'
      `).get(),
      profiles: reopened.prepare(`
        SELECT COUNT(*) AS count FROM agent_profiles
        WHERE owner_actor_type='migration'
      `).get(),
    }).toEqual(before)
    expect(reopened.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?
    `).get(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)).toEqual({ count: 1 })
    expect(validateCompatibilityForwardMigration(reopened)
      .every((result) => result.issue_count === 0)).toBe(true)
    reopened.close()
  })

  it('fails closed on snapshot drift or an incompatible evidence schema', () => {
    const drifted = openDb(':memory:')
    removeMarker(drifted)
    const { boardId } = insertLegacyFixture(drifted)
    applyAgentOsMigrations(drifted)
    drifted.prepare('UPDATE boards SET name=? WHERE id=?')
      .run('Changed after checkpoint', boardId)
    expect(validateCompatibilityForwardMigration(drifted)
      .find((result) => result.category === 'hash')).toMatchObject({
        issue_count: 1,
      })
    removeMarker(drifted)
    expect(() => applyAgentOsMigrations(drifted))
      .toThrow(/boards:1 changed after (?:linking|disposition)/)
    expect(drifted.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?
    `).get(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)).toEqual({ count: 0 })
    drifted.close()

    const incompatible = openDb(':memory:')
    removeMarker(incompatible)
    incompatible.exec(`
      DROP TABLE os_compatibility_projection_links;
      CREATE TABLE os_compatibility_projection_links (
        migration_id TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_key TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        target_table TEXT NOT NULL,
        target_key TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        disposition TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    expect(() => applyCompatibilityForwardMigration(incompatible))
      .toThrow(/incompatible os_compatibility_projection_links schema/)
    expect(incompatible.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?
    `).get(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID)).toEqual({ count: 0 })
    incompatible.close()
  })
})

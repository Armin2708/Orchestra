import type Database from 'better-sqlite3'
import SqliteDatabase from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { JobMarketService } from '../src/agent-os/job-market.js'
import { openDb } from '../src/db.js'

const MIGRATION_ID = '016-job-market-assignment-lifecycle'
const AT = '2026-07-25T12:00:00.000Z'

interface Fixture {
  boardId: number
  otherBoardId: number
  cardId: number
  dependencyCardId: number
  workspaceId: string
  otherWorkspaceId: string
  profileId: string
  otherProfileId: string
}

interface InsertAssignmentInput {
  id: string
  boardId: number
  cardId: number
  profileId: string
  workspaceId?: string | null
  origin?: 'claim' | 'assign' | 'reassign'
  predecessorAssignmentId?: string | null
  predecessorVersion?: number | null
  reason?: string | null
  assignedMarketVersion?: number
  status?: 'pending' | 'active'
  version?: number
}

function insertBoard(db: Database.Database, name: string): number {
  return Number(db.prepare(
    'INSERT INTO boards (project_path, name) VALUES (?, ?)',
  ).run(`/job-assignment-${name}`, name).lastInsertRowid)
}

function insertCard(
  db: Database.Database,
  boardId: number,
  title: string,
  columnName = 'backlog',
): number {
  return Number(db.prepare(
    'INSERT INTO cards (board_id, title, description, column_name) VALUES (?, ?, ?, ?)',
  ).run(boardId, title, `${title} objective`, columnName).lastInsertRowid)
}

function insertProfile(
  db: Database.Database,
  input: {
    id: string
    boardId: number
    capabilities?: string[]
  },
): void {
  db.prepare(`INSERT INTO agent_profiles (
    id, board_id, name, capabilities_json, owner_actor_type, owner_actor_id,
    status, provenance_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'operator', 'migration-test', 'active', '{}', ?, ?)`)
    .run(
      input.id,
      input.boardId,
      input.id,
      JSON.stringify(input.capabilities ?? []),
      AT,
      AT,
    )
}

function insertWorkspace(
  db: Database.Database,
  input: {
    id: string
    boardId: number
    cardId?: number | null
  },
): void {
  db.prepare(`INSERT INTO workspaces (
    id, board_id, card_id, name, kind, root_path, base_ref, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'shared', ?, 'HEAD', 'active', ?, ?)`).run(
    input.id,
    input.boardId,
    input.cardId ?? null,
    input.id,
    `/tmp/${input.id}`,
    AT,
    AT,
  )
}

function ensureMarket(db: Database.Database, cardId: number): void {
  new JobMarketService(db).get(cardId)
}

function makeFixture(db: Database.Database, suffix: string): Fixture {
  const boardId = insertBoard(db, `${suffix}-primary`)
  const otherBoardId = insertBoard(db, `${suffix}-other`)
  const cardId = insertCard(db, boardId, `${suffix} job`)
  const dependencyCardId = insertCard(db, boardId, `${suffix} dependency`)
  ensureMarket(db, cardId)
  ensureMarket(db, dependencyCardId)
  const profileId = `${suffix}-profile`
  const otherProfileId = `${suffix}-other-profile`
  insertProfile(db, { id: profileId, boardId, capabilities: ['terminal'] })
  insertProfile(db, {
    id: otherProfileId,
    boardId: otherBoardId,
    capabilities: ['terminal', 'gpu'],
  })
  const workspaceId = `${suffix}-workspace`
  const otherWorkspaceId = `${suffix}-other-workspace`
  insertWorkspace(db, { id: workspaceId, boardId, cardId })
  insertWorkspace(db, { id: otherWorkspaceId, boardId: otherBoardId })
  return {
    boardId,
    otherBoardId,
    cardId,
    dependencyCardId,
    workspaceId,
    otherWorkspaceId,
    profileId,
    otherProfileId,
  }
}

function insertAssignment(
  db: Database.Database,
  input: InsertAssignmentInput,
): Record<string, unknown> {
  const market = db.prepare(
    'SELECT version FROM job_market_contracts WHERE card_id=?',
  ).get(input.cardId) as { version: number }
  const origin = input.origin ?? 'claim'
  db.prepare(`INSERT INTO job_market_assignments (
    id, board_id, card_id, profile_id, workspace_id, ownership_mode, origin,
    status, assigned_market_version, version, predecessor_assignment_id,
    predecessor_version, created_actor_type, created_actor_id, idempotency_key,
    request_fingerprint, reason, created_at, updated_at
  ) VALUES (
    @id, @boardId, @cardId, @profileId, @workspaceId, 'exclusive', @origin,
    @status, @assignedMarketVersion, @version, @predecessorAssignmentId,
    @predecessorVersion, 'operator', 'migration-test', @idempotencyKey,
    @requestFingerprint, @reason, @createdAt, @createdAt
  )`).run({
    id: input.id,
    boardId: input.boardId,
    cardId: input.cardId,
    profileId: input.profileId,
    workspaceId: input.workspaceId ?? null,
    origin,
    status: input.status ?? (origin === 'reassign' ? 'pending' : 'active'),
    assignedMarketVersion: input.assignedMarketVersion ?? market.version + 1,
    version: input.version ?? 1,
    predecessorAssignmentId: input.predecessorAssignmentId ?? null,
    predecessorVersion: input.predecessorVersion ?? null,
    idempotencyKey: `assignment:${input.id}`,
    requestFingerprint: `fingerprint:${input.id}`,
    reason: input.reason ?? null,
    createdAt: AT,
  })
  return db.prepare('SELECT * FROM job_market_assignments WHERE id=?').get(input.id) as
    Record<string, unknown>
}

function releaseAssignment(
  db: Database.Database,
  assignmentId: string,
  endedMarketVersion: number,
): void {
  db.prepare(`UPDATE job_market_assignments
    SET status='released',
        version=version+1,
        updated_at=@endedAt,
        ended_at=@endedAt,
        ended_actor_type='operator',
        ended_actor_id='migration-test',
        end_reason='released by migration test',
        end_idempotency_key=@idempotencyKey,
        end_request_fingerprint=@requestFingerprint,
        ended_market_version=@endedMarketVersion
    WHERE id=@assignmentId`).run({
    assignmentId,
    endedAt: '2026-07-25T12:01:00.000Z',
    idempotencyKey: `release:${assignmentId}`,
    requestFingerprint: `release-fingerprint:${assignmentId}`,
    endedMarketVersion,
  })
}

function removeMigration018Schema(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS os_knowledge_promotion_scope_insert;
    DROP TABLE IF EXISTS os_knowledge_promotions;
    DELETE FROM os_schema_migrations WHERE id='029-agent-organization-assurance';
    DROP TABLE IF EXISTS context_uses;
    DROP TABLE IF EXISTS context_build_entries;
    DROP TABLE IF EXISTS context_build_sources;
    DROP TABLE IF EXISTS context_builds;
    DROP TABLE IF EXISTS knowledge_chunks;
    DROP TABLE IF EXISTS knowledge_sources;
    DELETE FROM os_schema_migrations WHERE id='018-knowledge-persistence';
  `)
}

function removeMigration016Schema(db: Database.Database): void {
  removeMigration018Schema(db)
  db.exec(`
    DROP TRIGGER IF EXISTS job_market_assignment_insert_scope;
    DROP TRIGGER IF EXISTS job_market_assignment_insert_market_cas;
    DROP TRIGGER IF EXISTS job_market_assignment_update;
    DROP TRIGGER IF EXISTS job_market_assignment_delete;
    DROP TRIGGER IF EXISTS job_market_assignment_release_market_cas;
    DROP TRIGGER IF EXISTS job_market_contract_assignment_transition;
    DROP TRIGGER IF EXISTS job_market_assignment_profile_archive;
    DROP TRIGGER IF EXISTS job_market_assignment_card_scope_update;
    DROP TRIGGER IF EXISTS job_market_assignment_profile_scope_update;
    DROP TRIGGER IF EXISTS job_market_assignment_workspace_scope_update;
    DROP TRIGGER IF EXISTS jobs_job_assignment_insert;
    DROP TRIGGER IF EXISTS jobs_job_assignment_update;
    DROP TRIGGER IF EXISTS jobs_job_assignment_status;
    DROP TRIGGER IF EXISTS jobs_job_assignment_required_insert;
    DROP TRIGGER IF EXISTS jobs_job_assignment_required_activation;
    DROP TRIGGER IF EXISTS jobs_job_assignment_binding_current_guard;
    DROP TRIGGER IF EXISTS jobs_job_assignment_session_binding_guard;
    DROP TRIGGER IF EXISTS agent_sessions_job_assignment_insert;
    DROP TRIGGER IF EXISTS agent_sessions_job_assignment_update;
    DROP TRIGGER IF EXISTS agent_sessions_job_assignment_status;
    DROP TRIGGER IF EXISTS agent_sessions_job_assignment_required_insert;
    DROP TRIGGER IF EXISTS agent_sessions_job_assignment_binding_current_guard;
    DROP TRIGGER IF EXISTS agent_sessions_job_assignment_required_update;
    DROP TRIGGER IF EXISTS agent_sessions_job_assignment_required_status;
    DROP TRIGGER IF EXISTS job_assignment_workspace_runtime_guard;
    DROP TRIGGER IF EXISTS os_events_job_assignment_insert;
    DROP TRIGGER IF EXISTS os_events_job_assignment_identity_update;
    DROP TRIGGER IF EXISTS os_events_job_assignment_delete;
    DROP TRIGGER IF EXISTS job_market_assignment_legacy_owner_insert;
    DROP TRIGGER IF EXISTS job_market_assignment_legacy_owner_update;
    DROP INDEX IF EXISTS idx_jobs_job_assignment;
    DROP INDEX IF EXISTS idx_agent_sessions_job_assignment;
    ALTER TABLE jobs DROP COLUMN assignment_market_version;
    ALTER TABLE jobs DROP COLUMN assigned_profile_id;
    ALTER TABLE jobs DROP COLUMN job_assignment_id;
    ALTER TABLE agent_sessions DROP COLUMN assignment_market_version;
    ALTER TABLE agent_sessions DROP COLUMN assigned_profile_id;
    ALTER TABLE agent_sessions DROP COLUMN job_assignment_id;
    DROP TABLE job_market_assignments;
    DELETE FROM os_schema_migrations WHERE id='017-job-assignment-runtime-binding';
    DELETE FROM os_schema_migrations WHERE id='016-job-market-assignment-lifecycle';
  `)
}

describe('job assignment migration 016', () => {
  it('backlevels dependent knowledge schema before replaying assignment migrations', () => {
    const db = openDb(':memory:')
    const profileTriggerNames = [
      'context_builds_scope_insert',
      'context_uses_insert',
      'knowledge_sources_scope_insert',
    ]
    const profileTriggersBefore = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type='trigger' AND name IN (?, ?, ?)
      ORDER BY name
    `).all(...profileTriggerNames) as Array<{ name: string; sql: string }>

    expect(profileTriggersBefore).toHaveLength(3)
    expect(profileTriggersBefore.every(
      ({ sql }) => sql.includes('assigned_profile_id'),
    )).toBe(true)

    removeMigration016Schema(db)

    expect(db.prepare(`
      SELECT id FROM os_schema_migrations
      WHERE id IN (
        '016-job-market-assignment-lifecycle',
        '017-job-assignment-runtime-binding',
        '018-knowledge-persistence',
        '029-agent-organization-assurance'
      )
    `).all()).toEqual([])
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name IN (
        'knowledge_sources', 'knowledge_chunks', 'context_builds',
        'context_build_sources', 'context_build_entries', 'context_uses'
      )
    `).get()).toEqual({ count: 0 })

    applyAgentOsMigrations(db)

    expect(db.prepare(`
      SELECT id FROM os_schema_migrations
      WHERE id IN (
        '016-job-market-assignment-lifecycle',
        '017-job-assignment-runtime-binding',
        '018-knowledge-persistence',
        '029-agent-organization-assurance'
      )
      ORDER BY id
    `).all()).toEqual([
      { id: '016-job-market-assignment-lifecycle' },
      { id: '017-job-assignment-runtime-binding' },
      { id: '018-knowledge-persistence' },
      { id: '029-agent-organization-assurance' },
    ])
    expect(db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type='trigger' AND name IN (?, ?, ?)
      ORDER BY name
    `).all(...profileTriggerNames)).toEqual(profileTriggersBefore)
    db.close()
  })

  it('fails atomically when its required prior schema is missing', () => {
    const db = new SqliteDatabase(':memory:')
    db.exec(`
      CREATE TABLE os_schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO os_schema_migrations (id) VALUES
        ('001-agent-os-kernel'),
        ('002-runtime-hardening'),
        ('003-provider-session-ownership'),
        ('004-delivery-trackbook'),
        ('005-delivery-report-revision-cascade'),
        ('006-canonical-launch-reservations'),
        ('007-agent-home-domain'),
        ('008-agent-home-controls'),
        ('009-job-market-domain'),
        ('010-agent-home-projected-text-redaction'),
        ('011-managed-driver-event-redaction'),
        ('012-agent-home-retention'),
        ('013-agent-home-structured-metadata-redaction'),
        ('014-agent-home-native-fork-lifecycle'),
        ('015-agent-home-action-command-scope');
    `)

    expect(() => applyAgentOsMigrations(db))
      .toThrow(/requires Agent Home, Job Market, and runtime tables/)
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?',
    ).get(MIGRATION_ID)).toEqual({ count: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name='job_market_assignments'`).get())
      .toEqual({ count: 0 })
    db.close()
  })

  it('creates the authoritative schema, indexes, triggers, and frozen identity columns', () => {
    const db = openDb(':memory:')
    const columns = db.prepare("PRAGMA table_info('job_market_assignments')").all() as
      Array<{ name: string; notnull: number; pk: number }>
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'board_id',
      'card_id',
      'profile_id',
      'workspace_id',
      'ownership_mode',
      'origin',
      'status',
      'assigned_market_version',
      'version',
      'predecessor_assignment_id',
      'predecessor_version',
      'created_actor_type',
      'created_actor_id',
      'idempotency_key',
      'request_fingerprint',
      'reason',
      'created_at',
      'updated_at',
      'ended_at',
      'ended_actor_type',
      'ended_actor_id',
      'end_reason',
      'end_idempotency_key',
      'end_request_fingerprint',
      'ended_market_version',
    ])
    expect(columns.find((column) => column.name === 'id')).toMatchObject({ pk: 1 })
    for (const name of [
      'board_id',
      'card_id',
      'profile_id',
      'origin',
      'status',
      'assigned_market_version',
      'version',
      'idempotency_key',
      'request_fingerprint',
    ]) {
      expect(columns.find((column) => column.name === name), name)
        .toMatchObject({ notnull: 1 })
    }

    const indexes = new Map((db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type='index' AND tbl_name='job_market_assignments'`).all() as
      Array<{ name: string; sql: string | null }>).map((row) => [row.name, row.sql]))
    for (const name of [
      'idx_job_market_assignments_active_exclusive',
      'idx_job_market_assignments_board',
      'idx_job_market_assignments_profile',
      'idx_job_market_assignments_workspace',
      'idx_job_market_assignments_history',
    ]) {
      expect(indexes.has(name), name).toBe(true)
    }
    expect(indexes.get('idx_job_market_assignments_active_exclusive'))
      .toContain("WHERE status='active' AND ownership_mode='exclusive'")

    const triggers = new Set((db.prepare(`SELECT name FROM sqlite_master
      WHERE type='trigger'
        AND (name LIKE '%job_assignment%' OR name LIKE 'job_market_assignment_%')`).all() as
      Array<{ name: string }>).map((row) => row.name))
    for (const name of [
      'job_market_assignment_insert_scope',
      'job_market_assignment_insert_market_cas',
      'job_market_assignment_update',
      'job_market_assignment_delete',
      'job_market_assignment_release_market_cas',
      'job_market_assignment_profile_archive',
      'jobs_job_assignment_insert',
      'jobs_job_assignment_update',
      'jobs_job_assignment_status',
      'jobs_job_assignment_required_insert',
      'jobs_job_assignment_required_activation',
      'jobs_job_assignment_session_binding_guard',
      'agent_sessions_job_assignment_insert',
      'agent_sessions_job_assignment_update',
      'agent_sessions_job_assignment_status',
      'agent_sessions_job_assignment_required_insert',
      'agent_sessions_job_assignment_required_update',
      'agent_sessions_job_assignment_required_status',
      'os_events_job_assignment_insert',
      'os_events_job_assignment_identity_update',
      'os_events_job_assignment_delete',
      'job_market_assignment_legacy_owner_insert',
      'job_market_assignment_legacy_owner_update',
    ]) {
      expect(triggers.has(name), name).toBe(true)
    }

    for (const table of ['jobs', 'agent_sessions']) {
      const names = (db.prepare(`PRAGMA table_info('${table}')`).all() as
        Array<{ name: string }>).map((column) => column.name)
      expect(names).toEqual(expect.arrayContaining([
        'job_assignment_id',
        'assigned_profile_id',
        'assignment_market_version',
      ]))
    }
    expect(db.prepare(
      'SELECT id FROM os_schema_migrations WHERE id=?',
    ).get(MIGRATION_ID)).toEqual({ id: MIGRATION_ID })
    db.close()
  })

  it('does not infer canonical assignments from legacy card owners or runtime jobs', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'no-backfill')
    const cardId = insertCard(db, boardId, 'legacy-owned job')
    ensureMarket(db, cardId)
    insertWorkspace(db, {
      id: 'no-backfill-workspace',
      boardId,
      cardId,
    })
    db.prepare(`INSERT INTO agents (board_id, name, status)
      VALUES (?, 'legacy owner', 'active')`).run(boardId)
    const legacyAgentId = Number((db.prepare(`SELECT id FROM agents
      WHERE board_id=? AND name='legacy owner'`).get(boardId) as { id: number }).id)

    removeMigration016Schema(db)
    db.prepare('UPDATE cards SET owner_agent_id=? WHERE id=?').run(legacyAgentId, cardId)
    db.prepare(`INSERT INTO jobs (
      id, board_id, card_id, workspace_id, provider, status
    ) VALUES (
      'legacy-runtime-job', ?, ?, 'no-backfill-workspace', 'codex', 'queued'
    )`).run(boardId, cardId)

    applyAgentOsMigrations(db)

    expect(db.prepare('SELECT COUNT(*) AS count FROM job_market_assignments').get())
      .toEqual({ count: 0 })
    expect(db.prepare(`SELECT owner_agent_id FROM cards WHERE id=?`).get(cardId))
      .toEqual({ owner_agent_id: legacyAgentId })
    expect(db.prepare(`SELECT job_assignment_id, assigned_profile_id,
      assignment_market_version FROM jobs WHERE id='legacy-runtime-job'`).get())
      .toEqual({
        job_assignment_id: null,
        assigned_profile_id: null,
        assignment_market_version: null,
      })
    db.close()
  })

  it('normalizes safe legacy assigned contracts and records held legacy lifecycle states', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'legacy-market-policy')
    const safeAssignedCardId = insertCard(db, boardId, 'safe assigned')
    const activeAssignedCardId = insertCard(db, boardId, 'active assigned')
    const runningCardId = insertCard(db, boardId, 'legacy running')
    const submittedCardId = insertCard(db, boardId, 'legacy submitted')
    for (const cardId of [
      safeAssignedCardId,
      activeAssignedCardId,
      runningCardId,
      submittedCardId,
    ]) ensureMarket(db, cardId)
    insertWorkspace(db, {
      id: 'legacy-market-active-workspace',
      boardId,
      cardId: activeAssignedCardId,
    })

    removeMigration016Schema(db)
    db.prepare(`UPDATE job_market_contracts SET status='assigned', version=2
      WHERE card_id IN (?, ?)`).run(safeAssignedCardId, activeAssignedCardId)
    db.prepare(`UPDATE job_market_contracts SET status='running', version=3
      WHERE card_id=?`).run(runningCardId)
    db.prepare(`UPDATE job_market_contracts SET status='submitted', version=4
      WHERE card_id=?`).run(submittedCardId)
    db.prepare(`INSERT INTO jobs (
      id, board_id, card_id, workspace_id, provider, status
    ) VALUES (
      'legacy-market-active-job', ?, ?, 'legacy-market-active-workspace',
      'codex', 'running'
    )`).run(boardId, activeAssignedCardId)

    applyAgentOsMigrations(db)

    expect(db.prepare(`SELECT card_id, status, version FROM job_market_contracts
      WHERE card_id IN (?, ?, ?, ?) ORDER BY card_id`).all(
      safeAssignedCardId,
      activeAssignedCardId,
      runningCardId,
      submittedCardId,
    )).toEqual([
      { card_id: safeAssignedCardId, status: 'open', version: 3 },
      { card_id: activeAssignedCardId, status: 'assigned', version: 2 },
      { card_id: runningCardId, status: 'running', version: 3 },
      { card_id: submittedCardId, status: 'submitted', version: 4 },
    ])
    expect(db.prepare(`SELECT kind, json_extract(payload, '$.disposition') AS disposition
      FROM os_events WHERE source='migration-016' ORDER BY card_id`).all()).toEqual([
      {
        kind: 'job_market.legacy_assignment_state_normalized',
        disposition: 'normalized_to_open',
      },
      {
        kind: 'job_market.legacy_assignment_state_retained',
        disposition: 'retained_for_legacy_lifecycle',
      },
      {
        kind: 'job_market.legacy_assignment_state_retained',
        disposition: 'retained_for_legacy_lifecycle',
      },
      {
        kind: 'job_market.legacy_assignment_state_retained',
        disposition: 'retained_for_legacy_lifecycle',
      },
    ])
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_market_assignments').get())
      .toEqual({ count: 0 })
    expect(() => new JobMarketService(db).transition(activeAssignedCardId, 'assigned'))
      .toThrow(/canonical job assignment/)
    db.close()
  })

  it('retains an inactive legacy-owned assigned contract without creating dual ownership', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'legacy-owner-policy')
    const cardId = insertCard(db, boardId, 'legacy-owned assigned')
    ensureMarket(db, cardId)
    insertProfile(db, {
      id: 'legacy-owner-canonical-profile',
      boardId,
      capabilities: ['terminal'],
    })
    db.prepare(`INSERT INTO agents (board_id, name, status)
      VALUES (?, 'retained legacy owner', 'active')`).run(boardId)
    const legacyAgentId = Number((db.prepare(`SELECT id FROM agents
      WHERE board_id=? AND name='retained legacy owner'`).get(boardId) as
      { id: number }).id)

    removeMigration016Schema(db)
    db.prepare('UPDATE cards SET owner_agent_id=? WHERE id=?').run(legacyAgentId, cardId)
    db.prepare(`UPDATE job_market_contracts SET status='assigned', version=2
      WHERE card_id=?`).run(cardId)

    applyAgentOsMigrations(db)

    expect(db.prepare(`SELECT market.status, market.version, card.owner_agent_id
      FROM job_market_contracts market
      JOIN cards card ON card.id=market.card_id
      WHERE market.card_id=?`).get(cardId)).toEqual({
      status: 'assigned',
      version: 2,
      owner_agent_id: legacyAgentId,
    })
    expect(db.prepare(`SELECT kind,
        json_extract(payload, '$.legacy_owner_present') AS legacy_owner_present,
        json_extract(payload, '$.disposition') AS disposition,
        json_extract(payload, '$.remediation') AS remediation
      FROM os_events
      WHERE source='migration-016' AND card_id=?`).get(cardId)).toEqual({
      kind: 'job_market.legacy_assignment_state_retained',
      legacy_owner_present: 1,
      disposition: 'retained_for_legacy_owner',
      remediation: 'finish or clear the legacy owner and return the contract to open before creating a canonical assignment',
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_market_assignments').get())
      .toEqual({ count: 0 })
    expect(() => insertAssignment(db, {
      id: 'must-not-dual-own',
      boardId,
      cardId,
      profileId: 'legacy-owner-canonical-profile',
      assignedMarketVersion: 3,
    })).toThrow(/legacy owner/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_market_assignments').get())
      .toEqual({ count: 0 })
    db.close()
  })

  it('rolls back legacy normalization and schema writes when its audit cannot be recorded', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'legacy-normalization-rollback')
    const cardId = insertCard(db, boardId, 'legacy normalization rollback')
    ensureMarket(db, cardId)

    removeMigration016Schema(db)
    db.prepare(`UPDATE job_market_contracts SET status='assigned', version=2
      WHERE card_id=?`).run(cardId)
    const eventKey = `migration:016:legacy-market-state:${cardId}`
    db.prepare(`INSERT INTO os_events (
      id, board_id, card_id, kind, source, payload, idempotency_key, created_at
    ) VALUES (?, ?, ?, 'test.collision', 'test', '{}', ?, ?)`)
      .run(eventKey, boardId, cardId, eventKey, AT)

    expect(() => applyAgentOsMigrations(db)).toThrow(/UNIQUE constraint failed/)
    expect(db.prepare(`SELECT status, version FROM job_market_contracts
      WHERE card_id=?`).get(cardId)).toEqual({
      status: 'assigned',
      version: 2,
    })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id=?`).get(MIGRATION_ID)).toEqual({ count: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name='job_market_assignments'`).get())
      .toEqual({ count: 0 })
    db.close()
  })

  it('enforces board, workspace, capability, dependency, and active-job scope', () => {
    const db = openDb(':memory:')
    const fixture = makeFixture(db, 'scope')

    expect(() => insertAssignment(db, {
      id: 'cross-board-profile',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: fixture.otherProfileId,
      workspaceId: fixture.workspaceId,
    })).toThrow(/card, board, and active profile scope is inconsistent/)

    expect(() => insertAssignment(db, {
      id: 'cross-board-workspace',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: fixture.profileId,
      workspaceId: fixture.otherWorkspaceId,
    })).toThrow(/workspace scope is inconsistent/)

    insertWorkspace(db, {
      id: 'scope-wrong-card-workspace',
      boardId: fixture.boardId,
      cardId: fixture.dependencyCardId,
    })
    expect(() => insertAssignment(db, {
      id: 'wrong-card-workspace',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: fixture.profileId,
      workspaceId: 'scope-wrong-card-workspace',
    })).toThrow(/workspace scope is inconsistent/)

    db.prepare('UPDATE task_contracts SET workspace_id=? WHERE card_id=?')
      .run(fixture.workspaceId, fixture.cardId)
    expect(() => insertAssignment(db, {
      id: 'missing-contract-workspace',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: fixture.profileId,
    })).toThrow(/must use the contract workspace/)

    db.prepare(`UPDATE job_market_contracts
      SET required_capabilities_json='["gpu"]'
      WHERE card_id=?`).run(fixture.cardId)
    expect(() => insertAssignment(db, {
      id: 'missing-capability',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: fixture.profileId,
      workspaceId: fixture.workspaceId,
    })).toThrow(/does not satisfy required job capabilities/)
    db.prepare(`UPDATE agent_profiles
      SET capabilities_json='["terminal","gpu"]'
      WHERE id=?`).run(fixture.profileId)

    db.prepare(`INSERT INTO job_market_dependencies (
      card_id, dependency_card_id, blocking_reason, completion_condition, updated_at
    ) VALUES (?, ?, 'must finish first', 'card_done', ?)`)
      .run(fixture.cardId, fixture.dependencyCardId, AT)
    expect(() => insertAssignment(db, {
      id: 'blocked-dependency',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: fixture.profileId,
      workspaceId: fixture.workspaceId,
    })).toThrow(/dependencies are not complete/)
    db.prepare("UPDATE cards SET column_name='done' WHERE id=?")
      .run(fixture.dependencyCardId)

    const activeJobCardId = insertCard(db, fixture.boardId, 'active runtime job')
    ensureMarket(db, activeJobCardId)
    insertWorkspace(db, {
      id: 'scope-active-job-workspace',
      boardId: fixture.boardId,
      cardId: activeJobCardId,
    })
    db.prepare(`INSERT INTO jobs (
      id, board_id, card_id, workspace_id, provider, status
    ) VALUES ('active-runtime-job', ?, ?, ?, 'codex', 'queued')`)
      .run(fixture.boardId, activeJobCardId, 'scope-active-job-workspace')
    expect(() => insertAssignment(db, {
      id: 'assignment-with-active-job',
      boardId: fixture.boardId,
      cardId: activeJobCardId,
      profileId: fixture.profileId,
      workspaceId: 'scope-active-job-workspace',
    })).toThrow(/cannot change while the card has an active job/)

    const activeSessionCardId = insertCard(db, fixture.boardId, 'active runtime session')
    ensureMarket(db, activeSessionCardId)
    insertWorkspace(db, {
      id: 'scope-active-session-workspace',
      boardId: fixture.boardId,
      cardId: activeSessionCardId,
    })
    db.prepare(`INSERT INTO jobs (
      id, board_id, card_id, workspace_id, provider, status
    ) VALUES ('terminal-runtime-job', ?, ?, ?, 'codex', 'failed')`)
      .run(fixture.boardId, activeSessionCardId, 'scope-active-session-workspace')
    db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, provider, status, job_id
    ) VALUES (
      'active-runtime-session', 'scope-active-session-workspace',
      'codex', 'running', 'terminal-runtime-job'
    )`).run()
    expect(() => insertAssignment(db, {
      id: 'assignment-with-active-session',
      boardId: fixture.boardId,
      cardId: activeSessionCardId,
      profileId: fixture.profileId,
      workspaceId: 'scope-active-session-workspace',
    })).toThrow(/cannot change while the card has an active agent session/)

    expect(insertAssignment(db, {
      id: 'scope-valid',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: fixture.profileId,
      workspaceId: fixture.workspaceId,
    })).toMatchObject({
      status: 'active',
      assigned_market_version: 2,
    })
    db.close()
  })

  it('keeps one active owner, preserves history, and guards lifecycle transitions', () => {
    const db = openDb(':memory:')
    const fixture = makeFixture(db, 'lifecycle')
    const replacementProfileId = 'lifecycle-replacement-profile'
    insertProfile(db, {
      id: replacementProfileId,
      boardId: fixture.boardId,
      capabilities: ['terminal'],
    })

    expect(() => db.prepare(`UPDATE job_market_contracts
      SET status='assigned', version=version+1 WHERE card_id=?`).run(fixture.cardId))
      .toThrow(/assigned status requires an active canonical assignment/)

    const first = insertAssignment(db, {
      id: 'lifecycle-first',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: fixture.profileId,
      workspaceId: fixture.workspaceId,
      origin: 'assign',
    })
    expect(first).toMatchObject({
      status: 'active',
      origin: 'assign',
      assigned_market_version: 2,
      version: 1,
    })
    expect(db.prepare(`SELECT status, version FROM job_market_contracts
      WHERE card_id=?`).get(fixture.cardId)).toEqual({
      status: 'assigned',
      version: 2,
    })
    expect(() => db.prepare(`UPDATE job_market_contracts
      SET status='open', version=version+1 WHERE card_id=?`).run(fixture.cardId))
      .toThrow(/release the active job market assignment/)
    expect(() => db.prepare(`UPDATE agent_profiles
      SET status='archived', archived_at=? WHERE id=?`).run(AT, fixture.profileId))
      .toThrow(/active job market assignment/)
    expect(() => db.prepare(`UPDATE job_market_assignments
      SET profile_id=? WHERE id='lifecycle-first'`).run(replacementProfileId))
      .toThrow(/identity is immutable/)
    expect(() => db.prepare(`UPDATE job_market_assignments SET
      status='superseded',
      version=version+1,
      updated_at=?,
      ended_at=?,
      ended_actor_type='operator',
      ended_actor_id='migration-test',
      end_reason='orphan',
      end_idempotency_key='orphan:supersede',
      end_request_fingerprint='orphan-fingerprint',
      ended_market_version=3
      WHERE id='lifecycle-first'`).run(AT, AT))
      .toThrow(/only be superseded by its pending successor/)
    expect(() => insertAssignment(db, {
      id: 'lifecycle-invalid-version',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: replacementProfileId,
      workspaceId: fixture.workspaceId,
      origin: 'reassign',
      predecessorAssignmentId: 'lifecycle-first',
      predecessorVersion: 1,
      version: 2,
    })).toThrow(/canonical status and version/)
    expect(() => insertAssignment(db, {
      id: 'lifecycle-invalid-reassign-status',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: replacementProfileId,
      workspaceId: fixture.workspaceId,
      origin: 'reassign',
      predecessorAssignmentId: 'lifecycle-first',
      predecessorVersion: 1,
      status: 'active',
    })).toThrow(/canonical status and version/)
    expect(() => insertAssignment(db, {
      id: 'lifecycle-same-profile-noop',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: fixture.profileId,
      workspaceId: fixture.workspaceId,
      origin: 'reassign',
      predecessorAssignmentId: 'lifecycle-first',
      predecessorVersion: 1,
    })).toThrow(/predecessor or market version is stale/)
    expect(() => db.prepare(`UPDATE job_market_contracts
      SET status='draft', version=version+1 WHERE card_id=?`).run(fixture.cardId))
      .toThrow(/before reopening or drafting/)
    expect(() => db.prepare(`UPDATE workspaces SET status='archived'
      WHERE id=?`).run(fixture.workspaceId))
      .not.toThrow()
    db.prepare(`UPDATE workspaces SET status='active'
      WHERE id=?`).run(fixture.workspaceId)
    db.prepare(`INSERT INTO os_events (
      id, board_id, workspace_id, card_id, kind, source, payload,
      idempotency_key, created_at
    ) VALUES (
      'lifecycle-audit', ?, ?, ?, 'job_market.assignment_assigned',
      'job-market', ?, 'assignment:lifecycle-first', ?
    )`).run(
      fixture.boardId,
      fixture.workspaceId,
      fixture.cardId,
      JSON.stringify({
        assignment_id: 'lifecycle-first',
        request_fingerprint: 'fingerprint:lifecycle-first',
        result: {
          assignment: first,
          market: {
            status: 'assigned',
            market_version: 2,
          },
          replayed: false,
        },
      }),
      AT,
    )
    expect(() => db.prepare(`UPDATE os_events
      SET payload='{"assignment_id":"rewritten","request_fingerprint":"fingerprint:lifecycle-first"}'
      WHERE id='lifecycle-audit'`).run())
      .toThrow(/assignment audit identity is immutable/)
    expect(() => db.prepare(`DELETE FROM os_events
      WHERE id='lifecycle-audit'`).run())
      .toThrow(/assignment audit history is immutable/)
    expect(() => db.prepare(`INSERT INTO os_events (
      id, board_id, workspace_id, card_id, kind, source, payload,
      idempotency_key, created_at
    ) VALUES (
      'lifecycle-invalid-audit', ?, ?, ?, 'job_market.assignment_assigned',
      'job-market', ?, 'assignment:invalid-audit', ?
    )`).run(
      fixture.boardId,
      fixture.workspaceId,
      fixture.cardId,
      JSON.stringify({
        assignment_id: 'lifecycle-first',
        request_fingerprint: 'wrong-fingerprint',
      }),
      AT,
    )).toThrow(/audit scope or command identity is inconsistent/)
    expect(() => db.prepare(`DELETE FROM job_market_assignments
      WHERE id='lifecycle-first'`).run())
      .toThrow(/assignment history is immutable/)
    db.prepare(`INSERT INTO agents (board_id, name, status)
      VALUES (?, 'late legacy owner', 'active')`).run(fixture.boardId)
    const legacyAgentId = Number((db.prepare(`SELECT id FROM agents
      WHERE board_id=? AND name='late legacy owner'`).get(fixture.boardId) as
      { id: number }).id)
    expect(() => db.prepare(`UPDATE cards SET owner_agent_id=?
      WHERE id=?`).run(legacyAgentId, fixture.cardId))
      .toThrow(/active canonical job market assignment/)

    const successor = insertAssignment(db, {
      id: 'lifecycle-successor',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: replacementProfileId,
      workspaceId: fixture.workspaceId,
      origin: 'reassign',
      predecessorAssignmentId: 'lifecycle-first',
      predecessorVersion: 1,
      reason: 'handoff',
    })
    expect(successor).toMatchObject({
      status: 'active',
      origin: 'reassign',
      predecessor_assignment_id: 'lifecycle-first',
      assigned_market_version: 3,
    })
    expect(db.prepare(`SELECT status, version, ended_market_version
      FROM job_market_assignments WHERE id='lifecycle-first'`).get()).toEqual({
      status: 'superseded',
      version: 2,
      ended_market_version: 3,
    })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM job_market_assignments
      WHERE card_id=? AND status='active'`).get(fixture.cardId)).toEqual({ count: 1 })
    expect(() => insertAssignment(db, {
      id: 'lifecycle-stale-successor',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: fixture.profileId,
      workspaceId: fixture.workspaceId,
      origin: 'reassign',
      predecessorAssignmentId: 'lifecycle-first',
      predecessorVersion: 1,
    })).toThrow(/predecessor or market version is stale/)
    expect(() => db.prepare(`UPDATE job_market_assignments
      SET end_reason='rewritten' WHERE id='lifecycle-first'`).run())
      .toThrow(/terminal job market assignments are immutable/)

    releaseAssignment(db, 'lifecycle-successor', 4)
    expect(db.prepare(`SELECT status, version FROM job_market_contracts
      WHERE card_id=?`).get(fixture.cardId)).toEqual({
      status: 'open',
      version: 4,
    })
    const releasedSuccessor = db.prepare(`SELECT * FROM job_market_assignments
      WHERE id='lifecycle-successor'`).get() as Record<string, unknown>
    const insertReleaseAudit = (assignment: Record<string, unknown>) => db.prepare(`
      INSERT INTO os_events (
        id, board_id, workspace_id, card_id, kind, source, payload,
        idempotency_key, created_at
      ) VALUES (
        'lifecycle-release-audit', ?, ?, ?, 'job_market.assignment_released',
        'job-market', ?, 'release:lifecycle-successor', ?
      )
    `).run(
      fixture.boardId,
      fixture.workspaceId,
      fixture.cardId,
      JSON.stringify({
        assignment_id: 'lifecycle-successor',
        request_fingerprint: 'release-fingerprint:lifecycle-successor',
        result: {
          assignment,
          market: { status: 'open', market_version: 4 },
          replayed: false,
        },
      }),
      AT,
    )
    expect(() => insertReleaseAudit({
      ...releasedSuccessor,
      ended_at: '2099-01-01T00:00:00.000Z',
    })).toThrow(/audit scope or command identity is inconsistent/)
    expect(() => insertReleaseAudit(releasedSuccessor)).not.toThrow()
    expect(db.prepare(`SELECT id, status FROM job_market_assignments
      WHERE card_id=? ORDER BY created_at, id`).all(fixture.cardId)).toEqual([
      { id: 'lifecycle-first', status: 'superseded' },
      { id: 'lifecycle-successor', status: 'released' },
    ])
    expect(() => db.prepare(`UPDATE agent_profiles
      SET status='archived', archived_at=? WHERE id=?`).run(AT, replacementProfileId))
      .not.toThrow()
    expect(() => db.prepare('UPDATE cards SET board_id=? WHERE id=?')
      .run(fixture.otherBoardId, fixture.cardId))
      .toThrow(/would displace job market assignment history/)
    db.close()
  })

  it('freezes complete assignment identity onto queued jobs and their sessions', () => {
    const db = openDb(':memory:')
    const fixture = makeFixture(db, 'binding')
    insertAssignment(db, {
      id: 'binding-assignment',
      boardId: fixture.boardId,
      cardId: fixture.cardId,
      profileId: fixture.profileId,
    })

    expect(() => db.prepare(`INSERT INTO jobs (
      id, board_id, card_id, workspace_id, provider, status, job_assignment_id
    ) VALUES (
      'binding-incomplete-job', ?, ?, ?, 'codex', 'failed', 'binding-assignment'
    )`).run(fixture.boardId, fixture.cardId, fixture.workspaceId))
      .toThrow(/job assignment identity must be complete/)
    expect(() => db.prepare(`INSERT INTO jobs (
      id, board_id, card_id, workspace_id, provider, status,
      job_assignment_id, assigned_profile_id, assignment_market_version
    ) VALUES (
      'binding-nonqueued-job', ?, ?, ?, 'codex', 'failed',
      'binding-assignment', ?, 2
    )`).run(fixture.boardId, fixture.cardId, fixture.workspaceId, fixture.profileId))
      .toThrow(/job assignment identity or scope is inconsistent/)

    insertWorkspace(db, {
      id: 'binding-wrong-card-workspace',
      boardId: fixture.boardId,
      cardId: fixture.dependencyCardId,
    })
    expect(() => db.prepare(`INSERT INTO jobs (
      id, board_id, card_id, workspace_id, provider, status,
      job_assignment_id, assigned_profile_id, assignment_market_version
    ) VALUES (
      'binding-wrong-card-job', ?, ?, 'binding-wrong-card-workspace', 'codex', 'queued',
      'binding-assignment', ?, 2
    )`).run(fixture.boardId, fixture.cardId, fixture.profileId))
      .toThrow(/job assignment identity or scope is inconsistent/)

    db.prepare(`INSERT INTO jobs (
      id, board_id, card_id, workspace_id, provider, status,
      job_assignment_id, assigned_profile_id, assignment_market_version
    ) VALUES (
      'binding-job', ?, ?, ?, 'codex', 'queued',
      'binding-assignment', ?, 2
    )`).run(fixture.boardId, fixture.cardId, fixture.workspaceId, fixture.profileId)
    expect(db.prepare(`SELECT job_assignment_id, assigned_profile_id,
      assignment_market_version FROM jobs WHERE id='binding-job'`).get()).toEqual({
      job_assignment_id: 'binding-assignment',
      assigned_profile_id: fixture.profileId,
      assignment_market_version: 2,
    })
    expect(() => db.prepare(`UPDATE jobs
      SET assignment_market_version=3 WHERE id='binding-job'`).run())
      .toThrow(/job assignment identity is immutable/)
    expect(() => releaseAssignment(db, 'binding-assignment', 3))
      .toThrow(/cannot end while the card has active execution/)

    expect(() => db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, provider, status, job_id, job_assignment_id
    ) VALUES (
      'binding-incomplete-session', ?, 'codex', 'starting',
      'binding-job', 'binding-assignment'
    )`).run(fixture.workspaceId))
      .toThrow(/agent session assignment identity must be complete/)

    db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, provider, status, job_id,
      job_assignment_id, assigned_profile_id, assignment_market_version
    ) VALUES (
      'binding-session', ?, 'codex', 'running', 'binding-job',
      'binding-assignment', ?, 2
    )`).run(fixture.workspaceId, fixture.profileId)
    expect(db.prepare(`SELECT job_assignment_id, assigned_profile_id,
      assignment_market_version FROM agent_sessions
      WHERE id='binding-session'`).get()).toEqual({
      job_assignment_id: 'binding-assignment',
      assigned_profile_id: fixture.profileId,
      assignment_market_version: 2,
    })
    expect(() => db.prepare(`UPDATE agent_sessions
      SET job_assignment_id=NULL,
          assigned_profile_id=NULL,
          assignment_market_version=NULL
      WHERE id='binding-session'`).run())
      .toThrow(/agent session assignment identity is immutable/)
    expect(() => db.prepare(`UPDATE agent_sessions
      SET job_id=NULL WHERE id='binding-session'`).run())
      .toThrow(/agent session assignment identity is immutable/)
    db.prepare(`INSERT INTO agent_conversations (
      id, board_id, profile_id, title, status, is_default, next_sequence,
      created_by_actor_type, created_by_actor_id, created_at, updated_at
    ) VALUES (
      'binding-conversation', ?, ?, 'Binding conversation', 'active', 1, 1,
      'operator', 'migration-test', ?, ?
    )`).run(fixture.boardId, fixture.profileId, AT, AT)
    db.prepare("UPDATE jobs SET status='running' WHERE id='binding-job'").run()
    expect(() => db.prepare(`UPDATE agent_sessions
      SET profile_id=?, conversation_id='binding-conversation'
      WHERE id='binding-session'`).run(fixture.profileId))
      .not.toThrow()
    expect(() => db.prepare(`UPDATE agent_sessions
      SET profile_id=? WHERE id='binding-session'`).run(fixture.otherProfileId))
      .toThrow(/scope is inconsistent/)
    db.prepare(`UPDATE agent_sessions SET status='stopped'
      WHERE id='binding-session'`).run()
    db.prepare(`UPDATE jobs SET status='succeeded'
      WHERE id='binding-job'`).run()
    releaseAssignment(db, 'binding-assignment', 3)
    expect(() => db.prepare(`UPDATE jobs SET status='queued'
      WHERE id='binding-job'`).run())
      .toThrow(/active job status requires an active canonical assignment/)
    expect(() => db.prepare(`UPDATE agent_sessions SET status='running'
      WHERE id='binding-session'`).run())
      .toThrow(/active agent session status requires an active canonical assignment/)
    expect(() => db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, provider, status, job_id,
      job_assignment_id, assigned_profile_id, assignment_market_version
    ) VALUES (
      'binding-late-session', ?, 'codex', 'running', 'binding-job',
      'binding-assignment', ?, 2
    )`).run(fixture.workspaceId, fixture.profileId))
      .toThrow(/agent session assignment identity or scope is inconsistent/)
    db.close()
  })
})

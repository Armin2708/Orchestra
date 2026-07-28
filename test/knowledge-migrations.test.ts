import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { openDb } from '../src/db.js'

const MIGRATION_ID = '018-knowledge-persistence'
const at = '2026-07-26T00:00:00.000Z'
const digest = (character: string): string => character.repeat(64)
const sourceId = `ks_${digest('1')}`
const chunkId = `kc_${digest('2')}`
const buildId = `cb_${digest('3')}`
const useId = `cu_${digest('4')}`
const contentHash = digest('a')
const manifestHash = digest('b')
const requestHash = digest('c')
const sourceSetHash = digest('d')
const content = 'A😀e\u0301'
const knowledgeTables = [
  'context_build_entries',
  'context_build_sources',
  'context_builds',
  'context_uses',
  'knowledge_chunks',
  'knowledge_sources',
] as const
const knowledgeIndexes = [
  'idx_context_build_entries_selected',
  'idx_context_build_sources_source',
  'idx_context_builds_status',
  'idx_context_uses_build',
  'idx_context_uses_job',
  'idx_knowledge_chunks_source',
  'idx_knowledge_sources_locator',
  'idx_knowledge_sources_state',
] as const
const knowledgeTriggers = [
  'context_build_entries_delete',
  'context_build_entries_immutable',
  'context_build_entries_insert',
  'context_build_sources_delete',
  'context_build_sources_immutable',
  'context_build_sources_insert',
  'context_builds_delete',
  'context_builds_identity_immutable',
  'context_builds_scope_insert',
  'context_builds_status_transition',
  'context_uses_delete',
  'context_uses_finish',
  'context_uses_insert',
  'context_uses_mark_build_used',
  'knowledge_chunks_delete',
  'knowledge_chunks_immutable',
  'knowledge_chunks_insert',
  'knowledge_sources_delete',
  'knowledge_sources_immutable',
  'knowledge_sources_scope_insert',
] as const
const sourceRangeJson = JSON.stringify({
  start_line: 1,
  end_line: 1,
  start_byte: 0,
  end_byte: 8,
})
const scoreComponentsJson = JSON.stringify({
  authority_micros: 1,
  relevance_micros: 0,
  freshness_micros: 0,
  recency_micros: 0,
  contract_micros: 0,
  pin_micros: 0,
})

interface SourceOverrides {
  id?: string
  sourceKind?: string
  trustClass?: string
  contentSha256?: string
  freshnessPolicy?: string
  freshnessState?: string
  redactionState?: string
  contentState?: string
  ingestState?: string
  accessScopeJson?: string
  targetsJson?: string
  provenanceJson?: string
}

interface BuildOverrides {
  id?: string
  requestJson?: string
  requestFingerprint?: string
  sourceSetJson?: string
  sourceSetFingerprint?: string
  manifestFingerprint?: string
  usageJson?: string
  sourceCount?: number
  entryCount?: number
  status?: string
  invalidatedAt?: string | null
}

interface EntryOverrides {
  candidateOrdinal?: number
  sourceId?: string
  chunkId?: string
  selectedOrdinal?: number | null
  decision?: string
  reason?: string
  scoreComponentsJson?: string
  scoreMicros?: number
  rendering?: string
  estimatedTokens?: number
  characterCount?: number
  redactionState?: string
  sourceRangeJson?: string
  contentSha256?: string
}

function repositoryProvenanceJson(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    repository_key: 'agentboard',
    base_commit_sha: digest('a').slice(0, 40),
    worktree_state_hash: null,
    relative_root: '.',
    adapter_id: 'migration-test',
    adapter_version: '1.0.0',
    adapter_index_commit_sha: null,
    observed_at: at,
    ...overrides,
  })
}

function targets(boardId: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    board_id: boardId,
    workspace_id: null,
    card_id: null,
    contract_ref: null,
    contract_version: null,
    contract_snapshot_sha256: null,
    job_id: null,
    profile_id: null,
    session_id: null,
    delivery_report_id: null,
    ...overrides,
  })
}

function insertBoard(db: Database.Database, suffix: string): number {
  return Number(db.prepare(
    'INSERT INTO boards (project_path, name) VALUES (?, ?)',
  ).run(`/knowledge-migration-${suffix}`, `knowledge migration ${suffix}`).lastInsertRowid)
}

function insertSource(
  db: Database.Database,
  boardId: number,
  overrides: SourceOverrides = {},
): void {
  db.prepare(`
    INSERT INTO knowledge_sources (
      board_id, id, source_kind, trust_class, title, locator, normalized_locator,
      source_revision, content_sha256, freshness_policy, freshness_state,
      redaction_state, content_state, ingest_state, access_scope_json,
      targets_json, provenance_json, created_at, updated_at
    ) VALUES (
      @boardId, @id, @sourceKind, @trustClass, 'README', 'README.md', 'README.md',
      'revision-one', @contentSha256, @freshnessPolicy, @freshnessState,
      @redactionState, @contentState, @ingestState, @accessScopeJson,
      @targetsJson, @provenanceJson, @at, @at
    )
  `).run({
    boardId,
    id: overrides.id ?? sourceId,
    sourceKind: overrides.sourceKind ?? 'readme',
    trustClass: overrides.trustClass ?? 'instruction',
    contentSha256: overrides.contentSha256 ?? contentHash,
    freshnessPolicy: overrides.freshnessPolicy ?? 'commit_exact',
    freshnessState: overrides.freshnessState ?? 'fresh',
    redactionState: overrides.redactionState ?? 'none',
    contentState: overrides.contentState ?? 'present',
    ingestState: overrides.ingestState ?? 'active',
    accessScopeJson: overrides.accessScopeJson ?? JSON.stringify({ kind: 'board' }),
    targetsJson: overrides.targetsJson ?? targets(boardId),
    provenanceJson: overrides.provenanceJson ?? repositoryProvenanceJson(),
    at,
  })
}

function insertChunk(
  db: Database.Database,
  boardId: number,
  overrides: {
    id?: string
    sourceId?: string
    ordinal?: number
    content?: string
    contentSha256?: string
    characterCount?: number
    byteCount?: number
    sourceRangeJson?: string
    symbolJson?: string
  } = {},
): void {
  const value = overrides.content ?? content
  db.prepare(`
    INSERT INTO knowledge_chunks (
      board_id, id, source_id, ordinal, content, content_sha256,
      character_count, byte_count, estimated_tokens, source_range_json,
      symbol_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    boardId,
    overrides.id ?? chunkId,
    overrides.sourceId ?? sourceId,
    overrides.ordinal ?? 0,
    value,
    overrides.contentSha256 ?? contentHash,
    overrides.characterCount ?? value.length,
    overrides.byteCount ?? Buffer.byteLength(value, 'utf8'),
    overrides.sourceRangeJson ?? sourceRangeJson,
    overrides.symbolJson ?? null,
    at,
  )
}

function requestJson(
  boardId: number,
  targetOverrides: Record<string, unknown> = {},
  accessScope: Record<string, unknown> = { kind: 'board' },
): string {
  return JSON.stringify({
    board_id: boardId,
    access_scope: accessScope,
    targets: JSON.parse(targets(boardId, targetOverrides)),
    budget: {
      max_tokens: 10,
      max_characters: 100,
      sections: {},
    },
    selection_request_sha256: digest('e'),
  })
}

function sourceSetJson(
  id = sourceId,
  redactionState = 'none',
): string {
  return JSON.stringify([{
    source_id: id,
    source_revision: 'revision-one',
    content_sha256: contentHash,
    freshness_state: 'fresh',
    redaction_state: redactionState,
  }])
}

function insertBuild(
  db: Database.Database,
  boardId: number,
  overrides: BuildOverrides = {},
): void {
  db.prepare(`
    INSERT INTO context_builds (
      board_id, id, request_json, request_fingerprint, source_set_json,
      source_set_fingerprint, manifest_fingerprint, usage_json, source_count,
      entry_count, status, created_at, invalidated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    boardId,
    overrides.id ?? buildId,
    overrides.requestJson ?? requestJson(boardId),
    overrides.requestFingerprint ?? requestHash,
    overrides.sourceSetJson ?? sourceSetJson(),
    overrides.sourceSetFingerprint ?? sourceSetHash,
    overrides.manifestFingerprint ?? manifestHash,
    overrides.usageJson ?? JSON.stringify({
      used_tokens: 1,
      used_characters: content.length,
      sections: {
        relevant_code: {
          used_tokens: 1,
          used_characters: content.length,
        },
      },
    }),
    overrides.sourceCount ?? 1,
    overrides.entryCount ?? 1,
    overrides.status ?? 'built',
    at,
    overrides.invalidatedAt ?? null,
  )
}

function insertBuildSource(
  db: Database.Database,
  boardId: number,
  input: {
    contextBuildId?: string
    sourceOrdinal?: number
    sourceId?: string
    redactionState?: string
  } = {},
): void {
  db.prepare(`
    INSERT INTO context_build_sources (
      board_id, context_build_id, source_ordinal, source_id, source_revision,
      content_sha256, freshness_state, redaction_state
    ) VALUES (?, ?, ?, ?, 'revision-one', ?, 'fresh', ?)
  `).run(
    boardId,
    input.contextBuildId ?? buildId,
    input.sourceOrdinal ?? 0,
    input.sourceId ?? sourceId,
    contentHash,
    input.redactionState ?? 'none',
  )
}

function insertEntry(
  db: Database.Database,
  boardId: number,
  contextBuildId = buildId,
  overrides: EntryOverrides = {},
): void {
  db.prepare(`
    INSERT INTO context_build_entries (
      board_id, context_build_id, candidate_ordinal, source_id, chunk_id,
      section, selected_ordinal, decision, reason, score_components_json,
      score_micros, rendering, estimated_tokens, character_count, source_kind,
      trust_class, freshness_state, redaction_state, normalized_locator,
      source_range_json, content_sha256
    ) VALUES (
      ?, ?, ?, ?, ?, 'relevant_code', ?, ?, ?, ?, ?, ?, ?, ?, 'readme',
      'instruction', 'fresh', ?, 'README.md', ?, ?
    )
  `).run(
    boardId,
    contextBuildId,
    overrides.candidateOrdinal ?? 0,
    overrides.sourceId ?? sourceId,
    overrides.chunkId ?? chunkId,
    overrides.selectedOrdinal === undefined ? 0 : overrides.selectedOrdinal,
    overrides.decision ?? 'selected',
    overrides.reason ?? 'within_budget',
    overrides.scoreComponentsJson ?? scoreComponentsJson,
    overrides.scoreMicros ?? 1,
    overrides.rendering ?? 'full',
    overrides.estimatedTokens ?? 1,
    overrides.characterCount ?? content.length,
    overrides.redactionState ?? 'none',
    overrides.sourceRangeJson ?? sourceRangeJson,
    overrides.contentSha256 ?? contentHash,
  )
}

function insertRuntime(
  db: Database.Database,
  boardId: number,
  suffix: string,
): { jobId: string; sessionId: string; workspaceId: string } {
  const workspaceId = `knowledge-${suffix}-workspace`
  const jobId = `knowledge-${suffix}-job`
  const sessionId = `knowledge-${suffix}-session`
  db.prepare(`
    INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, ?, 'shared', ?, 'active')
  `).run(workspaceId, boardId, workspaceId, `/tmp/${workspaceId}`)
  db.prepare(`
    INSERT INTO jobs (id, board_id, workspace_id, provider, status)
    VALUES (?, ?, ?, 'codex', 'queued')
  `).run(jobId, boardId, workspaceId)
  db.prepare(`
    INSERT INTO agent_sessions (id, workspace_id, provider, status, job_id)
    VALUES (?, ?, 'codex', 'running', ?)
  `).run(sessionId, workspaceId, jobId)
  return { jobId, sessionId, workspaceId }
}

function insertContextUse(
  db: Database.Database,
  boardId: number,
  runtime: { jobId: string; sessionId: string },
  overrides: {
    id?: string
    contextBuildId?: string
    manifestFingerprint?: string
    estimatedTokens?: number
    outcome?: string
    actualTokens?: number | null
    completedAt?: string | null
  } = {},
): void {
  db.prepare(`
    INSERT INTO context_uses (
      board_id, id, context_build_id, job_id, session_id, injection_ordinal,
      manifest_fingerprint, estimated_tokens, actual_tokens, cache_identity,
      outcome, injected_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'cache-one', ?, ?, ?)
  `).run(
    boardId,
    overrides.id ?? useId,
    overrides.contextBuildId ?? buildId,
    runtime.jobId,
    runtime.sessionId,
    overrides.manifestFingerprint ?? manifestHash,
    overrides.estimatedTokens ?? 1,
    overrides.actualTokens ?? null,
    overrides.outcome ?? 'running',
    at,
    overrides.completedAt ?? null,
  )
}

function removeMigration018(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS context_uses;
    DROP TABLE IF EXISTS context_build_entries;
    DROP TABLE IF EXISTS context_build_sources;
    DROP TABLE IF EXISTS context_builds;
    DROP TABLE IF EXISTS knowledge_chunks;
    DROP TABLE IF EXISTS knowledge_sources;
    DELETE FROM os_schema_migrations WHERE id='018-knowledge-persistence';
  `)
}

function completeBuild(db: Database.Database, boardId: number): void {
  insertSource(db, boardId)
  insertChunk(db, boardId)
  insertBuild(db, boardId)
  insertBuildSource(db, boardId)
  insertEntry(db, boardId)
}

function insertScopeGraph(
  db: Database.Database,
  boardId: number,
  suffix: string,
): {
    cardId: number
    contractVersion: number
    jobId: string
    profileId: string
    sessionId: string
    workspaceId: string
  } {
  const cardId = Number(db.prepare(`
    INSERT INTO cards (board_id, title) VALUES (?, ?)
  `).run(boardId, `knowledge ${suffix} card`).lastInsertRowid)
  const workspaceId = `knowledge-${suffix}-workspace`
  const jobId = `knowledge-${suffix}-job`
  const profileId = `knowledge-${suffix}-profile`
  const conversationId = `knowledge-${suffix}-conversation`
  const sessionId = `knowledge-${suffix}-session`
  db.prepare(`
    INSERT INTO task_contracts (card_id, objective, version)
    VALUES (?, 'exercise knowledge scope closure', 1)
  `).run(cardId)
  db.prepare(`
    INSERT INTO workspaces (id, board_id, card_id, name, kind, root_path, status)
    VALUES (?, ?, ?, ?, 'shared', ?, 'active')
  `).run(workspaceId, boardId, cardId, workspaceId, `/tmp/${workspaceId}`)
  db.prepare(`
    INSERT INTO agent_profiles (
      id, board_id, name, owner_actor_type, created_at, updated_at
    ) VALUES (?, ?, ?, 'human', ?, ?)
  `).run(profileId, boardId, profileId, at, at)
  db.prepare(`
    INSERT INTO agent_conversations (
      id, board_id, profile_id, title, created_by_actor_type, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'human', ?, ?)
  `).run(conversationId, boardId, profileId, conversationId, at, at)
  db.prepare(`
    INSERT INTO jobs (
      id, board_id, card_id, workspace_id, provider, status, contract_version
    ) VALUES (?, ?, ?, ?, 'codex', 'queued', 1)
  `).run(jobId, boardId, cardId, workspaceId)
  db.prepare(`
    INSERT INTO agent_sessions (
      id, workspace_id, provider, status, job_id, profile_id, conversation_id
    ) VALUES (?, ?, 'codex', 'running', ?, ?, ?)
  `).run(sessionId, workspaceId, jobId, profileId, conversationId)
  return {
    cardId,
    contractVersion: 1,
    jobId,
    profileId,
    sessionId,
    workspaceId,
  }
}

function fullTargets(
  boardId: number,
  graph: ReturnType<typeof insertScopeGraph>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    board_id: boardId,
    workspace_id: graph.workspaceId,
    card_id: graph.cardId,
    contract_ref: `card:${graph.cardId}:v${graph.contractVersion}`,
    contract_version: graph.contractVersion,
    contract_snapshot_sha256: digest('f'),
    job_id: graph.jobId,
    profile_id: graph.profileId,
    session_id: graph.sessionId,
    delivery_report_id: null,
    ...overrides,
  }
}

describe('knowledge persistence migration 018', () => {
  it('installs all six durable tables after migration 017', () => {
    const db = openDb(':memory:')
    expect(db.prepare(`
      SELECT id FROM os_schema_migrations WHERE id=?
    `).get(MIGRATION_ID)).toEqual({ id: MIGRATION_ID })
    expect(db.prepare(`
      SELECT id FROM os_schema_migrations ORDER BY rowid DESC LIMIT 1
    `).get()).toEqual({ id: '021-command-idempotency-coverage' })
    const tables = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name IN (
        'knowledge_sources', 'knowledge_chunks', 'context_builds',
        'context_build_sources', 'context_build_entries', 'context_uses'
      ) ORDER BY name
    `).all() as Array<{ name: string }>).map(({ name }) => name)
    expect(tables).toEqual([
      'context_build_entries',
      'context_build_sources',
      'context_builds',
      'context_uses',
      'knowledge_chunks',
      'knowledge_sources',
    ])
    expect((db.prepare(
      'SELECT COUNT(*) AS count FROM os_schema_migrations',
    ).get() as { count: number }).count).toBe(21)
    db.close()
  })

  it('installs the exact six-table, eight-index, and twenty-trigger inventory', () => {
    const db = openDb(':memory:')
    const objects = db.prepare(`
      SELECT type, name
      FROM sqlite_master
      WHERE tbl_name IN (
        'knowledge_sources', 'knowledge_chunks', 'context_builds',
        'context_build_sources', 'context_build_entries', 'context_uses'
      )
        AND type IN ('table', 'index', 'trigger')
        AND name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY type, name
    `).all() as Array<{ type: string; name: string }>

    expect(objects.filter(({ type }) => type === 'table').map(({ name }) => name))
      .toEqual(knowledgeTables)
    expect(objects.filter(({ type }) => type === 'index').map(({ name }) => name))
      .toEqual(knowledgeIndexes)
    expect(objects.filter(({ type }) => type === 'trigger').map(({ name }) => name))
      .toEqual(knowledgeTriggers)
    db.close()
  })

  it('atomically rejects full-column weak and textually altered schema lookalikes', () => {
    const weakKnowledgeSources = `
      CREATE TABLE knowledge_sources (
        board_id INTEGER, id TEXT, source_kind TEXT, trust_class TEXT, title TEXT,
        locator TEXT, normalized_locator TEXT, source_revision TEXT,
        content_sha256 TEXT, freshness_policy TEXT, freshness_state TEXT,
        redaction_state TEXT, content_state TEXT, ingest_state TEXT,
        access_scope_json TEXT, targets_json TEXT, provenance_json TEXT,
        created_at TEXT, updated_at TEXT
      )
    `
    const variants: Array<(canonical: string) => string> = [
      () => weakKnowledgeSources,
      (canonical) => canonical.replace("'forgotten'", "'FORGOTTEN'"),
      (canonical) => canonical.replace('knowledge_sources (', 'knowledge_sources  ('),
    ]

    for (const variant of variants) {
      const db = openDb(':memory:')
      const canonical = (db.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type='table' AND name='knowledge_sources'
      `).get() as { sql: string }).sql
      removeMigration018(db)
      db.exec(variant(canonical))

      expect(() => applyAgentOsMigrations(db)).toThrow(/incompatible knowledge schema/)
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?
      `).get(MIGRATION_ID)).toEqual({ count: 0 })
      expect(db.prepare(`
        SELECT type, name FROM sqlite_master
        WHERE (
          name LIKE 'knowledge_%'
          OR name LIKE 'context_build%'
          OR name LIKE 'context_uses%'
        )
          AND name NOT LIKE 'sqlite_autoindex_%'
        ORDER BY type, name
      `).all()).toEqual([{ type: 'table', name: 'knowledge_sources' }])
      db.close()
    }
  })

  it('upgrades a migration-017 database and safely reruns after marker loss', () => {
    const db = openDb(':memory:')
    removeMigration018(db)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?
    `).get(MIGRATION_ID)).toEqual({ count: 0 })

    applyAgentOsMigrations(db)
    const boardId = insertBoard(db, 'forward')
    insertSource(db, boardId)
    insertChunk(db, boardId)
    db.prepare('DELETE FROM os_schema_migrations WHERE id=?').run(MIGRATION_ID)

    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_sources WHERE board_id=? AND id=?
    `).get(boardId, sourceId)).toEqual({ count: 1 })
    expect(db.prepare(`
      SELECT character_count, byte_count FROM knowledge_chunks
      WHERE board_id=? AND id=?
    `).get(boardId, chunkId)).toEqual({
      character_count: 5,
      byte_count: 8,
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?
    `).get(MIGRATION_ID)).toEqual({ count: 1 })
    db.close()
  })

  it('recovers historical migration 005 marker loss while migration 018 remains installed', () => {
    const db = openDb(':memory:')
    db.prepare(`
      DELETE FROM os_schema_migrations
      WHERE id='005-delivery-report-revision-cascade'
    `).run()

    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    expect(db.prepare(`
      SELECT id FROM os_schema_migrations
      WHERE id IN (
        '005-delivery-report-revision-cascade',
        '018-knowledge-persistence'
      )
      ORDER BY id
    `).all()).toEqual([
      { id: '005-delivery-report-revision-cascade' },
      { id: MIGRATION_ID },
    ])
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name IN (
        'knowledge_sources', 'knowledge_chunks', 'context_builds',
        'context_build_sources', 'context_build_entries', 'context_uses'
      )
    `).get()).toEqual({ count: 6 })
    db.close()
  })

  it('rolls back every new object and leaves no marker on an incompatible partial schema', () => {
    const db = openDb(':memory:')
    removeMigration018(db)
    db.exec('CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY)')

    expect(() => applyAgentOsMigrations(db)).toThrow()
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?
    `).get(MIGRATION_ID)).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name LIKE 'knowledge_%'
      ORDER BY name
    `).all()).toEqual([{ name: 'knowledge_chunks' }])
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name LIKE 'context_build%'
    `).get()).toEqual({ count: 0 })
    db.close()
  })

  it('isolates identical identities by board and rejects cross-board relations', () => {
    const db = openDb(':memory:')
    const firstBoardId = insertBoard(db, 'first-board')
    const secondBoardId = insertBoard(db, 'second-board')
    insertSource(db, firstBoardId)
    insertSource(db, secondBoardId)
    insertChunk(db, firstBoardId)
    insertChunk(db, secondBoardId)

    expect(db.prepare(`
      SELECT board_id, id FROM knowledge_sources WHERE id=? ORDER BY board_id
    `).all(sourceId)).toEqual([
      { board_id: firstBoardId, id: sourceId },
      { board_id: secondBoardId, id: sourceId },
    ])
    const secondOnlySourceId = `ks_${digest('5')}`
    insertSource(db, secondBoardId, { id: secondOnlySourceId })
    expect(() => insertChunk(db, firstBoardId, {
      id: `kc_${digest('6')}`,
      sourceId: secondOnlySourceId,
    })).toThrow(/source state is inconsistent|FOREIGN KEY/)

    const firstWorkspaceId = 'knowledge-scope-first'
    const alternateWorkspaceId = 'knowledge-scope-alternate'
    for (const workspaceId of [firstWorkspaceId, alternateWorkspaceId]) {
      db.prepare(`
        INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
        VALUES (?, ?, ?, 'shared', ?, 'active')
      `).run(workspaceId, firstBoardId, workspaceId, `/tmp/${workspaceId}`)
    }
    expect(() => insertSource(db, firstBoardId, {
      id: `ks_${digest('7')}`,
      accessScopeJson: JSON.stringify({
        kind: 'workspace',
        workspace_id: firstWorkspaceId,
      }),
      targetsJson: targets(firstBoardId, { workspace_id: alternateWorkspaceId }),
    })).toThrow(/access scope is inconsistent/)
    db.close()
  })

  it('requires stable same-board targets and pairwise scope closure for sources and builds', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'scope-closure')
    const alternateBoardId = insertBoard(db, 'scope-other-board')
    const first = insertScopeGraph(db, boardId, 'scope-first')
    const second = insertScopeGraph(db, boardId, 'scope-second')
    const crossBoard = insertScopeGraph(db, alternateBoardId, 'scope-cross-board')
    const validTargets = fullTargets(boardId, first)

    insertSource(db, boardId, { targetsJson: JSON.stringify(validTargets) })
    insertBuild(db, boardId, {
      requestJson: requestJson(boardId, validTargets),
    })
    const validSessionContractTargets = fullTargets(boardId, first, {
      workspace_id: null,
      job_id: null,
      profile_id: null,
    })
    insertSource(db, boardId, {
      id: `ks_${'a'.repeat(64)}`,
      targetsJson: JSON.stringify(validSessionContractTargets),
    })
    insertBuild(db, boardId, {
      id: `cb_${'a'.repeat(64)}`,
      requestFingerprint: 'a'.repeat(64),
      requestJson: requestJson(boardId, validSessionContractTargets),
    })
    const invalidSessionContractTargets = fullTargets(boardId, first, {
      workspace_id: null,
      job_id: null,
      profile_id: null,
      session_id: second.sessionId,
    })
    expect(() => insertSource(db, boardId, {
      id: `ks_${'b'.repeat(64)}`,
      targetsJson: JSON.stringify(invalidSessionContractTargets),
    })).toThrow(/target|scope/)
    expect(() => insertBuild(db, boardId, {
      id: `cb_${'b'.repeat(64)}`,
      requestFingerprint: 'b'.repeat(64),
      requestJson: requestJson(boardId, invalidSessionContractTargets),
    })).toThrow(/target|scope/)

    const invalidTargets = [
      fullTargets(boardId, first, {
        workspace_id: second.workspaceId,
      }),
      fullTargets(boardId, first, {
        card_id: second.cardId,
        contract_ref: `card:${second.cardId}:v1`,
      }),
      fullTargets(boardId, first, {
        job_id: second.jobId,
      }),
      fullTargets(boardId, first, {
        profile_id: second.profileId,
      }),
      fullTargets(boardId, first, {
        session_id: second.sessionId,
      }),
      fullTargets(boardId, first, {
        workspace_id: crossBoard.workspaceId,
      }),
    ]
    for (const [index, invalid] of invalidTargets.entries()) {
      expect(() => insertSource(db, boardId, {
        id: `ks_${String(index + 2).repeat(64)}`,
        targetsJson: JSON.stringify(invalid),
      })).toThrow(/target|scope/)
      expect(() => insertBuild(db, boardId, {
        id: `cb_${String(index + 2).repeat(64)}`,
        requestFingerprint: String(index + 2).repeat(64),
        requestJson: requestJson(boardId, invalid),
      })).toThrow(/target|scope/)
    }

    db.prepare('UPDATE task_contracts SET version=2 WHERE card_id=?')
      .run(first.cardId)
    const jobVersionMismatch = fullTargets(boardId, first, {
      contract_ref: `card:${first.cardId}:v2`,
      contract_version: 2,
    })
    expect(() => insertSource(db, boardId, {
      id: `ks_${'8'.repeat(64)}`,
      targetsJson: JSON.stringify(jobVersionMismatch),
    })).toThrow(/target|scope/)
    expect(() => insertBuild(db, boardId, {
      id: `cb_${'8'.repeat(64)}`,
      requestFingerprint: '8'.repeat(64),
      requestJson: requestJson(boardId, jobVersionMismatch),
    })).toThrow(/target|scope/)

    db.prepare('UPDATE jobs SET contract_version=2 WHERE id=?').run(first.jobId)
    insertSource(db, boardId, {
      id: `ks_${'9'.repeat(64)}`,
      targetsJson: JSON.stringify(jobVersionMismatch),
    })
    insertBuild(db, boardId, {
      id: `cb_${'9'.repeat(64)}`,
      requestFingerprint: '9'.repeat(64),
      requestJson: requestJson(boardId, jobVersionMismatch),
    })
    db.close()
  })

  it('rejects missing mandatory scope fields and malformed contract snapshots', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'null-semantics')
    const graph = insertScopeGraph(db, boardId, 'null-semantics')
    const requiredTargets = fullTargets(boardId, graph)
    const withoutBoard = { ...requiredTargets }
    delete withoutBoard.board_id

    expect(() => insertSource(db, boardId, {
      targetsJson: JSON.stringify(withoutBoard),
    })).toThrow(/target|scope/)
    expect(() => insertSource(db, boardId, {
      targetsJson: JSON.stringify(fullTargets(boardId, graph, {
        contract_snapshot_sha256: digest('A'),
      })),
    })).toThrow(/contract target/)

    const missingRequestFields = [
      {
        access_scope: { kind: 'board' },
        targets: requiredTargets,
        budget: { max_tokens: 10, max_characters: 100, sections: {} },
      },
      {
        board_id: boardId,
        access_scope: { kind: 'board' },
        budget: { max_tokens: 10, max_characters: 100, sections: {} },
      },
      {
        board_id: boardId,
        access_scope: { kind: 'board' },
        targets: requiredTargets,
      },
    ]
    for (const [index, request] of missingRequestFields.entries()) {
      expect(() => insertBuild(db, boardId, {
        id: `cb_${String(index + 5).repeat(64)}`,
        requestFingerprint: String(index + 5).repeat(64),
        requestJson: JSON.stringify(request),
      })).toThrow(/request scope|budget accounting/)
    }
    for (const [index, usage] of [
      { used_characters: 0, sections: {} },
      { used_tokens: 0, sections: {} },
      { used_tokens: 0, used_characters: 0 },
    ].entries()) {
      expect(() => insertBuild(db, boardId, {
        id: `cb_${['9', 'a', 'b'][index].repeat(64)}`,
        requestFingerprint: ['9', 'a', 'b'][index].repeat(64),
        requestJson: requestJson(boardId, requiredTargets),
        usageJson: JSON.stringify(usage),
      })).toThrow(/budget accounting/)
    }
    expect(() => insertBuild(db, boardId, {
      id: `cb_${digest('8')}`,
      requestFingerprint: digest('8'),
      requestJson: requestJson(boardId, fullTargets(boardId, graph, {
        contract_snapshot_sha256: 'abc',
      })),
    })).toThrow(/contract target/)
    db.close()
  })

  it('rejects non-exact direct-SQL source and build request shapes atomically', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'exact-json-shapes')
    const unsafeWorkspaceId = ' unsafe-workspace '
    const nonAsciiWhitespaceWorkspaceId = '\u00a0unsafe-workspace\u00a0'
    const insertUnsafeWorkspace = db.prepare(`
      INSERT INTO workspaces (
        id, board_id, name, kind, root_path, status
      ) VALUES (?, ?, 'unsafe workspace', 'shared', '/tmp/unsafe', 'active')
    `)
    insertUnsafeWorkspace.run(unsafeWorkspaceId, boardId)
    insertUnsafeWorkspace.run(nonAsciiWhitespaceWorkspaceId, boardId)
    const completeProvenance = repositoryProvenanceJson()
    const completeTargets = JSON.parse(targets(boardId)) as Record<string, unknown>
    const sourceAttempts: SourceOverrides[] = [
      {
        accessScopeJson: JSON.stringify({ kind: 'board', extra: null }),
      },
      {
        accessScopeJson: '{"kind":"board","kind":"board"}',
      },
      {
        accessScopeJson: JSON.stringify({
          kind: 'workspace',
          workspace_id: unsafeWorkspaceId,
        }),
        targetsJson: targets(boardId, {
          workspace_id: unsafeWorkspaceId,
        }),
      },
      {
        accessScopeJson: JSON.stringify({
          kind: 'workspace',
          workspace_id: nonAsciiWhitespaceWorkspaceId,
        }),
        targetsJson: targets(boardId, {
          workspace_id: nonAsciiWhitespaceWorkspaceId,
        }),
      },
      {
        targetsJson: JSON.stringify({ board_id: boardId }),
      },
      {
        targetsJson: JSON.stringify({ ...completeTargets, extra: null }),
      },
      {
        targetsJson: targets(boardId).replace(
          `"board_id":${boardId}`,
          `"board_id":${boardId},"board_id":${boardId}`,
        ),
      },
      {
        targetsJson: targets(boardId, { delivery_report_id: 1 }),
      },
      {
        targetsJson: targets(boardId, { delivery_report_id: '' }),
      },
      {
        provenanceJson: '{}',
      },
      {
        provenanceJson: JSON.stringify({
          ...JSON.parse(completeProvenance),
          extra: null,
        }),
      },
      {
        provenanceJson: completeProvenance.replace(
          '"repository_key":"agentboard"',
          '"repository_key":"agentboard","repository_key":"agentboard"',
        ),
      },
      {
        provenanceJson: repositoryProvenanceJson({ repository_key: 1 }),
      },
      {
        provenanceJson: repositoryProvenanceJson({
          repository_key: 'bad\u0001key',
        }),
      },
      {
        provenanceJson: repositoryProvenanceJson({
          repository_key: '\u00a0bad-key\u00a0',
        }),
      },
      {
        provenanceJson: repositoryProvenanceJson({
          base_commit_sha: digest('A').slice(0, 40),
        }),
      },
      {
        provenanceJson: repositoryProvenanceJson({
          worktree_state_hash: 'abc',
        }),
      },
      {
        provenanceJson: repositoryProvenanceJson({ relative_root: '..' }),
      },
      {
        provenanceJson: repositoryProvenanceJson({ adapter_id: ' bad ' }),
      },
      {
        provenanceJson: repositoryProvenanceJson({
          adapter_index_commit_sha: digest('A').slice(0, 40),
        }),
      },
      {
        provenanceJson: repositoryProvenanceJson({
          observed_at: '2026-07-26T24:00:00.000Z',
        }),
      },
    ]

    for (const attempt of sourceAttempts) {
      expect(() => insertSource(db, boardId, attempt)).toThrow()
    }
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_sources WHERE board_id=?
    `).get(boardId)).toEqual({ count: 0 })

    const completeRequestJson = requestJson(boardId)
    const completeRequest = JSON.parse(completeRequestJson) as Record<string, unknown>
    const withoutSelectionHash = { ...completeRequest }
    delete withoutSelectionHash.selection_request_sha256
    const requestWithSection = JSON.stringify({
      ...completeRequest,
      budget: {
        max_tokens: 10,
        max_characters: 100,
        sections: {
          relevant_code: { max_tokens: 1, max_characters: 1 },
        },
      },
    })
    const requestAttempts = [
      JSON.stringify(withoutSelectionHash),
      JSON.stringify({ ...completeRequest, extra: null }),
      completeRequestJson.replace(
        `"board_id":${boardId}`,
        `"board_id":${boardId},"board_id":${boardId}`,
      ),
      JSON.stringify({
        ...completeRequest,
        access_scope: { kind: 'board', extra: null },
      }),
      requestJson(
        boardId,
        { workspace_id: unsafeWorkspaceId },
        { kind: 'workspace', workspace_id: unsafeWorkspaceId },
      ),
      requestJson(
        boardId,
        { workspace_id: nonAsciiWhitespaceWorkspaceId },
        {
          kind: 'workspace',
          workspace_id: nonAsciiWhitespaceWorkspaceId,
        },
      ),
      completeRequestJson.replace(
        '"access_scope":{"kind":"board"}',
        '"access_scope":{"kind":"board","kind":"board"}',
      ),
      JSON.stringify({
        ...completeRequest,
        targets: { board_id: boardId },
      }),
      JSON.stringify({
        ...completeRequest,
        targets: { ...completeTargets, extra: null },
      }),
      completeRequestJson.replace(
        `"targets":{"board_id":${boardId}`,
        `"targets":{"board_id":${boardId},"board_id":${boardId}`,
      ),
      JSON.stringify({
        ...completeRequest,
        targets: {
          ...completeTargets,
          delivery_report_id: 1,
        },
      }),
      JSON.stringify({
        ...completeRequest,
        targets: {
          ...completeTargets,
          delivery_report_id: '',
        },
      }),
      JSON.stringify({
        ...completeRequest,
        budget: {
          ...completeRequest.budget as Record<string, unknown>,
          extra: null,
        },
      }),
      completeRequestJson.replace(
        '"budget":{"max_tokens":10',
        '"budget":{"max_tokens":10,"max_tokens":10',
      ),
      JSON.stringify({
        ...completeRequest,
        budget: {
          max_tokens: 10,
          max_characters: 100,
          sections: {
            unknown: { max_tokens: 1, max_characters: 1 },
          },
        },
      }),
      requestWithSection.replace(
        '"sections":{"relevant_code":{"max_tokens":1,"max_characters":1}}',
        '"sections":{"relevant_code":{"max_tokens":1,"max_characters":1},'
          + '"relevant_code":{"max_tokens":1,"max_characters":1}}',
      ),
      JSON.stringify({
        ...completeRequest,
        budget: {
          max_tokens: 10,
          max_characters: 100,
          sections: {
            relevant_code: { max_tokens: 1 },
          },
        },
      }),
      JSON.stringify({
        ...completeRequest,
        budget: {
          max_tokens: 10,
          max_characters: 100,
          sections: {
            relevant_code: JSON.stringify({
              max_tokens: 1,
              max_characters: 1,
            }),
          },
        },
      }),
      completeRequestJson.replace(
        '"max_tokens":10',
        '"max_tokens":-0',
      ),
      completeRequestJson.replace(
        '"max_characters":100',
        '"max_characters":-0',
      ),
      requestWithSection.replace(
        '"relevant_code":{"max_tokens":1',
        '"relevant_code":{"max_tokens":-0',
      ),
      requestWithSection.replace(
        '"max_characters":1',
        '"max_characters":-0',
      ),
      JSON.stringify({
        ...completeRequest,
        selection_request_sha256: digest('A'),
      }),
      JSON.stringify({
        ...completeRequest,
        selection_request_sha256: 'abc',
      }),
    ]
    const emptyUsage = JSON.stringify({
      used_tokens: 0,
      used_characters: 0,
      sections: {},
    })

    for (const [index, request] of requestAttempts.entries()) {
      const identity = String((index % 9) + 1)
      expect(() => insertBuild(db, boardId, {
        id: `cb_${identity.repeat(64)}`,
        requestJson: request,
        requestFingerprint: identity.repeat(64),
        sourceSetJson: '[]',
        sourceSetFingerprint: identity.repeat(64),
        manifestFingerprint: identity.repeat(64),
        usageJson: emptyUsage,
        sourceCount: 0,
        entryCount: 0,
        status: 'failed',
      })).toThrow()
    }

    const completeSourceSet = JSON.parse(sourceSetJson()) as Array<Record<string, unknown>>
    const sourceSetEntry = completeSourceSet[0]
    const completeUsage = JSON.stringify({
      used_tokens: 1,
      used_characters: content.length,
      sections: {
        relevant_code: {
          used_tokens: 1,
          used_characters: content.length,
        },
      },
    })
    const duplicateUsageSection = `{"used_tokens":2,`
      + `"used_characters":${content.length * 2},"sections":{`
      + `"relevant_code":{"used_tokens":1,"used_characters":${content.length}},`
      + `"relevant_code":{"used_tokens":1,"used_characters":${content.length}}}}`
    const oversizedSourceSet = Array.from({ length: 513 }, (_, index) => ({
      ...sourceSetEntry,
      source_id: `ks_${index.toString(16).padStart(64, '0')}`,
    }))
    const evidenceAttempts: BuildOverrides[] = [
      {
        usageJson: JSON.stringify({
          ...JSON.parse(completeUsage),
          extra: null,
        }),
      },
      {
        usageJson: completeUsage.replace(
          '"used_tokens":1',
          '"used_tokens":1,"used_tokens":1',
        ),
      },
      {
        usageJson: duplicateUsageSection,
      },
      {
        usageJson: JSON.stringify({
          used_tokens: 1,
          used_characters: content.length,
          sections: {
            relevant_code: JSON.stringify({
              used_tokens: 1,
              used_characters: content.length,
            }),
          },
        }),
      },
      {
        usageJson: emptyUsage.replace(
          '"used_tokens":0',
          '"used_tokens":-0',
        ),
      },
      {
        usageJson: emptyUsage.replace(
          '"used_characters":0',
          '"used_characters":-0',
        ),
      },
      {
        usageJson: completeUsage.replace(
          '"relevant_code":{"used_tokens":1',
          '"relevant_code":{"used_tokens":-0',
        ),
      },
      {
        usageJson: completeUsage.replace(
          `"used_characters":${content.length}}`,
          '"used_characters":-0}',
        ),
      },
      {
        sourceSetJson: JSON.stringify([{
          ...sourceSetEntry,
          extra: null,
        }]),
      },
      {
        sourceSetJson: JSON.stringify([JSON.stringify(sourceSetEntry)]),
      },
      {
        sourceSetJson: sourceSetJson().replace(
          `"source_id":"${sourceId}"`,
          `"source_id":"${sourceId}","source_id":"${sourceId}"`,
        ),
      },
      {
        sourceSetJson: JSON.stringify([
          { ...sourceSetEntry, source_id: `ks_${digest('2')}` },
          { ...sourceSetEntry, source_id: `ks_${digest('1')}` },
        ]),
        sourceCount: 2,
      },
      {
        sourceSetJson: JSON.stringify(oversizedSourceSet),
        sourceCount: oversizedSourceSet.length,
      },
      {
        entryCount: 513,
      },
    ]
    for (const attempt of evidenceAttempts) {
      expect(() => insertBuild(db, boardId, attempt)).toThrow()
    }

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM context_builds WHERE board_id=?
    `).get(boardId)).toEqual({ count: 0 })
    db.close()
  })

  it('rejects non-exact chunk and manifest JSON evidence atomically', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'exact-evidence-json')
    insertSource(db, boardId)
    const completeRange = JSON.parse(sourceRangeJson) as Record<string, unknown>
    const completeSymbol = {
      language: 'typescript',
      qualified_name: 'agentboard.knowledge',
      symbol_kind: 'module',
      signature_sha256: null,
    }
    const chunkAttempts: Array<{
      sourceRangeJson?: string
      symbolJson?: string
    }> = [
      {
        sourceRangeJson: JSON.stringify({
          start_line: 1,
          end_line: 1,
          start_byte: 0,
        }),
      },
      {
        sourceRangeJson: JSON.stringify({ ...completeRange, extra: null }),
      },
      {
        sourceRangeJson: sourceRangeJson.replace(
          '"start_line":1',
          '"start_line":1,"start_line":1',
        ),
      },
      {
        sourceRangeJson: JSON.stringify({
          ...completeRange,
          end_byte: 0,
        }),
      },
      {
        sourceRangeJson: sourceRangeJson.replace(
          '"start_byte":0',
          '"start_byte":-0',
        ),
      },
      {
        symbolJson: JSON.stringify({
          language: completeSymbol.language,
          qualified_name: completeSymbol.qualified_name,
          symbol_kind: completeSymbol.symbol_kind,
        }),
      },
      {
        symbolJson: JSON.stringify({ ...completeSymbol, extra: null }),
      },
      {
        symbolJson: JSON.stringify(completeSymbol).replace(
          '"language":"typescript"',
          '"language":"typescript","language":"typescript"',
        ),
      },
    ]
    for (const attempt of chunkAttempts) {
      expect(() => insertChunk(db, boardId, attempt)).toThrow()
    }
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_chunks WHERE board_id=?
    `).get(boardId)).toEqual({ count: 0 })

    insertChunk(db, boardId)
    insertBuild(db, boardId)
    insertBuildSource(db, boardId)
    const completeScore = JSON.parse(scoreComponentsJson) as Record<string, unknown>
    const scoreAttempts: Array<{
      scoreComponentsJson: string
      scoreMicros?: number
    }> = [
      {
        scoreComponentsJson: JSON.stringify({ ...completeScore, extra: 0 }),
      },
      {
        scoreComponentsJson: scoreComponentsJson.replace(
          '"authority_micros":1',
          '"authority_micros":1,"authority_micros":1',
        ),
      },
      ...[
        'authority_micros',
        'relevance_micros',
        'freshness_micros',
        'recency_micros',
        'contract_micros',
        'pin_micros',
      ].map((field) => ({
        scoreComponentsJson: scoreComponentsJson.replace(
          `"${field}":${field === 'authority_micros' ? 1 : 0}`,
          `"${field}":-0`,
        ),
        scoreMicros: field === 'authority_micros' ? 0 : 1,
      })),
    ]
    for (const score of scoreAttempts) {
      expect(() => insertEntry(db, boardId, buildId, {
        ...score,
      })).toThrow()
    }

    const malformedRanges = [
      JSON.stringify({
        start_line: 1,
        end_line: 1,
        start_byte: 0,
      }),
      JSON.stringify({ ...completeRange, extra: null }),
      sourceRangeJson.replace(
        '"start_line":1',
        '"start_line":1,"start_line":1',
      ),
      sourceRangeJson.replace(
        '"start_byte":0',
        '"start_byte":-0',
      ),
    ]
    db.pragma('ignore_check_constraints = ON')
    for (const [index, malformedRange] of malformedRanges.entries()) {
      insertChunk(db, boardId, {
        id: `kc_${String(index + 5).repeat(64)}`,
        ordinal: index + 1,
        sourceRangeJson: malformedRange,
      })
    }
    db.pragma('ignore_check_constraints = OFF')

    for (const [index, malformedRange] of malformedRanges.entries()) {
      expect(() => insertEntry(db, boardId, buildId, {
        chunkId: `kc_${String(index + 5).repeat(64)}`,
        sourceRangeJson: malformedRange,
      })).toThrow()
    }
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM context_build_entries
      WHERE board_id=? AND context_build_id=?
    `).get(boardId, buildId)).toEqual({ count: 0 })
    db.close()
  })

  it('intentionally leaves delivery report existence to fail-closed public reads', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'delivery-exception')
    const missingDeliveryId = 'delivery-report-not-yet-visible'
    insertSource(db, boardId, {
      targetsJson: targets(boardId, { delivery_report_id: missingDeliveryId }),
    })
    insertBuild(db, boardId, {
      requestJson: requestJson(boardId, { delivery_report_id: missingDeliveryId }),
    })
    const triggerSql = (db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type='trigger' AND name IN (
        'knowledge_sources_scope_insert', 'context_builds_scope_insert'
      )
    `).all() as Array<{ sql: string }>).map(({ sql }) => sql.toLowerCase())
    expect(triggerSql.every((sql) => !sql.includes('delivery_reports'))).toBe(true)
    db.close()
  })

  it('fails closed on malformed ids, hashes, JSON, enums, state pairs, and chunk counts', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'constraints')
    const attempts: Array<() => void> = [
      () => insertSource(db, boardId, { id: `ks_${digest('A')}` }),
      () => insertSource(db, boardId, { contentSha256: digest('z') }),
      () => insertSource(db, boardId, { sourceKind: 'prompt' }),
      () => insertSource(db, boardId, { accessScopeJson: '{bad-json' }),
      () => insertSource(db, boardId, {
        accessScopeJson: '{ "kind": "board" }',
      }),
      () => insertSource(db, boardId, {
        ingestState: 'forgotten',
        contentState: 'present',
      }),
      () => insertSource(db, boardId, {
        redactionState: 'withheld',
        contentState: 'present',
      }),
    ]
    for (const attempt of attempts) expect(attempt).toThrow()

    insertSource(db, boardId)
    expect(() => insertChunk(db, boardId, { byteCount: 7 })).toThrow(/CHECK/)
    expect(() => insertChunk(db, boardId, {
      id: `kc_${digest('7')}`,
      contentSha256: digest('z'),
    })).toThrow(/CHECK/)
    expect(() => db.prepare(`
      UPDATE knowledge_sources SET freshness_state='stale'
      WHERE board_id=? AND id=?
    `).run(boardId, sourceId)).toThrow(/immutable/)
    expect(() => db.prepare(`
      DELETE FROM knowledge_sources WHERE board_id=? AND id=?
    `).run(boardId, sourceId)).toThrow(/immutable/)
    db.close()
  })

  it('restricts board deletion and rejects chunks for unavailable source states', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'source-state')
    insertSource(db, boardId)
    expect(() => db.prepare('DELETE FROM boards WHERE id=?').run(boardId))
      .toThrow(/FOREIGN KEY/)

    const unavailableSources: SourceOverrides[] = [
      {
        id: `ks_${digest('5')}`,
        contentState: 'purged',
      },
      {
        id: `ks_${digest('6')}`,
        redactionState: 'withheld',
        contentState: 'withheld',
      },
      {
        id: `ks_${digest('7')}`,
        ingestState: 'forgotten',
        contentState: 'purged',
      },
    ]
    for (const [index, source] of unavailableSources.entries()) {
      insertSource(db, boardId, source)
      expect(() => insertChunk(db, boardId, {
        id: `kc_${String(index + 5).repeat(64)}`,
        sourceId: source.id,
      })).toThrow(/source state is inconsistent/)
    }
    db.close()
  })

  it('enforces direct-SQL semantic, size, and budget boundaries', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'size-budget')
    insertSource(db, boardId)
    expect(() => insertChunk(db, boardId, {
      characterCount: 2_000_001,
    })).toThrow(/CHECK/)
    expect(() => insertChunk(db, boardId, {
      byteCount: 8_000_001,
    })).toThrow(/CHECK/)

    expect(() => insertBuild(db, boardId, {
      requestJson: JSON.stringify({
        ...JSON.parse(requestJson(boardId)),
        budget: {
          max_tokens: 10_000_001,
          max_characters: 100,
          sections: {},
        },
      }),
    })).toThrow(/budget accounting/)
    expect(() => insertBuild(db, boardId, {
      id: `cb_${digest('5')}`,
      requestFingerprint: digest('5'),
      requestJson: requestJson(boardId),
      usageJson: JSON.stringify({
        used_tokens: 11,
        used_characters: 5,
        sections: {},
      }),
    })).toThrow(/budget accounting/)

    const jsonShellBytes = Buffer.byteLength('{"padding":""}', 'utf8')
    const atLimit = JSON.stringify({
      padding: 'x'.repeat(8_000_000 - jsonShellBytes),
    })
    const overLimit = JSON.stringify({
      padding: 'x'.repeat(8_000_001 - jsonShellBytes),
    })
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(8_000_000)
    expect(Buffer.byteLength(overLimit, 'utf8')).toBe(8_000_001)
    expect(() => insertSource(db, boardId, {
      id: `ks_${digest('8')}`,
      provenanceJson: atLimit,
    })).toThrow(/CHECK/)
    expect(() => insertSource(db, boardId, {
      id: `ks_${digest('9')}`,
      provenanceJson: overLimit,
    })).toThrow(/CHECK/)
    db.close()
  })

  it('enforces canonical ordered build evidence and permits withheld omitted history', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'build-evidence')
    insertSource(db, boardId)
    insertChunk(db, boardId)

    expect(() => insertBuild(db, boardId, { status: 'used' }))
      .toThrow(/request scope is inconsistent/)
    expect(() => insertBuild(db, boardId, {
      sourceCount: 2,
    })).toThrow(/CHECK/)
    expect(() => insertBuild(db, boardId, {
      requestJson: '{ "board_id": 1 }',
    })).toThrow()

    insertBuild(db, boardId, { entryCount: 2 })
    expect(() => insertBuildSource(db, boardId, { sourceOrdinal: 1 }))
      .toThrow(/order or evidence/)
    insertBuildSource(db, boardId)

    expect(() => insertEntry(db, boardId, buildId, {
      scoreComponentsJson: '{}',
    })).toThrow(/CHECK/)
    for (const missingKey of [
      'authority_micros',
      'relevance_micros',
      'freshness_micros',
      'recency_micros',
      'contract_micros',
      'pin_micros',
    ]) {
      const components = JSON.parse(scoreComponentsJson) as Record<string, number>
      delete components[missingKey]
      expect(() => insertEntry(db, boardId, buildId, {
        scoreComponentsJson: JSON.stringify(components),
      })).toThrow(/CHECK/)
    }
    expect(() => insertEntry(db, boardId, buildId, {
      reason: 'stale',
    })).toThrow(/CHECK/)
    expect(() => insertEntry(db, boardId, buildId, {
      selectedOrdinal: null,
      decision: 'omitted',
      reason: 'stale',
      rendering: 'none',
      estimatedTokens: 1,
      characterCount: 0,
    })).toThrow(/CHECK/)
    expect(() => insertEntry(db, boardId, buildId, {
      scoreMicros: 2,
    })).toThrow(/CHECK/)
    insertEntry(db, boardId)
    expect(() => insertEntry(db, boardId, buildId, {
      candidateOrdinal: 1,
      selectedOrdinal: 1,
    })).toThrow(/UNIQUE/)
    expect(() => db.prepare(`
      UPDATE context_build_entries SET score_micros=2
      WHERE board_id=? AND context_build_id=? AND candidate_ordinal=0
    `).run(boardId, buildId)).toThrow(/immutable/)

    const withheldSourceId = `ks_${digest('8')}`
    const withheldChunkId = `kc_${digest('9')}`
    const withheldBuildId = `cb_${digest('0')}`
    insertSource(db, boardId, {
      id: withheldSourceId,
      redactionState: 'withheld',
      contentState: 'withheld',
    })
    insertBuild(db, boardId, {
      id: withheldBuildId,
      sourceSetJson: sourceSetJson(withheldSourceId, 'withheld'),
      sourceSetFingerprint: digest('1'),
      manifestFingerprint: digest('2'),
      usageJson: JSON.stringify({
        used_tokens: 0,
        used_characters: 0,
        sections: {},
      }),
    })
    insertBuildSource(db, boardId, {
      contextBuildId: withheldBuildId,
      sourceId: withheldSourceId,
      redactionState: 'withheld',
    })
    expect(() => insertEntry(db, boardId, withheldBuildId, {
      sourceId: withheldSourceId,
      chunkId: withheldChunkId,
      selectedOrdinal: null,
      decision: 'omitted',
      reason: 'withheld',
      scoreComponentsJson: JSON.stringify({
        authority_micros: 0,
        relevance_micros: 0,
        freshness_micros: 0,
        recency_micros: 0,
        contract_micros: 0,
        pin_micros: 0,
      }),
      scoreMicros: 0,
      rendering: 'none',
      estimatedTokens: 0,
      characterCount: 0,
      redactionState: 'withheld',
    })).not.toThrow()
    db.close()
  })

  it('allows aggregate wrapper overhead but requires exact per-section accounting', () => {
    const attempt = (
      usage: {
        used_tokens: number
        used_characters: number
        sections: Record<string, { used_tokens: number; used_characters: number }>
      },
      entryTokens: number,
      shouldPass: boolean,
    ): void => {
      const db = openDb(':memory:')
      const boardId = insertBoard(db, `accounting-${usage.used_tokens}-${entryTokens}-${shouldPass}`)
      insertSource(db, boardId)
      insertChunk(db, boardId)
      insertBuild(db, boardId, { usageJson: JSON.stringify(usage) })
      insertBuildSource(db, boardId)
      insertEntry(db, boardId, buildId, { estimatedTokens: entryTokens })
      const runtime = insertRuntime(db, boardId, `accounting-${entryTokens}-${shouldPass}`)
      const operation = (): void => insertContextUse(db, boardId, runtime, {
        estimatedTokens: usage.used_tokens,
      })
      if (shouldPass) expect(operation).not.toThrow()
      else expect(operation).toThrow(/build evidence is inconsistent/)
      db.close()
    }

    attempt({
      used_tokens: 2,
      used_characters: 6,
      sections: {
        relevant_code: { used_tokens: 1, used_characters: 5 },
      },
    }, 1, true)
    attempt({
      used_tokens: 2,
      used_characters: 6,
      sections: {
        relevant_code: { used_tokens: 2, used_characters: 5 },
      },
    }, 1, false)
    attempt({
      used_tokens: 2,
      used_characters: 6,
      sections: {
        relevant_code: { used_tokens: 0, used_characters: 5 },
      },
    }, 1, false)
    attempt({
      used_tokens: 1,
      used_characters: 5,
      sections: {
        relevant_code: { used_tokens: 1, used_characters: 5 },
      },
    }, 2, false)
  })

  it('requires a complete scoped running use and permits exactly one terminal transition', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'context-use')
    completeBuild(db, boardId)
    const runtime = insertRuntime(db, boardId, 'context-use')

    expect(() => insertContextUse(db, boardId, runtime, {
      outcome: 'completed',
      actualTokens: 1,
      completedAt: at,
    })).toThrow(/begin running/)
    expect(() => insertContextUse(db, boardId, runtime, {
      estimatedTokens: 2,
    })).toThrow(/build evidence is inconsistent/)
    expect(() => db.prepare(`
      UPDATE context_builds SET status='used'
      WHERE board_id=? AND id=?
    `).run(boardId, buildId)).toThrow(/invalid context build status/)

    insertContextUse(db, boardId, runtime)
    expect(db.prepare(`
      SELECT status FROM context_builds WHERE board_id=? AND id=?
    `).get(boardId, buildId)).toEqual({ status: 'used' })
    expect(() => db.prepare(`
      UPDATE context_uses
      SET outcome='completed', actual_tokens=NULL, completed_at=?
      WHERE board_id=? AND id=?
    `).run(at, boardId, useId)).toThrow()
    expect(() => db.prepare(`
      UPDATE context_uses
      SET outcome='completed', actual_tokens=1, completed_at='2026-07-25T23:59:59.000Z'
      WHERE board_id=? AND id=?
    `).run(boardId, useId)).toThrow()
    expect(() => db.prepare(`
      UPDATE context_uses
      SET outcome='completed', actual_tokens=10000001, completed_at=?
      WHERE board_id=? AND id=?
    `).run(at, boardId, useId)).toThrow(/CHECK/)
    db.prepare(`
      UPDATE context_uses
      SET outcome='completed', actual_tokens=1, completed_at=?
      WHERE board_id=? AND id=?
    `).run(at, boardId, useId)
    expect(db.prepare(`
      SELECT outcome, actual_tokens, completed_at
      FROM context_uses WHERE board_id=? AND id=?
    `).get(boardId, useId)).toEqual({
      outcome: 'completed',
      actual_tokens: 1,
      completed_at: at,
    })
    expect(() => db.prepare(`
      UPDATE context_uses SET outcome='failed', completed_at=?
      WHERE board_id=? AND id=?
    `).run(at, boardId, useId)).toThrow(/immutable/)
    expect(() => db.prepare(`
      DELETE FROM context_uses WHERE board_id=? AND id=?
    `).run(boardId, useId)).toThrow(/immutable/)
    expect(() => db.prepare(`
      UPDATE context_builds SET status='failed'
      WHERE board_id=? AND id=?
    `).run(boardId, buildId)).toThrow(/invalid context build status/)
    expect(() => db.prepare(`
      UPDATE context_builds
      SET status='invalidated', invalidated_at='2026-07-25T23:59:59.000Z'
      WHERE board_id=? AND id=?
    `).run(boardId, buildId)).toThrow(/invalid context build status/)
    db.prepare(`
      UPDATE context_builds SET status='invalidated', invalidated_at=?
      WHERE board_id=? AND id=?
    `).run(at, boardId, buildId)
    expect(db.prepare(`
      SELECT status, invalidated_at FROM context_builds WHERE board_id=? AND id=?
    `).get(boardId, buildId)).toEqual({
      status: 'invalidated',
      invalidated_at: at,
    })
    expect(() => db.prepare(`
      UPDATE context_builds
      SET invalidated_at='2026-07-26T00:00:01.000Z'
      WHERE board_id=? AND id=?
    `).run(boardId, buildId)).toThrow(/invalid context build status/)
    db.close()
  })

  it('does not write os_events or expose approval surfaces from knowledge persistence', () => {
    const db = openDb(':memory:')
    const boardId = insertBoard(db, 'no-approval-events')
    const before = db.prepare('SELECT COUNT(*) AS count FROM os_events').get()
    completeBuild(db, boardId)
    expect(db.prepare('SELECT COUNT(*) AS count FROM os_events').get()).toEqual(before)

    const schemaSql = (db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger')
        AND tbl_name IN (
          'knowledge_sources', 'knowledge_chunks', 'context_builds',
          'context_build_sources', 'context_build_entries', 'context_uses'
        )
        AND sql IS NOT NULL
    `).all() as Array<{ sql: string }>).map(({ sql }) => sql.toLowerCase()).join('\n')
    expect(schemaSql).not.toContain('os_events')
    expect(schemaSql).not.toContain('approval')
    db.close()
  })
})

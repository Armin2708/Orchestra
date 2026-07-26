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
  contentSha256?: string
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
    provenanceJson: overrides.provenanceJson ?? '{}',
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
  } = {},
): void {
  const value = overrides.content ?? content
  db.prepare(`
    INSERT INTO knowledge_chunks (
      board_id, id, source_id, ordinal, content, content_sha256,
      character_count, byte_count, estimated_tokens, source_range_json,
      symbol_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?)
  `).run(
    boardId,
    overrides.id ?? chunkId,
    overrides.sourceId ?? sourceId,
    overrides.ordinal ?? 0,
    value,
    overrides.contentSha256 ?? contentHash,
    overrides.characterCount ?? value.length,
    overrides.byteCount ?? Buffer.byteLength(value, 'utf8'),
    sourceRangeJson,
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
      sections: {},
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
    sourceRangeJson,
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

describe('knowledge persistence migration 018', () => {
  it('installs all six durable tables after migration 017', () => {
    const db = openDb(':memory:')
    expect(db.prepare(`
      SELECT id FROM os_schema_migrations ORDER BY rowid DESC LIMIT 1
    `).get()).toEqual({ id: MIGRATION_ID })
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
    ).get() as { count: number }).count).toBe(18)
    db.close()
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
    })).toThrow(/FOREIGN KEY/)

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

    insertBuild(db, boardId)
    expect(() => insertBuildSource(db, boardId, { sourceOrdinal: 1 }))
      .toThrow(/order or evidence/)
    insertBuildSource(db, boardId)

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

    insertContextUse(db, boardId, runtime)
    expect(db.prepare(`
      SELECT status FROM context_builds WHERE board_id=? AND id=?
    `).get(boardId, buildId)).toEqual({ status: 'used' })
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
    db.close()
  })
})

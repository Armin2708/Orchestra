import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  installKnowledgeContextUseActualEvidenceSchema,
} from '../src/agent-os/knowledge-context-use-actual-migration.js'
import {
  MAX_CONTEXT_BUDGET_TOKENS,
  contextBuildId,
  contextManifestFingerprint,
  contextRequestFingerprint,
  contextUseId,
  knowledgeChunkId,
  knowledgeSourceId,
  knowledgeSourceSetFingerprint,
  normalizeKnowledgeSourceSet,
} from '../src/agent-os/knowledge-contracts.js'
import {
  KnowledgeStore,
  KnowledgeStoreError,
} from '../src/agent-os/knowledge-store.js'
import type {
  ContextBuild,
  ContextBuildEntry,
  ContextRequestIdentityInput,
  ContextUse,
  KnowledgeChunk,
  KnowledgeSource,
  KnowledgeSourceSetEntry,
  KnowledgeTargetLinks,
} from '../src/agent-os/knowledge-types.js'

const tempDirectories: string[] = []
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const AT = '2026-07-26T09:00:00.000Z'
const LATER = '2026-07-26T09:01:00.000Z'
const COMPLETE = '2026-07-26T09:02:00.000Z'
const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

function targetLinks(
  boardId: number,
  overrides: Partial<KnowledgeTargetLinks> = {},
): KnowledgeTargetLinks {
  return {
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
  }
}

function sourceFixture(
  boardId: number,
  overrides: Partial<Omit<KnowledgeSource, 'id'>> = {},
): KnowledgeSource {
  const source: Omit<KnowledgeSource, 'id'> = {
    source_kind: 'documentation',
    trust_class: 'reference',
    title: 'Durable guide',
    locator: 'docs/durable-guide.md',
    normalized_locator: 'docs/durable-guide.md',
    source_revision: 'commit:durable',
    content_sha256: sha256('complete source'),
    freshness_policy: 'commit_exact',
    freshness_state: 'fresh',
    redaction_state: 'none',
    content_state: 'present',
    ingest_state: 'active',
    access_scope: { kind: 'board' },
    targets: targetLinks(boardId),
    provenance: {
      repository_key: 'agentboard',
      base_commit_sha: 'a'.repeat(40),
      worktree_state_hash: null,
      relative_root: '.',
      adapter_id: 'manual',
      adapter_version: '1.0.0',
      adapter_index_commit_sha: null,
      observed_at: AT,
    },
    created_at: AT,
    updated_at: AT,
    ...overrides,
  }
  return {
    ...source,
    id: knowledgeSourceId({
      repository_key: source.provenance.repository_key,
      source_kind: source.source_kind,
      normalized_locator: source.normalized_locator,
      source_revision: source.source_revision,
      content_sha256: source.content_sha256,
    }),
  }
}

function chunkFixture(
  source: KnowledgeSource,
  overrides: Partial<Omit<KnowledgeChunk, 'id'>> = {},
): KnowledgeChunk {
  const content = overrides.content ?? 'A😀e\u0301'
  const contentHash = overrides.content_sha256 ?? sha256(content)
  const range = overrides.source_range ?? {
    start_line: 1,
    end_line: 1,
    start_byte: 0,
    end_byte: Buffer.byteLength(content, 'utf8'),
  }
  const chunk: Omit<KnowledgeChunk, 'id'> = {
    source_id: source.id,
    ordinal: 0,
    content,
    content_sha256: contentHash,
    character_count: content.length,
    byte_count: Buffer.byteLength(content, 'utf8'),
    estimated_tokens: 3,
    source_range: range,
    symbol: null,
    created_at: AT,
    ...overrides,
  }
  return {
    ...chunk,
    id: knowledgeChunkId({
      source_id: chunk.source_id,
      ordinal: chunk.ordinal,
      content_sha256: chunk.content_sha256,
      source_range: chunk.source_range,
    }),
  }
}

function sourceSetFixture(source: KnowledgeSource): KnowledgeSourceSetEntry[] {
  return [{
    source_id: source.id,
    source_revision: source.source_revision,
    content_sha256: source.content_sha256,
    freshness_state: source.freshness_state,
    redaction_state: source.redaction_state,
  }]
}

function entryFixture(
  source: KnowledgeSource,
  chunk: KnowledgeChunk,
): ContextBuildEntry {
  return {
    source_id: source.id,
    chunk_id: chunk.id,
    section: 'relevant_code',
    candidate_ordinal: 0,
    selected_ordinal: 0,
    decision: 'selected',
    reason: 'within_budget',
    score_components: {
      authority_micros: 10,
      relevance_micros: 20,
      freshness_micros: 30,
      recency_micros: 40,
      contract_micros: 50,
      pin_micros: 0,
    },
    score_micros: 150,
    rendering: 'full',
    estimated_tokens: chunk.estimated_tokens,
    character_count: chunk.character_count,
    source_kind: source.source_kind,
    trust_class: source.trust_class,
    freshness_state: source.freshness_state,
    redaction_state: source.redaction_state,
    normalized_locator: source.normalized_locator,
    source_range: chunk.source_range,
    content_sha256: chunk.content_sha256,
  }
}

function buildFixture(
  boardId: number,
  source: KnowledgeSource,
  chunk: KnowledgeChunk,
  targets = targetLinks(boardId),
): { build: ContextBuild; request: ContextRequestIdentityInput; source_set: KnowledgeSourceSetEntry[] } {
  const request: ContextRequestIdentityInput = {
    board_id: boardId,
    access_scope: { kind: 'board' },
    targets,
    budget: {
      max_tokens: 100,
      max_characters: 1_000,
      sections: {
        relevant_code: { max_tokens: 100, max_characters: 1_000 },
      },
    },
    selection_request_sha256: sha256('selection'),
  }
  const sourceSet = sourceSetFixture(source)
  const entries = [entryFixture(source, chunk)]
  const manifestFingerprint = contextManifestFingerprint(entries)
  const sourceSetFingerprint = knowledgeSourceSetFingerprint(sourceSet)
  const build: ContextBuild = {
    id: contextBuildId({
      request,
      source_set_fingerprint: sourceSetFingerprint,
      manifest_fingerprint: manifestFingerprint,
    }),
    board_id: boardId,
    access_scope: request.access_scope,
    targets: request.targets,
    request_fingerprint: contextRequestFingerprint(request),
    source_set_fingerprint: sourceSetFingerprint,
    manifest_fingerprint: manifestFingerprint,
    budget: request.budget,
    usage: {
      used_tokens: chunk.estimated_tokens,
      used_characters: chunk.character_count,
      sections: {
        relevant_code: {
          used_tokens: chunk.estimated_tokens,
          used_characters: chunk.character_count,
        },
      },
    },
    entries,
    status: 'built',
    created_at: AT,
    invalidated_at: null,
  }
  return { build, request, source_set: sourceSet }
}

function addBoard(db: ReturnType<typeof openDb>, id: number): void {
  db.prepare('INSERT INTO boards (id, project_path, name) VALUES (?, ?, ?)')
    .run(id, `/knowledge-${id}`, `knowledge ${id}`)
}

function addRuntime(
  db: ReturnType<typeof openDb>,
  boardId: number,
  suffix: string,
): { workspaceId: string; jobId: string; sessionId: string } {
  const workspaceId = `knowledge-workspace-${suffix}`
  const jobId = `knowledge-job-${suffix}`
  const sessionId = `knowledge-session-${suffix}`
  db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, ?, 'shared', ?, 'active')`)
    .run(workspaceId, boardId, workspaceId, `/knowledge-${suffix}`)
  db.prepare(`INSERT INTO jobs
    (id, board_id, workspace_id, provider, status)
    VALUES (?, ?, ?, 'codex', 'queued')`)
    .run(jobId, boardId, workspaceId)
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, status, job_id)
    VALUES (?, ?, 'codex', 'running', ?)`)
    .run(sessionId, workspaceId, jobId)
  return { workspaceId, jobId, sessionId }
}

function useFixture(
  build: ContextBuild,
  runtime: ReturnType<typeof addRuntime>,
  overrides: Partial<Omit<ContextUse, 'id'>> = {},
): ContextUse {
  const use: Omit<ContextUse, 'id'> = {
    context_build_id: build.id,
    board_id: build.board_id,
    job_id: runtime.jobId,
    session_id: runtime.sessionId,
    injection_ordinal: 0,
    manifest_fingerprint: build.manifest_fingerprint,
    estimated_tokens: build.usage.used_tokens,
    actual_tokens: null,
    cache_identity: 'knowledge-cache-v1',
    outcome: 'running',
    injected_at: LATER,
    completed_at: null,
    ...overrides,
  }
  return {
    ...use,
    id: contextUseId({
      context_build_id: use.context_build_id,
      job_id: use.job_id,
      session_id: use.session_id,
      injection_ordinal: use.injection_ordinal,
    }),
  }
}

function caughtStoreError(action: () => unknown): KnowledgeStoreError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeStoreError)
    return error as KnowledgeStoreError
  }
  throw new Error('expected KnowledgeStoreError')
}

describe('KnowledgeStore', () => {
  it('persists exact evidence across restart and advances use/build lifecycle idempotently', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-knowledge-'))
    tempDirectories.push(directory)
    const file = path.join(directory, 'knowledge.db')
    const first = openDb(file)
    addBoard(first, 1)
    const runtime = addRuntime(first, 1, 'restart')
    const store = new KnowledgeStore(first)
    const source = sourceFixture(1)
    const chunk = chunkFixture(source)
    const buildInput = buildFixture(1, source, chunk, targetLinks(1, {
      workspace_id: runtime.workspaceId,
      job_id: runtime.jobId,
      session_id: runtime.sessionId,
    }))
    const use = useFixture(buildInput.build, runtime)

    expect(store.putSource(source)).toEqual(source)
    expect(store.putSource(source)).toEqual(source)
    expect(store.putChunk(1, chunk)).toEqual(chunk)
    expect(chunk).toMatchObject({ character_count: 5, byte_count: 8 })
    expect(store.putChunk(1, chunk)).toEqual(chunk)
    expect(store.putContextBuild(buildInput)).toMatchObject({ status: 'built' })
    expect(store.putContextUse(use)).toEqual(use)
    expect(store.getContextBuild(1, buildInput.build.id)).toMatchObject({ status: 'used' })
    expect(store.putContextBuild(buildInput)).toMatchObject({ status: 'used' })
    first.close()

    const second = openDb(file)
    const resumed = new KnowledgeStore(second)
    expect(resumed.getSource(1, source.id)).toEqual(source)
    expect(resumed.getChunk(1, chunk.id)).toEqual(chunk)
    expect(resumed.listChunks(1, source.id)).toEqual([chunk])
    expect(resumed.getContextBuild(1, buildInput.build.id)).toMatchObject({
      id: buildInput.build.id,
      request: buildInput.request,
      source_set: buildInput.source_set,
      status: 'used',
    })
    expect(resumed.getContextUse(1, use.id)).toEqual(use)
    const completed = resumed.finishContextUse({
      board_id: 1,
      context_use_id: use.id,
      outcome: 'completed',
      actual_tokens: 2,
      completed_at: COMPLETE,
    })
    expect(completed).toMatchObject({
      outcome: 'completed',
      actual_tokens: 2,
      completed_at: COMPLETE,
    })
    expect(resumed.finishContextUse({
      board_id: 1,
      context_use_id: use.id,
      outcome: 'completed',
      actual_tokens: 2,
      completed_at: COMPLETE,
    })).toEqual(completed)
    expect(resumed.putContextUse(use)).toEqual(completed)
    expect(resumed.listContextUses(1, buildInput.build.id)).toEqual([completed])
    second.close()
  })

  it('isolates board-neutral source and chunk identities across boards', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    addBoard(db, 2)
    const store = new KnowledgeStore(db)
    const firstSource = sourceFixture(1)
    const secondSource = sourceFixture(2)
    expect(secondSource.id).toBe(firstSource.id)
    store.putSource(firstSource)
    const firstChunk = chunkFixture(firstSource)
    store.putChunk(1, firstChunk)

    expect(store.getSource(2, firstSource.id)).toBeNull()
    expect(store.getChunk(2, firstChunk.id)).toBeNull()
    expect(() => store.putChunk(2, firstChunk)).toThrow(KnowledgeStoreError)

    store.putSource(secondSource)
    const secondChunk = chunkFixture(secondSource)
    expect(secondChunk.id).toBe(firstChunk.id)
    store.putChunk(2, secondChunk)
    expect(store.getSource(1, firstSource.id)?.targets.board_id).toBe(1)
    expect(store.getSource(2, secondSource.id)?.targets.board_id).toBe(2)
    expect(store.listChunks(1, firstSource.id)).toEqual([firstChunk])
    expect(store.listChunks(2, secondSource.id)).toEqual([secondChunk])
    db.close()
  })

  it('rejects divergent replays, bad hashes and wrong Unicode counts without reflecting input', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    const store = new KnowledgeStore(db)
    const source = sourceFixture(1)
    store.putSource(source)
    const sentinel = 'credential-sentinel-7hK29'
    expect(() => store.putSource({ ...source, title: sentinel })).toThrow(
      /replay conflicts with retained evidence/,
    )
    const chunk = chunkFixture(source)
    store.putChunk(1, chunk)
    expect(() => store.putChunk(1, {
      ...chunk,
      estimated_tokens: chunk.estimated_tokens + 1,
    })).toThrow(/replay conflicts with retained evidence/)
    for (const invalid of [
      { ...chunk, content_sha256: sentinel.padEnd(64, 'x') },
      { ...chunk, content_sha256: chunk.content_sha256.toUpperCase() },
      { ...chunk, character_count: 4 },
    ]) {
      try {
        store.putChunk(1, invalid)
        throw new Error('expected invalid chunk')
      } catch (error) {
        expect(String(error)).not.toContain(sentinel)
        expect(error).toBeInstanceOf(KnowledgeStoreError)
      }
    }
    const auditText = (db.prepare('SELECT payload FROM os_events').all() as Array<{
      payload: string
    }>).map((row) => row.payload).join('\n')
    expect(auditText).not.toContain(sentinel)
    db.close()
  })

  it('rolls back aggregate builds and rejects narrow-source or use scope mismatches', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    const firstRuntime = addRuntime(db, 1, 'first')
    const secondRuntime = addRuntime(db, 1, 'second')
    const store = new KnowledgeStore(db)
    const scopedSource = sourceFixture(1, {
      access_scope: { kind: 'workspace', workspace_id: firstRuntime.workspaceId },
      targets: targetLinks(1, { workspace_id: firstRuntime.workspaceId }),
    })
    const chunk = chunkFixture(scopedSource)
    store.putSource(scopedSource)
    store.putChunk(1, chunk)
    const wrongBuild = buildFixture(1, scopedSource, chunk, targetLinks(1, {
      workspace_id: secondRuntime.workspaceId,
      job_id: secondRuntime.jobId,
      session_id: secondRuntime.sessionId,
    }))
    expect(() => store.putContextBuild(wrongBuild)).toThrow(/scope is invalid/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM context_builds').get())
      .toEqual({ count: 0 })

    const validBuild = buildFixture(1, scopedSource, chunk, targetLinks(1, {
      workspace_id: firstRuntime.workspaceId,
      job_id: firstRuntime.jobId,
      session_id: firstRuntime.sessionId,
    }))
    store.putContextBuild(validBuild)
    const wrongUse = useFixture(validBuild.build, secondRuntime)
    expect(() => store.putContextUse(wrongUse)).toThrow(/scope is invalid/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM context_uses').get())
      .toEqual({ count: 0 })
    expect(store.getContextBuild(1, validBuild.build.id)).toMatchObject({ status: 'built' })
    db.close()
  })

  it('closes contract targets against the job version on create and retained reads', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    const cardId = Number(db.prepare(
      "INSERT INTO cards (board_id, title) VALUES (1, 'Version closure')",
    ).run().lastInsertRowid)
    db.prepare(`INSERT INTO task_contracts
      (card_id, objective, version) VALUES (?, 'Close contract versions', 2)`).run(cardId)
    const runtime = addRuntime(db, 1, 'contract-version')
    db.prepare('UPDATE workspaces SET card_id=? WHERE id=?')
      .run(cardId, runtime.workspaceId)
    db.prepare(`UPDATE jobs SET card_id=?, contract_version=1 WHERE id=?`)
      .run(cardId, runtime.jobId)
    const links = targetLinks(1, {
      workspace_id: runtime.workspaceId,
      card_id: cardId,
      contract_ref: `card:${cardId}:v2`,
      contract_version: 2,
      contract_snapshot_sha256: sha256('contract v2 snapshot'),
      job_id: runtime.jobId,
      session_id: runtime.sessionId,
    })
    const source = sourceFixture(1, { targets: links })
    const chunk = chunkFixture(source)
    const build = buildFixture(1, source, chunk, links)
    const store = new KnowledgeStore(db)

    expect(caughtStoreError(() => store.putSource(source)).code)
      .toBe('knowledge_scope_invalid')
    const sessionOnlyLinks = {
      ...links,
      workspace_id: null,
      job_id: null,
    }
    const sessionOnlySource = sourceFixture(1, {
      locator: 'docs/session-contract-version.md',
      normalized_locator: 'docs/session-contract-version.md',
      source_revision: 'commit:session-contract-version',
      targets: sessionOnlyLinks,
    })
    expect(caughtStoreError(() => store.putSource(sessionOnlySource)).code)
      .toBe('knowledge_scope_invalid')
    db.prepare('UPDATE jobs SET contract_version=2 WHERE id=?').run(runtime.jobId)
    store.putSource(source)
    store.putChunk(1, chunk)
    store.putContextBuild(build)

    db.prepare('UPDATE jobs SET contract_version=1 WHERE id=?').run(runtime.jobId)
    expect(caughtStoreError(() => store.getSource(1, source.id)).code)
      .toBe('knowledge_storage_corrupt')
    expect(caughtStoreError(() => store.getContextBuild(1, build.build.id)).code)
      .toBe('knowledge_storage_corrupt')
    db.close()
  })

  it('closes delivery report contract snapshots before retaining evidence', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    const cardId = Number(db.prepare(
      "INSERT INTO cards (board_id, title) VALUES (1, 'Delivery closure')",
    ).run().lastInsertRowid)
    db.prepare(`INSERT INTO task_contracts
      (card_id, objective, version) VALUES (?, 'Close asked version', 1)`).run(cardId)
    const reportId = 'knowledge-report-version-mismatch'
    db.prepare(`INSERT INTO delivery_reports (
      id, lineage_id, sequence, board_id, card_id, status, asked_snapshot,
      created_by, created_at, updated_at
    ) VALUES (?, ?, 1, 1, ?, 'draft', '{"contract_version":2}',
      'knowledge-test', ?, ?)`).run(reportId, reportId, cardId, AT, AT)
    const links = targetLinks(1, {
      card_id: cardId,
      contract_ref: `card:${cardId}:v1`,
      contract_version: 1,
      contract_snapshot_sha256: sha256('delivery contract v1'),
      delivery_report_id: reportId,
    })
    const source = sourceFixture(1, { targets: links })
    const store = new KnowledgeStore(db)
    expect(caughtStoreError(() => store.putSource(source)).code)
      .toBe('knowledge_scope_invalid')
    db.close()
  })

  it('fails closed when persisted build source ordinals are swapped', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    const store = new KnowledgeStore(db)
    const firstSource = sourceFixture(1)
    const secondSource = sourceFixture(1, {
      locator: 'docs/second-guide.md',
      normalized_locator: 'docs/second-guide.md',
      source_revision: 'commit:second',
      content_sha256: sha256('second source'),
    })
    const firstChunk = chunkFixture(firstSource)
    const secondChunk = chunkFixture(secondSource, { content: 'Second chunk' })
    for (const [source, chunk] of [
      [firstSource, firstChunk],
      [secondSource, secondChunk],
    ] as const) {
      store.putSource(source)
      store.putChunk(1, chunk)
    }
    const request: ContextRequestIdentityInput = {
      board_id: 1,
      access_scope: { kind: 'board' },
      targets: targetLinks(1),
      budget: {
        max_tokens: 100,
        max_characters: 1_000,
        sections: {
          relevant_code: { max_tokens: 100, max_characters: 1_000 },
        },
      },
      selection_request_sha256: sha256('two source selection'),
    }
    const sourceSet = normalizeKnowledgeSourceSet([
      ...sourceSetFixture(firstSource),
      ...sourceSetFixture(secondSource),
    ])
    const entries = [
      entryFixture(firstSource, firstChunk),
      {
        ...entryFixture(secondSource, secondChunk),
        candidate_ordinal: 1,
        selected_ordinal: 1,
      },
    ]
    const sourceSetFingerprint = knowledgeSourceSetFingerprint(sourceSet)
    const manifestFingerprint = contextManifestFingerprint(entries)
    const build: ContextBuild = {
      id: contextBuildId({
        request,
        source_set_fingerprint: sourceSetFingerprint,
        manifest_fingerprint: manifestFingerprint,
      }),
      board_id: 1,
      access_scope: request.access_scope,
      targets: request.targets,
      request_fingerprint: contextRequestFingerprint(request),
      source_set_fingerprint: sourceSetFingerprint,
      manifest_fingerprint: manifestFingerprint,
      budget: request.budget,
      usage: {
        used_tokens: firstChunk.estimated_tokens + secondChunk.estimated_tokens,
        used_characters: firstChunk.character_count + secondChunk.character_count,
        sections: {
          relevant_code: {
            used_tokens: firstChunk.estimated_tokens + secondChunk.estimated_tokens,
            used_characters: firstChunk.character_count + secondChunk.character_count,
          },
        },
      },
      entries,
      status: 'built',
      created_at: AT,
      invalidated_at: null,
    }
    store.putContextBuild({ build, request, source_set: sourceSet })

    db.exec('DROP TRIGGER context_build_sources_immutable')
    const swap = db.transaction(() => {
      db.prepare(`UPDATE context_build_sources SET source_ordinal=99
        WHERE board_id=1 AND context_build_id=? AND source_ordinal=0`).run(build.id)
      db.prepare(`UPDATE context_build_sources SET source_ordinal=0
        WHERE board_id=1 AND context_build_id=? AND source_ordinal=1`).run(build.id)
      db.prepare(`UPDATE context_build_sources SET source_ordinal=1
        WHERE board_id=1 AND context_build_id=? AND source_ordinal=99`).run(build.id)
    })
    swap()

    const corrupt = caughtStoreError(() => store.getContextBuild(1, build.id))
    expect(corrupt.code).toBe('knowledge_storage_corrupt')
    expect(corrupt.message).toBe('knowledge persistence evidence is corrupt')
    db.close()
  })

  it('fails closed on valid-but-noncanonical stored JSON', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    const source = sourceFixture(1)
    db.pragma('ignore_check_constraints = ON')
    db.prepare(`INSERT INTO knowledge_sources (
      board_id, id, source_kind, trust_class, title, locator, normalized_locator,
      source_revision, content_sha256, freshness_policy, freshness_state,
      redaction_state, content_state, ingest_state, access_scope_json,
      targets_json, provenance_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        1,
        source.id,
        source.source_kind,
        source.trust_class,
        source.title,
        source.locator,
        source.normalized_locator,
        source.source_revision,
        source.content_sha256,
        source.freshness_policy,
        source.freshness_state,
        source.redaction_state,
        source.content_state,
        source.ingest_state,
        '{ "kind": "board" }',
        JSON.stringify(source.targets),
        JSON.stringify(source.provenance),
        source.created_at,
        source.updated_at,
      )
    db.pragma('ignore_check_constraints = OFF')
    expect(() => new KnowledgeStore(db).getSource(1, source.id))
      .toThrow(/evidence is corrupt/)
    db.close()
  })

  it('redacts direct, nested, revoked, and poisoned Proxy failures at store boundaries', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    const store = new KnowledgeStore(db)
    const sentinel = 'credential-sentinel-proxy-93x'
    const assertFixedInputError = (action: () => unknown): void => {
      const error = caughtStoreError(action)
      expect(error.code).toBe('knowledge_input_invalid')
      expect(error.message).toBe('knowledge persistence input is invalid')
      expect(String(error)).not.toContain(sentinel)
    }

    const direct = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error(sentinel)
      },
    })
    assertFixedInputError(() => store.finishContextUse(direct as never))

    const source = sourceFixture(1)
    const nested = {
      ...source,
      targets: new Proxy(source.targets, {
        ownKeys() {
          throw new Error(sentinel)
        },
      }),
    }
    assertFixedInputError(() => store.putSource(nested))

    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    assertFixedInputError(() => store.finishContextUse(revoked.proxy as never))

    const poisoned = new KnowledgeStoreError('knowledge_scope_invalid')
    poisoned.message = sentinel
    const poisonedProxy = new Proxy(poisoned, {
      get() {
        throw new Error(sentinel)
      },
    })
    const wrappingProxy = new Proxy({}, {
      ownKeys() {
        throw poisonedProxy
      },
    })
    assertFixedInputError(() => store.finishContextUse(wrappingProxy as never))
    db.close()
  })

  it('fails closed with fixed errors for raw BLOB rows and reads after database closure', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    const store = new KnowledgeStore(db)
    const source = sourceFixture(1)
    store.putSource(source)
    const sentinel = 'credential-sentinel-blob-21q'

    db.exec('DROP TRIGGER knowledge_sources_immutable')
    db.prepare('UPDATE knowledge_sources SET title=? WHERE board_id=? AND id=?')
      .run(Buffer.from(sentinel, 'utf8'), 1, source.id)
    const corrupt = caughtStoreError(() => store.getSource(1, source.id))
    expect(corrupt.code).toBe('knowledge_storage_corrupt')
    expect(corrupt.message).toBe('knowledge persistence evidence is corrupt')
    expect(String(corrupt)).not.toContain(sentinel)

    db.close()
    const closed = caughtStoreError(() => store.getSource(1, source.id))
    expect(closed.code).toBe('knowledge_storage_corrupt')
    expect(closed.message).toBe('knowledge persistence evidence is corrupt')
  })

  it('rejects chunks for non-materialized sources and duplicate source ordinals', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    const store = new KnowledgeStore(db)
    const present = sourceFixture(1)
    store.putSource(present)
    const first = chunkFixture(present)
    store.putChunk(1, first)
    const duplicateOrdinal = chunkFixture(present, {
      content: 'different durable content',
      content_sha256: sha256('different durable content'),
      character_count: 'different durable content'.length,
      byte_count: Buffer.byteLength('different durable content', 'utf8'),
    })
    expect(duplicateOrdinal.id).not.toBe(first.id)
    expect(caughtStoreError(() => store.putChunk(1, duplicateOrdinal)).code)
      .toBe('knowledge_replay_conflict')

    const withheld = sourceFixture(1, {
      locator: 'docs/withheld.md',
      normalized_locator: 'docs/withheld.md',
      source_revision: 'commit:withheld',
      redaction_state: 'withheld',
      content_state: 'withheld',
    })
    store.putSource(withheld)
    expect(caughtStoreError(() => store.putChunk(1, chunkFixture(withheld))).code)
      .toBe('knowledge_scope_invalid')

    const forgotten = sourceFixture(1, {
      locator: 'docs/forgotten.md',
      normalized_locator: 'docs/forgotten.md',
      source_revision: 'commit:forgotten',
      content_state: 'purged',
      ingest_state: 'forgotten',
    })
    store.putSource(forgotten)
    expect(caughtStoreError(() => store.putChunk(1, chunkFixture(forgotten))).code)
      .toBe('knowledge_scope_invalid')
    db.close()
  })

  it('stores wrapper overhead and empty failed builds without weakening evidence checks', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    const runtime = addRuntime(db, 1, 'wrapper-overhead')
    const store = new KnowledgeStore(db)
    const source = sourceFixture(1)
    const chunk = chunkFixture(source)
    store.putSource(source)
    store.putChunk(1, chunk)

    const overhead = buildFixture(1, source, chunk)
    overhead.build.usage = {
      ...overhead.build.usage,
      used_tokens: chunk.estimated_tokens + 2,
      used_characters: chunk.character_count + 2,
    }
    expect(store.putContextBuild(overhead).usage).toMatchObject({
      used_tokens: 5,
      used_characters: 7,
      sections: {
        relevant_code: {
          used_tokens: chunk.estimated_tokens,
          used_characters: chunk.character_count,
        },
      },
    })
    const overheadUse = useFixture(overhead.build, runtime)
    expect(store.putContextUse(overheadUse)).toEqual(overheadUse)
    expect(store.getContextBuild(1, overhead.build.id)).toMatchObject({
      status: 'used',
    })

    const failedRequest: ContextRequestIdentityInput = {
      ...overhead.request,
      selection_request_sha256: sha256('failed selection'),
    }
    const emptySourceSet: KnowledgeSourceSetEntry[] = []
    const emptySourceFingerprint = knowledgeSourceSetFingerprint(emptySourceSet)
    const emptyManifestFingerprint = contextManifestFingerprint([])
    const failedBuild: ContextBuild = {
      ...overhead.build,
      id: contextBuildId({
        request: failedRequest,
        source_set_fingerprint: emptySourceFingerprint,
        manifest_fingerprint: emptyManifestFingerprint,
      }),
      request_fingerprint: contextRequestFingerprint(failedRequest),
      source_set_fingerprint: emptySourceFingerprint,
      manifest_fingerprint: emptyManifestFingerprint,
      usage: { used_tokens: 0, used_characters: 0, sections: {} },
      entries: [],
      status: 'failed',
    }
    expect(store.putContextBuild({
      build: failedBuild,
      request: failedRequest,
      source_set: emptySourceSet,
    })).toMatchObject({
      id: failedBuild.id,
      status: 'failed',
      entries: [],
      source_set: [],
    })
    db.close()
  })

  it('accepts the terminal token ceiling and rejects values beyond it atomically', () => {
    const db = openDb(':memory:')
    installKnowledgeContextUseActualEvidenceSchema(db)
    addBoard(db, 1)
    const runtime = addRuntime(db, 1, 'token-ceiling')
    const store = new KnowledgeStore(db)
    const source = sourceFixture(1)
    const chunk = chunkFixture(source)
    const build = buildFixture(1, source, chunk)
    store.putSource(source)
    store.putChunk(1, chunk)
    store.putContextBuild(build)

    const acceptedUse = useFixture(build.build, runtime)
    store.putContextUse(acceptedUse)
    expect(store.finishContextUse({
      board_id: 1,
      context_use_id: acceptedUse.id,
      outcome: 'completed',
      actual_tokens: MAX_CONTEXT_BUDGET_TOKENS,
      completed_at: COMPLETE,
    })).toMatchObject({
      outcome: 'completed',
      actual_tokens: MAX_CONTEXT_BUDGET_TOKENS,
    })

    const rejectedUse = useFixture(build.build, runtime, { injection_ordinal: 1 })
    store.putContextUse(rejectedUse)
    expect(caughtStoreError(() => store.finishContextUse({
      board_id: 1,
      context_use_id: rejectedUse.id,
      outcome: 'completed',
      actual_tokens: MAX_CONTEXT_BUDGET_TOKENS + 1,
      completed_at: COMPLETE,
    })).code).toBe('knowledge_input_invalid')
    expect(store.getContextUse(1, rejectedUse.id)).toMatchObject({
      outcome: 'running',
      actual_tokens: null,
      completed_at: null,
    })

    const unmeasuredUse = useFixture(build.build, runtime, { injection_ordinal: 2 })
    store.putContextUse(unmeasuredUse)
    expect(store.finishContextUse({
      board_id: 1,
      context_use_id: unmeasuredUse.id,
      outcome: 'completed',
      actual_tokens: null,
      completed_at: COMPLETE,
    })).toMatchObject({
      outcome: 'completed',
      actual_tokens: null,
      completed_at: COMPLETE,
    })
    db.close()
  })

  it('retains historical contract/report targets but blocks new use after report deletion', () => {
    const db = openDb(':memory:')
    addBoard(db, 1)
    const cardId = Number(db.prepare(
      "INSERT INTO cards (board_id, title) VALUES (1, 'Knowledge target')",
    ).run().lastInsertRowid)
    db.prepare(`INSERT INTO task_contracts
      (card_id, objective, version) VALUES (?, 'Retain the target', 1)`).run(cardId)
    const runtime = addRuntime(db, 1, 'retained-target')
    db.prepare('UPDATE workspaces SET card_id=? WHERE id=?')
      .run(cardId, runtime.workspaceId)
    db.prepare(`UPDATE jobs SET card_id=?, contract_version=1 WHERE id=?`)
      .run(cardId, runtime.jobId)
    const reportId = 'knowledge-report-retained'
    db.prepare(`INSERT INTO delivery_reports (
      id, lineage_id, sequence, board_id, card_id, job_id, session_id, workspace_id,
      status, asked_snapshot, created_by, created_at, updated_at
    ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, 'draft', '{"contract_version":1}',
      'knowledge-test', ?, ?)`).run(
      reportId,
      reportId,
      cardId,
      runtime.jobId,
      runtime.sessionId,
      runtime.workspaceId,
      AT,
      AT,
    )
    const links = targetLinks(1, {
      workspace_id: runtime.workspaceId,
      card_id: cardId,
      contract_ref: `card:${cardId}:v1`,
      contract_version: 1,
      contract_snapshot_sha256: sha256('contract snapshot'),
      job_id: runtime.jobId,
      session_id: runtime.sessionId,
      delivery_report_id: reportId,
    })
    const source = sourceFixture(1, { targets: links })
    const chunk = chunkFixture(source)
    const build = buildFixture(1, source, chunk, links)
    const store = new KnowledgeStore(db)
    store.putSource(source)
    store.putChunk(1, chunk)
    store.putContextBuild(build)

    db.prepare('DELETE FROM delivery_reports WHERE id=?').run(reportId)
    expect(store.getSource(1, source.id)).toEqual(source)
    expect(store.getContextBuild(1, build.build.id)).toMatchObject({
      id: build.build.id,
      targets: links,
    })

    const laterSource = sourceFixture(1, {
      locator: 'docs/missing-report.md',
      normalized_locator: 'docs/missing-report.md',
      source_revision: 'commit:missing-report',
      targets: links,
    })
    expect(caughtStoreError(() => store.putSource(laterSource)).code)
      .toBe('knowledge_scope_invalid')
    expect(caughtStoreError(() => store.putContextUse(
      useFixture(build.build, runtime),
    )).code).toBe('knowledge_scope_invalid')

    db.prepare('UPDATE task_contracts SET version=2 WHERE card_id=?').run(cardId)
    expect(store.getSource(1, source.id)).toEqual(source)
    expect(store.getContextBuild(1, build.build.id)).toMatchObject({
      id: build.build.id,
      targets: links,
    })

    const poisonCardId = Number(db.prepare(
      "INSERT INTO cards (board_id, title) VALUES (1, 'Poison target')",
    ).run().lastInsertRowid)
    db.prepare(`INSERT INTO delivery_reports (
      id, lineage_id, sequence, board_id, card_id, status, asked_snapshot,
      created_by, created_at, updated_at
    ) VALUES (?, ?, 1, 1, ?, 'draft', '{}', 'knowledge-test', ?, ?)`).run(
      reportId,
      reportId,
      poisonCardId,
      AT,
      AT,
    )
    expect(caughtStoreError(() => store.getSource(1, source.id)).code)
      .toBe('knowledge_storage_corrupt')
    expect(caughtStoreError(() => store.getContextBuild(1, build.build.id)).code)
      .toBe('knowledge_storage_corrupt')
    db.close()
  })

  it('makes one context slot idempotent across connections and rejects a competing build', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-knowledge-race-'))
    tempDirectories.push(directory)
    const file = path.join(directory, 'knowledge.db')
    const firstDb = openDb(file)
    addBoard(firstDb, 1)
    const runtime = addRuntime(firstDb, 1, 'race')
    const firstStore = new KnowledgeStore(firstDb)
    const source = sourceFixture(1)
    const chunk = chunkFixture(source)
    const firstBuild = buildFixture(1, source, chunk)
    firstStore.putSource(source)
    firstStore.putChunk(1, chunk)
    firstStore.putContextBuild(firstBuild)
    const firstUse = useFixture(firstBuild.build, runtime)
    expect(firstStore.putContextUse(firstUse)).toEqual(firstUse)

    const secondDb = openDb(file)
    const secondStore = new KnowledgeStore(secondDb)
    expect(secondStore.putContextUse(firstUse)).toEqual(firstUse)
    const competingRequest: ContextRequestIdentityInput = {
      ...firstBuild.request,
      selection_request_sha256: sha256('competing selection'),
    }
    const competingBuild: ContextBuild = {
      ...firstBuild.build,
      id: contextBuildId({
        request: competingRequest,
        source_set_fingerprint: firstBuild.build.source_set_fingerprint,
        manifest_fingerprint: firstBuild.build.manifest_fingerprint,
      }),
      request_fingerprint: contextRequestFingerprint(competingRequest),
      status: 'built',
    }
    secondStore.putContextBuild({
      build: competingBuild,
      request: competingRequest,
      source_set: firstBuild.source_set,
    })
    const competingUse = useFixture(competingBuild, runtime)
    expect(competingUse.id).not.toBe(firstUse.id)
    expect(caughtStoreError(() => secondStore.putContextUse(competingUse)).code)
      .toBe('knowledge_replay_conflict')
    secondDb.close()
    firstDb.close()
  })
})

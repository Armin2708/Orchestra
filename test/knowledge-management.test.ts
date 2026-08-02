import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  canonicalKnowledgeJson,
  contextBuildId,
  contextManifestFingerprint,
  contextRequestFingerprint,
  knowledgeChunkId,
  knowledgeSourceId,
  knowledgeSourceSetFingerprint,
} from '../src/agent-os/knowledge-contracts.js'
import { KnowledgeManagementService } from '../src/agent-os/knowledge-management.js'
import { KnowledgeService } from '../src/agent-os/knowledge-service.js'
import { KnowledgeStore } from '../src/agent-os/knowledge-store.js'
import type {
  ContextBuild,
  ContextBuildEntry,
  ContextRequestIdentityInput,
  KnowledgeChunk,
  KnowledgeSource,
} from '../src/agent-os/knowledge-types.js'

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const AT = '2026-08-02T08:00:00.000Z'
const LATER = '2026-08-02T08:05:00.000Z'

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-kno-management-'))
  temporary.push(root)
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'knowledge@example.invalid'])
  git(root, ['config', 'user.name', 'Knowledge Test'])
  return root
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

function commitFile(root: string, relative: string, content: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
  fs.writeFileSync(path.join(root, relative), content)
  git(root, ['add', '--', relative])
  git(root, ['commit', '-q', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

function addBoard(root: string, id = 1) {
  const dbPath = path.join(root, `knowledge-${id}.sqlite`)
  const db = openDb(dbPath)
  db.prepare('INSERT INTO boards (id, project_path, name) VALUES (?, ?, ?)')
    .run(id, root, `Knowledge ${id}`)
  return db
}

function sourceFixture(boardId: number, head: string, content: string, locator = 'docs/guide.md'):
{ source: KnowledgeSource; chunk: KnowledgeChunk } {
  const contentHash = sha(content)
  const sourceWithoutId: Omit<KnowledgeSource, 'id'> = {
    source_kind: 'documentation', trust_class: 'reference', title: 'Repository guide',
    locator, normalized_locator: locator, source_revision: head, content_sha256: contentHash,
    freshness_policy: 'commit_exact', freshness_state: 'fresh', redaction_state: 'none',
    content_state: 'present', ingest_state: 'active', access_scope: { kind: 'board' },
    targets: { board_id: boardId, workspace_id: null, card_id: null, contract_ref: null,
      contract_version: null, contract_snapshot_sha256: null, job_id: null, profile_id: null,
      session_id: null, delivery_report_id: null },
    provenance: { repository_key: 'orchestra', base_commit_sha: head, worktree_state_hash: null,
      relative_root: '.', adapter_id: 'test', adapter_version: '1', adapter_index_commit_sha: null,
      observed_at: AT },
    created_at: AT, updated_at: AT,
  }
  const source: KnowledgeSource = {
    ...sourceWithoutId,
    id: knowledgeSourceId({ repository_key: 'orchestra', source_kind: 'documentation',
      normalized_locator: locator, source_revision: head, content_sha256: contentHash }),
  }
  const range = { start_line: 1, end_line: 1, start_byte: 0, end_byte: Buffer.byteLength(content) }
  const chunkWithoutId: Omit<KnowledgeChunk, 'id'> = {
    source_id: source.id, ordinal: 0, content, content_sha256: contentHash,
    character_count: content.length, byte_count: Buffer.byteLength(content), estimated_tokens: 8,
    source_range: range, symbol: null, created_at: AT,
  }
  const chunk: KnowledgeChunk = { ...chunkWithoutId, id: knowledgeChunkId({ source_id: source.id,
    ordinal: 0, content_sha256: contentHash, source_range: range }) }
  return { source, chunk }
}

function putBuild(store: KnowledgeStore, boardId: number, source: KnowledgeSource, chunk: KnowledgeChunk) {
  const entry: ContextBuildEntry = {
    source_id: source.id, chunk_id: chunk.id, section: 'relevant_code', candidate_ordinal: 0,
    selected_ordinal: 0, decision: 'selected', reason: 'within_budget',
    score_components: { authority_micros: 1, relevance_micros: 2, freshness_micros: 3,
      recency_micros: 4, contract_micros: 5, pin_micros: 0 }, score_micros: 15,
    rendering: 'full', estimated_tokens: chunk.estimated_tokens,
    character_count: chunk.character_count, source_kind: source.source_kind,
    trust_class: source.trust_class, freshness_state: source.freshness_state,
    redaction_state: source.redaction_state, normalized_locator: source.normalized_locator,
    source_range: chunk.source_range, content_sha256: chunk.content_sha256,
  }
  const request: ContextRequestIdentityInput = {
    board_id: boardId, access_scope: { kind: 'board' }, targets: source.targets,
    budget: { max_tokens: 100, max_characters: 1_000,
      sections: { relevant_code: { max_tokens: 100, max_characters: 1_000 } } },
    selection_request_sha256: sha('selection'),
  }
  const sourceSet = [{ source_id: source.id, source_revision: source.source_revision,
    content_sha256: source.content_sha256, freshness_state: source.freshness_state,
    redaction_state: source.redaction_state }]
  const manifest = contextManifestFingerprint([entry])
  const sourceFingerprint = knowledgeSourceSetFingerprint(sourceSet)
  const build: ContextBuild = {
    id: contextBuildId({ request, source_set_fingerprint: sourceFingerprint,
      manifest_fingerprint: manifest }), board_id: boardId, access_scope: request.access_scope,
    targets: request.targets, request_fingerprint: contextRequestFingerprint(request),
    source_set_fingerprint: sourceFingerprint, manifest_fingerprint: manifest,
    budget: request.budget, usage: { used_tokens: 8, used_characters: chunk.character_count,
      sections: { relevant_code: { used_tokens: 8, used_characters: chunk.character_count } } },
    entries: [entry], status: 'built', created_at: AT, invalidated_at: null,
  }
  return store.putContextBuild({ build, request, source_set: sourceSet })
}

describe('Knowledge management freshness and human controls', () => {
  it('invalidates compiled context, opens review, and exposes why/token/citation evidence', () => {
    const root = repository()
    const initial = 'Use the canonical service boundary.'
    const head = commitFile(root, 'docs/guide.md', initial, 'initial guide')
    const db = addBoard(root)
    const store = new KnowledgeStore(db)
    const { source, chunk } = sourceFixture(1, head, initial)
    store.putSource(source); store.putChunk(1, chunk)
    new KnowledgeService(db).synchronizeRetrievalIndex({ board_id: 1, indexed_at: AT })
    const build = putBuild(store, 1, source, chunk)
    commitFile(root, 'docs/guide.md', 'Use the reviewed service boundary.', 'change guide')

    const service = new KnowledgeManagementService(db)
    const refreshed = service.refreshRepository(1, LATER)
    expect(refreshed.review_requests).toBe(1)
    expect(store.getContextBuild(1, build.id)?.status).toBe('invalidated')
    expect(service.listReviews(1)[0]).toMatchObject({ kind: 'stale', status: 'pending' })
    expect(service.browse({ board_id: 1 })).toEqual([])
    expect(service.browse({ board_id: 1, include_stale: true })[0]?.citation)
      .toMatchObject({ freshness: 'stale', source_id: source.id, chunk_id: chunk.id })
    expect(service.browse({ board_id: 1, include_stale: true, query: 'canonical service' }))
      .toHaveLength(1)

    const manifest = service.contextManifest(build.id, 1)
    expect(manifest[0]).toMatchObject({ selected: true, estimated_tokens: 8,
      token_contribution_percent: 100 })
    expect(manifest[0]?.why_included).toContain('within_budget')

    service.applyControl({ board_id: 1, source_id: source.id, action: 'accept',
      reason: 'Human reviewed the stale citation and accepts the retained historical fact.',
      actor: { type: 'operator', id: 'human' }, idempotency_key: 'accept-source', created_at: LATER })
    expect(service.browse({ board_id: 1 })[0]).toMatchObject({
      disposition: 'accept', citation: { freshness: 'stale' },
    })
    service.applyControl({ board_id: 1, source_id: source.id, action: 'pin', pinned: true,
      reason: 'Keep visible while reviewing the changed source.', actor: { type: 'operator', id: 'human' },
      idempotency_key: 'pin-source', created_at: LATER })
    service.applyControl({ board_id: 1, source_id: source.id, action: 'reject',
      reason: 'The committed guide has changed.', actor: { type: 'operator', id: 'human' },
      idempotency_key: 'reject-source', created_at: LATER })
    expect(service.listReviews(1)[0]).toMatchObject({ status: 'resolved' })
    expect(service.browse({ board_id: 1, include_stale: true })).toEqual([])
    expect(service.browse({ board_id: 1, include_stale: true, include_rejected: true })[0]
      ?.citation.pinned).toBe(true)
    db.close()
  })

  it('enforces idempotent actions and same-board exact replacement sources', () => {
    const root = repository()
    const head = commitFile(root, 'docs/guide.md', 'one', 'one')
    const db = addBoard(root)
    const store = new KnowledgeStore(db)
    const first = sourceFixture(1, head, 'one')
    const second = sourceFixture(1, head, 'two', 'docs/replacement.md')
    store.putSource(first.source); store.putChunk(1, first.chunk)
    store.putSource(second.source); store.putChunk(1, second.chunk)
    const service = new KnowledgeManagementService(db)
    const request = { board_id: 1, source_id: first.source.id, action: 'edit' as const,
      replacement_source_id: second.source.id, reason: 'Replace with reviewed exact source.',
      actor: { type: 'operator' as const, id: 'human' }, idempotency_key: 'edit-source', created_at: AT }
    const one = service.applyControl(request)
    expect(service.applyControl(request)).toEqual(one)
    expect(() => db.prepare(`UPDATE knowledge_control_actions SET reason='rewritten' WHERE id=?`)
      .run(one.id)).toThrow(/immutable/u)
    expect(() => service.applyControl({ ...request, reason: 'Different replay.' }))
      .toThrow(/idempotency conflict/u)
    expect(() => service.applyControl({ ...request, idempotency_key: 'missing',
      replacement_source_id: `ks_${'f'.repeat(64)}` })).toThrow(/not found/u)
    db.close()
  })
})

describe('reviewable exact-source promotion', () => {
  it('promotes only a committed canonical accepted-answer artifact after operator review', () => {
    const root = repository()
    const artifact = canonicalKnowledgeJson({ schema_version: 1, kind: 'discussion_answer',
      key: 'discussion:one:post:answer:v1', title: 'Use the focused service',
      content: 'Call the focused service and retain the exact citation.', accepted_at: AT,
      accepted_by: 'operator:human' })
    const head = commitFile(root, 'knowledge/accepted.json', artifact, 'accepted answer artifact')
    const db = addBoard(root)
    const service = new KnowledgeManagementService(db)
    const promotion = service.createPromotion({ board_id: 1, kind: 'accepted_answer',
      payload: { repository_key: 'orchestra', base_commit_sha: head, observed_at: AT,
        entries: [{ path: 'knowledge/accepted.json', start_line: 1, end_line: 1,
          expected_source_sha256: sha(artifact) }] }, requested_by: 'agent:answerer',
      idempotency_key: 'promote-answer', requested_at: AT })
    expect(promotion).toMatchObject({ status: 'pending', kind: 'accepted_answer' })
    expect(db.prepare('SELECT count(*) AS count FROM knowledge_sources').get()).toEqual({ count: 0 })
    expect(() => db.prepare(`UPDATE knowledge_promotion_requests SET status='promoted',
      reviewed_by='forged', review_reason='status only', reviewed_at=? WHERE id=?`)
      .run(LATER, promotion.id)).toThrow(/transition is invalid/u)

    const result = service.reviewPromotion({ board_id: 1, promotion_id: String(promotion.id),
      decision: 'promote', actor: { type: 'operator', id: 'human' },
      reason: 'Reviewed the exact committed post artifact.', reviewed_at: LATER })
    expect(result.status).toBe('promoted')
    expect(result.source_ids).toHaveLength(1)
    expect(db.prepare('SELECT source_kind FROM knowledge_sources').get())
      .toEqual({ source_kind: 'discussion_answer' })
    db.close()
  })

  it('rejects status-only/arbitrary text and stale or tampered exact-source evidence', () => {
    const root = repository()
    const artifact = canonicalKnowledgeJson({ schema_version: 1, kind: 'discussion_answer',
      key: 'discussion:two:post:answer:v1', title: 'Exact answer', content: 'Exact reviewed content.',
      accepted_at: AT, accepted_by: 'operator:human' })
    const head = commitFile(root, 'knowledge/answer.json', artifact, 'answer')
    const db = addBoard(root)
    const service = new KnowledgeManagementService(db)
    expect(() => service.createPromotion({ board_id: 1, kind: 'accepted_answer',
      payload: { repository_key: 'orchestra', base_commit_sha: head, observed_at: AT,
        status: 'accepted', content: 'arbitrary text' } as never,
      requested_by: 'agent', idempotency_key: 'status-only' })).toThrow(/promotion entries/u)

    const tampered = service.createPromotion({ board_id: 1, kind: 'accepted_answer',
      payload: { repository_key: 'orchestra', base_commit_sha: head, observed_at: AT,
        entries: [{ path: 'knowledge/answer.json', start_line: 1, end_line: 1,
          expected_source_sha256: 'f'.repeat(64) }] }, requested_by: 'agent',
      idempotency_key: 'tampered', requested_at: AT })
    expect(() => service.reviewPromotion({ board_id: 1, promotion_id: String(tampered.id),
      decision: 'promote', actor: { type: 'operator', id: 'human' }, reason: 'Review.',
      reviewed_at: LATER })).toThrow()
    expect(db.prepare('SELECT count(*) AS count FROM knowledge_sources').get()).toEqual({ count: 0 })
    expect(service.listPromotions(1).find((item) => item.id === tampered.id)?.status).toBe('pending')
    db.close()
  })
})

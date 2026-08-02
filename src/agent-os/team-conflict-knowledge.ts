import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  canonicalKnowledgeJson,
  knowledgeChunkId,
  knowledgeSourceId,
} from './knowledge-contracts.js'
import { resolveBoardKnowledgeRepository } from './knowledge-board-repository.js'
import { KnowledgeService } from './knowledge-service.js'
import type { KnowledgeChunk, KnowledgeSource } from './knowledge-types.js'
import { redactSensitiveText, redactStructuredValue } from './structured-redaction.js'
import type { ConflictKnowledgePromotionAdapter } from './team-planning.js'

export class CanonicalConflictKnowledgeAdapter implements ConflictKnowledgePromotionAdapter {
  private readonly knowledge: KnowledgeService

  constructor(private readonly db: Database.Database) {
    this.knowledge = new KnowledgeService(db)
  }

  promoteConflictResolution(input: {
    boardId: number
    cardId: number | null
    conflictId: string
    resolutionId: string
    title: string
    exactSource: Record<string, unknown>
    sourceSha256: string
    reviewedAt: string
  }): {
    sourceId: string
    chunkId: string
    repositoryHeadSha: string
    repositoryKey: string
    persistedContentSha256: string
    redactionState: 'none' | 'redacted'
  } {
    const rawContent = canonicalKnowledgeJson(input.exactSource)
    if (sha256(rawContent) !== input.sourceSha256) {
      throw new Error('conflict knowledge exact source changed before promotion')
    }
    const redactedSource = redactStructuredValue(input.exactSource)
    const content = canonicalKnowledgeJson(redactedSource.value)
    const persistedContentSha256 = sha256(content)
    const redactedTitle = redactSensitiveText(input.title)
    if (!redactedTitle.value) throw new Error('conflict knowledge title is invalid')
    const redactionState = redactedSource.changed || redactedTitle.changed
      ? 'redacted' as const : 'none' as const
    const repository = resolveBoardKnowledgeRepository(this.db, input.boardId)
    const normalizedLocator =
      `conflicts/${input.conflictId}/resolutions/${input.resolutionId}.json`
    const sourceWithoutId: Omit<KnowledgeSource, 'id'> = {
      source_kind: 'decision',
      trust_class: 'evidence',
      title: redactedTitle.value,
      locator: normalizedLocator,
      normalized_locator: normalizedLocator,
      source_revision: input.sourceSha256,
      content_sha256: persistedContentSha256,
      freshness_policy: 'manual_until_superseded',
      freshness_state: 'fresh',
      redaction_state: redactionState,
      content_state: 'present',
      ingest_state: 'active',
      access_scope: { kind: 'board' },
      targets: {
        board_id: input.boardId,
        workspace_id: null,
        card_id: input.cardId,
        contract_ref: null,
        contract_version: null,
        contract_snapshot_sha256: null,
        job_id: null,
        profile_id: null,
        session_id: null,
        delivery_report_id: null,
      },
      provenance: {
        repository_key: repository.repositoryKey,
        base_commit_sha: repository.head,
        worktree_state_hash: null,
        relative_root: '.',
        adapter_id: 'conflict-resolution-promotion',
        adapter_version: '1.0.0',
        adapter_index_commit_sha: null,
        observed_at: input.reviewedAt,
      },
      created_at: input.reviewedAt,
      updated_at: input.reviewedAt,
    }
    const source: KnowledgeSource = {
      ...sourceWithoutId,
      id: knowledgeSourceId({
        repository_key: sourceWithoutId.provenance.repository_key,
        source_kind: sourceWithoutId.source_kind,
        normalized_locator: normalizedLocator,
        source_revision: sourceWithoutId.source_revision,
        content_sha256: sourceWithoutId.content_sha256,
      }),
    }
    const range = {
      start_line: null,
      end_line: null,
      start_byte: null,
      end_byte: null,
    }
    const chunkWithoutId: Omit<KnowledgeChunk, 'id'> = {
      source_id: source.id,
      ordinal: 0,
      content,
      content_sha256: persistedContentSha256,
      character_count: content.length,
      byte_count: Buffer.byteLength(content, 'utf8'),
      estimated_tokens: Math.max(1, Math.ceil(content.length / 4)),
      source_range: range,
      symbol: null,
      created_at: input.reviewedAt,
    }
    const chunk: KnowledgeChunk = {
      ...chunkWithoutId,
      id: knowledgeChunkId({
        source_id: source.id,
        ordinal: 0,
        content_sha256: persistedContentSha256,
        source_range: range,
      }),
    }
    return this.db.transaction(() => {
      if (sha256(canonicalKnowledgeJson(input.exactSource)) !== input.sourceSha256) {
        throw new Error('conflict knowledge exact source changed before persistence')
      }
      const sourceResult = this.knowledge.putSource(source)
      const chunkResult = this.knowledge.putChunk(input.boardId, chunk)
      this.knowledge.synchronizeRetrievalIndex({
        board_id: input.boardId,
        indexed_at: input.reviewedAt,
      })
      return {
        sourceId: sourceResult.id,
        chunkId: chunkResult.id,
        repositoryHeadSha: repository.head,
        repositoryKey: repository.repositoryKey,
        persistedContentSha256,
        redactionState,
      }
    }).immediate()
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

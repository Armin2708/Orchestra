import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  canonicalKnowledgeJson,
  knowledgeChunkId,
  knowledgeSourceId,
  normalizeKnowledgeLocator,
} from './knowledge-contracts.js'
import type {
  DiscussionKnowledgePromotionAdapter,
  DiscussionKnowledgePromotionEvidence,
} from './discussions.js'
import { KnowledgeService } from './knowledge-service.js'
import type { KnowledgeChunk, KnowledgeSource } from './knowledge-types.js'

export type DiscussionKnowledgePromotionErrorCode =
  | 'invalid_evidence'
  | 'promotion_not_reviewed'
  | 'promotion_scope_mismatch'
  | 'promotion_source_mismatch'

const ERROR_MESSAGES: Record<DiscussionKnowledgePromotionErrorCode, string> = {
  invalid_evidence: 'discussion knowledge promotion evidence is invalid',
  promotion_not_reviewed: 'discussion knowledge promotion lacks canonical review evidence',
  promotion_scope_mismatch: 'discussion knowledge promotion scope does not match',
  promotion_source_mismatch: 'discussion knowledge promotion source does not match',
}

export class DiscussionKnowledgePromotionError extends Error {
  constructor(readonly code: DiscussionKnowledgePromotionErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'DiscussionKnowledgePromotionError'
  }
}

interface PromotionEvidenceRow {
  promotion_id: string
  promotion_status: string
  promotion_discussion_id: string
  promotion_post_id: string
  source_uri: string
  source_content_sha256: string
  artifact_json: string
  artifact_sha256: string
  acceptance_event_id: string
  requested_by_type: string
  requested_by_id: string
  reviewed_by_type: string | null
  reviewed_by_id: string | null
  review_note: string | null
  reviewed_at: string | null
  board_id: number
  discussion_title: string
  accepted_post_id: string | null
  post_discussion_id: string
  post_kind: string
  post_body: string
  post_content_sha256: string
  acceptance_board_id: number
  acceptance_discussion_id: string
  acceptance_post_id: string | null
  acceptance_event_type: string
  acceptance_actor_type: string
  acceptance_actor_id: string
  acceptance_payload_json: string
  acceptance_created_at: string
  project_path: string
}

interface ReviewEventRow {
  board_id: number
  discussion_id: string
  post_id: string | null
  event_type: string
  event_version: number
  actor_type: string
  actor_id: string
  payload_json: string
}

interface AcceptedAnswerArtifact {
  schema_version: 1
  kind: 'discussion_answer'
  key: string
  title: string
  content: string
  accepted_at: string
  accepted_by: string
}

const SHA256 = /^[a-f0-9]{64}$/u
const ADAPTER_ID = 'discussion-exact-source-promotion'
const ADAPTER_VERSION = '1.0.0'

/**
 * Canonical Discussion -> Knowledge bridge. The adapter treats the supplied
 * value only as an identity claim, then reconstructs and verifies the exact
 * accepted source and independent review from durable Discussion records.
 */
export class CanonicalDiscussionKnowledgePromotionAdapter
implements DiscussionKnowledgePromotionAdapter {
  private readonly knowledge: KnowledgeService

  constructor(
    private readonly db: Database.Database,
    knowledge?: KnowledgeService,
  ) {
    this.knowledge = knowledge ?? new KnowledgeService(db)
  }

  promote(evidence: DiscussionKnowledgePromotionEvidence): Record<string, unknown> {
    const claim = validatedEvidence(evidence)
    return this.db.transaction(() => {
      const retained = this.loadPromotion(claim.promotionId)
      this.verifyScope(retained, claim)
      this.verifyAcceptedSource(retained, claim)
      this.verifyReview(retained, claim)

      const locator = normalizeKnowledgeLocator(retained.source_uri)
      const sourceRevision = `${retained.acceptance_event_id}@${retained.artifact_sha256}`
      const repositoryKey = `discussion-board/${retained.board_id}`
      const repositoryHead = repositoryRevision(retained.project_path)
      const observedAt = retained.reviewed_at!
      const sourceWithoutId: Omit<KnowledgeSource, 'id'> = {
        source_kind: 'discussion_answer',
        trust_class: 'evidence',
        title: retained.discussion_title,
        locator,
        normalized_locator: locator,
        source_revision: sourceRevision,
        content_sha256: retained.post_content_sha256,
        freshness_policy: 'manual_until_superseded',
        freshness_state: 'fresh',
        redaction_state: 'none',
        content_state: 'present',
        ingest_state: 'active',
        access_scope: { kind: 'board' },
        targets: {
          board_id: retained.board_id,
          workspace_id: null,
          card_id: null,
          contract_ref: null,
          contract_version: null,
          contract_snapshot_sha256: null,
          job_id: null,
          profile_id: null,
          session_id: null,
          delivery_report_id: null,
        },
        provenance: {
          repository_key: repositoryKey,
          base_commit_sha: repositoryHead,
          worktree_state_hash: null,
          relative_root: '.',
          adapter_id: ADAPTER_ID,
          adapter_version: ADAPTER_VERSION,
          adapter_index_commit_sha: null,
          observed_at: observedAt,
        },
        created_at: observedAt,
        updated_at: observedAt,
      }
      const source: KnowledgeSource = {
        ...sourceWithoutId,
        id: knowledgeSourceId({
          repository_key: repositoryKey,
          source_kind: sourceWithoutId.source_kind,
          normalized_locator: locator,
          source_revision: sourceRevision,
          content_sha256: retained.post_content_sha256,
        }),
      }
      const sourceRange = {
        start_line: null,
        end_line: null,
        start_byte: null,
        end_byte: null,
      }
      const chunkWithoutId: Omit<KnowledgeChunk, 'id'> = {
        source_id: source.id,
        ordinal: 0,
        content: retained.post_body,
        content_sha256: retained.post_content_sha256,
        character_count: retained.post_body.length,
        byte_count: Buffer.byteLength(retained.post_body, 'utf8'),
        estimated_tokens: Math.max(1, Math.ceil(retained.post_body.length / 4)),
        source_range: sourceRange,
        symbol: null,
        created_at: observedAt,
      }
      const chunk: KnowledgeChunk = {
        ...chunkWithoutId,
        id: knowledgeChunkId({
          source_id: source.id,
          ordinal: 0,
          content_sha256: retained.post_content_sha256,
          source_range: sourceRange,
        }),
      }

      const persistedSource = this.knowledge.putSource(source)
      const persistedChunk = this.knowledge.putChunk(retained.board_id, chunk)
      this.verifyAcceptedSource(this.loadPromotion(claim.promotionId), claim)
      return {
        promotion_id: retained.promotion_id,
        source_ids: [persistedSource.id],
        chunk_ids: [persistedChunk.id],
      }
    }).immediate()
  }

  private loadPromotion(promotionId: string): PromotionEvidenceRow {
    const retained = this.db.prepare(`SELECT
        promotion.id AS promotion_id,
        promotion.status AS promotion_status,
        promotion.discussion_id AS promotion_discussion_id,
        promotion.post_id AS promotion_post_id,
        promotion.source_uri,
        promotion.source_content_sha256,
        promotion.artifact_json,
        promotion.artifact_sha256,
        promotion.acceptance_event_id,
        promotion.requested_by_type,
        promotion.requested_by_id,
        promotion.reviewed_by_type,
        promotion.reviewed_by_id,
        promotion.review_note,
        promotion.reviewed_at,
        discussion.board_id,
        discussion.title AS discussion_title,
        discussion.accepted_post_id,
        post.discussion_id AS post_discussion_id,
        post.post_kind,
        post.body AS post_body,
        post.content_sha256 AS post_content_sha256,
        acceptance.board_id AS acceptance_board_id,
        acceptance.discussion_id AS acceptance_discussion_id,
        acceptance.post_id AS acceptance_post_id,
        acceptance.event_type AS acceptance_event_type,
        acceptance.actor_type AS acceptance_actor_type,
        acceptance.actor_id AS acceptance_actor_id,
        acceptance.payload_json AS acceptance_payload_json,
        acceptance.created_at AS acceptance_created_at,
        board.project_path
      FROM os_discussion_promotions promotion
      JOIN os_discussions discussion ON discussion.id=promotion.discussion_id
      JOIN boards board ON board.id=discussion.board_id
      JOIN os_discussion_posts post ON post.id=promotion.post_id
      JOIN os_discussion_events acceptance ON acceptance.id=promotion.acceptance_event_id
      WHERE promotion.id=?`).get(promotionId) as PromotionEvidenceRow | undefined
    if (!retained) fail('invalid_evidence')
    return retained
  }

  private verifyScope(
    retained: PromotionEvidenceRow,
    claim: DiscussionKnowledgePromotionEvidence,
  ): void {
    if (
      retained.board_id !== claim.boardId
      || retained.acceptance_board_id !== claim.boardId
      || retained.promotion_discussion_id !== claim.discussionId
      || retained.post_discussion_id !== claim.discussionId
      || retained.acceptance_discussion_id !== claim.discussionId
      || retained.promotion_post_id !== claim.postId
      || retained.acceptance_post_id !== claim.postId
    ) {
      fail('promotion_scope_mismatch')
    }
  }

  private verifyAcceptedSource(
    retained: PromotionEvidenceRow,
    claim: DiscussionKnowledgePromotionEvidence,
  ): void {
    const expectedUri = `discussion://${claim.discussionId}/posts/${claim.postId}`
      + `@sha256:${claim.sourceContentSha256}`
    const expectedAcceptancePayload = canonicalKnowledgeJson({
      post_id: claim.postId,
      content_sha256: claim.sourceContentSha256,
    })
    const expectedArtifact = canonicalKnowledgeJson({
      schema_version: 1,
      kind: 'discussion_answer',
      key: `discussion:${claim.discussionId}:post:${claim.postId}`,
      title: retained.discussion_title,
      content: retained.post_body,
      accepted_at: retained.acceptance_created_at,
      accepted_by: `${retained.acceptance_actor_type}:${retained.acceptance_actor_id}`,
    } satisfies AcceptedAnswerArtifact)
    if (
      retained.accepted_post_id !== claim.postId
      || retained.post_kind !== 'answer'
      || retained.acceptance_event_id !== claim.acceptanceEventId
      || retained.acceptance_event_type !== 'discussion.answer.accepted'
      || retained.source_uri !== claim.sourceUri
      || retained.source_uri !== expectedUri
      || retained.source_content_sha256 !== claim.sourceContentSha256
      || retained.post_content_sha256 !== claim.sourceContentSha256
      || sha256(retained.post_body) !== claim.sourceContentSha256
      || retained.acceptance_payload_json !== expectedAcceptancePayload
      || retained.artifact_json !== claim.artifactJson
      || retained.artifact_json !== expectedArtifact
      || retained.artifact_sha256 !== claim.artifactSha256
      || sha256(retained.artifact_json) !== claim.artifactSha256
    ) {
      fail('promotion_source_mismatch')
    }
  }

  private verifyReview(
    retained: PromotionEvidenceRow,
    claim: DiscussionKnowledgePromotionEvidence,
  ): void {
    if (
      retained.promotion_status !== 'promoting'
      || retained.reviewed_at === null
      || retained.reviewed_by_type !== claim.reviewedBy.type
      || retained.reviewed_by_id !== claim.reviewedBy.id
      || (
        retained.requested_by_type === claim.reviewedBy.type
        && retained.requested_by_id === claim.reviewedBy.id
      )
      || typeof retained.review_note !== 'string'
      || retained.review_note.trim().length === 0
    ) {
      fail('promotion_not_reviewed')
    }
    const review = this.db.prepare(`SELECT board_id, discussion_id, post_id,
        event_type, event_version, actor_type, actor_id, payload_json
      FROM os_discussion_events
      WHERE discussion_id=? AND post_id=?
        AND event_type='discussion.promotion.approved'
        AND json_extract(payload_json, '$.promotion_id')=?
      ORDER BY rowid DESC LIMIT 1`).get(
      claim.discussionId,
      claim.postId,
      claim.promotionId,
    ) as ReviewEventRow | undefined
    const expectedReviewPayload = canonicalKnowledgeJson({
      promotion_id: claim.promotionId,
      decision: 'approve',
      source_uri: claim.sourceUri,
      source_content_sha256: claim.sourceContentSha256,
      artifact_sha256: claim.artifactSha256,
    })
    if (
      !review
      || review.board_id !== claim.boardId
      || review.discussion_id !== claim.discussionId
      || review.post_id !== claim.postId
      || review.event_type !== 'discussion.promotion.approved'
      || review.event_version !== 1
      || review.actor_type !== claim.reviewedBy.type
      || review.actor_id !== claim.reviewedBy.id
      || review.payload_json !== expectedReviewPayload
    ) {
      fail('promotion_not_reviewed')
    }
  }
}

function validatedEvidence(
  value: DiscussionKnowledgePromotionEvidence,
): DiscussionKnowledgePromotionEvidence {
  if (
    !value
    || typeof value !== 'object'
    || !Number.isSafeInteger(value.boardId)
    || value.boardId <= 0
    || !nonEmpty(value.promotionId)
    || !nonEmpty(value.discussionId)
    || !nonEmpty(value.postId)
    || !nonEmpty(value.sourceUri)
    || !SHA256.test(value.sourceContentSha256)
    || !nonEmpty(value.artifactJson)
    || !SHA256.test(value.artifactSha256)
    || !nonEmpty(value.acceptanceEventId)
    || !value.reviewedBy
    || !nonEmpty(value.reviewedBy.type)
    || !nonEmpty(value.reviewedBy.id)
  ) {
    fail('invalid_evidence')
  }
  return value
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function repositoryRevision(projectPath: string): string {
  try {
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (key.startsWith('GIT_')) delete environment[key]
    }
    environment.GIT_CONFIG_NOSYSTEM = '1'
    environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
    environment.GIT_NO_REPLACE_OBJECTS = '1'
    environment.GIT_OPTIONAL_LOCKS = '0'
    const run = (args: string[]) => execFileSync('git', ['-C', projectPath, ...args], {
      encoding: 'utf8',
      env: environment,
      maxBuffer: 1_000_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    }).trim()
    const root = run(['rev-parse', '--show-toplevel'])
    if (fs.realpathSync(path.resolve(root)) !== fs.realpathSync(path.resolve(projectPath))) {
      fail('invalid_evidence')
    }
    const head = run(['rev-parse', '--verify', 'HEAD'])
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) fail('invalid_evidence')
    return head
  } catch (error) {
    if (error instanceof DiscussionKnowledgePromotionError) throw error
    fail('invalid_evidence')
  }
}

function fail(code: DiscussionKnowledgePromotionErrorCode): never {
  throw new DiscussionKnowledgePromotionError(code)
}

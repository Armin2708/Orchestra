import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { canonicalKnowledgeJson } from './knowledge-contracts.js'
import { AgentOsError } from './errors.js'
import { KnowledgeService } from './knowledge-service.js'
import { installKnowledgeManagementSchema } from './knowledge-management-migration.js'
import type { KnowledgeFreshnessState, KnowledgeSourceKind } from './knowledge-types.js'

const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const SOURCE_ID = /^ks_[a-f0-9]{64}$/u
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const MAX_SEARCH_RESULTS = 50

export type KnowledgeControlAction =
  | 'accept' | 'edit' | 'pin' | 'reject' | 'supersede' | 'forget'

export interface KnowledgeActor {
  type: 'operator'
  id: string
}

export interface KnowledgeControlInput {
  board_id: number
  source_id: string
  action: KnowledgeControlAction
  replacement_source_id?: string
  pinned?: boolean
  reason: string
  actor: KnowledgeActor
  idempotency_key: string
  created_at?: string
}

export interface AcceptedAnswerPromotionPayload {
  repository_key: string
  base_commit_sha: string
  observed_at: string
  entries: Array<{
    path: string
    start_line: number
    end_line: number
    expected_source_sha256: string
  }>
}

export interface VerifiedDeliveryPromotionPayload {
  repository_key: string
  base_commit_sha: string
  observed_at: string
  report_id: string
  source_commit_sha: string
  gotchas?: Array<{
    path: string
    start_line: number
    end_line: number
    text: string
    expected_source_sha256: string
  }>
}

export interface CreatePromotionInput {
  board_id: number
  kind: 'accepted_answer' | 'verified_delivery'
  payload: AcceptedAnswerPromotionPayload | VerifiedDeliveryPromotionPayload
  requested_by: string
  idempotency_key: string
  requested_at?: string
}

export interface KnowledgeCitation {
  source_id: string
  chunk_id: string
  title: string
  source_kind: KnowledgeSourceKind
  locator: string
  source_revision: string
  source_content_sha256: string
  chunk_content_sha256: string
  repository_key: string
  repository_head_sha: string | null
  freshness: KnowledgeFreshnessState
  freshness_reason: string | null
  start_line: number | null
  end_line: number | null
  estimated_tokens: number
  pinned: boolean
}

export interface KnowledgeBrowseItem {
  content: string
  content_trust: 'untrusted_data'
  citation: KnowledgeCitation
  pending_review: 'stale' | 'contradiction' | null
  disposition: Exclude<KnowledgeControlAction, 'pin'> | null
}

interface SourceRow {
  id: string
  board_id: number
  source_kind: KnowledgeSourceKind
  title: string
  normalized_locator: string
  source_revision: string
  content_sha256: string
  freshness_state: KnowledgeFreshnessState
  freshness_policy: string
  ingest_state: string
  content_state: string
  provenance_json: string
}

interface ChunkBrowseRow extends SourceRow {
  chunk_id: string
  content: string
  chunk_content_sha256: string
  estimated_tokens: number
  source_range_json: string
  effective_freshness: KnowledgeFreshnessState | null
  freshness_reason: string | null
  repository_head_sha: string | null
  pending_review: 'stale' | 'contradiction' | null
  disposition: Exclude<KnowledgeControlAction, 'pin'> | null
  pinned: number | null
}

export class KnowledgeManagementError extends AgentOsError {
  constructor(
    code: 'invalid_request' | 'not_found' | 'conflict' | 'evidence_rejected',
    message: string,
  ) {
    super(message, code === 'not_found' ? 404 : code === 'conflict' ? 409 : 400, code)
  }
}

const hash = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

const id = (prefix: 'kf' | 'kr' | 'ka' | 'kp', value: unknown): string =>
  `${prefix}_${hash(canonicalKnowledgeJson(value))}`

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(field)
  return Number(value)
}

function text(value: unknown, field: string, maximum = 2000): string {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) invalid(field)
  return value
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field, 24)
  if (!ISO_TIME.test(result) || new Date(result).toISOString() !== result) invalid(field)
  return result
}

function invalid(field: string): never {
  throw new KnowledgeManagementError('invalid_request', `invalid knowledge ${field}`)
}

function sourceId(value: unknown, field = 'source id'): string {
  const result = text(value, field, 67)
  if (!SOURCE_ID.test(result)) invalid(field)
  return result
}

function commit(value: unknown, field: string): string {
  const result = text(value, field, 64)
  if (!COMMIT.test(result)) invalid(field)
  return result
}

function sha(value: unknown, field: string): string {
  const result = text(value, field, 64)
  if (!SHA256.test(result)) invalid(field)
  return result
}

function canonicalPayload(value: unknown): { json: string; sha256: string } {
  try {
    const json = canonicalKnowledgeJson(value, {
      max_depth: 12,
      max_nodes: 2_000,
      max_string_characters: 100_000,
      max_serialized_bytes: 500_000,
    })
    return { json, sha256: hash(json) }
  } catch {
    invalid('promotion payload')
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) delete environment[key]
  }
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  environment.GIT_NO_REPLACE_OBJECTS = '1'
  environment.GIT_OPTIONAL_LOCKS = '0'
  return environment
}

function git(root: string, args: string[], maximum = 2_100_000): Buffer {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'buffer',
      env: gitEnvironment(),
      maxBuffer: maximum,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    })
  } catch {
    throw new KnowledgeManagementError('evidence_rejected', 'repository freshness evidence could not be verified')
  }
}

function safeRepositoryPath(value: string): string | null {
  if (
    value.length === 0 || value.length > 4096 || value.includes('\0')
    || value.includes('\\') || path.posix.isAbsolute(value)
  ) return null
  const normalized = path.posix.normalize(value)
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) return null
  if (normalized.split('/').some((part) => part === '.git' || part.length === 0)) return null
  return normalized
}

function committedContentHash(root: string, head: string, locator: string): string | null {
  const repositoryPath = safeRepositoryPath(locator)
  if (!repositoryPath) return null
  try {
    return createHash('sha256').update(git(root, ['show', `${head}:${repositoryPath}`])).digest('hex')
  } catch {
    return null
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export class KnowledgeManagementService {
  private readonly knowledge: KnowledgeService

  constructor(private readonly db: Database.Database) {
    installKnowledgeManagementSchema(db)
    this.knowledge = new KnowledgeService(db)
  }

  refreshRepository(boardIdValue: number, observedAtValue?: string): {
    board_id: number
    repository_head_sha: string
    observations: number
    review_requests: number
    invalidated_builds: number
  } {
    const boardId = integer(boardIdValue, 'board id')
    const observedAt = observedAtValue === undefined
      ? new Date().toISOString() : timestamp(observedAtValue, 'observed at')
    const board = this.db.prepare('SELECT project_path FROM boards WHERE id=?').get(boardId) as
      { project_path: string } | undefined
    if (!board) throw new KnowledgeManagementError('not_found', 'knowledge board was not found')
    const root = git(board.project_path, ['rev-parse', '--show-toplevel']).toString('utf8').trim()
    if (fs.realpathSync(root) !== fs.realpathSync(board.project_path)) {
      throw new KnowledgeManagementError('evidence_rejected', 'board repository root does not match')
    }
    const head = git(root, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim()
    commit(head, 'repository head')
    const sources = this.db.prepare(`SELECT id, board_id, source_kind, title,
        normalized_locator, source_revision, content_sha256, freshness_state,
        freshness_policy, ingest_state, content_state, provenance_json
      FROM knowledge_sources WHERE board_id=? AND ingest_state='active'`)
      .all(boardId) as SourceRow[]

    return this.db.transaction(() => {
      let reviews = 0
      let invalidated = 0
      for (const source of sources) {
        const provenance = parseJsonRecord(source.provenance_json)
        const originalHead = typeof provenance.base_commit_sha === 'string'
          ? provenance.base_commit_sha : ''
        const observedHash = committedContentHash(root, head, source.normalized_locator)
        let freshness: KnowledgeFreshnessState
        let reason: 'head_unchanged' | 'head_changed' | 'content_changed' | 'source_missing'
        if (observedHash === null) {
          freshness = originalHead === head ? source.freshness_state : 'unknown'
          reason = 'source_missing'
        } else if (observedHash !== source.content_sha256) {
          freshness = 'stale'
          reason = 'content_changed'
        } else if (originalHead === head) {
          freshness = 'fresh'
          reason = 'head_unchanged'
        } else {
          freshness = 'fresh'
          reason = 'head_changed'
        }
        const observationId = id('kf', {
          board_id: boardId, source_id: source.id, repository_head_sha: head,
          observed_content_sha256: observedHash, effective_freshness: freshness, reason,
        })
        this.db.prepare(`INSERT OR IGNORE INTO knowledge_freshness_observations
          (id, board_id, source_id, repository_head_sha, observed_content_sha256,
           effective_freshness, reason, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(observationId, boardId, source.id, head, observedHash, freshness, reason, observedAt)
        if (reason !== 'head_unchanged') {
          const changed = this.db.prepare(`UPDATE context_builds SET status='invalidated', invalidated_at=?
            WHERE board_id=? AND status='built' AND EXISTS (
              SELECT 1 FROM context_build_sources link
              WHERE link.board_id=context_builds.board_id
                AND link.context_build_id=context_builds.id AND link.source_id=?)`)
            .run(observedAt, boardId, source.id)
          invalidated += changed.changes
        }
        if (freshness === 'stale' || freshness === 'unknown') {
          reviews += this.ensureReview(boardId, source.id, 'stale', observationId, observedAt)
        }
      }
      reviews += this.detectContradictions(boardId, head, observedAt)
      return {
        board_id: boardId,
        repository_head_sha: head,
        observations: sources.length,
        review_requests: reviews,
        invalidated_builds: invalidated,
      }
    }).immediate()
  }

  private detectContradictions(boardId: number, head: string, at: string): number {
    const rows = this.db.prepare(`SELECT normalized_locator, source_revision
      FROM knowledge_sources WHERE board_id=? AND ingest_state='active'
      GROUP BY normalized_locator, source_revision HAVING count(DISTINCT content_sha256)>1`)
      .all(boardId) as Array<{ normalized_locator: string; source_revision: string }>
    let reviews = 0
    for (const row of rows) {
      const sources = this.db.prepare(`SELECT id FROM knowledge_sources
        WHERE board_id=? AND normalized_locator=? AND source_revision=? AND ingest_state='active'`)
        .all(boardId, row.normalized_locator, row.source_revision) as Array<{ id: string }>
      for (const source of sources) {
        const observationId = id('kf', {
          board_id: boardId, source_id: source.id, repository_head_sha: head,
          observed_content_sha256: null, effective_freshness: 'contradicted', reason: 'contradiction',
        })
        this.db.prepare(`INSERT OR IGNORE INTO knowledge_freshness_observations
          (id, board_id, source_id, repository_head_sha, observed_content_sha256,
           effective_freshness, reason, observed_at)
          VALUES (?, ?, ?, ?, NULL, 'contradicted', 'contradiction', ?)`)
          .run(observationId, boardId, source.id, head, at)
        reviews += this.ensureReview(boardId, source.id, 'contradiction', observationId, at)
      }
    }
    return reviews
  }

  private ensureReview(
    boardId: number,
    source: string,
    kind: 'stale' | 'contradiction',
    observationId: string,
    at: string,
  ): number {
    const reviewId = id('kr', { board_id: boardId, source_id: source, kind, observation_id: observationId })
    return this.db.prepare(`INSERT OR IGNORE INTO knowledge_review_requests
      (id, board_id, source_id, kind, observation_id, requested_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(reviewId, boardId, source, kind, observationId, at).changes
  }

  applyControl(value: KnowledgeControlInput): Record<string, unknown> {
    const boardId = integer(value.board_id, 'board id')
    const source = sourceId(value.source_id)
    const actions = new Set<KnowledgeControlAction>([
      'accept', 'edit', 'pin', 'reject', 'supersede', 'forget',
    ])
    if (!actions.has(value.action)) invalid('control action')
    const actorId = text(value.actor?.id, 'actor id', 256)
    if (value.actor?.type !== 'operator') invalid('actor')
    const reason = text(value.reason, 'control reason')
    const key = text(value.idempotency_key, 'idempotency key', 256)
    const at = value.created_at === undefined
      ? new Date().toISOString() : timestamp(value.created_at, 'created at')
    const replacement = value.action === 'edit' || value.action === 'supersede'
      ? sourceId(value.replacement_source_id, 'replacement source id') : null
    const pinned = value.action === 'pin'
      ? (typeof value.pinned === 'boolean' ? value.pinned : invalid('pin state')) : null
    if (replacement === source) invalid('replacement source id')
    const request = { board_id: boardId, source_id: source, action: value.action,
      replacement_source_id: replacement, pinned, reason, actor_type: 'operator', actor_id: actorId }
    const requestHash = hash(canonicalKnowledgeJson(request))
    const actionId = id('ka', { ...request, idempotency_key: key })
    return this.db.transaction(() => {
      const replay = this.db.prepare(`SELECT * FROM knowledge_control_actions
        WHERE board_id=? AND idempotency_key=?`).get(boardId, key) as Record<string, unknown> | undefined
      if (replay) {
        if (replay.request_sha256 !== requestHash) {
          throw new KnowledgeManagementError('conflict', 'knowledge control idempotency conflict')
        }
        return replay
      }
      this.requireSource(boardId, source)
      if (replacement) this.requireSource(boardId, replacement)
      const ordinal = (this.db.prepare(`SELECT coalesce(max(source_ordinal), 0) + 1 AS ordinal
        FROM knowledge_control_actions WHERE board_id=? AND source_id=?`)
        .get(boardId, source) as { ordinal: number }).ordinal
      this.db.prepare(`INSERT INTO knowledge_control_actions
        (id, board_id, source_id, action, replacement_source_id, pinned, reason,
         actor_type, actor_id, source_ordinal, idempotency_key, request_sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'operator', ?, ?, ?, ?, ?)`)
        .run(actionId, boardId, source, value.action, replacement,
          pinned === null ? null : Number(pinned), reason, actorId, ordinal, key, requestHash, at)
      if (value.action !== 'pin') {
        this.db.prepare(`UPDATE knowledge_review_requests
          SET status='resolved', resolution_action_id=?, resolved_at=?
          WHERE board_id=? AND source_id=? AND status='pending'`)
          .run(actionId, at, boardId, source)
      }
      return this.db.prepare('SELECT * FROM knowledge_control_actions WHERE id=?').get(actionId) as
        Record<string, unknown>
    }).immediate()
  }

  createPromotion(value: CreatePromotionInput): Record<string, unknown> {
    const boardId = integer(value.board_id, 'board id')
    const requestedBy = text(value.requested_by, 'requester', 256)
    const key = text(value.idempotency_key, 'idempotency key', 256)
    const at = value.requested_at === undefined
      ? new Date().toISOString() : timestamp(value.requested_at, 'requested at')
    const payload = this.validatePromotionPayload(value.kind, value.payload)
    const canonical = canonicalPayload(payload)
    const requestHash = hash(canonicalKnowledgeJson({ kind: value.kind, payload_sha256: canonical.sha256 }))
    const promotionId = id('kp', {
      board_id: boardId, kind: value.kind, payload_sha256: canonical.sha256, idempotency_key: key,
    })
    return this.db.transaction(() => {
      this.requireBoard(boardId)
      const replay = this.db.prepare(`SELECT * FROM knowledge_promotion_requests
        WHERE board_id=? AND idempotency_key=?`).get(boardId, key) as Record<string, unknown> | undefined
      if (replay) {
        if (replay.request_sha256 !== requestHash) {
          throw new KnowledgeManagementError('conflict', 'knowledge promotion idempotency conflict')
        }
        return replay
      }
      this.db.prepare(`INSERT INTO knowledge_promotion_requests
        (id, board_id, kind, payload_json, payload_sha256, requested_by,
         idempotency_key, request_sha256, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(promotionId, boardId, value.kind, canonical.json, canonical.sha256,
          requestedBy, key, requestHash, at)
      return this.db.prepare('SELECT * FROM knowledge_promotion_requests WHERE id=?')
        .get(promotionId) as Record<string, unknown>
    }).immediate()
  }

  reviewPromotion(input: {
    board_id: number
    promotion_id: string
    decision: 'promote' | 'reject'
    actor: KnowledgeActor
    reason: string
    reviewed_at?: string
  }): Record<string, unknown> {
    const boardId = integer(input.board_id, 'board id')
    const promotionId = text(input.promotion_id, 'promotion id', 67)
    if (!/^kp_[a-f0-9]{64}$/u.test(promotionId)) invalid('promotion id')
    if (input.actor?.type !== 'operator') invalid('actor')
    const actorId = text(input.actor.id, 'actor id', 256)
    const reason = text(input.reason, 'review reason')
    if (input.decision !== 'promote' && input.decision !== 'reject') invalid('promotion decision')
    const at = input.reviewed_at === undefined
      ? new Date().toISOString() : timestamp(input.reviewed_at, 'reviewed at')
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM knowledge_promotion_requests
        WHERE id=? AND board_id=?`).get(promotionId, boardId) as Record<string, unknown> | undefined
      if (!row) throw new KnowledgeManagementError('not_found', 'knowledge promotion was not found')
      if (row.status !== 'pending') return row
      let sources: string[] = []
      if (input.decision === 'promote') {
        const payload = JSON.parse(String(row.payload_json)) as
          AcceptedAnswerPromotionPayload | VerifiedDeliveryPromotionPayload
        const root = this.boardRoot(boardId)
        const report = row.kind === 'accepted_answer'
          ? this.knowledge.ingestAcceptedKnowledge({
              board_id: boardId,
              repository_key: payload.repository_key,
              repository_root: root,
              base_commit_sha: payload.base_commit_sha,
              observed_at: payload.observed_at,
              entries: (payload as AcceptedAnswerPromotionPayload).entries,
            })
          : this.knowledge.ingestVerifiedDelivery({
              board_id: boardId,
              repository_key: payload.repository_key,
              repository_root: root,
              base_commit_sha: payload.base_commit_sha,
              observed_at: payload.observed_at,
              report_id: (payload as VerifiedDeliveryPromotionPayload).report_id,
              source_commit_sha: (payload as VerifiedDeliveryPromotionPayload).source_commit_sha,
              gotchas: (payload as VerifiedDeliveryPromotionPayload).gotchas,
            })
        sources = report.sources.map((source) => source.id)
        for (const source of sources) {
          this.db.prepare(`INSERT INTO knowledge_promotion_sources
            (promotion_id, board_id, source_id) VALUES (?, ?, ?)`)
            .run(promotionId, boardId, source)
        }
      }
      this.db.prepare(`UPDATE knowledge_promotion_requests
        SET status=?, reviewed_by=?, review_reason=?, reviewed_at=? WHERE id=?`)
        .run(input.decision === 'promote' ? 'promoted' : 'rejected', actorId, reason, at, promotionId)
      return {
        ...(this.db.prepare('SELECT * FROM knowledge_promotion_requests WHERE id=?')
          .get(promotionId) as Record<string, unknown>),
        source_ids: sources,
      }
    }).immediate()
  }

  listReviews(boardIdValue: number): Array<Record<string, unknown>> {
    const boardId = integer(boardIdValue, 'board id')
    this.requireBoard(boardId)
    return this.db.prepare(`SELECT review.*, source.title, source.normalized_locator,
        observation.effective_freshness, observation.reason AS freshness_reason,
        observation.repository_head_sha
      FROM knowledge_review_requests review
      JOIN knowledge_sources source ON source.board_id=review.board_id AND source.id=review.source_id
      JOIN knowledge_freshness_observations observation ON observation.id=review.observation_id
      WHERE review.board_id=? ORDER BY review.status='pending' DESC, review.requested_at DESC, review.id`)
      .all(boardId) as Array<Record<string, unknown>>
  }

  listPromotions(boardIdValue: number): Array<Record<string, unknown>> {
    const boardId = integer(boardIdValue, 'board id')
    this.requireBoard(boardId)
    return this.db.prepare(`SELECT promotion.*,
        (SELECT count(*) FROM knowledge_promotion_sources linked
          WHERE linked.promotion_id=promotion.id) AS promoted_source_count
      FROM knowledge_promotion_requests promotion WHERE board_id=?
      ORDER BY status='pending' DESC, requested_at DESC, id`).all(boardId) as
      Array<Record<string, unknown>>
  }

  browse(input: {
    board_id: number
    query?: string
    limit?: number
    include_stale?: boolean
    include_rejected?: boolean
  }): KnowledgeBrowseItem[] {
    const boardId = integer(input.board_id, 'board id')
    const limit = input.limit === undefined ? 25 : integer(input.limit, 'search limit')
    if (limit > MAX_SEARCH_RESULTS) invalid('search limit')
    const query = input.query?.trim() ?? ''
    if (query.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(query)) invalid('search query')
    this.requireBoard(boardId)
    const terms = query.split(/\s+/u).filter(Boolean).slice(0, 16)
    const parameters: unknown[] = [boardId]
    const searchJoin = terms.length > 0
      ? `JOIN knowledge_retrieval_documents document
          ON document.board_id=chunk.board_id AND document.source_id=chunk.source_id AND document.chunk_id=chunk.id
        JOIN knowledge_retrieval_fts fts ON fts.rowid=document.fts_rowid`
      : ''
    const searchCondition = terms.length > 0 ? 'AND knowledge_retrieval_fts MATCH ?' : ''
    if (terms.length > 0) parameters.push(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND '))
    parameters.push(limit)
    const rows = this.db.prepare(`WITH latest_observation AS (
        SELECT item.* FROM knowledge_freshness_observations item
        WHERE NOT EXISTS (SELECT 1 FROM knowledge_freshness_observations newer
          WHERE newer.board_id=item.board_id AND newer.source_id=item.source_id
            AND (newer.observed_at>item.observed_at OR (newer.observed_at=item.observed_at AND newer.id>item.id)))
      ), latest_disposition AS (
        SELECT item.* FROM knowledge_control_actions item WHERE item.action!='pin'
          AND NOT EXISTS (SELECT 1 FROM knowledge_control_actions newer
            WHERE newer.board_id=item.board_id AND newer.source_id=item.source_id AND newer.action!='pin'
              AND newer.source_ordinal>item.source_ordinal)
      ), latest_pin AS (
        SELECT item.* FROM knowledge_control_actions item WHERE item.action='pin'
          AND NOT EXISTS (SELECT 1 FROM knowledge_control_actions newer
            WHERE newer.board_id=item.board_id AND newer.source_id=item.source_id AND newer.action='pin'
              AND newer.source_ordinal>item.source_ordinal)
      )
      SELECT source.*, chunk.id AS chunk_id, chunk.content,
        chunk.content_sha256 AS chunk_content_sha256, chunk.estimated_tokens, chunk.source_range_json,
        observation.effective_freshness, observation.reason AS freshness_reason,
        observation.repository_head_sha,
        (SELECT kind FROM knowledge_review_requests review WHERE review.board_id=source.board_id
          AND review.source_id=source.id AND review.status='pending' ORDER BY kind LIMIT 1) AS pending_review,
        disposition.action AS disposition, pin.pinned
      FROM knowledge_chunks chunk
      JOIN knowledge_sources source ON source.board_id=chunk.board_id AND source.id=chunk.source_id
      ${searchJoin}
      LEFT JOIN latest_observation observation ON observation.board_id=source.board_id AND observation.source_id=source.id
      LEFT JOIN latest_disposition disposition ON disposition.board_id=source.board_id AND disposition.source_id=source.id
      LEFT JOIN latest_pin pin ON pin.board_id=source.board_id AND pin.source_id=source.id
      WHERE source.board_id=? AND source.content_state='present' AND source.ingest_state='active'
        ${searchCondition}
        ${input.include_stale ? '' : `AND (
          coalesce(observation.effective_freshness, source.freshness_state)='fresh'
          OR disposition.action='accept'
        )`}
        ${input.include_rejected ? '' : `AND coalesce(disposition.action, 'accept') NOT IN ('reject','forget','edit','supersede')`}
      ORDER BY coalesce(pin.pinned,0) DESC, source.updated_at DESC, source.id, chunk.ordinal
      LIMIT ?`).all(...parameters) as ChunkBrowseRow[]
    return rows.map((row) => this.browseItem(row))
  }

  contextManifest(buildIdValue: string, boardIdValue: number): Array<{
    source_id: string
    chunk_id: string
    selected: boolean
    why_included: string
    estimated_tokens: number
    token_contribution_percent: number
    citation: KnowledgeCitation
  }> {
    const boardId = integer(boardIdValue, 'board id')
    const buildId = text(buildIdValue, 'context build id', 67)
    const build = this.db.prepare(`SELECT json_extract(usage_json, '$.used_tokens') AS used_tokens
      FROM context_builds WHERE board_id=? AND id=?`)
      .get(boardId, buildId) as { used_tokens: number } | undefined
    if (!build) throw new KnowledgeManagementError('not_found', 'context build was not found')
    const rows = this.db.prepare(`SELECT source.*, chunk.id AS chunk_id, chunk.content,
        chunk.content_sha256 AS chunk_content_sha256, chunk.estimated_tokens, chunk.source_range_json,
        entry.decision, entry.reason, entry.score_micros,
        observation.effective_freshness, observation.reason AS freshness_reason,
        observation.repository_head_sha, NULL AS pending_review, NULL AS disposition,
        (SELECT pinned FROM knowledge_control_actions pin WHERE pin.board_id=source.board_id
          AND pin.source_id=source.id AND pin.action='pin' ORDER BY source_ordinal DESC LIMIT 1) AS pinned
      FROM context_build_entries entry
      JOIN knowledge_sources source ON source.board_id=entry.board_id AND source.id=entry.source_id
      JOIN knowledge_chunks chunk ON chunk.board_id=entry.board_id AND chunk.id=entry.chunk_id
      LEFT JOIN knowledge_freshness_observations observation ON observation.id=(
        SELECT id FROM knowledge_freshness_observations item WHERE item.board_id=source.board_id
          AND item.source_id=source.id ORDER BY observed_at DESC, id DESC LIMIT 1)
      WHERE entry.board_id=? AND entry.context_build_id=? ORDER BY entry.candidate_ordinal`)
      .all(boardId, buildId) as Array<ChunkBrowseRow & {
        decision: 'selected' | 'omitted'
        reason: string
        score_micros: number
      }>
    return rows.map((row) => ({
      source_id: row.id,
      chunk_id: row.chunk_id,
      selected: row.decision === 'selected',
      why_included: row.decision === 'selected'
        ? `${row.reason}; deterministic score ${row.score_micros}`
        : `omitted: ${row.reason}`,
      estimated_tokens: row.estimated_tokens,
      token_contribution_percent: build.used_tokens === 0 || row.decision !== 'selected'
        ? 0 : Math.round((row.estimated_tokens / build.used_tokens) * 10_000) / 100,
      citation: this.browseItem(row).citation,
    }))
  }

  private browseItem(row: ChunkBrowseRow): KnowledgeBrowseItem {
    const provenance = parseJsonRecord(row.provenance_json)
    const range = parseJsonRecord(row.source_range_json)
    return {
      content: row.content,
      content_trust: 'untrusted_data',
      pending_review: row.pending_review,
      disposition: row.disposition,
      citation: {
        source_id: row.id,
        chunk_id: row.chunk_id,
        title: row.title,
        source_kind: row.source_kind,
        locator: row.normalized_locator,
        source_revision: row.source_revision,
        source_content_sha256: row.content_sha256,
        chunk_content_sha256: row.chunk_content_sha256,
        repository_key: typeof provenance.repository_key === 'string' ? provenance.repository_key : 'unknown',
        repository_head_sha: row.repository_head_sha,
        freshness: row.effective_freshness ?? row.freshness_state,
        freshness_reason: row.freshness_reason,
        start_line: Number.isSafeInteger(range.start_line) ? Number(range.start_line) : null,
        end_line: Number.isSafeInteger(range.end_line) ? Number(range.end_line) : null,
        estimated_tokens: row.estimated_tokens,
        pinned: row.pinned === 1,
      },
    }
  }

  private validatePromotionPayload(
    kind: CreatePromotionInput['kind'],
    value: CreatePromotionInput['payload'],
  ): AcceptedAnswerPromotionPayload | VerifiedDeliveryPromotionPayload {
    if (kind !== 'accepted_answer' && kind !== 'verified_delivery') invalid('promotion kind')
    const payload = value as unknown as Record<string, unknown>
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('promotion payload')
    const common = {
      repository_key: text(payload.repository_key, 'repository key', 256),
      base_commit_sha: commit(payload.base_commit_sha, 'base commit'),
      observed_at: timestamp(payload.observed_at, 'observed at'),
    }
    if (kind === 'accepted_answer') {
      if (!Array.isArray(payload.entries) || payload.entries.length < 1 || payload.entries.length > 64) {
        invalid('promotion entries')
      }
      return {
        ...common,
        entries: payload.entries.map((raw) => {
          const entry = raw as Record<string, unknown>
          return {
            path: text(entry.path, 'source path', 4096),
            start_line: integer(entry.start_line, 'start line'),
            end_line: integer(entry.end_line, 'end line'),
            expected_source_sha256: sha(entry.expected_source_sha256, 'source hash'),
          }
        }),
      }
    }
    const delivery = payload as Record<string, unknown>
    return {
      ...common,
      report_id: text(delivery.report_id, 'delivery report id', 256),
      source_commit_sha: commit(delivery.source_commit_sha, 'source commit'),
      ...(delivery.gotchas === undefined ? {} : { gotchas: delivery.gotchas as VerifiedDeliveryPromotionPayload['gotchas'] }),
    }
  }

  private requireBoard(boardId: number): void {
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(boardId)) {
      throw new KnowledgeManagementError('not_found', 'knowledge board was not found')
    }
  }

  private requireSource(boardId: number, source: string): void {
    if (!this.db.prepare('SELECT 1 FROM knowledge_sources WHERE board_id=? AND id=?')
      .get(boardId, source)) {
      throw new KnowledgeManagementError('not_found', 'knowledge source was not found')
    }
  }

  private boardRoot(boardId: number): string {
    const row = this.db.prepare('SELECT project_path FROM boards WHERE id=?').get(boardId) as
      { project_path: string } | undefined
    if (!row) throw new KnowledgeManagementError('not_found', 'knowledge board was not found')
    return row.project_path
  }
}

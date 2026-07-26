import type Database from 'better-sqlite3'
import { AgentOsError } from './errors.js'
import {
  MAX_CANONICAL_JSON_LIMITS,
  canonicalKnowledgeJson,
  contextBuildId,
  contextRequestFingerprint,
  contextUseId,
  knowledgeSourceSetFingerprint,
  normalizeContextBuildEntries,
  normalizeKnowledgeSourceSet,
  validateContextBuild,
  validateContextRequestIdentity,
  validateContextUse,
  validateKnowledgeChunk,
  validateKnowledgeSource,
} from './knowledge-contracts.js'
import type {
  ContextBuild,
  ContextRequestIdentityInput,
  ContextUse,
  ContextUseOutcome,
  KnowledgeChunk,
  KnowledgeSource,
  KnowledgeSourceSetEntry,
} from './knowledge-types.js'

export interface PutContextBuildInput {
  build: ContextBuild
  request: ContextRequestIdentityInput
  source_set: readonly KnowledgeSourceSetEntry[]
}

export interface StoredContextBuild extends ContextBuild {
  request: ContextRequestIdentityInput
  source_set: KnowledgeSourceSetEntry[]
}

export interface FinishContextUseInput {
  board_id: number
  context_use_id: string
  outcome: Exclude<ContextUseOutcome, 'running'>
  actual_tokens: number | null
  completed_at?: string
}

export type KnowledgeStoreErrorCode =
  | 'knowledge_input_invalid'
  | 'knowledge_scope_invalid'
  | 'knowledge_replay_conflict'
  | 'knowledge_lifecycle_conflict'
  | 'knowledge_storage_corrupt'
  | 'knowledge_write_failed'

const STORE_ERROR_MESSAGES: Record<KnowledgeStoreErrorCode, string> = {
  knowledge_input_invalid: 'knowledge persistence input is invalid',
  knowledge_scope_invalid: 'knowledge persistence scope is invalid',
  knowledge_replay_conflict: 'knowledge persistence replay conflicts with retained evidence',
  knowledge_lifecycle_conflict: 'knowledge persistence lifecycle transition conflicts with retained state',
  knowledge_storage_corrupt: 'knowledge persistence evidence is corrupt',
  knowledge_write_failed: 'knowledge persistence write failed',
}

/**
 * All persistence errors use fixed text. In particular, supplied content,
 * locators, identifiers, cache keys, JSON, SQLite messages, and causes are
 * never reflected into the error surface.
 */
export class KnowledgeStoreError extends AgentOsError {
  constructor(
    code: KnowledgeStoreErrorCode,
    statusCode = code === 'knowledge_storage_corrupt' || code === 'knowledge_write_failed'
      ? 500
      : code === 'knowledge_replay_conflict' || code === 'knowledge_lifecycle_conflict'
        ? 409
        : 400,
  ) {
    super(STORE_ERROR_MESSAGES[code], statusCode, code)
    this.name = 'KnowledgeStoreError'
  }
}

const SHA256 = /^[a-f0-9]{64}$/u
const SOURCE_ID = /^ks_[a-f0-9]{64}$/u
const CHUNK_ID = /^kc_[a-f0-9]{64}$/u
const BUILD_ID = /^cb_[a-f0-9]{64}$/u
const USE_ID = /^cu_[a-f0-9]{64}$/u
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

function inputFailure(): never {
  throw new KnowledgeStoreError('knowledge_input_invalid')
}

function scopeFailure(): never {
  throw new KnowledgeStoreError('knowledge_scope_invalid')
}

function replayConflict(): never {
  throw new KnowledgeStoreError('knowledge_replay_conflict')
}

function lifecycleConflict(): never {
  throw new KnowledgeStoreError('knowledge_lifecycle_conflict')
}

function corruption(): never {
  throw new KnowledgeStoreError('knowledge_storage_corrupt')
}

function protectInput<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof KnowledgeStoreError) throw error
    inputFailure()
  }
}

function protectWrite<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof KnowledgeStoreError) throw error
    throw new KnowledgeStoreError('knowledge_write_failed')
  }
}

function canonicalJson(value: unknown): string {
  return canonicalKnowledgeJson(value, MAX_CANONICAL_JSON_LIMITS)
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right)
  } catch {
    corruption()
  }
}

function parseCanonicalJson(serialized: unknown): unknown {
  if (typeof serialized !== 'string') corruption()
  try {
    const value = JSON.parse(serialized) as unknown
    if (canonicalJson(value) !== serialized) corruption()
    return value
  } catch (error) {
    if (error instanceof KnowledgeStoreError) throw error
    corruption()
  }
}

function positiveBoardId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) inputFailure()
  return Number(value)
}

function identifier(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) inputFailure()
  return value
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) inputFailure()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) inputFailure()
  return value
}

function integer(value: unknown, nullable: false): number
function integer(value: unknown, nullable: true): number | null
function integer(value: unknown, nullable: boolean): number | null {
  if (value === null && nullable) return null
  if (!Number.isSafeInteger(value) || Number(value) < 0) inputFailure()
  return Number(value)
}

function requiredRecord(
  value: unknown,
  requiredKeys: readonly string[],
): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) inputFailure()
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) inputFailure()
    const keys = Reflect.ownKeys(value)
    if (
      keys.some((key) => typeof key !== 'string')
      || keys.length !== requiredKeys.length
      || requiredKeys.some((key) => !keys.includes(key))
    ) {
      inputFailure()
    }
    const result = Object.create(null) as Record<string, unknown>
    for (const key of requiredKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) inputFailure()
      result[key] = descriptor.value
    }
    return result
  } catch (error) {
    if (error instanceof KnowledgeStoreError) throw error
    inputFailure()
  }
}

function sourceCreationEqual(left: KnowledgeSource, right: KnowledgeSource): boolean {
  return canonicalEqual(left, right)
}

function chunkCreationEqual(left: KnowledgeChunk, right: KnowledgeChunk): boolean {
  return left.id === right.id
    && left.source_id === right.source_id
    && left.ordinal === right.ordinal
    && left.content === right.content
    && left.content_sha256 === right.content_sha256
    && left.character_count === right.character_count
    && left.byte_count === right.byte_count
    && left.estimated_tokens === right.estimated_tokens
    && canonicalEqual(left.source_range, right.source_range)
    && canonicalEqual(left.symbol, right.symbol)
    && left.created_at === right.created_at
}

function buildCreationProjection(build: ContextBuild): Omit<
  ContextBuild,
  'status' | 'invalidated_at'
> {
  const { status: _status, invalidated_at: _invalidatedAt, ...creation } = build
  return creation
}

function buildCreationEqual(
  retained: StoredContextBuild,
  supplied: StoredContextBuild,
): boolean {
  return canonicalEqual(
    {
      build: buildCreationProjection(retained),
      request: retained.request,
      source_set: retained.source_set,
    },
    {
      build: buildCreationProjection(supplied),
      request: supplied.request,
      source_set: supplied.source_set,
    },
  )
}

function useCreationProjection(use: ContextUse): Omit<
  ContextUse,
  'outcome' | 'actual_tokens' | 'completed_at'
> {
  const {
    outcome: _outcome,
    actual_tokens: _actualTokens,
    completed_at: _completedAt,
    ...creation
  } = use
  return creation
}

function useCreationEqual(left: ContextUse, right: ContextUse): boolean {
  return canonicalEqual(useCreationProjection(left), useCreationProjection(right))
}

function rawNumber(value: unknown): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) corruption()
  return number
}

function rawNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return rawNumber(value)
}

function rawNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

export class KnowledgeStore {
  constructor(private readonly db: Database.Database) {}

  putSource(value: KnowledgeSource): KnowledgeSource {
    const source = protectInput(() => validateKnowledgeSource(value))
    const boardId = positiveBoardId(source.targets.board_id)
    return protectWrite(() => {
      const save = this.db.transaction(() => {
        this.assertBoard(boardId)
        this.assertTargetScope(boardId, source)
        const existing = this.readSource(boardId, source.id)
        if (existing) {
          if (!sourceCreationEqual(existing, source)) replayConflict()
          return existing
        }
        this.db.prepare(`INSERT INTO knowledge_sources (
          board_id, id, source_kind, trust_class, title, locator, normalized_locator,
          source_revision, content_sha256, freshness_policy, freshness_state,
          redaction_state, content_state, ingest_state, access_scope_json,
          targets_json, provenance_json, created_at, updated_at
        ) VALUES (
          @board_id, @id, @source_kind, @trust_class, @title, @locator,
          @normalized_locator, @source_revision, @content_sha256, @freshness_policy,
          @freshness_state, @redaction_state, @content_state, @ingest_state,
          @access_scope_json, @targets_json, @provenance_json, @created_at, @updated_at
        )`).run({
          board_id: boardId,
          id: source.id,
          source_kind: source.source_kind,
          trust_class: source.trust_class,
          title: source.title,
          locator: source.locator,
          normalized_locator: source.normalized_locator,
          source_revision: source.source_revision,
          content_sha256: source.content_sha256,
          freshness_policy: source.freshness_policy,
          freshness_state: source.freshness_state,
          redaction_state: source.redaction_state,
          content_state: source.content_state,
          ingest_state: source.ingest_state,
          access_scope_json: canonicalJson(source.access_scope),
          targets_json: canonicalJson(source.targets),
          provenance_json: canonicalJson(source.provenance),
          created_at: source.created_at,
          updated_at: source.updated_at,
        })
        const retained = this.readSource(boardId, source.id)
        if (!retained || !sourceCreationEqual(retained, source)) corruption()
        return retained
      })
      return save.immediate()
    })
  }

  getSource(boardIdValue: number, sourceIdValue: string): KnowledgeSource | null {
    const boardId = positiveBoardId(boardIdValue)
    const sourceId = identifier(sourceIdValue, SOURCE_ID)
    return this.readSource(boardId, sourceId)
  }

  putChunk(boardIdValue: number, value: KnowledgeChunk): KnowledgeChunk {
    const boardId = positiveBoardId(boardIdValue)
    const chunk = protectInput(() => validateKnowledgeChunk(value))
    return protectWrite(() => {
      const save = this.db.transaction(() => {
        const source = this.readSource(boardId, chunk.source_id)
        if (!source) scopeFailure()
        if (
          source.content_state !== 'present'
          || source.redaction_state === 'withheld'
          || source.ingest_state === 'forgotten'
        ) {
          scopeFailure()
        }
        const existing = this.readChunk(boardId, chunk.id)
        if (existing) {
          if (!chunkCreationEqual(existing, chunk)) replayConflict()
          return existing
        }
        const ordinalRow = this.db.prepare(`SELECT id FROM knowledge_chunks
          WHERE board_id=? AND source_id=? AND ordinal=?`)
          .get(boardId, chunk.source_id, chunk.ordinal) as { id: string } | undefined
        if (ordinalRow) replayConflict()
        this.db.prepare(`INSERT INTO knowledge_chunks (
          board_id, id, source_id, ordinal, content, content_sha256,
          character_count, byte_count, estimated_tokens, source_range_json,
          symbol_json, created_at
        ) VALUES (
          @board_id, @id, @source_id, @ordinal, @content, @content_sha256,
          @character_count, @byte_count, @estimated_tokens, @source_range_json,
          @symbol_json, @created_at
        )`).run({
          board_id: boardId,
          id: chunk.id,
          source_id: chunk.source_id,
          ordinal: chunk.ordinal,
          content: chunk.content,
          content_sha256: chunk.content_sha256,
          character_count: chunk.character_count,
          byte_count: chunk.byte_count,
          estimated_tokens: chunk.estimated_tokens,
          source_range_json: canonicalJson(chunk.source_range),
          symbol_json: chunk.symbol === null ? null : canonicalJson(chunk.symbol),
          created_at: chunk.created_at,
        })
        const retained = this.readChunk(boardId, chunk.id)
        if (!retained || !chunkCreationEqual(retained, chunk)) corruption()
        return retained
      })
      return save.immediate()
    })
  }

  getChunk(boardIdValue: number, chunkIdValue: string): KnowledgeChunk | null {
    const boardId = positiveBoardId(boardIdValue)
    const chunkId = identifier(chunkIdValue, CHUNK_ID)
    return this.readChunk(boardId, chunkId)
  }

  listChunks(boardIdValue: number, sourceIdValue: string): KnowledgeChunk[] {
    const boardId = positiveBoardId(boardIdValue)
    const sourceId = identifier(sourceIdValue, SOURCE_ID)
    if (!this.readSource(boardId, sourceId)) return []
    const rows = this.db.prepare(`SELECT * FROM knowledge_chunks
      WHERE board_id=? AND source_id=? ORDER BY ordinal, id`)
      .all(boardId, sourceId) as Record<string, unknown>[]
    return rows.map((row) => this.mapChunk(row, boardId))
  }

  putContextBuild(input: PutContextBuildInput): StoredContextBuild {
    const supplied = protectInput(() => this.validateBuildInput(input))
    return protectWrite(() => {
      const save = this.db.transaction(() => {
        this.assertBoard(supplied.board_id)
        this.assertRequestTargets(supplied.request)
        const existing = this.readBuild(supplied.board_id, supplied.id)
        if (existing) {
          if (!buildCreationEqual(existing, supplied)) replayConflict()
          return existing
        }
        this.assertBuildSourcesAndEntries(supplied)
        this.db.prepare(`INSERT INTO context_builds (
          board_id, id, request_json, request_fingerprint, source_set_json,
          source_set_fingerprint, manifest_fingerprint, usage_json,
          source_count, entry_count, status, created_at, invalidated_at
        ) VALUES (
          @board_id, @id, @request_json, @request_fingerprint, @source_set_json,
          @source_set_fingerprint, @manifest_fingerprint, @usage_json,
          @source_count, @entry_count, @status, @created_at, @invalidated_at
        )`).run({
          board_id: supplied.board_id,
          id: supplied.id,
          request_json: canonicalJson(supplied.request),
          request_fingerprint: supplied.request_fingerprint,
          source_set_json: canonicalJson(supplied.source_set),
          source_set_fingerprint: supplied.source_set_fingerprint,
          manifest_fingerprint: supplied.manifest_fingerprint,
          usage_json: canonicalJson(supplied.usage),
          source_count: supplied.source_set.length,
          entry_count: supplied.entries.length,
          status: supplied.status,
          created_at: supplied.created_at,
          invalidated_at: supplied.invalidated_at,
        })
        const insertSource = this.db.prepare(`INSERT INTO context_build_sources (
          board_id, context_build_id, source_ordinal, source_id, source_revision,
          content_sha256, freshness_state, redaction_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        supplied.source_set.forEach((source, sourceOrdinal) => {
          insertSource.run(
            supplied.board_id,
            supplied.id,
            sourceOrdinal,
            source.source_id,
            source.source_revision,
            source.content_sha256,
            source.freshness_state,
            source.redaction_state,
          )
        })
        const insertEntry = this.db.prepare(`INSERT INTO context_build_entries (
          board_id, context_build_id, candidate_ordinal, source_id, chunk_id,
          section, selected_ordinal, decision, reason, score_components_json,
          score_micros, rendering, estimated_tokens, character_count,
          source_kind, trust_class, freshness_state, redaction_state,
          normalized_locator, source_range_json, content_sha256
        ) VALUES (
          @board_id, @context_build_id, @candidate_ordinal, @source_id, @chunk_id,
          @section, @selected_ordinal, @decision, @reason, @score_components_json,
          @score_micros, @rendering, @estimated_tokens, @character_count,
          @source_kind, @trust_class, @freshness_state, @redaction_state,
          @normalized_locator, @source_range_json, @content_sha256
        )`)
        for (const entry of supplied.entries) {
          insertEntry.run({
            board_id: supplied.board_id,
            context_build_id: supplied.id,
            candidate_ordinal: entry.candidate_ordinal,
            source_id: entry.source_id,
            chunk_id: entry.chunk_id,
            section: entry.section,
            selected_ordinal: entry.selected_ordinal,
            decision: entry.decision,
            reason: entry.reason,
            score_components_json: canonicalJson(entry.score_components),
            score_micros: entry.score_micros,
            rendering: entry.rendering,
            estimated_tokens: entry.estimated_tokens,
            character_count: entry.character_count,
            source_kind: entry.source_kind,
            trust_class: entry.trust_class,
            freshness_state: entry.freshness_state,
            redaction_state: entry.redaction_state,
            normalized_locator: entry.normalized_locator,
            source_range_json: canonicalJson(entry.source_range),
            content_sha256: entry.content_sha256,
          })
        }
        const counts = this.db.prepare(`SELECT
            (SELECT COUNT(*) FROM context_build_sources
              WHERE board_id=? AND context_build_id=?) AS source_count,
            (SELECT COUNT(*) FROM context_build_entries
              WHERE board_id=? AND context_build_id=?) AS entry_count`)
          .get(
            supplied.board_id,
            supplied.id,
            supplied.board_id,
            supplied.id,
          ) as { source_count: number; entry_count: number }
        if (
          Number(counts.source_count) !== supplied.source_set.length
          || Number(counts.entry_count) !== supplied.entries.length
        ) {
          corruption()
        }
        const retained = this.readBuild(supplied.board_id, supplied.id)
        if (!retained || !buildCreationEqual(retained, supplied)) corruption()
        return retained
      })
      return save.immediate()
    })
  }

  getContextBuild(boardIdValue: number, buildIdValue: string): StoredContextBuild | null {
    const boardId = positiveBoardId(boardIdValue)
    const buildIdValueNormalized = identifier(buildIdValue, BUILD_ID)
    return this.readBuild(boardId, buildIdValueNormalized)
  }

  putContextUse(value: ContextUse): ContextUse {
    const use = protectInput(() => validateContextUse(value))
    if (
      use.outcome !== 'running'
      || use.actual_tokens !== null
      || use.completed_at !== null
    ) {
      inputFailure()
    }
    return protectWrite(() => {
      const save = this.db.transaction(() => {
        const build = this.readBuild(use.board_id, use.context_build_id)
        if (!build) scopeFailure()
        const existing = this.readUse(use.board_id, use.id)
        if (existing) {
          if (!useCreationEqual(existing, use)) replayConflict()
          return existing
        }
        if (build.status !== 'built' && build.status !== 'used') lifecycleConflict()
        if (
          use.manifest_fingerprint !== build.manifest_fingerprint
          || use.estimated_tokens !== build.usage.used_tokens
        ) {
          scopeFailure()
        }
        this.assertUseScope(use, build)
        this.db.prepare(`INSERT INTO context_uses (
          board_id, id, context_build_id, job_id, session_id, injection_ordinal,
          manifest_fingerprint, estimated_tokens, actual_tokens, cache_identity,
          outcome, injected_at, completed_at
        ) VALUES (
          @board_id, @id, @context_build_id, @job_id, @session_id,
          @injection_ordinal, @manifest_fingerprint, @estimated_tokens,
          @actual_tokens, @cache_identity, @outcome, @injected_at, @completed_at
        )`).run(use)
        const retained = this.readUse(use.board_id, use.id)
        const retainedBuild = this.readBuild(use.board_id, use.context_build_id)
        if (
          !retained
          || !useCreationEqual(retained, use)
          || retainedBuild?.status !== 'used'
        ) {
          corruption()
        }
        return retained
      })
      return save.immediate()
    })
  }

  getContextUse(boardIdValue: number, useIdValue: string): ContextUse | null {
    const boardId = positiveBoardId(boardIdValue)
    const useId = identifier(useIdValue, USE_ID)
    return this.readUse(boardId, useId)
  }

  listContextUses(boardIdValue: number, buildIdValue: string): ContextUse[] {
    const boardId = positiveBoardId(boardIdValue)
    const buildIdValueNormalized = identifier(buildIdValue, BUILD_ID)
    if (!this.readBuild(boardId, buildIdValueNormalized)) return []
    const rows = this.db.prepare(`SELECT * FROM context_uses
      WHERE board_id=? AND context_build_id=?
      ORDER BY injection_ordinal, injected_at, id`)
      .all(boardId, buildIdValueNormalized) as Record<string, unknown>[]
    return rows.map((row) => this.mapUse(row, boardId))
  }

  finishContextUse(input: FinishContextUseInput): ContextUse {
    const fields = requiredRecord(
      input,
      input && Object.prototype.hasOwnProperty.call(input, 'completed_at')
        ? ['board_id', 'context_use_id', 'outcome', 'actual_tokens', 'completed_at']
        : ['board_id', 'context_use_id', 'outcome', 'actual_tokens'],
    )
    const boardId = positiveBoardId(fields.board_id)
    const useId = identifier(fields.context_use_id, USE_ID)
    if (
      fields.outcome !== 'completed'
      && fields.outcome !== 'failed'
      && fields.outcome !== 'cancelled'
    ) {
      inputFailure()
    }
    const outcome = fields.outcome
    const actualTokens = integer(fields.actual_tokens, true)
    if (outcome === 'completed' && actualTokens === null) inputFailure()
    const suppliedCompletedAt = Object.prototype.hasOwnProperty.call(fields, 'completed_at')
      ? timestamp(fields.completed_at)
      : null
    return protectWrite(() => {
      const finish = this.db.transaction(() => {
        const retained = this.readUse(boardId, useId)
        if (!retained) scopeFailure()
        if (retained.outcome !== 'running') {
          if (
            retained.outcome !== outcome
            || retained.actual_tokens !== actualTokens
            || (
              suppliedCompletedAt !== null
              && retained.completed_at !== suppliedCompletedAt
            )
          ) {
            lifecycleConflict()
          }
          return retained
        }
        const completedAt = suppliedCompletedAt ?? new Date().toISOString()
        if (completedAt < retained.injected_at) inputFailure()
        const result = this.db.prepare(`UPDATE context_uses
          SET outcome=?, actual_tokens=?, completed_at=?
          WHERE board_id=? AND id=? AND outcome='running'`)
          .run(outcome, actualTokens, completedAt, boardId, useId)
        if (result.changes !== 1) lifecycleConflict()
        const completed = this.readUse(boardId, useId)
        if (
          !completed
          || completed.outcome !== outcome
          || completed.actual_tokens !== actualTokens
          || completed.completed_at !== completedAt
        ) {
          corruption()
        }
        return completed
      })
      return finish.immediate()
    })
  }

  private readSource(boardId: number, sourceId: string): KnowledgeSource | null {
    const row = this.db.prepare(`SELECT * FROM knowledge_sources
      WHERE board_id=? AND id=?`).get(boardId, sourceId) as Record<string, unknown> | undefined
    return row ? this.mapSource(row, boardId) : null
  }

  private mapSource(row: Record<string, unknown>, boardId: number): KnowledgeSource {
    try {
      const raw: KnowledgeSource = {
        id: String(row.id),
        source_kind: String(row.source_kind) as KnowledgeSource['source_kind'],
        trust_class: String(row.trust_class) as KnowledgeSource['trust_class'],
        title: String(row.title),
        locator: String(row.locator),
        normalized_locator: String(row.normalized_locator),
        source_revision: String(row.source_revision),
        content_sha256: String(row.content_sha256),
        freshness_policy: String(row.freshness_policy) as KnowledgeSource['freshness_policy'],
        freshness_state: String(row.freshness_state) as KnowledgeSource['freshness_state'],
        redaction_state: String(row.redaction_state) as KnowledgeSource['redaction_state'],
        content_state: String(row.content_state) as KnowledgeSource['content_state'],
        ingest_state: String(row.ingest_state) as KnowledgeSource['ingest_state'],
        access_scope: parseCanonicalJson(row.access_scope_json) as KnowledgeSource['access_scope'],
        targets: parseCanonicalJson(row.targets_json) as KnowledgeSource['targets'],
        provenance: parseCanonicalJson(row.provenance_json) as KnowledgeSource['provenance'],
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
      }
      const source = validateKnowledgeSource(raw)
      if (
        source.targets.board_id !== boardId
        || rawNumber(row.board_id) !== boardId
        || !canonicalEqual(source, raw)
      ) {
        corruption()
      }
      return source
    } catch (error) {
      if (error instanceof KnowledgeStoreError) throw error
      corruption()
    }
  }

  private readChunk(boardId: number, chunkId: string): KnowledgeChunk | null {
    const row = this.db.prepare(`SELECT * FROM knowledge_chunks
      WHERE board_id=? AND id=?`).get(boardId, chunkId) as Record<string, unknown> | undefined
    return row ? this.mapChunk(row, boardId) : null
  }

  private mapChunk(row: Record<string, unknown>, boardId: number): KnowledgeChunk {
    try {
      const raw: KnowledgeChunk = {
        id: String(row.id),
        source_id: String(row.source_id),
        ordinal: rawNumber(row.ordinal),
        content: String(row.content),
        content_sha256: String(row.content_sha256),
        character_count: rawNumber(row.character_count),
        byte_count: rawNumber(row.byte_count),
        estimated_tokens: rawNumber(row.estimated_tokens),
        source_range: parseCanonicalJson(row.source_range_json) as KnowledgeChunk['source_range'],
        symbol: row.symbol_json === null || row.symbol_json === undefined
          ? null
          : parseCanonicalJson(row.symbol_json) as KnowledgeChunk['symbol'],
        created_at: String(row.created_at),
      }
      const chunk = validateKnowledgeChunk(raw)
      const source = this.readSource(boardId, chunk.source_id)
      if (
        rawNumber(row.board_id) !== boardId
        || !source
        || source.content_state !== 'present'
        || source.redaction_state === 'withheld'
        || !canonicalEqual(chunk, raw)
      ) {
        corruption()
      }
      return chunk
    } catch (error) {
      if (error instanceof KnowledgeStoreError) throw error
      corruption()
    }
  }

  private validateBuildInput(input: PutContextBuildInput): StoredContextBuild {
    const fields = requiredRecord(input, ['build', 'request', 'source_set'])
    const build = validateContextBuild(fields.build)
    if (build.status !== 'built' || build.invalidated_at !== null) inputFailure()
    const request = validateContextRequestIdentity(fields.request)
    const sourceSet = normalizeKnowledgeSourceSet(
      fields.source_set as readonly KnowledgeSourceSetEntry[],
    )
    const entries = normalizeContextBuildEntries(build.entries)
    const requestFingerprint = contextRequestFingerprint(request)
    const sourceSetFingerprint = knowledgeSourceSetFingerprint(sourceSet)
    if (
      build.board_id !== request.board_id
      || !canonicalEqual(build.access_scope, request.access_scope)
      || !canonicalEqual(build.targets, request.targets)
      || !canonicalEqual(build.budget, request.budget)
      || build.request_fingerprint !== requestFingerprint
      || build.source_set_fingerprint !== sourceSetFingerprint
      || !canonicalEqual(entries, build.entries)
    ) {
      inputFailure()
    }
    const expectedId = contextBuildId({
      request,
      source_set_fingerprint: sourceSetFingerprint,
      manifest_fingerprint: build.manifest_fingerprint,
    })
    if (build.id !== expectedId) inputFailure()
    return { ...build, entries, request, source_set: sourceSet }
  }

  private readBuild(boardId: number, buildIdValue: string): StoredContextBuild | null {
    const row = this.db.prepare(`SELECT * FROM context_builds
      WHERE board_id=? AND id=?`).get(boardId, buildIdValue) as Record<string, unknown> | undefined
    if (!row) return null
    try {
      const requestRaw = parseCanonicalJson(row.request_json)
      const request = validateContextRequestIdentity(requestRaw)
      if (!canonicalEqual(requestRaw, request)) corruption()
      const sourceSetRaw = parseCanonicalJson(row.source_set_json)
      const sourceSet = normalizeKnowledgeSourceSet(
        sourceSetRaw as readonly KnowledgeSourceSetEntry[],
      )
      if (!canonicalEqual(sourceSetRaw, sourceSet)) corruption()
      const sourceRows = this.db.prepare(`SELECT * FROM context_build_sources
        WHERE board_id=? AND context_build_id=? ORDER BY source_ordinal`)
        .all(boardId, buildIdValue) as Record<string, unknown>[]
      const relationalSourceSet = sourceRows.map((source, sourceOrdinal) => {
        if (
          rawNumber(source.board_id) !== boardId
          || String(source.context_build_id) !== buildIdValue
          || rawNumber(source.source_ordinal) !== sourceOrdinal
        ) {
          corruption()
        }
        return {
          source_id: String(source.source_id),
          source_revision: String(source.source_revision),
          content_sha256: String(source.content_sha256),
          freshness_state: String(source.freshness_state),
          redaction_state: String(source.redaction_state),
        } as KnowledgeSourceSetEntry
      })
      const normalizedRelationalSources = normalizeKnowledgeSourceSet(relationalSourceSet)
      if (!canonicalEqual(sourceSet, normalizedRelationalSources)) corruption()
      const entryRows = this.db.prepare(`SELECT * FROM context_build_entries
        WHERE board_id=? AND context_build_id=? ORDER BY candidate_ordinal`)
        .all(boardId, buildIdValue) as Record<string, unknown>[]
      const entries = entryRows.map((entry) => ({
        source_id: String(entry.source_id),
        chunk_id: String(entry.chunk_id),
        section: String(entry.section),
        candidate_ordinal: rawNumber(entry.candidate_ordinal),
        selected_ordinal: rawNullableNumber(entry.selected_ordinal),
        decision: String(entry.decision),
        reason: String(entry.reason),
        score_components: parseCanonicalJson(entry.score_components_json),
        score_micros: rawNumber(entry.score_micros),
        rendering: String(entry.rendering),
        estimated_tokens: rawNumber(entry.estimated_tokens),
        character_count: rawNumber(entry.character_count),
        source_kind: String(entry.source_kind),
        trust_class: String(entry.trust_class),
        freshness_state: String(entry.freshness_state),
        redaction_state: String(entry.redaction_state),
        normalized_locator: String(entry.normalized_locator),
        source_range: parseCanonicalJson(entry.source_range_json),
        content_sha256: String(entry.content_sha256),
      })) as ContextBuild['entries']
      const usage = parseCanonicalJson(row.usage_json) as ContextBuild['usage']
      const raw: ContextBuild = {
        id: String(row.id),
        board_id: rawNumber(row.board_id),
        access_scope: request.access_scope,
        targets: request.targets,
        request_fingerprint: String(row.request_fingerprint),
        source_set_fingerprint: String(row.source_set_fingerprint),
        manifest_fingerprint: String(row.manifest_fingerprint),
        budget: request.budget,
        usage,
        entries,
        status: String(row.status) as ContextBuild['status'],
        created_at: String(row.created_at),
        invalidated_at: rawNullableString(row.invalidated_at),
      }
      const build = validateContextBuild(raw)
      const expectedId = contextBuildId({
        request,
        source_set_fingerprint: build.source_set_fingerprint,
        manifest_fingerprint: build.manifest_fingerprint,
      })
      if (
        build.board_id !== boardId
        || build.id !== expectedId
        || build.request_fingerprint !== contextRequestFingerprint(request)
        || build.source_set_fingerprint !== knowledgeSourceSetFingerprint(sourceSet)
        || rawNumber(row.source_count) !== sourceSet.length
        || rawNumber(row.entry_count) !== entries.length
        || !canonicalEqual(build, raw)
      ) {
        corruption()
      }
      return { ...build, request, source_set: sourceSet }
    } catch (error) {
      if (error instanceof KnowledgeStoreError) throw error
      corruption()
    }
  }

  private readUse(boardId: number, useId: string): ContextUse | null {
    const row = this.db.prepare(`SELECT * FROM context_uses
      WHERE board_id=? AND id=?`).get(boardId, useId) as Record<string, unknown> | undefined
    return row ? this.mapUse(row, boardId) : null
  }

  private mapUse(row: Record<string, unknown>, boardId: number): ContextUse {
    try {
      const raw: ContextUse = {
        id: String(row.id),
        context_build_id: String(row.context_build_id),
        board_id: rawNumber(row.board_id),
        job_id: String(row.job_id),
        session_id: String(row.session_id),
        injection_ordinal: rawNumber(row.injection_ordinal),
        manifest_fingerprint: String(row.manifest_fingerprint),
        estimated_tokens: rawNumber(row.estimated_tokens),
        actual_tokens: rawNullableNumber(row.actual_tokens),
        cache_identity: String(row.cache_identity),
        outcome: String(row.outcome) as ContextUse['outcome'],
        injected_at: String(row.injected_at),
        completed_at: rawNullableString(row.completed_at),
      }
      const use = validateContextUse(raw)
      const build = this.readBuild(boardId, use.context_build_id)
      if (
        use.board_id !== boardId
        || !build
        || use.manifest_fingerprint !== build.manifest_fingerprint
        || use.estimated_tokens !== build.usage.used_tokens
        || !canonicalEqual(use, raw)
      ) {
        corruption()
      }
      return use
    } catch (error) {
      if (error instanceof KnowledgeStoreError) throw error
      corruption()
    }
  }

  private assertBoard(boardId: number): void {
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(boardId)) scopeFailure()
  }

  private assertTargetScope(boardId: number, source: KnowledgeSource): void {
    if (source.targets.board_id !== boardId) scopeFailure()
    const target = source.targets
    if (target.workspace_id !== null) {
      const workspace = this.db.prepare(`SELECT board_id, card_id FROM workspaces
        WHERE id=?`).get(target.workspace_id) as {
          board_id: number
          card_id: number | null
        } | undefined
      if (
        !workspace
        || Number(workspace.board_id) !== boardId
        || (
          target.card_id !== null
          && workspace.card_id !== null
          && Number(workspace.card_id) !== target.card_id
        )
      ) {
        scopeFailure()
      }
    }
    if (target.card_id !== null) {
      const card = this.db.prepare('SELECT board_id FROM cards WHERE id=?')
        .get(target.card_id) as { board_id: number } | undefined
      if (!card || Number(card.board_id) !== boardId) scopeFailure()
    }
    if (target.contract_ref !== null) {
      const contract = this.db.prepare(`SELECT card.board_id, contract.version
        FROM task_contracts contract JOIN cards card ON card.id=contract.card_id
        WHERE contract.card_id=?`).get(target.card_id) as {
          board_id: number
          version: number
        } | undefined
      if (
        !contract
        || Number(contract.board_id) !== boardId
        || Number(contract.version) !== target.contract_version
      ) {
        scopeFailure()
      }
    }
    if (target.job_id !== null) {
      const job = this.db.prepare(`SELECT board_id, card_id, workspace_id FROM jobs
        WHERE id=?`).get(target.job_id) as {
          board_id: number
          card_id: number | null
          workspace_id: string | null
        } | undefined
      if (
        !job
        || Number(job.board_id) !== boardId
        || (target.card_id !== null && Number(job.card_id) !== target.card_id)
        || (
          target.workspace_id !== null
          && job.workspace_id !== null
          && job.workspace_id !== target.workspace_id
        )
      ) {
        scopeFailure()
      }
    }
    if (target.profile_id !== null) {
      const profile = this.db.prepare('SELECT board_id FROM agent_profiles WHERE id=?')
        .get(target.profile_id) as { board_id: number } | undefined
      if (!profile || Number(profile.board_id) !== boardId) scopeFailure()
    }
    if (target.session_id !== null) {
      const session = this.db.prepare(`SELECT workspace.board_id, session.job_id,
          session.profile_id, session.workspace_id
        FROM agent_sessions session
        JOIN workspaces workspace ON workspace.id=session.workspace_id
        WHERE session.id=?`).get(target.session_id) as {
          board_id: number
          job_id: string | null
          profile_id: string | null
          workspace_id: string
        } | undefined
      if (
        !session
        || Number(session.board_id) !== boardId
        || (target.job_id !== null && session.job_id !== target.job_id)
        || (target.profile_id !== null && session.profile_id !== target.profile_id)
        || (target.workspace_id !== null && session.workspace_id !== target.workspace_id)
      ) {
        scopeFailure()
      }
    }
    if (target.delivery_report_id !== null) {
      const report = this.db.prepare(`SELECT board_id, card_id, job_id, session_id, workspace_id
        FROM delivery_reports WHERE id=?`).get(target.delivery_report_id) as {
          board_id: number
          card_id: number
          job_id: string | null
          session_id: string | null
          workspace_id: string | null
        } | undefined
      if (
        !report
        || Number(report.board_id) !== boardId
        || (target.card_id !== null && Number(report.card_id) !== target.card_id)
        || (target.job_id !== null && report.job_id !== target.job_id)
        || (target.session_id !== null && report.session_id !== target.session_id)
        || (target.workspace_id !== null && report.workspace_id !== target.workspace_id)
      ) {
        scopeFailure()
      }
    }
  }

  private assertRequestTargets(request: ContextRequestIdentityInput): void {
    const pseudoSource = {
      targets: request.targets,
    } as KnowledgeSource
    this.assertTargetScope(request.board_id, pseudoSource)
  }

  private assertBuildSourcesAndEntries(build: StoredContextBuild): void {
    const sources = new Map<string, KnowledgeSource>()
    for (const snapshot of build.source_set) {
      const source = this.readSource(build.board_id, snapshot.source_id)
      if (!source) scopeFailure()
      if (
        source.source_revision !== snapshot.source_revision
        || source.content_sha256 !== snapshot.content_sha256
        || source.freshness_state !== snapshot.freshness_state
        || source.redaction_state !== snapshot.redaction_state
        || !this.sourceVisibleToRequest(source, build.request)
      ) {
        scopeFailure()
      }
      sources.set(source.id, source)
    }
    for (const entry of build.entries) {
      const source = sources.get(entry.source_id)
      if (!source) scopeFailure()
      if (
        entry.source_kind !== source.source_kind
        || entry.trust_class !== source.trust_class
        || entry.freshness_state !== source.freshness_state
        || entry.redaction_state !== source.redaction_state
        || entry.normalized_locator !== source.normalized_locator
      ) {
        scopeFailure()
      }
      if (entry.redaction_state === 'withheld') {
        if (
          entry.decision !== 'omitted'
          || entry.reason !== 'withheld'
          || this.readChunk(build.board_id, entry.chunk_id) !== null
        ) {
          scopeFailure()
        }
        continue
      }
      const chunk = this.readChunk(build.board_id, entry.chunk_id)
      if (
        !chunk
        || chunk.source_id !== entry.source_id
        || chunk.content_sha256 !== entry.content_sha256
        || !canonicalEqual(chunk.source_range, entry.source_range)
      ) {
        scopeFailure()
      }
    }
  }

  private sourceVisibleToRequest(
    source: KnowledgeSource,
    request: ContextRequestIdentityInput,
  ): boolean {
    const target = request.targets
    switch (source.access_scope.kind) {
      case 'board':
        return source.targets.board_id === request.board_id
      case 'workspace':
        return target.workspace_id === source.access_scope.workspace_id
      case 'contract':
        return target.card_id === source.access_scope.card_id
          && target.contract_version === source.access_scope.contract_version
      case 'job':
        return target.job_id === source.access_scope.job_id
      case 'profile':
        return target.profile_id === source.access_scope.profile_id
      case 'session':
        return target.session_id === source.access_scope.session_id
    }
  }

  private assertUseScope(use: ContextUse, build: StoredContextBuild): void {
    const job = this.db.prepare(`SELECT board_id, card_id, workspace_id,
        assigned_profile_id FROM jobs WHERE id=?`).get(use.job_id) as {
          board_id: number
          card_id: number | null
          workspace_id: string | null
          assigned_profile_id: string | null
        } | undefined
    const session = this.db.prepare(`SELECT workspace.board_id, session.job_id,
        session.workspace_id, session.profile_id
      FROM agent_sessions session
      JOIN workspaces workspace ON workspace.id=session.workspace_id
      WHERE session.id=?`).get(use.session_id) as {
        board_id: number
        job_id: string | null
        workspace_id: string
        profile_id: string | null
      } | undefined
    if (
      !job
      || !session
      || Number(job.board_id) !== use.board_id
      || Number(session.board_id) !== use.board_id
      || session.job_id !== use.job_id
      || (
        job.workspace_id !== null
        && session.workspace_id !== job.workspace_id
      )
    ) {
      scopeFailure()
    }
    const target = build.targets
    if (
      (target.job_id !== null && target.job_id !== use.job_id)
      || (target.session_id !== null && target.session_id !== use.session_id)
      || (target.workspace_id !== null && target.workspace_id !== session.workspace_id)
      || (target.card_id !== null && Number(job.card_id) !== target.card_id)
      || (
        target.profile_id !== null
        && target.profile_id !== session.profile_id
        && target.profile_id !== job.assigned_profile_id
      )
    ) {
      scopeFailure()
    }
  }
}

export function isKnowledgeSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

export function expectedContextUseId(use: Pick<
  ContextUse,
  'context_build_id' | 'job_id' | 'session_id' | 'injection_ordinal'
>): string {
  return contextUseId(use)
}

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalKnowledgeJson, contextUseId } from './knowledge-contracts.js'
import {
  KNOWLEDGE_COMPILER_STABLE_PREFIXES,
} from './knowledge-compiler.js'
import type {
  CompiledContextCitation,
  CompiledContextDocument,
  KnowledgeCompilationResult,
  KnowledgeSelectionRationale,
} from './knowledge-compiler-contracts.js'
import { KnowledgeStore, type StoredContextBuild } from './knowledge-store.js'
import type { ContextBuildEntry, ContextUse } from './knowledge-types.js'

export const KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION = 1 as const

const COMMIT_SHA = /^[a-f0-9]{40}$/u
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

export type KnowledgeContextBridgeKind = 'managed_job' | 'managed_follow_up' | 'ambient_session_start'

export interface KnowledgeBridgeFreshness {
  repository_head_sha: string
  adapter_index_commits: Partial<Record<'gitnexus' | 'graphify', string>>
  checked_at: string
}

export interface ManagedKnowledgeBridgeInput extends KnowledgeBridgeFreshness {
  version: typeof KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION
  job_id: string
  session_id: string
  injection_ordinal: number
}

export interface ManagedFollowUpKnowledgeBridgeInput extends ManagedKnowledgeBridgeInput {
  previous_context_use_id: string
}

export interface AmbientSessionStartKnowledgeBridgeInput extends KnowledgeBridgeFreshness {
  version: typeof KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION
  session_id: string
}

export interface ContextUseChunkReceipt {
  chunk_id: string
  source_id: string
  section: ContextBuildEntry['section']
  reason: ContextBuildEntry['reason']
  score_components: ContextBuildEntry['score_components']
  score_micros: number
  rationale: KnowledgeSelectionRationale
  estimated_tokens: number
  character_count: number
  content_sha256: string
  citation: CompiledContextCitation
}

export interface ManagedContextBridgeEnvelope {
  version: typeof KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION
  kind: 'managed_job' | 'managed_follow_up'
  classification: 'managed'
  context_build_id: string
  context_use: ContextUse
  manifest_fingerprint: string
  cache_identity: string
  estimated_tokens: number
  character_count: number
  documents: CompiledContextDocument[]
  prompt: string
  chunks: ContextUseChunkReceipt[]
}

export interface AmbientSessionStartBridgeEnvelope {
  version: typeof KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION
  kind: 'ambient_session_start'
  classification: 'ambient'
  session_id: string
  context_build_id: string
  context_use: null
  manifest_fingerprint: string
  cache_identity: string
  estimated_tokens: number
  character_count: number
  documents: CompiledContextDocument[]
  session_start_context: string
  chunks: ContextUseChunkReceipt[]
  limitation: 'ambient_context_use_is_not_fabricated_as_a_managed_job'
}

export interface CompletedContextUseReceipt {
  context_use: ContextUse
  estimated_tokens: number
  actual_tokens: number | null
  token_delta: number | null
  manifest_fingerprint: string
  chunks: Array<{
    chunk_id: string
    reason: ContextBuildEntry['reason']
    estimated_tokens: number
    content_sha256: string
  }>
}

export type KnowledgeContextBridgeErrorCode =
  | 'invalid_request'
  | 'context_invalidated'
  | 'context_evidence_mismatch'
  | 'context_lifecycle_conflict'
  | 'context_persistence_failed'

const ERROR_MESSAGES: Readonly<Record<KnowledgeContextBridgeErrorCode, string>> = {
  invalid_request: 'knowledge context bridge request is invalid',
  context_invalidated: 'knowledge context was invalidated before injection',
  context_evidence_mismatch: 'knowledge context evidence does not match current repository state',
  context_lifecycle_conflict: 'knowledge context bridge lifecycle conflicts with retained evidence',
  context_persistence_failed: 'knowledge context bridge could not persist context use',
}

export class KnowledgeContextBridgeError extends Error {
  readonly code: KnowledgeContextBridgeErrorCode

  constructor(code: KnowledgeContextBridgeErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'KnowledgeContextBridgeError'
    this.code = code
  }
}

function fail(code: KnowledgeContextBridgeErrorCode): never {
  throw new KnowledgeContextBridgeError(code)
}

function safeText(value: unknown, max = 512): string {
  if (typeof value !== 'string') fail('invalid_request')
  const normalized = value.normalize('NFC').trim()
  if (
    normalized.length === 0
    || normalized.length > max
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail('invalid_request')
  }
  return normalized
}

function timestamp(value: unknown): string {
  const retained = safeText(value, 64)
  if (!ISO_TIMESTAMP.test(retained)) fail('invalid_request')
  return retained
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('invalid_request')
  return value as number
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalKnowledgeJson(left) === canonicalKnowledgeJson(right)
}

function sameBuildEvidence(left: StoredContextBuild, right: ContextBuildLike): boolean {
  const normalize = (value: ContextBuildLike): Record<string, unknown> => {
    const { status: _status, invalidated_at: _invalidatedAt, ...evidence } = value
    return evidence
  }
  return sameJson(normalize(left), normalize(right))
}

type ContextBuildLike = KnowledgeCompilationResult['build'] & Partial<Pick<
  StoredContextBuild,
  'request' | 'source_set'
>>

function sha256(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`orchestra-agent-os:${domain}:v1\0`, 'utf8')
    .update(typeof value === 'string' ? value : canonicalKnowledgeJson(value), 'utf8')
    .digest('hex')
}

function validateFreshness(value: KnowledgeBridgeFreshness): KnowledgeBridgeFreshness {
  const head = safeText(value.repository_head_sha, 40)
  if (!COMMIT_SHA.test(head)) fail('invalid_request')
  const commits: Partial<Record<'gitnexus' | 'graphify', string>> = {}
  for (const adapter of ['gitnexus', 'graphify'] as const) {
    const supplied = value.adapter_index_commits[adapter]
    if (supplied === undefined) continue
    const commit = safeText(supplied, 40)
    if (!COMMIT_SHA.test(commit)) fail('invalid_request')
    commits[adapter] = commit
  }
  return {
    repository_head_sha: head,
    adapter_index_commits: commits,
    checked_at: timestamp(value.checked_at),
  }
}

function contentHash(document: CompiledContextDocument): string {
  return sha256('compiled-context-document', document.content)
}

function validateDocuments(result: KnowledgeCompilationResult): void {
  const kinds = ['project_brief', 'task_pack', 'working_memory_delta'] as const
  if (result.documents.length !== kinds.length) fail('context_evidence_mismatch')
  result.documents.forEach((document, index) => {
    const kind = kinds[index]
    if (
      document.kind !== kind
      || document.stable_prefix !== KNOWLEDGE_COMPILER_STABLE_PREFIXES[kind]
      || !document.content.startsWith(document.stable_prefix)
      || document.content_sha256 !== contentHash(document)
      || document.cache_key !== `kctx_v1_${document.content_sha256}`
      || document.character_count !== document.content.length
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(document.content)
    ) {
      fail('context_evidence_mismatch')
    }
  })
}

function selectedDocuments(
  kind: KnowledgeContextBridgeKind,
  result: KnowledgeCompilationResult,
): CompiledContextDocument[] {
  if (kind === 'managed_job') return [result.documents[0], result.documents[1]]
  if (kind === 'managed_follow_up') return [result.documents[2]]
  return result.previous_manifest_fingerprint === null
    ? [result.documents[0], result.documents[1]]
    : [result.documents[2]]
}

function currentAdapterIndexes(
  expected: KnowledgeCompilationResult['adapter_index_commits'],
  actual: KnowledgeBridgeFreshness['adapter_index_commits'],
): boolean {
  for (const adapter of ['gitnexus', 'graphify'] as const) {
    if (expected[adapter] !== actual[adapter]) return false
  }
  return Object.keys(actual).every((adapter) => adapter === 'gitnexus' || adapter === 'graphify')
}

function citationMap(documents: readonly CompiledContextDocument[]): Map<string, CompiledContextCitation> {
  const retained = new Map<string, CompiledContextCitation>()
  for (const document of documents) {
    for (const citation of document.citations) {
      if (retained.has(citation.chunk_id)) fail('context_evidence_mismatch')
      retained.set(citation.chunk_id, citation)
    }
  }
  return retained
}

function contextChunks(
  result: KnowledgeCompilationResult,
  build: StoredContextBuild,
  documents: readonly CompiledContextDocument[],
): ContextUseChunkReceipt[] {
  const citations = citationMap(documents)
  const rationaleByChunk = new Map(result.rationales.map((item) => [item.chunk_id, item]))
  return build.entries.filter((entry) => entry.decision === 'selected').map((entry) => {
    const citation = citations.get(entry.chunk_id)
    const rationale = rationaleByChunk.get(entry.chunk_id)
    if (
      citation === undefined
      || rationale === undefined
      || citation.source_id !== entry.source_id
      || citation.section !== entry.section
      || citation.chunk_content_sha256 !== entry.content_sha256
      || rationale.selection_reason !== entry.reason
      || rationale.score_micros !== entry.score_micros
      || !sameJson(rationale.score_components, entry.score_components)
    ) {
      fail('context_evidence_mismatch')
    }
    return {
      chunk_id: entry.chunk_id,
      source_id: entry.source_id,
      section: entry.section,
      reason: entry.reason,
      score_components: entry.score_components,
      score_micros: entry.score_micros,
      rationale,
      estimated_tokens: entry.estimated_tokens,
      character_count: entry.character_count,
      content_sha256: entry.content_sha256,
      citation,
    }
  })
}

export class KnowledgeContextBridgeService {
  private readonly store: KnowledgeStore

  constructor(private readonly db: Database.Database) {
    this.store = new KnowledgeStore(db)
  }

  private invalidate(buildId: string, boardId: number, checkedAt: string): void {
    try {
      this.db.prepare(`UPDATE context_builds
        SET status='invalidated', invalidated_at=?
        WHERE board_id=? AND id=? AND status='built' AND invalidated_at IS NULL`)
        .run(checkedAt, boardId, buildId)
    } catch {
      fail('context_persistence_failed')
    }
  }

  private verify(
    result: KnowledgeCompilationResult,
    freshnessValue: KnowledgeBridgeFreshness,
    kind: KnowledgeContextBridgeKind,
  ): {
    build: StoredContextBuild
    documents: CompiledContextDocument[]
    chunks: ContextUseChunkReceipt[]
    freshness: KnowledgeBridgeFreshness
  } {
    const freshness = validateFreshness(freshnessValue)
    const stale = freshness.repository_head_sha !== result.base_commit_sha
      || !currentAdapterIndexes(result.adapter_index_commits, freshness.adapter_index_commits)
    if (stale) {
      this.invalidate(result.build.id, result.build.board_id, freshness.checked_at)
      fail('context_invalidated')
    }
    validateDocuments(result)
    const build = this.store.getContextBuild(result.build.board_id, result.build.id)
    if (
      build === null
      || (build.status !== 'built' && build.status !== 'used')
      || !sameBuildEvidence(build, result.build)
    ) {
      fail('context_lifecycle_conflict')
    }
    const selectedEntries = build.entries.filter((entry) => entry.decision === 'selected')
    for (const entry of build.entries) {
      const source = this.store.getSource(build.board_id, entry.source_id)
      const chunk = this.store.getChunk(build.board_id, entry.chunk_id)
      if (
        source === null
        || chunk === null
        || chunk.source_id !== source.id
        || source.provenance.repository_key !== result.repository_key
        || source.provenance.base_commit_sha !== result.base_commit_sha
        || source.freshness_state !== 'fresh'
        || source.content_state !== 'present'
        || source.ingest_state !== 'active'
        || source.content_sha256
          !== build.source_set.find((item) => item.source_id === source.id)?.content_sha256
        || chunk.content_sha256 !== entry.content_sha256
        || createHash('sha256').update(chunk.content, 'utf8').digest('hex') !== chunk.content_sha256
      ) {
        this.invalidate(build.id, build.board_id, freshness.checked_at)
        fail('context_invalidated')
      }
    }
    const documents = selectedDocuments(kind, result)
    const selectedDocumentChunks = new Set(
      documents.flatMap((document) => document.citations.map((citation) => citation.chunk_id)),
    )
    if (
      selectedDocumentChunks.size !== selectedEntries.length
      || selectedEntries.some((entry) => !selectedDocumentChunks.has(entry.chunk_id))
    ) {
      fail('context_evidence_mismatch')
    }
    const estimatedTokens = documents.reduce((total, document) => total + document.estimated_tokens, 0)
    const characterCount = documents.reduce((total, document) => total + document.character_count, 0)
    if (
      estimatedTokens !== build.usage.used_tokens
      || characterCount !== build.usage.used_characters
    ) {
      fail('context_evidence_mismatch')
    }
    return {
      build,
      documents,
      chunks: contextChunks(result, build, documents),
      freshness,
    }
  }

  private managed(
    kind: 'managed_job' | 'managed_follow_up',
    result: KnowledgeCompilationResult,
    input: ManagedKnowledgeBridgeInput,
  ): ManagedContextBridgeEnvelope {
    const jobId = safeText(input.job_id)
    const sessionId = safeText(input.session_id)
    const injectionOrdinal = integer(input.injection_ordinal)
    if (input.version !== KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION) fail('invalid_request')
    const verified = this.verify(result, input, kind)
    if (
      result.build.targets.job_id !== jobId
      || result.build.targets.session_id !== sessionId
      || (kind === 'managed_job' && result.previous_manifest_fingerprint !== null)
      || (kind === 'managed_follow_up' && result.previous_manifest_fingerprint === null)
    ) {
      fail('context_evidence_mismatch')
    }
    const cacheIdentity = `kuse_v1_${sha256('knowledge-context-use-cache', {
      kind,
      manifest_fingerprint: verified.build.manifest_fingerprint,
      document_cache_keys: verified.documents.map((document) => document.cache_key),
    })}`
    const identity = {
      context_build_id: verified.build.id,
      job_id: jobId,
      session_id: sessionId,
      injection_ordinal: injectionOrdinal,
    }
    const use: ContextUse = {
      id: contextUseId(identity),
      context_build_id: verified.build.id,
      board_id: verified.build.board_id,
      job_id: jobId,
      session_id: sessionId,
      injection_ordinal: injectionOrdinal,
      manifest_fingerprint: verified.build.manifest_fingerprint,
      estimated_tokens: verified.build.usage.used_tokens,
      actual_tokens: null,
      cache_identity: cacheIdentity,
      outcome: 'running',
      injected_at: verified.freshness.checked_at,
      completed_at: null,
    }
    let retained: ContextUse
    try {
      retained = this.store.putContextUse(use)
    } catch {
      fail('context_persistence_failed')
    }
    return {
      version: KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION,
      kind,
      classification: 'managed',
      context_build_id: verified.build.id,
      context_use: retained,
      manifest_fingerprint: verified.build.manifest_fingerprint,
      cache_identity: cacheIdentity,
      estimated_tokens: verified.build.usage.used_tokens,
      character_count: verified.build.usage.used_characters,
      documents: verified.documents,
      prompt: verified.documents.map((document) => document.content).join('\n'),
      chunks: verified.chunks,
    }
  }

  prepareManagedJob(
    result: KnowledgeCompilationResult,
    input: ManagedKnowledgeBridgeInput,
  ): ManagedContextBridgeEnvelope {
    return this.managed('managed_job', result, input)
  }

  prepareManagedFollowUp(
    result: KnowledgeCompilationResult,
    input: ManagedFollowUpKnowledgeBridgeInput,
  ): ManagedContextBridgeEnvelope {
    const previousUseId = safeText(input.previous_context_use_id, 67)
    const previous = this.store.getContextUse(result.build.board_id, previousUseId)
    if (
      previous === null
      || previous.manifest_fingerprint !== result.previous_manifest_fingerprint
      || previous.session_id !== input.session_id
      || previous.job_id !== input.job_id
    ) {
      fail('context_lifecycle_conflict')
    }
    const previousBuild = this.store.getContextBuild(
      result.build.board_id,
      previous.context_build_id,
    )
    if (previousBuild === null
      || previousBuild.manifest_fingerprint !== previous.manifest_fingerprint) {
      fail('context_lifecycle_conflict')
    }
    const prepare = this.db.transaction(() => {
      const envelope = this.managed('managed_follow_up', result, input)
      const expected = {
        board_id: result.build.board_id,
        context_use_id: envelope.context_use.id,
        previous_context_use_id: previous.id,
        context_build_id: envelope.context_build_id,
        previous_context_build_id: previousBuild.id,
        created_at: envelope.context_use.injected_at,
      }
      this.db.prepare(`INSERT OR IGNORE INTO outcome_context_refresh_receipts
        (board_id, context_use_id, previous_context_use_id, context_build_id,
         previous_context_build_id, created_at)
        VALUES (@board_id, @context_use_id, @previous_context_use_id, @context_build_id,
         @previous_context_build_id, @created_at)`).run(expected)
      const retained = this.db.prepare(`SELECT * FROM outcome_context_refresh_receipts
        WHERE board_id=? AND context_use_id=?`)
        .get(expected.board_id, expected.context_use_id) as Record<string, unknown> | undefined
      if (!retained || Object.entries(expected).some(([key, value]) => retained[key] !== value)) {
        fail('context_persistence_failed')
      }
      return envelope
    })
    return prepare.immediate()
  }

  prepareAmbientSessionStart(
    result: KnowledgeCompilationResult,
    input: AmbientSessionStartKnowledgeBridgeInput,
  ): AmbientSessionStartBridgeEnvelope {
    if (input.version !== KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION) fail('invalid_request')
    const sessionId = safeText(input.session_id)
    const verified = this.verify(result, input, 'ambient_session_start')
    if (
      result.build.targets.session_id !== sessionId
      || result.build.targets.job_id !== null
    ) {
      fail('context_evidence_mismatch')
    }
    const cacheIdentity = `kambient_v1_${sha256('ambient-session-start-cache', {
      session_id: sessionId,
      manifest_fingerprint: verified.build.manifest_fingerprint,
      document_cache_keys: verified.documents.map((document) => document.cache_key),
    })}`
    return {
      version: KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION,
      kind: 'ambient_session_start',
      classification: 'ambient',
      session_id: sessionId,
      context_build_id: verified.build.id,
      context_use: null,
      manifest_fingerprint: verified.build.manifest_fingerprint,
      cache_identity: cacheIdentity,
      estimated_tokens: verified.build.usage.used_tokens,
      character_count: verified.build.usage.used_characters,
      documents: verified.documents,
      session_start_context: verified.documents.map((document) => document.content).join('\n'),
      chunks: verified.chunks,
      limitation: 'ambient_context_use_is_not_fabricated_as_a_managed_job',
    }
  }

  finishManagedContextUse(input: {
    board_id: number
    context_use_id: string
    outcome: 'completed' | 'failed' | 'cancelled'
    actual_tokens: number | null
    completed_at: string
  }): CompletedContextUseReceipt {
    const completedAt = timestamp(input.completed_at)
    let use: ContextUse
    try {
      use = this.store.finishContextUse({
        board_id: input.board_id,
        context_use_id: safeText(input.context_use_id, 67),
        outcome: input.outcome,
        actual_tokens: input.actual_tokens,
        completed_at: completedAt,
      })
    } catch {
      fail('context_persistence_failed')
    }
    const build = this.store.getContextBuild(input.board_id, use.context_build_id)
    if (build === null) fail('context_evidence_mismatch')
    return {
      context_use: use,
      estimated_tokens: use.estimated_tokens,
      actual_tokens: use.actual_tokens,
      token_delta: use.actual_tokens === null ? null : use.actual_tokens - use.estimated_tokens,
      manifest_fingerprint: use.manifest_fingerprint,
      chunks: build.entries.filter((entry) => entry.decision === 'selected').map((entry) => ({
        chunk_id: entry.chunk_id,
        reason: entry.reason,
        estimated_tokens: entry.estimated_tokens,
        content_sha256: entry.content_sha256,
      })),
    }
  }
}

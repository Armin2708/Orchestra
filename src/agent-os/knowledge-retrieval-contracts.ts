import { createHash } from 'node:crypto'
import {
  KNOWLEDGE_SOURCE_KINDS,
  KNOWLEDGE_TRUST_CLASSES,
} from './knowledge-types.js'
import type {
  KnowledgeAccessScope,
  KnowledgeContentState,
  KnowledgeFreshnessPolicy,
  KnowledgeFreshnessState,
  KnowledgeIngestState,
  KnowledgeRedactionState,
  KnowledgeSourceKind,
  KnowledgeSourceRange,
  KnowledgeSymbolReference,
  KnowledgeTargetLinks,
  KnowledgeTrustClass,
  RepositoryProvenance,
} from './knowledge-types.js'
import {
  canonicalKnowledgeJson,
  knowledgeChunkId,
  knowledgeSourceId,
  normalizeKnowledgeLocator,
  validateKnowledgeAccessScope,
  validateKnowledgeSourceRange,
  validateKnowledgeTargetLinks,
  validateRepositoryProvenance,
} from './knowledge-contracts.js'

export const KNOWLEDGE_RETRIEVAL_CONTRACT_VERSION = 1 as const
export const MAX_KNOWLEDGE_RETRIEVAL_RESULTS = 50
export const MAX_KNOWLEDGE_RETRIEVAL_QUERY_CHARACTERS = 256
export const MAX_KNOWLEDGE_RETRIEVAL_QUERY_TERMS = 16

const MAX_FILTER_VALUES = 64
const MAX_FILTER_TEXT_CHARACTERS = 4_096
const MAX_REVISION_CHARACTERS = 512
const MAX_IDENTIFIER_CHARACTERS = 256
const MAX_RESULT_BYTES = 8_000_000
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const SOURCE_ID = /^ks_[a-f0-9]{64}$/u
const CHUNK_ID = /^kc_[a-f0-9]{64}$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const QUERY_TERM = /^[\p{L}\p{N}_./:@+-]+$/u
const SOURCE_KIND_SET = new Set<string>(KNOWLEDGE_SOURCE_KINDS)
const TRUST_CLASS_SET = new Set<string>(KNOWLEDGE_TRUST_CLASSES)
const FRESHNESS_POLICY_SET = new Set<string>([
  'commit_exact',
  'path_hash',
  'external_revision',
  'manual_until_superseded',
])
const SAFE_FRESHNESS_STATE_SET = new Set<string>(['fresh'])
const SAFE_REDACTION_STATE_SET = new Set<string>(['none', 'redacted'])
const SAFE_CONTENT_STATE_SET = new Set<string>(['present'])
const SAFE_INGEST_STATE_SET = new Set<string>(['active'])

export type KnowledgeRetrievalContractErrorCode =
  | 'invalid_request'
  | 'invalid_result'
  | 'invalid_query'
  | 'unsafe_state_filter'
  | 'duplicate_filter'
  | 'scope_invalid'

const ERROR_MESSAGES: Readonly<Record<KnowledgeRetrievalContractErrorCode, string>> = {
  invalid_request: 'knowledge retrieval request is invalid',
  invalid_result: 'knowledge retrieval result is invalid',
  invalid_query: 'knowledge retrieval query is invalid',
  unsafe_state_filter: 'knowledge retrieval state filter is unsafe',
  duplicate_filter: 'knowledge retrieval filter contains a duplicate',
  scope_invalid: 'knowledge retrieval scope is invalid',
}

/**
 * Retrieval contract errors expose only stable codes and fixed field names.
 * Query text, source content, locators, and credentials are never reflected.
 */
export class KnowledgeRetrievalContractError extends TypeError {
  readonly code: KnowledgeRetrievalContractErrorCode
  readonly field: string | null

  constructor(code: KnowledgeRetrievalContractErrorCode, field: string | null = null) {
    super(field === null ? ERROR_MESSAGES[code] : `${ERROR_MESSAGES[code]} (${field})`)
    this.name = 'KnowledgeRetrievalContractError'
    this.code = code
    this.field = field
  }
}

export interface KnowledgeRetrievalRequest {
  version: typeof KNOWLEDGE_RETRIEVAL_CONTRACT_VERSION
  board_id: number
  access_scope: KnowledgeAccessScope
  targets: KnowledgeTargetLinks
  repository_key: string
  base_commit_sha: string
  source_revisions: string[]
  source_kinds: KnowledgeSourceKind[]
  freshness_states: KnowledgeFreshnessState[]
  redaction_states: KnowledgeRedactionState[]
  content_states: KnowledgeContentState[]
  ingest_states: KnowledgeIngestState[]
  paths: string[]
  path_prefixes: string[]
  symbols: string[]
  query: string
  limit: number
}

export interface KnowledgeRetrievalCitation {
  board_id: number
  source_id: string
  chunk_id: string
  source_kind: KnowledgeSourceKind
  trust_class: KnowledgeTrustClass
  title: string
  locator: string
  normalized_locator: string
  repository_key: string
  base_commit_sha: string
  source_revision: string
  source_content_sha256: string
  freshness_policy: KnowledgeFreshnessPolicy
  freshness_state: KnowledgeFreshnessState
  redaction_state: KnowledgeRedactionState
  content_state: KnowledgeContentState
  ingest_state: KnowledgeIngestState
  access_scope: KnowledgeAccessScope
  targets: KnowledgeTargetLinks
  ordinal: number
  chunk_content_sha256: string
  character_count: number
  byte_count: number
  estimated_tokens: number
  source_range: KnowledgeSourceRange
  symbol: KnowledgeSymbolReference | null
  provenance: RepositoryProvenance
}

export interface KnowledgeRetrievalMatch {
  rank: number
  relevance_micros: number
  content: string
  content_trust: 'untrusted_data'
  citation: KnowledgeRetrievalCitation
}

export interface KnowledgeRetrievalResult {
  version: typeof KNOWLEDGE_RETRIEVAL_CONTRACT_VERSION
  request_sha256: string
  normalized_query: string
  index_snapshot_sha256: string
  results: KnowledgeRetrievalMatch[]
}

function contractError(
  code: KnowledgeRetrievalContractErrorCode,
  field: string | null = null,
): never {
  throw new KnowledgeRetrievalContractError(code, field)
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function materialize(
  value: unknown,
  code: KnowledgeRetrievalContractErrorCode,
  field: string,
  result = false,
): unknown {
  try {
    const serialized = canonicalKnowledgeJson(value, {
      max_depth: 16,
      max_nodes: 20_000,
      max_string_characters: 2_000_000,
      max_serialized_bytes: result ? MAX_RESULT_BYTES : 64_000,
    })
    return JSON.parse(serialized) as unknown
  } catch {
    contractError(code, field)
  }
}

function record(
  value: unknown,
  code: KnowledgeRetrievalContractErrorCode,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    contractError(code, field)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: KnowledgeRetrievalContractErrorCode,
  field: string,
): void {
  const actual = Object.keys(value).sort(compareCodeUnits)
  const wanted = [...expected].sort(compareCodeUnits)
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    contractError(code, field)
  }
}

function integer(
  value: unknown,
  code: KnowledgeRetrievalContractErrorCode,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum
  ) {
    contractError(code, field)
  }
  return Number(value)
}

function safeText(
  value: unknown,
  code: KnowledgeRetrievalContractErrorCode,
  field: string,
  maximum = MAX_FILTER_TEXT_CHARACTERS,
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || CONTROL_CHARACTERS.test(value)
  ) {
    contractError(code, field)
  }
  return value
}

function sha256(
  value: unknown,
  code: KnowledgeRetrievalContractErrorCode,
  field: string,
): string {
  if (typeof value !== 'string' || !SHA256.test(value)) contractError(code, field)
  return value
}

function identifier(
  value: unknown,
  expression: RegExp,
  code: KnowledgeRetrievalContractErrorCode,
  field: string,
): string {
  if (typeof value !== 'string' || !expression.test(value)) contractError(code, field)
  return value
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  code: KnowledgeRetrievalContractErrorCode,
  field: string,
): T {
  if (typeof value !== 'string' || !allowed.has(value)) contractError(code, field)
  return value as T
}

function sortedUniqueStrings<T extends string>(
  value: unknown,
  field: string,
  allowed?: ReadonlySet<string>,
  minimum = 0,
  maximumCharacters = MAX_FILTER_TEXT_CHARACTERS,
): T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_FILTER_VALUES) {
    contractError('invalid_request', field)
  }
  const output = value.map((entry) => {
    const text = safeText(entry, 'invalid_request', field, maximumCharacters)
    if (allowed && !allowed.has(text)) contractError('invalid_request', field)
    return text as T
  }).sort(compareCodeUnits)
  for (let index = 1; index < output.length; index += 1) {
    if (output[index - 1] === output[index]) contractError('duplicate_filter', field)
  }
  return output
}

function safeStateFilter<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILTER_VALUES) {
    contractError('invalid_request', field)
  }
  const output = value.map((entry) => {
    if (typeof entry !== 'string' || !allowed.has(entry)) {
      contractError('unsafe_state_filter', field)
    }
    return entry as T
  }).sort(compareCodeUnits)
  for (let index = 1; index < output.length; index += 1) {
    if (output[index - 1] === output[index]) contractError('duplicate_filter', field)
  }
  return output
}

function normalizePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_FILTER_VALUES) {
    contractError('invalid_request', field)
  }
  const output = value.map((entry) => {
    try {
      return normalizeKnowledgeLocator(
        safeText(entry, 'invalid_request', field, MAX_FILTER_TEXT_CHARACTERS),
      )
    } catch {
      contractError('invalid_request', field)
    }
  }).sort(compareCodeUnits)
  for (let index = 1; index < output.length; index += 1) {
    if (output[index - 1] === output[index]) contractError('duplicate_filter', field)
  }
  return output
}

function normalizedQuery(value: unknown): string {
  const query = safeText(
    value,
    'invalid_query',
    'query',
    MAX_KNOWLEDGE_RETRIEVAL_QUERY_CHARACTERS,
  )
  if (
    query.normalize('NFKC') !== query
    || Buffer.byteLength(query, 'utf8') > MAX_KNOWLEDGE_RETRIEVAL_QUERY_CHARACTERS * 4
    || query.includes('  ')
  ) {
    contractError('invalid_query', 'query')
  }
  const terms = query.split(' ')
  if (
    terms.length === 0
    || terms.length > MAX_KNOWLEDGE_RETRIEVAL_QUERY_TERMS
    || terms.some((term) => term.length === 0 || term.length > 64 || !QUERY_TERM.test(term))
  ) {
    contractError('invalid_query', 'query')
  }
  return terms.join(' ')
}

function scopeAndTargets(
  accessScopeValue: unknown,
  targetsValue: unknown,
  boardId: number,
  code: KnowledgeRetrievalContractErrorCode,
): { access_scope: KnowledgeAccessScope; targets: KnowledgeTargetLinks } {
  try {
    const accessScope = validateKnowledgeAccessScope(accessScopeValue)
    const targets = validateKnowledgeTargetLinks(targetsValue)
    if (
      targets.board_id !== boardId
      || (
        accessScope.kind === 'workspace'
        && targets.workspace_id !== accessScope.workspace_id
      )
      || (
        accessScope.kind === 'contract'
        && (
          targets.card_id !== accessScope.card_id
          || targets.contract_version !== accessScope.contract_version
        )
      )
      || (accessScope.kind === 'job' && targets.job_id !== accessScope.job_id)
      || (accessScope.kind === 'profile' && targets.profile_id !== accessScope.profile_id)
      || (accessScope.kind === 'session' && targets.session_id !== accessScope.session_id)
    ) {
      contractError('scope_invalid', 'scope_targets')
    }
    return { access_scope: accessScope, targets }
  } catch (error) {
    if (error instanceof KnowledgeRetrievalContractError) throw error
    contractError(code === 'invalid_result' ? 'invalid_result' : 'scope_invalid', 'scope_targets')
  }
}

export function validateKnowledgeRetrievalRequest(
  value: unknown,
): KnowledgeRetrievalRequest {
  const input = record(
    materialize(value, 'invalid_request', 'request'),
    'invalid_request',
    'request',
  )
  exactKeys(input, [
    'version',
    'board_id',
    'access_scope',
    'targets',
    'repository_key',
    'base_commit_sha',
    'source_revisions',
    'source_kinds',
    'freshness_states',
    'redaction_states',
    'content_states',
    'ingest_states',
    'paths',
    'path_prefixes',
    'symbols',
    'query',
    'limit',
  ], 'invalid_request', 'request')
  if (input.version !== KNOWLEDGE_RETRIEVAL_CONTRACT_VERSION) {
    contractError('invalid_request', 'version')
  }
  const boardId = integer(input.board_id, 'invalid_request', 'board_id', 1)
  const scoped = scopeAndTargets(
    input.access_scope,
    input.targets,
    boardId,
    'invalid_request',
  )
  if (typeof input.base_commit_sha !== 'string' || !COMMIT_SHA.test(input.base_commit_sha)) {
    contractError('invalid_request', 'base_commit_sha')
  }
  return {
    version: KNOWLEDGE_RETRIEVAL_CONTRACT_VERSION,
    board_id: boardId,
    access_scope: scoped.access_scope,
    targets: scoped.targets,
    repository_key: safeText(
      input.repository_key,
      'invalid_request',
      'repository_key',
      MAX_IDENTIFIER_CHARACTERS,
    ),
    base_commit_sha: input.base_commit_sha,
    source_revisions: sortedUniqueStrings(
      input.source_revisions,
      'source_revisions',
      undefined,
      0,
      MAX_REVISION_CHARACTERS,
    ),
    source_kinds: sortedUniqueStrings<KnowledgeSourceKind>(
      input.source_kinds,
      'source_kinds',
      SOURCE_KIND_SET,
      1,
      MAX_IDENTIFIER_CHARACTERS,
    ),
    freshness_states: safeStateFilter<KnowledgeFreshnessState>(
      input.freshness_states,
      'freshness_states',
      SAFE_FRESHNESS_STATE_SET,
    ),
    redaction_states: safeStateFilter<KnowledgeRedactionState>(
      input.redaction_states,
      'redaction_states',
      SAFE_REDACTION_STATE_SET,
    ),
    content_states: safeStateFilter<KnowledgeContentState>(
      input.content_states,
      'content_states',
      SAFE_CONTENT_STATE_SET,
    ),
    ingest_states: safeStateFilter<KnowledgeIngestState>(
      input.ingest_states,
      'ingest_states',
      SAFE_INGEST_STATE_SET,
    ),
    paths: normalizePaths(input.paths, 'paths'),
    path_prefixes: normalizePaths(input.path_prefixes, 'path_prefixes'),
    symbols: sortedUniqueStrings(
      input.symbols,
      'symbols',
      undefined,
      0,
      MAX_FILTER_TEXT_CHARACTERS,
    ),
    query: normalizedQuery(input.query),
    limit: integer(
      input.limit,
      'invalid_request',
      'limit',
      1,
      MAX_KNOWLEDGE_RETRIEVAL_RESULTS,
    ),
  }
}

export function knowledgeRetrievalRequestHash(
  requestValue: KnowledgeRetrievalRequest,
): string {
  const request = validateKnowledgeRetrievalRequest(requestValue)
  return createHash('sha256')
    .update('orchestra-agent-os:knowledge-retrieval-request:v1\0', 'utf8')
    .update(canonicalKnowledgeJson(request), 'utf8')
    .digest('hex')
}

export function knowledgeRetrievalFtsExpression(queryValue: string): string {
  const query = normalizedQuery(queryValue)
  return query.split(' ').map((term) => `"${term}"`).join(' AND ')
}

export function sourceVisibleToKnowledgeRetrievalRequest(
  accessScope: KnowledgeAccessScope,
  targets: KnowledgeTargetLinks,
  request: KnowledgeRetrievalRequest,
): boolean {
  if (targets.board_id !== request.board_id) return false
  switch (accessScope.kind) {
    case 'board':
      return true
    case 'workspace':
      return request.targets.workspace_id === accessScope.workspace_id
    case 'contract':
      return request.targets.card_id === accessScope.card_id
        && request.targets.contract_version === accessScope.contract_version
    case 'job':
      return request.targets.job_id === accessScope.job_id
    case 'profile':
      return request.targets.profile_id === accessScope.profile_id
    case 'session':
      return request.targets.session_id === accessScope.session_id
  }
}

function symbol(value: unknown): KnowledgeSymbolReference | null {
  if (value === null) return null
  const input = record(value, 'invalid_result', 'symbol')
  exactKeys(
    input,
    ['language', 'qualified_name', 'symbol_kind', 'signature_sha256'],
    'invalid_result',
    'symbol',
  )
  return {
    language: safeText(input.language, 'invalid_result', 'symbol.language', 256),
    qualified_name: safeText(
      input.qualified_name,
      'invalid_result',
      'symbol.qualified_name',
      MAX_FILTER_TEXT_CHARACTERS,
    ),
    symbol_kind: safeText(input.symbol_kind, 'invalid_result', 'symbol.symbol_kind', 256),
    signature_sha256: input.signature_sha256 === null
      ? null
      : sha256(input.signature_sha256, 'invalid_result', 'symbol.signature_sha256'),
  }
}

function citation(
  value: unknown,
  content: string,
): KnowledgeRetrievalCitation {
  const input = record(value, 'invalid_result', 'citation')
  exactKeys(input, [
    'board_id',
    'source_id',
    'chunk_id',
    'source_kind',
    'trust_class',
    'title',
    'locator',
    'normalized_locator',
    'repository_key',
    'base_commit_sha',
    'source_revision',
    'source_content_sha256',
    'freshness_policy',
    'freshness_state',
    'redaction_state',
    'content_state',
    'ingest_state',
    'access_scope',
    'targets',
    'ordinal',
    'chunk_content_sha256',
    'character_count',
    'byte_count',
    'estimated_tokens',
    'source_range',
    'symbol',
    'provenance',
  ], 'invalid_result', 'citation')
  const boardId = integer(input.board_id, 'invalid_result', 'citation.board_id', 1)
  const scoped = scopeAndTargets(
    input.access_scope,
    input.targets,
    boardId,
    'invalid_result',
  )
  let provenance: RepositoryProvenance
  let sourceRange: KnowledgeSourceRange
  try {
    provenance = validateRepositoryProvenance(input.provenance)
    sourceRange = validateKnowledgeSourceRange(input.source_range)
  } catch {
    contractError('invalid_result', 'citation')
  }
  const sourceKind = enumValue<KnowledgeSourceKind>(
    input.source_kind,
    SOURCE_KIND_SET,
    'invalid_result',
    'citation.source_kind',
  )
  const locator = safeText(
    input.locator,
    'invalid_result',
    'citation.locator',
    MAX_FILTER_TEXT_CHARACTERS,
  )
  let normalizedLocator: string
  try {
    normalizedLocator = normalizeKnowledgeLocator(locator)
  } catch {
    contractError('invalid_result', 'citation.normalized_locator')
  }
  if (normalizedLocator !== input.normalized_locator) {
    contractError('invalid_result', 'citation.normalized_locator')
  }
  const repositoryKey = safeText(
    input.repository_key,
    'invalid_result',
    'citation.repository_key',
    MAX_IDENTIFIER_CHARACTERS,
  )
  if (
    typeof input.base_commit_sha !== 'string'
    || !COMMIT_SHA.test(input.base_commit_sha)
    || provenance.repository_key !== repositoryKey
    || provenance.base_commit_sha !== input.base_commit_sha
  ) {
    contractError('invalid_result', 'citation.provenance')
  }
  const sourceRevision = safeText(
    input.source_revision,
    'invalid_result',
    'citation.source_revision',
    MAX_REVISION_CHARACTERS,
  )
  const sourceContentSha256 = sha256(
    input.source_content_sha256,
    'invalid_result',
    'citation.source_content_sha256',
  )
  const sourceId = identifier(
    input.source_id,
    SOURCE_ID,
    'invalid_result',
    'citation.source_id',
  )
  if (sourceId !== knowledgeSourceId({
    repository_key: repositoryKey,
    source_kind: sourceKind,
    normalized_locator: normalizedLocator,
    source_revision: sourceRevision,
    content_sha256: sourceContentSha256,
  })) {
    contractError('invalid_result', 'citation.source_id')
  }
  const ordinal = integer(input.ordinal, 'invalid_result', 'citation.ordinal', 0)
  const chunkContentSha256 = sha256(
    input.chunk_content_sha256,
    'invalid_result',
    'citation.chunk_content_sha256',
  )
  if (
    createHash('sha256').update(content, 'utf8').digest('hex') !== chunkContentSha256
    || integer(
      input.character_count,
      'invalid_result',
      'citation.character_count',
      0,
      2_000_000,
    ) !== content.length
    || integer(
      input.byte_count,
      'invalid_result',
      'citation.byte_count',
      0,
      8_000_000,
    ) !== Buffer.byteLength(content, 'utf8')
  ) {
    contractError('invalid_result', 'citation.content')
  }
  const chunkId = identifier(
    input.chunk_id,
    CHUNK_ID,
    'invalid_result',
    'citation.chunk_id',
  )
  if (chunkId !== knowledgeChunkId({
    source_id: sourceId,
    ordinal,
    content_sha256: chunkContentSha256,
    source_range: sourceRange,
  })) {
    contractError('invalid_result', 'citation.chunk_id')
  }
  return {
    board_id: boardId,
    source_id: sourceId,
    chunk_id: chunkId,
    source_kind: sourceKind,
    trust_class: enumValue<KnowledgeTrustClass>(
      input.trust_class,
      TRUST_CLASS_SET,
      'invalid_result',
      'citation.trust_class',
    ),
    title: safeText(
      input.title,
      'invalid_result',
      'citation.title',
      MAX_FILTER_TEXT_CHARACTERS,
    ),
    locator,
    normalized_locator: normalizedLocator,
    repository_key: repositoryKey,
    base_commit_sha: input.base_commit_sha,
    source_revision: sourceRevision,
    source_content_sha256: sourceContentSha256,
    freshness_policy: enumValue<KnowledgeFreshnessPolicy>(
      input.freshness_policy,
      FRESHNESS_POLICY_SET,
      'invalid_result',
      'citation.freshness_policy',
    ),
    freshness_state: enumValue<KnowledgeFreshnessState>(
      input.freshness_state,
      SAFE_FRESHNESS_STATE_SET,
      'invalid_result',
      'citation.freshness_state',
    ),
    redaction_state: enumValue<KnowledgeRedactionState>(
      input.redaction_state,
      SAFE_REDACTION_STATE_SET,
      'invalid_result',
      'citation.redaction_state',
    ),
    content_state: enumValue<KnowledgeContentState>(
      input.content_state,
      SAFE_CONTENT_STATE_SET,
      'invalid_result',
      'citation.content_state',
    ),
    ingest_state: enumValue<KnowledgeIngestState>(
      input.ingest_state,
      SAFE_INGEST_STATE_SET,
      'invalid_result',
      'citation.ingest_state',
    ),
    access_scope: scoped.access_scope,
    targets: scoped.targets,
    ordinal,
    chunk_content_sha256: chunkContentSha256,
    character_count: content.length,
    byte_count: Buffer.byteLength(content, 'utf8'),
    estimated_tokens: integer(
      input.estimated_tokens,
      'invalid_result',
      'citation.estimated_tokens',
      0,
      10_000_000,
    ),
    source_range: sourceRange,
    symbol: symbol(input.symbol),
    provenance,
  }
}

function pathMatchesRequest(locator: string, request: KnowledgeRetrievalRequest): boolean {
  if (request.paths.length === 0 && request.path_prefixes.length === 0) return true
  return request.paths.includes(locator)
    || request.path_prefixes.some((prefix) => locator.startsWith(prefix))
}

function citationMatchesRequest(
  value: KnowledgeRetrievalCitation,
  request: KnowledgeRetrievalRequest,
): boolean {
  return value.board_id === request.board_id
    && value.repository_key === request.repository_key
    && value.base_commit_sha === request.base_commit_sha
    && (
      request.source_revisions.length === 0
      || request.source_revisions.includes(value.source_revision)
    )
    && request.source_kinds.includes(value.source_kind)
    && request.freshness_states.includes(value.freshness_state)
    && request.redaction_states.includes(value.redaction_state)
    && request.content_states.includes(value.content_state)
    && request.ingest_states.includes(value.ingest_state)
    && pathMatchesRequest(value.normalized_locator, request)
    && (
      request.symbols.length === 0
      || (
        value.symbol !== null
        && request.symbols.includes(value.symbol.qualified_name)
      )
    )
    && sourceVisibleToKnowledgeRetrievalRequest(
      value.access_scope,
      value.targets,
      request,
    )
}

export function validateKnowledgeRetrievalResult(
  value: unknown,
  requestValue?: KnowledgeRetrievalRequest,
): KnowledgeRetrievalResult {
  const input = record(
    materialize(value, 'invalid_result', 'result', true),
    'invalid_result',
    'result',
  )
  exactKeys(
    input,
    [
      'version',
      'request_sha256',
      'normalized_query',
      'index_snapshot_sha256',
      'results',
    ],
    'invalid_result',
    'result',
  )
  if (input.version !== KNOWLEDGE_RETRIEVAL_CONTRACT_VERSION) {
    contractError('invalid_result', 'version')
  }
  const request = requestValue === undefined
    ? undefined
    : validateKnowledgeRetrievalRequest(requestValue)
  const query = normalizedQuery(input.normalized_query)
  if (!Array.isArray(input.results) || input.results.length > MAX_KNOWLEDGE_RETRIEVAL_RESULTS) {
    contractError('invalid_result', 'results')
  }
  const matches = input.results.map((entry, index): KnowledgeRetrievalMatch => {
    const match = record(entry, 'invalid_result', 'match')
    exactKeys(
      match,
      ['rank', 'relevance_micros', 'content', 'content_trust', 'citation'],
      'invalid_result',
      'match',
    )
    if (match.content_trust !== 'untrusted_data' || typeof match.content !== 'string') {
      contractError('invalid_result', 'match.content')
    }
    const content = match.content
    if (
      content.length === 0
      || content.length > 2_000_000
      || Buffer.byteLength(content, 'utf8') > 8_000_000
    ) {
      contractError('invalid_result', 'match.content')
    }
    const retained: KnowledgeRetrievalMatch = {
      rank: integer(match.rank, 'invalid_result', 'match.rank', 1),
      relevance_micros: integer(
        match.relevance_micros,
        'invalid_result',
        'match.relevance_micros',
        0,
        1_000_000_000_000,
      ),
      content,
      content_trust: 'untrusted_data',
      citation: citation(match.citation, content),
    }
    if (retained.rank !== index + 1) contractError('invalid_result', 'match.rank')
    return retained
  })
  const seenChunks = new Set<string>()
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index]
    if (seenChunks.has(current.citation.chunk_id)) {
      contractError('invalid_result', 'results')
    }
    seenChunks.add(current.citation.chunk_id)
    if (index > 0) {
      const previous = matches[index - 1]
      const invalidScoreOrder = previous.relevance_micros < current.relevance_micros
      const invalidSourceTie = previous.relevance_micros === current.relevance_micros
        && compareCodeUnits(
          previous.citation.source_id,
          current.citation.source_id,
        ) > 0
      const invalidChunkTie = previous.relevance_micros === current.relevance_micros
        && previous.citation.source_id === current.citation.source_id
        && compareCodeUnits(
          previous.citation.chunk_id,
          current.citation.chunk_id,
        ) > 0
      if (invalidScoreOrder || invalidSourceTie || invalidChunkTie) {
        contractError('invalid_result', 'results')
      }
    }
  }
  const output: KnowledgeRetrievalResult = {
    version: KNOWLEDGE_RETRIEVAL_CONTRACT_VERSION,
    request_sha256: sha256(
      input.request_sha256,
      'invalid_result',
      'request_sha256',
    ),
    normalized_query: query,
    index_snapshot_sha256: sha256(
      input.index_snapshot_sha256,
      'invalid_result',
      'index_snapshot_sha256',
    ),
    results: matches,
  }
  if (
    request
    && (
      output.request_sha256 !== knowledgeRetrievalRequestHash(request)
      || output.normalized_query !== request.query
      || output.results.length > request.limit
      || output.results.some((match) => !citationMatchesRequest(match.citation, request))
    )
  ) {
    contractError('invalid_result', 'request_binding')
  }
  return output
}

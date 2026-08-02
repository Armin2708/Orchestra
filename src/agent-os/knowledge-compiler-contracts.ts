import { createHash } from 'node:crypto'
import {
  canonicalKnowledgeJson,
  validateContextBudget,
  validateKnowledgeAccessScope,
  validateKnowledgeTargetLinks,
} from './knowledge-contracts.js'
import type { KnowledgeGraphSignal } from './knowledge-graph-adapters.js'
import type { KnowledgeRetrievalCitation } from './knowledge-retrieval-contracts.js'
import {
  CONTEXT_SECTIONS,
  type ContextBudget,
  type ContextBuild,
  type ContextBuildEntry,
  type ContextSection,
  type KnowledgeAccessScope,
  type KnowledgeTargetLinks,
} from './knowledge-types.js'

export const KNOWLEDGE_COMPILER_CONTRACT_VERSION = 1 as const
export const MAX_KNOWLEDGE_COMPILER_BUDGET_TOKENS = 64_000
export const MAX_KNOWLEDGE_COMPILER_BUDGET_CHARACTERS = 1_000_000
export const MAX_KNOWLEDGE_COMPILER_CRITERIA = 64
export const MAX_KNOWLEDGE_COMPILER_PATHS = 64
export const MAX_KNOWLEDGE_COMPILER_SYMBOLS = 64
export const MAX_KNOWLEDGE_COMPILER_RECENT_WORK = 32
export const MAX_KNOWLEDGE_COMPILER_RETRIEVAL_QUERIES = 8

const COMMIT_SHA = /^[a-f0-9]{40}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const STABLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\p{L}\p{N}._/@+,:= -]+$/u

export interface KnowledgeTaskCriterion {
  id: string
  text: string
  required: boolean
}

export interface KnowledgeRecentWork {
  source_location: string
  revision: string
  summary: string
}

export interface KnowledgeTaskDescriptor {
  objective: string
  criteria: KnowledgeTaskCriterion[]
  files: string[]
  symbols: string[]
  recent_work: KnowledgeRecentWork[]
}

export interface PreviousContextIdentity {
  manifest_fingerprint: string
  selected_chunk_ids: string[]
}

export interface KnowledgeCompilationRequest {
  version: typeof KNOWLEDGE_COMPILER_CONTRACT_VERSION
  board_id: number
  access_scope: KnowledgeAccessScope
  targets: KnowledgeTargetLinks
  repository_key: string
  base_commit_sha: string
  task: KnowledgeTaskDescriptor
  budget: ContextBudget
  pinned_chunk_ids: string[]
  adapter_signals: KnowledgeGraphSignal[]
  previous_context: PreviousContextIdentity | null
  created_at: string
}

export type KnowledgeMatchDimension =
  | 'objective'
  | 'criterion'
  | 'file'
  | 'symbol'
  | 'recent_work'
  | 'graph_signal'

export interface KnowledgeSelectionRationale {
  chunk_id: string
  section: ContextSection
  dimensions: KnowledgeMatchDimension[]
  matched_criterion_ids: string[]
  matched_files: string[]
  matched_symbols: string[]
  adapter_evidence_sha256: string[]
  selection_reason: ContextBuildEntry['reason']
  score_components: ContextBuildEntry['score_components']
  score_micros: number
  estimated_tokens: number
}

export type CompiledContextDocumentKind = 'project_brief' | 'task_pack' | 'working_memory_delta'

export interface CompiledContextCitation {
  ordinal: number
  chunk_id: string
  source_id: string
  section: ContextSection
  source_location: string
  source_revision: string
  source_content_sha256: string
  chunk_content_sha256: string
  source_range: KnowledgeRetrievalCitation['source_range']
  provenance: KnowledgeRetrievalCitation['provenance']
}

export interface CompiledContextDocument {
  kind: CompiledContextDocumentKind
  stable_prefix: string
  cache_key: string
  content_sha256: string
  estimated_tokens: number
  character_count: number
  content: string
  citations: CompiledContextCitation[]
}

export interface CompiledSectionUsage {
  used_tokens: number
  used_characters: number
  wrapper_tokens: number
  wrapper_characters: number
}

export interface KnowledgeCompilationResult {
  version: typeof KNOWLEDGE_COMPILER_CONTRACT_VERSION
  repository_key: string
  base_commit_sha: string
  adapter_index_commits: Partial<Record<'gitnexus' | 'graphify', string>>
  previous_manifest_fingerprint: string | null
  build: ContextBuild
  documents: [CompiledContextDocument, CompiledContextDocument, CompiledContextDocument]
  section_usage: Record<ContextSection, CompiledSectionUsage>
  rationales: KnowledgeSelectionRationale[]
  retrieval_request_sha256: string[]
  redaction_count: number
}

export type KnowledgeCompilerContractErrorCode =
  | 'invalid_request'
  | 'budget_invalid'
  | 'scope_invalid'
  | 'duplicate_identity'

const ERROR_MESSAGES: Readonly<Record<KnowledgeCompilerContractErrorCode, string>> = {
  invalid_request: 'knowledge compiler request is invalid',
  budget_invalid: 'knowledge compiler budget is invalid',
  scope_invalid: 'knowledge compiler scope is invalid',
  duplicate_identity: 'knowledge compiler request contains a duplicate identity',
}

export class KnowledgeCompilerContractError extends TypeError {
  readonly code: KnowledgeCompilerContractErrorCode

  constructor(code: KnowledgeCompilerContractErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'KnowledgeCompilerContractError'
    this.code = code
  }
}

function fail(code: KnowledgeCompilerContractErrorCode): never {
  throw new KnowledgeCompilerContractError(code)
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_request')
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) {
    fail('invalid_request')
  }
}

function safeText(value: unknown, max: number): string {
  if (typeof value !== 'string') fail('invalid_request')
  const normalized = value.normalize('NFC').trim().replace(/\r\n?/gu, '\n')
  if (
    normalized.length === 0
    || normalized.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    fail('invalid_request')
  }
  return normalized
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail('invalid_request')
  }
  return value as number
}

function uniqueSorted(values: unknown, max: number, parser: (value: unknown) => string): string[] {
  if (!Array.isArray(values) || values.length > max) fail('invalid_request')
  const parsed = values.map(parser)
  if (new Set(parsed).size !== parsed.length) fail('duplicate_identity')
  return parsed.sort()
}

function timestamp(value: unknown): string {
  const retained = safeText(value, 64)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(retained)) {
    fail('invalid_request')
  }
  return retained
}

function validateTask(value: unknown): KnowledgeTaskDescriptor {
  const input = record(value)
  exactKeys(input, ['objective', 'criteria', 'files', 'symbols', 'recent_work'])
  if (!Array.isArray(input.criteria) || input.criteria.length > MAX_KNOWLEDGE_COMPILER_CRITERIA) {
    fail('invalid_request')
  }
  const criteria = input.criteria.map((entry): KnowledgeTaskCriterion => {
    const criterion = record(entry)
    exactKeys(criterion, ['id', 'text', 'required'])
    const id = safeText(criterion.id, 128)
    if (!STABLE_ID.test(id) || typeof criterion.required !== 'boolean') fail('invalid_request')
    return { id, text: safeText(criterion.text, 2_000), required: criterion.required }
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
    fail('duplicate_identity')
  }
  const files = uniqueSorted(input.files, MAX_KNOWLEDGE_COMPILER_PATHS, (entry) => {
    const file = safeText(entry, 1_024).replaceAll('\\', '/')
    if (!SAFE_PATH.test(file)) fail('invalid_request')
    return file
  })
  const symbols = uniqueSorted(
    input.symbols,
    MAX_KNOWLEDGE_COMPILER_SYMBOLS,
    (entry) => safeText(entry, 512),
  )
  if (!Array.isArray(input.recent_work) || input.recent_work.length > MAX_KNOWLEDGE_COMPILER_RECENT_WORK) {
    fail('invalid_request')
  }
  const recentWork = input.recent_work.map((entry): KnowledgeRecentWork => {
    const work = record(entry)
    exactKeys(work, ['source_location', 'revision', 'summary'])
    return {
      source_location: safeText(work.source_location, 1_024),
      revision: safeText(work.revision, 512),
      summary: safeText(work.summary, 2_000),
    }
  }).sort((left, right) =>
    left.source_location < right.source_location
      ? -1
      : left.source_location > right.source_location
        ? 1
        : left.revision < right.revision
          ? -1
          : left.revision > right.revision
            ? 1
            : left.summary < right.summary
              ? -1
              : left.summary > right.summary
                ? 1
                : 0,
  )
  const workKeys = recentWork.map((work) => `${work.source_location}\0${work.revision}\0${work.summary}`)
  if (new Set(workKeys).size !== workKeys.length) fail('duplicate_identity')
  return {
    objective: safeText(input.objective, 8_000),
    criteria,
    files,
    symbols,
    recent_work: recentWork,
  }
}

function validateExplicitBudget(value: unknown): ContextBudget {
  let budget: ContextBudget
  try {
    budget = validateContextBudget(value)
  } catch {
    fail('budget_invalid')
  }
  if (
    budget.max_tokens > MAX_KNOWLEDGE_COMPILER_BUDGET_TOKENS
    || budget.max_characters > MAX_KNOWLEDGE_COMPILER_BUDGET_CHARACTERS
    || CONTEXT_SECTIONS.some((section) => budget.sections[section] === undefined)
  ) {
    fail('budget_invalid')
  }
  return budget
}

function validatePreviousContext(value: unknown): PreviousContextIdentity | null {
  if (value === null) return null
  const input = record(value)
  exactKeys(input, ['manifest_fingerprint', 'selected_chunk_ids'])
  const fingerprint = safeText(input.manifest_fingerprint, 64)
  if (!SHA256.test(fingerprint)) fail('invalid_request')
  return {
    manifest_fingerprint: fingerprint,
    selected_chunk_ids: uniqueSorted(
      input.selected_chunk_ids,
      10_000,
      (entry) => {
        const id = safeText(entry, 67)
        if (!/^kc_[a-f0-9]{64}$/u.test(id)) fail('invalid_request')
        return id
      },
    ),
  }
}

function validateSignals(value: unknown, repositoryKey: string, baseCommit: string): KnowledgeGraphSignal[] {
  if (!Array.isArray(value) || value.length > 128) fail('invalid_request')
  const signals = value.map((entry) => {
    const signal = record(entry) as unknown as KnowledgeGraphSignal
    if (
      (signal.adapter !== 'gitnexus' && signal.adapter !== 'graphify')
      || typeof signal.evidence_sha256 !== 'string'
      || !SHA256.test(signal.evidence_sha256)
      || signal.provenance?.repository_key !== repositoryKey
      || signal.provenance?.base_commit_sha !== baseCommit
      || signal.provenance?.adapter_index_commit_sha !== baseCommit
    ) {
      fail('invalid_request')
    }
    return signal
  }).sort((left, right) => left.evidence_sha256 < right.evidence_sha256 ? -1 : 1)
  if (new Set(signals.map((signal) => signal.evidence_sha256)).size !== signals.length) {
    fail('duplicate_identity')
  }
  return signals
}

export function validateKnowledgeCompilationRequest(
  value: unknown,
): KnowledgeCompilationRequest {
  const input = record(value)
  exactKeys(input, [
    'version',
    'board_id',
    'access_scope',
    'targets',
    'repository_key',
    'base_commit_sha',
    'task',
    'budget',
    'pinned_chunk_ids',
    'adapter_signals',
    'previous_context',
    'created_at',
  ])
  if (input.version !== KNOWLEDGE_COMPILER_CONTRACT_VERSION) fail('invalid_request')
  const boardId = integer(input.board_id, 1)
  let accessScope: KnowledgeAccessScope
  let targets: KnowledgeTargetLinks
  try {
    accessScope = validateKnowledgeAccessScope(input.access_scope)
    targets = validateKnowledgeTargetLinks(input.targets)
  } catch {
    fail('scope_invalid')
  }
  if (targets.board_id !== boardId) fail('scope_invalid')
  if (
    (accessScope.kind === 'workspace' && targets.workspace_id !== accessScope.workspace_id)
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
    fail('scope_invalid')
  }
  const repositoryKey = safeText(input.repository_key, 256)
  const baseCommit = safeText(input.base_commit_sha, 40)
  if (!COMMIT_SHA.test(baseCommit)) fail('invalid_request')
  return {
    version: KNOWLEDGE_COMPILER_CONTRACT_VERSION,
    board_id: boardId,
    access_scope: accessScope,
    targets,
    repository_key: repositoryKey,
    base_commit_sha: baseCommit,
    task: validateTask(input.task),
    budget: validateExplicitBudget(input.budget),
    pinned_chunk_ids: uniqueSorted(input.pinned_chunk_ids, 128, (entry) => {
      const id = safeText(entry, 67)
      if (!/^kc_[a-f0-9]{64}$/u.test(id)) fail('invalid_request')
      return id
    }),
    adapter_signals: validateSignals(input.adapter_signals, repositoryKey, baseCommit),
    previous_context: validatePreviousContext(input.previous_context),
    created_at: timestamp(input.created_at),
  }
}

export function knowledgeCompilationRequestHash(
  value: KnowledgeCompilationRequest,
): string {
  const request = validateKnowledgeCompilationRequest(value)
  return createHash('sha256')
    .update('orchestra-agent-os:knowledge-compilation-request:v1\0', 'utf8')
    .update(canonicalKnowledgeJson(request), 'utf8')
    .digest('hex')
}

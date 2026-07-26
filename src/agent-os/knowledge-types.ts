export const KNOWLEDGE_SOURCE_KINDS = Object.freeze([
  'agents',
  'readme',
  'documentation',
  'convention',
  'architecture',
  'code_symbol',
  'git_history',
  'git_blame',
  'discussion_answer',
  'decision',
  'verified_delivery',
  'gotcha',
  'graphify',
  'gitnexus',
  'manual',
] as const)

export type KnowledgeSourceKind = typeof KNOWLEDGE_SOURCE_KINDS[number]

export const KNOWLEDGE_TRUST_CLASSES = Object.freeze([
  'instruction',
  'reference',
  'evidence',
  'untrusted',
] as const)

export type KnowledgeTrustClass = typeof KNOWLEDGE_TRUST_CLASSES[number]

export const KNOWLEDGE_FRESHNESS_STATES = Object.freeze([
  'fresh',
  'stale',
  'unknown',
  'contradicted',
] as const)

export type KnowledgeFreshnessState = typeof KNOWLEDGE_FRESHNESS_STATES[number]

export const KNOWLEDGE_FRESHNESS_POLICIES = Object.freeze([
  'commit_exact',
  'path_hash',
  'external_revision',
  'manual_until_superseded',
] as const)

export type KnowledgeFreshnessPolicy = typeof KNOWLEDGE_FRESHNESS_POLICIES[number]

export const KNOWLEDGE_REDACTION_STATES = Object.freeze([
  'none',
  'redacted',
  'withheld',
] as const)
export type KnowledgeRedactionState = typeof KNOWLEDGE_REDACTION_STATES[number]

export const KNOWLEDGE_CONTENT_STATES = Object.freeze([
  'present',
  'purged',
  'withheld',
] as const)
export type KnowledgeContentState = typeof KNOWLEDGE_CONTENT_STATES[number]

export const KNOWLEDGE_INGEST_STATES = Object.freeze([
  'active',
  'excluded',
  'failed',
  'superseded',
  'forgotten',
] as const)

export type KnowledgeIngestState = typeof KNOWLEDGE_INGEST_STATES[number]

export type KnowledgeAccessScope =
  | { kind: 'board' }
  | { kind: 'workspace'; workspace_id: string }
  | { kind: 'contract'; card_id: number; contract_version: number }
  | { kind: 'job'; job_id: string }
  | { kind: 'profile'; profile_id: string }
  | { kind: 'session'; session_id: string }

export interface RepositoryProvenance {
  repository_key: string
  base_commit_sha: string
  worktree_state_hash: string | null
  relative_root: string
  adapter_id: string
  adapter_version: string
  adapter_index_commit_sha: string | null
  observed_at: string
}

export interface KnowledgeTargetLinks {
  board_id: number
  workspace_id: string | null
  card_id: number | null
  contract_ref: string | null
  contract_version: number | null
  contract_snapshot_sha256: string | null
  job_id: string | null
  profile_id: string | null
  session_id: string | null
  delivery_report_id: string | null
}

/**
 * Line ranges are one-based and inclusive. Byte ranges are zero-based with an
 * exclusive end. A range dimension is either completely present or null.
 */
export interface KnowledgeSourceRange {
  start_line: number | null
  end_line: number | null
  start_byte: number | null
  end_byte: number | null
}

export interface KnowledgeSymbolReference {
  language: string
  qualified_name: string
  symbol_kind: string
  signature_sha256: string | null
}

export interface KnowledgeSource {
  id: string
  source_kind: KnowledgeSourceKind
  trust_class: KnowledgeTrustClass
  title: string
  locator: string
  normalized_locator: string
  source_revision: string
  content_sha256: string
  freshness_policy: KnowledgeFreshnessPolicy
  freshness_state: KnowledgeFreshnessState
  redaction_state: KnowledgeRedactionState
  content_state: KnowledgeContentState
  ingest_state: KnowledgeIngestState
  access_scope: KnowledgeAccessScope
  targets: KnowledgeTargetLinks
  provenance: RepositoryProvenance
  created_at: string
  updated_at: string
}

export interface KnowledgeChunk {
  id: string
  source_id: string
  ordinal: number
  content: string
  content_sha256: string
  character_count: number
  byte_count: number
  estimated_tokens: number
  source_range: KnowledgeSourceRange
  symbol: KnowledgeSymbolReference | null
  created_at: string
}

/**
 * This order is part of the deterministic context-build contract.
 */
export const CONTEXT_SECTIONS = Object.freeze([
  'project_brief',
  'task_contract',
  'repository_instructions',
  'relevant_code',
  'recent_changes',
  'accepted_decisions',
  'verified_deliveries',
  'working_memory_delta',
] as const)

export type ContextSection = typeof CONTEXT_SECTIONS[number]

export interface ContextBudgetLimit {
  max_tokens: number
  max_characters: number
}

export interface ContextBudget extends ContextBudgetLimit {
  sections: Partial<Record<ContextSection, ContextBudgetLimit>>
}

export interface ContextBudgetUsageSection {
  used_tokens: number
  used_characters: number
}

export interface ContextBudgetUsage {
  used_tokens: number
  used_characters: number
  sections: Partial<Record<ContextSection, ContextBudgetUsageSection>>
}

export const CONTEXT_SELECTION_REASONS = Object.freeze([
  'within_budget',
  'pinned',
  'budget_exhausted',
  'section_budget_exhausted',
  'stale',
  'untrusted',
  'superseded',
  'duplicate',
  'policy_excluded',
  'redacted',
  'withheld',
  'lower_rank',
] as const)

export type ContextSelectionReason = typeof CONTEXT_SELECTION_REASONS[number]
export type ContextSelectionDecision = 'selected' | 'omitted'
export type ContextRendering = 'full' | 'truncated' | 'summary' | 'none'

export interface ContextScoreComponents {
  authority_micros: number
  relevance_micros: number
  freshness_micros: number
  recency_micros: number
  contract_micros: number
  pin_micros: number
}

/**
 * A manifest entry deliberately carries content identity, not content.
 */
export interface ContextBuildEntry {
  source_id: string
  chunk_id: string
  section: ContextSection
  candidate_ordinal: number
  selected_ordinal: number | null
  decision: ContextSelectionDecision
  reason: ContextSelectionReason
  score_components: ContextScoreComponents
  score_micros: number
  rendering: ContextRendering
  estimated_tokens: number
  character_count: number
  source_kind: KnowledgeSourceKind
  trust_class: KnowledgeTrustClass
  freshness_state: KnowledgeFreshnessState
  redaction_state: KnowledgeRedactionState
  normalized_locator: string
  source_range: KnowledgeSourceRange
  content_sha256: string
}

export type ContextBuildStatus = 'built' | 'used' | 'invalidated' | 'failed'

export interface ContextBuild {
  id: string
  board_id: number
  access_scope: KnowledgeAccessScope
  targets: KnowledgeTargetLinks
  request_fingerprint: string
  source_set_fingerprint: string
  manifest_fingerprint: string
  budget: ContextBudget
  usage: ContextBudgetUsage
  entries: ContextBuildEntry[]
  status: ContextBuildStatus
  created_at: string
  invalidated_at: string | null
}

export type ContextUseOutcome = 'running' | 'completed' | 'failed' | 'cancelled'

export interface ContextUse {
  id: string
  context_build_id: string
  board_id: number
  job_id: string
  session_id: string
  injection_ordinal: number
  manifest_fingerprint: string
  estimated_tokens: number
  actual_tokens: number | null
  cache_identity: string
  outcome: ContextUseOutcome
  injected_at: string
  completed_at: string | null
}

export interface ContextOrderingCandidate {
  chunk_id: string
  section: ContextSection
  pinned: boolean
  authority_rank: number
  score_micros: number
  source_kind: KnowledgeSourceKind
  locator: string
  start_line: number | null
}

export interface KnowledgeSourceIdentityInput {
  repository_key: string
  source_kind: KnowledgeSourceKind
  normalized_locator: string
  source_revision: string
  content_sha256: string
}

export interface KnowledgeChunkIdentityInput {
  source_id: string
  ordinal: number
  content_sha256: string
  source_range: KnowledgeSourceRange
}

export interface ContextBuildIdentityInput {
  request: ContextRequestIdentityInput
  source_set_fingerprint: string
  manifest_fingerprint: string
}

export interface ContextRequestIdentityInput {
  board_id: number
  access_scope: KnowledgeAccessScope
  targets: KnowledgeTargetLinks
  budget: ContextBudget
  selection_request_sha256: string
}

export interface ContextUseIdentityInput {
  context_build_id: string
  job_id: string
  session_id: string
  injection_ordinal: number
}

export interface KnowledgeSourceSetEntry {
  source_id: string
  source_revision: string
  content_sha256: string
  freshness_state: KnowledgeFreshnessState
  redaction_state: KnowledgeRedactionState
}

export interface ContextBuildAccounting {
  budget: ContextBudget
  usage: ContextBudgetUsage
  entries: ContextBuildEntry[]
  manifest_fingerprint: string
}

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { KnowledgeCompiler, KnowledgeCompilerError } from './knowledge-compiler.js'
import {
  KNOWLEDGE_COMPILER_CONTRACT_VERSION,
  type KnowledgeCompilationRequest,
} from './knowledge-compiler-contracts.js'
import {
  KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION,
  KnowledgeContextBridgeService,
  type AmbientSessionStartBridgeEnvelope,
} from './knowledge-context-bridges.js'
import { KnowledgeService } from './knowledge-service.js'
import { KnowledgeStore } from './knowledge-store.js'
import { CONTEXT_SECTIONS, type ContextBudget } from './knowledge-types.js'
import type { DeliveryReport } from './delivery-reports.js'
import type { Job } from './scheduler.js'
import type { TaskContract } from './task-contracts.js'

export interface ManagedKnowledgePrompt {
  prompt: string
  context_use_id: string
  context_build_id: string
  estimated_tokens: number
  manifest_fingerprint: string
}

type RepositoryCandidate = { repository_key: string; source_count: number }

/** Runtime-only composition of retrieval, compiler, controls, and durable use receipts. */
export class KnowledgeRuntimeIntegration {
  private readonly knowledge: KnowledgeService
  private readonly compiler: KnowledgeCompiler
  private readonly bridge: KnowledgeContextBridgeService
  private readonly store: KnowledgeStore

  constructor(private readonly db: Database.Database) {
    this.knowledge = new KnowledgeService(db)
    this.compiler = new KnowledgeCompiler(this.knowledge, (request) => this.knowledge.retrieve(request))
    this.bridge = new KnowledgeContextBridgeService(db)
    this.store = new KnowledgeStore(db)
  }

  hasSources(boardId: number): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM knowledge_sources
      WHERE board_id=? AND content_state='present' AND ingest_state='active' LIMIT 1`).get(boardId))
  }

  prepareManagedJob(input: {
    job: Job
    contract: TaskContract
    delivery: DeliveryReport
    session_id: string
    workspace_id: string
    repository_head_sha: string
    created_at: string
  }): ManagedKnowledgePrompt | null {
    const repositoryKey = this.repositoryKey(input.job.board_id, input.repository_head_sha)
    if (repositoryKey === null) return null
    if (!this.controlsAllowCompilation(
      input.job.board_id,
      repositoryKey,
      input.repository_head_sha,
    )) return null
    const request: KnowledgeCompilationRequest = {
      version: KNOWLEDGE_COMPILER_CONTRACT_VERSION,
      board_id: input.job.board_id,
      access_scope: { kind: 'job', job_id: input.job.id },
      targets: {
        board_id: input.job.board_id,
        workspace_id: input.workspace_id,
        card_id: input.job.card_id,
        contract_ref: input.job.card_id === null
          ? null : `card:${input.job.card_id}:v${input.contract.version}`,
        contract_version: input.contract.version,
        contract_snapshot_sha256: deliveryContractSnapshot(input.delivery),
        job_id: input.job.id,
        profile_id: input.job.assigned_profile_id,
        session_id: input.session_id,
        delivery_report_id: null,
      },
      repository_key: repositoryKey,
      base_commit_sha: input.repository_head_sha,
      task: {
        objective: input.contract.objective,
        criteria: input.contract.acceptance_criteria.map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
          required: criterion.required,
        })),
        files: [],
        symbols: [],
        recent_work: [],
      },
      budget: contextBudget(input.job, input.contract),
      pinned_chunk_ids: this.pinnedChunks(
        input.job.board_id,
        repositoryKey,
        input.repository_head_sha,
      ),
      adapter_signals: [],
      previous_context: null,
      created_at: input.created_at,
    }
    const compiled = this.compileWithinBudget(request)
    if (compiled === null) return null
    const envelope = this.bridge.prepareManagedJob(compiled, {
      version: KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION,
      job_id: input.job.id,
      session_id: input.session_id,
      injection_ordinal: Math.max(1, input.job.attempts),
      repository_head_sha: input.repository_head_sha,
      adapter_index_commits: {},
      checked_at: input.created_at,
    })
    return {
      prompt: envelope.prompt,
      context_use_id: envelope.context_use.id,
      context_build_id: envelope.context_build_id,
      estimated_tokens: envelope.estimated_tokens,
      manifest_fingerprint: envelope.manifest_fingerprint,
    }
  }

  prepareManagedFollowUp(input: {
    job: Job
    contract: TaskContract
    delivery: DeliveryReport
    session_id: string
    workspace_id: string
    repository_head_sha: string
    previous_context_use_id: string
    objective: string
    created_at: string
  }): ManagedKnowledgePrompt | null {
    const previousUse = this.store.getContextUse(input.job.board_id, input.previous_context_use_id)
    if (previousUse === null || previousUse.job_id !== input.job.id
      || previousUse.session_id !== input.session_id) return null
    const previousBuild = this.store.getContextBuild(input.job.board_id, previousUse.context_build_id)
    if (previousBuild === null) return null
    const repositoryKey = this.repositoryKey(input.job.board_id, input.repository_head_sha)
    if (repositoryKey === null || !this.controlsAllowCompilation(
      input.job.board_id,
      repositoryKey,
      input.repository_head_sha,
    )) return null
    const request: KnowledgeCompilationRequest = {
      version: KNOWLEDGE_COMPILER_CONTRACT_VERSION,
      board_id: input.job.board_id,
      access_scope: { kind: 'job', job_id: input.job.id },
      targets: {
        board_id: input.job.board_id,
        workspace_id: input.workspace_id,
        card_id: input.job.card_id,
        contract_ref: input.job.card_id === null
          ? null : `card:${input.job.card_id}:v${input.contract.version}`,
        contract_version: input.contract.version,
        contract_snapshot_sha256: deliveryContractSnapshot(input.delivery),
        job_id: input.job.id,
        profile_id: input.job.assigned_profile_id,
        session_id: input.session_id,
        delivery_report_id: null,
      },
      repository_key: repositoryKey,
      base_commit_sha: input.repository_head_sha,
      task: {
        objective: input.objective,
        criteria: input.contract.acceptance_criteria.map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
          required: criterion.required,
        })),
        files: [],
        symbols: [],
        recent_work: [],
      },
      budget: contextBudget(input.job, input.contract),
      pinned_chunk_ids: this.pinnedChunks(
        input.job.board_id,
        repositoryKey,
        input.repository_head_sha,
      ),
      adapter_signals: [],
      previous_context: {
        manifest_fingerprint: previousUse.manifest_fingerprint,
        selected_chunk_ids: previousBuild.entries
          .filter((entry) => entry.decision === 'selected')
          .map((entry) => entry.chunk_id),
      },
      created_at: input.created_at,
    }
    const compiled = this.compileWithinBudget(request)
    if (compiled === null) return null
    const ordinal = this.nextInjectionOrdinal(input.job.board_id, input.session_id)
    const envelope = this.bridge.prepareManagedFollowUp(compiled, {
      version: KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION,
      job_id: input.job.id,
      session_id: input.session_id,
      injection_ordinal: ordinal,
      previous_context_use_id: input.previous_context_use_id,
      repository_head_sha: input.repository_head_sha,
      adapter_index_commits: {},
      checked_at: input.created_at,
    })
    return {
      prompt: envelope.prompt,
      context_use_id: envelope.context_use.id,
      context_build_id: envelope.context_build_id,
      estimated_tokens: envelope.estimated_tokens,
      manifest_fingerprint: envelope.manifest_fingerprint,
    }
  }

  prepareAmbientSessionStart(input: {
    board_id: number
    session_id: string
    workspace_id: string | null
    repository_head_sha: string
    objective: string
    created_at: string
  }): AmbientSessionStartBridgeEnvelope | null {
    const repositoryKey = this.repositoryKey(input.board_id, input.repository_head_sha)
    if (repositoryKey === null || !this.controlsAllowCompilation(
      input.board_id,
      repositoryKey,
      input.repository_head_sha,
    )) return null
    const request: KnowledgeCompilationRequest = {
      version: KNOWLEDGE_COMPILER_CONTRACT_VERSION,
      board_id: input.board_id,
      access_scope: { kind: 'session', session_id: input.session_id },
      targets: {
        board_id: input.board_id,
        workspace_id: input.workspace_id,
        card_id: null,
        contract_ref: null,
        contract_version: null,
        contract_snapshot_sha256: null,
        job_id: null,
        profile_id: null,
        session_id: input.session_id,
        delivery_report_id: null,
      },
      repository_key: repositoryKey,
      base_commit_sha: input.repository_head_sha,
      task: {
        objective: input.objective,
        criteria: [],
        files: [],
        symbols: [],
        recent_work: [],
      },
      budget: fixedContextBudget(12_000),
      pinned_chunk_ids: this.pinnedChunks(
        input.board_id,
        repositoryKey,
        input.repository_head_sha,
      ),
      adapter_signals: [],
      previous_context: null,
      created_at: input.created_at,
    }
    const compiled = this.compileWithinBudget(request)
    if (compiled === null) return null
    return this.bridge.prepareAmbientSessionStart(compiled, {
      version: KNOWLEDGE_CONTEXT_BRIDGE_CONTRACT_VERSION,
      session_id: input.session_id,
      repository_head_sha: input.repository_head_sha,
      adapter_index_commits: {},
      checked_at: input.created_at,
    })
  }

  finishManagedJob(input: {
    board_id: number
    context_use_id: string
    outcome: 'completed' | 'failed' | 'cancelled'
    actual_tokens: number | null
    completed_at: string
  }): void {
    this.bridge.finishManagedContextUse(input)
  }

  private repositoryKey(boardId: number, head: string): string | null {
    const row = this.db.prepare(`SELECT
        json_extract(provenance_json, '$.repository_key') AS repository_key,
        count(*) AS source_count
      FROM knowledge_sources
      WHERE board_id=?
        AND json_extract(provenance_json, '$.base_commit_sha')=?
        AND content_state='present' AND ingest_state='active'
        AND json_type(provenance_json, '$.repository_key')='text'
      GROUP BY repository_key
      ORDER BY source_count DESC, repository_key
      LIMIT 1`).get(boardId, head) as RepositoryCandidate | undefined
    return row?.repository_key ?? null
  }

  /** A rejected, superseded, forgotten, edited, stale, or contradicted overlay stops injection. */
  private controlsAllowCompilation(boardId: number, repositoryKey: string, head: string): boolean {
    const blocked = this.db.prepare(`WITH scoped_sources AS (
        SELECT source.id FROM knowledge_sources source
        WHERE source.board_id=?
          AND json_extract(source.provenance_json, '$.repository_key')=?
          AND json_extract(source.provenance_json, '$.base_commit_sha')=?
          AND source.content_state='present' AND source.ingest_state='active'
      ), latest_observation AS (
        SELECT observation.* FROM knowledge_freshness_observations observation
        JOIN scoped_sources source ON source.id=observation.source_id
        WHERE observation.board_id=? AND NOT EXISTS (
          SELECT 1 FROM knowledge_freshness_observations newer
          WHERE newer.board_id=observation.board_id AND newer.source_id=observation.source_id
            AND (newer.observed_at>observation.observed_at
              OR (newer.observed_at=observation.observed_at AND newer.id>observation.id))
        )
      ), latest_disposition AS (
        SELECT action.* FROM knowledge_control_actions action
        JOIN scoped_sources source ON source.id=action.source_id
        WHERE action.board_id=? AND action.action!='pin' AND NOT EXISTS (
          SELECT 1 FROM knowledge_control_actions newer
          WHERE newer.board_id=action.board_id AND newer.source_id=action.source_id
            AND newer.action!='pin' AND newer.source_ordinal>action.source_ordinal
        )
      )
      SELECT 1 FROM scoped_sources source
      LEFT JOIN latest_observation observation ON observation.source_id=source.id
      LEFT JOIN latest_disposition disposition ON disposition.source_id=source.id
      WHERE coalesce(disposition.action, 'accept') IN ('reject','forget','edit','supersede')
        OR (observation.effective_freshness IN ('stale','contradicted','unknown')
          AND coalesce(disposition.action, '')!='accept')
      LIMIT 1`).get(boardId, repositoryKey, head, boardId, boardId)
    return !blocked
  }

  private pinnedChunks(boardId: number, repositoryKey: string, head: string): string[] {
    return (this.db.prepare(`WITH latest_pin AS (
        SELECT action.* FROM knowledge_control_actions action
        WHERE action.board_id=? AND action.action='pin' AND NOT EXISTS (
          SELECT 1 FROM knowledge_control_actions newer
          WHERE newer.board_id=action.board_id AND newer.source_id=action.source_id
            AND newer.action='pin' AND newer.source_ordinal>action.source_ordinal
        )
      )
      SELECT chunk.id FROM latest_pin pin
      JOIN knowledge_sources source ON source.board_id=pin.board_id AND source.id=pin.source_id
      JOIN knowledge_chunks chunk ON chunk.board_id=source.board_id AND chunk.source_id=source.id
      WHERE pin.pinned=1
        AND json_extract(source.provenance_json, '$.repository_key')=?
        AND json_extract(source.provenance_json, '$.base_commit_sha')=?
      ORDER BY chunk.id LIMIT 128`).all(boardId, repositoryKey, head) as Array<{ id: string }>)
      .map((row) => row.id)
  }

  private compileWithinBudget(request: KnowledgeCompilationRequest) {
    try {
      return this.compiler.compile(request)
    } catch (error) {
      if (error instanceof KnowledgeCompilerError && error.code === 'budget_exceeded') return null
      throw error
    }
  }

  private nextInjectionOrdinal(boardId: number, sessionId: string): number {
    const row = this.db.prepare(`SELECT max(injection_ordinal) AS ordinal
      FROM context_uses WHERE board_id=? AND session_id=?`).get(boardId, sessionId) as
      { ordinal: number | null }
    return Math.max(1, (row.ordinal ?? 0) + 1)
  }
}

function contextBudget(job: Job, contract: TaskContract): ContextBudget {
  const limit = job.budget_tokens ?? contract.budget_tokens
  const remaining = limit === null ? null : Math.max(0, limit - job.spent_tokens)
  const maxTokens = Math.min(12_000, remaining === null
    ? 12_000 : Math.floor(remaining * 0.2))
  return fixedContextBudget(maxTokens)
}

function fixedContextBudget(maxTokens: number): ContextBudget {
  const maxCharacters = Math.min(100_000, maxTokens * 8)
  return {
    max_tokens: maxTokens,
    max_characters: maxCharacters,
    sections: Object.fromEntries(CONTEXT_SECTIONS.map((section) => [section, {
      max_tokens: maxTokens,
      max_characters: maxCharacters,
    }])),
  }
}

function deliveryContractSnapshot(delivery: DeliveryReport): string {
  return createHash('sha256').update(JSON.stringify(delivery.asked), 'utf8').digest('hex')
}

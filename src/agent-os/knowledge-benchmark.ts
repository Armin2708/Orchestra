import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalKnowledgeJson } from './knowledge-contracts.js'
import { KnowledgeManagementError } from './knowledge-management.js'
import { installKnowledgeManagementSchema } from './knowledge-management-migration.js'

export interface KnowledgeBenchmarkTask {
  objective: string
  acceptance_criteria: string[]
  repository_head_sha: string
  provider: string
  model: string
  seed: string
}

export interface KnowledgeBenchmarkOutcome {
  accepted: boolean
  quality_micros: number
  input_tokens: number
  output_tokens: number
  repeated_exploration_steps: number
  cited_source_ids: string[]
  fresh_citation_count: number
  evidence_artifact: { ref: string; sha256: string }
}

export interface KnowledgeBenchmarkEvidence {
  schema_version: 1
  task: KnowledgeBenchmarkTask
  without_context: KnowledgeBenchmarkOutcome
  with_context: KnowledgeBenchmarkOutcome
  gate: KnowledgeBenchmarkGate
}

export interface KnowledgeBenchmarkGate {
  passed: boolean
  quality_preserved: boolean
  accepted_delivery_preserved: boolean
  cited_fresh_context: boolean
  input_tokens_saved: number
  total_tokens_saved: number
  repeated_exploration_saved: number
}

export type KnowledgeBenchmarkRunner = (
  variant: 'without_context' | 'with_context',
  task: Readonly<KnowledgeBenchmarkTask>,
) => Promise<KnowledgeBenchmarkOutcome>

const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const hash = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

function fail(): never {
  throw new KnowledgeManagementError('invalid_request', 'invalid knowledge benchmark evidence')
}

function safeText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) fail()
  return value
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) fail()
  return Number(value)
}

function validateTask(value: KnowledgeBenchmarkTask): KnowledgeBenchmarkTask {
  const criteria = value.acceptance_criteria
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 64) fail()
  const head = safeText(value.repository_head_sha, 64)
  if (!COMMIT.test(head)) fail()
  return {
    objective: safeText(value.objective, 10_000),
    acceptance_criteria: criteria.map((criterion) => safeText(criterion, 4_000)),
    repository_head_sha: head,
    provider: safeText(value.provider, 128),
    model: safeText(value.model, 256),
    seed: safeText(value.seed, 256),
  }
}

function validateOutcome(value: KnowledgeBenchmarkOutcome): KnowledgeBenchmarkOutcome {
  if (typeof value.accepted !== 'boolean') fail()
  const citationIds = value.cited_source_ids
  if (!Array.isArray(citationIds) || citationIds.length > 512
    || citationIds.some((id) => !/^ks_[a-f0-9]{64}$/u.test(id))) fail()
  const ref = safeText(value.evidence_artifact?.ref, 4096)
  const artifactHash = safeText(value.evidence_artifact?.sha256, 64)
  if (!SHA256.test(artifactHash)) fail()
  const result = {
    accepted: value.accepted,
    quality_micros: safeInteger(value.quality_micros, 1_000_000),
    input_tokens: safeInteger(value.input_tokens, 100_000_000),
    output_tokens: safeInteger(value.output_tokens, 100_000_000),
    repeated_exploration_steps: safeInteger(value.repeated_exploration_steps, 1_000_000),
    cited_source_ids: [...citationIds],
    fresh_citation_count: safeInteger(value.fresh_citation_count, citationIds.length),
    evidence_artifact: { ref, sha256: artifactHash },
  }
  if (new Set(result.cited_source_ids).size !== result.cited_source_ids.length) fail()
  return result
}

export function evaluateKnowledgeBenchmark(
  withoutContextValue: KnowledgeBenchmarkOutcome,
  withContextValue: KnowledgeBenchmarkOutcome,
): KnowledgeBenchmarkGate {
  const withoutContext = validateOutcome(withoutContextValue)
  const withContext = validateOutcome(withContextValue)
  const inputSaved = withoutContext.input_tokens - withContext.input_tokens
  const totalSaved = withoutContext.input_tokens + withoutContext.output_tokens
    - withContext.input_tokens - withContext.output_tokens
  const explorationSaved = withoutContext.repeated_exploration_steps
    - withContext.repeated_exploration_steps
  const qualityPreserved = withContext.quality_micros >= withoutContext.quality_micros
  const acceptancePreserved = withContext.accepted && (!withoutContext.accepted || withContext.accepted)
  const citedFresh = withContext.cited_source_ids.length > 0
    && withContext.fresh_citation_count === withContext.cited_source_ids.length
  return {
    passed: qualityPreserved && acceptancePreserved && citedFresh
      && inputSaved > 0 && totalSaved > 0 && explorationSaved > 0,
    quality_preserved: qualityPreserved,
    accepted_delivery_preserved: acceptancePreserved,
    cited_fresh_context: citedFresh,
    input_tokens_saved: inputSaved,
    total_tokens_saved: totalSaved,
    repeated_exploration_saved: explorationSaved,
  }
}

/** Runs the same frozen task twice, control first, with only compiled context varied. */
export async function runControlledKnowledgeBenchmark(
  taskValue: KnowledgeBenchmarkTask,
  runner: KnowledgeBenchmarkRunner,
): Promise<KnowledgeBenchmarkEvidence> {
  const task = Object.freeze(validateTask(taskValue))
  const withoutContext = validateOutcome(await runner('without_context', task))
  const withContext = validateOutcome(await runner('with_context', task))
  return {
    schema_version: 1,
    task,
    without_context: withoutContext,
    with_context: withContext,
    gate: evaluateKnowledgeBenchmark(withoutContext, withContext),
  }
}

export class KnowledgeBenchmarkStore {
  constructor(private readonly db: Database.Database) {
    installKnowledgeManagementSchema(db)
  }

  record(boardId: number, value: KnowledgeBenchmarkEvidence, recordedAt = new Date().toISOString()): {
    id: string
    gate_passed: boolean
    evidence_sha256: string
  } {
    if (!Number.isSafeInteger(boardId) || boardId < 1) fail()
    const task = validateTask(value.task)
    const withoutContext = validateOutcome(value.without_context)
    const withContext = validateOutcome(value.with_context)
    const gate = evaluateKnowledgeBenchmark(withoutContext, withContext)
    if (canonicalKnowledgeJson(gate) !== canonicalKnowledgeJson(value.gate)) fail()
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(recordedAt)
      || new Date(recordedAt).toISOString() !== recordedAt) fail()
    const evidence: KnowledgeBenchmarkEvidence = {
      schema_version: 1, task, without_context: withoutContext, with_context: withContext, gate,
    }
    const evidenceJson = canonicalKnowledgeJson(evidence, {
      max_depth: 10, max_nodes: 5_000, max_string_characters: 20_000, max_serialized_bytes: 1_000_000,
    })
    const evidenceHash = hash(evidenceJson)
    const taskFingerprint = hash(canonicalKnowledgeJson(task))
    const runId = `kb_${hash(canonicalKnowledgeJson({ board_id: boardId, task_fingerprint: taskFingerprint, evidence_sha256: evidenceHash }))}`
    try {
      this.db.prepare(`INSERT OR IGNORE INTO knowledge_benchmark_runs
        (id, board_id, task_fingerprint, evidence_json, evidence_sha256, gate_passed, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(runId, boardId, taskFingerprint, evidenceJson, evidenceHash, Number(gate.passed), recordedAt)
    } catch {
      throw new KnowledgeManagementError('evidence_rejected', 'knowledge benchmark evidence was rejected')
    }
    return { id: runId, gate_passed: gate.passed, evidence_sha256: evidenceHash }
  }

  list(boardId: number): Array<Record<string, unknown>> {
    if (!Number.isSafeInteger(boardId) || boardId < 1) fail()
    return this.db.prepare(`SELECT id, board_id, task_fingerprint, evidence_sha256,
      gate_passed, recorded_at FROM knowledge_benchmark_runs WHERE board_id=?
      ORDER BY recorded_at DESC, id`).all(boardId) as Array<Record<string, unknown>>
  }
}

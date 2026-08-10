import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  knowledgeChunkId,
  knowledgeSourceId,
  normalizeKnowledgeLocator,
} from './knowledge-contracts.js'
import {
  KnowledgeManagementError,
  KnowledgeManagementService,
} from './knowledge-management.js'
import { KnowledgeService } from './knowledge-service.js'
import type {
  KnowledgeChunk,
  KnowledgeSource,
  KnowledgeSourceRange,
} from './knowledge-types.js'

export const GRAPHIFY_GRAPH_LOCATOR = 'graphify-out/graph.json'
export const GRAPHIFY_REPORT_LOCATOR = 'graphify-out/GRAPH_REPORT.md'

/**
 * Shown to the operator when a board has no graphify output yet, so a fresh
 * system learns how to produce the inputs instead of silently staying empty.
 */
export const GRAPHIFY_BOOTSTRAP_HINT =
  'No graphify output was found in this repository. Generate it with '
  + '`/graphify .` (Claude skill) or `npx graphify analyze .`, commit the '
  + 'graphify-out/ directory, then run this sync again.'

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const COMMIT_40 = /^[a-f0-9]{40}$/u
const MAX_REPORT_BYTES = 4_000_000
const MAX_GRAPH_BYTES = 64_000_000
const MAX_SECTION_CHUNKS = 60
const MAX_SECTION_CHARACTERS = 12_000
const MAX_RATIONALE_ENTRIES = 200
const MAX_RATIONALE_CHARACTERS = 2_000

export interface GraphifyIngestInput {
  board_id: number
  observed_at?: string
}

export interface GraphifyIngestResult {
  board_id: number
  repository_head_sha: string
  graph_found: boolean
  report_found: boolean
  created_sources: number
  unchanged_sources: number
  superseded_sources: number
  created_chunks: number
  hint: string | null
}

interface GraphNode {
  label?: unknown
  rationale?: unknown
  source_file?: unknown
  source_location?: unknown
}

interface GraphDocument {
  nodes: GraphNode[]
  links: unknown[]
  built_at_commit: string | null
  communities: number
}

interface PlannedChunk {
  content: string
  range: KnowledgeSourceRange
}

interface PlannedSource {
  title: string
  locator: string
  content_sha256: string
  chunks: PlannedChunk[]
}

const sha256hex = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex')

const estimatedTokens = (content: string): number =>
  Math.max(1, Math.ceil(Buffer.byteLength(content, 'utf8') / 4))

const nullRange: KnowledgeSourceRange = {
  start_line: null,
  end_line: null,
  start_byte: null,
  end_byte: null,
}

function invalidTimestamp(): never {
  throw new KnowledgeManagementError('invalid_request', 'invalid knowledge observed at')
}

function resolveObservedAt(value: string | undefined): string {
  if (value === undefined) return new Date().toISOString()
  if (!ISO_TIME.test(value) || new Date(value).toISOString() !== value) invalidTimestamp()
  return value
}

function boardRoot(db: Database.Database, boardId: number): string {
  const board = db.prepare('SELECT project_path FROM boards WHERE id=?').get(boardId) as
    { project_path: string } | undefined
  if (!board) throw new KnowledgeManagementError('not_found', 'knowledge board was not found')
  return board.project_path
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 1_000_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    }).trim()
  } catch {
    throw new KnowledgeManagementError(
      'evidence_rejected',
      'repository state could not be verified; the board path must be a committed git repository',
    )
  }
}

function repositoryHead(root: string): string {
  const top = git(root, ['rev-parse', '--show-toplevel'])
  if (fs.realpathSync(top) !== fs.realpathSync(root)) {
    throw new KnowledgeManagementError('evidence_rejected', 'board repository root does not match')
  }
  const head = git(root, ['rev-parse', '--verify', 'HEAD'])
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) {
    throw new KnowledgeManagementError('evidence_rejected', 'repository head could not be verified')
  }
  return head
}

function readOutputFile(root: string, locator: string, maximumBytes: number): Buffer | null {
  const absolute = path.join(root, locator)
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(absolute)
  } catch {
    return null
  }
  if (!stats.isFile() || stats.size === 0 || stats.size > maximumBytes) return null
  try {
    return fs.readFileSync(absolute)
  } catch {
    return null
  }
}

function truncated(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 2)}\n…`
}

/**
 * Splits the graphify report into one chunk per `##` section so browse and
 * retrieval work at section granularity with accurate line citations.
 */
function reportChunks(report: string): PlannedChunk[] {
  const lines = report.split('\n')
  const sections: Array<{ start: number; end: number }> = []
  let start = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0 && lines[index].startsWith('## ')) {
      sections.push({ start, end: index - 1 })
      start = index
    }
  }
  sections.push({ start, end: lines.length - 1 })
  const chunks: PlannedChunk[] = []
  for (const section of sections) {
    const content = truncated(
      lines.slice(section.start, section.end + 1).join('\n').trim(),
      MAX_SECTION_CHARACTERS,
    )
    if (content.length === 0) continue
    chunks.push({
      content,
      range: {
        start_line: section.start + 1,
        end_line: section.end + 1,
        start_byte: null,
        end_byte: null,
      },
    })
    if (chunks.length >= MAX_SECTION_CHUNKS) break
  }
  return chunks
}

function parseGraph(raw: Buffer): GraphDocument | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const nodes = Array.isArray(record.nodes) ? record.nodes.filter(
    (node): node is GraphNode => Boolean(node) && typeof node === 'object',
  ) : []
  const links = Array.isArray(record.links) ? record.links : []
  const communities = new Set(
    nodes.map((node) => (node as Record<string, unknown>).community)
      .filter((value) => value !== undefined && value !== null),
  ).size
  const builtAt = typeof record.built_at_commit === 'string'
    && COMMIT_40.test(record.built_at_commit)
    ? record.built_at_commit : null
  return { nodes, links, built_at_commit: builtAt, communities }
}

function graphChunks(graph: GraphDocument): PlannedChunk[] {
  const overview = [
    'Graphify project knowledge graph.',
    `Nodes: ${graph.nodes.length} · Edges: ${graph.links.length}`
    + ` · Communities: ${graph.communities}`,
    graph.built_at_commit === null
      ? 'Built-at commit: unknown'
      : `Built-at commit: ${graph.built_at_commit}`,
    'Query it with `/graphify query "<question>"`; refresh with `/graphify . --update`.',
  ].join('\n')
  const chunks: PlannedChunk[] = [{ content: overview, range: nullRange }]
  for (const node of graph.nodes) {
    if (typeof node.rationale !== 'string' || node.rationale.trim().length === 0) continue
    const label = typeof node.label === 'string' && node.label.trim().length > 0
      ? node.label.trim() : 'Recorded decision'
    const origin = typeof node.source_file === 'string' && node.source_file.length > 0
      ? `\n(source: ${node.source_file}`
        + `${typeof node.source_location === 'string' && node.source_location.length > 0
          ? ` @ ${node.source_location}` : ''})`
      : ''
    chunks.push({
      content: truncated(
        `${label} — ${node.rationale.trim()}${origin}`,
        MAX_RATIONALE_CHARACTERS,
      ),
      range: nullRange,
    })
    if (chunks.length > MAX_RATIONALE_ENTRIES) break
  }
  return chunks
}

/**
 * Ingests the on-disk graphify output (graph.json + GRAPH_REPORT.md) of a
 * board's repository into the durable knowledge store, so the Wiki has real
 * project knowledge without waiting for discussion or delivery promotions.
 * Re-running is idempotent for unchanged content; changed content creates a
 * new source and marks the previous one superseded.
 */
export function ingestGraphifyKnowledge(
  db: Database.Database,
  input: GraphifyIngestInput,
): GraphifyIngestResult {
  if (!Number.isSafeInteger(input.board_id) || input.board_id < 1) {
    throw new KnowledgeManagementError('invalid_request', 'invalid knowledge board id')
  }
  const observedAt = resolveObservedAt(input.observed_at)
  const root = boardRoot(db, input.board_id)
  const service = new KnowledgeService(db)
  const management = new KnowledgeManagementService(db)
  const head = repositoryHead(root)

  const reportRaw = readOutputFile(root, GRAPHIFY_REPORT_LOCATOR, MAX_REPORT_BYTES)
  const graphRaw = readOutputFile(root, GRAPHIFY_GRAPH_LOCATOR, MAX_GRAPH_BYTES)
  const graph = graphRaw === null ? null : parseGraph(graphRaw)

  const planned: PlannedSource[] = []
  if (reportRaw !== null) {
    const chunks = reportChunks(reportRaw.toString('utf8'))
    if (chunks.length > 0) {
      planned.push({
        title: 'Graphify: architecture report',
        locator: GRAPHIFY_REPORT_LOCATOR,
        content_sha256: sha256hex(reportRaw),
        chunks,
      })
    }
  }
  if (graphRaw !== null && graph !== null) {
    planned.push({
      title: 'Graphify: project graph, decisions and rationale',
      locator: GRAPHIFY_GRAPH_LOCATOR,
      content_sha256: sha256hex(graphRaw),
      chunks: graphChunks(graph),
    })
  }

  const result: GraphifyIngestResult = {
    board_id: input.board_id,
    repository_head_sha: head,
    graph_found: graphRaw !== null && graph !== null,
    report_found: reportRaw !== null,
    created_sources: 0,
    unchanged_sources: 0,
    superseded_sources: 0,
    created_chunks: 0,
    hint: null,
  }
  if (planned.length === 0) {
    result.hint = GRAPHIFY_BOOTSTRAP_HINT
    return result
  }

  const repositoryKey = path.basename(root)
  for (const plan of planned) {
    const normalizedLocator = normalizeKnowledgeLocator(plan.locator)
    const sourceId = knowledgeSourceId({
      repository_key: repositoryKey,
      source_kind: 'graphify',
      normalized_locator: normalizedLocator,
      source_revision: head,
      content_sha256: plan.content_sha256,
    })
    if (service.getSource(input.board_id, sourceId)) {
      result.unchanged_sources += 1
      continue
    }
    const source: KnowledgeSource = {
      id: sourceId,
      source_kind: 'graphify',
      trust_class: 'reference',
      title: plan.title,
      locator: plan.locator,
      normalized_locator: normalizedLocator,
      source_revision: head,
      content_sha256: plan.content_sha256,
      freshness_policy: 'path_hash',
      freshness_state: 'fresh',
      redaction_state: 'none',
      content_state: 'present',
      ingest_state: 'active',
      access_scope: { kind: 'board' },
      targets: {
        board_id: input.board_id,
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
        base_commit_sha: head,
        worktree_state_hash: null,
        relative_root: '.',
        adapter_id: 'graphify',
        adapter_version: '1',
        adapter_index_commit_sha: graph?.built_at_commit ?? null,
        observed_at: observedAt,
      },
      created_at: observedAt,
      updated_at: observedAt,
    }
    service.putSource(source)
    result.created_sources += 1
    plan.chunks.forEach((chunk, ordinal) => {
      const contentSha = sha256hex(chunk.content)
      service.putChunk(input.board_id, {
        id: knowledgeChunkId({
          source_id: sourceId,
          ordinal,
          content_sha256: contentSha,
          source_range: chunk.range,
        }),
        source_id: sourceId,
        ordinal,
        content: chunk.content,
        content_sha256: contentSha,
        character_count: chunk.content.length,
        byte_count: Buffer.byteLength(chunk.content, 'utf8'),
        estimated_tokens: estimatedTokens(chunk.content),
        source_range: chunk.range,
        symbol: null,
        created_at: observedAt,
      })
      result.created_chunks += 1
    })
    const previous = db.prepare(`SELECT source.id FROM knowledge_sources source
      WHERE source.board_id=? AND source.source_kind='graphify'
        AND source.normalized_locator=? AND source.id!=? AND source.ingest_state='active'
        AND coalesce((SELECT action FROM knowledge_control_actions action
          WHERE action.board_id=source.board_id AND action.source_id=source.id
            AND action.action!='pin' ORDER BY action.source_ordinal DESC LIMIT 1), 'accept')
          NOT IN ('supersede', 'forget', 'reject', 'edit')`)
      .all(input.board_id, normalizedLocator, sourceId) as Array<{ id: string }>
    for (const stale of previous) {
      management.applyControl({
        board_id: input.board_id,
        source_id: stale.id,
        action: 'supersede',
        replacement_source_id: sourceId,
        reason: 'Superseded by a re-ingested graphify output revision.',
        actor: { type: 'operator', id: 'graphify-sync' },
        idempotency_key: `graphify:supersede:${stale.id}:${sourceId}`,
        created_at: observedAt,
      })
      result.superseded_sources += 1
    }
  }

  if (result.created_sources > 0) {
    service.synchronizeRetrievalIndex({ board_id: input.board_id, indexed_at: observedAt })
  }
  return result
}

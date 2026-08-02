import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalKnowledgeJson } from './knowledge-contracts.js'

export const KNOWLEDGE_GRAPH_ADAPTER_CONTRACT_VERSION = 1 as const
export const MAX_KNOWLEDGE_GRAPH_ADAPTER_REQUESTS = 8
export const MAX_KNOWLEDGE_GRAPH_ADAPTER_SIGNALS = 128
export const MAX_KNOWLEDGE_GRAPH_ADAPTER_OUTPUT_BYTES = 262_144
export const MAX_KNOWLEDGE_GRAPH_ADAPTER_QUERY_CHARACTERS = 512
export const MAX_KNOWLEDGE_GRAPH_ADAPTER_TIMEOUT_MS = 15_000

const COMMIT_SHA = /^[a-f0-9]{40}$/u
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\p{L}\p{N}._/@+,:= -]+$/u
const SOURCE_LOCATION = /^([^:\n\r]{1,1024})(?::(\d{1,9}))?$/u

export type KnowledgeGraphAdapterId = 'gitnexus' | 'graphify'
export type GitNexusSignalKind = 'call_graph' | 'impact' | 'code_flow'
export type GraphifySignalKind =
  | 'rationale'
  | 'documentation_relationship'
  | 'cross_cutting_relationship'
export type KnowledgeGraphSignalKind = GitNexusSignalKind | GraphifySignalKind

export interface KnowledgeGraphAdapterProvenance {
  repository_key: string
  base_commit_sha: string
  adapter_id: KnowledgeGraphAdapterId
  adapter_version: string
  adapter_index_commit_sha: string
  query_fingerprint: string
}

/**
 * Adapter signals are selection hints, never promoted Knowledge content. Every
 * signal points back to an exact repository source location and carries the
 * query/index identity that produced it.
 */
export interface KnowledgeGraphSignal {
  adapter: KnowledgeGraphAdapterId
  kind: KnowledgeGraphSignalKind
  label: string
  symbol: string | null
  source_location: string
  relationship: string | null
  relevance_micros: number
  evidence_sha256: string
  provenance: KnowledgeGraphAdapterProvenance
}

export interface KnowledgeGraphAdapterRequestBase {
  version: typeof KNOWLEDGE_GRAPH_ADAPTER_CONTRACT_VERSION
  repository_key: string
  repository_root: string
  base_commit_sha: string
  adapter_version: string
  adapter_index_commit_sha: string
  timeout_ms?: number
}

export interface GitNexusKnowledgeRequest extends KnowledgeGraphAdapterRequestBase {
  requests: Array<
    | {
      kind: 'call_graph'
      symbol: string
      file?: string
    }
    | {
      kind: 'impact'
      symbol: string
      file?: string
      direction: 'upstream' | 'downstream'
      depth?: number
    }
    | {
      kind: 'code_flow'
      query: string
      task_context?: string
      goal?: string
    }
  >
}

export interface GraphifyKnowledgeRequest extends KnowledgeGraphAdapterRequestBase {
  graph_path: string
  questions: Array<{
    kind: GraphifySignalKind
    question: string
  }>
}

export interface KnowledgeAdapterCommand {
  command: 'gitnexus' | 'graphify'
  args: string[]
  cwd: string
  timeout_ms: number
  max_output_bytes: number
}

export interface KnowledgeAdapterCommandResult {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error: boolean
}

export type KnowledgeAdapterCommandRunner = (
  command: KnowledgeAdapterCommand,
) => KnowledgeAdapterCommandResult

export type KnowledgeGraphAdapterErrorCode =
  | 'invalid_request'
  | 'repository_unavailable'
  | 'repository_revision_mismatch'
  | 'command_failed'
  | 'output_invalid'
  | 'output_exceeded'

const ERROR_MESSAGES: Readonly<Record<KnowledgeGraphAdapterErrorCode, string>> = {
  invalid_request: 'knowledge graph adapter request is invalid',
  repository_unavailable: 'knowledge graph adapter repository is unavailable',
  repository_revision_mismatch: 'knowledge graph adapter revision does not match',
  command_failed: 'knowledge graph adapter command failed',
  output_invalid: 'knowledge graph adapter output is invalid',
  output_exceeded: 'knowledge graph adapter output exceeded its bound',
}

/** Fixed errors never echo queries, paths, command output, or environment. */
export class KnowledgeGraphAdapterError extends Error {
  readonly code: KnowledgeGraphAdapterErrorCode

  constructor(code: KnowledgeGraphAdapterErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'KnowledgeGraphAdapterError'
    this.code = code
  }
}

interface ValidatedCommon {
  repository_key: string
  repository_root: string
  base_commit_sha: string
  adapter_version: string
  adapter_index_commit_sha: string
  timeout_ms: number
}

function fail(code: KnowledgeGraphAdapterErrorCode): never {
  throw new KnowledgeGraphAdapterError(code)
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
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || keys.some((key) => !allowed.has(key))
  ) {
    fail('invalid_request')
  }
}

function text(value: unknown, max = MAX_KNOWLEDGE_GRAPH_ADAPTER_QUERY_CHARACTERS): string {
  if (typeof value !== 'string') fail('invalid_request')
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ')
  if (
    normalized.length === 0
    || normalized.length > max
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail('invalid_request')
  }
  return normalized
}

function relativePath(value: unknown): string {
  const normalized = text(value, 1_024).replaceAll('\\', '/')
  if (!SAFE_RELATIVE_PATH.test(normalized) || path.posix.normalize(normalized) !== normalized) {
    fail('invalid_request')
  }
  return normalized
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail('invalid_request')
  }
  return value as number
}

function validateCommon(value: Record<string, unknown>): ValidatedCommon {
  if (value.version !== KNOWLEDGE_GRAPH_ADAPTER_CONTRACT_VERSION) fail('invalid_request')
  const repositoryRoot = text(value.repository_root, 4_096)
  let realRoot: string
  try {
    realRoot = fs.realpathSync(repositoryRoot)
    if (!fs.statSync(realRoot).isDirectory()) fail('repository_unavailable')
  } catch (error) {
    if (error instanceof KnowledgeGraphAdapterError) throw error
    fail('repository_unavailable')
  }
  const baseCommit = text(value.base_commit_sha, 40)
  const indexCommit = text(value.adapter_index_commit_sha, 40)
  if (!COMMIT_SHA.test(baseCommit) || !COMMIT_SHA.test(indexCommit)) {
    fail('invalid_request')
  }
  if (baseCommit !== indexCommit) fail('repository_revision_mismatch')
  return {
    repository_key: text(value.repository_key, 256),
    repository_root: realRoot,
    base_commit_sha: baseCommit,
    adapter_version: text(value.adapter_version, 64),
    adapter_index_commit_sha: indexCommit,
    timeout_ms: boundedInteger(
      value.timeout_ms,
      5_000,
      100,
      MAX_KNOWLEDGE_GRAPH_ADAPTER_TIMEOUT_MS,
    ),
  }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap((key) => {
      const value = process.env[key]
      return typeof value === 'string' ? [[key, value]] : []
    }),
  )
}

export const runKnowledgeAdapterCommand: KnowledgeAdapterCommandRunner = (request) => {
  const result = spawnSync(request.command, request.args, {
    cwd: request.cwd,
    encoding: 'utf8',
    env: {
      ...safeEnvironment(),
      NO_COLOR: '1',
    },
    windowsHide: true,
    shell: false,
    timeout: request.timeout_ms,
    maxBuffer: request.max_output_bytes,
  })
  return {
    status: result.status,
    signal: result.signal,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error !== undefined,
  }
}

function execute(
  runner: KnowledgeAdapterCommandRunner,
  command: KnowledgeAdapterCommand,
): string {
  let result: KnowledgeAdapterCommandResult
  try {
    result = runner(command)
  } catch {
    fail('command_failed')
  }
  if (
    Buffer.byteLength(result.stdout, 'utf8') > command.max_output_bytes
    || Buffer.byteLength(result.stderr, 'utf8') > command.max_output_bytes
  ) {
    fail('output_exceeded')
  }
  if (result.error || result.signal !== null || result.status !== 0) fail('command_failed')
  return result.stdout
}

function sha256(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`orchestra-agent-os:${domain}:v1\0`, 'utf8')
    .update(canonicalKnowledgeJson(value), 'utf8')
    .digest('hex')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizedSourceLocation(fileValue: unknown, lineValue?: unknown): string | null {
  if (typeof fileValue !== 'string') return null
  const file = fileValue.replaceAll('\\', '/').normalize('NFC')
  if (!SAFE_RELATIVE_PATH.test(file) || path.posix.normalize(file) !== file) return null
  const line = Number.isSafeInteger(lineValue) && (lineValue as number) > 0
    ? `:${lineValue as number}`
    : ''
  return `${file}${line}`
}

function signal(
  common: ValidatedCommon,
  adapter: KnowledgeGraphAdapterId,
  kind: KnowledgeGraphSignalKind,
  queryFingerprint: string,
  input: {
    label: string
    symbol: string | null
    source_location: string
    relationship: string | null
    relevance_micros: number
  },
): KnowledgeGraphSignal {
  const evidence = {
    adapter,
    kind,
    label: input.label,
    symbol: input.symbol,
    source_location: input.source_location,
    relationship: input.relationship,
    relevance_micros: input.relevance_micros,
    base_commit_sha: common.base_commit_sha,
    query_fingerprint: queryFingerprint,
  }
  return {
    ...evidence,
    evidence_sha256: sha256('knowledge-graph-adapter-evidence', evidence),
    provenance: {
      repository_key: common.repository_key,
      base_commit_sha: common.base_commit_sha,
      adapter_id: adapter,
      adapter_version: common.adapter_version,
      adapter_index_commit_sha: common.adapter_index_commit_sha,
      query_fingerprint: queryFingerprint,
    },
  }
}

function collectLocatedRecords(
  value: unknown,
  output: Array<Record<string, unknown>>,
  depth = 0,
): void {
  if (depth > 8 || output.length >= MAX_KNOWLEDGE_GRAPH_ADAPTER_SIGNALS * 4) return
  if (Array.isArray(value)) {
    for (const item of value) collectLocatedRecords(item, output, depth + 1)
    return
  }
  if (value === null || typeof value !== 'object') return
  const item = value as Record<string, unknown>
  if (typeof item.filePath === 'string') output.push(item)
  for (const nested of Object.values(item)) collectLocatedRecords(nested, output, depth + 1)
}

function parseGitNexusOutput(
  common: ValidatedCommon,
  kind: GitNexusSignalKind,
  queryFingerprint: string,
  output: string,
): KnowledgeGraphSignal[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    fail('output_invalid')
  }
  const located: Array<Record<string, unknown>> = []
  collectLocatedRecords(parsed, located)
  const seen = new Set<string>()
  const retained: KnowledgeGraphSignal[] = []
  for (const item of located) {
    const sourceLocation = normalizedSourceLocation(item.filePath, item.startLine)
    if (sourceLocation === null) continue
    const labelValue = typeof item.name === 'string'
      ? item.name
      : typeof item.summary === 'string'
        ? item.summary
        : sourceLocation
    const label = text(labelValue, 512)
    const symbolValue = typeof item.name === 'string' ? text(item.name, 512) : null
    const relationship = typeof item.relationType === 'string'
      ? text(item.relationType, 128).toLowerCase()
      : null
    const relevance = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? Math.max(0, Math.min(1_000_000, Math.round(item.confidence * 1_000_000)))
      : typeof item.priority === 'number' && Number.isFinite(item.priority)
        ? Math.max(0, Math.min(1_000_000, Math.round(item.priority * 1_000_000)))
        : 500_000
    const key = `${sourceLocation}\0${symbolValue ?? ''}\0${relationship ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    retained.push(signal(common, 'gitnexus', kind, queryFingerprint, {
      label,
      symbol: symbolValue,
      source_location: sourceLocation,
      relationship,
      relevance_micros: relevance,
    }))
  }
  return retained
}

function orderedSignals(values: KnowledgeGraphSignal[]): KnowledgeGraphSignal[] {
  return [...values].sort((left, right) =>
    compareText(left.adapter, right.adapter)
      || compareText(left.kind, right.kind)
      || compareText(left.source_location, right.source_location)
      || compareText(left.symbol ?? '', right.symbol ?? '')
      || compareText(left.relationship ?? '', right.relationship ?? '')
      || compareText(left.evidence_sha256, right.evidence_sha256),
  ).slice(0, MAX_KNOWLEDGE_GRAPH_ADAPTER_SIGNALS)
}

function validateGitNexusRequest(value: GitNexusKnowledgeRequest): {
  common: ValidatedCommon
  requests: GitNexusKnowledgeRequest['requests']
} {
  const input = record(value)
  exactKeys(input, [
    'version',
    'repository_key',
    'repository_root',
    'base_commit_sha',
    'adapter_version',
    'adapter_index_commit_sha',
    'requests',
  ], ['timeout_ms'])
  const common = validateCommon(input)
  if (
    !Array.isArray(input.requests)
    || input.requests.length === 0
    || input.requests.length > MAX_KNOWLEDGE_GRAPH_ADAPTER_REQUESTS
  ) {
    fail('invalid_request')
  }
  const requests = input.requests.map((entry) => {
    const item = record(entry)
    if (item.kind === 'call_graph') {
      exactKeys(item, ['kind', 'symbol'], ['file'])
      return {
        kind: 'call_graph' as const,
        symbol: text(item.symbol),
        ...(item.file === undefined ? {} : { file: relativePath(item.file) }),
      }
    }
    if (item.kind === 'impact') {
      exactKeys(item, ['kind', 'symbol', 'direction'], ['file', 'depth'])
      if (item.direction !== 'upstream' && item.direction !== 'downstream') {
        fail('invalid_request')
      }
      return {
        kind: 'impact' as const,
        symbol: text(item.symbol),
        direction: item.direction as 'upstream' | 'downstream',
        depth: boundedInteger(item.depth, 3, 1, 5),
        ...(item.file === undefined ? {} : { file: relativePath(item.file) }),
      }
    }
    if (item.kind === 'code_flow') {
      exactKeys(item, ['kind', 'query'], ['task_context', 'goal'])
      return {
        kind: 'code_flow' as const,
        query: text(item.query),
        ...(item.task_context === undefined
          ? {}
          : { task_context: text(item.task_context) }),
        ...(item.goal === undefined ? {} : { goal: text(item.goal) }),
      }
    }
    fail('invalid_request')
  })
  return { common, requests }
}

export class GitNexusKnowledgeAdapter {
  constructor(private readonly runner: KnowledgeAdapterCommandRunner = runKnowledgeAdapterCommand) {}

  collect(value: GitNexusKnowledgeRequest): KnowledgeGraphSignal[] {
    const { common, requests } = validateGitNexusRequest(value)
    const retained: KnowledgeGraphSignal[] = []
    for (const request of requests) {
      const queryFingerprint = sha256('gitnexus-query', request)
      let args: string[]
      if (request.kind === 'call_graph') {
        args = [
          'context',
          request.symbol,
          '--repo',
          common.repository_root,
          '--limit',
          '32',
          ...(request.file === undefined ? [] : ['--file', request.file]),
        ]
      } else if (request.kind === 'impact') {
        args = [
          'impact',
          request.symbol,
          '--repo',
          common.repository_root,
          '--direction',
          request.direction,
          '--depth',
          String(request.depth),
          '--limit',
          '32',
          ...(request.file === undefined ? [] : ['--file', request.file]),
        ]
      } else {
        args = [
          'query',
          request.query,
          '--repo',
          common.repository_root,
          '--limit',
          '8',
          ...(request.task_context === undefined
            ? []
            : ['--context', request.task_context]),
          ...(request.goal === undefined ? [] : ['--goal', request.goal]),
        ]
      }
      const output = execute(this.runner, {
        command: 'gitnexus',
        args,
        cwd: common.repository_root,
        timeout_ms: common.timeout_ms,
        max_output_bytes: MAX_KNOWLEDGE_GRAPH_ADAPTER_OUTPUT_BYTES,
      })
      retained.push(...parseGitNexusOutput(
        common,
        request.kind,
        queryFingerprint,
        output,
      ))
    }
    return orderedSignals(retained)
  }
}

function graphPath(root: string, value: unknown): string {
  const supplied = text(value, 4_096)
  const resolved = path.resolve(root, supplied)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('invalid_request')
  let real: string
  try {
    real = fs.realpathSync(resolved)
    if (!fs.statSync(real).isFile()) fail('repository_unavailable')
  } catch (error) {
    if (error instanceof KnowledgeGraphAdapterError) throw error
    fail('repository_unavailable')
  }
  const realRelative = path.relative(root, real)
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) fail('invalid_request')
  return real
}

function validateGraphifyRequest(value: GraphifyKnowledgeRequest): {
  common: ValidatedCommon
  graph_path: string
  questions: GraphifyKnowledgeRequest['questions']
} {
  const input = record(value)
  exactKeys(input, [
    'version',
    'repository_key',
    'repository_root',
    'base_commit_sha',
    'adapter_version',
    'adapter_index_commit_sha',
    'graph_path',
    'questions',
  ], ['timeout_ms'])
  const common = validateCommon(input)
  if (
    !Array.isArray(input.questions)
    || input.questions.length === 0
    || input.questions.length > MAX_KNOWLEDGE_GRAPH_ADAPTER_REQUESTS
  ) {
    fail('invalid_request')
  }
  const questions = input.questions.map((entry) => {
    const item = record(entry)
    exactKeys(item, ['kind', 'question'])
    if (
      item.kind !== 'rationale'
      && item.kind !== 'documentation_relationship'
      && item.kind !== 'cross_cutting_relationship'
    ) {
      fail('invalid_request')
    }
    return { kind: item.kind as GraphifySignalKind, question: text(item.question) }
  })
  return { common, graph_path: graphPath(common.repository_root, input.graph_path), questions }
}

function parseGraphifyOutput(
  common: ValidatedCommon,
  kind: GraphifySignalKind,
  queryFingerprint: string,
  output: string,
): KnowledgeGraphSignal[] {
  const lines = output.split(/\r?\n/u)
  const retained: KnowledgeGraphSignal[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (!line.startsWith('NODE ')) continue
    const sourceMatch = /\[src=([^\]]+?)(?: loc=(L\d+))?(?: community=([^\]]+))?\]$/u.exec(line)
    if (sourceMatch === null) continue
    const source = sourceMatch[1].replaceAll('\\', '/')
    const lineNumber = sourceMatch[2] === undefined
      ? undefined
      : Number(sourceMatch[2].slice(1))
    const sourceLocation = normalizedSourceLocation(source, lineNumber)
    if (sourceLocation === null) continue
    const rawLabel = line.slice(5, sourceMatch.index).trim()
    const label = text(rawLabel, 512)
    const relationship = sourceMatch[3] === undefined
      ? null
      : `community:${text(sourceMatch[3], 128)}`
    const key = `${sourceLocation}\0${label}\0${relationship ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    retained.push(signal(common, 'graphify', kind, queryFingerprint, {
      label,
      symbol: label,
      source_location: sourceLocation,
      relationship,
      relevance_micros: 500_000,
    }))
  }
  return retained
}

export class GraphifyKnowledgeAdapter {
  constructor(private readonly runner: KnowledgeAdapterCommandRunner = runKnowledgeAdapterCommand) {}

  collect(value: GraphifyKnowledgeRequest): KnowledgeGraphSignal[] {
    const { common, graph_path: graph, questions } = validateGraphifyRequest(value)
    const retained: KnowledgeGraphSignal[] = []
    for (const request of questions) {
      const queryFingerprint = sha256('graphify-query', request)
      const output = execute(this.runner, {
        command: 'graphify',
        args: [
          'query',
          request.question,
          '--budget',
          '2_000',
          '--graph',
          graph,
        ],
        cwd: common.repository_root,
        timeout_ms: common.timeout_ms,
        max_output_bytes: MAX_KNOWLEDGE_GRAPH_ADAPTER_OUTPUT_BYTES,
      })
      retained.push(...parseGraphifyOutput(
        common,
        request.kind,
        queryFingerprint,
        output,
      ))
    }
    return orderedSignals(retained)
  }
}

export function knowledgeGraphSignalPath(value: KnowledgeGraphSignal): string {
  const match = SOURCE_LOCATION.exec(value.source_location)
  if (match === null) fail('output_invalid')
  return match[1]
}

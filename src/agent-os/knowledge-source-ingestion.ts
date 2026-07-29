import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import type Database from 'better-sqlite3'
import {
  canonicalKnowledgeJson,
  knowledgeChunkId,
  knowledgeSourceId,
  normalizeKnowledgeLocator,
} from './knowledge-contracts.js'
import {
  DeliveryReportService,
  type DeliveryReport,
} from './delivery-reports.js'
import { KnowledgeStore } from './knowledge-store.js'
import {
  redactSensitiveText,
  redactStructuredValue,
} from './structured-redaction.js'
import type {
  KnowledgeChunk,
  KnowledgeSource,
  KnowledgeSourceKind,
  KnowledgeSourceRange,
  KnowledgeSymbolReference,
  KnowledgeTargetLinks,
  KnowledgeTrustClass,
} from './knowledge-types.js'
import {
  generateVerifiedDeliverySummary,
  selectLatestAcceptedDeliveryRevision,
} from './verified-delivery-summary.js'

export const MAX_KNOWLEDGE_SOURCE_SYMBOLS = 64
export const MAX_KNOWLEDGE_SOURCE_RELATIONSHIPS = 32
export const MAX_KNOWLEDGE_SOURCE_PATHS = 32
export const MAX_KNOWLEDGE_SOURCE_HISTORY_COMMITS = 50
export const MAX_KNOWLEDGE_SOURCE_BLAME_LINES = 500
export const MAX_KNOWLEDGE_SOURCE_GOTCHAS = 32
export const MAX_KNOWLEDGE_SOURCE_FILE_BYTES = 2_000_000
export const MAX_KNOWLEDGE_SOURCE_TOTAL_BYTES = 16_000_000

export type KnowledgeSourceIngestionErrorCode =
  | 'invalid_input'
  | 'board_not_found'
  | 'repository_unavailable'
  | 'repository_root_mismatch'
  | 'repository_revision_mismatch'
  | 'excluded_path'
  | 'evidence_mismatch'
  | 'stale_evidence'
  | 'contradictory_evidence'
  | 'persistence_conflict'
  | 'persistence_failed'

const ERROR_MESSAGES: Record<KnowledgeSourceIngestionErrorCode, string> = {
  invalid_input: 'knowledge source ingestion input is invalid',
  board_not_found: 'knowledge source ingestion board was not found',
  repository_unavailable: 'knowledge source ingestion repository is unavailable',
  repository_root_mismatch: 'knowledge source ingestion repository root does not match the board',
  repository_revision_mismatch: 'knowledge source ingestion revision does not match the repository',
  excluded_path: 'knowledge source ingestion path is excluded',
  evidence_mismatch: 'knowledge source ingestion evidence does not match the cited source',
  stale_evidence: 'knowledge source ingestion evidence is stale',
  contradictory_evidence: 'knowledge source ingestion evidence is contradictory',
  persistence_conflict: 'knowledge source ingestion conflicts with retained knowledge',
  persistence_failed: 'knowledge source ingestion could not persist knowledge',
}
const ERROR_CODES = new Set<KnowledgeSourceIngestionErrorCode>(
  Object.keys(ERROR_MESSAGES) as KnowledgeSourceIngestionErrorCode[],
)
const TRUSTED_ERRORS = new WeakMap<object, KnowledgeSourceIngestionErrorCode>()

/**
 * Fixed messages deliberately omit repository paths, revisions, authors, and
 * evidence content.
 */
export class KnowledgeSourceIngestionError extends Error {
  declare readonly code: KnowledgeSourceIngestionErrorCode

  constructor(code: KnowledgeSourceIngestionErrorCode) {
    const safeCode = typeof code === 'string' && ERROR_CODES.has(code)
      ? code
      : 'invalid_input'
    super(ERROR_MESSAGES[safeCode])
    Object.defineProperties(this, {
      name: {
        value: 'KnowledgeSourceIngestionError',
        enumerable: false,
        configurable: false,
        writable: false,
      },
      code: {
        value: safeCode,
        enumerable: true,
        configurable: false,
        writable: false,
      },
    })
  }
}

export interface StructuralRelationshipInput {
  kind: string
  target_key: string
  start_line?: number
  end_line?: number
}

export interface StructuralSymbolInput {
  key: string
  path: string
  start_line: number
  end_line: number
  language: string
  qualified_name: string
  symbol_kind: string
  /**
   * SHA-256 of the exact committed line slice before redaction. Original line
   * separators between cited lines are retained; the terminator after
   * end_line is outside the slice.
   */
  expected_source_sha256: string
  relationships?: StructuralRelationshipInput[]
}

export interface StructuralKnowledgeIngestionInput {
  board_id: number
  repository_key: string
  repository_root: string
  base_commit_sha: string
  observed_at: string
  symbols: StructuralSymbolInput[]
}

export interface GitBlameRangeInput {
  path: string
  start_line: number
  end_line: number
}

export interface GitContextKnowledgeIngestionInput {
  board_id: number
  repository_key: string
  repository_root: string
  base_commit_sha: string
  observed_at: string
  paths: string[]
  recent_commit_limit?: number
  blame_ranges?: GitBlameRangeInput[]
}

export interface VerifiedGotchaInput {
  path: string
  start_line: number
  end_line: number
  text: string
  /** Same exact pre-redaction committed line-slice hash as structural input. */
  expected_source_sha256: string
}

export interface VerifiedDeliveryKnowledgeIngestionInput {
  board_id: number
  repository_key: string
  repository_root: string
  base_commit_sha: string
  observed_at: string
  report_id: string
  source_commit_sha: string
  gotchas?: VerifiedGotchaInput[]
}

export interface KnowledgeSourceIngestionReport {
  board_id: number
  repository_key: string
  base_commit_sha: string
  sources: KnowledgeSource[]
  chunks: KnowledgeChunk[]
}

interface CommonInput {
  board_id: number
  repository_key: string
  repository_root: string
  base_commit_sha: string
  observed_at: string
}

interface VerifiedRepository {
  root: string
  common_git_directory: string
}

interface CanonicalAuthor {
  name: string
  email: string
}

interface BlameLine {
  line: number
  commit_sha: string
  author: CanonicalAuthor
  authored_at: string
  text: string
}

interface LoadedEvidence {
  path: string
  revision: string
  text: string
  lines: string[]
  line_separators: string[]
}

interface PlannedKnowledge {
  source: KnowledgeSource
  chunk: KnowledgeChunk
}

interface RedactedEnvelope {
  content: string
  redacted: boolean
}

const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const REPOSITORY_KEY = /^[a-z0-9](?:[a-z0-9._/-]{0,254}[a-z0-9])?$/u
const SAFE_KEY = /^[A-Za-z0-9](?:[A-Za-z0-9._:/#-]{0,255})$/u
const RELATIONSHIP_KIND = /^[a-z][a-z0-9_-]{0,63}$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const CODE_EXTENSIONS = new Set([
  '.bash',
  '.c',
  '.cc',
  '.cjs',
  '.cpp',
  '.cs',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scala',
  '.sh',
  '.swift',
  '.ts',
  '.tsx',
  '.zsh',
])
const EXCLUDED_DIRECTORY_NAMES = new Set([
  '__pypackages__',
  'artifacts',
  'bower_components',
  'build',
  'cache',
  'caches',
  'carthage',
  'coverage',
  'dist',
  'gen',
  'generated',
  'logs',
  'node_modules',
  'obj',
  'out',
  'pods',
  'site-packages',
  'target',
  'temp',
  'third-party',
  'third_party',
  'thirdparty',
  'tmp',
  'vendor',
  'venv',
])
const CREDENTIAL_NAMES = new Set([
  '.env',
  'auth.json',
  'credential',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'password',
  'private-key',
  'private-keys',
  'secret',
  'secrets',
  'secrets.json',
  'service-account',
  'service-account.json',
  'service-accounts',
  'token',
])
const SECRET_LOOKING_COMPONENT =
  /(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{12,})/u
const GIT_TIMEOUT_MILLISECONDS = 15_000
const MAX_GIT_OUTPUT_BYTES = 8_000_000
const ADAPTER_ID = 'knowledge-source-ingestion'
const ADAPTER_VERSION = '1.0.0'

function fail(code: KnowledgeSourceIngestionErrorCode): never {
  const error = new KnowledgeSourceIngestionError(code)
  TRUSTED_ERRORS.set(error, code)
  throw error
}

function trustedCode(value: unknown): KnowledgeSourceIngestionErrorCode | null {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return null
  }
  return TRUSTED_ERRORS.get(value) ?? null
}

function remap(
  error: unknown,
  fallback: KnowledgeSourceIngestionErrorCode,
): never {
  fail(trustedCode(error) ?? fallback)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function safeRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail('invalid_input')
    }
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) fail('invalid_input')
    const allowed = new Set([...required, ...optional])
    const keys = Reflect.ownKeys(value)
    if (
      keys.some((key) => typeof key !== 'string' || !allowed.has(key))
      || required.some((key) => !keys.includes(key))
    ) {
      fail('invalid_input')
    }
    const output = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) fail('invalid_input')
      output[key] = descriptor.value
    }
    return output
  } catch (error) {
    remap(error, 'invalid_input')
  }
}

function safeArray(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): unknown[] {
  try {
    if (!Array.isArray(value)) {
      fail('invalid_input')
    }
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Array.prototype && prototype !== null) fail('invalid_input')
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
    if (
      !lengthDescriptor
      || !('value' in lengthDescriptor)
      || typeof lengthDescriptor.value !== 'number'
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value > maximum
      || (!allowEmpty && lengthDescriptor.value === 0)
    ) {
      fail('invalid_input')
    }
    const allowedKeys = new Set([
      'length',
      ...Array.from({ length: lengthDescriptor.value }, (_, index) => String(index)),
    ])
    const keys = Reflect.ownKeys(value)
    if (
      keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
      || allowedKeys.size !== keys.length
    ) {
      fail('invalid_input')
    }
    const output: unknown[] = []
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !('value' in descriptor)) fail('invalid_input')
      output.push(descriptor.value)
    }
    return output
  } catch (error) {
    remap(error, 'invalid_input')
  }
}

function safeText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || value !== value.trim()
    || CONTROL_CHARACTERS.test(value)
  ) {
    fail('invalid_input')
  }
  return value
}

function safeTimestamp(value: unknown): string {
  const supplied = safeText(value, 64)
  const parsed = new Date(supplied)
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== supplied) {
    fail('invalid_input')
  }
  return supplied
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > maximum
  ) {
    fail('invalid_input')
  }
  return value
}

function boundedInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  return value === undefined ? fallback : positiveInteger(value, maximum)
}

function canonicalRepositoryKey(value: unknown): string {
  const supplied = safeText(value, 256)
  if (
    supplied !== supplied.toLowerCase()
    || !REPOSITORY_KEY.test(supplied)
    || supplied.includes('//')
    || supplied.split('/').some((segment) =>
      segment === '.' || segment === '..' || credentialComponent(segment))
  ) {
    fail('invalid_input')
  }
  return supplied
}

function commonInput(record: Record<string, unknown>): CommonInput {
  const commit = safeText(record.base_commit_sha, 64)
  if (!COMMIT_SHA.test(commit)) fail('invalid_input')
  const root = safeText(record.repository_root, 16_384)
  if (!path.isAbsolute(root)) fail('invalid_input')
  return {
    board_id: positiveInteger(record.board_id),
    repository_key: canonicalRepositoryKey(record.repository_key),
    repository_root: path.resolve(root),
    base_commit_sha: commit,
    observed_at: safeTimestamp(record.observed_at),
  }
}

function credentialComponent(value: string): boolean {
  const lower = value.toLowerCase()
  const extension = path.posix.extname(lower)
  const stem = extension.length === 0 ? lower : lower.slice(0, -extension.length)
  return CREDENTIAL_NAMES.has(lower)
    || CREDENTIAL_NAMES.has(stem)
    || lower.startsWith('.env.')
    || /\.(?:jks|key|p12|pfx|pem)$/u.test(lower)
    || /(?:^|[-_.])(?:api[-_]?key|auth[-_]?token|credential|password|private[-_]?key|secret|service[-_]?account)(?:$|[-_.])/u
      .test(stem)
    || SECRET_LOOKING_COMPONENT.test(value)
    || redactSensitiveText(value).changed
}

function safeRepositoryPath(value: unknown, codeOnly = false): string {
  const supplied = safeText(value, 2_048)
  const segments = supplied.split('/')
  if (
    path.posix.isAbsolute(supplied)
    || supplied.startsWith('-')
    || supplied.includes('\\')
    || /[:?#%]/u.test(supplied)
    || segments.some((segment) =>
      segment.length === 0
      || segment !== segment.trim()
      || segment === '.'
      || segment === '..')
  ) {
    fail('invalid_input')
  }
  if (
    segments.some((segment) =>
      segment.startsWith('.')
      || EXCLUDED_DIRECTORY_NAMES.has(segment.toLowerCase())
      || credentialComponent(segment))
  ) {
    fail('excluded_path')
  }
  if (codeOnly && !CODE_EXTENSIONS.has(path.posix.extname(supplied).toLowerCase())) {
    fail('excluded_path')
  }
  try {
    if (normalizeKnowledgeLocator(supplied) !== supplied) fail('invalid_input')
  } catch (error) {
    remap(error, 'invalid_input')
  }
  return supplied
}

function trustedGitExecutable(): string {
  const candidates = process.platform === 'win32'
    ? [
        `${process.env.ProgramFiles ?? ''}\\Git\\cmd\\git.exe`,
        `${process.env['ProgramFiles(x86)'] ?? ''}\\Git\\cmd\\git.exe`,
      ]
    : ['/usr/bin/git']
  const executable = candidates.find((candidate) =>
    candidate.length > 0 && fs.existsSync(candidate))
  if (!executable) fail('repository_unavailable')
  return executable
}

function isolatedGitEnvironment(executable: string): NodeJS.ProcessEnv {
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const environment: NodeJS.ProcessEnv = {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: path.dirname(executable),
  }
  if (process.platform === 'win32' && process.env.SystemRoot) {
    environment.SystemRoot = process.env.SystemRoot
  }
  return environment
}

function gitAttempt(
  root: string,
  arguments_: readonly string[],
  maxBuffer = MAX_GIT_OUTPUT_BYTES,
): { ok: boolean; stdout: Buffer } {
  const executable = trustedGitExecutable()
  const result = spawnSync(
    executable,
    ['-c', 'core.fsmonitor=false', '-C', root, ...arguments_],
    {
      encoding: null,
      env: isolatedGitEnvironment(executable),
      killSignal: 'SIGKILL',
      maxBuffer,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MILLISECONDS,
      windowsHide: true,
    },
  )
  if (
    result.error !== undefined
    || result.signal !== null
    || !Buffer.isBuffer(result.stdout)
  ) {
    fail('repository_unavailable')
  }
  return { ok: result.status === 0, stdout: result.stdout }
}

function decodeUtf8(
  bytes: Buffer,
  allowEmpty = false,
  allowNul = false,
): string {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (
      (!allowEmpty && decoded.length === 0)
      || (!allowNul && decoded.includes('\u0000'))
    ) {
      fail('repository_unavailable')
    }
    return decoded
  } catch (error) {
    remap(error, 'repository_unavailable')
  } finally {
    bytes.fill(0)
  }
}

function gitText(
  root: string,
  arguments_: readonly string[],
  options: {
    allow_empty?: boolean
    allow_nul?: boolean
    failure?: KnowledgeSourceIngestionErrorCode
    max_buffer?: number
  } = {},
): string {
  const result = gitAttempt(root, arguments_, options.max_buffer)
  if (!result.ok) {
    result.stdout.fill(0)
    fail(options.failure ?? 'repository_unavailable')
  }
  return decodeUtf8(result.stdout, options.allow_empty, options.allow_nul)
}

function trimSingleNewline(value: string): string {
  return value.endsWith('\r\n')
    ? value.slice(0, -2)
    : value.endsWith('\n')
      ? value.slice(0, -1)
      : value
}

function realDirectory(value: string): string {
  try {
    const resolved = fs.realpathSync(value)
    if (!fs.statSync(resolved).isDirectory()) fail('repository_unavailable')
    return resolved
  } catch (error) {
    remap(error, 'repository_unavailable')
  }
}

function gitScalar(root: string, arguments_: readonly string[]): string {
  const output = trimSingleNewline(gitText(root, arguments_))
  if (!output || CONTROL_CHARACTERS.test(output)) fail('repository_unavailable')
  return output
}

function verifyRepository(
  db: Database.Database,
  input: CommonInput,
): VerifiedRepository {
  const board = db.prepare('SELECT project_path FROM boards WHERE id=?')
    .get(input.board_id) as { project_path?: unknown } | undefined
  if (!board || typeof board.project_path !== 'string') fail('board_not_found')
  const boardRoot = realDirectory(board.project_path)
  const root = realDirectory(input.repository_root)
  if (boardRoot !== root) fail('repository_root_mismatch')
  const top = realDirectory(gitScalar(root, ['rev-parse', '--show-toplevel']))
  if (top !== root) fail('repository_root_mismatch')
  const commonSupplied = gitScalar(root, ['rev-parse', '--git-common-dir'])
  const common = fs.realpathSync(path.isAbsolute(commonSupplied)
    ? commonSupplied
    : path.resolve(root, commonSupplied))
  if (gitScalar(root, ['rev-parse', 'HEAD']) !== input.base_commit_sha) {
    fail('repository_revision_mismatch')
  }
  return { root, common_git_directory: common }
}

function assertRepositoryStable(
  db: Database.Database,
  input: CommonInput,
  verified: VerifiedRepository,
): void {
  const board = db.prepare('SELECT project_path FROM boards WHERE id=?')
    .get(input.board_id) as { project_path?: unknown } | undefined
  if (
    !board
    || typeof board.project_path !== 'string'
    || realDirectory(board.project_path) !== verified.root
  ) {
    fail('repository_root_mismatch')
  }
  if (
    realDirectory(gitScalar(verified.root, ['rev-parse', '--show-toplevel']))
      !== verified.root
  ) {
    fail('repository_root_mismatch')
  }
  const commonSupplied = gitScalar(
    verified.root,
    ['rev-parse', '--git-common-dir'],
  )
  const common = fs.realpathSync(path.isAbsolute(commonSupplied)
    ? commonSupplied
    : path.resolve(verified.root, commonSupplied))
  if (common !== verified.common_git_directory) fail('repository_root_mismatch')
  if (gitScalar(verified.root, ['rev-parse', 'HEAD']) !== input.base_commit_sha) {
    fail('repository_revision_mismatch')
  }
}

function assertCommit(
  root: string,
  commit: string,
  failureCode: KnowledgeSourceIngestionErrorCode,
): void {
  const result = gitAttempt(root, ['cat-file', '-e', `${commit}^{commit}`], 1_024)
  result.stdout.fill(0)
  if (!result.ok) fail(failureCode)
}

function assertAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): void {
  const result = gitAttempt(
    root,
    ['merge-base', '--is-ancestor', ancestor, descendant],
    1_024,
  )
  result.stdout.fill(0)
  if (!result.ok) fail('stale_evidence')
}

function splitLines(value: string): {
  lines: string[]
  separators: string[]
} {
  const lines: string[] = []
  const separators: string[] = []
  const separator = /\r\n|\r|\n/gu
  let start = 0
  for (let match = separator.exec(value); match; match = separator.exec(value)) {
    lines.push(value.slice(start, match.index))
    separators.push(match[0])
    start = match.index + match[0].length
  }
  if (start < value.length || lines.length === 0) {
    lines.push(value.slice(start))
    separators.push('')
  }
  return { lines, separators }
}

function loadEvidence(
  root: string,
  revision: string,
  repositoryPath: string,
): LoadedEvidence {
  const tree = gitText(
    root,
    ['ls-tree', '-z', revision, '--', repositoryPath],
    { failure: 'evidence_mismatch', allow_nul: true, max_buffer: 8_192 },
  )
  const treeMatch =
    /^(100644|100755) blob (?:[a-f0-9]{40}|[a-f0-9]{64})\t([^\u0000]+)\u0000$/u
      .exec(tree)
  if (!treeMatch || treeMatch[2] !== repositoryPath) fail('evidence_mismatch')
  const type = trimSingleNewline(gitText(
    root,
    ['cat-file', '-t', `${revision}:${repositoryPath}`],
    { failure: 'evidence_mismatch', max_buffer: 256 },
  ))
  if (type !== 'blob') fail('evidence_mismatch')
  const text = gitText(
    root,
    ['show', '--no-ext-diff', '--no-textconv', `${revision}:${repositoryPath}`],
    { failure: 'evidence_mismatch', max_buffer: MAX_KNOWLEDGE_SOURCE_FILE_BYTES },
  )
  if (Buffer.byteLength(text, 'utf8') > MAX_KNOWLEDGE_SOURCE_FILE_BYTES) {
    fail('invalid_input')
  }
  const split = splitLines(text)
  return {
    path: repositoryPath,
    revision,
    text,
    lines: split.lines,
    line_separators: split.separators,
  }
}

function excerpt(
  evidence: LoadedEvidence,
  startLine: number,
  endLine: number,
): { raw: string; redacted: string; changed: boolean } {
  if (
    startLine > endLine
    || startLine > evidence.lines.length
    || endLine > evidence.lines.length
  ) {
    fail('evidence_mismatch')
  }
  const selected = evidence.lines.slice(startLine - 1, endLine)
  const raw = selected.map((line, index) =>
    index === selected.length - 1
      ? line
      : `${line}${evidence.line_separators[startLine - 1 + index]}`).join('')
  if (raw.length === 0) fail('evidence_mismatch')
  const redaction = redactSensitiveText(raw)
  if (redaction.value === null || redaction.value.length === 0) {
    fail('evidence_mismatch')
  }
  return { raw, redacted: redaction.value, changed: redaction.changed }
}

function safeAuthor(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 500 || CONTROL_CHARACTERS.test(trimmed)) {
    fail('evidence_mismatch')
  }
  const redaction = redactSensitiveText(trimmed)
  if (redaction.value === null || redaction.value.length === 0) {
    fail('evidence_mismatch')
  }
  return redaction.value
}

function parseBlame(
  root: string,
  revision: string,
  repositoryPath: string,
  startLine: number,
  endLine: number,
): BlameLine[] {
  const output = gitText(root, [
    'blame',
    '--line-porcelain',
    '-L',
    `${startLine},${endLine}`,
    revision,
    '--',
    repositoryPath,
  ], { failure: 'evidence_mismatch' })
  const rows = output.split('\n')
  const lines: BlameLine[] = []
  let index = 0
  while (index < rows.length && rows[index] !== '') {
    const header = /^\^?([a-f0-9]{40}|[a-f0-9]{64}) [0-9]+ ([0-9]+)(?: [0-9]+)?$/u
      .exec(rows[index])
    if (!header) fail('evidence_mismatch')
    const commitSha = header[1]
    const finalLine = Number(header[2])
    index += 1
    let author: string | null = null
    let email: string | null = null
    let authoredAt: string | null = null
    let content: string | null = null
    while (index < rows.length) {
      const row = rows[index]
      index += 1
      if (row.startsWith('\t')) {
        content = row.slice(1)
        break
      }
      if (row.startsWith('author ')) author = row.slice('author '.length)
      if (row.startsWith('author-mail ')) {
        const supplied = row.slice('author-mail '.length)
        email = supplied.startsWith('<') && supplied.endsWith('>')
          ? supplied.slice(1, -1)
          : supplied
      }
      if (row.startsWith('author-time ')) {
        const seconds = Number(row.slice('author-time '.length))
        if (Number.isSafeInteger(seconds)) {
          authoredAt = new Date(seconds * 1_000).toISOString()
        }
      }
    }
    if (
      author === null
      || email === null
      || authoredAt === null
      || content === null
      || finalLine < startLine
      || finalLine > endLine
    ) {
      fail('evidence_mismatch')
    }
    const redaction = redactSensitiveText(content)
    if (redaction.value === null) fail('evidence_mismatch')
    lines.push({
      line: finalLine,
      commit_sha: commitSha,
      author: {
        name: safeAuthor(author),
        email: safeAuthor(email),
      },
      authored_at: authoredAt,
      text: redaction.value,
    })
  }
  if (rows.slice(index).some((row) => row !== '')) fail('evidence_mismatch')
  lines.sort((left, right) => left.line - right.line)
  if (
    lines.length !== endLine - startLine + 1
    || lines.some((line, position) => line.line !== startLine + position)
  ) {
    fail('evidence_mismatch')
  }
  return lines
}

function uniqueAuthors(lines: readonly BlameLine[]): CanonicalAuthor[] {
  const authors = new Map<string, CanonicalAuthor>()
  for (const line of lines) {
    const key = `${line.author.name}\u0000${line.author.email}`
    authors.set(key, line.author)
  }
  return [...authors.values()].sort((left, right) =>
    compareText(left.name, right.name)
      || compareText(left.email, right.email))
}

function redactEnvelope(value: unknown): RedactedEnvelope {
  const redacted = redactStructuredValue(value)
  const content = `${canonicalKnowledgeJson(redacted.value)}\n`
  if (
    content.length === 0
    || Buffer.byteLength(content, 'utf8') > MAX_KNOWLEDGE_SOURCE_FILE_BYTES
  ) {
    fail('invalid_input')
  }
  return {
    content,
    redacted: redacted.changed || content.includes('[REDACTED]'),
  }
}

function range(startLine: number | null, endLine: number | null): KnowledgeSourceRange {
  return {
    start_line: startLine,
    end_line: endLine,
    start_byte: null,
    end_byte: null,
  }
}

function boardTargets(boardId: number): KnowledgeTargetLinks {
  return {
    board_id: boardId,
    workspace_id: null,
    card_id: null,
    contract_ref: null,
    contract_version: null,
    contract_snapshot_sha256: null,
    job_id: null,
    profile_id: null,
    session_id: null,
    delivery_report_id: null,
  }
}

function deliveryTargets(report: DeliveryReport): KnowledgeTargetLinks {
  return {
    board_id: report.board_id,
    workspace_id: report.workspace_id,
    card_id: report.card_id,
    contract_ref: `card:${report.card_id}:v${report.asked.contract_version}`,
    contract_version: report.asked.contract_version,
    contract_snapshot_sha256: sha256(JSON.stringify(report.asked)),
    job_id: report.job_id,
    profile_id: null,
    session_id: report.session_id,
    delivery_report_id: report.id,
  }
}

function planKnowledge(input: {
  common: CommonInput
  kind: KnowledgeSourceKind
  trust: KnowledgeTrustClass
  title: string
  locator: string
  source_revision: string
  content: string
  redacted: boolean
  source_range: KnowledgeSourceRange
  symbol: KnowledgeSymbolReference | null
  targets: KnowledgeTargetLinks
}): PlannedKnowledge {
  const locator = normalizeKnowledgeLocator(input.locator)
  const contentHash = sha256(input.content)
  const sourceWithoutId: Omit<KnowledgeSource, 'id'> = {
    source_kind: input.kind,
    trust_class: input.trust,
    title: input.title,
    locator,
    normalized_locator: locator,
    source_revision: input.source_revision,
    content_sha256: contentHash,
    freshness_policy: 'commit_exact',
    freshness_state: 'fresh',
    redaction_state: input.redacted ? 'redacted' : 'none',
    content_state: 'present',
    ingest_state: 'active',
    access_scope: { kind: 'board' },
    targets: input.targets,
    provenance: {
      repository_key: input.common.repository_key,
      base_commit_sha: input.common.base_commit_sha,
      worktree_state_hash: null,
      relative_root: '.',
      adapter_id: ADAPTER_ID,
      adapter_version: ADAPTER_VERSION,
      adapter_index_commit_sha: null,
      observed_at: input.common.observed_at,
    },
    created_at: input.common.observed_at,
    updated_at: input.common.observed_at,
  }
  const source: KnowledgeSource = {
    ...sourceWithoutId,
    id: knowledgeSourceId({
      repository_key: input.common.repository_key,
      source_kind: input.kind,
      normalized_locator: locator,
      source_revision: input.source_revision,
      content_sha256: contentHash,
    }),
  }
  const chunkWithoutId: Omit<KnowledgeChunk, 'id'> = {
    source_id: source.id,
    ordinal: 0,
    content: input.content,
    content_sha256: contentHash,
    character_count: input.content.length,
    byte_count: Buffer.byteLength(input.content, 'utf8'),
    estimated_tokens: Math.max(1, Math.ceil(input.content.length / 4)),
    source_range: input.source_range,
    symbol: input.symbol,
    created_at: input.common.observed_at,
  }
  return {
    source,
    chunk: {
      ...chunkWithoutId,
      id: knowledgeChunkId({
        source_id: source.id,
        ordinal: 0,
        content_sha256: contentHash,
        source_range: input.source_range,
      }),
    },
  }
}

function sourceReplayCompatible(
  retained: KnowledgeSource,
  planned: KnowledgeSource,
): boolean {
  return retained.id === planned.id
    && retained.source_kind === planned.source_kind
    && retained.trust_class === planned.trust_class
    && retained.title === planned.title
    && retained.locator === planned.locator
    && retained.normalized_locator === planned.normalized_locator
    && retained.source_revision === planned.source_revision
    && retained.content_sha256 === planned.content_sha256
    && retained.freshness_policy === planned.freshness_policy
    && retained.freshness_state === planned.freshness_state
    && retained.redaction_state === planned.redaction_state
    && retained.content_state === planned.content_state
    && retained.ingest_state === planned.ingest_state
    && canonicalKnowledgeJson(retained.access_scope)
      === canonicalKnowledgeJson(planned.access_scope)
    && canonicalKnowledgeJson(retained.targets)
      === canonicalKnowledgeJson(planned.targets)
    && retained.provenance.repository_key === planned.provenance.repository_key
    && retained.provenance.base_commit_sha === planned.provenance.base_commit_sha
    && retained.provenance.worktree_state_hash
      === planned.provenance.worktree_state_hash
    && retained.provenance.relative_root === planned.provenance.relative_root
    && retained.provenance.adapter_id === planned.provenance.adapter_id
    && retained.provenance.adapter_version === planned.provenance.adapter_version
    && retained.provenance.adapter_index_commit_sha
      === planned.provenance.adapter_index_commit_sha
}

function chunkReplayCompatible(
  retained: KnowledgeChunk,
  planned: KnowledgeChunk,
): boolean {
  return retained.id === planned.id
    && retained.source_id === planned.source_id
    && retained.ordinal === planned.ordinal
    && retained.content === planned.content
    && retained.content_sha256 === planned.content_sha256
    && retained.character_count === planned.character_count
    && retained.byte_count === planned.byte_count
    && retained.estimated_tokens === planned.estimated_tokens
    && canonicalKnowledgeJson(retained.source_range)
      === canonicalKnowledgeJson(planned.source_range)
    && canonicalKnowledgeJson(retained.symbol)
      === canonicalKnowledgeJson(planned.symbol)
}

function persist(
  db: Database.Database,
  common: CommonInput,
  verified: VerifiedRepository,
  plans: readonly PlannedKnowledge[],
  finalAssertion?: () => void,
): KnowledgeSourceIngestionReport {
  const ordered = [...plans].sort((left, right) =>
    compareText(left.source.source_kind, right.source.source_kind)
      || compareText(left.source.normalized_locator, right.source.normalized_locator)
      || compareText(left.source.source_revision, right.source.source_revision)
      || compareText(left.source.id, right.source.id))
  const totalBytes = ordered.reduce((total, plan) => total + plan.chunk.byte_count, 0)
  if (totalBytes > MAX_KNOWLEDGE_SOURCE_TOTAL_BYTES) fail('invalid_input')
  const store = new KnowledgeStore(db)
  try {
    const save = db.transaction(() => {
      assertRepositoryStable(db, common, verified)
      finalAssertion?.()
      const sources: KnowledgeSource[] = []
      const chunks: KnowledgeChunk[] = []
      for (const plan of ordered) {
        const existingSource = store.getSource(common.board_id, plan.source.id)
        const source = existingSource
          ? sourceReplayCompatible(existingSource, plan.source)
            ? existingSource
            : fail('persistence_conflict')
          : store.putSource(plan.source)
        const existingChunk = store.getChunk(common.board_id, plan.chunk.id)
        let chunk: KnowledgeChunk
        if (existingChunk) {
          if (!chunkReplayCompatible(existingChunk, plan.chunk)) {
            fail('persistence_conflict')
          }
          chunk = existingChunk
        } else {
          const occupied = db.prepare(`SELECT 1 AS present FROM knowledge_chunks
            WHERE board_id=? AND source_id=? AND ordinal=?`)
            .get(common.board_id, plan.chunk.source_id, plan.chunk.ordinal)
          if (occupied !== undefined) fail('persistence_conflict')
          chunk = store.putChunk(common.board_id, plan.chunk)
        }
        sources.push(source)
        chunks.push(chunk)
      }
      finalAssertion?.()
      assertRepositoryStable(db, common, verified)
      return { sources, chunks }
    })
    const retained = save.immediate()
    return {
      board_id: common.board_id,
      repository_key: common.repository_key,
      base_commit_sha: common.base_commit_sha,
      sources: retained.sources,
      chunks: retained.chunks,
    }
  } catch (error) {
    remap(error, trustedCode(error) ?? 'persistence_failed')
  }
}

function validateStructuralInput(
  value: StructuralKnowledgeIngestionInput,
): { common: CommonInput; symbols: StructuralSymbolInput[] } {
  const record = safeRecord(value, [
    'board_id',
    'repository_key',
    'repository_root',
    'base_commit_sha',
    'observed_at',
    'symbols',
  ])
  const symbols = safeArray(record.symbols, MAX_KNOWLEDGE_SOURCE_SYMBOLS)
    .map((item): StructuralSymbolInput => {
      const symbol = safeRecord(item, [
        'key',
        'path',
        'start_line',
        'end_line',
        'language',
        'qualified_name',
        'symbol_kind',
        'expected_source_sha256',
      ], ['relationships'])
      const key = safeText(symbol.key, 256)
      if (!SAFE_KEY.test(key)) fail('invalid_input')
      const expectedHash = safeText(symbol.expected_source_sha256, 64)
      if (!SHA256.test(expectedHash)) fail('invalid_input')
      const relationships = safeArray(
        symbol.relationships ?? [],
        MAX_KNOWLEDGE_SOURCE_RELATIONSHIPS,
        true,
      ).map((relationship): StructuralRelationshipInput => {
        const relation = safeRecord(
          relationship,
          ['kind', 'target_key'],
          ['start_line', 'end_line'],
        )
        const kind = safeText(relation.kind, 64)
        const target = safeText(relation.target_key, 256)
        if (!RELATIONSHIP_KIND.test(kind) || !SAFE_KEY.test(target)) {
          fail('invalid_input')
        }
        return {
          kind,
          target_key: target,
          start_line: relation.start_line === undefined
            ? undefined
            : positiveInteger(relation.start_line),
          end_line: relation.end_line === undefined
            ? undefined
            : positiveInteger(relation.end_line),
        }
      })
      const relationshipKeys = new Set<string>()
      for (const relationship of relationships) {
        const identity = canonicalKnowledgeJson(relationship)
        if (relationshipKeys.has(identity)) fail('contradictory_evidence')
        relationshipKeys.add(identity)
      }
      const startLine = positiveInteger(symbol.start_line)
      const endLine = positiveInteger(symbol.end_line)
      if (endLine < startLine) fail('invalid_input')
      return {
        key,
        path: safeRepositoryPath(symbol.path, true),
        start_line: startLine,
        end_line: endLine,
        language: safeText(symbol.language, 100),
        qualified_name: safeText(symbol.qualified_name, 1_000),
        symbol_kind: safeText(symbol.symbol_kind, 100),
        expected_source_sha256: expectedHash,
        relationships,
      }
    })
  const keys = new Set(symbols.map((symbol) => symbol.key))
  if (keys.size !== symbols.length) fail('contradictory_evidence')
  for (const symbol of symbols) {
    for (const relationship of symbol.relationships ?? []) {
      if (!keys.has(relationship.target_key)) fail('evidence_mismatch')
      if (
        relationship.kind === 'contains'
        && relationship.target_key === symbol.key
      ) {
        fail('contradictory_evidence')
      }
      if (
        (relationship.start_line === undefined)
        !== (relationship.end_line === undefined)
      ) {
        fail('invalid_input')
      }
    }
  }
  return { common: commonInput(record), symbols }
}

function structuralPlans(
  common: CommonInput,
  root: string,
  symbols: readonly StructuralSymbolInput[],
): PlannedKnowledge[] {
  const evidenceCache = new Map<string, LoadedEvidence>()
  const blameCache = new Map<string, BlameLine[]>()
  const symbolMap = new Map(symbols.map((symbol) => [symbol.key, symbol]))
  const plans: PlannedKnowledge[] = []
  let evidenceBytes = 0
  for (const symbol of [...symbols].sort((left, right) =>
    compareText(left.path, right.path)
      || left.start_line - right.start_line
      || left.end_line - right.end_line
      || compareText(left.key, right.key))) {
    let evidence = evidenceCache.get(symbol.path)
    if (!evidence) {
      evidence = loadEvidence(root, common.base_commit_sha, symbol.path)
      evidenceBytes += Buffer.byteLength(evidence.text, 'utf8')
      if (evidenceBytes > MAX_KNOWLEDGE_SOURCE_TOTAL_BYTES) fail('invalid_input')
      evidenceCache.set(symbol.path, evidence)
    }
    const sourceExcerpt = excerpt(evidence, symbol.start_line, symbol.end_line)
    if (sha256(sourceExcerpt.raw) !== symbol.expected_source_sha256) {
      fail('evidence_mismatch')
    }
    const blameKey = `${symbol.path}\u0000${symbol.start_line}\u0000${symbol.end_line}`
    let blamed = blameCache.get(blameKey)
    if (!blamed) {
      blamed = parseBlame(
        root,
        common.base_commit_sha,
        symbol.path,
        symbol.start_line,
        symbol.end_line,
      )
      blameCache.set(blameKey, blamed)
    }
    const relationships = (symbol.relationships ?? [])
      .map((relationship) => {
        const target = symbolMap.get(relationship.target_key)
        if (!target) fail('evidence_mismatch')
        const startLine = relationship.start_line ?? symbol.start_line
        const endLine = relationship.end_line ?? symbol.end_line
        if (
          startLine < symbol.start_line
          || endLine > symbol.end_line
          || endLine < startLine
        ) {
          fail('evidence_mismatch')
        }
        const relationshipExcerpt = excerpt(evidence!, startLine, endLine)
        if (relationship.kind === 'contains') {
          if (
            symbol.path !== target.path
            || target.start_line < symbol.start_line
            || target.end_line > symbol.end_line
          ) {
            fail('contradictory_evidence')
          }
        } else {
          const targetToken = target.qualified_name.split(/[.:/#]/u).at(-1) ?? ''
          if (!targetToken || !relationshipExcerpt.raw.includes(targetToken)) {
            fail('evidence_mismatch')
          }
        }
        return {
          citation: {
            commit_sha: common.base_commit_sha,
            end_line: endLine,
            path: symbol.path,
            repository_key: common.repository_key,
            start_line: startLine,
          },
          persisted_evidence_sha256: sha256(relationshipExcerpt.redacted),
          source_sha256: sha256(relationshipExcerpt.raw),
          kind: relationship.kind,
          target: {
            end_line: target.end_line,
            key: target.key,
            path: target.path,
            qualified_name: target.qualified_name,
            start_line: target.start_line,
          },
        }
      })
      .sort((left, right) =>
        compareText(left.kind, right.kind)
          || compareText(left.target.path, right.target.path)
          || left.target.start_line - right.target.start_line
          || compareText(left.target.key, right.target.key))
    const envelope = redactEnvelope({
      authors: uniqueAuthors(blamed),
      citation: {
        commit_sha: common.base_commit_sha,
        end_line: symbol.end_line,
        path: symbol.path,
        repository_key: common.repository_key,
        start_line: symbol.start_line,
      },
      confidence_micros: 950_000,
      evidence: {
        persisted_evidence_sha256: sha256(sourceExcerpt.redacted),
        source_sha256: symbol.expected_source_sha256,
        text: sourceExcerpt.redacted,
      },
      interpretation: 'data_only',
      kind: 'code_symbol',
      relationships,
      schema_version: 1,
      symbol: {
        key: symbol.key,
        language: symbol.language,
        qualified_name: symbol.qualified_name,
        symbol_kind: symbol.symbol_kind,
      },
    })
    plans.push(planKnowledge({
      common,
      kind: 'code_symbol',
      trust: 'reference',
      title: symbol.qualified_name,
      locator:
        `code-symbols/${symbol.path}/lines-${symbol.start_line}-${symbol.end_line}-${sha256(symbol.key).slice(0, 12)}.json`,
      source_revision: common.base_commit_sha,
      content: envelope.content,
      redacted: envelope.redacted || sourceExcerpt.changed
        || blamed.some((line) => line.text === '[REDACTED]'),
      source_range: range(symbol.start_line, symbol.end_line),
      symbol: {
        language: symbol.language,
        qualified_name: symbol.qualified_name,
        symbol_kind: symbol.symbol_kind,
        signature_sha256: symbol.expected_source_sha256,
      },
      targets: boardTargets(common.board_id),
    }))
  }
  return plans
}

function validateGitContextInput(
  value: GitContextKnowledgeIngestionInput,
): {
  common: CommonInput
  paths: string[]
  recent_commit_limit: number
  blame_ranges: GitBlameRangeInput[]
} {
  const record = safeRecord(value, [
    'board_id',
    'repository_key',
    'repository_root',
    'base_commit_sha',
    'observed_at',
    'paths',
  ], ['recent_commit_limit', 'blame_ranges'])
  const paths = safeArray(record.paths, MAX_KNOWLEDGE_SOURCE_PATHS)
    .map((item) => safeRepositoryPath(item))
  if (new Set(paths).size !== paths.length) fail('invalid_input')
  const blameRanges = safeArray(
    record.blame_ranges ?? [],
    MAX_KNOWLEDGE_SOURCE_PATHS,
    true,
  ).map((item): GitBlameRangeInput => {
    const blame = safeRecord(item, ['path', 'start_line', 'end_line'])
    const repositoryPath = safeRepositoryPath(blame.path)
    if (!paths.includes(repositoryPath)) fail('invalid_input')
    const startLine = positiveInteger(blame.start_line)
    const endLine = positiveInteger(blame.end_line)
    if (endLine < startLine) fail('invalid_input')
    return { path: repositoryPath, start_line: startLine, end_line: endLine }
  })
  const blameKeys = new Set<string>()
  for (const blame of blameRanges) {
    const identity = `${blame.path}\u0000${blame.start_line}\u0000${blame.end_line}`
    if (blameKeys.has(identity)) fail('contradictory_evidence')
    blameKeys.add(identity)
  }
  const totalLines = blameRanges.reduce(
    (total, blame) => total + blame.end_line - blame.start_line + 1,
    0,
  )
  if (totalLines > MAX_KNOWLEDGE_SOURCE_BLAME_LINES) fail('invalid_input')
  return {
    common: commonInput(record),
    paths: [...paths].sort(),
    recent_commit_limit: boundedInteger(
      record.recent_commit_limit,
      20,
      MAX_KNOWLEDGE_SOURCE_HISTORY_COMMITS,
    ),
    blame_ranges: [...blameRanges].sort((left, right) =>
      compareText(left.path, right.path)
        || left.start_line - right.start_line
        || left.end_line - right.end_line),
  }
}

function selectedCommitHashes(
  root: string,
  baseCommit: string,
  paths: readonly string[],
  limit: number,
): string[] {
  const output = gitText(root, [
    'rev-list',
    `--max-count=${limit}`,
    baseCommit,
    '--',
    ...paths,
  ], { allow_empty: true })
  if (output.length === 0) return []
  const commits = trimSingleNewline(output).split('\n')
  if (
    commits.length > limit
    || commits.some((commit) => !COMMIT_SHA.test(commit))
  ) {
    fail('evidence_mismatch')
  }
  return commits
}

function commitMetadata(
  root: string,
  commit: string,
): {
  commit_sha: string
  author: CanonicalAuthor
  authored_at: string
  subject: string
} {
  const output = trimSingleNewline(gitText(root, [
    'show',
    '-s',
    '--format=%H%x00%an%x00%ae%x00%aI%x00%s',
    commit,
  ], { failure: 'evidence_mismatch', allow_nul: true }))
  const fields = output.split('\u0000')
  if (
    fields.length !== 5
    || fields[0] !== commit
    || !Number.isFinite(new Date(fields[3]).valueOf())
  ) {
    fail('evidence_mismatch')
  }
  const subject = redactSensitiveText(fields[4])
  if (subject.value === null || subject.value.length === 0) {
    fail('evidence_mismatch')
  }
  return {
    commit_sha: commit,
    author: {
      name: safeAuthor(fields[1]),
      email: safeAuthor(fields[2]),
    },
    authored_at: new Date(fields[3]).toISOString(),
    subject: subject.value,
  }
}

function changedSelectedPaths(
  root: string,
  commit: string,
  selectedPaths: readonly string[],
): string[] {
  const output = gitText(root, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--name-only',
    '-r',
    '-z',
    commit,
    '--',
    ...selectedPaths,
  ], { allow_empty: true, allow_nul: true })
  if (output.length === 0) return []
  const changed = output.split('\u0000').filter(Boolean)
    .map((item) => safeRepositoryPath(item))
    .filter((item) => selectedPaths.includes(item))
  return [...new Set(changed)].sort()
}

function historyPlans(
  common: CommonInput,
  root: string,
  paths: readonly string[],
  limit: number,
): PlannedKnowledge[] {
  return selectedCommitHashes(root, common.base_commit_sha, paths, limit)
    .map((commit) => {
      const metadata = commitMetadata(root, commit)
      const changedPaths = changedSelectedPaths(root, commit, paths)
      if (changedPaths.length === 0) fail('evidence_mismatch')
      const envelope = redactEnvelope({
        authored_at: metadata.authored_at,
        author: metadata.author,
        changed_paths: changedPaths,
        citation: {
          commit_sha: commit,
          repository_key: common.repository_key,
        },
        confidence_micros: 1_000_000,
        interpretation: 'data_only',
        kind: 'git_history',
        schema_version: 1,
        subject: metadata.subject,
      })
      return planKnowledge({
        common,
        kind: 'git_history',
        trust: 'reference',
        title: `Git commit ${commit.slice(0, 12)}`,
        locator: `git/commits/${commit}.json`,
        source_revision: commit,
        content: envelope.content,
        redacted: envelope.redacted,
        source_range: range(null, null),
        symbol: null,
        targets: boardTargets(common.board_id),
      })
    })
}

function blamePlans(
  common: CommonInput,
  root: string,
  ranges: readonly GitBlameRangeInput[],
): PlannedKnowledge[] {
  return ranges.map((input) => {
    const evidence = loadEvidence(root, common.base_commit_sha, input.path)
    const cited = excerpt(evidence, input.start_line, input.end_line)
    const lines = parseBlame(
      root,
      common.base_commit_sha,
      input.path,
      input.start_line,
      input.end_line,
    )
    const envelope = redactEnvelope({
      authors: uniqueAuthors(lines),
      citation: {
        commit_sha: common.base_commit_sha,
        end_line: input.end_line,
        path: input.path,
        repository_key: common.repository_key,
        start_line: input.start_line,
      },
      confidence_micros: 1_000_000,
      persisted_evidence_sha256: sha256(cited.redacted),
      source_sha256: sha256(cited.raw),
      interpretation: 'data_only',
      kind: 'git_blame',
      lines,
      schema_version: 1,
    })
    return planKnowledge({
      common,
      kind: 'git_blame',
      trust: 'reference',
      title: `Git blame ${input.path}:${input.start_line}-${input.end_line}`,
      locator:
        `git/blame/${input.path}/lines-${input.start_line}-${input.end_line}.json`,
      source_revision: common.base_commit_sha,
      content: envelope.content,
      redacted: envelope.redacted || cited.changed,
      source_range: range(input.start_line, input.end_line),
      symbol: null,
      targets: boardTargets(common.board_id),
    })
  })
}

function validateDeliveryInput(
  value: VerifiedDeliveryKnowledgeIngestionInput,
): {
  common: CommonInput
  report_id: string
  source_commit_sha: string
  gotchas: VerifiedGotchaInput[]
} {
  const record = safeRecord(value, [
    'board_id',
    'repository_key',
    'repository_root',
    'base_commit_sha',
    'observed_at',
    'report_id',
    'source_commit_sha',
  ], ['gotchas'])
  const sourceCommit = safeText(record.source_commit_sha, 64)
  if (!COMMIT_SHA.test(sourceCommit)) fail('invalid_input')
  const gotchas = safeArray(
    record.gotchas ?? [],
    MAX_KNOWLEDGE_SOURCE_GOTCHAS,
    true,
  ).map((item): VerifiedGotchaInput => {
    const gotcha = safeRecord(item, [
      'path',
      'start_line',
      'end_line',
      'text',
      'expected_source_sha256',
    ])
    const expectedHash = safeText(gotcha.expected_source_sha256, 64)
    if (!SHA256.test(expectedHash)) fail('invalid_input')
    const startLine = positiveInteger(gotcha.start_line)
    const endLine = positiveInteger(gotcha.end_line)
    if (endLine < startLine) fail('invalid_input')
    return {
      path: safeRepositoryPath(gotcha.path),
      start_line: startLine,
      end_line: endLine,
      text: safeText(gotcha.text, 4_000),
      expected_source_sha256: expectedHash,
    }
  })
  const citationText = new Map<string, string>()
  for (const gotcha of gotchas) {
    const key = `${gotcha.path}\u0000${gotcha.start_line}\u0000${gotcha.end_line}`
    const existing = citationText.get(key)
    if (existing !== undefined) fail('contradictory_evidence')
    citationText.set(key, gotcha.text)
  }
  return {
    common: commonInput(record),
    report_id: safeText(record.report_id, 256),
    source_commit_sha: sourceCommit,
    gotchas,
  }
}

function currentAcceptedReport(
  db: Database.Database,
  boardId: number,
  reportId: string,
): DeliveryReport {
  const deliveries = new DeliveryReportService(db)
  let report: DeliveryReport
  try {
    report = deliveries.get(reportId)
  } catch {
    fail('stale_evidence')
  }
  if (
    report.board_id !== boardId
    || report.status !== 'accepted'
    || report.accepted_by === null
    || report.accepted_at === null
    || report.verified_by === null
    || report.verified_at === null
  ) {
    fail('stale_evidence')
  }
  const history = deliveries.listCard(report.card_id)
  const latestAccepted = selectLatestAcceptedDeliveryRevision(history)
  const current = deliveries.currentForCard(report.card_id)
  if (latestAccepted?.id !== report.id || current?.id !== report.id) {
    fail('stale_evidence')
  }
  return report
}

function assertDeliveryEvidence(
  root: string,
  baseCommit: string,
  report: DeliveryReport,
  sourceCommit: string,
): void {
  if (
    report.commits.length === 0
    || report.commits.some((commit) => !COMMIT_SHA.test(commit))
    || report.commits.length !== new Set(report.commits).size
    || !report.commits.includes(sourceCommit)
  ) {
    fail('evidence_mismatch')
  }
  for (const commit of report.commits) {
    assertCommit(root, commit, 'evidence_mismatch')
    assertAncestor(root, commit, baseCommit)
  }
  const safeChangedPaths = report.changed_files.map((file) =>
    safeRepositoryPath(file))
  if (
    safeChangedPaths.length !== new Set(safeChangedPaths).size
    || report.changed_files.length === 0
  ) {
    fail('contradictory_evidence')
  }
}

function deliveryPlans(
  common: CommonInput,
  root: string,
  report: DeliveryReport,
  sourceCommit: string,
  gotchas: readonly VerifiedGotchaInput[],
): PlannedKnowledge[] {
  const summary = generateVerifiedDeliverySummary({
    latestAcceptedReport: report,
    currentReport: report,
  })
  const summaryEnvelope = redactEnvelope({
    accepted_at: report.accepted_at,
    accepted_by: report.accepted_by,
    citation: {
      commit_sha: sourceCommit,
      delivery_report_id: report.id,
      repository_key: common.repository_key,
      revision: report.sequence,
    },
    confidence_micros: 1_000_000,
    human_summary: summary.human,
    interpretation: 'data_only',
    kind: 'verified_delivery',
    schema_version: 1,
    summary: summary.machine,
    verified_at: report.verified_at,
    verified_by: report.verified_by,
  })
  const plans = [planKnowledge({
    common,
    kind: 'verified_delivery',
    trust: 'evidence',
    title: `Verified delivery ${report.id}`,
    locator: `deliveries/${sha256(report.id)}/verified-summary.json`,
    source_revision: `${sourceCommit}:delivery-revision-${report.sequence}`,
    content: summaryEnvelope.content,
    redacted: summaryEnvelope.redacted,
    source_range: range(null, null),
    symbol: null,
    targets: deliveryTargets(report),
  })]
  const changedPaths = new Set(report.changed_files)
  const loadedPaths = new Set<string>()
  let evidenceBytes = 0
  for (const gotcha of [...gotchas].sort((left, right) =>
    compareText(left.path, right.path)
      || left.start_line - right.start_line
      || left.end_line - right.end_line
      || compareText(left.text, right.text))) {
    if (!changedPaths.has(gotcha.path)) fail('evidence_mismatch')
    const evidence = loadEvidence(root, sourceCommit, gotcha.path)
    if (!loadedPaths.has(gotcha.path)) {
      loadedPaths.add(gotcha.path)
      evidenceBytes += Buffer.byteLength(evidence.text, 'utf8')
      if (evidenceBytes > MAX_KNOWLEDGE_SOURCE_TOTAL_BYTES) fail('invalid_input')
    }
    const cited = excerpt(evidence, gotcha.start_line, gotcha.end_line)
    if (
      sha256(cited.raw) !== gotcha.expected_source_sha256
      || !cited.redacted.includes(gotcha.text)
    ) {
      fail('evidence_mismatch')
    }
    const blamed = parseBlame(
      root,
      sourceCommit,
      gotcha.path,
      gotcha.start_line,
      gotcha.end_line,
    )
    const envelope = redactEnvelope({
      accepted_at: report.accepted_at,
      author: report.accepted_by,
      citation: {
        commit_sha: sourceCommit,
        delivery_report_id: report.id,
        end_line: gotcha.end_line,
        path: gotcha.path,
        repository_key: common.repository_key,
        start_line: gotcha.start_line,
      },
      confidence_micros: 900_000,
      evidence: {
        authors: uniqueAuthors(blamed),
        persisted_evidence_sha256: sha256(cited.redacted),
        source_sha256: gotcha.expected_source_sha256,
        text: cited.redacted,
      },
      gotcha: gotcha.text,
      interpretation: 'data_only',
      kind: 'gotcha',
      schema_version: 1,
      verified_by: report.verified_by,
    })
    plans.push(planKnowledge({
      common,
      kind: 'gotcha',
      trust: 'untrusted',
      title: `Verified gotcha ${gotcha.path}:${gotcha.start_line}`,
      locator:
        `gotchas/${gotcha.path}/lines-${gotcha.start_line}-${gotcha.end_line}.json`,
      source_revision: sourceCommit,
      content: envelope.content,
      redacted: envelope.redacted || cited.changed,
      source_range: range(gotcha.start_line, gotcha.end_line),
      symbol: null,
      targets: deliveryTargets(report),
    }))
  }
  return plans
}

/**
 * Ingests adapter-neutral structural evidence, selectively scoped Git
 * history/blame, and accepted delivery evidence. Every method re-verifies
 * repository and database scope inside the atomic persistence transaction.
 */
export class KnowledgeSourceIngestor {
  constructor(private readonly db: Database.Database) {}

  ingestStructural(
    value: StructuralKnowledgeIngestionInput,
  ): KnowledgeSourceIngestionReport {
    try {
      const input = validateStructuralInput(value)
      const verified = verifyRepository(this.db, input.common)
      assertRepositoryStable(this.db, input.common, verified)
      const plans = structuralPlans(input.common, verified.root, input.symbols)
      assertRepositoryStable(this.db, input.common, verified)
      return persist(this.db, input.common, verified, plans)
    } catch (error) {
      throw new KnowledgeSourceIngestionError(
        trustedCode(error) ?? 'persistence_failed',
      )
    }
  }

  ingestGitContext(
    value: GitContextKnowledgeIngestionInput,
  ): KnowledgeSourceIngestionReport {
    try {
      const input = validateGitContextInput(value)
      const verified = verifyRepository(this.db, input.common)
      assertRepositoryStable(this.db, input.common, verified)
      let evidenceBytes = 0
      for (const repositoryPath of input.paths) {
        const evidence = loadEvidence(
          verified.root,
          input.common.base_commit_sha,
          repositoryPath,
        )
        evidenceBytes += Buffer.byteLength(evidence.text, 'utf8')
        if (evidenceBytes > MAX_KNOWLEDGE_SOURCE_TOTAL_BYTES) {
          fail('invalid_input')
        }
      }
      const plans = [
        ...historyPlans(
          input.common,
          verified.root,
          input.paths,
          input.recent_commit_limit,
        ),
        ...blamePlans(input.common, verified.root, input.blame_ranges),
      ]
      assertRepositoryStable(this.db, input.common, verified)
      return persist(this.db, input.common, verified, plans)
    } catch (error) {
      throw new KnowledgeSourceIngestionError(
        trustedCode(error) ?? 'persistence_failed',
      )
    }
  }

  ingestVerifiedDelivery(
    value: VerifiedDeliveryKnowledgeIngestionInput,
  ): KnowledgeSourceIngestionReport {
    try {
      const input = validateDeliveryInput(value)
      const verified = verifyRepository(this.db, input.common)
      assertCommit(verified.root, input.source_commit_sha, 'evidence_mismatch')
      assertAncestor(
        verified.root,
        input.source_commit_sha,
        input.common.base_commit_sha,
      )
      const report = currentAcceptedReport(
        this.db,
        input.common.board_id,
        input.report_id,
      )
      assertDeliveryEvidence(
        verified.root,
        input.common.base_commit_sha,
        report,
        input.source_commit_sha,
      )
      const plans = deliveryPlans(
        input.common,
        verified.root,
        report,
        input.source_commit_sha,
        input.gotchas,
      )
      return persist(
        this.db,
        input.common,
        verified,
        plans,
        () => {
          const retained = currentAcceptedReport(
            this.db,
            input.common.board_id,
            input.report_id,
          )
          if (
            retained.updated_at !== report.updated_at
            || retained.accepted_at !== report.accepted_at
            || retained.verified_at !== report.verified_at
          ) {
            fail('stale_evidence')
          }
          assertDeliveryEvidence(
            verified.root,
            input.common.base_commit_sha,
            retained,
            input.source_commit_sha,
          )
        },
      )
    } catch (error) {
      throw new KnowledgeSourceIngestionError(
        trustedCode(error) ?? 'persistence_failed',
      )
    }
  }
}

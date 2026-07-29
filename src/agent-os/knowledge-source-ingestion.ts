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
export const MAX_KNOWLEDGE_SOURCE_DELIVERY_PATHS = 200
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
  /** SHA-256 of the exact raw relationship citation before redaction. */
  expected_evidence_sha256: string
  /** Must equal the target symbol's exact raw source hash. */
  target_source_sha256: string
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

interface Excerpt {
  raw: string
  redacted: string
  changed: boolean
}

interface PlannedKnowledge {
  source: KnowledgeSource
  chunk: KnowledgeChunk
}

interface RedactedEnvelope {
  content: string
  redacted: boolean
}

interface PersistedStructuralMetadata {
  key: string
  language: string
  qualified_name: string
  symbol_kind: string
  redacted: boolean
}

interface VerifiedDeliveryCommitEvidence {
  canonical_tip: string
  commits_oldest_first: string[]
  touched_paths: string[]
  paths_by_commit: ReadonlyMap<string, ReadonlySet<string>>
}

const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const REPOSITORY_KEY = /^[a-z0-9](?:[a-z0-9._/-]{0,254}[a-z0-9])?$/u
const SAFE_KEY = /^[A-Za-z0-9](?:[A-Za-z0-9._:/#-]{0,255})$/u
const RELATIONSHIP_KIND = /^[a-z][a-z0-9_-]{0,63}$/u
const CODE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u
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
): Excerpt {
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
          [
            'kind',
            'target_key',
            'expected_evidence_sha256',
            'target_source_sha256',
          ],
          ['start_line', 'end_line'],
        )
        const kind = safeText(relation.kind, 64)
        const target = safeText(relation.target_key, 256)
        const expectedEvidenceHash = safeText(
          relation.expected_evidence_sha256,
          64,
        )
        const targetSourceHash = safeText(relation.target_source_sha256, 64)
        if (!RELATIONSHIP_KIND.test(kind) || !SAFE_KEY.test(target)) {
          fail('invalid_input')
        }
        if (
          !SHA256.test(expectedEvidenceHash)
          || !SHA256.test(targetSourceHash)
        ) {
          fail('invalid_input')
        }
        return {
          kind,
          target_key: target,
          expected_evidence_sha256: expectedEvidenceHash,
          target_source_sha256: targetSourceHash,
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

function persistedStructuralMetadata(
  symbol: StructuralSymbolInput,
): PersistedStructuralMetadata {
  const fields = [
    ['key', symbol.key],
    ['language', symbol.language],
    ['qualified_name', symbol.qualified_name],
    ['symbol_kind', symbol.symbol_kind],
  ] as const
  const output = Object.create(null) as Record<string, string>
  let changed = false
  for (const [name, value] of fields) {
    const redaction = redactSensitiveText(value)
    if (redaction.value === null || redaction.value.length === 0) {
      fail('evidence_mismatch')
    }
    output[name] = redaction.value
    changed ||= redaction.changed
  }
  return {
    key: output.key,
    language: output.language,
    qualified_name: output.qualified_name,
    symbol_kind: output.symbol_kind,
    redacted: changed,
  }
}

const RELATIONSHIP_LITERAL_TOKEN = '<literal>'
const RELATIONSHIP_LITERAL_TOKEN_PREFIX = '<literal>:'
const RELATIONSHIP_REGEX_TOKEN = '<regex>'

function ecmaScriptLanguage(
  language: string,
  repositoryPath: string,
): boolean {
  return new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
    .has(path.posix.extname(repositoryPath).toLowerCase())
    || /^(?:cjs|ecmascript|javascript|js|jsx|mjs|node|ts|tsx|typescript)$/u
      .test(language.toLowerCase())
}

function previousRelationshipTokenIndex(
  tokens: readonly string[],
  beforeIndex = tokens.length,
): number | null {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (tokens[index] !== '\n') return index
  }
  return null
}

function matchingOpenParenthesis(
  tokens: readonly string[],
  closeIndex: number,
): number | null {
  let depth = 0
  for (let index = closeIndex; index >= 0; index -= 1) {
    if (tokens[index] === ')') depth += 1
    if (tokens[index] !== '(') continue
    depth -= 1
    if (depth === 0) return index
    if (depth < 0) return null
  }
  return null
}

function closesStatementControlCondition(
  tokens: readonly string[],
  closeIndex: number,
): boolean {
  const openIndex = matchingOpenParenthesis(tokens, closeIndex)
  if (openIndex === null) return false
  let beforeIndex = previousRelationshipTokenIndex(tokens, openIndex)
  if (
    beforeIndex !== null
    && tokens[beforeIndex] === 'await'
  ) {
    beforeIndex = previousRelationshipTokenIndex(tokens, beforeIndex)
  }
  return beforeIndex !== null
    && new Set(['for', 'if', 'while', 'with']).has(tokens[beforeIndex])
}

function relationshipLiteralToken(
  value: string,
  quote: string,
): string {
  if (
    quote === '`'
    || value.includes('\\')
    || value.includes('\n')
    || value.includes('\r')
  ) {
    return RELATIONSHIP_LITERAL_TOKEN
  }
  return RELATIONSHIP_LITERAL_TOKEN_PREFIX
    + Buffer.from(value, 'utf8').toString('base64url')
}

function relationshipLiteralValue(token: string): string | null {
  if (!token.startsWith(RELATIONSHIP_LITERAL_TOKEN_PREFIX)) return null
  const encoded = token.slice(RELATIONSHIP_LITERAL_TOKEN_PREFIX.length)
  try {
    const value = Buffer.from(encoded, 'base64url').toString('utf8')
    return Buffer.from(value, 'utf8').toString('base64url') === encoded
      ? value
      : null
  } catch {
    return null
  }
}

function tryRegexLiteralEnd(
  value: string,
  start: number,
  failOnAmbiguousComment: boolean,
): number | null {
  let index = start + 1
  let lastSlash: number | null = null
  let inCharacterClass = false
  while (index < value.length) {
    const current = value[index]
    if (current === '\\') {
      if (index + 1 >= value.length) return null
      index += 2
      continue
    }
    if (current === '\n' || current === '\r') break
    if (current === '[' && !inCharacterClass) {
      inCharacterClass = true
    } else if (current === ']' && inCharacterClass) {
      inCharacterClass = false
    } else if (!inCharacterClass && current === '/') {
      const next = value[index + 1] ?? ''
      if (next === '/' || next === '*') {
        if (failOnAmbiguousComment) fail('evidence_mismatch')
        if (next === '*') {
          const commentEnd = value.indexOf('*/', index + 2)
          if (commentEnd < 0) fail('evidence_mismatch')
          return commentEnd + 2
        }
        const lineEnd = value.indexOf('\n', index + 2)
        return lineEnd < 0 ? value.length : lineEnd
      }
      lastSlash = index
    }
    index += 1
  }
  if (lastSlash === null) return null
  let end = lastSlash + 1
  while (end < value.length && /[A-Za-z]/u.test(value[end])) end += 1
  return end
}

function relationshipTokens(
  value: string,
  language: string,
  repositoryPath: string,
  failOnAmbiguousComment = true,
): string[] {
  const tokens: string[] = []
  const hashComments = /^(?:bash|perl|python|r|ruby|sh|shell|zsh)$/u
    .test(language.toLowerCase())
    || new Set(['.bash', '.pl', '.py', '.r', '.rb', '.sh', '.zsh'])
      .has(path.posix.extname(repositoryPath).toLowerCase())
  const regexLiterals = ecmaScriptLanguage(language, repositoryPath)
  const tripleQuotedStrings = pythonLanguage(language, repositoryPath)
    || javaLanguage(language, repositoryPath)
  let index = 0
  while (index < value.length) {
    const current = value[index]
    const next = value[index + 1] ?? ''
    if (/\s/u.test(current)) {
      if (current === '\n') tokens.push('\n')
      index += 1
      continue
    }
    if (current === '/' && next === '/') {
      const end = value.indexOf('\n', index + 2)
      index = end < 0 ? value.length : end
      continue
    }
    if (current === '/' && next === '*') {
      const end = value.indexOf('*/', index + 2)
      if (end < 0) fail('evidence_mismatch')
      if (value.slice(index, end + 2).includes('\n')) tokens.push('\n')
      index = end + 2
      continue
    }
    if (current === '/' && regexLiterals) {
      const regexEnd = tryRegexLiteralEnd(
        value,
        index,
        failOnAmbiguousComment,
      )
      if (regexEnd !== null) {
        index = regexEnd
        tokens.push(RELATIONSHIP_REGEX_TOKEN)
        continue
      }
    }
    if (hashComments && current === '#') {
      const end = value.indexOf('\n', index + 1)
      index = end < 0 ? value.length : end
      continue
    }
    if (current === '"' || current === '\'' || current === '`') {
      const quote = current
      const start = index
      const delimiter = tripleQuotedStrings
        && quote !== '`'
        && value.slice(index, index + 3) === quote.repeat(3)
        ? quote.repeat(3)
        : quote
      index += delimiter.length
      let closed = false
      while (index < value.length) {
        if (value[index] === '\\') {
          index += 2
          continue
        }
        if (value.slice(index, index + delimiter.length) === delimiter) {
          index += delimiter.length
          closed = true
          break
        }
        index += 1
      }
      if (!closed) fail('evidence_mismatch')
      tokens.push(relationshipLiteralToken(
        value.slice(start + delimiter.length, index - delimiter.length),
        delimiter,
      ))
      if (value.slice(start, index).includes('\n')) tokens.push('\n')
      continue
    }
    if (/[A-Za-z_$]/u.test(current)) {
      let end = index + 1
      while (end < value.length && /[A-Za-z0-9_$]/u.test(value[end])) {
        end += 1
      }
      tokens.push(value.slice(index, end))
      index = end
      continue
    }
    tokens.push(current)
    index += 1
  }
  return tokens
}

function targetIdentifier(qualifiedName: string): string {
  const identifier = qualifiedName.split(/[.:/#]/u).at(-1) ?? ''
  if (!CODE_IDENTIFIER.test(identifier)) fail('evidence_mismatch')
  return identifier
}

function hasTokenPair(
  tokens: readonly string[],
  first: string,
  second: string,
): boolean {
  return tokens.some((token, index) => {
    if (token !== first) return false
    return significantTokenAfter(tokens, index)?.token === second
  })
}

function matchingParenthesis(
  tokens: readonly string[],
  openIndex: number,
): number | null {
  let depth = 0
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index] === '(') depth += 1
    if (tokens[index] !== ')') continue
    depth -= 1
    if (depth === 0) return index
    if (depth < 0) return null
  }
  return null
}

function significantTokenAfter(
  tokens: readonly string[],
  index: number,
): { token: string; index: number } | null {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor] !== '\n') return { token: tokens[cursor], index: cursor }
  }
  return null
}

function significantTokenBefore(
  tokens: readonly string[],
  index: number,
): { token: string; index: number } | null {
  const cursor = previousRelationshipTokenIndex(tokens, index)
  return cursor === null ? null : { token: tokens[cursor], index: cursor }
}

function statementPrefix(tokens: readonly string[], index: number): string[] {
  let start = index
  while (
    start > 0
    && !new Set(['\n', ';', '{', '}']).has(tokens[start - 1])
  ) {
    start -= 1
  }
  return tokens.slice(start, index)
}

function nearestUnmatchedOpeningBrace(
  tokens: readonly string[],
  beforeIndex: number,
): number | null {
  let depth = 0
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (tokens[index] === '}') {
      depth += 1
      continue
    }
    if (tokens[index] !== '{') continue
    if (depth === 0) return index
    depth -= 1
  }
  return null
}

function declarationContainerAt(
  tokens: readonly string[],
  identifierIndex: number,
): boolean {
  const openIndex = nearestUnmatchedOpeningBrace(tokens, identifierIndex)
  if (openIndex === null) return false
  const prefix = statementPrefix(tokens, openIndex)
    .filter((token) => token !== '\n')
  if (
    prefix.some((token) =>
      new Set([
        'class', 'enum', 'interface', 'protocol', 'record', 'struct', 'trait',
      ]).has(token))
  ) {
    return true
  }
  return prefix.includes('type') && prefix.includes('=')
}

function executableContainerAt(
  tokens: readonly string[],
  identifierIndex: number,
): boolean {
  const openIndex = nearestUnmatchedOpeningBrace(tokens, identifierIndex)
  if (openIndex === null) return false
  const prefix = statementPrefix(tokens, openIndex)
    .filter((token) => token !== '\n')
  const closeIndex = prefix.lastIndexOf(')')
  const arrow = prefix.some((token, index) =>
    token === '=' && prefix[index + 1] === '>')
  return (
    arrow
    || (
      closeIndex >= 0
      && prefix.at(-1) !== ':'
    )
  )
    || new Set(['do', 'else', 'finally', 'static', 'try'])
      .has(prefix.at(-1) ?? '')
}

function controlConditionPrefix(tokens: readonly string[]): boolean {
  const significant = tokens.filter((token) => token !== '\n')
  const closeIndex = significant.length - 1
  return significant[closeIndex] === ')'
    && closesStatementControlCondition(significant, closeIndex)
}

function declarationLikeCall(
  tokens: readonly string[],
  identifierIndex: number,
  closeIndex: number,
  sourceLanguage: string,
  sourcePath: string,
): boolean {
  const previous = significantTokenBefore(tokens, identifierIndex)?.token ?? ''
  const declarationTokens = new Set([
    'class', 'def', 'fn', 'func', 'function', 'fun', 'proc', 'sub',
  ])
  if (declarationTokens.has(previous) || previous === '~') return true

  const after = significantTokenAfter(tokens, closeIndex)
  if (after?.token === '{' || after?.token === ':') return true
  if (
    after?.token === '='
    && significantTokenAfter(tokens, after.index)?.token === '>'
  ) {
    return true
  }
  if (
    after?.token === '-'
    && significantTokenAfter(tokens, after.index)?.token === '>'
  ) {
    return true
  }
  if (declarationContainerAt(tokens, identifierIndex)) return true

  const declarationLanguage =
    /^(?:c|c\+\+|cc|cpp|cs|csharp|h|hpp|java|kt|kotlin|kts|objective-c|scala|swift)$/u
      .test(sourceLanguage.toLowerCase())
    || new Set([
      '.c', '.cc', '.cpp', '.cs', '.h', '.hpp', '.java', '.kt', '.kts',
      '.scala', '.swift',
    ]).has(path.posix.extname(sourcePath).toLowerCase())
  const prefix = statementPrefix(tokens, identifierIndex)
  if (controlConditionPrefix(prefix)) return false
  const invocationContext = new Set([
    '(', '[', ',', '.', ':', '=', '?', '+', '-', '/', '%', '!', '~',
    'await', 'case', 'do', 'else', 'new', 'return', 'throw', 'yield',
  ])
  if (
    invocationContext.has(prefix.at(-1) ?? '')
    || prefix.includes('=')
    || prefix.some((token, index) =>
      (token === '&' || token === '|') && prefix[index + 1] === token)
  ) {
    return false
  }
  if (prefix.length === 0) {
    if (executableContainerAt(tokens, identifierIndex)) return false
    return declarationLanguage
  }
  if (!declarationLanguage) return false
  return prefix.some((token) => CODE_IDENTIFIER.test(token))
}

function targetDeclarationContains(
  symbol: StructuralSymbolInput,
  targetEvidence: string,
  requireExport: boolean,
): boolean {
  const qualifiedParts = symbol.qualified_name.split(/[.:/#]/u)
  const identifier = targetIdentifier(symbol.qualified_name)
  const owner = qualifiedParts.length > 1
    ? qualifiedParts.at(-2) ?? null
    : null
  const tokens = relationshipTokens(
    targetEvidence,
    symbol.language,
    symbol.path,
    false,
  )
  const declarationKeywords = new Set([
    'class', 'const', 'def', 'enum', 'fn', 'func', 'function', 'interface',
    'let', 'namespace', 'proc', 'record', 'struct', 'sub', 'trait', 'type',
    'var',
  ])
  const declared = tokens.some((token, index) => {
    if (token !== identifier) return false
    const before = significantTokenBefore(tokens, index)
    if (declarationKeywords.has(before?.token ?? '')) return true
    const after = significantTokenAfter(tokens, index)
    if (after?.token === '(') {
      const close = matchingParenthesis(tokens, after.index)
      return close !== null && declarationLikeCall(
        tokens,
        index,
        close,
        symbol.language,
        symbol.path,
      )
    }
    if (
      after?.token === '='
      && (
        pythonLanguage(symbol.language, symbol.path)
        || /^(?:constant|field|property|variable)$/iu.test(symbol.symbol_kind)
        || before?.token === '.'
      )
    ) {
      return true
    }
    const prefix = statementPrefix(tokens, index)
      .filter((prefixToken) => prefixToken !== '\n')
    return prefix.includes('export') && prefix.includes('{')
  })
  if (
    !declared
    || !requireExport
    || !ecmaScriptLanguage(symbol.language, symbol.path)
  ) {
    return declared
  }
  const exported = (candidate: string): boolean => tokens.some(
    (token, index) => {
      if (token !== candidate) return false
      const prefix = statementPrefix(tokens, index)
        .filter((prefixToken) => prefixToken !== '\n')
      if (
        prefix.includes('export')
        || (prefix.includes('exports') && prefix.includes('='))
      ) {
        return true
      }
      const open = nearestUnmatchedOpeningBrace(tokens, index)
      if (open === null) return false
      const beforeOpen = significantTokenBefore(tokens, open)
      if (beforeOpen?.token === 'export') return true
      if (beforeOpen?.token !== '=') return false
      return significantTokenBefore(tokens, beforeOpen.index)?.token
        === 'exports'
    },
  )
  return exported(identifier)
    || (owner !== null && CODE_IDENTIFIER.test(owner) && exported(owner))
}

function relationshipSegments(tokens: readonly string[]): string[][] {
  const segments: string[][] = [[]]
  let depth = 0
  for (const token of tokens) {
    if (token === '\n') continue
    if (token === '(' || token === '[' || token === '{') depth += 1
    if (token === ')' || token === ']' || token === '}') depth -= 1
    if (depth < 0) return []
    if (token === ',' && depth === 0) {
      segments.push([])
      continue
    }
    segments.at(-1)!.push(token)
  }
  return depth === 0
    ? segments.filter((segment) => segment.length > 0)
    : []
}

function closingBrace(
  tokens: readonly string[],
  openIndex: number,
): number | null {
  let depth = 0
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index] === '{') depth += 1
    if (tokens[index] !== '}') continue
    depth -= 1
    if (depth === 0) return index
    if (depth < 0) return null
  }
  return null
}

function openingBrace(
  tokens: readonly string[],
  closeIndex: number,
): number | null {
  let depth = 0
  for (let index = closeIndex; index >= 0; index -= 1) {
    if (tokens[index] === '}') depth += 1
    if (tokens[index] !== '{') continue
    depth -= 1
    if (depth === 0) return index
    if (depth < 0) return null
  }
  return null
}

function namedImportExports(
  bindingTokens: readonly string[],
  identifier: string,
  requiredLocalIdentifier?: string,
): boolean {
  const binding = bindingTokens.filter((token) => token !== '\n')
  const openIndex = binding.indexOf('{')
  if (openIndex < 0) return false
  const closeIndex = closingBrace(binding, openIndex)
  if (closeIndex === null || closeIndex !== binding.length - 1) return false
  const prefix = binding.slice(0, openIndex)
  const validPrefix = prefix.length === 0
    || (prefix.length === 1 && prefix[0] === 'type')
    || (
      prefix.length === 2
      && CODE_IDENTIFIER.test(prefix[0])
      && prefix[1] === ','
    )
  if (!validPrefix) return false
  const segments = relationshipSegments(
    binding.slice(openIndex + 1, closeIndex),
  )
  return segments.some((rawSegment) => {
    const segment = rawSegment[0] === 'type'
      && rawSegment[1] !== 'as'
      ? rawSegment.slice(1)
      : rawSegment
    if (segment.length === 1) {
      return segment[0] === identifier
        && (
          requiredLocalIdentifier === undefined
          || segment[0] === requiredLocalIdentifier
        )
    }
    return segment.length === 3
      && segment[0] === identifier
      && segment[1] === 'as'
      && CODE_IDENTIFIER.test(segment[2])
      && (
        requiredLocalIdentifier === undefined
        || segment[2] === requiredLocalIdentifier
      )
  })
}

function safeResolvedImportPath(value: string): string | null {
  const normalized = path.posix.normalize(value)
  if (
    path.posix.isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    return null
  }
  return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

function ecmaScriptModuleTargets(
  specifier: string,
  sourcePath: string,
  targetPath: string,
  exactPathExists: (repositoryPath: string) => boolean,
): boolean {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false
  const resolved = safeResolvedImportPath(
    path.posix.join(path.posix.dirname(sourcePath), specifier),
  )
  if (resolved === null) return false
  const candidates = new Set([resolved])
  const extension = path.posix.extname(resolved).toLowerCase()
  if (
    extension.length > 0
    && resolved !== targetPath
    && exactPathExists(resolved)
  ) {
    return false
  }
  const withoutExtension = extension.length > 0
    ? resolved.slice(0, -extension.length)
    : resolved
  const mappedExtensions: Record<string, readonly string[]> = {
    '.cjs': ['.cjs', '.cts'],
    '.js': ['.js', '.jsx', '.ts', '.tsx'],
    '.jsx': ['.jsx', '.tsx'],
    '.mjs': ['.mjs', '.mts'],
  }
  for (const mapped of mappedExtensions[extension] ?? []) {
    candidates.add(withoutExtension + mapped)
  }
  if (extension.length === 0) {
    for (
      const candidateExtension
      of ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']
    ) {
      candidates.add(resolved + candidateExtension)
      candidates.add(`${resolved}/index${candidateExtension}`)
    }
  }
  return candidates.has(targetPath)
}

function ecmaScriptImportContains(
  tokens: readonly string[],
  identifier: string,
  sourcePath: string,
  targetPath: string,
  exactPathExists: (repositoryPath: string) => boolean,
  requiredLocalIdentifier?: string,
): boolean {
  for (let importIndex = 0; importIndex < tokens.length; importIndex += 1) {
    if (tokens[importIndex] !== 'import') continue
    const first = significantTokenAfter(tokens, importIndex)
    if (first === null) continue
    if (first.token === '(') {
      const close = matchingParenthesis(tokens, first.index)
      if (close === null) fail('evidence_mismatch')
      importIndex = close
      continue
    }
    let depth = 0
    for (let cursor = importIndex + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor]
      if (token === '{' || token === '[' || token === '(') {
        depth += 1
        continue
      }
      if (token === '}' || token === ']' || token === ')') {
        depth -= 1
        if (depth < 0) break
        continue
      }
      if (depth === 0 && token === ';') break
      if (depth !== 0 || token !== 'from') continue
      const specifierToken = significantTokenAfter(tokens, cursor)
      if (specifierToken === null) break
      const specifier = relationshipLiteralValue(specifierToken.token)
      if (
        specifier !== null
        && ecmaScriptModuleTargets(
          specifier,
          sourcePath,
          targetPath,
          exactPathExists,
        )
        && namedImportExports(
          tokens.slice(importIndex + 1, cursor),
          identifier,
          requiredLocalIdentifier,
        )
      ) {
        return true
      }
      break
    }
  }
  return commonJsImportContains(
    tokens,
    identifier,
    sourcePath,
    targetPath,
    exactPathExists,
    requiredLocalIdentifier,
  )
}

function commonJsImportContains(
  tokens: readonly string[],
  identifier: string,
  sourcePath: string,
  targetPath: string,
  exactPathExists: (repositoryPath: string) => boolean,
  requiredLocalIdentifier?: string,
): boolean {
  for (let requireIndex = 0; requireIndex < tokens.length; requireIndex += 1) {
    if (tokens[requireIndex] !== 'require') continue
    const beforeRequire = significantTokenBefore(tokens, requireIndex)
    if (
      beforeRequire?.token === '.'
      || beforeRequire?.token === '?'
      || new Set(['class', 'def', 'fn', 'function']).has(
        beforeRequire?.token ?? '',
      )
    ) {
      continue
    }
    const shadowed = tokens.some((token, tokenIndex) => {
      if (token !== 'require' || tokenIndex === requireIndex) return false
      const before = significantTokenBefore(tokens, tokenIndex)
      const after = significantTokenAfter(tokens, tokenIndex)
      if (before?.token === '.') return false
      return new Set(['class', 'def', 'fn', 'function']).has(
        before?.token ?? '',
      ) || after?.token !== '('
    })
    if (shadowed) continue
    const open = significantTokenAfter(tokens, requireIndex)
    if (open?.token !== '(') continue
    const specifierToken = significantTokenAfter(tokens, open.index)
    if (specifierToken === null) continue
    const specifier = relationshipLiteralValue(specifierToken.token)
    const close = significantTokenAfter(tokens, specifierToken.index)
    if (
      specifier === null
      || close?.token !== ')'
      || !ecmaScriptModuleTargets(
        specifier,
        sourcePath,
        targetPath,
        exactPathExists,
      )
    ) {
      continue
    }
    const propertyDot = significantTokenAfter(tokens, close.index)
    const property = propertyDot?.token === '.'
      ? significantTokenAfter(tokens, propertyDot.index)
      : null
    if (property?.token === identifier && requiredLocalIdentifier === undefined) {
      return true
    }

    const equals = significantTokenBefore(tokens, requireIndex)
    const localBinding = equals?.token === '='
      ? significantTokenBefore(tokens, equals.index)
      : null
    const localDeclaration = localBinding === null
      ? null
      : significantTokenBefore(tokens, localBinding.index)
    const declaredLocalBinding = localBinding?.token
      === (requiredLocalIdentifier ?? identifier)
      && localDeclaration !== null
      && new Set(['const', 'let', 'var']).has(localDeclaration.token)
    if (property?.token === identifier && declaredLocalBinding) return true
    const directBinding = propertyDot === null
      || propertyDot.token === ';'
      || propertyDot.token === ','
      || (
        tokens.slice(close.index + 1, propertyDot.index).includes('\n')
        && !new Set(['.', '[', '(', '`']).has(propertyDot.token)
    )
    if (
      directBinding
      && declaredLocalBinding
    ) {
      return true
    }
    const destructuringClose = equals?.token === '='
      ? significantTokenBefore(tokens, equals.index)
      : null
    if (destructuringClose?.token !== '}') continue
    const destructuringOpen = openingBrace(tokens, destructuringClose.index)
    if (destructuringOpen === null) continue
    const declaration = significantTokenBefore(tokens, destructuringOpen)
    if (
      declaration === null
      || !new Set(['const', 'let', 'var']).has(declaration.token)
    ) {
      continue
    }
    const segments = relationshipSegments(
      tokens.slice(destructuringOpen + 1, destructuringClose.index),
    )
    if (segments.some((segment) =>
      segment[0] === identifier
      && (
        (
          segment.length === 1
          && (
            requiredLocalIdentifier === undefined
            || segment[0] === requiredLocalIdentifier
          )
        )
        || (
          segment.length === 3
          && segment[1] === ':'
          && CODE_IDENTIFIER.test(segment[2])
          && (
            requiredLocalIdentifier === undefined
            || segment[2] === requiredLocalIdentifier
          )
        )
      ))) {
      return true
    }
  }
  return false
}

function pythonLanguage(language: string, sourcePath: string): boolean {
  return language.toLowerCase() === 'python'
    || path.posix.extname(sourcePath).toLowerCase() === '.py'
}

function pythonModuleTargets(
  moduleTokens: readonly string[],
  sourcePath: string,
  targetPath: string,
): boolean {
  const module = moduleTokens.filter((token) => token !== '\n')
  let leadingDots = 0
  while (module[leadingDots] === '.') leadingDots += 1
  const names = module.slice(leadingDots)
  if (
    names.length === 0
    || names.some((token, index) =>
      index % 2 === 0 ? !CODE_IDENTIFIER.test(token) : token !== '.')
  ) {
    return false
  }
  const modulePath = names.filter((_, index) => index % 2 === 0).join('/')
  let resolved: string
  if (leadingDots === 0) {
    resolved = modulePath
  } else {
    const packageDepth = path.posix.dirname(sourcePath)
      .split('/')
      .filter((component) => component.length > 0 && component !== '.')
      .length
    if (leadingDots > packageDepth) return false
    resolved = path.posix.dirname(sourcePath)
    for (let depth = 1; depth < leadingDots; depth += 1) {
      resolved = path.posix.dirname(resolved)
    }
    resolved = path.posix.join(resolved, modulePath)
  }
  const safe = safeResolvedImportPath(resolved)
  return safe !== null
    && (targetPath === `${safe}.py` || targetPath === `${safe}/__init__.py`)
}

function pythonImportContains(
  tokens: readonly string[],
  identifier: string,
  sourcePath: string,
  targetPath: string,
  requiredLocalIdentifier?: string,
): boolean {
  for (let fromIndex = 0; fromIndex < tokens.length; fromIndex += 1) {
    if (tokens[fromIndex] !== 'from') continue
    let importIndex = fromIndex + 1
    while (importIndex < tokens.length && tokens[importIndex] !== 'import') {
      if (
        tokens[importIndex] === ';'
        || tokens[importIndex] === '\n'
      ) {
        break
      }
      importIndex += 1
    }
    if (
      importIndex >= tokens.length
      || tokens[importIndex] !== 'import'
      || !pythonModuleTargets(
        tokens.slice(fromIndex + 1, importIndex),
        sourcePath,
        targetPath,
      )
    ) {
      continue
    }
    const imported: string[] = []
    let depth = 0
    for (let cursor = importIndex + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor]
      if (token === '(') {
        depth += 1
        if (depth === 1) continue
      }
      if (token === ')') {
        depth -= 1
        if (depth < 0) break
        if (depth === 0) continue
      }
      if (depth === 0 && (token === ';' || token === '\n')) break
      imported.push(token)
    }
    if (relationshipSegments(imported).some((segment) =>
      segment[0] === identifier
      && (
        (
          segment.length === 1
          && (
            requiredLocalIdentifier === undefined
            || segment[0] === requiredLocalIdentifier
          )
        )
        || (
          segment.length === 3
          && segment[1] === 'as'
          && CODE_IDENTIFIER.test(segment[2])
          && (
            requiredLocalIdentifier === undefined
            || segment[2] === requiredLocalIdentifier
          )
        )
      ))) {
      return true
    }
  }
  return false
}

function javaLanguage(language: string, sourcePath: string): boolean {
  return language.toLowerCase() === 'java'
    || path.posix.extname(sourcePath).toLowerCase() === '.java'
}

function javaModuleTargets(
  components: readonly string[],
  targetPath: string,
): boolean {
  if (components.length === 0 || components.some((token) =>
    !CODE_IDENTIFIER.test(token))) {
    return false
  }
  const expected = `${components.join('/')}.java`
  return targetPath === expected || targetPath.endsWith(`/${expected}`)
}

function javaImportContains(
  tokens: readonly string[],
  identifier: string,
  targetPath: string,
): boolean {
  for (let importIndex = 0; importIndex < tokens.length; importIndex += 1) {
    if (tokens[importIndex] !== 'import') continue
    const clause: string[] = []
    for (let cursor = importIndex + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor] === ';') break
      if (tokens[cursor] !== '\n') clause.push(tokens[cursor])
    }
    const isStatic = clause[0] === 'static'
    const qualified = isStatic ? clause.slice(1) : clause
    if (
      qualified.length < 1
      || qualified.some((token, index) =>
        index % 2 === 0 ? !CODE_IDENTIFIER.test(token) : token !== '.')
    ) {
      continue
    }
    const components = qualified.filter((_, index) => index % 2 === 0)
    const imported = components.at(-1)
    const module = isStatic ? components.slice(0, -1) : components
    if (
      imported === identifier
      && javaModuleTargets(module, targetPath)
    ) {
      return true
    }
  }
  return false
}

function staticImportContains(
  tokens: readonly string[],
  identifier: string,
  sourceLanguage: string,
  sourcePath: string,
  targetPath: string,
  exactPathExists: (repositoryPath: string) => boolean,
  requiredLocalIdentifier?: string,
): boolean {
  if (ecmaScriptLanguage(sourceLanguage, sourcePath)) {
    return ecmaScriptImportContains(
      tokens,
      identifier,
      sourcePath,
      targetPath,
      exactPathExists,
      requiredLocalIdentifier,
    )
  }
  if (pythonLanguage(sourceLanguage, sourcePath)) {
    return pythonImportContains(
      tokens,
      identifier,
      sourcePath,
      targetPath,
      requiredLocalIdentifier,
    )
  }
  if (javaLanguage(sourceLanguage, sourcePath)) {
    return javaImportContains(tokens, identifier, targetPath)
  }
  return false
}

function assertSyntacticRelationship(
  relationship: StructuralRelationshipInput,
  sourceLanguage: string,
  sourcePath: string,
  sourceFileEvidence: string,
  sourcePrefixEvidence: string,
  relationshipEvidence: string,
  targetQualifiedName: string,
  targetPath: string,
  exactPathExists: (repositoryPath: string) => boolean,
): void {
  if (relationship.kind === 'contains') return
  const identifier = targetIdentifier(targetQualifiedName)
  const tokens = relationshipTokens(
    relationshipEvidence,
    sourceLanguage,
    sourcePath,
  )
  const prefixTokens = relationshipTokens(
    sourcePrefixEvidence,
    sourceLanguage,
    sourcePath,
    false,
  )
  const contextualTokens = [...prefixTokens, ...tokens]
  const relationshipTokenOffset = prefixTokens.length
  const assertPathBoundReference = (): void => {
    if (sourcePath === targetPath) return
    const sourceTokens = relationshipTokens(
      sourceFileEvidence,
      sourceLanguage,
      sourcePath,
      false,
    )
    const references = [{
      exported: identifier,
      local: identifier,
    }]
    const qualifiedParts = targetQualifiedName.split(/[.:/#]/u)
    const owner = qualifiedParts.length > 1
      ? qualifiedParts.at(-2) ?? null
      : null
    if (owner !== null && CODE_IDENTIFIER.test(owner)) {
      for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index] !== identifier) continue
        const dot = significantTokenBefore(tokens, index)
        if (dot?.token !== '.') continue
        const qualifier = significantTokenBefore(tokens, dot.index)
        if (qualifier !== null && CODE_IDENTIFIER.test(qualifier.token)) {
          references.push({ exported: owner, local: qualifier.token })
        }
      }
    }
    if (
      !references.some((reference) =>
        staticImportContains(
          sourceTokens,
          reference.exported,
          sourceLanguage,
          sourcePath,
          targetPath,
          exactPathExists,
          reference.local,
        ))
    ) {
      fail('evidence_mismatch')
    }
  }
  switch (relationship.kind) {
    case 'calls': {
      assertPathBoundReference()
      const proved = tokens.some((token, index) => {
        if (token !== identifier) return false
        const contextualIndex = relationshipTokenOffset + index
        const open = significantTokenAfter(contextualTokens, contextualIndex)
        if (open?.token !== '(') return false
        if (
          pythonLanguage(sourceLanguage, sourcePath)
          && contextualTokens
            .slice(contextualIndex + 1, open.index)
            .includes('\n')
        ) {
          let groupingDepth = 0
          for (let cursor = 0; cursor < contextualIndex; cursor += 1) {
            if (new Set(['(', '[', '{']).has(contextualTokens[cursor])) {
              groupingDepth += 1
            } else if (
              new Set([')', ']', '}']).has(contextualTokens[cursor])
              && groupingDepth > 0
            ) {
              groupingDepth -= 1
            }
          }
          if (groupingDepth === 0) return false
        }
        const close = matchingParenthesis(contextualTokens, open.index)
        if (close === null) return false
        return !declarationLikeCall(
          contextualTokens,
          contextualIndex,
          close,
          sourceLanguage,
          sourcePath,
        )
      })
      if (!proved) fail('evidence_mismatch')
      return
    }
    case 'extends':
      assertPathBoundReference()
      if (!hasTokenPair(tokens, 'extends', identifier)) fail('evidence_mismatch')
      return
    case 'implements':
      assertPathBoundReference()
      if (!hasTokenPair(tokens, 'implements', identifier)) {
        fail('evidence_mismatch')
      }
      return
    case 'imports': {
      if (
        !staticImportContains(
          tokens,
          identifier,
          sourceLanguage,
          sourcePath,
          targetPath,
          exactPathExists,
        )
      ) {
        fail('evidence_mismatch')
      }
      return
    }
    default:
      fail('evidence_mismatch')
  }
}

function structuralPlans(
  common: CommonInput,
  root: string,
  symbols: readonly StructuralSymbolInput[],
): PlannedKnowledge[] {
  const evidenceCache = new Map<string, LoadedEvidence>()
  const blameCache = new Map<string, BlameLine[]>()
  const attestedTargets = new Set<string>()
  const committedPathCache = new Map<string, boolean>()
  const committedPathExists = (repositoryPath: string): boolean => {
    const cached = committedPathCache.get(repositoryPath)
    if (cached !== undefined) return cached
    const result = gitAttempt(
      root,
      ['cat-file', '-e', `${common.base_commit_sha}:${repositoryPath}`],
      1_024,
    )
    result.stdout.fill(0)
    const exists = result.ok
    committedPathCache.set(repositoryPath, exists)
    return exists
  }
  const symbolMap = new Map(symbols.map((symbol) => [symbol.key, symbol]))
  const metadataMap = new Map(symbols.map((symbol) => [
    symbol.key,
    persistedStructuralMetadata(symbol),
  ]))
  const plans: PlannedKnowledge[] = []
  let evidenceBytes = 0
  for (const symbol of [...symbols].sort((left, right) =>
    compareText(left.path, right.path)
      || left.start_line - right.start_line
      || left.end_line - right.end_line
      || compareText(left.key, right.key))) {
    const persistedSymbol = metadataMap.get(symbol.key)
    if (!persistedSymbol) fail('contradictory_evidence')
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
        if (
          sha256(relationshipExcerpt.raw)
            !== relationship.expected_evidence_sha256
          || target.expected_source_sha256
            !== relationship.target_source_sha256
        ) {
          fail('evidence_mismatch')
        }
        if (
          relationship.kind !== 'contains'
          && !attestedTargets.has(
            `${target.key}\u0000${symbol.path !== target.path}`,
          )
        ) {
          let targetEvidence = evidenceCache.get(target.path)
          if (!targetEvidence) {
            targetEvidence = loadEvidence(
              root,
              common.base_commit_sha,
              target.path,
            )
            evidenceBytes += Buffer.byteLength(targetEvidence.text, 'utf8')
            if (evidenceBytes > MAX_KNOWLEDGE_SOURCE_TOTAL_BYTES) {
              fail('invalid_input')
            }
            evidenceCache.set(target.path, targetEvidence)
          }
          const targetExcerpt = excerpt(
            targetEvidence,
            target.start_line,
            target.end_line,
          )
          if (
            sha256(targetExcerpt.raw) !== target.expected_source_sha256
            || !targetDeclarationContains(
              target,
              targetExcerpt.raw,
              symbol.path !== target.path,
            )
          ) {
            fail('evidence_mismatch')
          }
          attestedTargets.add(
            `${target.key}\u0000${symbol.path !== target.path}`,
          )
        }
        if (relationship.kind === 'contains') {
          if (
            symbol.path !== target.path
            || target.start_line < symbol.start_line
            || target.end_line > symbol.end_line
          ) {
            fail('contradictory_evidence')
          }
        } else {
          assertSyntacticRelationship(
            relationship,
            symbol.language,
            symbol.path,
            evidence.text,
            evidence.lines
              .slice(0, startLine - 1)
              .map((line, index) => line + evidence!.line_separators[index])
              .join(''),
            relationshipExcerpt.raw,
            target.qualified_name,
            target.path,
            committedPathExists,
          )
        }
        const persistedTarget = metadataMap.get(target.key)
        if (!persistedTarget) fail('contradictory_evidence')
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
          target_source_sha256: relationship.target_source_sha256,
          kind: relationship.kind,
          target: {
            end_line: target.end_line,
            key: persistedTarget.key,
            path: target.path,
            qualified_name: persistedTarget.qualified_name,
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
        key: persistedSymbol.key,
        language: persistedSymbol.language,
        qualified_name: persistedSymbol.qualified_name,
        symbol_kind: persistedSymbol.symbol_kind,
      },
    })
    plans.push(planKnowledge({
      common,
      kind: 'code_symbol',
      trust: 'reference',
      title: persistedSymbol.qualified_name,
      locator:
        `code-symbols/${symbol.path}/lines-${symbol.start_line}-${symbol.end_line}.json`,
      source_revision: common.base_commit_sha,
      content: envelope.content,
      redacted: envelope.redacted || sourceExcerpt.changed
        || persistedSymbol.redacted
        || blamed.some((line) => line.text === '[REDACTED]'),
      source_range: range(symbol.start_line, symbol.end_line),
      symbol: {
        language: persistedSymbol.language,
        qualified_name: persistedSymbol.qualified_name,
        symbol_kind: persistedSymbol.symbol_kind,
        signature_sha256: symbol.expected_source_sha256,
      },
      targets: boardTargets(common.board_id),
    }))
  }
  return plans
}

function assertStructuralLogicalCompatibility(
  db: Database.Database,
  boardId: number,
  plans: readonly PlannedKnowledge[],
): void {
  const logicalPlans = new Map<string, string>()
  for (const plan of plans) {
    const logicalKey = canonicalKnowledgeJson({
      normalized_locator: plan.source.normalized_locator,
      source_kind: plan.source.source_kind,
      source_revision: plan.source.source_revision,
    })
    const plannedId = logicalPlans.get(logicalKey)
    if (plannedId !== undefined && plannedId !== plan.source.id) {
      fail('persistence_conflict')
    }
    logicalPlans.set(logicalKey, plan.source.id)
    const rows = db.prepare(`SELECT id FROM knowledge_sources
      WHERE board_id=? AND source_kind=? AND normalized_locator=?
        AND source_revision=?
      ORDER BY id`).all(
      boardId,
      plan.source.source_kind,
      plan.source.normalized_locator,
      plan.source.source_revision,
    ) as Array<{ id: string }>
    if (
      rows.length > 1
      || rows.some((row) => row.id !== plan.source.id)
    ) {
      fail('persistence_conflict')
    }
  }
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

function singleParentAtCommit(root: string, commit: string): string | null {
  const output = gitScalar(root, ['rev-list', '--parents', '-n', '1', commit])
  const parts = output.split(' ')
  if (
    parts[0] !== commit
    || parts.length > 2
    || (parts[1] !== undefined && !COMMIT_SHA.test(parts[1]))
  ) {
    fail('evidence_mismatch')
  }
  return parts[1] ?? null
}

function changedPathsAtCommit(root: string, commit: string): string[] {
  const output = gitText(root, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--name-only',
    '--no-renames',
    '-r',
    '-z',
    commit,
  ], {
    allow_empty: true,
    allow_nul: true,
    failure: 'evidence_mismatch',
  })
  if (output.length === 0) return []
  const changed = output.split('\u0000').filter(Boolean)
    .map((item) => safeRepositoryPath(item))
  const unique = [...new Set(changed)].sort(compareText)
  if (unique.length > MAX_KNOWLEDGE_SOURCE_DELIVERY_PATHS) {
    fail('evidence_mismatch')
  }
  return unique
}

function changedLineRangesAtCommit(
  root: string,
  commit: string,
  repositoryPath: string,
): Array<{ start_line: number; end_line: number }> {
  const patch = gitText(root, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    '-r',
    '--unified=0',
    '--patch',
    commit,
    '--',
    repositoryPath,
  ], {
    allow_empty: true,
    failure: 'evidence_mismatch',
  })
  const ranges: Array<{ start_line: number; end_line: number }> = []
  const hunk = /^@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,([0-9]+))? @@/gmu
  for (let match = hunk.exec(patch); match; match = hunk.exec(patch)) {
    const startLine = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    if (
      !Number.isSafeInteger(startLine)
      || !Number.isSafeInteger(count)
      || startLine < 0
      || count < 0
    ) {
      fail('evidence_mismatch')
    }
    if (count === 0) continue
    ranges.push({
      start_line: startLine,
      end_line: startLine + count - 1,
    })
  }
  return ranges
}

function assertDeliveryEvidence(
  root: string,
  baseCommit: string,
  report: DeliveryReport,
  sourceCommit: string,
): VerifiedDeliveryCommitEvidence {
  if (
    report.commits.length === 0
    || report.commits.length > MAX_KNOWLEDGE_SOURCE_HISTORY_COMMITS
    || report.commits.some((commit) => !COMMIT_SHA.test(commit))
    || report.commits.length !== new Set(report.commits).size
    || !report.commits.includes(sourceCommit)
  ) {
    fail('evidence_mismatch')
  }
  const commitSet = new Set(report.commits)
  const parentByCommit = new Map<string, string | null>()
  for (const commit of commitSet) {
    assertCommit(root, commit, 'evidence_mismatch')
    parentByCommit.set(commit, singleParentAtCommit(root, commit))
  }
  const memberParents = new Set(
    [...parentByCommit.values()].filter(
      (parent): parent is string => parent !== null && commitSet.has(parent),
    ),
  )
  const tips = [...commitSet].filter((commit) => !memberParents.has(commit))
  if (tips.length !== 1) fail('contradictory_evidence')
  const canonicalTip = tips[0]
  if (canonicalTip !== sourceCommit) fail('evidence_mismatch')

  const remaining = new Set(commitSet)
  const tipFirst: string[] = []
  let cursor: string | null = canonicalTip
  while (cursor !== null && remaining.has(cursor)) {
    tipFirst.push(cursor)
    remaining.delete(cursor)
    cursor = parentByCommit.get(cursor) ?? null
  }
  if (remaining.size !== 0) fail('contradictory_evidence')
  assertAncestor(root, canonicalTip, baseCommit)

  if (
    report.changed_files.length === 0
    || report.changed_files.length > MAX_KNOWLEDGE_SOURCE_DELIVERY_PATHS
  ) {
    fail('evidence_mismatch')
  }
  const reportedPaths = report.changed_files
    .map((file) => safeRepositoryPath(file))
    .sort(compareText)
  if (
    reportedPaths.length !== new Set(reportedPaths).size
  ) {
    fail('contradictory_evidence')
  }
  const pathsByCommit = new Map<string, string[]>()
  const touched = new Set<string>()
  for (const commit of tipFirst) {
    const paths = changedPathsAtCommit(root, commit)
    pathsByCommit.set(commit, paths)
    for (const repositoryPath of paths) touched.add(repositoryPath)
  }
  const touchedPaths = [...touched].sort(compareText)
  if (
    touchedPaths.length !== reportedPaths.length
    || touchedPaths.some((item, index) => item !== reportedPaths[index])
  ) {
    fail('evidence_mismatch')
  }
  return {
    canonical_tip: canonicalTip,
    commits_oldest_first: [...tipFirst].reverse(),
    touched_paths: touchedPaths,
    paths_by_commit: new Map(
      [...pathsByCommit].map(([commit, paths]) => [
        commit,
        new Set(paths),
      ]),
    ),
  }
}

function gotchaEvidenceAtDeliveryCommit(
  root: string,
  commitEvidence: VerifiedDeliveryCommitEvidence,
  gotcha: VerifiedGotchaInput,
): {
  commit_sha: string
  evidence: LoadedEvidence
  cited: Excerpt
} {
  for (
    const commit of [...commitEvidence.commits_oldest_first].reverse()
  ) {
    if (!commitEvidence.paths_by_commit.get(commit)?.has(gotcha.path)) continue
    const changedRanges = changedLineRangesAtCommit(root, commit, gotcha.path)
    if (!changedRanges.some((changed) =>
      gotcha.start_line >= changed.start_line
      && gotcha.end_line <= changed.end_line)) {
      continue
    }
    const evidence = loadEvidence(root, commit, gotcha.path)
    const cited = excerpt(evidence, gotcha.start_line, gotcha.end_line)
    if (
      sha256(cited.raw) === gotcha.expected_source_sha256
      && cited.redacted.includes(gotcha.text)
    ) {
      return { commit_sha: commit, evidence, cited }
    }
  }
  fail('evidence_mismatch')
}

function deliveryPlans(
  common: CommonInput,
  root: string,
  report: DeliveryReport,
  sourceCommit: string,
  gotchas: readonly VerifiedGotchaInput[],
  commitEvidence: VerifiedDeliveryCommitEvidence,
): PlannedKnowledge[] {
  if (sourceCommit !== commitEvidence.canonical_tip) {
    fail('contradictory_evidence')
  }
  const summary = generateVerifiedDeliverySummary({
    latestAcceptedReport: report,
    currentReport: report,
  })
  const summaryEnvelope = redactEnvelope({
    accepted_at: report.accepted_at,
    accepted_by: report.accepted_by,
    citation: {
      commits_oldest_first: commitEvidence.commits_oldest_first,
      commit_sha: sourceCommit,
      delivery_report_id: report.id,
      repository_key: common.repository_key,
      revision: report.sequence,
      touched_paths: commitEvidence.touched_paths,
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
  const loadedPaths = new Set<string>()
  let evidenceBytes = 0
  for (const gotcha of [...gotchas].sort((left, right) =>
    compareText(left.path, right.path)
      || left.start_line - right.start_line
      || left.end_line - right.end_line
      || compareText(left.text, right.text))) {
    const selected = gotchaEvidenceAtDeliveryCommit(
      root,
      commitEvidence,
      gotcha,
    )
    const evidenceKey = `${selected.commit_sha}\u0000${gotcha.path}`
    if (!loadedPaths.has(evidenceKey)) {
      loadedPaths.add(evidenceKey)
      evidenceBytes += Buffer.byteLength(selected.evidence.text, 'utf8')
      if (evidenceBytes > MAX_KNOWLEDGE_SOURCE_TOTAL_BYTES) fail('invalid_input')
    }
    const blamed = parseBlame(
      root,
      selected.commit_sha,
      gotcha.path,
      gotcha.start_line,
      gotcha.end_line,
    )
    const envelope = redactEnvelope({
      accepted_at: report.accepted_at,
      author: report.accepted_by,
      citation: {
        commit_sha: selected.commit_sha,
        delivery_report_id: report.id,
        end_line: gotcha.end_line,
        path: gotcha.path,
        repository_key: common.repository_key,
        start_line: gotcha.start_line,
      },
      confidence_micros: 900_000,
      evidence: {
        authors: uniqueAuthors(blamed),
        persisted_evidence_sha256: sha256(selected.cited.redacted),
        source_sha256: gotcha.expected_source_sha256,
        text: selected.cited.redacted,
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
      source_revision: selected.commit_sha,
      content: envelope.content,
      redacted: envelope.redacted || selected.cited.changed,
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
      assertStructuralLogicalCompatibility(this.db, input.common.board_id, plans)
      return persist(
        this.db,
        input.common,
        verified,
        plans,
        () => assertStructuralLogicalCompatibility(
          this.db,
          input.common.board_id,
          plans,
        ),
      )
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
      const commitEvidence = assertDeliveryEvidence(
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
        commitEvidence,
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
          const retainedEvidence = assertDeliveryEvidence(
            verified.root,
            input.common.base_commit_sha,
            retained,
            input.source_commit_sha,
          )
          if (
            retainedEvidence.canonical_tip !== commitEvidence.canonical_tip
            || canonicalKnowledgeJson(retainedEvidence.commits_oldest_first)
              !== canonicalKnowledgeJson(commitEvidence.commits_oldest_first)
            || canonicalKnowledgeJson(retainedEvidence.touched_paths)
              !== canonicalKnowledgeJson(commitEvidence.touched_paths)
          ) {
            fail('stale_evidence')
          }
        },
      )
    } catch (error) {
      throw new KnowledgeSourceIngestionError(
        trustedCode(error) ?? 'persistence_failed',
      )
    }
  }
}

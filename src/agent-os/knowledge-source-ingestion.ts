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
): number | null {
  let index = start + 1
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
      let end = index + 1
      while (end < value.length && /[A-Za-z]/u.test(value[end])) end += 1
      return end
    }
    index += 1
  }
  return null
}

function regexLiteralMayStart(tokens: readonly string[]): boolean {
  const previousIndex = previousRelationshipTokenIndex(tokens)
  if (previousIndex === null) return true
  const previous = tokens[previousIndex]
  if (previous === ')') {
    return closesStatementControlCondition(tokens, previousIndex)
  }
  return new Set([
    '!', '%', '&', '(', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=',
    '>', '?', '[', '^', '{', '|', '}', '~',
    'await', 'case', 'debugger', 'default', 'delete', 'export', 'in', 'new',
    'of', 'return', 'throw', 'typeof', 'void', 'yield',
  ]).has(previous)
}

function ecmaQuotedLiteralEnd(
  value: string,
  start: number,
  quote: string,
): number | null {
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1
      continue
    }
    if (value[index] === quote) return index + 1
    if (value[index] === '\n' || value[index] === '\r') return null
  }
  return null
}

function ecmaTemplateEnd(value: string, start: number): number | null {
  let index = start + 1
  while (index < value.length) {
    if (value[index] === '\\') {
      index += 2
      continue
    }
    if (value[index] === '`') return index + 1
    if (value[index] === '$' && value[index + 1] === '{') {
      const expressionEnd = ecmaTemplateExpressionEnd(value, index + 2)
      if (expressionEnd === null) return null
      index = expressionEnd
      continue
    }
    index += 1
  }
  return null
}

function ecmaTemplateExpressionEnd(
  value: string,
  start: number,
): number | null {
  const tokens: string[] = []
  let depth = 1
  let index = start
  while (index < value.length) {
    const current = value[index]
    const next = value[index + 1] ?? ''
    if (/\s/u.test(current)) {
      if (current === '\n') tokens.push('\n')
      index += 1
      continue
    }
    if (current === '\'' || current === '"') {
      const quotedEnd = ecmaQuotedLiteralEnd(value, index, current)
      if (quotedEnd === null) return null
      index = quotedEnd
      tokens.push(RELATIONSHIP_LITERAL_TOKEN)
      continue
    }
    if (current === '`') {
      const templateEnd = ecmaTemplateEnd(value, index)
      if (templateEnd === null) return null
      index = templateEnd
      tokens.push(RELATIONSHIP_LITERAL_TOKEN)
      continue
    }
    if (current === '/' && next === '/') {
      const lineEnd = value.indexOf('\n', index + 2)
      index = lineEnd < 0 ? value.length : lineEnd
      continue
    }
    if (current === '/' && next === '*') {
      const commentEnd = value.indexOf('*/', index + 2)
      if (commentEnd < 0) return null
      index = commentEnd + 2
      continue
    }
    if (current === '/' && regexLiteralMayStart(tokens)) {
      const regexEnd = tryRegexLiteralEnd(value, index)
      if (regexEnd === null) return null
      index = regexEnd
      tokens.push(RELATIONSHIP_REGEX_TOKEN)
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
    if (current === '{') {
      depth += 1
      tokens.push(current)
      index += 1
      continue
    }
    if (current === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
    tokens.push(current)
    index += 1
  }
  return null
}

function ecmaTemplateTokens(
  value: string,
  start: number,
  language: string,
  repositoryPath: string,
): { end: number; tokens: string[] } | null {
  const end = ecmaTemplateEnd(value, start)
  if (end === null) return null
  const tokens: string[] = []
  let literalStart = start + 1
  let index = literalStart
  while (index < end - 1) {
    if (value[index] === '\\') {
      index += 2
      continue
    }
    if (value[index] !== '$' || value[index + 1] !== '{') {
      index += 1
      continue
    }
    const expressionEnd = ecmaTemplateExpressionEnd(value, index + 2)
    if (expressionEnd === null || expressionEnd > end) return null
    tokens.push(RELATIONSHIP_LITERAL_TOKEN)
    tokens.push(...(
      value.slice(literalStart, index).match(/\n/gu) ?? []
    ))
    tokens.push(...relationshipTokens(
      value.slice(index + 2, expressionEnd - 1),
      language,
      repositoryPath,
    ))
    literalStart = expressionEnd
    index = expressionEnd
  }
  tokens.push(RELATIONSHIP_LITERAL_TOKEN)
  tokens.push(...(value.slice(literalStart, end - 1).match(/\n/gu) ?? []))
  return { end, tokens }
}

function relationshipTokens(
  value: string,
  language: string,
  repositoryPath: string,
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
      tokens.push(...(value.slice(index, end + 2).match(/\n/gu) ?? []))
      index = end + 2
      continue
    }
    if (
      current === '/'
      && regexLiterals
      && regexLiteralMayStart(tokens)
    ) {
      const regexEnd = tryRegexLiteralEnd(value, index)
      if (regexEnd === null) fail('evidence_mismatch')
      index = regexEnd
      tokens.push(RELATIONSHIP_REGEX_TOKEN)
      continue
    }
    if (hashComments && current === '#') {
      const end = value.indexOf('\n', index + 1)
      index = end < 0 ? value.length : end
      continue
    }
    if (current === '`' && regexLiterals) {
      const template = ecmaTemplateTokens(
        value,
        index,
        language,
        repositoryPath,
      )
      if (template === null) fail('evidence_mismatch')
      tokens.push(...template.tokens)
      index = template.end
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
      tokens.push(...(value.slice(start, index).match(/\n/gu) ?? []))
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
  for (let firstIndex = 0; firstIndex < tokens.length; firstIndex += 1) {
    if (tokens[firstIndex] !== first) continue
    const segments: string[][] = [[]]
    let genericDepth = 0
    for (let index = firstIndex + 1; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token === '\n') continue
      if (
        genericDepth === 0
        && new Set([';', '{', 'extends', 'implements']).has(token)
      ) {
        break
      }
      if (token === '<') genericDepth += 1
      if (token === '>' && genericDepth > 0) genericDepth -= 1
      if (token === ',' && genericDepth === 0) {
        segments.push([])
        continue
      }
      segments.at(-1)!.push(token)
    }
    if (segments.some((segment) => {
      const genericStart = segment.indexOf('<')
      const reference = genericStart < 0
        ? segment
        : segment.slice(0, genericStart)
      return reference.length % 2 === 1
        && reference.every((token, index) =>
          index % 2 === 0
            ? CODE_IDENTIFIER.test(token)
            : token === '.')
        && reference.at(-1) === second
    })) {
      return true
    }
  }
  return false
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

function optionalCallOpenAt(
  tokens: readonly string[],
  afterIndex: number,
): number | null {
  const next = significantTokenAfter(tokens, afterIndex)
  if (next?.token === '(') return next.index
  if (next?.token !== '?') return null
  const dot = significantTokenAfter(tokens, next.index)
  if (dot?.token !== '.') return null
  const open = significantTokenAfter(tokens, dot.index)
  return open?.token === '(' ? open.index : null
}

function groupingDepthBefore(
  tokens: readonly string[],
  beforeIndex: number,
): number {
  let depth = 0
  for (let index = 0; index < beforeIndex; index += 1) {
    if (new Set(['(', '[', '{']).has(tokens[index])) depth += 1
    if (new Set([')', ']', '}']).has(tokens[index]) && depth > 0) depth -= 1
  }
  return depth
}

function relationshipCallOpenAfter(
  tokens: readonly string[],
  identifierIndex: number,
  sourceLanguage: string,
  sourcePath: string,
): number | null {
  let groupStart = identifierIndex
  let anchorIndex = identifierIndex
  while (true) {
    const before = significantTokenBefore(tokens, groupStart)
    const after = significantTokenAfter(tokens, anchorIndex)
    if (
      before?.token !== '('
      || after?.token !== ')'
      || matchingParenthesis(tokens, before.index) !== after.index
    ) {
      break
    }
    groupStart = before.index
    anchorIndex = after.index
  }
  let scanAnchorIndex = anchorIndex
  if (pythonLanguage(sourceLanguage, sourcePath)) {
    while (true) {
      const continuation = significantTokenAfter(tokens, scanAnchorIndex)
      if (
        continuation?.token !== '\\'
        || tokens[continuation.index + 1] !== '\n'
      ) {
        break
      }
      scanAnchorIndex = continuation.index + 1
    }
  }
  const openIndex = optionalCallOpenAt(tokens, scanAnchorIndex)
  if (openIndex === null) return null
  if (!pythonLanguage(sourceLanguage, sourcePath)) return openIndex
  const between = tokens.slice(anchorIndex + 1, openIndex)
  if (!between.includes('\n')) return openIndex
  if (groupingDepthBefore(tokens, anchorIndex) > 0) return openIndex
  for (let index = 0; index < between.length; index += 1) {
    if (between[index] !== '\n') continue
    if (between[index - 1] !== '\\') return null
  }
  return openIndex
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

function namedDeclarationContainerAt(
  tokens: readonly string[],
  identifierIndex: number,
  owner: string,
): boolean {
  const declarationKeywords = new Set([
    'class', 'enum', 'interface', 'namespace', 'protocol', 'record', 'struct',
    'trait', 'type',
  ])
  const openIndex = nearestUnmatchedOpeningBrace(tokens, identifierIndex)
  if (openIndex === null) return false
  const prefix = statementPrefix(tokens, openIndex)
    .filter((token) => token !== '\n')
  return prefix.some((token, index) =>
    token === owner
    && declarationKeywords.has(prefix[index - 1] ?? ''))
}

function declarationContainerNamesAt(
  tokens: readonly string[],
  identifierIndex: number,
): string[] {
  const declarationKeywords = new Set([
    'class', 'enum', 'interface', 'namespace', 'protocol', 'record', 'struct',
    'trait', 'type',
  ])
  const containers: string[] = []
  let openIndex = nearestUnmatchedOpeningBrace(tokens, identifierIndex)
  while (openIndex !== null) {
    const prefix = statementPrefix(tokens, openIndex)
      .filter((token) => token !== '\n')
    let name: string | null = null
    for (let index = 0; index < prefix.length; index += 1) {
      if (!declarationKeywords.has(prefix[index])) continue
      const declaredName = prefix[index + 1] ?? ''
      if (CODE_IDENTIFIER.test(declaredName) && declaredName !== 'extends') {
        name = declaredName
        continue
      }
      if (
        prefix[index] === 'class'
        && index === prefix.length - 1
        && CODE_IDENTIFIER.test(prefix[index - 2] ?? '')
        && prefix[index - 1] === '='
        && prefix.slice(0, index - 2).includes('static')
      ) {
        name = prefix[index - 2]
      }
    }
    if (name === null) break
    containers.push(name)
    openIndex = nearestUnmatchedOpeningBrace(tokens, openIndex)
  }
  return containers
}

function callablePropertyDeclarationAt(
  tokens: readonly string[],
  identifierIndex: number,
): boolean {
  const before = significantTokenBefore(tokens, identifierIndex)?.token ?? ''
  const after = significantTokenAfter(tokens, identifierIndex)
  if (before !== 'get' && after?.token !== ':') return false
  const bounds = statementBoundsAt(tokens, identifierIndex)
  const typeOpen = after?.token === ':'
    ? significantTokenAfter(tokens, after.index)
    : null
  const objectTypeClose = typeOpen?.token === '{'
    ? closingBrace(tokens, typeOpen.index)
    : null
  const suffixEnd = objectTypeClose === null
    ? bounds.end
    : Math.max(bounds.end, objectTypeClose + 1)
  const suffix = tokens.slice(identifierIndex + 1, suffixEnd)
    .filter((token) => token !== '\n')
  let colonIndex = 0
  let getter = false
  if (before === 'get') {
    if (suffix[0] !== '(') return false
    const close = matchingParenthesis(suffix, 0)
    if (close === null || suffix[close + 1] !== ':') return false
    colonIndex = close + 1
    getter = true
  } else if (suffix[0] !== ':') {
    return false
  }

  const typeStart = colonIndex + 1
  let depth = 0
  let typeEnd = suffix.length
  for (let index = typeStart; index < suffix.length; index += 1) {
    const token = suffix[index]
    if (
      depth === 0
      && token === '='
      && suffix[index + 1] !== '>'
    ) {
      typeEnd = index
      break
    }
    if (getter && depth === 0 && token === '{' && index > typeStart) {
      typeEnd = index
      break
    }
    if (token === '(' || token === '[' || token === '{') {
      depth += 1
      continue
    }
    if (token === ')' || token === ']' || token === '}') {
      depth -= 1
      if (depth < 0) return false
      continue
    }
  }
  if (depth !== 0 && typeEnd === suffix.length) return false

  const callableType = (rawType: readonly string[]): boolean => {
    let type = [...rawType]
    while (type[0] === '(') {
      const close = matchingParenthesis(type, 0)
      if (close !== type.length - 1) break
      type = type.slice(1, -1)
    }
    const signatureParameters = (
      candidate: readonly string[],
      start: number,
    ): { close: number; open: number } | null => {
      let open = start
      if (candidate[open] === '<') {
        let genericDepth = 0
        let genericClose: number | null = null
        for (let index = open; index < candidate.length; index += 1) {
          if (candidate[index] === '<') genericDepth += 1
          if (
            candidate[index] !== '>'
            || candidate[index - 1] === '='
          ) {
            continue
          }
          genericDepth -= 1
          if (genericDepth === 0) {
            genericClose = index
            break
          }
          if (genericDepth < 0) return null
        }
        if (genericClose === null) return null
        open = genericClose + 1
      }
      if (candidate[open] !== '(') return null
      const close = matchingParenthesis(candidate, open)
      return close === null ? null : { close, open }
    }
    const arrowParameters = signatureParameters(type, 0)
    if (arrowParameters !== null) {
      return type[arrowParameters.close + 1] === '='
        && type[arrowParameters.close + 2] === '>'
    }
    if (type[0] !== '{') return false
    const close = closingBrace(type, 0)
    if (close !== type.length - 1) return false
    const members = type.slice(1, -1)
    let memberStart = 0
    let depth = 0
    for (let index = 0; index <= members.length; index += 1) {
      if (index === memberStart) {
        const parameters = signatureParameters(members, memberStart)
        if (
          parameters !== null
          && members[parameters.close + 1] === ':'
        ) {
          return true
        }
      }
      const token = members[index]
      if (token === '(' || token === '[' || token === '{') depth += 1
      if (token === ')' || token === ']' || token === '}') depth -= 1
      if (depth < 0) return false
      if (depth === 0 && (token === ';' || token === ',')) {
        memberStart = index + 1
      }
    }
    return false
  }
  return callableType(suffix.slice(typeStart, typeEnd))
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
  if (after?.token === '{') return true
  if (after?.token === ':') {
    const prefix = statementPrefix(tokens, identifierIndex)
    let depth = 0
    const depths = prefix.map((token) => {
      const current = depth
      if (token === '(' || token === '[' || token === '{') depth += 1
      if (token === ')' || token === ']' || token === '}') depth -= 1
      return current
    })
    const callDepth = depth
    let ternaries = 0
    for (let index = 0; index < prefix.length; index += 1) {
      if (depths[index] !== callDepth) continue
      if (prefix[index] === '?' && prefix[index + 1] !== '.') {
        ternaries += 1
      } else if (prefix[index] === ':' && ternaries > 0) {
        ternaries -= 1
      }
    }
    if (ternaries === 0) return true
  }
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
  const tokens = relationshipTokens(
    targetEvidence,
    symbol.language,
    symbol.path,
  )
  const javaClassPart = javaLanguage(symbol.language, symbol.path)
    ? javaTargetClassPartIndex(qualifiedParts, symbol.path)
    : 0
  if (javaClassPart > 0) {
    const declaredPackage = javaPackageComponents(tokens)
    const qualifiedPackage = qualifiedParts.slice(0, javaClassPart)
    if (
      declaredPackage.length !== qualifiedPackage.length
      || !declaredPackage.every(
        (component, index) => component === qualifiedPackage[index],
      )
    ) {
      return false
    }
  }
  const owners = javaLanguage(symbol.language, symbol.path)
    ? qualifiedParts.slice(javaClassPart, -1)
    : qualifiedParts.slice(0, -1)
  const owner = owners.at(-1) ?? null
  const normalizedKind =
    /^[A-Za-z]+/u.exec(symbol.symbol_kind)?.[0]?.toLowerCase() ?? ''
  const callableDeclarationKeywords = new Set([
    'def', 'fn', 'func', 'function', 'fun', 'proc', 'sub',
  ])
  const variableDeclarationKeywords = new Set(['const', 'let', 'var'])
  const keywordKinds = new Map([
    ['class', 'class'],
    ['enum', 'enum'],
    ['interface', 'interface'],
    ['namespace', 'namespace'],
    ['record', 'record'],
    ['struct', 'struct'],
    ['trait', 'trait'],
    ['type', 'type'],
  ])
  const memberKind = new Set(['field', 'method', 'property'])
    .has(normalizedKind)
  const ownerRequired = owner !== null && memberKind
  const pythonOwnerMatches = ownerRequired
    && pythonLanguage(symbol.language, symbol.path)
    && pythonClassOwnsDeclaration(
      targetEvidence,
      owners,
      identifier,
      normalizedKind,
    )
  const ownerMatches = (identifierIndex: number): boolean =>
    pythonLanguage(symbol.language, symbol.path)
      ? !ownerRequired || pythonOwnerMatches
      : (() => {
          const containers = declarationContainerNamesAt(
            tokens,
            identifierIndex,
          )
          if (!ownerRequired && memberKind) return true
          if (!ownerRequired && containers.length === 0) return true
          const syntheticPrefix =
            ecmaScriptLanguage(symbol.language, symbol.path)
            && containers.length > 0
            && owners.length === containers.length + 1
            && owners[0] === 'Namespace'
          return (
            containers.length === owners.length
            || syntheticPrefix
          )
            && containers.every(
              (name, index) => name === owners[owners.length - index - 1],
            )
        })()
  const callableKindMatches = (identifierIndex: number): boolean =>
    normalizedKind === 'method'
      ? ownerMatches(identifierIndex)
        && (
          owner !== null
          || declarationContainerAt(tokens, identifierIndex)
        )
      : normalizedKind === 'function'
        && (
          !declarationContainerAt(tokens, identifierIndex)
          || (owners.length > 0 && ownerMatches(identifierIndex))
        )
  const declared = tokens.some((token, index) => {
    if (token !== identifier) return false
    if (!ownerMatches(index)) return false
    const before = significantTokenBefore(tokens, index)
    const beforeToken = before?.token ?? ''
    if (keywordKinds.get(beforeToken) === normalizedKind) return true
    if (
      callableKindMatches(index)
      && callableDeclarationKeywords.has(beforeToken)
    ) {
      return true
    }
    if (
      new Set(['constant', 'field', 'property', 'variable'])
        .has(normalizedKind)
      && variableDeclarationKeywords.has(beforeToken)
    ) {
      return true
    }
    if (
      normalizedKind === 'property'
      && callablePropertyDeclarationAt(tokens, index)
    ) {
      return true
    }
    const after = significantTokenAfter(tokens, index)
    if (after?.token === '(') {
      const close = matchingParenthesis(tokens, after.index)
      return callableKindMatches(index)
        && close !== null
        && declarationLikeCall(
          tokens,
          index,
          close,
          symbol.language,
          symbol.path,
        )
    }
    const declarationPrefix = statementPrefix(tokens, index)
      .filter((prefixToken) => prefixToken !== '\n')
    if (
      after?.token === '='
      && new Set(['constant', 'field', 'property', 'variable'])
        .has(normalizedKind)
      && beforeToken !== '.'
      && !declarationPrefix.includes('=')
      && !declarationPrefix.includes('(')
    ) {
      return true
    }
    if (
      after?.token === ';'
      && normalizedKind === 'field'
      && beforeToken !== '.'
      && !declarationPrefix.includes('=')
      && !declarationPrefix.includes('(')
      && !declarationPrefix.some((prefixToken) =>
        new Set(['case', 'return', 'throw', 'yield']).has(prefixToken))
      && declarationPrefix.some((prefixToken) =>
        CODE_IDENTIFIER.test(prefixToken))
    ) {
      return true
    }
    return declarationPrefix.includes('export')
      && declarationPrefix.includes('{')
      && new Set(['constant', 'field', 'property', 'variable'])
        .has(normalizedKind)
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
    || (
      owners.length > 0
      && CODE_IDENTIFIER.test(owners[0])
      && exported(owners[0])
    )
}

function targetDefaultExportContains(
  symbol: StructuralSymbolInput,
  targetEvidence: string,
): boolean {
  if (!ecmaScriptLanguage(symbol.language, symbol.path)) return false
  const identifier = targetIdentifier(symbol.qualified_name)
  const tokens = relationshipTokens(
    targetEvidence,
    symbol.language,
    symbol.path,
  )
  return tokens.some((token, index) => {
    if (token !== identifier) return false
    const prefix = statementPrefix(tokens, index)
      .filter((prefixToken) => prefixToken !== '\n')
    if (prefix.includes('export') && prefix.includes('default')) return true
    const asToken = significantTokenAfter(tokens, index)
    const defaultToken = asToken?.token === 'as'
      ? significantTokenAfter(tokens, asToken.index)
      : null
    return prefix.includes('export')
      && prefix.includes('{')
      && defaultToken?.token === 'default'
  })
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
  targetHasDefaultExport: boolean,
  requiredLocalIdentifier?: string,
): boolean {
  const binding = bindingTokens.filter((token) => token !== '\n')
  const requiredLocal = requiredLocalIdentifier ?? identifier
  const namespacePrefix = binding[0] === 'type'
    ? binding.slice(1)
    : binding
  if (
    namespacePrefix.length === 3
    && namespacePrefix[0] === '*'
    && namespacePrefix[1] === 'as'
    && namespacePrefix[2] === requiredLocal
  ) {
    return true
  }
  const openIndex = binding.indexOf('{')
  if (openIndex < 0) {
    const defaultBinding = binding[0] === 'type'
      ? binding.slice(1)
      : binding
    return targetHasDefaultExport
      && defaultBinding.length === 1
      && defaultBinding[0] === requiredLocal
  }
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
  if (
    targetHasDefaultExport
    && prefix.length === 2
    && prefix[0] === requiredLocal
  ) {
    return true
  }
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
  const extension = path.posix.extname(resolved).toLowerCase()
  const withoutExtension = extension.length > 0
    ? resolved.slice(0, -extension.length)
    : resolved
  const mappedExtensions: Record<string, readonly string[]> = {
    '.cjs': ['.cjs', '.cts'],
    '.js': ['.js', '.jsx', '.ts', '.tsx'],
    '.jsx': ['.jsx', '.tsx'],
    '.mjs': ['.mjs', '.mts'],
  }
  const candidateExtensions =
    ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'] as const
  const candidates = extension.length > 0
    ? (mappedExtensions[extension] ?? [extension])
      .map((mapped) => withoutExtension + mapped)
    : [
        ...candidateExtensions.map((candidate) => resolved + candidate),
        ...candidateExtensions.map(
          (candidate) => `${resolved}/index${candidate}`,
        ),
      ]
  return candidates.find(exactPathExists) === targetPath
}

function ecmaScriptImportContains(
  tokens: readonly string[],
  identifier: string,
  sourcePath: string,
  targetPath: string,
  exactPathExists: (repositoryPath: string) => boolean,
  targetHasDefaultExport: boolean,
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
          targetHasDefaultExport,
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
    const referenceStack = openingBraceStackAt(tokens, requireIndex)
    const shadowed = tokens.some((token, tokenIndex) => {
      if (token !== 'require' || tokenIndex === requireIndex) return false
      if (parameterBindingShadowsReference(
        tokens,
        tokenIndex,
        requireIndex,
        'javascript',
        sourcePath,
      )) {
        return true
      }
      const before = significantTokenBefore(tokens, tokenIndex)
      const after = significantTokenAfter(tokens, tokenIndex)
      if (before?.token === '.') return false
      const generatorFunction = before?.token === '*'
        ? significantTokenBefore(tokens, before.index)
        : null
      const functionKeyword = before?.token === 'function'
        ? before
        : generatorFunction?.token === 'function'
          ? generatorFunction
          : null
      const bounds = statementBoundsAt(tokens, tokenIndex)
      const prefix = tokens.slice(bounds.start, tokenIndex)
        .filter((candidate) => candidate !== '\n')
      const declaration = new Set([
        'class', 'const', 'def', 'fn', 'function', 'let', 'var',
      ]).has(before?.token ?? '')
        || functionKeyword !== null
        || (
          prefix.some((candidate) =>
            new Set(['const', 'let', 'var']).has(candidate))
          && tokens.slice(tokenIndex + 1, bounds.end).includes('=')
        )
        || (
          after?.token === '='
          && prefix.some((candidate) =>
            new Set(['const', 'let', 'var']).has(candidate))
        )
      const namedClassExpressionBody = (() => {
        if (before?.token !== 'class') return null
        const classPrefix = statementPrefix(tokens, before.index)
          .filter((candidate) => candidate !== '\n')
        const declarationModifiers = new Set(['abstract', 'declare', 'default', 'export'])
        const statementContext = classPrefix.filter((candidate) =>
          !declarationModifiers.has(candidate))
        if (statementContext.length === 0) return null
        const body = significantTokenAfter(tokens, tokenIndex)
        return body?.token === '{' ? body.index : null
      })()
      const namedFunctionExpressionBody = (() => {
        if (functionKeyword === null || after?.token !== '(') return null
        const functionPrefix = statementPrefix(tokens, functionKeyword.index)
          .filter((candidate) => candidate !== '\n')
        const declarationModifiers = new Set(['async', 'default', 'export'])
        let prefixEnd = functionPrefix.length
        while (
          prefixEnd > 0
          && declarationModifiers.has(functionPrefix[prefixEnd - 1])
        ) {
          prefixEnd -= 1
        }
        const statementContext = functionPrefix.slice(0, prefixEnd)
        let labelsStart = statementContext.length
        while (
          labelsStart >= 2
          && statementContext[labelsStart - 1] === ':'
          && CODE_IDENTIFIER.test(statementContext[labelsStart - 2])
        ) {
          labelsStart -= 2
        }
        const beforeLabels = statementContext.slice(0, labelsStart)
        const labeledDeclaration = labelsStart < statementContext.length
          && (
            beforeLabels.length === 0
            || controlConditionPrefix(beforeLabels)
            || beforeLabels.at(-1) === 'else'
          )
          && (() => {
            const braceStack = openingBraceStackAt(tokens, functionKeyword.index)
            if (braceStack.length === 0) return true
            if (executableContainerAt(tokens, functionKeyword.index)) return true
            const bracePrefix = statementPrefix(
              tokens,
              braceStack.at(-1) ?? functionKeyword.index,
            ).filter((candidate) => candidate !== '\n')
            return bracePrefix.length === 0
          })()
        const conditionalDeclaration = controlConditionPrefix(statementContext)
          || statementContext.at(-1) === 'else'
        const switchClauseDeclaration = statementContext.at(-1) === ':'
          && new Set(['case', 'default']).has(statementContext[0] ?? '')
        if (
          statementContext.length === 0
          || labeledDeclaration
          || conditionalDeclaration
          || switchClauseDeclaration
        ) {
          return null
        }
        const parametersClose = matchingParenthesis(tokens, after.index)
        if (parametersClose === null) return null
        const body = significantTokenAfter(tokens, parametersClose)
        return body?.token === '{' ? body.index : null
      })()
      const namedFunctionDeclaration = functionKeyword !== null
        && after?.token === '('
        && namedFunctionExpressionBody === null
      const declarationStack = namedFunctionExpressionBody !== null
        ? [
            ...openingBraceStackAt(tokens, namedFunctionExpressionBody),
            namedFunctionExpressionBody,
          ]
        : namedClassExpressionBody !== null
          ? [
              ...openingBraceStackAt(tokens, namedClassExpressionBody),
              namedClassExpressionBody,
            ]
        : namedFunctionDeclaration
          ? (() => {
              const stack = openingBraceStackAt(tokens, tokenIndex)
              const classScoped = stack.some((braceIndex) =>
                statementPrefix(tokens, braceIndex).includes('class'))
              if (classScoped) return stack
              const strictDirectiveAt = (braceIndex: number | null): boolean => {
                let cursor = braceIndex === null ? 0 : braceIndex + 1
                if (
                  braceIndex === null
                  && tokens[cursor] === '#'
                  && tokens[cursor + 1] === '!'
                ) {
                  while (cursor < tokens.length && tokens[cursor] !== '\n') {
                    cursor += 1
                  }
                }
                while (cursor < tokens.length) {
                  while (
                    cursor < tokens.length
                    && new Set(['\n', ';']).has(tokens[cursor])
                  ) {
                    cursor += 1
                  }
                  if (cursor >= tokens.length) return false
                  const directive = relationshipLiteralValue(tokens[cursor])
                  if (directive === null) return false
                  if (directive === 'use strict') return true
                  cursor += 1
                }
                return false
              }
              let nearestFunctionScope: number | null = null
              for (let index = stack.length - 1; index >= 0; index -= 1) {
                const containerPrefix = statementPrefix(tokens, stack[index])
                  .filter((candidate) => candidate !== '\n')
                const arrowBody = containerPrefix.some((candidate, candidateIndex) =>
                  candidate === '=' && containerPrefix[candidateIndex + 1] === '>')
                const closeIndex = containerPrefix.length - 1
                const openIndex = containerPrefix.at(-1) === ')'
                  ? matchingOpenParenthesis(containerPrefix, closeIndex)
                  : null
                const beforeOpen = openIndex === null
                  ? null
                  : previousRelationshipTokenIndex(containerPrefix, openIndex)
                const controlBody = beforeOpen !== null
                  && new Set([
                    'catch', 'for', 'if', 'switch', 'while', 'with',
                  ]).has(containerPrefix[beforeOpen])
                const functionBody = containerPrefix.at(-1) === ')'
                  && !controlBody
                if (!arrowBody && !functionBody) continue
                nearestFunctionScope ??= index
                if (strictDirectiveAt(stack[index])) return stack
              }
              if (strictDirectiveAt(null)) return stack
              return nearestFunctionScope === null
                ? []
                : stack.slice(0, nearestFunctionScope + 1)
            })()
          : openingBraceStackAt(tokens, tokenIndex)
      return declaration
        && stackIsPrefix(
          declarationStack,
          referenceStack,
        )
    })
    if (shadowed) continue
    const open = significantTokenAfter(tokens, requireIndex)
    if (open?.token !== '(') continue
    const specifierToken = significantTokenAfter(tokens, open.index)
    if (specifierToken === null) continue
    const specifier = relationshipLiteralValue(specifierToken.token)
    const afterSpecifier = significantTokenAfter(tokens, specifierToken.index)
    const close = afterSpecifier?.token === ','
      ? significantTokenAfter(tokens, afterSpecifier.index)
      : afterSpecifier
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
  exactPathExists: (repositoryPath: string) => boolean,
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
  if (safe === null) return false
  return [`${safe}/__init__.py`, `${safe}.py`]
    .find(exactPathExists) === targetPath
}

function withoutPythonLineContinuations(
  tokens: readonly string[],
): string[] {
  const output: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === '\\' && tokens[index + 1] === '\n') {
      index += 1
      continue
    }
    output.push(tokens[index])
  }
  return output
}

function pythonImportContains(
  tokens: readonly string[],
  identifier: string,
  sourcePath: string,
  targetPath: string,
  exactPathExists: (repositoryPath: string) => boolean,
  requiredLocalIdentifier?: string,
): boolean {
  const continuedTokens = withoutPythonLineContinuations(tokens)
  for (
    let fromIndex = 0;
    fromIndex < continuedTokens.length;
    fromIndex += 1
  ) {
    if (continuedTokens[fromIndex] !== 'from') continue
    let importIndex = fromIndex + 1
    while (
      importIndex < continuedTokens.length
      && continuedTokens[importIndex] !== 'import'
    ) {
      if (
        continuedTokens[importIndex] === ';'
        || continuedTokens[importIndex] === '\n'
      ) {
        break
      }
      importIndex += 1
    }
    if (
      importIndex >= continuedTokens.length
      || continuedTokens[importIndex] !== 'import'
      || !pythonModuleTargets(
        continuedTokens.slice(fromIndex + 1, importIndex),
        sourcePath,
        targetPath,
        exactPathExists,
      )
    ) {
      continue
    }
    const imported: string[] = []
    let depth = 0
    for (
      let cursor = importIndex + 1;
      cursor < continuedTokens.length;
      cursor += 1
    ) {
      const token = continuedTokens[cursor]
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

function javaTargetClassPartIndex(
  qualifiedParts: readonly string[],
  targetPath: string,
): number {
  for (let index = 0; index < qualifiedParts.length; index += 1) {
    if (javaModuleTargets(qualifiedParts.slice(0, index + 1), targetPath)) {
      return index
    }
  }
  return 0
}

function javaPackageComponents(tokens: readonly string[]): string[] {
  const packageIndex = tokens.indexOf('package')
  if (packageIndex < 0) return []
  const clause: string[] = []
  for (let index = packageIndex + 1; index < tokens.length; index += 1) {
    if (tokens[index] === ';') break
    if (tokens[index] !== '\n') clause.push(tokens[index])
  }
  if (
    clause.length % 2 !== 1
    || !clause.every((token, index) =>
      index % 2 === 0 ? CODE_IDENTIFIER.test(token) : token === '.')
  ) {
    return []
  }
  return clause.filter((_, index) => index % 2 === 0)
}

function javaImportContains(
  tokens: readonly string[],
  identifier: string,
  targetPath: string,
  targetQualifiedParts?: readonly string[],
): boolean {
  const targetClassPart = targetQualifiedParts === undefined
    ? null
    : javaTargetClassPartIndex(targetQualifiedParts, targetPath)
  const qualifiedTargetAnchored =
    targetQualifiedParts !== undefined
    && targetClassPart !== null
    && javaModuleTargets(
      targetQualifiedParts.slice(0, targetClassPart + 1),
      targetPath,
    )
  const exactQualifiedImport = (
    components: readonly string[],
    isStatic: boolean,
    wildcard: boolean,
  ): boolean => {
    if (
      targetQualifiedParts === undefined
      || targetClassPart === null
      || !qualifiedTargetAnchored
    ) {
      return false
    }
    return targetQualifiedParts.some((part, index) => {
      if (part !== identifier || index < targetClassPart) return false
      if (!isStatic && wildcard && index !== targetClassPart) return false
      const expected = targetQualifiedParts.slice(0, index + 1)
      const boundComponents = wildcard
        ? [...components, identifier]
        : [...components]
      if (targetClassPart > 0) {
        return boundComponents.length === expected.length
          && boundComponents.every(
            (component, componentIndex) =>
              component === expected[componentIndex],
          )
      }
      if (
        boundComponents.length < expected.length
        || !expected.every(
          (component, componentIndex) => component
            === boundComponents[
              boundComponents.length - expected.length + componentIndex
            ],
        )
      ) {
        return false
      }
      const packageLength = boundComponents.length - expected.length
      return javaModuleTargets(
        boundComponents.slice(0, packageLength + 1),
        targetPath,
      )
    })
  }
  for (let importIndex = 0; importIndex < tokens.length; importIndex += 1) {
    if (tokens[importIndex] !== 'import') continue
    const clause: string[] = []
    for (let cursor = importIndex + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor] === ';') break
      if (tokens[cursor] !== '\n') clause.push(tokens[cursor])
    }
    const isStatic = clause[0] === 'static'
    const qualified = isStatic ? clause.slice(1) : clause
    const wildcard = qualified.length >= 2
      && qualified.at(-2) === '.'
      && qualified.at(-1) === '*'
    const namedQualified = wildcard ? qualified.slice(0, -2) : qualified
    if (
      namedQualified.length < 1
      || namedQualified.some((token, index) =>
        index % 2 === 0 ? !CODE_IDENTIFIER.test(token) : token !== '.')
    ) {
      continue
    }
    const components = namedQualified
      .filter((_, index) => index % 2 === 0)
    if (wildcard) {
      if (qualifiedTargetAnchored) {
        if (exactQualifiedImport(components, isStatic, true)) return true
        continue
      }
      const module = isStatic ? components : [...components, identifier]
      if (javaModuleTargets(module, targetPath)) return true
      continue
    }
    const imported = components.at(-1)
    if (imported === identifier && qualifiedTargetAnchored) {
      if (exactQualifiedImport(components, isStatic, false)) return true
      continue
    }
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

function javaQualifiedReferenceContains(
  tokens: readonly string[],
  identifier: string,
  sourcePath: string,
  targetPath: string,
): boolean {
  const packageComponents = javaPackageComponents(tokens)
  const packageIndex = tokens.indexOf('package')
  return tokens.some((token, index) => {
    if (token !== identifier) return false
    const components = [identifier]
    let cursor = index
    while (true) {
      const dot = significantTokenBefore(tokens, cursor)
      if (dot?.token !== '.') break
      const component = significantTokenBefore(tokens, dot.index)
      if (component === null || !CODE_IDENTIFIER.test(component.token)) break
      components.unshift(component.token)
      cursor = component.index
    }
    if (components.length < 2) {
      if (packageComponents.length > 0) {
        return javaModuleTargets(
          [...packageComponents, ...components],
          targetPath,
        )
      }
      return packageIndex < 0
        && path.posix.dirname(sourcePath) === path.posix.dirname(targetPath)
        && path.posix.basename(targetPath) === `${identifier}.java`
    }
    return javaModuleTargets(components, targetPath)
      || javaModuleTargets(components.slice(0, -1), targetPath)
  })
}

function staticImportContains(
  tokens: readonly string[],
  identifier: string,
  sourceLanguage: string,
  sourcePath: string,
  targetPath: string,
  exactPathExists: (repositoryPath: string) => boolean,
  targetHasDefaultExport: boolean,
  allowJavaQualifiedReference: boolean,
  requiredLocalIdentifier?: string,
  targetQualifiedParts?: readonly string[],
): boolean {
  if (ecmaScriptLanguage(sourceLanguage, sourcePath)) {
    return ecmaScriptImportContains(
      tokens,
      identifier,
      sourcePath,
      targetPath,
      exactPathExists,
      targetHasDefaultExport,
      requiredLocalIdentifier,
    )
  }
  if (pythonLanguage(sourceLanguage, sourcePath)) {
    return pythonImportContains(
      tokens,
      identifier,
      sourcePath,
      targetPath,
      exactPathExists,
      requiredLocalIdentifier,
    )
  }
  if (javaLanguage(sourceLanguage, sourcePath)) {
    return javaImportContains(
      tokens,
      identifier,
      targetPath,
      targetQualifiedParts,
    )
      || (
        allowJavaQualifiedReference
        && javaQualifiedReferenceContains(
          tokens,
          identifier,
          sourcePath,
          targetPath,
        )
      )
  }
  return false
}

function openingBraceStackAt(
  tokens: readonly string[],
  beforeIndex: number,
): number[] {
  const stack: number[] = []
  for (let index = 0; index < beforeIndex; index += 1) {
    if (tokens[index] === '{') {
      stack.push(index)
    } else if (tokens[index] === '}') {
      stack.pop()
    }
  }
  return stack
}

function stackIsPrefix(
  prefix: readonly number[],
  stack: readonly number[],
): boolean {
  return prefix.length <= stack.length
    && prefix.every((value, index) => stack[index] === value)
}

function physicalStatementStart(
  tokens: readonly string[],
  index: number,
): number {
  let start = index
  while (
    start > 0
    && tokens[start - 1] !== '\n'
    && tokens[start - 1] !== ';'
  ) {
    start -= 1
  }
  return start
}

function physicalStatementEnd(
  tokens: readonly string[],
  index: number,
): number {
  let end = index
  while (
    end < tokens.length
    && tokens[end] !== '\n'
    && tokens[end] !== ';'
  ) {
    end += 1
  }
  return end
}

function logicalStatementNeedsNextLine(
  tokens: readonly string[],
  start: number,
  end: number,
): boolean {
  const statement = tokens.slice(start, end)
    .filter((token) => token !== '\n')
  if (statement.length === 0) return false
  let parentheses = 0
  let brackets = 0
  let braces = 0
  for (const token of statement) {
    if (token === '(') parentheses += 1
    if (token === ')' && parentheses > 0) parentheses -= 1
    if (token === '[') brackets += 1
    if (token === ']' && brackets > 0) brackets -= 1
    if (token === '{') braces += 1
    if (token === '}' && braces > 0) braces -= 1
  }
  const importLike = statement.includes('import')
    || statement.includes('require')
    || statement.some((token) => new Set(['const', 'let', 'var']).has(token))
  return parentheses > 0
    || brackets > 0
    || (importLike && braces > 0)
    || new Set(['\\', '(', '[', ',', '=']).has(statement.at(-1) ?? '')
}

function statementBoundsAt(
  tokens: readonly string[],
  index: number,
): { start: number; end: number } {
  let start = physicalStatementStart(tokens, index)
  while (start > 0) {
    const previousEnd = start - 1
    const previousStart = physicalStatementStart(tokens, previousEnd)
    const previous = tokens.slice(previousStart, previousEnd)
      .filter((token) => token !== '\n')
    const current = tokens.slice(start, physicalStatementEnd(tokens, start))
      .filter((token) => token !== '\n')
    const previousLast = previous.at(-1) ?? ''
    const previousOpensBinding = previousLast === '{'
      && previous.some((token) =>
        new Set(['const', 'import', 'let', 'var']).has(token))
    if (
      !new Set([')', ']', '}']).has(current[0] ?? '')
      && !new Set(['\\', '(', '[', ',', '=']).has(previousLast)
      && !previousOpensBinding
    ) {
      break
    }
    start = previousStart
  }
  let end = physicalStatementEnd(tokens, index + 1)
  while (end < tokens.length && tokens[end] !== ';') {
    const nextStart = end + 1
    if (nextStart >= tokens.length) break
    const nextEnd = physicalStatementEnd(tokens, nextStart)
    const next = tokens.slice(nextStart, nextEnd)
      .filter((token) => token !== '\n')
    if (
      !logicalStatementNeedsNextLine(tokens, start, end)
      && !new Set([')', ']', '}']).has(next[0] ?? '')
    ) {
      break
    }
    end = nextEnd
  }
  return { start, end }
}

function importedBindingAt(
  tokens: readonly string[],
  identifierIndex: number,
): boolean {
  const bounds = statementBoundsAt(tokens, identifierIndex)
  const statement = tokens.slice(bounds.start, bounds.end)
  return statement.includes('import') || statement.includes('require')
}

function pythonIndentation(line: string): number {
  let indentation = 0
  for (const character of line) {
    if (character === ' ') {
      indentation += 1
    } else if (character === '\t') {
      indentation += 8 - (indentation % 8)
    } else {
      break
    }
  }
  return indentation
}

function pythonSuiteEnd(
  lines: readonly string[],
  headerLine: number,
  headerIndentation: number,
): number {
  for (let line = headerLine + 1; line < lines.length; line += 1) {
    const trimmed = lines[line].trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    if (pythonIndentation(lines[line]) <= headerIndentation) return line
  }
  return lines.length
}

type PythonLogicalStatement = {
  endLine: number
  endToken: number
  indentation: number
  startLine: number
  startToken: number
  tokens: string[]
}

function pythonLogicalStatements(sourceText: string): PythonLogicalStatement[] {
  const lines = sourceText.split(/\r?\n/u)
  const sourceTokens = relationshipTokens(sourceText, 'python', 'scope.py')
  const statements: PythonLogicalStatement[] = []
  let current: string[] = []
  let currentLine = 0
  let startLine: number | null = null
  let startToken: number | null = null
  let depth = 0
  const flush = (endLine: number, endToken: number): void => {
    const significant = current.filter((token) => token !== '\n')
    if (
      startLine !== null
      && startToken !== null
      && significant.length > 0
    ) {
      statements.push({
        endLine,
        endToken,
        indentation: pythonIndentation(lines[startLine] ?? ''),
        startLine,
        startToken,
        tokens: [...current],
      })
    }
    current = []
    startLine = null
    startToken = null
  }
  for (let tokenIndex = 0; tokenIndex < sourceTokens.length; tokenIndex += 1) {
    const token = sourceTokens[tokenIndex]
    if (token === '\n') {
      const explicitContinuation = current.at(-1) === '\\'
      current.push(token)
      if (depth === 0 && !explicitContinuation) {
        flush(currentLine, tokenIndex + 1)
      }
      currentLine += 1
      continue
    }
    if (startLine === null) {
      startLine = currentLine
      startToken = tokenIndex
    }
    if (token === '(' || token === '[' || token === '{') depth += 1
    if (token === ')' || token === ']' || token === '}') {
      depth -= 1
      if (depth < 0) fail('evidence_mismatch')
    }
    if (token === ';' && depth === 0) {
      flush(currentLine, tokenIndex)
      continue
    }
    current.push(token)
  }
  if (depth !== 0) fail('evidence_mismatch')
  flush(currentLine, sourceTokens.length)
  return statements
}

function pythonFunctionHeader(
  rawTokens: readonly string[],
): { name: string; parameters: string[][] } | null {
  const tokens = rawTokens.filter((token) => token !== '\n')
  const defIndex = tokens[0] === 'async' ? 1 : 0
  if (tokens[defIndex] !== 'def') return null
  const name = tokens[defIndex + 1] ?? ''
  const openIndex = defIndex + 2
  if (!CODE_IDENTIFIER.test(name) || tokens[openIndex] !== '(') return null
  const closeIndex = matchingParenthesis(tokens, openIndex)
  if (closeIndex === null) return null
  return {
    name,
    parameters: relationshipSegments(
      tokens.slice(openIndex + 1, closeIndex),
    ),
  }
}

function pythonParametersContain(
  parameters: readonly string[][],
  identifier: string,
): boolean {
  return parameters.some((rawParameter) => {
    let start = 0
    while (rawParameter[start] === '*') start += 1
    return rawParameter[start] === identifier
  })
}

function pythonTargetContains(
  tokens: readonly string[],
  identifier: string,
): boolean {
  return tokens.some((token, index) =>
    token === identifier && tokens[index - 1] !== '.')
}

function pythonDelimiterDepths(tokens: readonly string[]): number[] {
  const depths: number[] = []
  let depth = 0
  for (const token of tokens) {
    depths.push(depth)
    if (token === '(' || token === '[' || token === '{') depth += 1
    if (token === ')' || token === ']' || token === '}') depth -= 1
    if (depth < 0) fail('evidence_mismatch')
  }
  if (depth !== 0) fail('evidence_mismatch')
  return depths
}

function pythonExpressionBindsIdentifier(
  tokens: readonly string[],
  identifier: string,
  referenceToken?: number,
): boolean {
  const indexed = tokens
    .map((token, index) => ({ index, token }))
    .filter((entry) => entry.token !== '\n')
  const significant = indexed.map((entry) => entry.token)
  const referenceIndex = referenceToken === undefined
    ? null
    : indexed.findIndex((entry) => entry.index === referenceToken)
  if (referenceIndex !== null && referenceIndex < 0) return true
  const depths = pythonDelimiterDepths(significant)
  const opening = new Set(['(', '[', '{'])
  const closing = new Map([
    [')', '('],
    [']', '['],
    ['}', '{'],
  ])
  const openStack: number[] = []
  const closeByOpen = new Map<number, number>()
  const enclosingOpen: Array<number | null> = []
  for (let index = 0; index < significant.length; index += 1) {
    enclosingOpen.push(openStack.at(-1) ?? null)
    if (opening.has(significant[index])) {
      openStack.push(index)
      continue
    }
    const expected = closing.get(significant[index])
    if (expected === undefined) continue
    const open = openStack.pop()
    if (open === undefined || significant[open] !== expected) {
      fail('evidence_mismatch')
    }
    closeByOpen.set(open, index)
  }
  if (openStack.length > 0) fail('evidence_mismatch')
  for (let index = 0; index < significant.length; index += 1) {
    if (significant[index] === 'lambda') {
      const baseDepth = depths[index]
      let colon = -1
      for (let cursor = index + 1; cursor < significant.length; cursor += 1) {
        if (depths[cursor] < baseDepth) break
        if (significant[cursor] === ':' && depths[cursor] === baseDepth) {
          colon = cursor
          break
        }
      }
      if (
        colon > index
        && pythonTargetContains(significant.slice(index + 1, colon), identifier)
      ) {
        if (referenceIndex === null) return true
        let expressionEnd = significant.length
        for (let cursor = colon + 1; cursor < significant.length; cursor += 1) {
          const token = significant[cursor]
          if (
            depths[cursor] < baseDepth
            || (depths[cursor] === baseDepth && token === ',')
            || (
              depths[cursor] === baseDepth
              && closing.has(token)
            )
          ) {
            expressionEnd = cursor
            break
          }
        }
        if (referenceIndex > colon && referenceIndex < expressionEnd) return true
      }
    }
    if (significant[index] !== 'for' || depths[index] === 0) continue
    const comprehensionOpen = enclosingOpen[index]
    const comprehensionClose = comprehensionOpen === null
      ? undefined
      : closeByOpen.get(comprehensionOpen)
    if (comprehensionOpen === null || comprehensionClose === undefined) continue
    const comprehensionDepth = depths[index]
    let inIndex = -1
    for (let cursor = index + 1; cursor < comprehensionClose; cursor += 1) {
      if (
        significant[cursor] === 'in'
        && depths[cursor] === comprehensionDepth
      ) {
        inIndex = cursor
        break
      }
    }
    if (
      inIndex > index
      && pythonTargetContains(significant.slice(index + 1, inIndex), identifier)
    ) {
      if (referenceIndex === null) return true
      let firstFor = index
      for (let cursor = comprehensionOpen + 1; cursor < index; cursor += 1) {
        if (
          significant[cursor] === 'for'
          && depths[cursor] === comprehensionDepth
        ) {
          firstFor = cursor
          break
        }
      }
      let iterableEnd = comprehensionClose
      for (let cursor = inIndex + 1; cursor < comprehensionClose; cursor += 1) {
        if (
          depths[cursor] === comprehensionDepth
          && new Set(['for', 'if']).has(significant[cursor])
        ) {
          iterableEnd = cursor
          break
        }
      }
      if (
        (
          referenceIndex > comprehensionOpen
          && referenceIndex < firstFor
        )
        || (
          referenceIndex >= iterableEnd
          && referenceIndex < comprehensionClose
        )
      ) {
        return true
      }
    }
  }
  return false
}

function pythonAssignmentBindsIdentifier(
  tokens: readonly string[],
  identifier: string,
): boolean {
  const significant = tokens.filter((token) => token !== '\n')
  const depths = pythonDelimiterDepths(significant)
  if (
    significant[0] === identifier
    && significant[1] === ':'
    && significant[2] !== '='
  ) {
    return true
  }
  for (let index = 0; index < significant.length; index += 1) {
    if (
      significant[index] === ':'
      && significant[index + 1] === '='
      && significant[index - 1] === identifier
    ) {
      return true
    }
    if (significant[index] !== '=' || depths[index] !== 0) continue
    const previous = significant[index - 1] ?? ''
    const next = significant[index + 1] ?? ''
    if (previous === '=' || next === '=' || new Set(['!', '<', '>']).has(previous)) {
      continue
    }
    if (new Set(['+', '-', '*', '/', '%', '@', '&', '|', '^']).has(previous)) {
      if (significant[index - 2] === identifier) return true
      continue
    }
    return pythonTargetContains(significant.slice(0, index), identifier)
  }
  return false
}

function pythonLineBindsIdentifier(
  rawTokens: readonly string[],
  identifier: string,
  includeExpressionBindings = true,
): boolean {
  const tokens = rawTokens.filter((token) => token !== '\n')
  if (tokens.length === 0) return false
  const importIndex = tokens.indexOf('import')
  if (importIndex >= 0) {
    const imported = tokens.slice(importIndex + 1)
    if (tokens[0] === 'from' && imported.includes('*')) return true
    return imported.some((token, index) =>
      token === identifier
      && imported[index - 1] !== '.'
      && imported[index + 1] !== 'as')
  }
  const header = pythonFunctionHeader(tokens)
  if (header?.name === identifier) return true
  if (tokens[0] === 'class' && tokens[1] === identifier) return true
  const depths = pythonDelimiterDepths(tokens)
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'for') continue
    if (depths[index] > 0 && !includeExpressionBindings) continue
    const inIndex = tokens.indexOf('in', index + 1)
    if (
      inIndex > index
      && pythonTargetContains(tokens.slice(index + 1, inIndex), identifier)
    ) {
      return true
    }
  }
  return pythonAssignmentBindsIdentifier(tokens, identifier)
    || tokens.some((token, index) =>
      token === 'as' && tokens[index + 1] === identifier)
    || (
      includeExpressionBindings
      && pythonExpressionBindsIdentifier(tokens, identifier)
    )
}

function pythonContainerHeader(
  rawTokens: readonly string[],
): { kind: 'class' | 'function'; name: string } | null {
  const functionHeader = pythonFunctionHeader(rawTokens)
  if (functionHeader !== null) {
    return { kind: 'function', name: functionHeader.name }
  }
  const tokens = rawTokens.filter((token) => token !== '\n')
  if (tokens[0] !== 'class' || !CODE_IDENTIFIER.test(tokens[1] ?? '')) {
    return null
  }
  return { kind: 'class', name: tokens[1] }
}

function pythonStatementSuiteEnd(
  statements: readonly PythonLogicalStatement[],
  headerIndex: number,
): number {
  const header = statements[headerIndex]
  for (let index = headerIndex + 1; index < statements.length; index += 1) {
    if (statements[index].indentation <= header.indentation) return index
  }
  return statements.length
}

function pythonDirectScopeStatements(
  statements: readonly PythonLogicalStatement[],
  headerIndex: number | null,
): number[] {
  const output: number[] = []
  const start = headerIndex === null ? 0 : headerIndex + 1
  const end = headerIndex === null
    ? statements.length
    : pythonStatementSuiteEnd(statements, headerIndex)
  const scopeIndentation = headerIndex === null
    ? -1
    : statements[headerIndex].indentation
  for (let index = start; index < end; index += 1) {
    if (statements[index].indentation <= scopeIndentation) continue
    output.push(index)
    if (pythonContainerHeader(statements[index].tokens) !== null) {
      index = pythonStatementSuiteEnd(statements, index) - 1
    }
  }
  return output
}

function pythonClassOwnsDeclaration(
  sourceText: string,
  owners: readonly string[],
  identifier: string,
  normalizedKind: string,
): boolean {
  const statements = pythonLogicalStatements(sourceText)
  for (
    let declarationIndex = 0;
    declarationIndex < statements.length;
    declarationIndex += 1
  ) {
    const declaration = statements[declarationIndex]
    const functionHeader = pythonFunctionHeader(declaration.tokens)
    const declaresIdentifier = normalizedKind === 'method'
      ? functionHeader?.name === identifier
      : functionHeader === null
        && pythonLineBindsIdentifier(declaration.tokens, identifier, false)
    if (!declaresIdentifier) continue
    const containers: string[] = []
    let containedIndex = declarationIndex
    while (true) {
      let nearestIndex: number | null = null
      for (let headerIndex = 0; headerIndex < containedIndex; headerIndex += 1) {
        const header = pythonContainerHeader(statements[headerIndex].tokens)
        if (header === null) continue
        if (
          statements[headerIndex].indentation
            >= statements[containedIndex].indentation
          || containedIndex >= pythonStatementSuiteEnd(statements, headerIndex)
        ) {
          continue
        }
        if (
          nearestIndex === null
          || statements[headerIndex].indentation
            > statements[nearestIndex].indentation
          || (
            statements[headerIndex].indentation
              === statements[nearestIndex].indentation
            && headerIndex > nearestIndex
          )
        ) {
          nearestIndex = headerIndex
        }
      }
      if (nearestIndex === null) break
      const nearest = pythonContainerHeader(statements[nearestIndex].tokens)!
      if (nearest.kind !== 'class') return false
      containers.push(nearest.name)
      containedIndex = nearestIndex
    }
    if (
      containers.length === owners.length
      && containers.every(
        (name, index) => name === owners[owners.length - index - 1],
      )
    ) {
      return true
    }
  }
  return false
}

function pythonFunctionShadowsReference(
  sourceText: string,
  referenceToken: number,
  referenceLine: number,
  identifier: string,
  exportedIdentifier: string,
  sourcePath: string,
  targetPath: string,
  exactPathExists: (repositoryPath: string) => boolean,
  targetRange: { endLine: number; startLine: number } | null,
): boolean {
  const statements = pythonLogicalStatements(sourceText)
  const referenceStatement = statements.findIndex((statement) =>
    referenceToken >= statement.startToken
    && referenceToken < statement.endToken)
  if (referenceStatement < 0) return true
  if (
    referenceLine < statements[referenceStatement].startLine
    || referenceLine > statements[referenceStatement].endLine
  ) {
    return true
  }
  if (pythonExpressionBindsIdentifier(
    statements[referenceStatement].tokens,
    identifier,
    referenceToken - statements[referenceStatement].startToken,
  )) {
    return true
  }

  const enclosingFunctions = statements
    .map((statement, index) => ({
      header: pythonFunctionHeader(statement.tokens),
      index,
    }))
    .filter((candidate) =>
      candidate.header !== null
      && candidate.index < referenceStatement
      && referenceStatement
        < pythonStatementSuiteEnd(statements, candidate.index))
    .sort((left, right) =>
      statements[right.index].indentation
        - statements[left.index].indentation
      || right.index - left.index)

  const directive = (
    indices: readonly number[],
    keyword: 'global' | 'nonlocal',
  ): boolean => indices.some((index) => {
    const tokens = statements[index].tokens
      .filter((token) => token !== '\n')
    return tokens[0] === keyword && tokens.includes(identifier)
  })
  type ExecutionBoundary = { statementIndex: number; token: number }
  const headerBoundary = (statementIndex: number): ExecutionBoundary => ({
    statementIndex,
    token: statements[statementIndex].startToken,
  })
  const invocationBoundary = (
    headerIndex: number | null,
    invokedHeaderIndex: number,
  ): ExecutionBoundary | null => {
    const invoked = pythonFunctionHeader(
      statements[invokedHeaderIndex].tokens,
    )
    if (invoked === null) return null
    const indices = pythonDirectScopeStatements(statements, headerIndex)
    const aliases = new Set<string>()
    for (const index of indices) {
      if (index === invokedHeaderIndex) continue
      const statementTokens = statements[index].tokens
      for (
        let tokenIndex = 0;
        tokenIndex < statementTokens.length;
        tokenIndex += 1
      ) {
        if (
          statementTokens[tokenIndex] !== invoked.name
          && !aliases.has(statementTokens[tokenIndex])
        ) {
          continue
        }
        const before = significantTokenBefore(statementTokens, tokenIndex)
        const after = significantTokenAfter(statementTokens, tokenIndex)
        if (
          after?.token === '('
          && !new Set(['class', 'def']).has(before?.token ?? '')
        ) {
          return {
            statementIndex: index,
            token: statements[index].startToken + tokenIndex,
          }
        }
        if (before?.token === 'return') {
          return {
            statementIndex: index,
            token: statements[index].startToken + tokenIndex,
          }
        }
      }
      const significant = statementTokens
        .filter((token) => token !== '\n')
      for (const alias of aliases) {
        if (pythonAssignmentBindsIdentifier(statementTokens, alias)) {
          aliases.delete(alias)
        }
      }
      const equalsIndex = significant.indexOf('=')
      const alias = equalsIndex === 1 ? significant[0] : ''
      if (!CODE_IDENTIFIER.test(alias)) continue
      if (
        significant[equalsIndex + 1] === invoked.name
        && significant[equalsIndex + 2] !== '('
      ) {
        aliases.add(alias)
      }
    }
    return null
  }
  const resolveScope = (
    indices: readonly number[],
    headerIndex: number | null,
    boundary: ExecutionBoundary,
    laterBindingShadows: boolean,
  ): 'none' | 'shadow' | 'target' => {
    if (headerIndex !== null) {
      const header = pythonFunctionHeader(statements[headerIndex].tokens)
      if (
        header !== null
        && pythonParametersContain(header.parameters, identifier)
      ) {
        return 'shadow'
      }
    }
    let resolution: 'none' | 'shadow' | 'target' = 'none'
    let bindingFound = false
    for (const index of indices) {
      const statement = statements[index]
      const tokens = statement.tokens.filter((token) => token !== '\n')
      if (!pythonLineBindsIdentifier(tokens, identifier, false)) continue
      bindingFound = true
      const beforeBoundary = index < boundary.statementIndex
        || (
          index === boundary.statementIndex
          && statement.endToken <= boundary.token
        )
      if (!beforeBoundary) continue
      if (tokens.includes('import')) {
        if (
          !staticImportContains(
            statement.tokens,
            exportedIdentifier,
            'python',
            sourcePath,
            targetPath,
            exactPathExists,
            false,
            false,
            identifier,
          )
        ) {
          resolution = 'shadow'
        } else {
          resolution = 'target'
        }
        continue
      }
      if (
        targetRange !== null
        && statement.startLine + 1 >= targetRange.startLine
        && statement.endLine + 1 <= targetRange.endLine
      ) {
        resolution = 'target'
        continue
      }
      resolution = 'shadow'
    }
    return resolution === 'none' && bindingFound && laterBindingShadows
      ? 'shadow'
      : resolution
  }

  let seekNonlocal = false
  let childHeaderIndex: number | null = null
  let scopeBoundary: ExecutionBoundary = {
    statementIndex: referenceStatement,
    token: referenceToken,
  }
  for (const candidate of enclosingFunctions) {
    if (childHeaderIndex !== null) {
      scopeBoundary = invocationBoundary(
        candidate.index,
        childHeaderIndex,
      ) ?? headerBoundary(childHeaderIndex)
    }
    const indices = pythonDirectScopeStatements(statements, candidate.index)
    if (!seekNonlocal && directive(indices, 'global')) {
      const globalResolution = resolveScope(
        indices,
        candidate.index,
        scopeBoundary,
        false,
      )
      if (globalResolution === 'shadow') return true
      if (globalResolution === 'target') return false
      const outermostHeader = enclosingFunctions.at(-1)?.index
        ?? candidate.index
      const moduleBoundary = invocationBoundary(null, outermostHeader)
        ?? headerBoundary(outermostHeader)
      const moduleResolution = resolveScope(
        pythonDirectScopeStatements(statements, null),
        null,
        moduleBoundary,
        false,
      )
      return moduleResolution !== 'target'
    }
    const declaredNonlocal = directive(indices, 'nonlocal')
    if (declaredNonlocal) seekNonlocal = true
    const resolution = resolveScope(
      indices,
      candidate.index,
      scopeBoundary,
      !declaredNonlocal,
    )
    if (resolution === 'target') return false
    if (resolution === 'shadow') return true
    childHeaderIndex = candidate.index
    if (seekNonlocal || declaredNonlocal) continue
  }
  const outermostHeader = enclosingFunctions.at(-1)?.index ?? null
  const moduleBoundary = outermostHeader === null
    ? scopeBoundary
    : invocationBoundary(null, outermostHeader)
      ?? headerBoundary(outermostHeader)
  const moduleResolution = resolveScope(
    pythonDirectScopeStatements(statements, null),
    null,
    moduleBoundary,
    false,
  )
  return moduleResolution !== 'target'
}

function parameterBindingShadowsReference(
  tokens: readonly string[],
  identifierIndex: number,
  referenceIndex: number,
  sourceLanguage: string,
  sourcePath: string,
): boolean {
  if (pythonLanguage(sourceLanguage, sourcePath)) return false
  let openIndex: number | null = null
  let depth = 0
  for (let index = identifierIndex - 1; index >= 0; index -= 1) {
    if (tokens[index] === ')') {
      depth += 1
      continue
    }
    if (tokens[index] !== '(') continue
    if (depth > 0) {
      depth -= 1
      continue
    }
    const closeIndex = matchingParenthesis(tokens, index)
    if (closeIndex !== null && closeIndex > identifierIndex) {
      openIndex = index
    }
    break
  }
  if (openIndex === null) return false
  const beforeOpen = significantTokenBefore(tokens, openIndex)
  if (
    beforeOpen !== null
    && new Set(['for', 'if', 'switch', 'while', 'with'])
      .has(beforeOpen.token)
  ) {
    return false
  }
  const closeIndex = matchingParenthesis(tokens, openIndex)
  if (closeIndex === null) return false
  const callStack = openingBraceStackAt(tokens, referenceIndex)
  for (let index = closeIndex + 1; index < referenceIndex; index += 1) {
    if (tokens[index] === ';') return false
    if (tokens[index] === '{') return callStack.includes(index)
    if (
      tokens[index] === '='
      && significantTokenAfter(tokens, index)?.token === '>'
    ) {
      const arrow = significantTokenAfter(tokens, index)
      const body = arrow === null
        ? null
        : significantTokenAfter(tokens, arrow.index)
      return body?.token === '{'
        ? callStack.includes(body.index)
        : true
    }
  }
  return false
}

function referenceBindingShadowed(
  tokens: readonly string[],
  referenceIndex: number,
  localIdentifier: string,
  exportedIdentifier: string,
  sourceLanguage: string,
  sourcePath: string,
  targetPath: string,
  exactPathExists: (repositoryPath: string) => boolean,
  targetHasDefaultExport: boolean,
  sourceText: string,
  referenceLine: number,
  targetRange: { endLine: number; startLine: number } | null,
  targetQualifiedParts?: readonly string[],
): boolean {
  if (pythonLanguage(sourceLanguage, sourcePath)) {
    return pythonFunctionShadowsReference(
      sourceText,
      referenceIndex,
      referenceLine,
      localIdentifier,
      exportedIdentifier,
      sourcePath,
      targetPath,
      exactPathExists,
      targetRange,
    )
  }
  const referenceStack = openingBraceStackAt(tokens, referenceIndex)
  const declarations = new Set([
    'class', 'const', 'def', 'enum', 'fn', 'func', 'function', 'interface',
    'let', 'namespace', 'record', 'struct', 'trait', 'type', 'var',
  ])
  let sourceLine = 1
  let targetBindingExempted = false
  let targetImportInScope = false
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === '\n') {
      sourceLine += 1
      continue
    }
    if (index === referenceIndex) continue
    if (tokens[index] !== localIdentifier) continue
    const importedBinding = importedBindingAt(tokens, index)
    const before = significantTokenBefore(tokens, index)
    if (before?.token === '.') continue
    if (parameterBindingShadowsReference(
      tokens,
      index,
      referenceIndex,
      sourceLanguage,
      sourcePath,
    )) {
      return true
    }
    const declarationStack = openingBraceStackAt(
      tokens,
      importedBinding
        ? statementBoundsAt(tokens, index).start
        : index,
    )
    if (!stackIsPrefix(declarationStack, referenceStack)) continue
    if (importedBinding) {
      const bounds = statementBoundsAt(tokens, index)
      const bindingStatement = tokens.slice(bounds.start, bounds.end)
      if (staticImportContains(
        bindingStatement,
        exportedIdentifier,
        sourceLanguage,
        sourcePath,
        targetPath,
        exactPathExists,
        targetHasDefaultExport,
        false,
        localIdentifier,
        targetQualifiedParts,
      )) {
        if (
          bindingStatement.includes('require')
          && index > referenceIndex
        ) {
          return true
        }
        targetImportInScope = true
        continue
      }
      return true
    }
    const exemptTargetBinding = (): boolean => {
      if (
        targetBindingExempted
        || targetRange === null
        || sourceLine < targetRange.startLine
        || sourceLine > targetRange.endLine
      ) {
        return false
      }
      targetBindingExempted = true
      return true
    }
    if (declarations.has(before?.token ?? '')) {
      if (exemptTargetBinding()) continue
      return true
    }
    const after = significantTokenAfter(tokens, index)
    if (after?.token === '=') {
      if (exemptTargetBinding()) continue
      return true
    }
    const bounds = statementBoundsAt(tokens, index)
    if (
      tokens.slice(bounds.start, index)
        .some((token) => new Set(['const', 'let', 'var']).has(token))
    ) {
      if (exemptTargetBinding()) continue
      return true
    }
  }
  return targetRange === null
    && ecmaScriptLanguage(sourceLanguage, sourcePath)
    && !targetImportInScope
}

type RelationshipReference = {
  exported: string
  local: string
  localIndex: number
  terminal: string
}

function relationshipReferenceAt(
  tokens: readonly string[],
  terminalIndex: number,
  targetParts: readonly string[],
  bindingPartIndex = 0,
): RelationshipReference | null {
  const terminal = tokens[terminalIndex]
  if (
    !CODE_IDENTIFIER.test(terminal)
    || targetParts.length === 0
    || bindingPartIndex < 0
    || bindingPartIndex >= targetParts.length
  ) {
    return null
  }
  if (targetParts.length === 1) {
    return {
      exported: targetParts[0],
      local: terminal,
      localIndex: terminalIndex,
      terminal,
    }
  }
  if (terminal !== targetParts.at(-1)) return null
  const components = [{ index: terminalIndex, name: terminal }]
  let cursor = terminalIndex
  while (true) {
    const dot = significantTokenBefore(tokens, cursor)
    if (dot?.token !== '.') break
    const component = significantTokenBefore(
      tokens,
      tokens[dot.index - 1] === '?' ? dot.index - 1 : dot.index,
    )
    if (component === null || !CODE_IDENTIFIER.test(component.token)) break
    components.unshift({ index: component.index, name: component.token })
    cursor = component.index
  }
  if (components.length !== targetParts.length) return null
  for (let index = 1; index < components.length; index += 1) {
    if (components[index].name !== targetParts[index]) return null
  }
  return {
    exported: targetParts[bindingPartIndex],
    local: components[bindingPartIndex].name,
    localIndex: components[bindingPartIndex].index,
    terminal,
  }
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
  targetStartLine: number,
  targetEndLine: number,
  targetHasDefaultExport: boolean,
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
  )
  const contextualTokens = [...prefixTokens, ...tokens]
  const relationshipTokenOffset = prefixTokens.length
  const qualifiedParts = targetQualifiedName.split(/[.:/#]/u)
  const javaTargetClassPart = javaLanguage(sourceLanguage, sourcePath)
    ? javaTargetClassPartIndex(qualifiedParts, targetPath)
    : 0
  const referenceShapes: Array<{
    bindingPartIndex: number
    parts: string[]
  }> = [{
    bindingPartIndex: javaTargetClassPart,
    parts: qualifiedParts,
  }]
  if (javaTargetClassPart > 0) {
    for (
      let start = javaTargetClassPart;
      start < qualifiedParts.length;
      start += 1
    ) {
      referenceShapes.push({
        bindingPartIndex: 0,
        parts: qualifiedParts.slice(start),
      })
    }
  } else if (javaLanguage(sourceLanguage, sourcePath)) {
    for (let start = 1; start < qualifiedParts.length; start += 1) {
      referenceShapes.push({
        bindingPartIndex: 0,
        parts: qualifiedParts.slice(start),
      })
    }
  }
  const exactJavaReferenceAt = (
    terminalIndex: number,
    parts: readonly string[],
  ): boolean => {
    let cursor = terminalIndex
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (contextualTokens[cursor] !== parts[index]) return false
      if (index === 0) {
        return parts.length === qualifiedParts.length
          || significantTokenBefore(contextualTokens, cursor)?.token !== '.'
      }
      const dot = significantTokenBefore(contextualTokens, cursor)
      if (dot?.token !== '.') return false
      const component = significantTokenBefore(contextualTokens, dot.index)
      if (component === null) return false
      cursor = component.index
    }
    return false
  }
  let sourceTokens: string[] | null = null
  const referencesAt = (
    contextualIndex: number,
  ): RelationshipReference[] => referenceShapes.flatMap((shape) => {
    if (
      javaLanguage(sourceLanguage, sourcePath)
      && !exactJavaReferenceAt(contextualIndex, shape.parts)
    ) {
      return []
    }
    const reference = relationshipReferenceAt(
      contextualTokens,
      contextualIndex,
      shape.parts,
      shape.bindingPartIndex,
    )
    return reference === null ? [] : [reference]
  })
  const pathBoundReference = (
    contextualIndex?: number,
    rejectShadow = false,
    referenceLine = 0,
  ): boolean => {
    if (sourceTokens === null) {
      sourceTokens = relationshipTokens(
        sourceFileEvidence,
        sourceLanguage,
        sourcePath,
      )
    }
    const references = contextualIndex === undefined
      ? tokens.flatMap((token, index) =>
          CODE_IDENTIFIER.test(token)
            ? referencesAt(relationshipTokenOffset + index)
            : [])
      : referencesAt(contextualIndex)
    return references.some((reference) => {
      const targetBound = sourcePath === targetPath
        ? reference.local === reference.exported
        : staticImportContains(
            sourceTokens!,
            reference.exported,
            sourceLanguage,
            sourcePath,
            targetPath,
            exactPathExists,
            targetHasDefaultExport,
            true,
            reference.local,
            qualifiedParts,
          )
      const shadowed = rejectShadow && referenceBindingShadowed(
        sourceTokens!,
        reference.localIndex,
        reference.local,
        reference.exported,
        sourceLanguage,
        sourcePath,
        targetPath,
        exactPathExists,
        targetHasDefaultExport,
        sourceFileEvidence,
        referenceLine,
        sourcePath === targetPath
          ? { endLine: targetEndLine, startLine: targetStartLine }
          : null,
        qualifiedParts,
      )
      return targetBound && !shadowed
    })
  }
  switch (relationship.kind) {
    case 'calls': {
      const proved = tokens.some((token, index) => {
        if (!CODE_IDENTIFIER.test(token)) return false
        const contextualIndex = relationshipTokenOffset + index
        if (referencesAt(contextualIndex).length === 0) return false
        const referenceLine =
          (sourcePrefixEvidence.match(/\n/gu)?.length ?? 0)
          + tokens.slice(0, index)
            .filter((candidate) => candidate === '\n').length
        const open = relationshipCallOpenAfter(
          contextualTokens,
          contextualIndex,
          sourceLanguage,
          sourcePath,
        )
        if (open === null) return false
        const close = matchingParenthesis(contextualTokens, open)
        if (close === null) return false
        return !declarationLikeCall(
          contextualTokens,
          contextualIndex,
          close,
          sourceLanguage,
          sourcePath,
        ) && pathBoundReference(contextualIndex, true, referenceLine)
      })
      if (!proved) fail('evidence_mismatch')
      return
    }
    case 'extends': {
      const proved = tokens.some((token, index) =>
        CODE_IDENTIFIER.test(token)
        && hasTokenPair(tokens, 'extends', token)
        && pathBoundReference(relationshipTokenOffset + index))
      if (!proved) fail('evidence_mismatch')
      return
    }
    case 'implements': {
      const proved = tokens.some((token, index) =>
        CODE_IDENTIFIER.test(token)
        && hasTokenPair(tokens, 'implements', token)
        && pathBoundReference(relationshipTokenOffset + index))
      if (!proved) fail('evidence_mismatch')
      return
    }
    case 'imports': {
      if (
        !staticImportContains(
          tokens,
          identifier,
          sourceLanguage,
          sourcePath,
          targetPath,
          exactPathExists,
          targetHasDefaultExport,
          false,
          undefined,
          qualifiedParts,
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
        let targetExcerpt: Excerpt | null = null
        if (relationship.kind !== 'contains') {
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
          targetExcerpt = excerpt(
            targetEvidence,
            target.start_line,
            target.end_line,
          )
          const attestationKey =
            `${target.key}\u0000${symbol.path !== target.path}`
          if (!attestedTargets.has(attestationKey)) {
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
            attestedTargets.add(attestationKey)
          }
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
            target.start_line,
            target.end_line,
            targetDefaultExportContains(target, targetExcerpt!.raw),
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

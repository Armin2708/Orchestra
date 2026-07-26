import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import type Database from 'better-sqlite3'
import {
  knowledgeChunkId,
  knowledgeSourceId,
  normalizeKnowledgeLocator,
} from './knowledge-contracts.js'
import { KnowledgeStore } from './knowledge-store.js'
import { redactSensitiveText } from './structured-redaction.js'
import type {
  KnowledgeAccessScope,
  KnowledgeChunk,
  KnowledgeSource,
  KnowledgeSourceKind,
  KnowledgeSourceRange,
  KnowledgeTargetLinks,
} from './knowledge-types.js'

export const MAX_REPOSITORY_DOCUMENT_BYTES = 1_000_000
export const MAX_REPOSITORY_DOCUMENT_TOTAL_BYTES = 64_000_000
export const MAX_REPOSITORY_DOCUMENTS = 10_000
export const MAX_REPOSITORY_TRAVERSAL_DEPTH = 64
export const MAX_REPOSITORY_TRAVERSAL_ENTRIES = 100_000

export type RepositoryDocumentIngestionErrorCode =
  | 'invalid_input'
  | 'board_not_found'
  | 'repository_unavailable'
  | 'repository_root_mismatch'
  | 'workspace_root_mismatch'
  | 'repository_revision_mismatch'
  | 'filesystem_read_failed'
  | 'persistence_conflict'
  | 'persistence_failed'

const INGESTION_ERROR_MESSAGES: Record<
  RepositoryDocumentIngestionErrorCode,
  string
> = {
  invalid_input: 'repository document ingestion input is invalid',
  board_not_found: 'repository document ingestion board was not found',
  repository_unavailable: 'repository document ingestion repository is unavailable',
  repository_root_mismatch: 'repository document ingestion repository root does not match the board',
  workspace_root_mismatch: 'repository document ingestion workspace root is outside the repository scope',
  repository_revision_mismatch: 'repository document ingestion revision does not match the workspace',
  filesystem_read_failed: 'repository document ingestion could not safely read the workspace',
  persistence_conflict: 'repository document ingestion conflicts with retained knowledge',
  persistence_failed: 'repository document ingestion could not persist knowledge',
}
const INGESTION_ERROR_CODES = new Set<RepositoryDocumentIngestionErrorCode>(
  Object.keys(INGESTION_ERROR_MESSAGES) as RepositoryDocumentIngestionErrorCode[],
)
const TRUSTED_ERROR_CODES = new WeakMap<object, RepositoryDocumentIngestionErrorCode>()

/**
 * Fixed messages deliberately omit supplied paths and document content.
 */
export class RepositoryDocumentIngestionError extends Error {
  declare readonly code: RepositoryDocumentIngestionErrorCode

  constructor(code: RepositoryDocumentIngestionErrorCode) {
    const safeCode = typeof code === 'string' && INGESTION_ERROR_CODES.has(code)
      ? code
      : 'invalid_input'
    super(INGESTION_ERROR_MESSAGES[safeCode])
    Object.defineProperties(this, {
      name: {
        value: 'RepositoryDocumentIngestionError',
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

export interface RepositoryDocumentIngestionInput {
  board_id: number
  repository_key: string
  repository_root: string
  workspace_root: string
  workspace_id?: string | null
  base_commit_sha: string
  observed_at: string
  max_file_bytes?: number
  max_total_bytes?: number
  max_documents?: number
  max_traversal_depth?: number
  max_traversal_entries?: number
}

export interface RepositoryDocumentSkipCounts {
  hidden_paths: number
  unsafe_paths: number
  excluded_directories: number
  credential_paths: number
  nested_repositories: number
  symbolic_links: number
  unsupported_files: number
  oversized_files: number
  invalid_text_files: number
  empty_files: number
}

export interface RepositoryDocumentIngestionTotals {
  discovered_files: number
  candidate_files: number
  ingested_files: number
  redacted_files: number
  skipped_paths: number
}

export interface RepositoryDocumentIngestionReport {
  board_id: number
  repository_key: string
  base_commit_sha: string
  sources: KnowledgeSource[]
  chunks: KnowledgeChunk[]
  totals: RepositoryDocumentIngestionTotals
  skipped: RepositoryDocumentSkipCounts
}

interface ValidatedIngestionInput {
  board_id: number
  repository_key: string
  repository_root: string
  workspace_root: string
  workspace_id: string | null
  base_commit_sha: string
  observed_at: string
  max_file_bytes: number
  max_total_bytes: number
  max_documents: number
  max_traversal_depth: number
  max_traversal_entries: number
}

interface VerifiedRoots {
  repository_root: string
  workspace_root: string
  common_git_directory: string
}

interface FileIdentity {
  path: string
  device: bigint
  inode: bigint
  links: bigint
  mode: bigint
  size: bigint
  modified_ns: bigint
  changed_ns: bigint
}

interface OpenDirectoryIdentity extends FileIdentity {
  descriptor: number
}

interface ScannedDirectory {
  file_identity: FileIdentity
  requires_nested_repository_absence: boolean
}

interface ScannedDocument {
  relative_path: string
  source_kind: Extract<
    KnowledgeSourceKind,
    'agents' | 'readme' | 'documentation' | 'convention' | 'architecture'
  >
  content: string
  content_sha256: string
  redacted: boolean
  source_range: KnowledgeSourceRange
  file_identity: FileIdentity
  original_bytes: Buffer
  freshness_policy: 'commit_exact' | 'path_hash'
  source_revision: string
  worktree_state_hash: string | null
}

interface PlannedDocument {
  source: KnowledgeSource
  chunk: KnowledgeChunk
}

interface GitlinkInventory {
  paths: ReadonlySet<string>
}

const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const REPOSITORY_KEY = /^[a-z0-9](?:[a-z0-9._/-]{0,254}[a-z0-9])?$/u
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const GIT_TIMEOUT_MILLISECONDS = 15_000
const MAX_GIT_TREE_LISTING_BYTES = 64_000_000
const MAX_GIT_INDEX_LISTING_BYTES = 64_000_000
const DEFAULT_TOTAL_BYTES = 32_000_000
const DEFAULT_DOCUMENTS = 2_000
const DEFAULT_TRAVERSAL_DEPTH = 32
const DEFAULT_TRAVERSAL_ENTRIES = 25_000
const SUPPORTED_TEXT_EXTENSIONS = new Set([
  '.adoc',
  '.asciidoc',
  '.markdown',
  '.md',
  '.mdx',
  '.rst',
  '.text',
  '.txt',
])
const EXCLUDED_DIRECTORY_NAMES = new Set([
  'artifacts',
  '__pypackages__',
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
const CREDENTIAL_PATH_NAMES = new Set([
  'credential',
  'credentials',
  'private-keys',
  'secret',
  'secrets',
  'service-accounts',
])
const CREDENTIAL_FILE_NAMES = new Set([
  'auth.json',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'secrets.json',
  'service-account.json',
])
const CREDENTIAL_FILE_STEMS = new Set([
  'api-key',
  'api_key',
  'auth-token',
  'auth_token',
  'credential',
  'credentials',
  'password',
  'private-key',
  'private-keys',
  'private_key',
  'private_keys',
  'secret',
  'secrets',
  'service-account',
  'service-accounts',
  'service_account',
  'service_accounts',
  'token',
])
const CREDENTIAL_STEM_PREFIX =
  /^(?:credentials?|private[-_]?keys?|secrets?|service[-_]?accounts?)(?:[-_].*)?$/iu
const CREDENTIAL_WORD =
  /(?:^|[^a-z0-9])(?:api[^a-z0-9]*keys?|(?:access|auth|refresh)[^a-z0-9]*tokens?|credentials?|passwords?|private[^a-z0-9]*keys?|secrets?|service[^a-z0-9]*accounts?)(?:$|[^a-z0-9])/iu
const SECRET_LOOKING_COMPONENT =
  /(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{12,})/u
const ARCHITECTURE_DIRECTORY_NAMES = new Set([
  'adr',
  'adrs',
  'architecture',
  'architectures',
  'decision-records',
])
const CONVENTION_DIRECTORY_NAMES = new Set([
  'convention',
  'conventions',
  'standards',
])
const DOCUMENTATION_DIRECTORY_NAMES = new Set([
  'doc',
  'docs',
  'documentation',
])
const ARCHITECTURE_FILE_STEMS = new Set([
  'architecture',
  'architecture-note',
  'architecture-notes',
  'architectural-decisions',
  'design',
  'system-design',
])
const CONVENTION_FILE_STEMS = new Set([
  'code-of-conduct',
  'code_of_conduct',
  'coding-standards',
  'contributing',
  'conventions',
  'development',
  'style-guide',
  'styleguide',
])

function ingestionFailure(code: RepositoryDocumentIngestionErrorCode): never {
  const error = new RepositoryDocumentIngestionError(code)
  TRUSTED_ERROR_CODES.set(error, code)
  throw error
}

function trustedErrorCode(
  value: unknown,
): RepositoryDocumentIngestionErrorCode | null {
  if (
    value === null
    || (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return null
  }
  return TRUSTED_ERROR_CODES.get(value) ?? null
}

function remapFailure(
  error: unknown,
  fallback: RepositoryDocumentIngestionErrorCode,
): never {
  ingestionFailure(trustedErrorCode(error) ?? fallback)
}

function safeInputRecord(value: unknown): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      ingestionFailure('invalid_input')
    }
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      ingestionFailure('invalid_input')
    }
    const allowed = new Set([
      'board_id',
      'repository_key',
      'repository_root',
      'workspace_root',
      'workspace_id',
      'base_commit_sha',
      'observed_at',
      'max_file_bytes',
      'max_total_bytes',
      'max_documents',
      'max_traversal_depth',
      'max_traversal_entries',
    ])
    const keys = Reflect.ownKeys(value)
    if (
      keys.some((key) => typeof key !== 'string' || !allowed.has(key))
      || ![
        'board_id',
        'repository_key',
        'repository_root',
        'workspace_root',
        'base_commit_sha',
        'observed_at',
      ].every((key) => keys.includes(key))
    ) {
      ingestionFailure('invalid_input')
    }
    const record = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
      ) {
        ingestionFailure('invalid_input')
      }
      record[key] = descriptor.value
    }
    return record
  } catch {
    ingestionFailure('invalid_input')
  }
}

function safeText(
  value: unknown,
  maximumCharacters: number,
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumCharacters
    || CONTROL_CHARACTERS.test(value)
  ) {
    ingestionFailure('invalid_input')
  }
  return value
}

function safeAbsolutePath(value: unknown): string {
  const supplied = safeText(value, 16_384)
  if (!path.isAbsolute(supplied)) ingestionFailure('invalid_input')
  return path.resolve(supplied)
}

function canonicalTimestamp(value: unknown): string {
  const supplied = safeText(value, 64)
  const parsed = new Date(supplied)
  if (
    !Number.isFinite(parsed.valueOf())
    || parsed.toISOString() !== supplied
  ) {
    ingestionFailure('invalid_input')
  }
  return supplied
}

function boundedPositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const supplied = value === undefined ? fallback : value
  if (
    typeof supplied !== 'number'
    || !Number.isSafeInteger(supplied)
    || supplied <= 0
    || supplied > maximum
  ) {
    ingestionFailure('invalid_input')
  }
  return supplied
}

function credentialLikeComponent(value: string): boolean {
  const lower = value.toLowerCase()
  const extension = path.posix.extname(lower)
  const stem = extension.length === 0
    ? lower
    : lower.slice(0, -extension.length)
  return CREDENTIAL_PATH_NAMES.has(lower)
    || CREDENTIAL_PATH_NAMES.has(stem)
    || CREDENTIAL_FILE_NAMES.has(lower)
    || CREDENTIAL_FILE_STEMS.has(stem)
    || CREDENTIAL_STEM_PREFIX.test(stem)
    || CREDENTIAL_WORD.test(stem)
    || lower === '.env'
    || lower.startsWith('.env.')
    || /\.(?:jks|key|p12|pfx|pem)$/iu.test(lower)
    || SECRET_LOOKING_COMPONENT.test(value)
    || redactSensitiveText(value).changed
}

function canonicalRepositoryKey(value: unknown): string {
  const supplied = safeText(value, 256)
  if (
    supplied !== supplied.trim()
    || supplied !== supplied.toLowerCase()
    || !REPOSITORY_KEY.test(supplied)
    || supplied.includes('//')
  ) {
    ingestionFailure('invalid_input')
  }
  const segments = supplied.split('/')
  if (
    segments.some((segment) =>
      segment === '.'
      || segment === '..'
      || credentialLikeComponent(segment))
  ) {
    ingestionFailure('invalid_input')
  }
  return supplied
}

function validateIngestionInput(value: unknown): ValidatedIngestionInput {
  const record = safeInputRecord(value)
  if (
    !Number.isSafeInteger(record.board_id)
    || Number(record.board_id) <= 0
  ) {
    ingestionFailure('invalid_input')
  }
  const baseCommitSha = safeText(record.base_commit_sha, 64)
  if (!COMMIT_SHA.test(baseCommitSha)) ingestionFailure('invalid_input')
  const workspaceId = record.workspace_id === undefined || record.workspace_id === null
    ? null
    : safeText(record.workspace_id, 256)
  const maxFileBytes = boundedPositiveInteger(
    record.max_file_bytes,
    MAX_REPOSITORY_DOCUMENT_BYTES,
    MAX_REPOSITORY_DOCUMENT_BYTES,
  )
  const maxTotalBytes = boundedPositiveInteger(
    record.max_total_bytes,
    DEFAULT_TOTAL_BYTES,
    MAX_REPOSITORY_DOCUMENT_TOTAL_BYTES,
  )
  if (maxFileBytes > maxTotalBytes) ingestionFailure('invalid_input')
  return {
    board_id: Number(record.board_id),
    repository_key: canonicalRepositoryKey(record.repository_key),
    repository_root: safeAbsolutePath(record.repository_root),
    workspace_root: safeAbsolutePath(record.workspace_root),
    workspace_id: workspaceId,
    base_commit_sha: baseCommitSha,
    observed_at: canonicalTimestamp(record.observed_at),
    max_file_bytes: maxFileBytes,
    max_total_bytes: maxTotalBytes,
    max_documents: boundedPositiveInteger(
      record.max_documents,
      DEFAULT_DOCUMENTS,
      MAX_REPOSITORY_DOCUMENTS,
    ),
    max_traversal_depth: boundedPositiveInteger(
      record.max_traversal_depth,
      DEFAULT_TRAVERSAL_DEPTH,
      MAX_REPOSITORY_TRAVERSAL_DEPTH,
    ),
    max_traversal_entries: boundedPositiveInteger(
      record.max_traversal_entries,
      DEFAULT_TRAVERSAL_ENTRIES,
      MAX_REPOSITORY_TRAVERSAL_ENTRIES,
    ),
  }
}

function realpathDirectory(
  value: string,
  code: 'repository_unavailable' | 'workspace_root_mismatch',
): string {
  try {
    const resolved = fs.realpathSync(value)
    if (!fs.statSync(resolved).isDirectory()) ingestionFailure(code)
    return resolved
  } catch (error) {
    remapFailure(error, code)
  }
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
  if (executable === undefined) ingestionFailure('repository_unavailable')
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

function gitBytes(
  root: string,
  arguments_: readonly string[],
  options: {
    input?: Buffer
    max_buffer?: number
  } = {},
): Buffer {
  const executable = trustedGitExecutable()
  const result = spawnSync(
    executable,
    ['-c', 'core.fsmonitor=false', '-C', root, ...arguments_],
    {
      encoding: null,
      env: isolatedGitEnvironment(executable),
      input: options.input,
      killSignal: 'SIGKILL',
      maxBuffer: options.max_buffer ?? 1_000_000,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MILLISECONDS,
      windowsHide: true,
    },
  )
  if (
    result.error !== undefined
    || result.signal !== null
    || result.status !== 0
    || !Buffer.isBuffer(result.stdout)
  ) {
    ingestionFailure('repository_unavailable')
  }
  return result.stdout
}

function gitOutput(root: string, arguments_: readonly string[]): string {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true })
      .decode(gitBytes(root, arguments_))
    const result = decoded.endsWith('\r\n')
      ? decoded.slice(0, -2)
      : decoded.endsWith('\n')
        ? decoded.slice(0, -1)
        : decoded
    if (
      result.length === 0
      || CONTROL_CHARACTERS.test(result)
    ) {
      ingestionFailure('repository_unavailable')
    }
    return result
  } catch (error) {
    remapFailure(error, 'repository_unavailable')
  }
}

function gitTopLevel(root: string): string {
  const topLevel = realpathDirectory(
    gitOutput(root, ['rev-parse', '--show-toplevel']),
    'repository_unavailable',
  )
  if (topLevel !== root) ingestionFailure('repository_root_mismatch')
  return topLevel
}

function gitCommonDirectory(root: string): string {
  const supplied = gitOutput(root, ['rev-parse', '--git-common-dir'])
  const resolved = path.isAbsolute(supplied)
    ? supplied
    : path.resolve(root, supplied)
  try {
    return fs.realpathSync(resolved)
  } catch {
    ingestionFailure('repository_unavailable')
  }
}

function assertRepositoryStable(
  roots: VerifiedRoots,
  baseCommitSha: string,
): void {
  try {
    gitTopLevel(roots.repository_root)
    gitTopLevel(roots.workspace_root)
  } catch (error) {
    if (trustedErrorCode(error) === 'repository_root_mismatch') {
      ingestionFailure('workspace_root_mismatch')
    }
    remapFailure(error, 'repository_unavailable')
  }
  if (
    gitCommonDirectory(roots.repository_root) !== roots.common_git_directory
    || gitCommonDirectory(roots.workspace_root) !== roots.common_git_directory
  ) {
    ingestionFailure('workspace_root_mismatch')
  }
  if (gitOutput(roots.workspace_root, ['rev-parse', 'HEAD']) !== baseCommitSha) {
    ingestionFailure('repository_revision_mismatch')
  }
}

function verifyRoots(
  db: Database.Database,
  input: ValidatedIngestionInput,
): VerifiedRoots {
  const board = db.prepare('SELECT project_path FROM boards WHERE id=?')
    .get(input.board_id) as { project_path?: unknown } | undefined
  if (!board || typeof board.project_path !== 'string') {
    ingestionFailure('board_not_found')
  }

  const boardRoot = realpathDirectory(
    board.project_path,
    'repository_unavailable',
  )
  const repositoryRoot = realpathDirectory(
    input.repository_root,
    'repository_unavailable',
  )
  if (boardRoot !== repositoryRoot) ingestionFailure('repository_root_mismatch')

  const workspaceRoot = realpathDirectory(
    input.workspace_root,
    'workspace_root_mismatch',
  )
  gitTopLevel(repositoryRoot)
  try {
    gitTopLevel(workspaceRoot)
  } catch (error) {
    if (trustedErrorCode(error) === 'repository_root_mismatch') {
      ingestionFailure('workspace_root_mismatch')
    }
    remapFailure(error, 'repository_unavailable')
  }
  const commonGitDirectory = gitCommonDirectory(repositoryRoot)
  if (commonGitDirectory !== gitCommonDirectory(workspaceRoot)) {
    ingestionFailure('workspace_root_mismatch')
  }
  if (workspaceRoot !== repositoryRoot && input.workspace_id === null) {
    ingestionFailure('workspace_root_mismatch')
  }

  if (input.workspace_id !== null) {
    const workspace = db.prepare(`SELECT board_id, root_path, worktree_path, status
      FROM workspaces WHERE id=?`).get(input.workspace_id) as {
      board_id?: unknown
      root_path?: unknown
      worktree_path?: unknown
      status?: unknown
    } | undefined
    if (
      !workspace
      || workspace.board_id !== input.board_id
      || typeof workspace.root_path !== 'string'
      || workspace.status !== 'active'
    ) {
      ingestionFailure('workspace_root_mismatch')
    }
    const executionRoot = typeof workspace.worktree_path === 'string'
      && workspace.worktree_path.length > 0
      ? workspace.worktree_path
      : workspace.root_path
    if (
      realpathDirectory(executionRoot, 'workspace_root_mismatch')
      !== workspaceRoot
    ) {
      ingestionFailure('workspace_root_mismatch')
    }
  }

  if (gitOutput(workspaceRoot, ['rev-parse', 'HEAD']) !== input.base_commit_sha) {
    ingestionFailure('repository_revision_mismatch')
  }
  return {
    repository_root: repositoryRoot,
    workspace_root: workspaceRoot,
    common_git_directory: commonGitDirectory,
  }
}

function realDirectoryMatches(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') return false
  try {
    const resolved = fs.realpathSync(value)
    return resolved === expected && fs.statSync(resolved).isDirectory()
  } catch {
    return false
  }
}

function assertDatabaseScopeStable(
  db: Database.Database,
  input: ValidatedIngestionInput,
  roots: VerifiedRoots,
): void {
  const board = db.prepare('SELECT project_path FROM boards WHERE id=?')
    .get(input.board_id) as { project_path?: unknown } | undefined
  if (
    !board
    || !realDirectoryMatches(board.project_path, roots.repository_root)
  ) {
    ingestionFailure('repository_root_mismatch')
  }
  if (input.workspace_id === null) return

  const workspace = db.prepare(`SELECT board_id, root_path, worktree_path, status
    FROM workspaces WHERE id=?`).get(input.workspace_id) as {
    board_id?: unknown
    root_path?: unknown
    worktree_path?: unknown
    status?: unknown
  } | undefined
  const executionRoot = typeof workspace?.worktree_path === 'string'
    && workspace.worktree_path.length > 0
    ? workspace.worktree_path
    : workspace?.root_path
  if (
    !workspace
    || workspace.board_id !== input.board_id
    || workspace.status !== 'active'
    || !realDirectoryMatches(executionRoot, roots.workspace_root)
  ) {
    ingestionFailure('workspace_root_mismatch')
  }
}

function emptySkipCounts(): RepositoryDocumentSkipCounts {
  return {
    hidden_paths: 0,
    unsafe_paths: 0,
    excluded_directories: 0,
    credential_paths: 0,
    nested_repositories: 0,
    symbolic_links: 0,
    unsupported_files: 0,
    oversized_files: 0,
    invalid_text_files: 0,
    empty_files: 0,
  }
}

function isHiddenName(value: string): boolean {
  return value.startsWith('.')
}

function isAllowedGithubRoot(
  parentSegments: readonly string[],
  entryName: string,
): boolean {
  return parentSegments.length === 0 && entryName === '.github'
}

function unsafePath(segments: readonly string[]): boolean {
  return segments.some((segment) =>
    segment.length === 0
    || segment !== segment.trim()
    || segment.includes('\\')
    || segment.includes('\ufffd')
    || CONTROL_CHARACTERS.test(segment))
}

function credentialPath(segments: readonly string[]): boolean {
  return segments.some(credentialLikeComponent)
}

function validKnowledgeLocatorPath(value: string): boolean {
  try {
    return normalizeKnowledgeLocator(value) === value
  } catch {
    return false
  }
}

function supportedTextFile(fileName: string): boolean {
  const extension = path.posix.extname(fileName.toLowerCase())
  return SUPPORTED_TEXT_EXTENSIONS.has(extension)
}

function fileStem(fileName: string): string {
  const extension = path.posix.extname(fileName)
  const stem = extension.length === 0
    ? fileName.toLowerCase()
    : fileName.slice(0, -extension.length).toLowerCase()
  return stem.replaceAll('_', '-')
}

function classifyDocument(
  relativePath: string,
): ScannedDocument['source_kind'] | null {
  const segments = relativePath.split('/')
  const lowerSegments = segments.map((segment) => segment.toLowerCase())
  const fileName = segments.at(-1) ?? ''
  const upperFileName = fileName.toUpperCase()
  const lowerFileName = fileName.toLowerCase()
  const stem = fileStem(fileName)
  const hasSupportedTextExtension = supportedTextFile(fileName)

  if (upperFileName === 'AGENTS.MD') return 'agents'
  // CLAUDE.md remains outside KNO-002 until provider-specific precedence and
  // directory scoping can prevent it from becoming provider-neutral guidance.
  if (
    (upperFileName === 'README' || upperFileName.startsWith('README.'))
    && (upperFileName === 'README' || hasSupportedTextExtension)
  ) {
    return 'readme'
  }
  if (!hasSupportedTextExtension) return null

  if (
    lowerSegments.some((segment) => ARCHITECTURE_DIRECTORY_NAMES.has(segment))
    || ARCHITECTURE_FILE_STEMS.has(stem)
    || /^adr[-_]\d+/u.test(lowerFileName)
    || /^rfc[-_]\d+/u.test(lowerFileName)
  ) {
    return 'architecture'
  }
  if (
    lowerSegments.some((segment) => CONVENTION_DIRECTORY_NAMES.has(segment))
    || CONVENTION_FILE_STEMS.has(stem)
  ) {
    return 'convention'
  }
  if (
    lowerSegments.some((segment) => DOCUMENTATION_DIRECTORY_NAMES.has(segment))
  ) {
    return 'documentation'
  }
  return null
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative))
}

function fileIdentity(
  filePath: string,
  status: fs.BigIntStats,
): FileIdentity {
  return {
    path: filePath,
    device: status.dev,
    inode: status.ino,
    links: status.nlink,
    mode: status.mode,
    size: status.size,
    modified_ns: status.mtimeNs,
    changed_ns: status.ctimeNs,
  }
}

function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.links === right.links
    && left.mode === right.mode
    && left.size === right.size
    && left.modified_ns === right.modified_ns
    && left.changed_ns === right.changed_ns
}

function currentIdentity(
  workspaceRoot: string,
  expected: FileIdentity,
  kind: 'file' | 'directory',
): FileIdentity {
  let status: fs.BigIntStats
  let realPath: string
  try {
    status = fs.lstatSync(expected.path, { bigint: true })
    realPath = fs.realpathSync(expected.path)
  } catch {
    ingestionFailure('filesystem_read_failed')
  }
  if (
    status.isSymbolicLink()
    || (kind === 'file' && !status.isFile())
    || (kind === 'file' && status.nlink !== 1n)
    || (kind === 'directory' && !status.isDirectory())
    || realPath !== expected.path
    || !insideRoot(workspaceRoot, realPath)
  ) {
    ingestionFailure('filesystem_read_failed')
  }
  return fileIdentity(expected.path, status)
}

function openDirectoryIdentity(
  workspaceRoot: string,
  directory: string,
): OpenDirectoryIdentity {
  let initial: fs.BigIntStats
  try {
    initial = fs.lstatSync(directory, { bigint: true })
  } catch {
    ingestionFailure('filesystem_read_failed')
  }
  const expected = currentIdentity(
    workspaceRoot,
    fileIdentity(directory, initial),
    'directory',
  )
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY
        | fs.constants.O_DIRECTORY
        | fs.constants.O_NOFOLLOW,
    )
    const opened = fs.fstatSync(descriptor, { bigint: true })
    const openedIdentity = fileIdentity(directory, opened)
    if (
      !opened.isDirectory()
      || !sameFileIdentity(expected, openedIdentity)
    ) {
      ingestionFailure('filesystem_read_failed')
    }
    return {
      ...openedIdentity,
      descriptor,
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // A fixed ingestion error is raised below.
      }
    }
    remapFailure(error, 'filesystem_read_failed')
  }
}

function validateOpenDirectory(
  workspaceRoot: string,
  directory: OpenDirectoryIdentity,
): void {
  let opened: fs.BigIntStats
  try {
    opened = fs.fstatSync(directory.descriptor, { bigint: true })
  } catch {
    ingestionFailure('filesystem_read_failed')
  }
  if (
    !opened.isDirectory()
    || !sameFileIdentity(directory, fileIdentity(directory.path, opened))
    || !sameFileIdentity(
      directory,
      currentIdentity(workspaceRoot, directory, 'directory'),
    )
  ) {
    ingestionFailure('filesystem_read_failed')
  }
}

function validateOpenDirectories(
  workspaceRoot: string,
  directories: readonly OpenDirectoryIdentity[],
): void {
  for (const directory of directories) {
    validateOpenDirectory(workspaceRoot, directory)
  }
}

function validateScannedDocument(
  workspaceRoot: string,
  document: ScannedDocument,
): void {
  if (
    !sameFileIdentity(
      document.file_identity,
      currentIdentity(workspaceRoot, document.file_identity, 'file'),
    )
  ) {
    ingestionFailure('filesystem_read_failed')
  }
}

function gitMarkerPresent(directory: string): boolean {
  return fs.lstatSync(path.join(directory, '.git'), {
    bigint: true,
    throwIfNoEntry: false,
  }) !== undefined
}

function bareRepositoryBoundaryPresent(
  directory: string,
  entries?: readonly fs.Dirent[],
): boolean {
  if (entries !== undefined) {
    const head = entries.find((entry) => entry.name === 'HEAD')
    const objects = entries.find((entry) => entry.name === 'objects')
    const refs = entries.find((entry) => entry.name === 'refs')
    if (head === undefined || objects === undefined || refs === undefined) {
      return false
    }
    if (
      head.isSymbolicLink()
      || objects.isSymbolicLink()
      || refs.isSymbolicLink()
      || !head.isFile()
      || !objects.isDirectory()
      || !refs.isDirectory()
    ) {
      ingestionFailure('filesystem_read_failed')
    }
  }

  let head: fs.BigIntStats | undefined
  let objects: fs.BigIntStats | undefined
  let refs: fs.BigIntStats | undefined
  try {
    head = fs.lstatSync(path.join(directory, 'HEAD'), {
      bigint: true,
      throwIfNoEntry: false,
    })
    objects = fs.lstatSync(path.join(directory, 'objects'), {
      bigint: true,
      throwIfNoEntry: false,
    })
    refs = fs.lstatSync(path.join(directory, 'refs'), {
      bigint: true,
      throwIfNoEntry: false,
    })
  } catch {
    ingestionFailure('filesystem_read_failed')
  }
  if (head === undefined || objects === undefined || refs === undefined) {
    if (entries !== undefined) ingestionFailure('filesystem_read_failed')
    return false
  }
  if (
    head.isSymbolicLink()
    || objects.isSymbolicLink()
    || refs.isSymbolicLink()
    || !head.isFile()
    || !objects.isDirectory()
    || !refs.isDirectory()
  ) {
    ingestionFailure('filesystem_read_failed')
  }
  return true
}

function nestedRepositoryBoundaryPresent(
  directory: string,
  entries?: readonly fs.Dirent[],
): boolean {
  const markerPresent = entries === undefined
    ? gitMarkerPresent(directory)
    : entries.some((entry) => entry.name === '.git')
  return markerPresent || bareRepositoryBoundaryPresent(directory, entries)
}

function validateScannedDirectory(
  workspaceRoot: string,
  directory: ScannedDirectory,
): void {
  if (
    !sameFileIdentity(
      directory.file_identity,
      currentIdentity(workspaceRoot, directory.file_identity, 'directory'),
    )
  ) {
    ingestionFailure('filesystem_read_failed')
  }
  if (
    directory.requires_nested_repository_absence
    && nestedRepositoryBoundaryPresent(directory.file_identity.path)
  ) {
    ingestionFailure('filesystem_read_failed')
  }
  if (
    !sameFileIdentity(
      directory.file_identity,
      currentIdentity(workspaceRoot, directory.file_identity, 'directory'),
    )
  ) {
    ingestionFailure('filesystem_read_failed')
  }
}

function lineCount(value: string): number {
  const separators = value.match(/\r\n|\r|\n/gu)?.length ?? 0
  return Math.max(
    1,
    separators + (/(?:\r\n|\r|\n)$/u.test(value) ? 0 : 1),
  )
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function pathRevisionScope(workspaceId: string | null): string {
  return workspaceId === null ? 'board' : `workspace-${sha256(workspaceId)}`
}

function safeReadDocument(
  workspaceRoot: string,
  ancestors: readonly OpenDirectoryIdentity[],
  fullPath: string,
  relativePath: string,
  sourceKind: ScannedDocument['source_kind'],
  baseCommitSha: string,
  workspaceId: string | null,
  maxFileBytes: number,
  aggregate: { bytes_read: number; max_bytes: number },
  skipped: RepositoryDocumentSkipCounts,
): ScannedDocument | null {
  let descriptor: number | null = null
  let bytes: Buffer | null = null
  let retainBytes = false
  try {
    validateOpenDirectories(workspaceRoot, ancestors)
    const beforePath = fs.lstatSync(fullPath, { bigint: true })
    if (
      beforePath.isSymbolicLink()
      || !beforePath.isFile()
      || beforePath.nlink !== 1n
    ) {
      ingestionFailure('filesystem_read_failed')
    }
    const realFile = fs.realpathSync(fullPath)
    if (realFile !== fullPath || !insideRoot(workspaceRoot, realFile)) {
      ingestionFailure('filesystem_read_failed')
    }
    descriptor = fs.openSync(
      fullPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    )
    const before = fs.fstatSync(descriptor, { bigint: true })
    const expectedIdentity = fileIdentity(fullPath, beforePath)
    const openedIdentity = fileIdentity(fullPath, before)
    if (
      !before.isFile()
      || before.nlink !== 1n
      || !sameFileIdentity(expectedIdentity, openedIdentity)
    ) {
      ingestionFailure('filesystem_read_failed')
    }
    const byteCount = Number(before.size)
    if (!Number.isSafeInteger(byteCount)) {
      ingestionFailure('filesystem_read_failed')
    }
    if (byteCount === 0) {
      skipped.empty_files += 1
      return null
    }
    if (byteCount > maxFileBytes) {
      skipped.oversized_files += 1
      return null
    }
    if (aggregate.bytes_read + byteCount > aggregate.max_bytes) {
      ingestionFailure('filesystem_read_failed')
    }
    aggregate.bytes_read += byteCount

    bytes = Buffer.alloc(byteCount)
    let offset = 0
    while (offset < byteCount) {
      const read = fs.readSync(
        descriptor,
        bytes,
        offset,
        byteCount - offset,
        offset,
      )
      if (read <= 0) ingestionFailure('filesystem_read_failed')
      offset += read
    }
    const extra = Buffer.allocUnsafe(1)
    const extraBytes = fs.readSync(descriptor, extra, 0, 1, byteCount)
    extra.fill(0)
    if (extraBytes !== 0) ingestionFailure('filesystem_read_failed')

    const after = fs.fstatSync(descriptor, { bigint: true })
    const afterIdentity = fileIdentity(fullPath, after)
    if (
      !sameFileIdentity(openedIdentity, afterIdentity)
      || bytes.byteLength !== byteCount
      || !sameFileIdentity(
        afterIdentity,
        currentIdentity(workspaceRoot, afterIdentity, 'file'),
      )
    ) {
      ingestionFailure('filesystem_read_failed')
    }
    validateOpenDirectories(workspaceRoot, ancestors)

    let original: string
    try {
      original = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      skipped.invalid_text_files += 1
      return null
    }
    if (original.length === 0) {
      skipped.empty_files += 1
      return null
    }
    if (original.includes('\u0000')) {
      skipped.invalid_text_files += 1
      return null
    }

    const redaction = redactSensitiveText(original)
    if (redaction.value === null || redaction.value.length === 0) {
      ingestionFailure('filesystem_read_failed')
    }
    const contentHash = sha256(redaction.value)
    retainBytes = true
    return {
      relative_path: relativePath,
      source_kind: sourceKind,
      content: redaction.value,
      content_sha256: contentHash,
      redacted: redaction.changed,
      source_range: {
        start_line: 1,
        end_line: lineCount(redaction.value),
        start_byte: 0,
        end_byte: Buffer.byteLength(redaction.value, 'utf8'),
      },
      file_identity: afterIdentity,
      original_bytes: bytes,
      freshness_policy: 'path_hash',
      source_revision:
        `path-sha256:${baseCommitSha}:${pathRevisionScope(workspaceId)}:${contentHash}`,
      worktree_state_hash: contentHash,
    }
  } catch (error) {
    remapFailure(error, 'filesystem_read_failed')
  } finally {
    if (!retainBytes) bytes?.fill(0)
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // The read has already completed and no content is exposed by close errors.
      }
    }
  }
  return ingestionFailure('filesystem_read_failed')
}

function boundedDirectoryEntries(
  directory: string,
  remainingEntries: number,
): fs.Dirent[] {
  let opened: fs.Dir | null = null
  try {
    opened = fs.opendirSync(directory, { bufferSize: 32 })
    const entries: fs.Dirent[] = []
    while (true) {
      const entry = opened.readSync()
      if (entry === null) break
      if (entries.length >= remainingEntries) {
        ingestionFailure('filesystem_read_failed')
      }
      entries.push(entry)
    }
    return entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  } catch (error) {
    remapFailure(error, 'filesystem_read_failed')
  } finally {
    try {
      opened?.closeSync()
    } catch {
      // Traversal state is validated independently through pinned descriptors.
    }
  }
  return ingestionFailure('filesystem_read_failed')
}

function durableGitlinkPath(value: Uint8Array): string | null {
  let relativePath: string
  try {
    relativePath = new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    // Git permits path bytes that cannot be represented by the durable UTF-8
    // locator contract. Traversal rejects the same entry before opening it.
    return null
  }
  const segments = relativePath.split('/')
  if (
    relativePath.length === 0
    || relativePath.length > 4_096
    || path.posix.isAbsolute(relativePath)
    || segments.some((segment) => segment === '.' || segment === '..')
    || unsafePath(segments)
    || !validKnowledgeLocatorPath(relativePath)
  ) {
    return null
  }
  return relativePath
}

function gitlinkPathsAtRevision(
  workspaceRoot: string,
  baseCommitSha: string,
): ReadonlySet<string> {
  const output = gitBytes(
    workspaceRoot,
    ['ls-tree', '-r', '-z', '--full-tree', baseCommitSha],
    { max_buffer: MAX_GIT_TREE_LISTING_BYTES },
  )
  const gitlinks = new Set<string>()
  try {
    let offset = 0
    while (offset < output.length) {
      const recordEnd = output.indexOf(0x00, offset)
      if (recordEnd < 0) ingestionFailure('repository_unavailable')
      const separator = output.indexOf(0x09, offset)
      if (separator < 0 || separator >= recordEnd) {
        ingestionFailure('repository_unavailable')
      }
      const header = output.subarray(offset, separator).toString('ascii')
      const match =
        /^(100644|100755|120000|040000|160000) (blob|tree|commit) ([a-f0-9]+)$/u
          .exec(header)
      if (!match || !OBJECT_ID.test(match[3])) {
        ingestionFailure('repository_unavailable')
      }
      const coherentType =
        (match[1] === '160000' && match[2] === 'commit')
        || (match[1] === '040000' && match[2] === 'tree')
        || (
          ['100644', '100755', '120000'].includes(match[1])
          && match[2] === 'blob'
      )
      if (!coherentType) ingestionFailure('repository_unavailable')
      if (match[1] === '160000') {
        const relativePath = durableGitlinkPath(
          output.subarray(separator + 1, recordEnd),
        )
        if (relativePath !== null) gitlinks.add(relativePath)
      }
      offset = recordEnd + 1
    }
    return gitlinks
  } finally {
    output.fill(0)
  }
}

function indexGitlinkInventory(workspaceRoot: string): GitlinkInventory {
  const output = gitBytes(
    workspaceRoot,
    ['ls-files', '--stage', '-z', '--full-name', '--'],
    { max_buffer: MAX_GIT_INDEX_LISTING_BYTES },
  )
  const paths = new Set<string>()
  try {
    let offset = 0
    while (offset < output.length) {
      const recordEnd = output.indexOf(0x00, offset)
      if (recordEnd < 0) ingestionFailure('repository_unavailable')
      const separator = output.indexOf(0x09, offset)
      if (separator < 0 || separator >= recordEnd) {
        ingestionFailure('repository_unavailable')
      }
      const header = output.subarray(offset, separator).toString('ascii')
      const match =
        /^(100644|100755|120000|040000|160000) ([a-f0-9]+) ([0-3])$/u
          .exec(header)
      if (!match || !OBJECT_ID.test(match[2])) {
        ingestionFailure('repository_unavailable')
      }
      if (match[1] === '160000') {
        const relativePath = durableGitlinkPath(
          output.subarray(separator + 1, recordEnd),
        )
        if (relativePath !== null) paths.add(relativePath)
      }
      offset = recordEnd + 1
    }
    return { paths }
  } finally {
    output.fill(0)
  }
}

function sameStringSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function assertIndexGitlinksStable(
  workspaceRoot: string,
  expected: GitlinkInventory,
): void {
  const actual = indexGitlinkInventory(workspaceRoot)
  if (!sameStringSet(actual.paths, expected.paths)) {
    ingestionFailure('filesystem_read_failed')
  }
}

function scanDocuments(
  workspaceRoot: string,
  input: Pick<
    ValidatedIngestionInput,
    | 'max_file_bytes'
    | 'base_commit_sha'
    | 'workspace_id'
    | 'max_total_bytes'
    | 'max_documents'
    | 'max_traversal_depth'
    | 'max_traversal_entries'
  >,
  gitlinkPaths: ReadonlySet<string>,
): {
  documents: ScannedDocument[]
  directories: ScannedDirectory[]
  discovered_files: number
  candidate_files: number
  skipped: RepositoryDocumentSkipCounts
} {
  const documents: ScannedDocument[] = []
  const directories: ScannedDirectory[] = []
  const skipped = emptySkipCounts()
  let discoveredFiles = 0
  let candidateFiles = 0
  let traversalEntries = 0
  const aggregate = {
    bytes_read: 0,
    max_bytes: input.max_total_bytes,
  }

  const visit = (
    directory: string,
    parentSegments: readonly string[],
    ancestors: readonly OpenDirectoryIdentity[],
  ): void => {
    const openedDirectory = openDirectoryIdentity(workspaceRoot, directory)
    const openDirectories = [...ancestors, openedDirectory]
    try {
      validateOpenDirectories(workspaceRoot, openDirectories)
      if (
        parentSegments.length > 0
        && nestedRepositoryBoundaryPresent(directory)
      ) {
        validateOpenDirectories(workspaceRoot, openDirectories)
        skipped.nested_repositories += 1
        return
      }
      const entries = boundedDirectoryEntries(
        directory,
        input.max_traversal_entries - traversalEntries,
      )
      traversalEntries += entries.length
      validateOpenDirectories(workspaceRoot, openDirectories)
      if (
        parentSegments.length > 0
        && nestedRepositoryBoundaryPresent(directory, entries)
      ) {
        skipped.nested_repositories += 1
        return
      }
      const {
        descriptor: _descriptor,
        ...scannedDirectoryIdentity
      } = openedDirectory
      directories.push({
        file_identity: scannedDirectoryIdentity,
        requires_nested_repository_absence: parentSegments.length > 0,
      })
      for (const entry of entries) {
        const segments = [...parentSegments, entry.name]
        if (segments.length > input.max_traversal_depth) {
          ingestionFailure('filesystem_read_failed')
        }
        const relativePath = segments.join('/')
        const fullPath = path.join(directory, entry.name)
        if (
          isHiddenName(entry.name)
          && !isAllowedGithubRoot(parentSegments, entry.name)
        ) {
          skipped.hidden_paths += 1
          continue
        }
        if (unsafePath(segments) || relativePath.length > 4_096) {
          skipped.unsafe_paths += 1
          continue
        }
        if (!validKnowledgeLocatorPath(relativePath)) {
          skipped.unsafe_paths += 1
          continue
        }
        if (gitlinkPaths.has(relativePath)) {
          skipped.nested_repositories += 1
          continue
        }
        if (credentialPath(segments)) {
          skipped.credential_paths += 1
          continue
        }

        let status: fs.BigIntStats
        try {
          status = fs.lstatSync(fullPath, { bigint: true })
        } catch {
          ingestionFailure('filesystem_read_failed')
        }
        if (status.isSymbolicLink()) {
          skipped.symbolic_links += 1
          continue
        }
        if (status.isDirectory()) {
          if (
            EXCLUDED_DIRECTORY_NAMES.has(entry.name.toLowerCase())
            || (
              parentSegments.length === 1
              && parentSegments[0] === '.github'
            )
          ) {
            skipped.excluded_directories += 1
            continue
          }
          visit(fullPath, segments, openDirectories)
          validateOpenDirectories(workspaceRoot, openDirectories)
          continue
        }
        if (!status.isFile()) {
          skipped.unsupported_files += 1
          continue
        }

        discoveredFiles += 1
        const sourceKind = classifyDocument(relativePath)
        if (sourceKind === null) {
          skipped.unsupported_files += 1
          continue
        }
        candidateFiles += 1
        if (candidateFiles > input.max_documents) {
          ingestionFailure('filesystem_read_failed')
        }
        const document = safeReadDocument(
          workspaceRoot,
          openDirectories,
          fullPath,
          relativePath,
          sourceKind,
          input.base_commit_sha,
          input.workspace_id,
          input.max_file_bytes,
          aggregate,
          skipped,
        )
        if (document !== null) documents.push(document)
        validateOpenDirectories(workspaceRoot, openDirectories)
      }
      validateOpenDirectories(workspaceRoot, openDirectories)
    } catch (error) {
      remapFailure(error, 'filesystem_read_failed')
    } finally {
      try {
        fs.closeSync(openedDirectory.descriptor)
      } catch {
        // A completed validation does not expose document content on close.
      }
    }
  }

  try {
    visit(workspaceRoot, [], [])
    documents.sort((left, right) =>
      left.relative_path < right.relative_path
        ? -1
        : left.relative_path > right.relative_path
          ? 1
          : 0)
    return {
      documents,
      directories,
      discovered_files: discoveredFiles,
      candidate_files: candidateFiles,
      skipped,
    }
  } catch (error) {
    for (const document of documents) document.original_bytes.fill(0)
    remapFailure(error, 'filesystem_read_failed')
  }
}

function gitBatchInput(
  baseCommitSha: string,
  documents: readonly ScannedDocument[],
): Buffer {
  if (documents.length === 0) return Buffer.alloc(0)
  return Buffer.from(
    `${documents.map((document) =>
      `${baseCommitSha}:${document.relative_path}`).join('\n')}\n`,
    'utf8',
  )
}

function classifyDocumentRevisions(
  workspaceRoot: string,
  baseCommitSha: string,
  documents: readonly ScannedDocument[],
): void {
  if (documents.length === 0) return
  const checkInput = gitBatchInput(baseCommitSha, documents)
  const checked = gitBytes(
    workspaceRoot,
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    {
      input: checkInput,
      max_buffer: checkInput.byteLength + (documents.length * 160),
    },
  )
  let checkLines: string[]
  try {
    checkLines = new TextDecoder('utf-8', { fatal: true })
      .decode(checked)
      .split('\n')
  } catch {
    ingestionFailure('repository_unavailable')
  }
  if (checkLines.at(-1) === '') checkLines.pop()
  if (checkLines.length !== documents.length) {
    ingestionFailure('repository_unavailable')
  }

  const candidates: Array<{
    document: ScannedDocument
    spec: string
    object_id: string
    size: number
  }> = []
  for (let index = 0; index < documents.length; index += 1) {
    const match = /^([a-f0-9]+) blob ([0-9]+)$/u.exec(checkLines[index])
    if (!match || !OBJECT_ID.test(match[1])) continue
    const size = Number(match[2])
    if (
      !Number.isSafeInteger(size)
      || size < 0
      || size !== documents[index].original_bytes.byteLength
    ) {
      continue
    }
    candidates.push({
      document: documents[index],
      spec: `${baseCommitSha}:${documents[index].relative_path}`,
      object_id: match[1],
      size,
    })
  }
  if (candidates.length === 0) return

  const contentInput = Buffer.from(
    `${candidates.map((candidate) => candidate.spec).join('\n')}\n`,
    'utf8',
  )
  const maximumContent = candidates.reduce(
    (total, candidate) => total + candidate.size,
    0,
  )
  const output = gitBytes(
    workspaceRoot,
    ['cat-file', '--batch'],
    {
      input: contentInput,
      max_buffer: maximumContent + (candidates.length * 160),
    },
  )
  try {
    let offset = 0
    for (const candidate of candidates) {
      const headerEnd = output.indexOf(0x0a, offset)
      if (headerEnd < 0) ingestionFailure('repository_unavailable')
      const header = output.subarray(offset, headerEnd).toString('ascii')
      const match = /^([a-f0-9]+) blob ([0-9]+)$/u.exec(header)
      if (
        !match
        || match[1] !== candidate.object_id
        || Number(match[2]) !== candidate.size
      ) {
        ingestionFailure('repository_unavailable')
      }
      const contentStart = headerEnd + 1
      const contentEnd = contentStart + candidate.size
      if (
        contentEnd >= output.length
        || output[contentEnd] !== 0x0a
      ) {
        ingestionFailure('repository_unavailable')
      }
      if (
        // commit_exact is deliberately raw-byte exact. KNO-007 owns any
        // cross-platform canonicalization; ingestion must never run filters.
        output.subarray(contentStart, contentEnd)
          .equals(candidate.document.original_bytes)
      ) {
        candidate.document.freshness_policy = 'commit_exact'
        candidate.document.source_revision = baseCommitSha
        candidate.document.worktree_state_hash = null
      }
      offset = contentEnd + 1
    }
    if (offset !== output.length) ingestionFailure('repository_unavailable')
  } finally {
    output.fill(0)
  }
}

function targetLinks(
  boardId: number,
  workspaceId: string | null,
): KnowledgeTargetLinks {
  return {
    board_id: boardId,
    workspace_id: workspaceId,
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

function planDocument(
  input: ValidatedIngestionInput,
  document: ScannedDocument,
): PlannedDocument {
  const locator = normalizeKnowledgeLocator(document.relative_path)
  const scopedWorkspaceId = document.freshness_policy === 'path_hash'
    ? input.workspace_id
    : null
  const sourceWithoutId: Omit<KnowledgeSource, 'id'> = {
    source_kind: document.source_kind,
    trust_class: document.source_kind === 'agents' ? 'instruction' : 'reference',
    title: document.relative_path,
    locator,
    normalized_locator: locator,
    source_revision: document.source_revision,
    content_sha256: document.content_sha256,
    freshness_policy: document.freshness_policy,
    freshness_state: 'fresh',
    redaction_state: document.redacted ? 'redacted' : 'none',
    content_state: 'present',
    ingest_state: 'active',
    access_scope: scopedWorkspaceId === null
      ? { kind: 'board' }
      : { kind: 'workspace', workspace_id: scopedWorkspaceId },
    targets: targetLinks(input.board_id, scopedWorkspaceId),
    provenance: {
      repository_key: input.repository_key,
      base_commit_sha: input.base_commit_sha,
      worktree_state_hash: document.worktree_state_hash,
      relative_root: '.',
      adapter_id: 'repository-document-ingestion',
      adapter_version: '1.0.0',
      adapter_index_commit_sha: null,
      observed_at: input.observed_at,
    },
    created_at: input.observed_at,
    updated_at: input.observed_at,
  }
  const source: KnowledgeSource = {
    ...sourceWithoutId,
    id: knowledgeSourceId({
      repository_key: input.repository_key,
      source_kind: document.source_kind,
      normalized_locator: locator,
      source_revision: document.source_revision,
      content_sha256: document.content_sha256,
    }),
  }
  const chunkWithoutId: Omit<KnowledgeChunk, 'id'> = {
    source_id: source.id,
    ordinal: 0,
    content: document.content,
    content_sha256: document.content_sha256,
    character_count: document.content.length,
    byte_count: Buffer.byteLength(document.content, 'utf8'),
    estimated_tokens: Math.max(1, Math.ceil(document.content.length / 4)),
    source_range: document.source_range,
    symbol: null,
    created_at: input.observed_at,
  }
  return {
    source,
    chunk: {
      ...chunkWithoutId,
      id: knowledgeChunkId({
        source_id: source.id,
        ordinal: 0,
        content_sha256: document.content_sha256,
        source_range: document.source_range,
      }),
    },
  }
}

function sameTargets(
  left: KnowledgeTargetLinks,
  right: KnowledgeTargetLinks,
): boolean {
  return left.board_id === right.board_id
    && left.workspace_id === right.workspace_id
    && left.card_id === right.card_id
    && left.contract_ref === right.contract_ref
    && left.contract_version === right.contract_version
    && left.contract_snapshot_sha256 === right.contract_snapshot_sha256
    && left.job_id === right.job_id
    && left.profile_id === right.profile_id
    && left.session_id === right.session_id
    && left.delivery_report_id === right.delivery_report_id
}

function sameAccessScope(
  left: KnowledgeAccessScope,
  right: KnowledgeAccessScope,
): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'board':
      return true
    case 'workspace':
      return right.kind === 'workspace'
        && left.workspace_id === right.workspace_id
    case 'contract':
      return right.kind === 'contract'
        && left.card_id === right.card_id
        && left.contract_version === right.contract_version
    case 'job':
      return right.kind === 'job' && left.job_id === right.job_id
    case 'profile':
      return right.kind === 'profile' && left.profile_id === right.profile_id
    case 'session':
      return right.kind === 'session' && left.session_id === right.session_id
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
    && sameAccessScope(retained.access_scope, planned.access_scope)
    && sameTargets(retained.targets, planned.targets)
    && retained.provenance.repository_key === planned.provenance.repository_key
    && retained.provenance.base_commit_sha === planned.provenance.base_commit_sha
    && retained.provenance.worktree_state_hash === planned.provenance.worktree_state_hash
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
    && retained.source_range.start_line === planned.source_range.start_line
    && retained.source_range.end_line === planned.source_range.end_line
    && retained.source_range.start_byte === planned.source_range.start_byte
    && retained.source_range.end_byte === planned.source_range.end_byte
    && retained.symbol === null
    && planned.symbol === null
}

function skippedPathCount(skipped: RepositoryDocumentSkipCounts): number {
  return Object.values(skipped).reduce((total, value) => total + value, 0)
}

/**
 * Explicitly walks repository documentation and atomically persists one
 * whole-document chunk per accepted source. It never consults ignore files,
 * so ignored AGENTS.md files remain discoverable.
 */
export class RepositoryDocumentIngestor {
  private readonly store: KnowledgeStore

  constructor(private readonly db: Database.Database) {
    this.store = new KnowledgeStore(db)
  }

  ingest(value: RepositoryDocumentIngestionInput): RepositoryDocumentIngestionReport {
    try {
      return this.#ingestInternal(value)
    } catch (error) {
      throw new RepositoryDocumentIngestionError(
        trustedErrorCode(error) ?? 'persistence_failed',
      )
    }
  }

  #ingestInternal(
    value: RepositoryDocumentIngestionInput,
  ): RepositoryDocumentIngestionReport {
    const input = validateIngestionInput(value)
    const roots = verifyRoots(this.db, input)
    assertRepositoryStable(roots, input.base_commit_sha)
    const baseGitlinkPaths = gitlinkPathsAtRevision(
      roots.workspace_root,
      input.base_commit_sha,
    )
    assertRepositoryStable(roots, input.base_commit_sha)
    const indexGitlinks = indexGitlinkInventory(roots.workspace_root)
    assertRepositoryStable(roots, input.base_commit_sha)
    assertIndexGitlinksStable(roots.workspace_root, indexGitlinks)
    const gitlinkPaths = new Set([
      ...baseGitlinkPaths,
      ...indexGitlinks.paths,
    ])
    const scan = scanDocuments(
      roots.workspace_root,
      input,
      gitlinkPaths,
    )
    assertRepositoryStable(roots, input.base_commit_sha)
    assertIndexGitlinksStable(roots.workspace_root, indexGitlinks)
    let plans: PlannedDocument[]
    try {
      for (const directory of scan.directories) {
        validateScannedDirectory(roots.workspace_root, directory)
      }
      for (const document of scan.documents) {
        validateScannedDocument(roots.workspace_root, document)
      }
      assertRepositoryStable(roots, input.base_commit_sha)
      assertIndexGitlinksStable(roots.workspace_root, indexGitlinks)
      classifyDocumentRevisions(
        roots.workspace_root,
        input.base_commit_sha,
        scan.documents,
      )
      assertRepositoryStable(roots, input.base_commit_sha)
      assertIndexGitlinksStable(roots.workspace_root, indexGitlinks)
      for (const directory of scan.directories) {
        validateScannedDirectory(roots.workspace_root, directory)
      }
      for (const document of scan.documents) {
        validateScannedDocument(roots.workspace_root, document)
      }
      plans = scan.documents.map((document) => planDocument(input, document))
    } finally {
      for (const document of scan.documents) {
        document.original_bytes.fill(0)
        document.original_bytes = Buffer.alloc(0)
      }
    }

    const save = this.db.transaction((): {
      sources: KnowledgeSource[]
      chunks: KnowledgeChunk[]
    } => {
      assertDatabaseScopeStable(this.db, input, roots)
      for (const directory of scan.directories) {
        validateScannedDirectory(roots.workspace_root, directory)
      }
      for (const document of scan.documents) {
        validateScannedDocument(roots.workspace_root, document)
      }
      assertRepositoryStable(roots, input.base_commit_sha)
      assertIndexGitlinksStable(roots.workspace_root, indexGitlinks)
      const sources: KnowledgeSource[] = []
      const chunks: KnowledgeChunk[] = []
      for (const plan of plans) {
        const retainedSource = this.store.getSource(input.board_id, plan.source.id)
        let source: KnowledgeSource
        if (retainedSource !== null) {
          if (!sourceReplayCompatible(retainedSource, plan.source)) {
            ingestionFailure('persistence_conflict')
          }
          source = retainedSource
        } else {
          source = this.store.putSource(plan.source)
        }

        const retainedChunk = this.store.getChunk(input.board_id, plan.chunk.id)
        let chunk: KnowledgeChunk
        if (retainedChunk !== null) {
          if (!chunkReplayCompatible(retainedChunk, plan.chunk)) {
            ingestionFailure('persistence_conflict')
          }
          chunk = retainedChunk
        } else {
          const occupiedOrdinal = this.db.prepare(`SELECT 1 AS present
            FROM knowledge_chunks
            WHERE board_id=? AND source_id=? AND ordinal=?`)
            .get(input.board_id, plan.chunk.source_id, plan.chunk.ordinal)
          if (occupiedOrdinal !== undefined) {
            ingestionFailure('persistence_conflict')
          }
          chunk = this.store.putChunk(input.board_id, plan.chunk)
        }
        sources.push(source)
        chunks.push(chunk)
      }
      for (const directory of scan.directories) {
        validateScannedDirectory(roots.workspace_root, directory)
      }
      for (const document of scan.documents) {
        validateScannedDocument(roots.workspace_root, document)
      }
      assertRepositoryStable(roots, input.base_commit_sha)
      assertIndexGitlinksStable(roots.workspace_root, indexGitlinks)
      assertDatabaseScopeStable(this.db, input, roots)
      return { sources, chunks }
    })
    const persisted = save.immediate()

    return {
      board_id: input.board_id,
      repository_key: input.repository_key,
      base_commit_sha: input.base_commit_sha,
      sources: persisted.sources,
      chunks: persisted.chunks,
      totals: {
        discovered_files: scan.discovered_files,
        candidate_files: scan.candidate_files,
        ingested_files: persisted.sources.length,
        redacted_files: scan.documents.filter((document) => document.redacted).length,
        skipped_paths: skippedPathCount(scan.skipped),
      },
      skipped: scan.skipped,
    }
  }
}

import { createHash } from 'node:crypto'
import {
  CONTEXT_SECTIONS,
  CONTEXT_SELECTION_REASONS,
  KNOWLEDGE_CONTENT_STATES,
  KNOWLEDGE_FRESHNESS_STATES,
  KNOWLEDGE_FRESHNESS_POLICIES,
  KNOWLEDGE_INGEST_STATES,
  KNOWLEDGE_REDACTION_STATES,
  KNOWLEDGE_SOURCE_KINDS,
  KNOWLEDGE_TRUST_CLASSES,
} from './knowledge-types.js'
import type {
  ContextBudget,
  ContextBudgetLimit,
  ContextBudgetUsage,
  ContextBudgetUsageSection,
  ContextBuildAccounting,
  ContextBuild,
  ContextBuildEntry,
  ContextBuildIdentityInput,
  ContextOrderingCandidate,
  ContextRequestIdentityInput,
  ContextScoreComponents,
  ContextSection,
  ContextUse,
  ContextUseIdentityInput,
  KnowledgeAccessScope,
  KnowledgeChunk,
  KnowledgeChunkIdentityInput,
  KnowledgeFreshnessState,
  KnowledgeRedactionState,
  KnowledgeSource,
  KnowledgeSourceIdentityInput,
  KnowledgeSourceKind,
  KnowledgeSourceRange,
  KnowledgeSourceSetEntry,
  KnowledgeSymbolReference,
  KnowledgeTargetLinks,
  KnowledgeTrustClass,
  RepositoryProvenance,
} from './knowledge-types.js'

export const KNOWLEDGE_HASH_DOMAINS = Object.freeze([
  'source',
  'chunk',
  'context-build',
  'context-use',
  'source-set',
  'context-manifest',
  'context-request',
] as const)

export type KnowledgeHashDomain = typeof KNOWLEDGE_HASH_DOMAINS[number]

export type KnowledgeContractErrorCode =
  | 'invalid_contract'
  | 'invalid_canonical_value'
  | 'canonical_cycle'
  | 'canonical_depth_exceeded'
  | 'canonical_node_limit_exceeded'
  | 'canonical_string_limit_exceeded'
  | 'canonical_size_exceeded'
  | 'invalid_hash_domain'
  | 'duplicate_identity'
  | 'invalid_range'
  | 'invalid_scope'
  | 'invalid_provenance'
  | 'invalid_targets'
  | 'invalid_budget'
  | 'budget_exceeded'
  | 'invalid_manifest'

const ERROR_MESSAGES: Record<KnowledgeContractErrorCode, string> = {
  invalid_contract: 'knowledge contract is invalid',
  invalid_canonical_value: 'canonical value is invalid',
  canonical_cycle: 'canonical value contains a cycle',
  canonical_depth_exceeded: 'canonical value exceeds the depth limit',
  canonical_node_limit_exceeded: 'canonical value exceeds the node limit',
  canonical_string_limit_exceeded: 'canonical value exceeds the string limit',
  canonical_size_exceeded: 'canonical value exceeds the serialized size limit',
  invalid_hash_domain: 'knowledge hash domain is invalid',
  duplicate_identity: 'knowledge contract contains a duplicate identity',
  invalid_range: 'knowledge source range is invalid',
  invalid_scope: 'knowledge access scope is invalid',
  invalid_provenance: 'repository provenance is invalid',
  invalid_targets: 'knowledge target links are invalid',
  invalid_budget: 'context budget is invalid',
  budget_exceeded: 'context budget is exceeded',
  invalid_manifest: 'context manifest is invalid',
}

/**
 * Contract errors intentionally never include supplied values. Callers may log
 * the stable code and fixed field name without leaking source or prompt text.
 */
export class KnowledgeContractError extends TypeError {
  readonly code: KnowledgeContractErrorCode
  readonly field: string | null

  constructor(code: KnowledgeContractErrorCode, field: string | null = null) {
    super(field === null ? ERROR_MESSAGES[code] : `${ERROR_MESSAGES[code]} (${field})`)
    this.name = 'KnowledgeContractError'
    this.code = code
    this.field = field
  }
}

export interface CanonicalJsonLimits {
  max_depth: number
  max_nodes: number
  max_string_characters: number
  max_serialized_bytes: number
}

export const DEFAULT_CANONICAL_JSON_LIMITS: Readonly<CanonicalJsonLimits> = Object.freeze({
  max_depth: 32,
  max_nodes: 20_000,
  max_string_characters: 1_000_000,
  max_serialized_bytes: 4_000_000,
})

export const MAX_CANONICAL_JSON_LIMITS: Readonly<CanonicalJsonLimits> = Object.freeze({
  max_depth: 64,
  max_nodes: 100_000,
  max_string_characters: 2_000_000,
  max_serialized_bytes: 8_000_000,
})

const MAX_IDENTIFIER_CHARACTERS = 256
const MAX_LOCATOR_CHARACTERS = 4_096
const MAX_REVISION_CHARACTERS = 512
const MAX_RANK = 1_000_000
const MAX_SCORE_ABS = 1_000_000_000_000
const MAX_CONTRACT_COLLECTION_ENTRIES = 512
export const MAX_CONTEXT_BUDGET_TOKENS = 10_000_000
export const MAX_CONTEXT_BUDGET_CHARACTERS = 50_000_000
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const SOURCE_ID = /^ks_[a-f0-9]{64}$/u
const CHUNK_ID = /^kc_[a-f0-9]{64}$/u
const CONTEXT_BUILD_ID = /^cb_[a-f0-9]{64}$/u
const HASH_PREFIX = 'orchestra-agent-os:'
const URL_LOCATOR_SCHEMES = new Set([
  'file',
  'ftp',
  'git+https',
  'git+ssh',
  'http',
  'https',
  'ssh',
  'ws',
  'wss',
])

const SOURCE_KIND_SET = new Set<string>(KNOWLEDGE_SOURCE_KINDS)
const TRUST_CLASS_SET = new Set<string>(KNOWLEDGE_TRUST_CLASSES)
const FRESHNESS_STATE_SET = new Set<string>(KNOWLEDGE_FRESHNESS_STATES)
const FRESHNESS_POLICY_SET = new Set<string>(KNOWLEDGE_FRESHNESS_POLICIES)
const REDACTION_STATE_SET = new Set<string>(KNOWLEDGE_REDACTION_STATES)
const CONTENT_STATE_SET = new Set<string>(KNOWLEDGE_CONTENT_STATES)
const INGEST_STATE_SET = new Set<string>(KNOWLEDGE_INGEST_STATES)
const CONTEXT_SECTION_SET = new Set<string>(CONTEXT_SECTIONS)
const SELECTION_REASON_SET = new Set<string>(CONTEXT_SELECTION_REASONS)
const HASH_DOMAIN_SET = new Set<string>(KNOWLEDGE_HASH_DOMAINS)

function contractError(
  code: KnowledgeContractErrorCode,
  field: string | null = null,
): never {
  throw new KnowledgeContractError(code, field)
}

function redactedReflection<T>(
  operation: () => T,
  code: KnowledgeContractErrorCode,
  field: string | null,
): T {
  try {
    return operation()
  } catch {
    contractError(code, field)
  }
}

function reflectedIsArray(
  value: unknown,
  code: KnowledgeContractErrorCode,
  field: string | null,
): value is unknown[] {
  return redactedReflection(() => Array.isArray(value), code, field)
}

function reflectedPrototype(
  value: object,
  code: KnowledgeContractErrorCode,
  field: string | null,
): object | null {
  return redactedReflection(() => Object.getPrototypeOf(value), code, field)
}

function reflectedOwnKeys(
  value: object,
  code: KnowledgeContractErrorCode,
  field: string | null,
): PropertyKey[] {
  return redactedReflection(() => Reflect.ownKeys(value), code, field)
}

function reflectedOwnPropertyDescriptor(
  value: object,
  key: PropertyKey,
  code: KnowledgeContractErrorCode,
  field: string | null,
): PropertyDescriptor | undefined {
  return redactedReflection(
    () => Object.getOwnPropertyDescriptor(value, key),
    code,
    field,
  )
}

function assertExactArrayKeys(
  keys: readonly PropertyKey[],
  length: number,
  code: KnowledgeContractErrorCode,
  field: string | null,
): void {
  if (
    keys.length !== length + 1
    || keys.some((key) => typeof key === 'symbol')
  ) {
    contractError(code, field)
  }
  const keySet = new Set(keys as string[])
  if (keySet.size !== length + 1 || !keySet.has('length')) {
    contractError(code, field)
  }
  for (let index = 0; index < length; index += 1) {
    if (!keySet.has(String(index))) contractError(code, field)
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function canonicalLimits(options: Partial<CanonicalJsonLimits> | undefined): CanonicalJsonLimits {
  if (options === undefined) return { ...DEFAULT_CANONICAL_JSON_LIMITS }
  const record = safeRecord(options, 'invalid_contract', 'canonical_limits')
  const fields = [
    'max_depth',
    'max_nodes',
    'max_string_characters',
    'max_serialized_bytes',
  ] as const
  exactKeys(record, [], fields, 'invalid_contract', 'canonical_limits')
  const merged: Record<typeof fields[number], unknown> = {
    ...DEFAULT_CANONICAL_JSON_LIMITS,
  }
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      merged[field] = record[field]
    }
  }
  for (const field of fields) {
    const value = merged[field]
    if (
      !Number.isSafeInteger(value)
      || Number(value) < 0
      || Number(value) > MAX_CANONICAL_JSON_LIMITS[field]
    ) {
      contractError('invalid_contract', 'canonical_limits')
    }
  }
  return {
    max_depth: Number(merged.max_depth),
    max_nodes: Number(merged.max_nodes),
    max_string_characters: Number(merged.max_string_characters),
    max_serialized_bytes: Number(merged.max_serialized_bytes),
  }
}

/**
 * Serializes the strict JSON subset with recursively sorted object keys.
 * Unsupported values fail closed instead of being silently dropped as they
 * would be by JSON.stringify.
 */
export function canonicalKnowledgeJson(
  value: unknown,
  options?: Partial<CanonicalJsonLimits>,
): string {
  const limits = canonicalLimits(options)
  const ancestors = new WeakSet<object>()
  const output: string[] = []
  let nodes = 0
  let bytes = 0

  const append = (fragment: string): void => {
    bytes += Buffer.byteLength(fragment, 'utf8')
    if (bytes > limits.max_serialized_bytes) {
      contractError('canonical_size_exceeded')
    }
    output.push(fragment)
  }

  const appendString = (text: string): void => {
    if (text.length > limits.max_string_characters) {
      contractError('canonical_string_limit_exceeded')
    }
    append(JSON.stringify(text))
  }

  const visit = (current: unknown, depth: number): void => {
    if (depth > limits.max_depth) contractError('canonical_depth_exceeded')
    nodes += 1
    if (nodes > limits.max_nodes) contractError('canonical_node_limit_exceeded')

    if (current === null) {
      append('null')
      return
    }
    if (typeof current === 'string') {
      appendString(current)
      return
    }
    if (typeof current === 'boolean') {
      append(current ? 'true' : 'false')
      return
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) contractError('invalid_canonical_value')
      append(Object.is(current, -0) ? '0' : JSON.stringify(current))
      return
    }
    if (typeof current !== 'object') contractError('invalid_canonical_value')
    if (ancestors.has(current)) contractError('canonical_cycle')

    ancestors.add(current)
    try {
      if (reflectedIsArray(current, 'invalid_canonical_value', null)) {
        const lengthDescriptor = reflectedOwnPropertyDescriptor(
          current,
          'length',
          'invalid_canonical_value',
          null,
        )
        if (
          !lengthDescriptor
          || !('value' in lengthDescriptor)
          || lengthDescriptor.configurable !== false
          || lengthDescriptor.enumerable !== false
          || !Number.isSafeInteger(lengthDescriptor.value)
          || Number(lengthDescriptor.value) < 0
        ) {
          contractError('invalid_canonical_value')
        }
        const length = Number(lengthDescriptor.value)
        // Every array element consumes at least one node. Reject before a walk
        // or allocation proportional to an attacker-controlled sparse length.
        if (length > limits.max_nodes - nodes) {
          contractError('canonical_node_limit_exceeded')
        }
        const keys = reflectedOwnKeys(current, 'invalid_canonical_value', null)
        assertExactArrayKeys(keys, length, 'invalid_canonical_value', null)
        const values: unknown[] = []
        for (let index = 0; index < length; index += 1) {
          const key = String(index)
          const descriptor = reflectedOwnPropertyDescriptor(
            current,
            key,
            'invalid_canonical_value',
            null,
          )
          if (!descriptor?.enumerable || !('value' in descriptor)) {
            contractError('invalid_canonical_value')
          }
          values.push(descriptor.value)
        }
        append('[')
        for (let index = 0; index < values.length; index += 1) {
          if (index > 0) append(',')
          visit(values[index], depth + 1)
        }
        append(']')
        return
      }

      const prototype = reflectedPrototype(current, 'invalid_canonical_value', null)
      if (prototype !== Object.prototype && prototype !== null) {
        contractError('invalid_canonical_value')
      }
      const ownKeys = reflectedOwnKeys(current, 'invalid_canonical_value', null)
      if (ownKeys.length > limits.max_nodes - nodes) {
        contractError('canonical_node_limit_exceeded')
      }
      if (ownKeys.some((key) => typeof key === 'symbol')) {
        contractError('invalid_canonical_value')
      }
      const keys = (ownKeys as string[]).sort(compareCodeUnits)
      const entries = keys.map((key) => {
        const descriptor = reflectedOwnPropertyDescriptor(
          current,
          key,
          'invalid_canonical_value',
          null,
        )
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          contractError('invalid_canonical_value')
        }
        return [key, descriptor.value] as const
      })
      append('{')
      entries.forEach(([key, descriptorValue], index) => {
        if (index > 0) append(',')
        appendString(key)
        append(':')
        visit(descriptorValue, depth + 1)
      })
      append('}')
    } finally {
      ancestors.delete(current)
    }
  }

  visit(value, 0)
  return output.join('')
}

export function canonicalKnowledgeHash(
  domain: KnowledgeHashDomain,
  value: unknown,
  options?: Partial<CanonicalJsonLimits>,
): string {
  if (!HASH_DOMAIN_SET.has(domain)) contractError('invalid_hash_domain')
  return createHash('sha256')
    .update(`${HASH_PREFIX}${domain}:v1\0`, 'utf8')
    .update(canonicalKnowledgeJson(value, options), 'utf8')
    .digest('hex')
}

function safeRecord(
  value: unknown,
  code: KnowledgeContractErrorCode,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object') contractError(code, field)
  if (reflectedIsArray(value, code, field)) contractError(code, field)
  const prototype = reflectedPrototype(value, code, field)
  if (prototype !== Object.prototype && prototype !== null) contractError(code, field)
  const keys = reflectedOwnKeys(value, code, field)
  if (keys.length > MAX_CONTRACT_COLLECTION_ENTRIES) contractError(code, field)
  if (keys.some((key) => typeof key === 'symbol')) contractError(code, field)
  const snapshot = Object.create(null) as Record<string, unknown>
  for (const key of keys as string[]) {
    const descriptor = reflectedOwnPropertyDescriptor(value, key, code, field)
    if (!descriptor?.enumerable || !('value' in descriptor)) contractError(code, field)
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return snapshot
}

function denseContractArray(
  value: unknown,
  code: KnowledgeContractErrorCode,
  field: string,
): unknown[] {
  if (!reflectedIsArray(value, code, field)) contractError(code, field)
  const lengthDescriptor = reflectedOwnPropertyDescriptor(value, 'length', code, field)
  if (
    !lengthDescriptor
    || !('value' in lengthDescriptor)
    || lengthDescriptor.configurable !== false
    || lengthDescriptor.enumerable !== false
    || !Number.isSafeInteger(lengthDescriptor.value)
    || Number(lengthDescriptor.value) < 0
    || Number(lengthDescriptor.value) > MAX_CONTRACT_COLLECTION_ENTRIES
  ) {
    contractError(code, field)
  }
  const length = Number(lengthDescriptor.value)
  const keys = reflectedOwnKeys(value, code, field)
  assertExactArrayKeys(keys, length, code, field)
  const snapshot = new Array<unknown>(length)
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    const descriptor = reflectedOwnPropertyDescriptor(value, key, code, field)
    if (!descriptor?.enumerable || !('value' in descriptor)) contractError(code, field)
    snapshot[index] = descriptor.value
  }
  return snapshot
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: KnowledgeContractErrorCode,
  field: string,
): void {
  const allowed = new Set([...required, ...optional])
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    contractError(code, field)
  }
  if (Object.keys(record).some((key) => !allowed.has(key))) contractError(code, field)
}

function safeText(
  value: unknown,
  code: KnowledgeContractErrorCode,
  field: string,
  maxCharacters = MAX_IDENTIFIER_CHARACTERS,
): string {
  if (typeof value !== 'string') contractError(code, field)
  const normalized = value.trim().normalize('NFC')
  if (
    normalized.length === 0
    || normalized.length > maxCharacters
    || CONTROL_CHARACTERS.test(normalized)
  ) {
    contractError(code, field)
  }
  return normalized
}

function nullableSafeText(
  value: unknown,
  code: KnowledgeContractErrorCode,
  field: string,
): string | null {
  return value === null ? null : safeText(value, code, field)
}

function integer(
  value: unknown,
  code: KnowledgeContractErrorCode,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    contractError(code, field)
  }
  return Number(value)
}

function nullableInteger(
  value: unknown,
  code: KnowledgeContractErrorCode,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  return value === null ? null : integer(value, code, field, minimum, maximum)
}

function sha256(
  value: unknown,
  code: KnowledgeContractErrorCode,
  field: string,
): string {
  if (typeof value !== 'string' || !SHA256.test(value)) contractError(code, field)
  return value
}

function nullableSha256(
  value: unknown,
  code: KnowledgeContractErrorCode,
  field: string,
): string | null {
  return value === null ? null : sha256(value, code, field)
}

function nullableCommitSha(
  value: unknown,
  code: KnowledgeContractErrorCode,
  field: string,
): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !COMMIT_SHA.test(value)) contractError(code, field)
  return value
}

function prefixedHash(
  value: unknown,
  pattern: RegExp,
  code: KnowledgeContractErrorCode,
  field: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) contractError(code, field)
  return value
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
  code: KnowledgeContractErrorCode,
  field: string,
): T {
  if (typeof value !== 'string' || !values.has(value)) contractError(code, field)
  return value as T
}

function isoTimestamp(
  value: unknown,
  code: KnowledgeContractErrorCode,
  field: string,
): string {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    contractError(code, field)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    contractError(code, field)
  }
  return value
}

function locatorScheme(value: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1]?.toLowerCase()
}

function parseRecognizedLocator(value: string, scheme: string): URL {
  const remainder = value.slice(value.indexOf(':') + 1)
  if (scheme === 'file') {
    const authority = /^\/\/([^/]*)/u.exec(remainder)?.[1]
    if (!remainder.startsWith('/') || (authority !== undefined && authority !== '')) {
      contractError('invalid_contract', 'locator')
    }
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    contractError('invalid_contract', 'locator')
  }
  if (
    parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || (scheme !== 'file' && parsed.host === '' && remainder.includes('@'))
    || (
      scheme === 'file'
      && (parsed.host !== '' || !parsed.pathname.startsWith('/') || parsed.pathname.startsWith('//'))
    )
  ) {
    contractError('invalid_contract', 'locator')
  }
  return parsed
}

function assertLocatorLayerPolicy(value: string): void {
  if (
    CONTROL_CHARACTERS.test(value)
    || value.includes('?')
    || value.includes('#')
    || /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/iu.test(value)
  ) {
    contractError('invalid_contract', 'locator')
  }
  const scheme = locatorScheme(value)
  if (scheme !== undefined && URL_LOCATOR_SCHEMES.has(scheme)) {
    parseRecognizedLocator(value, scheme)
  }
}

function assertSafeLocatorEncoding(value: string): void {
  let decoded = value
  for (let pass = 0; pass < 4; pass += 1) {
    assertLocatorLayerPolicy(decoded)
    for (let index = decoded.indexOf('%'); index !== -1; index = decoded.indexOf('%', index + 3)) {
      if (!/^[a-f0-9]{2}$/iu.test(decoded.slice(index + 1, index + 3))) {
        contractError('invalid_contract', 'locator')
      }
    }
    if (/%(?:0[0-9a-f]|1[0-9a-f]|23|25|2f|3a|3f|40|5c|7f)/iu.test(decoded)) {
      contractError('invalid_contract', 'locator')
    }
    if (!decoded.includes('%')) return
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      contractError('invalid_contract', 'locator')
    }
    if (
      (!decoded.includes('@') && next.includes('@'))
      || (!decoded.includes('?') && next.includes('?'))
      || (!decoded.includes('#') && next.includes('#'))
    ) {
      contractError('invalid_contract', 'locator')
    }
    if (next === decoded) return
    decoded = next
  }
  if (decoded.includes('%')) contractError('invalid_contract', 'locator')
}

function normalizeNonUrlSlashes(value: string, scheme: string | undefined): string {
  if (scheme === undefined) return value.replace(/\/{2,}/gu, '/')
  const colon = value.indexOf(':')
  const prefix = value.slice(0, colon + 1)
  const remainder = value.slice(colon + 1)
  if (!remainder.startsWith('//')) return `${prefix}${remainder.replace(/\/{2,}/gu, '/')}`
  return `${prefix}//${remainder.slice(2).replace(/\/{2,}/gu, '/')}`
}

export function normalizeKnowledgeLocator(value: unknown): string {
  const supplied = safeText(
    value,
    'invalid_contract',
    'locator',
    MAX_LOCATOR_CHARACTERS,
  )
  const forwardSlashes = supplied.replaceAll('\\', '/')
  const scheme = locatorScheme(forwardSlashes)
  let normalized = forwardSlashes
  assertSafeLocatorEncoding(normalized)
  if (scheme !== undefined && URL_LOCATOR_SCHEMES.has(scheme)) {
    normalized = parseRecognizedLocator(normalized, scheme).href
  } else {
    normalized = normalizeNonUrlSlashes(normalized, scheme)
  }
  assertSafeLocatorEncoding(normalized)
  if (normalized.length > MAX_LOCATOR_CHARACTERS) {
    contractError('invalid_contract', 'locator')
  }
  return normalized
}

export function validateKnowledgeSourceRange(value: unknown): KnowledgeSourceRange {
  const record = safeRecord(value, 'invalid_range', 'source_range')
  exactKeys(
    record,
    ['start_line', 'end_line', 'start_byte', 'end_byte'],
    [],
    'invalid_range',
    'source_range',
  )
  const startLine = nullableInteger(record.start_line, 'invalid_range', 'start_line', 1)
  const endLine = nullableInteger(record.end_line, 'invalid_range', 'end_line', 1)
  const startByte = nullableInteger(record.start_byte, 'invalid_range', 'start_byte', 0)
  const endByte = nullableInteger(record.end_byte, 'invalid_range', 'end_byte', 0)

  if ((startLine === null) !== (endLine === null)) contractError('invalid_range', 'line_range')
  if (startLine !== null && endLine !== null && endLine < startLine) {
    contractError('invalid_range', 'line_range')
  }
  if ((startByte === null) !== (endByte === null)) contractError('invalid_range', 'byte_range')
  if (startByte !== null && endByte !== null && endByte <= startByte) {
    contractError('invalid_range', 'byte_range')
  }
  return {
    start_line: startLine,
    end_line: endLine,
    start_byte: startByte,
    end_byte: endByte,
  }
}

export function validateKnowledgeAccessScope(value: unknown): KnowledgeAccessScope {
  const record = safeRecord(value, 'invalid_scope', 'access_scope')
  const kind = record.kind
  if (kind === 'board') {
    exactKeys(record, ['kind'], [], 'invalid_scope', 'access_scope')
    return { kind }
  }
  if (kind === 'workspace') {
    exactKeys(record, ['kind', 'workspace_id'], [], 'invalid_scope', 'access_scope')
    return {
      kind,
      workspace_id: safeText(record.workspace_id, 'invalid_scope', 'workspace_id'),
    }
  }
  if (kind === 'contract') {
    exactKeys(
      record,
      ['kind', 'card_id', 'contract_version'],
      [],
      'invalid_scope',
      'access_scope',
    )
    return {
      kind,
      card_id: integer(record.card_id, 'invalid_scope', 'card_id', 1),
      contract_version: integer(
        record.contract_version,
        'invalid_scope',
        'contract_version',
        1,
      ),
    }
  }
  if (kind === 'job') {
    exactKeys(record, ['kind', 'job_id'], [], 'invalid_scope', 'access_scope')
    return { kind, job_id: safeText(record.job_id, 'invalid_scope', 'job_id') }
  }
  if (kind === 'profile') {
    exactKeys(record, ['kind', 'profile_id'], [], 'invalid_scope', 'access_scope')
    return { kind, profile_id: safeText(record.profile_id, 'invalid_scope', 'profile_id') }
  }
  if (kind === 'session') {
    exactKeys(record, ['kind', 'session_id'], [], 'invalid_scope', 'access_scope')
    return { kind, session_id: safeText(record.session_id, 'invalid_scope', 'session_id') }
  }
  contractError('invalid_scope', 'access_scope')
}

function relativeRepositoryRoot(value: unknown): string {
  const root = safeText(
    value,
    'invalid_provenance',
    'relative_root',
    MAX_LOCATOR_CHARACTERS,
  )
  if (root === '.') return root
  if (
    root.startsWith('/')
    || root.startsWith('\\')
    || root.includes('\\')
    || /^[a-zA-Z]:/u.test(root)
  ) {
    contractError('invalid_provenance', 'relative_root')
  }
  const segments = root.split('/')
  if (
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    contractError('invalid_provenance', 'relative_root')
  }
  return root
}

export function validateRepositoryProvenance(value: unknown): RepositoryProvenance {
  const record = safeRecord(value, 'invalid_provenance', 'provenance')
  exactKeys(
    record,
    [
      'repository_key',
      'base_commit_sha',
      'worktree_state_hash',
      'relative_root',
      'adapter_id',
      'adapter_version',
      'adapter_index_commit_sha',
      'observed_at',
    ],
    [],
    'invalid_provenance',
    'provenance',
  )
  if (typeof record.base_commit_sha !== 'string' || !COMMIT_SHA.test(record.base_commit_sha)) {
    contractError('invalid_provenance', 'base_commit_sha')
  }
  return {
    repository_key: safeText(
      record.repository_key,
      'invalid_provenance',
      'repository_key',
    ),
    base_commit_sha: record.base_commit_sha,
    worktree_state_hash: nullableSha256(
      record.worktree_state_hash,
      'invalid_provenance',
      'worktree_state_hash',
    ),
    relative_root: relativeRepositoryRoot(record.relative_root),
    adapter_id: safeText(record.adapter_id, 'invalid_provenance', 'adapter_id'),
    adapter_version: safeText(
      record.adapter_version,
      'invalid_provenance',
      'adapter_version',
    ),
    adapter_index_commit_sha: nullableCommitSha(
      record.adapter_index_commit_sha,
      'invalid_provenance',
      'adapter_index_commit_sha',
    ),
    observed_at: isoTimestamp(record.observed_at, 'invalid_provenance', 'observed_at'),
  }
}

export function validateKnowledgeTargetLinks(value: unknown): KnowledgeTargetLinks {
  const record = safeRecord(value, 'invalid_targets', 'targets')
  exactKeys(
    record,
    [
      'board_id',
      'workspace_id',
      'card_id',
      'contract_ref',
      'contract_version',
      'contract_snapshot_sha256',
      'job_id',
      'profile_id',
      'session_id',
      'delivery_report_id',
    ],
    [],
    'invalid_targets',
    'targets',
  )
  const cardId = nullableInteger(record.card_id, 'invalid_targets', 'card_id', 1)
  const contractRef = nullableSafeText(record.contract_ref, 'invalid_targets', 'contract_ref')
  const contractVersion = nullableInteger(
    record.contract_version,
    'invalid_targets',
    'contract_version',
    1,
  )
  const contractSnapshot = nullableSha256(
    record.contract_snapshot_sha256,
    'invalid_targets',
    'contract_snapshot_sha256',
  )
  const contractValues = [contractRef, contractVersion, contractSnapshot]
  if (contractValues.some((part) => part !== null)) {
    if (
      cardId === null
      || contractRef === null
      || contractVersion === null
      || contractSnapshot === null
      || contractRef !== `card:${cardId}:v${contractVersion}`
    ) {
      contractError('invalid_targets', 'contract_target')
    }
  }
  return {
    board_id: integer(record.board_id, 'invalid_targets', 'board_id', 1),
    workspace_id: nullableSafeText(record.workspace_id, 'invalid_targets', 'workspace_id'),
    card_id: cardId,
    contract_ref: contractRef,
    contract_version: contractVersion,
    contract_snapshot_sha256: contractSnapshot,
    job_id: nullableSafeText(record.job_id, 'invalid_targets', 'job_id'),
    profile_id: nullableSafeText(record.profile_id, 'invalid_targets', 'profile_id'),
    session_id: nullableSafeText(record.session_id, 'invalid_targets', 'session_id'),
    delivery_report_id: nullableSafeText(
      record.delivery_report_id,
      'invalid_targets',
      'delivery_report_id',
    ),
  }
}

function validateBudgetLimit(
  value: unknown,
  code: 'invalid_budget' | 'budget_exceeded',
  field: string,
): ContextBudgetLimit {
  const record = safeRecord(value, code, field)
  exactKeys(record, ['max_tokens', 'max_characters'], [], code, field)
  return {
    max_tokens: integer(
      record.max_tokens,
      code,
      field,
      0,
      MAX_CONTEXT_BUDGET_TOKENS,
    ),
    max_characters: integer(
      record.max_characters,
      code,
      field,
      0,
      MAX_CONTEXT_BUDGET_CHARACTERS,
    ),
  }
}

export function validateContextBudget(value: unknown): ContextBudget {
  const record = safeRecord(value, 'invalid_budget', 'budget')
  exactKeys(
    record,
    ['max_tokens', 'max_characters', 'sections'],
    [],
    'invalid_budget',
    'budget',
  )
  const total = validateBudgetLimit(
    { max_tokens: record.max_tokens, max_characters: record.max_characters },
    'invalid_budget',
    'budget',
  )
  const rawSections = safeRecord(record.sections, 'invalid_budget', 'budget.sections')
  if (Object.keys(rawSections).some((section) => !CONTEXT_SECTION_SET.has(section))) {
    contractError('invalid_budget', 'budget.sections')
  }
  const sections: Partial<Record<ContextSection, ContextBudgetLimit>> = {}
  for (const section of CONTEXT_SECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(rawSections, section)) continue
    const limit = validateBudgetLimit(
      rawSections[section],
      'invalid_budget',
      'budget.sections',
    )
    if (
      limit.max_tokens > total.max_tokens
      || limit.max_characters > total.max_characters
    ) {
      contractError('invalid_budget', 'budget.sections')
    }
    sections[section] = limit
  }
  return { ...total, sections }
}

function validateUsageSection(value: unknown): ContextBudgetUsageSection {
  const record = safeRecord(value, 'budget_exceeded', 'usage.sections')
  exactKeys(
    record,
    ['used_tokens', 'used_characters'],
    [],
    'budget_exceeded',
    'usage.sections',
  )
  return {
    used_tokens: integer(
      record.used_tokens,
      'budget_exceeded',
      'usage.sections',
      0,
      MAX_CONTEXT_BUDGET_TOKENS,
    ),
    used_characters: integer(
      record.used_characters,
      'budget_exceeded',
      'usage.sections',
      0,
      MAX_CONTEXT_BUDGET_CHARACTERS,
    ),
  }
}

export function validateContextBudgetUsage(
  value: unknown,
  budgetValue: unknown,
): ContextBudgetUsage {
  const budget = validateContextBudget(budgetValue)
  const record = safeRecord(value, 'budget_exceeded', 'usage')
  exactKeys(
    record,
    ['used_tokens', 'used_characters', 'sections'],
    [],
    'budget_exceeded',
    'usage',
  )
  const usedTokens = integer(
    record.used_tokens,
    'budget_exceeded',
    'usage',
    0,
    MAX_CONTEXT_BUDGET_TOKENS,
  )
  const usedCharacters = integer(
    record.used_characters,
    'budget_exceeded',
    'usage',
    0,
    MAX_CONTEXT_BUDGET_CHARACTERS,
  )
  if (usedTokens > budget.max_tokens || usedCharacters > budget.max_characters) {
    contractError('budget_exceeded', 'usage')
  }

  const rawSections = safeRecord(record.sections, 'budget_exceeded', 'usage.sections')
  if (Object.keys(rawSections).some((section) => !CONTEXT_SECTION_SET.has(section))) {
    contractError('budget_exceeded', 'usage.sections')
  }
  const sections: Partial<Record<ContextSection, ContextBudgetUsageSection>> = {}
  let sectionTokens = 0
  let sectionCharacters = 0
  for (const section of CONTEXT_SECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(rawSections, section)) continue
    const usage = validateUsageSection(rawSections[section])
    const sectionBudget = budget.sections[section]
    if (
      sectionBudget !== undefined
      && (
        usage.used_tokens > sectionBudget.max_tokens
        || usage.used_characters > sectionBudget.max_characters
      )
    ) {
      contractError('budget_exceeded', 'usage.sections')
    }
    sectionTokens += usage.used_tokens
    sectionCharacters += usage.used_characters
    if (!Number.isSafeInteger(sectionTokens) || !Number.isSafeInteger(sectionCharacters)) {
      contractError('budget_exceeded', 'usage.sections')
    }
    sections[section] = usage
  }
  // The total may be greater than section sums because rendering adds wrappers.
  if (sectionTokens > usedTokens || sectionCharacters > usedCharacters) {
    contractError('budget_exceeded', 'usage.sections')
  }
  return { used_tokens: usedTokens, used_characters: usedCharacters, sections }
}

function validateOrderingCandidate(value: unknown): ContextOrderingCandidate {
  const record = safeRecord(value, 'invalid_contract', 'ordering_candidate')
  exactKeys(
    record,
    [
      'chunk_id',
      'section',
      'pinned',
      'authority_rank',
      'score_micros',
      'source_kind',
      'locator',
      'start_line',
    ],
    [],
    'invalid_contract',
    'ordering_candidate',
  )
  if (typeof record.pinned !== 'boolean') {
    contractError('invalid_contract', 'ordering_candidate')
  }
  return {
    chunk_id: prefixedHash(
      record.chunk_id,
      CHUNK_ID,
      'invalid_contract',
      'ordering_candidate',
    ),
    section: enumValue<ContextSection>(
      record.section,
      CONTEXT_SECTION_SET,
      'invalid_contract',
      'ordering_candidate',
    ),
    pinned: record.pinned,
    authority_rank: integer(
      record.authority_rank,
      'invalid_contract',
      'ordering_candidate',
      0,
      MAX_RANK,
    ),
    score_micros: integer(
      record.score_micros,
      'invalid_contract',
      'ordering_candidate',
      -MAX_SCORE_ABS,
      MAX_SCORE_ABS,
    ),
    source_kind: enumValue<KnowledgeSourceKind>(
      record.source_kind,
      SOURCE_KIND_SET,
      'invalid_contract',
      'ordering_candidate',
    ),
    locator: normalizeKnowledgeLocator(record.locator),
    start_line: nullableInteger(
      record.start_line,
      'invalid_contract',
      'ordering_candidate',
      1,
    ),
  }
}

function compareDescending(left: number, right: number): number {
  if (left === right) return 0
  return left > right ? -1 : 1
}

const SECTION_RANK = new Map(CONTEXT_SECTIONS.map((section, index) => [section, index]))
const SOURCE_KIND_RANK = new Map(
  KNOWLEDGE_SOURCE_KINDS.map((sourceKind, index) => [sourceKind, index]),
)

/**
 * Returns normalized copies in deterministic order and never mutates callers.
 */
export function orderContextCandidates(
  values: readonly ContextOrderingCandidate[],
): ContextOrderingCandidate[] {
  const candidates = denseContractArray(
    values,
    'invalid_contract',
    'ordering_candidates',
  ).map(validateOrderingCandidate)
  const chunkIds = new Set<string>()
  for (const candidate of candidates) {
    if (chunkIds.has(candidate.chunk_id)) {
      contractError('duplicate_identity', 'ordering_candidates')
    }
    chunkIds.add(candidate.chunk_id)
  }
  return candidates.sort((left, right) => {
    const section = (SECTION_RANK.get(left.section) ?? Number.MAX_SAFE_INTEGER)
      - (SECTION_RANK.get(right.section) ?? Number.MAX_SAFE_INTEGER)
    if (section !== 0) return section
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    const authority = compareDescending(left.authority_rank, right.authority_rank)
    if (authority !== 0) return authority
    const score = compareDescending(left.score_micros, right.score_micros)
    if (score !== 0) return score
    const sourceKind = (SOURCE_KIND_RANK.get(left.source_kind) ?? Number.MAX_SAFE_INTEGER)
      - (SOURCE_KIND_RANK.get(right.source_kind) ?? Number.MAX_SAFE_INTEGER)
    if (sourceKind !== 0) return sourceKind
    const locator = compareCodeUnits(left.locator, right.locator)
    if (locator !== 0) return locator
    if (left.start_line !== right.start_line) {
      if (left.start_line === null) return 1
      if (right.start_line === null) return -1
      return left.start_line - right.start_line
    }
    return compareCodeUnits(left.chunk_id, right.chunk_id)
  })
}

function validateScoreComponents(value: unknown): {
  components: ContextScoreComponents
  total: number
} {
  const record = safeRecord(value, 'invalid_manifest', 'score_components')
  const fields = [
    'authority_micros',
    'relevance_micros',
    'freshness_micros',
    'recency_micros',
    'contract_micros',
    'pin_micros',
  ] as const
  exactKeys(record, fields, [], 'invalid_manifest', 'score_components')
  const components = Object.fromEntries(fields.map((field) => [
    field,
    integer(
      record[field],
      'invalid_manifest',
      'score_components',
      -MAX_SCORE_ABS,
      MAX_SCORE_ABS,
    ),
  ])) as unknown as ContextScoreComponents
  const total = fields.reduce((sum, field) => sum + components[field], 0)
  if (!Number.isSafeInteger(total) || Math.abs(total) > MAX_SCORE_ABS) {
    contractError('invalid_manifest', 'score_components')
  }
  return { components, total }
}

export function validateContextBuildEntry(value: unknown): ContextBuildEntry {
  const record = safeRecord(value, 'invalid_manifest', 'manifest_entry')
  exactKeys(
    record,
    [
      'source_id',
      'chunk_id',
      'section',
      'candidate_ordinal',
      'selected_ordinal',
      'decision',
      'reason',
      'score_components',
      'score_micros',
      'rendering',
      'estimated_tokens',
      'character_count',
      'source_kind',
      'trust_class',
      'freshness_state',
      'redaction_state',
      'normalized_locator',
      'source_range',
      'content_sha256',
    ],
    [],
    'invalid_manifest',
    'manifest_entry',
  )
  const decision = enumValue<'selected' | 'omitted'>(
    record.decision,
    new Set(['selected', 'omitted']),
    'invalid_manifest',
    'manifest_entry',
  )
  const reason = enumValue<ContextBuildEntry['reason']>(
    record.reason,
    SELECTION_REASON_SET,
    'invalid_manifest',
    'manifest_entry',
  )
  const rendering = enumValue<ContextBuildEntry['rendering']>(
    record.rendering,
    new Set(['full', 'truncated', 'summary', 'none']),
    'invalid_manifest',
    'manifest_entry',
  )
  const selectedOrdinal = nullableInteger(
    record.selected_ordinal,
    'invalid_manifest',
    'manifest_entry',
    0,
    MAX_CONTRACT_COLLECTION_ENTRIES - 1,
  )
  const estimatedTokens = integer(
    record.estimated_tokens,
    'invalid_manifest',
    'manifest_entry',
    0,
    MAX_CONTEXT_BUDGET_TOKENS,
  )
  const characterCount = integer(
    record.character_count,
    'invalid_manifest',
    'manifest_entry',
    0,
    MAX_CONTEXT_BUDGET_CHARACTERS,
  )
  const { components, total } = validateScoreComponents(record.score_components)
  const scoreMicros = integer(
    record.score_micros,
    'invalid_manifest',
    'manifest_entry',
    -MAX_SCORE_ABS,
    MAX_SCORE_ABS,
  )
  if (scoreMicros !== total) contractError('invalid_manifest', 'score_micros')
  if (decision === 'selected') {
    if (
      selectedOrdinal === null
      || rendering === 'none'
      || estimatedTokens === 0
      || characterCount === 0
      || (reason !== 'within_budget' && reason !== 'pinned')
    ) {
      contractError('invalid_manifest', 'selection')
    }
  } else if (
    selectedOrdinal !== null
    || rendering !== 'none'
    || estimatedTokens !== 0
    || characterCount !== 0
    || reason === 'within_budget'
    || reason === 'pinned'
  ) {
    contractError('invalid_manifest', 'selection')
  }

  const redactionState = enumValue<KnowledgeRedactionState>(
    record.redaction_state,
    REDACTION_STATE_SET,
    'invalid_manifest',
    'redaction_state',
  )
  if (
    (redactionState === 'withheld' && (decision !== 'omitted' || reason !== 'withheld'))
    || (reason === 'withheld' && redactionState !== 'withheld')
  ) {
    contractError('invalid_manifest', 'redaction_state')
  }
  return {
    source_id: prefixedHash(record.source_id, SOURCE_ID, 'invalid_manifest', 'source_id'),
    chunk_id: prefixedHash(record.chunk_id, CHUNK_ID, 'invalid_manifest', 'chunk_id'),
    section: enumValue<ContextSection>(
      record.section,
      CONTEXT_SECTION_SET,
      'invalid_manifest',
      'section',
    ),
    candidate_ordinal: integer(
      record.candidate_ordinal,
      'invalid_manifest',
      'candidate_ordinal',
      0,
      MAX_CONTRACT_COLLECTION_ENTRIES - 1,
    ),
    selected_ordinal: selectedOrdinal,
    decision,
    reason,
    score_components: components,
    score_micros: scoreMicros,
    rendering,
    estimated_tokens: estimatedTokens,
    character_count: characterCount,
    source_kind: enumValue<KnowledgeSourceKind>(
      record.source_kind,
      SOURCE_KIND_SET,
      'invalid_manifest',
      'source_kind',
    ),
    trust_class: enumValue<KnowledgeTrustClass>(
      record.trust_class,
      TRUST_CLASS_SET,
      'invalid_manifest',
      'trust_class',
    ),
    freshness_state: enumValue<KnowledgeFreshnessState>(
      record.freshness_state,
      FRESHNESS_STATE_SET,
      'invalid_manifest',
      'freshness_state',
    ),
    redaction_state: redactionState,
    normalized_locator: normalizeKnowledgeLocator(record.normalized_locator),
    source_range: validateKnowledgeSourceRange(record.source_range),
    content_sha256: sha256(
      record.content_sha256,
      'invalid_manifest',
      'content_sha256',
    ),
  }
}

function normalizedContextManifest(value: unknown): ContextBuildEntry[] {
  const entries = denseContractArray(value, 'invalid_manifest', 'manifest')
    .map(validateContextBuildEntry)
    .sort((left, right) => left.candidate_ordinal - right.candidate_ordinal)
  const chunkIds = new Set<string>()
  let selectedOrdinal = 0
  for (let candidateOrdinal = 0; candidateOrdinal < entries.length; candidateOrdinal += 1) {
    const entry = entries[candidateOrdinal]
    if (entry.candidate_ordinal !== candidateOrdinal) {
      contractError('invalid_manifest', 'candidate_ordinal')
    }
    if (chunkIds.has(entry.chunk_id)) {
      contractError('duplicate_identity', 'manifest')
    }
    chunkIds.add(entry.chunk_id)
    if (entry.decision === 'selected') {
      if (entry.selected_ordinal !== selectedOrdinal) {
        contractError('invalid_manifest', 'selected_ordinal')
      }
      selectedOrdinal += 1
    }
  }
  return entries
}

export function contextManifestFingerprint(values: readonly ContextBuildEntry[]): string {
  const entries = normalizedContextManifest(values)
  return canonicalKnowledgeHash('context-manifest', entries)
}

/**
 * Closes the accounting boundary between selected manifest entries and the
 * caller-reported usage. Section usage must exactly equal selected content;
 * total usage may additionally include deterministic rendering wrappers.
 */
export function validateContextBuildAccounting(
  entriesValue: readonly ContextBuildEntry[],
  usageValue: unknown,
  budgetValue: unknown,
): ContextBuildAccounting {
  const budget = validateContextBudget(budgetValue)
  const entries = normalizedContextManifest(entriesValue)
  const usage = validateContextBudgetUsage(usageValue, budget)
  const contributions = new Map<ContextSection, ContextBudgetUsageSection>()
  for (const section of CONTEXT_SECTIONS) {
    contributions.set(section, { used_tokens: 0, used_characters: 0 })
  }
  for (const entry of entries) {
    if (entry.decision !== 'selected') continue
    const section = contributions.get(entry.section)
    if (section === undefined) contractError('invalid_manifest', 'section')
    section.used_tokens += entry.estimated_tokens
    section.used_characters += entry.character_count
    if (
      !Number.isSafeInteger(section.used_tokens)
      || !Number.isSafeInteger(section.used_characters)
      || section.used_tokens > MAX_CONTEXT_BUDGET_TOKENS
      || section.used_characters > MAX_CONTEXT_BUDGET_CHARACTERS
    ) {
      contractError('budget_exceeded', 'manifest_contributions')
    }
  }
  for (const section of CONTEXT_SECTIONS) {
    const expected = contributions.get(section)
    const actual = usage.sections[section]
    if (
      expected === undefined
      || (actual?.used_tokens ?? 0) !== expected.used_tokens
      || (actual?.used_characters ?? 0) !== expected.used_characters
    ) {
      contractError('budget_exceeded', 'manifest_contributions')
    }
  }
  return {
    budget,
    usage,
    entries,
    manifest_fingerprint: canonicalKnowledgeHash('context-manifest', entries),
  }
}

function validateSourceSetEntry(value: unknown): KnowledgeSourceSetEntry {
  const record = safeRecord(value, 'invalid_contract', 'source_set')
  exactKeys(
    record,
    [
      'source_id',
      'source_revision',
      'content_sha256',
      'freshness_state',
      'redaction_state',
    ],
    [],
    'invalid_contract',
    'source_set',
  )
  return {
    source_id: prefixedHash(record.source_id, SOURCE_ID, 'invalid_contract', 'source_id'),
    source_revision: safeText(
      record.source_revision,
      'invalid_contract',
      'source_revision',
      MAX_REVISION_CHARACTERS,
    ),
    content_sha256: sha256(record.content_sha256, 'invalid_contract', 'content_sha256'),
    freshness_state: enumValue<KnowledgeFreshnessState>(
      record.freshness_state,
      FRESHNESS_STATE_SET,
      'invalid_contract',
      'freshness_state',
    ),
    redaction_state: enumValue<KnowledgeRedactionState>(
      record.redaction_state,
      REDACTION_STATE_SET,
      'invalid_contract',
      'redaction_state',
    ),
  }
}

export function knowledgeSourceSetFingerprint(
  values: readonly KnowledgeSourceSetEntry[],
): string {
  const entries = denseContractArray(values, 'invalid_contract', 'source_set')
    .map(validateSourceSetEntry)
    .sort((left, right) => compareCodeUnits(left.source_id, right.source_id))
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].source_id === entries[index].source_id) {
      contractError('duplicate_identity', 'source_set')
    }
  }
  return canonicalKnowledgeHash('source-set', entries)
}

export function validateContextRequestIdentity(value: unknown): ContextRequestIdentityInput {
  const record = safeRecord(value, 'invalid_contract', 'context_request')
  exactKeys(
    record,
    ['board_id', 'access_scope', 'targets', 'budget', 'selection_request_sha256'],
    [],
    'invalid_contract',
    'context_request',
  )
  const boardId = integer(record.board_id, 'invalid_contract', 'board_id', 1)
  const accessScope = validateKnowledgeAccessScope(record.access_scope)
  const targets = validateKnowledgeTargetLinks(record.targets)
  const budget = validateContextBudget(record.budget)
  if (targets.board_id !== boardId) contractError('invalid_contract', 'context_request_scope')
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
    contractError('invalid_contract', 'context_request_scope')
  }
  return {
    board_id: boardId,
    access_scope: accessScope,
    targets,
    budget,
    selection_request_sha256: sha256(
      record.selection_request_sha256,
      'invalid_contract',
      'selection_request_sha256',
    ),
  }
}

export function contextRequestFingerprint(value: ContextRequestIdentityInput): string {
  return canonicalKnowledgeHash(
    'context-request',
    validateContextRequestIdentity(value),
  )
}

function validateSourceIdentity(value: unknown): KnowledgeSourceIdentityInput {
  const record = safeRecord(value, 'invalid_contract', 'source_identity')
  exactKeys(
    record,
    [
      'repository_key',
      'source_kind',
      'normalized_locator',
      'source_revision',
      'content_sha256',
    ],
    [],
    'invalid_contract',
    'source_identity',
  )
  const locator = normalizeKnowledgeLocator(record.normalized_locator)
  if (locator !== record.normalized_locator) {
    contractError('invalid_contract', 'normalized_locator')
  }
  return {
    repository_key: safeText(record.repository_key, 'invalid_contract', 'repository_key'),
    source_kind: enumValue<KnowledgeSourceKind>(
      record.source_kind,
      SOURCE_KIND_SET,
      'invalid_contract',
      'source_kind',
    ),
    normalized_locator: locator,
    source_revision: safeText(
      record.source_revision,
      'invalid_contract',
      'source_revision',
      MAX_REVISION_CHARACTERS,
    ),
    content_sha256: sha256(record.content_sha256, 'invalid_contract', 'content_sha256'),
  }
}

export function knowledgeSourceId(value: KnowledgeSourceIdentityInput): string {
  return `ks_${canonicalKnowledgeHash('source', validateSourceIdentity(value))}`
}

function validateChunkIdentity(value: unknown): KnowledgeChunkIdentityInput {
  const record = safeRecord(value, 'invalid_contract', 'chunk_identity')
  exactKeys(
    record,
    ['source_id', 'ordinal', 'content_sha256', 'source_range'],
    [],
    'invalid_contract',
    'chunk_identity',
  )
  return {
    source_id: prefixedHash(record.source_id, SOURCE_ID, 'invalid_contract', 'source_id'),
    ordinal: integer(record.ordinal, 'invalid_contract', 'ordinal', 0),
    content_sha256: sha256(record.content_sha256, 'invalid_contract', 'content_sha256'),
    source_range: validateKnowledgeSourceRange(record.source_range),
  }
}

export function knowledgeChunkId(value: KnowledgeChunkIdentityInput): string {
  return `kc_${canonicalKnowledgeHash('chunk', validateChunkIdentity(value))}`
}

function validateContextBuildIdentity(value: unknown): ContextBuildIdentityInput {
  const record = safeRecord(value, 'invalid_contract', 'context_build_identity')
  exactKeys(
    record,
    ['request', 'source_set_fingerprint', 'manifest_fingerprint'],
    [],
    'invalid_contract',
    'context_build_identity',
  )
  return {
    request: validateContextRequestIdentity(record.request),
    source_set_fingerprint: sha256(
      record.source_set_fingerprint,
      'invalid_contract',
      'source_set_fingerprint',
    ),
    manifest_fingerprint: sha256(
      record.manifest_fingerprint,
      'invalid_contract',
      'manifest_fingerprint',
    ),
  }
}

export function contextBuildId(value: ContextBuildIdentityInput): string {
  const identity = validateContextBuildIdentity(value)
  return `cb_${canonicalKnowledgeHash('context-build', {
    request_fingerprint: contextRequestFingerprint(identity.request),
    source_set_fingerprint: identity.source_set_fingerprint,
    manifest_fingerprint: identity.manifest_fingerprint,
  })}`
}

function validateContextUseIdentity(value: unknown): ContextUseIdentityInput {
  const record = safeRecord(value, 'invalid_contract', 'context_use_identity')
  exactKeys(
    record,
    ['context_build_id', 'job_id', 'session_id', 'injection_ordinal'],
    [],
    'invalid_contract',
    'context_use_identity',
  )
  return {
    context_build_id: prefixedHash(
      record.context_build_id,
      CONTEXT_BUILD_ID,
      'invalid_contract',
      'context_build_id',
    ),
    job_id: safeText(record.job_id, 'invalid_contract', 'job_id'),
    session_id: safeText(record.session_id, 'invalid_contract', 'session_id'),
    injection_ordinal: integer(
      record.injection_ordinal,
      'invalid_contract',
      'injection_ordinal',
      0,
    ),
  }
}

export function contextUseId(value: ContextUseIdentityInput): string {
  return `cu_${canonicalKnowledgeHash('context-use', validateContextUseIdentity(value))}`
}

const USE_ID = /^cu_[a-f0-9]{64}$/u
const CONTEXT_BUILD_STATUS_SET = new Set<string>([
  'built',
  'used',
  'invalidated',
  'failed',
])
const CONTEXT_USE_OUTCOME_SET = new Set<string>([
  'running',
  'completed',
  'failed',
  'cancelled',
])

function assertScopeTargets(
  boardId: number,
  accessScope: KnowledgeAccessScope,
  targets: KnowledgeTargetLinks,
): void {
  if (targets.board_id !== boardId) contractError('invalid_contract', 'scope_targets')
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
    contractError('invalid_contract', 'scope_targets')
  }
}

/**
 * Strict runtime validation for a fully-materialized durable knowledge source.
 * Supplied locators are always normalized again so an unsafe raw locator cannot
 * hide behind a separately supplied normalized value.
 */
export function validateKnowledgeSource(value: unknown): KnowledgeSource {
  const record = safeRecord(value, 'invalid_contract', 'knowledge_source')
  exactKeys(
    record,
    [
      'id',
      'source_kind',
      'trust_class',
      'title',
      'locator',
      'normalized_locator',
      'source_revision',
      'content_sha256',
      'freshness_policy',
      'freshness_state',
      'redaction_state',
      'content_state',
      'ingest_state',
      'access_scope',
      'targets',
      'provenance',
      'created_at',
      'updated_at',
    ],
    [],
    'invalid_contract',
    'knowledge_source',
  )
  const sourceKind = enumValue<KnowledgeSourceKind>(
    record.source_kind,
    SOURCE_KIND_SET,
    'invalid_contract',
    'source_kind',
  )
  const locator = safeText(
    record.locator,
    'invalid_contract',
    'locator',
    MAX_LOCATOR_CHARACTERS,
  )
  const normalizedLocator = normalizeKnowledgeLocator(locator)
  if (record.normalized_locator !== normalizedLocator) {
    contractError('invalid_contract', 'normalized_locator')
  }
  const contentSha256 = sha256(
    record.content_sha256,
    'invalid_contract',
    'content_sha256',
  )
  const accessScope = validateKnowledgeAccessScope(record.access_scope)
  const targets = validateKnowledgeTargetLinks(record.targets)
  const provenance = validateRepositoryProvenance(record.provenance)
  assertScopeTargets(targets.board_id, accessScope, targets)
  const redactionState = enumValue<KnowledgeRedactionState>(
    record.redaction_state,
    REDACTION_STATE_SET,
    'invalid_contract',
    'redaction_state',
  )
  const contentState = enumValue<KnowledgeSource['content_state']>(
    record.content_state,
    CONTENT_STATE_SET,
    'invalid_contract',
    'content_state',
  )
  if (
    (redactionState === 'withheld' && contentState === 'present')
    || (contentState === 'withheld' && redactionState !== 'withheld')
  ) {
    contractError('invalid_contract', 'redaction_content_state')
  }
  const ingestState = enumValue<KnowledgeSource['ingest_state']>(
    record.ingest_state,
    INGEST_STATE_SET,
    'invalid_contract',
    'ingest_state',
  )
  if (ingestState === 'forgotten' && contentState !== 'purged') {
    contractError('invalid_contract', 'ingest_content_state')
  }
  const createdAt = isoTimestamp(record.created_at, 'invalid_contract', 'created_at')
  const updatedAt = isoTimestamp(record.updated_at, 'invalid_contract', 'updated_at')
  if (updatedAt < createdAt) contractError('invalid_contract', 'updated_at')

  const source: KnowledgeSource = {
    id: prefixedHash(record.id, SOURCE_ID, 'invalid_contract', 'source_id'),
    source_kind: sourceKind,
    trust_class: enumValue<KnowledgeTrustClass>(
      record.trust_class,
      TRUST_CLASS_SET,
      'invalid_contract',
      'trust_class',
    ),
    title: safeText(
      record.title,
      'invalid_contract',
      'title',
      MAX_LOCATOR_CHARACTERS,
    ),
    locator,
    normalized_locator: normalizedLocator,
    source_revision: safeText(
      record.source_revision,
      'invalid_contract',
      'source_revision',
      MAX_REVISION_CHARACTERS,
    ),
    content_sha256: contentSha256,
    freshness_policy: enumValue<KnowledgeSource['freshness_policy']>(
      record.freshness_policy,
      FRESHNESS_POLICY_SET,
      'invalid_contract',
      'freshness_policy',
    ),
    freshness_state: enumValue<KnowledgeFreshnessState>(
      record.freshness_state,
      FRESHNESS_STATE_SET,
      'invalid_contract',
      'freshness_state',
    ),
    redaction_state: redactionState,
    content_state: contentState,
    ingest_state: ingestState,
    access_scope: accessScope,
    targets,
    provenance,
    created_at: createdAt,
    updated_at: updatedAt,
  }
  const expectedId = knowledgeSourceId({
    repository_key: provenance.repository_key,
    source_kind: sourceKind,
    normalized_locator: normalizedLocator,
    source_revision: source.source_revision,
    content_sha256: contentSha256,
  })
  if (source.id !== expectedId) contractError('invalid_contract', 'source_id')
  return source
}

function validateKnowledgeSymbolReference(value: unknown): KnowledgeSymbolReference {
  const record = safeRecord(value, 'invalid_contract', 'symbol')
  exactKeys(
    record,
    ['language', 'qualified_name', 'symbol_kind', 'signature_sha256'],
    [],
    'invalid_contract',
    'symbol',
  )
  return {
    language: safeText(record.language, 'invalid_contract', 'symbol'),
    qualified_name: safeText(
      record.qualified_name,
      'invalid_contract',
      'symbol',
      MAX_LOCATOR_CHARACTERS,
    ),
    symbol_kind: safeText(record.symbol_kind, 'invalid_contract', 'symbol'),
    signature_sha256: nullableSha256(
      record.signature_sha256,
      'invalid_contract',
      'signature_sha256',
    ),
  }
}

/** Strict runtime validation for a fully-materialized durable knowledge chunk. */
export function validateKnowledgeChunk(value: unknown): KnowledgeChunk {
  const record = safeRecord(value, 'invalid_contract', 'knowledge_chunk')
  exactKeys(
    record,
    [
      'id',
      'source_id',
      'ordinal',
      'content',
      'content_sha256',
      'character_count',
      'byte_count',
      'estimated_tokens',
      'source_range',
      'symbol',
      'created_at',
    ],
    [],
    'invalid_contract',
    'knowledge_chunk',
  )
  if (
    typeof record.content !== 'string'
    || record.content.length === 0
    || record.content.length > MAX_CANONICAL_JSON_LIMITS.max_string_characters
    || Buffer.byteLength(record.content, 'utf8') > MAX_CANONICAL_JSON_LIMITS.max_serialized_bytes
  ) {
    contractError('invalid_contract', 'content')
  }
  const sourceId = prefixedHash(
    record.source_id,
    SOURCE_ID,
    'invalid_contract',
    'source_id',
  )
  const ordinal = integer(record.ordinal, 'invalid_contract', 'ordinal', 0)
  const sourceRange = validateKnowledgeSourceRange(record.source_range)
  const contentSha256 = sha256(
    record.content_sha256,
    'invalid_contract',
    'content_sha256',
  )
  const calculatedHash = createHash('sha256').update(record.content, 'utf8').digest('hex')
  if (contentSha256 !== calculatedHash) contractError('invalid_contract', 'content_sha256')
  if (
    integer(
      record.character_count,
      'invalid_contract',
      'character_count',
      0,
      MAX_CONTEXT_BUDGET_CHARACTERS,
    ) !== record.content.length
    || integer(record.byte_count, 'invalid_contract', 'byte_count', 0)
      !== Buffer.byteLength(record.content, 'utf8')
  ) {
    contractError('invalid_contract', 'content_count')
  }
  const chunk: KnowledgeChunk = {
    id: prefixedHash(record.id, CHUNK_ID, 'invalid_contract', 'chunk_id'),
    source_id: sourceId,
    ordinal,
    content: record.content,
    content_sha256: contentSha256,
    character_count: record.content.length,
    byte_count: Buffer.byteLength(record.content, 'utf8'),
    estimated_tokens: integer(
      record.estimated_tokens,
      'invalid_contract',
      'estimated_tokens',
      0,
      MAX_CONTEXT_BUDGET_TOKENS,
    ),
    source_range: sourceRange,
    symbol: record.symbol === null ? null : validateKnowledgeSymbolReference(record.symbol),
    created_at: isoTimestamp(record.created_at, 'invalid_contract', 'created_at'),
  }
  const expectedId = knowledgeChunkId({
    source_id: sourceId,
    ordinal,
    content_sha256: contentSha256,
    source_range: sourceRange,
  })
  if (chunk.id !== expectedId) contractError('invalid_contract', 'chunk_id')
  return chunk
}

/** Return the canonical, dense manifest representation used for storage. */
export function normalizeContextBuildEntries(
  values: readonly ContextBuildEntry[],
): ContextBuildEntry[] {
  return normalizedContextManifest(values)
}

/** Return the canonical source-set order used for hashing and durable snapshots. */
export function normalizeKnowledgeSourceSet(
  values: readonly KnowledgeSourceSetEntry[],
): KnowledgeSourceSetEntry[] {
  const entries = denseContractArray(values, 'invalid_contract', 'source_set')
    .map(validateSourceSetEntry)
    .sort((left, right) => compareCodeUnits(left.source_id, right.source_id))
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].source_id === entries[index].source_id) {
      contractError('duplicate_identity', 'source_set')
    }
  }
  return entries
}

/** Strict runtime validation for the public ContextBuild projection. */
export function validateContextBuild(value: unknown): ContextBuild {
  const record = safeRecord(value, 'invalid_contract', 'context_build')
  exactKeys(
    record,
    [
      'id',
      'board_id',
      'access_scope',
      'targets',
      'request_fingerprint',
      'source_set_fingerprint',
      'manifest_fingerprint',
      'budget',
      'usage',
      'entries',
      'status',
      'created_at',
      'invalidated_at',
    ],
    [],
    'invalid_contract',
    'context_build',
  )
  const boardId = integer(record.board_id, 'invalid_contract', 'board_id', 1)
  const accessScope = validateKnowledgeAccessScope(record.access_scope)
  const targets = validateKnowledgeTargetLinks(record.targets)
  assertScopeTargets(boardId, accessScope, targets)
  const accounting = validateContextBuildAccounting(
    denseContractArray(record.entries, 'invalid_manifest', 'manifest') as ContextBuildEntry[],
    record.usage,
    record.budget,
  )
  const manifestFingerprint = sha256(
    record.manifest_fingerprint,
    'invalid_contract',
    'manifest_fingerprint',
  )
  if (manifestFingerprint !== accounting.manifest_fingerprint) {
    contractError('invalid_contract', 'manifest_fingerprint')
  }
  const status = enumValue<ContextBuild['status']>(
    record.status,
    CONTEXT_BUILD_STATUS_SET,
    'invalid_contract',
    'status',
  )
  const invalidatedAt = record.invalidated_at === null
    ? null
    : isoTimestamp(record.invalidated_at, 'invalid_contract', 'invalidated_at')
  if ((status === 'invalidated') !== (invalidatedAt !== null)) {
    contractError('invalid_contract', 'invalidated_at')
  }
  const createdAt = isoTimestamp(record.created_at, 'invalid_contract', 'created_at')
  if (invalidatedAt !== null && invalidatedAt < createdAt) {
    contractError('invalid_contract', 'invalidated_at')
  }
  return {
    id: prefixedHash(record.id, CONTEXT_BUILD_ID, 'invalid_contract', 'context_build_id'),
    board_id: boardId,
    access_scope: accessScope,
    targets,
    request_fingerprint: sha256(
      record.request_fingerprint,
      'invalid_contract',
      'request_fingerprint',
    ),
    source_set_fingerprint: sha256(
      record.source_set_fingerprint,
      'invalid_contract',
      'source_set_fingerprint',
    ),
    manifest_fingerprint: manifestFingerprint,
    budget: accounting.budget,
    usage: accounting.usage,
    entries: accounting.entries,
    status,
    created_at: createdAt,
    invalidated_at: invalidatedAt,
  }
}

/** Strict runtime validation for a durable ContextUse lifecycle record. */
export function validateContextUse(value: unknown): ContextUse {
  const record = safeRecord(value, 'invalid_contract', 'context_use')
  exactKeys(
    record,
    [
      'id',
      'context_build_id',
      'board_id',
      'job_id',
      'session_id',
      'injection_ordinal',
      'manifest_fingerprint',
      'estimated_tokens',
      'actual_tokens',
      'cache_identity',
      'outcome',
      'injected_at',
      'completed_at',
    ],
    [],
    'invalid_contract',
    'context_use',
  )
  const contextBuildIdValue = prefixedHash(
    record.context_build_id,
    CONTEXT_BUILD_ID,
    'invalid_contract',
    'context_build_id',
  )
  const jobId = safeText(record.job_id, 'invalid_contract', 'job_id')
  const sessionId = safeText(record.session_id, 'invalid_contract', 'session_id')
  const injectionOrdinal = integer(
    record.injection_ordinal,
    'invalid_contract',
    'injection_ordinal',
    0,
  )
  const outcome = enumValue<ContextUse['outcome']>(
    record.outcome,
    CONTEXT_USE_OUTCOME_SET,
    'invalid_contract',
    'outcome',
  )
  const actualTokens = nullableInteger(
    record.actual_tokens,
    'invalid_contract',
    'actual_tokens',
    0,
    MAX_CONTEXT_BUDGET_TOKENS,
  )
  const injectedAt = isoTimestamp(record.injected_at, 'invalid_contract', 'injected_at')
  const completedAt = record.completed_at === null
    ? null
    : isoTimestamp(record.completed_at, 'invalid_contract', 'completed_at')
  if (
    (outcome === 'running' && (actualTokens !== null || completedAt !== null))
    || (outcome !== 'running' && completedAt === null)
    || (outcome === 'completed' && actualTokens === null)
    || (completedAt !== null && completedAt < injectedAt)
  ) {
    contractError('invalid_contract', 'use_lifecycle')
  }
  const use: ContextUse = {
    id: prefixedHash(record.id, USE_ID, 'invalid_contract', 'context_use_id'),
    context_build_id: contextBuildIdValue,
    board_id: integer(record.board_id, 'invalid_contract', 'board_id', 1),
    job_id: jobId,
    session_id: sessionId,
    injection_ordinal: injectionOrdinal,
    manifest_fingerprint: sha256(
      record.manifest_fingerprint,
      'invalid_contract',
      'manifest_fingerprint',
    ),
    estimated_tokens: integer(
      record.estimated_tokens,
      'invalid_contract',
      'estimated_tokens',
      0,
      MAX_CONTEXT_BUDGET_TOKENS,
    ),
    actual_tokens: actualTokens,
    cache_identity: safeText(
      record.cache_identity,
      'invalid_contract',
      'cache_identity',
      MAX_LOCATOR_CHARACTERS,
    ),
    outcome,
    injected_at: injectedAt,
    completed_at: completedAt,
  }
  const expectedId = contextUseId({
    context_build_id: contextBuildIdValue,
    job_id: jobId,
    session_id: sessionId,
    injection_ordinal: injectionOrdinal,
  })
  if (use.id !== expectedId) contractError('invalid_contract', 'context_use_id')
  return use
}

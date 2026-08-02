import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  prepareSupportCase,
  type DiagnosticsBundleVerificationV1,
  type RedactedDiagnosticsManifestV1,
  type SupportCaseInputV1,
  type SupportCaseV1,
} from './support-workflow.js'
import {
  isWithheldOperationalKey,
  WITHHELD_OPERATIONAL_VALUE,
} from './operations/redaction.js'
import type { OperationsDiagnosticsArtifact } from './operations/diagnostics.js'
import { OPERATIONS_HEALTH_COMPONENTS } from './operations/health.js'
import { OPERATIONS_METRICS } from './operations/metrics.js'
import { REDACTED_STRUCTURED_VALUE } from './agent-os/structured-redaction.js'

const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024
const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const DIAGNOSTICS_FILE = /^orchestra-diagnostics-[A-Za-z0-9-]+\.json\.gz$/
const SUPPORT_CASE_FILE = /^orchestra-support-case-[A-Za-z0-9-]+-[a-f0-9]{12}\.json$/
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:github_pat_|gh[pousr]_|glpat-|xox[baprs]-|sk-)[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|bearer\s+[a-z0-9._~+/-]+|(?:api[_-]?key|authorization|cookie|token|secret|password)\s*[:=]\s*\S+)/i
const PATH_SEPARATOR_OR_URL = /[/\\]/u
const BARE_SENSITIVE_PATH = /(?:^|[\s"'=(])(?:\.env(?:\.[A-Za-z0-9_-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|known_hosts|authorized_keys)(?=$|[\s"',;)])/i
const ROOT_KEYS = [
  'schema_version',
  'created_at',
  'generator',
  'runtime',
  'health',
  'metrics',
  'recent_logs',
  'configuration',
  'exclusions',
] as const
const REQUIRED_EXCLUSIONS = [
  'database',
  'wal',
  'shm',
  'environment',
  'credentials',
  'transcripts',
  'pty_output',
  'approval_parameters',
  'workspaces',
  'source',
  'provider_raw_output',
] as const
const INCLUDED_CATEGORIES = [
  'configuration',
  'health',
  'providers',
  'queue',
  'redacted-errors',
  'runtime',
  'versions',
] as const
const GENERATOR_KEYS = ['version', 'revision'] as const
const GENERATOR_REQUIRED_KEYS = ['version'] as const
const RUNTIME_KEYS = ['node_version', 'platform', 'arch', 'uptime_seconds'] as const
const HEALTH_KEYS = ['status', 'checked_at', 'duration_ms', 'components'] as const
const HEALTH_COMPONENT_KEYS = [
  'component', 'required', 'status', 'reasonCode', 'observedAt', 'latencyMs', 'details',
] as const
const HEALTH_COMPONENT_REQUIRED_KEYS = [
  'component', 'required', 'status', 'observedAt', 'latencyMs', 'details',
] as const
const METRIC_KEYS = ['name', 'value', 'labels', 'observed_at'] as const
const METRIC_LABELS = new Set(['provider', 'result', 'priority', 'component'])
const LOG_KEYS = [
  'timestamp', 'level', 'event', 'outcome', 'component', 'reason_code', 'correlation_id',
  'job_id', 'session_id', 'device_id', 'attributes', 'redactions',
] as const
const LOG_REQUIRED_KEYS = ['timestamp', 'level', 'event', 'attributes', 'redactions'] as const
const CONFIGURATION_KEYS = [
  'authentication', 'remote_exposure', 'stale_remote_authorized_intents',
  'max_active_sessions', 'token', 'workspace_path',
] as const
const NODE_PLATFORMS = new Set([
  'aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd',
])
const HEALTH_STATUSES = new Set(['ready', 'degraded', 'unavailable', 'disabled'])
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const LOG_OUTCOMES = new Set(['allowed', 'denied', 'succeeded', 'failed', 'degraded'])
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EVENT_NAME = /^[a-z][a-z0-9_.-]{0,95}$/
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/

export const SUPPORT_CASE_EXPORT_CONSENT =
  'I_CONSENT_TO_LOCAL_EXPORT_AND_REVIEW_BEFORE_SHARING' as const

export type SupportCaseDraftV1 = Omit<SupportCaseInputV1, 'diagnostics'>

export type SupportCaseExportRequestV1 = SupportCaseDraftV1 & {
  consent: typeof SUPPORT_CASE_EXPORT_CONSENT
}

export type SupportCaseExportV1 = {
  schema_version: 1
  created_at: string
  support_case: SupportCaseV1
  diagnostics_bundle: {
    filename: string
    media_type: 'application/gzip'
    encoding: 'base64'
    sha256: string
    byte_length: number
    bytes: string
  }
  review: {
    required_before_sharing: true
    transport_registered: false
    publication_performed: false
  }
}

export type SupportCaseExportArtifact = {
  filename: string
  bytes: Buffer
  sha256: string
  value: SupportCaseExportV1
}

type ParsedDiagnostics = {
  createdAt: string
  manifest: RedactedDiagnosticsManifestV1
  verification: DiagnosticsBundleVerificationV1
}

const exactRecord = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

const exactStrings = (value: unknown, expected: readonly string[]): boolean => Array.isArray(value)
  && value.length === expected.length
  && value.every((item, index) => item === expected[index])

const exactRecordShape = (
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const keys = Object.keys(value)
  return keys.every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key))
}

const isIsoTimestamp = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value

const isFiniteNonNegative = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value)
  && value >= 0

const isIdentifier = (value: unknown): value is string => typeof value === 'string'
  && IDENTIFIER.test(value)

const isPlainRecord = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype

const validateDiagnosticsSchema = (payload: Record<string, unknown>): boolean => {
  if (!exactRecordShape(payload.generator, GENERATOR_KEYS, GENERATOR_REQUIRED_KEYS)
    || typeof payload.generator.version !== 'string'
    || !VERSION.test(payload.generator.version)
    || (payload.generator.revision !== undefined
      && (typeof payload.generator.revision !== 'string' || !/^[0-9a-f]{7,64}$/i.test(payload.generator.revision)))) {
    return false
  }
  if (!exactRecordShape(payload.runtime, RUNTIME_KEYS)
    || typeof payload.runtime.node_version !== 'string'
    || !/^v\d+\.\d+\.\d+$/.test(payload.runtime.node_version)
    || typeof payload.runtime.platform !== 'string'
    || !NODE_PLATFORMS.has(payload.runtime.platform)
    || typeof payload.runtime.arch !== 'string'
    || !/^[a-z0-9_-]{1,32}$/i.test(payload.runtime.arch)
    || !isFiniteNonNegative(payload.runtime.uptime_seconds)) return false

  if (!exactRecordShape(payload.health, HEALTH_KEYS)
    || !['ready', 'degraded', 'unavailable'].includes(String(payload.health.status))
    || !isIsoTimestamp(payload.health.checked_at)
    || !isFiniteNonNegative(payload.health.duration_ms)
    || !Array.isArray(payload.health.components)
    || payload.health.components.length !== OPERATIONS_HEALTH_COMPONENTS.length) return false
  const componentNames = new Set<string>()
  for (const component of payload.health.components) {
    if (!exactRecordShape(component, HEALTH_COMPONENT_KEYS, HEALTH_COMPONENT_REQUIRED_KEYS)
      || typeof component.component !== 'string'
      || !OPERATIONS_HEALTH_COMPONENTS.includes(component.component as never)
      || componentNames.has(component.component)
      || typeof component.required !== 'boolean'
      || typeof component.status !== 'string'
      || !HEALTH_STATUSES.has(component.status)
      || (component.reasonCode !== undefined && !isIdentifier(component.reasonCode))
      || !isIsoTimestamp(component.observedAt)
      || !isFiniteNonNegative(component.latencyMs)
      || !isPlainRecord(component.details)) return false
    componentNames.add(component.component)
  }
  if (componentNames.size !== OPERATIONS_HEALTH_COMPONENTS.length) return false

  if (!Array.isArray(payload.metrics) || payload.metrics.length > 512) return false
  for (const metric of payload.metrics) {
    if (!exactRecordShape(metric, METRIC_KEYS)
      || typeof metric.name !== 'string'
      || !OPERATIONS_METRICS.includes(metric.name as never)
      || !isFiniteNonNegative(metric.value)
      || !isIsoTimestamp(metric.observed_at)
      || !exactRecordShape(metric.labels, [...METRIC_LABELS], [])) return false
    for (const [key, value] of Object.entries(metric.labels)) {
      if (!METRIC_LABELS.has(key) || !isIdentifier(value)) return false
    }
  }

  if (!Array.isArray(payload.recent_logs) || payload.recent_logs.length > 500) return false
  for (const log of payload.recent_logs) {
    if (!exactRecordShape(log, LOG_KEYS, LOG_REQUIRED_KEYS)
      || !isIsoTimestamp(log.timestamp)
      || typeof log.level !== 'string' || !LOG_LEVELS.has(log.level)
      || typeof log.event !== 'string' || !EVENT_NAME.test(log.event)
      || (log.outcome !== undefined && (typeof log.outcome !== 'string' || !LOG_OUTCOMES.has(log.outcome)))
      || (log.component !== undefined && !isIdentifier(log.component))
      || (log.reason_code !== undefined && !isIdentifier(log.reason_code))
      || (log.correlation_id !== undefined && !isIdentifier(log.correlation_id))
      || (log.job_id !== undefined && !isIdentifier(log.job_id))
      || (log.session_id !== undefined && !isIdentifier(log.session_id))
      || (log.device_id !== undefined && !isIdentifier(log.device_id))
      || !isPlainRecord(log.attributes)
      || !Number.isSafeInteger(log.redactions) || Number(log.redactions) < 0) return false
  }

  if (!exactRecordShape(payload.configuration, CONFIGURATION_KEYS, [])) return false
  const configuration = payload.configuration
  if (configuration.authentication !== undefined
      && configuration.authentication !== 'required_or_loopback_only'
      && configuration.authentication !== REDACTED_STRUCTURED_VALUE) return false
  if (configuration.remote_exposure !== undefined && !isIdentifier(configuration.remote_exposure)) return false
  for (const key of ['stale_remote_authorized_intents', 'max_active_sessions'] as const) {
    if (configuration[key] !== undefined && !isFiniteNonNegative(configuration[key])) return false
  }
  for (const key of ['token', 'workspace_path'] as const) {
    if (configuration[key] !== undefined
      && configuration[key] !== WITHHELD_OPERATIONAL_VALUE
      && configuration[key] !== REDACTED_STRUCTURED_VALUE) return false
  }
  return true
}

const scanRedactedValue = (
  value: unknown,
  key = '',
  depth = 0,
  budget = { nodes: 0 },
): void => {
  budget.nodes += 1
  if (budget.nodes > 20_000 || depth > 24) throw new Error('diagnostics payload exceeds verifier bounds')
  if (key && isWithheldOperationalKey(key)) {
    if (value !== WITHHELD_OPERATIONAL_VALUE && value !== REDACTED_STRUCTURED_VALUE) {
      throw new Error('diagnostics payload retains a withheld value')
    }
    return
  }
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('diagnostics payload contains a non-finite number')
    return
  }
  if (typeof value === 'string') {
    if (value.length > 4_000
      || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
      || SECRET_VALUE.test(value)
      || PATH_SEPARATOR_OR_URL.test(value)
      || BARE_SENSITIVE_PATH.test(value)) {
      throw new Error('diagnostics payload contains unsafe text')
    }
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 2_000) throw new Error('diagnostics payload array exceeds verifier bounds')
    value.forEach((item) => scanRedactedValue(item, '', depth + 1, budget))
    return
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('diagnostics payload is not plain JSON')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 500) throw new Error('diagnostics payload object exceeds verifier bounds')
  for (const [name, item] of entries) {
    if (!SAFE_KEY.test(name)) throw new Error('diagnostics payload contains an unsafe key')
    scanRedactedValue(item, name, depth + 1, budget)
  }
}

export const verifyOperationsDiagnosticsArtifact = (
  artifact: Pick<OperationsDiagnosticsArtifact, 'filename' | 'bytes' | 'sha256'>,
  nowMs: () => number = Date.now,
): ParsedDiagnostics => {
  if (!DIAGNOSTICS_FILE.test(artifact.filename)
    || path.basename(artifact.filename) !== artifact.filename
    || !Buffer.isBuffer(artifact.bytes)
    || artifact.bytes.byteLength <= 0
    || artifact.bytes.byteLength > MAX_COMPRESSED_BYTES
    || !SHA256.test(artifact.sha256)) {
    throw new Error('diagnostics artifact metadata is invalid')
  }
  const digest = createHash('sha256').update(artifact.bytes).digest('hex')
  if (digest !== artifact.sha256) throw new Error('diagnostics artifact digest does not match its bytes')

  let decoded: Buffer
  try {
    decoded = gunzipSync(artifact.bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
  } catch {
    throw new Error('diagnostics artifact is not a bounded gzip payload')
  }
  if (decoded.byteLength <= 0 || decoded.byteLength > MAX_DECOMPRESSED_BYTES) {
    throw new Error('diagnostics artifact decoded size is invalid')
  }

  let payload: unknown
  try {
    payload = JSON.parse(decoded.toString('utf8'))
  } catch {
    throw new Error('diagnostics artifact is not valid JSON')
  }
  const canonical = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`)
  if (!canonical.equals(decoded)) {
    throw new Error('diagnostics artifact is not canonical generator JSON')
  }
  if (!exactRecord(payload, ROOT_KEYS)
    || payload.schema_version !== 1
    || !isIsoTimestamp(payload.created_at)
    || Date.parse(payload.created_at) > nowMs() + 5_000
    || !exactStrings(payload.exclusions, REQUIRED_EXCLUSIONS)
    || !validateDiagnosticsSchema(payload)) {
    throw new Error('diagnostics artifact schema or exclusion contract is invalid')
  }
  scanRedactedValue(Object.fromEntries(
    Object.entries(payload).filter(([name]) => name !== 'exclusions'),
  ))

  const manifest: RedactedDiagnosticsManifestV1 = Object.freeze({
    schema_version: 1,
    bundle_file: artifact.filename,
    sha256: digest,
    byte_length: artifact.bytes.byteLength,
    generated_at: payload.created_at,
    redaction_verified: true,
    secret_findings: 0,
    included_categories: INCLUDED_CATEGORIES,
  })
  const verification: DiagnosticsBundleVerificationV1 = Object.freeze({
    verified: true,
    verifier_id: 'operations-diagnostics-strict-v1',
    sha256: digest,
    byte_length: artifact.bytes.byteLength,
    redaction_verified: true,
    secret_findings: 0,
  })
  return { createdAt: payload.created_at, manifest, verification }
}

const REQUEST_KEYS = [
  'title',
  'summary',
  'reproduction_steps',
  'expected',
  'actual',
  'exact_commit',
  'orchestra_version',
  'consent',
] as const

export const createSupportCaseExport = (input: {
  request: SupportCaseExportRequestV1
  diagnostics: Pick<OperationsDiagnosticsArtifact, 'filename' | 'bytes' | 'sha256'>
  nowMs?: () => number
}): SupportCaseExportArtifact => {
  if (!exactRecord(input.request, REQUEST_KEYS)
    || input.request.consent !== SUPPORT_CASE_EXPORT_CONSENT) {
    throw new Error('explicit local-export and review consent is required')
  }
  const nowMs = input.nowMs ?? Date.now
  const parsed = verifyOperationsDiagnosticsArtifact(input.diagnostics, nowMs)
  const { consent: _consent, ...draft } = input.request
  const supportCase = prepareSupportCase({ ...draft, diagnostics: parsed.manifest }, {
    nowMs,
    verifyBundle: () => parsed.verification,
  })
  const createdAt = new Date(nowMs()).toISOString()
  const value: SupportCaseExportV1 = {
    schema_version: 1,
    created_at: createdAt,
    support_case: supportCase,
    diagnostics_bundle: {
      filename: input.diagnostics.filename,
      media_type: 'application/gzip',
      encoding: 'base64',
      sha256: parsed.manifest.sha256,
      byte_length: parsed.manifest.byte_length,
      bytes: input.diagnostics.bytes.toString('base64'),
    },
    review: {
      required_before_sharing: true,
      transport_registered: false,
      publication_performed: false,
    },
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const filename = `orchestra-support-case-${createdAt.replace(/[:.]/g, '-')}-${sha256.slice(0, 12)}.json`
  return Object.freeze({ filename, bytes, sha256, value })
}

export const writeSupportCaseExport = (
  outputDirectory: string,
  artifact: Pick<SupportCaseExportArtifact, 'filename' | 'bytes' | 'sha256'>,
): string => {
  if (!SUPPORT_CASE_FILE.test(artifact.filename)
    || path.basename(artifact.filename) !== artifact.filename
    || !Buffer.isBuffer(artifact.bytes)
    || artifact.bytes.byteLength <= 0
    || artifact.bytes.byteLength > 16 * 1024 * 1024
    || !SHA256.test(artifact.sha256)
    || createHash('sha256').update(artifact.bytes).digest('hex') !== artifact.sha256) {
    throw new Error('support-case export artifact is invalid')
  }
  const root = fs.realpathSync(outputDirectory)
  if (!fs.statSync(root).isDirectory()) throw new Error('support-case output must be an existing directory')
  const destination = path.join(root, artifact.filename)
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW ?? 0)
  const descriptor = fs.openSync(destination, flags, 0o600)
  try {
    fs.writeFileSync(descriptor, artifact.bytes)
    fs.fsyncSync(descriptor)
    fs.fchmodSync(descriptor, 0o600)
  } catch (error) {
    try {
      const opened = fs.fstatSync(descriptor)
      const current = fs.lstatSync(destination)
      if (opened.dev === current.dev && opened.ino === current.ino
        && opened.nlink === 1 && current.isFile()) {
        fs.unlinkSync(destination)
      }
    } catch { /* preserve original failure without deleting a swapped path */ }
    throw error
  } finally {
    fs.closeSync(descriptor)
  }
  return destination
}

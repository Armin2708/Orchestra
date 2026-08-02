import path from 'node:path'

export type RedactedDiagnosticsManifestV1 = {
  schema_version: 1
  bundle_file: string
  sha256: string
  byte_length: number
  generated_at: string
  redaction_verified: boolean
  secret_findings: number
  included_categories: readonly string[]
}

export type SupportCaseV1 = {
  schema_version: 1
  title: string
  summary: string
  reproduction_steps: readonly string[]
  expected: string
  actual: string
  exact_commit: string
  orchestra_version: string
  diagnostics: {
    bundle_file: string
    sha256: string
    byte_length: number
    generated_at: string
    included_categories: readonly string[]
    verifier_id: string
  }
  share_warning: string
}

const SHA256 = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/
const BUNDLE_FILE = /^orchestra-diagnostics-[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?:json|zip|tar\.gz)$/
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/
const SECRET_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:github_pat_|gh[pousr]_|glpat-|xox[baprs]-|sk-)[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|bearer\s+[a-z0-9._~+/-]+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/i
const DIAGNOSTIC_CATEGORIES = new Set([
  'configuration',
  'health',
  'migrations',
  'providers',
  'queue',
  'redacted-errors',
  'runtime',
  'versions',
])
const DIAGNOSTIC_KEYS = [
  'schema_version',
  'bundle_file',
  'sha256',
  'byte_length',
  'generated_at',
  'redaction_verified',
  'secret_findings',
  'included_categories',
] as const
const VERIFICATION_KEYS = [
  'verified',
  'verifier_id',
  'sha256',
  'byte_length',
  'redaction_verified',
  'secret_findings',
] as const
const SUPPORT_INPUT_KEYS = [
  'title',
  'summary',
  'reproduction_steps',
  'expected',
  'actual',
  'exact_commit',
  'orchestra_version',
  'diagnostics',
] as const

const exactPlainRecord = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

export type DiagnosticsBundleVerificationV1 = {
  verified: true
  verifier_id: string
  sha256: string
  byte_length: number
  redaction_verified: true
  secret_findings: 0
}

export type SupportWorkflowDeps = {
  verifyBundle?: (
    manifest: RedactedDiagnosticsManifestV1,
  ) => DiagnosticsBundleVerificationV1
  nowMs?: () => number
}

const safeText = (value: string, label: string, maxLength = 4_000): string => {
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} cannot be empty`)
  if (normalized.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    throw new Error(`${label} is not bounded safe text`)
  }
  if (SECRET_PATTERN.test(normalized)) throw new Error(`${label} appears to contain a secret`)
  return normalized
}

export const prepareSupportCase = (input: {
  title: string
  summary: string
  reproduction_steps: readonly string[]
  expected: string
  actual: string
  exact_commit: string
  orchestra_version: string
  diagnostics: RedactedDiagnosticsManifestV1
}, deps: SupportWorkflowDeps = {}): SupportCaseV1 => {
  if (!exactPlainRecord(input, SUPPORT_INPUT_KEYS)) {
    throw new Error('support case input has unknown or missing fields')
  }
  if (!deps.verifyBundle) {
    throw new Error('diagnostics verifier is not registered; support adapter remains disabled')
  }
  const diagnostics = input.diagnostics
  if (!exactPlainRecord(diagnostics, DIAGNOSTIC_KEYS)
    || diagnostics.schema_version !== 1
    || diagnostics.redaction_verified !== true
    || diagnostics.secret_findings !== 0
    || !SHA256.test(diagnostics.sha256)
    || !Number.isSafeInteger(diagnostics.byte_length)
    || diagnostics.byte_length <= 0
    || diagnostics.byte_length > 50 * 1024 * 1024
    || !Number.isFinite(Date.parse(diagnostics.generated_at))
    || new Date(Date.parse(diagnostics.generated_at)).toISOString() !== diagnostics.generated_at
    || Date.parse(diagnostics.generated_at) > (deps.nowMs ?? Date.now)() + 5_000
    || !Array.isArray(diagnostics.included_categories)
    || diagnostics.included_categories.length === 0
    || diagnostics.included_categories.length > DIAGNOSTIC_CATEGORIES.size
    || new Set(diagnostics.included_categories).size !== diagnostics.included_categories.length
    || diagnostics.included_categories.some((category) =>
      typeof category !== 'string' || !DIAGNOSTIC_CATEGORIES.has(category))) {
    throw new Error('diagnostics bundle is not verified safe for a support report')
  }
  const bundleFile = path.basename(diagnostics.bundle_file)
  if (!bundleFile
    || bundleFile !== diagnostics.bundle_file
    || !BUNDLE_FILE.test(bundleFile)
    || SECRET_PATTERN.test(bundleFile)) {
    throw new Error('diagnostics manifest must contain a basename, not a local path')
  }
  const verification = deps.verifyBundle(diagnostics)
  if (!exactPlainRecord(verification, VERIFICATION_KEYS)
    || verification.verified !== true
    || verification.redaction_verified !== true
    || verification.secret_findings !== 0
    || !IDENTIFIER.test(verification.verifier_id)
    || verification.sha256 !== diagnostics.sha256
    || verification.byte_length !== diagnostics.byte_length) {
    throw new Error('diagnostics verifier did not bind the attestation to the declared bundle')
  }
  if (!COMMIT.test(input.exact_commit)) throw new Error('exact_commit must be a full Git SHA-1')
  if (!VERSION.test(input.orchestra_version)) throw new Error('orchestra_version is invalid')
  if (!Array.isArray(input.reproduction_steps)) {
    throw new Error('reproduction_steps must be an array')
  }
  const steps = input.reproduction_steps.map((step) => safeText(step, 'reproduction step'))
  if (steps.length === 0 || steps.length > 50) {
    throw new Error('one to fifty reproduction steps are required')
  }
  return {
    schema_version: 1,
    title: safeText(input.title, 'title', 240),
    summary: safeText(input.summary, 'summary'),
    reproduction_steps: steps,
    expected: safeText(input.expected, 'expected'),
    actual: safeText(input.actual, 'actual'),
    exact_commit: input.exact_commit,
    orchestra_version: safeText(input.orchestra_version, 'orchestra_version'),
    diagnostics: {
      bundle_file: bundleFile,
      sha256: diagnostics.sha256,
      byte_length: diagnostics.byte_length,
      generated_at: diagnostics.generated_at,
      included_categories: [...diagnostics.included_categories],
      verifier_id: verification.verifier_id,
    },
    share_warning: 'Review the redacted bundle before sharing; never attach databases, credentials, transcripts, PTY output, or source files.',
  }
}

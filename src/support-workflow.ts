import path from 'node:path'

export type RedactedDiagnosticsManifestV1 = {
  schema_version: 1
  bundle_file: string
  sha256: string
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
    generated_at: string
    included_categories: readonly string[]
  }
  share_warning: string
}

const SHA256 = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const SECRET_PATTERN = /(?:bearer\s+[a-z0-9._~+/-]+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/i

const safeText = (value: string, label: string): string => {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} cannot be empty`)
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
}): SupportCaseV1 => {
  const diagnostics = input.diagnostics
  if (diagnostics.schema_version !== 1
    || !diagnostics.redaction_verified
    || diagnostics.secret_findings !== 0
    || !SHA256.test(diagnostics.sha256)
    || !Number.isFinite(Date.parse(diagnostics.generated_at))) {
    throw new Error('diagnostics bundle is not verified safe for a support report')
  }
  const bundleFile = path.basename(diagnostics.bundle_file)
  if (!bundleFile || bundleFile !== diagnostics.bundle_file) {
    throw new Error('diagnostics manifest must contain a basename, not a local path')
  }
  if (!COMMIT.test(input.exact_commit)) throw new Error('exact_commit must be a full Git SHA-1')
  const steps = input.reproduction_steps.map((step) => safeText(step, 'reproduction step'))
  if (steps.length === 0) throw new Error('at least one reproduction step is required')
  return {
    schema_version: 1,
    title: safeText(input.title, 'title'),
    summary: safeText(input.summary, 'summary'),
    reproduction_steps: steps,
    expected: safeText(input.expected, 'expected'),
    actual: safeText(input.actual, 'actual'),
    exact_commit: input.exact_commit,
    orchestra_version: safeText(input.orchestra_version, 'orchestra_version'),
    diagnostics: {
      bundle_file: bundleFile,
      sha256: diagnostics.sha256,
      generated_at: diagnostics.generated_at,
      included_categories: [...diagnostics.included_categories],
    },
    share_warning: 'Review the redacted bundle before sharing; never attach databases, credentials, transcripts, PTY output, or source files.',
  }
}

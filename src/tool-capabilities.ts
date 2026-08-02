import {
  FIRST_RELEASE_PROVIDER_MANIFESTS_V1,
} from './provider-manifests.js'
import {
  PROVIDER_CAPABILITY_IDS,
  defineProviderExecutableDiscoveryV1,
  type ProviderCapabilityId,
  type ProviderExecutableDiscoveryV1,
  type ProviderManifestV1,
  type ProviderSupportState,
} from './provider-contract.js'
import type {
  DoctorExecutableIdentity,
  OperatorDoctorCheck,
  OperatorDoctorReport,
} from './readiness-doctor.js'
import type { VersionProbeFailure } from './environment-compatibility.js'

export const TOOL_CAPABILITY_KINDS = [
  'cli',
  'mcp_server',
  'plugin',
  'skill',
  'native',
] as const

export const TOOL_POLICY_DECISIONS = [
  'allow',
  'approval_required',
  'deny',
] as const

export type ToolCapabilityKind = typeof TOOL_CAPABILITY_KINDS[number]
export type ToolPolicyDecision = typeof TOOL_POLICY_DECISIONS[number]
export type ToolCapabilityStatus =
  | 'ready'
  | 'degraded'
  | 'unavailable'
  | 'unsupported'
  | 'unknown'
export type ToolManagedSupportState =
  | 'supported'
  | 'candidate'
  | 'policy_blocked'
  | 'unsupported'
  | 'unknown'

export type ToolExecutableProvenance = {
  source: 'path' | 'environment_override' | 'sdk_bundled' | 'unknown'
  version: string | null
  platform: string | null
  health: 'validated' | 'missing' | 'incompatible' | 'untrusted' | 'unknown'
  probe_failure?: VersionProbeFailure | null
  path_fingerprint: string | null
  executable_fingerprint: string | null
}

export type ToolPackageProvenance = {
  package_id: string
  version: string | null
  source: 'bundled' | 'provider' | 'project' | 'user' | 'unknown'
}

export type ToolCapabilityProvenance = {
  evidence: 'observed' | 'declared' | 'unknown'
  observed_at: string | null
  executable: ToolExecutableProvenance | null
  package: ToolPackageProvenance | null
  provider_native_id: string | null
}

export type ToolCapabilityPermission = {
  requested: ToolPolicyDecision
  effective: ToolPolicyDecision | 'unknown'
  source: 'session_policy' | 'provider' | 'default_closed' | 'unknown'
}

export type ToolCapability = {
  schema_version: 1
  id: string
  name: string
  kind: ToolCapabilityKind
  provider_id: string | null
  session_id: string | null
  status: ToolCapabilityStatus
  managed_support: ToolManagedSupportState
  direct_terminal_available: boolean
  capabilities: readonly string[]
  permission: ToolCapabilityPermission
  provenance: ToolCapabilityProvenance
  error: { code: string; detail: string } | null
}

export type DeclaredProviderCapability = {
  id: ProviderCapabilityId
  state: ProviderSupportState
  reason_code: string | null
}

export type DeclaredProviderCapabilityMatrixRow = {
  schema_version: 1
  provider_id: string
  display_name: string
  adapter_id: string
  adapter_version: string
  release_state: ProviderManifestV1['release_state']
  mode_id: string
  runtime_mode: string
  billing_mode: string
  credential_kind: string
  mode_support: ProviderSupportState
  mode_reason_code: string | null
  automation_policy: string
  overage_behavior: string
  managed_support: ToolManagedSupportState
  accepted_evidence: boolean
  executable: ToolExecutableProvenance
  capabilities: readonly DeclaredProviderCapability[]
  blockers: readonly string[]
}

export type ToolIntegrationCheck = {
  id: string
  name: string
  kind: Extract<ToolCapabilityKind, 'mcp_server' | 'plugin' | 'skill' | 'native'>
  provider_id?: string | null
  status: 'validated' | 'experimental' | 'unsupported' | 'unknown'
  version?: string | null
  source?: ToolPackageProvenance['source']
  detail?: string
  capabilities?: readonly string[]
}

export type DeclaredProviderEvidence = {
  doctor?: OperatorDoctorReport | null
  discoveries?: Readonly<Record<string, ProviderExecutableDiscoveryV1 | undefined>>
  accepted?: (manifest: ProviderManifestV1, modeId: string) => boolean
  observedAt?: string | null
}

const safeIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/
const fingerprintPattern = /^sha256:[a-f0-9]{16,64}$/

const safeId = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !safeIdPattern.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

const safeOptionalId = (value: unknown, name: string): string | null =>
  value === null || value === undefined ? null : safeId(value, name)

const safeText = (value: unknown, name: string, limit = 512): string => {
  if (typeof value !== 'string') throw new Error(`${name} is invalid`)
  const normalized = value.trim()
  if (!normalized || normalized.length > limit || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${name} is invalid`)
  }
  return normalized
}

const optionalSafeText = (
  value: unknown,
  name: string,
  limit = 512,
): string | null => value === null || value === undefined
  ? null
  : safeText(value, name, limit)

const safeFingerprint = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  return typeof value === 'string' && fingerprintPattern.test(value)
    ? value
    : null
}

const clone = <T>(value: T): T => structuredClone(value)

const freezeCapability = (input: ToolCapability): Readonly<ToolCapability> => {
  const kind = input.kind
  if (!(TOOL_CAPABILITY_KINDS as readonly string[]).includes(kind)) {
    throw new Error('tool capability kind is invalid')
  }
  if (!(TOOL_POLICY_DECISIONS as readonly string[]).includes(input.permission.requested)) {
    throw new Error('tool requested permission is invalid')
  }
  if (![...TOOL_POLICY_DECISIONS, 'unknown'].includes(input.permission.effective)) {
    throw new Error('tool effective permission is invalid')
  }
  const capability: ToolCapability = {
    schema_version: 1,
    id: safeId(input.id, 'tool capability id'),
    name: safeText(input.name, 'tool capability name', 128),
    kind,
    provider_id: safeOptionalId(input.provider_id, 'tool provider id'),
    session_id: safeOptionalId(input.session_id, 'tool session id'),
    status: input.status,
    managed_support: input.managed_support,
    direct_terminal_available: input.direct_terminal_available === true,
    capabilities: Object.freeze([...new Set(input.capabilities.map((entry) =>
      safeId(entry, 'tool capability label')))].sort()),
    permission: Object.freeze({ ...input.permission }),
    provenance: Object.freeze({
      evidence: input.provenance.evidence,
      observed_at: optionalSafeText(
        input.provenance.observed_at,
        'tool observed timestamp',
        64,
      ),
      executable: input.provenance.executable === null
        ? null
        : Object.freeze({
            ...input.provenance.executable,
            probe_failure: input.provenance.executable.probe_failure ?? null,
            version: optionalSafeText(
              input.provenance.executable.version,
              'tool executable version',
              64,
            ),
            platform: optionalSafeText(
              input.provenance.executable.platform,
              'tool executable platform',
              64,
            ),
            path_fingerprint: safeFingerprint(
              input.provenance.executable.path_fingerprint,
            ),
            executable_fingerprint: safeFingerprint(
              input.provenance.executable.executable_fingerprint,
            ),
          }),
      package: input.provenance.package === null
        ? null
        : Object.freeze({
            package_id: safeId(input.provenance.package.package_id, 'tool package id'),
            version: optionalSafeText(
              input.provenance.package.version,
              'tool package version',
              64,
            ),
            source: input.provenance.package.source,
          }),
      provider_native_id: safeOptionalId(
        input.provenance.provider_native_id,
        'tool provider native id',
      ),
    }),
    error: input.error === null
      ? null
      : Object.freeze({
          code: safeId(input.error.code, 'tool error code'),
          detail: safeText(input.error.detail, 'tool error detail'),
        }),
  }
  return Object.freeze(capability)
}

/** Provider-neutral, duplicate-safe registry. It stores metadata, never tool inputs or credentials. */
export class ToolCapabilityRegistry {
  readonly #entries = new Map<string, Readonly<ToolCapability>>()

  constructor(entries: readonly ToolCapability[] = []) {
    for (const entry of entries) this.register(entry)
  }

  register(input: ToolCapability): Readonly<ToolCapability> {
    const entry = freezeCapability(clone(input))
    if (this.#entries.has(entry.id)) {
      throw new Error(`tool capability ${entry.id} is already registered`)
    }
    this.#entries.set(entry.id, entry)
    return entry
  }

  replace(input: ToolCapability): Readonly<ToolCapability> {
    const entry = freezeCapability(clone(input))
    this.#entries.set(entry.id, entry)
    return entry
  }

  synchronize(inputs: readonly ToolCapability[]): void {
    const next = new ToolCapabilityRegistry(inputs)
    this.#entries.clear()
    for (const entry of next.#entries.values()) {
      this.#entries.set(entry.id, entry)
    }
  }

  get(id: string): Readonly<ToolCapability> | null {
    return this.#entries.get(id) ?? null
  }

  list(filters: { providerId?: string | null; sessionId?: string | null } = {}): ToolCapability[] {
    return [...this.#entries.values()]
      .filter((entry) => filters.providerId === undefined
        || entry.provider_id === filters.providerId)
      .filter((entry) => filters.sessionId === undefined
        || entry.session_id === null
        || entry.session_id === filters.sessionId)
      .sort((left, right) => left.kind.localeCompare(right.kind)
        || left.name.localeCompare(right.name)
        || left.id.localeCompare(right.id))
      .map((entry) => clone(entry))
  }
}

const doctorCheck = (
  report: OperatorDoctorReport | null | undefined,
  id: string,
): OperatorDoctorCheck | undefined => report?.checks.find((check) => check.id === id)

const doctorProviders = (
  provider: OperatorDoctorReport['provider'],
): readonly string[] => provider === 'both' ? ['claude', 'codex'] : [provider]

const verifiedEvidence = (
  evidence: DeclaredProviderEvidence,
): DeclaredProviderEvidence => {
  const doctor = evidence.doctor
  if (doctor !== undefined && doctor !== null) {
    if (doctor.schema_version !== 2
      || doctor.mode !== 'readiness'
      || doctor.fail_closed !== true
      || !['claude', 'codex', 'both'].includes(doctor.provider)
      || !Number.isFinite(Date.parse(doctor.checked_at))
      || Date.parse(doctor.checked_at) > Date.now() + 5_000) {
      throw new Error('provider tool doctor evidence is invalid')
    }
    const checkIds = doctor.checks.map((check) => check.id)
    if (new Set(checkIds).size !== checkIds.length) {
      throw new Error('provider tool doctor evidence contains duplicate checks')
    }
  }

  const discoveries = Object.fromEntries(Object.entries(evidence.discoveries ?? {})
    .filter((entry): entry is [string, ProviderExecutableDiscoveryV1] => entry[1] !== undefined)
    .map(([providerId, discovery]) => {
      const manifest = FIRST_RELEASE_PROVIDER_MANIFESTS_V1.find((candidate) =>
        candidate.provider_id === providerId)
      if (!manifest) throw new Error(`provider tool discovery is undeclared: ${providerId}`)
      const defined = defineProviderExecutableDiscoveryV1(discovery)
      if (defined.provider_id !== manifest.provider_id
        || defined.adapter_id !== manifest.adapter_id) {
        throw new Error(`provider tool discovery does not match manifest: ${providerId}`)
      }
      if (doctor && doctorProviders(doctor.provider).includes(providerId)) {
        const checkId = providerId === 'claude' ? 'claude_bundled_cli' : 'codex_cli'
        const check = doctorCheck(doctor, checkId)
        const doctorValidated = check?.status === 'validated'
        const discoveryValidated = defined.status === 'validated'
        if (!check
          || doctorValidated !== discoveryValidated
          || (doctorValidated && check.actual !== defined.version)) {
          return [providerId, Object.freeze({ ...defined, status: 'untrusted' as const })]
        }
      }
      return [providerId, defined]
    }))

  if (evidence.observedAt !== undefined && evidence.observedAt !== null) {
    if (!Number.isFinite(Date.parse(evidence.observedAt))
      || Date.parse(evidence.observedAt) > Date.now() + 5_000
      || (doctor && evidence.observedAt !== doctor.checked_at)) {
      throw new Error('provider tool observation timestamp is invalid')
    }
  }
  return {
    ...evidence,
    doctor,
    discoveries,
  }
}

const executableFromDoctor = (
  manifest: ProviderManifestV1,
  report: OperatorDoctorReport | null | undefined,
): ToolExecutableProvenance | null => {
  const id = manifest.provider_id === 'claude'
    ? 'claude_bundled_cli'
    : manifest.provider_id === 'codex'
      ? 'codex_cli'
      : null
  if (!id) return null
  const check = doctorCheck(report, id)
  if (!check) return null
  const identity = 'executable' in check
    ? check.executable as DoctorExecutableIdentity | undefined
    : undefined
  const probeFailure = 'probe_failure' in check
    ? check.probe_failure ?? null
    : null
  const pathFingerprint = safeFingerprint(identity?.path_fingerprint)
  const validatedIdentity = check.status !== 'validated'
    || (identity !== undefined
      && identity.source !== 'process'
      && pathFingerprint !== null
      && typeof check.actual === 'string'
      && check.actual.trim().length > 0)
  return {
    source: identity?.source === 'process' ? 'unknown' : identity?.source ?? 'unknown',
    version: check.actual,
    platform: null,
    health: check.status === 'validated'
      ? validatedIdentity ? 'validated' : 'untrusted'
      : probeFailure === 'missing'
        ? 'missing'
        : check.actual === null
          ? 'unknown'
          : 'incompatible',
    probe_failure: probeFailure,
    path_fingerprint: pathFingerprint,
    executable_fingerprint: null,
  }
}

const executableFromDiscovery = (
  discovery: ProviderExecutableDiscoveryV1,
): ToolExecutableProvenance => ({
  source: discovery.source,
  version: discovery.version,
  platform: discovery.platform,
  health: discovery.status,
  probe_failure: null,
  path_fingerprint: discovery.executable_fingerprint,
  executable_fingerprint: discovery.executable_fingerprint,
})

const unknownExecutable = (manifest: ProviderManifestV1): ToolExecutableProvenance => ({
  source: manifest.executable.source === 'sdk_bundled' ? 'sdk_bundled' : 'unknown',
  version: null,
  platform: null,
  health: 'unknown',
  probe_failure: null,
  path_fingerprint: null,
  executable_fingerprint: null,
})

const managedSupport = (
  manifest: ProviderManifestV1,
  modeSupport: ProviderSupportState,
  accepted: boolean,
): ToolManagedSupportState => {
  if (modeSupport === 'policy_blocked') return 'policy_blocked'
  if (manifest.release_state === 'unsupported') return 'unsupported'
  if (manifest.release_state === 'candidate' || !accepted) return 'candidate'
  if (modeSupport === 'supported') return 'supported'
  return modeSupport
}

const executableBlocker = (executable: ToolExecutableProvenance): string | null =>
  executable.health === 'validated' ? null : `executable_${executable.health}`

export function buildDeclaredProviderCapabilityMatrix(
  evidence: DeclaredProviderEvidence = {},
): DeclaredProviderCapabilityMatrixRow[] {
  return FIRST_RELEASE_PROVIDER_MANIFESTS_V1.map((manifest) => {
    const mode = manifest.modes.find((candidate) => candidate.priority === 'primary')
      ?? manifest.modes[0]
    if (!mode) throw new Error(`provider ${manifest.provider_id} has no execution mode`)
    const discovery = evidence.discoveries?.[manifest.provider_id]
    const executable = discovery
      ? executableFromDiscovery(discovery)
      : executableFromDoctor(manifest, evidence.doctor) ?? unknownExecutable(manifest)
    const accepted = evidence.accepted?.(manifest, mode.id) === true
    const modeSupport = mode.support.state
    const support = managedSupport(manifest, modeSupport, accepted)
    const blockers = new Set<string>()
    const discoveryBlocker = executableBlocker(executable)
    if (discoveryBlocker) blockers.add(discoveryBlocker)
    if (!accepted) blockers.add('acceptance_evidence_missing')
    if (manifest.environment.audit_state !== 'complete') blockers.add('environment_audit_incomplete')
    if (manifest.release_state !== 'validated') blockers.add(`release_${manifest.release_state}`)
    if (modeSupport !== 'supported') blockers.add(`mode_${modeSupport}`)
    if (mode.automation_policy !== 'allowed') blockers.add(`automation_${mode.automation_policy}`)
    if (mode.overage.explicit_consent_required) blockers.add('overage_consent_required')
    return Object.freeze({
      schema_version: 1 as const,
      provider_id: manifest.provider_id,
      display_name: manifest.display_name,
      adapter_id: manifest.adapter_id,
      adapter_version: manifest.adapter_version,
      release_state: manifest.release_state,
      mode_id: mode.id,
      runtime_mode: mode.runtime_mode,
      billing_mode: mode.billing_mode,
      credential_kind: mode.default_credential_kind,
      mode_support: modeSupport,
      mode_reason_code: mode.support.state === 'supported' ? null : mode.support.reason_code,
      automation_policy: mode.automation_policy,
      overage_behavior: mode.overage.behavior,
      managed_support: support,
      accepted_evidence: accepted,
      executable: Object.freeze(executable),
      capabilities: Object.freeze(PROVIDER_CAPABILITY_IDS.map((id) => {
        const capability = mode.capabilities[id]
        return Object.freeze({
          id,
          state: capability.state,
          reason_code: capability.state === 'supported' ? null : capability.reason_code,
        })
      })),
      blockers: Object.freeze([...blockers].sort()),
    })
  })
}

const statusForProviderCli = (
  row: DeclaredProviderCapabilityMatrixRow,
): ToolCapabilityStatus => {
  if (row.executable.health === 'missing') return 'unavailable'
  if (row.executable.health === 'incompatible' || row.executable.health === 'untrusted') {
    return 'unsupported'
  }
  if (row.executable.health !== 'validated') return 'unknown'
  return row.managed_support === 'supported' ? 'ready' : 'degraded'
}

export function providerCliToolCapabilities(
  matrix: readonly DeclaredProviderCapabilityMatrixRow[],
  observedAt: string | null = null,
): ToolCapability[] {
  return matrix.map((row) => ({
    schema_version: 1,
    id: `provider:${row.provider_id}:cli`,
    name: row.display_name,
    kind: 'cli',
    provider_id: row.provider_id,
    session_id: null,
    status: statusForProviderCli(row),
    managed_support: row.managed_support,
    direct_terminal_available: [
      'validated',
      'incompatible',
      'untrusted',
    ].includes(row.executable.health),
    capabilities: row.capabilities
      .filter((capability) => capability.state === 'supported')
      .map((capability) => capability.id),
    permission: {
      requested: 'approval_required',
      effective: 'unknown',
      source: 'default_closed',
    },
    provenance: {
      evidence: row.executable.health === 'unknown' ? 'declared' : 'observed',
      observed_at: observedAt,
      executable: row.executable,
      package: null,
      provider_native_id: row.adapter_id,
    },
    error: row.blockers.length === 0
      ? null
      : {
          code: row.blockers[0]!,
          detail: row.blockers.join(', '),
        },
  }))
}

export function integrationToolCapabilities(
  checks: readonly ToolIntegrationCheck[],
  observedAt: string | null = null,
): ToolCapability[] {
  return checks.map((check) => ({
    schema_version: 1,
    id: `integration:${check.kind}:${safeId(check.id, 'integration check id')}`,
    name: safeText(check.name, 'integration check name', 128),
    kind: check.kind,
    provider_id: safeOptionalId(check.provider_id, 'integration provider id'),
    session_id: null,
    status: check.status === 'validated'
      ? 'ready'
      : check.status === 'experimental'
        ? 'degraded'
        : check.status === 'unsupported'
          ? 'unsupported'
          : 'unknown',
    managed_support: check.status === 'validated' ? 'supported' : 'unsupported',
    direct_terminal_available: false,
    capabilities: [...(check.capabilities ?? [])],
    permission: {
      requested: 'approval_required',
      effective: 'unknown',
      source: 'default_closed',
    },
    provenance: {
      evidence: check.status === 'unknown' ? 'unknown' : 'observed',
      observed_at: observedAt,
      executable: null,
      package: {
        package_id: check.id,
        version: check.version ?? null,
        source: check.source ?? 'unknown',
      },
      provider_native_id: null,
    },
    error: check.status === 'validated'
      ? null
      : {
          code: `${check.kind}_${check.status}`,
          detail: check.detail ?? `${check.name} is ${check.status}`,
        },
  }))
}

export function createDeclaredProviderToolRegistry(
  evidence: DeclaredProviderEvidence = {},
  integrations: readonly ToolIntegrationCheck[] = [],
): {
  registry: ToolCapabilityRegistry
  matrix: DeclaredProviderCapabilityMatrixRow[]
} {
  const verified = verifiedEvidence(evidence)
  const matrix = buildDeclaredProviderCapabilityMatrix(verified)
  const observedAt = verified.observedAt ?? verified.doctor?.checked_at ?? null
  return {
    matrix,
    registry: new ToolCapabilityRegistry([
      ...providerCliToolCapabilities(matrix, observedAt),
      ...integrationToolCapabilities(integrations, observedAt),
    ]),
  }
}

import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
  defineDeclaredProviderAcceptanceMatrixV1,
  type DeclaredProviderAcceptanceMatrixV1,
} from './provider-adapter-registry.js'
import compatibilityContract from '../environment-compatibility.json' with { type: 'json' }
import {
  FIRST_RELEASE_PROVIDER_MANIFESTS_V1,
} from './provider-manifests.js'
import type {
  ProviderAutomationPolicy,
  ProviderBillingMode,
  ProviderCredentialKind,
  ProviderExecutableDiscoveryV1,
  ProviderExecutionScope,
  ProviderManifestV1,
  ProviderOverageBehavior,
  ProviderReadinessV1,
  ProviderReleaseState,
  ProviderRuntimeMode,
} from './provider-contract.js'

const PROVIDER_IDS = ['claude', 'codex', 'qwen', 'kimi', 'opencode'] as const
const IDENTIFIER = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const PLATFORM = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const ENVIRONMENT_VARIABLE = /^[A-Z_][A-Z0-9_]{0,127}$/
const PROBE_ARGUMENT = /^(?:--?)?[A-Za-z0-9][A-Za-z0-9._:/=-]{0,127}$/
const SOURCE_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

export type DeclaredProviderIdV1 = typeof PROVIDER_IDS[number]

export type DeclaredProviderCompatibilityEntryV1 = {
  provider_id: DeclaredProviderIdV1
  adapter_id: string
  release_state: ProviderReleaseState
  executable: {
    command: string
    source: ProviderManifestV1['executable']['source']
    command_override_env: string | null
    exact_versions: readonly string[]
    exact_platforms: readonly string[]
  }
  native_subscription: {
    mode_id: string
    runtime_mode: ProviderRuntimeMode
    billing_mode: Exclude<ProviderBillingMode, 'unknown'>
    credential_kind: Exclude<ProviderCredentialKind, 'unknown'>
    authentication_mechanism: string
    safe_readiness_probe: readonly string[] | null
    automation_policy: ProviderAutomationPolicy
    overage_behavior: ProviderOverageBehavior
    explicit_overage_consent_required: boolean
  }
  provider_api: {
    mode_id: string
    runtime_mode: ProviderRuntimeMode
    billing_mode: Exclude<ProviderBillingMode, 'unknown'>
    credential_kind: Exclude<ProviderCredentialKind, 'unknown'>
    explicit_opt_in_required: true
    automatic_fallback_allowed: false
  }
  acceptance: {
    real_matrix_state: 'missing' | 'passed'
    support_claim: 'blocked' | 'ready'
    blocker_codes: readonly string[]
  }
}

export type DeclaredProviderCompatibilityContractV1 = {
  schema_version: 1
  evidence_standard: 'real_exact_eight_gate'
  source_commit_required: true
  mock_evidence_authorizes_support: false
  providers: readonly DeclaredProviderCompatibilityEntryV1[]
}

const ownRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype)

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

const exactStringArray = (
  value: unknown,
  pattern: RegExp,
  allowEmpty = false,
): value is string[] => Array.isArray(value)
  && (allowEmpty || value.length > 0)
  && new Set(value).size === value.length
  && value.every((entry) => typeof entry === 'string' && pattern.test(entry))

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

const compatibilityError = (detail: string): never => {
  throw new Error(`invalid declared-provider compatibility contract: ${detail}`)
}

const validateExecutable = (
  value: unknown,
  manifest: ProviderManifestV1,
): DeclaredProviderCompatibilityEntryV1['executable'] => {
  const record = ownRecord(value)
    ? value
    : compatibilityError(`${manifest.provider_id} executable declaration mismatch`)
  if (!exactKeys(record, [
      'command',
      'source',
      'command_override_env',
      'exact_versions',
      'exact_platforms',
    ])
    || record.command !== manifest.executable.command
    || record.source !== manifest.executable.source
    || record.command_override_env !== (manifest.executable.command_override_env ?? null)
    || !exactStringArray(record.exact_versions, VERSION, true)
    || !exactStringArray(record.exact_platforms, PLATFORM, true)
    || !sameStrings(record.exact_versions, manifest.executable.validated_versions)
    || !sameStrings(record.exact_platforms, manifest.executable.supported_platforms)) {
    compatibilityError(`${manifest.provider_id} executable declaration mismatch`)
  }
  if (record.command_override_env !== null
    && (typeof record.command_override_env !== 'string'
      || !ENVIRONMENT_VARIABLE.test(record.command_override_env))) {
    compatibilityError(`${manifest.provider_id} command override is invalid`)
  }
  return record as DeclaredProviderCompatibilityEntryV1['executable']
}

const validateNativeSubscription = (
  value: unknown,
  manifest: ProviderManifestV1,
): DeclaredProviderCompatibilityEntryV1['native_subscription'] => {
  const mode = manifest.modes.find((candidate) => candidate.priority === 'primary')
  if (!mode
    || !ownRecord(value)
    || !exactKeys(value, [
      'mode_id',
      'runtime_mode',
      'billing_mode',
      'credential_kind',
      'authentication_mechanism',
      'safe_readiness_probe',
      'automation_policy',
      'overage_behavior',
      'explicit_overage_consent_required',
    ])
    || value.mode_id !== mode.id
    || value.runtime_mode !== mode.runtime_mode
    || value.billing_mode !== 'personal_subscription'
    || value.billing_mode !== mode.billing_mode
    || value.credential_kind !== mode.default_credential_kind
    || typeof value.authentication_mechanism !== 'string'
    || !IDENTIFIER.test(value.authentication_mechanism)
    || (value.safe_readiness_probe !== null
      && !exactStringArray(value.safe_readiness_probe, PROBE_ARGUMENT))
    || value.automation_policy !== mode.automation_policy
    || value.overage_behavior !== mode.overage.behavior
    || value.explicit_overage_consent_required !== mode.overage.explicit_consent_required) {
    compatibilityError(`${manifest.provider_id} subscription declaration mismatch`)
  }
  return value as DeclaredProviderCompatibilityEntryV1['native_subscription']
}

const validateProviderApi = (
  value: unknown,
  manifest: ProviderManifestV1,
): DeclaredProviderCompatibilityEntryV1['provider_api'] => {
  const mode = manifest.modes.find((candidate) =>
    candidate.billing_mode === 'usage_priced_api')
  if (!mode
    || !ownRecord(value)
    || !exactKeys(value, [
      'mode_id',
      'runtime_mode',
      'billing_mode',
      'credential_kind',
      'explicit_opt_in_required',
      'automatic_fallback_allowed',
    ])
    || value.mode_id !== mode.id
    || value.runtime_mode !== mode.runtime_mode
    || value.billing_mode !== 'usage_priced_api'
    || value.credential_kind !== mode.default_credential_kind
    || value.explicit_opt_in_required !== true
    || mode.usage_priced_api_consent_required !== true
    || value.automatic_fallback_allowed !== false) {
    compatibilityError(`${manifest.provider_id} provider-API declaration mismatch`)
  }
  return value as DeclaredProviderCompatibilityEntryV1['provider_api']
}

const validateAcceptance = (
  value: unknown,
  manifest: ProviderManifestV1,
): DeclaredProviderCompatibilityEntryV1['acceptance'] => {
  if (!ownRecord(value)
    || !exactKeys(value, [
      'real_matrix_state',
      'support_claim',
      'blocker_codes',
    ])
    || !['missing', 'passed'].includes(String(value.real_matrix_state))
    || !['blocked', 'ready'].includes(String(value.support_claim))
    || !exactStringArray(value.blocker_codes, IDENTIFIER, true)
    || (value.real_matrix_state === 'missing'
      && (value.support_claim !== 'blocked'
        || value.blocker_codes.length === 0))
    || (value.real_matrix_state === 'passed'
      && (value.support_claim !== 'ready'
        || value.blocker_codes.length !== 0))) {
    compatibilityError(`${manifest.provider_id} acceptance declaration is invalid`)
  }
  return value as DeclaredProviderCompatibilityEntryV1['acceptance']
}

export function defineDeclaredProviderCompatibilityContractV1(
  value: unknown,
): Readonly<DeclaredProviderCompatibilityContractV1> {
  const record = ownRecord(value)
    ? value
    : compatibilityError('top-level declaration mismatch')
  if (!exactKeys(record, [
      'schema_version',
      'evidence_standard',
      'source_commit_required',
      'mock_evidence_authorizes_support',
      'providers',
    ])
    || record.schema_version !== 1
    || record.evidence_standard !== 'real_exact_eight_gate'
    || record.source_commit_required !== true
    || record.mock_evidence_authorizes_support !== false
    || !Array.isArray(record.providers)
    || record.providers.length !== PROVIDER_IDS.length) {
    compatibilityError('top-level declaration mismatch')
  }
  const providerValues = Array.isArray(record.providers)
    ? record.providers
    : compatibilityError('provider declarations are invalid')

  const manifests = new Map(FIRST_RELEASE_PROVIDER_MANIFESTS_V1.map((manifest) => [
    manifest.provider_id,
    manifest,
  ]))
  const providers = providerValues.map((entry: unknown, index: number) => {
    const expectedProviderId = PROVIDER_IDS[index]
    const manifest = manifests.get(expectedProviderId)
      ?? compatibilityError(`${expectedProviderId} provider manifest is missing`)
    const entryRecord = ownRecord(entry)
      ? entry
      : compatibilityError(`${expectedProviderId} provider declaration mismatch`)
    if (!exactKeys(entryRecord, [
        'provider_id',
        'adapter_id',
        'release_state',
        'executable',
        'native_subscription',
        'provider_api',
        'acceptance',
      ])
      || entryRecord.provider_id !== expectedProviderId
      || entryRecord.adapter_id !== manifest.adapter_id
      || entryRecord.release_state !== manifest.release_state) {
      compatibilityError(`${expectedProviderId} provider declaration mismatch`)
    }
    return {
      provider_id: expectedProviderId,
      adapter_id: manifest.adapter_id,
      release_state: manifest.release_state,
      executable: validateExecutable(entryRecord.executable, manifest),
      native_subscription: validateNativeSubscription(
        entryRecord.native_subscription,
        manifest,
      ),
      provider_api: validateProviderApi(entryRecord.provider_api, manifest),
      acceptance: validateAcceptance(entryRecord.acceptance, manifest),
    }
  })

  return deepFreeze({
    schema_version: 1 as const,
    evidence_standard: 'real_exact_eight_gate' as const,
    source_commit_required: true as const,
    mock_evidence_authorizes_support: false as const,
    providers,
  })
}

export const DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1 =
  defineDeclaredProviderCompatibilityContractV1(
    compatibilityContract.declared_provider_matrix,
  )

export type DeclaredProviderEvidenceKindV1 = 'observed' | 'source_only' | 'mock'

export type DeclaredProviderCompatibilityEvidenceV1 = {
  provider_id: DeclaredProviderIdV1
  execution_scope: ProviderExecutionScope
  evidence_kind: DeclaredProviderEvidenceKindV1
  source_commit: string
  discovery: ProviderExecutableDiscoveryV1
  readiness: ProviderReadinessV1
  acceptance_matrix: DeclaredProviderAcceptanceMatrixV1 | null
}

export type DeclaredProviderCompatibilityBlockerV1 =
  | 'acceptance_gate_incomplete'
  | 'acceptance_matrix_invalid'
  | 'acceptance_matrix_mismatch'
  | 'acceptance_matrix_missing'
  | 'authentication_not_ready'
  | 'automation_not_allowed'
  | 'billing_not_verified'
  | 'declared_support_blocked'
  | 'environment_audit_incomplete'
  | 'executable_evidence_mismatch'
  | 'executable_missing'
  | 'executable_not_validated'
  | 'executable_probe_indeterminate'
  | 'executable_source_mismatch'
  | 'executable_version_not_validated'
  | 'manifest_not_validated'
  | 'mode_not_supported'
  | 'non_observed_evidence'
  | 'overage_consent_missing'
  | 'overage_not_verified'
  | 'platform_not_validated'
  | 'provider_declaration_mismatch'
  | 'source_commit_invalid'

export type DeclaredProviderCompatibilityAssessmentV1 = {
  ready: boolean
  provider_id: DeclaredProviderIdV1
  blockers: readonly DeclaredProviderCompatibilityBlockerV1[]
}

const selectionMatches = (
  declaration: DeclaredProviderCompatibilityEntryV1,
  readiness: ProviderReadinessV1,
): boolean => readiness.selection.provider_id === declaration.provider_id
  && readiness.selection.adapter_id === declaration.adapter_id
  && readiness.selection.mode_id === declaration.native_subscription.mode_id
  && readiness.selection.runtime_mode === declaration.native_subscription.runtime_mode
  && readiness.selection.billing_mode === declaration.native_subscription.billing_mode
  && readiness.selection.credential_kind === declaration.native_subscription.credential_kind

const overageBlockers = (
  declaration: DeclaredProviderCompatibilityEntryV1,
  readiness: ProviderReadinessV1,
  blockers: Set<DeclaredProviderCompatibilityBlockerV1>,
): void => {
  const behavior = declaration.native_subscription.overage_behavior
  if (behavior === 'none') {
    if (readiness.overage_status !== 'not_applicable'
      || readiness.overage_consent !== 'not_required') {
      blockers.add('overage_not_verified')
    }
    return
  }
  if (readiness.overage_status === 'disabled') {
    if (behavior === 'always_metered') blockers.add('overage_not_verified')
    return
  }
  if (readiness.overage_status !== 'enabled') {
    blockers.add('overage_not_verified')
    return
  }
  if (readiness.overage_consent !== 'granted') {
    blockers.add('overage_consent_missing')
  }
  if (readiness.metering_status !== 'ready'
    || readiness.cost_cap_status !== 'enforced') {
    blockers.add('overage_not_verified')
  }
}

const acceptanceMatches = (
  matrix: Readonly<DeclaredProviderAcceptanceMatrixV1>,
  declaration: DeclaredProviderCompatibilityEntryV1,
  evidence: DeclaredProviderCompatibilityEvidenceV1,
): boolean => matrix.provider_id === declaration.provider_id
  && matrix.adapter_id === declaration.adapter_id
  && matrix.adapter_version === FIRST_RELEASE_PROVIDER_MANIFESTS_V1
    .find((manifest) => manifest.provider_id === declaration.provider_id)
    ?.adapter_version
  && matrix.mode_id === declaration.native_subscription.mode_id
  && matrix.runtime_mode === declaration.native_subscription.runtime_mode
  && matrix.billing_mode === declaration.native_subscription.billing_mode
  && matrix.credential_kind === declaration.native_subscription.credential_kind
  && matrix.executable_version === evidence.discovery.version
  && matrix.platform === evidence.discovery.platform
  && matrix.source_commit === evidence.source_commit

export function assessDeclaredProviderCompatibilityV1(
  evidence: DeclaredProviderCompatibilityEvidenceV1,
): Readonly<DeclaredProviderCompatibilityAssessmentV1> {
  const declaration = DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1.providers
    .find((candidate) => candidate.provider_id === evidence.provider_id)
  const manifest = FIRST_RELEASE_PROVIDER_MANIFESTS_V1
    .find((candidate) => candidate.provider_id === evidence.provider_id)
  const blockers = new Set<DeclaredProviderCompatibilityBlockerV1>()
  if (!declaration || !manifest) {
    blockers.add('provider_declaration_mismatch')
    return Object.freeze({
      ready: false,
      provider_id: evidence.provider_id,
      blockers: Object.freeze([...blockers]),
    })
  }

  if (evidence.evidence_kind !== 'observed') blockers.add('non_observed_evidence')
  if (!SOURCE_COMMIT.test(evidence.source_commit)) blockers.add('source_commit_invalid')
  if (declaration.acceptance.support_claim !== 'ready') {
    blockers.add('declared_support_blocked')
  }
  if (manifest.release_state !== 'validated') blockers.add('manifest_not_validated')
  if (manifest.environment.audit_state !== 'complete') {
    blockers.add('environment_audit_incomplete')
  }
  const mode = manifest.modes.find((candidate) =>
    candidate.id === declaration.native_subscription.mode_id)
  if (!mode || mode.support.state !== 'supported') blockers.add('mode_not_supported')
  if (!selectionMatches(declaration, evidence.readiness)) {
    blockers.add('provider_declaration_mismatch')
  }
  if (evidence.readiness.automation_policy
    !== declaration.native_subscription.automation_policy) {
    blockers.add('provider_declaration_mismatch')
  }

  if (evidence.discovery.provider_id !== declaration.provider_id
    || evidence.discovery.adapter_id !== declaration.adapter_id
    || evidence.readiness.executable_fingerprint !== evidence.discovery.executable_fingerprint) {
    blockers.add('executable_evidence_mismatch')
  }
  if (evidence.discovery.status !== 'validated'
    || evidence.readiness.executable_status !== 'validated') {
    blockers.add('executable_not_validated')
  }
  if (evidence.discovery.status === 'missing') blockers.add('executable_missing')
  if (evidence.discovery.status === 'unknown'
    || evidence.readiness.executable_status === 'unknown') {
    blockers.add('executable_probe_indeterminate')
  }
  const sourceMatches = declaration.executable.source === 'sdk_bundled'
    ? evidence.discovery.source === 'sdk_bundled'
    : evidence.discovery.source === 'path'
      || (evidence.discovery.source === 'environment_override'
        && declaration.executable.command_override_env !== null)
  if (!sourceMatches) blockers.add('executable_source_mismatch')
  if (evidence.discovery.version === null
    || !declaration.executable.exact_versions.includes(evidence.discovery.version)) {
    blockers.add('executable_version_not_validated')
  }
  if (evidence.discovery.platform === null
    || !declaration.executable.exact_platforms.includes(evidence.discovery.platform)) {
    blockers.add('platform_not_validated')
  }
  if (evidence.readiness.auth_status !== 'ready') {
    blockers.add('authentication_not_ready')
  }
  if (declaration.native_subscription.automation_policy === 'blocked'
    || declaration.native_subscription.automation_policy === 'unknown'
    || (declaration.native_subscription.automation_policy === 'interactive_only'
      && evidence.execution_scope !== 'interactive')) {
    blockers.add('automation_not_allowed')
  }
  overageBlockers(declaration, evidence.readiness, blockers)

  let matrix: Readonly<DeclaredProviderAcceptanceMatrixV1> | null = null
  if (evidence.acceptance_matrix === null) {
    blockers.add('acceptance_matrix_missing')
    blockers.add('billing_not_verified')
  } else {
    try {
      matrix = defineDeclaredProviderAcceptanceMatrixV1(evidence.acceptance_matrix)
    } catch {
      blockers.add('acceptance_matrix_invalid')
    }
    if (matrix && !acceptanceMatches(matrix, declaration, evidence)) {
      blockers.add('acceptance_matrix_mismatch')
    }
    if (matrix && matrix.gates.subscription_billing.state !== 'passed') {
      blockers.add('billing_not_verified')
    }
    if (matrix && DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.some((gateId) =>
      matrix!.gates[gateId].state !== 'passed')) {
      blockers.add('acceptance_gate_incomplete')
    }
  }

  const sortedBlockers = Object.freeze([...blockers].sort())
  return Object.freeze({
    ready: sortedBlockers.length === 0,
    provider_id: evidence.provider_id,
    blockers: sortedBlockers,
  })
}

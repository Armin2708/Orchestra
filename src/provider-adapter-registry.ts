import {
  defineProviderManifestV1,
  isValidatedProviderExecutionAdapterV1,
  type ProviderExecutionAdapterV1,
  type ProviderExecutionSelectionV1,
  type ProviderManifestV1,
} from './provider-contract.js'
import { FIRST_RELEASE_PROVIDER_MANIFESTS_V1 } from './provider-manifests.js'

export const DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1 = Object.freeze([
  'executable_provenance',
  'subscription_billing',
  'credential_conflict',
  'managed_lifecycle',
  'restart_recovery',
  'raw_terminal_coexistence',
  'failure_semantics',
  'credential_redaction',
] as const)

export type DeclaredProviderAcceptanceGateIdV1 =
  typeof DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1[number]

export type DeclaredProviderAcceptanceGateV1 = {
  state: 'passed' | 'failed' | 'not_run'
  evidence_refs: readonly string[]
}

export type DeclaredProviderAcceptanceMatrixV1 = {
  contract_version: 1
  provider_id: string
  adapter_id: string
  adapter_version: string
  mode_id: string
  runtime_mode: ProviderExecutionSelectionV1['runtime_mode']
  billing_mode: ProviderExecutionSelectionV1['billing_mode']
  credential_kind: ProviderExecutionSelectionV1['credential_kind']
  executable_version: string
  platform: string
  source_commit: string
  observed_at: string
  gates: Record<
    DeclaredProviderAcceptanceGateIdV1,
    DeclaredProviderAcceptanceGateV1
  >
}

export type ProviderSupportClaimBlockerV1 =
  | 'undeclared_provider'
  | 'adapter_not_registered'
  | 'manifest_not_validated'
  | 'environment_audit_incomplete'
  | 'selection_mismatch'
  | 'mode_not_supported'
  | 'automation_policy_not_allowed'
  | 'executable_version_not_declared'
  | 'platform_not_declared'
  | 'source_commit_mismatch'
  | 'acceptance_matrix_missing'
  | 'acceptance_gate_incomplete'

export type ProviderSupportAssessmentV1 =
  | {
      ready: false
      blockers: readonly ProviderSupportClaimBlockerV1[]
    }
  | {
      ready: true
      adapter: ProviderExecutionAdapterV1
      matrix: Readonly<DeclaredProviderAcceptanceMatrixV1>
    }

export type ProviderAdapterDeclarationV1 = {
  provider_id: string
  adapter_id: string
  release_state: ProviderManifestV1['release_state']
  adapter_registered: boolean
  acceptance_matrix_count: number
}

export class ProviderAdapterSupportError extends Error {
  constructor(
    readonly provider_id: string,
    readonly blockers: readonly ProviderSupportClaimBlockerV1[],
  ) {
    super(`provider support is not validated: ${provider_id} (${blockers.join(', ')})`)
    this.name = 'ProviderAdapterSupportError'
  }
}

const IDENTIFIER = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const PLATFORM = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const SOURCE_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9./:@_?&=%+#-]{0,2047}$/

const matrixKey = (
  selection: ProviderExecutionSelectionV1,
  executableVersion: string,
  platform: string,
  sourceCommit: string,
): string => [
  selection.provider_id,
  selection.adapter_id,
  selection.mode_id,
  selection.runtime_mode,
  selection.billing_mode,
  selection.credential_kind,
  executableVersion,
  platform,
  sourceCommit,
].join('\u0000')

const ownRecord = (value: unknown): value is Record<string, unknown> => {
  try {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype)
  } catch {
    return false
  }
}

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

const validIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && IDENTIFIER.test(value)

const defineAcceptanceMatrix = (
  value: DeclaredProviderAcceptanceMatrixV1,
): Readonly<DeclaredProviderAcceptanceMatrixV1> => {
  if (!ownRecord(value)
    || !exactKeys(value, [
      'contract_version',
      'provider_id',
      'adapter_id',
      'adapter_version',
      'mode_id',
      'runtime_mode',
      'billing_mode',
      'credential_kind',
      'executable_version',
      'platform',
      'source_commit',
      'observed_at',
      'gates',
    ])
    || value.contract_version !== 1
    || !validIdentifier(value.provider_id)
    || !validIdentifier(value.adapter_id)
    || !validIdentifier(value.mode_id)
    || !['native_cli', 'provider_api'].includes(String(value.runtime_mode))
    || !['personal_subscription', 'usage_priced_api'].includes(String(value.billing_mode))
    || ![
      'provider_account_session',
      'subscription_scoped_key',
      'subscription_access_token',
      'usage_priced_api_key',
    ].includes(String(value.credential_kind))
    || typeof value.adapter_version !== 'string'
    || !VERSION.test(value.adapter_version)
    || typeof value.executable_version !== 'string'
    || !VERSION.test(value.executable_version)
    || typeof value.platform !== 'string'
    || !PLATFORM.test(value.platform)
    || typeof value.source_commit !== 'string'
    || !SOURCE_COMMIT.test(value.source_commit)
    || typeof value.observed_at !== 'string'
    || !Number.isFinite(Date.parse(value.observed_at))
    || Date.parse(value.observed_at) > Date.now() + 5_000
    || !ownRecord(value.gates)
    || !exactKeys(value.gates, DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1)) {
    throw new Error('invalid declared-provider acceptance matrix')
  }
  const gates = Object.fromEntries(
    DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.map((gateId) => {
      const gate = value.gates[gateId]
      if (!ownRecord(gate)
        || !exactKeys(gate, ['state', 'evidence_refs'])
        || !['passed', 'failed', 'not_run'].includes(String(gate.state))
        || !Array.isArray(gate.evidence_refs)
        || gate.evidence_refs.some((reference) =>
          typeof reference !== 'string' || !EVIDENCE_REF.test(reference))
        || new Set(gate.evidence_refs).size !== gate.evidence_refs.length
        || (gate.state === 'passed' && gate.evidence_refs.length === 0)) {
        throw new Error('invalid declared-provider acceptance gate')
      }
      return [
        gateId,
        Object.freeze({
          state: gate.state,
          evidence_refs: Object.freeze([...gate.evidence_refs]),
        }),
      ]
    }),
  ) as Record<
    DeclaredProviderAcceptanceGateIdV1,
    DeclaredProviderAcceptanceGateV1
  >
  return Object.freeze({
    contract_version: 1,
    provider_id: value.provider_id,
    adapter_id: value.adapter_id,
    adapter_version: value.adapter_version,
    mode_id: value.mode_id,
    runtime_mode: value.runtime_mode,
    billing_mode: value.billing_mode,
    credential_kind: value.credential_kind,
    executable_version: value.executable_version,
    platform: value.platform,
    source_commit: value.source_commit,
    observed_at: value.observed_at,
    gates: Object.freeze(gates),
  })
}

export const defineDeclaredProviderAcceptanceMatrixV1 = (
  value: DeclaredProviderAcceptanceMatrixV1,
): Readonly<DeclaredProviderAcceptanceMatrixV1> =>
  defineAcceptanceMatrix(value)

export class ProviderAdapterRegistryV1 {
  readonly #manifests = new Map<string, Readonly<ProviderManifestV1>>()
  readonly #adapters = new Map<string, ProviderExecutionAdapterV1>()
  readonly #matrices = new Map<string, Readonly<DeclaredProviderAcceptanceMatrixV1>>()

  constructor(
    manifests: readonly ProviderManifestV1[] = FIRST_RELEASE_PROVIDER_MANIFESTS_V1,
  ) {
    for (const manifest of manifests) {
      const defined = defineProviderManifestV1(manifest)
      if (this.#manifests.has(defined.provider_id)) {
        throw new Error(`provider manifest already declared: ${defined.provider_id}`)
      }
      if ([...this.#manifests.values()].some((candidate) =>
        candidate.adapter_id === defined.adapter_id)) {
        throw new Error(`provider adapter already declared: ${defined.adapter_id}`)
      }
      this.#manifests.set(defined.provider_id, defined)
    }
  }

  register(adapter: ProviderExecutionAdapterV1): this {
    if (!isValidatedProviderExecutionAdapterV1(adapter)) {
      throw new Error('validated provider adapter is required')
    }
    const manifest = this.#manifests.get(adapter.manifest.provider_id)
    if (!manifest || manifest !== adapter.manifest) {
      throw new Error('provider adapter manifest was not declared')
    }
    if (this.#adapters.has(manifest.provider_id)) {
      throw new Error(`provider adapter already registered: ${manifest.provider_id}`)
    }
    this.#adapters.set(manifest.provider_id, adapter)
    return this
  }

  recordAcceptance(matrix: DeclaredProviderAcceptanceMatrixV1): this {
    const defined = defineAcceptanceMatrix(matrix)
    const manifest = this.#manifests.get(defined.provider_id)
    const mode = manifest?.modes.find((candidate) => candidate.id === defined.mode_id)
    if (!manifest
      || defined.adapter_id !== manifest.adapter_id
      || defined.adapter_version !== manifest.adapter_version
      || !mode
      || defined.runtime_mode !== mode.runtime_mode
      || defined.billing_mode !== mode.billing_mode
      || !mode.credential_kinds.includes(
        defined.credential_kind as Exclude<
          ProviderExecutionSelectionV1['credential_kind'],
          'unknown'
        >,
      )) {
      throw new Error('acceptance matrix does not match a declared provider tuple')
    }
    const key = matrixKey(
      defined,
      defined.executable_version,
      defined.platform,
      defined.source_commit,
    )
    const previous = this.#matrices.get(key)
    if (previous
      && Date.parse(defined.observed_at) <= Date.parse(previous.observed_at)) {
      throw new Error('newer declared-provider acceptance evidence is required')
    }
    this.#matrices.set(key, defined)
    return this
  }

  assessSupport(
    selection: ProviderExecutionSelectionV1,
    executableVersion: string,
    platform: string,
    sourceCommit: string,
  ): ProviderSupportAssessmentV1 {
    const manifest = this.#manifests.get(selection.provider_id)
    if (!manifest) return { ready: false, blockers: ['undeclared_provider'] }
    const blockers = new Set<ProviderSupportClaimBlockerV1>()
    const adapter = this.#adapters.get(selection.provider_id)
    if (!adapter) blockers.add('adapter_not_registered')
    if (manifest.release_state !== 'validated') blockers.add('manifest_not_validated')
    if (manifest.environment.audit_state !== 'complete') {
      blockers.add('environment_audit_incomplete')
    }
    const mode = manifest.modes.find((candidate) => candidate.id === selection.mode_id)
    if (selection.adapter_id !== manifest.adapter_id
      || !mode
      || selection.runtime_mode !== mode.runtime_mode
      || selection.billing_mode !== mode.billing_mode
      || !mode.credential_kinds.includes(
        selection.credential_kind as Exclude<
          ProviderExecutionSelectionV1['credential_kind'],
          'unknown'
        >,
      )) {
      blockers.add('selection_mismatch')
    }
    if (!mode || mode.support.state !== 'supported') blockers.add('mode_not_supported')
    if (!mode || mode.automation_policy !== 'allowed') {
      blockers.add('automation_policy_not_allowed')
    }
    if (!manifest.executable.validated_versions.includes(executableVersion)) {
      blockers.add('executable_version_not_declared')
    }
    if (!manifest.executable.supported_platforms.includes(platform)) {
      blockers.add('platform_not_declared')
    }
    const matrix = this.#matrices.get(matrixKey(
      selection,
      executableVersion,
      platform,
      sourceCommit,
    ))
    if (!matrix) {
      const priorTuple = [...this.#matrices.values()].some((candidate) =>
        candidate.provider_id === selection.provider_id
        && candidate.adapter_id === selection.adapter_id
        && candidate.mode_id === selection.mode_id
        && candidate.runtime_mode === selection.runtime_mode
        && candidate.billing_mode === selection.billing_mode
        && candidate.credential_kind === selection.credential_kind
        && candidate.executable_version === executableVersion
        && candidate.platform === platform)
      blockers.add(priorTuple ? 'source_commit_mismatch' : 'acceptance_matrix_missing')
    } else if (DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.some((gateId) =>
      matrix.gates[gateId].state !== 'passed')) {
      blockers.add('acceptance_gate_incomplete')
    }
    if (blockers.size || !adapter || !matrix) {
      return {
        ready: false,
        blockers: Object.freeze([...blockers].sort()),
      }
    }
    return { ready: true, adapter, matrix }
  }

  requireSupported(
    selection: ProviderExecutionSelectionV1,
    executableVersion: string,
    platform: string,
    sourceCommit: string,
  ): ProviderExecutionAdapterV1 {
    const assessment = this.assessSupport(
      selection,
      executableVersion,
      platform,
      sourceCommit,
    )
    if (!assessment.ready) {
      throw new ProviderAdapterSupportError(selection.provider_id, assessment.blockers)
    }
    return assessment.adapter
  }

  declarations(): readonly ProviderAdapterDeclarationV1[] {
    return Object.freeze([...this.#manifests.values()]
      .map((manifest) => Object.freeze({
        provider_id: manifest.provider_id,
        adapter_id: manifest.adapter_id,
        release_state: manifest.release_state,
        adapter_registered: this.#adapters.has(manifest.provider_id),
        acceptance_matrix_count: [...this.#matrices.values()]
          .filter((matrix) => matrix.provider_id === manifest.provider_id).length,
      }))
      .sort((left, right) => left.provider_id.localeCompare(right.provider_id)))
  }
}

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { redactSensitiveText } from './agent-os/structured-redaction.js'

const VALIDATED_PROVIDER_ADAPTER_BRAND: unique symbol = Symbol('validated-provider-adapter-brand')

export const PROVIDER_CONTRACT_VERSION = 1 as const
export const PROVIDER_READINESS_MAX_AGE_MS = 30_000
export const PROVIDER_READINESS_FUTURE_SKEW_MS = 5_000
export const PROVIDER_LAUNCH_AUTHORIZATION_TTL_MS = 5_000
export const PROVIDER_SESSION_REGISTRY_LIMIT = 1_024
export const PROVIDER_EVENT_ID_WINDOW_LIMIT = 4_096

export const PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1 = [
  ['ANTHROPIC_API_KEY', 'credential'],
  ['ANTHROPIC_AUTH_TOKEN', 'credential'],
  ['ANTHROPIC_AWS_API_KEY', 'credential'],
  ['ANTHROPIC_FOUNDRY_API_KEY', 'credential'],
  ['ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'credential'],
  ['AWS_BEARER_TOKEN_BEDROCK', 'credential'],
  ['ANTHROPIC_CUSTOM_HEADERS', 'credential'],
  ['CLAUDE_CODE_OAUTH_TOKEN', 'credential'],
  ['CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'provisioning'],
  ['CLAUDE_CODE_OAUTH_SCOPES', 'provisioning'],
  ['CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'provider_selector'],
  ['CLAUDE_CODE_SIMPLE', 'provider_selector'],
  ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'provider_selector'],
  ['CLAUDE_CODE_USE_BEDROCK', 'provider_selector'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'provider_selector'],
  ['CLAUDE_CODE_USE_MANTLE', 'provider_selector'],
  ['CLAUDE_CODE_USE_VERTEX', 'provider_selector'],
  ['ANTHROPIC_BASE_URL', 'endpoint'],
  ['ANTHROPIC_AWS_BASE_URL', 'endpoint'],
  ['ANTHROPIC_AWS_WORKSPACE_ID', 'provider_selector'],
  ['ANTHROPIC_BEDROCK_BASE_URL', 'endpoint'],
  ['ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'endpoint'],
  ['ANTHROPIC_VERTEX_BASE_URL', 'endpoint'],
  ['ANTHROPIC_VERTEX_PROJECT_ID', 'provider_selector'],
  ['ANTHROPIC_FOUNDRY_BASE_URL', 'endpoint'],
  ['ANTHROPIC_FOUNDRY_RESOURCE', 'provider_selector'],
  ['ANTHROPIC_WORKSPACE_ID', 'provider_selector'],
  ['CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH', 'provider_selector'],
  ['CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'provider_selector'],
  ['CLAUDE_CODE_SKIP_FOUNDRY_AUTH', 'provider_selector'],
  ['OPENAI_API_KEY', 'credential'],
  ['OPENAI_BASE_URL', 'endpoint'],
  ['OPENAI_ORGANIZATION', 'provider_selector'],
  ['OPENAI_ORG_ID', 'provider_selector'],
  ['OPENAI_PROJECT', 'provider_selector'],
  ['CODEX_API_KEY', 'credential'],
  ['CODEX_ACCESS_TOKEN', 'credential'],
] as const
for (const conflict of PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1) Object.freeze(conflict)
Object.freeze(PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1)

const PROVIDER_MANAGED_ENVIRONMENT_CATEGORY_BY_VARIABLE_V1: ReadonlyMap<string, string> = new Map(
  PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1,
)

const CODEX_MANAGED_ENVIRONMENT_VARIABLES_V1 = new Set([
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
])

const PROVIDER_MANAGED_ENVIRONMENT_OWNER_BY_VARIABLE_V1: ReadonlyMap<
  string,
  readonly [provider_id: string, adapter_id: string]
> = new Map(PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1.map(([variable]) => [
  variable,
  CODEX_MANAGED_ENVIRONMENT_VARIABLES_V1.has(variable)
    ? ['codex', 'codex-app-server']
    : ['claude', 'claude-agent-sdk'],
]))

const PROVIDER_SUBSCRIPTION_ENVIRONMENT_CREDENTIALS_V1: ReadonlyMap<
  string,
  readonly string[]
> = new Map([
  ['CLAUDE_CODE_OAUTH_TOKEN', ['subscription_access_token']],
  ['CODEX_ACCESS_TOKEN', ['subscription_access_token']],
] as const)

export const PROVIDER_CAPABILITY_IDS = [
  'launch',
  'follow_up',
  'attach',
  'resume',
  'restart_recovery',
  'fork',
  'interrupt',
  'cancel',
  'stop',
  'model_discovery',
  'model_selection',
  'effort',
  'approvals',
  'access_profile',
  'structured_events',
  'usage',
  'rate_limits',
  'token_budget',
  'cost_budget',
  'mcp',
  'plugins',
  'skills',
  'hooks',
  'raw_terminal_coexistence',
] as const
Object.freeze(PROVIDER_CAPABILITY_IDS)

export type ProviderCapabilityId = typeof PROVIDER_CAPABILITY_IDS[number]
export type ProviderRuntimeMode = 'native_cli' | 'provider_api'
export type ProviderBillingMode = 'personal_subscription' | 'usage_priced_api' | 'unknown'
export type ProviderCredentialKind =
  | 'provider_account_session'
  | 'subscription_scoped_key'
  | 'subscription_access_token'
  | 'usage_priced_api_key'
  | 'unknown'

const managedEnvironmentVariableAllowsSelection = (
  variable: string,
  providerId: string,
  adapterId: string,
  billingMode: Exclude<ProviderBillingMode, 'unknown'>,
  credentialKind: Exclude<ProviderCredentialKind, 'unknown'>,
): boolean => {
  const category = PROVIDER_MANAGED_ENVIRONMENT_CATEGORY_BY_VARIABLE_V1.get(variable)
  if (category === undefined) return true
  const owner = PROVIDER_MANAGED_ENVIRONMENT_OWNER_BY_VARIABLE_V1.get(variable)
  if (owner === undefined || owner[0] !== providerId || owner[1] !== adapterId) return false
  if (billingMode === 'usage_priced_api') {
    return category !== 'provisioning'
      && !PROVIDER_SUBSCRIPTION_ENVIRONMENT_CREDENTIALS_V1.has(variable)
      && credentialKind === 'usage_priced_api_key'
  }
  return PROVIDER_SUBSCRIPTION_ENVIRONMENT_CREDENTIALS_V1
    .get(variable)
    ?.includes(credentialKind as 'subscription_access_token') === true
}

export type ProviderReleaseState = 'validated' | 'candidate' | 'unsupported'
export type ProviderSupportState = 'supported' | 'unsupported' | 'policy_blocked' | 'unknown'
export type ProviderAutomationPolicy = 'allowed' | 'interactive_only' | 'blocked' | 'unknown'
export type ProviderOverageBehavior = 'none' | 'optional_metered' | 'always_metered' | 'unknown'
export type ProviderExecutionScope = 'interactive' | 'managed_foreground' | 'managed_background'

export type ProviderCapabilitySupportV1 =
  | { state: 'supported' }
  | {
      state: Exclude<ProviderSupportState, 'supported'>
      reason_code: string
    }

export type ProviderCapabilitiesV1 = Record<ProviderCapabilityId, ProviderCapabilitySupportV1>

export type ProviderModeSupportV1 =
  | { state: 'supported' }
  | {
      state: Exclude<ProviderSupportState, 'supported'>
      reason_code: string
    }

export type ProviderExecutionModeV1 = {
  id: string
  runtime_mode: ProviderRuntimeMode
  billing_mode: Exclude<ProviderBillingMode, 'unknown'>
  credential_kinds: readonly Exclude<ProviderCredentialKind, 'unknown'>[]
  default_credential_kind: Exclude<ProviderCredentialKind, 'unknown'>
  priority: 'primary' | 'secondary'
  support: ProviderModeSupportV1
  automation_policy: ProviderAutomationPolicy
  usage_priced_api_consent_required: boolean
  overage: {
    behavior: ProviderOverageBehavior
    explicit_consent_required: boolean
  }
  capabilities: ProviderCapabilitiesV1
}

export type ProviderEnvironmentConflictCategory =
  | 'credential'
  | 'endpoint'
  | 'provider_selector'
  | 'provisioning'

export type ProviderEnvironmentConflictRuleV1 = {
  variable: string
  category: ProviderEnvironmentConflictCategory
  allowed_mode_ids: readonly string[]
  allowed_credential_kinds: readonly Exclude<ProviderCredentialKind, 'unknown'>[]
}

export type ProviderManifestV1 = {
  contract_version: 1
  provider_id: string
  display_name: string
  adapter_id: string
  adapter_version: string
  release_state: ProviderReleaseState
  protocol: 'sdk' | 'app_server' | 'acp' | 'native_cli' | 'provider_api'
  executable: {
    command: string
    source: 'path' | 'sdk_bundled'
    command_override_env?: string
    validated_versions: readonly string[]
    supported_platforms: readonly string[]
  }
  environment: {
    audit_state: 'complete' | 'incomplete'
    conflict_rules: readonly ProviderEnvironmentConflictRuleV1[]
  }
  modes: readonly ProviderExecutionModeV1[]
}

export type ProviderExecutionSelectionV1 = {
  provider_id: string
  adapter_id: string
  mode_id: string
  runtime_mode: ProviderRuntimeMode
  billing_mode: ProviderBillingMode
  credential_kind: ProviderCredentialKind
}

export type ProviderExecutionSelectionRequestV1 = {
  mode_id?: string
  credential_kind?: Exclude<ProviderCredentialKind, 'unknown'>
  usage_priced_api_consent?: boolean
}

export type ProviderCostConsentV1 = {
  state: 'not_required' | 'granted'
  provider_id: string | null
  adapter_id: string | null
  mode_id: string | null
  purpose: 'usage_priced_api' | 'provider_managed_overage' | null
  operator_id: string | null
  granted_at: string | null
  expires_at: string | null
  scope_id: string | null
  receipt_id: string | null
  currency: string | null
  max_cost_minor_units: number | null
}

export type ProviderActionV1 =
  | {
      contract_version: 1
      kind: 'launch'
      action_id: string
      scope_id: string
      cwd: string
      prompt: string
      model: string | null
      effort: string | null
      access_profile: 'read_only' | 'workspace_write' | 'full_access'
      cost_limit: {
        currency: string
        max_cost_minor_units: number
      } | null
    }
  | {
      contract_version: 1
      kind: 'resume'
      action_id: string
      scope_id: string
      provider_session_id: string
      cwd: string
      cost_limit: {
        currency: string
        max_cost_minor_units: number
      } | null
    }
  | {
      contract_version: 1
      kind: 'follow_up'
      action_id: string
      scope_id: string
      session_id: string
      prompt: string
      cost_limit: {
        currency: string
        max_cost_minor_units: number
      } | null
    }
  | {
      contract_version: 1
      kind: 'fork'
      action_id: string
      scope_id: string
      session_id: string
      model: string | null
      effort: string | null
      access_profile: 'read_only' | 'workspace_write' | 'full_access'
      cost_limit: {
        currency: string
        max_cost_minor_units: number
      } | null
    }

export type ProviderExecutionIntentV1 = {
  selection: ProviderExecutionSelectionV1
  execution_scope: ProviderExecutionScope
  usage_priced_api: ProviderCostConsentV1
  provider_managed_overage: ProviderCostConsentV1
  required_capabilities: readonly ProviderCapabilityId[]
}

export type ProviderReadinessV1 = {
  contract_version: 1
  observed_at: string
  selection: ProviderExecutionSelectionV1
  executable_status: 'validated' | 'missing' | 'incompatible' | 'untrusted' | 'unknown'
  auth_status:
    | 'ready'
    | 'signed_out'
    | 'expired'
    | 'revoked'
    | 'credential_conflict'
    | 'unknown'
  automation_policy: ProviderAutomationPolicy
  overage_status: 'not_applicable' | 'disabled' | 'enabled' | 'exhausted' | 'unknown'
  overage_consent: 'not_required' | 'missing' | 'granted' | 'denied'
  metering_status: 'not_required' | 'ready' | 'unavailable' | 'unknown'
  cost_cap_status: 'not_required' | 'enforced' | 'unenforced' | 'unknown'
  executable_fingerprint: string
  environment_fingerprint: string
  configuration_fingerprint: string
}

export type ProviderLaunchBlockerCode =
  | 'unsupported_provider'
  | 'unsupported_mode'
  | 'selection_mismatch'
  | 'missing_executable'
  | 'incompatible_version'
  | 'untrusted_executable'
  | 'executable_unknown'
  | 'authentication_required'
  | 'authentication_unknown'
  | 'credential_conflict'
  | 'billing_mismatch'
  | 'credential_kind_mismatch'
  | 'provider_policy_blocked'
  | 'interactive_only'
  | 'usage_priced_api_consent_required'
  | 'environment_audit_incomplete'
  | 'environment_mismatch'
  | 'configuration_mismatch'
  | 'executable_mismatch'
  | 'unsupported_platform'
  | 'readiness_stale'
  | 'readiness_from_future'
  | 'overage_unknown'
  | 'overage_consent_required'
  | 'overage_policy_mismatch'
  | 'quota_exhausted'
  | 'capability_unsupported'
  | 'metering_unavailable'
  | 'cost_cap_unenforced'
  | 'durable_cost_authority_unavailable'
  | 'cost_consent_scope_mismatch'
  | 'cost_consent_replayed'

export type ProviderLaunchDecisionV1 =
  | {
      ready: true
      selection: ProviderExecutionSelectionV1
    }
  | {
      ready: false
      blockers: readonly ProviderLaunchBlockerCode[]
    }

export type ProviderExecutableDiscoveryV1 = {
  contract_version: 1
  provider_id: string
  adapter_id: string
  status: 'validated' | 'missing' | 'incompatible' | 'untrusted' | 'unknown'
  source: 'path' | 'environment_override' | 'sdk_bundled' | 'unknown'
  version: string | null
  platform: string | null
  resolved_path: string | null
  executable_fingerprint: string
}

export type ProviderModelV1 = {
  id: string
  display_name: string
  is_default: boolean
  supports_effort: boolean
  effort_levels: readonly string[]
}

export type ProviderUsageWindowV1 = {
  kind: 'rolling' | 'daily' | 'weekly' | 'monthly'
  used_percent: number | null
  resets_at: string | null
}

export type ProviderUsageV1 = {
  contract_version: 1
  observed_at: string
  selection: ProviderExecutionSelectionV1
  action_id: string
  scope_id: string
  billing_mode: ProviderBillingMode
  status: 'available' | 'exhausted' | 'unavailable' | 'unknown'
  overage_status: ProviderReadinessV1['overage_status']
  windows: readonly ProviderUsageWindowV1[]
  metered_cost: {
    purpose: 'usage_priced_api' | 'provider_managed_overage'
    receipt_id: string
    currency: string
    incurred_minor_units: number
    limit_minor_units: number
  } | null
}

export type ProviderSessionV1 = {
  contract_version: 1
  session_id: string
  provider_session_id: string
  selection: ProviderExecutionSelectionV1
  status: 'starting' | 'running' | 'idle' | 'stopping' | 'stopped' | 'failed' | 'lost'
  model: {
    requested: string | null
    effective: string
  } | null
  effort: {
    requested: string | null
    effective: string | null
  } | null
  access_profile: {
    requested: 'read_only' | 'workspace_write' | 'full_access' | null
    effective: 'read_only' | 'workspace_write' | 'full_access'
  } | null
}

export type ProviderApprovalDecisionV1 = {
  approval_id: string
  decision: 'approve' | 'reject'
}

export type ProviderEventV1 =
  | {
      kind: 'output'
      event_id: string
      turn_id: string
      session_id: string
      sequence: number
      observed_at: string
      safe_text: string
    }
  | {
      kind: 'status'
      event_id: string
      turn_id: string
      session_id: string
      sequence: number
      observed_at: string
      status: ProviderSessionV1['status']
    }
  | {
      kind: 'tool'
      event_id: string
      turn_id: string
      session_id: string
      sequence: number
      observed_at: string
      tool_call_id: string
      tool_name: string
      phase: 'started' | 'completed' | 'failed'
      safe_summary: string | null
    }
  | {
      kind: 'approval'
      event_id: string
      turn_id: string
      session_id: string
      sequence: number
      observed_at: string
      approval_id: string
      approval_kind: 'command' | 'file_change' | 'tool' | 'other'
      status: 'requested' | 'approved' | 'rejected' | 'expired'
      safe_summary: string
    }
  | {
      kind: 'usage'
      event_id: string
      turn_id: string
      session_id: string
      sequence: number
      observed_at: string
      usage: ProviderUsageV1
    }
  | {
      kind: 'error'
      event_id: string
      turn_id: string
      session_id: string
      sequence: number
      observed_at: string
      code: string
      safe_message: string
    }

export type ProviderLaunchRequestV1 = {
  authorization: AuthorizedProviderLaunchV1
}

export type ProviderResumeRequestV1 = {
  authorization: AuthorizedProviderLaunchV1
}

export type ProviderFollowUpRequestV1 = {
  authorization: AuthorizedProviderLaunchV1
}

export type ProviderAttachRequestV1 = {
  provider_session_id: string
  selection: ProviderExecutionSelectionV1
}

export type ProviderForkRequestV1 = {
  authorization: AuthorizedProviderLaunchV1
}

export type ProviderEventStreamContextV1 = {
  readonly signal: AbortSignal
}

export interface ProviderExecutionAdapterV1 {
  readonly [VALIDATED_PROVIDER_ADAPTER_BRAND]: true
  readonly contract_version: 1
  readonly manifest: Readonly<ProviderManifestV1>
  discoverExecutable(): Promise<ProviderExecutableDiscoveryV1>
  prepareEnvironment(
    intent: ProviderExecutionIntentV1,
    source: NodeJS.ProcessEnv,
    options?: PrepareProviderEnvironmentOptionsV1,
  ): PreparedProviderEnvironmentV1
  probeReadiness(
    intent: ProviderExecutionIntentV1,
    boundary: ProviderLaunchBoundaryV1,
  ): Promise<ProviderReadinessV1>
  listModels(intent: ProviderExecutionIntentV1): Promise<readonly ProviderModelV1[]>
  launch(request: ProviderLaunchRequestV1): Promise<ProviderSessionV1>
  followUp(request: ProviderFollowUpRequestV1): Promise<void>
  attach(request: ProviderAttachRequestV1): Promise<ProviderSessionV1 | null>
  resume(request: ProviderResumeRequestV1): Promise<ProviderSessionV1>
  fork(request: ProviderForkRequestV1): Promise<ProviderSessionV1>
  interrupt(session_id: string): Promise<void>
  cancel(session_id: string): Promise<void>
  stop(session_id: string): Promise<void>
  submitApproval(session_id: string, decision: ProviderApprovalDecisionV1): Promise<void>
  events(session_id: string): AsyncIterable<ProviderEventV1>
  usage(session_id: string): Promise<ProviderUsageV1>
}

export interface ProviderExecutionAdapterImplementationV1 {
  readonly contract_version: 1
  readonly manifest: ProviderManifestV1
  discoverExecutable(): Promise<unknown>
  probeReadiness(
    intent: Readonly<ProviderExecutionIntentV1>,
    boundary: ProviderLaunchBoundaryV1,
  ): Promise<unknown>
  listModels(intent: Readonly<ProviderExecutionIntentV1>): Promise<unknown>
  launch(context: ProviderAuthorizedLaunchContextV1): Promise<unknown>
  followUp(context: ProviderAuthorizedLaunchContextV1): Promise<void>
  fork(context: ProviderAuthorizedLaunchContextV1): Promise<unknown>
  interrupt(session_id: string): Promise<void>
  cancel(session_id: string): Promise<void>
  stop(session_id: string): Promise<void>
  submitApproval(
    session_id: string,
    decision: Readonly<ProviderApprovalDecisionV1>,
  ): Promise<void>
  events(
    session_id: string,
    context: ProviderEventStreamContextV1,
  ): AsyncIterable<unknown>
  usage(session_id: string): Promise<unknown>
}

export type PrepareProviderEnvironmentOptionsV1 = {
  on_conflict?: 'reject' | 'strip'
  overrides?: NodeJS.ProcessEnv
}

export type ProviderEnvironmentEvidenceV1 = {
  contract_version: 1
  provider_id: string
  mode_id: string
  runtime_mode: ProviderRuntimeMode
  billing_mode: ProviderBillingMode
  credential_kind: ProviderCredentialKind
  conflict_policy: 'reject' | 'strip'
  stripped_variables: readonly string[]
  retained_variable_count: number
  environment_fingerprint: string
}

export type ProviderLaunchBoundaryEvidenceV1 = {
  contract_version: 1
  provider_id: string
  adapter_id: string
  manifest_fingerprint: string
  executable_status: ProviderExecutableDiscoveryV1['status']
  executable_source: ProviderExecutableDiscoveryV1['source']
  executable_version: string | null
  executable_platform: string | null
  executable_resolved_path_fingerprint: string | null
  executable_fingerprint: string
  configuration_fingerprint: string
  environment_fingerprint: string
}

export interface ProviderLaunchBoundaryV1 {
  readonly evidence: Readonly<ProviderLaunchBoundaryEvidenceV1>
  toJSON(): ProviderLaunchBoundaryEvidenceV1
}

export type ProviderLaunchAuthorizationEvidenceV1 = {
  contract_version: 1
  selection: ProviderExecutionSelectionV1
  action_kind: ProviderActionV1['kind']
  action_id: string
  scope_id: string
  action_fingerprint: string
  authorized_at: string
  expires_at: string
  readiness_observed_at: string
  manifest_fingerprint: string
  executable_fingerprint: string
  configuration_fingerprint: string
  environment_fingerprint: string
  usage_priced_api_consent: ProviderCostConsentV1
  provider_managed_overage_consent: ProviderCostConsentV1
  reserved_cost: {
    purpose: 'usage_priced_api' | 'provider_managed_overage'
    receipt_id: string
    currency: string
    max_cost_minor_units: number
  } | null
}

export interface AuthorizedProviderLaunchV1 {
  readonly evidence: Readonly<ProviderLaunchAuthorizationEvidenceV1>
  toJSON(): ProviderLaunchAuthorizationEvidenceV1
}

export type AuthorizedProviderActionV1 = AuthorizedProviderLaunchV1

export type ProviderAuthorizedLaunchContextV1 = {
  readonly assigned_session_id: string
  readonly intent: Readonly<ProviderExecutionIntentV1>
  readonly action: Readonly<ProviderActionV1>
  readonly readiness: Readonly<ProviderReadinessV1>
  readonly executable: Readonly<ProviderExecutableDiscoveryV1>
  readonly environment: Readonly<NodeJS.ProcessEnv>
}

export type ProviderLaunchAuthorizationResultV1 =
  | {
      ready: false
      blockers: readonly ProviderLaunchBlockerCode[]
    }
  | {
      ready: true
      authorization: AuthorizedProviderLaunchV1
    }

const IDENTIFIER = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const REASON_CODE = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/
const SHA256_FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const MAX_ENVIRONMENT_VARIABLES = 4096
const MAX_ENVIRONMENT_VALUE_LENGTH = 1_048_576
const MAX_CONTRACT_NODES = 16_384
const MAX_CONTRACT_ARRAY_LENGTH = 4096
const MAX_SAFE_TEXT_LENGTH = 262_144
const ENVIRONMENT_FINGERPRINT_KEY = randomBytes(32)
const PREPARED_ENVIRONMENT_TOKEN = Symbol('prepared-provider-environment')
const LAUNCH_BOUNDARY_TOKEN = Symbol('provider-launch-boundary')
const LAUNCH_AUTHORIZATION_TOKEN = Symbol('provider-launch-authorization')
const COST_CONSENT_TOKEN = Symbol('verified-provider-cost-consent')
const VALIDATED_ADAPTER_TOKEN = Symbol('validated-provider-adapter')
const manifestRegistry = new Map<string, {
  fingerprint: string
  manifest: Readonly<ProviderManifestV1>
}>()
const manifestAdapterRegistry = new Map<string, {
  provider_id: string
  fingerprint: string
}>()
const RESERVED_FIRST_RELEASE_MANIFESTS: ReadonlyMap<string, {
  readonly adapter_id: string
  readonly fingerprint: string
}> = new Map([
  ['claude', {
    adapter_id: 'claude-agent-sdk',
    fingerprint: '48400e59017286f5829f3eb557d1de380a4ca766ea8535bedbaa814ec045ddac',
  }],
  ['codex', {
    adapter_id: 'codex-app-server',
    fingerprint: '2f9f6d926c9e6a2b539f112587fd72cdde63aca999b35393bef331ba45f16f71',
  }],
  ['qwen', {
    adapter_id: 'qwen-code-cli',
    fingerprint: 'ae03bbcc398cdbf6f5d73ecc158394afecd4bfe1b17fab6b4dd7671162a9f4bc',
  }],
  ['kimi', {
    adapter_id: 'kimi-code-acp',
    fingerprint: '1f1f5396f1600f99e6a055af4af7865ae66139015b4675f14ac2b4b4aab6d30f',
  }],
] as const)
const RESERVED_FIRST_RELEASE_ADAPTERS: ReadonlyMap<string, string> = new Map(
  [...RESERVED_FIRST_RELEASE_MANIFESTS].map(([providerId, definition]) => [
    definition.adapter_id,
    providerId,
  ]),
)
const canonicalManifests = new WeakSet<object>()
const validatedProviderAdapters = new WeakSet<object>()
const costConsents = new WeakMap<object, {
  evidence: Readonly<ProviderCostConsentV1>
}>()

const publicManifestFingerprint = (manifest: ProviderManifestV1): string =>
  createHash('sha256').update(JSON.stringify(manifest)).digest('hex')

export class ProviderContractError extends Error {
  readonly code: string
  readonly variables: readonly string[]

  constructor(code: string, variables: readonly string[] = []) {
    super(`provider contract rejected: ${code}`)
    this.name = 'ProviderContractError'
    this.code = code
    this.variables = Object.freeze([...variables].sort())
  }
}

function reject(code: string, variables: readonly string[] = []): never {
  throw new ProviderContractError(code, variables)
}

const exactKeys = (value: object, expected: readonly string[], code: string): void => {
  let keys: string[] = []
  try {
    keys = Object.keys(value)
  } catch {
    reject(code)
  }
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) reject(code)
}

const containsSensitiveText = (value: string): boolean =>
  redactSensitiveText(value).changed

const requiredIdentifier = (value: unknown, code: string): string => {
  if (typeof value !== 'string'
    || containsSensitiveText(value)
    || !IDENTIFIER.test(value)) reject(code)
  return value as string
}

const requiredReasonCode = (value: unknown, code: string): string => {
  if (typeof value !== 'string'
    || containsSensitiveText(value)
    || !REASON_CODE.test(value)) reject(code)
  return value as string
}

const requiredNonEmptyString = (value: unknown, code: string): string => {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || value.includes('\0')
    || containsSensitiveText(value)) reject(code)
  return value as string
}

const requiredStringArray = (value: unknown, code: string): readonly string[] => {
  if (!Array.isArray(value)
    || value.some((item) =>
      typeof item !== 'string'
      || !item
      || item.length > 256
      || containsSensitiveText(item))) {
    reject(code)
  }
  return value as string[]
}

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

type SnapshotBudget = { nodes: number }

const plainSnapshot = (
  value: unknown,
  code: string,
  budget: SnapshotBudget = { nodes: 0 },
  active: WeakSet<object> = new WeakSet(),
): unknown => {
  budget.nodes += 1
  if (budget.nodes > MAX_CONTRACT_NODES) reject(`${code}_too_large`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject(code)
    return value
  }
  if (typeof value !== 'object') reject(code)
  if (active.has(value)) reject(`${code}_cyclic`)
  active.add(value)
  try {
    let prototype: object | null
    let descriptors: Record<string, PropertyDescriptor>
    let symbols: symbol[]
    try {
      prototype = Object.getPrototypeOf(value)
      descriptors = Object.getOwnPropertyDescriptors(value)
      symbols = Object.getOwnPropertySymbols(value)
    } catch {
      reject(code)
    }
    if (symbols.length) reject(code)
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) reject(code)
      const lengthDescriptor = descriptors.length
      if (!lengthDescriptor || !('value' in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > MAX_CONTRACT_ARRAY_LENGTH) {
        reject(code)
      }
      const length = lengthDescriptor.value as number
      const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))])
      const keys = Object.keys(descriptors)
      if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) reject(code)
      const snapshot: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) reject(code)
        snapshot.push(plainSnapshot(descriptor.value, code, budget, active))
      }
      return snapshot
    }
    if (prototype !== Object.prototype && prototype !== null) reject(code)
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (!('value' in descriptor) || descriptor.enumerable !== true) reject(code)
      Object.defineProperty(snapshot, name, {
        value: plainSnapshot(descriptor.value, code, budget, active),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return snapshot
  } catch {
    return reject(code)
  } finally {
    active.delete(value)
  }
}

const clonePlain = <T>(value: T, code: string): T =>
  plainSnapshot(value, code) as T

const ownDataProperties = (
  value: unknown,
  expected: readonly string[],
  code: string,
): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code)
  try {
    const prototype = Object.getPrototypeOf(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if ((prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(value).length
      || Object.keys(descriptors).length !== expected.length) reject(code)
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const name of expected) {
      const descriptor = descriptors[name]
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) reject(code)
      Object.defineProperty(output, name, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return output
  } catch {
    return reject(code)
  }
}

function supportState(
  value: unknown,
  code: string,
): asserts value is ProviderCapabilitySupportV1 | ProviderModeSupportV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code)
  const row = value as Record<string, unknown>
  if (row.state === 'supported') {
    exactKeys(row, ['state'], code)
    return
  }
  if (!['unsupported', 'policy_blocked', 'unknown'].includes(String(row.state))) reject(code)
  exactKeys(row, ['state', 'reason_code'], code)
  requiredReasonCode(row.reason_code, code)
}

function validateCapabilities(value: unknown): asserts value is ProviderCapabilitiesV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_capabilities')
  exactKeys(value as object, PROVIDER_CAPABILITY_IDS, 'invalid_capabilities')
  for (const id of PROVIDER_CAPABILITY_IDS) {
    supportState((value as Record<string, unknown>)[id], `invalid_capability_${id}`)
  }
}

function validateMode(value: unknown): asserts value is ProviderExecutionModeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_mode')
  const row = value as Record<string, unknown>
  exactKeys(row, [
    'id',
    'runtime_mode',
    'billing_mode',
    'credential_kinds',
    'default_credential_kind',
    'priority',
    'support',
    'automation_policy',
    'usage_priced_api_consent_required',
    'overage',
    'capabilities',
  ], 'invalid_mode')
  requiredIdentifier(row.id, 'invalid_mode_id')
  if (!['native_cli', 'provider_api'].includes(String(row.runtime_mode))) reject('invalid_runtime_mode')
  if (!['personal_subscription', 'usage_priced_api'].includes(String(row.billing_mode))) {
    reject('invalid_billing_mode')
  }
  if (!Array.isArray(row.credential_kinds) || row.credential_kinds.length === 0) {
    reject('invalid_credential_kinds')
  }
  const credentialKinds = row.credential_kinds as unknown[]
  if (credentialKinds.some((kind) =>
    !['provider_account_session', 'subscription_scoped_key', 'subscription_access_token', 'usage_priced_api_key']
      .includes(String(kind)))) {
    reject('invalid_credential_kinds')
  }
  if (!unique(credentialKinds as string[])) reject('duplicate_credential_kind')
  if (!credentialKinds.includes(row.default_credential_kind)) reject('invalid_default_credential_kind')
  if (!['primary', 'secondary'].includes(String(row.priority))) reject('invalid_mode_priority')
  supportState(row.support, 'invalid_mode_support')
  if (!['allowed', 'interactive_only', 'blocked', 'unknown'].includes(String(row.automation_policy))) {
    reject('invalid_automation_policy')
  }
  if (typeof row.usage_priced_api_consent_required !== 'boolean') reject('invalid_api_consent_policy')
  if (!row.overage || typeof row.overage !== 'object' || Array.isArray(row.overage)) {
    reject('invalid_overage_policy')
  }
  const overage = row.overage as Record<string, unknown>
  exactKeys(overage, ['behavior', 'explicit_consent_required'], 'invalid_overage_policy')
  if (!['none', 'optional_metered', 'always_metered', 'unknown'].includes(String(overage.behavior))) {
    reject('invalid_overage_policy')
  }
  if (typeof overage.explicit_consent_required !== 'boolean') reject('invalid_overage_policy')

  if (row.priority === 'primary'
    && (row.runtime_mode !== 'native_cli' || row.billing_mode !== 'personal_subscription')) {
    reject('invalid_primary_mode')
  }
  if (row.runtime_mode === 'provider_api' && row.billing_mode !== 'usage_priced_api') {
    reject('provider_api_requires_usage_pricing')
  }
  if (row.billing_mode === 'usage_priced_api') {
    if (row.priority !== 'secondary' || row.usage_priced_api_consent_required !== true) {
      reject('usage_priced_api_requires_opt_in')
    }
    if (credentialKinds.some((kind) => kind !== 'usage_priced_api_key')) {
      reject('usage_priced_api_requires_api_key')
    }
    if (overage.behavior !== 'none') reject('usage_priced_api_rejects_provider_overage')
  } else {
    if (credentialKinds.includes('usage_priced_api_key')) reject('subscription_rejects_api_key')
    if (row.usage_priced_api_consent_required !== false) reject('subscription_rejects_api_consent')
  }
  if (overage.behavior === 'none' && overage.explicit_consent_required !== false) {
    reject('unnecessary_overage_consent')
  }
  if (overage.behavior !== 'none' && overage.explicit_consent_required !== true) {
    reject('metered_overage_requires_consent')
  }
  validateCapabilities(row.capabilities)
  const capabilities = row.capabilities as ProviderCapabilitiesV1
  if (capabilities.attach.state !== 'unsupported'
    || capabilities.resume.state !== 'unsupported'
    || capabilities.restart_recovery.state !== 'unsupported') {
    reject('durable_rehydration_not_supported_in_contract_v1')
  }
}

function validateEnvironment(
  value: unknown,
  modes: readonly ProviderExecutionModeV1[],
): asserts value is ProviderManifestV1['environment'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_environment_contract')
  const row = value as Record<string, unknown>
  exactKeys(row, ['audit_state', 'conflict_rules'], 'invalid_environment_contract')
  if (!['complete', 'incomplete'].includes(String(row.audit_state))) reject('invalid_environment_audit_state')
  if (!Array.isArray(row.conflict_rules)) reject('invalid_environment_rules')
  const rules = row.conflict_rules as unknown[]
  const variables: string[] = []
  for (const ruleValue of rules) {
    if (!ruleValue || typeof ruleValue !== 'object' || Array.isArray(ruleValue)) {
      reject('invalid_environment_rule')
    }
    const rule = ruleValue as Record<string, unknown>
    exactKeys(rule, [
      'variable',
      'category',
      'allowed_mode_ids',
      'allowed_credential_kinds',
    ], 'invalid_environment_rule')
    if (typeof rule.variable !== 'string' || !ENVIRONMENT_VARIABLE.test(rule.variable)) {
      reject('invalid_environment_variable')
    }
    if (!['credential', 'endpoint', 'provider_selector', 'provisioning'].includes(String(rule.category))) {
      reject('invalid_environment_category')
    }
    const allowed = requiredStringArray(rule.allowed_mode_ids, 'invalid_environment_mode')
    const allowedCredentials = requiredStringArray(
      rule.allowed_credential_kinds,
      'invalid_environment_credential',
    )
    if (!unique(allowed) || !unique(allowedCredentials)) reject('invalid_environment_rule')
    if (allowedCredentials.some((kind) => ![
      'provider_account_session',
      'subscription_scoped_key',
      'subscription_access_token',
      'usage_priced_api_key',
    ].includes(kind))) reject('invalid_environment_credential')
    for (const modeId of allowed) {
      const mode = modes.find((candidate) => candidate.id === modeId)
      if (!mode) reject('invalid_environment_mode')
      if (!allowedCredentials.some((kind) => mode.credential_kinds.includes(
        kind as Exclude<ProviderCredentialKind, 'unknown'>,
      ))) reject('invalid_environment_credential')
    }
    if (!allowed.length && allowedCredentials.length) reject('invalid_environment_credential')
    if (allowed.length && !allowedCredentials.length) reject('invalid_environment_credential')
    variables.push(rule.variable as string)
  }
  if (!unique(variables)) reject('duplicate_environment_rule')
  if (row.audit_state === 'complete') {
    const requiredVariables = PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1
      .map(([variable]) => variable)
    if (requiredVariables.some((variable) => !variables.includes(variable))) {
      reject('environment_audit_incomplete')
    }
  }
}

function validateManagedEnvironmentSemantics(manifest: ProviderManifestV1): void {
  for (const rule of manifest.environment.conflict_rules) {
    const managedCategory = PROVIDER_MANAGED_ENVIRONMENT_CATEGORY_BY_VARIABLE_V1.get(rule.variable)
    if (managedCategory === undefined) continue
    if (rule.category !== managedCategory) reject('invalid_environment_category')
    const owner = PROVIDER_MANAGED_ENVIRONMENT_OWNER_BY_VARIABLE_V1.get(rule.variable)
    if (rule.allowed_mode_ids.length > 0
      && (owner === undefined
        || owner[0] !== manifest.provider_id
        || owner[1] !== manifest.adapter_id)) {
      reject('environment_variable_owner_mismatch')
    }
    for (const modeId of rule.allowed_mode_ids) {
      const mode = manifest.modes.find((candidate) => candidate.id === modeId)
      if (!mode) continue
      if (rule.allowed_credential_kinds.some((kind) =>
        !managedEnvironmentVariableAllowsSelection(
          rule.variable,
          manifest.provider_id,
          manifest.adapter_id,
          mode.billing_mode,
          kind,
        ))) {
        if (mode.billing_mode === 'personal_subscription') {
          reject('api_environment_in_subscription_mode')
        }
        reject('invalid_environment_credential')
      }
    }
  }
}

function validateManifest(value: unknown): asserts value is ProviderManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_manifest')
  const row = value as Record<string, unknown>
  exactKeys(row, [
    'contract_version',
    'provider_id',
    'display_name',
    'adapter_id',
    'adapter_version',
    'release_state',
    'protocol',
    'executable',
    'environment',
    'modes',
  ], 'invalid_manifest')
  if (row.contract_version !== PROVIDER_CONTRACT_VERSION) reject('unsupported_contract_version')
  requiredIdentifier(row.provider_id, 'invalid_provider_id')
  requiredNonEmptyString(row.display_name, 'invalid_display_name')
  requiredIdentifier(row.adapter_id, 'invalid_adapter_id')
  requiredNonEmptyString(row.adapter_version, 'invalid_adapter_version')
  if (!['validated', 'candidate', 'unsupported'].includes(String(row.release_state))) {
    reject('invalid_release_state')
  }
  if (!['sdk', 'app_server', 'acp', 'native_cli', 'provider_api'].includes(String(row.protocol))) {
    reject('invalid_protocol')
  }
  if (!row.executable || typeof row.executable !== 'object' || Array.isArray(row.executable)) {
    reject('invalid_executable_contract')
  }
  const executable = row.executable as Record<string, unknown>
  const executableKeys = executable.command_override_env === undefined
    ? ['command', 'source', 'validated_versions', 'supported_platforms']
    : ['command', 'source', 'command_override_env', 'validated_versions', 'supported_platforms']
  exactKeys(executable, executableKeys, 'invalid_executable_contract')
  requiredNonEmptyString(executable.command, 'invalid_executable_command')
  if (!['path', 'sdk_bundled'].includes(String(executable.source))) reject('invalid_executable_source')
  if (executable.command_override_env !== undefined
    && (typeof executable.command_override_env !== 'string'
      || !ENVIRONMENT_VARIABLE.test(executable.command_override_env))) {
    reject('invalid_command_override')
  }
  const versions = requiredStringArray(executable.validated_versions, 'invalid_validated_versions')
  const platforms = requiredStringArray(executable.supported_platforms, 'invalid_supported_platforms')
  if (!unique(versions) || !unique(platforms)) reject('duplicate_executable_constraint')

  if (!Array.isArray(row.modes) || row.modes.length === 0) reject('missing_execution_modes')
  const modeValues = row.modes as unknown[]
  for (const mode of modeValues) validateMode(mode)
  const modes = modeValues as ProviderExecutionModeV1[]
  const modeIds = modes.map((mode) => mode.id)
  if (!unique(modeIds)) reject('duplicate_execution_mode')
  if (modes.filter((mode) => mode.priority === 'primary').length !== 1) reject('invalid_primary_count')
  validateEnvironment(row.environment, modes)
  const environment = row.environment as ProviderManifestV1['environment']
  if ((row.release_state === 'validated' || modes.some((mode) => mode.support.state === 'supported'))
    && environment.audit_state !== 'complete') {
    reject('environment_audit_incomplete')
  }
  if ((row.release_state === 'validated' || modes.some((mode) => mode.support.state === 'supported'))
    && (!versions.length || !platforms.length)) {
    reject('missing_executable_constraint')
  }
  if (row.release_state === 'validated') {
    const primary = modes.find((mode) => mode.priority === 'primary')
    if (primary?.support.state !== 'supported') reject('validated_primary_mode_required')
    if (primary.capabilities.launch.state !== 'supported') {
      reject('validated_primary_launch_required')
    }
  }
}

export function defineProviderManifestV1(manifest: ProviderManifestV1): Readonly<ProviderManifestV1> {
  if (manifest && typeof manifest === 'object' && canonicalManifests.has(manifest)) {
    return manifest
  }
  const snapshot = clonePlain(manifest, 'manifest_not_plain')
  validateManifest(snapshot)
  const reserved = RESERVED_FIRST_RELEASE_MANIFESTS.get(snapshot.provider_id)
  if (reserved
    && (snapshot.adapter_id !== reserved.adapter_id
      || publicManifestFingerprint(snapshot) !== reserved.fingerprint)) {
    reject('reserved_provider_manifest_mismatch')
  }
  const reservedProviderId = RESERVED_FIRST_RELEASE_ADAPTERS.get(snapshot.adapter_id)
  if (reservedProviderId !== undefined && reservedProviderId !== snapshot.provider_id) {
    reject('reserved_provider_adapter_mismatch')
  }
  validateManagedEnvironmentSemantics(snapshot)
  const fingerprint = manifestFingerprint(snapshot)
  const existing = manifestRegistry.get(snapshot.provider_id)
  if (existing) {
    if (existing.fingerprint !== fingerprint) reject('provider_manifest_conflict')
    return existing.manifest
  }
  const existingAdapter = manifestAdapterRegistry.get(snapshot.adapter_id)
  if (existingAdapter
    && (existingAdapter.provider_id !== snapshot.provider_id
      || existingAdapter.fingerprint !== fingerprint)) {
    reject('provider_adapter_manifest_conflict')
  }
  const defined = deepFreeze(snapshot)
  canonicalManifests.add(defined)
  manifestRegistry.set(defined.provider_id, { fingerprint, manifest: defined })
  manifestAdapterRegistry.set(defined.adapter_id, {
    provider_id: defined.provider_id,
    fingerprint,
  })
  return defined
}

function validateSelection(
  value: unknown,
  code = 'invalid_selection',
): asserts value is ProviderExecutionSelectionV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code)
  const row = value as Record<string, unknown>
  exactKeys(row, [
    'provider_id',
    'adapter_id',
    'mode_id',
    'runtime_mode',
    'billing_mode',
    'credential_kind',
  ], code)
  requiredIdentifier(row.provider_id, code)
  requiredIdentifier(row.adapter_id, code)
  requiredIdentifier(row.mode_id, code)
  if (!['native_cli', 'provider_api'].includes(String(row.runtime_mode))) reject(code)
  if (!['personal_subscription', 'usage_priced_api', 'unknown'].includes(String(row.billing_mode))) reject(code)
  if (![
    'provider_account_session',
    'subscription_scoped_key',
    'subscription_access_token',
    'usage_priced_api_key',
    'unknown',
  ].includes(String(row.credential_kind))) reject(code)
}

function validateCostConsentEvidence(
  value: unknown,
  code: string,
): asserts value is ProviderCostConsentV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code)
  const row = value as Record<string, unknown>
  exactKeys(row, [
    'state',
    'provider_id',
    'adapter_id',
    'mode_id',
    'purpose',
    'operator_id',
    'granted_at',
    'expires_at',
    'scope_id',
    'receipt_id',
    'currency',
    'max_cost_minor_units',
  ], code)
  if (!['not_required', 'granted'].includes(String(row.state))) reject(code)
  if (row.state === 'not_required') {
    if (row.provider_id !== null
      || row.adapter_id !== null
      || row.mode_id !== null
      || row.purpose !== null
      || row.operator_id !== null
      || row.granted_at !== null
      || row.expires_at !== null
      || row.scope_id !== null
      || row.receipt_id !== null
      || row.currency !== null
      || row.max_cost_minor_units !== null) reject(code)
    return
  }
  requiredIdentifier(row.provider_id, code)
  requiredIdentifier(row.adapter_id, code)
  requiredIdentifier(row.mode_id, code)
  if (!['usage_priced_api', 'provider_managed_overage'].includes(String(row.purpose))) reject(code)
  requiredIdentifier(row.operator_id, code)
  requiredIdentifier(row.scope_id, code)
  requiredIdentifier(row.receipt_id, code)
  if (typeof row.granted_at !== 'string'
    || !Number.isFinite(Date.parse(row.granted_at))
    || row.granted_at.length > 64) reject(code)
  if (typeof row.expires_at !== 'string'
    || !Number.isFinite(Date.parse(row.expires_at))
    || row.expires_at.length > 64) reject(code)
  const now = Date.now()
  const grantedAt = Date.parse(row.granted_at)
  const expiresAt = Date.parse(row.expires_at)
  if (grantedAt > now + PROVIDER_READINESS_FUTURE_SKEW_MS
    || expiresAt <= now
    || expiresAt <= grantedAt) reject(code)
  if (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) reject(code)
  if (!Number.isSafeInteger(row.max_cost_minor_units)
    || (row.max_cost_minor_units as number) <= 0) reject(code)
}

class VerifiedProviderCostConsent implements ProviderCostConsentV1 {
  readonly state: ProviderCostConsentV1['state']
  readonly provider_id: string | null
  readonly adapter_id: string | null
  readonly mode_id: string | null
  readonly purpose: ProviderCostConsentV1['purpose']
  readonly operator_id: string | null
  readonly granted_at: string | null
  readonly expires_at: string | null
  readonly scope_id: string | null
  readonly receipt_id: string | null
  readonly currency: string | null
  readonly max_cost_minor_units: number | null

  constructor(token: symbol, evidence: ProviderCostConsentV1) {
    if (token !== COST_CONSENT_TOKEN) reject('verified_cost_consent_required')
    this.state = evidence.state
    this.provider_id = evidence.provider_id
    this.adapter_id = evidence.adapter_id
    this.mode_id = evidence.mode_id
    this.purpose = evidence.purpose
    this.operator_id = evidence.operator_id
    this.granted_at = evidence.granted_at
    this.expires_at = evidence.expires_at
    this.scope_id = evidence.scope_id
    this.receipt_id = evidence.receipt_id
    this.currency = evidence.currency
    this.max_cost_minor_units = evidence.max_cost_minor_units
    costConsents.set(this, {
      evidence: deepFreeze(clonePlain(evidence, 'invalid_cost_consent')),
    })
    Object.freeze(this)
  }

  toJSON(): ProviderCostConsentV1 {
    return clonePlain(costConsentState(this).evidence, 'invalid_cost_consent')
  }
}

function costConsentState(value: unknown): {
  evidence: Readonly<ProviderCostConsentV1>
} {
  if (!value || typeof value !== 'object') reject('verified_cost_consent_required')
  const state = costConsents.get(value)
  if (!state) reject('verified_cost_consent_required')
  validateCostConsentEvidence(state.evidence, 'invalid_cost_consent')
  return state
}

export function defineProviderNoCostConsentV1(): ProviderCostConsentV1 {
  return new VerifiedProviderCostConsent(COST_CONSENT_TOKEN, {
    state: 'not_required',
    provider_id: null,
    adapter_id: null,
    mode_id: null,
    purpose: null,
    operator_id: null,
    granted_at: null,
    expires_at: null,
    scope_id: null,
    receipt_id: null,
    currency: null,
    max_cost_minor_units: null,
  })
}

export function selectProviderExecutionV1(
  manifest: ProviderManifestV1,
  request: ProviderExecutionSelectionRequestV1 = {},
): ProviderExecutionSelectionV1 {
  const defined = defineProviderManifestV1(manifest)
  const selectedRequest = clonePlain(request, 'invalid_selection_request')
  if (!selectedRequest || typeof selectedRequest !== 'object' || Array.isArray(selectedRequest)) {
    reject('invalid_selection_request')
  }
  const requestKeys = Object.keys(selectedRequest)
  if (requestKeys.some((key) =>
    !['mode_id', 'credential_kind', 'usage_priced_api_consent'].includes(key))) {
    reject('invalid_selection_request')
  }
  if (selectedRequest.mode_id !== undefined) {
    requiredIdentifier(selectedRequest.mode_id, 'invalid_selection_request')
  }
  if (selectedRequest.credential_kind !== undefined
    && ![
      'provider_account_session',
      'subscription_scoped_key',
      'subscription_access_token',
      'usage_priced_api_key',
    ].includes(selectedRequest.credential_kind)) {
    reject('invalid_selection_request')
  }
  if (selectedRequest.usage_priced_api_consent !== undefined
    && typeof selectedRequest.usage_priced_api_consent !== 'boolean') {
    reject('invalid_selection_request')
  }
  const mode = selectedRequest.mode_id !== undefined
    ? defined.modes.find((candidate) => candidate.id === selectedRequest.mode_id)
    : defined.modes.find((candidate) => candidate.priority === 'primary')
  if (!mode) reject('unsupported_mode')
  const credentialKind = selectedRequest.credential_kind ?? mode.default_credential_kind
  if (!mode.credential_kinds.includes(credentialKind)) reject('unsupported_credential_kind')
  if (mode.billing_mode === 'usage_priced_api' && selectedRequest.usage_priced_api_consent !== true) {
    reject('usage_priced_api_consent_required')
  }
  return deepFreeze({
    provider_id: defined.provider_id,
    adapter_id: defined.adapter_id,
    mode_id: mode.id,
    runtime_mode: mode.runtime_mode,
    billing_mode: mode.billing_mode,
    credential_kind: credentialKind,
  })
}

export function defineProviderReadinessV1(
  readiness: ProviderReadinessV1,
): Readonly<ProviderReadinessV1> {
  const snapshot = clonePlain(readiness, 'readiness_not_plain')
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) reject('invalid_readiness')
  exactKeys(snapshot, [
    'contract_version',
    'observed_at',
    'selection',
    'executable_status',
    'auth_status',
    'automation_policy',
    'overage_status',
    'overage_consent',
    'metering_status',
    'cost_cap_status',
    'executable_fingerprint',
    'environment_fingerprint',
    'configuration_fingerprint',
  ], 'invalid_readiness')
  if (snapshot.contract_version !== PROVIDER_CONTRACT_VERSION) reject('unsupported_contract_version')
  if (typeof snapshot.observed_at !== 'string'
    || !Number.isFinite(Date.parse(snapshot.observed_at))
    || snapshot.observed_at.length > 64) {
    reject('invalid_observed_at')
  }
  validateSelection(snapshot.selection)
  if (!['validated', 'missing', 'incompatible', 'untrusted', 'unknown']
    .includes(snapshot.executable_status)) reject('invalid_executable_status')
  if (!['ready', 'signed_out', 'expired', 'revoked', 'credential_conflict', 'unknown']
    .includes(snapshot.auth_status)) reject('invalid_auth_status')
  if (!['allowed', 'interactive_only', 'blocked', 'unknown']
    .includes(snapshot.automation_policy)) reject('invalid_automation_policy')
  if (!['not_applicable', 'disabled', 'enabled', 'exhausted', 'unknown']
    .includes(snapshot.overage_status)) reject('invalid_overage_status')
  if (!['not_required', 'missing', 'granted', 'denied']
    .includes(snapshot.overage_consent)) reject('invalid_overage_consent')
  if (!['not_required', 'ready', 'unavailable', 'unknown']
    .includes(snapshot.metering_status)) reject('invalid_metering_status')
  if (!['not_required', 'enforced', 'unenforced', 'unknown']
    .includes(snapshot.cost_cap_status)) reject('invalid_cost_cap_status')
  for (const fingerprint of [
    snapshot.executable_fingerprint,
    snapshot.environment_fingerprint,
    snapshot.configuration_fingerprint,
  ]) {
    if (!SHA256_FINGERPRINT.test(fingerprint)) reject('invalid_readiness_fingerprint')
  }
  return deepFreeze(snapshot)
}

const validTimestamp = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    reject(code)
  }
  return value
}

const safeText = (
  value: unknown,
  code: string,
  maximum = MAX_SAFE_TEXT_LENGTH,
): string => {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) reject(code)
  return redactSensitiveText(value).value ?? ''
}

const safeNonEmptyText = (
  value: unknown,
  code: string,
  maximum = 4096,
): string => {
  const output = safeText(value, code, maximum)
  if (!output) reject(code)
  return output
}

const safeIdentifier = (value: unknown, code: string): string => {
  if (typeof value !== 'string'
    || value.length > 128
    || value.includes('\0')
    || containsSensitiveText(value)
    || !IDENTIFIER.test(value)) reject(code)
  return value
}

const safeOpaqueIdentifier = (
  value: unknown,
  code: string,
  maximum = 4096,
): string => {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || value.includes('\0')
    || containsSensitiveText(value)) reject(code)
  return value
}

const providerSessionIdForCleanup = (value: unknown): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'provider_session_id')
    if (!descriptor || !('value' in descriptor)) return null
    return safeOpaqueIdentifier(
      descriptor.value,
      'invalid_provider_session',
      4096,
    )
  } catch {
    return null
  }
}

const privateText = (
  value: unknown,
  code: string,
  maximum = MAX_SAFE_TEXT_LENGTH,
): string => {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || value.includes('\0')) reject(code)
  return value
}

export function defineProviderExecutableDiscoveryV1(
  discovery: ProviderExecutableDiscoveryV1,
): Readonly<ProviderExecutableDiscoveryV1> {
  const snapshot = clonePlain(discovery, 'invalid_executable_discovery')
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    reject('invalid_executable_discovery')
  }
  exactKeys(snapshot, [
    'contract_version',
    'provider_id',
    'adapter_id',
    'status',
    'source',
    'version',
    'platform',
    'resolved_path',
    'executable_fingerprint',
  ], 'invalid_executable_discovery')
  if (snapshot.contract_version !== PROVIDER_CONTRACT_VERSION) reject('unsupported_contract_version')
  requiredIdentifier(snapshot.provider_id, 'invalid_executable_discovery')
  requiredIdentifier(snapshot.adapter_id, 'invalid_executable_discovery')
  if (!['validated', 'missing', 'incompatible', 'untrusted', 'unknown'].includes(snapshot.status)) {
    reject('invalid_executable_discovery')
  }
  if (!['path', 'environment_override', 'sdk_bundled', 'unknown'].includes(snapshot.source)) {
    reject('invalid_executable_discovery')
  }
  const version = snapshot.version === null
    ? null
    : safeText(snapshot.version, 'invalid_executable_version', 128)
  const platform = snapshot.platform === null
    ? null
    : safeText(snapshot.platform, 'invalid_executable_platform', 128)
  const resolvedPath = snapshot.resolved_path === null
    ? null
    : safeOpaqueIdentifier(snapshot.resolved_path, 'invalid_executable_path', 4096)
  if (snapshot.status === 'validated'
    && (snapshot.source === 'unknown' || version === null || platform === null)) {
    reject('invalid_validated_executable')
  }
  if (snapshot.status === 'validated'
    && ['path', 'environment_override'].includes(snapshot.source)
    && (resolvedPath === null || !isAbsolute(resolvedPath))) {
    reject('invalid_executable_path')
  }
  if (snapshot.source === 'sdk_bundled' && resolvedPath !== null) {
    reject('invalid_executable_path')
  }
  if (!SHA256_FINGERPRINT.test(snapshot.executable_fingerprint)) {
    reject('invalid_executable_fingerprint')
  }
  return deepFreeze({
    ...snapshot,
    version,
    platform,
    resolved_path: resolvedPath,
  })
}

export function defineProviderModelsV1(
  models: readonly ProviderModelV1[],
): readonly Readonly<ProviderModelV1>[] {
  const snapshot = clonePlain(models, 'invalid_provider_models')
  if (!Array.isArray(snapshot) || snapshot.length > 1024) reject('invalid_provider_models')
  const output: ProviderModelV1[] = []
  const ids: string[] = []
  let defaults = 0
  for (const value of snapshot) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_provider_model')
    exactKeys(value, [
      'id',
      'display_name',
      'is_default',
      'supports_effort',
      'effort_levels',
    ], 'invalid_provider_model')
    const id = safeIdentifier(value.id, 'invalid_provider_model')
    const displayName = safeText(value.display_name, 'invalid_provider_model', 256)
    if (typeof value.is_default !== 'boolean' || typeof value.supports_effort !== 'boolean') {
      reject('invalid_provider_model')
    }
    const levels = requiredStringArray(value.effort_levels, 'invalid_provider_model')
      .map((level) => safeIdentifier(level, 'invalid_provider_model'))
    if (!unique(levels)
      || (!value.supports_effort && levels.length > 0)) reject('invalid_provider_model')
    if (value.is_default) defaults += 1
    ids.push(id)
    output.push({
      id,
      display_name: displayName,
      is_default: value.is_default,
      supports_effort: value.supports_effort,
      effort_levels: [...levels],
    })
  }
  if (!unique(ids) || defaults > 1) reject('invalid_provider_models')
  return deepFreeze(output)
}

const validateUsageWindow = (value: unknown): ProviderUsageWindowV1 => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_usage_window')
  const row = value as Record<string, unknown>
  exactKeys(row, ['kind', 'used_percent', 'resets_at'], 'invalid_usage_window')
  if (!['rolling', 'daily', 'weekly', 'monthly'].includes(String(row.kind))) {
    reject('invalid_usage_window')
  }
  if (row.used_percent !== null
    && (typeof row.used_percent !== 'number'
      || !Number.isFinite(row.used_percent)
      || row.used_percent < 0
      || row.used_percent > 100)) reject('invalid_usage_window')
  if (row.resets_at !== null) validTimestamp(row.resets_at, 'invalid_usage_window')
  return row as ProviderUsageWindowV1
}

export function defineProviderUsageV1(
  usage: ProviderUsageV1,
  authorization: AuthorizedProviderLaunchV1,
): Readonly<ProviderUsageV1> {
  const snapshot = clonePlain(usage, 'invalid_provider_usage')
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) reject('invalid_provider_usage')
  exactKeys(snapshot, [
    'contract_version',
    'observed_at',
    'selection',
    'action_id',
    'scope_id',
    'billing_mode',
    'status',
    'overage_status',
    'windows',
    'metered_cost',
  ], 'invalid_provider_usage')
  if (snapshot.contract_version !== PROVIDER_CONTRACT_VERSION) reject('unsupported_contract_version')
  validTimestamp(snapshot.observed_at, 'invalid_provider_usage')
  validateSelection(snapshot.selection)
  const actionId = safeIdentifier(snapshot.action_id, 'invalid_provider_usage')
  const scopeId = safeIdentifier(snapshot.scope_id, 'invalid_provider_usage')
  if (!['personal_subscription', 'usage_priced_api', 'unknown'].includes(snapshot.billing_mode)
    || !['available', 'exhausted', 'unavailable', 'unknown'].includes(snapshot.status)
    || !['not_applicable', 'disabled', 'enabled', 'exhausted', 'unknown']
      .includes(snapshot.overage_status)
    || !Array.isArray(snapshot.windows)
    || snapshot.windows.length > 32) {
    reject('invalid_provider_usage')
  }
  if (snapshot.billing_mode !== snapshot.selection.billing_mode) {
    reject('provider_usage_billing_mismatch')
  }
  const authorizationState = launchAuthorizationState(authorization)
  if (!sameSelection(snapshot.selection, authorizationState.intent.selection)
    || actionId !== authorizationState.action.action_id
    || scopeId !== authorizationState.action.scope_id) {
    reject('provider_usage_authorization_mismatch')
  }
  const windows = snapshot.windows.map(validateUsageWindow)
  let meteredCost: ProviderUsageV1['metered_cost'] = null
  if (snapshot.metered_cost !== null) {
    const row = snapshot.metered_cost
    if (!row || typeof row !== 'object' || Array.isArray(row)) reject('invalid_metered_cost')
    exactKeys(row, [
      'purpose',
      'receipt_id',
      'currency',
      'incurred_minor_units',
      'limit_minor_units',
    ], 'invalid_metered_cost')
    if (!['usage_priced_api', 'provider_managed_overage'].includes(row.purpose)
      || typeof row.receipt_id !== 'string'
      || !IDENTIFIER.test(row.receipt_id)
      || typeof row.currency !== 'string'
      || !/^[A-Z]{3}$/.test(row.currency)
      || !Number.isSafeInteger(row.incurred_minor_units)
      || row.incurred_minor_units < 0
      || !Number.isSafeInteger(row.limit_minor_units)
      || row.limit_minor_units <= 0
      || row.incurred_minor_units > row.limit_minor_units) {
      reject('invalid_metered_cost')
    }
    if (row.incurred_minor_units === row.limit_minor_units
      && snapshot.status !== 'exhausted'
      && snapshot.overage_status !== 'exhausted') reject('invalid_metered_cost_state')
    meteredCost = row
  }
  const meteringExpected = (snapshot.billing_mode === 'usage_priced_api'
    || ['enabled', 'exhausted'].includes(snapshot.overage_status))
    && ['available', 'exhausted'].includes(snapshot.status)
  if (meteringExpected && meteredCost === null) reject('missing_metered_cost')
  if (!meteringExpected && meteredCost !== null) reject('unexpected_metered_cost')
  if (meteringExpected) {
    if (authorizationState.evidence.reserved_cost === null
      || meteredCost?.purpose !== authorizationState.evidence.reserved_cost.purpose
      || meteredCost.receipt_id !== authorizationState.evidence.reserved_cost.receipt_id
      || meteredCost.currency !== authorizationState.evidence.reserved_cost.currency
      || meteredCost.limit_minor_units
        !== authorizationState.evidence.reserved_cost.max_cost_minor_units) {
      reject('metered_usage_authorization_mismatch')
    }
    reject('durable_cost_authority_unavailable')
  }
  return deepFreeze({
    ...snapshot,
    action_id: actionId,
    scope_id: scopeId,
    windows,
    metered_cost: meteredCost,
  })
}

const requestedEffective = (
  value: unknown,
  code: string,
  effectiveNullable: boolean,
): { requested: string | null; effective: string | null } | null => {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code)
  const row = value as Record<string, unknown>
  exactKeys(row, ['requested', 'effective'], code)
  const requested = row.requested === null
    ? null
    : safeNonEmptyText(row.requested, code, 256)
  let effective: string | null
  if (row.effective === null) {
    if (!effectiveNullable) reject(code)
    effective = null
  } else {
    effective = safeNonEmptyText(row.effective, code, 256)
  }
  return { requested, effective }
}

export function defineProviderSessionV1(
  session: ProviderSessionV1,
): Readonly<ProviderSessionV1> {
  const snapshot = clonePlain(session, 'invalid_provider_session')
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) reject('invalid_provider_session')
  exactKeys(snapshot, [
    'contract_version',
    'session_id',
    'provider_session_id',
    'selection',
    'status',
    'model',
    'effort',
    'access_profile',
  ], 'invalid_provider_session')
  if (snapshot.contract_version !== PROVIDER_CONTRACT_VERSION) reject('unsupported_contract_version')
  const sessionId = safeOpaqueIdentifier(snapshot.session_id, 'invalid_provider_session')
  const providerSessionId = safeOpaqueIdentifier(
    snapshot.provider_session_id,
    'invalid_provider_session',
  )
  validateSelection(snapshot.selection)
  if (!['starting', 'running', 'idle', 'stopping', 'stopped', 'failed', 'lost']
    .includes(snapshot.status)) reject('invalid_provider_session')
  const model = requestedEffective(snapshot.model, 'invalid_provider_session_model', false)
  const effort = requestedEffective(snapshot.effort, 'invalid_provider_session_effort', true)
  let accessProfile: ProviderSessionV1['access_profile'] = null
  if (snapshot.access_profile !== null) {
    if (!snapshot.access_profile
      || typeof snapshot.access_profile !== 'object'
      || Array.isArray(snapshot.access_profile)) reject('invalid_provider_session_access')
    exactKeys(snapshot.access_profile, ['requested', 'effective'], 'invalid_provider_session_access')
    const allowed = ['read_only', 'workspace_write', 'full_access']
    if (snapshot.access_profile.requested !== null
      && !allowed.includes(snapshot.access_profile.requested)) reject('invalid_provider_session_access')
    if (!allowed.includes(snapshot.access_profile.effective)) reject('invalid_provider_session_access')
    accessProfile = snapshot.access_profile
  }
  return deepFreeze({
    ...snapshot,
    session_id: sessionId,
    provider_session_id: providerSessionId,
    model: model as ProviderSessionV1['model'],
    effort: effort as ProviderSessionV1['effort'],
    access_profile: accessProfile,
  })
}

export function defineProviderApprovalDecisionV1(
  decision: ProviderApprovalDecisionV1,
): Readonly<ProviderApprovalDecisionV1> {
  const snapshot = clonePlain(decision, 'invalid_approval_decision')
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) reject('invalid_approval_decision')
  exactKeys(snapshot, ['approval_id', 'decision'], 'invalid_approval_decision')
  const approvalId = safeOpaqueIdentifier(snapshot.approval_id, 'invalid_approval_decision')
  if (!['approve', 'reject'].includes(snapshot.decision)) reject('invalid_approval_decision')
  return deepFreeze({ ...snapshot, approval_id: approvalId })
}

export function defineProviderEventV1(
  event: ProviderEventV1,
  authorization?: AuthorizedProviderLaunchV1,
): Readonly<ProviderEventV1> {
  const snapshot = clonePlain(event, 'invalid_provider_event')
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) reject('invalid_provider_event')
  const common = ['kind', 'event_id', 'turn_id', 'session_id', 'sequence', 'observed_at']
  const eventId = safeIdentifier(snapshot.event_id, 'invalid_provider_event')
  const turnId = safeIdentifier(snapshot.turn_id, 'invalid_provider_event')
  const sessionId = safeOpaqueIdentifier(snapshot.session_id, 'invalid_provider_event')
  const normalizedCommon = { event_id: eventId, turn_id: turnId, session_id: sessionId }
  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) reject('invalid_provider_event')
  validTimestamp(snapshot.observed_at, 'invalid_provider_event')
  if (snapshot.kind === 'output') {
    exactKeys(snapshot, [...common, 'safe_text'], 'invalid_provider_event')
    return deepFreeze({
      ...snapshot,
      ...normalizedCommon,
      safe_text: safeText(snapshot.safe_text, 'invalid_provider_event'),
    })
  }
  if (snapshot.kind === 'status') {
    exactKeys(snapshot, [...common, 'status'], 'invalid_provider_event')
    if (!['starting', 'running', 'idle', 'stopping', 'stopped', 'failed', 'lost']
      .includes(snapshot.status)) reject('invalid_provider_event')
    return deepFreeze({ ...snapshot, ...normalizedCommon })
  }
  if (snapshot.kind === 'tool') {
    exactKeys(snapshot, [
      ...common,
      'tool_call_id',
      'tool_name',
      'phase',
      'safe_summary',
    ], 'invalid_provider_event')
    const toolCallId = safeIdentifier(snapshot.tool_call_id, 'invalid_provider_event')
    const toolName = safeNonEmptyText(snapshot.tool_name, 'invalid_provider_event', 256)
    if (!['started', 'completed', 'failed'].includes(snapshot.phase)) reject('invalid_provider_event')
    const summary = snapshot.safe_summary === null
      ? null
      : safeText(snapshot.safe_summary, 'invalid_provider_event', 16_384)
    return deepFreeze({
      ...snapshot,
      ...normalizedCommon,
      tool_call_id: toolCallId,
      tool_name: toolName,
      safe_summary: summary,
    })
  }
  if (snapshot.kind === 'approval') {
    exactKeys(snapshot, [
      ...common,
      'approval_id',
      'approval_kind',
      'status',
      'safe_summary',
    ], 'invalid_provider_event')
    const approvalId = safeOpaqueIdentifier(snapshot.approval_id, 'invalid_provider_event')
    if (!['command', 'file_change', 'tool', 'other'].includes(snapshot.approval_kind)
      || !['requested', 'approved', 'rejected', 'expired'].includes(snapshot.status)) {
      reject('invalid_provider_event')
    }
    return deepFreeze({
      ...snapshot,
      ...normalizedCommon,
      approval_id: approvalId,
      safe_summary: safeText(snapshot.safe_summary, 'invalid_provider_event', 16_384),
    })
  }
  if (snapshot.kind === 'usage') {
    exactKeys(snapshot, [...common, 'usage'], 'invalid_provider_event')
    if (!authorization) reject('provider_usage_authorization_required')
    return deepFreeze({
      ...snapshot,
      ...normalizedCommon,
      usage: defineProviderUsageV1(snapshot.usage, authorization),
    })
  }
  if (snapshot.kind === 'error') {
    exactKeys(snapshot, [...common, 'code', 'safe_message'], 'invalid_provider_event')
    const code = safeIdentifier(snapshot.code, 'invalid_provider_event')
    return deepFreeze({
      ...snapshot,
      ...normalizedCommon,
      code,
      safe_message: safeText(snapshot.safe_message, 'invalid_provider_event', 16_384),
    })
  }
  return reject('invalid_provider_event')
}

export function defineProviderExecutionIntentV1(
  intent: ProviderExecutionIntentV1,
): Readonly<ProviderExecutionIntentV1> {
  const values = ownDataProperties(intent, [
    'selection',
    'execution_scope',
    'usage_priced_api',
    'provider_managed_overage',
    'required_capabilities',
  ], 'intent_not_plain')
  const usageConsent = values.usage_priced_api as ProviderCostConsentV1
  const overageConsent = values.provider_managed_overage as ProviderCostConsentV1
  const usageState = costConsentState(usageConsent)
  const overageState = costConsentState(overageConsent)
  const snapshot = clonePlain({
    selection: values.selection,
    execution_scope: values.execution_scope,
    usage_priced_api: usageState.evidence,
    provider_managed_overage: overageState.evidence,
    required_capabilities: values.required_capabilities,
  } as ProviderExecutionIntentV1, 'intent_not_plain')
  validateSelection(snapshot.selection)
  if (snapshot.selection.billing_mode === 'unknown') reject('unknown_billing_selection')
  if (snapshot.selection.credential_kind === 'unknown') reject('unknown_credential_selection')
  if (!['interactive', 'managed_foreground', 'managed_background'].includes(snapshot.execution_scope)) {
    reject('invalid_execution_scope')
  }
  validateCostConsentEvidence(snapshot.usage_priced_api, 'invalid_usage_priced_api_consent')
  validateCostConsentEvidence(snapshot.provider_managed_overage, 'invalid_provider_overage_consent')
  const consentMatchesSelection = (
    consent: ProviderCostConsentV1,
    purpose: Exclude<ProviderCostConsentV1['purpose'], null>,
  ): boolean => consent.state === 'not_required'
    || (consent.provider_id === snapshot.selection.provider_id
      && consent.adapter_id === snapshot.selection.adapter_id
      && consent.mode_id === snapshot.selection.mode_id
      && consent.purpose === purpose)
  if (!consentMatchesSelection(snapshot.usage_priced_api, 'usage_priced_api')) {
    reject('invalid_usage_priced_api_consent')
  }
  if (!consentMatchesSelection(snapshot.provider_managed_overage, 'provider_managed_overage')) {
    reject('invalid_provider_overage_consent')
  }
  if (snapshot.usage_priced_api.state === 'granted'
    && snapshot.provider_managed_overage.state === 'granted'
    && snapshot.usage_priced_api.receipt_id === snapshot.provider_managed_overage.receipt_id) {
    reject('duplicate_cost_consent_receipt')
  }
  if (!Array.isArray(snapshot.required_capabilities)
    || snapshot.required_capabilities.some((capability) =>
      !(PROVIDER_CAPABILITY_IDS as readonly string[]).includes(capability))) {
    reject('invalid_required_capability')
  }
  if (!unique(snapshot.required_capabilities)) reject('duplicate_required_capability')
  return deepFreeze({
    ...snapshot,
    usage_priced_api: usageConsent,
    provider_managed_overage: overageConsent,
  })
}

const validateCostLimit = (
  value: unknown,
): ProviderActionV1['cost_limit'] => {
  if (value === null) return null
  const snapshot = clonePlain(value, 'invalid_action_cost_limit')
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    reject('invalid_action_cost_limit')
  }
  const row = snapshot as Record<string, unknown>
  exactKeys(row, ['currency', 'max_cost_minor_units'], 'invalid_action_cost_limit')
  if (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)
    || !Number.isSafeInteger(row.max_cost_minor_units)
    || (row.max_cost_minor_units as number) <= 0) reject('invalid_action_cost_limit')
  return row as ProviderActionV1['cost_limit']
}

export function defineProviderActionV1(
  action: ProviderActionV1,
): Readonly<ProviderActionV1> {
  const snapshot = clonePlain(action, 'invalid_provider_action')
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    reject('invalid_provider_action')
  }
  if (snapshot.contract_version !== PROVIDER_CONTRACT_VERSION) reject('unsupported_contract_version')
  const actionId = safeIdentifier(snapshot.action_id, 'invalid_provider_action')
  const scopeId = safeIdentifier(snapshot.scope_id, 'invalid_provider_action')
  const costLimit = validateCostLimit(snapshot.cost_limit)
  if (snapshot.kind === 'launch') {
    exactKeys(snapshot, [
      'contract_version',
      'kind',
      'action_id',
      'scope_id',
      'cwd',
      'prompt',
      'model',
      'effort',
      'access_profile',
      'cost_limit',
    ], 'invalid_provider_action')
    const cwd = privateText(snapshot.cwd, 'invalid_provider_action', 4096)
    const prompt = privateText(snapshot.prompt, 'invalid_provider_action')
    const model = snapshot.model === null
      ? null
      : privateText(snapshot.model, 'invalid_provider_action', 256)
    const effort = snapshot.effort === null
      ? null
      : privateText(snapshot.effort, 'invalid_provider_action', 256)
    if (!['read_only', 'workspace_write', 'full_access'].includes(snapshot.access_profile)) {
      reject('invalid_provider_action')
    }
    return deepFreeze({
      ...snapshot,
      action_id: actionId,
      scope_id: scopeId,
      cwd,
      prompt,
      model,
      effort,
      cost_limit: costLimit,
    })
  }
  if (snapshot.kind === 'resume') {
    exactKeys(snapshot, [
      'contract_version',
      'kind',
      'action_id',
      'scope_id',
      'provider_session_id',
      'cwd',
      'cost_limit',
    ], 'invalid_provider_action')
    const providerSessionId = privateText(
      snapshot.provider_session_id,
      'invalid_provider_action',
      4096,
    )
    const cwd = privateText(snapshot.cwd, 'invalid_provider_action', 4096)
    return deepFreeze({
      ...snapshot,
      action_id: actionId,
      scope_id: scopeId,
      provider_session_id: providerSessionId,
      cwd,
      cost_limit: costLimit,
    })
  }
  if (snapshot.kind === 'follow_up') {
    exactKeys(snapshot, [
      'contract_version',
      'kind',
      'action_id',
      'scope_id',
      'session_id',
      'prompt',
      'cost_limit',
    ], 'invalid_provider_action')
    const sessionId = privateText(snapshot.session_id, 'invalid_provider_action', 4096)
    const prompt = privateText(snapshot.prompt, 'invalid_provider_action')
    return deepFreeze({
      ...snapshot,
      action_id: actionId,
      scope_id: scopeId,
      session_id: sessionId,
      prompt,
      cost_limit: costLimit,
    })
  }
  if (snapshot.kind === 'fork') {
    exactKeys(snapshot, [
      'contract_version',
      'kind',
      'action_id',
      'scope_id',
      'session_id',
      'model',
      'effort',
      'access_profile',
      'cost_limit',
    ], 'invalid_provider_action')
    const sessionId = privateText(snapshot.session_id, 'invalid_provider_action', 4096)
    const model = snapshot.model === null
      ? null
      : privateText(snapshot.model, 'invalid_provider_action', 256)
    const effort = snapshot.effort === null
      ? null
      : privateText(snapshot.effort, 'invalid_provider_action', 256)
    if (!['read_only', 'workspace_write', 'full_access'].includes(snapshot.access_profile)) {
      reject('invalid_provider_action')
    }
    return deepFreeze({
      ...snapshot,
      action_id: actionId,
      scope_id: scopeId,
      session_id: sessionId,
      model,
      effort,
      cost_limit: costLimit,
    })
  }
  return reject('invalid_provider_action')
}

const actionFingerprint = (action: ProviderActionV1): string => {
  const digest = createHmac('sha256', ENVIRONMENT_FINGERPRINT_KEY)
  digest.update('provider-action-v1:')
  digest.update(JSON.stringify(action))
  return `sha256:${digest.digest('hex')}`
}

const sameSelection = (
  left: ProviderExecutionSelectionV1,
  right: ProviderExecutionSelectionV1,
): boolean =>
  left.provider_id === right.provider_id
  && left.adapter_id === right.adapter_id
  && left.mode_id === right.mode_id
  && left.runtime_mode === right.runtime_mode
  && left.billing_mode === right.billing_mode
  && left.credential_kind === right.credential_kind

const launchBoundaries = new WeakMap<object, {
  executable: Readonly<ProviderExecutableDiscoveryV1>
  manifest_fingerprint: string
  executable_fingerprint: string
  configuration_fingerprint: string
  environment: PreparedProviderEnvironmentV1
  environment_state: ReturnType<typeof preparedEnvironmentState>
  evidence: Readonly<ProviderLaunchBoundaryEvidenceV1>
}>()

class ProviderLaunchBoundary implements ProviderLaunchBoundaryV1 {
  constructor(token: symbol, state: {
    executable: Readonly<ProviderExecutableDiscoveryV1>
    manifest_fingerprint: string
    executable_fingerprint: string
    configuration_fingerprint: string
    environment: PreparedProviderEnvironmentV1
    environment_state: ReturnType<typeof preparedEnvironmentState>
    evidence: ProviderLaunchBoundaryEvidenceV1
  }) {
    if (token !== LAUNCH_BOUNDARY_TOKEN) reject('launch_boundary_required')
    launchBoundaries.set(this, {
      ...state,
      evidence: deepFreeze(clonePlain(state.evidence, 'invalid_launch_boundary')),
    })
    Object.freeze(this)
  }

  get evidence(): Readonly<ProviderLaunchBoundaryEvidenceV1> {
    return validatedLaunchBoundary(this).evidence
  }

  toJSON(): ProviderLaunchBoundaryEvidenceV1 {
    return clonePlain(this.evidence, 'invalid_launch_boundary')
  }
}

function validatedLaunchBoundary(value: unknown): {
  executable: Readonly<ProviderExecutableDiscoveryV1>
  manifest_fingerprint: string
  executable_fingerprint: string
  configuration_fingerprint: string
  environment: PreparedProviderEnvironmentV1
  environment_state: ReturnType<typeof preparedEnvironmentState>
  evidence: Readonly<ProviderLaunchBoundaryEvidenceV1>
} {
  if (!value || typeof value !== 'object') reject('launch_boundary_required')
  const state = launchBoundaries.get(value)
  if (!state) reject('launch_boundary_required')
  return state
}

export function defineProviderLaunchBoundaryV1(
  manifest: ProviderManifestV1,
  discovery: ProviderExecutableDiscoveryV1,
  configurationFingerprint: string,
  environment: PreparedProviderEnvironmentV1,
): ProviderLaunchBoundaryV1 {
  const defined = defineProviderManifestV1(manifest)
  const executable = defineProviderExecutableDiscoveryV1(discovery)
  if (!SHA256_FINGERPRINT.test(configurationFingerprint)) reject('invalid_configuration_fingerprint')
  const environmentState = preparedEnvironmentState(environment)
  if (executable.provider_id !== defined.provider_id
    || executable.adapter_id !== defined.adapter_id) reject('executable_manifest_mismatch')
  if (executable.status === 'validated') {
    if (executable.version === null
      || !defined.executable.validated_versions.includes(executable.version)) {
      reject('incompatible_executable_version')
    }
    if (executable.platform === null
      || !defined.executable.supported_platforms.includes(executable.platform)) {
      reject('unsupported_executable_platform')
    }
    const sourceMatches = defined.executable.source === 'sdk_bundled'
      ? executable.source === 'sdk_bundled'
      : executable.source === 'path'
        || (executable.source === 'environment_override'
          && defined.executable.command_override_env !== undefined)
    if (!sourceMatches) reject('untrusted_executable_provenance')
  }
  const manifestDigest = manifestFingerprint(defined)
  const resolvedPathFingerprint = executable.resolved_path === null
    ? null
    : actionFingerprint({
      contract_version: 1,
      kind: 'fork',
      action_id: 'resolved-path',
      scope_id: 'executable',
      session_id: executable.resolved_path,
      model: null,
      effort: null,
      access_profile: 'read_only',
      cost_limit: null,
    })
  return new ProviderLaunchBoundary(LAUNCH_BOUNDARY_TOKEN, {
    executable,
    manifest_fingerprint: manifestDigest,
    executable_fingerprint: executable.executable_fingerprint,
    configuration_fingerprint: configurationFingerprint,
    environment,
    environment_state: environmentState,
    evidence: {
      contract_version: PROVIDER_CONTRACT_VERSION,
      provider_id: defined.provider_id,
      adapter_id: defined.adapter_id,
      manifest_fingerprint: manifestDigest,
      executable_status: executable.status,
      executable_source: executable.source,
      executable_version: executable.version,
      executable_platform: executable.platform,
      executable_resolved_path_fingerprint: resolvedPathFingerprint,
      executable_fingerprint: executable.executable_fingerprint,
      configuration_fingerprint: configurationFingerprint,
      environment_fingerprint: environmentState.evidence.environment_fingerprint,
    },
  })
}

export function providerLaunchDecisionV1(
  manifest: ProviderManifestV1,
  intent: ProviderExecutionIntentV1,
  readiness: ProviderReadinessV1,
  boundary: ProviderLaunchBoundaryV1,
  action: ProviderActionV1,
): ProviderLaunchDecisionV1 {
  const defined = defineProviderManifestV1(manifest)
  const planned = defineProviderExecutionIntentV1(intent)
  const observed = defineProviderReadinessV1(readiness)
  const launchBoundary = validatedLaunchBoundary(boundary)
  const plannedAction = defineProviderActionV1(action)
  const blockers = new Set<ProviderLaunchBlockerCode>()
  const mode = defined.modes.find((candidate) => candidate.id === planned.selection.mode_id)
  const observedAt = Date.parse(observed.observed_at)
  const now = Date.now()

  if (defined.release_state === 'unsupported') blockers.add('unsupported_provider')
  if (defined.environment.audit_state !== 'complete') blockers.add('environment_audit_incomplete')
  if (launchBoundary.manifest_fingerprint !== manifestFingerprint(defined)
    || launchBoundary.executable.provider_id !== defined.provider_id
    || launchBoundary.executable.adapter_id !== defined.adapter_id) {
    blockers.add('executable_mismatch')
  }
  if (observedAt > now + PROVIDER_READINESS_FUTURE_SKEW_MS) {
    blockers.add('readiness_from_future')
  } else if (now - observedAt > PROVIDER_READINESS_MAX_AGE_MS) {
    blockers.add('readiness_stale')
  }
  if (launchBoundary.executable_fingerprint !== observed.executable_fingerprint) {
    blockers.add('executable_mismatch')
  }
  if (launchBoundary.executable.status !== observed.executable_status) {
    blockers.add('executable_mismatch')
  }
  if (launchBoundary.configuration_fingerprint !== observed.configuration_fingerprint) {
    blockers.add('configuration_mismatch')
  }
  if (launchBoundary.environment_state.evidence.environment_fingerprint
    !== observed.environment_fingerprint) {
    blockers.add('environment_mismatch')
  }
  const preparedSelection = launchBoundary.environment_state.evidence
  if (preparedSelection.provider_id !== planned.selection.provider_id
    || preparedSelection.mode_id !== planned.selection.mode_id
    || preparedSelection.runtime_mode !== planned.selection.runtime_mode
    || preparedSelection.billing_mode !== planned.selection.billing_mode
    || preparedSelection.credential_kind !== planned.selection.credential_kind) {
    blockers.add('environment_mismatch')
  }
  if (!mode) {
    blockers.add('unsupported_mode')
  } else {
    if (mode.support.state === 'unsupported' || mode.support.state === 'unknown') {
      blockers.add('unsupported_mode')
    } else if (mode.support.state === 'policy_blocked') {
      blockers.add('provider_policy_blocked')
    }
    if (planned.selection.provider_id !== defined.provider_id
      || planned.selection.adapter_id !== defined.adapter_id
      || planned.selection.runtime_mode !== mode.runtime_mode) {
      blockers.add('selection_mismatch')
    }
    if (planned.selection.billing_mode !== mode.billing_mode) blockers.add('billing_mismatch')
    if (!mode.credential_kinds.includes(
      planned.selection.credential_kind as Exclude<ProviderCredentialKind, 'unknown'>,
    )) blockers.add('credential_kind_mismatch')
    if (mode.billing_mode === 'usage_priced_api' && planned.usage_priced_api.state !== 'granted') {
      blockers.add('usage_priced_api_consent_required')
    }
    if (mode.billing_mode === 'personal_subscription'
      && planned.usage_priced_api.state !== 'not_required') {
      blockers.add('billing_mismatch')
    }
    if (mode.automation_policy === 'blocked' || mode.automation_policy === 'unknown') {
      blockers.add('provider_policy_blocked')
    } else if (mode.automation_policy === 'interactive_only'
      && planned.execution_scope !== 'interactive') {
      blockers.add('interactive_only')
    }
  }

  if (!sameSelection(planned.selection, observed.selection)) {
    blockers.add('selection_mismatch')
    if (planned.selection.billing_mode !== observed.selection.billing_mode) blockers.add('billing_mismatch')
    if (planned.selection.credential_kind !== observed.selection.credential_kind) {
      blockers.add('credential_kind_mismatch')
    }
  }

  if (observed.executable_status === 'missing') blockers.add('missing_executable')
  if (observed.executable_status === 'incompatible') blockers.add('incompatible_version')
  if (observed.executable_status === 'untrusted') blockers.add('untrusted_executable')
  if (observed.executable_status === 'unknown') blockers.add('executable_unknown')
  if (launchBoundary.executable.status === 'missing') blockers.add('missing_executable')
  if (launchBoundary.executable.status === 'incompatible') blockers.add('incompatible_version')
  if (launchBoundary.executable.status === 'untrusted') blockers.add('untrusted_executable')
  if (launchBoundary.executable.status === 'unknown') blockers.add('executable_unknown')

  if (observed.auth_status === 'signed_out'
    || observed.auth_status === 'expired'
    || observed.auth_status === 'revoked') blockers.add('authentication_required')
  if (observed.auth_status === 'credential_conflict') blockers.add('credential_conflict')
  if (observed.auth_status === 'unknown') blockers.add('authentication_unknown')

  if (observed.automation_policy === 'blocked' || observed.automation_policy === 'unknown') {
    blockers.add('provider_policy_blocked')
  } else if (observed.automation_policy === 'interactive_only'
    && planned.execution_scope !== 'interactive') {
    blockers.add('interactive_only')
  }
  if (mode && observed.automation_policy !== mode.automation_policy) {
    blockers.add('provider_policy_blocked')
  }

  if (observed.overage_status === 'exhausted') blockers.add('quota_exhausted')
  if (mode) {
    if (mode.overage.behavior === 'none') {
      if (!['disabled', 'not_applicable'].includes(observed.overage_status)
        || observed.overage_consent !== 'not_required'
        || planned.provider_managed_overage.state !== 'not_required') {
        blockers.add('overage_policy_mismatch')
      }
    } else if (mode.overage.behavior === 'optional_metered') {
      if (observed.overage_status === 'unknown') blockers.add('overage_unknown')
      if (observed.overage_status === 'enabled'
        && (planned.provider_managed_overage.state !== 'granted'
          || observed.overage_consent !== 'granted')) {
        blockers.add('overage_consent_required')
      }
    } else if (mode.overage.behavior === 'always_metered') {
      if (observed.overage_status === 'unknown') blockers.add('overage_unknown')
      if (observed.overage_status !== 'enabled') blockers.add('overage_policy_mismatch')
      if (planned.provider_managed_overage.state !== 'granted'
        || observed.overage_consent !== 'granted') {
        blockers.add('overage_consent_required')
      }
    } else {
      blockers.add('overage_unknown')
    }
  }

  const meteringRequired = mode?.billing_mode === 'usage_priced_api'
    || observed.overage_status === 'enabled'
  if (meteringRequired) {
    blockers.add('durable_cost_authority_unavailable')
    if (observed.metering_status !== 'ready') blockers.add('metering_unavailable')
    if (observed.cost_cap_status !== 'enforced' || plannedAction.cost_limit === null) {
      blockers.add('cost_cap_unenforced')
    }
    const consent = mode?.billing_mode === 'usage_priced_api'
      ? planned.usage_priced_api
      : planned.provider_managed_overage
    if (consent.state === 'granted') {
      if (consent.scope_id !== plannedAction.scope_id
        || consent.currency !== plannedAction.cost_limit?.currency
        || (plannedAction.cost_limit !== null
          && consent.max_cost_minor_units !== null
          && plannedAction.cost_limit.max_cost_minor_units > consent.max_cost_minor_units)) {
        blockers.add('cost_consent_scope_mismatch')
      }
    }
  } else {
    if (observed.metering_status !== 'not_required') blockers.add('metering_unavailable')
    if (observed.cost_cap_status !== 'not_required' || plannedAction.cost_limit !== null) {
      blockers.add('cost_cap_unenforced')
    }
  }

  const inferredCapabilities = new Set<ProviderCapabilityId>(planned.required_capabilities)
  inferredCapabilities.add(plannedAction.kind)
  if (planned.execution_scope !== 'interactive') inferredCapabilities.add('structured_events')
  if (plannedAction.kind === 'launch' || plannedAction.kind === 'fork') {
    inferredCapabilities.add('access_profile')
    if (plannedAction.model !== null) inferredCapabilities.add('model_selection')
    if (plannedAction.effort !== null) inferredCapabilities.add('effort')
  }
  if (meteringRequired) {
    inferredCapabilities.add('usage')
    inferredCapabilities.add('cost_budget')
  }
  const required: readonly unknown[] = [...inferredCapabilities]
  for (const capability of required) {
    if (typeof capability !== 'string'
      || !(PROVIDER_CAPABILITY_IDS as readonly string[]).includes(capability)
      || mode?.capabilities[capability as ProviderCapabilityId].state !== 'supported') {
      blockers.add('capability_unsupported')
      break
    }
  }

  return blockers.size
    ? deepFreeze({ ready: false as const, blockers: [...blockers].sort() })
    : deepFreeze({ ready: true as const, selection: clonePlain(planned.selection, 'invalid_selection') })
}

const snapshotEnvironment = (value: NodeJS.ProcessEnv | undefined): Record<string, string> => {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('environment_unreadable')
  let descriptors: Record<string, PropertyDescriptor> = {}
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    reject('environment_unreadable')
  }
  const names = Object.keys(descriptors).filter((name) => descriptors[name]?.enumerable)
  if (names.length > MAX_ENVIRONMENT_VARIABLES) reject('environment_too_large')
  const snapshot: Record<string, string> = {}
  for (const name of names) {
    if (!ENVIRONMENT_VARIABLE.test(name) || name.includes('\0')) reject('invalid_environment_name')
    const descriptor = descriptors[name]
    if (!descriptor || !('value' in descriptor)) reject('environment_accessor_rejected')
    const entry = descriptor.value
    if (entry === undefined) continue
    if (typeof entry !== 'string'
      || entry.length > MAX_ENVIRONMENT_VALUE_LENGTH
      || entry.includes('\0')) {
      reject('invalid_environment_value')
    }
    snapshot[name] = entry
  }
  return snapshot
}

const preparedEnvironments = new WeakMap<object, {
  environment: Readonly<Record<string, string>>
  evidence: Readonly<ProviderEnvironmentEvidenceV1>
}>()

export interface PreparedProviderEnvironmentV1 {
  readonly evidence: Readonly<ProviderEnvironmentEvidenceV1>
  forSpawn(): Readonly<NodeJS.ProcessEnv>
  toJSON(): ProviderEnvironmentEvidenceV1
}

const environmentFingerprint = (environment: Readonly<Record<string, string>>): string => {
  const digest = createHmac('sha256', ENVIRONMENT_FINGERPRINT_KEY)
  for (const name of Object.keys(environment).sort()) {
    const value = environment[name] ?? ''
    digest.update(`${Buffer.byteLength(name)}:${name}${Buffer.byteLength(value)}:${value}`)
  }
  return `sha256:${digest.digest('hex')}`
}

class PreparedProviderEnvironment implements PreparedProviderEnvironmentV1 {
  constructor(
    token: symbol,
    environment: Record<string, string>,
    evidence: ProviderEnvironmentEvidenceV1,
  ) {
    if (token !== PREPARED_ENVIRONMENT_TOKEN) reject('prepared_environment_required')
    preparedEnvironments.set(this, {
      environment: deepFreeze({ ...environment }),
      evidence: deepFreeze({
        ...evidence,
        stripped_variables: [...evidence.stripped_variables],
      }),
    })
    Object.freeze(this)
  }

  get evidence(): Readonly<ProviderEnvironmentEvidenceV1> {
    return preparedEnvironmentState(this).evidence
  }

  forSpawn(): Readonly<NodeJS.ProcessEnv> {
    return Object.freeze({ ...preparedEnvironmentState(this).environment })
  }

  toJSON(): ProviderEnvironmentEvidenceV1 {
    return {
      ...this.evidence,
      stripped_variables: [...this.evidence.stripped_variables],
    }
  }
}

function preparedEnvironmentState(value: unknown): {
  environment: Readonly<Record<string, string>>
  evidence: Readonly<ProviderEnvironmentEvidenceV1>
} {
  if (!value || typeof value !== 'object') reject('prepared_environment_required')
  const state = preparedEnvironments.get(value)
  if (!state) reject('prepared_environment_required')
  return state
}

export function prepareProviderEnvironmentV1(
  manifest: ProviderManifestV1,
  intent: ProviderExecutionIntentV1,
  source: NodeJS.ProcessEnv,
  options: PrepareProviderEnvironmentOptionsV1 = {},
): PreparedProviderEnvironmentV1 {
  const defined = defineProviderManifestV1(manifest)
  const planned = defineProviderExecutionIntentV1(intent)
  const selection = planned.selection
  const mode = defined.modes.find((candidate) => candidate.id === selection.mode_id)
  if (!mode
    || selection.provider_id !== defined.provider_id
    || selection.adapter_id !== defined.adapter_id
    || selection.runtime_mode !== mode.runtime_mode
    || selection.billing_mode !== mode.billing_mode
    || !mode.credential_kinds.includes(
      selection.credential_kind as Exclude<ProviderCredentialKind, 'unknown'>,
    )) {
    reject('selection_mismatch')
  }
  if (defined.environment.audit_state !== 'complete') reject('environment_audit_incomplete')
  if (mode.billing_mode === 'usage_priced_api' && planned.usage_priced_api.state !== 'granted') {
    reject('usage_priced_api_consent_required')
  }
  if (mode.billing_mode === 'personal_subscription'
    && planned.usage_priced_api.state !== 'not_required') {
    reject('unexpected_usage_priced_api_consent')
  }
  const selectedOptions = clonePlain(options, 'invalid_environment_options')
  if (!selectedOptions || typeof selectedOptions !== 'object' || Array.isArray(selectedOptions)) {
    reject('invalid_environment_options')
  }
  const optionKeys = Object.keys(selectedOptions)
  if (optionKeys.some((key) => !['on_conflict', 'overrides'].includes(key))) {
    reject('invalid_environment_options')
  }
  const conflictPolicy = selectedOptions.on_conflict ?? 'reject'
  if (!['reject', 'strip'].includes(conflictPolicy)) reject('invalid_environment_conflict_policy')
  const environment = {
    ...snapshotEnvironment(source),
    ...snapshotEnvironment(selectedOptions.overrides),
  }
  const conflicts = defined.environment.conflict_rules
    .filter((rule) =>
      Object.prototype.hasOwnProperty.call(environment, rule.variable)
      && (!rule.allowed_mode_ids.includes(mode.id)
        || !rule.allowed_credential_kinds.includes(
          selection.credential_kind as Exclude<ProviderCredentialKind, 'unknown'>,
        )
        || !managedEnvironmentVariableAllowsSelection(
          rule.variable,
          defined.provider_id,
          defined.adapter_id,
          mode.billing_mode,
          selection.credential_kind as Exclude<ProviderCredentialKind, 'unknown'>,
        )))
    .map((rule) => rule.variable)
    .sort()
  if (conflicts.length && conflictPolicy === 'reject') reject('environment_conflict', conflicts)
  for (const variable of conflicts) delete environment[variable]
  const fingerprint = environmentFingerprint(environment)
  return new PreparedProviderEnvironment(PREPARED_ENVIRONMENT_TOKEN, environment, {
    contract_version: PROVIDER_CONTRACT_VERSION,
    provider_id: defined.provider_id,
    mode_id: mode.id,
    runtime_mode: mode.runtime_mode,
    billing_mode: mode.billing_mode,
    credential_kind: selection.credential_kind,
    conflict_policy: conflictPolicy,
    stripped_variables: conflicts,
    retained_variable_count: Object.keys(environment).length,
    environment_fingerprint: fingerprint,
  })
}

const launchAuthorizations = new WeakMap<object, {
  intent: Readonly<ProviderExecutionIntentV1>
  action: Readonly<ProviderActionV1>
  readiness: Readonly<ProviderReadinessV1>
  executable: Readonly<ProviderExecutableDiscoveryV1>
  environment: PreparedProviderEnvironmentV1
  evidence: Readonly<ProviderLaunchAuthorizationEvidenceV1>
  consumed: boolean
}>()

class AuthorizedProviderLaunch implements AuthorizedProviderLaunchV1 {
  constructor(token: symbol, state: {
    intent: Readonly<ProviderExecutionIntentV1>
    action: Readonly<ProviderActionV1>
    readiness: Readonly<ProviderReadinessV1>
    executable: Readonly<ProviderExecutableDiscoveryV1>
    environment: PreparedProviderEnvironmentV1
    evidence: ProviderLaunchAuthorizationEvidenceV1
  }) {
    if (token !== LAUNCH_AUTHORIZATION_TOKEN) reject('launch_authorization_required')
    launchAuthorizations.set(this, {
      ...state,
      evidence: deepFreeze(clonePlain(state.evidence, 'invalid_authorization_evidence')),
      consumed: false,
    })
    Object.freeze(this)
  }

  get evidence(): Readonly<ProviderLaunchAuthorizationEvidenceV1> {
    return launchAuthorizationState(this).evidence
  }

  toJSON(): ProviderLaunchAuthorizationEvidenceV1 {
    return clonePlain(this.evidence, 'invalid_authorization_evidence')
  }
}

function launchAuthorizationState(value: unknown): {
  intent: Readonly<ProviderExecutionIntentV1>
  action: Readonly<ProviderActionV1>
  readiness: Readonly<ProviderReadinessV1>
  executable: Readonly<ProviderExecutableDiscoveryV1>
  environment: PreparedProviderEnvironmentV1
  evidence: Readonly<ProviderLaunchAuthorizationEvidenceV1>
  consumed: boolean
} {
  if (!value || typeof value !== 'object') reject('launch_authorization_required')
  const state = launchAuthorizations.get(value)
  if (!state) reject('launch_authorization_required')
  return state
}

const manifestFingerprint = (manifest: ProviderManifestV1): string => {
  const digest = createHmac('sha256', ENVIRONMENT_FINGERPRINT_KEY)
  digest.update('provider-manifest-v1:')
  digest.update(JSON.stringify(manifest))
  return `sha256:${digest.digest('hex')}`
}

export function authorizeProviderLaunchV1(
  manifest: ProviderManifestV1,
  intent: ProviderExecutionIntentV1,
  readiness: ProviderReadinessV1,
  boundary: ProviderLaunchBoundaryV1,
  action: ProviderActionV1,
): ProviderLaunchAuthorizationResultV1 {
  const decision = providerLaunchDecisionV1(manifest, intent, readiness, boundary, action)
  if (!decision.ready) return decision
  const defined = defineProviderManifestV1(manifest)
  const planned = defineProviderExecutionIntentV1(intent)
  const plannedAction = defineProviderActionV1(action)
  const observed = defineProviderReadinessV1(readiness)
  const launchBoundary = validatedLaunchBoundary(boundary)
  const authorizedAtMs = Date.now()
  const readinessExpiry = Date.parse(observed.observed_at) + PROVIDER_READINESS_MAX_AGE_MS
  const consentExpiries = [
    costConsentState(planned.usage_priced_api).evidence,
    costConsentState(planned.provider_managed_overage).evidence,
  ].filter((consent) => consent.state === 'granted')
    .map((consent) => Date.parse(consent.expires_at as string))
  const expiresAtMs = Math.min(
    readinessExpiry,
    authorizedAtMs + PROVIDER_LAUNCH_AUTHORIZATION_TTL_MS,
    ...consentExpiries,
  )
  if (expiresAtMs <= authorizedAtMs) {
    return { ready: false, blockers: ['readiness_stale'] }
  }
  const authorization = new AuthorizedProviderLaunch(LAUNCH_AUTHORIZATION_TOKEN, {
    intent: planned,
    action: plannedAction,
    readiness: observed,
    executable: launchBoundary.executable,
    environment: launchBoundary.environment,
    evidence: {
      contract_version: PROVIDER_CONTRACT_VERSION,
      selection: planned.selection,
      action_kind: plannedAction.kind,
      action_id: plannedAction.action_id,
      scope_id: plannedAction.scope_id,
      action_fingerprint: actionFingerprint(plannedAction),
      authorized_at: new Date(authorizedAtMs).toISOString(),
      expires_at: new Date(expiresAtMs).toISOString(),
      readiness_observed_at: observed.observed_at,
      manifest_fingerprint: manifestFingerprint(defined),
      executable_fingerprint: launchBoundary.executable_fingerprint,
      configuration_fingerprint: launchBoundary.configuration_fingerprint,
      environment_fingerprint: launchBoundary.environment_state.evidence.environment_fingerprint,
      usage_priced_api_consent: costConsentState(planned.usage_priced_api).evidence,
      provider_managed_overage_consent: costConsentState(
        planned.provider_managed_overage,
      ).evidence,
      reserved_cost: null,
    },
  })
  return { ready: true, authorization }
}

export const authorizeProviderActionV1 = authorizeProviderLaunchV1

type ProviderConsumedLaunchContextV1 = Omit<
  ProviderAuthorizedLaunchContextV1,
  'assigned_session_id'
>

function consumeProviderLaunchAuthorization(
  authorization: AuthorizedProviderLaunchV1,
  manifest: ProviderManifestV1,
  expectedAction: ProviderActionV1['kind'],
  currentDiscovery: ProviderExecutableDiscoveryV1,
): ProviderConsumedLaunchContextV1 {
  const state = launchAuthorizationState(authorization)
  const defined = defineProviderManifestV1(manifest)
  const currentExecutable = defineProviderExecutableDiscoveryV1(currentDiscovery)
  if (state.consumed) reject('launch_authorization_consumed')
  const now = Date.now()
  if (now >= Date.parse(state.evidence.expires_at)) reject('launch_authorization_expired')
  if (state.action.kind !== expectedAction
    || state.evidence.action_kind !== expectedAction
    || state.evidence.action_fingerprint !== actionFingerprint(state.action)) {
    reject('launch_authorization_action_mismatch')
  }
  if (state.evidence.manifest_fingerprint !== manifestFingerprint(defined)
    || state.evidence.selection.provider_id !== defined.provider_id
    || state.evidence.selection.adapter_id !== defined.adapter_id) {
    reject('launch_authorization_manifest_mismatch')
  }
  if (currentExecutable.status !== 'validated'
    || currentExecutable.provider_id !== state.executable.provider_id
    || currentExecutable.adapter_id !== state.executable.adapter_id
    || currentExecutable.source !== state.executable.source
    || currentExecutable.version !== state.executable.version
    || currentExecutable.platform !== state.executable.platform
    || currentExecutable.resolved_path !== state.executable.resolved_path
    || currentExecutable.executable_fingerprint !== state.executable.executable_fingerprint) {
    reject('launch_authorization_executable_mismatch')
  }
  for (const consent of [
    costConsentState(state.intent.usage_priced_api).evidence,
    costConsentState(state.intent.provider_managed_overage).evidence,
  ]) {
    validateCostConsentEvidence(consent, 'launch_authorization_consent_invalid')
    if (consent.state === 'granted' && Date.parse(consent.expires_at as string) <= now) {
      reject('launch_authorization_expired')
    }
  }
  const environmentState = preparedEnvironmentState(state.environment)
  if (environmentState.evidence.environment_fingerprint
    !== state.evidence.environment_fingerprint) {
    reject('launch_authorization_environment_mismatch')
  }
  state.consumed = true
  return Object.freeze({
    intent: state.intent,
    action: state.action,
    readiness: state.readiness,
    executable: state.executable,
    environment: Object.freeze(state.environment.forSpawn()),
  })
}

const authorizationFromRequest = (
  request: unknown,
  code: string,
): AuthorizedProviderLaunchV1 => {
  const values = ownDataProperties(request, ['authorization'], code)
  return values.authorization as AuthorizedProviderLaunchV1
}

type ProviderAdapterImplementationStateV1 = {
  readonly receiver: object
  readonly discoverExecutable: ProviderExecutionAdapterImplementationV1['discoverExecutable']
  readonly probeReadiness: ProviderExecutionAdapterImplementationV1['probeReadiness']
  readonly listModels: ProviderExecutionAdapterImplementationV1['listModels']
  readonly launch: ProviderExecutionAdapterImplementationV1['launch']
  readonly followUp: ProviderExecutionAdapterImplementationV1['followUp']
  readonly fork: ProviderExecutionAdapterImplementationV1['fork']
  readonly interrupt: ProviderExecutionAdapterImplementationV1['interrupt']
  readonly cancel: ProviderExecutionAdapterImplementationV1['cancel']
  readonly stop: ProviderExecutionAdapterImplementationV1['stop']
  readonly submitApproval: ProviderExecutionAdapterImplementationV1['submitApproval']
  readonly events: ProviderExecutionAdapterImplementationV1['events']
  readonly usage: ProviderExecutionAdapterImplementationV1['usage']
}

type ProviderAdapterDefinitionV1 = {
  readonly manifest: Readonly<ProviderManifestV1>
  readonly implementation: Readonly<ProviderAdapterImplementationStateV1>
}

const providerAdapterDefinition = (
  implementation: ProviderExecutionAdapterImplementationV1,
): ProviderAdapterDefinitionV1 => {
  const methodNames = [
    'discoverExecutable',
    'probeReadiness',
    'listModels',
    'launch',
    'followUp',
    'fork',
    'interrupt',
    'cancel',
    'stop',
    'submitApproval',
    'events',
    'usage',
  ] as const
  const values = ownDataProperties(
    implementation,
    ['contract_version', 'manifest', ...methodNames],
    'invalid_provider_adapter',
  )
  if (values.contract_version !== PROVIDER_CONTRACT_VERSION) {
    reject('invalid_provider_adapter')
  }
  for (const method of methodNames) {
    if (typeof values[method] !== 'function') reject('invalid_provider_adapter')
  }
  const manifest = defineProviderManifestV1(values.manifest as ProviderManifestV1)
  return Object.freeze({
    manifest,
    implementation: Object.freeze({
      receiver: implementation,
      discoverExecutable: values.discoverExecutable as ProviderExecutionAdapterImplementationV1['discoverExecutable'],
      probeReadiness: values.probeReadiness as ProviderExecutionAdapterImplementationV1['probeReadiness'],
      listModels: values.listModels as ProviderExecutionAdapterImplementationV1['listModels'],
      launch: values.launch as ProviderExecutionAdapterImplementationV1['launch'],
      followUp: values.followUp as ProviderExecutionAdapterImplementationV1['followUp'],
      fork: values.fork as ProviderExecutionAdapterImplementationV1['fork'],
      interrupt: values.interrupt as ProviderExecutionAdapterImplementationV1['interrupt'],
      cancel: values.cancel as ProviderExecutionAdapterImplementationV1['cancel'],
      stop: values.stop as ProviderExecutionAdapterImplementationV1['stop'],
      submitApproval: values.submitApproval as ProviderExecutionAdapterImplementationV1['submitApproval'],
      events: values.events as ProviderExecutionAdapterImplementationV1['events'],
      usage: values.usage as ProviderExecutionAdapterImplementationV1['usage'],
    }),
  })
}

type ManagedProviderEventStreamV1 = {
  readonly retirement: Promise<void>
  isRetired(): boolean
  retire(): void
  next(): Promise<IteratorResult<unknown>>
  close(): Promise<boolean>
}

type ManagedProviderSessionV1 = {
  authorization: AuthorizedProviderLaunchV1
  readonly session_id: string
  readonly adapter_session_id: string
  readonly selection: Readonly<ProviderExecutionSelectionV1>
  readonly scope_id: string
  readonly provider_session_id: string
  readonly access_profile: Readonly<NonNullable<ProviderSessionV1['access_profile']>>
  status: ProviderSessionV1['status']
  last_sequence: number
  readonly recent_event_ids: Set<string>
  readonly event_id_order: string[]
  event_id_cursor: number
  event_stream: ManagedProviderEventStreamV1 | null
  stop_promise: Promise<void> | null
}

type FailedProviderSessionCleanupV1 = {
  readonly adapter_session_id: string
  readonly identities: readonly string[]
}

type SafeProviderAbortControllerV1 = {
  readonly signal: AbortSignal
  abort(): void
}

const createSafeProviderAbortController = (): SafeProviderAbortControllerV1 => {
  const controller = new AbortController()
  const safeSignal = controller.signal
  const nativeAddEventListener = safeSignal.addEventListener
  const nativeRemoveEventListener = safeSignal.removeEventListener
  const nativeOnAbort = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'onabort')
  if (typeof nativeOnAbort?.get !== 'function' || typeof nativeOnAbort.set !== 'function') {
    throw new TypeError('AbortSignal.onabort is unavailable')
  }
  const listenerWrappers = new WeakMap<object, (event: Event) => void>()

  const wrappedListener = (listener: unknown): unknown => {
    if (listener === null
      || (typeof listener !== 'function' && typeof listener !== 'object')) {
      return listener
    }
    const key = listener as object
    const existing = listenerWrappers.get(key)
    if (existing) return existing
    const wrapped = (event: Event): void => {
      let result: unknown
      try {
        if (typeof listener === 'function') {
          result = Reflect.apply(listener, safeSignal, [event])
        } else {
          const handleEvent = Reflect.get(listener, 'handleEvent')
          if (typeof handleEvent !== 'function') return
          result = Reflect.apply(handleEvent, listener, [event])
        }
      } catch {
        return
      }
      try {
        void Promise.resolve(result).catch(() => undefined)
      } catch {
        // Listener thenable failures are contained like synchronous listener failures.
      }
    }
    listenerWrappers.set(key, wrapped)
    return wrapped
  }

  let onAbortValue = Reflect.apply(nativeOnAbort.get, safeSignal, [])
  Object.defineProperties(safeSignal, {
    addEventListener: {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function addEventListener(
        this: AbortSignal,
        type: string,
        listener: unknown,
        options?: unknown,
      ): void {
        Reflect.apply(nativeAddEventListener, this, [
          type,
          this === safeSignal ? wrappedListener(listener) : listener,
          options,
        ])
      },
    },
    removeEventListener: {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function removeEventListener(
        this: AbortSignal,
        type: string,
        listener: unknown,
        options?: unknown,
      ): void {
        const wrapped = this === safeSignal
          && listener !== null
          && (typeof listener === 'function' || typeof listener === 'object')
          ? listenerWrappers.get(listener as object) ?? listener
          : listener
        Reflect.apply(nativeRemoveEventListener, this, [type, wrapped, options])
      },
    },
    onabort: {
      configurable: nativeOnAbort.configurable,
      enumerable: nativeOnAbort.enumerable,
      get(): unknown {
        return onAbortValue
      },
      set(value: unknown): void {
        Reflect.apply(nativeOnAbort.set as (value: unknown) => void, safeSignal, [
          typeof value === 'function' ? wrappedListener(value) : value,
        ])
        onAbortValue = value
      },
    },
  })

  return Object.freeze({
    signal: safeSignal,
    abort(): void {
      controller.abort()
    },
  })
}

const PROVIDER_ACCESS_RANK = Object.freeze({
  read_only: 0,
  workspace_write: 1,
  full_access: 2,
} as const)

class ValidatedProviderExecutionAdapter implements ProviderExecutionAdapterV1 {
  readonly [VALIDATED_PROVIDER_ADAPTER_BRAND] = true
  readonly contract_version = PROVIDER_CONTRACT_VERSION
  readonly manifest: Readonly<ProviderManifestV1>
  readonly #implementation: Readonly<ProviderAdapterImplementationStateV1>
  readonly #sessions = new Map<string, ManagedProviderSessionV1>()
  readonly #adapterSessionIds = new Map<string, string>()
  readonly #providerSessionIds = new Map<string, string>()
  readonly #retiringSessions = new Set<ManagedProviderSessionV1>()
  readonly #failedSessionCleanups = new Set<FailedProviderSessionCleanupV1>()
  readonly #failedSessionIdentities = new Map<string, number>()
  readonly #sessionNamespace: string
  #sessionCounter = 0
  #pendingRegistrations = 0

  constructor(token: symbol, implementation: ProviderExecutionAdapterImplementationV1) {
    if (token !== VALIDATED_ADAPTER_TOKEN) reject('validated_provider_adapter_required')
    const definition = providerAdapterDefinition(implementation)
    this.manifest = definition.manifest
    this.#implementation = definition.implementation
    this.#sessionNamespace = randomBytes(16).toString('hex')
    validatedProviderAdapters.add(this)
    Object.freeze(this)
  }

  async #invoke<T>(operation: string, invoke: () => T | PromiseLike<T>): Promise<T> {
    try {
      return await invoke()
    } catch {
      return reject('provider_adapter_implementation_failed', [operation])
    }
  }

  #createRawEventStream(adapterSessionId: string): ManagedProviderEventStreamV1 {
    const controller = createSafeProviderAbortController()
    let resolveRetirement: (() => void) | undefined
    const retirement = new Promise<void>((resolve) => {
      resolveRetirement = resolve
    })
    let retired = false
    let iterator: AsyncIterator<unknown> | null = null
    let nextMethod: ((...args: never[]) => unknown) | null = null
    let returnMethod: ((...args: never[]) => unknown) | null = null
    let closePromise: Promise<boolean> | null = null
    const pendingNexts = new Set<Promise<unknown>>()

    const open = (): void => {
      if (iterator !== null) return
      try {
        const iterable = Reflect.apply(
          this.#implementation.events,
          this.#implementation.receiver,
          [adapterSessionId, Object.freeze({ signal: controller.signal })],
        ) as AsyncIterable<unknown>
        if (!iterable || typeof iterable !== 'object') {
          reject('provider_adapter_implementation_failed', ['events'])
        }
        const iteratorMethod = Reflect.get(iterable as object, Symbol.asyncIterator)
        if (typeof iteratorMethod !== 'function') {
          reject('provider_adapter_implementation_failed', ['events'])
        }
        const opened = Reflect.apply(iteratorMethod, iterable, []) as AsyncIterator<unknown>
        if (!opened || typeof opened !== 'object') {
          reject('provider_adapter_implementation_failed', ['events'])
        }
        const openedNext = Reflect.get(opened as object, 'next')
        const openedReturn = Reflect.get(opened as object, 'return')
        if (typeof openedNext !== 'function' || typeof openedReturn !== 'function') {
          reject('provider_adapter_implementation_failed', ['events'])
        }
        iterator = opened
        nextMethod = openedNext as (...args: never[]) => unknown
        returnMethod = openedReturn as (...args: never[]) => unknown
      } catch {
        reject('provider_adapter_implementation_failed', ['events'])
      }
    }

    const close = (): Promise<boolean> => {
      if (closePromise !== null) return closePromise
      try {
        controller.abort()
      } catch {
        // Stream cleanup must not expose abort implementation failures.
      }
      closePromise = (async () => {
        if (iterator === null || returnMethod === null) return true
        try {
          const result = await Reflect.apply(returnMethod, iterator, [])
          if (!result || typeof result !== 'object' || Reflect.get(result, 'done') !== true) {
            return false
          }
          await Promise.allSettled([...pendingNexts])
          return true
        } catch {
          return false
        }
      })()
      return closePromise
    }

    const retire = (): void => {
      if (retired) return
      retired = true
      resolveRetirement?.()
      try {
        controller.abort()
      } catch {
        // The gateway retirement result must not expose abort implementation failures.
      }
      void close().catch(() => undefined)
    }

    return {
      retirement,
      isRetired: () => retired,
      retire,
      async next(): Promise<IteratorResult<unknown>> {
        if (retired) reject('provider_event_session_retired')
        open()
        let pending: Promise<unknown> | null = null
        try {
          pending = Promise.resolve(
            Reflect.apply(
              nextMethod as (...args: never[]) => unknown,
              iterator as AsyncIterator<unknown>,
              [],
            ),
          )
          pendingNexts.add(pending)
          const result = await pending
          if (!result || typeof result !== 'object') {
            reject('provider_adapter_implementation_failed', ['events'])
          }
          return {
            done: Boolean(Reflect.get(result as object, 'done')),
            value: Reflect.get(result as object, 'value'),
          }
        } catch {
          reject('provider_adapter_implementation_failed', ['events'])
        } finally {
          if (pending !== null) pendingNexts.delete(pending)
        }
      },
      close,
    }
  }

  #modeForSelection(
    selection: ProviderExecutionSelectionV1,
  ): Readonly<ProviderExecutionModeV1> {
    const mode = this.manifest.modes.find((candidate) => candidate.id === selection.mode_id)
    if (!mode
      || selection.provider_id !== this.manifest.provider_id
      || selection.adapter_id !== this.manifest.adapter_id
      || selection.runtime_mode !== mode.runtime_mode
      || selection.billing_mode !== mode.billing_mode
      || !mode.credential_kinds.includes(
        selection.credential_kind as Exclude<ProviderCredentialKind, 'unknown'>,
      )) {
      reject('selection_mismatch')
    }
    return mode
  }

  #requireCapability(
    selection: ProviderExecutionSelectionV1,
    capability: ProviderCapabilityId,
    executionScope?: ProviderExecutionScope,
  ): Readonly<ProviderExecutionModeV1> {
    const mode = this.#modeForSelection(selection)
    if (this.manifest.release_state === 'unsupported'
      || mode.support.state !== 'supported'
      || mode.automation_policy === 'blocked'
      || mode.automation_policy === 'unknown'
      || (mode.automation_policy === 'interactive_only' && executionScope !== 'interactive')
      || mode.capabilities[capability].state !== 'supported') {
      reject('capability_unsupported')
    }
    return mode
  }

  async discoverExecutable(): Promise<ProviderExecutableDiscoveryV1> {
    const discovery = defineProviderExecutableDiscoveryV1(
      await this.#invoke('discover_executable', () => Reflect.apply(
        this.#implementation.discoverExecutable,
        this.#implementation.receiver,
        [],
      )) as ProviderExecutableDiscoveryV1,
    )
    if (discovery.provider_id !== this.manifest.provider_id
      || discovery.adapter_id !== this.manifest.adapter_id) {
      reject('executable_manifest_mismatch')
    }
    return discovery
  }

  prepareEnvironment(
    intent: ProviderExecutionIntentV1,
    source: NodeJS.ProcessEnv,
    options?: PrepareProviderEnvironmentOptionsV1,
  ): PreparedProviderEnvironmentV1 {
    return prepareProviderEnvironmentV1(this.manifest, intent, source, options)
  }

  async probeReadiness(
    intent: ProviderExecutionIntentV1,
    boundary: ProviderLaunchBoundaryV1,
  ): Promise<ProviderReadinessV1> {
    const planned = defineProviderExecutionIntentV1(intent)
    this.#modeForSelection(planned.selection)
    const launchBoundary = validatedLaunchBoundary(boundary)
    const preparedSelection = launchBoundary.environment_state.evidence
    if (launchBoundary.manifest_fingerprint !== manifestFingerprint(this.manifest)
      || launchBoundary.executable.provider_id !== this.manifest.provider_id
      || launchBoundary.executable.adapter_id !== this.manifest.adapter_id
      || preparedSelection.provider_id !== planned.selection.provider_id
      || preparedSelection.mode_id !== planned.selection.mode_id
      || preparedSelection.runtime_mode !== planned.selection.runtime_mode
      || preparedSelection.billing_mode !== planned.selection.billing_mode
      || preparedSelection.credential_kind !== planned.selection.credential_kind) {
      reject('readiness_context_mismatch')
    }
    const observed = defineProviderReadinessV1(
      await this.#invoke('probe_readiness', () => Reflect.apply(
        this.#implementation.probeReadiness,
        this.#implementation.receiver,
        [planned, boundary],
      )) as ProviderReadinessV1,
    )
    if (!sameSelection(observed.selection, planned.selection)
      || observed.executable_status !== launchBoundary.executable.status
      || observed.executable_fingerprint !== launchBoundary.executable_fingerprint
      || observed.configuration_fingerprint !== launchBoundary.configuration_fingerprint
      || observed.environment_fingerprint
        !== launchBoundary.environment_state.evidence.environment_fingerprint) {
      reject('readiness_context_mismatch')
    }
    return observed
  }

  async listModels(intent: ProviderExecutionIntentV1): Promise<readonly ProviderModelV1[]> {
    const planned = defineProviderExecutionIntentV1(intent)
    const mode = this.#requireCapability(
      planned.selection,
      'model_discovery',
      planned.execution_scope,
    )
    const models = defineProviderModelsV1(
      await this.#invoke('list_models', () => Reflect.apply(
        this.#implementation.listModels,
        this.#implementation.receiver,
        [planned],
      )) as readonly ProviderModelV1[],
    )
    if (mode.capabilities.model_selection.state === 'supported'
      && models.filter((model) => model.is_default).length !== 1) {
      reject('invalid_provider_models')
    }
    return models
  }

  async #consume(
    authorization: AuthorizedProviderLaunchV1,
    kind: ProviderActionV1['kind'],
  ): Promise<ProviderConsumedLaunchContextV1> {
    const executable = await this.discoverExecutable()
    return consumeProviderLaunchAuthorization(
      authorization,
      this.manifest,
      kind,
      executable,
    )
  }

  #implementationContext(
    context: ProviderConsumedLaunchContextV1,
    assignedSessionId: string,
  ): ProviderAuthorizedLaunchContextV1 {
    return Object.freeze({
      ...context,
      assigned_session_id: assignedSessionId,
    })
  }

  #validateSession(
    value: unknown,
    context: ProviderAuthorizedLaunchContextV1,
    captureProviderSessionId: (providerSessionId: string) => void,
  ): Readonly<ProviderSessionV1> {
    const session = defineProviderSessionV1(value as ProviderSessionV1)
    captureProviderSessionId(session.provider_session_id)
    if (session.session_id !== context.assigned_session_id) {
      reject('provider_session_assignment_mismatch')
    }
    if (!sameSelection(session.selection, context.intent.selection)) {
      reject('provider_session_selection_mismatch')
    }
    if (context.action.kind === 'launch' || context.action.kind === 'fork') {
      if (session.access_profile === null
        || session.access_profile.requested !== context.action.access_profile) {
        reject('provider_session_access_mismatch')
      }
      if (PROVIDER_ACCESS_RANK[session.access_profile.effective]
        > PROVIDER_ACCESS_RANK[context.action.access_profile]) {
        reject('provider_session_access_mismatch')
      }
      if (!session.model || session.model.requested !== context.action.model) {
        reject('provider_session_model_mismatch')
      }
      if ((session.effort === null && context.action.effort !== null)
        || (session.effort !== null
          && (session.effort.requested !== context.action.effort
            || (context.action.effort !== null && session.effort.effective === null)))) {
        reject('provider_session_effort_mismatch')
      }
    }
    if (context.action.kind === 'resume'
      && session.provider_session_id !== context.action.provider_session_id) {
      reject('provider_session_resume_mismatch')
    }
    return session
  }

  #reserveSessionRegistration(): void {
    if (this.#sessions.size
      + this.#retiringSessions.size
      + this.#failedSessionCleanups.size
      + this.#pendingRegistrations >= PROVIDER_SESSION_REGISTRY_LIMIT) {
      reject('provider_session_capacity_exceeded')
    }
    this.#pendingRegistrations += 1
  }

  #releaseSessionRegistration(): void {
    this.#pendingRegistrations -= 1
  }

  #mintAssignedSessionId(): string {
    while (this.#sessionCounter < Number.MAX_SAFE_INTEGER) {
      this.#sessionCounter += 1
      const candidate = [
        'managed',
        this.#sessionNamespace,
        this.#sessionCounter.toString(36),
      ].join('-')
      if (!this.#sessionIdentityInUse(candidate)) return candidate
    }
    return reject('provider_session_capacity_exceeded')
  }

  #sessionIdentityInUse(identity: string): boolean {
    return this.#sessions.has(identity)
      || this.#adapterSessionIds.has(identity)
      || this.#providerSessionIds.has(identity)
      || this.#failedSessionIdentities.has(identity)
  }

  #cleanupFailedRawSession(
    adapterSessionId: string,
    providerSessionIds: ReadonlySet<string>,
  ): void {
    const identities = Object.freeze([
      ...new Set([
        adapterSessionId,
        ...providerSessionIds,
      ]),
    ])
    const cleanup = Object.freeze({
      adapter_session_id: adapterSessionId,
      identities,
    })
    this.#failedSessionCleanups.add(cleanup)
    for (const identity of identities) {
      this.#failedSessionIdentities.set(
        identity,
        (this.#failedSessionIdentities.get(identity) ?? 0) + 1,
      )
    }
    void this.#invoke('stop', () => Reflect.apply(
      this.#implementation.stop,
      this.#implementation.receiver,
      [adapterSessionId],
    )).then(() => {
      if (!this.#failedSessionCleanups.delete(cleanup)) return
      for (const identity of identities) {
        const references = this.#failedSessionIdentities.get(identity)
        if (references === undefined || references <= 1) {
          this.#failedSessionIdentities.delete(identity)
        } else {
          this.#failedSessionIdentities.set(identity, references - 1)
        }
      }
    }).catch(() => undefined)
  }

  #registerSession(
    session: Readonly<ProviderSessionV1>,
    authorization: AuthorizedProviderLaunchV1,
  ): {
      readonly record: ManagedProviderSessionV1
      readonly session: Readonly<ProviderSessionV1>
    } {
    if (!['starting', 'running', 'idle'].includes(session.status)) {
      reject('provider_session_not_operable')
    }
    if (session.provider_session_id.startsWith(`managed-${this.#sessionNamespace}-`)
      || session.session_id === session.provider_session_id
      || this.#sessionIdentityInUse(session.session_id)
      || this.#sessionIdentityInUse(session.provider_session_id)) {
      reject('provider_session_identity_conflict')
    }
    if (session.access_profile === null) reject('provider_session_access_mismatch')
    const managedSessionId = session.session_id
    const authorizationState = launchAuthorizationState(authorization)
    const record: ManagedProviderSessionV1 = {
      authorization,
      session_id: managedSessionId,
      adapter_session_id: session.session_id,
      selection: session.selection,
      scope_id: authorizationState.action.scope_id,
      provider_session_id: session.provider_session_id,
      access_profile: session.access_profile,
      status: session.status,
      last_sequence: -1,
      recent_event_ids: new Set(),
      event_id_order: [],
      event_id_cursor: 0,
      event_stream: null,
      stop_promise: null,
    }
    this.#sessions.set(managedSessionId, record)
    this.#adapterSessionIds.set(session.session_id, managedSessionId)
    this.#providerSessionIds.set(session.provider_session_id, managedSessionId)
    return Object.freeze({
      record,
      session: defineProviderSessionV1({
        ...session,
        session_id: managedSessionId,
      }),
    })
  }

  #releaseRawSessionIdentities(record: ManagedProviderSessionV1): void {
    if (this.#adapterSessionIds.get(record.adapter_session_id) === record.session_id) {
      this.#adapterSessionIds.delete(record.adapter_session_id)
    }
    if (this.#providerSessionIds.get(record.provider_session_id) === record.session_id) {
      this.#providerSessionIds.delete(record.provider_session_id)
    }
    this.#retiringSessions.delete(record)
  }

  #unregisterSession(
    sessionId: string,
    expected?: ManagedProviderSessionV1,
  ): Promise<void> {
    const record = this.#sessions.get(sessionId)
    if (!record || (expected !== undefined && record !== expected)) {
      return Promise.resolve()
    }
    this.#sessions.delete(sessionId)
    record.recent_event_ids.clear()
    record.event_id_order.length = 0
    record.event_id_cursor = 0
    const stream = record.event_stream
    if (stream === null) {
      this.#releaseRawSessionIdentities(record)
      return Promise.resolve()
    }
    this.#retiringSessions.add(record)
    stream.retire()
    return stream.close().then((closed) => {
      if (closed) this.#releaseRawSessionIdentities(record)
    }).catch(() => undefined)
  }

  #requireSessionCapability(
    sessionId: string,
    capability: ProviderCapabilityId,
  ): ManagedProviderSessionV1 {
    const record = this.#sessions.get(sessionId)
    if (!record) reject('provider_session_authorization_required')
    const state = launchAuthorizationState(record.authorization)
    this.#requireCapability(
      state.intent.selection,
      capability,
      state.intent.execution_scope,
    )
    return record
  }

  #requireTargetSession(
    sessionId: string,
    context: ProviderConsumedLaunchContextV1,
    capability: ProviderCapabilityId,
  ): ManagedProviderSessionV1 {
    const record = this.#requireSessionCapability(sessionId, capability)
    if (!sameSelection(record.selection, context.intent.selection)) {
      reject('provider_session_selection_mismatch')
    }
    if (record.scope_id !== context.action.scope_id) {
      reject('provider_session_scope_mismatch')
    }
    return record
  }

  #implementationContextForSession(
    context: ProviderConsumedLaunchContextV1,
    record: ManagedProviderSessionV1,
    assignedSessionId: string,
  ): ProviderAuthorizedLaunchContextV1 {
    if (context.action.kind !== 'follow_up' && context.action.kind !== 'fork') {
      reject('launch_authorization_action_mismatch')
    }
    if (context.action.session_id !== record.session_id) {
      reject('provider_session_authorization_required')
    }
    return this.#implementationContext(context, assignedSessionId)
  }

  async launch(request: ProviderLaunchRequestV1): Promise<ProviderSessionV1> {
    this.#reserveSessionRegistration()
    let assignedSessionId: string | null = null
    const providerSessionIds = new Set<string>()
    let rawSessionStarted = false
    try {
      const authorization = authorizationFromRequest(request, 'invalid_launch_request')
      const consumedContext = await this.#consume(authorization, 'launch')
      assignedSessionId = this.#mintAssignedSessionId()
      const context = this.#implementationContext(
        consumedContext,
        assignedSessionId,
      )
      rawSessionStarted = true
      const rawSession = await this.#invoke('launch', () => Reflect.apply(
        this.#implementation.launch,
        this.#implementation.receiver,
        [context],
      ))
      const cleanupProviderSessionId = providerSessionIdForCleanup(rawSession)
      if (cleanupProviderSessionId !== null) {
        providerSessionIds.add(cleanupProviderSessionId)
      }
      const session = this.#validateSession(
        rawSession,
        context,
        (definedProviderSessionId) => {
          providerSessionIds.add(definedProviderSessionId)
        },
      )
      return this.#registerSession(session, authorization).session
    } catch (error) {
      if (rawSessionStarted && assignedSessionId !== null) {
        this.#cleanupFailedRawSession(assignedSessionId, providerSessionIds)
      }
      throw error
    } finally {
      this.#releaseSessionRegistration()
    }
  }

  async followUp(request: ProviderFollowUpRequestV1): Promise<void> {
    const authorization = authorizationFromRequest(request, 'invalid_follow_up_request')
    const context = await this.#consume(authorization, 'follow_up')
    if (context.action.kind !== 'follow_up') reject('launch_authorization_action_mismatch')
    const record = this.#requireTargetSession(
      context.action.session_id,
      context,
      'follow_up',
    )
    await this.#invoke('follow_up', () => Reflect.apply(
      this.#implementation.followUp,
      this.#implementation.receiver,
      [this.#implementationContextForSession(context, record, record.session_id)],
    ))
    record.authorization = authorization
  }

  async attach(_request: ProviderAttachRequestV1): Promise<ProviderSessionV1 | null> {
    return reject('capability_unsupported')
  }

  async resume(_request: ProviderResumeRequestV1): Promise<ProviderSessionV1> {
    return reject('capability_unsupported')
  }

  async fork(request: ProviderForkRequestV1): Promise<ProviderSessionV1> {
    this.#reserveSessionRegistration()
    let assignedSessionId: string | null = null
    const providerSessionIds = new Set<string>()
    let rawSessionStarted = false
    try {
      const authorization = authorizationFromRequest(request, 'invalid_fork_request')
      const context = await this.#consume(authorization, 'fork')
      if (context.action.kind !== 'fork') reject('launch_authorization_action_mismatch')
      const parent = this.#requireTargetSession(context.action.session_id, context, 'fork')
      if (PROVIDER_ACCESS_RANK[context.action.access_profile]
        > PROVIDER_ACCESS_RANK[parent.access_profile.effective]) {
        reject('provider_session_access_mismatch')
      }
      assignedSessionId = this.#mintAssignedSessionId()
      const implementationContext = this.#implementationContextForSession(
        context,
        parent,
        assignedSessionId,
      )
      rawSessionStarted = true
      const rawSession = await this.#invoke('fork', () => Reflect.apply(
        this.#implementation.fork,
        this.#implementation.receiver,
        [implementationContext],
      ))
      const cleanupProviderSessionId = providerSessionIdForCleanup(rawSession)
      if (cleanupProviderSessionId !== null) {
        providerSessionIds.add(cleanupProviderSessionId)
      }
      const session = this.#validateSession(
        rawSession,
        implementationContext,
        (definedProviderSessionId) => {
          providerSessionIds.add(definedProviderSessionId)
        },
      )
      if (session.session_id === parent.adapter_session_id
        || session.provider_session_id === parent.provider_session_id) {
        reject('provider_session_fork_identity_mismatch')
      }
      return this.#registerSession(session, authorization).session
    } catch (error) {
      if (rawSessionStarted && assignedSessionId !== null) {
        this.#cleanupFailedRawSession(assignedSessionId, providerSessionIds)
      }
      throw error
    } finally {
      this.#releaseSessionRegistration()
    }
  }

  async interrupt(session_id: string): Promise<void> {
    const sessionId = safeOpaqueIdentifier(session_id, 'invalid_provider_session')
    const record = this.#requireSessionCapability(sessionId, 'interrupt')
    await this.#invoke('interrupt', () => Reflect.apply(
      this.#implementation.interrupt,
      this.#implementation.receiver,
      [record.adapter_session_id],
    ))
  }

  async cancel(session_id: string): Promise<void> {
    const sessionId = safeOpaqueIdentifier(session_id, 'invalid_provider_session')
    const record = this.#requireSessionCapability(sessionId, 'cancel')
    await this.#invoke('cancel', () => Reflect.apply(
      this.#implementation.cancel,
      this.#implementation.receiver,
      [record.adapter_session_id],
    ))
  }

  stop(session_id: string): Promise<void> {
    const sessionId = safeOpaqueIdentifier(session_id, 'invalid_provider_session')
    const record = this.#requireSessionCapability(sessionId, 'stop')
    if (record.stop_promise !== null) return record.stop_promise
    record.stop_promise = Promise.resolve()
    const stopPromise = this.#invoke('stop', () => Reflect.apply(
      this.#implementation.stop,
      this.#implementation.receiver,
      [record.adapter_session_id],
    )).then(async () => {
      const cleanup = this.#unregisterSession(sessionId, record)
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => setImmediate(resolve)),
      ])
    }).catch((error: unknown) => {
      if (record.stop_promise === stopPromise) record.stop_promise = null
      throw error
    })
    record.stop_promise = stopPromise
    return stopPromise
  }

  async submitApproval(
    session_id: string,
    decision: ProviderApprovalDecisionV1,
  ): Promise<void> {
    const sessionId = safeOpaqueIdentifier(session_id, 'invalid_provider_session')
    const record = this.#requireSessionCapability(sessionId, 'approvals')
    const definedDecision = defineProviderApprovalDecisionV1(decision)
    await this.#invoke('submit_approval', () => Reflect.apply(
      this.#implementation.submitApproval,
      this.#implementation.receiver,
      [record.adapter_session_id, definedDecision],
    ))
  }

  async *#eventsForRecord(
    sessionId: string,
    record: ManagedProviderSessionV1,
    consumerRetirement: Promise<void>,
  ): AsyncIterable<ProviderEventV1> {
    if (this.#sessions.get(sessionId) !== record) {
      reject('provider_event_session_retired')
    }
    if (record.event_stream !== null) reject('provider_event_stream_already_open')
    const stream = this.#createRawEventStream(record.adapter_session_id)
    record.event_stream = stream
    let terminal = false
    try {
      while (true) {
        if (stream.isRetired() || this.#sessions.get(sessionId) !== record) {
          reject('provider_event_session_retired')
        }
        const rawOutcome = stream.next().then(
          (result) => Object.freeze({ kind: 'raw' as const, result }),
          () => Object.freeze({ kind: 'raw_error' as const }),
        )
        const outcome = await Promise.race([
          rawOutcome,
          stream.retirement.then(
            () => Object.freeze({ kind: 'retired' as const }),
          ),
          consumerRetirement.then(
            () => Object.freeze({ kind: 'consumer_retired' as const }),
          ),
        ])
        if (outcome.kind === 'consumer_retired') {
          void rawOutcome.then(() => undefined)
          return
        }
        if (outcome.kind === 'retired'
          || stream.isRetired()
          || this.#sessions.get(sessionId) !== record) {
          void rawOutcome.then(() => undefined)
          reject('provider_event_session_retired')
        }
        if (outcome.kind === 'raw_error') {
          reject('provider_adapter_implementation_failed', ['events'])
        }
        if (outcome.result.done) return
        const rawEvent = defineProviderEventV1(
          outcome.result.value as ProviderEventV1,
          record.authorization,
        )
        if (rawEvent.session_id !== record.adapter_session_id) {
          reject('provider_event_session_mismatch')
        }
        const event = deepFreeze({
          ...rawEvent,
          session_id: sessionId,
        }) as Readonly<ProviderEventV1>
        if (event.sequence <= record.last_sequence
          || record.recent_event_ids.has(event.event_id)) {
          reject('invalid_provider_event_order')
        }
        record.last_sequence = event.sequence
        if (record.event_id_order.length < PROVIDER_EVENT_ID_WINDOW_LIMIT) {
          record.event_id_order.push(event.event_id)
        } else {
          const evicted = record.event_id_order[record.event_id_cursor]
          if (evicted !== undefined) record.recent_event_ids.delete(evicted)
          record.event_id_order[record.event_id_cursor] = event.event_id
          record.event_id_cursor = (
            record.event_id_cursor + 1
          ) % PROVIDER_EVENT_ID_WINDOW_LIMIT
        }
        record.recent_event_ids.add(event.event_id)
        if (event.kind === 'status') {
          record.status = event.status
          terminal = ['stopped', 'failed', 'lost'].includes(event.status)
          if (terminal) {
            void this.#unregisterSession(sessionId, record)
          }
        }
        yield event
        if (terminal) return
      }
    } finally {
      void stream.close().then((closed) => {
        if (closed) {
          if (record.event_stream === stream) record.event_stream = null
        } else {
          void this.#unregisterSession(sessionId, record)
        }
      }).catch(() => undefined)
    }
  }

  events(session_id: string): AsyncIterable<ProviderEventV1> {
    const sessionId = safeOpaqueIdentifier(session_id, 'invalid_provider_session')
    const record = this.#requireSessionCapability(sessionId, 'structured_events')
    let closed = false
    let resolveConsumerRetirement: (() => void) | undefined
    const consumerRetirement = new Promise<void>((resolve) => {
      resolveConsumerRetirement = resolve
    })
    const generator = this.#eventsForRecord(sessionId, record, consumerRetirement)
      [Symbol.asyncIterator]()
    const iterator: AsyncIterableIterator<ProviderEventV1> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () => closed
        ? Promise.resolve({ done: true, value: undefined })
        : generator.next(),
      return: () => {
        if (!closed) {
          closed = true
          resolveConsumerRetirement?.()
          void generator.return?.(undefined).catch(() => undefined)
        }
        return Promise.resolve({ done: true, value: undefined })
      },
    }
    return iterator
  }

  async usage(session_id: string): Promise<ProviderUsageV1> {
    const sessionId = safeOpaqueIdentifier(session_id, 'invalid_provider_session')
    const record = this.#requireSessionCapability(sessionId, 'usage')
    return defineProviderUsageV1(
      await this.#invoke('usage', () => Reflect.apply(
        this.#implementation.usage,
        this.#implementation.receiver,
        [record.adapter_session_id],
      )) as ProviderUsageV1,
      record.authorization,
    )
  }
}

export function defineProviderExecutionAdapterV1(
  implementation: ProviderExecutionAdapterImplementationV1,
): ProviderExecutionAdapterV1 {
  return new ValidatedProviderExecutionAdapter(VALIDATED_ADAPTER_TOKEN, implementation)
}

export function isValidatedProviderExecutionAdapterV1(
  value: unknown,
): value is ProviderExecutionAdapterV1 {
  return Boolean(value && typeof value === 'object' && validatedProviderAdapters.has(value))
}

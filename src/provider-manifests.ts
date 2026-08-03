import {
  PROVIDER_CAPABILITY_IDS,
  PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1,
  defineProviderManifestV1,
  type ProviderCapabilitiesV1,
  type ProviderCapabilityId,
  type ProviderCapabilitySupportV1,
} from './provider-contract.js'

const supported = (): ProviderCapabilitySupportV1 => ({ state: 'supported' })
const unsupported = (reason_code: string): ProviderCapabilitySupportV1 => ({
  state: 'unsupported',
  reason_code,
})
const unknown = (reason_code: string): ProviderCapabilitySupportV1 => ({
  state: 'unknown',
  reason_code,
})

const capabilityMatrix = (
  values: Partial<Record<ProviderCapabilityId, ProviderCapabilitySupportV1>>,
  defaultReason: string,
): ProviderCapabilitiesV1 =>
  Object.fromEntries(PROVIDER_CAPABILITY_IDS.map((id) => [
    id,
    values[id] ?? unknown(defaultReason),
  ])) as ProviderCapabilitiesV1

const CLAUDE_API_ENVIRONMENT_VARIABLES = new Set([
  'ANTHROPIC_API_KEY',
])

const CODEX_API_ENVIRONMENT_VARIABLES = new Set([
  ['OPENAI_API_KEY', 'credential'],
  ['OPENAI_BASE_URL', 'endpoint'],
  ['OPENAI_ORGANIZATION', 'provider_selector'],
  ['OPENAI_ORG_ID', 'provider_selector'],
  ['OPENAI_PROJECT', 'provider_selector'],
  ['CODEX_API_KEY', 'credential'],
].map(([variable]) => variable))

const CLAUDE_NATIVE_CAPABILITIES = capabilityMatrix({
  launch: supported(),
  follow_up: supported(),
  attach: unsupported('authorized_attach_not_implemented_v1'),
  resume: unsupported('durable_resume_not_implemented_v1'),
  restart_recovery: unsupported('durable_resume_not_implemented_v1'),
  fork: supported(),
  interrupt: supported(),
  cancel: supported(),
  stop: supported(),
  model_discovery: supported(),
  model_selection: supported(),
  effort: supported(),
  approvals: supported(),
  access_profile: supported(),
  structured_events: supported(),
  usage: supported(),
  rate_limits: supported(),
  hooks: supported(),
  raw_terminal_coexistence: supported(),
  token_budget: unknown('token_budget_not_verified'),
  cost_budget: unknown('cost_budget_not_verified'),
}, 'claude_capability_not_verified')

const CODEX_NATIVE_CAPABILITIES = capabilityMatrix({
  launch: supported(),
  follow_up: supported(),
  attach: unsupported('authorized_attach_not_implemented_v1'),
  resume: supported(),
  restart_recovery: supported(),
  fork: supported(),
  interrupt: supported(),
  cancel: supported(),
  stop: supported(),
  model_discovery: supported(),
  model_selection: supported(),
  effort: supported(),
  approvals: supported(),
  access_profile: supported(),
  structured_events: supported(),
  usage: supported(),
  rate_limits: supported(),
  raw_terminal_coexistence: supported(),
  token_budget: unknown('token_budget_not_verified'),
  cost_budget: unknown('cost_budget_not_verified'),
  hooks: unknown('hook_projection_not_verified'),
}, 'codex_capability_not_verified')

const QWEN_UNMANAGED_CAPABILITIES = capabilityMatrix({
  attach: unsupported('authorized_attach_not_implemented_v1'),
  resume: unsupported('durable_resume_not_implemented_v1'),
  restart_recovery: unsupported('durable_resume_not_implemented_v1'),
  raw_terminal_coexistence: supported(),
}, 'managed_adapter_not_implemented')

const KIMI_UNMANAGED_CAPABILITIES = capabilityMatrix({
  attach: unsupported('authorized_attach_not_implemented_v1'),
  resume: unsupported('durable_resume_not_implemented_v1'),
  restart_recovery: unsupported('durable_resume_not_implemented_v1'),
  raw_terminal_coexistence: supported(),
  token_budget: unsupported('provider_does_not_expose_token_budget'),
  cost_budget: unsupported('provider_does_not_expose_cost_budget'),
}, 'managed_adapter_not_implemented')

const UNMIGRATED_API_CAPABILITIES = capabilityMatrix({
  attach: unsupported('authorized_attach_not_implemented_v1'),
  resume: unsupported('durable_resume_not_implemented_v1'),
  restart_recovery: unsupported('durable_resume_not_implemented_v1'),
  raw_terminal_coexistence: supported(),
}, 'api_mode_not_migrated_to_contract')

export const CLAUDE_PROVIDER_MANIFEST_V1 = defineProviderManifestV1({
  contract_version: 1,
  provider_id: 'claude',
  display_name: 'Claude Code',
  adapter_id: 'claude-agent-sdk',
  adapter_version: '1.0.0',
  release_state: 'unsupported',
  protocol: 'sdk',
  executable: {
    command: 'claude',
    source: 'sdk_bundled',
    validated_versions: ['2.1.212'],
    supported_platforms: ['darwin-arm64'],
  },
  environment: {
    audit_state: 'complete',
    conflict_rules: PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1.map(([variable, category]) => ({
      variable,
      category,
      allowed_mode_ids: CLAUDE_API_ENVIRONMENT_VARIABLES.has(variable)
        ? ['native_api_key']
        : [],
      allowed_credential_kinds: CLAUDE_API_ENVIRONMENT_VARIABLES.has(variable)
        ? ['usage_priced_api_key']
        : [],
    })),
  },
  modes: [
    {
      id: 'native_subscription',
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      credential_kinds: ['provider_account_session'],
      default_credential_kind: 'provider_account_session',
      priority: 'primary',
      support: {
        state: 'policy_blocked',
        reason_code: 'third_party_subscription_routing_prohibited',
      },
      automation_policy: 'blocked',
      usage_priced_api_consent_required: false,
      overage: {
        behavior: 'none',
        explicit_consent_required: false,
      },
      capabilities: CLAUDE_NATIVE_CAPABILITIES,
    },
    {
      id: 'native_api_key',
      runtime_mode: 'native_cli',
      billing_mode: 'usage_priced_api',
      credential_kinds: ['usage_priced_api_key'],
      default_credential_kind: 'usage_priced_api_key',
      priority: 'secondary',
      support: {
        state: 'unknown',
        reason_code: 'api_mode_not_migrated_to_contract',
      },
      automation_policy: 'allowed',
      usage_priced_api_consent_required: true,
      overage: {
        behavior: 'none',
        explicit_consent_required: false,
      },
      capabilities: UNMIGRATED_API_CAPABILITIES,
    },
  ],
})

export const CODEX_PROVIDER_MANIFEST_V1 = defineProviderManifestV1({
  contract_version: 1,
  provider_id: 'codex',
  display_name: 'Codex CLI',
  adapter_id: 'codex-app-server',
  adapter_version: '1.0.0',
  release_state: 'candidate',
  protocol: 'app_server',
  executable: {
    command: 'codex',
    source: 'path',
    command_override_env: 'ORCHESTRA_CODEX_COMMAND',
    validated_versions: ['0.146.0'],
    supported_platforms: ['darwin-arm64'],
  },
  environment: {
    audit_state: 'complete',
    conflict_rules: PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1.map(([variable, category]) => ({
      variable,
      category,
      allowed_mode_ids: CODEX_API_ENVIRONMENT_VARIABLES.has(variable)
        ? ['native_api_key']
        : [],
      allowed_credential_kinds: CODEX_API_ENVIRONMENT_VARIABLES.has(variable)
        ? ['usage_priced_api_key']
        : [],
    })),
  },
  modes: [
    {
      id: 'native_subscription',
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      credential_kinds: ['provider_account_session'],
      default_credential_kind: 'provider_account_session',
      priority: 'primary',
      support: {
        state: 'unknown',
        reason_code: 'subscription_guard_not_integrated',
      },
      automation_policy: 'allowed',
      usage_priced_api_consent_required: false,
      overage: {
        behavior: 'none',
        explicit_consent_required: false,
      },
      capabilities: CODEX_NATIVE_CAPABILITIES,
    },
    {
      id: 'native_api_key',
      runtime_mode: 'native_cli',
      billing_mode: 'usage_priced_api',
      credential_kinds: ['usage_priced_api_key'],
      default_credential_kind: 'usage_priced_api_key',
      priority: 'secondary',
      support: {
        state: 'unknown',
        reason_code: 'api_mode_not_migrated_to_contract',
      },
      automation_policy: 'allowed',
      usage_priced_api_consent_required: true,
      overage: {
        behavior: 'none',
        explicit_consent_required: false,
      },
      capabilities: UNMIGRATED_API_CAPABILITIES,
    },
  ],
})

export const QWEN_PROVIDER_MANIFEST_V1 = defineProviderManifestV1({
  contract_version: 1,
  provider_id: 'qwen',
  display_name: 'Qwen Code',
  adapter_id: 'qwen-code-cli',
  adapter_version: '1.0.0',
  release_state: 'unsupported',
  protocol: 'native_cli',
  executable: {
    command: 'qwen',
    source: 'path',
    validated_versions: [],
    supported_platforms: [],
  },
  environment: {
    audit_state: 'incomplete',
    conflict_rules: [],
  },
  modes: [
    {
      id: 'native_subscription',
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      credential_kinds: ['subscription_scoped_key'],
      default_credential_kind: 'subscription_scoped_key',
      priority: 'primary',
      support: {
        state: 'unknown',
        reason_code: 'managed_adapter_not_implemented',
      },
      automation_policy: 'interactive_only',
      usage_priced_api_consent_required: false,
      overage: {
        behavior: 'none',
        explicit_consent_required: false,
      },
      capabilities: QWEN_UNMANAGED_CAPABILITIES,
    },
    {
      id: 'native_api_key',
      runtime_mode: 'native_cli',
      billing_mode: 'usage_priced_api',
      credential_kinds: ['usage_priced_api_key'],
      default_credential_kind: 'usage_priced_api_key',
      priority: 'secondary',
      support: {
        state: 'unknown',
        reason_code: 'managed_adapter_not_implemented',
      },
      automation_policy: 'allowed',
      usage_priced_api_consent_required: true,
      overage: {
        behavior: 'none',
        explicit_consent_required: false,
      },
      capabilities: UNMIGRATED_API_CAPABILITIES,
    },
  ],
})

export const KIMI_PROVIDER_MANIFEST_V1 = defineProviderManifestV1({
  contract_version: 1,
  provider_id: 'kimi',
  display_name: 'Kimi Code',
  adapter_id: 'kimi-code-acp',
  adapter_version: '1.0.0',
  release_state: 'unsupported',
  protocol: 'acp',
  executable: {
    command: 'kimi',
    source: 'path',
    validated_versions: [],
    supported_platforms: [],
  },
  environment: {
    audit_state: 'incomplete',
    conflict_rules: [],
  },
  modes: [
    {
      id: 'native_subscription',
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      credential_kinds: ['provider_account_session'],
      default_credential_kind: 'provider_account_session',
      priority: 'primary',
      support: {
        state: 'unknown',
        reason_code: 'managed_adapter_not_implemented',
      },
      automation_policy: 'allowed',
      usage_priced_api_consent_required: false,
      overage: {
        behavior: 'optional_metered',
        explicit_consent_required: true,
      },
      capabilities: KIMI_UNMANAGED_CAPABILITIES,
    },
    {
      id: 'native_api_key',
      runtime_mode: 'native_cli',
      billing_mode: 'usage_priced_api',
      credential_kinds: ['usage_priced_api_key'],
      default_credential_kind: 'usage_priced_api_key',
      priority: 'secondary',
      support: {
        state: 'unknown',
        reason_code: 'managed_adapter_not_implemented',
      },
      automation_policy: 'allowed',
      usage_priced_api_consent_required: true,
      overage: {
        behavior: 'none',
        explicit_consent_required: false,
      },
      capabilities: UNMIGRATED_API_CAPABILITIES,
    },
  ],
})

export const FIRST_RELEASE_PROVIDER_MANIFESTS_V1 = Object.freeze([
  CLAUDE_PROVIDER_MANIFEST_V1,
  CODEX_PROVIDER_MANIFEST_V1,
  QWEN_PROVIDER_MANIFEST_V1,
  KIMI_PROVIDER_MANIFEST_V1,
])

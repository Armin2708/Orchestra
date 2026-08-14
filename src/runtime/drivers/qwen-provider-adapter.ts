import { QWEN_PROVIDER_MANIFEST_V1 } from '../../provider-manifests.js'
import { defineProviderReadinessV1 } from '../../provider-contract.js'
import type {
  ProviderCapabilityId,
  ProviderExecutionAdapterV1,
  ProviderExecutionIntentV1,
  ProviderExecutionScope,
  ProviderExecutionSelectionRequestV1,
  ProviderLaunchBoundaryV1,
  ProviderModelV1,
  ProviderReadinessV1,
} from '../../provider-contract.js'
import type { AgentDriver, MaybePromise } from '../types.js'
import { defineAgentDriverProviderAdapterV1 } from './provider-adapter.js'
import {
  defineTerminalProviderCandidateEvidenceV1,
  discoverTerminalProviderExecutableV1,
} from './terminal-provider-discovery.js'
import type {
  TerminalProviderCandidateEvidenceV1,
  TerminalProviderDiscoveryDependenciesV1,
} from './terminal-provider-discovery.js'

export type QwenProviderExecutableOptionsV1 =
  TerminalProviderDiscoveryDependenciesV1 & {
    command?: string
    environment?: NodeJS.ProcessEnv
    platform?: string
  }

export type QwenProviderCandidateInspectionOptionsV1 =
  QwenProviderExecutableOptionsV1 & {
    execution_scope?: ProviderExecutionScope
    selection_request?: ProviderExecutionSelectionRequestV1
    required_capabilities?: readonly ProviderCapabilityId[]
  }

export type QwenProviderAdapterOptionsV1 =
  QwenProviderExecutableOptionsV1 & {
    driver: AgentDriver
    now?: () => Date
    probeVersion?: () => MaybePromise<string | null>
  }

export const QWEN_CODING_PLAN_POLICY_EVIDENCE_V1 = Object.freeze({
  billing_mode: 'personal_subscription',
  credential_kind: 'subscription_scoped_key',
  permitted_execution_scopes: Object.freeze([
    'interactive',
    'managed_foreground',
    'managed_background',
  ] as const),
  prohibited_execution_scopes: Object.freeze([] as readonly ProviderExecutionScope[]),
  reason_code: 'owner_authorized_personal_coding_plan_automation',
  provider_confirmation_required_for_managed_use: false,
  support_claim: false,
})

export type QwenProviderModelEntryV1 = Readonly<{
  id: string
  displayName: string
  description: string
  isDefault: boolean
}>

// Coding-plan models published by the local ModelStudio Coding Plan
// (Global/Intl) provider configuration. ids must match the CLI `-m` value
// exactly; the default is Orchestra's managed-launch default, since the CLI's
// own configured default may point at a usage-priced API credential.
export const QWEN_PROVIDER_MODEL_CATALOG_V1: readonly QwenProviderModelEntryV1[] =
  Object.freeze([
    {
      id: 'qwen3-coder-plus',
      displayName: 'Qwen3 Coder Plus',
      description: 'Qwen coding model, 1M context (Coding Plan)',
      isDefault: true,
    },
    {
      id: 'qwen3-coder-next',
      displayName: 'Qwen3 Coder Next',
      description: 'Qwen coding model, 262k context (Coding Plan)',
      isDefault: false,
    },
    {
      id: 'qwen3.7-plus',
      displayName: 'Qwen3.7 Plus',
      description: 'Qwen flagship, 1M context (Coding Plan)',
      isDefault: false,
    },
    {
      id: 'qwen3.6-plus',
      displayName: 'Qwen3.6 Plus',
      description: 'Qwen flagship, Pro subscribers (Coding Plan)',
      isDefault: false,
    },
    {
      id: 'qwen3.5-plus',
      displayName: 'Qwen3.5 Plus',
      description: 'Qwen flagship, 1M context (Coding Plan)',
      isDefault: false,
    },
    {
      id: 'qwen3-max-2026-01-23',
      displayName: 'Qwen3 Max (2026-01-23)',
      description: 'Qwen max snapshot, 262k context (Coding Plan)',
      isDefault: false,
    },
    {
      id: 'glm-5',
      displayName: 'GLM-5',
      description: 'GLM-5 via ModelStudio (Coding Plan)',
      isDefault: false,
    },
    {
      id: 'glm-4.7',
      displayName: 'GLM-4.7',
      description: 'GLM-4.7 via ModelStudio (Coding Plan)',
      isDefault: false,
    },
    {
      id: 'kimi-k2.5',
      displayName: 'Kimi K2.5',
      description: 'Kimi K2.5 via ModelStudio (Coding Plan)',
      isDefault: false,
    },
    {
      id: 'MiniMax-M2.5',
      displayName: 'MiniMax M2.5',
      description: 'MiniMax M2.5 via ModelStudio (Coding Plan)',
      isDefault: false,
    },
  ])

const CONTRACT_SAFE_MODEL_ID = /^[a-z0-9][a-z0-9_.-]{0,127}$/

export function discoverQwenProviderExecutableV1(
  options: QwenProviderExecutableOptionsV1 = {},
) {
  return discoverTerminalProviderExecutableV1({
    manifest: QWEN_PROVIDER_MANIFEST_V1,
    ...options,
  })
}

export function inspectQwenProviderCandidateV1(
  options: QwenProviderCandidateInspectionOptionsV1 = {},
): Readonly<TerminalProviderCandidateEvidenceV1> {
  return defineTerminalProviderCandidateEvidenceV1({
    manifest: QWEN_PROVIDER_MANIFEST_V1,
    discovery: discoverQwenProviderExecutableV1(options),
    execution_scope: options.execution_scope ?? 'managed_background',
    selection_request: options.selection_request,
    required_capabilities: options.required_capabilities ?? ['launch'],
  })
}

export async function probeQwenProviderReadinessV1(
  intent: Readonly<ProviderExecutionIntentV1>,
  boundary: ProviderLaunchBoundaryV1,
  observedAt: string,
  versionProbe?: MaybePromise<string | null>,
): Promise<Readonly<ProviderReadinessV1>> {
  const mode = QWEN_PROVIDER_MANIFEST_V1.modes.find((candidate) =>
    candidate.id === intent.selection.mode_id)
  if (!mode) throw new Error('Qwen provider mode is unavailable')
  const probedVersion = (await versionProbe ?? null)?.trim() || null
  const expectedVersions = QWEN_PROVIDER_MANIFEST_V1.executable.validated_versions
  const expectedPlatforms = QWEN_PROVIDER_MANIFEST_V1.executable.supported_platforms
  const versionValidated = probedVersion !== null
    && expectedVersions.includes(probedVersion)
  const platformValidated = expectedPlatforms.length === 0
    || expectedPlatforms.includes(resolveQwenProbePlatform())
  const executableStatus = boundary.evidence.executable_status === 'validated'
    && versionValidated
    && platformValidated
    ? 'validated'
    : boundary.evidence.executable_status
  const authenticationObserved = Boolean(probedVersion)
  return defineProviderReadinessV1({
    contract_version: 1,
    observed_at: observedAt,
    selection: intent.selection,
    executable_status: executableStatus,
    auth_status: authenticationObserved ? 'ready' : 'unknown',
    automation_policy: mode.automation_policy,
    overage_status: 'not_applicable',
    overage_consent: 'not_required',
    metering_status: 'not_required',
    cost_cap_status: 'not_required',
    executable_fingerprint: boundary.evidence.executable_fingerprint,
    environment_fingerprint: boundary.evidence.environment_fingerprint,
    configuration_fingerprint: boundary.evidence.configuration_fingerprint,
  })
}

function resolveQwenProbePlatform(): string {
  return `${process.platform}-${process.arch}`
}

export function createQwenProviderAdapterV1(
  options: QwenProviderAdapterOptionsV1,
): ProviderExecutionAdapterV1 {
  const now = options.now ?? (() => new Date())
  return defineAgentDriverProviderAdapterV1({
    manifest: QWEN_PROVIDER_MANIFEST_V1,
    driver: options.driver,
    discoverExecutable() {
      return discoverQwenProviderExecutableV1(options)
    },
    async probeReadiness(intent, boundary) {
      return probeQwenProviderReadinessV1(
        intent,
        boundary,
        now().toISOString(),
        options.probeVersion ? options.probeVersion() : undefined,
      )
    },
    async listModels(): Promise<ProviderModelV1[]> {
      return QWEN_PROVIDER_MODEL_CATALOG_V1
        .filter((model) => CONTRACT_SAFE_MODEL_ID.test(model.id))
        .map((model) => ({
          id: model.id,
          display_name: model.displayName,
          is_default: model.isDefault,
          supports_effort: false,
          effort_levels: [],
        }))
    },
    async launchRequest(context) {
      if (context.action.kind !== 'launch') {
        throw new Error('Qwen managed launch action is required')
      }
      return {
        workspaceId: context.action.scope_id,
        cwd: context.action.cwd,
      }
    },
    async resume(context) {
      if (context.action.kind !== 'resume' || !options.driver.recover) {
        throw new Error('Qwen managed resume is unavailable')
      }
      const recovered = await options.driver.recover({
        externalId: context.action.provider_session_id,
        workspaceId: context.action.scope_id,
        cwd: context.action.cwd,
        model: context.action.model ?? undefined,
        effort: context.action.effort ?? undefined,
        accessProfile: context.action.access_profile,
        maxBudgetUsd: context.action.cost_limit === null
          ? undefined
          : context.action.cost_limit.max_cost_minor_units / 100,
      })
      if (!recovered) throw new Error('Qwen managed session could not be resumed')
      return recovered
    },
    async sessionEvidence(context, session) {
      const effectiveModel = typeof session.metadata.effectiveModel === 'string'
        ? session.metadata.effectiveModel.trim()
        : context.action.kind === 'launch'
          || context.action.kind === 'resume'
          || context.action.kind === 'fork'
          ? context.action.model?.trim() ?? ''
          : ''
      if (!effectiveModel) throw new Error('Qwen CLI did not report an effective model')
      // Non-interactive qwen runs in auto permission mode: tool access is
      // unrestricted, so full_access is the honest effective profile.
      return {
        effective_model: effectiveModel,
        effective_effort: null,
        effective_access_profile: 'full_access',
      }
    },
  })
}

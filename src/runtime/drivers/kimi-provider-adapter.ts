import { KIMI_PROVIDER_MANIFEST_V1 } from '../../provider-manifests.js'
import { defineProviderReadinessV1 } from '../../provider-contract.js'
import type {
  ProviderCapabilityId,
  ProviderExecutionAdapterV1,
  ProviderExecutionIntentV1,
  ProviderExecutionScope,
  ProviderExecutionSelectionRequestV1,
  ProviderLaunchBoundaryV1,
  ProviderReadinessV1,
} from '../../provider-contract.js'
import type { AgentDriver, MaybePromise } from '../types.js'
import type { KimiAcpDriverPortV1 } from './kimi-acp-driver.js'
import { defineAgentDriverProviderAdapterV1 } from './provider-adapter.js'
import {
  defineTerminalProviderCandidateEvidenceV1,
  discoverTerminalProviderExecutableV1,
} from './terminal-provider-discovery.js'
import type {
  TerminalProviderCandidateEvidenceV1,
  TerminalProviderDiscoveryDependenciesV1,
} from './terminal-provider-discovery.js'

export type KimiProviderExecutableOptionsV1 =
  TerminalProviderDiscoveryDependenciesV1 & {
    command?: string
    environment?: NodeJS.ProcessEnv
    platform?: string
  }

export type KimiProviderCandidateInspectionOptionsV1 =
  KimiProviderExecutableOptionsV1 & {
    execution_scope?: ProviderExecutionScope
    selection_request?: ProviderExecutionSelectionRequestV1
    required_capabilities?: readonly ProviderCapabilityId[]
  }

export type KimiProviderAdapterOptionsV1 =
  KimiProviderExecutableOptionsV1 & {
    driver: AgentDriver
    now?: () => Date
    observeReadiness?(
      intent: Readonly<ProviderExecutionIntentV1>,
      boundary: ProviderLaunchBoundaryV1,
    ): MaybePromise<KimiProviderReadinessObservationV1>
  }

export type KimiProviderReadinessObservationV1 = Readonly<{
  observed_at: string
  evidence_source: 'kimi_cli_usage' | 'kimi_console'
  billing_mode: 'personal_subscription'
  credential_kind: 'provider_account_session'
  auth_status: ProviderReadinessV1['auth_status']
  overage_status: ProviderReadinessV1['overage_status']
  metering_status: ProviderReadinessV1['metering_status']
  cost_cap_status: ProviderReadinessV1['cost_cap_status']
  executable_fingerprint: string
  environment_fingerprint: string
  configuration_fingerprint: string
}>

export const KIMI_ACP_IMPLEMENTATION_EVIDENCE_V1 = Object.freeze({
  protocol: 'acp-0.23',
  command: Object.freeze(['kimi', 'acp']),
  implemented: Object.freeze([
    'launch',
    'follow_up',
    'resume',
    'restart_recovery',
    'interrupt',
    'cancel',
    'stop',
    'model_selection',
    'effort',
    'approvals',
    'structured_events',
  ] as const),
  unavailable: Object.freeze({
    attach: 'raw_provider_session_id_is_not_authority',
    fork: 'kimi_acp_fork_not_documented_stable',
    model_discovery: 'kimi_acp_models_require_a_session',
    access_profile: 'native_mapping_requires_exact_version_acceptance',
    usage: 'kimi_acp_does_not_expose_subscription_or_extra_usage_state',
    token_budget: 'provider_does_not_expose_token_budget',
    cost_budget: 'provider_does_not_expose_cost_budget',
  }),
  support_claim: false,
})

export function discoverKimiProviderExecutableV1(
  options: KimiProviderExecutableOptionsV1 = {},
) {
  return discoverTerminalProviderExecutableV1({
    manifest: KIMI_PROVIDER_MANIFEST_V1,
    ...options,
  })
}

export function inspectKimiProviderCandidateV1(
  options: KimiProviderCandidateInspectionOptionsV1 = {},
): Readonly<TerminalProviderCandidateEvidenceV1> {
  return defineTerminalProviderCandidateEvidenceV1({
    manifest: KIMI_PROVIDER_MANIFEST_V1,
    discovery: discoverKimiProviderExecutableV1(options),
    execution_scope: options.execution_scope ?? 'managed_background',
    selection_request: options.selection_request,
    required_capabilities: options.required_capabilities ?? ['launch'],
  })
}

export async function defineKimiProviderCandidateReadinessV1(
  intent: Readonly<ProviderExecutionIntentV1>,
  boundary: ProviderLaunchBoundaryV1,
  observedAt: string,
  observe?: KimiProviderAdapterOptionsV1['observeReadiness'],
): Promise<Readonly<ProviderReadinessV1>> {
  const mode = KIMI_PROVIDER_MANIFEST_V1.modes.find((candidate) =>
    candidate.id === intent.selection.mode_id)
  if (!mode) throw new Error('Kimi provider mode is unavailable')
  const nativeSubscription = intent.selection.mode_id === 'native_subscription'
  const observation = nativeSubscription && observe
    ? await observe(intent, boundary)
    : null
  if (observation) {
    if (!Number.isFinite(Date.parse(observation.observed_at))
      || !['kimi_cli_usage', 'kimi_console'].includes(observation.evidence_source)
      || observation.billing_mode !== intent.selection.billing_mode
      || observation.credential_kind !== intent.selection.credential_kind
      || observation.executable_fingerprint
        !== boundary.evidence.executable_fingerprint
      || observation.environment_fingerprint
        !== boundary.evidence.environment_fingerprint
      || observation.configuration_fingerprint
        !== boundary.evidence.configuration_fingerprint) {
      throw new Error('Kimi readiness observation does not match launch boundary')
    }
  }
  const overageStatus = nativeSubscription
    ? observation?.overage_status ?? 'unknown'
    : 'not_applicable'
  const meteredOverage = overageStatus === 'enabled'
    || overageStatus === 'exhausted'
  const overageConsent = nativeSubscription
    ? overageStatus === 'disabled'
      ? 'not_required'
      : meteredOverage && intent.provider_managed_overage.state === 'granted'
        ? 'granted'
        : 'missing'
    : 'not_required'
  return defineProviderReadinessV1({
    contract_version: 1,
    observed_at: observation?.observed_at ?? observedAt,
    selection: intent.selection,
    executable_status: boundary.evidence.executable_status,
    auth_status: observation?.auth_status ?? 'unknown',
    automation_policy: mode.automation_policy,
    overage_status: overageStatus,
    overage_consent: overageConsent,
    metering_status: nativeSubscription && overageStatus === 'disabled'
      ? 'not_required'
      : observation?.metering_status ?? 'unknown',
    cost_cap_status: nativeSubscription && overageStatus === 'disabled'
      ? 'not_required'
      : observation?.cost_cap_status ?? 'unknown',
    executable_fingerprint: boundary.evidence.executable_fingerprint,
    environment_fingerprint: boundary.evidence.environment_fingerprint,
    configuration_fingerprint: boundary.evidence.configuration_fingerprint,
  })
}

export function createKimiProviderAdapterV1(
  options: KimiProviderAdapterOptionsV1,
): ProviderExecutionAdapterV1 {
  const now = options.now ?? (() => new Date())
  return defineAgentDriverProviderAdapterV1({
    manifest: KIMI_PROVIDER_MANIFEST_V1,
    driver: options.driver,
    discoverExecutable() {
      return discoverKimiProviderExecutableV1(options)
    },
    async probeReadiness(intent, boundary) {
      return defineKimiProviderCandidateReadinessV1(
        intent,
        boundary,
        now().toISOString(),
        options.observeReadiness,
      )
    },
    async listModels() {
      throw new Error('Kimi managed model discovery is not verified')
    },
    async launchRequest(context) {
      if (context.action.kind !== 'launch') {
        throw new Error('Kimi managed launch action is required')
      }
      return {
        workspaceId: context.action.scope_id,
        cwd: context.action.cwd,
      }
    },
    async resume(context) {
      if (context.action.kind !== 'resume' || !options.driver.recover) {
        throw new Error('Kimi managed resume is unavailable')
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
      if (!recovered) throw new Error('Kimi managed session could not be resumed')
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
      const effectiveEffort = typeof session.metadata.effectiveEffort === 'string'
        ? session.metadata.effectiveEffort.trim()
        : context.action.kind === 'launch'
          || context.action.kind === 'resume'
          || context.action.kind === 'fork'
          ? context.action.effort
          : null
      const effectiveAccess = session.metadata.effectiveAccessProfile
      if (!effectiveModel) throw new Error('Kimi ACP did not report an effective model')
      if (!['read_only', 'workspace_write', 'full_access'].includes(
        String(effectiveAccess),
      )) {
        throw new Error('Kimi ACP did not report an effective access profile')
      }
      return {
        effective_model: effectiveModel,
        effective_effort: effectiveEffort,
        effective_access_profile: effectiveAccess as
          | 'read_only'
          | 'workspace_write'
          | 'full_access',
      }
    },
    async submitApproval(context, decision) {
      const driver = options.driver as Partial<KimiAcpDriverPortV1>
      if (!driver.resolveApproval) {
        throw new Error('Kimi ACP approval resolution is unavailable')
      }
      await driver.resolveApproval(
        context.driver_session.id,
        decision.approval_id,
        decision.decision,
      )
    },
  })
}

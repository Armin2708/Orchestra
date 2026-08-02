import { QWEN_PROVIDER_MANIFEST_V1 } from '../../provider-manifests.js'
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
import type { AgentDriver } from '../types.js'
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
  }

export const QWEN_CODING_PLAN_POLICY_EVIDENCE_V1 = Object.freeze({
  billing_mode: 'personal_subscription',
  credential_kind: 'subscription_scoped_key',
  permitted_execution_scopes: Object.freeze(['interactive'] as const),
  prohibited_execution_scopes: Object.freeze([
    'managed_foreground',
    'managed_background',
  ] as const),
  reason_code: 'coding_plan_noninteractive_use_prohibited',
  provider_confirmation_required_for_managed_use: true,
  support_claim: false,
})

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

function defineQwenProviderCandidateReadinessV1(
  intent: Readonly<ProviderExecutionIntentV1>,
  boundary: ProviderLaunchBoundaryV1,
  observedAt: string,
): Readonly<ProviderReadinessV1> {
  const mode = QWEN_PROVIDER_MANIFEST_V1.modes.find((candidate) =>
    candidate.id === intent.selection.mode_id)
  if (!mode) throw new Error('Qwen provider mode is unavailable')
  const metered = intent.selection.billing_mode === 'usage_priced_api'
  return defineProviderReadinessV1({
    contract_version: 1,
    observed_at: observedAt,
    selection: intent.selection,
    executable_status: boundary.evidence.executable_status,
    auth_status: 'unknown',
    automation_policy: mode.automation_policy,
    overage_status: 'not_applicable',
    overage_consent: 'not_required',
    metering_status: metered ? 'unknown' : 'not_required',
    cost_cap_status: metered ? 'unknown' : 'not_required',
    executable_fingerprint: boundary.evidence.executable_fingerprint,
    environment_fingerprint: boundary.evidence.environment_fingerprint,
    configuration_fingerprint: boundary.evidence.configuration_fingerprint,
  })
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
    probeReadiness(intent, boundary) {
      return defineQwenProviderCandidateReadinessV1(
        intent,
        boundary,
        now().toISOString(),
      )
    },
    async listModels() {
      throw new Error('Qwen managed model discovery is policy blocked')
    },
    async launchRequest() {
      throw new Error(
        'Qwen Coding Plan managed automation is prohibited without provider permission',
      )
    },
    async sessionEvidence() {
      throw new Error('Qwen managed session evidence is not implemented')
    },
  })
}

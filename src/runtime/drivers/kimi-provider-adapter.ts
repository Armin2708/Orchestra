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
  }

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

function defineKimiProviderCandidateReadinessV1(
  intent: Readonly<ProviderExecutionIntentV1>,
  boundary: ProviderLaunchBoundaryV1,
  observedAt: string,
): Readonly<ProviderReadinessV1> {
  const mode = KIMI_PROVIDER_MANIFEST_V1.modes.find((candidate) =>
    candidate.id === intent.selection.mode_id)
  if (!mode) throw new Error('Kimi provider mode is unavailable')
  const nativeSubscription = intent.selection.mode_id === 'native_subscription'
  return defineProviderReadinessV1({
    contract_version: 1,
    observed_at: observedAt,
    selection: intent.selection,
    executable_status: boundary.evidence.executable_status,
    auth_status: 'unknown',
    automation_policy: mode.automation_policy,
    overage_status: nativeSubscription ? 'unknown' : 'not_applicable',
    overage_consent: nativeSubscription ? 'missing' : 'not_required',
    metering_status: 'unknown',
    cost_cap_status: 'unknown',
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
    probeReadiness(intent, boundary) {
      return defineKimiProviderCandidateReadinessV1(
        intent,
        boundary,
        now().toISOString(),
      )
    },
    async listModels() {
      throw new Error('Kimi managed model discovery is not verified')
    },
    async launchRequest() {
      throw new Error('Kimi managed launch transport is not implemented')
    },
    async sessionEvidence() {
      throw new Error('Kimi managed session evidence is not implemented')
    },
  })
}

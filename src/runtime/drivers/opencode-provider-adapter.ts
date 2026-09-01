import { OPENCODE_PROVIDER_MANIFEST_V1 } from '../../provider-manifests.js'
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
import type { OpenCodeAgentDriver } from './opencode.js'

export type OpenCodeProviderExecutableOptionsV1 =
  TerminalProviderDiscoveryDependenciesV1 & {
    command?: string
    environment?: NodeJS.ProcessEnv
    platform?: string
  }

export type OpenCodeProviderCandidateInspectionOptionsV1 =
  OpenCodeProviderExecutableOptionsV1 & {
    execution_scope?: ProviderExecutionScope
    selection_request?: ProviderExecutionSelectionRequestV1
    required_capabilities?: readonly ProviderCapabilityId[]
  }

export type OpenCodeProviderAdapterOptionsV1 =
  OpenCodeProviderExecutableOptionsV1 & {
    driver: OpenCodeAgentDriver
    now?: () => Date
    probeVersion?: () => MaybePromise<string | null>
    /**
     * Live model catalog reader. Unlike Qwen's hardcoded list, OpenCode
     * brokers whichever upstream providers the user has configured, so this
     * queries the running server (`client.config.providers()`) instead of a
     * static array that would go stale immediately. Injectable for tests.
     */
    listModels?: () => MaybePromise<readonly OpenCodeProviderModelEntryV1[]>
  }

export type OpenCodeProviderModelEntryV1 = Readonly<{
  id: string
  displayName: string
  description: string
  isDefault: boolean
}>

const CONTRACT_SAFE_MODEL_ID = /^[a-z0-9][a-z0-9_.\/-]{0,127}$/i

export function discoverOpenCodeProviderExecutableV1(
  options: OpenCodeProviderExecutableOptionsV1 = {},
) {
  return discoverTerminalProviderExecutableV1({
    manifest: OPENCODE_PROVIDER_MANIFEST_V1,
    ...options,
  })
}

export function inspectOpenCodeProviderCandidateV1(
  options: OpenCodeProviderCandidateInspectionOptionsV1 = {},
): Readonly<TerminalProviderCandidateEvidenceV1> {
  return defineTerminalProviderCandidateEvidenceV1({
    manifest: OPENCODE_PROVIDER_MANIFEST_V1,
    discovery: discoverOpenCodeProviderExecutableV1(options),
    execution_scope: options.execution_scope ?? 'managed_background',
    selection_request: options.selection_request,
    required_capabilities: options.required_capabilities ?? ['launch'],
  })
}

export async function probeOpenCodeProviderReadinessV1(
  intent: Readonly<ProviderExecutionIntentV1>,
  boundary: ProviderLaunchBoundaryV1,
  observedAt: string,
  versionProbe?: MaybePromise<string | null>,
): Promise<Readonly<ProviderReadinessV1>> {
  const mode = OPENCODE_PROVIDER_MANIFEST_V1.modes.find((candidate) =>
    candidate.id === intent.selection.mode_id)
  if (!mode) throw new Error('OpenCode provider mode is unavailable')
  const probedVersion = (await versionProbe ?? null)?.trim() || null
  const expectedVersions = OPENCODE_PROVIDER_MANIFEST_V1.executable.validated_versions
  const expectedPlatforms = OPENCODE_PROVIDER_MANIFEST_V1.executable.supported_platforms
  const versionValidated = probedVersion !== null && expectedVersions.includes(probedVersion)
  const platformValidated = expectedPlatforms.length === 0
    || expectedPlatforms.includes(resolveOpenCodeProbePlatform())
  const executableStatus = boundary.evidence.executable_status === 'validated'
    && versionValidated
    && platformValidated
    ? 'validated'
    : boundary.evidence.executable_status
  // Executable resolving and reporting a version is necessary but not
  // sufficient here: unlike Qwen/Codex (single vendor, single credential),
  // OpenCode's actual auth readiness depends on whichever upstream
  // provider(s) are configured, which this pass does not verify (see manifest
  // comment on `billing_mode: 'unknown'`). `unknown` is the honest state.
  return defineProviderReadinessV1({
    contract_version: 1,
    observed_at: observedAt,
    selection: intent.selection,
    executable_status: executableStatus,
    auth_status: 'unknown',
    automation_policy: mode.automation_policy,
    overage_status: 'unknown',
    overage_consent: 'missing',
    metering_status: 'unknown',
    cost_cap_status: 'unknown',
    executable_fingerprint: boundary.evidence.executable_fingerprint,
    environment_fingerprint: boundary.evidence.environment_fingerprint,
    configuration_fingerprint: boundary.evidence.configuration_fingerprint,
  })
}

function resolveOpenCodeProbePlatform(): string {
  return `${process.platform}-${process.arch}`
}

export function createOpenCodeProviderAdapterV1(
  options: OpenCodeProviderAdapterOptionsV1,
): ProviderExecutionAdapterV1 {
  const now = options.now ?? (() => new Date())
  return defineAgentDriverProviderAdapterV1({
    manifest: OPENCODE_PROVIDER_MANIFEST_V1,
    driver: options.driver,
    discoverExecutable() {
      return discoverOpenCodeProviderExecutableV1(options)
    },
    async probeReadiness(intent, boundary) {
      return probeOpenCodeProviderReadinessV1(
        intent,
        boundary,
        now().toISOString(),
        options.probeVersion ? options.probeVersion() : undefined,
      )
    },
    async listModels(): Promise<ProviderModelV1[]> {
      const entries = options.listModels
        ? await options.listModels()
        : await listOpenCodeModelsFromServer(options.driver)
      return entries
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
        throw new Error('OpenCode managed launch action is required')
      }
      return {
        workspaceId: context.action.scope_id,
        cwd: context.action.cwd,
      }
    },
    async resume(context) {
      if (context.action.kind !== 'resume' || !options.driver.recover) {
        throw new Error('OpenCode managed resume is unavailable')
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
      if (!recovered) throw new Error('OpenCode managed session could not be resumed')
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
      if (!effectiveModel) throw new Error('OpenCode did not report an effective model')
      // No approval-response path is wired this pass (see manifest:
      // `approvals: unsupported`), so full_access is the only honest claim —
      // same reasoning Qwen's adapter uses for its non-interactive auto mode.
      return {
        effective_model: effectiveModel,
        effective_effort: null,
        effective_access_profile: 'full_access',
      }
    },
  })
}

/**
 * Queries the shared `opencode serve` process for its configured upstream
 * providers/models. Falls back to an empty catalog (never a guessed default)
 * if the server isn't reachable yet — model discovery degrades gracefully,
 * it does not block launch.
 */
async function listOpenCodeModelsFromServer(
  driver: OpenCodeAgentDriver,
): Promise<readonly OpenCodeProviderModelEntryV1[]> {
  const client = driver.currentClient?.()
  if (!client) return []
  try {
    const result = await client.config.providers()
    if (!result.data) return []
    const providers = (result.data as { providers?: unknown }).providers
    if (!Array.isArray(providers)) return []
    const entries: OpenCodeProviderModelEntryV1[] = []
    for (const provider of providers) {
      if (!provider || typeof provider !== 'object') continue
      const providerId = (provider as { id?: unknown }).id
      const models = (provider as { models?: unknown }).models
      if (typeof providerId !== 'string' || !models || typeof models !== 'object') continue
      for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
        const name = model && typeof model === 'object' && typeof (model as { name?: unknown }).name === 'string'
          ? (model as { name: string }).name
          : modelId
        entries.push({
          id: `${providerId}/${modelId}`,
          displayName: name,
          description: `${name} via OpenCode (${providerId})`,
          isDefault: false,
        })
      }
    }
    return entries
  } catch {
    return []
  }
}

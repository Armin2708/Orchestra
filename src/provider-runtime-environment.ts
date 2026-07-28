import {
  defineProviderExecutionIntentV1,
  defineProviderNoCostConsentV1,
  prepareProviderEnvironmentV1,
  selectProviderExecutionV1,
  type PreparedProviderEnvironmentV1,
  type ProviderExecutionScope,
  type ProviderManifestV1,
} from './provider-contract.js'
import {
  CLAUDE_PROVIDER_MANIFEST_V1,
  CODEX_PROVIDER_MANIFEST_V1,
} from './provider-manifests.js'

const MANAGED_SUBSCRIPTION_MANIFESTS_V1 = Object.freeze({
  claude: CLAUDE_PROVIDER_MANIFEST_V1,
  codex: CODEX_PROVIDER_MANIFEST_V1,
})

export type ManagedSubscriptionProviderIdV1 =
  keyof typeof MANAGED_SUBSCRIPTION_MANIFESTS_V1

export type PrepareManagedSubscriptionEnvironmentOptionsV1 = {
  execution_scope?: ProviderExecutionScope
  overrides?: NodeJS.ProcessEnv
}

export function prepareManagedSubscriptionEnvironmentV1(
  providerId: ManagedSubscriptionProviderIdV1,
  source: NodeJS.ProcessEnv,
  options: PrepareManagedSubscriptionEnvironmentOptionsV1 = {},
): PreparedProviderEnvironmentV1 {
  const manifest: ProviderManifestV1 = MANAGED_SUBSCRIPTION_MANIFESTS_V1[providerId]
  const selection = selectProviderExecutionV1(manifest)
  const intent = defineProviderExecutionIntentV1({
    selection,
    execution_scope: options.execution_scope ?? 'managed_background',
    usage_priced_api: defineProviderNoCostConsentV1(),
    provider_managed_overage: defineProviderNoCostConsentV1(),
    required_capabilities: ['launch'],
  })
  return prepareProviderEnvironmentV1(
    manifest,
    intent,
    source,
    {
      on_conflict: 'strip',
      ...(options.overrides ? { overrides: options.overrides } : {}),
    },
  )
}

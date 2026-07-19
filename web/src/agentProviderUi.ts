export const ACCESS_PROFILES = [
  { value: 'read_only', label: 'read only', icon: '⏸', hint: 'inspect only; writes require a different profile' },
  { value: 'workspace_write', label: 'workspace write', icon: '⏵', hint: 'may edit the workspace; sensitive actions still ask' },
  { value: 'full_access', label: 'full access', icon: '⏵⏵', hint: 'no sandbox restrictions; use only in a trusted workspace' },
] as const

export type AccessProfile = (typeof ACCESS_PROFILES)[number]['value']
export type AgentCapability = 'access_profile' | 'model' | 'effort' | 'approvals' | 'interrupt' | 'stop'

export type ProviderTokenUsage = {
  total_tokens?: number
  totalTokens?: number
  input_tokens?: number
  inputTokens?: number
  cached_input_tokens?: number
  cachedInputTokens?: number
  cache_read?: number
  cache_creation?: number
  output_tokens?: number
  outputTokens?: number
  reasoning_output_tokens?: number
  reasoningOutputTokens?: number
}

export type ProviderTokenSummary = {
  input: number
  inputTotal: number
  cached: number
  cacheWrite: number
  output: number
  reasoningOutput: number
  total: number
  cachedPercent: number
}

const capabilityAliases: Record<AgentCapability, string[]> = {
  access_profile: ['access_profile', 'accessprofile', 'permissions', 'permission_mode', 'permissionmode', 'sandbox'],
  model: ['model', 'models', 'model_selection', 'modelselection', 'model_catalog', 'modelcatalog', 'reconfigure'],
  effort: ['effort', 'reasoning', 'reasoning_effort', 'reasoningeffort', 'reasoning_levels', 'reasoninglevels', 'reconfigure'],
  approvals: ['approval', 'approvals', 'inline_approval', 'inlineapprovals', 'permission_requests', 'permissionrequests', 'permissions'],
  interrupt: ['interrupt', 'turn_interrupt', 'turninterrupt'],
  stop: ['stop', 'terminate'],
}

const canonical = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0

export function normalizeProvider(provider?: string | null): string {
  return provider?.trim().toLowerCase() || 'claude'
}

export function providerLabel(provider?: string | null): string {
  const id = normalizeProvider(provider)
  if (id === 'claude') return 'Claude'
  if (id === 'codex') return 'Codex'
  return id.split(/[-_]/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

export function hasAgentCapability(
  capabilities: readonly string[] | null | undefined,
  capability: AgentCapability,
  provider?: string | null,
): boolean {
  // Older Claude snapshots predate capability publication. Preserve their controls
  // during rolling upgrades; every non-legacy provider must advertise support.
  if (!Array.isArray(capabilities)) return normalizeProvider(provider) === 'claude'
  const published = new Set(capabilities.map(canonical))
  if (published.has('*') || published.has('all')) return true
  return capabilityAliases[capability].some((alias) => published.has(canonical(alias)))
}

export function providerLaunchBody(provider?: string | null): { provider?: string } {
  const selected = provider?.trim()
  return selected ? { provider: selected } : {}
}

export function accessProfileFromLegacyPermission(mode?: string | null): AccessProfile {
  if (mode === 'plan') return 'read_only'
  if (mode === 'acceptEdits') return 'workspace_write'
  return 'full_access'
}

export function resolveAccessProfile(profile?: string | null, legacyPermissionMode?: string | null): AccessProfile {
  if (ACCESS_PROFILES.some((candidate) => candidate.value === profile)) return profile as AccessProfile
  return accessProfileFromLegacyPermission(legacyPermissionMode)
}

const usageValue = (usage: ProviderTokenUsage, snake: keyof ProviderTokenUsage, camel?: keyof ProviderTokenUsage) =>
  finite(usage[snake] ?? (camel ? usage[camel] : undefined))

export function providerTokenSummary(
  provider: string | null | undefined,
  usages: Array<ProviderTokenUsage | null | undefined>,
): ProviderTokenSummary {
  const id = normalizeProvider(provider)
  let input = 0
  let cached = 0
  let cacheWrite = 0
  let output = 0
  let reasoningOutput = 0
  let total = 0

  for (const usage of usages) {
    if (!usage) continue
    const itemInput = usageValue(usage, 'input_tokens', 'inputTokens')
    const itemCached = usageValue(usage, 'cached_input_tokens', 'cachedInputTokens') || usageValue(usage, 'cache_read')
    const itemCacheWrite = usageValue(usage, 'cache_creation')
    const itemOutput = usageValue(usage, 'output_tokens', 'outputTokens')
    input += itemInput
    cached += itemCached
    cacheWrite += itemCacheWrite
    output += itemOutput
    reasoningOutput += usageValue(usage, 'reasoning_output_tokens', 'reasoningOutputTokens')
    const explicitTotal = usageValue(usage, 'total_tokens', 'totalTokens')
    total += explicitTotal || (id === 'codex' ? itemInput : itemInput + itemCached + itemCacheWrite) + itemOutput
  }

  // Codex reports cached input as a subset of input. Claude's existing result
  // envelope reports cache read/write alongside uncached input, so they remain additive.
  const inputTotal = id === 'codex' ? input : input + cached + cacheWrite
  return {
    input,
    inputTotal,
    cached,
    cacheWrite,
    output,
    reasoningOutput,
    total,
    cachedPercent: inputTotal > 0 ? Math.round(100 * cached / inputTotal) : 0,
  }
}

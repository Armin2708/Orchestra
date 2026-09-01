// Claude Code's own permission-mode names — the wire values stay orchestra's
// access-profile ids (#45 contract); only the display vocabulary is Claude's.
export const ACCESS_PROFILES = [
  { value: 'read_only', label: 'plan mode', icon: '⏸', hint: 'read-only: the agent explores and plans but cannot modify anything' },
  { value: 'workspace_write', label: 'accept edits', icon: '⏵', hint: 'file edits are auto-approved; sensitive commands still ask' },
  { value: 'full_access', label: 'bypass permissions', icon: '⏵⏵', hint: 'no permission prompts at all; use only in a trusted workspace' },
] as const

export type AccessProfile = (typeof ACCESS_PROFILES)[number]['value']
export type AgentCapability = 'access_profile' | 'model' | 'effort' | 'approvals' | 'interrupt' | 'stop'
export type ProviderLaunchBody = {
  provider?: string
  model?: string
  effort?: string
  access_profile?: AccessProfile
}

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
  if (id === 'qwen') return 'Qwen Code'
  if (id === 'opencode') return 'OpenCode'
  return id.split(/[-_]/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

export function hasAgentCapability(
  capabilities: readonly string[] | Readonly<Record<string, boolean>> | null | undefined,
  capability: AgentCapability,
  provider?: string | null,
): boolean {
  // Older Claude snapshots predate capability publication. Preserve their controls
  // during rolling upgrades; every non-legacy provider must advertise support.
  if (!capabilities) return normalizeProvider(provider) === 'claude'
  const values = Array.isArray(capabilities)
    ? capabilities
    : Object.entries(capabilities as Readonly<Record<string, boolean>>)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
  const published = new Set(values.map(canonical))
  if (published.has('*') || published.has('all')) return true
  return capabilityAliases[capability].some((alias) => published.has(canonical(alias)))
}

// Canonical low→high ordering so the effort slider is monotonic regardless of the
// order the provider catalog happens to list levels in.
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function orderEffortLevels(levels: readonly string[]): string[] {
  const rank = (level: string) => {
    const idx = EFFORT_ORDER.indexOf(level.toLowerCase())
    return idx === -1 ? EFFORT_ORDER.length : idx
  }
  return [...levels].sort((a, b) => rank(a) - rank(b))
}

// The SDK's model catalog reports bare families ("Opus", "Fable"). Derive the
// versioned label ("Opus 4.8", "Fable 5") from the resolved model id when we can,
// so the picker names the exact model — falling back to the SDK displayName.
export function modelDisplayLabel(model: {
  value: string
  resolvedModel?: string
  displayName?: string
}): string {
  const raw = (model.resolvedModel || model.value || '').toLowerCase()
  // Model ids carry a context-window suffix (claude-opus-5[1m]). Render it as a
  // readable badge instead of leaking the bracket syntax into the button label.
  const contextWindow = raw.match(/\[(\d+m)\]/)?.[1]
  const source = raw.replace(/\[[^\]]*\]/g, '')
  const tokens = source
    .replace(/^claude-/, '')
    .split('-')
    .filter(Boolean)
    .filter((token) => !/^\d{6,}$/.test(token)) // drop trailing date stamps (e.g. 20251001)
  if (tokens.length >= 2) {
    const [family, ...rest] = tokens
    const version = rest.join('.')
    if (/\d/.test(version)) {
      const name = `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`
      return contextWindow ? `${name} · ${contextWindow.toUpperCase()}` : name
    }
  }
  return model.displayName || model.value
}

export function providerLaunchBody(
  provider?: string | null,
  model?: string | null,
  effort?: string | null,
  accessProfile?: AccessProfile | null,
): ProviderLaunchBody {
  const selectedProvider = provider?.trim()
  const selectedModel = model?.trim()
  const selectedEffort = effort?.trim()
  return {
    ...(selectedProvider ? { provider: selectedProvider } : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(selectedEffort ? { effort: selectedEffort } : {}),
    ...(accessProfile ? { access_profile: accessProfile } : {}),
  }
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
    total += explicitTotal || (id === 'codex' || id === 'qwen' ? itemInput : itemInput + itemCached + itemCacheWrite) + itemOutput
  }

  // Codex and Qwen report cached input as a subset of input. Claude's existing result
  // envelope reports cache read/write alongside uncached input, so they remain additive.
  const inputTotal = id === 'codex' || id === 'qwen' ? input : input + cached + cacheWrite
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

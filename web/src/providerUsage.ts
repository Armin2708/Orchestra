import type { SystemInfo, SystemProviderInfo } from './api'

export type SubscriptionUsageWindow = {
  id: string
  label: string
  used: number
  resetsAt: string | null
}

export type SubscriptionUsageProvider = {
  id: string
  name: string
  account?: string
  stale: boolean
  detail?: string
  windows: SubscriptionUsageWindow[]
  lifetimeTokens?: number
  resetCredits?: number
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const number = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

const percentage = (value: unknown): number | undefined => {
  const parsed = number(value)
  return parsed === undefined ? undefined : Math.min(100, Math.max(0, parsed))
}

const resetIso = (value: unknown): string | null => {
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  const parsed = number(value)
  if (parsed === undefined) return null
  const millis = parsed > 10_000_000_000 ? parsed : parsed * 1_000
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

const durationLabel = (minutes: unknown, fallback: string): string => {
  const value = number(minutes)
  if (!value || value <= 0) return fallback
  if (value === 300) return '5h'
  if (value === 10_080) return 'week'
  if (value % 10_080 === 0) return `${value / 10_080}w`
  if (value % 1_440 === 0) return `${value / 1_440}d`
  if (value % 60 === 0) return `${value / 60}h`
  return `${Math.round(value)}m`
}

const readableLimitName = (id: string, value: unknown, providerName: string): string => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (id === 'codex') return providerName
  return id.replace(/^codex[_-]?/i, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase())
    || providerName
}

const providerLimits = (provider: SystemProviderInfo): SubscriptionUsageProvider => {
  const snapshot = record(provider.usage)
  const rateLimits = record(snapshot?.rate_limits)
  const current = record(rateLimits?.current)
  const byLimit = record(rateLimits?.by_limit)
  const candidates = [
    ...(current ? [current] : []),
    ...Object.values(byLimit ?? {}).flatMap((value) => {
      const limit = record(value)
      return limit ? [limit] : []
    }),
  ]
  const seen = new Set<string>()
  const windows: SubscriptionUsageWindow[] = []

  for (const limit of candidates) {
    const id = typeof limit.limit_id === 'string' && limit.limit_id ? limit.limit_id : `limit-${seen.size + 1}`
    if (seen.has(id)) continue
    seen.add(id)
    const limitName = readableLimitName(id, limit.limit_name, provider.name)
    for (const [slot, fallback] of [['primary', 'primary'], ['secondary', 'secondary']] as const) {
      const window = record(limit[slot])
      const used = percentage(window?.usedPercent)
      if (!window || used === undefined) continue
      const duration = durationLabel(window.windowDurationMins, fallback)
      windows.push({
        id: `${id}:${slot}`,
        label: limitName === provider.name ? duration : `${limitName} · ${duration}`,
        used,
        resetsAt: resetIso(window.resetsAt),
      })
    }
  }

  const usage = record(snapshot?.usage)
  const summary = record(usage?.summary)
  const lifetimeTokens = number(summary?.lifetimeTokens)
  const resetCredits = number(rateLimits?.reset_credits_available)
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.auth?.account ? { account: provider.auth.account } : {}),
    stale: snapshot?.stale === true,
    ...(typeof snapshot?.detail === 'string' ? { detail: snapshot.detail } : {}),
    windows,
    ...(lifetimeTokens !== undefined ? { lifetimeTokens } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {}),
  }
}

export function subscriptionUsage(sys: SystemInfo): SubscriptionUsageProvider[] {
  const providers: SubscriptionUsageProvider[] = []
  if (sys.usage || sys.usage_error) {
    const stale = !!sys.usage?.stale_since
    providers.push({
      id: 'claude',
      name: 'Claude',
      stale,
      ...(sys.usage_error ? { detail: `Usage unavailable (${sys.usage_error})` } : {}),
      windows: sys.usage ? [
        {
          id: 'claude:five-hour', label: '5h', used: percentage(sys.usage.five_hour.utilization) ?? 0,
          resetsAt: resetIso(sys.usage.five_hour.resets_at),
        },
        {
          id: 'claude:seven-day', label: 'week', used: percentage(sys.usage.seven_day.utilization) ?? 0,
          resetsAt: resetIso(sys.usage.seven_day.resets_at),
        },
      ] : [],
    })
  }

  for (const provider of sys.providers ?? []) {
    if (provider.id === 'claude' || (!provider.usage && !provider.auth?.account)) continue
    providers.push(providerLimits(provider))
  }
  return providers
}

export const highestSubscriptionUsage = (providers: SubscriptionUsageProvider[]): number | null => {
  const values = providers.flatMap((provider) => provider.windows.map((window) => window.used))
  return values.length ? Math.max(...values) : null
}

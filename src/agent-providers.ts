import type Database from 'better-sqlite3'

export const CLAUDE_PROVIDER_ID = 'claude'
export const CODEX_PROVIDER_ID = 'codex'
export const QWEN_PROVIDER_ID = 'qwen'

export type AgentProviderCapability =
  | 'steering'
  | 'approvals'
  | 'model'
  | 'effort'
  | 'rate_limits'
  | 'usage'
  | 'diffs'
  | 'plans'
  | 'subagents'
  | 'ambient_hooks'
  | 'session_end_hooks'
  | 'access_profile'
  | 'interrupt'
  | 'stop'

export type AgentProviderCapabilities = Record<AgentProviderCapability, boolean>

export type AgentProviderHealth = {
  available: boolean
  status: 'ready' | 'degraded' | 'unavailable'
  updated_at: string
  version?: string
  detail?: string
}

export type AgentProviderAuthState = {
  status: 'authenticated' | 'unauthenticated' | 'unknown'
  updated_at: string
  account?: string
  detail?: string
}

export type AgentProviderUsageSnapshot = {
  updated_at: string
  stale?: boolean
  rate_limits?: unknown
  usage?: unknown
  detail?: string
}

export type AgentProviderModel = {
  value: string
  resolvedModel?: string
  displayName: string
  description: string
  isDefault?: boolean
  defaultEffort?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

export type AgentProviderCatalog = {
  id: string
  name: string
  available: boolean
  models: AgentProviderModel[]
  source: 'live' | 'cache' | 'unavailable'
  updated_at: string | null
  detail?: string
  capabilities?: AgentProviderCapabilities | string[]
  health?: AgentProviderHealth
  auth?: AgentProviderAuthState
  usage?: AgentProviderUsageSnapshot
}

export interface AgentProviderService {
  readonly id: string
  readonly name: string
  readonly capabilities: AgentProviderCapabilities
  catalog(): Promise<AgentProviderCatalog>
  health(): Promise<AgentProviderHealth>
  authState?(): Promise<AgentProviderAuthState>
  usageSnapshot?(): Promise<AgentProviderUsageSnapshot>
}

export type ProviderModelCache = {
  models: AgentProviderModel[]
  updated_at: string
}

const PROVIDER_MODEL_CACHE_PREFIX = 'provider_models_'
const PROVIDER_MODEL_CACHE_SUFFIX = '_v1'
const MAX_MODEL_ID_LENGTH = 200
const MAX_EFFORT_ID_LENGTH = 40
const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const normalizeProviderId = (provider: string): string => {
  const normalized = provider.trim().toLowerCase()
  if (!SAFE_PROVIDER_ID.test(normalized)) throw new Error(`invalid provider id: ${provider}`)
  return normalized
}

const providerModelCacheKey = (provider: string): string =>
  `${PROVIDER_MODEL_CACHE_PREFIX}${normalizeProviderId(provider)}${PROVIDER_MODEL_CACHE_SUFFIX}`

const normalizeEffortLevels = (row: Record<string, unknown>): string[] => {
  const raw = Array.isArray(row.supportedEffortLevels)
    ? row.supportedEffortLevels
    : Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts
      : []
  const levels: string[] = []
  for (const item of raw) {
    const value = typeof item === 'string'
      ? item
      : item && typeof item === 'object' && !Array.isArray(item)
        ? optionalString((item as Record<string, unknown>).reasoningEffort)
        : undefined
    if (!value || value.length > MAX_EFFORT_ID_LENGTH || !/^[a-zA-Z0-9_-]+$/.test(value)) continue
    levels.push(value)
  }
  return [...new Set(levels)]
}

const normalizeEffort = (value: unknown): string | undefined => {
  const effort = optionalString(value)
  return effort && effort.length <= MAX_EFFORT_ID_LENGTH && /^[a-zA-Z0-9_-]+$/.test(effort)
    ? effort
    : undefined
}

export function normalizeProviderModels(value: unknown): AgentProviderModel[] {
  if (!Array.isArray(value)) return []
  const models = new Map<string, AgentProviderModel>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const modelValue = optionalString(row.value) ?? optionalString(row.model) ?? optionalString(row.id)
    if (!modelValue || modelValue.length > MAX_MODEL_ID_LENGTH) continue
    const effortLevels = normalizeEffortLevels(row)
    const isDefault = optionalBoolean(row.isDefault) ?? (modelValue.toLowerCase() === 'default' ? true : undefined)
    const defaultEffort = normalizeEffort(row.defaultEffort) ?? normalizeEffort(row.defaultReasoningEffort)
    models.set(modelValue, {
      value: modelValue,
      ...(optionalString(row.resolvedModel) ? { resolvedModel: optionalString(row.resolvedModel) } : {}),
      displayName: optionalString(row.displayName) ?? modelValue,
      description: optionalString(row.description) ?? '',
      ...(isDefault !== undefined ? { isDefault } : {}),
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(optionalBoolean(row.supportsEffort) !== undefined
        ? { supportsEffort: optionalBoolean(row.supportsEffort) }
        : effortLevels.length ? { supportsEffort: true } : {}),
      ...(effortLevels.length ? { supportedEffortLevels: [...new Set(effortLevels)] } : {}),
      ...(optionalBoolean(row.supportsAdaptiveThinking) !== undefined
        ? { supportsAdaptiveThinking: optionalBoolean(row.supportsAdaptiveThinking) } : {}),
      ...(optionalBoolean(row.supportsFastMode) !== undefined
        ? { supportsFastMode: optionalBoolean(row.supportsFastMode) } : {}),
      ...(optionalBoolean(row.supportsAutoMode) !== undefined
        ? { supportsAutoMode: optionalBoolean(row.supportsAutoMode) } : {}),
    })
  }
  return [...models.values()]
}

export function readProviderModelCache(
  db: Database.Database,
  provider = CLAUDE_PROVIDER_ID,
): ProviderModelCache | null {
  const row = db.prepare('SELECT value, updated_at FROM kv WHERE key=?').get(providerModelCacheKey(provider)) as
    { value: string; updated_at: string } | undefined
  if (!row) return null
  try {
    const models = normalizeProviderModels(JSON.parse(row.value))
    return models.length ? { models, updated_at: row.updated_at } : null
  } catch {
    return null
  }
}

export function writeProviderModelCache(
  db: Database.Database,
  value: unknown,
  provider = CLAUDE_PROVIDER_ID,
): ProviderModelCache | null {
  const models = normalizeProviderModels(value)
  if (!models.length) return null
  db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(providerModelCacheKey(provider), JSON.stringify(models))
  return readProviderModelCache(db, provider)
}

export function agentProviderCatalog(input: {
  id: string
  name: string
  available: boolean
  models?: AgentProviderModel[]
  source?: AgentProviderCatalog['source']
  updatedAt?: string | null
  detail?: string
  capabilities?: AgentProviderCapabilities | string[]
  health?: AgentProviderHealth
  auth?: AgentProviderAuthState
  usage?: AgentProviderUsageSnapshot
}): AgentProviderCatalog {
  return {
    id: normalizeProviderId(input.id),
    name: input.name,
    available: input.available,
    models: input.models ?? [],
    source: input.source ?? 'unavailable',
    updated_at: input.updatedAt ?? null,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    ...(input.health ? { health: input.health } : {}),
    ...(input.auth ? { auth: input.auth } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  }
}

export function claudeProviderCatalog(input: {
  available: boolean
  models?: AgentProviderModel[]
  source?: AgentProviderCatalog['source']
  updatedAt?: string | null
  detail?: string
}): AgentProviderCatalog {
  return agentProviderCatalog({
    id: CLAUDE_PROVIDER_ID,
    name: 'Claude',
    ...input,
  })
}

export function codexProviderCatalog(input: {
  available: boolean
  models?: AgentProviderModel[]
  source?: AgentProviderCatalog['source']
  updatedAt?: string | null
  detail?: string
  capabilities?: AgentProviderCapabilities
  health?: AgentProviderHealth
  auth?: AgentProviderAuthState
  usage?: AgentProviderUsageSnapshot
}): AgentProviderCatalog {
  return agentProviderCatalog({ id: CODEX_PROVIDER_ID, name: 'Codex', ...input })
}

export function qwenProviderCatalog(input: {
  available: boolean
  models?: AgentProviderModel[]
  source?: AgentProviderCatalog['source']
  updatedAt?: string | null
  detail?: string
  capabilities?: AgentProviderCapabilities
  health?: AgentProviderHealth
  auth?: AgentProviderAuthState
  usage?: AgentProviderUsageSnapshot
}): AgentProviderCatalog {
  return agentProviderCatalog({ id: QWEN_PROVIDER_ID, name: 'Qwen Code', ...input })
}

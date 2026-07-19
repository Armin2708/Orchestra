import type Database from 'better-sqlite3'
import { AGENT_DEFAULT_EFFORT_LEVELS, type AgentDefaultEffort } from './agent-defaults.js'

export const CLAUDE_PROVIDER_ID = 'claude'

export type AgentProviderModel = {
  value: string
  resolvedModel?: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: AgentDefaultEffort[]
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
}

export type ProviderModelCache = {
  models: AgentProviderModel[]
  updated_at: string
}

const CLAUDE_MODEL_CACHE_KEY = 'provider_models_claude_v1'
const MAX_MODEL_ID_LENGTH = 200

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

export function normalizeProviderModels(value: unknown): AgentProviderModel[] {
  if (!Array.isArray(value)) return []
  const models = new Map<string, AgentProviderModel>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const modelValue = optionalString(row.value) ?? optionalString(row.model)
    if (!modelValue || modelValue.length > MAX_MODEL_ID_LENGTH) continue
    const effortLevels = Array.isArray(row.supportedEffortLevels)
      ? row.supportedEffortLevels.filter((level): level is AgentDefaultEffort =>
          AGENT_DEFAULT_EFFORT_LEVELS.includes(level as AgentDefaultEffort))
      : []
    models.set(modelValue, {
      value: modelValue,
      ...(optionalString(row.resolvedModel) ? { resolvedModel: optionalString(row.resolvedModel) } : {}),
      displayName: optionalString(row.displayName) ?? modelValue,
      description: optionalString(row.description) ?? '',
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

export function readProviderModelCache(db: Database.Database): ProviderModelCache | null {
  const row = db.prepare('SELECT value, updated_at FROM kv WHERE key=?').get(CLAUDE_MODEL_CACHE_KEY) as
    { value: string; updated_at: string } | undefined
  if (!row) return null
  try {
    const models = normalizeProviderModels(JSON.parse(row.value))
    return models.length ? { models, updated_at: row.updated_at } : null
  } catch {
    return null
  }
}

export function writeProviderModelCache(db: Database.Database, value: unknown): ProviderModelCache | null {
  const models = normalizeProviderModels(value)
  if (!models.length) return null
  db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(CLAUDE_MODEL_CACHE_KEY, JSON.stringify(models))
  return readProviderModelCache(db)
}

export function claudeProviderCatalog(input: {
  available: boolean
  models?: AgentProviderModel[]
  source?: AgentProviderCatalog['source']
  updatedAt?: string | null
  detail?: string
}): AgentProviderCatalog {
  return {
    id: CLAUDE_PROVIDER_ID,
    name: 'Claude',
    available: input.available,
    models: input.models ?? [],
    source: input.source ?? 'unavailable',
    updated_at: input.updatedAt ?? null,
    ...(input.detail ? { detail: input.detail } : {}),
  }
}

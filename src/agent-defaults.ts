import type Database from 'better-sqlite3'

export const AGENT_DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgentDefaultEffort = string
export type AgentType = 'worker' | 'specialist'
export type SpecialistRole = 'strategist' | 'auditor' | 'verifier'
export const DEFAULT_AGENT_PROVIDER = 'claude'

export type AgentDefaultProfile = {
  provider: string
  model: string | null
  effort: AgentDefaultEffort | null
}

export type AgentDefaults = Record<AgentType, AgentDefaultProfile>

const SETTINGS_KEY = 'agent_defaults_v1'
const MAX_PROVIDER_LENGTH = 64
const MAX_MODEL_LENGTH = 200
const SAFE_EFFORT = /^[a-zA-Z0-9_-]{1,40}$/

export class AgentDefaultsValidationError extends Error {}

export const emptyAgentDefaults = (): AgentDefaults => ({
  worker: { provider: DEFAULT_AGENT_PROVIDER, model: null, effort: null },
  specialist: { provider: DEFAULT_AGENT_PROVIDER, model: null, effort: null },
})

const storedProfile = (value: unknown): AgentDefaultProfile => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { provider: DEFAULT_AGENT_PROVIDER, model: null, effort: null }
  const profile = value as Record<string, unknown>
  const provider = typeof profile.provider === 'string' && profile.provider.trim()
    ? profile.provider.trim().slice(0, MAX_PROVIDER_LENGTH) : DEFAULT_AGENT_PROVIDER
  const model = typeof profile.model === 'string' && profile.model.trim()
    ? profile.model.trim().slice(0, MAX_MODEL_LENGTH) : null
  const effort = typeof profile.effort === 'string' && SAFE_EFFORT.test(profile.effort)
    ? profile.effort : null
  return { provider, model, effort }
}

const requestedProfile = (value: unknown, type: AgentType): AgentDefaultProfile => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentDefaultsValidationError(`${type} settings are required`)
  const profile = value as Record<string, unknown>
  if (profile.provider !== undefined && typeof profile.provider !== 'string')
    throw new AgentDefaultsValidationError(`${type} provider must be a string`)
  const provider = profile.provider === undefined ? DEFAULT_AGENT_PROVIDER : profile.provider.trim()
  if (!provider) throw new AgentDefaultsValidationError(`${type} provider is required`)
  if (provider.length > MAX_PROVIDER_LENGTH)
    throw new AgentDefaultsValidationError(`${type} provider must be ${MAX_PROVIDER_LENGTH} characters or fewer`)
  if (profile.model !== null && typeof profile.model !== 'string')
    throw new AgentDefaultsValidationError(`${type} model must be a string or null`)
  const model = typeof profile.model === 'string' ? profile.model.trim() || null : null
  if (model && model.length > MAX_MODEL_LENGTH)
    throw new AgentDefaultsValidationError(`${type} model must be ${MAX_MODEL_LENGTH} characters or fewer`)
  if (profile.effort !== null && (typeof profile.effort !== 'string' || !SAFE_EFFORT.test(profile.effort)))
    throw new AgentDefaultsValidationError(`${type} effort must be a provider effort identifier or null`)
  return { provider, model, effort: profile.effort as AgentDefaultEffort | null }
}

export function parseAgentDefaults(value: unknown): AgentDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentDefaultsValidationError('agent defaults must be an object')
  const input = value as Record<string, unknown>
  return {
    worker: requestedProfile(input.worker, 'worker'),
    specialist: requestedProfile(input.specialist, 'specialist'),
  }
}

export function readAgentDefaults(db: Database.Database): AgentDefaults {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(SETTINGS_KEY) as { value: string } | undefined
  if (!row) return emptyAgentDefaults()
  try {
    const value = JSON.parse(row.value) as Record<string, unknown>
    return { worker: storedProfile(value.worker), specialist: storedProfile(value.specialist) }
  } catch {
    // A malformed local setting must never prevent the daemon from hiring an agent.
    return emptyAgentDefaults()
  }
}

export function writeAgentDefaults(db: Database.Database, value: unknown): AgentDefaults {
  const defaults = parseAgentDefaults(value)
  db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(SETTINGS_KEY, JSON.stringify(defaults))
  return defaults
}

export const agentTypeForRole = (role?: SpecialistRole): AgentType => role ? 'specialist' : 'worker'

export function defaultsForRole(db: Database.Database, role?: SpecialistRole): AgentDefaultProfile {
  return readAgentDefaults(db)[agentTypeForRole(role)]
}

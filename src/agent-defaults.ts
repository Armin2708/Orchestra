import type Database from 'better-sqlite3'

export const AGENT_DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgentDefaultEffort = (typeof AGENT_DEFAULT_EFFORT_LEVELS)[number]
export type AgentType = 'worker' | 'specialist'
export type SpecialistRole = 'strategist' | 'auditor' | 'verifier'

export type AgentDefaultProfile = {
  model: string | null
  effort: AgentDefaultEffort | null
}

export type AgentDefaults = Record<AgentType, AgentDefaultProfile>

const SETTINGS_KEY = 'agent_defaults_v1'
const MAX_MODEL_LENGTH = 200

export class AgentDefaultsValidationError extends Error {}

export const emptyAgentDefaults = (): AgentDefaults => ({
  worker: { model: null, effort: null },
  specialist: { model: null, effort: null },
})

const storedProfile = (value: unknown): AgentDefaultProfile => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { model: null, effort: null }
  const profile = value as Record<string, unknown>
  const model = typeof profile.model === 'string' && profile.model.trim()
    ? profile.model.trim().slice(0, MAX_MODEL_LENGTH) : null
  const effort = AGENT_DEFAULT_EFFORT_LEVELS.includes(profile.effort as AgentDefaultEffort)
    ? profile.effort as AgentDefaultEffort : null
  return { model, effort }
}

const requestedProfile = (value: unknown, type: AgentType): AgentDefaultProfile => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentDefaultsValidationError(`${type} settings are required`)
  const profile = value as Record<string, unknown>
  if (profile.model !== null && typeof profile.model !== 'string')
    throw new AgentDefaultsValidationError(`${type} model must be a string or null`)
  const model = typeof profile.model === 'string' ? profile.model.trim() || null : null
  if (model && model.length > MAX_MODEL_LENGTH)
    throw new AgentDefaultsValidationError(`${type} model must be ${MAX_MODEL_LENGTH} characters or fewer`)
  if (profile.effort !== null && !AGENT_DEFAULT_EFFORT_LEVELS.includes(profile.effort as AgentDefaultEffort))
    throw new AgentDefaultsValidationError(`${type} effort must be low, medium, high, xhigh, max, or null`)
  return { model, effort: profile.effort as AgentDefaultEffort | null }
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

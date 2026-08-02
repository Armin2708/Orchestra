import { createHash } from 'node:crypto'

export const OPERATOR_TELEMETRY_EVENTS = [
  'onboarding_completed',
  'doctor_completed',
  'demo_completed',
  'support_bundle_prepared',
] as const

export type OperatorTelemetryEvent = typeof OPERATOR_TELEMETRY_EVENTS[number]
export type OperatorTelemetryConsent = 'off' | 'redacted'

export type OperatorTelemetryInput = {
  event: OperatorTelemetryEvent
  properties?: {
    provider?: 'claude' | 'codex' | 'qwen' | 'kimi'
    execution_mode?: 'native_subscription' | 'provider_api'
    result?: 'passed' | 'blocked' | 'failed'
    platform?: 'darwin' | 'linux' | 'win32' | 'other'
    duration_bucket?: 'lt_10s' | 'lt_60s' | 'gte_60s'
  }
}

export type OperatorTelemetryEnvelopeV1 = {
  schema_version: 1
  event: OperatorTelemetryEvent
  installation_id: string
  occurred_at: string
  properties: NonNullable<OperatorTelemetryInput['properties']>
}

const PROPERTY_VALUES = Object.freeze({
  provider: ['claude', 'codex', 'qwen', 'kimi'],
  execution_mode: ['native_subscription', 'provider_api'],
  result: ['passed', 'blocked', 'failed'],
  platform: ['darwin', 'linux', 'win32', 'other'],
  duration_bucket: ['lt_10s', 'lt_60s', 'gte_60s'],
} as const)

const validateProperties = (
  properties: NonNullable<OperatorTelemetryInput['properties']>,
): void => {
  for (const [key, value] of Object.entries(properties)) {
    const allowed = PROPERTY_VALUES[key as keyof typeof PROPERTY_VALUES]
    if (!allowed || !(allowed as readonly string[]).includes(String(value))) {
      throw new Error(`telemetry property is not allowlisted: ${key}`)
    }
  }
}

export const redactedInstallationId = (localSeed: string): string => {
  if (localSeed.length < 16) throw new Error('telemetry installation seed is too short')
  return `sha256:${createHash('sha256').update(localSeed).digest('hex')}`
}

export const buildOperatorTelemetryEnvelope = (
  consent: OperatorTelemetryConsent,
  localSeed: string,
  input: OperatorTelemetryInput,
  now: () => string = () => new Date().toISOString(),
): OperatorTelemetryEnvelopeV1 | null => {
  if (consent === 'off') return null
  if (!OPERATOR_TELEMETRY_EVENTS.includes(input.event)) {
    throw new Error('telemetry event is not allowlisted')
  }
  validateProperties(input.properties ?? {})
  return {
    schema_version: 1,
    event: input.event,
    installation_id: redactedInstallationId(localSeed),
    occurred_at: now(),
    properties: { ...input.properties },
  }
}

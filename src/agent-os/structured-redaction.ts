import { redactProjectedText } from './projected-text-redaction.js'

export const REDACTED_STRUCTURED_VALUE = '[REDACTED]'
export const MAX_STRUCTURED_REDACTION_DEPTH = 32

export interface StructuredRedactionResult<T = unknown> {
  value: T
  redactions: number
  changed: boolean
}

const SENSITIVE_KEY = /(?:^|_)(?:authorizations?|authentications?|proxy_authorizations?|basic_auths?|cookies?|set_cookies?|credentials?|passwords?|passwds?|api_keys?|apikeys?|private_keys?|raw_responses?|client_secrets?|secrets?)(?:$|_)/i
const SHORT_BASIC_AUTH = /\b((?:authorization\s*[:=]\s*)?basic\s+)([A-Za-z0-9+/]{2,}={0,2})(?=$|[^A-Za-z0-9+/=])/gi
const SAFE_TOKEN_ACCOUNTING_KEYS = new Set([
  'tokens',
  'token_budget',
  'total_tokens',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cached_output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'reasoning_tokens',
  'reasoning_output_tokens',
  'last_total_tokens',
  'prompt_tokens',
  'completion_tokens',
  'spent_tokens',
  'budget_tokens',
  'remaining_tokens',
  'accounted_tokens',
  'reported_tokens',
  'coordination_tokens',
  'turn_tokens',
  'session_tokens',
  'lifetime_tokens',
  'peak_daily_tokens',
  'max_tokens',
])

export function normalizeSensitiveKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

export function isSensitiveMetadataKey(key: string): boolean {
  const normalized = normalizeSensitiveKey(key)
  return ['token', 'tokens', 'apikey', 'auth', 'bearer'].includes(normalized)
    || normalized.endsWith('_token')
    || normalized.endsWith('_tokens')
    || SENSITIVE_KEY.test(normalized)
}

export function redactStructuredValue<T>(value: T): StructuredRedactionResult<T> {
  return redactValue(value, '', 0, new WeakSet<object>()) as StructuredRedactionResult<T>
}

export function redactSensitiveText(
  value: string | null,
): StructuredRedactionResult<string | null> {
  if (value === null) return { value: null, redactions: 0, changed: false }
  const projected = redactProjectedText(value)
  let shortBasicRedactions = 0
  const withoutShortBasic = (projected.value ?? '').replace(
    SHORT_BASIC_AUTH,
    (match, prefix: string | undefined, credential: string | undefined) => {
      if (typeof credential !== 'string') return match
      let decoded = ''
      try {
        const padded = credential.padEnd(
          credential.length + ((4 - (credential.length % 4)) % 4),
          '=',
        )
        decoded = Buffer.from(padded, 'base64').toString('utf8')
      } catch {
        return match
      }
      if (!decoded.includes(':')) return match
      shortBasicRedactions += 1
      return `${prefix ?? 'Basic '}[REDACTED]`
    },
  )
  return {
    value: withoutShortBasic,
    redactions: projected.redactions + shortBasicRedactions,
    changed: withoutShortBasic !== value,
  }
}

function redactValue(
  value: unknown,
  key: string,
  depth: number,
  active: WeakSet<object>,
): StructuredRedactionResult {
  if (key && isSensitiveMetadataKey(key) && !isSafeTokenAccountingValue(key, value)) {
    return {
      value: REDACTED_STRUCTURED_VALUE,
      redactions: value === REDACTED_STRUCTURED_VALUE ? 0 : 1,
      changed: value !== REDACTED_STRUCTURED_VALUE,
    }
  }
  if (typeof value === 'string') {
    return redactSensitiveText(value)
  }
  if (typeof value === 'function') {
    return { value: REDACTED_STRUCTURED_VALUE, redactions: 1, changed: true }
  }
  if (!value || typeof value !== 'object') {
    return { value, redactions: 0, changed: false }
  }
  if (depth >= MAX_STRUCTURED_REDACTION_DEPTH || active.has(value)) {
    return { value: REDACTED_STRUCTURED_VALUE, redactions: 1, changed: true }
  }

  active.add(value)
  try {
    if (Array.isArray(value)) {
      let redactions = 0
      let changed = false
      const next = value.map((item) => {
        const result = redactValue(item, '', depth + 1, active)
        redactions += result.redactions
        changed ||= result.changed
        return result.value
      })
      return { value: next, redactions, changed }
    }

    let redactions = 0
    let changed = false
    const next = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => {
        const result = redactValue(item, name, depth + 1, active)
        redactions += result.redactions
        changed ||= result.changed
        return [name, result.value]
      }),
    )
    return { value: next, redactions, changed }
  } finally {
    active.delete(value)
  }
}

function isSafeTokenAccountingValue(key: string, value: unknown): boolean {
  const normalized = normalizeSensitiveKey(key)
  if (normalized === 'token_usage') {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }
  return SAFE_TOKEN_ACCOUNTING_KEYS.has(normalized)
    && (value === null || (typeof value === 'number' && Number.isFinite(value)))
}

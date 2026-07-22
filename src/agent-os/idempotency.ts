import { ValidationError } from './errors.js'

const MAX_IDEMPOTENCY_KEY_LENGTH = 200
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

type IdempotencyKeySources = {
  header?: unknown
  snake?: unknown
  camel?: unknown
}

const normalizeSource = (label: string, value: unknown): string | undefined => {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new ValidationError(`${label} must be provided exactly once`)
    return normalizeSource(label, value[0])
  }
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`)
  const key = value.trim()
  if (!key) throw new ValidationError(`${label} must not be empty`)
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ValidationError(`${label} must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`)
  }
  if (CONTROL_CHARACTER.test(key)) throw new ValidationError(`${label} must not contain control characters`)
  return key
}

/** Resolve every supported spelling once and reject ambiguous replay identities. */
export function resolveIdempotencyKey(sources: IdempotencyKeySources): string | undefined {
  const values = [
    normalizeSource('Idempotency-Key header', sources.header),
    normalizeSource('idempotency_key', sources.snake),
    normalizeSource('idempotencyKey', sources.camel),
  ].filter((value): value is string => value !== undefined)
  if (!values.length) return undefined
  if (values.some((value) => value !== values[0])) {
    throw new ValidationError('Idempotency-Key header, idempotency_key, and idempotencyKey must match')
  }
  return values[0]
}

import { ValidationError } from './errors.js'

const MAX_IDEMPOTENCY_KEY_LENGTH = 200
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

type IdempotencyKeySources = {
  header?: unknown
  rawHeaders?: readonly string[]
  snake?: unknown
  camel?: unknown
}

const normalizeText = (label: string, value: unknown): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`)
  const key = value.trim()
  if (!key) throw new ValidationError(`${label} must not be empty`)
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ValidationError(`${label} must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`)
  }
  if (CONTROL_CHARACTER.test(key)) throw new ValidationError(`${label} must not contain control characters`)
  return key
}

const headerValue = (sources: IdempotencyKeySources): unknown => {
  const occurrences: string[] = []
  for (let index = 0; index < (sources.rawHeaders?.length ?? 0); index += 2) {
    if (sources.rawHeaders?.[index]?.toLowerCase() === 'idempotency-key') {
      occurrences.push(sources.rawHeaders[index + 1] ?? '')
    }
  }
  if (occurrences.length > 1) {
    throw new ValidationError('Idempotency-Key header must be provided exactly once')
  }
  if (occurrences.length === 1) {
    if (occurrences[0].includes(',')) {
      throw new ValidationError('Idempotency-Key header must be provided exactly once')
    }
    return occurrences[0]
  }
  if (Array.isArray(sources.header)) {
    if (sources.header.length !== 1) {
      throw new ValidationError('Idempotency-Key header must be provided exactly once')
    }
    return sources.header[0]
  }
  if (typeof sources.header === 'string' && sources.header.includes(',')) {
    throw new ValidationError('Idempotency-Key header must be provided exactly once')
  }
  return sources.header
}

/** Resolve every supported spelling once and reject ambiguous replay identities. */
export function resolveIdempotencyKey(sources: IdempotencyKeySources): string | undefined {
  const values = [
    normalizeText('Idempotency-Key header', headerValue(sources)),
    normalizeText('idempotency_key', sources.snake),
    normalizeText('idempotencyKey', sources.camel),
  ].filter((value): value is string => value !== undefined)
  if (!values.length) return undefined
  if (values.some((value) => value !== values[0])) {
    throw new ValidationError('Idempotency-Key header, idempotency_key, and idempotencyKey must match')
  }
  return values[0]
}

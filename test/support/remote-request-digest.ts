import { createHash } from 'node:crypto'

export function remoteRequestDigest(input: {
  method: string
  path: string
  body?: unknown
}): string {
  return createHash('sha256').update(JSON.stringify({
    method: input.method.toUpperCase(),
    path: input.path,
    body: canonicalValue(input.body ?? null),
  })).digest('base64url')
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]))
  }
  return value
}

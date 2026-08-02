import { createHash } from 'node:crypto'
import {
  REDACTED_STRUCTURED_VALUE,
  redactStructuredValue,
} from '../agent-os/structured-redaction.js'

const WITHHELD_OPERATIONAL_KEY = /(?:^|_)(?:args?|argv|commands?|contexts?|prompts?|transcripts?|reasoning|approval_parameters?|raw|raw_data|inputs?|outputs?|stdout|stderr|environment|env|cwd|paths?|worktrees?|branches?|repository|headers?|queries?|urls?|uris?|cookies?|credentials?|secrets?|tokens?|passwords?|private_keys?)(?:$|_)/i

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EVENT_NAME = /^[a-z][a-z0-9_.-]{0,95}$/

export const WITHHELD_OPERATIONAL_VALUE = '[WITHHELD]'

export interface OperationsRedactionResult<T = unknown> {
  value: T
  redactions: number
}

export function normalizeOperationsKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

export function isWithheldOperationalKey(key: string): boolean {
  return WITHHELD_OPERATIONAL_KEY.test(normalizeOperationsKey(key))
}

/**
 * Redacts credentials first, then withholds content classes that are unsafe even when they do
 * not look like a credential (commands, context, PTY data, paths, approval parameters, and raw
 * provider material). Diagnostics and logs both call this at their final serialization boundary.
 */
export function redactOperationsValue<T>(input: T): OperationsRedactionResult<T> {
  const credentialSafe = redactStructuredValue(input)
  const contentSafe = withholdContent(credentialSafe.value, '', 0, new WeakSet<object>())
  return {
    value: contentSafe.value as T,
    redactions: credentialSafe.redactions + contentSafe.redactions,
  }
}

export function safeOperationalIdentifier(
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  return IDENTIFIER.test(trimmed) ? trimmed : undefined
}

export function safeOperationalEventName(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!EVENT_NAME.test(normalized)) throw new Error('invalid operational event name')
  return normalized
}

/** Creates a correlation-safe partition without retaining an IP, account, or device token. */
export function privacySafePartition(value: string, salt: string): string {
  if (!salt || salt.length < 16) throw new Error('operations partition salt must be at least 16 characters')
  return createHash('sha256').update(salt).update('\0').update(value).digest('hex').slice(0, 24)
}

function withholdContent(
  value: unknown,
  key: string,
  depth: number,
  active: WeakSet<object>,
): OperationsRedactionResult {
  if (key && isWithheldOperationalKey(key)) {
    const alreadySafe = value === WITHHELD_OPERATIONAL_VALUE
      || value === REDACTED_STRUCTURED_VALUE
    return {
      value: alreadySafe ? value : WITHHELD_OPERATIONAL_VALUE,
      redactions: alreadySafe ? 0 : 1,
    }
  }
  if (!value || typeof value !== 'object') return { value, redactions: 0 }
  if (depth >= 24 || active.has(value)) {
    return { value: WITHHELD_OPERATIONAL_VALUE, redactions: 1 }
  }

  active.add(value)
  try {
    if (Array.isArray(value)) {
      let redactions = 0
      const next = value.map((item) => {
        const result = withholdContent(item, '', depth + 1, active)
        redactions += result.redactions
        return result.value
      })
      return { value: next, redactions }
    }

    let redactions = 0
    const next = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => {
        const result = withholdContent(item, name, depth + 1, active)
        redactions += result.redactions
        return [name, result.value]
      }),
    )
    return { value: next, redactions }
  } finally {
    active.delete(value)
  }
}

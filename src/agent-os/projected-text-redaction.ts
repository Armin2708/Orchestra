export type ProjectedTextRedactionState = 'none' | 'redacted' | 'withheld'

const SECRET_PATTERNS = [
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[a-z]-[A-Za-z0-9-]{16,})\b/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export const CODEX_WITHHELD_REASONING_METHODS = new Set([
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
])

export function redactProjectedText(
  value: string | null,
): { value: string | null; redactions: number } {
  if (value === null) return { value: null, redactions: 0 }
  let redactions = 0
  let next = value
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, (_match, prefix: string | number | undefined) => {
      redactions += 1
      return typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'
    })
  }
  return { value: next, redactions }
}

export function normalizeProjectedText(
  value: string | null,
  requestedState: ProjectedTextRedactionState,
): { value: string | null; redactionState: ProjectedTextRedactionState; redactions: number } {
  if (requestedState === 'withheld') {
    return { value: null, redactionState: 'withheld', redactions: value === null ? 0 : 1 }
  }
  const redacted = redactProjectedText(value)
  return {
    ...redacted,
    redactionState: redacted.redactions > 0 ? 'redacted' : requestedState,
  }
}

export function isNativeProviderProjection(
  provider: string | null,
  metadata: Record<string, unknown>,
): boolean {
  if (provider === 'claude') {
    return metadata.provider_native === true
      || metadata.provider_native_schema === 'claude-agent-sdk-message'
  }
  return provider === 'codex'
    && typeof metadata.native_method === 'string'
    && typeof metadata.raw_payload_state === 'string'
}

export function isWithheldProviderReasoning(
  provider: string | null,
  metadata: Record<string, unknown>,
): boolean {
  if (provider === 'claude') {
    return metadata.native_block_type === 'thinking'
      || metadata.native_block_type === 'redacted_thinking'
      || metadata.delta_type === 'thinking_delta'
  }
  return provider === 'codex'
    && typeof metadata.native_method === 'string'
    && CODEX_WITHHELD_REASONING_METHODS.has(metadata.native_method)
}

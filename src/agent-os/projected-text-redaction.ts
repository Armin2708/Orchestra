export type ProjectedTextRedactionState = 'none' | 'redacted' | 'withheld'

const SECRET_PATTERNS: Array<{
  pattern: RegExp
  preservePrefix?: boolean
  valueCapture?: boolean
}> = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    pattern: /\b((?:authorization\s*[:=]\s*)?basic\s+)(\[REDACTED\](?:[A-Za-z0-9+/=]+)?|[A-Za-z0-9+/=]{8,})(?![A-Za-z0-9+/=])/gi,
    preservePrefix: true,
    valueCapture: true,
  },
  {
    pattern: /\b((?:authorization\s*[:=]\s*)?bearer\s+)(\[REDACTED\](?:[A-Za-z0-9._~+/=-]+)?|[A-Za-z0-9._~+/=-]{8,})/gi,
    preservePrefix: true,
    valueCapture: true,
  },
  {
    pattern: /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[a-z]-[A-Za-z0-9-]{16,})\b/gi,
  },
  {
    pattern: /\b((?:set-cookie|cookie)\s*:\s*)([^\r\n]+)/gi,
    preservePrefix: true,
    valueCapture: true,
  },
  {
    pattern: /\b((?:(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?(?:token|id)|auth[_-]?token|token|password|passwd|secret(?:[_-][A-Za-z0-9]+)*|private[_-]?key|client[_-]?secret|cookie|set[_-]?cookie))\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    preservePrefix: true,
    valueCapture: true,
  },
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
  for (const { pattern, preservePrefix, valueCapture } of SECRET_PATTERNS) {
    next = next.replace(pattern, (match, prefix: string | number | undefined, secret: string | number | undefined) => {
      const captured = valueCapture && typeof secret === 'string'
        ? secret.trim().replace(/^(['"])(.*)\1$/, '$2')
        : null
      if (captured === '[REDACTED]') return match
      redactions += 1
      return preservePrefix && typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'
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

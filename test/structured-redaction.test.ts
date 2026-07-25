import { describe, expect, it } from 'vitest'
import {
  MAX_STRUCTURED_REDACTION_DEPTH,
  REDACTED_STRUCTURED_VALUE,
  redactSensitiveText,
  redactStructuredValue,
} from '../src/agent-os/structured-redaction.js'

const pem = [
  '-----BEGIN PRIVATE KEY-----',
  'private-material-must-not-survive',
  '-----END PRIVATE KEY-----',
].join('\n')

describe('structured Agent Home redaction', () => {
  it('recursively redacts semantic keys and credential-shaped strings while preserving safe shape', () => {
    const source = {
      authorization: 'Basic dXNlcjpwYXNz',
      nested: {
        apiKey: 'camel-key-must-not-survive',
        apikey: 'compact-key-must-not-survive',
        auth: 'compact-auth-must-not-survive',
        'client-secret': 'hyphen-secret-must-not-survive',
        private_key_material: pem,
        note: 'Authorization: Basic Og==',
        cookieLine: 'Cookie: sid=cookie-must-not-survive',
        usage: {
          token_usage: {
            total_tokens: 144,
            input_tokens: 100,
            output_tokens: 44,
            cached_input_tokens: 30,
            last_total_tokens: null,
          },
          token_budget: 2_000,
          budget_tokens: null,
        },
      },
      array: [
        null,
        true,
        7,
        { refreshToken: 'array-token-must-not-survive' },
        `key material:\n${pem}`,
      ],
      tokens: ['short-token-xy12'],
      providerTokens: { primary: 'short-provider-token-xy13' },
      accessTokens: ['short-access-token-xy14'],
      apiKeys: ['short-api-key-xy15'],
      secrets: { primary: 'short-secret-xy16' },
      passwords: ['short-password-xy17'],
      cookies: ['short-cookie-xy18'],
      safe: {
        sessionId: 'session-safe',
        status: 'completed',
      },
    }

    const result = redactStructuredValue(source)
    const serialized = JSON.stringify(result.value)

    expect(result.changed).toBe(true)
    expect(result.redactions).toBeGreaterThanOrEqual(7)
    expect(result.value).toMatchObject({
      authorization: REDACTED_STRUCTURED_VALUE,
      nested: {
        apiKey: REDACTED_STRUCTURED_VALUE,
        apikey: REDACTED_STRUCTURED_VALUE,
        auth: REDACTED_STRUCTURED_VALUE,
        'client-secret': REDACTED_STRUCTURED_VALUE,
        private_key_material: REDACTED_STRUCTURED_VALUE,
        note: 'Authorization: Basic [REDACTED]',
        cookieLine: REDACTED_STRUCTURED_VALUE,
        usage: {
          token_usage: {
            total_tokens: 144,
            input_tokens: 100,
            output_tokens: 44,
            cached_input_tokens: 30,
            last_total_tokens: null,
          },
          token_budget: 2_000,
          budget_tokens: null,
        },
      },
      array: [
        null,
        true,
        7,
        { refreshToken: REDACTED_STRUCTURED_VALUE },
        'key material:\n[REDACTED]',
      ],
      tokens: REDACTED_STRUCTURED_VALUE,
      providerTokens: REDACTED_STRUCTURED_VALUE,
      accessTokens: REDACTED_STRUCTURED_VALUE,
      apiKeys: REDACTED_STRUCTURED_VALUE,
      secrets: REDACTED_STRUCTURED_VALUE,
      passwords: REDACTED_STRUCTURED_VALUE,
      cookies: REDACTED_STRUCTURED_VALUE,
      safe: {
        sessionId: 'session-safe',
        status: 'completed',
      },
    })
    for (const secret of [
      'camel-key-must-not-survive',
      'compact-key-must-not-survive',
      'compact-auth-must-not-survive',
      'hyphen-secret-must-not-survive',
      'private-material-must-not-survive',
      'cookie-must-not-survive',
      'array-token-must-not-survive',
      'Og==',
      'short-token-xy12',
      'short-provider-token-xy13',
      'short-access-token-xy14',
      'short-api-key-xy15',
      'short-secret-xy16',
      'short-password-xy17',
      'short-cookie-xy18',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('is byte-stable on an already redacted value and leaves benign Basic prose visible', () => {
    const first = redactStructuredValue({
      apiKey: 'first-secret',
      note: 'Authorization: Basic Og==',
      prose: 'This is a basic test of ordinary prose.',
    })
    const second = redactStructuredValue(first.value)

    expect(second).toEqual({
      value: first.value,
      redactions: 0,
      changed: false,
    })
    expect(second.value.prose).toBe('This is a basic test of ordinary prose.')
    for (const [source, expected] of [
      ['Basic Og==', 'Basic [REDACTED]'],
      ['Authorization: Basic Og', 'Authorization: Basic [REDACTED]'],
      ['Authorization: Basic YTo', 'Authorization: Basic [REDACTED]'],
      ['Authorization: Basic Og==.', 'Authorization: Basic [REDACTED].'],
      ['Authorization: Basic dXNlcjpwYXNz.', 'Authorization: Basic [REDACTED].'],
    ]) {
      expect(redactSensitiveText(source)).toMatchObject({
        value: expected,
        changed: true,
      })
    }
  })

  it('fails closed for cycles, excessive depth, and executable toJSON semantics', () => {
    const cyclic: Record<string, unknown> = { safe: true }
    cyclic.self = cyclic
    const cycleResult = redactStructuredValue(cyclic)
    expect(cycleResult).toMatchObject({
      changed: true,
      value: {
        safe: true,
        self: REDACTED_STRUCTURED_VALUE,
      },
    })

    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let index = 0; index <= MAX_STRUCTURED_REDACTION_DEPTH + 2; index += 1) {
      const child: Record<string, unknown> = {}
      cursor.next = child
      cursor = child
    }
    cursor.apiKey = 'deep-secret-must-not-survive'
    const deepResult = redactStructuredValue(deep)
    expect(JSON.stringify(deepResult.value)).not.toContain('deep-secret-must-not-survive')
    expect(deepResult.changed).toBe(true)

    const executable = {
      safe: 'visible',
      toJSON: () => ({ authorization: 'Basic dXNlcjpwYXNz' }),
    }
    const executableResult = redactStructuredValue(executable)
    expect(executableResult.value).toMatchObject({
      safe: 'visible',
      toJSON: REDACTED_STRUCTURED_VALUE,
    })
    expect(JSON.stringify(executableResult.value)).not.toContain('dXNlcjpwYXNz')
  })
})

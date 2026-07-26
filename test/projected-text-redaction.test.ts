import { describe, expect, it } from 'vitest'
import { redactProjectedText } from '../src/agent-os/projected-text-redaction.js'

describe('projected text redaction', () => {
  it.each([
    ['AWS_SECRET_ACCESS_KEY=plainsecretvalue123', 'AWS_SECRET_ACCESS_KEY=[REDACTED]'],
    ['CUSTOM_AUTH_TOKEN=plainsecretvalue123', 'CUSTOM_AUTH_TOKEN=[REDACTED]'],
    ['COOKIE=sessionid123456789', 'COOKIE=[REDACTED]'],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [REDACTED]'],
    ['Authorization: Basic dXNlcjpwYXNz.', 'Authorization: Basic [REDACTED].'],
    ['Authorization: Bearer top.secret.value', 'Authorization: Bearer [REDACTED]'],
    ['Authorization: Bearer [REDACTED].rawsecret123456', 'Authorization: Bearer [REDACTED]'],
    ['Authorization: Basic [REDACTED]rawsecret123456', 'Authorization: Basic [REDACTED]'],
    ['Cookie: session=sessionid123456789; theme=dark', 'Cookie: [REDACTED]'],
    ['Cookie: masked=[REDACTED]; sid=rawsecret123456', 'Cookie: [REDACTED]'],
    ['API_KEY="[REDACTED] rawsecret123456"', 'API_KEY=[REDACTED]'],
  ])('redacts common credential form %s', (input, expected) => {
    expect(redactProjectedText(input)).toEqual({ value: expected, redactions: 1 })
  })

  it('redacts a complete PEM block before processing its assignment prefix', () => {
    const pem = [
      'PRIVATE_KEY=-----BEGIN PRIVATE KEY-----',
      'raw-private-key-body-must-not-survive',
      '-----END PRIVATE KEY-----',
    ].join('\n')
    expect(redactProjectedText(pem)).toEqual({
      value: 'PRIVATE_KEY=[REDACTED]',
      redactions: 1,
    })
  })

  it('does not hide ordinary prose that merely discusses secrets or token budgets', () => {
    const text = 'The secret of reliable systems is testing; token budget is 1200; secretary=Alice; secretSauce=tomato.'
    expect(redactProjectedText(text)).toEqual({ value: text, redactions: 0 })
  })
})

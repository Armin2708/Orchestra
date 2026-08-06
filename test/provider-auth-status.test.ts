import { describe, expect, it } from 'vitest'
import { providerLoginCommand, readProviderAuthStatus } from '../src/provider-auth-status.js'

const withOutput = (output: string | null) => ({ run: () => output })

describe('provider auth status', () => {
  it('reads Claude authenticated state and its non-secret account label', () => {
    const state = readProviderAuthStatus('claude', '/bin/claude', withOutput(
      JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'operator@example.com' }),
    ))
    expect(state.status).toBe('authenticated')
    expect(state.account).toBe('operator@example.com')
    expect(state.method).toBe('claude.ai')
  })

  it('reads Claude signed-out state without leaking an account', () => {
    const state = readProviderAuthStatus('claude', '/bin/claude', withOutput(JSON.stringify({ loggedIn: false })))
    expect(state.status).toBe('signed_out')
    expect(state.account).toBeNull()
  })

  // Codex prints to stderr and can exit non-zero; both must still be understood.
  it('reads Codex authenticated state from its banner text', () => {
    const state = readProviderAuthStatus('codex', '/bin/codex', withOutput('Logged in using ChatGPT'))
    expect(state.status).toBe('authenticated')
    expect(state.method).toBe('ChatGPT')
  })

  it('reads Codex signed-out state', () => {
    expect(readProviderAuthStatus('codex', '/bin/codex', withOutput('Not logged in')).status).toBe('signed_out')
  })

  it('reports unknown when the CLI is not installed', () => {
    const state = readProviderAuthStatus('claude', null)
    expect(state.status).toBe('unknown')
    expect(state.detail).toMatch(/not installed/)
  })

  it('reports unknown — never signed_out — when the probe fails', () => {
    const state = readProviderAuthStatus('claude', '/bin/claude', withOutput(null))
    expect(state.status).toBe('unknown')
    expect(state.detail).toMatch(/probe failed/)
  })

  it('never surfaces a token or key from the probe output', () => {
    const state = readProviderAuthStatus('claude', '/bin/claude', withOutput(
      JSON.stringify({ loggedIn: true, authMethod: 'api key', email: 'a@b.c', apiKey: 'sk-secret-value' }),
    ))
    expect(JSON.stringify(state)).not.toContain('sk-secret-value')
  })

  it('exposes the native login command per provider', () => {
    expect(providerLoginCommand('claude')).toBe('claude /login')
    expect(providerLoginCommand('codex')).toBe('codex login')
    expect(providerLoginCommand('nope')).toBeNull()
  })
})

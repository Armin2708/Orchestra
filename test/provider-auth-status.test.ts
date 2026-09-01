import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { providerLoginCommand, readProviderAuthStatus } from '../src/provider-auth-status.js'

const withOutput = (output: string | null) => ({ run: () => output })

const withQwenHome = (settings: Record<string, unknown> | null, fn: () => void): void => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-qwen-home-'))
  if (settings) {
    fs.mkdirSync(path.join(home, '.qwen'))
    fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify(settings))
  }
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
}

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
    expect(providerLoginCommand('qwen')).toBe('qwen')
    expect(providerLoginCommand('opencode')).toBe('opencode auth login')
    expect(providerLoginCommand('nope')).toBeNull()
  })

  // OpenCode's readiness depends on whichever upstream provider(s) the user
  // configured, not a single vendor credential — this pass reports 'unknown'
  // honestly rather than parsing unverified CLI output, matching the provider
  // adapter's own readiness probe (`auth_status: 'unknown'`).
  it('reports OpenCode auth as unknown rather than guessing from unverified CLI output', () => {
    const state = readProviderAuthStatus('opencode', '/bin/opencode', withOutput('opencode 1.18.25'))
    expect(state.status).toBe('unknown')
    expect(state.account).toBeNull()
    expect(state.login_command).toBe('opencode auth login')
  })

  it('reads Qwen auth from the CLI-selected provider profile without touching keys', () => {
    withQwenHome({
      security: { auth: { selectedType: 'openai', apiKey: { envKey: 'DASHSCOPE_API_KEY', value: 'sk-secret' } } },
    }, () => {
      const state = readProviderAuthStatus('qwen', '/bin/qwen', withOutput('qwen 0.21.6'))
      expect(state.status).toBe('authenticated')
      expect(state.method).toBe('qwen_settings:openai')
      expect(JSON.stringify(state)).not.toContain('sk-secret')
    })
  })

  it('treats a Qwen CLI without a selected profile as signed out', () => {
    withQwenHome({ security: { auth: {} } }, () => {
      const state = readProviderAuthStatus('qwen', '/bin/qwen', withOutput('qwen 0.21.6'))
      expect(state.status).toBe('signed_out')
    })
    withQwenHome(null, () => {
      const state = readProviderAuthStatus('qwen', '/bin/qwen', withOutput('qwen 0.21.6'))
      expect(state.status).toBe('signed_out')
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  accessProfileFromLegacyPermission,
  hasAgentCapability,
  providerLabel,
  providerLaunchBody,
  providerTokenSummary,
  resolveAccessProfile,
} from '../web/src/agentProviderUi.js'

describe('provider-aware agent UI helpers', () => {
  it('keeps launch defaults server-side and sends only explicit overrides', () => {
    expect(providerLaunchBody()).toEqual({})
    expect(providerLaunchBody('')).toEqual({})
    expect(providerLaunchBody('codex')).toEqual({ provider: 'codex' })
    expect(providerLaunchBody(' codex ', ' gpt-5.4 ', ' ultra ', 'workspace_write')).toEqual({
      provider: 'codex',
      model: 'gpt-5.4',
      effort: 'ultra',
      access_profile: 'workspace_write',
    })
  })

  it('labels built-in and custom providers without leaking provider-specific copy', () => {
    expect(providerLabel()).toBe('Claude')
    expect(providerLabel('codex')).toBe('Codex')
    expect(providerLabel('local-agent')).toBe('Local Agent')
  })

  it('gates controls from canonical capabilities and accepted aliases', () => {
    expect(hasAgentCapability(['access_profile', 'model', 'effort', 'approvals'], 'model', 'codex')).toBe(true)
    expect(hasAgentCapability(['reasoningEffort'], 'effort', 'codex')).toBe(true)
    expect(hasAgentCapability(['inlineApprovals'], 'approvals', 'codex')).toBe(true)
    expect(hasAgentCapability({ model: true, effort: false }, 'model', 'codex')).toBe(true)
    expect(hasAgentCapability({ model: true, effort: false }, 'effort', 'codex')).toBe(false)
    expect(hasAgentCapability([], 'model', 'codex')).toBe(false)
    expect(hasAgentCapability(undefined, 'model', 'codex')).toBe(false)
    expect(hasAgentCapability(undefined, 'model', 'claude')).toBe(true)
  })

  it('maps legacy Claude permission modes into neutral access profiles', () => {
    expect(accessProfileFromLegacyPermission('plan')).toBe('read_only')
    expect(accessProfileFromLegacyPermission('acceptEdits')).toBe('workspace_write')
    expect(accessProfileFromLegacyPermission('bypassPermissions')).toBe('full_access')
    expect(resolveAccessProfile('read_only', 'bypassPermissions')).toBe('read_only')
  })

  it('preserves additive Claude cache accounting', () => {
    expect(providerTokenSummary('claude', [{
      input_tokens: 100,
      cache_read: 50,
      cache_creation: 20,
      output_tokens: 10,
    }])).toEqual({
      input: 100,
      inputTotal: 170,
      cached: 50,
      cacheWrite: 20,
      output: 10,
      reasoningOutput: 0,
      total: 180,
      cachedPercent: 29,
    })
  })

  it('does not double-count cached Codex input', () => {
    expect(providerTokenSummary('codex', [{
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 10,
      reasoning_output_tokens: 4,
    }])).toEqual({
      input: 100,
      inputTotal: 100,
      cached: 50,
      cacheWrite: 0,
      output: 10,
      reasoningOutput: 4,
      total: 110,
      cachedPercent: 50,
    })
  })

  it('uses provider totals per usage segment without dropping a live turn', () => {
    const summary = providerTokenSummary('codex', [
      { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, totalTokens: 120 },
      { inputTokens: 25, cachedInputTokens: 5, outputTokens: 7 },
    ])
    expect(summary.total).toBe(152)
    expect(summary.inputTotal).toBe(125)
    expect(summary.cached).toBe(65)
  })
})

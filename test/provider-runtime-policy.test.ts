import { describe, expect, it } from 'vitest'
import {
  PROVIDER_CAPABILITY_IDS,
  type ProviderExecutionModeV1,
} from '../src/provider-contract.js'
import { FIRST_RELEASE_PROVIDER_MANIFESTS_V1 } from '../src/provider-manifests.js'
import {
  evaluateProviderRuntimeOperation,
  executeBoundedProviderControl,
} from '../src/agent-os/provider-runtime-policy.js'

const mode = (overrides: Partial<ProviderExecutionModeV1> = {}): ProviderExecutionModeV1 => ({
  id: 'synthetic-policy-fixture',
  runtime_mode: 'native_cli',
  billing_mode: 'personal_subscription',
  credential_kinds: ['provider_account_session'],
  default_credential_kind: 'provider_account_session',
  priority: 'primary',
  support: { state: 'supported' },
  automation_policy: 'allowed',
  usage_priced_api_consent_required: false,
  overage: { behavior: 'none', explicit_consent_required: false },
  capabilities: Object.fromEntries(PROVIDER_CAPABILITY_IDS.map((id) => [
    id,
    { state: 'supported' as const },
  ])) as ProviderExecutionModeV1['capabilities'],
  ...overrides,
})

describe('provider runtime operation policy', () => {
  it('keeps cancel and stop semantics explicit instead of silently substituting them', () => {
    const selected = mode()
    selected.capabilities.cancel = {
      state: 'unsupported',
      reason_code: 'native_cancel_unavailable',
    }

    expect(evaluateProviderRuntimeOperation({ operation: 'cancel', mode: selected })).toEqual({
      state: 'unsupported',
      operation: 'cancel',
      reason_code: 'native_cancel_unavailable',
      supported_alternative: 'stop',
    })
    expect(evaluateProviderRuntimeOperation({
      operation: 'timeout',
      mode: selected,
      elapsedMs: 5_000,
      timeoutMs: 5_000,
      method: 'stop',
    })).toMatchObject({ state: 'allowed', operation: 'timeout', method: 'stop' })
  })

  it('enforces retry budgets, strategy capabilities, and automation policy', () => {
    expect(evaluateProviderRuntimeOperation({
      operation: 'retry', mode: mode(), executionScope: 'managed_background',
      strategy: 'new_session', attempts: 2, maxAttempts: 2,
    })).toMatchObject({ state: 'exhausted', reason_code: 'retry_budget_exhausted' })

    const interactiveOnly = mode({ automation_policy: 'interactive_only' })
    expect(evaluateProviderRuntimeOperation({
      operation: 'retry', mode: interactiveOnly, executionScope: 'managed_background',
      strategy: 'new_session', attempts: 1, maxAttempts: 2,
    })).toMatchObject({ state: 'policy_blocked', reason_code: 'automation_interactive_only' })

    interactiveOnly.capabilities.resume = {
      state: 'unsupported',
      reason_code: 'resume_not_implemented',
    }
    expect(evaluateProviderRuntimeOperation({
      operation: 'retry', mode: interactiveOnly, executionScope: 'interactive',
      strategy: 'resume_session', attempts: 1, maxAttempts: 2,
    })).toMatchObject({ state: 'unsupported', reason_code: 'resume_not_implemented' })
  })

  it('counts quarantined cleanup against capacity', () => {
    expect(evaluateProviderRuntimeOperation({
      operation: 'capacity', mode: mode(), activeSessions: 2, quarantinedSessions: 1, capacity: 3,
    })).toMatchObject({ state: 'at_capacity', reason_code: 'provider_session_capacity_exceeded' })
    expect(evaluateProviderRuntimeOperation({
      operation: 'capacity', mode: mode(), activeSessions: 1, quarantinedSessions: 1, capacity: 3,
    })).toMatchObject({ state: 'allowed', method: 'reserve' })
  })

  it('fails closed with visible reasons for every declared first-release provider mode', () => {
    expect(FIRST_RELEASE_PROVIDER_MANIFESTS_V1.map((manifest) => {
      const selected = manifest.modes.find((candidate) => candidate.priority === 'primary')!
      const decision = evaluateProviderRuntimeOperation({ operation: 'cancel', mode: selected })
      return {
        provider: manifest.provider_id,
        mode: selected.id,
        state: decision.state,
        reason: 'reason_code' in decision ? decision.reason_code : null,
      }
    })).toEqual([
      {
        provider: 'claude',
        mode: 'native_subscription',
        state: 'policy_blocked',
        reason: 'third_party_subscription_routing_prohibited',
      },
      {
        provider: 'codex',
        mode: 'native_subscription',
        state: 'unsupported',
        reason: 'subscription_guard_not_integrated',
      },
      {
        provider: 'qwen',
        mode: 'native_subscription',
        state: 'unsupported',
        reason: 'subscription_guard_not_integrated',
      },
      {
        provider: 'kimi',
        mode: 'native_subscription',
        state: 'unsupported',
        reason: 'managed_adapter_not_implemented',
      },
      {
        provider: 'opencode',
        mode: 'native_subscription',
        state: 'unsupported',
        reason: 'acceptance_harness_not_run',
      },
    ])
  })

  it('quarantines capacity when a native control fails or times out', async () => {
    expect(await executeBoundedProviderControl(
      async () => { throw new Error('native control rejected') },
      100,
    )).toEqual({
      state: 'unconfirmed',
      reason_code: 'provider_control_failed',
      detail: 'native control rejected',
      capacityDisposition: 'quarantine',
    })

    const pending = new Promise<void>(() => {})
    expect(await executeBoundedProviderControl(() => pending, 5)).toMatchObject({
      state: 'unconfirmed',
      reason_code: 'provider_control_timeout',
      capacityDisposition: 'quarantine',
    })
  })
})

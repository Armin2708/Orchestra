import { describe, expect, it } from 'vitest'
import { highestSubscriptionUsage, subscriptionUsage } from '../web/src/providerUsage.js'
import type { SystemInfo } from '../web/src/api.js'

const system = (): SystemInfo => ({
  hardware: { cores: 8, total_gb: 32, capacity: 4 },
  hired: 1,
  usage: {
    five_hour: { utilization: 12, resets_at: '2026-07-19T20:30:00Z' },
    seven_day: { utilization: 53, resets_at: '2026-07-24T23:00:00Z' },
  },
  providers: [{
    id: 'codex',
    name: 'Codex',
    auth: { status: 'authenticated', account: 'ChatGPT · pro' },
    usage: {
      updated_at: '2026-07-19T20:00:00Z',
      rate_limits: {
        current: {
          limit_id: 'codex', limit_name: null,
          primary: { usedPercent: 45, windowDurationMins: 10_080, resetsAt: 1_785_061_645 },
        },
        by_limit: {
          codex: {
            limit_id: 'codex', limit_name: null,
            primary: { usedPercent: 45, windowDurationMins: 10_080, resetsAt: 1_785_061_645 },
          },
          codex_bengalfox: {
            limit_id: 'codex_bengalfox', limit_name: 'GPT-5.3-Codex-Spark',
            primary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: 1_785_088_538 },
          },
        },
        reset_credits_available: 3,
      },
      usage: { summary: { lifetimeTokens: 6_728_418_582 } },
    },
  }],
})

describe('subscription usage projection', () => {
  it('combines Claude and every deduplicated Codex subscription limit', () => {
    const providers = subscriptionUsage(system())
    expect(providers).toHaveLength(2)
    expect(providers[0]).toMatchObject({
      id: 'claude',
      windows: [{ label: '5h', used: 12 }, { label: 'week', used: 53 }],
    })
    expect(providers[1]).toMatchObject({
      id: 'codex',
      account: 'ChatGPT · pro',
      lifetimeTokens: 6_728_418_582,
      resetCredits: 3,
      windows: [
        { id: 'codex:primary', label: 'week', used: 45 },
        { id: 'codex_bengalfox:primary', label: 'GPT-5.3-Codex-Spark · week', used: 4 },
      ],
    })
    expect(highestSubscriptionUsage(providers)).toBe(53)
  })

  it('keeps unavailable and stale subscription state explicit', () => {
    const unavailable = system()
    unavailable.usage = null
    unavailable.usage_error = 'keychain'
    const codex = unavailable.providers![0].usage as Record<string, unknown>
    codex.stale = true
    const providers = subscriptionUsage(unavailable)
    expect(providers[0]).toMatchObject({ id: 'claude', detail: 'Usage unavailable (keychain)', windows: [] })
    expect(providers[1]).toMatchObject({ id: 'codex', stale: true })
  })
})

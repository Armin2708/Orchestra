import { describe, expect, it } from 'vitest'
import { rateLimitSummary } from '../src/codex/provider-acceptance.js'
import type { CodexRateLimitsResponse } from '../src/codex/protocol.js'

const limits = (spendControlReached: boolean | null): CodexRateLimitsResponse => ({
  rateLimits: {
    limitId: 'codex',
    limitName: 'Codex',
    primary: {
      usedPercent: 12,
      windowDurationMins: 300,
      resetsAt: null,
    },
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached,
    planType: 'plus',
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
})

describe('Codex provider acceptance rate-limit evidence', () => {
  it('records backend spend control and classifies it as exhausted', () => {
    expect(rateLimitSummary(limits(true))).toMatchObject({
      snapshot_count: 1,
      spend_control_reached: true,
      exhausted: true,
      plan_types: ['plus'],
    })
  })

  it('does not report spend control when the backend has not reached it', () => {
    expect(rateLimitSummary(limits(false))).toMatchObject({
      spend_control_reached: false,
      exhausted: false,
    })
  })
})

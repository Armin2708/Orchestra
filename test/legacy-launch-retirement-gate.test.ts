import { describe, expect, it } from 'vitest'
import {
  evaluateLegacyLaunchRetirement,
  type LegacyLaunchRetirementEvidence,
} from '../src/agent-os/legacy-launch-retirement-gate.js'

const sourceCommit = 'a'.repeat(40)

const evidence = (): LegacyLaunchRetirementEvidence => ({
  sourceCommit,
  observationThrough: '2026-08-14',
  daily: Array.from({ length: 14 }, (_, index) => ({
    utcDate: `2026-08-${String(index + 1).padStart(2, '0')}`,
    sealed: true,
    coverageComplete: true,
    canonicalLaunches: 3,
    legacyLaunchWrites: 0,
    telemetryFailures: 0,
    telemetryMismatches: 0,
  })),
  rollback: {
    sourceCommit,
    testedAt: '2026-08-14T23:00:00.000Z',
    artifactSha256: 'b'.repeat(64),
    restoredCompatibilityWrites: true,
    preservedCanonicalRows: true,
    integrityCheckPassed: true,
  },
})

describe('ORC-020 legacy launch retirement gate', () => {
  it('fails closed without observed zero-usage telemetry and rollback evidence', () => {
    const missing = evidence()
    missing.daily = []
    missing.rollback = null
    expect(evaluateLegacyLaunchRetirement(missing)).toMatchObject({
      eligible: false,
      reason_code: 'observation_window_incomplete',
    })
  })

  it('refuses zero traffic, unsealed days, telemetry errors, and any legacy write', () => {
    for (const [mutate, reason] of [
      [(value: LegacyLaunchRetirementEvidence) => { value.daily[0]!.canonicalLaunches = 0; for (const day of value.daily) day.canonicalLaunches = 0 }, 'canonical_launches_unobserved'],
      [(value: LegacyLaunchRetirementEvidence) => { value.daily[4]!.sealed = false }, 'telemetry_not_sealed'],
      [(value: LegacyLaunchRetirementEvidence) => { value.daily[4]!.telemetryFailures = 1 }, 'telemetry_unhealthy'],
      [(value: LegacyLaunchRetirementEvidence) => { value.daily[4]!.legacyLaunchWrites = 1 }, 'legacy_usage_observed'],
    ] as const) {
      const candidate = evidence()
      mutate(candidate)
      expect(evaluateLegacyLaunchRetirement(candidate)).toMatchObject({
        eligible: false,
        reason_code: reason,
      })
    }
  })

  it('authorizes retirement only for a consecutive exact-source window and valid rollback', () => {
    expect(evaluateLegacyLaunchRetirement(evidence())).toEqual({
      eligible: true,
      reason_code: 'zero_usage_and_rollback_proven',
      observedDays: 14,
      canonicalLaunches: 42,
    })

    const mismatch = evidence()
    mismatch.rollback = { ...mismatch.rollback!, sourceCommit: 'c'.repeat(40) }
    expect(evaluateLegacyLaunchRetirement(mismatch)).toMatchObject({
      eligible: false,
      reason_code: 'rollback_source_mismatch',
    })
  })
})

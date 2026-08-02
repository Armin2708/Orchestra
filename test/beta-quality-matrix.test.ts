import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROOT,
  evaluateBetaQualityMatrix,
} from '../scripts/check-beta-quality-matrix.mjs'

describe('beta quality coverage contract', () => {
  it('verifies every current-base evidence anchor and keeps future lane symbols fail-closed', () => {
    const result = evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'current-base' })

    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.covered).toHaveLength(24)
    expect(result.unresolved).toEqual(expect.arrayContaining([
      { item: 'QA-001', case: 'discussion-lifecycle', lane: 'A' },
      { item: 'QA-012', case: 'step-up-binding-and-replay', lane: 'C' },
      { item: 'QA-016', case: 'network-loss-recovery', lane: 'C' },
      { item: 'QA-018', case: 'integrator-final-evidence', lane: 'D' },
    ]))
  })

  it('refuses beta release while any required lane evidence is unresolved', () => {
    const result = evaluateBetaQualityMatrix({ root: DEFAULT_ROOT, mode: 'release' })

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('QA-012/pairing-single-use-origin-expiry'),
      expect.stringContaining('QA-016/network-loss-recovery'),
      expect.stringContaining('QA-018/integrator-final-evidence'),
    ]))
  })
})

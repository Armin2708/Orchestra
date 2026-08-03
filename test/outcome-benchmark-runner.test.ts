import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  evaluateBenchmarkPair,
  runOutcomeBenchmark,
  validateBenchmarkOutcome,
} from '../scripts/outcome-benchmark.mjs'

const outcome = (overrides: Record<string, unknown> = {}) => ({
  accepted: true,
  accepted_deliveries: 1,
  quality_milli: 900,
  provider_tokens: 1_000,
  context_tokens: 100,
  duration_ms: 5_000,
  repeated_exploration_steps: 8,
  ...overrides,
})

describe('controlled outcome benchmark runner', () => {
  it('runs a frozen pair and preserves the representative-gate boundary', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const report = runOutcomeBenchmark({
      schema_version: 1,
      suite_key: 'knowledge-context',
      source_commit: head,
      scenarios: [{
        scenario_key: 'focused-change',
        objective: 'Make one focused verified change.',
        acceptance_criteria: ['Focused tests pass.'],
        provider: 'codex',
        model: 'gpt-5',
        seed: 'fixed-seed',
        command: ['unused'],
      }],
    }, {
      repositoryRoot: process.cwd(),
      runVariant: (_scenario: unknown, variant: string) => ({
        outcome: variant === 'before' ? outcome() : outcome({
          quality_milli: 910,
          provider_tokens: 700,
          context_tokens: 50,
          repeated_exploration_steps: 3,
        }),
        evidence_sha256: variant === 'before' ? 'a'.repeat(64) : 'b'.repeat(64),
      }),
    })
    expect(report).toMatchObject({
      passed: true,
      representative_evidence_observed: false,
      gate_claimed: false,
      scenario_count: 1,
    })
    expect(report.scenarios[0].comparison).toMatchObject({
      quality_preserved: true,
      token_efficiency_improved: true,
      passed: true,
    })
    expect(report.report_sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('fails when lower tokens accompany lower quality or fewer accepted deliveries', () => {
    expect(evaluateBenchmarkPair(outcome(), outcome({
      quality_milli: 899,
      provider_tokens: 100,
    }))).toMatchObject({ passed: false, quality_preserved: false })
    expect(evaluateBenchmarkPair(outcome({ accepted_deliveries: 2 }), outcome({
      accepted_deliveries: 1,
      provider_tokens: 100,
    }))).toMatchObject({ passed: false, quality_preserved: false })
  })

  it('rejects extra fields so raw prompts, output, and identity data cannot enter evidence', () => {
    expect(() => validateBenchmarkOutcome({ ...outcome(), raw_output: 'secret' }))
      .toThrow(/field is not allowed/)
  })
})

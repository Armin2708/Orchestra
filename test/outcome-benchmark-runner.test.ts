import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const withRepository = (run: (repositoryRoot: string, head: string) => void) => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'orchestra-outcome-benchmark-test-'))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
    writeFileSync(join(repositoryRoot, 'tracked.txt'), 'committed\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repositoryRoot })
    execFileSync('git', [
      '-c', 'user.name=Orchestra Test',
      '-c', 'user.email=orchestra-test@example.invalid',
      'commit', '--quiet', '-m', 'fixture',
    ], { cwd: repositoryRoot })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim()
    run(repositoryRoot, head)
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true })
  }
}

const manifest = (sourceCommit: string) => ({
  schema_version: 1,
  suite_key: 'knowledge-context',
  source_commit: sourceCommit,
  scenarios: [{
    scenario_key: 'focused-change',
    objective: 'Make one focused verified change.',
    acceptance_criteria: ['Focused tests pass.'],
    provider: 'codex',
    model: 'gpt-5',
    seed: 'fixed-seed',
    command: ['unused'],
  }],
})

describe('controlled outcome benchmark runner', () => {
  it('runs a frozen pair and preserves the representative-gate boundary', () => {
    withRepository((repositoryRoot, head) => {
      const report = runOutcomeBenchmark(manifest(head), {
        repositoryRoot,
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
  })

  it('rejects a dirty tracked source before executing either variant', () => {
    withRepository((repositoryRoot, head) => {
      writeFileSync(join(repositoryRoot, 'tracked.txt'), 'adversarial change\n')
      let variantCalls = 0
      expect(() => runOutcomeBenchmark(manifest(head), {
        repositoryRoot,
        runVariant: () => {
          variantCalls += 1
          return { outcome: outcome(), evidence_sha256: 'a'.repeat(64) }
        },
      })).toThrow('benchmark source has tracked changes')
      expect(variantCalls).toBe(0)
    })
  })

  it('rejects a benchmark command that dirties tracked source before reporting', () => {
    withRepository((repositoryRoot, head) => {
      expect(() => runOutcomeBenchmark(manifest(head), {
        repositoryRoot,
        runVariant: (_scenario: unknown, variant: string) => {
          if (variant === 'after') {
            writeFileSync(join(repositoryRoot, 'tracked.txt'), 'mutated by benchmark\n')
          }
          return { outcome: outcome(), evidence_sha256: 'a'.repeat(64) }
        },
      })).toThrow('benchmark source has tracked changes')
    })
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

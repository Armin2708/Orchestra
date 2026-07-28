import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  aggregateRuntimeRuns,
  BASELINE_SCHEMA_VERSION,
  directorySummary,
  percentile,
  summarizeSamples,
  summarizeVitestReport,
  validateBaseline,
} from '../scripts/capture-agent-os-baseline.mjs'

const root = join(import.meta.dirname, '..')
const source = readFileSync(
  join(root, 'scripts/capture-agent-os-baseline.mjs'),
  'utf8',
)

describe('BASE-008 baseline capture harness', () => {
  it('uses deterministic nearest-rank sample summaries', () => {
    expect(BASELINE_SCHEMA_VERSION).toBe(1)
    expect(percentile([9, 1, 5, 3], 0.5)).toBe(3)
    expect(percentile([9, 1, 5, 3], 0.95)).toBe(9)
    expect(summarizeSamples([1, 2, 3, 4])).toEqual({
      samples: 4,
      min: 1,
      mean: 2.5,
      p50: 2,
      p95: 4,
      p99: 4,
      max: 4,
    })
    expect(summarizeVitestReport({
      numTotalTestSuites: 4,
      numPassedTestSuites: 4,
      numFailedTestSuites: 0,
      numTotalTests: 3,
      numPassedTests: 3,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{ status: 'passed' }, { status: 'passed' }],
    })).toEqual({
      test_files: 2,
      passed_test_files: 2,
      failed_test_files: 0,
      tests: 3,
      passed_tests: 3,
      failed_tests: 0,
      pending_tests: 0,
      todo_tests: 0,
    })
  })

  it('rejects an incomplete or unauditable snapshot', () => {
    expect(validateBaseline({})).toEqual(expect.arrayContaining([
      'schema_version must be 1',
      'backlog_item must be BASE-008',
      'status must be observed',
      'source.commit must be a full Git SHA',
      'source tree was not clean before capture',
      'package smoke did not pass',
      'runtime requires at least three cold-start runs',
      'token totals do not prove a reduction',
    ]))
  })

  it('summarizes nested build artifacts on the host path separator', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentboard-baseline-summary-'))
    try {
      mkdirSync(join(directory, 'nested'))
      writeFileSync(join(directory, 'nested', 'artifact.txt'), 'alpha')
      const summary = directorySummary(directory)
      expect(summary).toMatchObject({
        files: 1,
        bytes: 5,
      })
      expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('aggregates every loopback latency sample without serializing raw samples', () => {
    const observedRuns = [1, 2, 3].map((run) => ({
      run,
      startup_ms: run * 10,
      ready_rss_bytes: run * 100,
      ready_virtual_bytes: run * 1_000,
      health_requests: 2,
      health_failures: 0,
      health_latency_ms: summarizeSamples([run, run + 3]),
      health_latency_samples_ms: [run, run + 3],
      graceful_shutdown: true,
      exit_code: 0,
      exit_signal: null,
    }))
    const aggregate = aggregateRuntimeRuns(observedRuns)

    expect(aggregate.health_latency_ms).toEqual({
      samples: 6,
      min: 1,
      mean: 3.5,
      p50: 3,
      p95: 6,
      p99: 6,
      max: 6,
      requests: 6,
      failures: 0,
      aggregation: 'all sequential loopback request samples',
    })
    expect(aggregate.runs).toHaveLength(3)
    expect(aggregate.runs.every((run) => !('health_latency_samples_ms' in run))).toBe(true)
  })

  it('keeps capture exact, credential-free, and disposable', () => {
    expect(source).toContain("['status', '--porcelain', '--untracked-files=no']")
    expect(source).toContain("if (head !== sourceCommit)")
    expect(source).toContain("throw new Error('tracked source tree changed during capture')")
    expect(source).toContain("npm_config_userconfig: join(tempRoot, 'empty-npmrc')")
    expect(source).toContain("ORCHESTRA_CODEX_COMMAND: join(runtimeHome, 'intentionally-missing-codex')")
    expect(source).toContain("ORCHESTRA_NO_AUTH: '1'")
    expect(source).toContain("rmSync(runtimeHome, { recursive: true, force: true })")
    expect(source).toContain('real provider token evidence remains gated by TOOL-014 acceptance')
  })
})

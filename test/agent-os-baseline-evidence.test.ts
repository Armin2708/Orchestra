import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateBaseline } from '../scripts/capture-agent-os-baseline.mjs'

const root = join(import.meta.dirname, '..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')
const baseline = JSON.parse(read('docs/agent-os-current-baseline.json')) as any
const sourceCommit = '51b168d96becccd4aa3506dec9e80fcebda43ed7'
const sourceTree = '50cb9c7c9062bf3f25701a6dff66fee3d34befd0'

describe('BASE-008 exact engineering baseline evidence', () => {
  it('validates the observed snapshot against its immutable source commit', () => {
    expect(validateBaseline(baseline)).toEqual([])
    expect(baseline.source.commit).toBe(sourceCommit)
    expect(baseline.source.tree).toBe(sourceTree)
    expect(execFileSync(
      'git',
      ['rev-parse', `${sourceCommit}^{tree}`],
      { cwd: root, encoding: 'utf8' },
    ).trim()).toBe(sourceTree)
    expect(baseline.source.tracked_clean_before_capture).toBe(true)
    expect(baseline.source.environment_files_present).toEqual([])
  })

  it('records complete test, build, package, runtime, and token measurements', () => {
    for (const mode of ['default_parallel', 'serial']) {
      expect(baseline.tests[mode]).toMatchObject({
        passed: true,
        test_files: 146,
        passed_test_files: 146,
        failed_test_files: 0,
        tests: 1199,
        passed_tests: 1199,
        failed_tests: 0,
      })
    }
    expect(baseline.builds.root_production.output).toMatchObject({
      files: 1,
      bytes: 1_807_439,
    })
    expect(baseline.builds.web_production.output).toMatchObject({
      files: 16,
      bytes: 995_285,
    })
    expect(baseline.package).toMatchObject({
      passed: true,
      bytes: 680_660,
      unpacked_bytes: 3_051_963,
      file_count: 37,
      install_smoke: { passed: true, scripts_disabled: true, cli_version: '0.1.0' },
    })
    expect(baseline.runtime.runs).toHaveLength(3)
    expect(baseline.runtime.health_latency_ms).toMatchObject({
      samples: 300,
      requests: 300,
      failures: 0,
      p50: 0.25,
      p95: 0.698,
      p99: 1.174,
      aggregation: 'all sequential loopback request samples',
    })
    expect(baseline.runtime.runs.every(
      (run: any) => run.health_requests === 100
        && run.health_failures === 0
        && run.graceful_shutdown === true,
    )).toBe(true)
    expect(baseline.token_usage).toMatchObject({
      passed: true,
      verbose: { chars: 3609, tokens: 903, count: 5 },
      compact: { chars: 1795, tokens: 449, count: 5 },
      reduction_pct: 50.3,
      output_rules_cost: { chars: 130, tokens: 33 },
      compliance: { passed: 11, total: 11 },
      provider_native_completion_tokens: { measured: false },
    })
  })

  it('fails closed when exactness or a required evidence family is tampered', () => {
    const cases: Array<[(copy: any) => void, string]> = [
      [(copy) => { copy.source.tracked_clean_before_capture = false },
        'source tree was not clean before capture'],
      [(copy) => { copy.package.passed = false }, 'package smoke did not pass'],
      [(copy) => { copy.runtime.runs.pop() }, 'runtime requires at least three cold-start runs'],
      [(copy) => { copy.runtime.health_latency_ms.samples -= 1 },
        'runtime health latency aggregation is incomplete'],
      [(copy) => { copy.token_usage.compact.tokens = copy.token_usage.verbose.tokens },
        'token totals do not prove a reduction'],
    ]

    for (const [tamper, expectedError] of cases) {
      const copy = structuredClone(baseline)
      tamper(copy)
      expect(validateBaseline(copy)).toContain(expectedError)
    }
  })

  it('keeps the human record, package, README, and reconciliation aligned', () => {
    const document = read('docs/agent-os-current-baseline.md')
    const tokenDiet = read('docs/token-diet.md')
    const readme = read('README.md')
    const program = read('docs/north-star-delivery-program.md')
    const manifest = JSON.parse(read('package.json')) as { files?: string[] }

    for (const marker of [
      sourceCommit,
      '146 / 146 files; 1,199 / 1,199 tests',
      '724.909',
      '0.698',
      '903',
      '449',
      '50.3%',
      'TOOL-014',
    ]) {
      expect(document).toContain(marker)
    }
    expect(tokenDiet).toContain('**903**')
    expect(tokenDiet).toContain('**449**')
    expect(tokenDiet).toContain('**50.3%**')
    expect(readme).toContain('(docs/agent-os-current-baseline.md)')
    expect(manifest.files).toEqual(expect.arrayContaining([
      'docs/agent-os-current-baseline.json',
      'docs/agent-os-current-baseline.md',
    ]))
    const reconciliation = program.match(
      /strict master reconciliation is \*\*(\d+) \/ 400 checklist boxes delivered; (\d+) remain open\*\*/,
    )
    if (!reconciliation) throw new Error('program reconciliation is missing')
    expect(Number(reconciliation[1])).toBeGreaterThanOrEqual(130)
    expect(Number(reconciliation[2])).toBeLessThanOrEqual(270)
    const phaseZero = program.match(
      /\| Phase 0 — Product contract\/baseline \| (\d+) \/ 13 \| (\d+) \|/,
    )
    if (!phaseZero) throw new Error('Phase 0 reconciliation is missing')
    expect(Number(phaseZero[1])).toBeGreaterThanOrEqual(11)
    expect(Number(phaseZero[2])).toBeLessThanOrEqual(2)
    expect(program).toContain('BASE-008')
  })
})

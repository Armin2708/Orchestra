import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_SCHEMA_VERSION,
  percentile,
  summarizeSamples,
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

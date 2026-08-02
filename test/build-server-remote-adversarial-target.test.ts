import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BuildServerRemoteAdversarialTarget,
  PRODUCTION_AC_EVIDENCE_MANIFEST,
} from './support/build-server-remote-adversarial-target.js'
import { runRemoteSecurityAdversarialContract } from './support/remote-ops-adversarial-contract.js'

describe('buildServer production remote adversarial acceptance', () => {
  const targets: BuildServerRemoteAdversarialTarget[] = []

  afterEach(async () => {
    await Promise.all(targets.splice(0).map((target) => target.close()))
  })

  it('binds canonical AC-01 through AC-20 to registered production boundaries', async () => {
    const target = new BuildServerRemoteAdversarialTarget()
    targets.push(target)
    const results = await runRemoteSecurityAdversarialContract(target)
    expect(results.filter(({ status }) => status === 'failed')).toEqual([])
    expect(results.filter(({ status }) => status === 'passed')).toHaveLength(20)
    const evidence = target.evidenceLog()
    expect(evidence.length).toBeGreaterThan(20)
    expect(evidence.filter(({ kind }) => kind === 'synthesized')).toEqual([])
    expect(evidence.every(({ source }) => source.length > 0)).toBe(true)
    expect(Object.keys(PRODUCTION_AC_EVIDENCE_MANIFEST).sort()).toEqual([
      'AC-02', 'AC-04', 'AC-09', 'AC-10', 'AC-12', 'AC-13', 'AC-17', 'AC-18', 'AC-19',
    ])
    for (const sources of Object.values(PRODUCTION_AC_EVIDENCE_MANIFEST)) {
      expect(sources.length).toBeGreaterThan(0)
      for (const source of sources) {
        const testSource = readFileSync(join(process.cwd(), source.file), 'utf8')
        expect(testSource, `${source.file} must execute: ${source.title}`).toContain(`it('${source.title}'`)
      }
    }
  }, 30_000)
})

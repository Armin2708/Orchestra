import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('license contract', () => {
  it('ships FSL-1.1-ALv2 as the package license', () => {
    expect(license).toContain('Functional Source License, Version 1.1, ALv2 Future License')
    expect(license).toContain('FSL-1.1-ALv2')
    expect(license).toContain('Grant of Future License')
    expect(license).toContain('Apache License, Version 2.0')
    expect(pkg.license).toBe('FSL-1.1-ALv2')
  })

  it('keeps the license in the published artifact file list implicitly (npm always packs LICENSE)', () => {
    // npm includes LICENSE/README unconditionally; this guards against a rename breaking that
    expect(() => readFileSync(new URL('../LICENSE', import.meta.url))).not.toThrow()
  })
})

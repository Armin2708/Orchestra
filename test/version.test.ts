import { expect, it } from 'vitest'
import { VERSION } from '../src/version.js'
it('exports a semver version', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
})

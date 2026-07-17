import { expect, it } from 'vitest'
import { generateName } from '../src/names.js'
it('generates adjective-animal names', () => {
  expect(generateName(() => 0)).toMatch(/^[a-z]+-[a-z]+$/)
  expect(generateName(() => 0)).not.toBe(generateName(() => 0.99))
})

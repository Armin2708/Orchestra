import { expect, it } from 'vitest'
import { generateName, testerName } from '../src/names.js'
it('generates adjective-animal names', () => {
  expect(generateName(() => 0)).toMatch(/^[a-z]+-[a-z]+$/)
  expect(generateName(() => 0)).not.toBe(generateName(() => 0.99))
})

it('names test-pass agents for the job, suffixing only around a live tester', () => {
  expect(testerName(() => false)).toBe('tester-agent')
  expect(testerName((n) => n === 'tester-agent')).toBe('tester-agent-2')
  expect(testerName((n) => n === 'tester-agent' || n === 'tester-agent-2')).toBe('tester-agent-3')
})

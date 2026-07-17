import { expect, it } from 'vitest'
import { isSimilar } from '../src/similar.js'

it('flags cards about the same topic', () => {
  expect(isSimilar(
    'Users table migration plan',
    'Migrate the users table to accounts',
  )).toBe(true)
  expect(isSimilar(
    'Auth middleware refactor — unify session validation',
    'Refactor auth middleware validation',
  )).toBe(true)
})

it('ignores unrelated cards', () => {
  expect(isSimilar('Users table migration plan', 'Login page error copy')).toBe(false)
  expect(isSimilar('SSE reconnect backoff', 'README sanity check')).toBe(false)
  expect(isSimilar('Fix typo', '')).toBe(false)
})

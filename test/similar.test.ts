import { expect, it } from 'vitest'
import { isShippedMatch, isSimilar } from '../src/similar.js'

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

it('flags near-identical work as shipped', () => {
  expect(isShippedMatch(
    'Mobile-first installable PWA shell — manifest, icons, service worker',
    'Make the web UI an installable mobile PWA with manifest and service worker',
  )).toBe(true)
  expect(isShippedMatch(
    'Users table migration plan',
    'Migrate the users table to accounts',
  )).toBe(true)
})

it('shipped bar is stricter than isSimilar — repeated-work titles pass', () => {
  // two shared tokens is enough for "similar" but not for "already shipped"
  expect(isSimilar('Record the demo GIF', 'Record a demo video walkthrough')).toBe(true)
  expect(isShippedMatch('Record the demo GIF', 'Record a demo video walkthrough')).toBe(false)
  expect(isShippedMatch('Weekly dependency bump', 'Monthly dependency bump for web')).toBe(false)
  expect(isShippedMatch('Fix typo', '')).toBe(false)
})

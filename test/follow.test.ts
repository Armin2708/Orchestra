import { expect, it } from 'vitest'
import { followIntent } from '../web/src/follow.js'

it('keeps following through appends and only unfollows on a deliberate scroll away', () => {
  // at the bottom → following, regardless of prior intent
  expect(followIntent(0, false)).toBe(true)
  expect(followIntent(39, false)).toBe(true)
  // clearly scrolled away → not following
  expect(followIntent(121, true)).toBe(false)
  expect(followIntent(5000, true)).toBe(false)
  // the hysteresis band holds the current intent — iOS rubber-band bounces and tiny
  // drags near the bottom must not flip state either way
  expect(followIntent(80, true)).toBe(true)
  expect(followIntent(80, false)).toBe(false)
  expect(followIntent(40, true)).toBe(true)
  expect(followIntent(120, false)).toBe(false)
})

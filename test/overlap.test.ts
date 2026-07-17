import { expect, it } from 'vitest'
import { pathsIntersect } from '../src/overlap.js'
it('detects prefix containment', () => {
  expect(pathsIntersect(['src/auth'], ['src/auth/login.ts'])).toBe(true)
})
it('detects glob intersection both directions', () => {
  expect(pathsIntersect(['src/auth/**'], ['src/auth/login.ts'])).toBe(true)
  expect(pathsIntersect(['src/auth/login.ts'], ['src/auth/**'])).toBe(true)
})
it('treats glob base dirs as prefixes', () => {
  expect(pathsIntersect(['src/auth/**'], ['src/auth'])).toBe(true)
})
it('rejects disjoint paths', () => {
  expect(pathsIntersect(['src/auth/**'], ['docs/readme.md'])).toBe(false)
  expect(pathsIntersect([], ['src/a.ts'])).toBe(false)
})

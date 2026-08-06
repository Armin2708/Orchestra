import { describe, expect, it } from 'vitest'
import {
  compareExecutableSemver,
  parseExecutableSemver,
  pickNewestExecutable,
} from '../src/provider-executable-version.js'

describe('parseExecutableSemver', () => {
  it('extracts a version from a CLI banner', () => {
    expect(parseExecutableSemver('2.1.222 (Claude Code)')?.value).toBe('2.1.222')
    expect(parseExecutableSemver('codex-cli 0.146.0')?.value).toBe('0.146.0')
  })

  it('returns null for unparseable text', () => {
    expect(parseExecutableSemver('nightly')).toBeNull()
    expect(parseExecutableSemver(null)).toBeNull()
  })
})

describe('pickNewestExecutable', () => {
  const versions: Record<string, string> = {
    '/stale/claude': '2.0.10 (Claude Code)',
    '/bundled/claude': '2.1.212 (Claude Code)',
    '/newest/claude': '2.1.222 (Claude Code)',
  }
  const read = (path: string) => versions[path] ?? null

  // The real defect this guards: npx prepends node_modules/.bin, which held a
  // 2.0.10 CLI while 2.1.222 sat later on PATH. Taking the first hit pinned the
  // stale binary — the exact staleness this whole resolver exists to prevent.
  it('picks the newest even when a stale CLI comes FIRST on PATH', () => {
    expect(pickNewestExecutable(['/stale/claude', '/bundled/claude', '/newest/claude'], read))
      .toBe('/newest/claude')
  })

  it('is order independent', () => {
    expect(pickNewestExecutable(['/newest/claude', '/stale/claude'], read)).toBe('/newest/claude')
    expect(pickNewestExecutable(['/stale/claude', '/newest/claude'], read)).toBe('/newest/claude')
  })

  it('does not probe when there is only one candidate', () => {
    const boom = () => { throw new Error('should not probe a single candidate') }
    expect(pickNewestExecutable(['/only/claude'], boom)).toBe('/only/claude')
  })

  it('degrades to PATH order when no candidate reports a version', () => {
    expect(pickNewestExecutable(['/a', '/b'], () => null)).toBe('/a')
  })

  it('returns null for no candidates', () => {
    expect(pickNewestExecutable([], read)).toBeNull()
  })
})

describe('compareExecutableSemver', () => {
  it('orders by major, minor, then patch', () => {
    const v = (s: string) => parseExecutableSemver(s)!.tuple
    expect(compareExecutableSemver(v('2.1.222'), v('2.1.212'))).toBeGreaterThan(0)
    expect(compareExecutableSemver(v('2.0.10'), v('2.1.212'))).toBeLessThan(0)
    expect(compareExecutableSemver(v('2.1.212'), v('2.1.212'))).toBe(0)
  })
})

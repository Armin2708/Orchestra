import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(root, 'docs', file), 'utf8')

describe('operator onboarding documentation', () => {
  it('documents every owned PKG boundary without claiming unfinished support', () => {
    expect(read('getting-started.md')).toMatch(/loopback-only daemon binding/)
    expect(read('getting-started.md')).toMatch(/provider-API runtime.*blocked/s)
    expect(read('data-recovery.md')).toMatch(/offline-consistent/)
    expect(read('data-recovery.md')).toMatch(/does not back up worktrees/)
    expect(read('data-recovery.md')).toContain('${ORCHESTRA_HOME:-$HOME/.orchestra}')
    expect(read('data-recovery.md')).toMatch(/shasum.*sha256sum/s)
    expect(read('remote-access-security.md')).toMatch(/Secure remote beta remains.*unavailable/s)
    expect(read('troubleshooting.md')).toMatch(/Database locked/)
    expect(read('lifecycle-demo.md')).toMatch(/marker-bound Board, card and/)
    expect(read('api-event-schema-v1.md')).toMatch(/\/api\/v1\/os/)
    expect(read('upgrade-compatibility.md')).toMatch(/forward schema/)
    expect(read('telemetry-support.md')).toMatch(/off by default/)
    expect(read('telemetry-support.md')).toMatch(/No transport is registered/)
    expect(read('telemetry-support.md')).toMatch(/adapter is disabled when no verifier is injected/)
    expect(read('operator-preview.md')).toMatch(/`onboarding\.json`/)
    expect(read('api-event-schema-v1.md')).toMatch(/does not close PKG-014/)
    expect(read('upgrade-compatibility.md')).toMatch(/PKG-015 remains open/)
  })
})

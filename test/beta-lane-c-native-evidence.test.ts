import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Lane C historical native evidence', () => {
  it('retains exact bytes without converting them into REM-017 or REM-GATE evidence', () => {
    const result = JSON.parse(execFileSync(
      process.execPath,
      ['scripts/verify-beta-lane-c-native-evidence.mjs'],
      { cwd: process.cwd(), encoding: 'utf8' },
    )) as { exact_marker_bound: boolean; gate_status: string; verified: unknown[] }
    expect(result).toMatchObject({ exact_marker_bound: false, gate_status: 'open' })
    expect(result.verified).toHaveLength(5)

    const manifest = JSON.parse(fs.readFileSync(path.join(
      process.cwd(),
      'docs/evidence/beta-lane-c-native-historical/manifest.json',
    ), 'utf8')) as { claims_not_supported: string[] }
    expect(manifest.claims_not_supported).toEqual(expect.arrayContaining([
      'iOS PWA installation',
      'iOS PWA relaunch or reconnect',
      'iOS persistent credential storage',
      'REM-017 completion',
      'REM-GATE completion',
    ]))
  })
})

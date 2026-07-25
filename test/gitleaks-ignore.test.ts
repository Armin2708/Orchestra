import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const EXPECTED_FINGERPRINTS = [
  '6fbf6171f06111604151b1ee23f1b09461cf2560:test/agent-home-domain.test.ts:private-key:418',
  '6fbf6171f06111604151b1ee23f1b09461cf2560:test/agent-os-migrations.test.ts:private-key:154',
  '1b1dfbee2f2d4969e5a9351caaa97e2926366d02:test/projected-text-redaction.test.ts:private-key:22',
]

describe('gitleaks ignore policy', () => {
  it('permits only reviewed commit-scoped redaction fixtures', () => {
    const fingerprints = readFileSync(new URL('../.gitleaksignore', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))

    expect(fingerprints).toEqual(EXPECTED_FINGERPRINTS)
    for (const fingerprint of fingerprints) {
      expect(fingerprint).toMatch(
        /^[0-9a-f]{40}:test\/(?:agent-home-domain|agent-os-migrations|projected-text-redaction)\.test\.ts:private-key:\d+$/,
      )
    }
  })
})

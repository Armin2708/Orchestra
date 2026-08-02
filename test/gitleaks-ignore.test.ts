import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const EXPECTED_FINGERPRINTS = [
  '479e67a01b60f39976f41363521a706bb76e39d2:test/organization-coordination.test.ts:generic-api-key:144',
  '085b180b8f696eb0c0e5352fd0b696ba2563d147:test/command-idempotency-coverage.test.ts:generic-api-key:217',
  '6fbf6171f06111604151b1ee23f1b09461cf2560:test/agent-home-domain.test.ts:private-key:418',
  '6fbf6171f06111604151b1ee23f1b09461cf2560:test/agent-os-migrations.test.ts:private-key:154',
  '6d8235922a88200c4856ee424e5ee00820de02b1:test/agent-home-domain.test.ts:private-key:418',
  '6d8235922a88200c4856ee424e5ee00820de02b1:test/agent-os-migrations.test.ts:private-key:154',
  '1b1dfbee2f2d4969e5a9351caaa97e2926366d02:test/projected-text-redaction.test.ts:private-key:22',
  '3c79b69b3298a17a54e9fd2426e2eca1a337bd18:test/session-tool-routes.test.ts:generic-api-key:83',
  '1994f12d9ff23c969a6eb0b645b2db25ee694eda:test/agent-home-domain.test.ts:private-key:418',
  '1994f12d9ff23c969a6eb0b645b2db25ee694eda:test/agent-os-migrations.test.ts:private-key:178',
  '1994f12d9ff23c969a6eb0b645b2db25ee694eda:test/projected-text-redaction.test.ts:private-key:23',
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
        /^[0-9a-f]{40}:test\/(?:(?:agent-home-domain|agent-os-migrations|projected-text-redaction)\.test\.ts:private-key|(?:organization-coordination|command-idempotency-coverage|session-tool-routes)\.test\.ts:generic-api-key):\d+$/,
      )
    }
  })
})

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
} from '../src/provider-adapter-registry.js'
import {
  ProviderAcceptanceRunV1,
  acceptanceCheckV1,
  verifyProviderAcceptanceArtifactsV1,
} from '../src/provider-acceptance-harness.js'

const roots: string[] = []

const temporary = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-provider-acceptance-'))
  roots.push(root)
  return root
}

const run = (
  root: string,
  forbiddenSubstrings: readonly string[] = [],
): ProviderAcceptanceRunV1 => new ProviderAcceptanceRunV1({
  artifact_root: join(root, 'evidence', 'codex'),
  reference_root: 'evidence/codex',
  tuple: {
    contract_version: 1,
    provider_id: 'codex',
    adapter_id: 'codex-app-server',
    adapter_version: '1.0.0',
    mode_id: 'native_subscription',
    runtime_mode: 'native_cli',
    billing_mode: 'personal_subscription',
    credential_kind: 'provider_account_session',
    executable_version: '0.144.6',
    platform: 'darwin-arm64',
    source_commit: 'a'.repeat(40),
  },
  forbidden_substrings: forbiddenSubstrings,
  now: () => new Date('2026-07-28T18:00:00.000Z'),
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('provider acceptance harness', () => {
  it('writes, verifies, and persists an exact all-pass eight-gate matrix', async () => {
    const root = temporary()
    const acceptance = run(root)
    for (const gateId of DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1) {
      const gate = await acceptance.gate(gateId, async () => [
        acceptanceCheckV1(
          `${gateId}_observed`,
          'passed',
          'observed',
          { observed: true, tokens: 12 },
        ),
      ])
      expect(gate.state).toBe('passed')
      expect(gate.artifact_sha256).toMatch(/^[a-f0-9]{64}$/)
    }

    const finalized = acceptance.finalize(join(root, 'evidence.db'))
    expect(finalized.evidence_record?.id).toMatch(/^pe_[a-f0-9]{64}$/)
    expect(finalized.matrix.source_commit).toBe('a'.repeat(40))
    expect(Object.values(finalized.matrix.gates)
      .every((gate) => gate.state === 'passed')).toBe(true)
    expect(finalized.gates).toHaveLength(8)
    expect(statSync(join(root, 'evidence', 'codex', 'matrix.json')).mode & 0o777)
      .toBe(0o600)
    verifyProviderAcceptanceArtifactsV1(
      join(root, 'evidence', 'codex'),
      finalized,
    )
  })

  it('records failed and source-only gates honestly and refuses persistence', async () => {
    const root = temporary()
    const acceptance = run(root)
    for (const gateId of DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1) {
      await acceptance.gate(gateId, async () => gateId === 'managed_lifecycle'
        ? [
            acceptanceCheckV1(
              'synthetic_only',
              'passed',
              'source_contract',
              { source_only: true },
            ),
          ]
        : [
            acceptanceCheckV1(
              `${gateId}_observed`,
              gateId === 'failure_semantics' ? 'failed' : 'passed',
              'observed',
              { observed: true },
            ),
          ])
    }

    expect(() => acceptance.finalize(join(root, 'evidence.db')))
      .toThrow(/refusing to persist incomplete/)
    const finalized = acceptance.finalize()
    expect(finalized.evidence_record).toBeNull()
    expect(finalized.matrix.gates.managed_lifecycle.state).toBe('failed')
    expect(finalized.matrix.gates.failure_semantics.state).toBe('failed')
    const managed = finalized.gates.find((gate) =>
      gate.gate_id === 'managed_lifecycle')
    expect(managed?.artifact.checks.map((check) => check.check_id))
      .toContain('observed_evidence_required')
  })

  it('redacts structured secret fields and rejects explicit forbidden values', async () => {
    const root = temporary()
    const sentinel = 'tool014-forbidden-sentinel'
    const acceptance = run(root, [sentinel])
    const redacted = await acceptance.gate('executable_provenance', async () => [
      acceptanceCheckV1(
        'redaction',
        'passed',
        'observed',
        {
          api_key: 'sk-never-store-this',
          nested: { authorization: 'Bearer never-store-this' },
        },
      ),
    ])
    const text = readFileSync(
      join(root, 'evidence', 'codex', 'gates', 'executable_provenance.json'),
      'utf8',
    )
    expect(text).not.toContain('sk-never-store-this')
    expect(text).not.toContain('Bearer never-store-this')
    expect(text).toContain('[REDACTED]')
    expect(redacted.artifact.redactions_applied).toBeGreaterThan(0)

    await expect(acceptance.gate('subscription_billing', async () => [
      acceptanceCheckV1(
        'forbidden',
        'passed',
        'observed',
        { harmless_name: sentinel },
      ),
    ])).rejects.toThrow(/forbidden sensitive material/)
  })

  it('rejects duplicate gates, duplicate checks, and paths outside the run', async () => {
    const root = temporary()
    const acceptance = run(root)
    await acceptance.gate('executable_provenance', async () => [
      acceptanceCheckV1('one', 'passed', 'observed'),
    ])
    await expect(acceptance.gate('executable_provenance', async () => [
      acceptanceCheckV1('two', 'passed', 'observed'),
    ])).rejects.toThrow(/already recorded/)
    await expect(acceptance.gate('subscription_billing', async () => [
      acceptanceCheckV1('same', 'passed', 'observed'),
      acceptanceCheckV1('same', 'passed', 'observed'),
    ])).rejects.toThrow(/duplicate checks/)
    expect(() => new ProviderAcceptanceRunV1({
      artifact_root: 'relative',
      reference_root: 'evidence/codex',
      tuple: {
        contract_version: 1,
        provider_id: 'codex',
        adapter_id: 'codex-app-server',
        adapter_version: '1.0.0',
        mode_id: 'native_subscription',
        runtime_mode: 'native_cli',
        billing_mode: 'personal_subscription',
        credential_kind: 'provider_account_session',
        executable_version: '0.144.6',
        platform: 'darwin-arm64',
        source_commit: 'a'.repeat(40),
      },
    })).toThrow(/absolute/)
  })
})

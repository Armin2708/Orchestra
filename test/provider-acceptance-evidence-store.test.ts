import { describe, expect, it } from 'vitest'
import { createAgentOsRuntime } from '../src/agent-os/runtime-integration.js'
import { openDb } from '../src/db.js'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
  ProviderAdapterRegistryV1,
  type DeclaredProviderAcceptanceMatrixV1,
} from '../src/provider-adapter-registry.js'
import {
  ProviderAcceptanceEvidenceStoreV1,
} from '../src/provider-acceptance-evidence-store.js'

const artifact = {
  artifact_ref: 'evidence/codex/0.144.6/darwin-arm64/matrix.json',
  artifact_sha256: 'b'.repeat(64),
}

const matrix = (
  observedAt = '2026-07-28T12:00:00.000Z',
): DeclaredProviderAcceptanceMatrixV1 => ({
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
  observed_at: observedAt,
  gates: Object.fromEntries(
    DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.map((gateId) => [
      gateId,
      {
        state: 'passed' as const,
        evidence_refs: [`evidence/${gateId}.json`],
      },
    ]),
  ) as DeclaredProviderAcceptanceMatrixV1['gates'],
})

describe('durable provider acceptance evidence', () => {
  it('persists, hydrates, and advances exact acceptance tuples across runtimes', async () => {
    const db = openDb(':memory:')
    const store = new ProviderAcceptanceEvidenceStoreV1(db, {
      now: () => new Date('2026-07-28T12:01:00.000Z'),
    })
    const registry = new ProviderAdapterRegistryV1()
    const first = store.record(registry, matrix(), artifact)

    expect(first).toMatchObject({
      artifact_ref: artifact.artifact_ref,
      artifact_sha256: artifact.artifact_sha256,
      recorded_at: '2026-07-28T12:01:00.000Z',
    })
    expect(first.id).toMatch(/^pe_[a-f0-9]{64}$/)
    expect(first.matrix_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(registry.declarations().find((entry) => entry.provider_id === 'codex'))
      .toMatchObject({ acceptance_matrix_count: 1 })

    const reloaded = new ProviderAdapterRegistryV1()
    expect(store.hydrate(reloaded)).toBe(1)
    expect(store.hydrate(reloaded)).toBe(0)
    expect(reloaded.declarations().find((entry) => entry.provider_id === 'codex'))
      .toMatchObject({ acceptance_matrix_count: 1 })

    store.record(
      registry,
      matrix('2026-07-28T12:05:00.000Z'),
      {
        artifact_ref: 'evidence/codex/0.144.6/darwin-arm64/matrix-2.json',
        artifact_sha256: 'c'.repeat(64),
      },
    )
    expect(store.list()).toHaveLength(2)

    const runtime = createAgentOsRuntime(db)
    expect(runtime.providerAdapters.declarations()
      .find((entry) => entry.provider_id === 'codex'))
      .toMatchObject({ acceptance_matrix_count: 1 })
    expect(runtime.providerAcceptanceEvidence.list()).toHaveLength(2)
    await runtime.shutdown()
    db.close()
  })

  it('rolls back invalid evidence instead of creating an in-memory-only claim', () => {
    const db = openDb(':memory:')
    const store = new ProviderAcceptanceEvidenceStoreV1(db)
    const registry = new ProviderAdapterRegistryV1()
    const invalid = matrix()
    invalid.gates.credential_redaction = {
      state: 'passed',
      evidence_refs: [],
    }

    expect(() => store.record(registry, invalid, artifact))
      .toThrow(/acceptance/)
    expect(store.list()).toEqual([])
    expect(registry.declarations().find((entry) => entry.provider_id === 'codex'))
      .toMatchObject({ acceptance_matrix_count: 0 })
    expect(() => store.record(registry, matrix(), {
      ...artifact,
      artifact_sha256: 'not-a-digest',
    })).toThrow(/invalid provider acceptance evidence artifact/)
    expect(store.list()).toEqual([])
    db.close()
  })

  it('fails closed when persisted evidence no longer matches its digest', () => {
    const db = openDb(':memory:')
    const store = new ProviderAcceptanceEvidenceStoreV1(db)
    const persisted = store.record(
      new ProviderAdapterRegistryV1(),
      matrix(),
      artifact,
    )
    db.exec('DROP TRIGGER provider_acceptance_evidence_update')
    db.prepare(`UPDATE provider_acceptance_evidence
      SET matrix_sha256=? WHERE id=?`).run('d'.repeat(64), persisted.id)

    expect(() => new ProviderAcceptanceEvidenceStoreV1(db).hydrate(
      new ProviderAdapterRegistryV1(),
    )).toThrow(/provider acceptance evidence is corrupt/)
    db.close()
  })
})

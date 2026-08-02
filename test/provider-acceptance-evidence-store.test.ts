import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalHash, stableJson } from '../src/agent-os/agent-home-support.js'
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

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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

const retainedArtifact = (
  value: DeclaredProviderAcceptanceMatrixV1,
  name = 'matrix.json',
) => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-provider-evidence-'))
  roots.push(root)
  const path = join(root, name)
  writeFileSync(path, `${stableJson(value)}\n`, { mode: 0o600 })
  return {
    path,
    artifact: {
      artifact_ref: pathToFileURL(path).href,
      artifact_sha256: canonicalHash(value),
    },
  }
}

describe('durable provider acceptance evidence', () => {
  it('persists, hydrates, and advances exact acceptance tuples across runtimes', async () => {
    const db = openDb(':memory:')
    const store = new ProviderAcceptanceEvidenceStoreV1(db, {
      now: () => new Date('2026-07-28T12:01:00.000Z'),
    })
    const registry = new ProviderAdapterRegistryV1()
    const firstMatrix = matrix()
    const firstArtifact = retainedArtifact(firstMatrix)
    const first = store.record(registry, firstMatrix, firstArtifact.artifact)

    expect(first).toMatchObject({
      artifact_ref: firstArtifact.artifact.artifact_ref,
      artifact_sha256: firstArtifact.artifact.artifact_sha256,
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

    const secondMatrix = matrix('2026-07-28T12:05:00.000Z')
    const secondArtifact = retainedArtifact(secondMatrix, 'matrix-2.json')
    store.record(
      registry,
      secondMatrix,
      secondArtifact.artifact,
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

    expect(() => store.record(registry, invalid, retainedArtifact(matrix()).artifact))
      .toThrow(/acceptance/)
    expect(store.list()).toEqual([])
    expect(registry.declarations().find((entry) => entry.provider_id === 'codex'))
      .toMatchObject({ acceptance_matrix_count: 0 })
    const validArtifact = retainedArtifact(matrix()).artifact
    expect(() => store.record(registry, matrix(), {
      ...validArtifact,
      artifact_sha256: 'not-a-digest',
    })).toThrow(/invalid provider acceptance evidence artifact/)
    expect(store.list()).toEqual([])
    db.close()
  })

  it('verifies retained evidence before changing durable or in-memory state', () => {
    const cases = [
      {
        name: 'missing artifact',
        arrange: () => {
          const value = matrix()
          const retained = retainedArtifact(value)
          unlinkSync(retained.path)
          return { value, artifact: retained.artifact }
        },
        error: /artifact could not be verified/,
      },
      {
        name: 'wrong digest',
        arrange: () => {
          const value = matrix()
          const retained = retainedArtifact(value)
          return {
            value,
            artifact: { ...retained.artifact, artifact_sha256: 'b'.repeat(64) },
          }
        },
        error: /artifact digest mismatch/,
      },
      {
        name: 'wrong matrix',
        arrange: () => {
          const retainedValue = matrix()
          const retained = retainedArtifact(retainedValue)
          return {
            value: matrix('2026-07-28T12:10:00.000Z'),
            artifact: retained.artifact,
          }
        },
        error: /artifact digest mismatch/,
      },
    ]

    for (const testCase of cases) {
      const db = openDb(':memory:')
      const store = new ProviderAcceptanceEvidenceStoreV1(db)
      const registry = new ProviderAdapterRegistryV1()
      const { value, artifact } = testCase.arrange()

      expect(
        () => store.record(registry, value, artifact),
        testCase.name,
      ).toThrow(testCase.error)
      expect(store.list(), testCase.name).toEqual([])
      expect(
        registry.declarations().find((entry) => entry.provider_id === 'codex'),
        testCase.name,
      ).toMatchObject({ acceptance_matrix_count: 0 })
      db.close()
    }
  })

  it('fails closed when persisted evidence no longer matches its digest', () => {
    const db = openDb(':memory:')
    const store = new ProviderAcceptanceEvidenceStoreV1(db)
    const value = matrix()
    const retained = retainedArtifact(value)
    const persisted = store.record(
      new ProviderAdapterRegistryV1(),
      value,
      retained.artifact,
    )
    db.exec('DROP TRIGGER provider_acceptance_evidence_update')
    db.prepare(`UPDATE provider_acceptance_evidence
      SET matrix_sha256=? WHERE id=?`).run('d'.repeat(64), persisted.id)

    expect(() => new ProviderAcceptanceEvidenceStoreV1(db).hydrate(
      new ProviderAdapterRegistryV1(),
    )).toThrow(/provider acceptance evidence is corrupt/)
    db.close()
  })

  it('fails closed when the retained artifact is missing or tampered', () => {
    const missingDb = openDb(':memory:')
    const missingValue = matrix()
    const missing = retainedArtifact(missingValue)
    new ProviderAcceptanceEvidenceStoreV1(missingDb).record(
      new ProviderAdapterRegistryV1(), missingValue, missing.artifact,
    )
    unlinkSync(missing.path)
    expect(() => new ProviderAcceptanceEvidenceStoreV1(missingDb).hydrate(
      new ProviderAdapterRegistryV1(),
    )).toThrow(/artifact could not be verified/)
    missingDb.close()

    const tamperedDb = openDb(':memory:')
    const tamperedValue = matrix()
    const tampered = retainedArtifact(tamperedValue)
    new ProviderAcceptanceEvidenceStoreV1(tamperedDb).record(
      new ProviderAdapterRegistryV1(), tamperedValue, tampered.artifact,
    )
    writeFileSync(tampered.path, `${stableJson(matrix('2026-07-28T12:10:00.000Z'))}\n`)
    expect(() => new ProviderAcceptanceEvidenceStoreV1(tamperedDb).hydrate(
      new ProviderAdapterRegistryV1(),
    )).toThrow(/artifact digest mismatch/)
    tamperedDb.close()
  })
})

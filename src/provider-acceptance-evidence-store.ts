import type Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  canonicalHash,
  stableJson,
} from './agent-os/agent-home-support.js'
import {
  ProviderAdapterRegistryV1,
  defineDeclaredProviderAcceptanceMatrixV1,
  type DeclaredProviderAcceptanceMatrixV1,
} from './provider-adapter-registry.js'

const SHA256 = /^[a-f0-9]{64}$/
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9./:@_?&=%+#-]{0,2047}$/

export type ProviderAcceptanceArtifactV1 = {
  artifact_ref: string
  artifact_sha256: string
}

export type ProviderAcceptanceEvidenceRecordV1 = {
  id: string
  matrix: Readonly<DeclaredProviderAcceptanceMatrixV1>
  matrix_sha256: string
  artifact_ref: string
  artifact_sha256: string
  recorded_at: string
}

type ProviderAcceptanceEvidenceRowV1 = {
  id: string
  contract_version: number
  provider_id: string
  adapter_id: string
  adapter_version: string
  mode_id: string
  runtime_mode: string
  billing_mode: string
  credential_kind: string
  executable_version: string
  platform: string
  source_commit: string
  observed_at: string
  matrix_json: string
  matrix_sha256: string
  artifact_ref: string
  artifact_sha256: string
  recorded_at: string
}

export type ProviderAcceptanceEvidenceStoreOptionsV1 = {
  now?: () => Date
  loadArtifact?: (artifactRef: string) => string | Uint8Array
}

const defaultArtifactLoader = (artifactRef: string): Uint8Array => {
  let url: URL
  try {
    url = new URL(artifactRef)
  } catch {
    throw new Error('provider acceptance artifact reference is not resolvable')
  }
  if (url.protocol !== 'file:') {
    throw new Error('provider acceptance artifact reference is not resolvable')
  }
  return readFileSync(fileURLToPath(url))
}

const parseArtifact = (artifact: string | Uint8Array): unknown => {
  try {
    return JSON.parse(typeof artifact === 'string'
      ? artifact
      : Buffer.from(artifact).toString('utf8')) as unknown
  } catch {
    throw new Error('provider acceptance artifact is invalid')
  }
}

const recordId = (
  matrixSha256: string,
  artifactRef: string,
  artifactSha256: string,
): string => `pe_${canonicalHash({
  artifact_ref: artifactRef,
  artifact_sha256: artifactSha256,
  matrix_sha256: matrixSha256,
})}`

const validTimestamp = (value: string): boolean =>
  value.trim() === value && Number.isFinite(Date.parse(value))

const assertArtifact = (
  artifact: ProviderAcceptanceArtifactV1,
): ProviderAcceptanceArtifactV1 => {
  if (!EVIDENCE_REF.test(artifact.artifact_ref)
    || !SHA256.test(artifact.artifact_sha256)) {
    throw new Error('invalid provider acceptance evidence artifact')
  }
  return {
    artifact_ref: artifact.artifact_ref,
    artifact_sha256: artifact.artifact_sha256,
  }
}

const verifyRetainedArtifact = (
  loadArtifact: (artifactRef: string) => string | Uint8Array,
  matrix: Readonly<DeclaredProviderAcceptanceMatrixV1>,
  artifact: ProviderAcceptanceArtifactV1,
  evidenceId: string,
): void => {
  let retained: unknown
  try {
    retained = parseArtifact(loadArtifact(artifact.artifact_ref))
  } catch (error) {
    throw new Error(
      `provider acceptance artifact could not be verified: ${evidenceId}`,
      { cause: error },
    )
  }
  if (canonicalHash(retained) !== artifact.artifact_sha256
    || stableJson(retained) !== stableJson(matrix)) {
    throw new Error(`provider acceptance artifact digest mismatch: ${evidenceId}`)
  }
}

const matrixMatchesRow = (
  matrix: Readonly<DeclaredProviderAcceptanceMatrixV1>,
  row: ProviderAcceptanceEvidenceRowV1,
): boolean =>
  matrix.contract_version === row.contract_version
  && matrix.provider_id === row.provider_id
  && matrix.adapter_id === row.adapter_id
  && matrix.adapter_version === row.adapter_version
  && matrix.mode_id === row.mode_id
  && matrix.runtime_mode === row.runtime_mode
  && matrix.billing_mode === row.billing_mode
  && matrix.credential_kind === row.credential_kind
  && matrix.executable_version === row.executable_version
  && matrix.platform === row.platform
  && matrix.source_commit === row.source_commit
  && matrix.observed_at === row.observed_at

const evidenceRecord = (
  row: ProviderAcceptanceEvidenceRowV1,
): ProviderAcceptanceEvidenceRecordV1 => {
  let matrix: Readonly<DeclaredProviderAcceptanceMatrixV1>
  try {
    matrix = defineDeclaredProviderAcceptanceMatrixV1(
      JSON.parse(row.matrix_json) as DeclaredProviderAcceptanceMatrixV1,
    )
  } catch {
    throw new Error(`provider acceptance evidence is corrupt: ${row.id}`)
  }
  const artifact = assertArtifact({
    artifact_ref: row.artifact_ref,
    artifact_sha256: row.artifact_sha256,
  })
  const matrixJson = stableJson(matrix)
  const matrixSha256 = canonicalHash(matrix)
  if (row.contract_version !== 1
    || matrixJson !== row.matrix_json
    || matrixSha256 !== row.matrix_sha256
    || !SHA256.test(row.matrix_sha256)
    || !validTimestamp(row.recorded_at)
    || !matrixMatchesRow(matrix, row)
    || row.id !== recordId(
      row.matrix_sha256,
      artifact.artifact_ref,
      artifact.artifact_sha256,
    )) {
    throw new Error(`provider acceptance evidence is corrupt: ${row.id}`)
  }
  return Object.freeze({
    id: row.id,
    matrix,
    matrix_sha256: row.matrix_sha256,
    artifact_ref: artifact.artifact_ref,
    artifact_sha256: artifact.artifact_sha256,
    recorded_at: row.recorded_at,
  })
}

export class ProviderAcceptanceEvidenceStoreV1 {
  readonly #now: () => Date
  readonly #loadArtifact: (artifactRef: string) => string | Uint8Array
  readonly #hydrated = new WeakSet<ProviderAdapterRegistryV1>()

  constructor(
    private readonly db: Database.Database,
    options: ProviderAcceptanceEvidenceStoreOptionsV1 = {},
  ) {
    this.#now = options.now ?? (() => new Date())
    this.#loadArtifact = options.loadArtifact ?? defaultArtifactLoader
  }

  record(
    registry: ProviderAdapterRegistryV1,
    matrixInput: DeclaredProviderAcceptanceMatrixV1,
    artifactInput: ProviderAcceptanceArtifactV1,
  ): ProviderAcceptanceEvidenceRecordV1 {
    const artifact = assertArtifact(artifactInput)
    const matrix = defineDeclaredProviderAcceptanceMatrixV1(matrixInput)
    const matrixJson = stableJson(matrix)
    const matrixSha256 = canonicalHash(matrix)
    const id = recordId(
      matrixSha256,
      artifact.artifact_ref,
      artifact.artifact_sha256,
    )
    verifyRetainedArtifact(this.#loadArtifact, matrix, artifact, id)
    const recordedAt = this.#now().toISOString()
    const insert = this.db.prepare(`INSERT INTO provider_acceptance_evidence (
      id, contract_version, provider_id, adapter_id, adapter_version, mode_id,
      runtime_mode, billing_mode, credential_kind, executable_version, platform,
      source_commit, observed_at, matrix_json, matrix_sha256, artifact_ref,
      artifact_sha256, recorded_at
    ) VALUES (
      @id, @contract_version, @provider_id, @adapter_id, @adapter_version, @mode_id,
      @runtime_mode, @billing_mode, @credential_kind, @executable_version, @platform,
      @source_commit, @observed_at, @matrix_json, @matrix_sha256, @artifact_ref,
      @artifact_sha256, @recorded_at
    )`)
    const persist = this.db.transaction(() => {
      insert.run({
        id,
        contract_version: matrix.contract_version,
        provider_id: matrix.provider_id,
        adapter_id: matrix.adapter_id,
        adapter_version: matrix.adapter_version,
        mode_id: matrix.mode_id,
        runtime_mode: matrix.runtime_mode,
        billing_mode: matrix.billing_mode,
        credential_kind: matrix.credential_kind,
        executable_version: matrix.executable_version,
        platform: matrix.platform,
        source_commit: matrix.source_commit,
        observed_at: matrix.observed_at,
        matrix_json: matrixJson,
        matrix_sha256: matrixSha256,
        artifact_ref: artifact.artifact_ref,
        artifact_sha256: artifact.artifact_sha256,
        recorded_at: recordedAt,
      })
      registry.recordAcceptance(
        matrix as DeclaredProviderAcceptanceMatrixV1,
      )
    })
    persist()
    return this.required(id)
  }

  hydrate(registry: ProviderAdapterRegistryV1): number {
    if (this.#hydrated.has(registry)) return 0
    const evidence = this.verified()
      .sort((left, right) =>
        Date.parse(left.matrix.observed_at) - Date.parse(right.matrix.observed_at)
        || Date.parse(left.recorded_at) - Date.parse(right.recorded_at)
        || left.id.localeCompare(right.id))
    for (const record of evidence) {
      registry.recordAcceptance(
        record.matrix as DeclaredProviderAcceptanceMatrixV1,
      )
    }
    this.#hydrated.add(registry)
    return evidence.length
  }

  list(): ProviderAcceptanceEvidenceRecordV1[] {
    const rows = (
      this.db.prepare(`SELECT *
        FROM provider_acceptance_evidence
        ORDER BY observed_at, recorded_at, rowid`).all()
    ) as ProviderAcceptanceEvidenceRowV1[]
    return rows.map(evidenceRecord)
  }

  verified(): ProviderAcceptanceEvidenceRecordV1[] {
    const evidence = this.list()
    for (const record of evidence) {
      verifyRetainedArtifact(this.#loadArtifact, record.matrix, record, record.id)
    }
    return evidence
  }

  private required(id: string): ProviderAcceptanceEvidenceRecordV1 {
    const row = (
      this.db.prepare(`SELECT *
        FROM provider_acceptance_evidence WHERE id=?`).get(id)
    ) as ProviderAcceptanceEvidenceRowV1 | undefined
    if (!row) throw new Error(`provider acceptance evidence was not persisted: ${id}`)
    return evidenceRecord(row)
  }
}

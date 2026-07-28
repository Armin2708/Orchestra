import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  canonicalHash,
  stableJson,
} from './agent-os/agent-home-support.js'
import {
  redactSensitiveText,
  redactStructuredValue,
} from './agent-os/structured-redaction.js'
import { openDb } from './db.js'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
  ProviderAdapterRegistryV1,
  defineDeclaredProviderAcceptanceMatrixV1,
  type DeclaredProviderAcceptanceGateIdV1,
  type DeclaredProviderAcceptanceMatrixV1,
} from './provider-adapter-registry.js'
import {
  ProviderAcceptanceEvidenceStoreV1,
  type ProviderAcceptanceEvidenceRecordV1,
} from './provider-acceptance-evidence-store.js'

const CHECK_ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const SHA256 = /^[a-f0-9]{64}$/
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9./:@_?&=%+#-]{0,2047}$/

export type ProviderAcceptanceCheckStateV1 = 'passed' | 'failed'
export type ProviderAcceptanceEvidenceKindV1 =
  | 'observed'
  | 'negative_control'
  | 'source_contract'

export type ProviderAcceptanceCheckV1 = {
  check_id: string
  state: ProviderAcceptanceCheckStateV1
  evidence_kind: ProviderAcceptanceEvidenceKindV1
  detail: Record<string, unknown>
}

export type ProviderAcceptanceGateArtifactV1 = {
  schema_version: 1
  gate_id: DeclaredProviderAcceptanceGateIdV1
  source_commit: string
  started_at: string
  completed_at: string
  state: ProviderAcceptanceCheckStateV1
  checks: readonly ProviderAcceptanceCheckV1[]
  redactions_applied: number
}

export type ProviderAcceptanceGateRecordV1 = {
  gate_id: DeclaredProviderAcceptanceGateIdV1
  state: ProviderAcceptanceCheckStateV1
  evidence_ref: string
  artifact_sha256: string
  artifact: Readonly<ProviderAcceptanceGateArtifactV1>
}

export type ProviderAcceptanceTupleV1 = Omit<
  DeclaredProviderAcceptanceMatrixV1,
  'observed_at' | 'gates'
>

export type ProviderAcceptanceFinalizationV1 = {
  matrix: Readonly<DeclaredProviderAcceptanceMatrixV1>
  matrix_ref: string
  matrix_sha256: string
  gates: readonly ProviderAcceptanceGateRecordV1[]
  evidence_record: ProviderAcceptanceEvidenceRecordV1 | null
}

export type ProviderAcceptanceRunOptionsV1 = {
  artifact_root: string
  reference_root: string
  tuple: ProviderAcceptanceTupleV1
  forbidden_substrings?: readonly string[]
  now?: () => Date
}

type SafeDetail = {
  value: Record<string, unknown>
  redactions: number
}

const assertTimestamp = (value: string): string => {
  if (value.trim() !== value || !Number.isFinite(Date.parse(value))) {
    throw new Error('provider acceptance timestamp is invalid')
  }
  return value
}

const assertContainedPath = (root: string, candidate: string): void => {
  const path = relative(root, candidate)
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('provider acceptance artifact path escapes its run root')
  }
}

const safeError = (error: unknown): Record<string, unknown> => {
  const name = error instanceof Error && error.name.trim()
    ? error.name.slice(0, 128)
    : 'Error'
  const message = redactSensitiveText(
    error instanceof Error ? error.message : String(error),
  )
  return {
    error_name: name,
    error_message: (message.value ?? 'provider acceptance check failed').slice(0, 2_000),
    redacted: message.changed,
  }
}

const safeDetail = (detail: Record<string, unknown>): SafeDetail => {
  const redacted = redactStructuredValue(detail)
  return {
    value: redacted.value,
    redactions: redacted.redactions,
  }
}

const writeJsonAtomic = (
  path: string,
  value: unknown,
  forbiddenSubstrings: readonly string[],
): { sha256: string; json: string } => {
  const json = `${stableJson(value)}\n`
  for (const forbidden of forbiddenSubstrings) {
    if (forbidden && json.includes(forbidden)) {
      throw new Error('provider acceptance artifact contains forbidden sensitive material')
    }
  }
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, json, 'utf8')
    closeSync(descriptor)
  } catch (error) {
    try {
      closeSync(descriptor)
    } catch {
      // Preserve the original write failure.
    }
    rmSync(temporary, { force: true })
    throw error
  }
  renameSync(temporary, path)
  chmodSync(path, 0o600)
  return {
    sha256: canonicalHash(JSON.parse(json) as unknown),
    json,
  }
}

export const acceptanceCheckV1 = (
  checkId: string,
  state: ProviderAcceptanceCheckStateV1,
  evidenceKind: ProviderAcceptanceEvidenceKindV1,
  detail: Record<string, unknown> = {},
): ProviderAcceptanceCheckV1 => {
  if (!CHECK_ID.test(checkId)) {
    throw new Error(`invalid provider acceptance check id: ${checkId}`)
  }
  return Object.freeze({
    check_id: checkId,
    state,
    evidence_kind: evidenceKind,
    detail: Object.freeze({ ...detail }),
  })
}

export const failedAcceptanceCheckV1 = (
  checkId: string,
  evidenceKind: ProviderAcceptanceEvidenceKindV1,
  error: unknown,
): ProviderAcceptanceCheckV1 =>
  acceptanceCheckV1(checkId, 'failed', evidenceKind, safeError(error))

export class ProviderAcceptanceRunV1 {
  readonly #artifactRoot: string
  readonly #referenceRoot: string
  readonly #tuple: ProviderAcceptanceTupleV1
  readonly #forbiddenSubstrings: readonly string[]
  readonly #now: () => Date
  readonly #gates = new Map<
    DeclaredProviderAcceptanceGateIdV1,
    ProviderAcceptanceGateRecordV1
  >()

  constructor(options: ProviderAcceptanceRunOptionsV1) {
    if (!isAbsolute(options.artifact_root)) {
      throw new Error('provider acceptance artifact root must be absolute')
    }
    if (!EVIDENCE_REF.test(options.reference_root)
      || options.reference_root.includes('..')) {
      throw new Error('provider acceptance reference root is invalid')
    }
    this.#artifactRoot = resolve(options.artifact_root)
    this.#referenceRoot = options.reference_root.replace(/\/+$/u, '')
    this.#tuple = options.tuple
    this.#forbiddenSubstrings = Object.freeze(
      [...new Set(options.forbidden_substrings ?? [])].filter(Boolean),
    )
    this.#now = options.now ?? (() => new Date())
    mkdirSync(this.#artifactRoot, { recursive: true, mode: 0o700 })
    chmodSync(this.#artifactRoot, 0o700)
  }

  async gate(
    gateId: DeclaredProviderAcceptanceGateIdV1,
    run: () => Promise<readonly ProviderAcceptanceCheckV1[]>,
  ): Promise<ProviderAcceptanceGateRecordV1> {
    if (!DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.includes(gateId)) {
      throw new Error(`unknown provider acceptance gate: ${gateId}`)
    }
    if (this.#gates.has(gateId)) {
      throw new Error(`provider acceptance gate already recorded: ${gateId}`)
    }
    const startedAt = this.#now().toISOString()
    let checks: readonly ProviderAcceptanceCheckV1[]
    try {
      checks = await run()
    } catch (error) {
      checks = [failedAcceptanceCheckV1('gate_execution', 'observed', error)]
    }
    if (checks.length === 0) {
      checks = [
        acceptanceCheckV1(
          'missing_checks',
          'failed',
          'source_contract',
          { reason_code: 'provider_acceptance_gate_has_no_checks' },
        ),
      ]
    }
    const checkIds = checks.map((check) => check.check_id)
    if (new Set(checkIds).size !== checkIds.length) {
      throw new Error(`provider acceptance gate has duplicate checks: ${gateId}`)
    }
    if (!checks.some((check) => check.evidence_kind === 'observed')) {
      checks = [
        ...checks,
        acceptanceCheckV1(
          'observed_evidence_required',
          'failed',
          'source_contract',
          { reason_code: 'provider_acceptance_gate_requires_observed_evidence' },
        ),
      ]
    }
    const completedAt = this.#now().toISOString()
    let redactions = 0
    const safeChecks = checks.map((check) => {
      if (!CHECK_ID.test(check.check_id)
        || !['passed', 'failed'].includes(check.state)
        || !['observed', 'negative_control', 'source_contract'].includes(
          check.evidence_kind,
        )) {
        throw new Error(`provider acceptance gate check is invalid: ${gateId}`)
      }
      const safe = safeDetail(check.detail)
      redactions += safe.redactions
      return Object.freeze({
        check_id: check.check_id,
        state: check.state,
        evidence_kind: check.evidence_kind,
        detail: Object.freeze(safe.value),
      })
    })
    const artifact: ProviderAcceptanceGateArtifactV1 = Object.freeze({
      schema_version: 1,
      gate_id: gateId,
      source_commit: this.#tuple.source_commit,
      started_at: assertTimestamp(startedAt),
      completed_at: assertTimestamp(completedAt),
      state: safeChecks.every((check) => check.state === 'passed')
        ? 'passed'
        : 'failed',
      checks: Object.freeze(safeChecks),
      redactions_applied: redactions,
    })
    const gatesDirectory = resolve(this.#artifactRoot, 'gates')
    assertContainedPath(this.#artifactRoot, gatesDirectory)
    mkdirSync(gatesDirectory, { recursive: true, mode: 0o700 })
    chmodSync(gatesDirectory, 0o700)
    const path = resolve(gatesDirectory, `${gateId}.json`)
    assertContainedPath(this.#artifactRoot, path)
    const written = writeJsonAtomic(path, artifact, this.#forbiddenSubstrings)
    const record = Object.freeze({
      gate_id: gateId,
      state: artifact.state,
      evidence_ref: `${this.#referenceRoot}/gates/${gateId}.json`,
      artifact_sha256: written.sha256,
      artifact,
    })
    this.#gates.set(gateId, record)
    return record
  }

  finalize(databasePath?: string): ProviderAcceptanceFinalizationV1 {
    const missing = DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.filter(
      (gateId) => !this.#gates.has(gateId),
    )
    if (missing.length > 0) {
      throw new Error(`provider acceptance gates are missing: ${missing.join(', ')}`)
    }
    const gates = DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.map(
      (gateId) => this.#gates.get(gateId) as ProviderAcceptanceGateRecordV1,
    )
    const observedAt = gates
      .map((gate) => gate.artifact.completed_at)
      .sort()
      .at(-1) as string
    const matrix = defineDeclaredProviderAcceptanceMatrixV1({
      ...this.#tuple,
      observed_at: observedAt,
      gates: Object.fromEntries(gates.map((gate) => [
        gate.gate_id,
        {
          state: gate.state,
          evidence_refs: [gate.evidence_ref],
        },
      ])) as unknown as DeclaredProviderAcceptanceMatrixV1['gates'],
    })
    if (databasePath !== undefined
      && !gates.every((gate) => gate.state === 'passed')) {
      throw new Error('refusing to persist incomplete provider acceptance evidence')
    }
    const matrixPath = resolve(this.#artifactRoot, 'matrix.json')
    assertContainedPath(this.#artifactRoot, matrixPath)
    const matrixWritten = writeJsonAtomic(
      matrixPath,
      matrix,
      this.#forbiddenSubstrings,
    )
    if (!SHA256.test(matrixWritten.sha256)) {
      throw new Error('provider acceptance matrix digest is invalid')
    }
    const matrixRef = `${this.#referenceRoot}/matrix.json`
    let evidenceRecord: ProviderAcceptanceEvidenceRecordV1 | null = null
    if (databasePath !== undefined) {
      const db = openDb(databasePath)
      try {
        const registry = new ProviderAdapterRegistryV1()
        const store = new ProviderAcceptanceEvidenceStoreV1(db, {
          now: this.#now,
        })
        evidenceRecord = store.record(
          registry,
          matrix as DeclaredProviderAcceptanceMatrixV1,
          {
            artifact_ref: matrixRef,
            artifact_sha256: matrixWritten.sha256,
          },
        )
      } finally {
        db.close()
      }
    }
    return Object.freeze({
      matrix,
      matrix_ref: matrixRef,
      matrix_sha256: matrixWritten.sha256,
      gates: Object.freeze(gates),
      evidence_record: evidenceRecord,
    })
  }
}

export const verifyProviderAcceptanceArtifactsV1 = (
  artifactRoot: string,
  finalization: Pick<
    ProviderAcceptanceFinalizationV1,
    'matrix' | 'matrix_sha256' | 'gates'
  >,
  forbiddenSubstrings: readonly string[] = [],
): void => {
  const root = resolve(artifactRoot)
  for (const gate of finalization.gates) {
    const path = resolve(root, 'gates', `${gate.gate_id}.json`)
    assertContainedPath(root, path)
    const bytes = readFileSync(path)
    const text = bytes.toString('utf8')
    if (canonicalHash(JSON.parse(text) as unknown) !== gate.artifact_sha256) {
      throw new Error(`provider acceptance artifact digest mismatch: ${gate.gate_id}`)
    }
    for (const forbidden of forbiddenSubstrings) {
      if (forbidden && text.includes(forbidden)) {
        throw new Error(`provider acceptance artifact contains forbidden material: ${gate.gate_id}`)
      }
    }
  }
  const matrixPath = resolve(root, 'matrix.json')
  assertContainedPath(root, matrixPath)
  const matrixText = readFileSync(matrixPath, 'utf8')
  if (canonicalHash(JSON.parse(matrixText) as unknown) !== finalization.matrix_sha256
    || stableJson(JSON.parse(matrixText) as unknown) !== stableJson(finalization.matrix)) {
    throw new Error('provider acceptance matrix verification failed')
  }
  for (const forbidden of forbiddenSubstrings) {
    if (forbidden && matrixText.includes(forbidden)) {
      throw new Error('provider acceptance matrix contains forbidden material')
    }
  }
}

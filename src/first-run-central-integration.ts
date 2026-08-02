import fs from 'node:fs'
import path from 'node:path'
import { openDb } from './db.js'
import {
  DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1,
  type DeclaredProviderCompatibilityContractV1,
} from './declared-provider-compatibility.js'
import { providerToolEvidenceSourceCommit } from './daemon.js'
import { firstRunConfigPath } from './first-run-onboarding.js'
import type {
  LifecycleDemoLaunchAttestationV1,
  LifecycleDemoLaunchGateDeps,
} from './lifecycle-demo.js'
import {
  FIRST_RELEASE_PROVIDER_MANIFESTS_V1,
} from './provider-manifests.js'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
} from './provider-adapter-registry.js'
import {
  ProviderAcceptanceEvidenceStoreV1,
  type ProviderAcceptanceEvidenceRecordV1,
} from './provider-acceptance-evidence-store.js'
import type { ProviderManifestV1 } from './provider-contract.js'
import {
  runOperatorReadinessDoctor,
  type OperatorDoctorReport,
} from './readiness-doctor.js'

type LaunchProvider = 'claude' | 'codex'

type ReadinessResult = Pick<
  OperatorDoctorReport,
  'mode' | 'provider' | 'ready' | 'checked_at'
>

export type CentralFirstRunDemoLaunchGateDeps = {
  env?: NodeJS.ProcessEnv
  runDoctor?: (
    provider: LaunchProvider,
    env: NodeJS.ProcessEnv,
  ) => ReadinessResult
  loadVerifiedEvidence?: (
    databasePath: string,
  ) => readonly ProviderAcceptanceEvidenceRecordV1[]
  providerContract?: DeclaredProviderCompatibilityContractV1
  providerManifests?: readonly Readonly<ProviderManifestV1>[]
}

const loadVerifiedEvidence = (
  databasePath: string,
): readonly ProviderAcceptanceEvidenceRecordV1[] => {
  if (!fs.existsSync(databasePath)) {
    throw new Error('retained provider acceptance database is unavailable')
  }
  const db = openDb(databasePath)
  try {
    return new ProviderAcceptanceEvidenceStoreV1(db).verified()
  } finally {
    db.close()
  }
}

const exactAcceptance = (
  provider: LaunchProvider,
  records: () => readonly ProviderAcceptanceEvidenceRecordV1[],
  sourceCommit: string,
  contract: DeclaredProviderCompatibilityContractV1,
  manifests: readonly Readonly<ProviderManifestV1>[],
): LifecycleDemoLaunchAttestationV1['acceptance'] => {
  const declaration = contract.providers.find((candidate) =>
    candidate.provider_id === provider)
  const manifest = manifests.find((candidate) =>
    candidate.provider_id === provider)
  const nativeMode = manifest?.modes.find((candidate) =>
    candidate.id === declaration?.native_subscription.mode_id)
  if (!declaration
    || !manifest
    || declaration.release_state !== 'validated'
    || declaration.acceptance.real_matrix_state !== 'passed'
    || declaration.acceptance.support_claim !== 'ready'
    || declaration.acceptance.blocker_codes.length !== 0
    || manifest.release_state !== 'validated'
    || manifest.environment.audit_state !== 'complete'
    || !nativeMode
    || nativeMode.support.state !== 'supported'
    || nativeMode.automation_policy !== 'allowed') {
    throw new Error(`${provider} managed launch remains unsupported by the declared provider matrix`)
  }

  const matches = records().filter((record) => {
    const matrix = record.matrix
    return /^pe_[a-f0-9]{64}$/.test(record.id)
      && /^[a-f0-9]{64}$/.test(record.matrix_sha256)
      && /^[a-f0-9]{64}$/.test(record.artifact_sha256)
      && matrix.provider_id === declaration.provider_id
      && matrix.adapter_id === declaration.adapter_id
      && matrix.adapter_version === manifest.adapter_version
      && matrix.mode_id === declaration.native_subscription.mode_id
      && matrix.runtime_mode === declaration.native_subscription.runtime_mode
      && matrix.billing_mode === declaration.native_subscription.billing_mode
      && matrix.credential_kind === declaration.native_subscription.credential_kind
      && declaration.executable.exact_versions.includes(matrix.executable_version)
      && declaration.executable.exact_platforms.includes(matrix.platform)
      && matrix.source_commit === sourceCommit
      && DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.every((gateId) =>
        matrix.gates[gateId].state === 'passed'
        && matrix.gates[gateId].evidence_refs.length > 0)
  }).sort((left, right) =>
    Date.parse(right.matrix.observed_at) - Date.parse(left.matrix.observed_at)
    || Date.parse(right.recorded_at) - Date.parse(left.recorded_at)
    || right.id.localeCompare(left.id))

  const retained = matches[0]
  if (!retained) {
    throw new Error(`${provider} launch lacks an exact retained provider acceptance tuple`)
  }
  return {
    accepted: true,
    runtime_mode: 'native_cli',
    billing_mode: 'personal_subscription',
    source_commit: retained.matrix.source_commit,
    matrix_sha256: retained.matrix_sha256,
    executable_version: retained.matrix.executable_version,
    platform: retained.matrix.platform,
  }
}

export const createCentralFirstRunDemoLaunchGate = (
  deps: CentralFirstRunDemoLaunchGateDeps = {},
): LifecycleDemoLaunchGateDeps => {
  const env = deps.env ?? process.env
  const runDoctor = deps.runDoctor ?? runOperatorReadinessDoctor
  const readEvidence = deps.loadVerifiedEvidence ?? loadVerifiedEvidence
  const contract = deps.providerContract
    ?? DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1
  const manifests = deps.providerManifests ?? FIRST_RELEASE_PROVIDER_MANIFESTS_V1

  return {
    runDoctor: (provider) => {
      const report = runDoctor(provider, env)
      if (report.mode !== 'readiness' || report.provider !== provider) {
        return {
          mode: 'readiness',
          provider,
          ready: false,
          checked_at: report.checked_at,
        }
      }
      return {
        mode: report.mode,
        provider: report.provider,
        ready: report.ready,
        checked_at: report.checked_at,
      }
    },
    requireExactAcceptance: async (provider, _projectRoot) => {
      const sourceCommit = providerToolEvidenceSourceCommit(env)
      if (!sourceCommit) {
        throw new Error(
          'ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT must identify the exact accepted provider source',
        )
      }
      const databasePath = path.join(
        path.dirname(firstRunConfigPath(env)),
        'orchestra.db',
      )
      return exactAcceptance(
        provider,
        () => readEvidence(databasePath),
        sourceCommit,
        contract,
        manifests,
      )
    },
  }
}

import { describe, expect, it } from 'vitest'
import {
  DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1,
  assessDeclaredProviderCompatibilityV1,
  defineDeclaredProviderCompatibilityContractV1,
  type DeclaredProviderCompatibilityEvidenceV1,
  type DeclaredProviderIdV1,
} from '../src/declared-provider-compatibility.js'
import {
  ENVIRONMENT_COMPATIBILITY_CONTRACT,
  ENVIRONMENT_DECLARED_PROVIDER_COMPATIBILITY_CONTRACT,
} from '../src/environment-compatibility.js'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
  type DeclaredProviderAcceptanceMatrixV1,
} from '../src/provider-adapter-registry.js'
import {
  FIRST_RELEASE_PROVIDER_MANIFESTS_V1,
} from '../src/provider-manifests.js'

const SOURCE_COMMIT = 'a'.repeat(40)
const FINGERPRINT = `sha256:${'b'.repeat(64)}`

const mutableContract = (): any => JSON.parse(JSON.stringify(
  ENVIRONMENT_COMPATIBILITY_CONTRACT.declared_provider_matrix,
))

const passedMatrix = (
  providerId: DeclaredProviderIdV1,
  version: string,
  platform: string,
): DeclaredProviderAcceptanceMatrixV1 => {
  const declaration = DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1.providers
    .find((candidate) => candidate.provider_id === providerId)!
  return {
    contract_version: 1,
    provider_id: providerId,
    adapter_id: declaration.adapter_id,
    adapter_version: FIRST_RELEASE_PROVIDER_MANIFESTS_V1
      .find((manifest) => manifest.provider_id === providerId)!.adapter_version,
    mode_id: declaration.native_subscription.mode_id,
    runtime_mode: declaration.native_subscription.runtime_mode,
    billing_mode: declaration.native_subscription.billing_mode,
    credential_kind: declaration.native_subscription.credential_kind,
    executable_version: version,
    platform,
    source_commit: SOURCE_COMMIT,
    observed_at: '2026-07-25T12:00:00.000Z',
    gates: Object.fromEntries(DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.map((gateId) => [
      gateId,
      {
        state: 'passed' as const,
        evidence_refs: [`artifact://base-010/${providerId}/${gateId}`],
      },
    ])) as DeclaredProviderAcceptanceMatrixV1['gates'],
  }
}

const evidence = (
  providerId: DeclaredProviderIdV1,
  overrides: Partial<DeclaredProviderCompatibilityEvidenceV1> = {},
): DeclaredProviderCompatibilityEvidenceV1 => {
  const declaration = DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1.providers
    .find((candidate) => candidate.provider_id === providerId)!
  const version = declaration.executable.exact_versions[0] ?? '0.0.0'
  const platform = declaration.executable.exact_platforms[0] ?? 'darwin-arm64'
  const source = declaration.executable.source
  return {
    provider_id: providerId,
    execution_scope: 'managed_background',
    evidence_kind: 'observed',
    source_commit: SOURCE_COMMIT,
    discovery: {
      contract_version: 1,
      provider_id: providerId,
      adapter_id: declaration.adapter_id,
      status: 'validated',
      source,
      version,
      platform,
      resolved_path: null,
      executable_fingerprint: FINGERPRINT,
    },
    readiness: {
      contract_version: 1,
      observed_at: '2026-07-25T12:00:00.000Z',
      selection: {
        provider_id: providerId,
        adapter_id: declaration.adapter_id,
        mode_id: declaration.native_subscription.mode_id,
        runtime_mode: declaration.native_subscription.runtime_mode,
        billing_mode: declaration.native_subscription.billing_mode,
        credential_kind: declaration.native_subscription.credential_kind,
      },
      executable_status: 'validated',
      auth_status: 'ready',
      automation_policy: declaration.native_subscription.automation_policy,
      overage_status: declaration.native_subscription.overage_behavior === 'none'
        ? 'not_applicable'
        : 'disabled',
      overage_consent: declaration.native_subscription.overage_behavior === 'none'
        ? 'not_required'
        : 'missing',
      metering_status: declaration.native_subscription.overage_behavior === 'none'
        ? 'not_required'
        : 'unknown',
      cost_cap_status: declaration.native_subscription.overage_behavior === 'none'
        ? 'not_required'
        : 'unknown',
      executable_fingerprint: FINGERPRINT,
      environment_fingerprint: FINGERPRINT,
      configuration_fingerprint: FINGERPRINT,
    },
    acceptance_matrix: passedMatrix(providerId, version, platform),
    ...overrides,
  }
}

describe('BASE-010 declared-provider compatibility contract', () => {
  it('validates the provider matrix on the shipped environment-doctor import path', () => {
    expect(ENVIRONMENT_DECLARED_PROVIDER_COMPATIBILITY_CONTRACT)
      .toBe(DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1)
    expect(ENVIRONMENT_DECLARED_PROVIDER_COMPATIBILITY_CONTRACT.providers)
      .toHaveLength(5)
  })
  it('declares every first-release provider with exact executable, auth, billing, overage, and evidence truth', () => {
    expect(DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1).toMatchObject({
      schema_version: 1,
      evidence_standard: 'real_exact_eight_gate',
      source_commit_required: true,
      mock_evidence_authorizes_support: false,
    })
    expect(DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1.providers
      .map((provider) => provider.provider_id))
      .toEqual(['claude', 'codex', 'qwen', 'kimi', 'opencode'])

    for (const provider of DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1.providers) {
      expect(provider.native_subscription).toMatchObject({
        runtime_mode: 'native_cli',
        billing_mode: 'personal_subscription',
      })
      expect(provider.provider_api).toMatchObject({
        billing_mode: 'usage_priced_api',
        explicit_opt_in_required: true,
        automatic_fallback_allowed: false,
      })
      expect(provider.acceptance).toMatchObject({
        real_matrix_state: 'missing',
        support_claim: 'blocked',
      })
      expect(provider.acceptance.blocker_codes).toContain(
        'real_acceptance_matrix_missing',
      )
    }
  })

  it('keeps exact manifest and external-evidence limitations explicit', () => {
    const byId = Object.fromEntries(
      DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1.providers
        .map((provider) => [provider.provider_id, provider]),
    )

    expect(byId.claude).toMatchObject({
      release_state: 'unsupported',
      executable: {
        source: 'sdk_bundled',
        exact_versions: ['2.1.212'],
        exact_platforms: ['darwin-arm64'],
      },
      native_subscription: {
        authentication_mechanism: 'claude_ai_account_session',
        automation_policy: 'blocked',
      },
    })
    expect(byId.codex).toMatchObject({
      release_state: 'candidate',
      executable: {
        source: 'path',
        command_override_env: 'ORCHESTRA_CODEX_COMMAND',
        exact_versions: ['0.146.0'],
        exact_platforms: ['darwin-arm64'],
      },
      native_subscription: {
        authentication_mechanism: 'chatgpt_account_session',
      },
    })
    expect(byId.qwen).toMatchObject({
      release_state: 'candidate',
      executable: {
        exact_versions: ['0.21.6'],
        exact_platforms: ['darwin-arm64'],
      },
      native_subscription: {
        credential_kind: 'subscription_scoped_key',
        automation_policy: 'allowed',
        safe_readiness_probe: ['--version'],
      },
    })
    expect(byId.kimi).toMatchObject({
      release_state: 'unsupported',
      executable: { exact_versions: [], exact_platforms: [] },
      native_subscription: {
        overage_behavior: 'optional_metered',
        explicit_overage_consent_required: true,
        safe_readiness_probe: null,
      },
    })
    expect(byId.opencode).toMatchObject({
      release_state: 'candidate',
      executable: {
        source: 'path',
        command_override_env: 'ORCHESTRA_OPENCODE_COMMAND',
        exact_versions: ['1.18.25'],
        exact_platforms: ['darwin-arm64'],
      },
      native_subscription: {
        credential_kind: 'provider_account_session',
        authentication_mechanism: 'opencode_auth_login',
        // Unlike Qwen/Codex, whether OpenCode's own upstream-provider terms
        // permit autonomous use is unresolved (see design spec, "Out of
        // scope") — automation_policy and overage stay 'unknown', not 'allowed'.
        automation_policy: 'unknown',
        overage_behavior: 'unknown',
        safe_readiness_probe: ['--version'],
      },
    })
  })

  it.each([
    ['mock support', (copy: any) => {
      copy.mock_evidence_authorizes_support = true
    }],
    ['missing provider', (copy: any) => {
      copy.providers.pop()
    }],
    ['provider reorder', (copy: any) => {
      copy.providers.reverse()
    }],
    ['executable version drift', (copy: any) => {
      copy.providers[1].executable.exact_versions = ['0.145.0']
    }],
    ['executable source drift', (copy: any) => {
      copy.providers[0].executable.source = 'path'
    }],
    ['subscription billing drift', (copy: any) => {
      copy.providers[1].native_subscription.billing_mode = 'usage_priced_api'
    }],
    ['overage drift', (copy: any) => {
      copy.providers[3].native_subscription.overage_behavior = 'none'
    }],
    ['API fallback', (copy: any) => {
      copy.providers[2].provider_api.automatic_fallback_allowed = true
    }],
    ['claimed acceptance', (copy: any) => {
      copy.providers[1].acceptance.support_claim = 'ready'
    }],
  ])('rejects %s instead of weakening the exact matrix', (_case, mutate) => {
    const copy = mutableContract()
    mutate(copy)
    expect(() => defineDeclaredProviderCompatibilityContractV1(copy))
      .toThrow(/invalid declared-provider compatibility contract/)
  })

  it('does not authorize current source-level Claude or Codex candidates even with a forged all-pass shape', () => {
    const claude = assessDeclaredProviderCompatibilityV1(evidence('claude'))
    const codex = assessDeclaredProviderCompatibilityV1(evidence('codex'))

    expect(claude.ready).toBe(false)
    expect(claude.blockers).toEqual(expect.arrayContaining([
      'automation_not_allowed',
      'manifest_not_validated',
      'mode_not_supported',
    ]))
    expect(codex.ready).toBe(false)
    expect(codex.blockers).toEqual(expect.arrayContaining([
      'manifest_not_validated',
      'mode_not_supported',
    ]))
  })

  it.each(['source_only', 'mock'] as const)(
    'rejects %s evidence even when every supplied tuple and gate appears exact',
    (evidenceKind) => {
      const assessment = assessDeclaredProviderCompatibilityV1(evidence('codex', {
        evidence_kind: evidenceKind,
      }))

      expect(assessment.ready).toBe(false)
      expect(assessment.blockers).toContain('non_observed_evidence')
    },
  )

  it('fails closed on nearby versions, executable-source changes, and missing real matrices', () => {
    const nearby = evidence('codex')
    nearby.discovery.version = '0.145.0'
    nearby.discovery.status = 'incompatible'
    const nearbyAssessment = assessDeclaredProviderCompatibilityV1(nearby)
    expect(nearbyAssessment.blockers).toEqual(expect.arrayContaining([
      'acceptance_matrix_mismatch',
      'executable_not_validated',
      'executable_version_not_validated',
    ]))

    const wrongSource = evidence('claude')
    wrongSource.discovery.source = 'path'
    expect(assessDeclaredProviderCompatibilityV1(wrongSource).blockers)
      .toContain('executable_source_mismatch')

    const noMatrix = evidence('codex', { acceptance_matrix: null })
    expect(assessDeclaredProviderCompatibilityV1(noMatrix).blockers)
      .toEqual(expect.arrayContaining([
        'acceptance_matrix_missing',
        'billing_not_verified',
      ]))
  })

  it('keeps a cold version-probe timeout indeterminate instead of calling the executable missing or accepting a warm retry', () => {
    const coldProbe = evidence('claude')
    coldProbe.discovery.status = 'unknown'
    coldProbe.discovery.version = null
    coldProbe.readiness.executable_status = 'unknown'
    const coldAssessment = assessDeclaredProviderCompatibilityV1(coldProbe)

    expect(coldAssessment.ready).toBe(false)
    expect(coldAssessment.blockers).toEqual(expect.arrayContaining([
      'executable_not_validated',
      'executable_probe_indeterminate',
      'executable_version_not_validated',
    ]))
    expect(coldAssessment.blockers).not.toContain('executable_missing')

    const warmRetry = assessDeclaredProviderCompatibilityV1(evidence('claude'))
    expect(warmRetry.ready).toBe(false)
    expect(warmRetry.blockers).toEqual(expect.arrayContaining([
      'declared_support_blocked',
      'manifest_not_validated',
      'mode_not_supported',
    ]))
  })

  it('clears owner-authorized Qwen automation of policy blockers and keeps Kimi unknown overage fail-closed', () => {
    const qwen = assessDeclaredProviderCompatibilityV1(evidence('qwen'))
    expect(qwen.ready).toBe(false)
    expect(qwen.blockers).toEqual(expect.arrayContaining([
      'manifest_not_validated',
      'mode_not_supported',
    ]))
    expect(qwen.blockers).not.toContain('automation_not_allowed')
    expect(qwen.blockers).not.toContain('executable_version_not_validated')
    expect(qwen.blockers).not.toContain('platform_not_validated')

    const qwenWithoutMatrix = assessDeclaredProviderCompatibilityV1(evidence('qwen', {
      acceptance_matrix: null,
    }))
    expect(qwenWithoutMatrix.ready).toBe(false)
    expect(qwenWithoutMatrix.blockers).toEqual(expect.arrayContaining([
      'acceptance_matrix_missing',
      'billing_not_verified',
    ]))

    const kimiEvidence = evidence('kimi')
    kimiEvidence.readiness.overage_status = 'unknown'
    const kimi = assessDeclaredProviderCompatibilityV1(kimiEvidence)
    expect(kimi.ready).toBe(false)
    expect(kimi.blockers).toContain('overage_not_verified')
  })

  it('fails closed on OpenCode automation policy instead of assuming subscription-first authorization', () => {
    // Unlike Qwen (owner-authorized `allowed`), OpenCode's automation_policy is
    // deliberately `unknown` because whether its upstream-provider terms permit
    // autonomous use was never resolved — this must block, not silently pass.
    const opencode = assessDeclaredProviderCompatibilityV1(evidence('opencode'))
    expect(opencode.ready).toBe(false)
    expect(opencode.blockers).toEqual(expect.arrayContaining([
      'automation_not_allowed',
      'manifest_not_validated',
      'mode_not_supported',
    ]))
    expect(opencode.blockers).not.toContain('executable_version_not_validated')
    expect(opencode.blockers).not.toContain('platform_not_validated')
  })
})

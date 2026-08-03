import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import {
  DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1,
  type DeclaredProviderCompatibilityContractV1,
} from '../src/declared-provider-compatibility.js'
import {
  createCentralFirstRunDemoLaunchGate,
} from '../src/first-run-central-integration.js'
import { registerFirstRunCommands } from '../src/first-run-cli.js'
import { buildFirstRunPlan } from '../src/first-run-onboarding.js'
import { createLifecycleDemoLaunchAuthorizer } from '../src/lifecycle-demo.js'
import {
  FIRST_RELEASE_PROVIDER_MANIFESTS_V1,
} from '../src/provider-manifests.js'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
  type DeclaredProviderAcceptanceMatrixV1,
} from '../src/provider-adapter-registry.js'
import type {
  ProviderAcceptanceEvidenceRecordV1,
} from '../src/provider-acceptance-evidence-store.js'
import type { ProviderManifestV1 } from '../src/provider-contract.js'

const setup = (overrides: Parameters<typeof registerFirstRunCommands>[1] = {}) => {
  const output: string[] = []
  const program = new Command().name('orchestra').exitOverride()
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
  registerFirstRunCommands(program, {
    cwd: () => '/workspace/project',
    ask: vi.fn(async (_question, defaultValue) => defaultValue),
    output: (line) => output.push(line),
    ...overrides,
  })
  const run = (...args: string[]) => program.parseAsync(['node', 'orchestra', ...args])
  return { output, run }
}

const sourceCommit = 'a'.repeat(40)

const readyProviderInputs = () => {
  const providerContract = structuredClone(
    DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1,
  ) as DeclaredProviderCompatibilityContractV1
  const providerManifests = structuredClone(
    FIRST_RELEASE_PROVIDER_MANIFESTS_V1,
  ) as ProviderManifestV1[]
  const declaration = providerContract.providers.find((candidate) =>
    candidate.provider_id === 'codex')!
  const manifest = providerManifests.find((candidate) =>
    candidate.provider_id === 'codex')!
  declaration.release_state = 'validated'
  declaration.acceptance = {
    real_matrix_state: 'passed',
    support_claim: 'ready',
    blocker_codes: [],
  }
  manifest.release_state = 'validated'
  const nativeMode = manifest.modes.find((candidate) =>
    candidate.id === declaration.native_subscription.mode_id)!
  nativeMode.support = { state: 'supported' }

  const matrix: DeclaredProviderAcceptanceMatrixV1 = {
    contract_version: 1,
    provider_id: 'codex',
    adapter_id: declaration.adapter_id,
    adapter_version: manifest.adapter_version,
    mode_id: declaration.native_subscription.mode_id,
    runtime_mode: declaration.native_subscription.runtime_mode,
    billing_mode: declaration.native_subscription.billing_mode,
    credential_kind: declaration.native_subscription.credential_kind,
    executable_version: declaration.executable.exact_versions[0]!,
    platform: declaration.executable.exact_platforms[0]!,
    source_commit: sourceCommit,
    observed_at: '2026-08-02T12:00:00.000Z',
    gates: Object.fromEntries(
      DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.map((gateId) => [
        gateId,
        { state: 'passed' as const, evidence_refs: [`evidence/${gateId}.json`] },
      ]),
    ) as DeclaredProviderAcceptanceMatrixV1['gates'],
  }
  const record: ProviderAcceptanceEvidenceRecordV1 = {
    id: `pe_${'b'.repeat(64)}`,
    matrix,
    matrix_sha256: 'c'.repeat(64),
    artifact_ref: 'file:///retained/provider/matrix.json',
    artifact_sha256: 'd'.repeat(64),
    recorded_at: '2026-08-02T12:01:00.000Z',
  }
  return { providerContract, providerManifests, record }
}

describe('first-run CLI registrar', () => {
  it('prints a machine-readable safe plan without applying changes', async () => {
    const applyPlan = vi.fn()
    const { output, run } = setup({ applyPlan })

    await run(
      'onboard',
      '--project', '/workspace/project',
      '--provider', 'codex',
      '--mode', 'native_subscription',
      '--hooks', 'off',
      '--telemetry', 'off',
      '--json',
    )

    expect(JSON.parse(output[0])).toMatchObject({
      provider: { id: 'codex', release_state: 'candidate' },
      defaults: { remote_access: 'off', usage_priced_api_fallback: 'off' },
      ready_for_managed_launch: false,
    })
    expect(applyPlan).not.toHaveBeenCalled()
  })

  it('applies only after an explicit flag', async () => {
    const applyPlan = vi.fn(() => ({ schema_version: 1 })) as any
    const { output, run } = setup({ applyPlan })
    await run(
      'onboard',
      '--project', '/workspace/project',
      '--provider', 'codex',
      '--mode', 'native_subscription',
      '--hooks', 'off',
      '--telemetry', 'off',
      '--apply',
    )
    expect(applyPlan).toHaveBeenCalledOnce()
    expect(output[0]).toContain('Configuration saved')
  })

  it('installs ambient Claude hooks without claiming managed launch support', async () => {
    const applyPlan = vi.fn()
    const applyAmbientHooks = vi.fn(() => ({
      schema_version: 1 as const,
      provider_id: 'claude' as const,
      scope: 'project' as const,
      managed_launch_ready: false,
      managed_launch_blockers: [],
    }))
    const { output, run } = setup({ applyPlan, applyAmbientHooks })

    await run(
      'onboard',
      '--project', '/workspace/project',
      '--provider', 'claude',
      '--mode', 'native_subscription',
      '--hooks', 'project',
      '--telemetry', 'off',
      '--apply-ambient-hooks',
    )

    expect(applyAmbientHooks).toHaveBeenCalledOnce()
    expect(applyPlan).not.toHaveBeenCalled()
    expect(output[0]).toContain('Ambient claude hooks installed (project)')
    expect(output[0]).toContain('Managed provider launch was not enabled')
  })

  it('rejects conflicting onboarding mutations before applying either one', async () => {
    const applyPlan = vi.fn()
    const applyAmbientHooks = vi.fn()
    const { run } = setup({ applyPlan, applyAmbientHooks })

    await expect(run(
      'onboard',
      '--project', '/workspace/project',
      '--provider', 'claude',
      '--hooks', 'project',
      '--apply',
      '--apply-ambient-hooks',
    )).rejects.toThrow('mutually exclusive')
    expect(applyPlan).not.toHaveBeenCalled()
    expect(applyAmbientHooks).not.toHaveBeenCalled()
  })

  it('rejects an invalid provider before any action', async () => {
    const { run } = setup()
    await expect(run('onboard', '--provider', 'imaginary')).rejects.toThrow(
      'provider must be claude|codex|qwen|kimi',
    )
  })
})

describe('central first-run integration', () => {
  it('registers the root CLI and keeps every declared provider plan fail-closed', () => {
    const cliSource = fs.readFileSync(
      new URL('../src/cli.ts', import.meta.url),
      'utf8',
    )
    expect(cliSource).toContain('registerFirstRunCommands(program, {')
    expect(cliSource).toContain('demoLaunchGate: createCentralFirstRunDemoLaunchGate()')

    for (const declaration of DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1.providers) {
      const plan = buildFirstRunPlan({
        project_root: '/workspace/project',
        provider_id: declaration.provider_id,
      }, { directoryExists: () => true })
      expect(plan.provider.declared_acceptance).toEqual(declaration.acceptance)
      expect(plan.blockers.map((blocker) => blocker.code))
        .toContain('provider_acceptance_not_ready')
      expect(plan.ready_for_managed_launch).toBe(false)
    }
  })

  it('refuses a root CLI launch before API or evidence access while the declaration is blocked', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-central-onboard-'))
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-central-state-'))
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Demo\n')
    const api = vi.fn()
    const loadVerifiedEvidence = vi.fn(() => [])
    const program = new Command().name('orchestra').exitOverride()
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
    registerFirstRunCommands(program, {
      api,
      demoLaunchGate: createCentralFirstRunDemoLaunchGate({
        env: {
          ORCHESTRA_HOME: stateRoot,
          ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT: sourceCommit,
        },
        runDoctor: (provider) => ({
          mode: 'readiness',
          provider,
          ready: true,
          checked_at: new Date().toISOString(),
        }),
        loadVerifiedEvidence,
      }),
    })

    await expect(program.parseAsync([
      'node', 'orchestra', 'lifecycle-demo',
      '--project', projectRoot,
      '--provider', 'codex',
      '--launch',
    ])).rejects.toThrow('remains unsupported by the declared provider matrix')
    expect(loadVerifiedEvidence).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
  })

  it('returns only the retained exact declared tuple after a real ready-doctor result', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-central-state-'))
    const { providerContract, providerManifests, record } = readyProviderInputs()
    const runDoctor = vi.fn((provider: 'claude' | 'codex') => ({
      mode: 'readiness' as const,
      provider,
      ready: true,
      checked_at: new Date().toISOString(),
    }))
    const loadVerifiedEvidence = vi.fn(() => [record])
    const gate = createCentralFirstRunDemoLaunchGate({
      env: {
        ORCHESTRA_HOME: stateRoot,
        ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT: sourceCommit,
      },
      runDoctor,
      loadVerifiedEvidence,
      providerContract,
      providerManifests,
    })

    const attestation = await createLifecycleDemoLaunchAuthorizer(gate)(
      'codex',
      '/workspace/project',
    )
    expect(runDoctor).toHaveBeenCalledWith('codex', expect.any(Object))
    expect(loadVerifiedEvidence).toHaveBeenCalledWith(
      path.join(stateRoot, 'orchestra.db'),
    )
    expect(attestation.acceptance).toEqual({
      accepted: true,
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      source_commit: sourceCommit,
      matrix_sha256: record.matrix_sha256,
      executable_version: record.matrix.executable_version,
      platform: record.matrix.platform,
    })
  })

  it('rejects missing or mismatched exact source evidence', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-central-state-'))
    const { providerContract, providerManifests, record } = readyProviderInputs()
    const common = {
      runDoctor: (provider: 'claude' | 'codex') => ({
        mode: 'readiness' as const,
        provider,
        ready: true,
        checked_at: new Date().toISOString(),
      }),
      loadVerifiedEvidence: vi.fn(() => [record]),
      providerContract,
      providerManifests,
    }
    const missing = createCentralFirstRunDemoLaunchGate({
      ...common,
      env: { ORCHESTRA_HOME: stateRoot },
    })
    await expect(missing.requireExactAcceptance('codex', '/workspace/project'))
      .rejects.toThrow('must identify the exact accepted provider source')

    const mismatched = createCentralFirstRunDemoLaunchGate({
      ...common,
      env: {
        ORCHESTRA_HOME: stateRoot,
        ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT: 'e'.repeat(40),
      },
    })
    await expect(mismatched.requireExactAcceptance('codex', '/workspace/project'))
      .rejects.toThrow('lacks an exact retained provider acceptance tuple')
  })
})

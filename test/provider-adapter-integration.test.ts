import { describe, expect, it } from 'vitest'
import {
  PROVIDER_CAPABILITY_IDS,
  PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1,
  authorizeProviderLaunchV1,
  defineProviderExecutionIntentV1,
  defineProviderLaunchBoundaryV1,
  defineProviderManifestV1,
  defineProviderNoCostConsentV1,
  selectProviderExecutionV1,
  type ProviderActionV1,
  type ProviderCapabilityId,
  type ProviderCapabilitiesV1,
  type ProviderExecutionAdapterV1,
  type ProviderExecutionIntentV1,
  type ProviderManifestV1,
} from '../src/provider-contract.js'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
  ProviderAdapterRegistryV1,
  type DeclaredProviderAcceptanceMatrixV1,
} from '../src/provider-adapter-registry.js'
import {
  CLAUDE_PROVIDER_MANIFEST_V1,
  CODEX_PROVIDER_MANIFEST_V1,
  FIRST_RELEASE_PROVIDER_MANIFESTS_V1,
} from '../src/provider-manifests.js'
import {
  defineAgentDriverProviderAdapterV1,
} from '../src/runtime/drivers/provider-adapter.js'
import { createAgentOsRuntime } from '../src/agent-os/runtime-integration.js'
import { openDb } from '../src/db.js'
import type {
  AgentDriver,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
} from '../src/runtime/types.js'

const FINGERPRINT = `sha256:${'a'.repeat(64)}`
let fixtureIndex = 0

const capabilityMatrix = (
  supported: readonly ProviderCapabilityId[],
): ProviderCapabilitiesV1 => Object.fromEntries(
  PROVIDER_CAPABILITY_IDS.map((capability) => [
    capability,
    supported.includes(capability)
      ? { state: 'supported' as const }
      : {
          state: 'unsupported' as const,
          reason_code: 'fixture_capability_unsupported',
        },
  ]),
) as ProviderCapabilitiesV1

const fixtureManifest = (
  extraSupported: readonly ProviderCapabilityId[] = [],
): ProviderManifestV1 => {
  fixtureIndex += 1
  const providerId = `fixture-terminal-${fixtureIndex}`
  const supported = [
    'launch',
    'follow_up',
    'interrupt',
    'cancel',
    'stop',
    'model_discovery',
    'model_selection',
    'effort',
    'access_profile',
    'structured_events',
    'usage',
    'raw_terminal_coexistence',
    ...extraSupported,
  ] as ProviderCapabilityId[]
  return defineProviderManifestV1({
    contract_version: 1,
    provider_id: providerId,
    display_name: `Fixture Terminal ${fixtureIndex}`,
    adapter_id: `${providerId}-adapter`,
    adapter_version: '1.0.0',
    release_state: 'validated',
    protocol: 'native_cli',
    executable: {
      command: providerId,
      source: 'path',
      validated_versions: ['1.0.0'],
      supported_platforms: ['test-platform'],
    },
    environment: {
      audit_state: 'complete',
      conflict_rules: PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1.map(
        ([variable, category]) => ({
          variable,
          category,
          allowed_mode_ids: [],
          allowed_credential_kinds: [],
        }),
      ),
    },
    modes: [{
      id: 'native_subscription',
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      credential_kinds: ['provider_account_session'],
      default_credential_kind: 'provider_account_session',
      priority: 'primary',
      support: { state: 'supported' },
      automation_policy: 'allowed',
      usage_priced_api_consent_required: false,
      overage: {
        behavior: 'none',
        explicit_consent_required: false,
      },
      capabilities: capabilityMatrix(supported),
    }],
  }) as ProviderManifestV1
}

type FakeDriver = AgentDriver & {
  launches: DriverLaunchRequest[]
  attached: string[]
  sent: Array<{ sessionId: string; text: string }>
  interrupted: string[]
  stopped: string[]
}

const fakeDriver = (manifest: ProviderManifestV1): FakeDriver => {
  const launches: DriverLaunchRequest[] = []
  const attached: string[] = []
  const sent: Array<{ sessionId: string; text: string }> = []
  const interrupted: string[] = []
  const stopped: string[] = []
  return {
    id: manifest.provider_id,
    launches,
    attached,
    sent,
    interrupted,
    stopped,
    capabilities: () => ({
      attach: true,
      streaming: true,
      interrupt: true,
      stop: true,
      rawTerminal: false,
      resume: true,
      tokenBudget: false,
      costBudget: false,
    }),
    async launch(request) {
      launches.push(request)
      return {
        id: `${manifest.provider_id}:internal-${launches.length}`,
        externalId: `provider-session-${launches.length}`,
        driverId: manifest.provider_id,
        workspaceId: request.workspaceId,
        status: 'running',
        startedAt: new Date().toISOString(),
        metadata: {},
      }
    },
    async attach(externalId) {
      attached.push(externalId)
      return {
        id: `${manifest.provider_id}:resumed-${attached.length}`,
        externalId,
        driverId: manifest.provider_id,
        workspaceId: 'workspace-1',
        status: 'running',
        startedAt: new Date().toISOString(),
        metadata: {
          cwd: '/workspace',
        },
      }
    },
    async send(sessionId, text) {
      sent.push({ sessionId, text })
    },
    async interrupt(sessionId) {
      interrupted.push(sessionId)
    },
    async cancel(sessionId) {
      interrupted.push(sessionId)
      stopped.push(sessionId)
    },
    async stop(sessionId) {
      stopped.push(sessionId)
    },
    async *events(sessionId): AsyncIterable<DriverEvent> {
      yield {
        sessionId,
        seq: 7,
        type: 'output',
        at: new Date().toISOString(),
        data: 'safe output',
        metadata: { turnId: 'turn-1' },
      }
      yield {
        sessionId,
        seq: 9,
        type: 'tool',
        at: new Date().toISOString(),
        data: 'running tests',
        metadata: {
          itemId: 'tool-1',
          toolName: 'shell',
          nativeMethod: 'item/completed',
        },
      }
      yield {
        sessionId,
        seq: 12,
        type: 'exit',
        at: new Date().toISOString(),
        data: 'done',
      }
    },
  }
}

const bridge = (
  manifest: ProviderManifestV1,
  driver: FakeDriver,
): ProviderExecutionAdapterV1 => defineAgentDriverProviderAdapterV1({
  manifest,
  driver,
  async discoverExecutable() {
    return {
      contract_version: 1,
      provider_id: manifest.provider_id,
      adapter_id: manifest.adapter_id,
      status: 'validated',
      source: 'path',
      version: '1.0.0',
      platform: 'test-platform',
      resolved_path: `/safe/bin/${manifest.executable.command}`,
      executable_fingerprint: FINGERPRINT,
    }
  },
  async probeReadiness(intent, boundary) {
    return {
      contract_version: 1,
      observed_at: new Date().toISOString(),
      selection: intent.selection,
      executable_status: 'validated',
      auth_status: 'ready',
      automation_policy: 'allowed',
      overage_status: 'not_applicable',
      overage_consent: 'not_required',
      metering_status: 'not_required',
      cost_cap_status: 'not_required',
      executable_fingerprint: boundary.evidence.executable_fingerprint,
      environment_fingerprint: boundary.evidence.environment_fingerprint,
      configuration_fingerprint: boundary.evidence.configuration_fingerprint,
    }
  },
  async listModels() {
    return [{
      id: 'fixture-model',
      display_name: 'Fixture model',
      is_default: true,
      supports_effort: true,
      effort_levels: ['high'],
    }]
  },
  async launchRequest() {
    return {
      workspaceId: 'workspace-1',
      cwd: '/untrusted-cwd',
      prompt: 'untrusted prompt',
      env: {
        OPENAI_API_KEY: 'must-not-reach-driver',
      },
      model: 'untrusted-model',
      effort: 'untrusted-effort',
      accessProfile: 'full_access',
      permissionMode: 'bypassPermissions',
      externalId: 'must-not-resume',
      maxBudgetUsd: 1_000_000,
    }
  },
  async resume(context) {
    if (context.action.kind !== 'resume') {
      throw new Error('fixture resume action is required')
    }
    const session = await driver.attach(context.action.provider_session_id)
    if (!session) throw new Error('fixture provider session is missing')
    Object.assign(session.metadata, {
      resolvedModel: context.action.model ?? 'fixture-model',
      resolvedEffort: context.action.effort,
      accessProfile: context.action.access_profile,
    })
    return session
  },
  async sessionEvidence(context) {
    const action = context.action
    if (action.kind !== 'launch'
      && action.kind !== 'resume'
      && action.kind !== 'fork') {
      throw new Error('fixture session evidence requires a creating action')
    }
    return {
      effective_model: action.model ?? 'fixture-model',
      effective_effort: action.effort,
      effective_access_profile: action.access_profile,
    }
  },
  async usage(context) {
    return {
      contract_version: 1,
      observed_at: new Date().toISOString(),
      selection: context.selection,
      action_id: context.action_id,
      scope_id: context.scope_id,
      billing_mode: context.selection.billing_mode,
      status: 'available',
      overage_status: 'not_applicable',
      windows: [],
      metered_cost: null,
    }
  },
})

const executionPlan = (
  manifest: ProviderManifestV1,
): ProviderExecutionIntentV1 => defineProviderExecutionIntentV1({
  selection: selectProviderExecutionV1(manifest),
  execution_scope: 'managed_background',
  usage_priced_api: defineProviderNoCostConsentV1(),
  provider_managed_overage: defineProviderNoCostConsentV1(),
  required_capabilities: ['launch', 'structured_events', 'usage', 'cancel'],
})

const authorize = async (
  adapter: ProviderExecutionAdapterV1,
  plan: ProviderExecutionIntentV1,
  action: ProviderActionV1,
) => {
  const environment = adapter.prepareEnvironment(
    plan,
    {
      PATH: '/safe/bin',
      OPENAI_API_KEY: 'strip-me',
      ANTHROPIC_API_KEY: 'strip-me-too',
    },
    { on_conflict: 'strip' },
  )
  const discovery = await adapter.discoverExecutable()
  const boundary = defineProviderLaunchBoundaryV1(
    adapter.manifest,
    discovery,
    FINGERPRINT,
    environment,
  )
  const readiness = await adapter.probeReadiness(plan, boundary)
  const result = authorizeProviderLaunchV1(
    adapter.manifest,
    plan,
    readiness,
    boundary,
    action,
  )
  if (!result.ready) throw new Error(`fixture authorization failed: ${result.blockers.join(',')}`)
  return result.authorization
}

const launchAction = (): Extract<ProviderActionV1, { kind: 'launch' }> => ({
  contract_version: 1,
  kind: 'launch',
  action_id: 'launch-1',
  scope_id: 'workspace-1',
  cwd: '/workspace',
  prompt: 'Implement the task',
  model: 'fixture-model',
  effort: 'high',
  access_profile: 'workspace_write',
  cost_limit: null,
})

const passingMatrix = (
  manifest: ProviderManifestV1,
  observedAt = new Date().toISOString(),
): DeclaredProviderAcceptanceMatrixV1 => {
  const gates = {} as DeclaredProviderAcceptanceMatrixV1['gates']
  for (const gateId of DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1) {
    gates[gateId] = {
      state: 'passed',
      evidence_refs: [`evidence/${gateId}.json`],
    }
  }
  return {
    contract_version: 1,
    provider_id: manifest.provider_id,
    adapter_id: manifest.adapter_id,
  adapter_version: manifest.adapter_version,
  mode_id: 'native_subscription',
  runtime_mode: 'native_cli',
  billing_mode: 'personal_subscription',
  credential_kind: 'provider_account_session',
    executable_version: '1.0.0',
    platform: 'test-platform',
    source_commit: 'a'.repeat(40),
    observed_at: observedAt,
    gates,
  }
}

describe('TOOL-014 capability-aware adapter integration', () => {
  it('preserves sealed launch evidence across AgentDriver lifecycle, events, and usage', async () => {
    const manifest = fixtureManifest()
    const driver = fakeDriver(manifest)
    const adapter = bridge(manifest, driver)
    const plan = executionPlan(manifest)
    const session = await adapter.launch({
      authorization: await authorize(adapter, plan, launchAction()),
    })

    expect(session).toMatchObject({
      provider_session_id: 'provider-session-1',
      status: 'running',
      model: { requested: 'fixture-model', effective: 'fixture-model' },
      effort: { requested: 'high', effective: 'high' },
      access_profile: {
        requested: 'workspace_write',
        effective: 'workspace_write',
      },
    })
    expect(session.session_id).toMatch(/^managed-/)
    expect(driver.launches[0]).toMatchObject({
      workspaceId: 'workspace-1',
      cwd: '/workspace',
      prompt: 'Implement the task',
      env: { PATH: '/safe/bin' },
      model: 'fixture-model',
      effort: 'high',
      accessProfile: 'workspace_write',
      metadata: {
        providerContractVersion: 1,
        providerActionId: 'launch-1',
        providerBillingMode: 'personal_subscription',
      },
    })
    expect(driver.launches[0]?.env).not.toHaveProperty('OPENAI_API_KEY')
    expect(driver.launches[0]?.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(driver.launches[0]?.externalId).toBeUndefined()
    expect(driver.launches[0]?.permissionMode).toBe('acceptEdits')
    expect(driver.launches[0]?.maxBudgetUsd).toBeUndefined()

    await adapter.interrupt(session.session_id)
    expect(driver.interrupted).toEqual([`${manifest.provider_id}:internal-1`])

    const followUp: Extract<ProviderActionV1, { kind: 'follow_up' }> = {
      contract_version: 1,
      kind: 'follow_up',
      action_id: 'follow-up-1',
      scope_id: 'workspace-1',
      session_id: session.session_id,
      prompt: 'Continue safely',
      cost_limit: null,
    }
    await adapter.followUp({
      authorization: await authorize(adapter, plan, followUp),
    })
    expect(driver.sent).toEqual([{
      sessionId: `${manifest.provider_id}:internal-1`,
      text: 'Continue safely',
    }])
    expect(await adapter.usage(session.session_id)).toMatchObject({
      action_id: 'follow-up-1',
      scope_id: 'workspace-1',
      billing_mode: 'personal_subscription',
    })

    const events = adapter.events(session.session_id)[Symbol.asyncIterator]()
    expect((await events.next()).value).toMatchObject({
      kind: 'output',
      session_id: session.session_id,
      sequence: 1,
      safe_text: 'safe output',
    })
    await adapter.cancel(session.session_id)
    expect(driver.stopped).toEqual([`${manifest.provider_id}:internal-1`])
    expect((await events.next()).value).toMatchObject({
      kind: 'tool',
      session_id: session.session_id,
      sequence: 2,
      tool_call_id: 'tool-1',
      tool_name: 'shell',
      phase: 'completed',
    })
    expect((await events.next()).value).toMatchObject({
      kind: 'status',
      session_id: session.session_id,
      sequence: 3,
      status: 'stopped',
    })
  })

  it('resumes only the authorized provider/workspace/configuration tuple', async () => {
    const manifest = fixtureManifest(['resume', 'restart_recovery'])
    const driver = fakeDriver(manifest)
    const adapter = bridge(manifest, driver)
    const plan = defineProviderExecutionIntentV1({
      ...executionPlan(manifest),
      required_capabilities: [
        'resume',
        'restart_recovery',
        'structured_events',
      ],
    })
    const action: Extract<ProviderActionV1, { kind: 'resume' }> = {
      contract_version: 1,
      kind: 'resume',
      action_id: 'resume-1',
      scope_id: 'workspace-1',
      provider_session_id: 'provider-session-existing',
      cwd: '/workspace',
      model: 'fixture-model',
      effort: 'high',
      access_profile: 'read_only',
      cost_limit: null,
    }
    const authorization = await authorize(adapter, plan, action)
    await expect(adapter.resume({ authorization })).resolves.toMatchObject({
      provider_session_id: 'provider-session-existing',
      model: {
        requested: 'fixture-model',
        effective: 'fixture-model',
      },
      effort: {
        requested: 'high',
        effective: 'high',
      },
      access_profile: {
        requested: 'read_only',
        effective: 'read_only',
      },
    })
    expect(driver.attached).toEqual(['provider-session-existing'])
    await expect(adapter.resume({ authorization })).rejects.toMatchObject({
      code: 'launch_authorization_consumed',
    })
    expect(driver.attached).toEqual(['provider-session-existing'])
    await expect(adapter.attach({
      provider_session_id: 'provider-session-existing',
      selection: plan.selection,
    })).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
  })

  it('rejects a supported capability that the bridge cannot implement', () => {
    const manifest = fixtureManifest(['approvals'])
    const driver = fakeDriver(manifest)
    expect(() => bridge(manifest, driver)).toThrow(
      'driver does not implement declared provider capability: approvals',
    )
  })

  it('keeps all canonical providers unclaimed until exact acceptance passes', () => {
    const registry = new ProviderAdapterRegistryV1()
    expect(registry.declarations()).toEqual(
      [...FIRST_RELEASE_PROVIDER_MANIFESTS_V1]
        .map((manifest) => ({
          provider_id: manifest.provider_id,
          adapter_id: manifest.adapter_id,
          release_state: manifest.release_state,
          adapter_registered: false,
          acceptance_matrix_count: 0,
        }))
        .sort((left, right) => left.provider_id.localeCompare(right.provider_id)),
    )
    expect(registry.assessSupport(
      selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1),
      '0.146.0',
      'darwin-arm64',
      'a'.repeat(40),
    )).toEqual({
      ready: false,
      blockers: [
        'acceptance_matrix_missing',
        'adapter_not_registered',
        'manifest_not_validated',
        'mode_not_supported',
      ],
    })
    expect(CODEX_PROVIDER_MANIFEST_V1.release_state).toBe('candidate')
  })

  it('makes the canonical support gate part of the Agent OS runtime composition', async () => {
    const runtime = createAgentOsRuntime(openDb(':memory:'))
    expect(runtime.providerAdapters.declarations().map((entry) => entry.provider_id))
      .toEqual(['claude', 'codex', 'kimi', 'qwen'])
    await runtime.shutdown()
  })

  it('registers the real Claude driver bridge without promoting unsupported provider support', async () => {
    const runtime = createAgentOsRuntime(openDb(':memory:'))
    runtime.registerClaude({
      isHired: () => false,
      hire: () => { throw new Error('not launched by this composition test') },
      task: () => false,
      transcript: () => ({ lines: [], working: null }),
      interruptAgent: async () => false,
      fire: async () => false,
    })
    expect(runtime.providerAdapters.declarations().find((entry) => entry.provider_id === 'claude'))
      .toMatchObject({
        adapter_registered: true,
        acceptance_matrix_count: 0,
        release_state: 'unsupported',
      })
    expect(runtime.providerAdapters.assessSupport(
      selectProviderExecutionV1(CLAUDE_PROVIDER_MANIFEST_V1),
      '2.1.212',
      'darwin-arm64',
      'a'.repeat(40),
    )).toMatchObject({ ready: false })
    await runtime.shutdown()
  })

  it('requires the same eight-gate matrix before a future provider can be claimed', () => {
    const manifest = fixtureManifest()
    const driver = fakeDriver(manifest)
    const adapter = bridge(manifest, driver)
    const registry = new ProviderAdapterRegistryV1([manifest]).register(adapter)
    const selection = selectProviderExecutionV1(manifest)

    expect(registry.assessSupport(
      selection,
      '1.0.0',
      'test-platform',
      'a'.repeat(40),
    )).toEqual({
      ready: false,
      blockers: ['acceptance_matrix_missing'],
    })

    const incomplete = passingMatrix(
      manifest,
      new Date(Date.now() - 1_000).toISOString(),
    )
    incomplete.gates.credential_redaction = {
      state: 'not_run',
      evidence_refs: [],
    }
    registry.recordAcceptance(incomplete)
    expect(registry.assessSupport(
      selection,
      '1.0.0',
      'test-platform',
      'a'.repeat(40),
    )).toEqual({
      ready: false,
      blockers: ['acceptance_gate_incomplete'],
    })

    registry.recordAcceptance(passingMatrix(manifest))
    expect(registry.requireSupported(
      selection,
      '1.0.0',
      'test-platform',
      'a'.repeat(40),
    )).toBe(adapter)

    expect(registry.assessSupport(
      selection,
      '1.0.0',
      'test-platform',
      'b'.repeat(40),
    )).toEqual({
      ready: false,
      blockers: ['source_commit_mismatch'],
    })

    const stale = passingMatrix(manifest)
    stale.observed_at = new Date(Date.now() - 60_000).toISOString()
    expect(() => registry.recordAcceptance(stale)).toThrow(
      'newer declared-provider acceptance evidence is required',
    )
  })
})

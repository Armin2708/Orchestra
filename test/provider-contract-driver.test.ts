import { describe, expect, it } from 'vitest'
import {
  PROVIDER_CAPABILITY_IDS,
  PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1,
  defineProviderManifestV1,
  type ProviderCapabilitiesV1,
  type ProviderCapabilityId,
  type ProviderManifestV1,
} from '../src/provider-contract.js'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
  ProviderAdapterRegistryV1,
  type DeclaredProviderAcceptanceMatrixV1,
} from '../src/provider-adapter-registry.js'
import { AsyncQueue } from '../src/runtime/async-queue.js'
import {
  defineAgentDriverProviderAdapterV1,
} from '../src/runtime/drivers/provider-adapter.js'
import {
  ProviderContractAgentDriverV1,
} from '../src/runtime/drivers/provider-contract-driver.js'
import {
  ProviderLaunchRequestBrokerV1,
} from '../src/runtime/drivers/provider-launch-request-broker.js'
import type {
  AgentDriver,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
} from '../src/runtime/types.js'

const SOURCE_COMMIT = 'a'.repeat(40)
const FINGERPRINT = `sha256:${'f'.repeat(64)}`

const supportedCapabilities = new Set<ProviderCapabilityId>([
  'launch',
  'follow_up',
  'resume',
  'restart_recovery',
  'interrupt',
  'cancel',
  'stop',
  'model_discovery',
  'model_selection',
  'effort',
  'access_profile',
  'structured_events',
  'raw_terminal_coexistence',
])

const capabilities = Object.fromEntries(
  PROVIDER_CAPABILITY_IDS.map((capability) => [
    capability,
    supportedCapabilities.has(capability)
      ? { state: 'supported' as const }
      : {
          state: 'unsupported' as const,
          reason_code: 'fixture_capability_unsupported',
        },
  ]),
) as ProviderCapabilitiesV1

const manifest = defineProviderManifestV1({
  contract_version: 1,
  provider_id: 'contract-driver-fixture',
  display_name: 'Contract driver fixture',
  adapter_id: 'contract-driver-fixture-adapter',
  adapter_version: '1.0.0',
  release_state: 'validated',
  protocol: 'native_cli',
  executable: {
    command: 'fixture-provider',
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
    capabilities,
  }],
}) as ProviderManifestV1

type FakeDriver = AgentDriver & {
  launches: DriverLaunchRequest[]
  attached: string[]
  sent: string[]
  interrupted: string[]
  cancelled: string[]
  stopped: string[]
  queue: AsyncQueue<DriverEvent>
}

const rawDriver = (): FakeDriver => {
  const launches: DriverLaunchRequest[] = []
  const attached: string[] = []
  const sent: string[] = []
  const interrupted: string[] = []
  const cancelled: string[] = []
  const stopped: string[] = []
  const queue = new AsyncQueue<DriverEvent>()
  return {
    id: manifest.provider_id,
    launches,
    attached,
    sent,
    interrupted,
    cancelled,
    stopped,
    queue,
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
    async launch(request): Promise<DriverSession> {
      launches.push(request)
      return {
        id: 'raw-session-1',
        externalId: 'provider-session-1',
        driverId: manifest.provider_id,
        workspaceId: request.workspaceId,
        status: 'running',
        startedAt: new Date().toISOString(),
        metadata: {
          cwd: request.cwd,
          resolvedModel: request.model,
          resolvedEffort: request.effort,
          accessProfile: request.accessProfile,
        },
      }
    },
    async attach(externalId) {
      attached.push(externalId)
      return {
        id: `raw-resumed-${attached.length}`,
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
    async send(_sessionId, text) {
      sent.push(text)
    },
    async interrupt(sessionId) {
      interrupted.push(sessionId)
    },
    async cancel(sessionId) {
      cancelled.push(sessionId)
      queue.close()
    },
    async stop(sessionId) {
      stopped.push(sessionId)
      queue.close()
    },
    events() {
      return queue
    },
  }
}

const passingMatrix = (): DeclaredProviderAcceptanceMatrixV1 => ({
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
  source_commit: SOURCE_COMMIT,
  observed_at: new Date(Date.now() - 1_000).toISOString(),
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

const fixture = (accepted: boolean) => {
  const raw = rawDriver()
  const broker = new ProviderLaunchRequestBrokerV1()
  const adapter = defineAgentDriverProviderAdapterV1({
    manifest,
    driver: raw,
    async discoverExecutable() {
      return {
        contract_version: 1,
        provider_id: manifest.provider_id,
        adapter_id: manifest.adapter_id,
        status: 'validated',
        source: 'path',
        version: '1.0.0',
        platform: 'test-platform',
        resolved_path: '/safe/bin/fixture-provider',
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
    launchRequest: broker.resolve,
    async resume(context) {
      if (context.action.kind !== 'resume') {
        throw new Error('resume action required')
      }
      const session = await raw.attach(context.action.provider_session_id)
      if (!session) throw new Error('provider session is missing')
      Object.assign(session.metadata, {
        resolvedModel: context.action.model ?? 'fixture-model',
        resolvedEffort: context.action.effort,
        accessProfile: context.action.access_profile,
      })
      return session
    },
    async sessionEvidence(context) {
      if (context.action.kind !== 'launch'
        && context.action.kind !== 'resume'
        && context.action.kind !== 'fork') {
        throw new Error('creating action required')
      }
      return {
        effective_model: context.action.model ?? 'fixture-model',
        effective_effort: context.action.effort,
        effective_access_profile: context.action.access_profile,
      }
    },
  })
  const registry = new ProviderAdapterRegistryV1([manifest]).register(adapter)
  if (accepted) registry.recordAcceptance(passingMatrix())
  const driver = new ProviderContractAgentDriverV1({
    registry,
    adapter,
    launchRequests: broker,
    source_commit: SOURCE_COMMIT,
    configuration_fingerprint: FINGERPRINT,
    environment: { PATH: '/safe/bin' },
  })
  return { raw, adapter, registry, driver }
}

describe('TOOL-014 production provider-contract driver', () => {
  it('exposes the selected provider mode to scheduler runtime policy', () => {
    const { driver } = fixture(true)
    expect(driver.runtimePolicy({
      operation: 'retry',
      executionScope: 'managed_background',
      strategy: 'resume_session',
      attempts: 1,
      maxAttempts: 2,
    })).toMatchObject({ state: 'allowed', operation: 'retry', method: 'resume' })
    expect(driver.runtimePolicy({
      operation: 'capacity',
      activeSessions: 1,
      quarantinedSessions: 1,
      capacity: 2,
    })).toMatchObject({ state: 'at_capacity', operation: 'capacity' })
    expect(driver.runtimePolicy({
      operation: 'timeout',
      elapsedMs: 1_000,
      timeoutMs: 1_000,
      method: 'stop',
    })).toMatchObject({ state: 'allowed', operation: 'timeout', method: 'stop' })
  })

  it('routes the full AgentDriver lifecycle through an accepted adapter', async () => {
    const { raw, driver } = fixture(true)
    await expect(driver.assertSupported()).resolves.toMatchObject({
      status: 'validated',
      version: '1.0.0',
    })
    const session = await driver.launch({
      workspaceId: 'workspace-1',
      boardId: 7,
      cwd: '/workspace',
      name: 'agent-os-job',
      prompt: 'Implement safely',
      env: { CUSTOM_SAFE: '1' },
      model: 'fixture-model',
      effort: 'high',
      accessProfile: 'workspace_write',
      metadata: {
        jobId: 'job-1',
        agentHomeSessionId: 'agent-home-session-1',
      },
    })

    expect(session).toMatchObject({
      externalId: 'provider-session-1',
      driverId: manifest.provider_id,
      workspaceId: 'workspace-1',
      status: 'running',
      metadata: {
        jobId: 'job-1',
        agentHomeSessionId: 'agent-home-session-1',
        providerContractVersion: 1,
        resolvedModel: 'fixture-model',
        resolvedEffort: 'high',
        accessProfile: 'workspace_write',
      },
    })
    expect(session.id).toMatch(/^managed-/)
    expect(raw.launches).toHaveLength(1)
    expect(raw.launches[0]).toMatchObject({
      workspaceId: 'workspace-1',
      boardId: 7,
      cwd: '/workspace',
      name: 'agent-os-job',
      prompt: 'Implement safely',
      env: {
        PATH: '/safe/bin',
        CUSTOM_SAFE: '1',
      },
      model: 'fixture-model',
      effort: 'high',
      accessProfile: 'workspace_write',
      permissionMode: 'acceptEdits',
      metadata: {
        jobId: 'job-1',
        providerContractVersion: 1,
      },
    })

    await driver.send(session.id, 'Continue')
    await driver.interrupt(session.id)
    expect(raw.sent).toEqual(['Continue'])
    expect(raw.interrupted).toEqual(['raw-session-1'])
    expect(raw.cancelled).toEqual([])

    raw.queue.push({
      sessionId: 'raw-session-1',
      seq: 1,
      type: 'output',
      at: new Date().toISOString(),
      data: 'safe output',
    })
    raw.queue.push({
      sessionId: 'raw-session-1',
      seq: 2,
      type: 'exit',
      at: new Date().toISOString(),
      data: 'done',
    })
    raw.queue.close()

    const events = driver.events(session.id)[Symbol.asyncIterator]()
    expect((await events.next()).value).toMatchObject({
      type: 'output',
      data: 'safe output',
    })
    expect((await events.next()).value).toMatchObject({
      type: 'exit',
      data: 'provider session stopped',
      metadata: { exitCode: 0 },
    })
    expect((await events.next()).done).toBe(true)
  })

  it('does not dispatch to the raw driver when acceptance is absent', async () => {
    const { raw, driver } = fixture(false)
    await expect(driver.launch({
      workspaceId: 'workspace-1',
      cwd: '/workspace',
      prompt: 'Must not launch',
      accessProfile: 'workspace_write',
    })).rejects.toMatchObject({
      blockers: ['acceptance_matrix_missing'],
    })
    expect(raw.launches).toEqual([])
  })

  it('preserves native cancellation before explicit provider cleanup', async () => {
    const { raw, driver } = fixture(true)
    const session = await driver.launch({
      workspaceId: 'workspace-1',
      cwd: '/workspace',
      prompt: 'Cancel safely',
      accessProfile: 'workspace_write',
    })
    const events = driver.events(session.id)[Symbol.asyncIterator]()

    await driver.cancel!(session.id)

    expect(raw.cancelled).toEqual(['raw-session-1'])
    expect(raw.interrupted).toEqual([])
    expect(raw.stopped).toEqual([])
    expect((await events.next()).value).toMatchObject({
      type: 'exit',
      data: 'provider session stopped',
      metadata: { providerStatus: 'stopped', exitCode: 0 },
    })
    expect((await events.next()).done).toBe(true)
  })

  it('routes durable recovery through authorization while raw attach stays disabled', async () => {
    const { raw, driver } = fixture(true)
    await expect(driver.attach('provider-session-existing')).resolves.toBeNull()
    expect(raw.attached).toEqual([])

    const session = await driver.recover!({
      externalId: 'provider-session-existing',
      workspaceId: 'workspace-1',
      cwd: '/workspace',
      model: 'fixture-model',
      effort: 'high',
      accessProfile: 'read_only',
      metadata: {
        jobId: 'job-recovery',
        agentHomeSessionId: 'agent-home-recovery',
      },
    })
    expect(session).toMatchObject({
      externalId: 'provider-session-existing',
      driverId: manifest.provider_id,
      workspaceId: 'workspace-1',
      metadata: {
        jobId: 'job-recovery',
        agentHomeSessionId: 'agent-home-recovery',
        providerContractVersion: 1,
        resolvedModel: 'fixture-model',
        resolvedEffort: 'high',
        accessProfile: 'read_only',
      },
    })
    expect(session?.id).toMatch(/^managed-/)
    expect(raw.attached).toEqual(['provider-session-existing'])
  })

  it('does not reach raw recovery without the exact acceptance matrix', async () => {
    const { raw, driver } = fixture(false)
    await expect(driver.recover!({
      externalId: 'provider-session-existing',
      workspaceId: 'workspace-1',
      cwd: '/workspace',
      accessProfile: 'workspace_write',
    })).rejects.toMatchObject({
      blockers: ['acceptance_matrix_missing'],
    })
    expect(raw.attached).toEqual([])
  })

  it('fails before dispatch when a token budget cannot be sealed', async () => {
    const { raw, driver } = fixture(true)
    await expect(driver.launch({
      workspaceId: 'workspace-1',
      cwd: '/workspace',
      prompt: 'Must not launch',
      accessProfile: 'workspace_write',
      taskBudgetTokens: 1_000,
    })).rejects.toThrow(/cannot seal a token-budget amount/)
    expect(raw.launches).toEqual([])
  })
})

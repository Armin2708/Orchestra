import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  authorizeProviderLaunchV1,
  defineProviderExecutionIntentV1,
  defineProviderLaunchBoundaryV1,
  defineProviderNoCostConsentV1,
  selectProviderExecutionV1,
} from '../src/provider-contract.js'
import { ProviderAdapterRegistryV1 } from '../src/provider-adapter-registry.js'
import { CODEX_PROVIDER_MANIFEST_V1 } from '../src/provider-manifests.js'
import {
  CODEX_PROTOCOL_CONFIGURATION_FINGERPRINT_V1,
  createCodexProviderAdapterV1,
  type CodexProviderAdapterOptionsV1,
  type CodexProviderDriverPortV1,
} from '../src/runtime/drivers/codex-provider-adapter.js'
import type {
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
} from '../src/runtime/types.js'

const SOURCE_COMMIT = 'a'.repeat(40)
const EXECUTABLE_BYTES = new Uint8Array([0x63, 0x6f, 0x64, 0x65, 0x78])
const EXECUTABLE_FINGERPRINT =
  `sha256:${createHash('sha256').update(EXECUTABLE_BYTES).digest('hex')}`

type FixtureAccount = 'chatgpt' | 'apiKey' | 'signed-out' | 'unknown'

const fakeDriver = (): CodexProviderDriverPortV1 => ({
  id: 'codex',
  capabilities: () => ({
    attach: true,
    streaming: true,
    interrupt: true,
    stop: true,
    rawTerminal: false,
    resume: true,
    tokenBudget: true,
    costBudget: false,
  }),
  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    return {
      id: 'codex:session-1',
      externalId: 'thread-1',
      driverId: 'codex',
      workspaceId: request.workspaceId,
      status: 'running',
      startedAt: '2026-07-28T12:00:00.000Z',
      metadata: {
        cwd: request.cwd,
        resolvedModel: request.model ?? 'gpt-5.1-codex',
        resolvedEffort: request.effort ?? null,
        accessProfile: request.accessProfile ?? 'workspace_write',
      },
    }
  },
  async attach(): Promise<DriverSession | null> {
    return null
  },
  async detach(): Promise<void> {},
  async updateSession(): Promise<void> {},
  async send(): Promise<void> {},
  async interrupt(): Promise<void> {},
  async cancel(): Promise<void> {},
  async stop(): Promise<void> {},
  async *events(): AsyncIterable<DriverEvent> {},
  async forkSession() {
    return {
      externalId: 'thread-child',
      providerThreadId: 'thread-child',
      sourceExternalId: 'thread-parent',
      sourceProviderThreadId: 'thread-parent',
      metadata: {},
    }
  },
  async resolveApproval(): Promise<boolean> {
    return true
  },
})

const fakeService = (
  account: FixtureAccount = 'chatgpt',
): CodexProviderAdapterOptionsV1['service'] => ({
  async listModels() {
    return [{
      id: 'gpt-5.1-codex',
      model: 'gpt-5.1-codex',
      displayName: 'GPT-5.1 Codex',
      description: 'Fixture model',
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium', description: 'Medium' },
        { reasoningEffort: 'high', description: 'High' },
      ],
      defaultReasoningEffort: 'medium',
      inputModalities: ['text'],
      supportsPersonality: false,
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: true,
    }]
  },
  async readAccount() {
    if (account === 'unknown') throw new Error('account unavailable')
    if (account === 'signed-out') {
      return { account: null, requiresOpenaiAuth: true }
    }
    return {
      account: account === 'chatgpt'
        ? { type: 'chatgpt' as const, email: null, planType: 'plus' }
        : { type: 'apiKey' as const },
      requiresOpenaiAuth: true,
    }
  },
  async readRateLimits() {
    return {
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: {
          usedPercent: 17,
          windowDurationMins: 300,
          resetsAt: 1_785_276_000,
        },
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: 'plus',
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    }
  },
  async readUsage() {
    return {
      summary: {
        lifetimeTokens: 1_000,
        peakDailyTokens: 500,
        longestRunningTurnSec: 30,
        currentStreakDays: 2,
        longestStreakDays: 3,
      },
      dailyUsageBuckets: null,
    }
  },
})

const createAdapter = (
  overrides: Partial<CodexProviderAdapterOptionsV1> = {},
) => createCodexProviderAdapterV1({
  driver: fakeDriver(),
  service: fakeService(),
  command: '/safe/bin/codex',
  environment: {
    PATH: '/safe/bin',
    HOME: '/safe/home',
    LANG: 'en_US.UTF-8',
    OPENAI_API_KEY: 'must-be-stripped',
  },
  platform: 'darwin-arm64',
  now: () => new Date('2026-07-28T12:00:00.000Z'),
  resolveExecutable: () => '/safe/bin/codex',
  readExecutable: () => EXECUTABLE_BYTES,
  readVersion: () => 'codex-cli 0.146.0',
  resolveRecoveryTarget: (scopeId) => ({
    workspaceId: scopeId,
    cwd: '/workspace',
  }),
  ...overrides,
})

const intent = () => defineProviderExecutionIntentV1({
  selection: selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1),
  execution_scope: 'managed_background',
  usage_priced_api: defineProviderNoCostConsentV1(),
  provider_managed_overage: defineProviderNoCostConsentV1(),
  required_capabilities: ['launch', 'structured_events', 'usage'],
})

const readiness = async (
  adapter: ReturnType<typeof createAdapter>,
) => {
  const executionIntent = intent()
  const environment = adapter.prepareEnvironment(
    executionIntent,
    {
      PATH: '/safe/bin',
      OPENAI_API_KEY: 'must-be-stripped',
    },
    { on_conflict: 'strip' },
  )
  const discovery = await adapter.discoverExecutable()
  const boundary = defineProviderLaunchBoundaryV1(
    adapter.manifest,
    discovery,
    CODEX_PROTOCOL_CONFIGURATION_FINGERPRINT_V1,
    environment,
  )
  return {
    boundary,
    discovery,
    environment,
    intent: executionIntent,
    readiness: await adapter.probeReadiness(executionIntent, boundary),
  }
}

describe('Codex TOOL-014 provider adapter', () => {
  it('binds exact executable, environment, account, and protocol evidence', async () => {
    let versionEnvironment: NodeJS.ProcessEnv | null = null
    const adapter = createAdapter({
      readVersion: (_resolvedPath, environment) => {
        versionEnvironment = environment
        return 'codex-cli 0.146.0'
      },
    })
    const observed = await readiness(adapter)

    expect(adapter.manifest).toEqual(CODEX_PROVIDER_MANIFEST_V1)
    expect(observed.discovery).toMatchObject({
      contract_version: 1,
      provider_id: 'codex',
      adapter_id: 'codex-app-server',
      status: 'validated',
      source: 'environment_override',
      version: '0.146.0',
      platform: 'darwin-arm64',
      resolved_path: '/safe/bin/codex',
      executable_fingerprint: EXECUTABLE_FINGERPRINT,
    })
    expect(versionEnvironment).toEqual({ LANG: 'en_US.UTF-8' })
    expect(observed.environment.forSpawn()).toEqual({ PATH: '/safe/bin' })
    expect(observed.environment.evidence).toMatchObject({
      conflict_policy: 'strip',
      stripped_variables: ['OPENAI_API_KEY'],
      retained_variable_count: 1,
    })
    expect(observed.readiness).toMatchObject({
      auth_status: 'ready',
      executable_status: 'validated',
      automation_policy: 'allowed',
      overage_status: 'not_applicable',
      executable_fingerprint: EXECUTABLE_FINGERPRINT,
      configuration_fingerprint: CODEX_PROTOCOL_CONFIGURATION_FINGERPRINT_V1,
    })
    await expect(adapter.listModels(intent())).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
  })

  it('fails closed for nearby CLI versions and non-subscription credentials', async () => {
    const incompatible = createAdapter({
      readVersion: () => 'codex-cli 0.145.0',
    })
    expect(await incompatible.discoverExecutable()).toMatchObject({
      status: 'incompatible',
      version: '0.145.0',
      executable_fingerprint: EXECUTABLE_FINGERPRINT,
    })

    const apiKeyAccount = createAdapter({ service: fakeService('apiKey') })
    expect((await readiness(apiKeyAccount)).readiness.auth_status)
      .toBe('credential_conflict')
  })

  it('fails closed when subscription quota readiness cannot be observed', async () => {
    const service = fakeService()
    const adapter = createAdapter({
      service: {
        ...service,
        async readRateLimits() {
          throw new Error('rate limits unavailable')
        },
      },
    })
    const observed = await readiness(adapter)

    expect(observed.readiness.overage_status).toBe('unknown')
    const authorization = authorizeProviderLaunchV1(
      adapter.manifest,
      observed.intent,
      observed.readiness,
      observed.boundary,
      {
        contract_version: 1,
        kind: 'launch',
        action_id: 'codex-quota-unknown',
        scope_id: 'workspace-1',
        cwd: '/workspace',
        prompt: 'test',
        model: null,
        effort: null,
        access_profile: 'workspace_write',
        cost_limit: null,
      },
    )
    expect(authorization).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining(['overage_policy_mismatch']),
    })
  })

  it('fails closed when Codex reports that backend spend control is reached', async () => {
    const service = fakeService()
    const adapter = createAdapter({
      service: {
        ...service,
        async readRateLimits() {
          const response = await service.readRateLimits()
          return {
            ...response,
            rateLimits: {
              ...response.rateLimits,
              spendControlReached: true,
            },
          }
        },
      },
    })

    const observed = await readiness(adapter)
    expect(observed.readiness.overage_status).toBe('exhausted')
    expect(authorizeProviderLaunchV1(
      adapter.manifest,
      observed.intent,
      observed.readiness,
      observed.boundary,
      {
        contract_version: 1,
        kind: 'launch',
        action_id: 'codex-spend-control-reached',
        scope_id: 'workspace-1',
        cwd: '/workspace',
        prompt: 'test',
        model: null,
        effort: null,
        access_profile: 'workspace_write',
        cost_limit: null,
      },
    )).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining(['quota_exhausted']),
    })
  })

  it('registers the implementation without claiming unsupported canonical routing', () => {
    const registry = new ProviderAdapterRegistryV1()
      .register(createAdapter())
    expect(registry.declarations().find((entry) => entry.provider_id === 'codex'))
      .toMatchObject({
        adapter_registered: true,
        acceptance_matrix_count: 0,
      })
    expect(registry.assessSupport(
      selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1),
      '0.146.0',
      'darwin-arm64',
      SOURCE_COMMIT,
    )).toEqual({
      ready: false,
      blockers: [
        'acceptance_matrix_missing',
        'manifest_not_validated',
        'mode_not_supported',
      ],
    })
  })
})

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  authorizeProviderLaunchV1,
  defineProviderExecutionIntentV1,
  defineProviderLaunchBoundaryV1,
  defineProviderNoCostConsentV1,
  selectProviderExecutionV1,
  type ProviderActionV1,
  type ProviderCapabilityId,
} from '../src/provider-contract.js'
import { ProviderAdapterRegistryV1 } from '../src/provider-adapter-registry.js'
import {
  CLAUDE_PROVIDER_MANIFEST_V1,
  CODEX_PROVIDER_MANIFEST_V1,
} from '../src/provider-manifests.js'
import {
  CLAUDE_PROVIDER_CONFIGURATION_FINGERPRINT_V1,
  CLAUDE_PROVIDER_LIFECYCLE_EVIDENCE_V1,
  createClaudeProviderAdapterV1,
  parseClaudeAuthenticationStatusV1,
  projectClaudeProviderEventV1,
  streamClaudeProviderDriverEventsV1,
  type ClaudeProviderAdapterOptionsV1,
  type ClaudeProviderDriverPortV1,
} from '../src/runtime/drivers/claude-provider-adapter.js'
import type {
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
} from '../src/runtime/types.js'

const SOURCE_COMMIT = 'a'.repeat(40)
const EXECUTABLE_BYTES = new Uint8Array([
  0x63,
  0x6c,
  0x61,
  0x75,
  0x64,
  0x65,
])
const EXECUTABLE_FINGERPRINT =
  `sha256:${createHash('sha256').update(EXECUTABLE_BYTES).digest('hex')}`

type DriverCalls = {
  launched: DriverLaunchRequest[]
  attached: string[]
  interrupted: string[]
  stopped: string[]
}

const fakeDriver = (
  calls: DriverCalls,
  capabilities: Partial<
    ReturnType<ClaudeProviderDriverPortV1['capabilities']>
  > = {},
): ClaudeProviderDriverPortV1 => ({
  id: 'claude',
  capabilities: () => ({
    attach: true,
    streaming: true,
    interrupt: true,
    stop: true,
    rawTerminal: false,
    resume: true,
    tokenBudget: true,
    costBudget: true,
    managesAgentIdentity: true,
    ...capabilities,
  }),
  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    calls.launched.push(request)
    return {
      id: `claude:${calls.launched.length}`,
      externalId: request.externalId ?? `claude-session-${calls.launched.length}`,
      driverId: 'claude',
      workspaceId: request.workspaceId,
      status: 'running',
      startedAt: '2026-07-29T12:00:00.000Z',
      metadata: {},
    }
  },
  async attach(externalId): Promise<DriverSession | null> {
    calls.attached.push(externalId)
    return null
  },
  async send(): Promise<void> {},
  async interrupt(sessionId): Promise<void> {
    calls.interrupted.push(sessionId)
  },
  async stop(sessionId): Promise<void> {
    calls.stopped.push(sessionId)
  },
  async *events(): AsyncIterable<DriverEvent> {},
  async forkSession(sessionId, options) {
    return {
      sourceExternalId: options.sourceExternalId,
      externalId: `${options.sourceExternalId}-fork`,
      providerThreadId: `${options.sourceExternalId}-fork`,
      sourceProviderThreadId: options.sourceExternalId,
      metadata: {
        driverSessionId: sessionId,
        workspaceId: options.workspaceId,
        cwd: options.cwd,
      },
    }
  },
})

const calls = (): DriverCalls => ({
  launched: [],
  attached: [],
  interrupted: [],
  stopped: [],
})

const createAdapter = (
  driverCalls: DriverCalls,
  overrides: Partial<ClaudeProviderAdapterOptionsV1> = {},
) => createClaudeProviderAdapterV1({
  driver: fakeDriver(driverCalls),
  environment: {
    HOME: '/safe/home',
    PATH: '/ambient/bin',
    LANG: 'en_US.UTF-8',
    ANTHROPIC_API_KEY: 'must-not-reach-auth-probe',
    OPENAI_API_KEY: 'must-not-reach-auth-probe',
    CLAUDE_CODE_OAUTH_TOKEN: 'must-not-reach-any-probe',
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'must-not-reach-any-probe',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ORCHESTRA_CLAUDE_COMMAND: '/ambient/claude',
  },
  platform: 'darwin-arm64',
  now: () => new Date(),
  resolveBundledExecutable: () => '/sdk/bundled/claude',
  readExecutable: () => EXECUTABLE_BYTES,
  readVersion: () => '2.1.212 (Claude Code)',
  probeAuthentication: (_resolvedPath, environment) => {
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(environment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBeUndefined()
    expect(environment.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    return 'ready'
  },
  listModels: () => [{
    id: 'claude-sonnet-4-5',
    display_name: 'Claude Sonnet 4.5',
    is_default: true,
    supports_effort: true,
    effort_levels: ['low', 'medium', 'high'],
  }],
  launchRequest: (context) => ({
    workspaceId: context.action.scope_id,
    boardId: 7,
    cwd: context.action.kind === 'launch'
      ? context.action.cwd
      : '/workspace',
    prompt: context.action.kind === 'launch'
      ? context.action.prompt
      : undefined,
  }),
  sessionEvidence: (context) => {
    if (context.action.kind !== 'launch'
      && context.action.kind !== 'fork') {
      throw new Error('creating action required')
    }
    return {
      effective_model: context.action.model ?? 'claude-sonnet-4-5',
      effective_effort: context.action.effort,
      effective_access_profile: context.action.access_profile,
    }
  },
  forkLaunchRequest: (_context, parent) => ({
    workspaceId: parent.workspaceId,
    boardId: 7,
    cwd: '/workspace',
  }),
  submitApproval: () => undefined,
  usage: (context) => ({
    contract_version: 1,
    observed_at: '2026-07-29T12:00:00.000Z',
    selection: context.selection,
    action_id: context.action_id,
    scope_id: context.scope_id,
    billing_mode: context.selection.billing_mode,
    status: 'unavailable',
    overage_status: 'unknown',
    windows: [],
    metered_cost: null,
  }),
  ...overrides,
})

const subscriptionIntent = (
  requiredCapabilities: readonly ProviderCapabilityId[] = [
    'launch',
    'structured_events',
    'usage',
  ],
) => defineProviderExecutionIntentV1({
  selection: selectProviderExecutionV1(CLAUDE_PROVIDER_MANIFEST_V1),
  execution_scope: 'managed_background',
  usage_priced_api: defineProviderNoCostConsentV1(),
  provider_managed_overage: defineProviderNoCostConsentV1(),
  required_capabilities: requiredCapabilities,
})

const launchAction = (): Extract<
  ProviderActionV1,
  { kind: 'launch' }
> => ({
  contract_version: 1,
  kind: 'launch',
  action_id: 'launch-1',
  scope_id: 'workspace-1',
  cwd: '/workspace',
  prompt: 'Implement the task',
  model: 'claude-sonnet-4-5',
  effort: 'high',
  access_profile: 'workspace_write',
  cost_limit: null,
})

const readiness = async (
  adapter: ReturnType<typeof createAdapter>,
  intent = subscriptionIntent(),
) => {
  const environment = adapter.prepareEnvironment(
    intent,
    {
      HOME: '/safe/home',
      PATH: '/ambient/bin',
      ANTHROPIC_API_KEY: 'must-be-stripped',
      OPENAI_API_KEY: 'must-also-be-stripped',
      CLAUDE_CODE_USE_BEDROCK: '1',
    },
    { on_conflict: 'strip' },
  )
  const discovery = await adapter.discoverExecutable()
  const boundary = defineProviderLaunchBoundaryV1(
    adapter.manifest,
    discovery,
    CLAUDE_PROVIDER_CONFIGURATION_FINGERPRINT_V1,
    environment,
  )
  return {
    boundary,
    discovery,
    environment,
    readiness: await adapter.probeReadiness(intent, boundary),
  }
}

describe('Claude TOOL-014 provider adapter candidate', () => {
  it('binds only the SDK-bundled personal-subscription path and stays policy-blocked', async () => {
    const driverCalls = calls()
    let resolved = 0
    let versionEnvironment: NodeJS.ProcessEnv | null = null
    const adapter = createAdapter(driverCalls, {
      resolveBundledExecutable: () => {
        resolved += 1
        return '/sdk/bundled/claude'
      },
      readVersion: (_resolvedPath, environment) => {
        versionEnvironment = environment
        return '2.1.212 (Claude Code)'
      },
    })
    const intent = subscriptionIntent()
    const observed = await readiness(adapter, intent)

    expect(adapter.manifest).toEqual(CLAUDE_PROVIDER_MANIFEST_V1)
    expect(intent.selection).toEqual({
      provider_id: 'claude',
      adapter_id: 'claude-agent-sdk',
      mode_id: 'native_subscription',
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      credential_kind: 'provider_account_session',
    })
    expect(resolved).toBe(1)
    expect(versionEnvironment).toEqual({ LANG: 'en_US.UTF-8' })
    expect(observed.discovery).toMatchObject({
      contract_version: 1,
      provider_id: 'claude',
      adapter_id: 'claude-agent-sdk',
      status: 'validated',
      source: 'sdk_bundled',
      version: '2.1.212',
      platform: 'darwin-arm64',
      resolved_path: null,
      executable_fingerprint: EXECUTABLE_FINGERPRINT,
    })
    expect(observed.environment.forSpawn()).toEqual({
      HOME: '/safe/home',
      PATH: '/ambient/bin',
    })
    expect(observed.environment.evidence).toMatchObject({
      conflict_policy: 'strip',
      stripped_variables: [
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_USE_BEDROCK',
        'OPENAI_API_KEY',
      ],
      retained_variable_count: 2,
    })
    expect(observed.readiness).toMatchObject({
      auth_status: 'ready',
      executable_status: 'validated',
      automation_policy: 'blocked',
      overage_status: 'not_applicable',
      configuration_fingerprint:
        CLAUDE_PROVIDER_CONFIGURATION_FINGERPRINT_V1,
    })

    const authorization = authorizeProviderLaunchV1(
      adapter.manifest,
      intent,
      observed.readiness,
      observed.boundary,
      launchAction(),
    )
    expect(authorization).toEqual({
      ready: false,
      blockers: [
        'provider_policy_blocked',
        'unsupported_provider',
      ],
    })
    expect(driverCalls.launched).toEqual([])
    expect(driverCalls.interrupted).toEqual([])
  })

  it('requires explicit API selection and durable cost consent without falling back', () => {
    expect(() => selectProviderExecutionV1(
      CLAUDE_PROVIDER_MANIFEST_V1,
      { mode_id: 'native_api_key' },
    )).toThrowError(expect.objectContaining({
      code: 'usage_priced_api_consent_required',
    }))
    const selection = selectProviderExecutionV1(
      CLAUDE_PROVIDER_MANIFEST_V1,
      {
        mode_id: 'native_api_key',
        usage_priced_api_consent: true,
      },
    )
    expect(selection).toMatchObject({
      mode_id: 'native_api_key',
      billing_mode: 'usage_priced_api',
      credential_kind: 'usage_priced_api_key',
    })
    const intent = defineProviderExecutionIntentV1({
      selection,
      execution_scope: 'managed_background',
      usage_priced_api: defineProviderNoCostConsentV1(),
      provider_managed_overage: defineProviderNoCostConsentV1(),
      required_capabilities: ['launch'],
    })
    const driverCalls = calls()
    const adapter = createAdapter(driverCalls)
    expect(() => adapter.prepareEnvironment(
      intent,
      { ANTHROPIC_API_KEY: 'explicit-but-not-durably-authorized' },
    )).toThrowError(expect.objectContaining({
      code: 'usage_priced_api_consent_required',
    }))
    expect(driverCalls.launched).toEqual([])
  })

  it('accepts only credential-free Claude account-session auth evidence', () => {
    expect(parseClaudeAuthenticationStatusV1(JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      accessToken: 'must-never-be-projected',
    }))).toBe('ready')
    expect(parseClaudeAuthenticationStatusV1(JSON.stringify({
      loggedIn: true,
      authMethod: 'api_key',
    }))).toBe('credential_conflict')
    expect(parseClaudeAuthenticationStatusV1(JSON.stringify({
      loggedIn: false,
    }))).toBe('signed_out')
    expect(parseClaudeAuthenticationStatusV1(JSON.stringify({
      loggedIn: true,
    }))).toBe('unknown')
    expect(parseClaudeAuthenticationStatusV1('not-json')).toBe('unknown')
  })

  it('preserves exact unsupported recovery states and records no acceptance', async () => {
    const driverCalls = calls()
    const adapter = createAdapter(driverCalls)
    const subscription = CLAUDE_PROVIDER_MANIFEST_V1.modes[0]
    const api = CLAUDE_PROVIDER_MANIFEST_V1.modes[1]

    expect(subscription).toMatchObject({
      id: 'native_subscription',
      priority: 'primary',
      support: {
        state: 'policy_blocked',
        reason_code: 'third_party_subscription_routing_prohibited',
      },
      automation_policy: 'blocked',
      capabilities: {
        launch: { state: 'supported' },
        fork: { state: 'supported' },
        cancel: { state: 'supported' },
        attach: {
          state: 'unsupported',
          reason_code: 'authorized_attach_not_implemented_v1',
        },
        resume: {
          state: 'unsupported',
          reason_code: 'durable_resume_not_implemented_v1',
        },
        restart_recovery: {
          state: 'unsupported',
          reason_code: 'durable_resume_not_implemented_v1',
        },
      },
    })
    expect(api).toMatchObject({
      id: 'native_api_key',
      priority: 'secondary',
      support: {
        state: 'unknown',
        reason_code: 'api_mode_not_migrated_to_contract',
      },
    })
    expect(CLAUDE_PROVIDER_LIFECYCLE_EVIDENCE_V1).toMatchObject({
      launch: 'driver.launch_after_provider_authorization',
      cancel: 'driver.interrupt',
      resume: 'unsupported_durable_resume_not_implemented_v1',
      restart_recovery: 'unsupported_durable_resume_not_implemented_v1',
    })
    expect(() => createAdapter(calls(), {
      driver: fakeDriver(calls(), { interrupt: false }),
    })).toThrow(
      'driver does not implement declared provider capability: interrupt',
    )
    expect(CODEX_PROVIDER_MANIFEST_V1.release_state).toBe('candidate')
    expect(CODEX_PROVIDER_MANIFEST_V1.modes[0]).toMatchObject({
      id: 'native_subscription',
      support: {
        state: 'unknown',
        reason_code: 'subscription_guard_not_integrated',
      },
    })

    const registry = new ProviderAdapterRegistryV1().register(adapter)
    expect(registry.declarations().find(
      (entry) => entry.provider_id === 'claude',
    )).toMatchObject({
      adapter_registered: true,
      acceptance_matrix_count: 0,
    })
    expect(registry.assessSupport(
      selectProviderExecutionV1(CLAUDE_PROVIDER_MANIFEST_V1),
      '2.1.212',
      'darwin-arm64',
      SOURCE_COMMIT,
    )).toEqual({
      ready: false,
      blockers: [
        'acceptance_matrix_missing',
        'automation_policy_not_allowed',
        'manifest_not_validated',
        'mode_not_supported',
      ],
    })

    await expect(adapter.attach({
      provider_session_id: 'provider-session-existing',
      selection: selectProviderExecutionV1(
        CLAUDE_PROVIDER_MANIFEST_V1,
      ),
    })).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
    expect(driverCalls.attached).toEqual([])

    const restartIntent = subscriptionIntent([
      'resume',
      'restart_recovery',
      'structured_events',
    ])
    const observed = await readiness(adapter, restartIntent)
    const restart: Extract<
      ProviderActionV1,
      { kind: 'resume' }
    > = {
      contract_version: 1,
      kind: 'resume',
      action_id: 'resume-1',
      scope_id: 'workspace-1',
      provider_session_id: 'provider-session-existing',
      cwd: '/workspace',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      access_profile: 'workspace_write',
      cost_limit: null,
    }
    expect(authorizeProviderLaunchV1(
      adapter.manifest,
      restartIntent,
      observed.readiness,
      observed.boundary,
      restart,
    )).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining([
        'unsupported_provider',
        'provider_policy_blocked',
        'capability_unsupported',
      ]),
    })
    expect(driverCalls.attached).toEqual([])
  })

  it('redacts projected output, suppresses thinking, and withholds tool results', () => {
    const selection = selectProviderExecutionV1(
      CLAUDE_PROVIDER_MANIFEST_V1,
    )
    const context = {
      assigned_session_id: 'assigned-session-1',
      driver_session: {
        id: 'claude:1',
        externalId: 'provider-session-1',
        driverId: 'claude',
        workspaceId: 'workspace-1',
        status: 'running' as const,
        startedAt: '2026-07-29T12:00:00.000Z',
        metadata: {},
      },
      selection,
      action_id: 'launch-1',
      scope_id: 'workspace-1',
      sequence: 1,
    }
    const secret = 'ANTHROPIC_API_KEY=sk-ant-secret-value'
    const output = projectClaudeProviderEventV1({
      sessionId: 'claude:1',
      seq: 1,
      type: 'output',
      at: '2026-07-29T12:00:01.000Z',
      data: secret,
      metadata: { transcriptKind: 'text' },
    }, context)
    expect(output).toMatchObject({
      kind: 'output',
      session_id: 'assigned-session-1',
    })
    expect(JSON.stringify(output)).not.toContain('sk-ant-secret-value')

    expect(projectClaudeProviderEventV1({
      sessionId: 'claude:1',
      seq: 2,
      type: 'output',
      at: '2026-07-29T12:00:02.000Z',
      data: 'private chain of thought',
      metadata: { transcriptKind: 'thinking' },
    }, { ...context, sequence: 2 })).toBeNull()

    const tool = projectClaudeProviderEventV1({
      sessionId: 'claude:1',
      seq: 3,
      type: 'tool',
      at: '2026-07-29T12:00:03.000Z',
      data: `raw tool output ${secret}`,
      metadata: { transcriptKind: 'tool_result' },
    }, { ...context, sequence: 3 })
    expect(tool).toMatchObject({
      kind: 'tool',
      phase: 'completed',
      safe_summary: 'Claude tool completed',
    })
    expect(JSON.stringify(tool)).not.toContain('raw tool output')
  })

  it('releases private bindings on terminal streams but not consumer cancellation', async () => {
    const event = (
      type: DriverEvent['type'],
      seq: number,
    ): DriverEvent => ({
      sessionId: 'claude:1',
      seq,
      type,
      at: '2026-07-29T12:00:00.000Z',
      data: type,
    })
    const terminalEvents = async function* (): AsyncIterable<DriverEvent> {
      yield event('output', 1)
      yield event('exit', 2)
    }
    let terminalReleases = 0
    const observed: DriverEvent[] = []
    for await (const value of streamClaudeProviderDriverEventsV1(
      terminalEvents(),
      () => {
        terminalReleases += 1
      },
    )) {
      observed.push(value)
    }
    expect(observed.map((value) => value.type)).toEqual(['output', 'exit'])
    expect(terminalReleases).toBe(1)

    const interruptedEvents = async function* (): AsyncIterable<DriverEvent> {
      yield event('output', 1)
      await new Promise<never>(() => undefined)
    }
    let interruptedReleases = 0
    const iterator = streamClaudeProviderDriverEventsV1(
      interruptedEvents(),
      () => {
        interruptedReleases += 1
      },
    )[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'output' },
    })
    await iterator.return?.()
    expect(interruptedReleases).toBe(0)
  })

  it('fails closed for a nearby bundled version and never searches ambient PATH', async () => {
    const incompatible = createAdapter(calls(), {
      readVersion: () => '2.1.213 (Claude Code)',
    })
    await expect(incompatible.discoverExecutable()).resolves.toMatchObject({
      status: 'incompatible',
      source: 'sdk_bundled',
      version: '2.1.213',
      resolved_path: null,
      executable_fingerprint: EXECUTABLE_FINGERPRINT,
    })

    const unknown = createAdapter(calls(), {
      readVersion: () => null,
    })
    await expect(unknown.discoverExecutable()).resolves.toMatchObject({
      status: 'unknown',
      source: 'sdk_bundled',
      version: null,
      resolved_path: null,
      executable_fingerprint: EXECUTABLE_FINGERPRINT,
    })

    let authProbes = 0
    const missing = createAdapter(calls(), {
      resolveBundledExecutable: () => null,
      probeAuthentication: () => {
        authProbes += 1
        return 'ready'
      },
    })
    const observed = await readiness(missing)
    expect(observed.discovery).toMatchObject({
      status: 'missing',
      source: 'sdk_bundled',
      resolved_path: null,
    })
    expect(observed.readiness.auth_status).toBe('unknown')
    expect(authProbes).toBe(0)
  })

  it('fails closed when the bundled version output is ambiguous', async () => {
    const observed = await readiness(createAdapter(calls(), {
      readVersion: () => 'claude 2.1.212; embedded helper 2.1.213',
    }))

    expect(observed.discovery).toMatchObject({
      status: 'unknown',
      version: null,
    })
    expect(observed.readiness).toMatchObject({
      auth_status: 'unknown',
      executable_status: 'unknown',
    })
  })
})

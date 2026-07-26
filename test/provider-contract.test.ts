import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  PROVIDER_CAPABILITY_IDS,
  PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1,
  PROVIDER_SESSION_REGISTRY_LIMIT,
  ProviderContractError,
  authorizeProviderLaunchV1,
  defineProviderActionV1,
  defineProviderApprovalDecisionV1,
  defineProviderEventV1,
  defineProviderExecutionAdapterV1,
  defineProviderExecutionIntentV1,
  defineProviderExecutableDiscoveryV1,
  defineProviderLaunchBoundaryV1,
  defineProviderManifestV1,
  defineProviderModelsV1,
  defineProviderNoCostConsentV1,
  defineProviderReadinessV1,
  defineProviderSessionV1,
  defineProviderUsageV1,
  prepareProviderEnvironmentV1,
  providerLaunchDecisionV1,
  selectProviderExecutionV1,
  type ProviderCostConsentV1,
  type ProviderActionV1,
  type ProviderEventV1,
  type ProviderExecutionAdapterImplementationV1,
  type ProviderExecutionIntentV1,
  type ProviderExecutionSelectionV1,
  type ProviderLaunchBoundaryV1,
  type ProviderManifestV1,
  type ProviderReadinessV1,
  type ProviderSessionV1,
  type ProviderUsageV1,
} from '../src/provider-contract.js'
import {
  CLAUDE_PROVIDER_MANIFEST_V1,
  CODEX_PROVIDER_MANIFEST_V1,
  FIRST_RELEASE_PROVIDER_MANIFESTS_V1,
  KIMI_PROVIDER_MANIFEST_V1,
  QWEN_PROVIDER_MANIFEST_V1,
} from '../src/provider-manifests.js'

const FINGERPRINT = `sha256:${'a'.repeat(64)}`
const OTHER_FINGERPRINT = `sha256:${'b'.repeat(64)}`

const noCostConsent = (): ProviderCostConsentV1 => defineProviderNoCostConsentV1()

const forgedCostConsent = (
  selection: ProviderExecutionSelectionV1,
  purpose: Exclude<ProviderCostConsentV1['purpose'], null> = 'usage_priced_api',
): ProviderCostConsentV1 => ({
  state: 'granted',
  provider_id: selection.provider_id,
  adapter_id: selection.adapter_id,
  mode_id: selection.mode_id,
  purpose,
  operator_id: 'operator-1',
  granted_at: new Date(Date.now() - 1_000).toISOString(),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  scope_id: 'scope-1',
  receipt_id: 'receipt-1',
  currency: 'USD',
  max_cost_minor_units: 5_000,
})

const mutableManifest = (manifest: ProviderManifestV1): ProviderManifestV1 =>
  structuredClone(manifest)

let fixtureManifestIndex = 0

const supportedManifest = (
  manifest: ProviderManifestV1,
  modeId = 'native_subscription',
): ProviderManifestV1 => {
  const copy = mutableManifest(manifest)
  fixtureManifestIndex += 1
  copy.provider_id = `fixture-${manifest.provider_id}-${fixtureManifestIndex}`
  copy.adapter_id = `fixture-${manifest.provider_id}-adapter-${fixtureManifestIndex}`
  copy.release_state = 'candidate'
  copy.environment.audit_state = 'complete'
  const existingEnvironmentRules = new Map(
    copy.environment.conflict_rules.map((rule) => [rule.variable, rule]),
  )
  copy.environment.conflict_rules = PROVIDER_MANAGED_ENVIRONMENT_CONFLICTS_V1
    .map(([variable, category]) => existingEnvironmentRules.get(variable) ?? {
      variable,
      category,
      allowed_mode_ids: [],
      allowed_credential_kinds: [],
    })
  if (!copy.executable.validated_versions.length) copy.executable.validated_versions = ['test']
  if (!copy.executable.supported_platforms.length) {
    copy.executable.supported_platforms = ['test-platform']
  }
  const mode = copy.modes.find((candidate) => candidate.id === modeId)
  if (!mode) throw new Error('fixture requires the selected mode')
  mode.support = { state: 'supported' }
  for (const capability of [
    'launch',
    'cancel',
    'structured_events',
    'access_profile',
    'usage',
    'cost_budget',
  ] as const) {
    mode.capabilities[capability] = { state: 'supported' }
  }
  return defineProviderManifestV1(copy) as ProviderManifestV1
}

const intent = (
  selection: ProviderExecutionSelectionV1,
  overrides: Partial<ProviderExecutionIntentV1> = {},
): ProviderExecutionIntentV1 => ({
  selection,
  execution_scope: 'managed_background',
  usage_priced_api: noCostConsent(),
  provider_managed_overage: noCostConsent(),
  required_capabilities: ['launch', 'cancel'],
  ...overrides,
})

const launchAction = (
  overrides: Partial<Extract<ProviderActionV1, { kind: 'launch' }>> = {},
): Extract<ProviderActionV1, { kind: 'launch' }> => ({
  contract_version: 1,
  kind: 'launch',
  action_id: 'action-1',
  scope_id: 'scope-1',
  cwd: '/workspace',
  prompt: 'Implement the task',
  model: null,
  effort: null,
  access_profile: 'workspace_write',
  cost_limit: null,
  ...overrides,
})

const readiness = (
  selection: ProviderExecutionSelectionV1,
  environmentFingerprint: string,
  overrides: Partial<ProviderReadinessV1> = {},
): ProviderReadinessV1 => ({
  contract_version: 1,
  observed_at: new Date().toISOString(),
  selection,
  executable_status: 'validated',
  auth_status: 'ready',
  automation_policy: 'allowed',
  overage_status: 'not_applicable',
  overage_consent: 'not_required',
  metering_status: 'not_required',
  cost_cap_status: 'not_required',
  executable_fingerprint: FINGERPRINT,
  environment_fingerprint: environmentFingerprint,
  configuration_fingerprint: FINGERPRINT,
  ...overrides,
})

const launchFixture = (
  manifest: ProviderManifestV1,
  selection = selectProviderExecutionV1(manifest),
  intentOverrides: Partial<ProviderExecutionIntentV1> = {},
  readinessOverrides: Partial<ProviderReadinessV1> = {},
): {
  plan: ProviderExecutionIntentV1
  observed: ProviderReadinessV1
  boundary: ProviderLaunchBoundaryV1
  environment: ReturnType<typeof prepareProviderEnvironmentV1>
  discovery: ReturnType<typeof defineProviderExecutableDiscoveryV1>
  action: ProviderActionV1
} => {
  const plan = intent(selection, intentOverrides)
  const environment = prepareProviderEnvironmentV1(
    manifest,
    plan,
    { PATH: '/safe/bin' },
  )
  const source = manifest.executable.source
  const discovery = defineProviderExecutableDiscoveryV1({
    contract_version: 1,
    provider_id: manifest.provider_id,
    adapter_id: manifest.adapter_id,
    status: 'validated',
    source,
    version: manifest.executable.validated_versions[0] ?? 'test',
    platform: manifest.executable.supported_platforms[0] ?? 'test-platform',
    resolved_path: source === 'path' ? `/safe/bin/${manifest.executable.command}` : null,
    executable_fingerprint: FINGERPRINT,
  })
  const action = launchAction()
  return {
    plan,
    observed: readiness(selection, environment.evidence.environment_fingerprint, readinessOverrides),
    boundary: defineProviderLaunchBoundaryV1(
      manifest,
      discovery,
      FINGERPRINT,
      environment,
    ),
    environment,
    discovery,
    action,
  }
}

const adapterImplementation = (
  manifest: ProviderManifestV1,
  fixture: ReturnType<typeof launchFixture>,
  onLaunch: (context: unknown) => unknown = () => ({
    contract_version: 1,
    session_id: 'session-1',
    provider_session_id: 'provider-session-1',
    selection: fixture.plan.selection,
    status: 'running',
    model: {
      requested: null,
      effective: 'default-model',
    },
    effort: null,
    access_profile: {
      requested: 'workspace_write',
      effective: 'workspace_write',
    },
  }),
): ProviderExecutionAdapterImplementationV1 => ({
  contract_version: 1,
  manifest,
  async discoverExecutable() {
    return fixture.discovery
  },
  async probeReadiness() {
    return fixture.observed
  },
  async listModels() {
    return []
  },
  async launch(context) {
    return onLaunch(context)
  },
  async followUp() {},
  async fork(context) {
    return onLaunch(context)
  },
  async interrupt() {},
  async cancel() {},
  async stop() {},
  async submitApproval() {},
  async *events(sessionId) {
    yield {
      kind: 'approval',
      event_id: 'event-1',
      turn_id: 'turn-1',
      session_id: sessionId,
      sequence: 1,
      observed_at: new Date().toISOString(),
      approval_id: 'approval-1',
      approval_kind: 'tool',
      status: 'requested',
      safe_summary: 'Review sk-abcdefghijklmnopqrstuvwxyz123456',
    }
  },
  async usage() {
    return {
      contract_version: 1,
      observed_at: new Date().toISOString(),
      selection: fixture.plan.selection,
      action_id: fixture.action.action_id,
      scope_id: fixture.action.scope_id,
      billing_mode: fixture.plan.selection.billing_mode,
      status: 'available',
      overage_status: 'not_applicable',
      windows: [],
      metered_cost: null,
    }
  },
})

const sessionOutput = (
  fixture: ReturnType<typeof launchFixture>,
  overrides: Partial<ProviderSessionV1> = {},
): ProviderSessionV1 => ({
  contract_version: 1,
  session_id: 'session-1',
  provider_session_id: 'provider-session-1',
  selection: fixture.plan.selection,
  status: 'running',
  model: {
    requested: null,
    effective: 'default-model',
  },
  effort: null,
  access_profile: {
    requested: 'workspace_write',
    effective: 'workspace_write',
  },
  ...overrides,
})

const authorizeAction = (
  manifest: ProviderManifestV1,
  fixture: ReturnType<typeof launchFixture>,
  action: ProviderActionV1,
) => {
  const result = authorizeProviderLaunchV1(
    manifest,
    fixture.plan,
    fixture.observed,
    fixture.boundary,
    action,
  )
  if (!result.ready) throw new Error(`fixture authorization failed: ${result.blockers.join(',')}`)
  return result.authorization
}

const expectSafeAdapterFailure = async (
  run: () => Promise<unknown>,
  sentinel: string,
  operation: string,
): Promise<void> => {
  let error: unknown
  try {
    await run()
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({
    code: 'provider_adapter_implementation_failed',
    variables: [operation],
  })
  const rendered = [
    String(error),
    error instanceof Error ? error.stack ?? '' : '',
    JSON.stringify(error),
    error && typeof error === 'object' && 'cause' in error
      ? String((error as { cause?: unknown }).cause)
      : '',
  ].join('\n')
  expect(rendered).not.toContain(sentinel)
}

describe('terminal-agent provider contract V1', () => {
  it('declares the four first-release targets without claiming unsupported providers', () => {
    expect(FIRST_RELEASE_PROVIDER_MANIFESTS_V1.map((manifest) => manifest.provider_id))
      .toEqual(['claude', 'codex', 'qwen', 'kimi'])
    expect(CLAUDE_PROVIDER_MANIFEST_V1.release_state).toBe('unsupported')
    expect(CODEX_PROVIDER_MANIFEST_V1.release_state).toBe('candidate')
    expect(QWEN_PROVIDER_MANIFEST_V1.release_state).toBe('unsupported')
    expect(KIMI_PROVIDER_MANIFEST_V1.release_state).toBe('unsupported')
    expect(CLAUDE_PROVIDER_MANIFEST_V1.modes[0]?.support).toEqual({
      state: 'policy_blocked',
      reason_code: 'third_party_subscription_routing_prohibited',
    })
  })

  it('requires a complete explicit capability matrix on every execution mode', () => {
    for (const manifest of FIRST_RELEASE_PROVIDER_MANIFESTS_V1) {
      for (const mode of manifest.modes) {
        expect(Object.keys(mode.capabilities).sort())
          .toEqual([...PROVIDER_CAPABILITY_IDS].sort())
        expect(mode.capabilities.raw_terminal_coexistence.state).toBe('supported')
        expect(mode.capabilities.attach).toEqual({
          state: 'unsupported',
          reason_code: 'authorized_attach_not_implemented_v1',
        })
        expect(mode.capabilities.resume).toEqual({
          state: 'unsupported',
          reason_code: 'durable_resume_not_implemented_v1',
        })
        expect(mode.capabilities.restart_recovery).toEqual({
          state: 'unsupported',
          reason_code: 'durable_resume_not_implemented_v1',
        })
      }
    }
  })

  it('rejects any V1 manifest that claims durable rehydration is already operable', () => {
    const copy = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    copy.provider_id = 'fixture-unsafe-attach'
    copy.adapter_id = 'fixture-unsafe-attach-adapter'
    copy.modes[0]!.capabilities.attach = { state: 'supported' }
    expect(() => defineProviderManifestV1(copy)).toThrowError(expect.objectContaining({
      code: 'durable_rehydration_not_supported_in_contract_v1',
    }))
  })

  it('keeps capability truth mode-scoped', () => {
    const primary = CODEX_PROVIDER_MANIFEST_V1.modes.find((mode) => mode.id === 'native_subscription')
    const api = CODEX_PROVIDER_MANIFEST_V1.modes.find((mode) => mode.id === 'native_api_key')
    expect(primary?.capabilities.launch.state).toBe('supported')
    expect(api?.capabilities.launch.state).toBe('unknown')
  })

  it('defaults every provider selection to native personal-subscription billing', () => {
    for (const manifest of FIRST_RELEASE_PROVIDER_MANIFESTS_V1) {
      expect(selectProviderExecutionV1(manifest)).toMatchObject({
        runtime_mode: 'native_cli',
        billing_mode: 'personal_subscription',
        mode_id: 'native_subscription',
      })
    }
    expect(selectProviderExecutionV1(QWEN_PROVIDER_MANIFEST_V1).credential_kind)
      .toBe('subscription_scoped_key')
  })

  it('requires explicit selection consent before API billing', () => {
    expect(() => selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1, {
      mode_id: 'native_api_key',
    })).toThrowError(expect.objectContaining({
      code: 'usage_priced_api_consent_required',
    }))
    expect(selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1, {
      mode_id: 'native_api_key',
      usage_priced_api_consent: true,
    })).toMatchObject({
      runtime_mode: 'native_cli',
      billing_mode: 'usage_priced_api',
      credential_kind: 'usage_priced_api_key',
    })
  })

  it('rejects inherited selection fields instead of inheriting API consent', () => {
    const inherited = Object.create({
      mode_id: 'native_api_key',
      usage_priced_api_consent: true,
    }) as { mode_id?: string; usage_priced_api_consent?: boolean }
    expect(() => selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1, inherited))
      .toThrowError(expect.objectContaining({ code: 'invalid_selection_request' }))
  })

  it('rejects empty, null, accessor-backed, and unexpected selection requests safely', () => {
    expect(() => selectProviderExecutionV1(
      CODEX_PROVIDER_MANIFEST_V1,
      { mode_id: '' },
    )).toThrowError(expect.objectContaining({ code: 'invalid_selection_request' }))
    expect(() => selectProviderExecutionV1(
      CODEX_PROVIDER_MANIFEST_V1,
      null as never,
    )).toThrowError(ProviderContractError)
    const sentinel = 'credential-sentinel-selection-getter'
    const accessor = Object.defineProperty({}, 'mode_id', {
      enumerable: true,
      get() {
        throw new Error(sentinel)
      },
    })
    let error: unknown
    try {
      selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1, accessor)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ProviderContractError)
    expect(String(error)).not.toContain(sentinel)
  })

  it('snapshots and deeply freezes a valid manifest', () => {
    const input = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    const defined = defineProviderManifestV1(input)
    input.display_name = 'mutated'
    input.modes[0]!.credential_kinds = ['subscription_scoped_key']
    expect(defined.display_name).toBe('Codex CLI')
    expect(defined.modes[0]?.credential_kinds).toEqual(['provider_account_session'])
    expect(Object.isFrozen(defined)).toBe(true)
    expect(Object.isFrozen(defined.modes[0]?.capabilities)).toBe(true)
  })

  it('reserves canonical provider and adapter identities against billing substitution', () => {
    const providerImpostor = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    const apiRule = providerImpostor.environment.conflict_rules.find((candidate) =>
      candidate.variable === 'OPENAI_API_KEY')
    if (!apiRule) throw new Error('fixture requires OPENAI_API_KEY')
    apiRule.allowed_mode_ids = ['native_subscription']
    apiRule.allowed_credential_kinds = ['provider_account_session']
    expect(() => defineProviderManifestV1(providerImpostor)).toThrowError(expect.objectContaining({
      code: 'reserved_provider_manifest_mismatch',
    }))

    const adapterImpostor = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    adapterImpostor.provider_id = 'different-provider'
    expect(() => defineProviderManifestV1(adapterImpostor)).toThrowError(expect.objectContaining({
      code: 'reserved_provider_adapter_mismatch',
    }))
  })

  it('reserves first-release manifests before any caller can win registration order', () => {
    const spoof = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    const apiRule = spoof.environment.conflict_rules.find((candidate) =>
      candidate.variable === 'OPENAI_API_KEY')
    if (!apiRule) throw new Error('fixture requires OPENAI_API_KEY')
    apiRule.allowed_mode_ids = ['native_subscription']
    apiRule.allowed_credential_kinds = ['provider_account_session']
    const script = `
      const contract = await import('./src/provider-contract.ts')
      let code = ''
      try {
        contract.defineProviderManifestV1(${JSON.stringify(spoof)})
      } catch (error) {
        code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      }
      if (code !== 'reserved_provider_manifest_mismatch') {
        throw new Error('reserved manifest was not rejected: ' + code)
      }
      const manifests = await import('./src/provider-manifests.ts')
      if (manifests.CODEX_PROVIDER_MANIFEST_V1.provider_id !== 'codex') {
        throw new Error('official manifest failed after rejected first writer')
      }
      process.stdout.write('ok')
    `
    expect(execFileSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      script,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })).toBe('ok')
  })

  it('requires executable constraints and a supported primary before validated release', () => {
    const copy = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    copy.provider_id = 'fixture-validated-contract'
    copy.adapter_id = 'fixture-validated-adapter'
    copy.release_state = 'validated'
    copy.modes[0]!.support = { state: 'supported' }
    copy.executable.validated_versions = []
    expect(() => defineProviderManifestV1(copy)).toThrowError(expect.objectContaining({
      code: 'missing_executable_constraint',
    }))

    copy.executable.validated_versions = ['0.144.6']
    copy.modes[0]!.support = {
      state: 'unknown',
      reason_code: 'not_verified',
    }
    expect(() => defineProviderManifestV1(copy)).toThrowError(expect.objectContaining({
      code: 'validated_primary_mode_required',
    }))
  })

  it.each([
    ['wrong contract version', (copy: ProviderManifestV1) => {
      ;(copy as unknown as { contract_version: number }).contract_version = 2
    }],
    ['duplicate primary', (copy: ProviderManifestV1) => {
      copy.modes[1]!.priority = 'primary'
    }],
    ['duplicate mode id', (copy: ProviderManifestV1) => {
      copy.modes[1]!.id = copy.modes[0]!.id
    }],
    ['API key in subscription mode', (copy: ProviderManifestV1) => {
      copy.modes[0]!.credential_kinds = ['usage_priced_api_key']
      copy.modes[0]!.default_credential_kind = 'usage_priced_api_key'
    }],
    ['incomplete capabilities', (copy: ProviderManifestV1) => {
      delete (copy.modes[0]!.capabilities as Partial<typeof copy.modes[0]['capabilities']>).approvals
    }],
    ['unsupported capability without reason', (copy: ProviderManifestV1) => {
      ;(copy.modes[0]!.capabilities.approvals as unknown as Record<string, unknown>).state = 'unsupported'
    }],
    ['unknown credential-bearing field', (copy: ProviderManifestV1) => {
      ;(copy as ProviderManifestV1 & { api_key: string }).api_key = 'must-not-be-accepted'
    }],
  ])('rejects malformed manifests: %s', (_name, mutate) => {
    const copy = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    mutate(copy)
    expect(() => defineProviderManifestV1(copy)).toThrowError(ProviderContractError)
  })

  it('rejects validated or supported manifests with an incomplete environment audit', () => {
    const copy = mutableManifest(QWEN_PROVIDER_MANIFEST_V1)
    copy.release_state = 'validated'
    expect(() => defineProviderManifestV1(copy)).toThrowError(expect.objectContaining({
      code: 'environment_audit_incomplete',
    }))
    copy.release_state = 'candidate'
    copy.modes[0]!.support = { state: 'supported' }
    expect(() => defineProviderManifestV1(copy)).toThrowError(expect.objectContaining({
      code: 'environment_audit_incomplete',
    }))
  })

  it('rejects a claimed-complete audit that omits any managed credential family', () => {
    const copy = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    copy.provider_id = 'fixture-incomplete-global-audit'
    copy.adapter_id = 'fixture-incomplete-global-audit-adapter'
    copy.environment.conflict_rules = copy.environment.conflict_rules
      .filter((rule) => rule.variable !== 'CLAUDE_CODE_OAUTH_TOKEN')
    expect(() => defineProviderManifestV1(copy)).toThrowError(expect.objectContaining({
      code: 'environment_audit_incomplete',
    }))
  })

  it('rejects environment rules that permit API credentials in subscription modes', () => {
    const copy = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    const rule = copy.environment.conflict_rules.find((candidate) =>
      candidate.variable === 'OPENAI_API_KEY')
    if (!rule) throw new Error('fixture requires OPENAI_API_KEY')
    rule.allowed_mode_ids = ['native_subscription']
    rule.allowed_credential_kinds = ['usage_priced_api_key']
    expect(() => defineProviderManifestV1(copy)).toThrowError(expect.objectContaining({
      code: 'invalid_environment_credential',
    }))
  })

  it('rejects sparse arrays and hostile manifest reflection without leaking thrown text', () => {
    const sparse = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    const sparseKinds = new Array<ProviderExecutionSelectionV1['credential_kind']>(2)
    sparseKinds[0] = 'provider_account_session'
    sparse.modes[0]!.credential_kinds = sparseKinds as never
    expect(() => defineProviderManifestV1(sparse)).toThrowError(ProviderContractError)

    const sentinel = 'credential-sentinel-manifest-getter'
    const hostile = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    Object.defineProperty(hostile, 'display_name', {
      enumerable: true,
      get() {
        throw new Error(sentinel)
      },
    })
    let error: unknown
    try {
      defineProviderManifestV1(hostile)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ProviderContractError)
    expect(String(error)).not.toContain(sentinel)
  })

  it('rejects plain self-asserted paid consent until a durable authority exists', () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1, 'native_api_key')
    const selection = selectProviderExecutionV1(manifest, {
      mode_id: 'native_api_key',
      usage_priced_api_consent: true,
    })
    expect(() => defineProviderExecutionIntentV1(intent(selection, {
      usage_priced_api: forgedCostConsent(selection),
      required_capabilities: [],
    }))).toThrowError(expect.objectContaining({
      code: 'verified_cost_consent_required',
    }))
    const noCost = noCostConsent()
    expect(() => defineProviderExecutionIntentV1(intent(selection, {
      usage_priced_api: JSON.parse(JSON.stringify(noCost)) as ProviderCostConsentV1,
      required_capabilities: [],
    }))).toThrowError(expect.objectContaining({
      code: 'verified_cost_consent_required',
    }))
    const ConsentConstructor = noCost.constructor as new (
      token: symbol,
      evidence: ProviderCostConsentV1,
    ) => ProviderCostConsentV1
    expect(() => new ConsentConstructor(Symbol('forged'), forgedCostConsent(selection)))
      .toThrowError(expect.objectContaining({ code: 'verified_cost_consent_required' }))
  })
})

describe('fail-closed launch decisions and authorizations', () => {
  it('allows only an exact, fresh, supported subscription launch', () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest, undefined, { required_capabilities: [] })
    expect(providerLaunchDecisionV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )).toEqual({
      ready: true,
      selection: fixture.plan.selection,
    })
  })

  it('never substitutes API readiness for a requested subscription tuple', () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const api = selectProviderExecutionV1(manifest, {
      mode_id: 'native_api_key',
      usage_priced_api_consent: true,
    })
    const decision = providerLaunchDecisionV1(
      manifest,
      fixture.plan,
      { ...fixture.observed, selection: api },
      fixture.boundary,
      fixture.action,
    )
    expect(decision.ready).toBe(false)
    if (!decision.ready) {
      expect(decision.blockers).toEqual(expect.arrayContaining([
        'billing_mismatch',
        'credential_kind_mismatch',
        'selection_mismatch',
      ]))
    }
  })

  it.each([
    ['missing', 'missing_executable'],
    ['incompatible', 'incompatible_version'],
    ['untrusted', 'untrusted_executable'],
    ['unknown', 'executable_unknown'],
  ] as const)('blocks %s executable readiness', (status, blocker) => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest, undefined, {}, { executable_status: status })
    const decision = providerLaunchDecisionV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    expect(decision.ready).toBe(false)
    if (!decision.ready) expect(decision.blockers).toContain(blocker)
  })

  it('retains discovery status and never lets readiness upgrade a missing executable', () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const missingDiscovery = defineProviderExecutableDiscoveryV1({
      ...fixture.discovery,
      status: 'missing',
      source: 'unknown',
      version: null,
      platform: null,
      resolved_path: null,
    })
    const boundary = defineProviderLaunchBoundaryV1(
      manifest,
      missingDiscovery,
      FINGERPRINT,
      fixture.environment,
    )
    const decision = providerLaunchDecisionV1(
      manifest,
      fixture.plan,
      fixture.observed,
      boundary,
      fixture.action,
    )
    expect(decision.ready).toBe(false)
    if (!decision.ready) {
      expect(decision.blockers).toEqual(expect.arrayContaining([
        'executable_mismatch',
        'missing_executable',
      ]))
    }
  })

  it('binds validated discovery to manifest version, platform, and provenance', () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    expect(() => defineProviderExecutableDiscoveryV1({
      ...fixture.discovery,
      source: 'unknown',
      version: null,
    })).toThrowError(expect.objectContaining({
      code: 'invalid_validated_executable',
    }))
    expect(() => defineProviderLaunchBoundaryV1(
      manifest,
      { ...fixture.discovery, version: '999.0.0' },
      FINGERPRINT,
      fixture.environment,
    )).toThrowError(expect.objectContaining({
      code: 'incompatible_executable_version',
    }))
    expect(() => defineProviderLaunchBoundaryV1(
      manifest,
      { ...fixture.discovery, platform: 'unsupported-platform' },
      FINGERPRINT,
      fixture.environment,
    )).toThrowError(expect.objectContaining({
      code: 'unsupported_executable_platform',
    }))
    expect(() => defineProviderLaunchBoundaryV1(
      manifest,
      { ...fixture.discovery, source: 'sdk_bundled', resolved_path: null },
      FINGERPRINT,
      fixture.environment,
    )).toThrowError(expect.objectContaining({
      code: 'untrusted_executable_provenance',
    }))
    expect(() => defineProviderLaunchBoundaryV1(
      manifest,
      { ...fixture.discovery, source: 'environment_override' },
      FINGERPRINT,
      fixture.environment,
    )).not.toThrow()
  })

  it.each([
    ['signed_out', 'authentication_required'],
    ['expired', 'authentication_required'],
    ['revoked', 'authentication_required'],
    ['credential_conflict', 'credential_conflict'],
    ['unknown', 'authentication_unknown'],
  ] as const)('blocks %s authentication readiness', (status, blocker) => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest, undefined, {}, { auth_status: status })
    const decision = providerLaunchDecisionV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    expect(decision.ready).toBe(false)
    if (!decision.ready) expect(decision.blockers).toContain(blocker)
  })

  it('rejects stale and future readiness', () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const stale = launchFixture(manifest, undefined, {}, {
      observed_at: new Date(Date.now() - 60_000).toISOString(),
    })
    const future = launchFixture(manifest, undefined, {}, {
      observed_at: new Date(Date.now() + 60_000).toISOString(),
    })
    const staleDecision = providerLaunchDecisionV1(
      manifest,
      stale.plan,
      stale.observed,
      stale.boundary,
      stale.action,
    )
    const futureDecision = providerLaunchDecisionV1(
      manifest,
      future.plan,
      future.observed,
      future.boundary,
      future.action,
    )
    expect(staleDecision.ready).toBe(false)
    expect(futureDecision.ready).toBe(false)
    if (!staleDecision.ready) expect(staleDecision.blockers).toContain('readiness_stale')
    if (!futureDecision.ready) expect(futureDecision.blockers).toContain('readiness_from_future')
  })

  it.each([
    ['executable_fingerprint', 'executable_mismatch'],
    ['configuration_fingerprint', 'configuration_mismatch'],
  ] as const)('binds readiness to the launch %s', (field, blocker) => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const boundary = field === 'executable_fingerprint'
      ? defineProviderLaunchBoundaryV1(
        manifest,
        { ...fixture.discovery, executable_fingerprint: OTHER_FINGERPRINT },
        FINGERPRINT,
        fixture.environment,
      )
      : defineProviderLaunchBoundaryV1(
        manifest,
        fixture.discovery,
        OTHER_FINGERPRINT,
        fixture.environment,
      )
    const decision = providerLaunchDecisionV1(
      manifest,
      fixture.plan,
      fixture.observed,
      boundary,
      fixture.action,
    )
    expect(decision.ready).toBe(false)
    if (!decision.ready) expect(decision.blockers).toContain(blocker)
  })

  it('binds readiness to the exact sealed prepared environment', () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const decision = providerLaunchDecisionV1(
      manifest,
      fixture.plan,
      { ...fixture.observed, environment_fingerprint: OTHER_FINGERPRINT },
      fixture.boundary,
      fixture.action,
    )
    expect(decision.ready).toBe(false)
    if (!decision.ready) expect(decision.blockers).toContain('environment_mismatch')

    const forged = {
      evidence: fixture.boundary.evidence,
      forSpawn: () => ({ OPENAI_API_KEY: 'credential-sentinel-forged' }),
      toJSON: () => fixture.boundary.evidence,
    }
    expect(() => providerLaunchDecisionV1(
      manifest,
      fixture.plan,
      fixture.observed,
      forged as never,
      fixture.action,
    )).toThrowError(expect.objectContaining({
      code: 'launch_boundary_required',
    }))
  })

  it('keeps Claude managed subscription policy-blocked even with technical readiness', () => {
    const fixture = launchFixture(CLAUDE_PROVIDER_MANIFEST_V1, undefined, {}, {
      automation_policy: 'blocked',
    })
    const decision = providerLaunchDecisionV1(
      CLAUDE_PROVIDER_MANIFEST_V1,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    expect(decision.ready).toBe(false)
    if (!decision.ready) {
      expect(decision.blockers).toContain('unsupported_provider')
      expect(decision.blockers).toContain('provider_policy_blocked')
    }
  })

  it('keeps Qwen subscription-scoped billing distinct and managed automation interactive-only', () => {
    const manifest = supportedManifest(QWEN_PROVIDER_MANIFEST_V1)
    const selection = selectProviderExecutionV1(manifest)
    const fixture = launchFixture(manifest, selection, {
      required_capabilities: [],
      execution_scope: 'managed_background',
    }, {
      automation_policy: 'interactive_only',
    })
    expect(selection).toMatchObject({
      billing_mode: 'personal_subscription',
      credential_kind: 'subscription_scoped_key',
    })
    const decision = providerLaunchDecisionV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    expect(decision.ready).toBe(false)
    if (!decision.ready) expect(decision.blockers).toContain('interactive_only')
  })

  it('never accepts metered overage in a mode that declares no overage', () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest, undefined, {}, {
      overage_status: 'enabled',
      overage_consent: 'granted',
      metering_status: 'ready',
      cost_cap_status: 'enforced',
    })
    const decision = providerLaunchDecisionV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    expect(decision.ready).toBe(false)
    if (!decision.ready) expect(decision.blockers).toContain('overage_policy_mismatch')
  })

  it('keeps Kimi Extra Usage fail-closed without a durable consent authority', () => {
    const manifest = supportedManifest(KIMI_PROVIDER_MANIFEST_V1)
    const selection = selectProviderExecutionV1(manifest)
    const denied = launchFixture(manifest, selection, { required_capabilities: [] }, {
      overage_status: 'enabled',
      overage_consent: 'missing',
    })
    const deniedDecision = providerLaunchDecisionV1(
      manifest,
      denied.plan,
      denied.observed,
      denied.boundary,
      denied.action,
    )
    expect(deniedDecision.ready).toBe(false)
    if (!deniedDecision.ready) expect(deniedDecision.blockers).toContain('overage_consent_required')

    const metered = launchFixture(manifest, selection, {
      required_capabilities: [],
    }, {
      overage_status: 'enabled',
      overage_consent: 'granted',
      metering_status: 'ready',
      cost_cap_status: 'enforced',
    })
    const meteredDecision = providerLaunchDecisionV1(
      manifest,
      metered.plan,
      metered.observed,
      metered.boundary,
      defineProviderActionV1({ ...metered.action, cost_limit: {
        currency: 'USD',
        max_cost_minor_units: 1_000,
      } }),
    )
    expect(meteredDecision.ready).toBe(false)
    if (!meteredDecision.ready) {
      expect(meteredDecision.blockers).toContain('durable_cost_authority_unavailable')
    }

    const unknown = launchFixture(manifest, selection, {
      required_capabilities: [],
    }, {
      overage_status: 'unknown',
      overage_consent: 'granted',
    })
    const unknownDecision = providerLaunchDecisionV1(
      manifest,
      unknown.plan,
      unknown.observed,
      unknown.boundary,
      unknown.action,
    )
    expect(unknownDecision.ready).toBe(false)
    if (!unknownDecision.ready) expect(unknownDecision.blockers).toContain('overage_unknown')
  })

  it('blocks required capabilities using the selected mode matrix', () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest, undefined, {
      required_capabilities: ['launch', 'plugins'],
    })
    const decision = providerLaunchDecisionV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    expect(decision.ready).toBe(false)
    if (!decision.ready) expect(decision.blockers).toContain('capability_unsupported')
  })

  it('derives the action capability even when caller extras are empty', () => {
    const copy = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    fixtureManifestIndex += 1
    copy.provider_id = `fixture-action-capability-${fixtureManifestIndex}`
    copy.adapter_id = `fixture-action-adapter-${fixtureManifestIndex}`
    copy.release_state = 'candidate'
    copy.modes[0]!.support = { state: 'supported' }
    copy.modes[0]!.capabilities.launch = {
      state: 'unknown',
      reason_code: 'launch_not_verified',
    }
    const manifest = defineProviderManifestV1(copy) as ProviderManifestV1
    const fixture = launchFixture(manifest)
    const decision = providerLaunchDecisionV1(
      manifest,
      intent(fixture.plan.selection, { required_capabilities: [] }),
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    expect(decision.ready).toBe(false)
    if (!decision.ready) expect(decision.blockers).toContain('capability_unsupported')
  })

  it('issues a request-hidden, manifest-bound, single-use launch authorization', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const result = authorizeProviderLaunchV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    expect(result.ready).toBe(true)
    if (!result.ready) return
    expect(result.authorization.evidence.usage_priced_api_consent.state).toBe('not_required')
    expect(JSON.stringify(result.authorization)).not.toContain('/safe/bin')
    expect(JSON.stringify(result.authorization)).not.toContain('Implement the task')
    let observedContext: {
      action: ProviderActionV1
      environment: Readonly<NodeJS.ProcessEnv>
    } | undefined
    const adapter = defineProviderExecutionAdapterV1(
      adapterImplementation(manifest, fixture, (context) => {
        observedContext = context as typeof observedContext
        return {
          contract_version: 1,
          session_id: 'session-1',
          provider_session_id: 'provider-session-1',
          selection: fixture.plan.selection,
          status: 'running',
          model: {
            requested: null,
            effective: 'default-model',
          },
          effort: null,
          access_profile: {
            requested: 'workspace_write',
            effective: 'workspace_write',
          },
        }
      }),
    )
    const session = await adapter.launch({ authorization: result.authorization })
    expect(session.session_id).toMatch(/^managed-[a-f0-9]{32}-1$/)
    expect(session.session_id).not.toBe('session-1')
    expect(observedContext?.environment.PATH).toBe('/safe/bin')
    expect(observedContext?.action).toEqual(fixture.action)
    expect(Object.isFrozen(observedContext?.environment)).toBe(true)
    await expect(adapter.launch({ authorization: result.authorization })).rejects.toMatchObject({
      code: 'launch_authorization_consumed',
    })
  })

  it('does not mint an API authorization without a durable branded cost receipt', () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1, 'native_api_key')
    const selection = selectProviderExecutionV1(manifest, {
      mode_id: 'native_api_key',
      usage_priced_api_consent: true,
    })
    expect(() => defineProviderExecutionIntentV1(intent(selection, {
      usage_priced_api: forgedCostConsent(selection),
      required_capabilities: [],
    }))).toThrowError(expect.objectContaining({
      code: 'verified_cost_consent_required',
    }))
  })

  it('rejects forged launch authorization and manifest substitution', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const adapter = defineProviderExecutionAdapterV1(adapterImplementation(manifest, fixture))
    await expect(adapter.launch({ authorization: {
      evidence: {} as never,
      toJSON: () => ({} as never),
    } })).rejects.toMatchObject({
      code: 'launch_authorization_required',
    })

    const result = authorizeProviderLaunchV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    if (!result.ready) throw new Error('fixture authorization failed')
    const AuthorizationConstructor = result.authorization.constructor as new (
      token: symbol,
      state: unknown,
    ) => unknown
    expect(() => new AuthorizationConstructor(Symbol('forged'), {}))
      .toThrowError(expect.objectContaining({ code: 'launch_authorization_required' }))
    const BoundaryConstructor = fixture.boundary.constructor as new (
      token: symbol,
      state: unknown,
    ) => unknown
    expect(() => new BoundaryConstructor(Symbol('forged'), {}))
      .toThrowError(expect.objectContaining({ code: 'launch_boundary_required' }))
    const other = supportedManifest(CLAUDE_PROVIDER_MANIFEST_V1)
    const otherFixture = launchFixture(other)
    const otherAdapter = defineProviderExecutionAdapterV1(
      adapterImplementation(other, otherFixture),
    )
    await expect(otherAdapter.launch({
      authorization: result.authorization,
    })).rejects.toMatchObject({
      code: 'launch_authorization_manifest_mismatch',
    })
  })

  it('requires an exact executable recheck immediately before authorization consumption', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const result = authorizeProviderLaunchV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    if (!result.ready) throw new Error('fixture authorization failed')
    const swappedImplementation = adapterImplementation(manifest, fixture)
    swappedImplementation.discoverExecutable = async () => ({
      ...fixture.discovery,
      resolved_path: '/safe/bin/swapped-codex',
    })
    const swappedAdapter = defineProviderExecutionAdapterV1(swappedImplementation)
    await expect(swappedAdapter.launch({
      authorization: result.authorization,
    })).rejects.toMatchObject({
      code: 'launch_authorization_executable_mismatch',
    })
    const correctAdapter = defineProviderExecutionAdapterV1(
      adapterImplementation(manifest, fixture),
    )
    const session = await correctAdapter.launch({
      authorization: result.authorization,
    })
    expect(session.session_id).toMatch(/^managed-[a-f0-9]{32}-1$/)
  })
})

describe('validated provider adapter gateway', () => {
  it('does not export the raw authorization-consumption primitive', async () => {
    const contractModule = await import('../src/provider-contract.js')
    expect(contractModule).not.toHaveProperty('consumeProviderLaunchAuthorizationV1')
  })

  it('consumes an exact action token before invoking raw code and validates every output', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    let launchCalls = 0
    const implementation = adapterImplementation(manifest, fixture, (context) => {
      launchCalls += 1
      expect((context as { action: ProviderActionV1 }).action.kind).toBe('launch')
      return {
        contract_version: 1,
        session_id: 'session-1',
        provider_session_id: 'provider-session-1',
        selection: fixture.plan.selection,
        status: 'running',
        model: {
          requested: null,
          effective: 'default-model',
        },
        effort: null,
        access_profile: {
          requested: 'workspace_write',
          effective: 'workspace_write',
        },
      }
    })
    const adapter = defineProviderExecutionAdapterV1(implementation)
    const followAction = defineProviderActionV1({
      contract_version: 1,
      kind: 'follow_up',
      action_id: 'follow-action-1',
      scope_id: 'scope-1',
      session_id: 'session-1',
      prompt: 'Continue',
      cost_limit: null,
    })
    const wrongActionAuthorization = authorizeProviderLaunchV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      followAction,
    )
    if (!wrongActionAuthorization.ready) throw new Error('follow-up fixture authorization failed')
    await expect(adapter.launch({
      authorization: wrongActionAuthorization.authorization,
    })).rejects.toMatchObject({
      code: 'launch_authorization_action_mismatch',
    })
    expect(launchCalls).toBe(0)

    const launchAuthorization = authorizeProviderLaunchV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    if (!launchAuthorization.ready) throw new Error('launch fixture authorization failed')
    const session = await adapter.launch({ authorization: launchAuthorization.authorization })
    expect(session.session_id).toMatch(/^managed-[a-f0-9]{32}-1$/)
    expect(session.session_id).not.toBe('session-1')
    expect(launchCalls).toBe(1)
    const events: ProviderEventV1[] = []
    for await (const event of adapter.events(session.session_id)) events.push(event)
    expect(events).toHaveLength(1)
    expect(events[0]?.session_id).toBe(session.session_id)
    expect(JSON.stringify(events)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
    expect((await adapter.usage(session.session_id)).metered_cost).toBeNull()
  })

  it('rejects malformed raw session output after a valid authorization', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const adapter = defineProviderExecutionAdapterV1(
      adapterImplementation(manifest, fixture, () => ({
        contract_version: 1,
        session_id: 'session-1',
        provider_session_id: 'provider-session-1',
        selection: fixture.plan.selection,
        status: 'running',
        model: null,
        effort: null,
        access_profile: null,
        raw_provider_state: 'credential-sentinel',
      })),
    )
    const result = authorizeProviderLaunchV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    if (!result.ready) throw new Error('fixture authorization failed')
    await expect(adapter.launch({ authorization: result.authorization })).rejects.toMatchObject({
      code: 'invalid_provider_session',
    })
  })

  it('requires effective launch evidence and keeps V1 rehydration fail-closed', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const requestedAction = defineProviderActionV1({
      ...launchAction({
        action_id: 'effective-evidence-action',
        model: 'requested-model',
        effort: 'high',
        access_profile: 'full_access',
      }),
    })
    const launchAuthorization = authorizeProviderLaunchV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      requestedAction,
    )
    if (!launchAuthorization.ready) throw new Error('fixture authorization failed')
    const missingEvidenceAdapter = defineProviderExecutionAdapterV1(
      adapterImplementation(manifest, fixture, () => ({
        contract_version: 1,
        session_id: 'session-1',
        provider_session_id: 'provider-session-1',
        selection: fixture.plan.selection,
        status: 'running',
        model: null,
        effort: null,
        access_profile: {
          requested: 'full_access',
          effective: 'full_access',
        },
      })),
    )
    await expect(missingEvidenceAdapter.launch({
      authorization: launchAuthorization.authorization,
    })).rejects.toMatchObject({
      code: 'provider_session_model_mismatch',
    })

    const resumeAction = defineProviderActionV1({
      contract_version: 1,
      kind: 'resume',
      action_id: 'resume-action-1',
      scope_id: 'scope-1',
      provider_session_id: 'expected-provider-session',
      cwd: '/workspace',
      cost_limit: null,
    })
    const resumeAuthorization = authorizeProviderLaunchV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      resumeAction,
    )
    expect(resumeAuthorization.ready).toBe(false)
    if (resumeAuthorization.ready) throw new Error('resume must remain fail-closed')
    expect(resumeAuthorization.blockers).toContain('capability_unsupported')
    const resumeAdapter = defineProviderExecutionAdapterV1(
      adapterImplementation(manifest, fixture),
    )
    await expect(resumeAdapter.resume({
      authorization: {} as never,
    })).rejects.toMatchObject({
      code: 'capability_unsupported',
    })

    const attachAdapter = defineProviderExecutionAdapterV1(
      adapterImplementation(manifest, fixture),
    )
    await expect(attachAdapter.attach({
      provider_session_id: 'expected-provider-session',
      selection: fixture.plan.selection,
    })).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
  })

  it('checks control capabilities before invoking the raw adapter', async () => {
    const copy = mutableManifest(CODEX_PROVIDER_MANIFEST_V1)
    fixtureManifestIndex += 1
    copy.provider_id = `fixture-control-capability-${fixtureManifestIndex}`
    copy.adapter_id = `fixture-control-adapter-${fixtureManifestIndex}`
    copy.release_state = 'candidate'
    copy.modes[0]!.support = { state: 'supported' }
    copy.modes[0]!.capabilities.cancel = {
      state: 'unsupported',
      reason_code: 'cancel_not_supported',
    }
    const manifest = defineProviderManifestV1(copy) as ProviderManifestV1
    const fixture = launchFixture(manifest, undefined, { required_capabilities: [] })
    let cancelCalls = 0
    const implementation = adapterImplementation(manifest, fixture)
    implementation.cancel = async () => {
      cancelCalls += 1
    }
    const adapter = defineProviderExecutionAdapterV1(implementation)
    const authorization = authorizeProviderLaunchV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    if (!authorization.ready) throw new Error('fixture authorization failed')
    const session = await adapter.launch({ authorization: authorization.authorization })
    await expect(adapter.cancel(session.session_id)).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
    expect(cancelCalls).toBe(0)
  })

  it('rejects follow-up for an unknown target session before raw invocation', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    let followUpCalls = 0
    const implementation = adapterImplementation(manifest, fixture)
    implementation.followUp = async () => {
      followUpCalls += 1
    }
    const adapter = defineProviderExecutionAdapterV1(implementation)
    const action = defineProviderActionV1({
      contract_version: 1,
      kind: 'follow_up',
      action_id: 'follow-action-unknown-session',
      scope_id: 'scope-1',
      session_id: 'unknown-session',
      prompt: 'Continue',
      cost_limit: null,
    })
    const authorization = authorizeProviderLaunchV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      action,
    )
    if (!authorization.ready) throw new Error('fixture authorization failed')
    await expect(adapter.followUp({
      authorization: authorization.authorization,
    })).rejects.toMatchObject({
      code: 'provider_session_authorization_required',
    })
    expect(followUpCalls).toBe(0)
  })

  it('keeps raw implementation, authorization, and session state runtime-inaccessible', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const adapter = defineProviderExecutionAdapterV1(adapterImplementation(manifest, fixture))
    await adapter.launch({
      authorization: authorizeAction(manifest, fixture, fixture.action),
    })
    const reflected = adapter as unknown as Record<string, unknown>
    for (const name of [
      'implementation',
      'sessionAuthorizations',
      'sessions',
      'consume',
      'validateSession',
      'requireCapability',
      'requireSessionCapability',
      'requireTargetSession',
    ]) {
      expect(reflected[name]).toBeUndefined()
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(adapter))).not.toContain(name)
    }
    expect(Object.isFrozen(adapter)).toBe(true)
    const serialized = JSON.stringify(adapter)
    expect(serialized).not.toContain('Implement the task')
    expect(serialized).not.toContain('/safe/bin')
  })

  it('sanitizes hostile adapter reflection and raw method or iterator failures', async () => {
    const sentinel = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error(sentinel)
      },
    })
    let reflectionError: unknown
    try {
      defineProviderExecutionAdapterV1(hostile as ProviderExecutionAdapterImplementationV1)
    } catch (caught) {
      reflectionError = caught
    }
    expect(reflectionError).toMatchObject({ code: 'invalid_provider_adapter' })
    expect([
      String(reflectionError),
      reflectionError instanceof Error ? reflectionError.stack ?? '' : '',
    ].join('\n')).not.toContain(sentinel)

    const discoveryManifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const discoveryFixture = launchFixture(discoveryManifest)
    const discoveryImplementation = adapterImplementation(discoveryManifest, discoveryFixture)
    discoveryImplementation.discoverExecutable = async () => {
      const error = new Error(sentinel) as Error & { credential?: string }
      error.credential = sentinel
      throw error
    }
    const discoveryAdapter = defineProviderExecutionAdapterV1(discoveryImplementation)
    await expectSafeAdapterFailure(
      () => discoveryAdapter.discoverExecutable(),
      sentinel,
      'discover_executable',
    )

    const launchManifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const launchFixtureValue = launchFixture(launchManifest)
    const launchImplementation = adapterImplementation(launchManifest, launchFixtureValue)
    launchImplementation.launch = async () => {
      throw new Error(sentinel, { cause: { credential: sentinel } })
    }
    const launchAdapter = defineProviderExecutionAdapterV1(launchImplementation)
    await expectSafeAdapterFailure(
      () => launchAdapter.launch({
        authorization: authorizeAction(
          launchManifest,
          launchFixtureValue,
          launchFixtureValue.action,
        ),
      }),
      sentinel,
      'launch',
    )

    const eventManifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const eventFixture = launchFixture(eventManifest)
    const eventImplementation = adapterImplementation(eventManifest, eventFixture)
    eventImplementation.events = async function* (sessionId) {
      yield {
        kind: 'status',
        event_id: 'event-before-failure',
        turn_id: 'turn-before-failure',
        session_id: sessionId,
        sequence: 1,
        observed_at: new Date().toISOString(),
        status: 'running',
      }
      throw new Error(sentinel)
    }
    const eventAdapter = defineProviderExecutionAdapterV1(eventImplementation)
    const session = await eventAdapter.launch({
      authorization: authorizeAction(eventManifest, eventFixture, eventFixture.action),
    })
    await expectSafeAdapterFailure(async () => {
      for await (const _event of eventAdapter.events(session.session_id)) {
        // Consume until the provider iterator fails.
      }
    }, sentinel, 'events')
  })

  it('binds discovery and readiness to the adapter manifest, intent, and boundary', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const foreignDiscoveryImplementation = adapterImplementation(manifest, fixture)
    foreignDiscoveryImplementation.discoverExecutable = async () => ({
      ...fixture.discovery,
      provider_id: 'foreign-provider',
    })
    const foreignDiscoveryAdapter = defineProviderExecutionAdapterV1(
      foreignDiscoveryImplementation,
    )
    await expect(foreignDiscoveryAdapter.discoverExecutable()).rejects.toMatchObject({
      code: 'executable_manifest_mismatch',
    })

    let readinessCalls = 0
    const readinessImplementation = adapterImplementation(manifest, fixture)
    readinessImplementation.probeReadiness = async () => {
      readinessCalls += 1
      return {
        ...fixture.observed,
        executable_fingerprint: OTHER_FINGERPRINT,
      }
    }
    const readinessAdapter = defineProviderExecutionAdapterV1(readinessImplementation)
    await expect(readinessAdapter.probeReadiness(
      fixture.plan,
      fixture.boundary,
    )).rejects.toMatchObject({ code: 'readiness_context_mismatch' })
    expect(readinessCalls).toBe(1)

    const otherManifest = supportedManifest(CLAUDE_PROVIDER_MANIFEST_V1)
    const otherFixture = launchFixture(otherManifest)
    readinessCalls = 0
    await expect(readinessAdapter.probeReadiness(
      fixture.plan,
      otherFixture.boundary,
    )).rejects.toMatchObject({ code: 'readiness_context_mismatch' })
    expect(readinessCalls).toBe(0)
  })

  it('blocks policy-ineligible provider operations and requires one effective default model', async () => {
    const claudeFixture = launchFixture(CLAUDE_PROVIDER_MANIFEST_V1)
    let claudeModelCalls = 0
    const claudeImplementation = adapterImplementation(
      CLAUDE_PROVIDER_MANIFEST_V1,
      claudeFixture,
    )
    claudeImplementation.listModels = async () => {
      claudeModelCalls += 1
      return []
    }
    const claudeAdapter = defineProviderExecutionAdapterV1(claudeImplementation)
    await expect(claudeAdapter.listModels(claudeFixture.plan)).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
    expect(claudeModelCalls).toBe(0)

    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const implementation = adapterImplementation(manifest, fixture)
    const adapter = defineProviderExecutionAdapterV1(implementation)
    await expect(adapter.listModels(fixture.plan)).rejects.toMatchObject({
      code: 'invalid_provider_models',
    })

    const validImplementation = adapterImplementation(manifest, fixture)
    validImplementation.listModels = async () => [{
      id: 'default-model',
      display_name: 'Default model',
      is_default: true,
      supports_effort: true,
      effort_levels: ['low', 'high'],
    }]
    await expect(defineProviderExecutionAdapterV1(validImplementation).listModels(fixture.plan))
      .resolves.toHaveLength(1)
  })

  it('matches requested model and effort evidence including exact null semantics', async () => {
    const defaultManifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const defaultFixture = launchFixture(defaultManifest)
    const fabricatedDefault = defineProviderExecutionAdapterV1(
      adapterImplementation(defaultManifest, defaultFixture, () => sessionOutput(defaultFixture, {
        model: {
          requested: 'caller-never-requested',
          effective: 'caller-never-requested',
        },
        effort: {
          requested: 'ultra',
          effective: 'ultra',
        },
      })),
    )
    await expect(fabricatedDefault.launch({
      authorization: authorizeAction(defaultManifest, defaultFixture, defaultFixture.action),
    })).rejects.toMatchObject({ code: 'provider_session_model_mismatch' })

    const effortManifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const effortFixture = launchFixture(effortManifest)
    const effortAction = defineProviderActionV1(launchAction({
      action_id: 'requested-effort-evidence',
      effort: 'high',
    }))
    const missingEffectiveEffort = defineProviderExecutionAdapterV1(
      adapterImplementation(effortManifest, effortFixture, () => sessionOutput(effortFixture, {
        effort: {
          requested: 'high',
          effective: null,
        },
      })),
    )
    await expect(missingEffectiveEffort.launch({
      authorization: authorizeAction(effortManifest, effortFixture, effortAction),
    })).rejects.toMatchObject({ code: 'provider_session_effort_mismatch' })

    const missingDefaultManifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const missingDefaultFixture = launchFixture(missingDefaultManifest)
    const missingDefault = defineProviderExecutionAdapterV1(
      adapterImplementation(
        missingDefaultManifest,
        missingDefaultFixture,
        () => sessionOutput(missingDefaultFixture, { model: null }),
      ),
    )
    await expect(missingDefault.launch({
      authorization: authorizeAction(
        missingDefaultManifest,
        missingDefaultFixture,
        missingDefaultFixture.action,
      ),
    })).rejects.toMatchObject({ code: 'provider_session_model_mismatch' })
  })

  it('keeps follow-up and fork inside the originating session scope', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    let followUpCalls = 0
    let forkCalls = 0
    const implementation = adapterImplementation(manifest, fixture, (context) => {
      if ((context as { action: ProviderActionV1 }).action.kind === 'fork') forkCalls += 1
      return sessionOutput(fixture)
    })
    implementation.followUp = async () => {
      followUpCalls += 1
    }
    const adapter = defineProviderExecutionAdapterV1(implementation)
    const parent = await adapter.launch({
      authorization: authorizeAction(manifest, fixture, fixture.action),
    })

    const followAction = defineProviderActionV1({
      contract_version: 1,
      kind: 'follow_up',
      action_id: 'cross-scope-follow',
      scope_id: 'scope-2',
      session_id: parent.session_id,
      prompt: 'Continue elsewhere',
      cost_limit: null,
    })
    await expect(adapter.followUp({
      authorization: authorizeAction(manifest, fixture, followAction),
    })).rejects.toMatchObject({ code: 'provider_session_scope_mismatch' })
    expect(followUpCalls).toBe(0)

    const forkAction = defineProviderActionV1({
      contract_version: 1,
      kind: 'fork',
      action_id: 'cross-scope-fork',
      scope_id: 'scope-2',
      session_id: parent.session_id,
      model: null,
      effort: null,
      access_profile: 'workspace_write',
      cost_limit: null,
    })
    await expect(adapter.fork({
      authorization: authorizeAction(manifest, fixture, forkAction),
    })).rejects.toMatchObject({ code: 'provider_session_scope_mismatch' })
    expect(forkCalls).toBe(0)
  })

  it('rejects fork or launch identity reuse without replacing the parent session', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    let cancelCalls = 0
    const implementation = adapterImplementation(
      manifest,
      fixture,
      () => sessionOutput(fixture),
    )
    implementation.cancel = async () => {
      cancelCalls += 1
    }
    const adapter = defineProviderExecutionAdapterV1(implementation)
    const parent = await adapter.launch({
      authorization: authorizeAction(manifest, fixture, fixture.action),
    })
    const forkAction = defineProviderActionV1({
      contract_version: 1,
      kind: 'fork',
      action_id: 'fork-reusing-parent',
      scope_id: fixture.action.scope_id,
      session_id: parent.session_id,
      model: null,
      effort: null,
      access_profile: 'workspace_write',
      cost_limit: null,
    })
    await expect(adapter.fork({
      authorization: authorizeAction(manifest, fixture, forkAction),
    })).rejects.toMatchObject({ code: 'provider_session_fork_identity_mismatch' })

    const duplicateLaunchAction = defineProviderActionV1(launchAction({
      action_id: 'duplicate-session-launch',
    }))
    await expect(adapter.launch({
      authorization: authorizeAction(manifest, fixture, duplicateLaunchAction),
    })).rejects.toMatchObject({ code: 'provider_session_identity_conflict' })
    await adapter.cancel(parent.session_id)
    expect(cancelCalls).toBe(1)
  })

  it('binds fork access to sealed authority without exceeding the parent ceiling', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const parentAction = defineProviderActionV1(launchAction({
      action_id: 'read-only-parent',
      access_profile: 'read_only',
    }))
    let forkCalls = 0
    const implementation = adapterImplementation(manifest, fixture, (context) => {
      const action = (context as { action: ProviderActionV1 }).action
      if (action.kind === 'launch') {
        return sessionOutput(fixture, {
          access_profile: {
            requested: 'read_only',
            effective: 'read_only',
          },
        })
      }
      forkCalls += 1
      return sessionOutput(fixture, {
        session_id: 'fork-child-session',
        provider_session_id: 'fork-child-provider-session',
        access_profile: {
          requested: 'read_only',
          effective: 'full_access',
        },
      })
    })
    const adapter = defineProviderExecutionAdapterV1(implementation)
    const parent = await adapter.launch({
      authorization: authorizeAction(manifest, fixture, parentAction),
    })

    const elevatedAction = defineProviderActionV1({
      contract_version: 1,
      kind: 'fork',
      action_id: 'fork-elevated-request',
      scope_id: parentAction.scope_id,
      session_id: parent.session_id,
      model: null,
      effort: null,
      access_profile: 'full_access',
      cost_limit: null,
    })
    await expect(adapter.fork({
      authorization: authorizeAction(manifest, fixture, elevatedAction),
    })).rejects.toMatchObject({ code: 'provider_session_access_mismatch' })
    expect(forkCalls).toBe(0)

    const readOnlyAction = defineProviderActionV1({
      contract_version: 1,
      kind: 'fork',
      action_id: 'fork-read-only-request',
      scope_id: parentAction.scope_id,
      session_id: parent.session_id,
      model: null,
      effort: null,
      access_profile: 'read_only',
      cost_limit: null,
    })
    await expect(adapter.fork({
      authorization: authorizeAction(manifest, fixture, readOnlyAction),
    })).rejects.toMatchObject({ code: 'provider_session_access_mismatch' })
    expect(forkCalls).toBe(1)
  })

  it('persists event ordering across subscriptions and retires terminal sessions', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    let subscriptions = 0
    const implementation = adapterImplementation(manifest, fixture)
    implementation.events = async function* (sessionId) {
      subscriptions += 1
      if (subscriptions === 1) {
        yield {
          kind: 'status',
          event_id: 'event-persistent-1',
          turn_id: 'turn-persistent',
          session_id: sessionId,
          sequence: 1,
          observed_at: new Date().toISOString(),
          status: 'running',
        }
        return
      }
      if (subscriptions === 2) {
        yield {
          kind: 'status',
          event_id: 'event-persistent-2',
          turn_id: 'turn-persistent',
          session_id: sessionId,
          sequence: 1,
          observed_at: new Date().toISOString(),
          status: 'running',
        }
        return
      }
      yield {
        kind: 'status',
        event_id: 'event-persistent-3',
        turn_id: 'turn-persistent',
        session_id: sessionId,
        sequence: 2,
        observed_at: new Date().toISOString(),
        status: 'stopped',
      }
    }
    const adapter = defineProviderExecutionAdapterV1(implementation)
    const session = await adapter.launch({
      authorization: authorizeAction(manifest, fixture, fixture.action),
    })
    for await (const _event of adapter.events(session.session_id)) {
      // First subscription establishes the persistent sequence high-water mark.
    }
    await expect((async () => {
      for await (const _event of adapter.events(session.session_id)) {
        // The repeated sequence is rejected across subscriptions.
      }
    })()).rejects.toMatchObject({ code: 'invalid_provider_event_order' })
    for await (const _event of adapter.events(session.session_id)) {
      // Terminal status retires the session after delivery.
    }
    await expect(adapter.cancel(session.session_id)).rejects.toMatchObject({
      code: 'provider_session_authorization_required',
    })
  })

  it('retires a session before a terminal event is observable through manual iteration', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    let cancelCalls = 0
    const implementation = adapterImplementation(manifest, fixture)
    implementation.cancel = async () => {
      cancelCalls += 1
    }
    implementation.events = async function* (sessionId) {
      yield {
        kind: 'status',
        event_id: 'event-manual-terminal',
        turn_id: 'turn-manual-terminal',
        session_id: sessionId,
        sequence: 1,
        observed_at: new Date().toISOString(),
        status: 'stopped',
      }
    }
    const adapter = defineProviderExecutionAdapterV1(implementation)
    const session = await adapter.launch({
      authorization: authorizeAction(manifest, fixture, fixture.action),
    })

    const iterator = adapter.events(session.session_id)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: 'status',
        status: 'stopped',
      },
    })
    await expect(adapter.cancel(session.session_id)).rejects.toMatchObject({
      code: 'provider_session_authorization_required',
    })
    expect(cancelCalls).toBe(0)
    await iterator.return?.()
  })

  it('invalidates an old stream before reused identities can expose stale events', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    let cancelCalls = 0
    const implementation = adapterImplementation(
      manifest,
      fixture,
      () => sessionOutput(fixture),
    )
    implementation.cancel = async () => {
      cancelCalls += 1
    }
    implementation.events = async function* (sessionId) {
      yield {
        kind: 'status',
        event_id: 'event-before-stop',
        turn_id: 'turn-before-stop',
        session_id: sessionId,
        sequence: 1,
        observed_at: new Date().toISOString(),
        status: 'running',
      }
      yield {
        kind: 'message',
        event_id: 'event-stale-after-stop',
        turn_id: 'turn-before-stop',
        session_id: sessionId,
        sequence: 2,
        observed_at: new Date().toISOString(),
        role: 'assistant',
        text: 'stale-output-must-not-cross-session-generations',
      }
    }
    const adapter = defineProviderExecutionAdapterV1(implementation)
    const original = await adapter.launch({
      authorization: authorizeAction(manifest, fixture, fixture.action),
    })
    const oldIterator = adapter.events(original.session_id)[Symbol.asyncIterator]()
    await expect(oldIterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        event_id: 'event-before-stop',
      },
    })

    await adapter.stop(original.session_id)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const replacementAction = defineProviderActionV1(launchAction({
      action_id: 'replacement-session-action',
      scope_id: 'scope-2',
    }))
    const replacement = await adapter.launch({
      authorization: authorizeAction(manifest, fixture, replacementAction),
    })
    expect(replacement.session_id).not.toBe(original.session_id)

    let staleError: unknown
    try {
      await oldIterator.next()
    } catch (caught) {
      staleError = caught
    }
    expect(staleError).toMatchObject({ code: 'provider_event_session_retired' })
    expect(JSON.stringify(staleError))
      .not.toContain('stale-output-must-not-cross-session-generations')
    await expect(adapter.cancel(replacement.session_id)).resolves.toBeUndefined()
    expect(cancelCalls).toBe(1)
  })

  it('bounds live session state and releases capacity after a successful stop', async () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    let launchCalls = 0
    const implementation = adapterImplementation(manifest, fixture, () => {
      launchCalls += 1
      return sessionOutput(fixture, {
        session_id: `capacity-session-${launchCalls}`,
        provider_session_id: `capacity-provider-session-${launchCalls}`,
      })
    })
    const adapter = defineProviderExecutionAdapterV1(implementation)
    let firstManagedSessionId = ''
    for (let index = 0; index < PROVIDER_SESSION_REGISTRY_LIMIT; index += 1) {
      const action = defineProviderActionV1(launchAction({
        action_id: `capacity-action-${index}`,
      }))
      const session = await adapter.launch({
        authorization: authorizeAction(manifest, fixture, action),
      })
      if (index === 0) firstManagedSessionId = session.session_id
    }
    await expect(adapter.launch({
      authorization: {} as never,
    })).rejects.toMatchObject({ code: 'provider_session_capacity_exceeded' })
    expect(launchCalls).toBe(PROVIDER_SESSION_REGISTRY_LIMIT)

    await adapter.stop(firstManagedSessionId)
    const replacementAction = defineProviderActionV1(launchAction({
      action_id: 'capacity-replacement',
    }))
    const replacement = await adapter.launch({
      authorization: authorizeAction(manifest, fixture, replacementAction),
    })
    expect(replacement.session_id).toMatch(/^managed-[a-f0-9]{32}-[a-z0-9]+$/)
    expect(launchCalls).toBe(PROVIDER_SESSION_REGISTRY_LIMIT + 1)
  })
})

describe('provider environment boundary', () => {
  it('reports subscription conflicts by variable name without leaking values', () => {
    const selection = selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1)
    const plan = intent(selection)
    const sentinel = 'credential-sentinel-codex-environment'
    let error: unknown
    try {
      prepareProviderEnvironmentV1(CODEX_PROVIDER_MANIFEST_V1, plan, {
        PATH: '/safe/bin',
        OPENAI_API_KEY: sentinel,
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({
      code: 'environment_conflict',
      variables: ['OPENAI_API_KEY'],
    })
    expect(JSON.stringify(error)).not.toContain(sentinel)
    expect(String(error)).not.toContain(sentinel)
  })

  it('strips every declared Claude billing or provider override', () => {
    const plan = intent(selectProviderExecutionV1(CLAUDE_PROVIDER_MANIFEST_V1))
    const source: NodeJS.ProcessEnv = { PATH: '/safe/bin' }
    for (const rule of CLAUDE_PROVIDER_MANIFEST_V1.environment.conflict_rules) {
      source[rule.variable] = `credential-sentinel-${rule.variable}`
    }
    const prepared = prepareProviderEnvironmentV1(
      CLAUDE_PROVIDER_MANIFEST_V1,
      plan,
      source,
      { on_conflict: 'strip' },
    )
    const spawn = prepared.forSpawn()
    expect(spawn.PATH).toBe('/safe/bin')
    for (const rule of CLAUDE_PROVIDER_MANIFEST_V1.environment.conflict_rules) {
      expect(spawn).not.toHaveProperty(rule.variable)
    }
    expect(JSON.stringify(prepared)).not.toContain('credential-sentinel')
  })

  it('preserves unrelated tool variables internally but never serializes values', () => {
    const plan = intent(selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1))
    const sentinel = 'credential-sentinel-tool-environment'
    const prepared = prepareProviderEnvironmentV1(
      CODEX_PROVIDER_MANIFEST_V1,
      plan,
      {
        PATH: '/safe/bin',
        GITHUB_TOKEN: sentinel,
        OPENAI_API_KEY: 'credential-sentinel-openai',
      },
      { on_conflict: 'strip' },
    )
    expect(prepared.forSpawn()).toMatchObject({ PATH: '/safe/bin', GITHUB_TOKEN: sentinel })
    expect(prepared.forSpawn()).not.toHaveProperty('OPENAI_API_KEY')
    expect(JSON.stringify(prepared)).not.toContain('credential-sentinel')
    const PreparedConstructor = prepared.constructor as new (
      token: symbol,
      environment: Record<string, string>,
      evidence: unknown,
    ) => unknown
    expect(() => new PreparedConstructor(
      Symbol('forged'),
      { OPENAI_API_KEY: 'credential-sentinel-forged' },
      prepared.evidence,
    )).toThrowError(expect.objectContaining({ code: 'prepared_environment_required' }))
  })

  it('requires durable API consent before allowing API variables', () => {
    const selection = selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1, {
      mode_id: 'native_api_key',
      usage_priced_api_consent: true,
    })
    const withoutReceipt = intent(selection, {
      usage_priced_api: noCostConsent(),
      required_capabilities: [],
    })
    expect(() => prepareProviderEnvironmentV1(
      CODEX_PROVIDER_MANIFEST_V1,
      withoutReceipt,
      { OPENAI_API_KEY: 'credential-sentinel-api' },
    )).toThrowError(expect.objectContaining({
      code: 'usage_priced_api_consent_required',
    }))

    expect(() => defineProviderExecutionIntentV1(intent(selection, {
      usage_priced_api: forgedCostConsent(selection),
      required_capabilities: [],
    }))).toThrowError(expect.objectContaining({
      code: 'verified_cost_consent_required',
    }))
  })

  it('rejects conflicting overrides and incomplete audits', () => {
    const codexPlan = intent(selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1))
    expect(() => prepareProviderEnvironmentV1(
      CODEX_PROVIDER_MANIFEST_V1,
      codexPlan,
      { PATH: '/safe/bin' },
      { overrides: { CODEX_API_KEY: 'credential-sentinel-override' } },
    )).toThrowError(expect.objectContaining({
      code: 'environment_conflict',
      variables: ['CODEX_API_KEY'],
    }))
    const qwenPlan = intent(selectProviderExecutionV1(QWEN_PROVIDER_MANIFEST_V1))
    expect(() => prepareProviderEnvironmentV1(
      QWEN_PROVIDER_MANIFEST_V1,
      qwenPlan,
      { PATH: '/safe/bin' },
    )).toThrowError(expect.objectContaining({
      code: 'environment_audit_incomplete',
    }))
  })

  it('rejects invalid names, NUL values, accessors, proxies, and null options safely', () => {
    const plan = intent(selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1))
    expect(() => prepareProviderEnvironmentV1(
      CODEX_PROVIDER_MANIFEST_V1,
      plan,
      { 'BAD=NAME': 'value' },
    )).toThrowError(expect.objectContaining({ code: 'invalid_environment_name' }))
    expect(() => prepareProviderEnvironmentV1(
      CODEX_PROVIDER_MANIFEST_V1,
      plan,
      { SAFE_NAME: 'value\0credential' },
    )).toThrowError(expect.objectContaining({ code: 'invalid_environment_value' }))
    expect(() => prepareProviderEnvironmentV1(
      CODEX_PROVIDER_MANIFEST_V1,
      plan,
      { PATH: '/safe/bin' },
      null as never,
    )).toThrowError(ProviderContractError)

    const sentinel = 'credential-sentinel-hostile-environment'
    let getterCalls = 0
    const accessor = Object.defineProperty({}, 'OPENAI_API_KEY', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error(sentinel)
      },
    }) as NodeJS.ProcessEnv
    expect(() => prepareProviderEnvironmentV1(
      CODEX_PROVIDER_MANIFEST_V1,
      plan,
      accessor,
    )).toThrowError(expect.objectContaining({ code: 'environment_accessor_rejected' }))
    expect(getterCalls).toBe(0)

    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error(sentinel)
      },
    }) as NodeJS.ProcessEnv
    let error: unknown
    try {
      prepareProviderEnvironmentV1(CODEX_PROVIDER_MANIFEST_V1, plan, hostile)
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'environment_unreadable' })
    expect(String(error)).not.toContain(sentinel)
  })

  it('never carries one provider credential family into another provider child', () => {
    const sentinel = 'credential-sentinel-cross-provider'
    const codexPlan = intent(selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1))
    expect(() => prepareProviderEnvironmentV1(
      CODEX_PROVIDER_MANIFEST_V1,
      codexPlan,
      {
        PATH: '/safe/bin',
        CLAUDE_CODE_OAUTH_TOKEN: sentinel,
        ANTHROPIC_API_KEY: sentinel,
      },
    )).toThrowError(expect.objectContaining({ code: 'environment_conflict' }))
    const codexEnvironment = prepareProviderEnvironmentV1(
      CODEX_PROVIDER_MANIFEST_V1,
      codexPlan,
      {
        PATH: '/safe/bin',
        CLAUDE_CODE_OAUTH_TOKEN: sentinel,
        ANTHROPIC_API_KEY: sentinel,
      },
      { on_conflict: 'strip' },
    ).forSpawn()
    expect(codexEnvironment).toEqual({ PATH: '/safe/bin' })

    const claudePlan = intent(selectProviderExecutionV1(CLAUDE_PROVIDER_MANIFEST_V1))
    const claudeEnvironment = prepareProviderEnvironmentV1(
      CLAUDE_PROVIDER_MANIFEST_V1,
      claudePlan,
      {
        PATH: '/safe/bin',
        CODEX_ACCESS_TOKEN: sentinel,
        OPENAI_API_KEY: sentinel,
      },
      { on_conflict: 'strip' },
    ).forSpawn()
    expect(claudeEnvironment).toEqual({ PATH: '/safe/bin' })
  })
})

describe('runtime-safe provider outputs', () => {
  it('redacts credential-shaped event text and rejects raw extra fields', () => {
    const credential = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    const event = defineProviderEventV1({
      kind: 'approval',
      event_id: 'event-1',
      turn_id: 'turn-1',
      session_id: 'session-1',
      sequence: 1,
      observed_at: new Date().toISOString(),
      approval_id: 'approval-1',
      approval_kind: 'tool',
      status: 'requested',
      safe_summary: `Run tool using ${credential}`,
    })
    expect(JSON.stringify(event)).not.toContain(credential)
    expect(() => defineProviderApprovalDecisionV1({
      approval_id: credential,
      decision: 'reject',
    })).toThrowError(expect.objectContaining({ code: 'invalid_approval_decision' }))
    expect(() => defineProviderEventV1({
      ...event,
      raw_parameters: { api_key: credential },
    } as unknown as ProviderEventV1)).toThrowError(expect.objectContaining({
      code: 'invalid_provider_event',
    }))
    let codeError: unknown
    try {
      defineProviderEventV1({
        kind: 'error',
        event_id: 'event-2',
        turn_id: 'turn-1',
        session_id: 'session-1',
        sequence: 2,
        observed_at: new Date().toISOString(),
        code: credential,
        safe_message: 'Provider failed',
      })
    } catch (caught) {
      codeError = caught
    }
    expect(codeError).toMatchObject({ code: 'invalid_provider_event' })
    expect(String(codeError)).not.toContain(credential)
  })

  it('rejects credential-shaped runtime identities without collapsing identity keys', () => {
    const credential = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    const selection = selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1)
    const sessionFixture = launchFixture(supportedManifest(CODEX_PROVIDER_MANIFEST_V1))
    const cases: Array<() => unknown> = [
      () => defineProviderExecutableDiscoveryV1({
        contract_version: 1,
        provider_id: credential,
        adapter_id: selection.adapter_id,
        status: 'unknown',
        source: 'unknown',
        version: null,
        platform: null,
        resolved_path: null,
        executable_fingerprint: FINGERPRINT,
      }),
      () => defineProviderReadinessV1(readiness({
        ...selection,
        provider_id: credential,
      }, FINGERPRINT)),
      () => defineProviderSessionV1({
        ...sessionOutput(sessionFixture),
        session_id: credential,
      }),
      () => defineProviderSessionV1({
        ...sessionOutput(sessionFixture),
        provider_session_id: credential,
      }),
      () => defineProviderEventV1({
        kind: 'status',
        event_id: 'event-safe-identity',
        turn_id: 'turn-safe-identity',
        session_id: credential,
        sequence: 1,
        observed_at: new Date().toISOString(),
        status: 'running',
      }),
    ]
    for (const run of cases) {
      let error: unknown
      try {
        run()
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(ProviderContractError)
      expect([String(error), JSON.stringify(error)].join('\n')).not.toContain(credential)
    }
  })

  it('validates approval decisions without accepting raw parameters', () => {
    expect(defineProviderApprovalDecisionV1({
      approval_id: 'approval-1',
      decision: 'approve',
    })).toEqual({ approval_id: 'approval-1', decision: 'approve' })
    expect(() => defineProviderApprovalDecisionV1({
      approval_id: 'approval-1',
      decision: 'approve',
      raw_parameters: { command: 'unsafe' },
    } as never)).toThrowError(expect.objectContaining({
      code: 'invalid_approval_decision',
    }))
  })

  it('records requested and effective model, effort, and access profile', () => {
    const selection = selectProviderExecutionV1(CODEX_PROVIDER_MANIFEST_V1)
    const session = defineProviderSessionV1({
      contract_version: 1,
      session_id: 'session-1',
      provider_session_id: 'thread-1',
      selection,
      status: 'running',
      model: { requested: 'default', effective: 'gpt-codex-current' },
      effort: { requested: 'high', effective: 'high' },
      access_profile: { requested: 'workspace_write', effective: 'workspace_write' },
    })
    expect(session.model?.effective).toBe('gpt-codex-current')
    expect(session.effort?.effective).toBe('high')
    expect(session.access_profile?.effective).toBe('workspace_write')
    expect(() => defineProviderSessionV1({
      ...session,
      raw_provider_state: 'credential-sentinel',
    } as ProviderSessionV1)).toThrowError(expect.objectContaining({
      code: 'invalid_provider_session',
    }))
    expect(() => defineProviderSessionV1({
      ...session,
      model: { requested: null, effective: '' },
    })).toThrowError(expect.objectContaining({
      code: 'invalid_provider_session_model',
    }))
  })

  it('validates executable discovery and model outputs exactly', () => {
    expect(defineProviderExecutableDiscoveryV1({
      contract_version: 1,
      provider_id: 'codex',
      adapter_id: 'codex-app-server',
      status: 'validated',
      source: 'path',
      version: '0.144.6',
      platform: 'darwin-arm64',
      resolved_path: '/safe/bin/codex',
      executable_fingerprint: FINGERPRINT,
    }).version).toBe('0.144.6')
    const credential = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    expect(JSON.stringify(defineProviderExecutableDiscoveryV1({
      contract_version: 1,
      provider_id: 'codex',
      adapter_id: 'codex-app-server',
      status: 'incompatible',
      source: 'path',
      version: credential,
      platform: 'darwin-arm64',
      resolved_path: '/safe/bin/codex',
      executable_fingerprint: FINGERPRINT,
    }))).not.toContain(credential)
    expect(() => defineProviderModelsV1([{
      id: credential,
      display_name: 'Credential-shaped model',
      is_default: true,
      supports_effort: false,
      effort_levels: [],
    }])).toThrowError(expect.objectContaining({
      code: 'invalid_provider_model',
    }))
    expect(defineProviderModelsV1([{
      id: 'default',
      display_name: 'Default',
      is_default: true,
      supports_effort: true,
      effort_levels: ['low', 'high'],
    }])).toHaveLength(1)
    expect(() => defineProviderModelsV1([
      {
        id: 'one',
        display_name: 'One',
        is_default: true,
        supports_effort: false,
        effort_levels: [],
      },
      {
        id: 'two',
        display_name: 'Two',
        is_default: true,
        supports_effort: false,
        effort_levels: [],
      },
    ])).toThrowError(expect.objectContaining({ code: 'invalid_provider_models' }))
  })

  it('validates subscription usage and rejects unbound or over-cap metered evidence', () => {
    const manifest = supportedManifest(CODEX_PROVIDER_MANIFEST_V1)
    const fixture = launchFixture(manifest)
    const authorization = authorizeProviderLaunchV1(
      manifest,
      fixture.plan,
      fixture.observed,
      fixture.boundary,
      fixture.action,
    )
    if (!authorization.ready) throw new Error('fixture authorization failed')
    const usage: ProviderUsageV1 = {
      contract_version: 1,
      observed_at: new Date().toISOString(),
      selection: fixture.plan.selection,
      action_id: fixture.action.action_id,
      scope_id: fixture.action.scope_id,
      billing_mode: 'personal_subscription',
      status: 'available',
      overage_status: 'not_applicable',
      windows: [{ kind: 'monthly', used_percent: 20, resets_at: null }],
      metered_cost: null,
    }
    expect(defineProviderUsageV1(usage, authorization.authorization).metered_cost).toBeNull()
    expect(() => defineProviderUsageV1({
      ...usage,
      overage_status: 'enabled',
      metered_cost: {
        purpose: 'usage_priced_api',
        receipt_id: 'receipt-1',
        currency: 'USD',
        incurred_minor_units: 6_000,
        limit_minor_units: 5_000,
      },
    }, authorization.authorization)).toThrowError(expect.objectContaining({
      code: 'invalid_metered_cost',
    }))
    expect(() => defineProviderUsageV1({
      ...usage,
      overage_status: 'enabled',
      status: 'exhausted',
      metered_cost: {
        purpose: 'usage_priced_api',
        receipt_id: 'receipt-1',
        currency: 'USD',
        incurred_minor_units: 5_000,
        limit_minor_units: 5_000,
      },
    }, authorization.authorization)).toThrowError(expect.objectContaining({
      code: 'metered_usage_authorization_mismatch',
    }))
    expect(() => defineProviderUsageV1({
      ...usage,
      action_id: 'foreign-action',
    }, authorization.authorization)).toThrowError(expect.objectContaining({
      code: 'provider_usage_authorization_mismatch',
    }))
    expect(() => defineProviderUsageV1({
      ...usage,
      action_id: 'sk-abcdefghijklmnopqrstuvwxyz123456',
    }, authorization.authorization)).toThrowError(expect.objectContaining({
      code: 'invalid_provider_usage',
    }))
  })
})

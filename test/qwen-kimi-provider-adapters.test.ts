import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  defineProviderExecutionIntentV1,
  defineProviderNoCostConsentV1,
  selectProviderExecutionV1,
} from '../src/provider-contract.js'
import type { ProviderManifestV1 } from '../src/provider-contract.js'
import {
  KIMI_PROVIDER_MANIFEST_V1,
  QWEN_PROVIDER_MANIFEST_V1,
} from '../src/provider-manifests.js'
import {
  createKimiProviderAdapterV1,
  discoverKimiProviderExecutableV1,
  inspectKimiProviderCandidateV1,
} from '../src/runtime/drivers/kimi-provider-adapter.js'
import {
  createQwenProviderAdapterV1,
  discoverQwenProviderExecutableV1,
  inspectQwenProviderCandidateV1,
} from '../src/runtime/drivers/qwen-provider-adapter.js'
import {
  defineTerminalProviderCandidateEvidenceV1,
  discoverTerminalProviderExecutableV1,
} from '../src/runtime/drivers/terminal-provider-discovery.js'
import type {
  AgentDriver,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
} from '../src/runtime/types.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

const executableFixture = (
  command: string,
): {
  bytes: Uint8Array
  directory: string
  path: string
} => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestra-provider-candidate-'))
  temporaryDirectories.push(directory)
  const bytes = Buffer.from('#!/bin/sh\nexit 0\n', 'utf8')
  const path = join(directory, command)
  writeFileSync(path, bytes)
  chmodSync(path, 0o700)
  return { bytes, directory, path: realpathSync(path) }
}

const fingerprint = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const nativeIntent = (manifest: ProviderManifestV1) =>
  defineProviderExecutionIntentV1({
    selection: selectProviderExecutionV1(manifest),
    execution_scope: 'managed_background',
    usage_priced_api: defineProviderNoCostConsentV1(),
    provider_managed_overage: defineProviderNoCostConsentV1(),
    required_capabilities: ['launch', 'structured_events'],
  })

type CountingDriver = AgentDriver & {
  calls: {
    attach: number
    events: number
    interrupt: number
    launch: number
    send: number
    stop: number
  }
}

const countingDriver = (id: 'qwen' | 'kimi'): CountingDriver => {
  const calls = {
    attach: 0,
    events: 0,
    interrupt: 0,
    launch: 0,
    send: 0,
    stop: 0,
  }
  return {
    id,
    calls,
    capabilities: () => ({
      attach: false,
      streaming: false,
      interrupt: false,
      stop: false,
      rawTerminal: true,
      resume: false,
      tokenBudget: false,
      costBudget: false,
    }),
    async launch(_request: DriverLaunchRequest): Promise<DriverSession> {
      calls.launch += 1
      throw new Error('raw launch must remain unreachable')
    },
    async attach(): Promise<DriverSession | null> {
      calls.attach += 1
      return null
    },
    async send(): Promise<void> {
      calls.send += 1
    },
    async interrupt(): Promise<void> {
      calls.interrupt += 1
    },
    async stop(): Promise<void> {
      calls.stop += 1
    },
    events(): AsyncIterable<DriverEvent> {
      calls.events += 1
      return (async function *empty(): AsyncIterable<DriverEvent> {})()
    },
  }
}

describe('Qwen Code and Kimi Code executable discovery candidates', () => {
  it.each([
    {
      command: 'qwen',
      discover: discoverQwenProviderExecutableV1,
      provider: 'qwen',
      adapter: 'qwen-code-cli',
      version: '0.10.2',
    },
    {
      command: 'kimi',
      discover: discoverKimiProviderExecutableV1,
      provider: 'kimi',
      adapter: 'kimi-code-acp',
      version: '1.7.0',
    },
  ])(
    'records exact path, bytes, version, and provenance for $provider without forwarding credentials',
    ({ command, discover, provider, adapter, version }) => {
      const fixture = executableFixture(command)
      let resolverEnvironment: NodeJS.ProcessEnv | null = null
      let versionEnvironment: NodeJS.ProcessEnv | null = null
      const result = discover({
        environment: {
          PATH: fixture.directory,
          LANG: 'C',
          HOME: '/credential-bearing-home',
          SECRET_API_KEY: 'sk-secret-must-not-propagate',
        },
        platform: 'darwin-arm64',
        resolveExecutable: (_requestedCommand, environment) => {
          resolverEnvironment = environment
          return fixture.path
        },
        readVersion: (_resolvedPath, environment) => {
          versionEnvironment = environment
          return `${command} version ${version}`
        },
      })

      expect(result).toEqual({
        contract_version: 1,
        provider_id: provider,
        adapter_id: adapter,
        status: 'incompatible',
        source: 'path',
        version,
        platform: 'darwin-arm64',
        resolved_path: fixture.path,
        executable_fingerprint: fingerprint(fixture.bytes),
      })
      expect(versionEnvironment).toEqual({
        PATH: fixture.directory,
        LANG: 'C',
      })
      expect(resolverEnvironment).toEqual(versionEnvironment)
      expect(JSON.stringify(result)).not.toContain('sk-secret')
      expect(Object.isFrozen(result)).toBe(true)
    },
  )

  it('distinguishes missing, unknown-version, and untrusted override states', () => {
    const missing = discoverQwenProviderExecutableV1({
      environment: { PATH: '' },
      platform: 'darwin-arm64',
    })
    expect(missing.status).toBe('missing')
    expect(missing.resolved_path).toBeNull()

    const fixture = executableFixture('qwen')
    const unknown = discoverQwenProviderExecutableV1({
      environment: {
        PATH: fixture.directory,
        API_KEY: 'sk-secret-never-returned',
      },
      platform: 'darwin-arm64',
      readVersion: () =>
        'Authorization: Bearer sk-secret-never-returned; builds 1.2.3 and 2.3.4',
    })
    expect(unknown.status).toBe('unknown')
    expect(unknown.version).toBeNull()
    expect(JSON.stringify(unknown)).not.toContain('sk-secret-never-returned')

    const override = discoverQwenProviderExecutableV1({
      command: fixture.path,
      environment: { PATH: '' },
      platform: 'darwin-arm64',
      readVersion: () => 'qwen 0.10.2',
    })
    expect(override.status).toBe('untrusted')
    expect(override.source).toBe('environment_override')
    expect(override.resolved_path).toBe(fixture.path)

    const unreadable = discoverQwenProviderExecutableV1({
      environment: { PATH: fixture.directory },
      platform: 'darwin-arm64',
      readExecutable: () => {
        throw new Error('credential=sk-secret-never-returned')
      },
      readVersion: () => 'qwen 0.10.2',
    })
    expect(unreadable.status).toBe('untrusted')
    expect(JSON.stringify(unreadable)).not.toContain('sk-secret-never-returned')
    expect(unreadable.executable_fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('normalizes manifests and rejects malformed or cross-provider evidence', () => {
    const resolver = vi.fn(() => null)
    const malformed = {
      ...QWEN_PROVIDER_MANIFEST_V1,
      contract_version: 2,
    } as unknown as ProviderManifestV1
    expect(() => discoverTerminalProviderExecutableV1({
      manifest: malformed,
      resolveExecutable: resolver,
    })).toThrow('unsupported_contract_version')
    expect(resolver).not.toHaveBeenCalled()

    const qwenDiscovery = discoverQwenProviderExecutableV1({
      resolveExecutable: () => null,
    })
    expect(() => defineTerminalProviderCandidateEvidenceV1({
      manifest: malformed,
      discovery: qwenDiscovery,
      execution_scope: 'interactive',
    })).toThrow('unsupported_contract_version')
    expect(() => defineTerminalProviderCandidateEvidenceV1({
      manifest: KIMI_PROVIDER_MANIFEST_V1,
      discovery: qwenDiscovery,
      execution_scope: 'interactive',
    })).toThrow('terminal provider candidate discovery does not match manifest')
  })
})

describe('Qwen Code and Kimi Code candidate policy evidence', () => {
  it('keeps Qwen subscription mode interactive-only and every unverified managed capability explicit', () => {
    const evidence = inspectQwenProviderCandidateV1({
      execution_scope: 'managed_background',
      environment: {
        PATH: '',
        QWEN_API_KEY: 'sk-secret-must-not-appear',
      },
      resolveExecutable: () => null,
    })
    const capabilities = Object.fromEntries(
      evidence.capabilities.map((entry) => [entry.capability, entry]),
    )

    expect(evidence.selection).toEqual({
      provider_id: 'qwen',
      adapter_id: 'qwen-code-cli',
      mode_id: 'native_subscription',
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      credential_kind: 'subscription_scoped_key',
    })
    expect(evidence.auth_status).toBe('unknown')
    expect(evidence.automation_policy).toBe('interactive_only')
    expect(evidence.overage_status).toBe('not_applicable')
    expect(evidence.launch_ready).toBe(false)
    expect(evidence.blockers).toEqual(expect.arrayContaining([
      'authentication_unknown',
      'capability_unsupported',
      'environment_audit_incomplete',
      'interactive_only',
      'missing_executable',
      'unsupported_mode',
      'unsupported_provider',
    ]))
    expect(evidence.capabilities).toHaveLength(24)
    expect(capabilities.raw_terminal_coexistence).toEqual({
      capability: 'raw_terminal_coexistence',
      state: 'supported',
      reason_code: null,
    })
    for (const capability of [
      'launch',
      'model_discovery',
      'model_selection',
      'effort',
      'approvals',
      'access_profile',
      'structured_events',
      'usage',
      'cancel',
      'mcp',
      'plugins',
      'skills',
    ]) {
      expect(capabilities[capability]).toMatchObject({
        state: 'unknown',
        reason_code: 'managed_adapter_not_implemented',
      })
    }
    for (const capability of ['attach', 'resume', 'restart_recovery']) {
      expect(capabilities[capability]).toMatchObject({ state: 'unsupported' })
    }
    expect(JSON.stringify(evidence)).not.toContain('sk-secret-must-not-appear')

    const interactive = inspectQwenProviderCandidateV1({
      execution_scope: 'interactive',
      resolveExecutable: () => null,
    })
    expect(interactive.blockers).not.toContain('interactive_only')
    expect(interactive.launch_ready).toBe(false)
  })

  it('keeps Kimi OAuth readiness unknown and Extra Usage separately unresolved', () => {
    const evidence = inspectKimiProviderCandidateV1({
      environment: {
        PATH: '',
        KIMI_API_KEY: 'sk-secret-must-not-appear',
        KIMI_OAUTH_SESSION: 'oauth-does-not-prove-zero-overage',
      },
      resolveExecutable: () => null,
    })
    const capabilities = Object.fromEntries(
      evidence.capabilities.map((entry) => [entry.capability, entry]),
    )

    expect(evidence.selection).toEqual({
      provider_id: 'kimi',
      adapter_id: 'kimi-code-acp',
      mode_id: 'native_subscription',
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      credential_kind: 'provider_account_session',
    })
    expect(evidence.auth_status).toBe('unknown')
    expect(evidence.automation_policy).toBe('allowed')
    expect(evidence.overage_status).toBe('unknown')
    expect(evidence.overage_consent).toBe('missing')
    expect(evidence.metering_status).toBe('unknown')
    expect(evidence.cost_cap_status).toBe('unknown')
    expect(evidence.launch_ready).toBe(false)
    expect(evidence.blockers).toEqual(expect.arrayContaining([
      'authentication_unknown',
      'capability_unsupported',
      'cost_cap_unenforced',
      'environment_audit_incomplete',
      'metering_unavailable',
      'overage_unknown',
      'unsupported_mode',
      'unsupported_provider',
    ]))
    expect(capabilities.token_budget).toMatchObject({
      state: 'unsupported',
      reason_code: 'provider_does_not_expose_token_budget',
    })
    expect(capabilities.cost_budget).toMatchObject({
      state: 'unsupported',
      reason_code: 'provider_does_not_expose_cost_budget',
    })
    expect(capabilities.mcp).toMatchObject({
      state: 'unknown',
      reason_code: 'managed_adapter_not_implemented',
    })
    expect(JSON.stringify(evidence)).not.toContain('sk-secret-must-not-appear')
    expect(JSON.stringify(evidence)).not.toContain('oauth-does-not-prove')
  })

  it.each([
    {
      inspect: inspectQwenProviderCandidateV1,
      provider: 'qwen',
      adapter: 'qwen-code-cli',
    },
    {
      inspect: inspectKimiProviderCandidateV1,
      provider: 'kimi',
      adapter: 'kimi-code-acp',
    },
  ])(
    'requires explicit API-mode consent and never falls back for $provider',
    ({ inspect, provider, adapter }) => {
      expect(() => inspect({
        selection_request: { mode_id: 'native_api_key' },
        resolveExecutable: () => null,
      })).toThrow('usage_priced_api_consent_required')

      const evidence = inspect({
        selection_request: {
          mode_id: 'native_api_key',
          usage_priced_api_consent: true,
        },
        resolveExecutable: () => null,
      })
      expect(evidence.selection).toEqual({
        provider_id: provider,
        adapter_id: adapter,
        mode_id: 'native_api_key',
        runtime_mode: 'native_cli',
        billing_mode: 'usage_priced_api',
        credential_kind: 'usage_priced_api_key',
      })
      expect(evidence.auth_status).toBe('unknown')
      expect(evidence.blockers).toEqual(expect.arrayContaining([
        'cost_cap_unenforced',
        'durable_cost_authority_unavailable',
        'metering_unavailable',
        'unsupported_mode',
      ]))
      expect(evidence.launch_ready).toBe(false)
    },
  )
})

describe('Qwen Code and Kimi Code fail-closed bridge adapters', () => {
  it.each([
    {
      create: createQwenProviderAdapterV1,
      manifest: QWEN_PROVIDER_MANIFEST_V1,
      provider: 'qwen' as const,
    },
    {
      create: createKimiProviderAdapterV1,
      manifest: KIMI_PROVIDER_MANIFEST_V1,
      provider: 'kimi' as const,
    },
  ])(
    'blocks $provider before any raw driver launch, lifecycle, event, approval, or usage call',
    async ({ create, manifest, provider }) => {
      const driver = countingDriver(provider)
      const adapter = create({
        driver,
        environment: { PATH: '' },
        resolveExecutable: () => null,
      })
      const intent = nativeIntent(manifest)

      expect((await adapter.discoverExecutable()).status).toBe('missing')
      expect(() => adapter.prepareEnvironment(intent, {
        PATH: '',
        API_KEY: 'sk-secret-must-never-reach-driver',
      })).toThrow('environment_audit_incomplete')
      await expect(adapter.listModels(intent)).rejects.toThrow('capability_unsupported')
      await expect(adapter.launch({
        authorization: {} as never,
      })).rejects.toThrow()
      await expect(adapter.interrupt('missing-session')).rejects.toThrow(
        'provider_session_authorization_required',
      )
      await expect(adapter.cancel('missing-session')).rejects.toThrow(
        'provider_session_authorization_required',
      )
      expect(() => adapter.stop('missing-session')).toThrow(
        'provider_session_authorization_required',
      )
      await expect(adapter.submitApproval('missing-session', {
        approval_id: 'approval-1',
        decision: 'reject',
      })).rejects.toThrow('provider_session_authorization_required')
      expect(() => adapter.events('missing-session')).toThrow(
        'provider_session_authorization_required',
      )
      await expect(adapter.usage('missing-session')).rejects.toThrow(
        'provider_session_authorization_required',
      )

      expect(driver.calls).toEqual({
        attach: 0,
        events: 0,
        interrupt: 0,
        launch: 0,
        send: 0,
        stop: 0,
      })
    },
  )
})

import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { CodexProviderService } from '../src/codex/provider-service.js'
import type { CodexSupervisorLifecycleEvent, CodexSupervisorState } from '../src/codex/supervisor.js'

class FakeSupervisor {
  state: CodexSupervisorState = 'idle'
  starts = 0
  private readonly listeners = new Set<(event: CodexSupervisorLifecycleEvent) => void>()

  constructor(private readonly failure?: Error) {}

  async start(): Promise<void> {
    this.starts += 1
    if (this.failure) {
      this.state = 'failed'
      throw this.failure
    }
    this.state = 'running'
    const event: CodexSupervisorLifecycleEvent = {
      type: 'connected', state: 'running', at: new Date().toISOString(), generation: 1, attempt: 0,
    }
    for (const listener of this.listeners) listener(event)
  }

  onLifecycle(listener: (event: CodexSupervisorLifecycleEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

describe('Codex provider service', () => {
  it('enables an account-backed runtime and exposes live models, health, auth, and quota data', async () => {
    const db = openDb(':memory:')
    const supervisor = new FakeSupervisor()
    let account: { type: 'chatgpt'; email: string; planType: string } | null = {
      type: 'chatgpt', email: 'dev@example.com', planType: 'pro',
    }
    const rpc = {
      listModels: async () => [{
        id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4', description: 'Coding model',
        hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
        defaultReasoningEffort: 'high', inputModalities: ['text'], supportsPersonality: false,
        serviceTiers: [], defaultServiceTier: null, isDefault: true,
      }],
      // requiresOpenaiAuth describes the provider requirement; account presence proves current auth.
      readAccount: async () => ({ account, requiresOpenaiAuth: true }),
      readRateLimits: async () => ({ rateLimits: { primary: { usedPercent: 12 }, spendControlReached: true }, rateLimitsByLimitId: null, rateLimitResetCredits: null }) as any,
      readUsage: async () => ({ summary: { lifetimeTokens: 42 }, dailyUsageBuckets: null }) as any,
    }
    const service = new CodexProviderService(db, rpc, supervisor, { version: 'codex-cli 0.146.0', refreshMs: 60_000 })

    expect(await service.initialize()).toBe(true)
    expect(service.isRuntimeAvailable()).toBe(true)
    const catalog = await service.catalog()
    expect(catalog).toMatchObject({
      id: 'codex', available: true, source: 'live',
      health: { status: 'ready', version: 'codex-cli 0.146.0' },
      auth: { status: 'authenticated', account: 'ChatGPT · pro' },
      usage: { rate_limits: { current: { primary: { usedPercent: 12 }, spend_control_reached: true } } },
    })
    expect(catalog.models[0]).toMatchObject({ value: 'gpt-5.4', supportedEffortLevels: ['high'] })
    expect(JSON.parse((db.prepare("SELECT value FROM kv WHERE key='provider_models_codex_v1'").get() as any).value)[0])
      .toMatchObject({ value: 'gpt-5.4' })
    account = null
    expect(await service.authState()).toMatchObject({ status: 'unauthenticated' })
    expect(service.isRuntimeAvailable()).toBe(false)
    service.dispose()
  })

  it('stays explicitly unavailable when unauthenticated or the CLI cannot start', async () => {
    const db = openDb(':memory:')
    const unauthenticated = new CodexProviderService(db, {
      listModels: async () => [],
      readAccount: async () => ({ account: null, requiresOpenaiAuth: true }),
      readRateLimits: async () => ({}) as any,
      readUsage: async () => ({}) as any,
    }, new FakeSupervisor(), { version: 'codex-cli 0.146.0' })
    expect(await unauthenticated.initialize()).toBe(false)
    expect(await unauthenticated.catalog()).toMatchObject({
      available: false,
      auth: { status: 'unauthenticated' },
      health: { status: 'unavailable' },
    })
    unauthenticated.dispose()

    const missing = new CodexProviderService(db, {
      listModels: async () => [], readAccount: async () => ({ account: null, requiresOpenaiAuth: true }),
      readRateLimits: async () => ({}) as any, readUsage: async () => ({}) as any,
    }, new FakeSupervisor(new Error('spawn codex ENOENT')), { version: 'codex-cli 0.146.0' })
    expect(await missing.initialize()).toBe(false)
    expect(await missing.health()).toMatchObject({ available: false, detail: 'spawn codex ENOENT' })
    missing.dispose()
  })

  // Codex's app-server protocol is upstream "experimental" — a version other than
  // the pin might speak a different wire protocol. Orchestra used to hard-block
  // startup on any mismatch; it now trusts whatever is installed and just flags it,
  // so a real (if unverified) codex update never leaves the operator stuck.
  it.each([
    ['too old', 'codex-cli 0.143.0'],
    ['too new', 'codex-cli 0.147.0'],
    ['unparseable', 'not found'],
  ])('starts the app-server and reports degraded/unverified, not blocked, when the CLI is %s', async (_case, version) => {
    const db = openDb(':memory:')
    const supervisor = new FakeSupervisor()
    const service = new CodexProviderService(db, {
      listModels: async () => [],
      readAccount: async () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }),
      readRateLimits: async () => ({}) as any,
      readUsage: async () => ({}) as any,
    }, supervisor, { version })

    expect(await service.initialize()).toBe(true)
    expect(supervisor.starts).toBe(1)
    expect(service.isRuntimeAvailable()).toBe(true)
    expect(await service.health()).toMatchObject({
      available: true,
      status: 'degraded',
      detail: expect.stringContaining('unverified'),
    })
    service.dispose()
  })
})

// Regression: initialize() only classifies the CLI version once, at daemon boot.
// If codex updates itself while the daemon keeps running, health stayed stale
// "ready" until the next restart — the operator found out from a confusing
// runtime failure instead of a clear signal. recheckVersion() re-probes on a
// timer so drift is caught within one tick.
describe('CodexProviderService.recheckVersion', () => {
  const authenticatedRpc = () => ({
    listModels: async () => [],
    readAccount: async () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }),
    readRateLimits: async () => ({}) as any,
    readUsage: async () => ({}) as any,
  })

  it('flips health from ready to unavailable when the CLI drifts off the pin', async () => {
    const db = openDb(':memory:')
    let probed = 'codex-cli 0.146.0'
    const service = new CodexProviderService(db, authenticatedRpc(), new FakeSupervisor(), {
      version: 'codex-cli 0.146.0',
      versionProbe: () => probed,
    })
    expect(await service.initialize()).toBe(true)
    expect(service.isRuntimeAvailable()).toBe(true)

    probed = 'codex-cli 0.150.0'
    expect(service.recheckVersion()).toBe(true)

    expect(service.isRuntimeAvailable()).toBe(false)
    expect(await service.health()).toMatchObject({
      status: 'unavailable',
      detail: expect.stringContaining('0.150.0'),
    })
    service.dispose()
  })

  it('does nothing when the CLI still matches the pin', async () => {
    const db = openDb(':memory:')
    const service = new CodexProviderService(db, authenticatedRpc(), new FakeSupervisor(), {
      version: 'codex-cli 0.146.0',
      versionProbe: () => 'codex-cli 0.146.0',
    })
    expect(await service.initialize()).toBe(true)

    expect(service.recheckVersion()).toBe(false)

    expect(service.isRuntimeAvailable()).toBe(true)
    service.dispose()
  })

  it('reports no change on a repeat check once already flagged unavailable', async () => {
    const db = openDb(':memory:')
    let probed = 'codex-cli 0.146.0'
    const service = new CodexProviderService(db, authenticatedRpc(), new FakeSupervisor(), {
      version: 'codex-cli 0.146.0',
      versionProbe: () => probed,
    })
    expect(await service.initialize()).toBe(true)
    probed = 'codex-cli 0.150.0'
    expect(service.recheckVersion()).toBe(true)

    expect(service.recheckVersion()).toBe(false)
    service.dispose()
  })
})

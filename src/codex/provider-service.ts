import { execFileSync } from 'node:child_process'
import type Database from 'better-sqlite3'
import {
  CODEX_PROVIDER_ID,
  codexProviderCatalog,
  readProviderModelCache,
  writeProviderModelCache,
  type AgentProviderAuthState,
  type AgentProviderCatalog,
  type AgentProviderHealth,
  type AgentProviderService,
  type AgentProviderUsageSnapshot,
} from '../agent-providers.js'
import { CODEX_CAPABILITIES } from '../provider-agent-manager.js'
import { classifyCodexCliVersion } from '../environment-compatibility.js'
import type { CodexRuntimeService } from './service.js'
import type { CodexSupervisorLifecycleEvent, CodexSupervisorState } from './supervisor.js'
import type { CodexUnsubscribe } from './transport.js'

type CodexProviderRpc = Pick<
  CodexRuntimeService,
  'listModels' | 'readAccount' | 'readRateLimits' | 'readUsage'
>

type CodexProviderSupervisor = {
  readonly state: CodexSupervisorState
  start(): Promise<unknown>
  onLifecycle(listener: (event: CodexSupervisorLifecycleEvent) => void): CodexUnsubscribe
}

export type CodexProviderServiceOptions = {
  command?: string
  version?: string
  refreshMs?: number
  now?: () => Date
  /** Overrides how recheckVersion() re-probes the installed CLI. Defaults to
   * re-running `readCodexCliVersion(command)`; tests inject a controllable probe
   * instead of shelling out to a real `codex` binary. */
  versionProbe?: () => string | undefined
}

const detailForAccount = (account: Record<string, unknown>): string => {
  if (account.type === 'chatgpt') {
    const plan = typeof account.planType === 'string' && account.planType.trim() ? account.planType.trim() : null
    return plan ? `ChatGPT · ${plan}` : 'ChatGPT account'
  }
  if (account.type === 'apiKey') return 'OpenAI API key'
  if (account.type === 'amazonBedrock') return 'Amazon Bedrock credentials'
  return typeof account.type === 'string' && account.type ? account.type : 'Codex account'
}

const safeRateLimit = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  return {
    limit_id: row.limitId ?? null,
    limit_name: row.limitName ?? null,
    primary: row.primary ?? null,
    secondary: row.secondary ?? null,
    plan_type: row.planType ?? null,
    spend_control_reached: typeof row.spendControlReached === 'boolean'
      ? row.spendControlReached
      : null,
    reached: row.rateLimitReachedType ?? null,
  }
}

const safeRateLimits = (value: Record<string, unknown>): Record<string, unknown> => {
  const rawByLimit = value.rateLimitsByLimitId
  const byLimit = rawByLimit && typeof rawByLimit === 'object' && !Array.isArray(rawByLimit)
    ? Object.fromEntries(Object.entries(rawByLimit as Record<string, unknown>)
      .map(([id, limit]) => [id, safeRateLimit(limit)]))
    : null
  const reset = value.rateLimitResetCredits
  const available = reset && typeof reset === 'object' && !Array.isArray(reset)
    ? Number((reset as Record<string, unknown>).availableCount)
    : 0
  return {
    current: safeRateLimit(value.rateLimits),
    by_limit: byLimit,
    reset_credits_available: Number.isFinite(available) ? Math.max(0, available) : 0,
  }
}

const safeUsage = (value: Record<string, unknown>): Record<string, unknown> => ({
  summary: value.summary ?? {},
  daily_usage_buckets: Array.isArray(value.dailyUsageBuckets) ? value.dailyUsageBuckets.slice(-30) : null,
})

export function readCodexCliVersion(command = 'codex'): string | undefined {
  try {
    const output = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }).trim()
    return output || undefined
  } catch {
    return undefined
  }
}

/** Provider-facing health, auth, catalog, and quota view over the daemon-owned app-server. */
export class CodexProviderService implements AgentProviderService {
  readonly id = CODEX_PROVIDER_ID
  readonly name = 'Codex'
  readonly capabilities = CODEX_CAPABILITIES

  private readonly now: () => Date
  private readonly refreshMs: number
  private readonly versionProbe: () => string | undefined
  private version: string | undefined
  private runtimeEnabled = false
  private versionUnverified = false
  // Kept separate from lastDetail: the onLifecycle listener below clears lastDetail
  // on every 'connected' event (including the one supervisor.start() fires inside
  // initialize()), which would wipe this out before initialize() even returns.
  private versionUnverifiedDetail: string | undefined
  private lastAuth: AgentProviderAuthState | undefined
  private lastUsage: AgentProviderUsageSnapshot | undefined
  private lastCatalog: AgentProviderCatalog | undefined
  private lastCatalogAt = 0
  private lastDetail: string | undefined
  private readonly unsubscribeLifecycle: CodexUnsubscribe

  constructor(
    private readonly db: Database.Database,
    private readonly rpc: CodexProviderRpc,
    private readonly supervisor: CodexProviderSupervisor,
    options: CodexProviderServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.refreshMs = Math.max(1_000, options.refreshMs ?? 30_000)
    this.versionProbe = options.versionProbe ?? (() => readCodexCliVersion(options.command))
    this.version = options.version ?? this.versionProbe()
    this.unsubscribeLifecycle = supervisor.onLifecycle((event) => {
      if (event.error) this.lastDetail = event.error
      if (event.type === 'connected') this.lastDetail = undefined
      this.lastCatalogAt = 0
    })
  }

  /**
   * Codex's app-server protocol is upstream "experimental" — a version other than
   * the pin might speak a different wire protocol. Orchestra does not know that in
   * advance, so it trusts whatever is installed rather than refusing to run it; it
   * only flags the version as unverified so a real protocol break points straight
   * at the likely cause instead of reading as a mystery bug.
   */
  private unverifiedDetail(compatibilityDetail: string): string {
    return `${compatibilityDetail} Running on an unverified Codex CLI version — `
      + 'reinstall @openai/codex@0.146.0 to clear this warning.'
  }

  /** Start once at daemon boot. Authentication gained later is reported but enabled after restart. */
  async initialize(): Promise<boolean> {
    const compatibility = classifyCodexCliVersion(this.version)
    this.versionUnverified = compatibility.status !== 'validated'
    this.versionUnverifiedDetail = this.versionUnverified
      ? this.unverifiedDetail(compatibility.detail)
      : undefined
    try {
      await this.supervisor.start()
    } catch (error) {
      this.lastDetail = error instanceof Error ? error.message : String(error)
      this.runtimeEnabled = false
      return false
    }
    const auth = await this.refreshAuth()
    this.runtimeEnabled = auth.status === 'authenticated'
    if (!this.runtimeEnabled) {
      this.lastDetail = auth.detail ?? 'Run `codex login`, then restart Orchestra.'
      return false
    }
    await this.refreshCatalog().catch(() => undefined)
    return true
  }

  isRuntimeAvailable(): boolean {
    return this.runtimeEnabled && this.supervisor.state === 'running'
  }

  /**
   * Re-probe the installed Codex CLI version. Called periodically while the daemon
   * runs, not just at boot, so a codex self-update mid-session is caught within one
   * tick instead of only on restart. Never blocks the runtime — only updates the
   * unverified flag health() reports. Edge-triggered: returns true only on the
   * transition INTO drift, so callers (e.g. a notification) fire once, not every
   * tick and not again on the (unrequested) transition back to verified.
   */
  recheckVersion(): boolean {
    if (!this.runtimeEnabled) return false
    const probed = this.versionProbe()
    const compatibility = classifyCodexCliVersion(probed)
    const wasUnverified = this.versionUnverified
    this.version = probed
    this.versionUnverified = compatibility.status !== 'validated'
    this.versionUnverifiedDetail = this.versionUnverified
      ? this.unverifiedDetail(compatibility.detail)
      : undefined
    return this.versionUnverified && !wasUnverified
  }

  async health(): Promise<AgentProviderHealth> {
    const available = this.isRuntimeAvailable()
    const state = this.supervisor.state
    const status: AgentProviderHealth['status'] = !available
      ? (state === 'starting' || state === 'restarting' ? 'degraded' : 'unavailable')
      : (this.versionUnverified ? 'degraded' : 'ready')
    const detail = !available ? this.lastDetail : (this.versionUnverified ? this.versionUnverifiedDetail : undefined)
    return {
      available,
      status,
      updated_at: this.now().toISOString(),
      ...(this.version ? { version: this.version } : {}),
      ...(detail ? { detail } : {}),
    }
  }

  async authState(): Promise<AgentProviderAuthState> {
    if (this.supervisor.state !== 'running') {
      return this.lastAuth ?? {
        status: 'unknown',
        updated_at: this.now().toISOString(),
        detail: this.lastDetail ?? 'Codex app-server is not connected.',
      }
    }
    return this.refreshAuth()
  }

  async usageSnapshot(): Promise<AgentProviderUsageSnapshot> {
    if (!this.isRuntimeAvailable()) {
      return this.lastUsage
        ? { ...this.lastUsage, stale: true, detail: this.lastDetail ?? 'Codex runtime is unavailable.' }
        : { updated_at: this.now().toISOString(), stale: true, detail: this.lastDetail ?? 'Codex runtime is unavailable.' }
    }
    try {
      const [rateLimits, usage] = await Promise.all([this.rpc.readRateLimits(), this.rpc.readUsage()])
      this.lastUsage = {
        updated_at: this.now().toISOString(),
        rate_limits: safeRateLimits(rateLimits as unknown as Record<string, unknown>),
        usage: safeUsage(usage as unknown as Record<string, unknown>),
      }
      return this.lastUsage
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.lastDetail = detail
      return this.lastUsage
        ? { ...this.lastUsage, stale: true, detail }
        : { updated_at: this.now().toISOString(), stale: true, detail }
    }
  }

  async catalog(): Promise<AgentProviderCatalog> {
    if (this.lastCatalog && Date.now() - this.lastCatalogAt < this.refreshMs) {
      return {
        ...this.lastCatalog,
        available: this.isRuntimeAvailable(),
        health: await this.health(),
      }
    }
    return this.refreshCatalog()
  }

  dispose(): void {
    this.unsubscribeLifecycle()
  }

  private async refreshAuth(): Promise<AgentProviderAuthState> {
    try {
      const response = await this.rpc.readAccount(false)
      const updated_at = this.now().toISOString()
      if (response.account) {
        const account = response.account as Record<string, unknown>
        this.lastAuth = {
          status: 'authenticated',
          updated_at,
          account: detailForAccount(account),
        }
      } else {
        this.runtimeEnabled = false
        this.lastAuth = {
          status: 'unauthenticated',
          updated_at,
          detail: 'Run `codex login`, then restart Orchestra.',
        }
      }
      return this.lastAuth
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.lastDetail = detail
      this.lastAuth = { status: 'unknown', updated_at: this.now().toISOString(), detail }
      return this.lastAuth
    }
  }

  private async refreshCatalog(): Promise<AgentProviderCatalog> {
    const cached = readProviderModelCache(this.db, CODEX_PROVIDER_ID)
    const health = await this.health()
    const auth = await this.authState()
    let models = cached?.models ?? []
    let source: AgentProviderCatalog['source'] = cached ? 'cache' : 'unavailable'
    let updatedAt = cached?.updated_at ?? null
    let detail = this.lastDetail

    if (this.isRuntimeAvailable()) {
      try {
        const live = writeProviderModelCache(this.db, await this.rpc.listModels(), CODEX_PROVIDER_ID)
        if (live) {
          models = live.models
          source = 'live'
          updatedAt = live.updated_at
          detail = undefined
        } else if (!models.length) {
          detail = 'Codex returned no discoverable models.'
        }
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error)
        this.lastDetail = detail
      }
    } else if (auth.status === 'authenticated' && !this.runtimeEnabled) {
      detail = 'Codex authenticated after daemon startup; restart Orchestra to enable launches.'
    } else {
      detail = auth.detail ?? detail ?? 'Install and authenticate the Codex CLI to enable this provider.'
    }

    const usage = await this.usageSnapshot()
    this.lastCatalog = codexProviderCatalog({
      available: this.isRuntimeAvailable(),
      models,
      source,
      updatedAt,
      capabilities: CODEX_CAPABILITIES,
      health,
      auth,
      usage,
      ...(detail ? { detail } : {}),
    })
    this.lastCatalogAt = Date.now()
    return this.lastCatalog
  }
}

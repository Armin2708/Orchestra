import { deferred, type Deferred } from './async.js'
import {
  CODEX_REQUEST_UNHANDLED,
  CodexAppServerClient,
  CodexConnectionClosedError,
  type CodexAppServerClientOptions,
  type CodexAppServerPort,
  type CodexClientClose,
  type CodexRequestOptions,
  type CodexServerRequestHandler,
} from './client.js'
import {
  type CodexClientInfo,
  type CodexDiagnostic,
  type CodexInitializeParams,
  type CodexMethodParams,
  type CodexMethodResult,
  type CodexServerNotification,
  type CodexServerRequest,
} from './protocol.js'
import {
  CodexProcessTransport,
  type CodexByteTransport,
  type CodexProcessTransportOptions,
  type CodexUnsubscribe,
} from './transport.js'

export type CodexSupervisorState = 'idle' | 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'failed'

export type CodexSupervisorLifecycleEvent = {
  type: 'starting' | 'connected' | 'disconnected' | 'restart_scheduled' | 'restart_exhausted' | 'stopped'
  state: CodexSupervisorState
  at: string
  generation: number
  attempt: number
  delayMs?: number
  error?: string
}

export type CodexRestartPolicy = {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  factor?: number
  jitter?: number
  stableResetMs?: number
}

export type CodexAppServerSupervisorOptions = {
  clientInfo?: CodexClientInfo
  initializeCapabilities?: CodexInitializeParams['capabilities']
  client?: CodexAppServerClientOptions
  process?: CodexProcessTransportOptions
  transportFactory?: () => CodexByteTransport | Promise<CodexByteTransport>
  clientFactory?: (transport: CodexByteTransport, options: CodexAppServerClientOptions) => CodexAppServerClient
  restart?: CodexRestartPolicy
  random?: () => number
  now?: () => Date
}

export class CodexAppServerSupervisor implements CodexAppServerPort {
  private readonly notificationListeners = new Set<(notification: CodexServerNotification) => void>()
  private readonly serverRequestHandlers = new Set<CodexServerRequestHandler>()
  private readonly diagnosticListeners = new Set<(diagnostic: CodexDiagnostic) => void>()
  private readonly lifecycleListeners = new Set<(event: CodexSupervisorLifecycleEvent) => void>()
  private readonly clientInfo: CodexClientInfo
  private readonly initializeCapabilities: CodexInitializeParams['capabilities']
  private readonly clientOptions: CodexAppServerClientOptions
  private readonly transportFactory: () => CodexByteTransport | Promise<CodexByteTransport>
  private readonly clientFactory: NonNullable<CodexAppServerSupervisorOptions['clientFactory']>
  private readonly restart: Required<CodexRestartPolicy>
  private readonly random: () => number
  private readonly now: () => Date
  private currentClient: CodexAppServerClient | null = null
  private clientSubscriptions: CodexUnsubscribe[] = []
  private currentState: CodexSupervisorState = 'idle'
  private readiness: Deferred<CodexAppServerClient> = this.newReadiness()
  private connectPromise: Promise<CodexAppServerClient> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempt = 0
  private generation = 0

  constructor(options: CodexAppServerSupervisorOptions = {}) {
    this.clientInfo = options.clientInfo ?? {
      name: 'orchestra',
      title: 'Orchestra',
      version: '0.1.0',
    }
    this.initializeCapabilities = options.initializeCapabilities ?? null
    this.clientOptions = options.client ?? {}
    this.transportFactory = options.transportFactory ?? (() => CodexProcessTransport.spawn(options.process))
    this.clientFactory = options.clientFactory ?? ((transport, clientOptions) => new CodexAppServerClient(transport, clientOptions))
    this.restart = {
      maxAttempts: Math.max(0, options.restart?.maxAttempts ?? 5),
      initialDelayMs: Math.max(0, options.restart?.initialDelayMs ?? 250),
      maxDelayMs: Math.max(0, options.restart?.maxDelayMs ?? 10_000),
      factor: Math.max(1, options.restart?.factor ?? 2),
      jitter: Math.min(1, Math.max(0, options.restart?.jitter ?? 0.2)),
      stableResetMs: Math.max(0, options.restart?.stableResetMs ?? 30_000),
    }
    this.random = options.random ?? Math.random
    this.now = options.now ?? (() => new Date())
  }

  get state(): CodexSupervisorState {
    return this.currentState
  }

  get client(): CodexAppServerClient | null {
    return this.currentClient
  }

  async start(): Promise<CodexAppServerClient> {
    if (this.currentClient) return this.currentClient
    if (this.connectPromise) return this.connectPromise
    if (this.currentState === 'stopping') throw new Error('Codex app-server supervisor is stopping')
    if (this.currentState === 'stopped' || this.currentState === 'failed') {
      this.restartAttempt = 0
      this.readiness = this.newReadiness()
    }
    this.clearRestartTimer()
    this.currentState = 'starting'
    this.emitLifecycle('starting')
    this.connectPromise = this.connect(false)
    try {
      return await this.connectPromise
    } catch (error) {
      if (!this.isStoppingOrStopped()) {
        this.currentState = 'failed'
        this.readiness.reject(error)
      }
      throw error
    } finally {
      this.connectPromise = null
    }
  }

  async request<M extends string>(
    method: M,
    params: CodexMethodParams<M>,
    options?: CodexRequestOptions,
  ): Promise<CodexMethodResult<M>> {
    const client = await this.availableClient()
    return client.request(method, params, options)
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const client = await this.availableClient()
    await client.notify(method, params)
  }

  onNotification(listener: (notification: CodexServerNotification) => void): CodexUnsubscribe {
    return this.add(this.notificationListeners, listener)
  }

  onServerRequest(handler: CodexServerRequestHandler): CodexUnsubscribe {
    return this.add(this.serverRequestHandlers, handler)
  }

  onDiagnostic(listener: (diagnostic: CodexDiagnostic) => void): CodexUnsubscribe {
    return this.add(this.diagnosticListeners, listener)
  }

  onLifecycle(listener: (event: CodexSupervisorLifecycleEvent) => void): CodexUnsubscribe {
    return this.add(this.lifecycleListeners, listener)
  }

  async stop(): Promise<void> {
    if (this.currentState === 'stopped') return
    this.currentState = 'stopping'
    this.generation += 1
    this.clearRestartTimer()
    this.clearStableTimer()
    const client = this.currentClient
    this.currentClient = null
    this.clearClientSubscriptions()
    if (!this.readiness.settled) this.readiness.reject(new CodexConnectionClosedError('Codex supervisor stopped'))
    if (client) await client.close()
    this.currentState = 'stopped'
    this.emitLifecycle('stopped')
  }

  private async availableClient(): Promise<CodexAppServerClient> {
    if (this.currentClient) return this.currentClient
    if (this.currentState === 'idle' || this.currentState === 'stopped' || this.currentState === 'failed') {
      return this.start()
    }
    if (this.currentState === 'stopping') throw new CodexConnectionClosedError('Codex supervisor is stopping')
    return this.readiness.promise
  }

  private async connect(isRestart: boolean): Promise<CodexAppServerClient> {
    const generation = ++this.generation
    const transport = await this.transportFactory()
    const client = this.clientFactory(transport, this.clientOptions)
    const provisionalSubscriptions: CodexUnsubscribe[] = [
      client.onNotification((notification) => this.emit(this.notificationListeners, notification)),
      client.onDiagnostic((diagnostic) => this.emit(this.diagnosticListeners, diagnostic)),
      client.onServerRequest((request) => this.dispatchServerRequest(request)),
    ]
    try {
      await client.initialize(this.clientInfo, this.initializeCapabilities)
      if (generation !== this.generation || this.currentState === 'stopping' || this.currentState === 'stopped') {
        for (const unsubscribe of provisionalSubscriptions) unsubscribe()
        await client.close()
        throw new CodexConnectionClosedError('Codex connection became stale during initialization')
      }
      this.clearClientSubscriptions()
      this.clientSubscriptions = provisionalSubscriptions
      this.clientSubscriptions.push(client.onClose((close) => this.handleClientClose(client, generation, close)))
      this.currentClient = client
      this.currentState = 'running'
      this.readiness.resolve(client)
      this.emitLifecycle('connected', {
        attempt: this.restartAttempt,
        ...(isRestart ? { error: undefined } : {}),
      })
      this.scheduleStableReset(generation)
      return client
    } catch (error) {
      for (const unsubscribe of provisionalSubscriptions) unsubscribe()
      await client.close().catch(() => {})
      throw error
    }
  }

  private handleClientClose(client: CodexAppServerClient, generation: number, close: CodexClientClose): void {
    if (client !== this.currentClient || generation !== this.generation) return
    this.currentClient = null
    this.clearClientSubscriptions()
    this.clearStableTimer()
    const error = close.error ?? new CodexConnectionClosedError('Codex app-server disconnected')
    this.emitLifecycle('disconnected', { error: error.message })
    if (this.currentState === 'stopping' || this.currentState === 'stopped') return
    this.readiness = this.newReadiness()
    this.scheduleRestart(error)
  }

  private scheduleRestart(error: Error): void {
    if (this.currentState === 'stopping' || this.currentState === 'stopped') return
    this.restartAttempt += 1
    if (this.restartAttempt > this.restart.maxAttempts) {
      this.currentState = 'failed'
      this.readiness.reject(error)
      this.emitLifecycle('restart_exhausted', { error: error.message })
      return
    }
    this.currentState = 'restarting'
    const exponential = Math.min(
      this.restart.maxDelayMs,
      this.restart.initialDelayMs * this.restart.factor ** Math.max(0, this.restartAttempt - 1),
    )
    const jitterMultiplier = 1 + ((this.random() * 2) - 1) * this.restart.jitter
    const delayMs = Math.max(0, Math.round(exponential * jitterMultiplier))
    this.emitLifecycle('restart_scheduled', { attempt: this.restartAttempt, delayMs, error: error.message })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.currentState !== 'restarting') return
      this.connectPromise = this.connect(true)
      void this.connectPromise.then(() => {
        this.connectPromise = null
      }, (failure) => {
        this.connectPromise = null
        this.scheduleRestart(failure instanceof Error ? failure : new Error(String(failure)))
      })
    }, delayMs)
    this.restartTimer.unref?.()
  }

  private scheduleStableReset(generation: number): void {
    this.clearStableTimer()
    if (this.restart.stableResetMs === 0) {
      this.restartAttempt = 0
      return
    }
    this.stableTimer = setTimeout(() => {
      if (generation === this.generation && this.currentClient) this.restartAttempt = 0
    }, this.restart.stableResetMs)
    this.stableTimer.unref?.()
  }

  private async dispatchServerRequest(request: CodexServerRequest): Promise<unknown> {
    for (const handler of [...this.serverRequestHandlers]) {
      const result = await handler(request)
      if (result !== CODEX_REQUEST_UNHANDLED) return result
    }
    return CODEX_REQUEST_UNHANDLED
  }

  private emitLifecycle(
    type: CodexSupervisorLifecycleEvent['type'],
    overrides: Partial<Pick<CodexSupervisorLifecycleEvent, 'attempt' | 'delayMs' | 'error'>> = {},
  ): void {
    this.emit(this.lifecycleListeners, {
      type,
      state: this.currentState,
      at: this.now().toISOString(),
      generation: this.generation,
      attempt: overrides.attempt ?? this.restartAttempt,
      ...(overrides.delayMs !== undefined ? { delayMs: overrides.delayMs } : {}),
      ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    })
  }

  private newReadiness(): Deferred<CodexAppServerClient> {
    const result = deferred<CodexAppServerClient>()
    void result.promise.catch(() => {})
    return result
  }

  private clearClientSubscriptions(): void {
    for (const unsubscribe of this.clientSubscriptions.splice(0)) unsubscribe()
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private clearStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
  }

  private isStoppingOrStopped(): boolean {
    return this.currentState === 'stopping' || this.currentState === 'stopped'
  }

  private add<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void): CodexUnsubscribe {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  private emit<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of [...listeners]) {
      try { listener(value) } catch {}
    }
  }
}

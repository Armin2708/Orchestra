import { Buffer } from 'node:buffer'
import { deferred, type Deferred } from './async.js'
import {
  type CodexClientInfo,
  type CodexDiagnostic,
  type CodexInitializeParams,
  type CodexInitializeResponse,
  type CodexMethodParams,
  type CodexMethodResult,
  type CodexRpcError,
  type CodexRpcId,
  type CodexServerNotification,
  type CodexServerRequest,
  isRecord,
} from './protocol.js'
import {
  CodexJsonlDecoder,
  type CodexByteTransport,
  type CodexTransportClose,
  type CodexUnsubscribe,
} from './transport.js'

export type CodexRequestOptions = {
  timeoutMs?: number
}

export type CodexClientState = 'new' | 'initializing' | 'ready' | 'closing' | 'closed' | 'failed'

export class CodexRpcResponseError extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: CodexRpcError,
  ) {
    super(`Codex app-server ${method} failed (${rpcError.code}): ${rpcError.message}`)
    this.name = 'CodexRpcResponseError'
  }
}

export class CodexRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`Codex app-server ${method} timed out after ${timeoutMs}ms`)
    this.name = 'CodexRequestTimeoutError'
  }
}

export class CodexConnectionClosedError extends Error {
  constructor(message = 'Codex app-server connection closed') {
    super(message)
    this.name = 'CodexConnectionClosedError'
  }
}

export class CodexPayloadTooLargeError extends Error {
  constructor(readonly size: number, readonly limit: number) {
    super(`Codex app-server payload is ${size} bytes; limit is ${limit}`)
    this.name = 'CodexPayloadTooLargeError'
  }
}

export const CODEX_REQUEST_UNHANDLED = Symbol('CODEX_REQUEST_UNHANDLED')
export type CodexServerRequestHandlerResult = unknown | typeof CODEX_REQUEST_UNHANDLED
export type CodexServerRequestHandler = (
  request: CodexServerRequest,
) => CodexServerRequestHandlerResult | Promise<CodexServerRequestHandlerResult>

export type CodexClientClose = {
  transport: CodexTransportClose | null
  error: Error | null
}

export interface CodexAppServerPort {
  request<M extends string>(
    method: M,
    params: CodexMethodParams<M>,
    options?: CodexRequestOptions,
  ): Promise<CodexMethodResult<M>>
  notify(method: string, params?: unknown): Promise<void>
  onNotification(listener: (notification: CodexServerNotification) => void): CodexUnsubscribe
  onServerRequest(handler: CodexServerRequestHandler): CodexUnsubscribe
  onDiagnostic(listener: (diagnostic: CodexDiagnostic) => void): CodexUnsubscribe
}

type PendingRequest = {
  method: string
  deferred: Deferred<unknown>
  timer: ReturnType<typeof setTimeout>
}

export type CodexAppServerClientOptions = {
  requestTimeoutMs?: number
  maxPendingRequests?: number
  maxFrameBytes?: number
  maxPayloadBytes?: number
  now?: () => Date
}

export class CodexAppServerClient implements CodexAppServerPort {
  private readonly decoder: CodexJsonlDecoder
  private readonly requestTimeoutMs: number
  private readonly maxPendingRequests: number
  private readonly maxPayloadBytes: number
  private readonly now: () => Date
  private readonly pending = new Map<string, PendingRequest>()
  private readonly notificationListeners = new Set<(notification: CodexServerNotification) => void>()
  private readonly serverRequestHandlers = new Set<CodexServerRequestHandler>()
  private readonly diagnosticListeners = new Set<(diagnostic: CodexDiagnostic) => void>()
  private readonly closeListeners = new Set<(close: CodexClientClose) => void>()
  private readonly subscriptions: CodexUnsubscribe[] = []
  private nextId = 1
  private currentState: CodexClientState = 'new'
  private initializePromise: Promise<CodexInitializeResponse> | null = null
  private closeInfo: CodexClientClose | null = null

  constructor(
    private readonly transport: CodexByteTransport,
    options: CodexAppServerClientOptions = {},
  ) {
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 30_000)
    this.maxPendingRequests = Math.max(1, options.maxPendingRequests ?? 256)
    this.maxPayloadBytes = Math.max(1_024, options.maxPayloadBytes ?? 8 * 1024 * 1024)
    this.decoder = new CodexJsonlDecoder(options.maxFrameBytes ?? 8 * 1024 * 1024)
    this.now = options.now ?? (() => new Date())
    this.subscriptions.push(
      transport.onData((chunk) => this.acceptData(chunk)),
      transport.onStderr((line) => this.emitDiagnostic('stderr', 'info', line)),
      transport.onError((error) => this.emitDiagnostic('transport', 'error', error.message)),
      transport.onClose((close) => this.acceptClose(close)),
    )
  }

  get state(): CodexClientState {
    return this.currentState
  }

  get initialized(): boolean {
    return this.currentState === 'ready'
  }

  async initialize(
    clientInfo: CodexClientInfo,
    capabilities: CodexInitializeParams['capabilities'] = null,
  ): Promise<CodexInitializeResponse> {
    if (this.initializePromise) return this.initializePromise
    if (this.currentState !== 'new') throw new Error(`Cannot initialize Codex client in state ${this.currentState}`)
    this.currentState = 'initializing'
    this.initializePromise = (async () => {
      try {
        const response = await this.requestInternal<'initialize'>('initialize', { clientInfo, capabilities }, {}, true)
        await this.sendMessage({ method: 'initialized' })
        this.currentState = 'ready'
        return response
      } catch (error) {
        this.currentState = 'failed'
        await this.closeWithError(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    })()
    return this.initializePromise
  }

  async request<M extends string>(
    method: M,
    params: CodexMethodParams<M>,
    options: CodexRequestOptions = {},
  ): Promise<CodexMethodResult<M>> {
    return this.requestInternal(method, params, options, false)
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.assertReady()
    await this.sendMessage(params === undefined ? { method } : { method, params })
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

  onClose(listener: (close: CodexClientClose) => void): CodexUnsubscribe {
    if (this.closeInfo) queueMicrotask(() => listener(this.closeInfo!))
    else this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async close(): Promise<void> {
    if (this.currentState === 'closed' || this.currentState === 'closing') return
    this.currentState = 'closing'
    try {
      await this.transport.close()
    } catch (error) {
      this.finishClose({
        transport: null,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
    this.finishClose({ transport: null, error: null })
  }

  private async requestInternal<M extends string>(
    method: M,
    params: CodexMethodParams<M>,
    options: CodexRequestOptions,
    allowBeforeInitialization: boolean,
  ): Promise<CodexMethodResult<M>> {
    if (!allowBeforeInitialization) this.assertReady()
    else if (this.currentState !== 'initializing') throw new Error('initialize is only valid while initializing')
    if (this.pending.size >= this.maxPendingRequests) {
      throw new Error(`Codex app-server pending request limit reached (${this.maxPendingRequests})`)
    }
    const id = this.nextId++
    const key = this.idKey(id)
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.requestTimeoutMs)
    const pending = deferred<unknown>()
    const timer = setTimeout(() => {
      const entry = this.pending.get(key)
      if (!entry) return
      this.pending.delete(key)
      entry.deferred.reject(new CodexRequestTimeoutError(method, timeoutMs))
    }, timeoutMs)
    timer.unref?.()
    this.pending.set(key, { method, deferred: pending, timer })
    try {
      await this.sendMessage(params === undefined ? { method, id } : { method, id, params })
    } catch (error) {
      clearTimeout(timer)
      this.pending.delete(key)
      pending.reject(error)
    }
    return pending.promise as Promise<CodexMethodResult<M>>
  }

  private assertReady(): void {
    if (this.currentState !== 'ready') {
      throw new Error(`Codex app-server client is not ready (state: ${this.currentState})`)
    }
  }

  private async sendMessage(message: Record<string, unknown>): Promise<void> {
    // App-server intentionally omits the JSON-RPC 2.0 header on the wire.
    const payload = `${JSON.stringify(message)}\n`
    const size = Buffer.byteLength(payload)
    if (size > this.maxPayloadBytes) throw new CodexPayloadTooLargeError(size, this.maxPayloadBytes)
    await this.transport.write(payload)
  }

  private acceptData(chunk: Uint8Array): void {
    try {
      for (const message of this.decoder.push(chunk)) this.acceptMessage(message)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.emitDiagnostic('protocol', 'error', failure.message)
      void this.closeWithError(failure)
    }
  }

  private acceptMessage(message: Record<string, unknown>): void {
    const hasId = typeof message.id === 'number' || typeof message.id === 'string'
    const hasMethod = typeof message.method === 'string'
    if (hasId && hasMethod) {
      void this.handleServerRequest({
        id: message.id as CodexRpcId,
        method: message.method as string,
        params: message.params,
        receivedAt: this.now().toISOString(),
      })
      return
    }
    if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      this.handleResponse(message.id as CodexRpcId, message)
      return
    }
    if (hasMethod) {
      const notification: CodexServerNotification = {
        method: message.method as string,
        params: message.params,
        receivedAt: this.now().toISOString(),
      }
      this.emit(this.notificationListeners, notification)
      return
    }
    this.emitDiagnostic('protocol', 'warning', 'Ignored unrecognized Codex app-server message')
  }

  private handleResponse(id: CodexRpcId, message: Record<string, unknown>): void {
    const key = this.idKey(id)
    const pending = this.pending.get(key)
    if (!pending) {
      this.emitDiagnostic('protocol', 'warning', `Ignored response for unknown request id ${String(id)}`)
      return
    }
    this.pending.delete(key)
    clearTimeout(pending.timer)
    if (message.error !== undefined) {
      const raw = isRecord(message.error) ? message.error : {}
      pending.deferred.reject(new CodexRpcResponseError(pending.method, {
        code: typeof raw.code === 'number' ? raw.code : -32603,
        message: typeof raw.message === 'string' ? raw.message : 'Unknown app-server error',
        ...(Object.hasOwn(raw, 'data') ? { data: raw.data } : {}),
      }))
      return
    }
    pending.deferred.resolve(message.result)
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    for (const handler of [...this.serverRequestHandlers]) {
      try {
        const result = await handler(request)
        if (result === CODEX_REQUEST_UNHANDLED) continue
        await this.sendMessage({ id: request.id, result: result === undefined ? null : result })
        return
      } catch (error) {
        await this.sendMessage({
          id: request.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        }).catch(() => {})
        return
      }
    }
    await this.sendMessage({
      id: request.id,
      error: { code: -32601, message: `No client handler registered for ${request.method}` },
    }).catch(() => {})
  }

  private acceptClose(close: CodexTransportClose): void {
    try {
      for (const message of this.decoder.finish()) this.acceptMessage(message)
    } catch (error) {
      this.emitDiagnostic('protocol', 'error', error instanceof Error ? error.message : String(error))
    }
    const error = close.expected
      ? null
      : new CodexConnectionClosedError(`Codex app-server exited (code=${String(close.code)}, signal=${String(close.signal)})`)
    this.finishClose({ transport: close, error })
  }

  private async closeWithError(error: Error): Promise<void> {
    this.finishClose({ transport: null, error })
    try { await this.transport.close() } catch {}
  }

  private finishClose(close: CodexClientClose): void {
    if (this.closeInfo) return
    this.closeInfo = close
    this.currentState = close.error ? 'failed' : 'closed'
    const rejection = close.error ?? new CodexConnectionClosedError()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.deferred.reject(rejection)
    }
    this.pending.clear()
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    this.emit(this.closeListeners, close)
    this.closeListeners.clear()
  }

  private emitDiagnostic(
    source: CodexDiagnostic['source'],
    level: CodexDiagnostic['level'],
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.emit(this.diagnosticListeners, {
      source,
      level,
      message,
      at: this.now().toISOString(),
      ...(metadata ? { metadata } : {}),
    })
  }

  private idKey(id: CodexRpcId): string {
    return `${typeof id}:${String(id)}`
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

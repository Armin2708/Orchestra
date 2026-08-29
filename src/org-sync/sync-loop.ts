import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../daemon.js'
import {
  HubConflictError,
  HubRequestError,
  HubRetryableError,
  type HubSyncEvent,
  type OpResult,
} from './hub-client.js'
import { Outbox, type QueuedOp } from './outbox.js'

export type SyncState = 'offline' | 'connecting' | 'live'

export interface SyncClient {
  postOp(op: string, payload: unknown, idempotencyKey?: string): Promise<OpResult>
  streamSince(
    seq: number,
    onEvent: (event: HubSyncEvent) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void>
}

export interface SyncLoopOptions {
  client: SyncClient
  outbox: Outbox
  applyEvent: (event: HubSyncEvent) => void | Promise<void>
  home?: string
  onConflict?: (error: HubConflictError, op: QueuedOp) => void
  onError?: (error: Error) => void
  onStateChange?: (state: SyncState) => void
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  backoff?: { baseMs?: number; maxMs?: number; jitter?: number }
  random?: () => number
}

class EventApplyError extends HubRetryableError {
  constructor(options?: ErrorOptions) {
    super('a hub event could not be applied locally; it will be replayed', undefined, options)
    this.name = 'EventApplyError'
  }
}

export class SyncLoop {
  readonly #client: SyncClient
  readonly #outbox: Outbox
  readonly #applyEvent: SyncLoopOptions['applyEvent']
  readonly #cursorPath: string
  readonly #onConflict: NonNullable<SyncLoopOptions['onConflict']>
  readonly #onError: NonNullable<SyncLoopOptions['onError']>
  readonly #onStateChange?: SyncLoopOptions['onStateChange']
  readonly #sleep: NonNullable<SyncLoopOptions['sleep']>
  readonly #baseBackoffMs: number
  readonly #maxBackoffMs: number
  readonly #jitter: number
  readonly #random: () => number
  #state: SyncState = 'offline'
  #running = false
  #controller?: AbortController
  #runPromise?: Promise<void>
  #flushPromise?: Promise<void>
  #flushRequested = false

  constructor(options: SyncLoopOptions) {
    this.#client = options.client
    this.#outbox = options.outbox
    this.#applyEvent = options.applyEvent
    this.#cursorPath = path.join(options.home ?? dataDir(), 'org-cursor.json')
    this.#onConflict = options.onConflict ?? ((error) => {
      console.error(`${conflictGuidance()} (${safeErrorMessage(error)})`)
    })
    this.#onError = options.onError ?? ((error) => {
      console.error(`organization sync: ${safeErrorMessage(error)}`)
    })
    this.#onStateChange = options.onStateChange
    this.#sleep = options.sleep ?? abortableSleep
    this.#baseBackoffMs = positive(options.backoff?.baseMs, 500)
    this.#maxBackoffMs = positive(options.backoff?.maxMs, 30_000)
    this.#jitter = Math.max(0, options.backoff?.jitter ?? 0.25)
    this.#random = options.random ?? Math.random
  }

  start(): void {
    if (this.#runPromise) return
    this.#running = true
    const running = this.#run()
    const tracked = running.finally(() => {
      if (this.#runPromise === tracked) this.#runPromise = undefined
      this.#running = false
      this.#controller = undefined
      this.#setState('offline')
    })
    this.#runPromise = tracked
  }

  async stop(): Promise<void> {
    this.#running = false
    this.#controller?.abort()
    await this.#runPromise
    this.#setState('offline')
  }

  state(): SyncState {
    return this.#state
  }

  /** Flushes work enqueued after the SSE connection became live. Calls coalesce so a
   * burst of local events still has exactly one FIFO sender. */
  flush(): Promise<void> {
    this.#flushRequested = true
    if (this.#flushPromise) return this.#flushPromise
    const flushing = (async () => {
      do {
        this.#flushRequested = false
        await this.#flushOutbox()
      } while (this.#flushRequested)
    })()
    const tracked = flushing.finally(() => {
      if (this.#flushPromise === tracked) this.#flushPromise = undefined
    })
    this.#flushPromise = tracked
    return tracked
  }

  async #run(): Promise<void> {
    let cursor = this.#loadCursor()
    let failures = 0
    while (this.#running) {
      const controller = new AbortController()
      this.#controller = controller
      this.#setState('connecting')
      let receivedEvent = false
      try {
        await this.flush()
        if (!this.#running) break
        this.#setState('live')
        await this.#client.streamSince(cursor, async (event) => {
          if (event.seq <= cursor) return
          try { await this.#applyEvent(event) } catch (error) {
            throw new EventApplyError({ cause: error })
          }
          this.#persistCursor(event.seq)
          cursor = event.seq
          receivedEvent = true
        }, controller.signal)
        if (!this.#running || controller.signal.aborted) break
        throw new HubRetryableError('hub sync stream disconnected')
      } catch (error) {
        if (!this.#running || controller.signal.aborted || isAbortError(error)) break
        const failure = asError(error)
        this.#onError(failure)
        if (failure instanceof HubRequestError && !(failure instanceof HubConflictError)) break
        if (!(failure instanceof HubRetryableError)) break
        failures = receivedEvent ? 0 : failures
      }
      this.#setState('offline')
      const delay = this.#backoffDelay(failures)
      failures += 1
      try { await this.#sleep(delay, controller.signal) } catch (error) {
        if (!isAbortError(error)) this.#onError(asError(error))
      }
      if (this.#controller === controller) this.#controller = undefined
    }
  }

  async #flushOutbox(): Promise<void> {
    for (const item of this.#outbox.pending()) {
      if (!this.#running) return
      try {
        await this.#client.postOp(item.op, item.payload, item.idempotencyKey)
        this.#outbox.markSent(item.id)
      } catch (error) {
        if (error instanceof HubConflictError) {
          this.#outbox.markFailed(item.id, conflictGuidance())
          this.#onConflict(error, item)
          continue
        }
        if (error instanceof HubRequestError
          && error.status !== 401 && error.status !== 403) {
          this.#outbox.markFailed(item.id, safeErrorMessage(error))
          this.#onError(error)
          continue
        }
        throw error
      }
    }
  }

  #backoffDelay(attempt: number): number {
    const exponential = Math.min(this.#maxBackoffMs, this.#baseBackoffMs * (2 ** attempt))
    return Math.min(this.#maxBackoffMs, Math.round(exponential * (1 + (this.#random() * this.#jitter))))
  }

  #loadCursor(): number {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#cursorPath, 'utf8')) as { version?: unknown; seq?: unknown }
      return parsed.version === 1 && Number.isInteger(parsed.seq) && Number(parsed.seq) >= 0 ? Number(parsed.seq) : 0
    } catch {
      return 0
    }
  }

  #persistCursor(seq: number): void {
    const directory = path.dirname(this.#cursorPath)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(directory, `.org-cursor.json.${process.pid}.${randomUUID()}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(descriptor, `${JSON.stringify({ version: 1, seq })}\n`, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      fs.renameSync(temporary, this.#cursorPath)
      fs.chmodSync(this.#cursorPath, 0o600)
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* retain original failure */ }
      }
      try { fs.rmSync(temporary, { force: true }) } catch { /* retain original failure */ }
      throw error
    }
  }

  #setState(state: SyncState): void {
    if (this.#state === state) return
    this.#state = state
    this.#onStateChange?.(state)
  }
}

const conflictGuidance = () =>
  'shared card changed or was claimed by someone else; ask the current owner before retrying'

const safeErrorMessage = (error: Error): string =>
  error.message.replace(/orchestra_device_v1\.[^\s"']+/g, '[redacted device token]')

const asError = (error: unknown): Error => error instanceof Error ? error : new Error('unknown sync failure')
const isAbortError = (error: unknown): error is Error => error instanceof Error && error.name === 'AbortError'
const positive = (value: number | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

const abortableSleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('This operation was aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(finish, milliseconds)
    timer.unref()
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new DOMException('This operation was aborted', 'AbortError'))
    }
    function finish() {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
  })

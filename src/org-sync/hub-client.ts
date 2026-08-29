import { randomUUID } from 'node:crypto'
import type { OrgCredential } from './credentials.js'

export interface OpResult {
  result: unknown
  seq: number
}

export type HubSyncEvent = {
  seq: number
  [key: string]: unknown
}

export class HubRequestError extends Error {
  readonly retryable = false

  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'HubRequestError'
  }
}

export class HubRetryableError extends Error {
  readonly retryable = true

  constructor(message: string, readonly status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HubRetryableError'
  }
}

export class HubConflictError extends HubRequestError {
  constructor(message: string, readonly current: unknown) {
    super(message, 409)
    this.name = 'HubConflictError'
  }
}

type Query = Record<string, string | number | boolean | undefined>

export interface HubClientOptions {
  requestTimeoutMs?: number
}

export class HubClient {
  readonly #credential: OrgCredential
  readonly #orgRoot: string
  readonly #requestTimeoutMs: number

  constructor(credential: OrgCredential, options: HubClientOptions = {}) {
    this.#credential = credential
    this.#orgRoot = `${credential.hubBaseUrl.replace(/\/+$/, '')}/api/v1/hub/orgs/${encodeURIComponent(credential.orgId)}`
    this.#requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, 10_000)
  }

  async postOp(
    op: string,
    payload: unknown,
    idempotencyKey = randomUUID(),
    signal?: AbortSignal,
  ): Promise<OpResult> {
    if (!idempotencyKey) throw new Error('an idempotency key is required for every hub operation')
    const request = requestDeadline(signal, this.#requestTimeoutMs)
    try {
      const response = await this.#fetch(`${this.#orgRoot}/ops`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, idempotency_key: idempotencyKey, payload }),
        signal: request.signal,
      })
      const body = await this.#jsonResponse(response)
      if (!body || typeof body !== 'object' || !Number.isInteger((body as any).seq) || !('result' in body)) {
        throw new HubRequestError('hub returned an invalid operation response', response.status)
      }
      return { result: (body as any).result, seq: (body as any).seq }
    } catch (error) {
      if (request.timedOut()) throw new HubRetryableError('hub operation request timed out', undefined, { cause: error })
      throw error
    } finally {
      request.dispose()
    }
  }

  async get(path: string, query: Query = {}, signal?: AbortSignal): Promise<unknown> {
    const normalizedPath = path.replace(/^\/+/, '')
    const url = new URL(`${this.#orgRoot}/${normalizedPath}`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const request = requestDeadline(signal, this.#requestTimeoutMs)
    try {
      const response = await this.#fetch(url, { signal: request.signal })
      return await this.#jsonResponse(response)
    } catch (error) {
      if (request.timedOut()) throw new HubRetryableError('hub read request timed out', undefined, { cause: error })
      throw error
    } finally {
      request.dispose()
    }
  }

  async streamSince(
    seq: number,
    onEvent: (event: HubSyncEvent) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const url = new URL(`${this.#orgRoot}/sync`)
    url.searchParams.set('since', String(seq))
    const request = requestDeadline(signal, this.#requestTimeoutMs)
    let response: Response
    try {
      response = await this.#fetch(url, {
        headers: { accept: 'text/event-stream' },
        signal: request.signal,
      })
    } catch (error) {
      if (request.timedOut()) throw new HubRetryableError('hub sync connection timed out', undefined, { cause: error })
      throw error
    } finally {
      // The stream is intentionally long-lived. The deadline covers connection and
      // response headers; daemon shutdown remains wired through the caller signal.
      request.dispose()
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('text/event-stream') || !response.body) {
      throw new HubRequestError('hub returned an invalid sync stream', response.status)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let boundary = /\r?\n\r?\n/.exec(buffer)
        while (boundary) {
          const frame = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary[0].length)
          await this.#handleFrame(frame, onEvent)
          boundary = /\r?\n\r?\n/.exec(buffer)
        }
        if (done) break
      }
      if (buffer.trim()) await this.#handleFrame(buffer, onEvent)
    } finally {
      reader.releaseLock()
    }
  }

  async #handleFrame(
    frame: string,
    onEvent: (event: HubSyncEvent) => void | Promise<void>,
  ): Promise<void> {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).replace(/^ /, ''))
    if (data.length === 0) return
    let event: unknown
    try { event = JSON.parse(data.join('\n')) } catch {
      throw new HubRequestError('hub sent invalid JSON in the sync stream', 200)
    }
    if (!event || typeof event !== 'object' || !Number.isInteger((event as any).seq)) {
      throw new HubRequestError('hub sent an invalid sync event', 200)
    }
    await onEvent(event as HubSyncEvent)
  }

  async #fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await fetch(input, {
        ...init,
        headers: {
          authorization: `Bearer ${this.#credential.deviceToken}`,
          ...init.headers,
        },
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new HubRetryableError('hub request failed because the hub could not be reached', undefined, { cause: error })
    }
    if (response.ok) return response
    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    const detail = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`
    if (response.status === 409) throw new HubConflictError(detail, body?.current)
    if (response.status === 401 || response.status === 403) {
      throw new HubRequestError(
        'hub authorization failed: the token may be invalid, revoked, or for another organization',
        response.status,
      )
    }
    if (response.status >= 500) throw new HubRetryableError(detail, response.status)
    throw new HubRequestError(detail, response.status)
  }

  async #jsonResponse(response: Response): Promise<unknown> {
    try { return await response.json() } catch (error) {
      if (isAbortError(error) || isTimeoutError(error)) throw error
      throw new HubRequestError('hub returned an invalid JSON response', response.status)
    }
  }
}

const isAbortError = (error: unknown): error is Error =>
  error instanceof Error && error.name === 'AbortError'

const isTimeoutError = (error: unknown): error is Error =>
  error instanceof Error && error.name === 'TimeoutError'

const positiveTimeout = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

const requestDeadline = (signal: AbortSignal | undefined, milliseconds: number) => {
  const timeout = new AbortController()
  const timer = setTimeout(() => {
    timeout.abort(new DOMException('The hub request timed out', 'TimeoutError'))
  }, milliseconds)
  timer.unref()
  return {
    signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
    timedOut: () => timeout.signal.aborted,
    dispose: () => clearTimeout(timer),
  }
}

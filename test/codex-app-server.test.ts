import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_REQUEST_UNHANDLED,
  CodexAppServerClient,
  CodexAppServerService,
  CodexAppServerSupervisor,
  CodexFrameTooLargeError,
  CodexJsonlDecoder,
  CodexPayloadTooLargeError,
  CodexProcessTransport,
  CodexRequestTimeoutError,
  CodexRpcResponseError,
  type CodexAppServerPort,
  type CodexByteTransport,
  type CodexChildProcess,
  type CodexDiagnostic,
  type CodexTransportClose,
  type CodexTransportListener,
  type CodexUnsubscribe,
} from '../src/codex/index.js'

class FakeTransport implements CodexByteTransport {
  readonly writes: string[] = []
  readonly dataListeners = new Set<CodexTransportListener<Uint8Array>>()
  readonly stderrListeners = new Set<CodexTransportListener<string>>()
  readonly errorListeners = new Set<CodexTransportListener<Error>>()
  readonly closeListeners = new Set<CodexTransportListener<CodexTransportClose>>()
  closed = false
  onWrite?: (message: Record<string, unknown>) => void

  async write(data: string): Promise<void> {
    if (this.closed) throw new Error('closed')
    this.writes.push(data)
    for (const line of data.trimEnd().split('\n')) this.onWrite?.(JSON.parse(line) as Record<string, unknown>)
  }

  async close(): Promise<void> {
    this.disconnect(true)
  }

  onData(listener: CodexTransportListener<Uint8Array>): CodexUnsubscribe {
    return this.add(this.dataListeners, listener)
  }

  onStderr(listener: CodexTransportListener<string>): CodexUnsubscribe {
    return this.add(this.stderrListeners, listener)
  }

  onError(listener: CodexTransportListener<Error>): CodexUnsubscribe {
    return this.add(this.errorListeners, listener)
  }

  onClose(listener: CodexTransportListener<CodexTransportClose>): CodexUnsubscribe {
    return this.add(this.closeListeners, listener)
  }

  server(message: Record<string, unknown>): void {
    this.bytes(`${JSON.stringify(message)}\n`)
  }

  bytes(value: string): void {
    for (const listener of [...this.dataListeners]) listener(Buffer.from(value))
  }

  stderr(value: string): void {
    for (const listener of [...this.stderrListeners]) listener(value)
  }

  disconnect(expected = false): void {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.closeListeners]) listener({ code: expected ? 0 : 1, signal: null, expected })
  }

  private add<T>(listeners: Set<CodexTransportListener<T>>, listener: CodexTransportListener<T>): CodexUnsubscribe {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}

const initializeResult = {
  userAgent: 'codex-test',
  codexHome: '/tmp/codex-test',
  platformFamily: 'unix',
  platformOs: 'macos',
}

const connect = async (transport: FakeTransport, options: ConstructorParameters<typeof CodexAppServerClient>[1] = {}) => {
  const client = new CodexAppServerClient(transport, options)
  const initialized = client.initialize({ name: 'orchestra_test', title: 'Orchestra Test', version: '1.0.0' })
  expect(JSON.parse(transport.writes[0])).toEqual({
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: { name: 'orchestra_test', title: 'Orchestra Test', version: '1.0.0' },
      capabilities: null,
    },
  })
  expect(transport.writes[0]).not.toContain('jsonrpc')
  transport.server({ id: 1, result: initializeResult })
  await initialized
  expect(JSON.parse(transport.writes[1])).toEqual({ method: 'initialized' })
  return client
}

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const clients: CodexAppServerClient[] = []
const supervisors: CodexAppServerSupervisor[] = []

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()))
  await Promise.allSettled(supervisors.splice(0).map((supervisor) => supervisor.stop()))
  vi.restoreAllMocks()
})
describe('Codex JSONL app-server client', () => {
  it('performs the handshake, correlates out-of-order responses, and forwards unknown notifications', async () => {
    const transport = new FakeTransport()
    const client = await connect(transport)
    clients.push(client)
    const notifications: string[] = []
    client.onNotification((notification) => notifications.push(notification.method))

    const read = client.request('thread/read', { threadId: 'thread-a', includeTurns: true })
    const models = client.request('model/list', { cursor: null })
    const readRequest = JSON.parse(transport.writes[2]) as { id: number }
    const modelRequest = JSON.parse(transport.writes[3]) as { id: number }
    transport.server({ method: 'future/providerEvent', params: { threadId: 'thread-a', value: 1 } })
    transport.server({ id: modelRequest.id, result: { data: [], nextCursor: null } })
    transport.server({ id: readRequest.id, result: { thread: { id: 'thread-a' } } })

    await expect(models).resolves.toEqual({ data: [], nextCursor: null })
    await expect(read).resolves.toEqual({ thread: { id: 'thread-a' } })
    expect(notifications).toEqual(['future/providerEvent'])
  })

  it('routes bidirectional requests to handlers and returns protocol errors for unhandled methods', async () => {
    const transport = new FakeTransport()
    const client = await connect(transport)
    clients.push(client)
    client.onServerRequest(async (request) => request.method === 'item/commandExecution/requestApproval'
      ? { decision: 'accept' }
      : CODEX_REQUEST_UNHANDLED)

    transport.server({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a' },
    })
    await waitFor(() => transport.writes.length === 3)
    expect(JSON.parse(transport.writes[2])).toEqual({ id: 'approval-1', result: { decision: 'accept' } })

    transport.server({ id: 'future-1', method: 'future/request', params: {} })
    await waitFor(() => transport.writes.length === 4)
    expect(JSON.parse(transport.writes[3])).toMatchObject({
      id: 'future-1', error: { code: -32601 },
    })
  })

  it('surfaces RPC errors, timeouts, stderr diagnostics, and outbound bounds', async () => {
    const transport = new FakeTransport()
    const client = await connect(transport, { requestTimeoutMs: 15, maxPayloadBytes: 1_024 })
    clients.push(client)
    const diagnostics: CodexDiagnostic[] = []
    client.onDiagnostic((diagnostic) => diagnostics.push(diagnostic))
    transport.stderr('rate-limit service temporarily unavailable')

    const failed = client.request('account/read', {})
    const failedId = (JSON.parse(transport.writes[2]) as { id: number }).id
    transport.server({ id: failedId, error: { code: 503, message: 'upstream unavailable' } })
    await expect(failed).rejects.toBeInstanceOf(CodexRpcResponseError)

    await expect(client.request('thread/read', { threadId: 'never', includeTurns: true }))
      .rejects.toBeInstanceOf(CodexRequestTimeoutError)
    await expect(client.request('future/huge', { text: 'x'.repeat(2_000) }))
      .rejects.toBeInstanceOf(CodexPayloadTooLargeError)
    expect(diagnostics).toEqual([expect.objectContaining({ source: 'stderr', message: expect.stringContaining('rate-limit') })])
  })

  it('closes the connection on an oversized inbound frame', async () => {
    const transport = new FakeTransport()
    const client = await connect(transport, { maxFrameBytes: 512 })
    clients.push(client)
    const diagnostics: CodexDiagnostic[] = []
    client.onDiagnostic((diagnostic) => diagnostics.push(diagnostic))
    transport.bytes(`${JSON.stringify({ method: 'future/event', params: { data: 'x'.repeat(800) } })}\n`)
    await waitFor(() => transport.closed)
    expect(client.state).toBe('failed')
    expect(diagnostics.some((diagnostic) => diagnostic.message.includes('limit is 512'))).toBe(true)
  })

  it('decodes fragmented CRLF frames and rejects non-object or oversized frames', () => {
    const decoder = new CodexJsonlDecoder(64)
    expect(decoder.push(Buffer.from('{"method":"one"}\r'))).toEqual([])
    expect(decoder.push(Buffer.from('\n{"method":"two"}\n'))).toEqual([
      { method: 'one' },
      { method: 'two' },
    ])
    expect(() => decoder.push(Buffer.from('x'.repeat(65)))).toThrow(CodexFrameTooLargeError)
  })
})

describe('Codex process transport and supervisor', () => {
  it('adapts an injected child process, captures stderr, and closes gracefully', async () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const childEvents = new EventEmitter()
    const writes: string[] = []
    let ended = false
    const child: CodexChildProcess = {
      pid: 123,
      stdin: {
        writable: true,
        write: (data, callback) => { writes.push(data); callback?.(); return true },
        end: () => {
          ended = true
          queueMicrotask(() => childEvents.emit('close', 0, null))
        },
      },
      stdout: { on: (event, listener) => stdout.on(event, listener) },
      stderr: { on: (event, listener) => stderr.on(event, listener) },
      once: (event, listener) => childEvents.once(event, listener),
      kill: () => true,
    }
    const transport = CodexProcessTransport.spawn({
      spawnProcess: () => child,
      gracefulShutdownMs: 20,
      terminateWaitMs: 20,
    })
    const data: string[] = []
    const diagnostics: string[] = []
    transport.onData((chunk) => data.push(Buffer.from(chunk).toString('utf8')))
    transport.onStderr((line) => diagnostics.push(line))
    stdout.emit('data', Buffer.from('{"method":"ready"}\n'))
    stderr.emit('data', Buffer.from('diagnostic line\n'))
    await transport.write('request\n')
    await transport.close()

    expect(data).toEqual(['{"method":"ready"}\n'])
    expect(diagnostics).toEqual(['diagnostic line'])
    expect(writes).toEqual(['request\n'])
    expect(ended).toBe(true)
    expect(transport.closed).toBe(true)
  })

  it('restarts after an unexpected disconnect while preserving a stable RPC port', async () => {
    const transports: FakeTransport[] = []
    const lifecycle: string[] = []
    const supervisor = new CodexAppServerSupervisor({
      transportFactory: () => {
        const transport = new FakeTransport()
        transport.onWrite = (message) => {
          if (message.method === 'initialize') queueMicrotask(() => transport.server({ id: message.id, result: initializeResult }))
          if (message.method === 'account/read') queueMicrotask(() => transport.server({
            id: message.id,
            result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
          }))
        }
        transports.push(transport)
        return transport
      },
      restart: { initialDelayMs: 1, maxDelayMs: 1, jitter: 0, stableResetMs: 100, maxAttempts: 3 },
    })
    supervisors.push(supervisor)
    supervisor.onLifecycle((event) => lifecycle.push(event.type))
    await supervisor.start()
    expect(supervisor.state).toBe('running')
    transports[0].disconnect(false)
    const account = supervisor.request('account/read', {})
    await expect(account).resolves.toMatchObject({ account: { type: 'apiKey' } })
    expect(transports).toHaveLength(2)
    expect(lifecycle).toEqual(expect.arrayContaining(['connected', 'disconnected', 'restart_scheduled']))
  })
})

describe('Codex provider service', () => {
  it('wraps thread, turn, model, account, rate-limit, and usage methods exactly', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const port = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params })
        if (method === 'model/list') {
          const cursor = (params as { cursor?: string | null }).cursor
          return cursor === null
            ? { data: [{ id: 'one', model: 'one' }], nextCursor: 'next' }
            : { data: [{ id: 'two', model: 'two' }], nextCursor: null }
        }
        if (method === 'thread/start') return { thread: { id: 'thread-1' } }
        if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
        if (method === 'thread/read') return { thread: { id: 'thread-1' } }
        if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
        if (method === 'turn/start') return { turn: { id: 'turn-1' } }
        if (method === 'turn/steer') return { turnId: 'turn-1' }
        if (method === 'account/read') return { account: null, requiresOpenaiAuth: true }
        if (method === 'account/rateLimits/read') return { rateLimits: {}, rateLimitsByLimitId: null, rateLimitResetCredits: null }
        if (method === 'account/usage/read') return { summary: {}, dailyUsageBuckets: null }
        return {}
      },
      notify: async () => {},
      onNotification: () => () => {},
      onServerRequest: () => () => {},
      onDiagnostic: () => () => {},
    } as CodexAppServerPort
    const service = new CodexAppServerService(port)

    await service.startThread({ cwd: '/repo' })
    await service.resumeThread('thread-1')
    await service.readThread('thread-1')
    await service.startTurn('thread-1', 'hello')
    await service.steerTurn('thread-1', 'turn-1', 'more')
    await service.interruptTurn('thread-1', 'turn-1')
    await service.unsubscribeThread('thread-1')
    expect((await service.listModels()).map((model) => model.id)).toEqual(['one', 'two'])
    await service.readAccount()
    await service.readRateLimits()
    await service.readUsage()

    expect(calls.map((call) => call.method)).toEqual([
      'thread/start', 'thread/resume', 'thread/read', 'turn/start', 'turn/steer', 'turn/interrupt',
      'thread/unsubscribe', 'model/list', 'model/list', 'account/read', 'account/rateLimits/read', 'account/usage/read',
    ])
    expect(calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      threadId: 'thread-1', input: [{ type: 'text', text: 'hello', text_elements: [] }],
    })
  })
})

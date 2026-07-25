import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodexAppServerClient,
  type CodexAppServerPort,
  type CodexRequestOptions,
} from '../src/codex/client.js'
import type {
  CodexMethodParams,
  CodexMethodResult,
  CodexServerNotification,
  CodexServerRequest,
  CodexThread,
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadReadResponse,
  CodexThreadResumeParams,
  CodexThreadResumeResponse,
  CodexThreadStartParams,
  CodexThreadStartResponse,
  CodexTurnStartParams,
  CodexTurnStartResponse,
  CodexTurnSteerResponse,
  CodexUserInput,
} from '../src/codex/protocol.js'
import {
  CodexAppServerService,
  type CodexModelCatalogOptions,
  type CodexRuntimeService,
} from '../src/codex/service.js'
import type { CodexSupervisorLifecycleEvent } from '../src/codex/supervisor.js'
import type {
  CodexByteTransport,
  CodexTransportClose,
  CodexTransportListener,
  CodexUnsubscribe,
} from '../src/codex/transport.js'
import {
  CodexAgentDriver,
  type CodexSessionForkOptions,
} from '../src/runtime/drivers/codex.js'

const thread = (
  id: string,
  overrides: Partial<CodexThread> = {},
): CodexThread => ({
  id,
  sessionId: id,
  forkedFromId: null,
  parentThreadId: null,
  preview: '',
  ephemeral: false,
  status: { type: 'idle' },
  cwd: '/repo',
  cliVersion: '0.144.6',
  agentNickname: null,
  agentRole: null,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  path: `/codex/sessions/${id}.jsonl`,
  turns: [],
  ...overrides,
})

const startResponse = (value: CodexThread): CodexThreadStartResponse => ({
  thread: value,
  model: 'gpt-test',
  modelProvider: 'openai',
  serviceTier: null,
  cwd: value.cwd,
  instructionSources: [],
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: { type: 'workspaceWrite' },
  reasoningEffort: 'high',
})

const forkResponse = (value: CodexThread): CodexThreadForkResponse => ({
  ...startResponse(value),
  runtimeWorkspaceRoots: [value.cwd],
  activePermissionProfile: null,
  multiAgentMode: 'explicitRequestOnly',
})

class FakeTransport implements CodexByteTransport {
  readonly writes: string[] = []
  readonly dataListeners = new Set<CodexTransportListener<Uint8Array>>()
  readonly closeListeners = new Set<CodexTransportListener<CodexTransportClose>>()
  closed = false

  async write(data: string): Promise<void> {
    this.writes.push(data)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.closeListeners]) {
      listener({ code: 0, signal: null, expected: true })
    }
  }

  onData(listener: CodexTransportListener<Uint8Array>): CodexUnsubscribe {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onStderr(): CodexUnsubscribe {
    return () => {}
  }

  onError(): CodexUnsubscribe {
    return () => {}
  }

  onClose(listener: CodexTransportListener<CodexTransportClose>): CodexUnsubscribe {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  server(message: Record<string, unknown>): void {
    const frame = Buffer.from(`${JSON.stringify(message)}\n`)
    for (const listener of [...this.dataListeners]) listener(frame)
  }
}

class RecordingPort implements CodexAppServerPort {
  readonly calls: Array<{ method: string; params: unknown; options?: CodexRequestOptions }> = []

  constructor(readonly response: CodexThreadForkResponse) {}

  async request<M extends string>(
    method: M,
    params: CodexMethodParams<M>,
    options?: CodexRequestOptions,
  ): Promise<CodexMethodResult<M>> {
    this.calls.push({ method, params, options })
    return this.response as CodexMethodResult<M>
  }

  async notify(): Promise<void> {}
  onNotification(): CodexUnsubscribe { return () => {} }
  onServerRequest(): CodexUnsubscribe { return () => {} }
  onDiagnostic(): CodexUnsubscribe { return () => {} }
}

class FakeRuntimeService implements CodexRuntimeService {
  readonly forks: Array<{
    threadId: string
    overrides: Omit<CodexThreadForkParams, 'threadId'>
  }> = []
  readonly reads: Array<{ threadId: string; includeTurns: boolean | undefined }> = []
  readonly unsubscribes: string[] = []
  forked = forkResponse(thread('thread-child', { forkedFromId: 'thread-source' }))
  readThreadValue: CodexThread | null = null
  readError: Error | null = null
  unsubscribeError: Error | null = null

  async startThread(_params: CodexThreadStartParams): Promise<CodexThreadStartResponse> {
    return startResponse(thread('thread-source'))
  }

  async resumeThread(
    _threadId: string,
    _overrides?: Omit<CodexThreadResumeParams, 'threadId'>,
  ): Promise<CodexThreadResumeResponse> {
    throw new Error('not used')
  }

  async forkThread(
    threadId: string,
    overrides: Omit<CodexThreadForkParams, 'threadId'> = {},
  ): Promise<CodexThreadForkResponse> {
    this.forks.push({ threadId, overrides })
    return this.forked
  }

  async readThread(
    threadId: string,
    includeTurns?: boolean,
  ): Promise<CodexThreadReadResponse> {
    this.reads.push({ threadId, includeTurns })
    if (this.readError) throw this.readError
    return { thread: this.readThreadValue ?? this.forked.thread }
  }

  async unsubscribeThread(threadId: string): Promise<{ status: string }> {
    this.unsubscribes.push(threadId)
    if (this.unsubscribeError) throw this.unsubscribeError
    return { status: 'unsubscribed' }
  }

  async startTurn(
    _threadId: string,
    _input: string | CodexUserInput[],
    _overrides?: Omit<CodexTurnStartParams, 'threadId' | 'input'>,
  ): Promise<CodexTurnStartResponse> {
    throw new Error('not used')
  }

  async steerTurn(): Promise<CodexTurnSteerResponse> {
    throw new Error('not used')
  }

  async interruptTurn(): Promise<void> {
    throw new Error('not used')
  }

  async listModelsPage(
    _cursor?: string | null,
    _options?: CodexModelCatalogOptions & CodexRequestOptions,
  ): Promise<never> {
    throw new Error('not used')
  }

  async listModels(): Promise<never> {
    throw new Error('not used')
  }

  async readAccount(): Promise<never> {
    throw new Error('not used')
  }

  async readRateLimits(): Promise<never> {
    throw new Error('not used')
  }

  async readUsage(): Promise<never> {
    throw new Error('not used')
  }

  onNotification(_listener: (notification: CodexServerNotification) => void): CodexUnsubscribe {
    return () => {}
  }

  onServerRequest(_handler: (request: CodexServerRequest) => unknown): CodexUnsubscribe {
    return () => {}
  }

  onLifecycle(_listener: (event: CodexSupervisorLifecycleEvent) => void): CodexUnsubscribe {
    return () => {}
  }
}

const clients: CodexAppServerClient[] = []
const drivers: CodexAgentDriver[] = []

afterEach(async () => {
  for (const driver of drivers.splice(0)) driver.dispose()
  await Promise.allSettled(clients.splice(0).map((client) => client.close()))
})

describe('Codex 0.144.6 thread/fork protocol', () => {
  it('sends the exact typed request and decodes the typed fork response', async () => {
    const transport = new FakeTransport()
    const client = new CodexAppServerClient(transport)
    clients.push(client)
    const initializing = client.initialize({
      name: 'orchestra_test',
      title: 'Orchestra Test',
      version: '1.0.0',
    })
    transport.server({
      id: 1,
      result: {
        userAgent: 'codex-test',
        codexHome: '/tmp/codex-test',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    })
    await initializing

    const response = forkResponse(thread('thread-child', {
      forkedFromId: 'thread-source',
      turns: [{ id: 'turn-boundary', items: [], status: 'completed', error: null }],
    }))
    const pending = client.request('thread/fork', {
      threadId: 'thread-source',
      lastTurnId: 'turn-boundary',
      excludeTurns: false,
    })
    const request = JSON.parse(transport.writes[2]) as {
      id: number
      method: string
      params: unknown
    }
    expect(request).toEqual({
      id: 2,
      method: 'thread/fork',
      params: {
        threadId: 'thread-source',
        lastTurnId: 'turn-boundary',
        excludeTurns: false,
      },
    })
    transport.server({ id: request.id, result: response })

    const result = await pending
    expect(result.thread).toMatchObject({
      id: 'thread-child',
      forkedFromId: 'thread-source',
      sessionId: 'thread-child',
    })
  })

  it('maps the service wrapper without allowing an override to replace the source thread id', async () => {
    const response = forkResponse(thread('thread-child', { forkedFromId: 'thread-source' }))
    const port = new RecordingPort(response)
    const service = new CodexAppServerService(port)

    await expect(service.forkThread('thread-source', {
      threadId: 'forged-source',
      lastTurnId: 'turn-boundary',
      excludeTurns: true,
    } as Omit<CodexThreadForkParams, 'threadId'>, { timeoutMs: 9_000 })).resolves.toBe(response)

    expect(port.calls).toEqual([{
      method: 'thread/fork',
      params: {
        threadId: 'thread-source',
        lastTurnId: 'turn-boundary',
        excludeTurns: true,
      },
      options: { timeoutMs: 9_000 },
    }])
  })
})

describe('CodexAgentDriver provenance-safe native fork', () => {
  const options = (
    overrides: Partial<CodexSessionForkOptions> = {},
  ): CodexSessionForkOptions => ({
    sourceExternalId: 'thread-source',
    workspaceId: 'workspace-1',
    cwd: '/repo',
    lastTurnId: 'turn-boundary',
    excludeTurns: true,
    ...overrides,
  })

  const launch = async (service: FakeRuntimeService) => {
    const driver = new CodexAgentDriver({ service })
    drivers.push(driver)
    const session = await driver.launch({
      workspaceId: 'workspace-1',
      cwd: '/repo',
    })
    return { driver, session }
  }

  it('accepts the child-local session id used by 0.144.6 and releases the unadopted subscription', async () => {
    const service = new FakeRuntimeService()
    const { driver, session } = await launch(service)

    const result = await driver.forkSession(session.id, options({ cwd: '/repo/.' }))

    expect(service.forks).toEqual([{
      threadId: 'thread-source',
      overrides: { lastTurnId: 'turn-boundary', excludeTurns: true },
    }])
    expect(service.reads).toEqual([{ threadId: 'thread-child', includeTurns: false }])
    expect(service.unsubscribes).toEqual(['thread-child'])
    expect(result).toEqual({
      sourceExternalId: 'thread-source',
      externalId: 'thread-child',
      providerThreadId: 'thread-child',
      sourceProviderThreadId: 'thread-source',
      metadata: {
        forkMethod: 'thread/fork',
        forkedFromId: 'thread-source',
        sourceProviderSessionId: 'thread-source',
        providerSessionId: 'thread-child',
        lastTurnId: 'turn-boundary',
        excludeTurns: true,
        workspaceId: 'workspace-1',
        sourceCwd: '/repo',
        childCwd: '/repo',
        cwdVerified: true,
        workspaceVerified: true,
        readVerified: true,
        subscriptionReleased: true,
        subscriptionStatus: 'unsubscribed',
      },
    })
  })

  it('returns the created identity when unsubscribe fails so retry cannot create a duplicate fork', async () => {
    const service = new FakeRuntimeService()
    service.unsubscribeError = new Error('connection closed after fork response')
    const { driver, session } = await launch(service)

    await expect(driver.forkSession(session.id, options())).resolves.toMatchObject({
      externalId: 'thread-child',
      metadata: {
        subscriptionReleased: false,
        subscriptionStatus: null,
      },
    })
    expect(service.forks).toHaveLength(1)
    expect(service.unsubscribes).toEqual(['thread-child'])
  })

  it('returns the created identity with an explicit unverified reread when the post-fork read fails', async () => {
    const service = new FakeRuntimeService()
    service.readError = new Error('connection closed after fork response')
    const { driver, session } = await launch(service)

    await expect(driver.forkSession(session.id, options())).resolves.toMatchObject({
      externalId: 'thread-child',
      metadata: {
        readVerified: false,
        subscriptionReleased: true,
      },
    })
    expect(service.forks).toHaveLength(1)
    expect(service.reads).toEqual([{ threadId: 'thread-child', includeTurns: false }])
    expect(service.unsubscribes).toEqual(['thread-child'])
  })

  it.each([
    ['source external id', { sourceExternalId: 'thread-other' }, /source external id/],
    ['workspace', { workspaceId: 'workspace-other' }, /workspace/],
    ['cwd', { cwd: '/other' }, /cwd/],
  ])('rejects a mismatched %s before issuing thread/fork', async (_label, override, error) => {
    const service = new FakeRuntimeService()
    const { driver, session } = await launch(service)

    await expect(driver.forkSession(session.id, options(override))).rejects.toThrow(error)
    expect(service.forks).toEqual([])
    expect(service.unsubscribes).toEqual([])
  })

  it.each([
    [
      'forkedFromId',
      thread('thread-child', { forkedFromId: 'thread-other' }),
      /did not attest source thread/,
    ],
    [
      'child provider session identity',
      thread('thread-child', {
        forkedFromId: 'thread-source',
        sessionId: '',
      }),
      /returned no child provider session identity/,
    ],
    [
      'workspace cwd',
      thread('thread-child', { forkedFromId: 'thread-source', cwd: '/other' }),
      /did not preserve workspace cwd provenance/,
    ],
  ])('fails closed on invalid native %s provenance and releases the child', async (_label, child, error) => {
    const service = new FakeRuntimeService()
    service.forked = forkResponse(child)
    const { driver, session } = await launch(service)

    await expect(driver.forkSession(session.id, options())).rejects.toThrow(error)
    expect(service.forks).toHaveLength(1)
    expect(service.unsubscribes).toEqual(['thread-child'])
  })

  it('never unsubscribes the source when a malformed response reuses its thread id', async () => {
    const service = new FakeRuntimeService()
    service.forked = forkResponse(thread('thread-source', { forkedFromId: 'thread-source' }))
    const { driver, session } = await launch(service)

    await expect(driver.forkSession(session.id, options())).rejects.toThrow(/reused source thread id/)
    expect(service.unsubscribes).toEqual([])
  })

  it('fails closed when the child reread no longer attests the native source lineage', async () => {
    const service = new FakeRuntimeService()
    service.readThreadValue = thread('thread-child', { forkedFromId: 'thread-other' })
    const { driver, session } = await launch(service)

    await expect(driver.forkSession(session.id, options()))
      .rejects.toThrow(/failed native lineage reread verification/)
    expect(service.forks).toHaveLength(1)
    expect(service.unsubscribes).toEqual(['thread-child'])
  })
})

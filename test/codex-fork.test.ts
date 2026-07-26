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
  CodexForkOutcomeUnknownError,
  CodexForkVerificationError,
  type CodexSessionForkOptions,
  type CodexSessionForkVerificationOptions,
} from '../src/runtime/drivers/codex.js'

const thread = (
  id: string,
  overrides: Partial<CodexThread> = {},
): CodexThread => ({
  id,
  sessionId: `provider-session:${id}`,
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
  readonly mutations: string[] = []
  readonly forks: Array<{
    threadId: string
    overrides: Omit<CodexThreadForkParams, 'threadId'>
  }> = []
  readonly reads: Array<{ threadId: string; includeTurns: boolean | undefined }> = []
  readonly unsubscribes: string[] = []
  forked = forkResponse(thread('thread-child', {
    forkedFromId: 'thread-source',
    cwd: '/repo-child',
  }))
  forkError: Error | null = null
  readThreadValue: CodexThread | null = null
  readError: Error | null = null
  unsubscribeError: Error | null = null
  unsubscribeStatus = 'unsubscribed'
  started = thread('thread-source')

  async startThread(_params: CodexThreadStartParams): Promise<CodexThreadStartResponse> {
    this.mutations.push('thread/start')
    return startResponse(this.started)
  }

  async resumeThread(
    _threadId: string,
    _overrides?: Omit<CodexThreadResumeParams, 'threadId'>,
  ): Promise<CodexThreadResumeResponse> {
    this.mutations.push('thread/resume')
    throw new Error('not used')
  }

  async forkThread(
    threadId: string,
    overrides: Omit<CodexThreadForkParams, 'threadId'> = {},
  ): Promise<CodexThreadForkResponse> {
    this.mutations.push('thread/fork')
    this.forks.push({ threadId, overrides })
    if (this.forkError) throw this.forkError
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
    this.mutations.push('thread/unsubscribe')
    this.unsubscribes.push(threadId)
    if (this.unsubscribeError) throw this.unsubscribeError
    return { status: this.unsubscribeStatus }
  }

  async startTurn(
    _threadId: string,
    _input: string | CodexUserInput[],
    _overrides?: Omit<CodexTurnStartParams, 'threadId' | 'input'>,
  ): Promise<CodexTurnStartResponse> {
    this.mutations.push('turn/start')
    throw new Error('not used')
  }

  async steerTurn(): Promise<CodexTurnSteerResponse> {
    this.mutations.push('turn/steer')
    throw new Error('not used')
  }

  async interruptTurn(): Promise<void> {
    this.mutations.push('turn/interrupt')
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
      cwd: '/repo-child',
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
        cwd: '/repo-child',
      },
    })
    transport.server({ id: request.id, result: response })

    const result = await pending
    expect(result.thread).toMatchObject({
      id: 'thread-child',
      forkedFromId: 'thread-source',
      sessionId: 'provider-session:thread-child',
    })
  })

  it('maps the service wrapper without allowing an override to replace the source thread id', async () => {
    const response = forkResponse(thread('thread-child', { forkedFromId: 'thread-source' }))
    const port = new RecordingPort(response)
    const service = new CodexAppServerService(port)

    await expect(service.forkThread('thread-source', {
      threadId: 'forged-source',
      lastTurnId: 'turn-boundary',
      cwd: '/repo-child',
      excludeTurns: true,
    } as Omit<CodexThreadForkParams, 'threadId'>, { timeoutMs: 9_000 })).resolves.toBe(response)

    expect(port.calls).toEqual([{
      method: 'thread/fork',
      params: {
        threadId: 'thread-source',
        lastTurnId: 'turn-boundary',
        cwd: '/repo-child',
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
    sourceWorkspaceId: 'workspace-1',
    sourceCwd: '/repo',
    targetWorkspaceId: 'workspace-child',
    targetCwd: '/repo-child',
    lastTurnId: 'turn-boundary',
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

  it('uses forkedFromId rather than session-id equality and releases the unadopted subscription', async () => {
    const service = new FakeRuntimeService()
    const { driver, session } = await launch(service)

    const result = await driver.forkSession(session.id, options({
      sourceCwd: '/repo/.',
      targetCwd: '/repo-child/.',
    }))

    expect(service.forks).toEqual([{
      threadId: 'thread-source',
      overrides: {
        lastTurnId: 'turn-boundary',
        cwd: '/repo-child',
      },
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
        sourceProviderSessionId: 'provider-session:thread-source',
        providerSessionId: 'provider-session:thread-child',
        lastTurnId: 'turn-boundary',
        sourceWorkspaceId: 'workspace-1',
        sourceCwd: '/repo',
        targetWorkspaceId: 'workspace-child',
        targetWorkspaceAttestation: {
          value: 'workspace-child',
          authority: 'orchestrator',
        },
        targetCwd: '/repo-child',
        childCwd: '/repo-child',
        cwdVerified: true,
        workspaceBindingVerified: true,
        workspaceBindingAuthority: 'orchestrator',
        readVerified: true,
        threadReadVerified: true,
        subscriptionReleased: true,
        childUnsubscribeVerified: true,
        subscriptionStatus: 'unsubscribed',
        verificationMethod: 'thread/fork+thread/read',
      },
    })
  })

  it('omits experimental excludeTurns from the ordinary default-capability fork request', async () => {
    const service = new FakeRuntimeService()
    const { driver, session } = await launch(service)

    await driver.forkSession(session.id, options({ lastTurnId: undefined }))

    expect(service.forks).toEqual([{
      threadId: 'thread-source',
      overrides: { cwd: '/repo-child' },
    }])
  })

  it.each(['notSubscribed', 'notLoaded'])(
    'accepts the exact %s status as proof that no child subscription remains',
    async (status) => {
      const service = new FakeRuntimeService()
      service.unsubscribeStatus = status
      const { driver, session } = await launch(service)

      await expect(driver.forkSession(session.id, options())).resolves.toMatchObject({
        metadata: {
          subscriptionStatus: status,
          subscriptionReleased: true,
          childUnsubscribeVerified: true,
        },
      })
    },
  )

  it('quarantines the known child when unsubscribe proof is unavailable', async () => {
    const service = new FakeRuntimeService()
    service.unsubscribeError = new Error('connection closed after fork response')
    const { driver, session } = await launch(service)

    await expect(driver.forkSession(session.id, options())).rejects.toMatchObject({
      outcomeUnknown: true,
      knownChild: {
        externalId: 'thread-child',
        providerThreadId: 'thread-child',
        forkedFromId: 'thread-source',
        childProviderSessionId: 'provider-session:thread-child',
        subscriptionReleased: false,
      },
    })
    expect(service.forks).toHaveLength(1)
    expect(service.reads).toEqual([{ threadId: 'thread-child', includeTurns: false }])
    expect(service.unsubscribes).toEqual(['thread-child'])
  })

  it('rejects an unrecognized unsubscribe status as missing release proof', async () => {
    const service = new FakeRuntimeService()
    service.unsubscribeStatus = 'future-or-malformed-status'
    const { driver, session } = await launch(service)

    await expect(driver.forkSession(session.id, options())).rejects.toMatchObject({
      outcomeUnknown: true,
      knownChild: {
        externalId: 'thread-child',
        subscriptionReleased: false,
      },
    })
    expect(service.reads).toEqual([{ threadId: 'thread-child', includeTurns: false }])
    expect(service.unsubscribes).toEqual(['thread-child'])
  })

  it('classifies a rejected native fork as outcome-unknown without exposing the raw error', async () => {
    const service = new FakeRuntimeService()
    service.forkError = new Error('raw transport detail must not escape')
    const { driver, session } = await launch(service)

    let caught: unknown
    try {
      await driver.forkSession(session.id, options())
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CodexForkOutcomeUnknownError)
    expect(caught).toMatchObject({
      outcomeUnknown: true,
      sourceExternalId: 'thread-source',
      sourceProviderThreadId: 'thread-source',
      knownChild: null,
    })
    expect((caught as Error).message).not.toContain('raw transport detail')
    expect(caught).not.toHaveProperty('cause')
    expect(service.forks).toHaveLength(1)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['missing thread', {}],
  ])('classifies a resolved malformed %s response as outcome-unknown', async (_label, response) => {
    const service = new FakeRuntimeService()
    service.forked = response as unknown as CodexThreadForkResponse
    const { driver, session } = await launch(service)

    let caught: unknown
    try {
      await driver.forkSession(session.id, options())
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CodexForkOutcomeUnknownError)
    expect(caught).toMatchObject({
      outcomeUnknown: true,
      sourceExternalId: 'thread-source',
      sourceProviderThreadId: 'thread-source',
      knownChild: null,
    })
    expect(caught).not.toHaveProperty('cause')
    expect(JSON.stringify(caught)).not.toContain('/repo')
    expect(service.forks).toHaveLength(1)
    expect(service.unsubscribes).toEqual([])
  })

  it('quarantines the known child when the mandatory post-fork reread fails', async () => {
    const service = new FakeRuntimeService()
    service.readError = new Error('connection closed after fork response')
    const { driver, session } = await launch(service)

    await expect(driver.forkSession(session.id, options())).rejects.toMatchObject({
      outcomeUnknown: true,
      knownChild: {
        externalId: 'thread-child',
        providerThreadId: 'thread-child',
        forkedFromId: 'thread-source',
        childProviderSessionId: 'provider-session:thread-child',
        subscriptionReleased: true,
      },
    })
    expect(service.forks).toHaveLength(1)
    expect(service.reads).toEqual([{ threadId: 'thread-child', includeTurns: false }])
    expect(service.unsubscribes).toEqual(['thread-child'])
  })

  it.each([
    ['source external id', { sourceExternalId: 'thread-other' }, /source external id/],
    ['source workspace', { sourceWorkspaceId: 'workspace-other' }, /source workspace/],
    ['source cwd', { sourceCwd: '/other' }, /source cwd/],
    ['target workspace', { targetWorkspaceId: 'workspace-1' }, /target workspace/],
    ['target cwd', { targetCwd: '/repo' }, /target cwd/],
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

  it('preserves safe known-child evidence when response provenance and cleanup both fail', async () => {
    const service = new FakeRuntimeService()
    service.forked = forkResponse(thread('thread-child', { forkedFromId: 'thread-other' }))
    service.unsubscribeError = new Error('raw cleanup transport detail')
    const { driver, session } = await launch(service)

    let caught: unknown
    try {
      await driver.forkSession(session.id, options())
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CodexForkOutcomeUnknownError)
    expect(caught).toMatchObject({
      outcomeUnknown: true,
      sourceExternalId: 'thread-source',
      sourceProviderThreadId: 'thread-source',
      knownChild: {
        externalId: 'thread-child',
        providerThreadId: 'thread-child',
        forkedFromId: 'thread-other',
        childProviderSessionId: 'provider-session:thread-child',
        subscriptionReleased: false,
      },
    })
    expect(JSON.stringify(caught)).not.toContain('raw cleanup transport detail')
    expect(service.unsubscribes).toEqual(['thread-child'])
  })

  it('never unsubscribes the source when a malformed response reuses its thread id', async () => {
    const service = new FakeRuntimeService()
    service.forked = forkResponse(thread('thread-source', { forkedFromId: 'thread-source' }))
    const { driver, session } = await launch(service)

    let caught: unknown
    try {
      await driver.forkSession(session.id, options())
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CodexForkOutcomeUnknownError)
    expect(caught).toMatchObject({ outcomeUnknown: true, knownChild: null })
    expect((caught as Error).message).toMatch(/reused source thread id/)
    expect(service.unsubscribes).toEqual([])
  })

  it('never reads or unsubscribes another managed thread named by a malformed fork response', async () => {
    const service = new FakeRuntimeService()
    const driver = new CodexAgentDriver({ service })
    drivers.push(driver)
    const sourceSession = await driver.launch({
      workspaceId: 'workspace-1',
      cwd: '/repo',
    })
    service.started = thread('thread-managed', { cwd: '/repo-child' })
    await driver.launch({
      workspaceId: 'workspace-managed',
      cwd: '/repo-child',
    })
    service.forked = forkResponse(thread('thread-managed', {
      forkedFromId: 'thread-source',
      cwd: '/repo-child',
    }))

    await expect(driver.forkSession(sourceSession.id, options())).rejects.toMatchObject({
      outcomeUnknown: true,
      knownChild: null,
    })
    expect(service.forks).toHaveLength(1)
    expect(service.reads).toEqual([])
    expect(service.unsubscribes).toEqual([])
  })

  it.each([
    [
      'child identity',
      thread('thread-other', { forkedFromId: 'thread-source', cwd: '/repo-child' }),
    ],
    [
      'source lineage',
      thread('thread-child', { forkedFromId: 'thread-other', cwd: '/repo-child' }),
    ],
    [
      'provider session identity',
      thread('thread-child', {
        forkedFromId: 'thread-source',
        sessionId: 'provider-session:other',
        cwd: '/repo-child',
      }),
    ],
    [
      'target cwd',
      thread('thread-child', { forkedFromId: 'thread-source', cwd: '/other' }),
    ],
  ])('fails closed when the child reread mismatches %s', async (_label, reread) => {
    const service = new FakeRuntimeService()
    service.readThreadValue = reread
    const { driver, session } = await launch(service)

    let caught: unknown
    try {
      await driver.forkSession(session.id, options())
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CodexForkOutcomeUnknownError)
    expect(caught).toMatchObject({
      outcomeUnknown: true,
      sourceExternalId: 'thread-source',
      sourceProviderThreadId: 'thread-source',
      knownChild: {
        externalId: 'thread-child',
        providerThreadId: 'thread-child',
        forkedFromId: 'thread-source',
        childProviderSessionId: 'provider-session:thread-child',
        subscriptionReleased: true,
      },
    })
    expect((caught as Error).message).toMatch(/failed native lineage reread verification/)
    expect(service.forks).toHaveLength(1)
    expect(service.unsubscribes).toEqual(['thread-child'])
  })
})

describe('CodexAgentDriver read-only native fork verification', () => {
  const verificationOptions = (
    overrides: Partial<CodexSessionForkVerificationOptions> = {},
  ): CodexSessionForkVerificationOptions => ({
    sourceExternalId: 'thread-source',
    sourceProviderThreadId: 'thread-source',
    childExternalId: 'thread-child',
    childProviderThreadId: 'thread-child',
    childProviderSessionId: 'provider-session:thread-child',
    sourceWorkspaceId: 'workspace-1',
    sourceCwd: '/repo',
    targetWorkspaceId: 'workspace-child',
    targetCwd: '/repo-child',
    ...overrides,
  })

  it('accepts the exact lifecycle shape, performs only thread/read, and returns typed proof', async () => {
    const service = new FakeRuntimeService()
    service.readThreadValue = thread('thread-child', {
      forkedFromId: 'thread-source',
      cwd: '/repo-child',
    })
    const driver = new CodexAgentDriver({ service })
    drivers.push(driver)
    const { sourceProviderThreadId: _derivedSourceThreadId, ...lifecycleOptions } =
      verificationOptions()

    const result = await driver.verifyForkSession(lifecycleOptions)

    expect(service.reads).toEqual([{ threadId: 'thread-child', includeTurns: false }])
    expect(service.forks).toEqual([])
    expect(service.unsubscribes).toEqual([])
    expect(service.mutations).toEqual([])
    expect(result).toEqual({
      sourceExternalId: 'thread-source',
      externalId: 'thread-child',
      sourceProviderThreadId: 'thread-source',
      providerThreadId: 'thread-child',
      proof: {
        status: 'verified',
        sourceExternalId: 'thread-source',
        sourceProviderThreadId: 'thread-source',
        childExternalId: 'thread-child',
        childProviderThreadId: 'thread-child',
        childProviderSessionId: 'provider-session:thread-child',
        targetCwd: '/repo-child',
        targetWorkspaceAttestation: {
          value: 'workspace-child',
          authority: 'orchestrator',
        },
        read: {
          method: 'thread/read',
          includeTurns: false,
          verified: true,
        },
      },
      metadata: {
        forkMethod: 'thread/fork',
        verificationMethod: 'thread/read',
        forkedFromId: 'thread-source',
        providerSessionId: 'provider-session:thread-child',
        lastTurnId: null,
        sourceWorkspaceId: 'workspace-1',
        sourceCwd: '/repo',
        targetWorkspaceId: 'workspace-child',
        targetWorkspaceAttestation: {
          value: 'workspace-child',
          authority: 'orchestrator',
        },
        targetCwd: '/repo-child',
        childCwd: '/repo-child',
        cwdVerified: true,
        workspaceBindingVerified: true,
        workspaceBindingAuthority: 'orchestrator',
        readVerified: true,
        threadReadVerified: true,
      },
    })
    expect(result.metadata).not.toHaveProperty('subscriptionReleased')
    expect(result.metadata).not.toHaveProperty('childUnsubscribeVerified')
  })

  it('also supports the explicit child-id overload without gaining mutation authority', async () => {
    const service = new FakeRuntimeService()
    service.readThreadValue = thread('thread-child', {
      forkedFromId: 'thread-source',
      cwd: '/repo-child',
    })
    const driver = new CodexAgentDriver({ service })
    drivers.push(driver)
    const { childExternalId, ...context } = verificationOptions()

    await expect(driver.verifyForkSession(childExternalId, context)).resolves.toMatchObject({
      externalId: 'thread-child',
      proof: {
        read: { method: 'thread/read', includeTurns: false, verified: true },
      },
    })
    expect(service.reads).toEqual([{ threadId: 'thread-child', includeTurns: false }])
    expect(service.forks).toEqual([])
    expect(service.unsubscribes).toEqual([])
    expect(service.mutations).toEqual([])
  })

  it('returns a safe typed quarantine failure when thread/read fails', async () => {
    const service = new FakeRuntimeService()
    service.readError = new Error('raw credential and /private/target must not escape')
    const driver = new CodexAgentDriver({ service })
    drivers.push(driver)

    let caught: unknown
    try {
      await driver.verifyForkSession(verificationOptions())
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CodexForkVerificationError)
    expect(caught).toMatchObject({
      quarantined: true,
      code: 'read_failed',
      sourceExternalId: 'thread-source',
      sourceProviderThreadId: 'thread-source',
      knownChild: {
        externalId: 'thread-child',
        providerThreadId: 'thread-child',
        forkedFromId: null,
        childProviderSessionId: null,
      },
    })
    expect(caught).not.toHaveProperty('cause')
    expect(JSON.stringify(caught)).not.toContain('raw credential')
    expect(JSON.stringify(caught)).not.toContain('/private/target')
    expect(service.reads).toEqual([{ threadId: 'thread-child', includeTurns: false }])
    expect(service.forks).toEqual([])
    expect(service.unsubscribes).toEqual([])
    expect(service.mutations).toEqual([])
  })

  it.each([
    [
      'child identity',
      thread('thread-other', { forkedFromId: 'thread-source', cwd: '/repo-child' }),
      'child_identity_mismatch',
    ],
    [
      'source lineage',
      thread('thread-child', { forkedFromId: 'thread-other', cwd: '/repo-child' }),
      'lineage_mismatch',
    ],
    [
      'provider session identity',
      thread('thread-child', {
        forkedFromId: 'thread-source',
        sessionId: 'provider-session:other',
        cwd: '/repo-child',
      }),
      'provider_session_mismatch',
    ],
    [
      'target cwd',
      thread('thread-child', { forkedFromId: 'thread-source', cwd: '/other' }),
      'cwd_mismatch',
    ],
  ])('quarantines a mismatched %s without any mutation', async (_label, value, code) => {
    const service = new FakeRuntimeService()
    service.readThreadValue = value
    const driver = new CodexAgentDriver({ service })
    drivers.push(driver)

    await expect(driver.verifyForkSession(verificationOptions())).rejects.toMatchObject({
      quarantined: true,
      code,
    })
    expect(service.reads).toEqual([{ threadId: 'thread-child', includeTurns: false }])
    expect(service.forks).toEqual([])
    expect(service.unsubscribes).toEqual([])
    expect(service.mutations).toEqual([])
  })

  it('rejects source-as-child before issuing even a read', async () => {
    const service = new FakeRuntimeService()
    const driver = new CodexAgentDriver({ service })
    drivers.push(driver)

    await expect(driver.verifyForkSession(verificationOptions({
      childExternalId: 'thread-source',
      childProviderThreadId: 'thread-source',
    }))).rejects.toMatchObject({
      quarantined: true,
      code: 'invalid_request',
    })
    expect(service.reads).toEqual([])
    expect(service.forks).toEqual([])
    expect(service.unsubscribes).toEqual([])
    expect(service.mutations).toEqual([])
  })
})

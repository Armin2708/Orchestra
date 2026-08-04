import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_REQUEST_UNHANDLED, CodexRpcResponseError } from '../src/codex/client.js'
import type {
  CodexServerNotification,
  CodexServerRequest,
  CodexThread,
  CodexThreadReadResponse,
  CodexThreadResumeResponse,
  CodexThreadStartResponse,
  CodexTurnStartResponse,
} from '../src/codex/protocol.js'
import type { CodexRuntimeService } from '../src/codex/service.js'
import type { CodexSupervisorLifecycleEvent } from '../src/codex/supervisor.js'
import type { CodexUnsubscribe } from '../src/codex/transport.js'
import {
  CodexAgentDriver,
  type CodexDriverApprovalRequest,
} from '../src/runtime/drivers/codex.js'
import type { DriverEvent } from '../src/runtime/types.js'

const thread = (id: string, turns: CodexThread['turns'] = [], status: CodexThread['status'] = { type: 'idle' }): CodexThread => ({
  id,
  sessionId: `session-${id}`,
  parentThreadId: null,
  status,
  cwd: '/repo',
  cliVersion: '0.144.6',
  agentNickname: null,
  agentRole: null,
  createdAt: 1_700_000_000,
  turns,
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

class FakeService {
  readonly notifications = new Set<(notification: CodexServerNotification) => void>()
  readonly serverRequests = new Set<(request: CodexServerRequest) => unknown | Promise<unknown>>()
  readonly lifecycle = new Set<(event: CodexSupervisorLifecycleEvent) => void>()
  readonly starts: unknown[] = []
  readonly resumes: string[] = []
  readonly reads: string[] = []
  readonly turnStarts: Array<{ threadId: string; input: unknown; overrides: unknown }> = []
  readonly steers: Array<{ threadId: string; turnId: string; input: unknown }> = []
  readonly interrupts: Array<{ threadId: string; turnId: string }> = []
  readonly unsubscribes: string[] = []
  nextThread = thread('thread-new')
  readThreadValue = this.nextThread
  resumeError: unknown
  nextTurn = 1

  async startThread(params: unknown): Promise<CodexThreadStartResponse> {
    this.starts.push(params)
    return startResponse(this.nextThread)
  }

  async resumeThread(threadId: string): Promise<CodexThreadResumeResponse> {
    this.resumes.push(threadId)
    if (this.resumeError) throw this.resumeError
    return startResponse(this.readThreadValue)
  }

  async readThread(threadId: string): Promise<CodexThreadReadResponse> {
    this.reads.push(threadId)
    return { thread: this.readThreadValue }
  }

  async unsubscribeThread(threadId: string): Promise<{ status: string }> {
    this.unsubscribes.push(threadId)
    return { status: 'unsubscribed' }
  }

  async startTurn(threadId: string, input: unknown, overrides: unknown = {}): Promise<CodexTurnStartResponse> {
    this.turnStarts.push({ threadId, input, overrides })
    return { turn: { id: `turn-${this.nextTurn++}`, items: [], status: 'inProgress', error: null } }
  }

  async steerTurn(threadId: string, expectedTurnId: string, input: unknown): Promise<{ turnId: string }> {
    this.steers.push({ threadId, turnId: expectedTurnId, input })
    return { turnId: expectedTurnId }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId })
  }

  async listModelsPage(): Promise<never> { throw new Error('not used') }
  async listModels(): Promise<never> { throw new Error('not used') }
  async readAccount(): Promise<never> { throw new Error('not used') }
  async readRateLimits(): Promise<never> { throw new Error('not used') }
  async readUsage(): Promise<never> { throw new Error('not used') }

  onNotification(listener: (notification: CodexServerNotification) => void): CodexUnsubscribe {
    this.notifications.add(listener)
    return () => this.notifications.delete(listener)
  }

  onServerRequest(handler: (request: CodexServerRequest) => unknown | Promise<unknown>): CodexUnsubscribe {
    this.serverRequests.add(handler)
    return () => this.serverRequests.delete(handler)
  }

  onLifecycle(listener: (event: CodexSupervisorLifecycleEvent) => void): CodexUnsubscribe {
    this.lifecycle.add(listener)
    return () => this.lifecycle.delete(listener)
  }

  emit(method: string, params: unknown): void {
    const notification = { method, params, receivedAt: '2026-07-19T12:00:00.000Z' }
    for (const listener of [...this.notifications]) listener(notification)
  }

  emitLifecycle(type: CodexSupervisorLifecycleEvent['type']): void {
    const event: CodexSupervisorLifecycleEvent = {
      type,
      state: type === 'connected' ? 'running' : type === 'restart_exhausted' ? 'failed' : 'restarting',
      at: '2026-07-19T12:00:00.000Z',
      generation: 2,
      attempt: 1,
      ...(type === 'restart_exhausted' ? { error: 'restart budget exhausted' } : {}),
    }
    for (const listener of [...this.lifecycle]) listener(event)
  }

  async request(request: CodexServerRequest): Promise<unknown> {
    for (const handler of [...this.serverRequests]) {
      const result = await handler(request)
      if (result !== CODEX_REQUEST_UNHANDLED) return result
    }
    return CODEX_REQUEST_UNHANDLED
  }

  asPort(): CodexRuntimeService {
    return this as unknown as CodexRuntimeService
  }
}

const drivers: CodexAgentDriver[] = []

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.dispose()
})

const next = async (iterator: AsyncIterator<DriverEvent>): Promise<DriverEvent> => {
  const result = await iterator.next()
  if (result.done) throw new Error('event stream ended')
  return result.value
}

const untilExit = async (iterator: AsyncIterator<DriverEvent>): Promise<DriverEvent> => {
  for (;;) {
    const event = await next(iterator)
    if (event.type === 'exit') return event
  }
}

describe('Codex AgentDriver lifecycle', () => {
  it('maps launch, active steering, idle turns, interrupt, and stop to app-server calls', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    const session = await driver.launch({
      workspaceId: 'workspace-1',
      cwd: '/repo',
      model: 'gpt-test',
      permissionMode: 'workspace-write',
      prompt: 'Implement it',
      metadata: { effort: 'high', serviceTier: 'fast' },
    })

    expect(driver.capabilities()).toMatchObject({ attach: true, streaming: true, interrupt: true, resume: true })
    expect(session).toMatchObject({
      id: 'codex:thread-new',
      externalId: 'thread-new',
      driverId: 'codex',
      workspaceId: 'workspace-1',
      status: 'running',
      metadata: {
        threadId: 'thread-new', cliVersion: '0.144.6', currentTurnId: 'turn-1',
        resolvedModel: 'gpt-test', resolvedEffort: 'high',
      },
    })
    expect(service.starts[0]).toMatchObject({
      cwd: '/repo', model: 'gpt-test', sandbox: 'workspace-write', approvalPolicy: 'on-request', serviceTier: 'fast',
    })
    expect(service.turnStarts[0]).toMatchObject({ threadId: 'thread-new', input: 'Implement it', overrides: { effort: 'high' } })

    await driver.send(session.id, 'Steer this turn')
    expect(service.steers).toEqual([{ threadId: 'thread-new', turnId: 'turn-1', input: 'Steer this turn' }])
    service.emit('turn/completed', {
      threadId: 'thread-new',
      turn: { id: 'turn-1', items: [], status: 'completed', error: null },
    })
    await driver.send(session.id, 'Start another turn')
    expect(service.turnStarts.at(-1)).toMatchObject({ threadId: 'thread-new', input: 'Start another turn' })
    await driver.interrupt(session.id)
    expect(service.interrupts.at(-1)).toEqual({ threadId: 'thread-new', turnId: 'turn-2' })

    const iterator = driver.events(session.id)[Symbol.asyncIterator]()
    await driver.stop(session.id)
    const exit = await untilExit(iterator)
    expect(exit).toMatchObject({ type: 'exit', data: 'Codex session stopped', metadata: { unsubscribeStatus: 'unsubscribed' } })
    expect(service.unsubscribes).toEqual(['thread-new'])
    expect(session.status).toBe('stopped')
  })

  it('resumes and reads a thread before attaching, restoring its active turn', async () => {
    const service = new FakeService()
    service.readThreadValue = thread('thread-existing', [
      { id: 'turn-active', items: [], status: 'inProgress', error: null },
    ], { type: 'active', activeFlags: [] })
    const driver = new CodexAgentDriver({
      service: service.asPort(),
      workspaceForThread: (threadId) => threadId === 'thread-existing' ? 'workspace-existing' : undefined,
    })
    drivers.push(driver)

    const session = await driver.attach('thread-existing')
    expect(session).toMatchObject({
      id: 'codex:thread-existing', workspaceId: 'workspace-existing', status: 'running',
      metadata: { currentTurnId: 'turn-active', resolvedModel: 'gpt-test', resolvedEffort: 'high' },
    })
    expect(service.resumes).toEqual(['thread-existing'])
    expect(service.reads).toEqual(['thread-existing'])
    await driver.send(session!.id, 'continue')
    expect(service.steers).toEqual([{ threadId: 'thread-existing', turnId: 'turn-active', input: 'continue' }])
    await expect(driver.attach('thread-existing')).rejects.toThrow('already attached by this daemon')
  })

  it('replays a terminal turn found while attaching so durable consumers cannot hang', async () => {
    const service = new FakeService()
    service.readThreadValue = thread('thread-completed', [
      { id: 'turn-completed-offline', items: [], status: 'completed', error: null },
    ])
    const driver = new CodexAgentDriver({
      service: service.asPort(),
      workspaceForThread: () => 'workspace-completed',
    })
    drivers.push(driver)

    const session = await driver.attach('thread-completed')
    const event = await next(driver.events(session!.id)[Symbol.asyncIterator]())

    expect(event).toMatchObject({
      type: 'status', data: 'Codex turn completed',
      metadata: {
        method: 'turn/completed', turnId: 'turn-completed-offline', turnCompleted: true,
        replayed: true, reconnectReason: 'daemon-attach',
      },
    })
  })

  it('reports interrupted turns as failures to durable job consumers', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    const session = await driver.launch({ workspaceId: 'workspace-interrupted', cwd: '/repo', prompt: 'work' })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()

    service.emit('turn/completed', {
      threadId: 'thread-new',
      turn: { id: 'turn-1', items: [], status: 'interrupted', error: null },
    })

    expect(await next(iterator)).toMatchObject({
      type: 'error', data: 'Codex turn interrupted',
      metadata: { turnCompleted: true, status: 'interrupted' },
    })
  })

  it('detaches without interrupting the active turn so the thread remains resumable', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    const session = await driver.launch({ workspaceId: 'workspace-detach', cwd: '/repo', prompt: 'keep working' })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()

    await driver.detach(session.id)

    expect(service.interrupts).toEqual([])
    expect(service.unsubscribes).toEqual(['thread-new'])
    expect(await untilExit(iterator)).toMatchObject({
      type: 'exit', data: 'Codex session detached', metadata: { detached: true, unsubscribeStatus: 'unsubscribed' },
    })
  })

  it('returns null for a missing thread and requires a workspace resolver for durable attach', async () => {
    const missing = new FakeService()
    missing.resumeError = new CodexRpcResponseError('thread/resume', { code: -32602, message: 'thread not found' })
    const missingDriver = new CodexAgentDriver({ service: missing.asPort() })
    drivers.push(missingDriver)
    await expect(missingDriver.attach('missing')).resolves.toBeNull()

    const unresolved = new FakeService()
    unresolved.readThreadValue = thread('known')
    const unresolvedDriver = new CodexAgentDriver({ service: unresolved.asPort() })
    drivers.push(unresolvedDriver)
    await expect(unresolvedDriver.attach('known')).rejects.toThrow('workspace for Codex thread known is unknown')
  })

  it('maps Claude bypass-permissions to full-auto Codex: danger sandbox, never ask', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    await driver.launch({
      workspaceId: 'workspace-1', cwd: '/repo', permissionMode: 'bypassPermissions',
    })
    expect(service.starts[0]).toMatchObject({
      sandbox: 'danger-full-access', approvalPolicy: 'never',
    })
  })

  it('launches full-access profiles as full-auto: danger sandbox, never ask', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    const session = await driver.launch({
      workspaceId: 'workspace-1', cwd: '/repo', accessProfile: 'full_access',
    } as any)
    expect(service.starts[0]).toMatchObject({
      sandbox: 'danger-full-access', approvalPolicy: 'never',
    })
    await driver.updateSession(session.id, { accessProfile: 'full_access' })
    await driver.send(session.id, 'go')
    expect(service.turnStarts.at(-1)).toMatchObject({
      overrides: {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    })
  })

  it('automatically resumes and rereads known threads after supervisor reconnect', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    const session = await driver.launch({ workspaceId: 'workspace-reconnect', cwd: '/repo' })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()
    service.readThreadValue = thread('thread-new', [
      { id: 'turn-after-restart', items: [], status: 'inProgress', error: null },
    ], { type: 'active', activeFlags: [] })

    service.emitLifecycle('connected')
    const result = await driver.reconcileSessions()
    expect(result).toEqual({ resumed: ['thread-new'], failed: [] })
    expect(service.resumes).toEqual(['thread-new'])
    expect(service.reads).toEqual(['thread-new'])
    expect(session).toMatchObject({ status: 'running', metadata: { currentTurnId: 'turn-after-restart' } })
    expect(await next(iterator)).toMatchObject({
      type: 'status', data: 'Codex session resumed after app-server reconnect', metadata: { reconnected: true },
    })
  })

  it('replays a turn that completed while the app-server was reconnecting', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    const session = await driver.launch({ workspaceId: 'workspace-replay', cwd: '/repo', prompt: 'work' })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()
    service.readThreadValue = thread('thread-new', [
      { id: 'turn-1', items: [], status: 'completed', error: null },
    ])

    await expect(driver.reconcileSessions()).resolves.toEqual({ resumed: ['thread-new'], failed: [] })
    expect(await next(iterator)).toMatchObject({ type: 'status', metadata: { reconnected: true } })
    expect(await next(iterator)).toMatchObject({
      type: 'status', data: 'Codex turn completed',
      metadata: { turnCompleted: true, replayed: true, reconnectReason: 'app-server-reconnect' },
    })
  })

  it('terminalizes a session when reconnect recovery fails instead of leaving its event stream open', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    const session = await driver.launch({ workspaceId: 'workspace-lost', cwd: '/repo' })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()
    service.resumeError = new Error('app-server could not restore the thread')

    await expect(driver.reconcileSessions()).resolves.toEqual({ resumed: [], failed: ['thread-new'] })
    expect(await next(iterator)).toMatchObject({ type: 'error', metadata: { reconnected: false } })
    expect(await next(iterator)).toMatchObject({
      type: 'exit', data: 'Codex session lost after reconnect failure',
      metadata: { lost: true, reconnectFailed: true },
    })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('terminalizes active sessions when app-server restart attempts are exhausted', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    const session = await driver.launch({ workspaceId: 'workspace-exhausted', cwd: '/repo' })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()

    service.emitLifecycle('restart_exhausted')

    expect(await next(iterator)).toMatchObject({
      type: 'error', data: 'restart budget exhausted', metadata: { restartExhausted: true },
    })
    expect(await next(iterator)).toMatchObject({
      type: 'exit', data: 'Codex session lost after app-server restart exhaustion',
      metadata: { lost: true, reconnectFailed: true, restartExhausted: true },
    })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })
})

describe('Codex AgentDriver event normalization', () => {
  it('emits output, usage, subagent, unknown-native, approval, and exit metadata', async () => {
    const service = new FakeService()
    const approvals: CodexDriverApprovalRequest[] = []
    const driver = new CodexAgentDriver({
      service: service.asPort(),
      onApprovalRequest: (request) => {
        approvals.push(request)
        return { decision: 'accept' }
      },
    })
    drivers.push(driver)
    const session = await driver.launch({ workspaceId: 'workspace-events', cwd: '/repo' })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()

    service.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-a', itemId: 'message-a', delta: 'hello ',
    })
    expect(await next(iterator)).toMatchObject({
      type: 'output', data: 'hello ', metadata: { nativeMethod: 'item/agentMessage/delta', turnId: 'turn-a' },
    })

    service.emit('thread/tokenUsage/updated', {
      threadId: 'thread-new',
      turnId: 'turn-a',
      tokenUsage: {
        total: { totalTokens: 120, inputTokens: 80, cachedInputTokens: 30, outputTokens: 40, reasoningOutputTokens: 10 },
        last: { totalTokens: 20, inputTokens: 10, cachedInputTokens: 3, outputTokens: 10, reasoningOutputTokens: 2 },
        modelContextWindow: 200_000,
      },
    })
    expect(await next(iterator)).toMatchObject({
      type: 'status', metadata: { tokens: 120, usage: { total: { cachedInputTokens: 30 } } },
    })

    service.emit('item/completed', {
      threadId: 'thread-new', turnId: 'turn-a', completedAtMs: 1_700_000_000_000,
      item: {
        type: 'collabAgentToolCall', id: 'collab-a', tool: 'spawn_agent', senderThreadId: 'thread-new',
        receiverThreadIds: ['thread-child'], agentsStates: { 'thread-child': { status: 'running' } },
      },
    })
    expect(await next(iterator)).toMatchObject({
      type: 'tool', metadata: { subagents: { receiverThreadIds: ['thread-child'] } },
    })

    service.emit('future/threadFeature', { threadId: 'thread-new', futureValue: true })
    expect(await next(iterator)).toMatchObject({
      type: 'status', data: 'future/threadFeature', metadata: { unknownNativeEvent: true, native: { futureValue: true } },
    })

    const approvalResult = await service.request({
      id: 'approval-a',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-new', turnId: 'turn-a', itemId: 'command-a', command: 'npm test' },
      receivedAt: '2026-07-19T12:00:00.000Z',
    })
    expect(approvalResult).toEqual({ decision: 'accept' })
    expect(approvals).toEqual([expect.objectContaining({
      kind: 'command', sessionId: session.id, threadId: 'thread-new', requestId: 'approval-a',
    })])
    expect(await next(iterator)).toMatchObject({
      type: 'tool', metadata: {
        approval: true,
        kind: 'approval',
        requestId: 'approval-a',
        approvalKind: 'command',
      },
    })

    await driver.stop(session.id)
    expect(await next(iterator)).toMatchObject({
      type: 'exit', metadata: { tokens: 120, usage: { total: { totalTokens: 120 } } },
    })
  })

  it('does not duplicate a completed agent message after streaming deltas', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    const session = await driver.launch({ workspaceId: 'workspace-events', cwd: '/repo' })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()
    service.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-a', itemId: 'message-a', delta: 'streamed',
    })
    expect((await next(iterator)).data).toBe('streamed')
    service.emit('item/completed', {
      threadId: 'thread-new', turnId: 'turn-a', item: { type: 'agentMessage', id: 'message-a', text: 'streamed' },
    })
    await driver.stop(session.id)
    expect(await next(iterator)).toMatchObject({ type: 'exit' })
  })

  it('applies session updates on the next idle turn and resolves deferred approvals', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({
      service: service.asPort(),
      approvalTimeoutMs: 1_000,
      onApprovalRequest: () => CODEX_REQUEST_UNHANDLED,
    })
    drivers.push(driver)
    const session = await driver.launch({
      workspaceId: 'workspace-updates',
      cwd: '/repo',
      accessProfile: 'read_only',
    } as Parameters<CodexAgentDriver['launch']>[0] & { accessProfile: 'read_only' })
    await driver.updateSession(session.id, {
      model: 'gpt-next',
      effort: 'xhigh',
      accessProfile: 'workspace_write',
    })
    expect(session.metadata).toMatchObject({
      model: 'gpt-next', effort: 'xhigh', resolvedModel: 'gpt-test', resolvedEffort: 'high',
    })
    await driver.send(session.id, 'updated turn')
    expect(session.metadata).toMatchObject({ resolvedModel: 'gpt-next', resolvedEffort: 'xhigh' })
    expect(service.turnStarts.at(-1)).toMatchObject({
      input: 'updated turn',
      overrides: {
        model: 'gpt-next',
        effort: 'xhigh',
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/repo'] },
      },
    })

    const iterator = driver.events(session.id)[Symbol.asyncIterator]()
    const pendingResponse = service.request({
      id: 'deferred-approval',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-new', turnId: 'turn-1', itemId: 'file-1' },
      receivedAt: '2026-07-19T12:00:00.000Z',
    })
    expect(await next(iterator)).toMatchObject({
      metadata: { approval: true, requestId: 'deferred-approval', approvalKind: 'file-change' },
    })
    await expect(driver.resolveApproval(session.id, 'deferred-approval', 'allow_session')).resolves.toBe(true)
    await expect(pendingResponse).resolves.toEqual({ decision: 'acceptForSession' })
    await expect(driver.resolveApproval(session.id, 'deferred-approval', 'deny')).resolves.toBe(false)

    const userInputResponse = service.request({
      id: 'deferred-user-input',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-new',
        turnId: 'turn-1',
        itemId: 'question-1',
        questions: [
          { id: 'framework', header: 'Framework', question: 'Which framework?', options: [{ label: 'React' }] },
          { id: 'notes', header: 'Notes', question: 'Any constraints?' },
        ],
      },
      receivedAt: '2026-07-19T12:00:00.000Z',
    })
    const userInputEvent = await next(iterator)
    expect(userInputEvent).toMatchObject({ metadata: { approvalKind: 'user-input' } })
    expect(userInputEvent.metadata?.questions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'framework', question: 'Which framework?' }),
    ]))
    await expect(driver.resolveApproval(
      session.id,
      'deferred-user-input',
      'allow',
      undefined,
      { framework: ['React'], notes: ['Keep it accessible'] },
    )).resolves.toBe(true)
    await expect(userInputResponse).resolves.toEqual({
      answers: {
        framework: { answers: ['React'] },
        notes: { answers: ['Keep it accessible'] },
      },
    })
  })

  it('bridges MCP form and URL elicitations through the approval stream', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({
      service: service.asPort(),
      onApprovalRequest: () => CODEX_REQUEST_UNHANDLED,
      now: () => new Date('2026-07-19T12:00:00.000Z'),
    })
    drivers.push(driver)
    const session = await driver.launch({ workspaceId: 'workspace-mcp', cwd: '/repo' })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()

    await expect(service.request({
      id: 'current-time',
      method: 'currentTime/read',
      params: { threadId: 'thread-new' },
      receivedAt: '2026-07-19T12:00:00.000Z',
    })).resolves.toEqual({ currentTimeAt: 1_784_462_400 })

    const formResponse = service.request({
      id: 'mcp-form',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-new',
        turnId: 'turn-1',
        serverName: 'github',
        mode: 'form',
        _meta: null,
        message: 'Choose connection settings',
        requestedSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', title: 'Project', enum: ['orchestra', 'other'] },
            retries: { type: 'integer', title: 'Retries', minimum: 0, maximum: 5, default: 2 },
            publish: { type: 'boolean', title: 'Publish results' },
            scopes: { type: 'array', title: 'Scopes', items: { type: 'string', enum: ['read', 'write'] } },
            note: { type: 'string', title: 'Optional note' },
          },
          required: ['project', 'retries'],
        },
      },
      receivedAt: '2026-07-19T12:00:00.000Z',
    })
    const formEvent = await next(iterator)
    expect(formEvent).toMatchObject({
      type: 'tool',
      data: 'Choose connection settings',
      metadata: {
        approvalKind: 'mcp-elicitation',
        elicitationMode: 'form',
        serverName: 'github',
      },
    })
    expect(formEvent.metadata?.questions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'project', required: true, options: [{ label: 'orchestra' }, { label: 'other' }] }),
      expect.objectContaining({ id: 'retries', inputType: 'number', defaultAnswers: ['2'], step: 1 }),
      expect.objectContaining({ id: 'publish', required: false, options: expect.any(Array) }),
      expect.objectContaining({ id: 'scopes', multiple: true }),
    ]))
    await expect(driver.resolveApproval(session.id, 'mcp-form', 'allow', undefined, {
      project: ['orchestra'],
      retries: ['2'],
      publish: ['true'],
      scopes: ['read', 'write'],
      note: [],
    })).resolves.toBe(true)
    await expect(formResponse).resolves.toEqual({
      action: 'accept',
      content: { project: 'orchestra', retries: 2, publish: true, scopes: ['read', 'write'] },
      _meta: null,
    })

    const urlResponse = service.request({
      id: 'mcp-url',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-new', turnId: null, serverName: 'github', mode: 'url', _meta: null,
        message: 'Sign in to GitHub', url: 'https://github.com/login/oauth/authorize', elicitationId: 'oauth-1',
      },
      receivedAt: '2026-07-19T12:00:00.000Z',
    })
    expect(await next(iterator)).toMatchObject({
      data: 'Sign in to GitHub',
      metadata: {
        approvalKind: 'mcp-elicitation',
        elicitationMode: 'url',
        serverName: 'github',
        url: 'https://github.com/login/oauth/authorize',
        elicitationId: 'oauth-1',
      },
    })
    await expect(driver.resolveApproval(session.id, 'mcp-url', 'allow')).resolves.toBe(true)
    await expect(urlResponse).resolves.toEqual({ action: 'accept', content: null, _meta: null })
  })

  it('interrupts an active turn when its enforceable token budget is reached', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    const session = await driver.launch({
      workspaceId: 'workspace-budget', cwd: '/repo', prompt: 'work', taskBudgetTokens: 100,
    })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()
    service.emit('thread/tokenUsage/updated', {
      threadId: 'thread-new',
      turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 101, inputTokens: 70, cachedInputTokens: 10, outputTokens: 31, reasoningOutputTokens: 5 },
        last: { totalTokens: 101, inputTokens: 70, cachedInputTokens: 10, outputTokens: 31, reasoningOutputTokens: 5 },
        modelContextWindow: 200_000,
      },
    })
    expect(await next(iterator)).toMatchObject({ metadata: { tokenUsage: { total: { totalTokens: 101 } } } })
    expect(await next(iterator)).toMatchObject({
      type: 'status', data: 'Codex token budget reached', metadata: { budgetExceeded: true, budgetTokens: 100 },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.interrupts).toContainEqual({ threadId: 'thread-new', turnId: 'turn-1' })
    expect(driver.capabilities()).toMatchObject({ tokenBudget: true, costBudget: false })
  })
})

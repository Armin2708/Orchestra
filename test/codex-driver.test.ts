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
      state: type === 'connected' ? 'running' : 'restarting',
      at: '2026-07-19T12:00:00.000Z',
      generation: 2,
      attempt: 1,
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
      metadata: { threadId: 'thread-new', cliVersion: '0.144.6', currentTurnId: 'turn-1' },
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
      metadata: { currentTurnId: 'turn-active' },
    })
    expect(service.resumes).toEqual(['thread-existing'])
    expect(service.reads).toEqual(['thread-existing'])
    await driver.send(session!.id, 'continue')
    expect(service.steers).toEqual([{ threadId: 'thread-existing', turnId: 'turn-active', input: 'continue' }])
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

  it('refuses an implicit Claude bypass-permissions translation', async () => {
    const service = new FakeService()
    const driver = new CodexAgentDriver({ service: service.asPort() })
    drivers.push(driver)
    await expect(driver.launch({
      workspaceId: 'workspace-1', cwd: '/repo', permissionMode: 'bypassPermissions',
    })).rejects.toThrow('Refusing to map Claude bypassPermissions')
    expect(service.starts).toEqual([])
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
    const driver = new CodexAgentDriver({ service: service.asPort(), approvalTimeoutMs: 1_000 })
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
    await driver.send(session.id, 'updated turn')
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

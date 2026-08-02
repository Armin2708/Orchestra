import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type {
  Agent,
  Client,
  InitializeResponse,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { redactSensitiveText } from '../../agent-os/structured-redaction.js'
import type {
  AgentDriver,
  DriverEvent,
  DriverLaunchRequest,
  DriverRecoveryRequest,
  DriverSession,
  DriverSessionStatus,
} from '../types.js'

const SAFE_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
])

export const KIMI_ACP_PROTOCOL_VERSION_V1 = '0.23' as const

export type KimiAcpAccessProfileValuesV1 = Readonly<Record<
  'read_only' | 'workspace_write' | 'full_access',
  string
>>

export type KimiAcpProcessV1 = Pick<
  ChildProcessWithoutNullStreams,
  'stdin' | 'stdout' | 'stderr' | 'kill' | 'once'
> & {
  readonly pid?: number
}

export type KimiAcpConnectionV1 = Pick<
  ClientSideConnection,
  | 'initialize'
  | 'newSession'
  | 'loadSession'
  | 'resumeSession'
  | 'setSessionConfigOption'
  | 'prompt'
  | 'cancel'
>

export type KimiAcpDriverOptionsV1 = {
  command: string
  environment?: NodeJS.ProcessEnv
  now?: () => Date
  randomId?: () => string
  handshakeTimeoutMs?: number
  accessProfileValues: KimiAcpAccessProfileValuesV1
  spawnProcess?(
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ): KimiAcpProcessV1
  createConnection?(
    process: KimiAcpProcessV1,
    client: Client,
  ): KimiAcpConnectionV1
}

export type KimiAcpDriverPortV1 = AgentDriver & {
  resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: 'approve' | 'reject',
  ): Promise<void>
}

type PendingApprovalV1 = {
  options: readonly PermissionOption[]
  resolve(value: RequestPermissionResponse): void
}

type EventQueueV1 = {
  close(): void
  push(event: DriverEvent): void
  stream(): AsyncIterable<DriverEvent>
}

type KimiAcpSessionStateV1 = {
  connection: KimiAcpConnectionV1
  process: KimiAcpProcessV1
  queue: EventQueueV1
  session: DriverSession
  cwd: string
  configOptions: readonly SessionConfigOption[]
  initialize: InitializeResponse
  promptRunning: boolean
  closed: boolean
  sequence: number
  pendingApprovals: Map<string, PendingApprovalV1>
}

const createEventQueue = (): EventQueueV1 => {
  const values: DriverEvent[] = []
  const waiters: Array<(value: IteratorResult<DriverEvent>) => void> = []
  let closed = false
  const flush = (): void => {
    while (values.length > 0 && waiters.length > 0) {
      const event = values.shift()
      const waiter = waiters.shift()
      if (event && waiter) waiter({ done: false, value: event })
    }
    if (closed) {
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined })
      }
    }
  }
  return {
    close() {
      closed = true
      flush()
    },
    push(event) {
      if (closed) return
      values.push(event)
      flush()
    },
    stream() {
      return {
        [Symbol.asyncIterator]() {
          let finished = false
          let pending: ((value: IteratorResult<DriverEvent>) => void) | null = null
          return {
            next(): Promise<IteratorResult<DriverEvent>> {
              if (finished) return Promise.resolve({ done: true, value: undefined })
              const event = values.shift()
              if (event) return Promise.resolve({ done: false, value: event })
              if (closed) return Promise.resolve({ done: true, value: undefined })
              return new Promise((resolve) => {
                pending = resolve
                waiters.push(resolve)
              })
            },
            return(): Promise<IteratorResult<DriverEvent>> {
              finished = true
              if (pending) {
                const index = waiters.indexOf(pending)
                if (index >= 0) waiters.splice(index, 1)
                pending({ done: true, value: undefined })
                pending = null
              }
              return Promise.resolve({ done: true, value: undefined })
            },
          }
        },
      }
    },
  }
}

const defaultSpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): KimiAcpProcessV1 => spawn(command, [...args], {
  ...options,
  stdio: ['pipe', 'pipe', 'pipe'],
})

const defaultCreateConnection = (
  process: KimiAcpProcessV1,
  client: Client,
): KimiAcpConnectionV1 => {
  const output = Writable.toWeb(process.stdin) as WritableStream<Uint8Array>
  const input = Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(output, input)
  return new ClientSideConnection((_agent: Agent) => client, stream)
}

const safeText = (value: unknown, fallback: string): string => {
  const text = typeof value === 'string' ? value : fallback
  const redacted = redactSensitiveText(text.slice(0, 2_000))
  return redacted.value || fallback
}

const safeError = (prefix: string, error: unknown): Error => new Error(
  `${prefix}: ${safeText(error instanceof Error ? error.message : null, 'unknown failure')}`,
)

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const optionValues = (option: SessionConfigOption): readonly string[] => {
  if (option.type !== 'select') return []
  return option.options.flatMap((candidate) => 'options' in candidate
    ? candidate.options.map((entry) => entry.value)
    : [candidate.value])
}

const matchingOption = (
  options: readonly SessionConfigOption[],
  category: string,
  ids: readonly string[],
): SessionConfigOption | null => options.find((option) =>
  option.category === category || ids.includes(option.id)) ?? null

const currentOptionValue = (
  options: readonly SessionConfigOption[],
  category: string,
  ids: readonly string[],
): string | null => {
  const option = matchingOption(options, category, ids)
  return option?.type === 'select' ? option.currentValue : null
}

const processEnvironment = (
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const output: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === 'string') output[key] = value
  }
  return output
}

export class KimiAcpDriverV1 implements KimiAcpDriverPortV1 {
  readonly id = 'kimi'
  private readonly options: KimiAcpDriverOptionsV1
  private readonly sessions = new Map<string, KimiAcpSessionStateV1>()
  private readonly externalSessions = new Map<string, string>()

  constructor(options: KimiAcpDriverOptionsV1) {
    const command = options.command.trim()
    if (!command) throw new Error('Kimi ACP command is required')
    for (const value of Object.values(options.accessProfileValues)) {
      if (!value.trim()) throw new Error('Kimi ACP access-profile mapping is invalid')
    }
    const timeout = options.handshakeTimeoutMs ?? 5_000
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30_000) {
      throw new Error('Kimi ACP handshake timeout is invalid')
    }
    this.options = { ...options, command }
  }

  capabilities() {
    return {
      attach: false,
      streaming: true,
      interrupt: true,
      stop: true,
      rawTerminal: true,
      resume: true,
      tokenBudget: false,
      costBudget: false,
    }
  }

  private nextEvent(
    state: KimiAcpSessionStateV1,
    type: DriverEvent['type'],
    data: string,
    metadata?: Record<string, unknown>,
  ): void {
    state.sequence += 1
    state.queue.push({
      sessionId: state.session.id,
      seq: state.sequence,
      type,
      at: (this.options.now ?? (() => new Date()))().toISOString(),
      data,
      metadata,
    })
  }

  private updateSession(
    state: KimiAcpSessionStateV1,
    notification: SessionNotification,
  ): void {
    const update = notification.update
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content.type === 'text') {
        this.nextEvent(state, 'output', safeText(update.content.text, 'Kimi output'))
      }
      return
    }
    if (update.sessionUpdate === 'tool_call') {
      this.nextEvent(state, 'tool', safeText(update.title, 'Kimi tool call'), {
        nativeMethod: update.status === 'completed'
          ? 'tool/completed'
          : update.status === 'failed'
            ? 'tool/failed'
            : 'tool/started',
        itemId: update.toolCallId,
        toolName: safeText(update.title, 'kimi_tool'),
      })
      return
    }
    if (update.sessionUpdate === 'tool_call_update') {
      this.nextEvent(state, 'tool', safeText(update.title, 'Kimi tool update'), {
        nativeMethod: update.status === 'completed'
          ? 'tool/completed'
          : update.status === 'failed'
            ? 'tool/failed'
            : 'tool/updated',
        itemId: update.toolCallId,
        toolName: safeText(update.title, 'kimi_tool'),
      })
      return
    }
    if (update.sessionUpdate === 'config_option_update') {
      state.configOptions = update.configOptions
      this.nextEvent(state, 'status', 'Kimi session configuration changed', {
        configurationChanged: true,
      })
      return
    }
    if (update.sessionUpdate === 'current_mode_update') {
      this.nextEvent(state, 'status', 'Kimi session mode changed', {
        modeChanged: true,
      })
    }
  }

  private requestPermission(
    state: KimiAcpSessionStateV1,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const approvalId = `kimi-acp-approval-${state.sequence + 1}`
    return new Promise((resolve) => {
      state.pendingApprovals.set(approvalId, {
        options: Object.freeze([...request.options]),
        resolve,
      })
      this.nextEvent(
        state,
        'tool',
        safeText(request.toolCall.title, 'Kimi permission requested'),
        {
          approval: true,
          approvalRequest: {
            requestId: approvalId,
            kind: request.toolCall.kind === 'execute'
              ? 'command'
              : request.toolCall.kind === 'edit'
                ? 'file-change'
                : 'tool',
          },
        },
      )
    })
  }

  private clientFor(
    getState: () => KimiAcpSessionStateV1 | null,
  ): Client {
    return {
      requestPermission: async (request) => {
        const state = getState()
        if (!state || request.sessionId !== state.session.externalId) {
          return { outcome: { outcome: 'cancelled' } }
        }
        return this.requestPermission(state, request)
      },
      sessionUpdate: async (notification) => {
        const state = getState()
        if (state && notification.sessionId === state.session.externalId) {
          this.updateSession(state, notification)
        }
      },
      readTextFile: async () => {
        throw new Error('Kimi ACP client-side file reads are not enabled')
      },
      writeTextFile: async () => {
        throw new Error('Kimi ACP client-side file writes are not enabled')
      },
    }
  }

  private async initializeProcess(cwd: string): Promise<{
    connection: KimiAcpConnectionV1
    initialize: InitializeResponse
    process: KimiAcpProcessV1
    stateRef: { current: KimiAcpSessionStateV1 | null }
  }> {
    const resolvedCwd = realpathSync(cwd)
    const spawnProcess = this.options.spawnProcess ?? defaultSpawnProcess
    const child = spawnProcess(this.options.command, ['acp'], {
      cwd: resolvedCwd,
      env: processEnvironment(this.options.environment ?? globalThis.process.env),
      shell: false,
      windowsHide: true,
    })
    const stateRef = { current: null as KimiAcpSessionStateV1 | null }
    const client = this.clientFor(() => stateRef.current)
    const connection = (this.options.createConnection ?? defaultCreateConnection)(
      child,
      client,
    )
    try {
      const processError = new Promise<never>((_resolve, reject) => {
        child.once('error', (error) => reject(error))
      })
      const initialize = await withTimeout(Promise.race([
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: {
            name: 'Orchestra',
            version: '0.1.0',
          },
          clientCapabilities: {},
        }),
        processError,
      ]), this.options.handshakeTimeoutMs ?? 5_000, 'kimi_acp_initialize_timeout')
      if (initialize.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error('Kimi ACP protocol version is incompatible')
      }
      if (initialize.agentInfo?.name !== 'Kimi Code CLI') {
        throw new Error('Kimi ACP agent identity is incompatible')
      }
      return { connection, initialize, process: child, stateRef }
    } catch (error) {
      child.kill('SIGTERM')
      throw safeError('Kimi ACP initialization failed', error)
    }
  }

  private async configure(
    state: KimiAcpSessionStateV1,
    request: Pick<DriverLaunchRequest, 'accessProfile' | 'model' | 'effort'>,
  ): Promise<void> {
    const set = async (
      option: SessionConfigOption | null,
      value: string | undefined,
      label: string,
    ): Promise<void> => {
      if (value === undefined) return
      if (!option || option.type !== 'select' || !optionValues(option).includes(value)) {
        throw new Error(`Kimi ACP ${label} is unsupported`)
      }
      const response = await withTimeout(state.connection.setSessionConfigOption({
        sessionId: state.session.externalId,
        configId: option.id,
        value,
      }), this.options.handshakeTimeoutMs ?? 5_000, 'kimi_acp_configuration_timeout')
      state.configOptions = response.configOptions
    }
    await set(
      matchingOption(state.configOptions, 'model', ['model']),
      request.model,
      'model selection',
    )
    await set(
      matchingOption(state.configOptions, 'thought_level', ['thinking', 'effort']),
      request.effort,
      'effort selection',
    )
    const accessProfile = request.accessProfile ?? 'workspace_write'
    await set(
      matchingOption(state.configOptions, 'mode', ['mode', 'permission_mode']),
      this.options.accessProfileValues[accessProfile],
      'access profile',
    )
  }

  private register(
    processState: Awaited<ReturnType<KimiAcpDriverV1['initializeProcess']>>,
    sessionId: string,
    workspaceId: string,
    cwd: string,
    configOptions: readonly SessionConfigOption[],
    status: DriverSessionStatus,
  ): KimiAcpSessionStateV1 {
    const id = (this.options.randomId ?? randomUUID)()
    const session: DriverSession = {
      id,
      externalId: sessionId,
      driverId: this.id,
      workspaceId,
      status,
      startedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      metadata: {
        protocol: 'acp',
        protocolVersion: KIMI_ACP_PROTOCOL_VERSION_V1,
        agentVersion: processState.initialize.agentInfo?.version ?? null,
      },
    }
    const state: KimiAcpSessionStateV1 = {
      connection: processState.connection,
      process: processState.process,
      queue: createEventQueue(),
      session,
      cwd,
      configOptions,
      initialize: processState.initialize,
      promptRunning: false,
      closed: false,
      sequence: 0,
      pendingApprovals: new Map(),
    }
    processState.stateRef.current = state
    this.sessions.set(id, state)
    this.externalSessions.set(sessionId, id)
    processState.process.once('exit', (code, signal) => {
      if (state.closed) return
      state.closed = true
      state.session.status = code === 0 ? 'stopped' : 'failed'
      this.nextEvent(state, code === 0 ? 'exit' : 'error', code === 0
        ? 'Kimi ACP process stopped'
        : 'Kimi ACP process failed', {
        exitCode: Number.isInteger(code) ? code : null,
        signal: typeof signal === 'string' ? signal : null,
      })
      state.queue.close()
      this.sessions.delete(id)
      this.externalSessions.delete(sessionId)
    })
    return state
  }

  private discardRegisteredState(state: KimiAcpSessionStateV1): void {
    state.closed = true
    for (const pending of state.pendingApprovals.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    state.pendingApprovals.clear()
    state.queue.close()
    this.sessions.delete(state.session.id)
    this.externalSessions.delete(state.session.externalId)
  }

  private beginPrompt(state: KimiAcpSessionStateV1, prompt: string): void {
    if (state.promptRunning) throw new Error('Kimi ACP prompt is already running')
    if (!prompt.trim()) return
    state.promptRunning = true
    state.session.status = 'running'
    void state.connection.prompt({
      sessionId: state.session.externalId,
      prompt: [{ type: 'text', text: prompt }],
    }).then((response) => {
      if (state.closed) return
      state.promptRunning = false
      state.session.status = 'idle'
      const stopReason = SAFE_STOP_REASONS.has(response.stopReason)
        ? response.stopReason
        : 'unknown'
      this.nextEvent(state, 'status', 'Kimi turn completed', {
        turnCompleted: true,
        stopReason,
      })
    }).catch((error: unknown) => {
      if (state.closed) return
      state.promptRunning = false
      state.session.status = 'failed'
      this.nextEvent(state, 'error', safeText(
        error instanceof Error ? error.message : null,
        'Kimi ACP prompt failed',
      ), { code: 'kimi_acp_prompt_failed' })
    })
  }

  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    if (!request.workspaceId.trim()) throw new Error('Kimi ACP workspace is required')
    const processState = await this.initializeProcess(request.cwd)
    let registered: KimiAcpSessionStateV1 | null = null
    try {
      const response = await withTimeout(processState.connection.newSession({
        cwd: realpathSync(request.cwd),
        mcpServers: [],
      }), this.options.handshakeTimeoutMs ?? 5_000, 'kimi_acp_new_session_timeout')
      const state = this.register(
        processState,
        response.sessionId,
        request.workspaceId,
        realpathSync(request.cwd),
        response.configOptions ?? [],
        request.prompt?.trim() ? 'running' : 'idle',
      )
      registered = state
      await this.configure(state, request)
      state.session.metadata = {
        ...state.session.metadata,
        effectiveModel: request.model
          ?? currentOptionValue(state.configOptions, 'model', ['model']),
        effectiveEffort: request.effort
          ?? currentOptionValue(
            state.configOptions,
            'thought_level',
            ['thinking', 'effort'],
          ),
        effectiveAccessProfile: request.accessProfile ?? 'workspace_write',
      }
      if (request.prompt) this.beginPrompt(state, request.prompt)
      return state.session
    } catch (error) {
      if (registered) this.discardRegisteredState(registered)
      processState.process.kill('SIGTERM')
      throw safeError('Kimi ACP launch failed', error)
    }
  }

  async attach(externalId: string): Promise<DriverSession | null> {
    const id = this.externalSessions.get(externalId)
    return id ? this.sessions.get(id)?.session ?? null : null
  }

  async recover(request: DriverRecoveryRequest): Promise<DriverSession | null> {
    if (!request.externalId.trim()) return null
    const processState = await this.initializeProcess(request.cwd)
    let registered: KimiAcpSessionStateV1 | null = null
    try {
      const canResume = processState.initialize.agentCapabilities
        ?.sessionCapabilities?.resume !== undefined
      const responseOperation = canResume
        ? processState.connection.resumeSession({
            sessionId: request.externalId,
            cwd: realpathSync(request.cwd),
            mcpServers: [],
          })
        : processState.initialize.agentCapabilities?.loadSession === true
          ? processState.connection.loadSession({
              sessionId: request.externalId,
              cwd: realpathSync(request.cwd),
              mcpServers: [],
            })
          : null
      const response = responseOperation === null
        ? null
        : await withTimeout(
          responseOperation,
          this.options.handshakeTimeoutMs ?? 5_000,
          'kimi_acp_resume_timeout',
        )
      if (response === null) {
        processState.process.kill('SIGTERM')
        return null
      }
      const state = this.register(
        processState,
        request.externalId,
        request.workspaceId,
        realpathSync(request.cwd),
        response.configOptions ?? [],
        'idle',
      )
      registered = state
      await this.configure(state, request)
      state.session.metadata = {
        ...state.session.metadata,
        effectiveModel: request.model ?? null,
        effectiveEffort: request.effort ?? null,
        effectiveAccessProfile: request.accessProfile,
      }
      return state.session
    } catch (error) {
      if (registered) this.discardRegisteredState(registered)
      processState.process.kill('SIGTERM')
      throw safeError('Kimi ACP recovery failed', error)
    }
  }

  async send(sessionId: string, text: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.closed) throw new Error('Kimi ACP session is unavailable')
    this.beginPrompt(state, text)
  }

  async interrupt(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.closed) throw new Error('Kimi ACP session is unavailable')
    await state.connection.cancel({ sessionId: state.session.externalId })
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.closed) throw new Error('Kimi ACP session is unavailable')
    await state.connection.cancel({ sessionId: state.session.externalId })
    state.closed = true
    for (const [approvalId, pending] of state.pendingApprovals) {
      state.pendingApprovals.delete(approvalId)
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    state.process.kill('SIGTERM')
    state.session.status = 'stopped'
    this.nextEvent(state, 'exit', 'Kimi ACP session cancelled')
    state.queue.close()
    this.sessions.delete(sessionId)
    this.externalSessions.delete(state.session.externalId)
  }

  async resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    const state = this.sessions.get(sessionId)
    const pending = state?.pendingApprovals.get(approvalId)
    if (!state || !pending) throw new Error('Kimi ACP approval is unavailable')
    const kinds = decision === 'approve'
      ? ['allow_once']
      : ['reject_once', 'reject_always']
    const option = pending.options.find((candidate) => kinds.includes(candidate.kind))
    state.pendingApprovals.delete(approvalId)
    pending.resolve(option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } })
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.closed) return
    state.closed = true
    for (const [approvalId, pending] of state.pendingApprovals) {
      state.pendingApprovals.delete(approvalId)
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    await state.connection.cancel({ sessionId: state.session.externalId })
      .catch(() => undefined)
    state.process.kill('SIGTERM')
    state.session.status = 'stopped'
    this.nextEvent(state, 'exit', 'Kimi ACP process stopped')
    state.queue.close()
    this.sessions.delete(sessionId)
    this.externalSessions.delete(state.session.externalId)
  }

  events(sessionId: string): AsyncIterable<DriverEvent> {
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error('Kimi ACP session is unavailable')
    return state.queue.stream()
  }
}

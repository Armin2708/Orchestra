import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type {
  Client,
  InitializeResponse,
  PromptResponse,
  RequestPermissionResponse,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'
import {
  KimiAcpDriverV1,
  KIMI_ACP_PROTOCOL_VERSION_V1,
} from '../src/runtime/drivers/kimi-acp-driver.js'
import type {
  KimiAcpConnectionV1,
  KimiAcpProcessV1,
} from '../src/runtime/drivers/kimi-acp-driver.js'

const temporaryNow = new Date('2026-08-02T08:00:00.000Z')

type FakeProcess = KimiAcpProcessV1 & {
  emit(event: string, ...args: unknown[]): boolean
  killedWith: string[]
}

const fakeProcess = (): FakeProcess => {
  const emitter = new EventEmitter()
  const killedWith: string[] = []
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 1234,
    killedWith,
    kill(signal = 'SIGTERM') {
      killedWith.push(String(signal))
      return true
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      emitter.once(event, listener as (...args: any[]) => void)
      return this as never
    },
    emit(event: string, ...args: unknown[]) {
      return emitter.emit(event, ...args)
    },
  }
}

const configOptions = (): SessionConfigOption[] => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'kimi-code/default',
    options: [
      { name: 'Default', value: 'kimi-code/default' },
      { name: 'K3', value: 'kimi-code/k3' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { name: 'High', value: 'high' },
      { name: 'Max', value: 'max' },
    ],
  },
  {
    id: 'permission_mode',
    name: 'Permission mode',
    category: 'mode',
    type: 'select',
    currentValue: 'manual',
    options: [
      { name: 'Plan', value: 'plan' },
      { name: 'Manual', value: 'manual' },
      { name: 'Auto', value: 'auto' },
    ],
  },
]

const initializeResponse = (): InitializeResponse => ({
  protocolVersion: PROTOCOL_VERSION,
  agentInfo: {
    name: 'Kimi Code CLI',
    version: '0.31.0',
  },
  authMethods: [{ id: 'login', name: 'Kimi login' }],
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: {
      resume: {},
    },
  },
})

const fakeConnection = () => {
  let options = configOptions()
  let finishPrompt: ((value: { stopReason: 'end_turn' }) => void) | null = null
  const connection: KimiAcpConnectionV1 = {
    initialize: vi.fn(async () => initializeResponse()),
    newSession: vi.fn(async () => ({
      sessionId: 'kimi-session-1',
      configOptions: options,
    })),
    loadSession: vi.fn(async () => ({ configOptions: options })),
    resumeSession: vi.fn(async () => ({ configOptions: options })),
    setSessionConfigOption: vi.fn(async (request) => {
      options = options.map((option) => option.id === request.configId
        ? { ...option, currentValue: String(request.value) } as SessionConfigOption
        : option)
      return { configOptions: options }
    }),
    prompt: vi.fn(() => new Promise<PromptResponse>((resolve) => {
      finishPrompt = resolve as (value: { stopReason: 'end_turn' }) => void
    })),
    cancel: vi.fn(async () => undefined),
  }
  return {
    connection,
    finishPrompt() {
      if (!finishPrompt) throw new Error('prompt was not started')
      finishPrompt({ stopReason: 'end_turn' })
    },
  }
}

const accessProfileValues = {
  read_only: 'plan',
  workspace_write: 'manual',
  full_access: 'auto',
} as const

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Kimi ACP driver', () => {
  it('uses the exact ACP subprocess, negotiates identity, configures native controls, and streams safe events', async () => {
    const child = fakeProcess()
    const fake = fakeConnection()
    let client: Client | null = null
    const spawnProcess = vi.fn(() => child)
    const driver = new KimiAcpDriverV1({
      command: '/opt/kimi/bin/kimi',
      environment: {
        PATH: '/opt/kimi/bin',
        KIMI_CODE_HOME: '/isolated/kimi-home',
      },
      accessProfileValues,
      now: () => temporaryNow,
      randomId: () => 'driver-session-1',
      spawnProcess,
      createConnection: (_process, value) => {
        client = value
        return fake.connection
      },
    })

    const session = await driver.launch({
      workspaceId: 'workspace-1',
      cwd: process.cwd(),
      model: 'kimi-code/k3',
      effort: 'max',
      accessProfile: 'read_only',
    })

    expect(spawnProcess).toHaveBeenCalledWith(
      '/opt/kimi/bin/kimi',
      ['acp'],
      expect.objectContaining({
        cwd: process.cwd(),
        env: {
          PATH: '/opt/kimi/bin',
          KIMI_CODE_HOME: '/isolated/kimi-home',
        },
        shell: false,
      }),
    )
    expect(fake.connection.initialize).toHaveBeenCalledWith({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'Orchestra', version: '0.1.0' },
      clientCapabilities: {},
    })
    expect(fake.connection.newSession).toHaveBeenCalledWith({
      cwd: process.cwd(),
      mcpServers: [],
    })
    expect(fake.connection.setSessionConfigOption).toHaveBeenNthCalledWith(1, {
      sessionId: 'kimi-session-1',
      configId: 'model',
      value: 'kimi-code/k3',
    })
    expect(fake.connection.setSessionConfigOption).toHaveBeenNthCalledWith(2, {
      sessionId: 'kimi-session-1',
      configId: 'effort',
      value: 'max',
    })
    expect(fake.connection.setSessionConfigOption).toHaveBeenNthCalledWith(3, {
      sessionId: 'kimi-session-1',
      configId: 'permission_mode',
      value: 'plan',
    })
    expect(session).toMatchObject({
      id: 'driver-session-1',
      externalId: 'kimi-session-1',
      driverId: 'kimi',
      workspaceId: 'workspace-1',
      status: 'idle',
      metadata: {
        protocol: 'acp',
        protocolVersion: KIMI_ACP_PROTOCOL_VERSION_V1,
        agentVersion: '0.31.0',
        effectiveModel: 'kimi-code/k3',
        effectiveEffort: 'max',
        effectiveAccessProfile: 'read_only',
      },
    })

    const iterator = driver.events(session.id)[Symbol.asyncIterator]()
    await client!.sessionUpdate({
      sessionId: session.externalId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read workspace file',
        kind: 'read',
        status: 'in_progress',
        rawInput: { credential: 'must-never-be-projected' },
      },
    })
    const tool = await iterator.next()
    expect(tool.value).toMatchObject({
      type: 'tool',
      data: 'Read workspace file',
      metadata: {
        itemId: 'tool-1',
        toolName: 'Read workspace file',
      },
    })
    expect(JSON.stringify(tool.value)).not.toContain('must-never-be-projected')

    await driver.send(session.id, 'Continue safely')
    expect(fake.connection.prompt).toHaveBeenCalledWith({
      sessionId: session.externalId,
      prompt: [{ type: 'text', text: 'Continue safely' }],
    })
    fake.finishPrompt()
    await vi.waitFor(() => expect(session.status).toBe('idle'))
    const completed = await iterator.next()
    expect(completed.value).toMatchObject({
      type: 'status',
      data: 'Kimi turn completed',
      metadata: { turnCompleted: true, stopReason: 'end_turn' },
    })

    await driver.interrupt(session.id)
    expect(fake.connection.cancel).toHaveBeenCalledWith({
      sessionId: session.externalId,
    })
    const waiting = iterator.next()
    await iterator.return?.()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
    await driver.stop(session.id)
    expect(child.killedWith).toEqual(['SIGTERM'])
    expect(await driver.attach(session.externalId)).toBeNull()
  })

  it('keeps ACP tool approval pending until an explicit Orchestra approve or reject decision', async () => {
    const child = fakeProcess()
    const fake = fakeConnection()
    let client: Client | null = null
    const driver = new KimiAcpDriverV1({
      command: '/opt/kimi/bin/kimi',
      accessProfileValues,
      randomId: () => 'driver-session-approval',
      spawnProcess: () => child,
      createConnection: (_process, value) => {
        client = value
        return fake.connection
      },
    })
    const session = await driver.launch({
      workspaceId: 'workspace-1',
      cwd: process.cwd(),
      accessProfile: 'workspace_write',
    })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()
    const permission = client!.requestPermission({
      sessionId: session.externalId,
      toolCall: {
        toolCallId: 'tool-approval',
        title: 'Run tests',
        kind: 'execute',
      },
      options: [
        { optionId: 'yes-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'no-once', name: 'Reject once', kind: 'reject_once' },
      ],
    })
    const event = await iterator.next()
    expect(event.value).toMatchObject({
      type: 'tool',
      metadata: {
        approval: true,
        approvalRequest: {
          requestId: 'kimi-acp-approval-1',
          kind: 'command',
        },
      },
    })

    await driver.resolveApproval(
      session.id,
      'kimi-acp-approval-1',
      'reject',
    )
    const rejected: RequestPermissionResponse = {
      outcome: { outcome: 'selected', optionId: 'no-once' },
    }
    await expect(permission).resolves.toEqual(rejected)
  })

  it('resumes through the documented ACP session/resume surface and fails closed on unsupported native controls', async () => {
    const child = fakeProcess()
    const fake = fakeConnection()
    const driver = new KimiAcpDriverV1({
      command: '/opt/kimi/bin/kimi',
      accessProfileValues,
      randomId: () => 'recovered-driver-session',
      spawnProcess: () => child,
      createConnection: () => fake.connection,
    })
    const recovered = await driver.recover({
      externalId: 'kimi-existing-session',
      workspaceId: 'workspace-1',
      cwd: process.cwd(),
      model: 'kimi-code/k3',
      effort: 'high',
      accessProfile: 'full_access',
    })
    expect(fake.connection.resumeSession).toHaveBeenCalledWith({
      sessionId: 'kimi-existing-session',
      cwd: process.cwd(),
      mcpServers: [],
    })
    expect(recovered).toMatchObject({
      externalId: 'kimi-existing-session',
      status: 'idle',
      metadata: {
        effectiveModel: 'kimi-code/k3',
        effectiveEffort: 'high',
        effectiveAccessProfile: 'full_access',
      },
    })

    const incompatible = new KimiAcpDriverV1({
      command: '/opt/kimi/bin/kimi',
      accessProfileValues,
      spawnProcess: () => fakeProcess(),
      createConnection: () => ({
        ...fakeConnection().connection,
        initialize: vi.fn(async () => ({
          ...initializeResponse(),
          agentInfo: { name: 'Different Agent', version: '0.31.0' },
        })),
      }),
    })
    await expect(incompatible.launch({
      workspaceId: 'workspace-1',
      cwd: process.cwd(),
      accessProfile: 'workspace_write',
    })).rejects.toThrow('Kimi ACP agent identity is incompatible')
  })
})

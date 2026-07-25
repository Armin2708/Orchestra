import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodexAppServerClient,
  CodexAppServerSupervisor,
  CodexConnectionClosedError,
  type CodexByteTransport,
  type CodexSupervisorLifecycleEvent,
  type CodexTransportClose,
  type CodexTransportListener,
  type CodexUnsubscribe,
} from '../src/codex/index.js'
import {
  MemoryRuntimePersistence,
  RuntimeSupervisor,
  type PtyBackend,
  type PtyHandle,
} from '../src/runtime/index.js'

const clientInfo = {
  name: 'orchestra_state_machine_test',
  title: 'Orchestra State Machine Test',
  version: '1.0.0',
}

const initializeResult = {
  userAgent: 'codex-state-machine-test',
  codexHome: '/tmp/codex-state-machine-test',
  platformFamily: 'unix',
  platformOs: 'macos',
}

class ControlledTransport implements CodexByteTransport {
  readonly writes: string[] = []
  readonly dataListeners = new Set<CodexTransportListener<Uint8Array>>()
  readonly stderrListeners = new Set<CodexTransportListener<string>>()
  readonly errorListeners = new Set<CodexTransportListener<Error>>()
  readonly closeListeners = new Set<CodexTransportListener<CodexTransportClose>>()
  closeCalls = 0
  closed = false
  onWrite?: (message: Record<string, unknown>) => void

  async write(data: string): Promise<void> {
    if (this.closed) throw new Error('transport is closed')
    this.writes.push(data)
    for (const line of data.trimEnd().split('\n')) {
      this.onWrite?.(JSON.parse(line) as Record<string, unknown>)
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1
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
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`)
    for (const listener of [...this.dataListeners]) listener(bytes)
  }

  disconnect(expected = false): void {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.closeListeners]) {
      listener({ code: expected ? 0 : 1, signal: null, expected })
    }
  }

  listenerCount(): number {
    return this.dataListeners.size
      + this.stderrListeners.size
      + this.errorListeners.size
      + this.closeListeners.size
  }

  private add<T>(
    listeners: Set<CodexTransportListener<T>>,
    listener: CodexTransportListener<T>,
  ): CodexUnsubscribe {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}

class ControlledPty implements PtyHandle {
  readonly process = 'controlled'
  readonly writes: Array<string | Buffer> = []
  readonly killSignals: Array<string | undefined> = []
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()

  constructor(
    readonly pid: number,
    private readonly exitOnKill = true,
  ) {}

  onData = (listener: (data: string) => void) => {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onExit = (listener: (event: { exitCode: number; signal?: number }) => void) => {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  write(data: string | Buffer): void {
    this.writes.push(data)
  }

  resize(): void {}

  kill(signal?: string): void {
    this.killSignals.push(signal)
    if (this.exitOnKill) this.emitExit(0)
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode, signal })
  }
}

class ControlledPtyBackend implements PtyBackend {
  readonly ptys: ControlledPty[] = []

  spawn(): PtyHandle {
    const pty = new ControlledPty(4_200 + this.ptys.length)
    this.ptys.push(pty)
    return pty
  }
}

const clients: CodexAppServerClient[] = []
const codexSupervisors: CodexAppServerSupervisor[] = []
const runtimeSupervisors: RuntimeSupervisor[] = []

const trackClient = (client: CodexAppServerClient): CodexAppServerClient => {
  clients.push(client)
  return client
}

const trackCodexSupervisor = (
  supervisor: CodexAppServerSupervisor,
): CodexAppServerSupervisor => {
  codexSupervisors.push(supervisor)
  return supervisor
}

const trackRuntimeSupervisor = (supervisor: RuntimeSupervisor): RuntimeSupervisor => {
  runtimeSupervisors.push(supervisor)
  return supervisor
}

const autoInitialize = (transport: ControlledTransport): ControlledTransport => {
  transport.onWrite = (message) => {
    if (message.method === 'initialize') {
      queueMicrotask(() => transport.server({ id: message.id, result: initializeResult }))
    }
  }
  return transport
}

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 1_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()))
  await Promise.allSettled(codexSupervisors.splice(0).map((supervisor) => supervisor.stop()))
  await Promise.allSettled(runtimeSupervisors.splice(0).map((supervisor) => supervisor.shutdown(0)))
})

describe('CodexAppServerClient transition guards', () => {
  it('rejects application traffic until ready and again after closure', async () => {
    const transport = new ControlledTransport()
    const client = trackClient(new CodexAppServerClient(transport))

    await expect(client.request('account/read', {}))
      .rejects.toThrow('Codex app-server client is not ready (state: new)')
    await expect(client.notify('test/before-initialize'))
      .rejects.toThrow('Codex app-server client is not ready (state: new)')

    const initializing = client.initialize(clientInfo)
    expect(client.state).toBe('initializing')
    await expect(client.request('account/read', {}))
      .rejects.toThrow('Codex app-server client is not ready (state: initializing)')
    await expect(client.notify('test/while-initializing'))
      .rejects.toThrow('Codex app-server client is not ready (state: initializing)')

    transport.server({ id: 1, result: initializeResult })
    await initializing
    expect(client.state).toBe('ready')

    await client.close()
    expect(client.state).toBe('closed')
    await expect(client.request('account/read', {}))
      .rejects.toThrow('Codex app-server client is not ready (state: closed)')
    await expect(client.notify('test/after-close'))
      .rejects.toThrow('Codex app-server client is not ready (state: closed)')
    expect(transport.listenerCount()).toBe(0)
  })

  it('refuses initialization after a pre-initialization close and closes idempotently', async () => {
    const transport = new ControlledTransport()
    const client = trackClient(new CodexAppServerClient(transport))

    await client.close()
    await client.close()

    expect(client.state).toBe('closed')
    expect(transport.closeCalls).toBe(1)
    await expect(client.initialize(clientInfo))
      .rejects.toThrow('Cannot initialize Codex client in state closed')
    expect(transport.writes).toEqual([])
  })
})

describe('CodexAppServerSupervisor transition guards', () => {
  it('enters failed on initial connection failure and can start once from failed', async () => {
    let factoryCalls = 0
    let healthyTransport: ControlledTransport | undefined
    const lifecycle: CodexSupervisorLifecycleEvent[] = []
    const supervisor = trackCodexSupervisor(new CodexAppServerSupervisor({
      transportFactory: () => {
        factoryCalls += 1
        if (factoryCalls === 1) throw new Error('initial transport failure')
        healthyTransport = autoInitialize(new ControlledTransport())
        return healthyTransport
      },
      restart: { stableResetMs: 0 },
    }))
    supervisor.onLifecycle((event) => lifecycle.push(event))

    await expect(supervisor.start()).rejects.toThrow('initial transport failure')
    expect(supervisor.state).toBe('failed')
    expect(supervisor.client).toBeNull()

    const firstRetry = supervisor.start()
    const concurrentRetry = supervisor.start()
    const [firstClient, concurrentClient] = await Promise.all([firstRetry, concurrentRetry])

    expect(firstClient).toBe(concurrentClient)
    expect(await supervisor.start()).toBe(firstClient)
    expect(supervisor.state).toBe('running')
    expect(factoryCalls).toBe(2)
    expect(lifecycle.map((event) => event.type)).toEqual([
      'starting',
      'starting',
      'connected',
    ])

    await supervisor.stop()
    await supervisor.stop()
    expect(supervisor.state).toBe('stopped')
    expect(healthyTransport?.closeCalls).toBe(1)
    expect(lifecycle.filter((event) => event.type === 'stopped')).toHaveLength(1)
  })

  it('stops during initialization without publishing a stale connection', async () => {
    const transport = new ControlledTransport()
    const lifecycle: CodexSupervisorLifecycleEvent[] = []
    const supervisor = trackCodexSupervisor(new CodexAppServerSupervisor({
      transportFactory: () => transport,
      restart: { stableResetMs: 0 },
    }))
    supervisor.onLifecycle((event) => lifecycle.push(event))

    const firstStart = supervisor.start()
    const concurrentStart = supervisor.start()
    const startResults = Promise.allSettled([firstStart, concurrentStart])
    await waitFor(
      () => transport.writes.length === 1,
      'supervisor did not begin initialization',
    )

    await supervisor.stop()
    await supervisor.stop()
    expect(supervisor.state).toBe('stopped')

    transport.server({ id: 1, result: initializeResult })
    const results = await startResults

    expect(results).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.any(CodexConnectionClosedError) }),
      expect.objectContaining({ status: 'rejected', reason: expect.any(CodexConnectionClosedError) }),
    ])
    expect(supervisor.state).toBe('stopped')
    expect(supervisor.client).toBeNull()
    expect(transport.closed).toBe(true)
    expect(transport.listenerCount()).toBe(0)
    expect(lifecycle.map((event) => event.type)).toEqual(['starting', 'stopped'])
  })

  it('exhausts bounded restart attempts and rejects waiters without another spawn', async () => {
    let factoryCalls = 0
    let initialTransport: ControlledTransport | undefined
    const lifecycle: CodexSupervisorLifecycleEvent[] = []
    const supervisor = trackCodexSupervisor(new CodexAppServerSupervisor({
      transportFactory: () => {
        factoryCalls += 1
        if (factoryCalls === 1) {
          initialTransport = autoInitialize(new ControlledTransport())
          return initialTransport
        }
        throw new Error(`restart transport failure ${factoryCalls - 1}`)
      },
      restart: {
        maxAttempts: 2,
        initialDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
        stableResetMs: 60_000,
      },
    }))
    supervisor.onLifecycle((event) => lifecycle.push(event))

    await supervisor.start()
    initialTransport!.disconnect(false)
    const waitingRequest = supervisor.request('account/read', {}).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    )

    await waitFor(
      () => supervisor.state === 'failed',
      'supervisor did not exhaust its restart attempts',
    )

    expect((await waitingRequest).error).toEqual(
      expect.objectContaining({ message: 'restart transport failure 2' }),
    )
    expect(factoryCalls).toBe(3)
    expect(lifecycle.filter((event) => event.type === 'restart_scheduled')
      .map((event) => event.attempt)).toEqual([1, 2])
    expect(lifecycle.filter((event) => event.type === 'restart_exhausted'))
      .toEqual([
        expect.objectContaining({
          state: 'failed',
          attempt: 3,
          error: 'restart transport failure 2',
        }),
      ])
  })
})

describe('RuntimeSupervisor transition guards', () => {
  it('persists starting to failed when PTY spawn throws', async () => {
    const persistence = new MemoryRuntimePersistence()
    const supervisor = trackRuntimeSupervisor(new RuntimeSupervisor({
      persistence,
      pty: {
        spawn: () => {
          throw new Error('controlled PTY spawn failure')
        },
      },
    }))

    await expect(supervisor.spawn({
      workspaceId: 'workspace-spawn-failure',
      command: 'controlled',
      args: [],
      shell: false,
      cwd: process.cwd(),
    })).rejects.toThrow('controlled PTY spawn failure')

    expect([...persistence.processes.values()]).toEqual([
      expect.objectContaining({
        workspaceId: 'workspace-spawn-failure',
        status: 'failed',
        pid: null,
        exitCode: null,
        endedAt: expect.any(String),
      }),
    ])
    expect(persistence.events).toEqual([
      expect.objectContaining({
        kind: 'process.failed',
        workspaceId: 'workspace-spawn-failure',
        payload: {
          phase: 'spawn',
          error: 'controlled PTY spawn failure',
        },
      }),
    ])
    expect(supervisor.hasLiveProcesses('workspace-spawn-failure')).toBe(false)
  })

  it('rejects restart for running and non-restartable terminal processes', async () => {
    const backend = new ControlledPtyBackend()
    const persistence = new MemoryRuntimePersistence()
    const supervisor = trackRuntimeSupervisor(new RuntimeSupervisor({
      persistence,
      pty: backend,
    }))
    const running = await supervisor.spawn({
      workspaceId: 'workspace-running',
      command: 'controlled-running',
      args: [],
      shell: false,
      cwd: process.cwd(),
    })

    await expect(supervisor.restart(running.id))
      .rejects.toThrow(`process ${running.id} must stop before restart`)

    const nonRestartable = await supervisor.spawn({
      workspaceId: 'workspace-non-restartable',
      command: 'controlled-terminal',
      args: [],
      shell: false,
      cwd: process.cwd(),
      restartable: false,
    })
    backend.ptys[1].emitExit(0)
    await waitFor(
      async () => (await supervisor.get(nonRestartable.id))?.status === 'exited',
      'non-restartable process did not terminalize',
    )

    await expect(supervisor.restart(nonRestartable.id))
      .rejects.toThrow(`process ${nonRestartable.id} is not restartable`)
    expect(backend.ptys).toHaveLength(2)
    expect(persistence.events.some((event) => event.kind === 'process.restarted')).toBe(false)
  })

  it('makes terminal stop idempotent while rejecting unknown process IDs', async () => {
    const backend = new ControlledPtyBackend()
    const persistence = new MemoryRuntimePersistence()
    const supervisor = trackRuntimeSupervisor(new RuntimeSupervisor({
      persistence,
      pty: backend,
    }))
    const record = await supervisor.spawn({
      workspaceId: 'workspace-stop',
      command: 'controlled-stop',
      args: [],
      shell: false,
      cwd: process.cwd(),
    })

    const first = await supervisor.stop(record.id, 0)
    const eventCountAfterFirstStop = persistence.events.length
    const second = await supervisor.stop(record.id, 0)

    expect(first).toMatchObject({ id: record.id, status: 'stopped', exitCode: 0, pid: null })
    expect(second).toEqual(first)
    expect(backend.ptys[0].killSignals).toHaveLength(1)
    expect(persistence.events).toHaveLength(eventCountAfterFirstStop)
    expect(persistence.events.filter((event) => event.kind === 'process.stopping')).toHaveLength(1)
    expect(persistence.events.filter((event) => event.kind === 'process.stopped')).toHaveLength(1)
    await expect(supervisor.stop('missing-process', 0))
      .rejects.toThrow('process missing-process not found')
  })
})

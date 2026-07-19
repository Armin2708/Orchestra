import { afterEach, describe, expect, it } from 'vitest'
import {
  ClaudeAgentDriverAdapter,
  DriverRegistry,
  RuntimeSupervisor,
  ShellAgentDriver,
  type ClaudeConductorPort,
  type ClaudeTranscriptLine,
  type PtyBackend,
  type PtyHandle,
} from '../src/runtime/index.js'

class DriverPty implements PtyHandle {
  readonly pid = 5252
  readonly process = 'driver-fake'
  readonly writes: (string | Buffer)[] = []
  private data = new Set<(value: string) => void>()
  private exits = new Set<(event: { exitCode: number; signal?: number }) => void>()
  onData = (listener: (value: string) => void) => {
    this.data.add(listener)
    return { dispose: () => this.data.delete(listener) }
  }
  onExit = (listener: (event: { exitCode: number; signal?: number }) => void) => {
    this.exits.add(listener)
    return { dispose: () => this.exits.delete(listener) }
  }
  write(data: string | Buffer): void { this.writes.push(data) }
  resize(): void {}
  kill(): void { for (const listener of [...this.exits]) listener({ exitCode: 0 }) }
  emit(data: string): void { for (const listener of this.data) listener(data) }
}

class DriverBackend implements PtyBackend {
  readonly ptys: DriverPty[] = []
  spawn(): PtyHandle {
    const pty = new DriverPty()
    this.ptys.push(pty)
    return pty
  }
}

const runtimes: RuntimeSupervisor[] = []

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.shutdown(10)))
})

describe('provider-neutral drivers', () => {
  it('maps a shell session to a raw RuntimeSupervisor process', async () => {
    const backend = new DriverBackend()
    const runtime = new RuntimeSupervisor({ pty: backend })
    runtimes.push(runtime)
    const driver = new ShellAgentDriver(runtime)
    const session = await driver.launch({
      workspaceId: 'workspace-shell',
      cwd: process.cwd(),
      command: 'npm test',
      prompt: 'initial bytes\r',
    })

    expect(driver.capabilities()).toMatchObject({ rawTerminal: true, attach: true, resume: false })
    expect(session).toMatchObject({ driverId: 'shell', workspaceId: 'workspace-shell', status: 'running' })
    expect(backend.ptys[0].writes).toEqual(['initial bytes\r'])
    await driver.send(session.id, 'next bytes\r')
    expect(backend.ptys[0].writes).toEqual(['initial bytes\r', 'next bytes\r'])
    expect((await driver.attach(session.externalId))?.id).toBe(session.id)

    const iterator = driver.events(session.id)[Symbol.asyncIterator]()
    const eventPromise = iterator.next()
    await new Promise((resolve) => setTimeout(resolve, 0))
    backend.ptys[0].emit('xterm output\r\n')
    const event = await eventPromise
    expect(event.value).toMatchObject({
      sessionId: session.id,
      type: 'output',
      data: 'xterm output\r\n',
      metadata: { outputSeq: 1, stream: 'pty' },
    })
    await iterator.return?.()
  })

  it('adapts existing Conductor semantics without importing or modifying Conductor', async () => {
    let nextId = 1
    const live = new Set<number>()
    const transcripts = new Map<number, ClaudeTranscriptLine[]>()
    const tasks: { id: number; text: string }[] = []
    const interrupted: number[] = []
    const hires: Record<string, unknown>[] = []
    const conductor: ClaudeConductorPort = {
      isHired: (id) => live.has(id),
      hire: (options) => {
        hires.push(options)
        const id = nextId++
        live.add(id)
        transcripts.set(id, [])
        return { id, name: options.name, sdk_session: options.resumeSession ?? `sdk-${id}` }
      },
      task: (id, text) => { tasks.push({ id, text }); return live.has(id) },
      transcript: (id) => ({ lines: transcripts.get(id) ?? [], working: null }),
      interruptAgent: async (id) => { interrupted.push(id); return live.has(id) },
      fire: async (id) => live.delete(id),
    }
    const driver = new ClaudeAgentDriverAdapter({ conductor, pollIntervalMs: 25 })
    const session = await driver.launch({
      workspaceId: 'workspace-claude',
      boardId: 3,
      cwd: process.cwd(),
      name: 'violet-fox',
      model: 'claude-test',
      prompt: 'Implement the task',
      metadata: { cardId: 77 },
    })

    expect(driver.capabilities()).toMatchObject({ rawTerminal: false, resume: true })
    expect(session).toMatchObject({ driverId: 'claude', externalId: 'sdk-1', workspaceId: 'workspace-claude' })
    expect(hires[0]).toMatchObject({ boardId: 3, cardId: 77, model: 'claude-test' })
    expect(tasks).toEqual([{ id: 1, text: 'Implement the task' }])
    await driver.send(session.id, 'Follow-up')
    await driver.interrupt(session.id)
    expect(tasks.at(-1)).toEqual({ id: 1, text: 'Follow-up' })
    expect(interrupted).toEqual([1])

    transcripts.get(1)!.push({ at: new Date().toISOString(), kind: 'tool', text: 'Bash(npm test)' })
    const iterator = driver.events(session.id)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ type: 'tool', data: 'Bash(npm test)' })
    await driver.stop(session.id)
    expect((await iterator.next()).value).toMatchObject({ type: 'exit', data: 'Claude session stopped' })
  })

  it('attaches Claude sessions through injected identity and workspace resolvers', async () => {
    const conductor: ClaudeConductorPort = {
      isHired: (id) => id === 44,
      hire: () => ({ id: 44 }),
      task: () => true,
      transcript: () => ({ lines: [], working: null }),
      interruptAgent: async () => true,
      fire: async () => true,
    }
    const driver = new ClaudeAgentDriverAdapter({
      conductor,
      resolveAgent: (externalId) => externalId === 'sdk-existing' ? { id: 44, sdk_session: externalId } : null,
      workspaceForAgent: () => 'workspace-existing',
    })

    expect(await driver.attach('sdk-existing')).toMatchObject({
      id: 'claude:44', externalId: 'sdk-existing', workspaceId: 'workspace-existing', status: 'running',
    })
    expect(await driver.attach('missing')).toBeNull()
  })

  it('registers and describes provider drivers deterministically', () => {
    const backend = new DriverBackend()
    const runtime = new RuntimeSupervisor({ pty: backend })
    runtimes.push(runtime)
    const shell = new ShellAgentDriver(runtime)
    const registry = new DriverRegistry([shell])

    expect(registry.require('shell')).toBe(shell)
    expect(registry.list()).toEqual([{ id: 'shell', capabilities: shell.capabilities() }])
    expect(() => registry.register(shell)).toThrow('already registered')
    expect(() => registry.require('unknown')).toThrow('unsupported driver')
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MemoryRuntimePersistence,
  RuntimeSupervisor,
  type ProcessOutputChunk,
  type PtyBackend,
  type PtyHandle,
} from '../src/runtime/index.js'

class FakePty implements PtyHandle {
  readonly pid = 4242
  readonly process = 'fake'
  readonly writes: (string | Buffer)[] = []
  cols = 80
  rows = 24
  private dataListeners = new Set<(data: string) => void>()
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()

  onData = (listener: (data: string) => void) => {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onExit = (listener: (event: { exitCode: number; signal?: number }) => void) => {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  write(data: string | Buffer): void { this.writes.push(data) }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows }
  kill(signal?: string): void {
    if (signal === 'SIGINT') return
    this.emitExit(0)
  }
  emit(data: string): void { for (const listener of this.dataListeners) listener(data) }
  emitExit(exitCode: number, signal?: number): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode, signal })
  }
}

class FakeBackend implements PtyBackend {
  readonly ptys: FakePty[] = []
  spawn(): PtyHandle {
    const pty = new FakePty()
    this.ptys.push(pty)
    return pty
  }
}

const supervisors: RuntimeSupervisor[] = []
const tempRoots: string[] = []

const until = async (condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const runtime = (options: ConstructorParameters<typeof RuntimeSupervisor>[0] = {}) => {
  const value = new RuntimeSupervisor(options)
  supervisors.push(value)
  return value
}

afterEach(async () => {
  await Promise.allSettled(supervisors.splice(0).map((supervisor) => supervisor.shutdown(100)))
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('RuntimeSupervisor', () => {
  it('runs a real PTY with xterm output, input, resize, and an exact exit code', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'orchestra-real-pty-'))
    tempRoots.push(cwd)
    const supervisor = runtime()
    const script = [
      "process.stdin.setEncoding('utf8')",
      "console.log('ready')",
      "process.stdin.once('data', d => { console.log('got:' + d.trim()); process.exit(0) })",
    ].join(';')
    const processRecord = await supervisor.spawn({
      workspaceId: 'workspace-real',
      name: 'interactive node',
      command: process.execPath,
      args: ['-e', script],
      shell: false,
      cwd,
      cols: 90,
      rows: 30,
    })
    await until(async () => (await supervisor.readOutput(processRecord.id)).chunks.some((chunk) => chunk.data.includes('ready')))

    const resized = await supervisor.resize(processRecord.id, 132, 48)
    expect(resized).toMatchObject({ cols: 132, rows: 48, status: 'running' })
    await supervisor.write(processRecord.id, 'hello\r')
    await until(async () => ['exited', 'failed'].includes((await supervisor.get(processRecord.id))!.status))
    await supervisor.flush(processRecord.id)

    const ended = await supervisor.get(processRecord.id)
    const output = await supervisor.readOutput(processRecord.id)
    expect(ended).toMatchObject({ status: 'exited', exitCode: 0, pid: null })
    expect(output.chunks.map((chunk) => chunk.data).join('')).toContain('got:hello')
    expect(output.chunks.map((chunk) => chunk.seq)).toEqual(
      [...output.chunks].map((_, index) => index + 1),
    )
  }, 20_000)

  it('serializes output persistence and bounds both memory and durable history', async () => {
    const backend = new FakeBackend()
    const order: number[] = []
    class SlowPersistence extends MemoryRuntimePersistence {
      override async appendOutput(chunk: ProcessOutputChunk): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, (16 - chunk.seq) * 2))
        order.push(chunk.seq)
        super.appendOutput(chunk)
      }
    }
    const persistence = new SlowPersistence()
    const supervisor = runtime({ pty: backend, persistence, maxOutputChunks: 10, maxOutputBytes: 1_024 })
    const record = await supervisor.spawn({
      workspaceId: 'workspace-order', command: 'fake', args: [], shell: false, cwd: process.cwd(),
    })
    for (let index = 1; index <= 15; index++) backend.ptys[0].emit(`chunk-${index}\n`)
    await supervisor.flush(record.id)

    expect(order).toEqual(Array.from({ length: 15 }, (_, index) => index + 1))
    const page = await supervisor.readOutput(record.id, 0, 100)
    expect(page.truncated).toBe(true)
    expect(page.chunks[0].seq).toBe(6)
    expect(page.chunks.at(-1)?.seq).toBe(15)
  })

  it('audits input, resize, signals, and stop transitions', async () => {
    const backend = new FakeBackend()
    const persistence = new MemoryRuntimePersistence()
    const supervisor = runtime({ pty: backend, persistence })
    const record = await supervisor.spawn({
      workspaceId: 'workspace-control', command: 'fake', args: [], shell: false, cwd: process.cwd(),
    })

    await supervisor.write(record.id, 'secret input', 'human')
    await supervisor.resize(record.id, 100, 40)
    await supervisor.signal(record.id, 'SIGINT')
    const stopped = await supervisor.stop(record.id, 10)

    expect(stopped.status).toBe('stopped')
    expect(backend.ptys[0].writes).toEqual(['secret input'])
    expect(persistence.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'process.started', 'process.input', 'process.resized', 'process.signal', 'process.stopping', 'process.stopped',
    ]))
    const input = persistence.events.find((event) => event.kind === 'process.input')!
    expect(input.payload).toMatchObject({ source: 'human', bytes: 12 })
    expect(JSON.stringify(input)).not.toContain('secret input')
  })

  it('exposes restart recipes and creates a new durable process on restart', async () => {
    const backend = new FakeBackend()
    const supervisor = runtime({ pty: backend })
    const first = await supervisor.spawn({
      workspaceId: 'workspace-restart',
      name: 'dev server',
      command: 'npm run dev',
      shell: true,
      cwd: process.cwd(),
      env: { PORT: '4321' },
      cols: 111,
      rows: 33,
    })
    backend.ptys[0].emitExit(0)
    await until(async () => (await supervisor.get(first.id))?.status === 'exited')

    expect(await supervisor.restartRecipe(first.id)).toMatchObject({
      workspaceId: 'workspace-restart', command: 'npm run dev', env: { PORT: '4321' }, cols: 111, rows: 33,
    })
    const second = await supervisor.restart(first.id)
    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe('running')
  })

  it('marks daemon-orphaned records lost and leaves a reconstructable recipe', async () => {
    const persistence = new MemoryRuntimePersistence()
    const stale = persistence.createProcess({
      workspaceId: 'workspace-lost',
      name: 'old server',
      command: 'npm run dev',
      cwd: process.cwd(),
      status: 'running',
      pid: 999_999,
      exitCode: null,
      cols: 120,
      rows: 32,
      restartable: true,
      startedAt: new Date().toISOString(),
      endedAt: null,
    })
    const supervisor = runtime({ persistence, pty: new FakeBackend() })

    const lost = await supervisor.reconcileLost()

    expect(lost).toHaveLength(1)
    expect(lost[0]).toMatchObject({ id: stale.id, status: 'lost', pid: null })
    expect(await supervisor.restartRecipe(stale.id)).toMatchObject({ command: 'npm run dev', shell: true })
    expect(persistence.events.at(-1)?.payload).toMatchObject({ previousPid: 999_999, restartable: true })
  })

  it('delegates port discovery with the live workspace process set', async () => {
    const backend = new FakeBackend()
    const seen: string[] = []
    const supervisor = runtime({
      pty: backend,
      discoverPorts: (processes) => {
        seen.push(...processes.map((record) => record.id))
        return processes.map((record) => ({
          processId: record.id, workspaceId: record.workspaceId, pid: record.pid!, host: '127.0.0.1', port: 5173, protocol: 'tcp',
        }))
      },
    })
    const record = await supervisor.spawn({
      workspaceId: 'workspace-port', command: 'fake', args: [], shell: false, cwd: process.cwd(),
    })

    expect(await supervisor.discoverPorts('workspace-port')).toEqual([
      { processId: record.id, workspaceId: 'workspace-port', pid: 4242, host: '127.0.0.1', port: 5173, protocol: 'tcp' },
    ])
    expect(seen).toEqual([record.id])
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import {
  MemoryRuntimePersistence,
  RuntimeSupervisor,
  type ProcessOutputChunk,
  type ProcessRecord,
} from '../src/runtime/index.js'

const supervisors: RuntimeSupervisor[] = []

class BackpressuredPersistence extends MemoryRuntimePersistence {
  override async appendOutput(chunk: ProcessOutputChunk): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1))
    super.appendOutput(chunk)
  }
}

const runtime = (options: ConstructorParameters<typeof RuntimeSupervisor>[0] = {}) => {
  const supervisor = new RuntimeSupervisor(options)
  supervisors.push(supervisor)
  return supervisor
}

const until = async (condition: () => boolean | Promise<boolean>, timeoutMs = 20_000) => {
  const startedAt = Date.now()
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('PTY contract condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const outputText = async (supervisor: RuntimeSupervisor, processId: string, afterSeq = 0) =>
  (await supervisor.readOutput(processId, afterSeq, 10_000)).chunks.map((chunk) => chunk.data).join('')

const waitForOutput = async (supervisor: RuntimeSupervisor, processId: string, expected: string) => {
  await until(async () => (await outputText(supervisor, processId)).includes(expected))
}

const waitForTerminal = async (supervisor: RuntimeSupervisor, processId: string): Promise<ProcessRecord> => {
  let record: ProcessRecord | undefined
  await until(async () => {
    record = await supervisor.get(processId)
    return Boolean(record && ['stopped', 'exited', 'failed', 'lost'].includes(record.status))
  })
  await supervisor.flush(processId)
  return record!
}

afterEach(async () => {
  await Promise.allSettled(supervisors.splice(0).map((supervisor) => supervisor.shutdown(100)))
})

describe('raw PTY reliability contract', () => {
  it('preserves exact Unicode, ANSI, and control output through a non-zero process exit', async () => {
    const supervisor = runtime()
    const expected = '\u001b[38;5;214mZażółć gęślą jaźń · 你好 · 🚀\u001b[0m\u0000END'
    const encoded = Buffer.from(expected).toString('base64')
    const script = `process.stdout.write(Buffer.from(${JSON.stringify(encoded)},'base64'),()=>process.exit(23))`
    const processRecord = await supervisor.spawn({
      workspaceId: 'pty-exact-output',
      command: process.execPath,
      args: ['-e', script],
      shell: false,
      cwd: process.cwd(),
    })

    const ended = await waitForTerminal(supervisor, processRecord.id)
    const page = await supervisor.readOutput(processRecord.id, 0, 10_000)

    expect(page.chunks.map((chunk) => chunk.data).join('')).toBe(expected)
    expect(page.chunks.map((chunk) => chunk.seq)).toEqual(
      page.chunks.map((_, index) => index + 1),
    )
    expect(ended).toMatchObject({ status: 'failed', exitCode: 23, pid: null })
  })

  it('drains large output without loss, duplication, reordering, or premature exit finalization', async () => {
    const supervisor = runtime({
      persistence: new BackpressuredPersistence(),
      maxOutputBytes: 2 * 1024 * 1024,
      maxOutputChunks: 10_000,
    })
    const unit = '0123456789abcdef'
    const repeat = 49_152
    const expected = unit.repeat(repeat)
    const script = [
      `const payload=${JSON.stringify(unit)}.repeat(${repeat})`,
      "process.stdout.write(payload,()=>process.exit(0))",
    ].join(';')
    const processRecord = await supervisor.spawn({
      workspaceId: 'pty-large-output',
      command: process.execPath,
      args: ['-e', script],
      shell: false,
      cwd: process.cwd(),
    })

    const ended = await waitForTerminal(supervisor, processRecord.id)
    const page = await supervisor.readOutput(processRecord.id, 0, 10_000)

    expect(page.truncated).toBe(false)
    expect(page.chunks.length).toBeGreaterThan(1)
    expect(page.chunks.map((chunk) => chunk.seq)).toEqual(
      page.chunks.map((_, index) => index + 1),
    )
    expect(page.chunks.map((chunk) => chunk.data).join('')).toBe(expected)
    expect(ended).toMatchObject({ status: 'exited', exitCode: 0, pid: null })
  }, 30_000)

  it('keeps rapid concurrent input ordered and lets a disconnected reader resume from its exact cursor', async () => {
    const persistence = new MemoryRuntimePersistence()
    const supervisor = runtime({ persistence })
    const pieces = Array.from({ length: 300 }, (_, index) => `${String(index).padStart(4, '0')}|`)
    const expected = pieces.join('')
    const expectedBytes = Buffer.byteLength(expected)
    const script = [
      "process.stdin.setRawMode(true)",
      'process.stdin.resume()',
      'let received=Buffer.alloc(0)',
      'let complete=false',
      "process.stdin.on('data',chunk=>{",
      'if(complete)return',
      'received=Buffer.concat([received,chunk])',
      `if(received.length>=${expectedBytes}){`,
      'complete=true',
      "process.stdout.write('RESULT:'+received.toString('base64'),()=>process.exit(0))",
      '}',
      '})',
      "process.stdout.write('READY')",
    ].join(';')
    const processRecord = await supervisor.spawn({
      workspaceId: 'pty-rapid-input',
      command: process.execPath,
      args: ['-e', script],
      shell: false,
      cwd: process.cwd(),
    })
    await waitForOutput(supervisor, processRecord.id, 'READY')
    const disconnectedAt = await supervisor.readOutput(processRecord.id, 0, 10_000)

    await Promise.all(pieces.map((piece) => supervisor.write(processRecord.id, piece)))
    const ended = await waitForTerminal(supervisor, processRecord.id)
    const reconnected = await supervisor.readOutput(processRecord.id, disconnectedAt.nextSeq, 10_000)
    const resumedText = reconnected.chunks.map((chunk) => chunk.data).join('')

    expect(resumedText).not.toContain('READY')
    expect(resumedText).toBe(`RESULT:${Buffer.from(expected).toString('base64')}`)
    expect(reconnected.chunks.map((chunk) => chunk.seq)).toEqual(
      reconnected.chunks.map((_, index) => disconnectedAt.nextSeq + index + 1),
    )
    expect(ended).toMatchObject({ status: 'exited', exitCode: 0, pid: null })
    const inputEvents = persistence.events.filter((event) => event.kind === 'process.input')
    expect(inputEvents).toHaveLength(pieces.length)
    expect(inputEvents.map((event) => event.payload.bytes)).toEqual(pieces.map((piece) => Buffer.byteLength(piece)))
    expect(inputEvents.every((event) => !JSON.stringify(event.payload).includes('0000|'))).toBe(true)
  }, 30_000)

  it.skipIf(process.platform === 'win32')(
    'propagates resize and signals to the real PTY and persists the resulting exit semantics',
    async () => {
      const persistence = new MemoryRuntimePersistence()
      const supervisor = runtime({ persistence })
      // Node refreshes cached stdout dimensions on SIGWINCH; input and resize callbacks may run in either order.
      const script = [
        "process.stdin.setRawMode(true)",
        'process.stdin.resume()',
        "const size=()=>process.stdout.getWindowSize().join('x')",
        "process.stdout.once('resize',()=>process.stdout.write('RESIZE:'+size()))",
        "process.stdin.on('data',data=>{if(data.includes(115))process.stdout.write('INPUT:s')})",
        "process.on('SIGINT',()=>process.stdout.write('SIGNAL:SIGINT',()=>process.exit(42)))",
        "process.stdout.write('READY:'+size())",
      ].join(';')
      const processRecord = await supervisor.spawn({
        workspaceId: 'pty-controls',
        command: process.execPath,
        args: ['-e', script],
        shell: false,
        cwd: process.cwd(),
        cols: 91,
        rows: 27,
      })
      await waitForOutput(supervisor, processRecord.id, 'READY:91x27')

      const resized = await supervisor.resize(processRecord.id, 137, 43)
      await supervisor.write(processRecord.id, 's')
      await Promise.all([
        waitForOutput(supervisor, processRecord.id, 'RESIZE:137x43'),
        waitForOutput(supervisor, processRecord.id, 'INPUT:s'),
      ])
      await supervisor.signal(processRecord.id, 'SIGINT')
      const ended = await waitForTerminal(supervisor, processRecord.id)
      const output = await outputText(supervisor, processRecord.id)

      expect(resized).toMatchObject({ cols: 137, rows: 43, status: 'running' })
      expect(output).toContain('READY:91x27')
      expect(output).toContain('RESIZE:137x43')
      expect(output).toContain('INPUT:s')
      expect(output).toContain('SIGNAL:SIGINT')
      expect(ended).toMatchObject({ status: 'failed', exitCode: 42, pid: null, cols: 137, rows: 43 })
      expect(persistence.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
        'process.started',
        'process.resized',
        'process.signal',
        'process.failed',
      ]))
      expect(persistence.events.find((event) => event.kind === 'process.signal')?.payload)
        .toEqual({ signal: 'SIGINT' })
      expect(persistence.events.find((event) => event.kind === 'process.failed')?.payload)
        .toMatchObject({ exitCode: 42 })
    },
    30_000,
  )
})

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { QwenAgentDriver } from '../src/runtime/drivers/qwen.js'
import type { DriverEvent, DriverLaunchRequest } from '../src/runtime/types.js'

class FakeQwenProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  exitCode: number | null = null
  readonly signals: string[] = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal ?? 'SIGTERM'))
    return true
  }

  emitLine(value: unknown): void {
    const line = typeof value === 'string' ? value : JSON.stringify(value)
    this.stdout.emit('data', Buffer.from(`${line}\n`, 'utf8'))
  }

  finish(code = 0): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

const makeDriver = (extra: Record<string, unknown> = {}) => {
  const spawns: Array<{ command: string; args: string[]; options: any; process: FakeQwenProcess }> = []
  const driver = new QwenAgentDriver({
    command: '/bin/qwen',
    environment: { PATH: '/bin', HOME: '/home/op' },
    interruptGraceMs: 5,
    spawnImpl: ((command: string, args: string[], options: any) => {
      const process = new FakeQwenProcess()
      spawns.push({ command, args, options, process })
      return process
    }) as never,
    ...extra,
  })
  const latest = () => spawns[spawns.length - 1]
  return { driver, spawns, latest }
}

const take = async (iterable: AsyncIterable<DriverEvent>, count: number): Promise<DriverEvent[]> => {
  const out: DriverEvent[] = []
  const iterator = iterable[Symbol.asyncIterator]()
  while (out.length < count) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: DriverEvent | undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 6_000)),
    ])
    if (next.done) break
    out.push(next.value as DriverEvent)
  }
  return out
}

const baseLaunch = (overrides: Partial<DriverLaunchRequest> = {}): DriverLaunchRequest => ({
  workspaceId: 'ws:1',
  cwd: '/private/tmp/project',
  prompt: 'say pong',
  ...overrides,
})

describe('QwenAgentDriver', () => {
  it('launches a non-interactive stream-json turn with model and chat recording', async () => {
    const { driver, latest } = makeDriver()
    const session = await driver.launch(baseLaunch({ model: 'qwen3-coder-plus' }))

    expect(latest().command).toBe('/bin/qwen')
    expect(latest().args).toEqual([
      '-p', 'say pong', '-o', 'stream-json', '--chat-recording', '-m', 'qwen3-coder-plus',
    ])
    expect(latest().options.cwd).toBe('/private/tmp/project')
    expect(latest().options.env).toEqual({ PATH: '/bin', HOME: '/home/op' })
    expect(session).toMatchObject({ driverId: 'qwen', status: 'running', externalId: '' })
  })

  it('maps stream-json events to driver events and binds the provider session id', async () => {
    const { driver, latest } = makeDriver()
    const session = await driver.launch(baseLaunch())
    const events = driver.events(session.id)

    latest().process.emitLine({
      type: 'system', subtype: 'init', session_id: 'qsess-1', model: 'qwen3.8-max',
      permission_mode: 'auto', qwen_code_version: '0.21.6',
    })
    latest().process.emitLine({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'ponder' }, { type: 'text', text: 'PONG' }] },
    })
    latest().process.emitLine({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'call-1', name: 'list_directory', input: { path: '.' } }] },
    })
    latest().process.emitLine({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: false, content: 'ok' }] },
    })
    latest().process.emitLine({
      type: 'result', subtype: 'success', is_error: false, result: 'PONG', num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, total_tokens: 12 },
    })
    latest().process.finish(0)

    const seen = await take(events, 8)
    expect(seen.map((event) => event.type)).toEqual([
      'status', 'status', 'output', 'output', 'tool', 'tool', 'status', 'status',
    ])
    expect(seen[0].metadata).toMatchObject({ phase: 'turn_started' })
    const init = seen[1]
    expect(init.metadata).toMatchObject({ phase: 'session_init', providerSessionId: 'qsess-1', model: 'qwen3.8-max' })
    expect(seen[2]).toMatchObject({ type: 'output', data: 'ponder', metadata: { kind: 'thinking' } })
    expect(seen[3]).toMatchObject({ type: 'output', data: 'PONG', metadata: { kind: 'text' } })
    expect(seen[4].metadata).toMatchObject({ kind: 'tool_call', toolCallId: 'call-1' })
    expect(seen[5].metadata).toMatchObject({ kind: 'tool_result', isError: false })
    expect(seen[6].metadata).toMatchObject({
      phase: 'result',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, total_tokens: 12 },
    })
    expect(seen[7].metadata).toMatchObject({ phase: 'turn_completed' })

    expect(session.externalId).toBe('qsess-1')
    expect(session.metadata.effectiveModel).toBe('qwen3.8-max')
    expect(driver.latestUsage(session.id)).toMatchObject({ total_tokens: 12 })
  })

  it('resumes the provider session on subsequent turns', async () => {
    const { driver, latest, spawns } = makeDriver()
    const session = await driver.launch(baseLaunch())
    const events = driver.events(session.id)

    latest().process.emitLine({ type: 'system', subtype: 'init', session_id: 'qsess-9', model: 'm' })
    latest().process.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
    latest().process.finish(0)
    await take(events, 3)

    await driver.send(session.id, 'follow up')
    expect(spawns).toHaveLength(2)
    expect(latest().args).toEqual([
      '-p', 'follow up', '-o', 'stream-json', '--chat-recording', '-r', 'qsess-9',
    ])
  })

  it('rejects a send while a turn is active and recovers sessions by provider id', async () => {
    const { driver, latest } = makeDriver()
    const session = await driver.launch(baseLaunch())
    driver.events(session.id)

    await expect(driver.send(session.id, 'interrupt me first')).rejects.toThrow('turn already active')

    const recovered = await driver.recover({
      externalId: 'existing-session', workspaceId: 'ws:2', cwd: '/private/tmp/project',
    })
    expect(recovered).toMatchObject({ externalId: 'existing-session', status: 'idle' })
    await driver.send(recovered!.id, 'resume me')
    expect(latest().args).toContain('-r')
    expect(latest().args).toContain('existing-session')
  })

  it('launching with an external id resumes immediately', async () => {
    const { driver, latest } = makeDriver()
    await driver.launch(baseLaunch({ externalId: 'qsess-42' }))
    expect(latest().args).toEqual([
      '-p', 'say pong', '-o', 'stream-json', '--chat-recording', '-r', 'qsess-42',
    ])
  })

  it('reports failed turns as error events without ending the session', async () => {
    const { driver, latest } = makeDriver()
    const session = await driver.launch(baseLaunch())
    const events = driver.events(session.id)

    latest().process.stderr.emit('data', Buffer.from('quota exhausted\n'))
    latest().process.finish(1)

    const seen = await take(events, 2)
    expect(seen[1]).toMatchObject({ type: 'error' })
    expect(seen[1].data).toContain('quota exhausted')
    expect(seen[1].metadata).toMatchObject({ phase: 'turn_failed' })
    expect(session.status).toBe('idle')
  })

  it('stops with an exit event and closes the event stream', async () => {
    const { driver, latest } = makeDriver()
    const session = await driver.launch(baseLaunch())
    const events = driver.events(session.id)
    const collecting = take(events, 3)

    await driver.stop(session.id)
    expect(latest().process.signals[0]).toBe('SIGINT')
    latest().process.finish(0)

    const seen = await collecting
    expect(seen.at(-1)).toMatchObject({ type: 'exit' })
    expect(session.status).toBe('stopped')
  })
})

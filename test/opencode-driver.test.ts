import { describe, expect, it, vi } from 'vitest'
import { OpenCodeAgentDriver } from '../src/runtime/drivers/opencode.js'
import { BoundedAsyncQueue } from '../src/codex/async.js'
import type { DriverEvent, DriverLaunchRequest, OsId, ProcessRecord, RuntimeStreamItem, SpawnProcessRequest } from '../src/runtime/types.js'
import type { RuntimeSupervisor } from '../src/runtime/supervisor.js'
import type { OpencodeClient } from '@opencode-ai/sdk'

/** Minimal fake RuntimeSupervisor covering only what OpenCodeAgentDriver calls. */
class FakeSupervisor {
  readonly spawned: Array<{
    request: SpawnProcessRequest
    record: ProcessRecord
    queue: BoundedAsyncQueue<RuntimeStreamItem>
  }> = []

  readonly stopped: OsId[] = []
  private nextId = 1

  async spawn(request: SpawnProcessRequest): Promise<ProcessRecord> {
    const record: ProcessRecord = {
      id: `proc-${this.nextId++}`,
      workspaceId: request.workspaceId,
      name: request.name ?? request.command,
      command: request.command,
      cwd: request.cwd,
      status: 'running',
      pid: 1234,
      exitCode: null,
      cols: 80,
      rows: 24,
      restartable: request.restartable ?? false,
      startedAt: new Date().toISOString(),
      endedAt: null,
    }
    this.spawned.push({ request, record, queue: new BoundedAsyncQueue<RuntimeStreamItem>(64) })
    return record
  }

  events(processId: OsId): AsyncIterable<RuntimeStreamItem> {
    const entry = this.spawned.find((candidate) => candidate.record.id === processId)
    if (!entry) throw new Error(`FakeSupervisor: no such process ${processId}`)
    return entry.queue
  }

  async stop(processId: OsId): Promise<ProcessRecord> {
    this.stopped.push(processId)
    const entry = this.spawned.find((candidate) => candidate.record.id === processId)
    if (!entry) throw new Error(`FakeSupervisor: no such process ${processId}`)
    entry.record.status = 'stopped'
    return entry.record
  }

  emitListening(index = 0, url = 'http://127.0.0.1:4097'): void {
    const entry = this.spawned[index]!
    entry.queue.push({
      type: 'output',
      output: {
        processId: entry.record.id,
        seq: 1,
        stream: 'stdout',
        data: `opencode server listening on ${url}`,
        createdAt: new Date().toISOString(),
      },
    })
  }

  emitProcessFailed(index = 0): void {
    const entry = this.spawned[index]!
    entry.queue.push({
      type: 'event',
      event: {
        kind: 'process.failed',
        processId: entry.record.id,
        workspaceId: entry.record.workspaceId,
        at: new Date().toISOString(),
        payload: {},
      },
    })
  }
}

/** Minimal fake OpencodeClient covering only what the driver calls. */
function makeFakeClient(overrides: Partial<{
  sessionId: string
  events: unknown[]
}> = {}) {
  const sessionId = overrides.sessionId ?? 'ses_abc123'
  const eventQueue = new BoundedAsyncQueue<unknown>(64)
  for (const event of overrides.events ?? []) eventQueue.push(event)

  const abortCalls: unknown[] = []
  const promptCalls: unknown[] = []

  const client = {
    session: {
      create: vi.fn(async (_opts: unknown) => ({ data: { id: sessionId }, error: undefined })),
      get: vi.fn(async (_opts: unknown) => ({ data: { id: sessionId }, error: undefined })),
      prompt: vi.fn(async (opts: unknown) => {
        promptCalls.push(opts)
        return { data: { info: { id: 'msg_1' } }, error: undefined }
      }),
      abort: vi.fn(async (opts: unknown) => {
        abortCalls.push(opts)
        return { data: true, error: undefined }
      }),
    },
    event: {
      subscribe: vi.fn(async (_opts: unknown) => ({ stream: eventQueue })),
    },
    config: {
      providers: vi.fn(async () => ({ data: { providers: [] }, error: undefined })),
    },
  }
  return { client: client as unknown as OpencodeClient, sessionId, abortCalls, promptCalls, eventQueue }
}

const baseLaunch = (overrides: Partial<DriverLaunchRequest> = {}): DriverLaunchRequest => ({
  workspaceId: 'ws:1',
  cwd: '/private/tmp/project',
  prompt: 'say pong',
  ...overrides,
})

const take = async (iterable: AsyncIterable<DriverEvent>, count: number): Promise<DriverEvent[]> => {
  const out: DriverEvent[] = []
  const iterator = iterable[Symbol.asyncIterator]()
  while (out.length < count) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: DriverEvent | undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 2_000)),
    ])
    if (next.done) break
    out.push(next.value as DriverEvent)
  }
  return out
}

const makeDriver = (fakeClient: ReturnType<typeof makeFakeClient>) => {
  const supervisor = new FakeSupervisor()
  const driver = new OpenCodeAgentDriver(supervisor as unknown as RuntimeSupervisor, {
    command: '/bin/opencode',
    port: 4097,
    createClient: () => fakeClient.client,
    serverStartTimeoutMs: 1_000,
  })
  return { driver, supervisor }
}

describe('OpenCodeAgentDriver', () => {
  it('starts one shared server process and creates a directory-scoped session', async () => {
    const fakeClient = makeFakeClient()
    const { driver, supervisor } = makeDriver(fakeClient)

    const launchPromise = driver.launch(baseLaunch())
    // Readiness is gated on the "opencode server listening" line arriving on
    // the supervisor's output stream, same as @opencode-ai/sdk's own
    // createOpencodeServer() readiness check.
    await Promise.resolve()
    supervisor.emitListening()
    const session = await launchPromise

    expect(supervisor.spawned).toHaveLength(1)
    expect(supervisor.spawned[0]!.request.command).toBe('/bin/opencode')
    expect(supervisor.spawned[0]!.request.args).toEqual([
      'serve', '--hostname=127.0.0.1', '--port=4097',
    ])
    expect(session).toMatchObject({ driverId: 'opencode', status: 'idle', externalId: fakeClient.sessionId })
    expect(fakeClient.promptCalls).toHaveLength(1)
    expect(fakeClient.promptCalls[0]).toMatchObject({
      path: { id: fakeClient.sessionId },
      query: { directory: '/private/tmp/project' },
      body: { parts: [{ type: 'text', text: 'say pong' }] },
    })
  })

  it('reuses the same server process across a second launch in a different workspace', async () => {
    const fakeClient = makeFakeClient()
    const { driver, supervisor } = makeDriver(fakeClient)

    const first = driver.launch(baseLaunch())
    await Promise.resolve()
    supervisor.emitListening()
    await first

    await driver.launch(baseLaunch({ workspaceId: 'ws:2', cwd: '/private/tmp/other', prompt: '' }))

    expect(supervisor.spawned).toHaveLength(1)
    expect(fakeClient.client.session.create).toHaveBeenCalledTimes(2)
  })

  it('maps message/tool/idle/error SSE events to DriverEvent, including real usage from AssistantMessage', async () => {
    const fakeClient = makeFakeClient()
    const { driver, supervisor } = makeDriver(fakeClient)

    const launchPromise = driver.launch(baseLaunch({ prompt: '' }))
    await Promise.resolve()
    supervisor.emitListening()
    const session = await launchPromise
    const events = driver.events(session.id)

    fakeClient.eventQueue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part_1', sessionID: fakeClient.sessionId, messageID: 'msg_1',
          type: 'text', text: 'PONG',
        },
        delta: 'PONG',
      },
    })
    fakeClient.eventQueue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part_2', sessionID: fakeClient.sessionId, messageID: 'msg_1',
          type: 'tool', callID: 'call_1', tool: 'list_directory',
          state: { status: 'completed', input: { path: '.' }, output: 'ok', title: 'ls', metadata: {}, time: { start: 0, end: 1 } },
        },
      },
    })
    fakeClient.eventQueue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_1', sessionID: fakeClient.sessionId, role: 'assistant',
          time: { created: 0, completed: 1 }, parentID: 'msg_0', modelID: 'sonnet-5',
          providerID: 'anthropic', mode: 'build', path: { cwd: '/private/tmp/project', root: '/private/tmp/project' },
          cost: 0.02, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    })
    fakeClient.eventQueue.push({ type: 'session.idle', properties: { sessionID: fakeClient.sessionId } })
    fakeClient.eventQueue.push({
      type: 'session.error',
      properties: { sessionID: fakeClient.sessionId, error: { name: 'ProviderAuthError' } },
    })

    const seen = await take(events, 5)
    expect(seen.map((event) => event.type)).toEqual(['output', 'tool', 'status', 'status', 'error'])
    expect(seen[0]).toMatchObject({ data: 'PONG', metadata: { kind: 'text' } })
    expect(seen[1].metadata).toMatchObject({ kind: 'tool_result', toolCallId: 'call_1', status: 'completed', output: 'ok' })
    expect(seen[2].metadata).toMatchObject({
      phase: 'message_updated',
      effectiveModel: 'anthropic/sonnet-5',
      usage: { cost: 0.02, input_tokens: 10, output_tokens: 5 },
    })
    expect(seen[3].metadata).toMatchObject({ phase: 'turn_completed' })
    expect(seen[4]).toMatchObject({ type: 'error', data: 'ProviderAuthError' })
  })

  it('ignores events for a different session on the same shared server', async () => {
    const fakeClient = makeFakeClient()
    const { driver, supervisor } = makeDriver(fakeClient)

    const launchPromise = driver.launch(baseLaunch({ prompt: '' }))
    await Promise.resolve()
    supervisor.emitListening()
    const session = await launchPromise
    const events = driver.events(session.id)

    fakeClient.eventQueue.push({ type: 'session.idle', properties: { sessionID: 'some-other-session' } })
    fakeClient.eventQueue.push({ type: 'session.idle', properties: { sessionID: fakeClient.sessionId } })

    const seen = await take(events, 1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ metadata: { phase: 'turn_completed' } })
  })

  it('interrupt() aborts the session via the SDK', async () => {
    const fakeClient = makeFakeClient()
    const { driver, supervisor } = makeDriver(fakeClient)

    const launchPromise = driver.launch(baseLaunch({ prompt: '' }))
    await Promise.resolve()
    supervisor.emitListening()
    const session = await launchPromise

    await driver.interrupt(session.id)
    expect(fakeClient.abortCalls).toHaveLength(1)
    expect(fakeClient.abortCalls[0]).toMatchObject({
      path: { id: fakeClient.sessionId },
      query: { directory: '/private/tmp/project' },
    })
  })

  it('stop() tears down the shared server once the last session releases it', async () => {
    const fakeClient = makeFakeClient()
    const { driver, supervisor } = makeDriver(fakeClient)

    const launchPromise = driver.launch(baseLaunch({ prompt: '' }))
    await Promise.resolve()
    supervisor.emitListening()
    const session = await launchPromise

    await driver.stop(session.id)
    expect(supervisor.stopped).toEqual([supervisor.spawned[0]!.record.id])
  })

  it('does not stop the shared server while another session still holds it', async () => {
    const fakeClient = makeFakeClient()
    const { driver, supervisor } = makeDriver(fakeClient)

    const first = await (async () => {
      const p = driver.launch(baseLaunch({ prompt: '' }))
      await Promise.resolve()
      supervisor.emitListening()
      return p
    })()
    const second = await driver.launch(baseLaunch({ workspaceId: 'ws:2', cwd: '/private/tmp/other', prompt: '' }))

    await driver.stop(first.id)
    expect(supervisor.stopped).toHaveLength(0)

    await driver.stop(second.id)
    expect(supervisor.stopped).toEqual([supervisor.spawned[0]!.record.id])
  })

  it('fails every live session when the shared server process is lost', async () => {
    const fakeClient = makeFakeClient()
    const { driver, supervisor } = makeDriver(fakeClient)

    const launchPromise = driver.launch(baseLaunch({ prompt: '' }))
    await Promise.resolve()
    supervisor.emitListening()
    const session = await launchPromise
    const events = driver.events(session.id)

    supervisor.emitProcessFailed()

    const seen = await take(events, 2)
    expect(seen.map((event) => event.type)).toEqual(['error', 'exit'])
  })
})

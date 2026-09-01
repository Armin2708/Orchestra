import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { createOpencodeClient } from '@opencode-ai/sdk'
import type { Event as OpenCodeEvent, OpencodeClient, Part as OpenCodePart } from '@opencode-ai/sdk'
import { BoundedAsyncQueue } from '../../codex/async.js'
import type { RuntimeSupervisor } from '../supervisor.js'
import type {
  AgentDriver,
  DriverCapabilities,
  DriverEvent,
  DriverLaunchRequest,
  DriverRecoveryRequest,
  DriverSession,
  OsId,
} from '../types.js'

export const OPENCODE_DRIVER_ID = 'opencode'

export type OpenCodeAgentDriverOptions = {
  command?: string
  hostname?: string
  /** Fixed port for the shared server. Omit to allocate a free ephemeral port at first launch. */
  port?: number
  environment?: NodeJS.ProcessEnv
  defaultModel?: string
  eventBufferSize?: number
  now?: () => Date
  serverStartTimeoutMs?: number
  /** Injectable for tests; defaults to the real `createOpencodeClient` from `@opencode-ai/sdk`. */
  createClient?: (config: { baseUrl: string }) => OpencodeClient
}

type OpenCodeSessionState = {
  session: DriverSession
  cwd: string
  workspaceId: OsId
  model: string | undefined
  queue: BoundedAsyncQueue<DriverEvent>
  seq: number
  stopped: boolean
  claimed: boolean
  eventLoopAbort: AbortController | null
}

type SharedServer = {
  url: string
  processId: OsId
  client: OpencodeClient
  /** Number of live sessions currently depending on this process. */
  refCount: number
}

const LISTENING_LINE = /opencode server listening on\s+(https?:\/\/\S+)/

async function findFreePort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen(0, hostname, () => {
      const address = probe.address()
      if (address && typeof address === 'object') {
        const { port } = address
        probe.close(() => resolve(port))
      } else {
        probe.close(() => reject(new Error('OpenCode driver could not allocate a free port')))
      }
    })
  })
}

/** Extract the `sessionID` a given OpenCode event refers to, if any. */
function eventSessionId(event: OpenCodeEvent): string | null {
  const properties = event.properties as Record<string, unknown> | undefined
  if (!properties) return null
  if (typeof properties.sessionID === 'string') return properties.sessionID
  const info = properties.info as Record<string, unknown> | undefined
  if (info && typeof info.sessionID === 'string') return info.sessionID
  if (info && typeof info.id === 'string' && event.type.startsWith('session.')) return info.id
  return null
}

export class OpenCodeAgentDriver implements AgentDriver {
  readonly id = OPENCODE_DRIVER_ID

  private readonly sessions = new Map<string, OpenCodeSessionState>()
  private readonly command: string
  private readonly hostname: string
  private readonly explicitPort: number | undefined
  private readonly baseEnv: NodeJS.ProcessEnv | undefined
  private readonly defaultModel: string | undefined
  private readonly eventBufferSize: number
  private readonly now: () => Date
  private readonly serverStartTimeoutMs: number
  private readonly createClient: (config: { baseUrl: string }) => OpencodeClient

  private server: SharedServer | null = null
  private serverStarting: Promise<SharedServer> | null = null

  constructor(
    private readonly runtime: RuntimeSupervisor,
    options: OpenCodeAgentDriverOptions = {},
  ) {
    this.command = options.command ?? 'opencode'
    this.hostname = options.hostname ?? '127.0.0.1'
    this.explicitPort = options.port
    this.baseEnv = options.environment
    this.defaultModel = options.defaultModel
    this.eventBufferSize = options.eventBufferSize ?? 4_096
    this.now = options.now ?? (() => new Date())
    this.serverStartTimeoutMs = options.serverStartTimeoutMs ?? 15_000
    this.createClient = options.createClient ?? ((config) => createOpencodeClient(config))
  }

  capabilities(): DriverCapabilities {
    return {
      attach: false,
      streaming: true,
      interrupt: true,
      stop: true,
      rawTerminal: false,
      resume: true,
      managesAgentIdentity: false,
    }
  }

  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    if (!request.workspaceId) throw new Error('OpenCode launch requires a workspace')
    if (!request.cwd) throw new Error('OpenCode launch requires a cwd')
    const server = await this.ensureServer(request.workspaceId)
    const created = await server.client.session.create({
      query: { directory: request.cwd },
      body: request.name ? { title: request.name } : undefined,
    })
    if (!created.data) {
      throw new Error(`OpenCode session create failed: ${describeError(created.error)}`)
    }
    server.refCount += 1
    const state = this.createSession({
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      model: request.model ?? this.defaultModel,
      externalId: created.data.id,
      metadata: request.metadata,
    })
    this.watchEvents(state)
    if (request.prompt && request.prompt.trim()) {
      await this.sendPrompt(state, request.prompt)
    }
    return state.session
  }

  async attach(): Promise<DriverSession | null> {
    // Raw provider session ids are only authoritative through recover(), which
    // binds an explicit workspace and cwd (same rule as the Qwen driver).
    return null
  }

  async recover(request: DriverRecoveryRequest): Promise<DriverSession | null> {
    const externalId = request.externalId?.trim()
    if (!externalId) return null
    const existing = [...this.sessions.values()].find((candidate) =>
      !candidate.stopped && candidate.session.externalId === externalId)
    if (existing) return existing.session
    const server = await this.ensureServer(request.workspaceId)
    const found = await server.client.session.get({
      path: { id: externalId },
      query: { directory: request.cwd },
    })
    if (!found.data) return null
    server.refCount += 1
    const state = this.createSession({
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      model: request.model ?? this.defaultModel,
      externalId,
      metadata: request.metadata,
    })
    this.watchEvents(state)
    return state.session
  }

  async send(sessionId: string, text: string): Promise<void> {
    const state = this.required(sessionId)
    if (state.stopped) throw new Error('OpenCode session is stopped')
    const prompt = text.trim()
    if (!prompt) throw new Error('OpenCode prompt is required')
    await this.sendPrompt(state, prompt)
  }

  async interrupt(sessionId: string): Promise<void> {
    const state = this.required(sessionId)
    await this.abortTurn(state)
  }

  async cancel(sessionId: string): Promise<void> {
    // OpenCode has no mid-turn steering distinct from abort; the session
    // itself remains resumable via its externalId, same as Qwen's `-r`.
    await this.interrupt(sessionId)
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.required(sessionId)
    await this.abortTurn(state)
    this.stopState(state, 'OpenCode session stopped')
  }

  async *events(sessionId: string): AsyncIterable<DriverEvent> {
    const state = this.required(sessionId)
    if (state.claimed) throw new Error('OpenCode session event stream already claimed')
    state.claimed = true
    yield* state.queue
  }

  session(externalId: string): DriverSession | null {
    for (const state of this.sessions.values()) {
      if (!state.stopped && state.session.externalId === externalId) return state.session
    }
    return null
  }

  /** The live SDK client for the shared server, if it's currently running — used by the provider adapter's live model-catalog lookup. Never starts the server as a side effect. */
  currentClient(): OpencodeClient | null {
    return this.server?.client ?? null
  }

  dispose(): void {
    for (const state of [...this.sessions.values()]) {
      state.eventLoopAbort?.abort()
      this.stopState(state, 'OpenCode driver disposed')
    }
    if (this.server) {
      const processId = this.server.processId
      this.server = null
      this.serverStarting = null
      void this.runtime.stop(processId).catch(() => {
        // best-effort teardown; the supervisor's own reaper handles stragglers
      })
    }
  }

  /** Starts (or reuses) the single daemon-wide `opencode serve` process. */
  private async ensureServer(workspaceId: OsId): Promise<SharedServer> {
    if (this.server) return this.server
    if (this.serverStarting) return this.serverStarting
    this.serverStarting = this.startServer(workspaceId).finally(() => {
      this.serverStarting = null
    })
    return this.serverStarting
  }

  private async startServer(workspaceId: OsId): Promise<SharedServer> {
    const port = this.explicitPort ?? await findFreePort(this.hostname)
    const record = await this.runtime.spawn({
      workspaceId,
      name: 'opencode-server',
      command: this.command,
      args: ['serve', `--hostname=${this.hostname}`, `--port=${port}`],
      cwd: process.cwd(),
      env: this.baseEnv,
      shell: false,
      restartable: false,
    })

    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`OpenCode server did not start within ${this.serverStartTimeoutMs}ms`))
      }, this.serverStartTimeoutMs)
      timeout.unref?.();
      (async () => {
        try {
          for await (const item of this.runtime.events(record.id)) {
            if (item.type === 'output') {
              const match = LISTENING_LINE.exec(item.output.data)
              if (match) {
                clearTimeout(timeout)
                resolve(match[1])
                return
              }
              continue
            }
            if (item.event.kind === 'process.failed' || item.event.kind === 'process.exited'
              || item.event.kind === 'process.lost') {
              clearTimeout(timeout)
              reject(new Error(`OpenCode server process ended before it reported readiness (${item.event.kind})`))
              return
            }
          }
          clearTimeout(timeout)
          reject(new Error('OpenCode server event stream ended before reporting readiness'))
        } catch (error) {
          clearTimeout(timeout)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    })

    const client = this.createClient({ baseUrl: url })
    const server: SharedServer = { url, processId: record.id, client, refCount: 0 }
    this.server = server
    this.watchServerLifecycle(server)
    return server
  }

  /** Fails every live session when the shared server process dies unexpectedly. */
  private watchServerLifecycle(server: SharedServer): void {
    void (async () => {
      try {
        for await (const item of this.runtime.events(server.processId)) {
          if (item.type !== 'event') continue
          const terminal = item.event.kind === 'process.failed'
            || item.event.kind === 'process.exited'
            || item.event.kind === 'process.lost'
          if (!terminal) continue
          if (this.server === server) this.server = null
          for (const state of this.sessions.values()) {
            if (state.stopped || state.session.workspaceId === undefined) continue
            this.emit(state, 'error', `OpenCode server process ended (${item.event.kind})`, {
              phase: 'server_lost',
            })
            this.stopState(state, 'OpenCode server process ended')
          }
          return
        }
      } catch {
        // supervisor stream ended; nothing further to reconcile
      }
    })()
  }

  private async sendPrompt(state: OpenCodeSessionState, prompt: string): Promise<void> {
    const server = this.server
    if (!server) throw new Error('OpenCode server is not running')
    this.emit(state, 'status', 'OpenCode turn started', { phase: 'turn_started' })
    const result = await server.client.session.prompt({
      path: { id: state.session.externalId },
      query: { directory: state.cwd },
      body: {
        parts: [{ type: 'text', text: prompt }],
        ...(state.model ? { model: parseModelId(state.model) } : {}),
      },
    })
    if (!result.data) {
      this.emit(state, 'error', `OpenCode turn failed to start: ${describeError(result.error)}`, {
        phase: 'turn_start_failed',
      })
    }
  }

  private async abortTurn(state: OpenCodeSessionState): Promise<void> {
    const server = this.server
    if (!server) return
    try {
      await server.client.session.abort({
        path: { id: state.session.externalId },
        query: { directory: state.cwd },
      })
    } catch {
      // best-effort; the session may already be idle
    }
  }

  private watchEvents(state: OpenCodeSessionState): void {
    const server = this.server
    if (!server) return
    const abort = new AbortController()
    state.eventLoopAbort = abort
    void (async () => {
      try {
        const subscription = await server.client.event.subscribe({
          query: { directory: state.cwd },
          signal: abort.signal,
        })
        for await (const event of subscription.stream) {
          if (state.stopped) break
          const relatedSessionId = eventSessionId(event)
          if (relatedSessionId !== null && relatedSessionId !== state.session.externalId) continue
          this.acceptEvent(state, event)
        }
      } catch (error) {
        if (state.stopped || abort.signal.aborted) return
        this.emit(state, 'error', `OpenCode event stream failed: ${error instanceof Error ? error.message : String(error)}`, {
          phase: 'event_stream_error',
        })
      }
    })()
  }

  private acceptEvent(state: OpenCodeSessionState, event: OpenCodeEvent): void {
    switch (event.type) {
      case 'message.part.updated': {
        const part = event.properties.part as OpenCodePart
        if (part.type === 'text') {
          if (part.text.trim()) {
            this.emit(state, 'output', part.text, { kind: 'text', delta: event.properties.delta ?? null })
          }
          return
        }
        if (part.type === 'tool') {
          const status = part.state.status
          const kind = status === 'completed' || status === 'error' ? 'tool_result' : 'tool_call'
          this.emit(state, 'tool', part.tool, {
            kind,
            toolCallId: part.callID,
            status,
            input: 'input' in part.state ? part.state.input : null,
            output: part.state.status === 'completed' ? part.state.output : null,
            error: part.state.status === 'error' ? part.state.error : null,
          })
        }
        return
      }
      case 'message.updated': {
        const info = event.properties.info
        if (info.role !== 'assistant') return
        this.emit(state, 'status', info.finish ?? 'OpenCode message updated', {
          phase: 'message_updated',
          effectiveModel: `${info.providerID}/${info.modelID}`,
          usage: {
            cost: info.cost,
            input_tokens: info.tokens.input,
            output_tokens: info.tokens.output,
            reasoning_tokens: info.tokens.reasoning,
            cache_read_tokens: info.tokens.cache.read,
            cache_write_tokens: info.tokens.cache.write,
          },
          error: info.error ?? null,
        })
        state.session.metadata.effectiveModel = `${info.providerID}/${info.modelID}`
        return
      }
      case 'session.idle': {
        this.emit(state, 'status', 'OpenCode turn completed', { phase: 'turn_completed' })
        return
      }
      case 'session.error': {
        this.emit(state, 'error', describeSessionError(event.properties.error), {
          phase: 'session_error',
        })
        return
      }
      case 'permission.updated':
      case 'permission.replied': {
        this.emit(state, 'status', `OpenCode ${event.type}`, {
          phase: event.type.replace('.', '_'),
          permission: event.properties,
        })
        return
      }
      default:
        return
    }
  }

  private createSession(input: {
    workspaceId: OsId
    cwd: string
    model?: string
    externalId: string
    metadata?: Record<string, unknown>
  }): OpenCodeSessionState {
    const session: DriverSession = {
      id: randomUUID(),
      externalId: input.externalId,
      driverId: this.id,
      workspaceId: input.workspaceId,
      status: 'idle',
      startedAt: this.now().toISOString(),
      metadata: {
        provider: this.id,
        ...(input.model ? { requestedModel: input.model } : {}),
        ...(input.metadata ?? {}),
      },
    }
    const state: OpenCodeSessionState = {
      session,
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      model: input.model,
      queue: new BoundedAsyncQueue<DriverEvent>(this.eventBufferSize),
      seq: 0,
      stopped: false,
      claimed: false,
      eventLoopAbort: null,
    }
    this.sessions.set(session.id, state)
    return state
  }

  private emit(
    state: OpenCodeSessionState,
    type: DriverEvent['type'],
    data: string,
    metadata: Record<string, unknown> = {},
  ): void {
    if (state.stopped && type !== 'exit') return
    state.seq += 1
    const event: DriverEvent = {
      sessionId: state.session.id,
      seq: state.seq,
      type,
      at: this.now().toISOString(),
      data,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    }
    state.queue.push(event)
  }

  private stopState(state: OpenCodeSessionState, data: string): void {
    if (state.stopped) return
    state.stopped = true
    state.session.status = 'stopped'
    state.eventLoopAbort?.abort()
    state.seq += 1
    state.queue.push({
      sessionId: state.session.id,
      seq: state.seq,
      type: 'exit',
      at: this.now().toISOString(),
      data,
      metadata: { provider: this.id },
    })
    state.queue.close()
    if (this.server && this.server.refCount > 0) {
      this.server.refCount -= 1
      if (this.server.refCount === 0) {
        const processId = this.server.processId
        this.server = null
        void this.runtime.stop(processId).catch(() => {
          // best-effort; a stuck server is picked up by the daemon's own reaper
        })
      }
    }
  }

  private required(sessionId: string): OpenCodeSessionState {
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error(`OpenCode session not attached: ${sessionId}`)
    return state
  }
}

function parseModelId(model: string): { providerID: string; modelID: string } | undefined {
  const separator = model.indexOf('/')
  if (separator <= 0 || separator === model.length - 1) return undefined
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
}

function describeError(error: unknown): string {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return 'unknown error'
  }
}

function describeSessionError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'OpenCode session error'
  const row = error as Record<string, unknown>
  if (typeof row.name === 'string') return row.name
  if (typeof row.message === 'string') return row.message
  return describeError(error)
}

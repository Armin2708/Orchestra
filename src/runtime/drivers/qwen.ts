import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { BoundedAsyncQueue } from '../../codex/async.js'
import type {
  AgentDriver,
  DriverCapabilities,
  DriverEvent,
  DriverLaunchRequest,
  DriverRecoveryRequest,
  DriverSession,
  OsId,
} from '../types.js'

export const QWEN_DRIVER_ID = 'qwen'

export type QwenStreamJsonUsage = Readonly<{
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  total_tokens: number
}>

export type QwenAgentDriverOptions = {
  command?: string
  environment?: NodeJS.ProcessEnv
  defaultModel?: string
  /** Session recording must stay on for `-r` resume to work. */
  chatRecording?: boolean
  interruptGraceMs?: number
  eventBufferSize?: number
  now?: () => Date
  spawnImpl?: typeof spawn
}

export type QwenSpawnedProcess = ChildProcessByStdio<null, Readable, Readable>

type QwenTurnState = {
  process: QwenSpawnedProcess
  interrupted: boolean
}

type QwenSessionState = {
  session: DriverSession
  cwd: string
  model: string | undefined
  queue: BoundedAsyncQueue<DriverEvent>
  seq: number
  stopped: boolean
  claimed: boolean
  turn: QwenTurnState | null
  latestUsage: QwenStreamJsonUsage | null
}

const usageNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

const normalizeQwenUsage = (
  usage: Record<string, unknown> | undefined,
): QwenStreamJsonUsage | null => {
  if (!usage) return null
  const input_tokens = usageNumber(usage.input_tokens)
  const output_tokens = usageNumber(usage.output_tokens)
  const cache_read_input_tokens = usageNumber(usage.cache_read_input_tokens)
  const total_tokens = usageNumber(usage.total_tokens) || input_tokens + output_tokens
  return { input_tokens, output_tokens, cache_read_input_tokens, total_tokens }
}

export class QwenAgentDriver implements AgentDriver {
  readonly id = QWEN_DRIVER_ID

  private readonly sessions = new Map<string, QwenSessionState>()
  private readonly command: string
  private readonly baseEnv: NodeJS.ProcessEnv | undefined
  private readonly defaultModel: string | undefined
  private readonly chatRecording: boolean
  private readonly interruptGraceMs: number
  private readonly eventBufferSize: number
  private readonly now: () => Date
  private readonly spawnImpl: typeof spawn

  constructor(options: QwenAgentDriverOptions = {}) {
    this.command = options.command ?? 'qwen'
    this.baseEnv = options.environment
    this.defaultModel = options.defaultModel
    this.chatRecording = options.chatRecording ?? true
    this.interruptGraceMs = options.interruptGraceMs ?? 2_500
    this.eventBufferSize = options.eventBufferSize ?? 4_096
    this.now = options.now ?? (() => new Date())
    this.spawnImpl = options.spawnImpl ?? spawn
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
    if (!request.workspaceId) throw new Error('Qwen launch requires a workspace')
    if (!request.cwd) throw new Error('Qwen launch requires a cwd')
    const state = this.createSession({
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      model: request.model ?? this.defaultModel,
      externalId: request.externalId,
      metadata: request.metadata,
    })
    if (request.prompt && request.prompt.trim()) {
      this.startTurn(state, request.prompt)
    }
    return state.session
  }

  async attach(): Promise<DriverSession | null> {
    // Raw provider session ids are only authoritative through recover(),
    // which binds an explicit workspace and cwd.
    return null
  }

  async recover(request: DriverRecoveryRequest): Promise<DriverSession | null> {
    const externalId = request.externalId?.trim()
    if (!externalId) return null
    for (const state of this.sessions.values()) {
      if (!state.stopped && state.session.externalId === externalId) {
        return state.session
      }
    }
    const state = this.createSession({
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      model: request.model ?? this.defaultModel,
      externalId,
      metadata: request.metadata,
    })
    return state.session
  }

  async send(sessionId: string, text: string): Promise<void> {
    const state = this.required(sessionId)
    if (state.stopped) throw new Error('Qwen session is stopped')
    if (state.turn) throw new Error('Qwen turn already active; interrupt it first')
    const prompt = text.trim()
    if (!prompt) throw new Error('Qwen prompt is required')
    this.startTurn(state, prompt)
  }

  async interrupt(sessionId: string): Promise<void> {
    const state = this.required(sessionId)
    await this.interruptTurn(state)
  }

  async cancel(sessionId: string): Promise<void> {
    // qwen has no mid-turn steering: cancellation kills the turn process and
    // leaves the recorded session resumable via `-r`.
    await this.interrupt(sessionId)
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.required(sessionId)
    await this.interruptTurn(state)
    this.stopState(state, 'Qwen session stopped')
  }

  async *events(sessionId: string): AsyncIterable<DriverEvent> {
    const state = this.required(sessionId)
    if (state.claimed) throw new Error('Qwen session event stream already claimed')
    state.claimed = true
    yield* state.queue
  }

  session(externalId: string): DriverSession | null {
    for (const state of this.sessions.values()) {
      if (!state.stopped && state.session.externalId === externalId) {
        return state.session
      }
    }
    return null
  }

  latestUsage(sessionId: string): QwenStreamJsonUsage | null {
    return this.sessions.get(sessionId)?.latestUsage ?? null
  }

  dispose(): void {
    for (const state of [...this.sessions.values()]) {
      const turn = state.turn
      if (turn) {
        turn.interrupted = true
        try {
          turn.process.kill('SIGKILL')
        } catch {
          // already gone
        }
        state.turn = null
      }
      this.stopState(state, 'Qwen driver disposed')
    }
  }

  private createSession(input: {
    workspaceId: OsId
    cwd: string
    model?: string
    externalId?: string
    metadata?: Record<string, unknown>
  }): QwenSessionState {
    const session: DriverSession = {
      id: randomUUID(),
      externalId: input.externalId?.trim() || '',
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
    const state: QwenSessionState = {
      session,
      cwd: input.cwd,
      model: input.model,
      queue: new BoundedAsyncQueue<DriverEvent>(this.eventBufferSize),
      seq: 0,
      stopped: false,
      claimed: false,
      turn: null,
      latestUsage: null,
    }
    this.sessions.set(session.id, state)
    return state
  }

  private startTurn(state: QwenSessionState, prompt: string): void {
    const args = ['-p', prompt, '-o', 'stream-json']
    if (this.chatRecording) args.push('--chat-recording')
    if (state.session.externalId) args.push('-r', state.session.externalId)
    if (state.model) args.push('-m', state.model)

    const child = this.spawnImpl(this.command, args, {
      cwd: state.cwd,
      env: this.baseEnv ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const turn: QwenTurnState = { process: child, interrupted: false }
    state.turn = turn
    state.session.status = 'running'
    this.emit(state, 'status', 'Qwen turn started', { phase: 'turn_started' })

    let stdoutBuffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      let newline = stdoutBuffer.indexOf('\n')
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line) this.acceptStreamLine(state, turn, line)
        newline = stdoutBuffer.indexOf('\n')
      }
    })

    let stderrTail = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4_096)
    })

    child.once('error', (error) => {
      if (state.turn !== turn) return
      state.turn = null
      if (state.stopped) return
      state.session.status = 'idle'
      this.emit(state, 'error', `Qwen CLI failed to start: ${error.message}`, {
        phase: 'spawn_error',
      })
    })

    child.once('exit', (code, signal) => {
      if (state.turn !== turn) return
      state.turn = null
      if (state.stopped) return
      state.session.status = 'idle'
      if (turn.interrupted) {
        this.emit(state, 'status', 'Qwen turn interrupted', { phase: 'turn_interrupted' })
      } else if (code === 0) {
        this.emit(state, 'status', 'Qwen turn completed', { phase: 'turn_completed' })
      } else {
        const detail = stderrTail.trim()
        this.emit(
          state,
          'error',
          `Qwen CLI exited with ${signal ?? code ?? 'unknown'}${detail ? `: ${detail}` : ''}`,
          { phase: 'turn_failed', exitCode: code, signal },
        )
      }
    })
  }

  private acceptStreamLine(state: QwenSessionState, turn: QwenTurnState, line: string): void {
    if (state.turn !== turn) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const event = parsed as Record<string, unknown>
    switch (event.type) {
      case 'system': {
        if (event.subtype !== 'init') return
        const providerSessionId = typeof event.session_id === 'string' ? event.session_id : null
        if (providerSessionId) state.session.externalId = providerSessionId
        const model = typeof event.model === 'string' ? event.model : null
        if (model) state.session.metadata.effectiveModel = model
        this.emit(state, 'status', 'Qwen session initialized', {
          phase: 'session_init',
          providerSessionId: providerSessionId ?? state.session.externalId,
          model: model ?? state.model ?? null,
          permissionMode: typeof event.permission_mode === 'string' ? event.permission_mode : null,
          cliVersion: typeof event.qwen_code_version === 'string' ? event.qwen_code_version : null,
        })
        return
      }
      case 'assistant': {
        const message = event.message as Record<string, unknown> | undefined
        const content = message && Array.isArray(message.content) ? message.content : []
        const parentToolUseId = typeof event.parent_tool_use_id === 'string'
          ? event.parent_tool_use_id
          : null
        for (const block of content) {
          if (!block || typeof block !== 'object' || Array.isArray(block)) continue
          const row = block as Record<string, unknown>
          if (row.type === 'text' && typeof row.text === 'string' && row.text.trim()) {
            this.emit(state, 'output', row.text, { kind: 'text' })
          } else if (row.type === 'thinking' && typeof row.thinking === 'string'
            && row.thinking.trim()) {
            this.emit(state, 'output', row.thinking, { kind: 'thinking' })
          } else if (row.type === 'tool_use') {
            this.emit(state, 'tool', typeof row.name === 'string' ? row.name : 'tool', {
              kind: 'tool_call',
              toolCallId: typeof row.id === 'string' ? row.id : null,
              input: row.input ?? null,
              parentToolUseId,
            })
          }
        }
        return
      }
      case 'user': {
        const message = event.message as Record<string, unknown> | undefined
        const content = message && Array.isArray(message.content) ? message.content : []
        for (const block of content) {
          if (!block || typeof block !== 'object' || Array.isArray(block)) continue
          const row = block as Record<string, unknown>
          if (row.type !== 'tool_result') continue
          this.emit(state, 'tool', typeof row.tool_use_id === 'string' ? row.tool_use_id : 'tool', {
            kind: 'tool_result',
            isError: row.is_error === true,
            content: row.content ?? null,
          })
        }
        return
      }
      case 'result': {
        const usage = normalizeQwenUsage(event.usage as Record<string, unknown> | undefined)
        if (usage) state.latestUsage = usage
        if (event.is_error === true) {
          this.emit(
            state,
            'error',
            typeof event.result === 'string' && event.result.trim()
              ? event.result
              : 'Qwen turn failed',
            {
              phase: 'result_error',
              subtype: typeof event.subtype === 'string' ? event.subtype : null,
              usage: usage ?? null,
            },
          )
        } else {
          this.emit(
            state,
            'status',
            typeof event.result === 'string' ? event.result : 'Qwen turn finished',
            {
              phase: 'result',
              subtype: typeof event.subtype === 'string' ? event.subtype : null,
              numTurns: typeof event.num_turns === 'number' ? event.num_turns : null,
              durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
              usage: usage ?? null,
            },
          )
        }
        return
      }
      default:
        // stream_event/goal_state and other internal events carry no
        // transcript value for the board.
        return
    }
  }

  private async interruptTurn(state: QwenSessionState): Promise<void> {
    const turn = state.turn
    if (!turn || turn.process.exitCode !== null) return
    turn.interrupted = true
    const child = turn.process
    try {
      child.kill('SIGINT')
    } catch {
      return
    }
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(graceTimer)
        resolve()
      }
      const graceTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          finish()
          return
        }
        const killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
          finish()
        }, this.interruptGraceMs)
        killTimer.unref?.()
      }, this.interruptGraceMs)
      graceTimer.unref?.()
      child.once('exit', finish)
      if (child.exitCode !== null) finish()
    })
  }

  private emit(
    state: QwenSessionState,
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

  private stopState(state: QwenSessionState, data: string): void {
    if (state.stopped) return
    state.stopped = true
    state.session.status = 'stopped'
    state.turn = null
    state.seq += 1
    state.queue.push({
      sessionId: state.session.id,
      seq: state.seq,
      type: 'exit',
      at: this.now().toISOString(),
      data,
      metadata: { provider: this.id, usage: state.latestUsage },
    })
    state.queue.close()
  }

  private required(sessionId: string): QwenSessionState {
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error(`Qwen session not attached: ${sessionId}`)
    return state
  }
}

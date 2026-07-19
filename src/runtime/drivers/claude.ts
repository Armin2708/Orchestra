import type {
  AgentDriver,
  DriverCapabilities,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
  MaybePromise,
  OsId,
} from '../types.js'

export type ClaudeAgentRecord = {
  id: number
  name?: string
  sdk_session?: string | null
  status?: string
}

export type ClaudeTranscriptLine = {
  at: string
  kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'
  text: string
}

export interface ClaudeConductorPort {
  isHired(agentId: number): boolean
  hire(options: {
    boardId: number
    cwd: string
    name?: string
    model?: string
    resumeSession?: string
    permissionMode?: string
    cardId?: number
    maxBudgetUsd?: number
    taskBudgetTokens?: number
  }): ClaudeAgentRecord
  task(agentId: number, text: string): boolean
  transcript(agentId: number): { lines: ClaudeTranscriptLine[]; working: unknown; info?: Record<string, unknown> }
  interruptAgent(agentId: number): Promise<boolean>
  fire(agentId: number): Promise<boolean>
  sessionAccounting?(agentId: number): { usage: { input_tokens: number; cache_read: number; cache_creation: number; output_tokens: number }; costUsd: number } | null
}

export type ClaudeAgentDriverOptions = {
  conductor: ClaudeConductorPort
  resolveAgent?: (externalId: string) => MaybePromise<ClaudeAgentRecord | null>
  workspaceForAgent?: (agentId: number) => MaybePromise<OsId | undefined>
  pollIntervalMs?: number
}

type ClaudeSessionState = {
  session: DriverSession
  agentId: number
}

export class ClaudeAgentDriverAdapter implements AgentDriver {
  readonly id = 'claude'
  private readonly sessions = new Map<string, ClaudeSessionState>()
  private readonly pollIntervalMs: number

  constructor(private readonly options: ClaudeAgentDriverOptions) {
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250)
  }

  capabilities(): DriverCapabilities {
    return { attach: true, streaming: true, interrupt: true, stop: true, rawTerminal: false, resume: true }
  }

  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    if (!Number.isInteger(request.boardId) || request.boardId! <= 0) throw new Error('Claude driver requires boardId')
    const cardId = request.metadata?.cardId
    const agent = this.options.conductor.hire({
      boardId: request.boardId!,
      cwd: request.cwd,
      ...(request.name ? { name: request.name } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.externalId ? { resumeSession: request.externalId } : {}),
      ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
      ...(request.maxBudgetUsd !== undefined ? { maxBudgetUsd: request.maxBudgetUsd } : {}),
      ...(request.taskBudgetTokens !== undefined ? { taskBudgetTokens: request.taskBudgetTokens } : {}),
      ...(typeof cardId === 'number' && Number.isInteger(cardId) ? { cardId } : {}),
    })
    const session = this.toSession(agent, request.workspaceId)
    this.sessions.set(session.id, { session, agentId: agent.id })
    if (request.prompt && !this.options.conductor.task(agent.id, request.prompt))
      throw new Error(`Claude agent ${agent.id} rejected the initial prompt`)
    return session
  }

  async attach(externalId: string): Promise<DriverSession | null> {
    const agent = this.options.resolveAgent
      ? await this.options.resolveAgent(externalId)
      : /^\d+$/.test(externalId) ? { id: Number(externalId) } : null
    if (!agent || !this.options.conductor.isHired(agent.id)) return null
    const workspaceId = await this.options.workspaceForAgent?.(agent.id)
    if (!workspaceId) throw new Error(`workspace for Claude agent ${agent.id} is unknown`)
    const session = this.toSession(agent, workspaceId)
    this.sessions.set(session.id, { session, agentId: agent.id })
    return session
  }

  async send(sessionId: string, text: string): Promise<void> {
    const state = this.required(sessionId)
    if (!this.options.conductor.task(state.agentId, text)) throw new Error(`Claude session is not live: ${sessionId}`)
  }

  async interrupt(sessionId: string): Promise<void> {
    const state = this.required(sessionId)
    if (!(await this.options.conductor.interruptAgent(state.agentId))) throw new Error(`Claude session is not live: ${sessionId}`)
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.required(sessionId)
    if (!(await this.options.conductor.fire(state.agentId))) throw new Error(`Claude session is not live: ${sessionId}`)
  }

  async *events(sessionId: string): AsyncIterable<DriverEvent> {
    const state = this.required(sessionId)
    let seq = 0
    const seen = new Set<string>()
    const seenOrder: string[] = []
    while (this.options.conductor.isHired(state.agentId)) {
      const transcript = this.options.conductor.transcript(state.agentId)
      for (const line of transcript.lines) {
        const fingerprint = `${line.at}\u0000${line.kind}\u0000${line.text}`
        if (seen.has(fingerprint)) continue
        seen.add(fingerprint)
        seenOrder.push(fingerprint)
        if (seenOrder.length > 2_000) seen.delete(seenOrder.shift()!)
        yield {
          sessionId,
          seq: ++seq,
          type: line.kind === 'error' ? 'error' : line.kind === 'status' ? 'status'
            : line.kind === 'tool' || line.kind === 'tool_result' ? 'tool' : 'output',
          at: line.at,
          data: line.text,
          metadata: { transcriptKind: line.kind },
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
    }
    const accounting = this.options.conductor.sessionAccounting?.(state.agentId)
    const tokens = accounting ? Object.values(accounting.usage).reduce((sum, value) => sum + Number(value || 0), 0) : 0
    yield {
      sessionId,
      seq: ++seq,
      type: 'exit',
      at: new Date().toISOString(),
      data: 'Claude session stopped',
      metadata: { tokens, costUsd: accounting?.costUsd ?? 0 },
    }
  }

  private toSession(agent: ClaudeAgentRecord, workspaceId: OsId): DriverSession {
    const externalId = agent.sdk_session || String(agent.id)
    return {
      id: `${this.id}:${agent.id}`,
      externalId,
      driverId: this.id,
      workspaceId,
      status: 'running',
      startedAt: new Date().toISOString(),
      metadata: { agentId: agent.id, name: agent.name ?? null },
    }
  }

  private required(sessionId: string): ClaudeSessionState {
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error(`Claude session not attached: ${sessionId}`)
    return state
  }
}

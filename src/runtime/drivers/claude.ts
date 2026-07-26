import path from 'node:path'
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

export type ClaudeAgentHomeBinding = {
  agentHomeSessionId: string
  agentProfileId: string
  agentConversationId: string
}

export type ClaudeSessionForkOptions = {
  sourceExternalId: string
  workspaceId: OsId
  cwd: string
  upToMessageId?: string
  title?: string
}

export type ClaudeSessionForkResult = {
  sourceExternalId: string
  externalId: string
  providerThreadId: string
  sourceProviderThreadId: string
  metadata: Record<string, unknown>
}

export type ClaudeNativeSessionFork = (
  sourceExternalId: string,
  options: {
    dir: string
    upToMessageId?: string
    title?: string
  },
) => MaybePromise<{ sessionId: string }>

export type ClaudeNativeEventKind =
  | 'session_start'
  | 'outbound_user'
  | 'provider_message'
  | 'approval_request'
  | 'approval_response'
  | 'error'
  | 'session_end'

export type ClaudeNativeEvent = {
  captureId: string
  agentId: number
  agentName: string
  agentHome?: ClaudeAgentHomeBinding
  kind: ClaudeNativeEventKind
  direction: 'inbound' | 'outbound' | 'lifecycle'
  at: string
  providerSessionId?: string | null
  resumed?: boolean
  payload: unknown
}

export interface ClaudeNativeEventSink {
  /** Persistence is synchronous so native capture completes before transcript projection. */
  append(event: ClaudeNativeEvent): void
}

export interface ClaudeConductorPort {
  isHired(agentId: number): boolean
  hire(options: {
    boardId: number
    cwd: string
    name?: string
    model?: string
    effort?: string
    accessProfile?: 'read_only' | 'workspace_write' | 'full_access'
    resumeSession?: string
    permissionMode?: string
    cardId?: number
    maxBudgetUsd?: number
    taskBudgetTokens?: number
    agentHome?: ClaudeAgentHomeBinding
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
  forkSession?: ClaudeNativeSessionFork
  pollIntervalMs?: number
}

type ClaudeSessionState = {
  session: DriverSession
  agentId: number
  cwd: string | null
}

export class ClaudeAgentDriverAdapter implements AgentDriver {
  readonly id = 'claude'
  private readonly sessions = new Map<string, ClaudeSessionState>()
  private readonly pollIntervalMs: number

  constructor(private readonly options: ClaudeAgentDriverOptions) {
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250)
  }

  capabilities(): DriverCapabilities {
    return {
      attach: true,
      streaming: true,
      interrupt: true,
      stop: true,
      rawTerminal: false,
      resume: true,
      tokenBudget: true,
      costBudget: true,
      managesAgentIdentity: true,
    }
  }

  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    if (!Number.isInteger(request.boardId) || request.boardId! <= 0) throw new Error('Claude driver requires boardId')
    const cardId = request.metadata?.cardId
    const agentHome = this.agentHomeBinding(request)
    const agent = this.options.conductor.hire({
      boardId: request.boardId!,
      cwd: request.cwd,
      ...(request.name ? { name: request.name } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.accessProfile ? { accessProfile: request.accessProfile } : {}),
      ...(request.externalId ? { resumeSession: request.externalId } : {}),
      ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
      ...(request.maxBudgetUsd !== undefined ? { maxBudgetUsd: request.maxBudgetUsd } : {}),
      ...(request.taskBudgetTokens !== undefined ? { taskBudgetTokens: request.taskBudgetTokens } : {}),
      ...(typeof cardId === 'number' && Number.isInteger(cardId) ? { cardId } : {}),
      ...(agentHome ? { agentHome } : {}),
    })
    const session = this.toSession(agent, request.workspaceId)
    this.sessions.set(session.id, { session, agentId: agent.id, cwd: request.cwd })
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
    const transcript = this.options.conductor.transcript(agent.id)
    const cwd = typeof transcript.info?.cwd === 'string' && transcript.info.cwd.trim()
      ? transcript.info.cwd
      : null
    this.sessions.set(session.id, { session, agentId: agent.id, cwd })
    return session
  }

  /**
   * Forks only the provider transcript. Claude SDK 0.3.212 does not copy the
   * source session's undo history or file-history snapshots into the child.
   */
  async forkSession(
    sessionId: string,
    options: ClaudeSessionForkOptions,
  ): Promise<ClaudeSessionForkResult> {
    const state = this.required(sessionId)
    const sourceExternalId = options.sourceExternalId.trim()
    if (!sourceExternalId) {
      throw new Error(`Claude session ${sessionId} external provenance does not match`)
    }
    if (options.workspaceId !== state.session.workspaceId) {
      throw new Error(`Claude session ${sessionId} belongs to another workspace`)
    }
    const requestedCwd = options.cwd.trim()
    if (!requestedCwd) throw new Error('Claude session fork requires cwd provenance')
    if (!state.cwd) throw new Error(`Claude session ${sessionId} cwd provenance is unavailable`)
    if (path.resolve(requestedCwd) !== path.resolve(state.cwd)) {
      throw new Error(`Claude session ${sessionId} belongs to another cwd`)
    }

    const numericFallback = String(state.agentId)
    if (sourceExternalId !== state.session.externalId) {
      if (state.session.externalId !== numericFallback
        || !this.options.resolveAgent
        || !this.options.workspaceForAgent) {
        throw new Error(`Claude session ${sessionId} external provenance does not match`)
      }
      const resolved = await this.options.resolveAgent(sourceExternalId)
      if (!resolved
        || resolved.id !== state.agentId
        || resolved.sdk_session !== sourceExternalId) {
        throw new Error(`Claude provider session ${sourceExternalId} does not belong to agent ${state.agentId}`)
      }
      const resolvedWorkspaceId = await this.options.workspaceForAgent(resolved.id)
      if (!resolvedWorkspaceId
        || resolvedWorkspaceId !== state.session.workspaceId
        || resolvedWorkspaceId !== options.workspaceId) {
        throw new Error(`Claude session ${sessionId} belongs to another workspace`)
      }
      state.session.externalId = sourceExternalId
    } else if (sourceExternalId === numericFallback) {
      throw new Error(`Claude session ${sessionId} provider provenance is not initialized`)
    }

    const upToMessageId = options.upToMessageId?.trim()
    if (options.upToMessageId !== undefined && !upToMessageId) {
      throw new Error('Claude session fork upToMessageId must not be empty')
    }
    const title = options.title?.trim()
    const nativeFork = this.options.forkSession
      ?? (await import('@anthropic-ai/claude-agent-sdk')).forkSession
    const forked = await nativeFork(sourceExternalId, {
      dir: state.cwd,
      ...(upToMessageId ? { upToMessageId } : {}),
      ...(title ? { title } : {}),
    })
    const externalId = typeof forked?.sessionId === 'string' ? forked.sessionId.trim() : ''
    if (!externalId) throw new Error('Claude SDK fork did not return a session id')
    if (externalId === sourceExternalId) {
      throw new Error('Claude SDK fork returned the source session id')
    }

    return {
      sourceExternalId,
      externalId,
      providerThreadId: externalId,
      sourceProviderThreadId: sourceExternalId,
      metadata: {
        forkMethod: 'sdk.forkSession',
        workspaceId: state.session.workspaceId,
        cwd: state.cwd,
        fileHistoryCopied: false,
        undoHistoryCopied: false,
        ...(upToMessageId ? { upToMessageId } : {}),
        ...(title ? { title } : {}),
      },
    }
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

  private agentHomeBinding(request: DriverLaunchRequest): ClaudeAgentHomeBinding | undefined {
    const sessionId = request.metadata?.agentHomeSessionId
    const profileId = request.metadata?.agentProfileId
    const conversationId = request.metadata?.agentConversationId
    const present = [sessionId, profileId, conversationId].filter((value) => typeof value === 'string').length
    if (present === 0) return undefined
    if (present !== 3) throw new Error('Claude Agent Home binding metadata is incomplete')
    return {
      agentHomeSessionId: sessionId as string,
      agentProfileId: profileId as string,
      agentConversationId: conversationId as string,
    }
  }
}

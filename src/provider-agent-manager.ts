import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { defaultsForRole, type SpecialistRole } from './agent-defaults.js'
import {
  CODEX_PROVIDER_ID,
  codexProviderCatalog,
  readProviderModelCache,
  type AgentProviderCapabilities,
  type AgentProviderCatalog,
  type AgentProviderService,
} from './agent-providers.js'
import { generateName } from './names.js'
import { bounceDeadLetters, removeAgentCards } from './reaper.js'
import type { ConductorLike } from './server.js'
import { autoshipEnabled, cardWorktree } from './shipqueue.js'
import type { AgentDriver, DriverEvent, DriverSession } from './runtime/index.js'
import { appendDriverTranscript, type DriverTranscriptLine } from './runtime/transcript.js'
import { fromCodexUsage, recordProviderUsage, type ProviderUsageSplit } from './usage.js'
import { KnowledgeRuntimeIntegration } from './agent-os/knowledge-runtime-integration.js'
import { WorkspaceStore } from './agent-os/workspace-store.js'
import { AgentProfileService } from './agent-os/agent-profiles.js'
import { provisionManagedAgentSessionCredential } from './agent-session-credential.js'

export const ACCESS_PROFILES = ['read_only', 'workspace_write', 'full_access'] as const
export type AccessProfile = (typeof ACCESS_PROFILES)[number]

export const CODEX_CAPABILITIES: AgentProviderCapabilities = {
  steering: true,
  approvals: true,
  model: true,
  effort: true,
  rate_limits: true,
  usage: true,
  diffs: true,
  plans: true,
  subagents: true,
  ambient_hooks: true,
  session_end_hooks: false,
  access_profile: true,
  interrupt: true,
  stop: true,
}

export const CLAUDE_CAPABILITIES: AgentProviderCapabilities = {
  steering: false,
  approvals: true,
  model: true,
  effort: true,
  rate_limits: true,
  usage: true,
  diffs: false,
  plans: true,
  subagents: true,
  ambient_hooks: true,
  session_end_hooks: true,
  access_profile: true,
  interrupt: true,
  stop: true,
}

export class ProviderUnavailableError extends Error {
  readonly statusCode = 503
  constructor(readonly provider: string, detail?: string) {
    super(detail ? `${provider} is unavailable: ${detail}` : `${provider} is unavailable`)
  }
}

export interface ManagedAgentDriver extends AgentDriver {
  updateSession?(sessionId: string, patch: {
    model?: string
    effort?: string
    accessProfile?: AccessProfile
  }): Promise<void>
  resolveApproval?(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'allow_session' | 'deny' | 'cancel',
    message?: string,
    answers?: Record<string, string[]>,
  ): Promise<boolean>
}

export type ProviderHireOptions = {
  boardId: number
  cwd: string
  name?: string
  provider?: string
  model?: string
  role?: SpecialistRole
  ephemeral?: boolean
  resumeSession?: string
  permissionMode?: string
  accessProfile?: AccessProfile
  effort?: string
  cardId?: number
  maxBudgetUsd?: number
  taskBudgetTokens?: number
}

export type ProviderLaunchRequest = {
  boardId: number
  cardId: number
  cwd: string
  brief: string
  provider?: string
  model?: string
  effort?: string
  accessProfile?: AccessProfile
}

export interface AgentOsAgentControl {
  ownsAgent(agentId: number): boolean
  isHiredAgent(agentId: number): boolean
  isLaunchedCard(cardId: number): boolean
  taskAgent(agentId: number, text: string): boolean
  deliverAgent(agentId: number, message: any): boolean
  transcriptAgent(agentId: number): any
  subagentsForAgent(agentId: number): { key: string; label: string }[]
  interruptManagedAgent(agentId: number): Promise<boolean>
  fireManagedAgent(agentId: number): Promise<boolean>
  setManagedAgentModel(agentId: number, model: string): Promise<boolean>
  setManagedAgentEffort(agentId: number, level: string): Promise<'ok' | 'busy' | 'not-found' | 'bad-level' | 'no-session'>
  setManagedAgentAccess(agentId: number, profile: AccessProfile): Promise<boolean>
  resolveManagedApproval(
    agentId: number,
    requestId: string,
    decision: 'allow' | 'allow_session' | 'deny' | 'cancel',
    message?: string,
    answers?: Record<string, string[]>,
  ): Promise<boolean>
}

type TranscriptLine = DriverTranscriptLine

type CodexState = {
  agentId: number
  boardId: number
  name: string
  cwd: string
  role?: SpecialistRole
  ephemeral: boolean
  model: string | null
  effort: string | null
  accessProfile: AccessProfile
  session: DriverSession | null
  queue: string[]
  transcript: TranscriptLine[]
  pending: Map<string, Record<string, unknown>>
  subagents: Map<string, string>
  completedItemIds: Set<string>
  usageTotal: ProviderUsageSplit
  activeTurnId: string | null
  cardId: number | null
  branch: string | null
  cardFinalized: boolean
  ended: boolean
  stopping: boolean
  detaching: boolean
  sending: Promise<void>
  lastEventSeq: number
  rateLimitPause: { at: string; snapshot?: unknown } | null
  ambientContext: string | null
  ambientSessionId: string | null
}

const emptyCodexUsage = (): ProviderUsageSplit => ({
  provider: CODEX_PROVIDER_ID,
  total_tokens: 0,
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  cost_cents: null,
})

const enabledCapabilities = (capabilities: AgentProviderCapabilities): string[] =>
  Object.entries(capabilities).filter(([, enabled]) => enabled).map(([name]) => name)

const permissionModeForAccess = (profile: AccessProfile): string => {
  if (profile === 'read_only') return 'plan'
  if (profile === 'workspace_write') return 'acceptEdits'
  return 'bypassPermissions'
}

const accessForPermissionMode = (mode?: string): AccessProfile | undefined => {
  if (mode === 'plan') return 'read_only'
  if (mode === 'acceptEdits' || mode === 'default') return 'workspace_write'
  if (mode === 'bypassPermissions') return 'full_access'
  return undefined
}

const parseObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch { return {} }
}

const safeProvider = (value: string): string => {
  const provider = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider)) throw new Error(`invalid provider: ${value}`)
  return provider
}

const isAccessProfile = (value: unknown): value is AccessProfile =>
  typeof value === 'string' && ACCESS_PROFILES.includes(value as AccessProfile)

const codexRoleInstructions = (role: SpecialistRole | undefined, name: string): string | undefined => {
  if (role === 'strategist') return `You are "${name}", this project's Orchestra strategist. You are read-only: never modify files. Research the repository, help the user refine ideas, and create concrete backlog cards with orchestra CLI commands only when requested. Make each card implementation-ready with OBJECTIVE, CONTEXT, REQUIREMENTS, and DONE WHEN sections. Do not implement the cards yourself.`
  if (role === 'auditor') return `You are "${name}", a one-shot Orchestra ticket auditor. You are read-only: never modify files. Audit exactly one roadmap idea against the repository and existing board work. Either create one implementation-ready, unassigned card and consume the idea, or reject/mark it duplicate with evidence. Record the result on the board, then stop.`
  if (role === 'verifier') return `You are "${name}", a one-shot Orchestra delivery verifier. You are read-only: never modify files, create cards, move cards, approve, or ship. Inspect the actual delivered diff and test results against every acceptance criterion. Submit exactly one evidence-backed pass, gaps, or fail report using the command in your brief, then stop.`
  return undefined
}

/** Board-facing lifecycle for Codex threads, backed by the provider-neutral AgentDriver. */
export class CodexManagedAgentRuntime {
  private readonly states = new Map<number, CodexState>()
  private readonly knowledge: KnowledgeRuntimeIntegration

  constructor(
    private readonly db: Database.Database,
    private readonly bus: EventEmitter,
    private readonly driver: ManagedAgentDriver,
    private readonly providerService?: AgentProviderService,
  ) {
    if (driver.id !== CODEX_PROVIDER_ID) throw new Error(`expected codex driver, got ${driver.id}`)
    this.knowledge = new KnowledgeRuntimeIntegration(db)
  }

  isHired(agentId: number): boolean {
    const state = this.states.get(agentId)
    return !!state && !state.ended
  }

  hire(options: ProviderHireOptions): any {
    const existingLive = options.name
      ? [...this.states.values()].find((state) => !state.ended && state.boardId === options.boardId && state.name === options.name)
      : undefined
    if (existingLive) return this.agent(existingLive.agentId)

    let name = options.name
    if (!name) {
      do { name = generateName() } while (
        this.db.prepare('SELECT 1 FROM agents WHERE board_id=? AND name=?').get(options.boardId, name))
    }
    const existing = this.db.prepare('SELECT id, provider, status, provider_state_json FROM agents WHERE board_id=? AND name=?')
      .get(options.boardId, name) as { id: number; provider: string; status: string; provider_state_json: string } | undefined
    if (existing && existing.provider !== CODEX_PROVIDER_ID && existing.status !== 'gone')
      throw new Error(`agent ${name} already belongs to provider ${existing.provider}`)

    const resumeSession = options.resumeSession?.trim() || undefined
    if (resumeSession) this.assertResumeOwnership(resumeSession, existing?.id)
    const prior = resumeSession ? parseObject(existing?.provider_state_json) : {}
    const accessProfile = options.accessProfile ?? (options.role ? 'read_only' : 'workspace_write')
    const stateJson = JSON.stringify({
      ...prior,
      cwd: options.cwd,
      card_id: options.cardId ?? null,
      active_turn_id: null,
      lifecycle: 'starting',
    })
    this.db.prepare(`
      INSERT INTO agents (
        board_id, name, session_id, kind, role, status, provider, external_session_id,
        provider_state_json, access_profile, model, effort
      ) VALUES (?, ?, ?, 'hired', ?, 'starting', 'codex', ?, ?, ?, ?, ?)
      ON CONFLICT(board_id, name) DO UPDATE SET
        session_id=excluded.session_id, kind='hired', role=excluded.role, status='starting',
        provider='codex', external_session_id=excluded.external_session_id,
        sdk_session=NULL, hook_token_hash=NULL,
        provider_state_json=excluded.provider_state_json, access_profile=excluded.access_profile,
        model=excluded.model, effort=excluded.effort, last_seen=datetime('now')
    `).run(
      options.boardId,
      name,
      `hired:codex:${Date.now()}`,
      options.role ?? null,
      resumeSession ?? null,
      stateJson,
      accessProfile,
      options.model ?? null,
      options.effort ?? null,
    )
    const row = this.db.prepare('SELECT * FROM agents WHERE board_id=? AND name=?').get(options.boardId, name) as any
    const persistedUsage = prior.usage_total && typeof prior.usage_total === 'object'
      ? fromCodexUsage(prior.usage_total)
      : emptyCodexUsage()
    const state: CodexState = {
      agentId: Number(row.id),
      boardId: options.boardId,
      name,
      cwd: options.cwd,
      role: options.role,
      ephemeral: options.ephemeral ?? false,
      model: options.model ?? null,
      effort: options.effort ?? null,
      accessProfile,
      session: null,
      queue: [],
      transcript: [],
      pending: new Map(),
      subagents: new Map(),
      completedItemIds: new Set(Array.isArray(prior.completed_item_ids)
        ? prior.completed_item_ids.filter((id): id is string => typeof id === 'string').slice(-500)
        : []),
      usageTotal: persistedUsage,
      activeTurnId: null,
      cardId: options.cardId ?? null,
      branch: null,
      cardFinalized: false,
      ended: false,
      stopping: false,
      detaching: false,
      sending: Promise.resolve(),
      lastEventSeq: 0,
      rateLimitPause: prior.rate_limit_pause && typeof prior.rate_limit_pause === 'object'
        ? prior.rate_limit_pause as { at: string; snapshot?: unknown }
        : null,
      ambientContext: null,
      ambientSessionId: null,
    }
    this.states.set(state.agentId, state)
    this.log(state, 'status', resumeSession ? `resumed in ${options.cwd} (previous session continues)` : `hired in ${options.cwd}`)
    this.emitAgent(state)
    void this.start(state, resumeSession).catch((error) => this.failStart(state, error))
    return row
  }

  launch(request: ProviderLaunchRequest): any {
    let cwd = request.cwd
    let branch: string | null = null
    if (autoshipEnabled()) {
      const branchName = `card-${request.cardId}`
      const worktree = cardWorktree(request.cwd, request.cardId)
      try {
        if (!existsSync(worktree)) {
          try { execFileSync('git', ['worktree', 'add', worktree, '-b', branchName], { cwd: request.cwd, timeout: 30_000 }) }
          catch { execFileSync('git', ['worktree', 'add', worktree, branchName], { cwd: request.cwd, timeout: 30_000 }) }
        }
        cwd = worktree
        branch = branchName
      } catch { /* shared checkout remains usable when worktree creation is unavailable */ }
    }
    const agent = this.hire({
      boardId: request.boardId,
      cwd,
      provider: CODEX_PROVIDER_ID,
      model: request.model,
      effort: request.effort,
      accessProfile: request.accessProfile,
      cardId: request.cardId,
    })
    const state = this.required(agent.id)
    state.branch = branch
    this.db.prepare(`UPDATE cards SET owner_agent_id=?, column_name='in_progress', branch=?, updated_at=datetime('now') WHERE id=?`)
      .run(agent.id, branch, request.cardId)
    this.cardEvent(request.cardId, agent.id, 'launched', { agent: agent.name, provider: CODEX_PROVIDER_ID })
    this.bus.emit('event', { board_id: request.boardId, type: 'card', data: this.card(request.cardId) })
    this.bus.emit('event', {
      board_id: request.boardId,
      type: 'launch',
      data: { card_id: request.cardId, agent_id: agent.id, agent_name: agent.name, provider: CODEX_PROVIDER_ID, status: 'started' },
    })
    this.task(agent.id, request.brief)
    return { agent: this.agent(agent.id), card: this.card(request.cardId) }
  }

  isLaunched(cardId: number): boolean {
    return [...this.states.values()].some((state) => !state.ended && state.cardId === cardId)
  }

  adoptLaunch(agentId: number): void {
    const state = this.states.get(agentId)
    if (!state || state.cardId !== null) return
    const card = this.db.prepare(`SELECT c.id, c.branch FROM cards c
      JOIN card_events e ON e.card_id=c.id AND e.type='launched' AND e.agent_id=?
      WHERE c.owner_agent_id=? AND c.column_name='in_progress' ORDER BY e.id DESC LIMIT 1`)
      .get(agentId, agentId) as { id: number; branch: string | null } | undefined
    if (card) { state.cardId = card.id; state.branch = card.branch }
  }

  task(agentId: number, text: string): boolean {
    const state = this.states.get(agentId)
    if (!state || state.ended || !text) return false
    this.log(state, 'user', text)
    state.queue.push(text)
    this.flush(state)
    return true
  }

  deliver(agentId: number, message: any): boolean {
    const from = message?.from_name ? ` from ${message.from_name}` : ''
    const prefix = message?.kind === 'notify' ? 'notification' : message?.kind === 'task' ? 'task' : 'message'
    return this.task(agentId, `orchestra ${prefix}${from}: ${String(message?.body ?? '')}`)
  }

  transcript(agentId: number): any {
    const state = this.states.get(agentId)
    if (!state) return { lines: [], working: null }
    const resolvedModel = typeof state.session?.metadata.resolvedModel === 'string'
      ? state.session.metadata.resolvedModel
      : state.model
    const resolvedEffort = typeof state.session?.metadata.resolvedEffort === 'string'
      ? state.session.metadata.resolvedEffort
      : state.effort
    return {
      lines: state.transcript,
      working: state.activeTurnId ? { secs: 0, tokens: 0 } : null,
      info: {
        provider: CODEX_PROVIDER_ID,
        capabilities: enabledCapabilities(CODEX_CAPABILITIES),
        accessProfile: state.accessProfile,
        model: state.model,
        requestedModel: state.model,
        resolvedModel,
        effort: state.effort,
        resolvedEffort,
        cwd: state.cwd,
        tokens: state.usageTotal.total_tokens,
        usage: { session: state.usageTotal },
        models: readProviderModelCache(this.db, CODEX_PROVIDER_ID)?.models ?? [],
        permissionMode: permissionModeForAccess(state.accessProfile),
      },
      permissions: [...state.pending.values()],
    }
  }

  subagents(agentId: number): { key: string; label: string }[] {
    const state = this.states.get(agentId)
    return state ? [...state.subagents].map(([key, label]) => ({ key, label })) : []
  }

  async interruptAgent(agentId: number): Promise<boolean> {
    const state = this.states.get(agentId)
    if (!state || state.ended || !state.session) return false
    await this.driver.interrupt(state.session.id)
    state.activeTurnId = null
    this.log(state, 'status', 'interrupted by user')
    this.persist(state)
    return true
  }

  async fire(agentId: number): Promise<boolean> {
    const state = this.states.get(agentId)
    if (!state || state.ended) return false
    state.stopping = true
    if (state.session) await this.driver.stop(state.session.id).catch(() => undefined)
    this.finish(state, state.cardId !== null && !state.cardFinalized ? 'error' : 'success', 'stopped by user')
    return true
  }

  async setModel(agentId: number, model: string): Promise<boolean> {
    const state = this.states.get(agentId)
    if (!state || state.ended || !model.trim()) return false
    if (state.session && this.driver.updateSession) {
      try { await this.driver.updateSession(state.session.id, { model }) }
      catch { return false }
    }
    state.model = model
    this.db.prepare('UPDATE agents SET model=? WHERE id=?').run(model, agentId)
    this.log(state, 'status', `model → ${model} (takes effect next turn)`)
    this.persist(state)
    return true
  }

  async setEffort(agentId: number, level: string): Promise<'ok' | 'busy' | 'not-found' | 'bad-level' | 'no-session'> {
    const state = this.states.get(agentId)
    if (!state || state.ended) return 'not-found'
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(level)) return 'bad-level'
    if (state.session && this.driver.updateSession) {
      try { await this.driver.updateSession(state.session.id, { effort: level }) }
      catch { return 'bad-level' }
    }
    state.effort = level
    this.db.prepare('UPDATE agents SET effort=? WHERE id=?').run(level, agentId)
    this.log(state, 'status', `reasoning effort → ${level} (takes effect next turn)`)
    this.persist(state)
    return 'ok'
  }

  async setAccessProfile(agentId: number, profile: AccessProfile): Promise<boolean> {
    const state = this.states.get(agentId)
    if (!state || state.ended || !isAccessProfile(profile)) return false
    if (state.session && this.driver.updateSession) {
      try { await this.driver.updateSession(state.session.id, { accessProfile: profile }) }
      catch { return false }
    }
    state.accessProfile = profile
    this.db.prepare('UPDATE agents SET access_profile=? WHERE id=?').run(profile, agentId)
    this.log(state, 'status', `access profile → ${profile} (takes effect next turn)`)
    this.persist(state)
    return true
  }

  async resolvePermission(
    agentId: number,
    requestId: string,
    behavior: 'allow' | 'deny',
    message?: string,
  ): Promise<boolean> {
    return this.resolveApproval(agentId, requestId, behavior, message)
  }

  async resolveApproval(
    agentId: number,
    requestId: string,
    decision: 'allow' | 'allow_session' | 'deny' | 'cancel',
    message?: string,
    answers?: Record<string, string[]>,
  ): Promise<boolean> {
    const state = this.states.get(agentId)
    if (!state?.session || !state.pending.has(requestId) || !this.driver.resolveApproval) return false
    const ok = await this.driver.resolveApproval(state.session.id, requestId, decision, message, answers)
    if (ok) state.pending.delete(requestId)
    return ok
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.states.values()].filter((state) => !state.ended).map(async (state) => {
      state.detaching = true
      this.persist(state)
      if (state.session && this.driver.detach) await this.driver.detach(state.session.id)
      this.persist(state)
    }))
  }

  private async start(state: CodexState, externalId?: string): Promise<void> {
    let session = externalId ? await this.driver.attach(externalId) : null
    const attached = !!session
    if (!session) {
      session = await this.driver.launch({
        workspaceId: `legacy-agent:${state.agentId}`,
        boardId: state.boardId,
        cwd: state.cwd,
        name: state.name,
        ...(externalId ? { externalId } : {}),
        ...(state.model ? { model: state.model } : {}),
        accessProfile: state.accessProfile,
        metadata: {
          agentId: state.agentId,
          cardId: state.cardId,
          role: state.role ?? null,
          effort: state.effort,
          ...(codexRoleInstructions(state.role, state.name)
            ? { developerInstructions: codexRoleInstructions(state.role, state.name) }
            : {}),
        },
      })
    }
    if (attached && this.driver.updateSession) await this.driver.updateSession(session.id, {
      ...(state.model ? { model: state.model } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
      accessProfile: state.accessProfile,
    })
    if (state.ended || state.detaching) {
      state.session = session
      this.db.prepare(`UPDATE agents SET external_session_id=?, last_seen=datetime('now') WHERE id=?`)
        .run(session.externalId, state.agentId)
      if (state.detaching && this.driver.detach) await this.driver.detach(session.id).catch(() => undefined)
      else await this.driver.stop(session.id).catch(() => undefined)
      this.persist(state)
      return
    }
    state.session = session
    this.db.prepare(`UPDATE agents SET status='active', external_session_id=?,
      last_seen=datetime('now') WHERE id=?`).run(session.externalId, state.agentId)
    const collaboration = this.ensureLegacyCollaborationSession(state, session)
    provisionManagedAgentSessionCredential(this.db, {
      agentId: state.agentId,
      boardId: state.boardId,
      agentName: state.name,
      provider: CODEX_PROVIDER_ID,
      externalSessionId: session.externalId,
      cwd: state.cwd,
    })
    if (state.cardId === null && this.knowledge.hasSources(state.boardId)) {
      const repositoryHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: state.cwd,
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().toLowerCase()
      const ambient = this.knowledge.prepareAmbientSessionStart({
        board_id: state.boardId,
        session_id: collaboration.sessionId,
        workspace_id: collaboration.workspaceId,
        repository_head_sha: repositoryHead,
        objective: state.queue[0] ?? 'Provide exact repository context for this ambient Orchestra session.',
        created_at: new Date().toISOString(),
      })
      state.ambientContext = ambient?.session_start_context ?? null
      state.ambientSessionId = collaboration.sessionId
    }
    this.log(state, 'status', `session started${state.model ? ` · ${state.model}` : ''} · ${state.cwd}`)
    this.persist(state)
    this.emitAgent(state)
    void this.watch(state, session)
    this.flush(state)
  }

  private flush(state: CodexState): void {
    if (!state.session || state.ended || state.detaching) return
    state.sending = state.sending.then(async () => {
      while (state.session && state.queue.length && !state.ended) {
        const text = state.queue[0]
        const prompt = state.ambientContext === null
          ? text
          : `${state.ambientContext}\n\n${text}`
        await this.driver.send(state.session.id, prompt)
        state.ambientContext = null
        state.queue.shift()
      }
      this.persist(state)
    }).catch((error) => {
      this.log(state, 'error', error instanceof Error ? error.message : String(error))
    })
  }

  private async watch(state: CodexState, session: DriverSession): Promise<void> {
    let sawExit = false
    try {
      for await (const event of this.driver.events(session.id)) {
        if (state.ended || state.detaching || state.session?.id !== session.id) return
        state.lastEventSeq = Math.max(state.lastEventSeq, event.seq)
        if (this.isDuplicateCompletedItem(state, event)) continue
        this.applyEvent(state, event)
        if (event.type === 'exit') { sawExit = true; break }
        if (state.cardId !== null && this.isTurnCompleted(event)) {
          const failed = event.metadata?.status === 'failed' || event.metadata?.status === 'interrupted'
          this.finalizeCard(state, failed ? 'error' : 'success', event.data || (failed ? 'turn failed' : 'finished'))
          state.stopping = true
          await this.driver.stop(session.id).catch(() => undefined)
          sawExit = true
          break
        }
      }
    } catch (error) {
      this.log(state, 'error', error instanceof Error ? error.message : String(error))
      sawExit = true
    } finally {
      if (state.detaching) {
        this.persist(state)
        return
      }
      if (sawExit && !state.ended) this.finish(
        state,
        state.cardFinalized ? 'success' : 'error',
        state.stopping ? 'stopped' : 'Codex session ended',
      )
    }
  }

  private applyEvent(state: CodexState, event: DriverEvent): void {
    const metadata = event.metadata ?? {}
    const rateLimited = event.type === 'error'
      && /rate.?limit|too many requests|quota|\b429\b/i.test(event.data)
    if (rateLimited) {
      state.rateLimitPause = { at: event.at }
      this.db.prepare("UPDATE agents SET status='paused_provider', last_seen=datetime('now') WHERE id=?").run(state.agentId)
      void this.captureRateLimitSnapshot(state, event.at)
    } else if (state.rateLimitPause && (event.type === 'output' || metadata.turnActive === true)) {
      state.rateLimitPause = null
      this.db.prepare("UPDATE agents SET status='active', last_seen=datetime('now') WHERE id=?").run(state.agentId)
    }
    if (typeof metadata.turnId === 'string') state.activeTurnId = metadata.turnId
    if (metadata.turnActive === false || this.isTurnCompleted(event)) state.activeTurnId = null
    const requestId = typeof metadata.requestId === 'string' ? metadata.requestId : undefined
    if (requestId && (metadata.approval === true || metadata.kind === 'approval')) {
      const approvalKind = typeof metadata.approvalKind === 'string' ? metadata.approvalKind : 'tool'
      state.pending.set(requestId, {
        id: requestId,
        at: event.at,
        title: `${approvalKind.replaceAll('-', ' ')} approval`,
        summary: event.data || String(metadata.method ?? 'Codex needs approval to continue.'),
        ...metadata,
      })
    }
    const subagentId = typeof metadata.subagentId === 'string' ? metadata.subagentId : undefined
    if (subagentId && metadata.subagentStatus === 'started')
      state.subagents.set(subagentId, String(metadata.label ?? 'subagent'))
    if (subagentId && metadata.subagentStatus === 'stopped') state.subagents.delete(subagentId)

    const rawUsage = metadata.tokenUsage && typeof metadata.tokenUsage === 'object'
      ? (metadata.tokenUsage as Record<string, unknown>).total
      : metadata.usageTotal
    if (rawUsage) this.recordUsageDelta(state, rawUsage)

    if (appendDriverTranscript(state.transcript, event)) {
      this.bus.emit('event', { board_id: state.boardId, type: 'transcript', data: { agent_id: state.agentId } })
    }
    this.persist(state)
  }

  private recordUsageDelta(state: CodexState, raw: unknown): void {
    const total = fromCodexUsage(raw)
    const previous = state.usageTotal
    const delta: ProviderUsageSplit = {
      provider: CODEX_PROVIDER_ID,
      total_tokens: Math.max(0, total.total_tokens - previous.total_tokens),
      input_tokens: Math.max(0, total.input_tokens - previous.input_tokens),
      cached_input_tokens: Math.max(0, total.cached_input_tokens - previous.cached_input_tokens),
      cache_creation_input_tokens: 0,
      output_tokens: Math.max(0, total.output_tokens - previous.output_tokens),
      reasoning_output_tokens: Math.max(0, total.reasoning_output_tokens - previous.reasoning_output_tokens),
      cost_cents: null,
    }
    if (delta.total_tokens > 0) recordProviderUsage(this.db, state.boardId, state.agentId, delta)
    state.usageTotal = total
  }

  private async captureRateLimitSnapshot(state: CodexState, pausedAt: string): Promise<void> {
    if (!this.providerService?.usageSnapshot) return
    const snapshot = await this.providerService.usageSnapshot().catch(() => undefined)
    if (!snapshot || state.ended || state.rateLimitPause?.at !== pausedAt) return
    state.rateLimitPause = { at: pausedAt, snapshot }
    this.persist(state)
  }

  private isDuplicateCompletedItem(state: CodexState, event: DriverEvent): boolean {
    const itemId = typeof event.metadata?.itemId === 'string' ? event.metadata.itemId : undefined
    const completed = event.metadata?.itemCompleted === true || event.metadata?.method === 'item/completed'
    if (!itemId || !completed) return false
    if (state.completedItemIds.has(itemId)) return true
    state.completedItemIds.add(itemId)
    while (state.completedItemIds.size > 500) state.completedItemIds.delete(state.completedItemIds.values().next().value!)
    return false
  }

  private isTurnCompleted(event: DriverEvent): boolean {
    return event.metadata?.method === 'turn/completed' || event.metadata?.turnCompleted === true
  }

  private failStart(state: CodexState, error: unknown): void {
    if (state.ended || state.detaching) return
    const detail = error instanceof Error ? error.message : String(error)
    this.log(state, 'error', `Codex failed to start: ${detail}`)
    this.finish(state, 'error', detail)
  }

  private finish(state: CodexState, outcome: 'success' | 'error', reason: string): void {
    if (state.ended) return
    state.ended = true
    state.activeTurnId = null
    state.pending.clear()
    if (state.cardId !== null && !state.cardFinalized) this.finalizeCard(state, outcome, reason)
    removeAgentCards(this.db, state.agentId)
    this.db.prepare("UPDATE agents SET status='gone', last_seen=datetime('now') WHERE id=?").run(state.agentId)
    if (state.ambientSessionId) {
      this.db.prepare(`UPDATE agent_sessions SET status='stopped',
        updated_at=datetime('now') WHERE id=? AND job_id IS NULL`)
        .run(state.ambientSessionId)
    }
    bounceDeadLetters(this.db, state.agentId)
    this.log(state, 'status', reason)
    this.persist(state)
    this.emitAgent(state)
  }

  private finalizeCard(state: CodexState, outcome: 'success' | 'error', reason: string): void {
    if (state.cardId === null || state.cardFinalized) return
    state.cardFinalized = true
    const card = this.card(state.cardId)
    if (!card) return
    const column = card.column === 'done' ? 'done' : outcome === 'success' ? 'review' : 'blocked'
    this.db.prepare(`UPDATE cards SET owner_agent_id=NULL, column_name=?, updated_at=datetime('now') WHERE id=?`)
      .run(column, state.cardId)
    this.cardEvent(state.cardId, state.agentId, 'agent_exit', {
      outcome,
      reason,
      to: column,
      agent: state.name,
      provider: CODEX_PROVIDER_ID,
    })
    this.bus.emit('event', { board_id: state.boardId, type: 'card', data: this.card(state.cardId) })
    this.bus.emit('event', {
      board_id: state.boardId,
      type: 'launch',
      data: {
        card_id: state.cardId,
        agent_id: state.agentId,
        agent_name: state.name,
        provider: CODEX_PROVIDER_ID,
        status: 'finished',
        outcome,
        reason,
        to_column: column,
        summary: this.finalAssistantOutput(state),
      },
    })
  }

  private finalAssistantOutput(state: CodexState): string | undefined {
    for (let index = state.transcript.length - 1; index >= 0; index -= 1) {
      const line = state.transcript[index]
      if (line.kind !== 'text') continue
      const output = line.text.trim()
      if (output) return output
    }
    return undefined
  }

  private persist(state: CodexState): void {
    const providerState = {
      driver_session_id: state.session?.id ?? null,
      thread_id: state.session?.externalId ?? null,
      active_turn_id: state.activeTurnId,
      last_event_seq: state.lastEventSeq,
      completed_item_ids: [...state.completedItemIds],
      cwd: state.cwd,
      card_id: state.cardId,
      branch: state.branch,
      lifecycle: state.ended ? 'stopped' : state.detaching ? 'detached' : state.session ? 'active' : 'starting',
      usage_total: state.usageTotal,
      rate_limit_pause: state.rateLimitPause,
    }
    this.db.prepare(`UPDATE agents SET provider_state_json=?, access_profile=?, model=?, effort=?, last_seen=datetime('now') WHERE id=?`)
      .run(JSON.stringify(providerState), state.accessProfile, state.model, state.effort, state.agentId)
  }

  private log(state: CodexState, kind: TranscriptLine['kind'], text: string, metadata?: Record<string, unknown>): void {
    state.transcript.push({ at: new Date().toISOString(), kind, text, ...(metadata ? { metadata } : {}) })
    if (state.transcript.length > 500) state.transcript.shift()
    this.bus.emit('event', { board_id: state.boardId, type: 'transcript', data: { agent_id: state.agentId } })
  }

  private emitAgent(state: CodexState): void {
    this.bus.emit('event', { board_id: state.boardId, type: 'agent', data: this.agent(state.agentId) })
  }

  private cardEvent(cardId: number, agentId: number | null, type: string, payload: unknown): void {
    this.db.prepare('INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, ?, ?)')
      .run(cardId, agentId, type, JSON.stringify(payload))
  }

  private agent(agentId: number): any {
    return this.db.prepare('SELECT * FROM agents WHERE id=?').get(agentId)
  }

  private card(cardId: number): any {
    const card = this.db.prepare(`SELECT c.*, a.name AS owner FROM cards c
      LEFT JOIN agents a ON a.id=c.owner_agent_id WHERE c.id=?`).get(cardId) as any
    return card && { ...card, column: card.column_name, paths: JSON.parse(card.paths) }
  }

  private ambientWorkspace(state: CodexState) {
    const existing = new WorkspaceStore(this.db).listBoard(state.boardId)
      .find((workspace) => workspace.card_id === null
        && workspace.status === 'active'
        && (workspace.worktree_path ?? workspace.root_path) === state.cwd)
    if (existing) return existing
    return new WorkspaceStore(this.db).create({
      boardId: state.boardId,
      name: `Ambient ${state.name}`,
      kind: 'shared',
      rootPath: state.cwd,
      status: 'active',
    })
  }

  private ensureLegacyCollaborationSession(
    state: CodexState,
    session: DriverSession,
  ): { workspaceId: string; sessionId: string } {
    const workspace = this.ambientWorkspace(state)
    const profile = new AgentProfileService(this.db).create({
      boardId: state.boardId,
      name: `Managed Codex ${state.agentId}`,
      defaultProvider: CODEX_PROVIDER_ID,
      defaultModel: state.model,
      defaultEffort: state.effort,
      defaultAccessProfile: state.accessProfile,
      actor: { type: 'system', id: 'codex-managed-runtime' },
      idempotencyKey: `codex-managed-agent:${state.agentId}:profile`,
      correlationId: `codex-managed-agent:${state.agentId}`,
    })
    const conversation = this.db.prepare(`SELECT id FROM agent_conversations
      WHERE board_id=? AND profile_id=? AND status='active' AND is_default=1`)
      .get(state.boardId, profile.id) as { id: string }
    const sessionId = `legacy-codex:${state.agentId}`
    this.db.prepare(`INSERT INTO agent_sessions (
        id, workspace_id, agent_id, provider, external_id, model, status,
        profile_id, conversation_id, context_json, mode, driver_id, access_profile,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'codex', ?, ?, 'running', ?, ?, ?, 'managed', 'codex', ?,
        datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        workspace_id=excluded.workspace_id, agent_id=excluded.agent_id,
        external_id=excluded.external_id, model=excluded.model, status='running',
        profile_id=excluded.profile_id, conversation_id=excluded.conversation_id,
        context_json=excluded.context_json, access_profile=excluded.access_profile,
        updated_at=datetime('now')
      WHERE agent_sessions.job_id IS NULL`).run(
      sessionId,
      workspace.id,
      state.agentId,
      session.externalId,
      state.model,
      profile.id,
      conversation.id,
      JSON.stringify({ classification: 'legacy_managed', provider_session_id: session.externalId }),
      state.accessProfile,
    )
    return { workspaceId: workspace.id, sessionId }
  }

  private required(agentId: number): CodexState {
    const state = this.states.get(agentId)
    if (!state || state.ended) throw new Error(`Codex agent is not live: ${agentId}`)
    return state
  }

  private assertResumeOwnership(externalId: string, existingAgentId?: number): void {
    const owner = this.db.prepare(`SELECT id, name FROM agents
      WHERE provider=? AND external_session_id=? LIMIT 1`).get(CODEX_PROVIDER_ID, externalId) as
      { id: number; name: string } | undefined
    if (owner && owner.id !== existingAgentId)
      throw new Error(`Codex thread ${externalId} already belongs to agent ${owner.name}`)
    const durable = this.db.prepare(`SELECT agent_id FROM agent_sessions
      WHERE provider=? AND external_id=? AND status='running'
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(CODEX_PROVIDER_ID, externalId) as
      { agent_id: number | null } | undefined
    if (durable)
      throw new Error(`Codex thread ${externalId} is already attached to an active Agent OS job`)
  }
}

type QueuedLaunch = ProviderLaunchRequest & { provider: string }

/** One server-facing conductor surface that routes every operation by persisted provider. */
export class ProviderAgentManager implements ConductorLike {
  private readonly launchQueue: QueuedLaunch[] = []
  private draining = false

  constructor(
    private readonly db: Database.Database,
    private readonly bus: EventEmitter,
    private readonly claude: ConductorLike,
    private readonly codex?: CodexManagedAgentRuntime,
    private readonly codexService?: AgentProviderService & { isRuntimeAvailable?(): boolean },
    private readonly agentOs?: AgentOsAgentControl,
  ) {
    bus.on('event', (event: any) => {
      if (event?.type === 'launch' && event?.data?.status === 'finished') void this.drainQueue()
    })
  }

  isHired(agentId: number): boolean {
    return this.providerForAgent(agentId) === CODEX_PROVIDER_ID
      ? this.usesAgentOs(agentId)
        ? this.agentOs!.isHiredAgent(agentId)
        : this.codex?.isHired(agentId) ?? false
      : this.claude.isHired(agentId)
  }

  hire(options: ProviderHireOptions): any {
    const resolved = this.resolveHire(options)
    if (resolved.provider === CODEX_PROVIDER_ID) return this.requireCodex().hire(resolved)
    if (resolved.provider !== 'claude') throw new ProviderUnavailableError(resolved.provider, 'no registered agent provider')
    const agent = this.claude.hire({
      ...resolved,
      permissionMode: options.permissionMode ?? permissionModeForAccess(resolved.accessProfile ?? 'full_access'),
    })
    this.db.prepare(`UPDATE agents SET provider='claude', access_profile=? WHERE id=?`)
      .run(resolved.accessProfile ?? 'full_access', agent.id)
    return this.db.prepare('SELECT * FROM agents WHERE id=?').get(agent.id)
  }

  launch(request: ProviderLaunchRequest): any {
    const resolved = this.resolveLaunch(request)
    this.assertProviderAvailable(resolved.provider)
    if (this.launchedCount() >= this.maxLaunched()) {
      if (!this.launchQueue.some((queued) => queued.cardId === resolved.cardId)) this.launchQueue.push(resolved)
      const position = this.launchQueue.findIndex((queued) => queued.cardId === resolved.cardId) + 1
      this.cardEvent(resolved.cardId, null, 'launch_queued', { position, provider: resolved.provider })
      this.bus.emit('event', {
        board_id: resolved.boardId,
        type: 'launch',
        data: { card_id: resolved.cardId, status: 'queued', position, provider: resolved.provider },
      })
      return { queued: true, position, provider: resolved.provider }
    }
    return this.startLaunch(resolved)
  }

  isLaunched(cardId: number): boolean {
    return this.launchQueue.some((request) => request.cardId === cardId)
      || this.claude.isLaunched(cardId)
      || (this.codex?.isLaunched(cardId) ?? false)
      || (this.agentOs?.isLaunchedCard(cardId) ?? false)
  }

  deliver(agentId: number, message: any): boolean {
    return this.providerForAgent(agentId) === CODEX_PROVIDER_ID
      ? this.usesAgentOs(agentId)
        ? this.agentOs!.deliverAgent(agentId, message)
        : this.codex?.deliver(agentId, message) ?? false
      : this.claude.deliver(agentId, message)
  }

  task(agentId: number, text: string): boolean {
    return this.providerForAgent(agentId) === CODEX_PROVIDER_ID
      ? this.usesAgentOs(agentId)
        ? this.agentOs!.taskAgent(agentId, text)
        : this.codex?.task(agentId, text) ?? false
      : this.claude.task(agentId, text)
  }

  transcript(agentId: number): any {
    if (this.providerForAgent(agentId) === CODEX_PROVIDER_ID) {
      if (this.usesAgentOs(agentId)) return this.agentOs!.transcriptAgent(agentId)
      return this.codex?.transcript(agentId) ?? { lines: [], working: null }
    }
    const transcript = this.claude.transcript(agentId)
    const row = this.agentRow(agentId)
    return {
      ...transcript,
      info: transcript.info ? {
        ...transcript.info,
        provider: 'claude',
        capabilities: enabledCapabilities(CLAUDE_CAPABILITIES),
        accessProfile: row?.access_profile ?? accessForPermissionMode(transcript.info.permissionMode) ?? 'full_access',
        requestedModel: row?.model ?? null,
        resolvedModel: transcript.info.model,
      } : transcript.info,
    }
  }

  subagents(agentId: number): { key: string; label: string }[] {
    return this.providerForAgent(agentId) === CODEX_PROVIDER_ID
      ? this.usesAgentOs(agentId)
        ? this.agentOs!.subagentsForAgent(agentId)
        : this.codex?.subagents(agentId) ?? []
      : this.claude.subagents(agentId)
  }

  interruptAgent(agentId: number): Promise<boolean> {
    return this.providerForAgent(agentId) === CODEX_PROVIDER_ID
      ? this.usesAgentOs(agentId)
        ? this.agentOs!.interruptManagedAgent(agentId)
        : this.codex?.interruptAgent(agentId) ?? Promise.resolve(false)
      : this.claude.interruptAgent(agentId)
  }

  fire(agentId: number): Promise<boolean> {
    return this.providerForAgent(agentId) === CODEX_PROVIDER_ID
      ? this.usesAgentOs(agentId)
        ? this.agentOs!.fireManagedAgent(agentId)
        : this.codex?.fire(agentId) ?? Promise.resolve(false)
      : this.claude.fire(agentId)
  }

  wake(boardId: number): { woke: string[]; queued: string[]; skipped: string[] } {
    return this.claude.wake?.(boardId) ?? { woke: [], queued: [], skipped: [] }
  }

  async setPermissionMode(agentId: number, mode: string): Promise<boolean> {
    const profile = accessForPermissionMode(mode)
    if (!profile) return false
    return this.setAccessProfile(agentId, profile)
  }

  async setAccessProfile(agentId: number, profile: AccessProfile): Promise<boolean> {
    if (!isAccessProfile(profile)) return false
    if (this.providerForAgent(agentId) === CODEX_PROVIDER_ID) {
      if (this.usesAgentOs(agentId)) return this.agentOs!.setManagedAgentAccess(agentId, profile)
      return this.codex?.setAccessProfile(agentId, profile) ?? false
    }
    const ok = (await this.claude.setPermissionMode?.(agentId, permissionModeForAccess(profile))) ?? false
    if (ok) this.db.prepare('UPDATE agents SET access_profile=? WHERE id=?').run(profile, agentId)
    return ok
  }

  async resolvePermission(agentId: number, requestId: string, behavior: 'allow' | 'deny', message?: string): Promise<boolean> {
    if (this.providerForAgent(agentId) === CODEX_PROVIDER_ID) {
      if (this.usesAgentOs(agentId)) return this.agentOs!.resolveManagedApproval(agentId, requestId, behavior, message)
      return this.codex?.resolvePermission(agentId, requestId, behavior, message) ?? false
    }
    return this.claude.resolvePermission?.(agentId, requestId, behavior, message) ?? false
  }

  async resolveApproval(
    agentId: number,
    requestId: string,
    decision: 'allow' | 'allow_session' | 'deny' | 'cancel',
    message?: string,
    answers?: Record<string, string[]>,
  ): Promise<boolean> {
    if (this.providerForAgent(agentId) === CODEX_PROVIDER_ID)
      return this.usesAgentOs(agentId)
        ? this.agentOs!.resolveManagedApproval(agentId, requestId, decision, message, answers)
        : this.codex?.resolveApproval(agentId, requestId, decision, message, answers) ?? false
    if (decision !== 'allow' && decision !== 'deny') return false
    return this.claude.resolvePermission?.(agentId, requestId, decision, message) ?? false
  }

  setModel(agentId: number, model: string): Promise<boolean> {
    return this.providerForAgent(agentId) === CODEX_PROVIDER_ID
      ? this.usesAgentOs(agentId)
        ? this.agentOs!.setManagedAgentModel(agentId, model)
        : this.codex?.setModel(agentId, model) ?? Promise.resolve(false)
      : this.claude.setModel?.(agentId, model) ?? Promise.resolve(false)
  }

  setEffort(agentId: number, level: string): Promise<'ok' | 'busy' | 'not-found' | 'bad-level' | 'no-session'> {
    return this.providerForAgent(agentId) === CODEX_PROVIDER_ID
      ? this.usesAgentOs(agentId)
        ? this.agentOs!.setManagedAgentEffort(agentId, level)
        : this.codex?.setEffort(agentId, level) ?? Promise.resolve('not-found')
      : this.claude.setEffort?.(agentId, level) ?? Promise.resolve('not-found')
  }

  capabilities(agentId: number): string[] {
    return enabledCapabilities(this.providerForAgent(agentId) === CODEX_PROVIDER_ID ? CODEX_CAPABILITIES : CLAUDE_CAPABILITIES)
  }

  mcpStatus(agentId: number): Promise<unknown | null> {
    if (this.providerForAgent(agentId) !== 'claude') return Promise.resolve(null)
    return this.claude.mcpStatus?.(agentId) ?? Promise.resolve(null)
  }

  toggleMcpServer(agentId: number, name: string, enabled: boolean): Promise<unknown | null> {
    if (this.providerForAgent(agentId) !== 'claude') return Promise.resolve(null)
    return this.claude.toggleMcpServer?.(agentId, name, enabled) ?? Promise.resolve(null)
  }

  reconnectMcpServer(agentId: number, name: string): Promise<unknown | null> {
    if (this.providerForAgent(agentId) !== 'claude') return Promise.resolve(null)
    return this.claude.reconnectMcpServer?.(agentId, name) ?? Promise.resolve(null)
  }

  reloadPlugins(agentId: number): Promise<unknown | null> {
    if (this.providerForAgent(agentId) !== 'claude') return Promise.resolve(null)
    return this.claude.reloadPlugins?.(agentId) ?? Promise.resolve(null)
  }

  async providerCatalog(): Promise<AgentProviderCatalog[]> {
    const claude = await this.claude.providerCatalog?.() ?? []
    const codexRuntimeAvailable = !!this.codex && (this.codexService?.isRuntimeAvailable?.() ?? true)
    let codex: AgentProviderCatalog
    if (this.codexService) {
      try { codex = await this.codexService.catalog() }
      catch (error) {
        const cached = readProviderModelCache(this.db, CODEX_PROVIDER_ID)
        codex = codexProviderCatalog({
          available: codexRuntimeAvailable,
          models: cached?.models ?? [],
          source: cached ? 'cache' : 'unavailable',
          updatedAt: cached?.updated_at ?? null,
          capabilities: CODEX_CAPABILITIES,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      const cached = readProviderModelCache(this.db, CODEX_PROVIDER_ID)
      codex = codexProviderCatalog({
        available: codexRuntimeAvailable,
        models: cached?.models ?? [],
        source: cached ? 'cache' : 'unavailable',
        updatedAt: cached?.updated_at ?? null,
        capabilities: CODEX_CAPABILITIES,
        detail: this.codex ? 'Codex model discovery is still initializing.' : 'Install and authenticate the Codex CLI to enable this provider.',
      })
    }
    return [...claude.map((catalog) => ({ ...catalog, capabilities: catalog.capabilities ?? CLAUDE_CAPABILITIES })), codex]
  }

  adoptLaunch(agentId: number): void {
    if (this.providerForAgent(agentId) === CODEX_PROVIDER_ID) this.codex?.adoptLaunch(agentId)
    else (this.claude as ConductorLike & { adoptLaunch?(id: number): void }).adoptLaunch?.(agentId)
  }

  async shutdown(): Promise<void> {
    const detachClaude = (this.claude as ConductorLike & { detachAll?(): Promise<void> }).detachAll
    await Promise.allSettled([
      detachClaude
        ? detachClaude.call(this.claude)
        : (this.claude as ConductorLike & { shutdown?(): Promise<void> }).shutdown?.() ?? Promise.resolve(),
      this.codex?.shutdown() ?? Promise.resolve(),
    ])
  }

  private resolveHire(options: ProviderHireOptions): ProviderHireOptions & { provider: string; accessProfile: AccessProfile } {
    const stored = options.resumeSession && options.name
      ? this.db.prepare('SELECT provider, access_profile FROM agents WHERE board_id=? AND name=?').get(options.boardId, options.name) as
        { provider: string; access_profile: string | null } | undefined
      : undefined
    const profile = options.resumeSession ? null : defaultsForRole(this.db, options.role)
    const provider = safeProvider(options.provider ?? stored?.provider ?? profile?.provider ?? 'claude')
    const matchingProfile = profile?.provider === provider ? profile : null
    const defaultAccess: AccessProfile = options.role
      ? 'read_only'
      : provider === CODEX_PROVIDER_ID ? 'workspace_write' : 'full_access'
    const storedAccess = isAccessProfile(stored?.access_profile) ? stored.access_profile : undefined
    const accessProfile = options.accessProfile ?? accessForPermissionMode(options.permissionMode) ?? storedAccess ?? defaultAccess
    return {
      ...options,
      provider,
      accessProfile,
      model: options.model ?? matchingProfile?.model ?? undefined,
      effort: options.effort ?? matchingProfile?.effort ?? undefined,
    }
  }

  private resolveLaunch(request: ProviderLaunchRequest): QueuedLaunch {
    const profile = defaultsForRole(this.db)
    const provider = safeProvider(request.provider ?? profile.provider)
    const matchingProfile = profile.provider === provider ? profile : null
    return {
      ...request,
      provider,
      model: request.model ?? matchingProfile?.model ?? undefined,
      effort: request.effort ?? matchingProfile?.effort ?? undefined,
      accessProfile: request.accessProfile ?? (provider === CODEX_PROVIDER_ID ? 'workspace_write' : 'full_access'),
    }
  }

  private startLaunch(request: QueuedLaunch): any {
    if (request.provider === CODEX_PROVIDER_ID) return this.requireCodex().launch(request)
    if (request.provider !== 'claude') throw new ProviderUnavailableError(request.provider, 'no registered agent provider')
    return this.claude.launch({
      ...request,
      permissionMode: permissionModeForAccess(request.accessProfile ?? 'full_access'),
    } as any)
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.launchQueue.length && this.launchedCount() < this.maxLaunched()) {
        const request = this.launchQueue.shift()!
        try { this.startLaunch(request) }
        catch (error) {
          this.cardEvent(request.cardId, null, 'launch_failed', {
            provider: request.provider,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally { this.draining = false }
  }

  private launchedCount(): number {
    return Number((this.db.prepare(`SELECT COUNT(DISTINCT c.id) AS count FROM cards c
      JOIN agents a ON a.id=c.owner_agent_id
      WHERE c.column_name='in_progress' AND a.kind='hired' AND a.status NOT IN ('gone','paused_limit')`)
      .get() as { count: number }).count)
  }

  private maxLaunched(): number {
    const configured = process.env.ORCHESTRA_MAX_LAUNCHED
    if (configured === undefined || configured.trim() === '') return Number.POSITIVE_INFINITY
    const value = Number(configured)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : Number.POSITIVE_INFINITY
  }

  private assertProviderAvailable(provider: string): void {
    if (provider === 'claude') return
    if (provider === CODEX_PROVIDER_ID && this.codex && this.codexService?.isRuntimeAvailable?.() !== false) return
    throw new ProviderUnavailableError(provider, 'no registered agent provider')
  }

  private requireCodex(): CodexManagedAgentRuntime {
    if (!this.codex) throw new ProviderUnavailableError(CODEX_PROVIDER_ID, 'Codex CLI or app-server is not ready')
    if (this.codexService?.isRuntimeAvailable?.() === false)
      throw new ProviderUnavailableError(CODEX_PROVIDER_ID, 'Codex app-server is reconnecting or no longer authenticated')
    return this.codex
  }

  private providerForAgent(agentId: number): string {
    return safeProvider(this.agentRow(agentId)?.provider ?? 'claude')
  }

  private usesAgentOs(agentId: number): boolean {
    return this.agentOs?.ownsAgent(agentId) ?? false
  }

  private agentRow(agentId: number): any {
    return this.db.prepare('SELECT * FROM agents WHERE id=?').get(agentId)
  }

  private cardEvent(cardId: number, agentId: number | null, type: string, payload: unknown): void {
    this.db.prepare('INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, ?, ?)')
      .run(cardId, agentId, type, JSON.stringify(payload))
  }
}

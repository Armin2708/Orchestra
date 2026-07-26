import { isAbsolute, resolve } from 'node:path'
import { BoundedAsyncQueue, deferred, type Deferred } from '../../codex/async.js'
import {
  CODEX_REQUEST_UNHANDLED,
  CodexRpcResponseError,
  type CodexServerRequestHandlerResult,
} from '../../codex/client.js'
import {
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type CodexServerNotification,
  type CodexServerRequest,
  type CodexThread,
  type CodexThreadForkParams,
  type CodexThreadForkResponse,
  type CodexThreadItem,
  type CodexThreadStartParams,
  type CodexThreadTokenUsage,
  type CodexTurn,
  type CodexTurnStartParams,
  isRecord,
} from '../../codex/protocol.js'
import type { CodexRuntimeService } from '../../codex/service.js'
import type { CodexUnsubscribe } from '../../codex/transport.js'
import type {
  AgentDriver,
  DriverCapabilities,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
  DriverSessionStatus,
  MaybePromise,
  OsId,
} from '../types.js'

export type CodexLaunchPolicy = {
  sandbox?: CodexSandboxMode
  approvalPolicy?: CodexApprovalPolicy
}

export type CodexDriverApprovalKind = 'command' | 'file-change' | 'permissions' | 'user-input' | 'mcp-elicitation'

export type CodexDriverApprovalRequest = {
  kind: CodexDriverApprovalKind
  sessionId: string
  threadId: string
  turnId: string | null
  itemId: string | null
  requestId: string | number
  method: string
  params: unknown
}

export type CodexDriverApprovalHandler = (
  request: CodexDriverApprovalRequest,
) => MaybePromise<unknown>

export type CodexNativeEvent = {
  agentHomeSessionId: string
  agentProfileId: string
  agentConversationId: string
  captureCursor: string
  threadId: string
  turnId: string | null
  itemId: string | null
  method: string
  params: unknown
  receivedAt: string
}

export type CodexNativeEventSink = {
  /** Must return synchronously so persistence completes before driver projection. */
  append(event: CodexNativeEvent): undefined
}

export type CodexAgentHomeBinding = {
  agentHomeSessionId: string
  agentProfileId: string
  agentConversationId: string
  workspaceId?: OsId
  providerCursor?: string | null
  captureCursor?: string | null
}

export type CodexAgentHomeBindContext = {
  mode: 'launch' | 'attach'
  boardId?: number
  workspaceId?: OsId
  metadata: Record<string, unknown>
  expectedBinding?: CodexAgentHomeBinding
}

export type CodexAgentDriverOptions = {
  service: CodexRuntimeService
  workspaceForThread?: (threadId: string, thread: CodexThread) => MaybePromise<OsId | undefined>
  tokenBudgetForThread?: (threadId: string) => MaybePromise<number | null | undefined>
  agentHomeForThread?: (
    threadId: string,
    thread: CodexThread,
    context: CodexAgentHomeBindContext,
  ) => MaybePromise<CodexAgentHomeBinding | undefined>
  resolveLaunchPolicy?: (request: DriverLaunchRequest) => MaybePromise<CodexLaunchPolicy>
  onApprovalRequest?: CodexDriverApprovalHandler
  nativeEventSink?: CodexNativeEventSink
  isMissingThreadError?: (error: unknown) => boolean
  approvalTimeoutMs?: number
  eventBufferSize?: number
  now?: () => Date
}

export type CodexAccessProfile = 'read_only' | 'workspace_write' | 'full_access'

export type CodexSessionUpdate = {
  model?: string
  effort?: string
  accessProfile?: CodexAccessProfile
}

export type CodexApprovalDecision = 'allow' | 'allow_session' | 'deny' | 'cancel'
export type CodexApprovalAnswers = Record<string, string[]>
type CodexApprovalAuditDecision = CodexApprovalDecision | 'unhandled'
type CodexApprovalOutcomeSource = 'automatic' | 'operator' | 'timeout' | 'shutdown'

export type CodexSessionReconcileResult = {
  resumed: string[]
  failed: string[]
}

export type CodexSessionForkOptions = {
  sourceExternalId: string
  sourceWorkspaceId: OsId
  sourceCwd: string
  targetWorkspaceId: OsId
  targetCwd: string
} & Pick<CodexThreadForkParams, 'lastTurnId'>

export type CodexTargetWorkspaceAttestation = {
  value: OsId
  authority: 'orchestrator'
}

export type CodexForkCreationProofMetadata = {
  forkMethod: 'thread/fork'
  verificationMethod: 'thread/fork+thread/read'
  forkedFromId: string
  sourceProviderSessionId: string
  providerSessionId: string
  lastTurnId: string | null
  sourceWorkspaceId: OsId
  sourceCwd: string
  targetWorkspaceId: OsId
  targetWorkspaceAttestation: CodexTargetWorkspaceAttestation
  targetCwd: string
  childCwd: string
  cwdVerified: true
  workspaceBindingVerified: true
  workspaceBindingAuthority: 'orchestrator'
  readVerified: true
  threadReadVerified: true
  subscriptionReleased: true
  childUnsubscribeVerified: true
  subscriptionStatus: 'notLoaded' | 'notSubscribed' | 'unsubscribed'
  [key: string]: unknown
}

export type CodexSessionForkResult = {
  sourceExternalId: string
  externalId: string
  providerThreadId: string
  sourceProviderThreadId: string
  metadata: CodexForkCreationProofMetadata
}

export type CodexSessionForkVerificationContext = {
  sourceExternalId: string
  sourceProviderThreadId?: string
  targetWorkspaceId: OsId
  targetCwd: string
  sourceWorkspaceId?: OsId
  sourceCwd?: string
  childProviderThreadId?: string
  childProviderSessionId?: string | null
  lastTurnId?: string | null
}

export type CodexSessionForkVerificationOptions =
  CodexSessionForkVerificationContext & {
    childExternalId: string
  }

export type CodexForkVerificationProof = {
  status: 'verified'
  sourceExternalId: string
  sourceProviderThreadId: string
  childExternalId: string
  childProviderThreadId: string
  childProviderSessionId: string
  targetCwd: string
  targetWorkspaceAttestation: CodexTargetWorkspaceAttestation
  read: {
    method: 'thread/read'
    includeTurns: false
    verified: true
  }
}

export type CodexForkReadProofMetadata = {
  forkMethod: 'thread/fork'
  verificationMethod: 'thread/read'
  forkedFromId: string
  providerSessionId: string
  lastTurnId: string | null
  sourceWorkspaceId?: OsId
  sourceCwd?: string
  targetWorkspaceId: OsId
  targetWorkspaceAttestation: CodexTargetWorkspaceAttestation
  targetCwd: string
  childCwd: string
  cwdVerified: true
  workspaceBindingVerified: true
  workspaceBindingAuthority: 'orchestrator'
  readVerified: true
  threadReadVerified: true
  [key: string]: unknown
}

export type CodexSessionForkVerificationResult = {
  sourceExternalId: string
  externalId: string
  providerThreadId: string
  sourceProviderThreadId: string
  proof: CodexForkVerificationProof
  metadata: CodexForkReadProofMetadata
}

export type CodexForkKnownChild = {
  externalId: string
  providerThreadId: string
  forkedFromId: string | null
  childProviderSessionId: string | null
  subscriptionReleased: boolean
}

export class CodexForkOutcomeUnknownError extends Error {
  readonly outcomeUnknown = true

  constructor(
    message: string,
    readonly sourceExternalId: string,
    readonly sourceProviderThreadId: string,
    readonly knownChild: CodexForkKnownChild | null,
  ) {
    super(message)
    this.name = 'CodexForkOutcomeUnknownError'
  }
}

export type CodexForkVerificationFailureCode =
  | 'invalid_request'
  | 'read_failed'
  | 'malformed_read'
  | 'child_identity_mismatch'
  | 'lineage_mismatch'
  | 'provider_session_mismatch'
  | 'cwd_mismatch'

export type CodexForkVerificationKnownChild = Omit<
  CodexForkKnownChild,
  'subscriptionReleased'
>

export class CodexForkVerificationError extends Error {
  readonly quarantined = true

  constructor(
    readonly code: CodexForkVerificationFailureCode,
    readonly sourceExternalId: string,
    readonly sourceProviderThreadId: string,
    readonly knownChild: CodexForkVerificationKnownChild | null,
  ) {
    super(`Codex fork verification quarantined: ${code}`)
    this.name = 'CodexForkVerificationError'
  }
}

type PendingApproval = {
  kind: CodexDriverApprovalKind
  params: Record<string, unknown>
  deferred: Deferred<unknown>
  timer: ReturnType<typeof setTimeout> | null
}

type CodexSessionState = {
  session: DriverSession
  threadId: string
  activeTurnId: string | null
  queue: BoundedAsyncQueue<DriverEvent>
  seq: number
  stopped: boolean
  agentMessageDeltaItems: Set<string>
  latestUsage: CodexThreadTokenUsage | null
  droppedEvents: number
  pendingTurnOverrides: Omit<CodexTurnStartParams, 'threadId' | 'input'>
  pendingApprovals: Map<string, PendingApproval>
  completedApprovals: Map<string, unknown>
  tokenBudget: number | null
  tokenBudgetInterrupted: boolean
  nativeEventSeq: number
}

const APPROVAL_METHODS: Record<string, CodexDriverApprovalKind> = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'file-change',
  'item/permissions/requestApproval': 'permissions',
  'item/tool/requestUserInput': 'user-input',
  'mcpServer/elicitation/request': 'mcp-elicitation',
}

const COMPLETED_APPROVAL_CACHE_SIZE = 256
const CODEX_UNSUBSCRIBE_RELEASE_STATUSES = new Set([
  'notLoaded',
  'notSubscribed',
  'unsubscribed',
] as const)
type CodexUnsubscribeReleaseStatus =
  'notLoaded'
  | 'notSubscribed'
  | 'unsubscribed'

function normalizedAbsoluteCwd(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && isAbsolute(trimmed) ? resolve(trimmed) : null
}

function sameCwd(value: unknown, expected: string): boolean {
  return normalizedAbsoluteCwd(value) === expected
}

function unsubscribeReleaseStatus(value: unknown): CodexUnsubscribeReleaseStatus | null {
  if (typeof value !== 'string') return null
  return CODEX_UNSUBSCRIBE_RELEASE_STATUSES.has(
    value as CodexUnsubscribeReleaseStatus,
  )
    ? value as CodexUnsubscribeReleaseStatus
    : null
}

export class CodexAgentDriver implements AgentDriver {
  readonly id = 'codex'
  private readonly sessions = new Map<string, CodexSessionState>()
  private readonly sessionsByThread = new Map<string, CodexSessionState>()
  private readonly subscriptions: CodexUnsubscribe[]
  private readonly now: () => Date
  private readonly eventBufferSize: number
  private readonly approvalTimeoutMs: number
  private reconcilePromise: Promise<CodexSessionReconcileResult> | null = null

  constructor(private readonly options: CodexAgentDriverOptions) {
    this.now = options.now ?? (() => new Date())
    this.eventBufferSize = Math.max(16, options.eventBufferSize ?? 4_096)
    this.approvalTimeoutMs = Math.max(1_000, options.approvalTimeoutMs ?? 10 * 60_000)
    this.subscriptions = [
      options.service.onNotification((notification) => this.acceptNotification(notification)),
      options.service.onServerRequest((request) => this.acceptServerRequest(request)),
    ]
    if (options.service.onLifecycle) {
      this.subscriptions.push(options.service.onLifecycle((event) => {
        if (event.type === 'connected' && this.sessionsByThread.size > 0) {
          void this.reconcileSessions().catch(() => {})
        } else if (event.type === 'restart_exhausted') {
          for (const state of this.sessionsByThread.values()) {
            if (state.stopped) continue
            const detail = event.error || 'Codex app-server restart attempts were exhausted'
            state.session.status = 'lost'
            this.emitEvent(state, 'error', detail, {
              method: 'orchestra/restartExhausted',
              params: { threadId: state.threadId },
              receivedAt: event.at,
            }, { reconnected: false, restartExhausted: true })
            this.stopState(state, 'Codex session lost after app-server restart exhaustion', {
              lost: true,
              reconnectFailed: true,
              restartExhausted: true,
              error: detail,
            })
          }
        }
      }))
    }
  }

  capabilities(): DriverCapabilities & { tokenBudget: true; costBudget: false } {
    return {
      attach: true,
      streaming: true,
      interrupt: true,
      stop: true,
      rawTerminal: false,
      resume: true,
      tokenBudget: true,
      costBudget: false,
    }
  }

  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    const accessProfile = (request as DriverLaunchRequest & { accessProfile?: CodexAccessProfile }).accessProfile
    const policy = this.options.resolveLaunchPolicy
      ? await this.options.resolveLaunchPolicy(request)
      : accessProfile ? this.launchPolicy(accessProfile) : this.defaultPolicy(request.permissionMode)
    const metadata = request.metadata ?? {}
    const threadParams: CodexThreadStartParams = {
      cwd: request.cwd,
      ...(request.model ? { model: request.model } : {}),
      ...(policy.sandbox ? { sandbox: policy.sandbox } : {}),
      ...(policy.approvalPolicy ? { approvalPolicy: policy.approvalPolicy } : {}),
      ...(typeof metadata.modelProvider === 'string' ? { modelProvider: metadata.modelProvider } : {}),
      ...(typeof metadata.serviceTier === 'string' ? { serviceTier: metadata.serviceTier } : {}),
      ...(typeof metadata.developerInstructions === 'string'
        ? { developerInstructions: metadata.developerInstructions }
        : {}),
      ...(typeof metadata.ephemeral === 'boolean' ? { ephemeral: metadata.ephemeral } : {}),
    }
    const started = await this.options.service.startThread(threadParams)
    let agentHome: CodexAgentHomeBinding | undefined
    try {
      agentHome = await this.resolveAgentHomeBinding(started.thread, {
        mode: 'launch',
        boardId: request.boardId,
        workspaceId: request.workspaceId,
        metadata,
      })
    } catch (error) {
      await this.options.service.unsubscribeThread(started.thread.id).catch(() => {})
      throw error
    }
    const state = this.createState(started.thread, request.workspaceId, started, request.taskBudgetTokens)
    Object.assign(state.session.metadata, {
      ...(request.model ? { model: request.model } : {}),
      ...(typeof metadata.effort === 'string' ? { effort: metadata.effort } : {}),
      ...(accessProfile ? { accessProfile } : {}),
      ...(request.externalId ? { replacesExternalId: request.externalId } : {}),
    })
    if (agentHome) this.applyAgentHomeBinding(state, agentHome)
    this.registerState(state)
    if (request.prompt?.length) {
      try {
        const turn = await this.options.service.startTurn(started.thread.id, request.prompt, {
          ...(typeof metadata.effort === 'string' ? { effort: metadata.effort } : {}),
          ...(typeof metadata.serviceTier === 'string' ? { serviceTier: metadata.serviceTier } : {}),
        })
        if (typeof metadata.effort === 'string') state.session.metadata.resolvedEffort = metadata.effort
        this.setActiveTurn(state, turn.turn.id)
      } catch (error) {
        await this.options.service.unsubscribeThread(started.thread.id).catch(() => {})
        this.failState(state, error)
        throw error
      }
    } else {
      state.session.status = 'idle'
    }
    return state.session
  }

  async attach(externalId: string): Promise<DriverSession | null> {
    const existing = this.sessionsByThread.get(externalId)
    if (existing && !existing.stopped)
      throw new Error(`Codex thread ${externalId} is already attached by this daemon`)
    let resumed
    try {
      resumed = await this.options.service.resumeThread(externalId)
    } catch (error) {
      if (this.isMissingThread(error)) return null
      throw error
    }
    const read = await this.options.service.readThread(externalId, true).catch(async (error) => {
      await this.options.service.unsubscribeThread(externalId).catch(() => {})
      throw error
    })
    const thread = read.thread ?? resumed.thread
    if (thread.id !== externalId) {
      await this.options.service.unsubscribeThread(thread.id).catch(() => {})
      throw new Error(`Codex resume returned thread ${thread.id} for requested thread ${externalId}`)
    }
    let agentHome: CodexAgentHomeBinding | undefined
    try {
      agentHome = await this.resolveAgentHomeBinding(thread, {
        mode: 'attach',
        metadata: {},
      })
    } catch (error) {
      await this.options.service.unsubscribeThread(thread.id).catch(() => {})
      throw error
    }
    let resolvedWorkspaceId: OsId | undefined
    try {
      resolvedWorkspaceId = await this.options.workspaceForThread?.(externalId, thread)
    } catch (error) {
      await this.options.service.unsubscribeThread(thread.id).catch(() => {})
      throw error
    }
    if (agentHome?.workspaceId && resolvedWorkspaceId
      && agentHome.workspaceId !== resolvedWorkspaceId) {
      await this.options.service.unsubscribeThread(thread.id).catch(() => {})
      throw new Error(`Codex thread ${externalId} has conflicting durable workspace identities`)
    }
    const workspaceId = agentHome?.workspaceId ?? resolvedWorkspaceId
    if (!workspaceId) {
      await this.options.service.unsubscribeThread(thread.id).catch(() => {})
      throw new Error(`workspace for Codex thread ${externalId} is unknown`)
    }
    let tokenBudget: number | null | undefined
    try {
      tokenBudget = await this.options.tokenBudgetForThread?.(externalId)
    } catch (error) {
      await this.options.service.unsubscribeThread(thread.id).catch(() => {})
      throw error
    }
    const state = this.createState(thread, workspaceId, resumed, tokenBudget)
    if (agentHome) this.applyAgentHomeBinding(state, agentHome)
    const activeTurn = [...thread.turns].reverse().find((turn) => turn.status === 'inProgress')
    if (activeTurn) this.setActiveTurn(state, activeTurn.id)
    const attachedAt = this.now().toISOString()
    const captureGap = {
      method: 'orchestra/captureGap',
      params: {
        threadId: state.threadId,
        turnId: activeTurn?.id ?? null,
        reason: 'daemon-attach',
        requestedThreadId: externalId,
      },
      receivedAt: attachedAt,
    }
    if (!this.captureNativeEvent(state, captureGap, state.threadId)) {
      await this.options.service.unsubscribeThread(thread.id).catch(() => {})
      throw new Error(`Codex thread ${externalId} could not persist its daemon-attach capture boundary`)
    }
    state.session.metadata.nativeCaptureResume = {
      reason: 'daemon-attach',
      at: attachedAt,
      priorProviderCursor: agentHome?.providerCursor ?? null,
      priorCaptureCursor: agentHome?.captureCursor ?? null,
    }
    this.registerState(state)
    if (!activeTurn) this.replayTerminalTurn(state, thread, 'daemon-attach')
    return state.session
  }

  async forkSession(
    sessionId: string,
    options: CodexSessionForkOptions,
  ): Promise<CodexSessionForkResult> {
    const source = this.required(sessionId)
    if (source.stopped) throw new Error(`Codex session is stopped: ${sessionId}`)
    if (source.session.externalId !== source.threadId) {
      throw new Error(`Codex session ${sessionId} has inconsistent provider thread provenance`)
    }
    if (options.sourceExternalId !== source.session.externalId) {
      throw new Error(`Codex fork source external id does not match session ${sessionId}`)
    }
    if (!options.sourceWorkspaceId.trim()
      || options.sourceWorkspaceId !== source.session.workspaceId) {
      throw new Error(`Codex fork source workspace does not match session ${sessionId}`)
    }
    const sourceProviderSessionId = typeof source.session.metadata.codexSessionId === 'string'
      ? source.session.metadata.codexSessionId.trim()
      : ''
    if (!sourceProviderSessionId) {
      throw new Error(`Codex session ${sessionId} has no provider session identity`)
    }
    const sourceCwd = normalizedAbsoluteCwd(source.session.metadata.cwd)
    if (!sourceCwd) throw new Error(`Codex session ${sessionId} has no source cwd provenance`)
    const requestedSourceCwd = normalizedAbsoluteCwd(options.sourceCwd)
    if (!requestedSourceCwd || requestedSourceCwd !== sourceCwd) {
      throw new Error(`Codex fork source cwd does not match session ${sessionId}`)
    }
    const targetWorkspaceId = options.targetWorkspaceId.trim()
    if (!targetWorkspaceId || targetWorkspaceId === source.session.workspaceId) {
      throw new Error(`Codex fork target workspace must be distinct from session ${sessionId}`)
    }
    const targetCwd = normalizedAbsoluteCwd(options.targetCwd)
    if (!targetCwd || targetCwd === sourceCwd) {
      throw new Error(`Codex fork target cwd must be distinct from session ${sessionId}`)
    }
    const lastTurnId = options.lastTurnId == null ? null : options.lastTurnId.trim()
    if (options.lastTurnId != null && !lastTurnId) {
      throw new Error('Codex fork last turn id is required when provided')
    }

    let forked: CodexThreadForkResponse
    try {
      const response = await this.options.service.forkThread(source.threadId, {
        ...(lastTurnId ? { lastTurnId } : {}),
        cwd: targetCwd,
      })
      if (!response
        || typeof response !== 'object'
        || !('thread' in response)
        || !response.thread
        || typeof response.thread !== 'object') {
        throw new Error('Codex fork returned a malformed response')
      }
      forked = response
    } catch {
      throw new CodexForkOutcomeUnknownError(
        `Codex fork outcome is unknown for source thread ${source.threadId}`,
        source.session.externalId,
        source.threadId,
        null,
      )
    }
    const child = forked.thread
    const childId = typeof child?.id === 'string' ? child.id.trim() : ''
    const childProviderSessionId = typeof child?.sessionId === 'string' ? child.sessionId.trim() : ''
    const childForkedFromId = typeof child?.forkedFromId === 'string'
      ? child.forkedFromId.trim()
      : null
    const releaseKnownChild = async (): Promise<CodexForkKnownChild | null> => {
      if (!childId
        || childId === source.threadId
        || this.sessionsByThread.has(childId)) {
        return null
      }
      let releaseStatus: CodexUnsubscribeReleaseStatus | null = null
      try {
        releaseStatus = unsubscribeReleaseStatus(
          (await this.options.service.unsubscribeThread(childId)).status,
        )
      } catch {
        // This diagnostic is safe to retain without exposing the transport error.
      }
      return {
        externalId: childId,
        providerThreadId: childId,
        forkedFromId: childForkedFromId,
        childProviderSessionId: childProviderSessionId || null,
        subscriptionReleased: releaseStatus !== null,
      }
    }
    let provenanceError: Error | null = null
    if (!childId) {
      provenanceError = new Error(`Codex fork from ${source.threadId} returned no child thread id`)
    } else if (childId === source.threadId) {
      provenanceError = new Error(`Codex fork reused source thread id ${source.threadId}`)
    } else if (this.sessionsByThread.has(childId)) {
      provenanceError = new Error(`Codex fork reused managed thread id ${childId}`)
    } else if (childForkedFromId !== source.threadId) {
      provenanceError = new Error(
        `Codex fork ${childId} did not attest source thread ${source.threadId}`,
      )
    } else if (!childProviderSessionId) {
      provenanceError = new Error(
        `Codex fork ${childId} returned no child provider session identity`,
      )
    } else if (!sameCwd(child.cwd, targetCwd) || !sameCwd(forked.cwd, targetCwd)) {
      provenanceError = new Error(
        `Codex fork ${childId} did not preserve workspace cwd provenance`,
      )
    }
    if (provenanceError) {
      throw new CodexForkOutcomeUnknownError(
        provenanceError.message,
        source.session.externalId,
        source.threadId,
        await releaseKnownChild(),
      )
    }

    let reread: CodexThread
    try {
      const response = await this.options.service.readThread(childId, false)
      if (!response
        || typeof response !== 'object'
        || !('thread' in response)
        || !response.thread
        || typeof response.thread !== 'object') {
        throw new Error('Codex fork reread returned a malformed response')
      }
      reread = response.thread
    } catch {
      throw new CodexForkOutcomeUnknownError(
        `Codex fork ${childId} could not complete mandatory native lineage reread verification`,
        source.session.externalId,
        source.threadId,
        await releaseKnownChild(),
      )
    }
    const rereadId = typeof reread.id === 'string' ? reread.id.trim() : ''
    const rereadForkedFromId = typeof reread.forkedFromId === 'string'
      ? reread.forkedFromId.trim()
      : null
    const rereadSessionId = typeof reread.sessionId === 'string' ? reread.sessionId.trim() : ''
    if (rereadId !== childId
      || rereadForkedFromId !== source.threadId
      || rereadSessionId !== childProviderSessionId
      || !sameCwd(reread.cwd, targetCwd)) {
      throw new CodexForkOutcomeUnknownError(
        `Codex fork ${childId} failed native lineage reread verification`,
        source.session.externalId,
        source.threadId,
        await releaseKnownChild(),
      )
    }
    if (this.sessionsByThread.has(childId)) {
      throw new CodexForkOutcomeUnknownError(
        `Codex fork child ${childId} became managed before subscription release`,
        source.session.externalId,
        source.threadId,
        null,
      )
    }

    let subscriptionStatus: CodexUnsubscribeReleaseStatus | null = null
    try {
      const unsubscribed = await this.options.service.unsubscribeThread(childId)
      subscriptionStatus = unsubscribeReleaseStatus(unsubscribed.status)
    } catch {
      // The outcome is quarantined below without exposing transport details.
    }
    if (!subscriptionStatus) {
      throw new CodexForkOutcomeUnknownError(
        `Codex fork ${childId} could not prove child subscription release`,
        source.session.externalId,
        source.threadId,
        {
          externalId: childId,
          providerThreadId: childId,
          forkedFromId: childForkedFromId,
          childProviderSessionId,
          subscriptionReleased: false,
        },
      )
    }

    return {
      sourceExternalId: source.session.externalId,
      externalId: childId,
      providerThreadId: childId,
      sourceProviderThreadId: source.threadId,
      metadata: {
        forkMethod: 'thread/fork',
        verificationMethod: 'thread/fork+thread/read',
        forkedFromId: source.threadId,
        sourceProviderSessionId,
        providerSessionId: childProviderSessionId,
        lastTurnId,
        sourceWorkspaceId: source.session.workspaceId,
        sourceCwd,
        targetWorkspaceId,
        targetWorkspaceAttestation: {
          value: targetWorkspaceId,
          authority: 'orchestrator',
        },
        targetCwd,
        childCwd: targetCwd,
        cwdVerified: true,
        workspaceBindingVerified: true,
        workspaceBindingAuthority: 'orchestrator',
        readVerified: true,
        threadReadVerified: true,
        subscriptionReleased: true,
        childUnsubscribeVerified: true,
        subscriptionStatus,
      },
    }
  }

  verifyForkSession(
    options: CodexSessionForkVerificationOptions,
  ): Promise<CodexSessionForkVerificationResult>
  verifyForkSession(
    childExternalId: string,
    options: CodexSessionForkVerificationContext,
  ): Promise<CodexSessionForkVerificationResult>
  async verifyForkSession(
    childExternalIdOrOptions: string | CodexSessionForkVerificationOptions,
    context?: CodexSessionForkVerificationContext,
  ): Promise<CodexSessionForkVerificationResult> {
    const options = typeof childExternalIdOrOptions === 'string'
      ? { ...context, childExternalId: childExternalIdOrOptions }
      : childExternalIdOrOptions
    const sourceExternalId = typeof options?.sourceExternalId === 'string'
      ? options.sourceExternalId.trim()
      : ''
    const explicitSourceProviderThreadId =
      typeof options?.sourceProviderThreadId === 'string'
        ? options.sourceProviderThreadId.trim()
        : ''
    const sourceProviderThreadId = options?.sourceProviderThreadId === undefined
      ? sourceExternalId
      : explicitSourceProviderThreadId
    const childExternalId = typeof options?.childExternalId === 'string'
      ? options.childExternalId.trim()
      : ''
    const childProviderThreadId = typeof options?.childProviderThreadId === 'string'
      ? options.childProviderThreadId.trim()
      : childExternalId
    const expectedChildProviderSessionId =
      typeof options?.childProviderSessionId === 'string'
        ? options.childProviderSessionId.trim()
        : null
    const sourceWorkspaceId = typeof options?.sourceWorkspaceId === 'string'
      ? options.sourceWorkspaceId.trim()
      : undefined
    const sourceCwd = options?.sourceCwd === undefined
      ? undefined
      : normalizedAbsoluteCwd(options.sourceCwd)
    const targetWorkspaceId = typeof options?.targetWorkspaceId === 'string'
      ? options.targetWorkspaceId.trim()
      : ''
    const targetCwd = normalizedAbsoluteCwd(options?.targetCwd)
    const lastTurnId = options?.lastTurnId == null ? null : options.lastTurnId.trim()
    const invalidRequest = !sourceExternalId
      || !sourceProviderThreadId
      || sourceExternalId !== sourceProviderThreadId
      || (options?.sourceProviderThreadId !== undefined
        && !explicitSourceProviderThreadId)
      || !childExternalId
      || childExternalId === sourceExternalId
      || !childProviderThreadId
      || childProviderThreadId !== childExternalId
      || (options?.childProviderSessionId != null && !expectedChildProviderSessionId)
      || !targetWorkspaceId
      || !targetCwd
      || (options?.sourceWorkspaceId !== undefined
        && (!sourceWorkspaceId || sourceWorkspaceId === targetWorkspaceId))
      || (options?.sourceCwd !== undefined
        && (!sourceCwd || sourceCwd === targetCwd))
      || (options?.lastTurnId != null && !lastTurnId)
    if (invalidRequest) {
      throw new CodexForkVerificationError(
        'invalid_request',
        sourceExternalId,
        sourceProviderThreadId,
        null,
      )
    }

    const unresolvedKnownChild: CodexForkVerificationKnownChild = {
      externalId: childExternalId,
      providerThreadId: childProviderThreadId,
      forkedFromId: null,
      childProviderSessionId: null,
    }
    let reread: CodexThread
    try {
      const response = await this.options.service.readThread(childExternalId, false)
      if (!response
        || typeof response !== 'object'
        || !('thread' in response)
        || !response.thread
        || typeof response.thread !== 'object') {
        throw new CodexForkVerificationError(
          'malformed_read',
          sourceExternalId,
          sourceProviderThreadId,
          unresolvedKnownChild,
        )
      }
      reread = response.thread
    } catch (error) {
      if (error instanceof CodexForkVerificationError) throw error
      throw new CodexForkVerificationError(
        'read_failed',
        sourceExternalId,
        sourceProviderThreadId,
        unresolvedKnownChild,
      )
    }

    const rereadId = typeof reread.id === 'string' ? reread.id.trim() : ''
    const rereadForkedFromId = typeof reread.forkedFromId === 'string'
      ? reread.forkedFromId.trim()
      : null
    const rereadProviderSessionId = typeof reread.sessionId === 'string'
      ? reread.sessionId.trim()
      : ''
    const knownChild: CodexForkVerificationKnownChild = {
      externalId: rereadId || childExternalId,
      providerThreadId: rereadId || childProviderThreadId,
      forkedFromId: rereadForkedFromId,
      childProviderSessionId: rereadProviderSessionId || null,
    }
    const fail = (code: CodexForkVerificationFailureCode): never => {
      throw new CodexForkVerificationError(
        code,
        sourceExternalId,
        sourceProviderThreadId,
        knownChild,
      )
    }
    if (rereadId !== childExternalId) fail('child_identity_mismatch')
    if (rereadForkedFromId !== sourceProviderThreadId) fail('lineage_mismatch')
    if (!rereadProviderSessionId
      || (expectedChildProviderSessionId !== null
        && rereadProviderSessionId !== expectedChildProviderSessionId)) {
      fail('provider_session_mismatch')
    }
    if (!sameCwd(reread.cwd, targetCwd)) fail('cwd_mismatch')

    const targetWorkspaceAttestation: CodexTargetWorkspaceAttestation = {
      value: targetWorkspaceId,
      authority: 'orchestrator',
    }
    return {
      sourceExternalId,
      externalId: childExternalId,
      providerThreadId: childProviderThreadId,
      sourceProviderThreadId,
      proof: {
        status: 'verified',
        sourceExternalId,
        sourceProviderThreadId,
        childExternalId,
        childProviderThreadId,
        childProviderSessionId: rereadProviderSessionId,
        targetCwd,
        targetWorkspaceAttestation,
        read: {
          method: 'thread/read',
          includeTurns: false,
          verified: true,
        },
      },
      metadata: {
        forkMethod: 'thread/fork',
        verificationMethod: 'thread/read',
        forkedFromId: sourceProviderThreadId,
        providerSessionId: rereadProviderSessionId,
        lastTurnId,
        ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}),
        ...(sourceCwd ? { sourceCwd } : {}),
        targetWorkspaceId,
        targetWorkspaceAttestation,
        targetCwd,
        childCwd: targetCwd,
        cwdVerified: true,
        workspaceBindingVerified: true,
        workspaceBindingAuthority: 'orchestrator',
        readVerified: true,
        threadReadVerified: true,
      },
    }
  }

  async send(sessionId: string, text: string): Promise<void> {
    if (text.length === 0) throw new Error('Codex message cannot be empty')
    const state = this.required(sessionId)
    if (state.stopped) throw new Error(`Codex session is stopped: ${sessionId}`)
    if (state.tokenBudgetInterrupted) throw new Error(`Codex token budget is exhausted: ${sessionId}`)
    if (state.activeTurnId) {
      await this.options.service.steerTurn(state.threadId, state.activeTurnId, text)
      return
    }
    const overrides = state.pendingTurnOverrides
    state.pendingTurnOverrides = {}
    let started
    try {
      started = await this.options.service.startTurn(state.threadId, text, overrides)
    } catch (error) {
      state.pendingTurnOverrides = { ...overrides, ...state.pendingTurnOverrides }
      throw error
    }
    if (typeof overrides.model === 'string') state.session.metadata.resolvedModel = overrides.model
    if (typeof overrides.effort === 'string') state.session.metadata.resolvedEffort = overrides.effort
    this.setActiveTurn(state, started.turn.id)
  }

  async interrupt(sessionId: string): Promise<void> {
    const state = this.required(sessionId)
    if (!state.activeTurnId) throw new Error(`Codex session has no active turn: ${sessionId}`)
    await this.options.service.interruptTurn(state.threadId, state.activeTurnId)
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.required(sessionId)
    if (state.stopped) return
    let failure: unknown
    if (state.activeTurnId) {
      try { await this.options.service.interruptTurn(state.threadId, state.activeTurnId) }
      catch (error) { failure = error }
    }
    let unsubscribeStatus: string | null = null
    try {
      unsubscribeStatus = (await this.options.service.unsubscribeThread(state.threadId)).status
    } catch (error) {
      failure ??= error
    }
    this.stopState(state, 'Codex session stopped', {
      unsubscribeStatus,
      ...(failure ? { stopError: failure instanceof Error ? failure.message : String(failure) } : {}),
    })
    if (failure) throw failure
  }

  async detach(sessionId: string): Promise<void> {
    const state = this.required(sessionId)
    if (state.stopped) return
    let failure: unknown
    let unsubscribeStatus: string | null = null
    try {
      unsubscribeStatus = (await this.options.service.unsubscribeThread(state.threadId)).status
    } catch (error) {
      failure = error
    }
    this.stopState(state, 'Codex session detached', {
      detached: true,
      unsubscribeStatus,
      ...(failure ? { detachError: failure instanceof Error ? failure.message : String(failure) } : {}),
    })
    if (failure) throw failure
  }

  async detachAll(): Promise<void> {
    await Promise.all([...this.sessions.values()]
      .filter((state) => !state.stopped)
      .map((state) => this.detach(state.session.id)))
  }

  async updateSession(sessionId: string, patch: CodexSessionUpdate): Promise<void> {
    const state = this.required(sessionId)
    if (state.stopped) throw new Error(`Codex session is stopped: ${sessionId}`)
    const overrides: Omit<CodexTurnStartParams, 'threadId' | 'input'> = {}
    if (patch.model !== undefined) {
      const model = patch.model.trim()
      if (!model) throw new Error('Codex model is required')
      overrides.model = model
      state.session.metadata.model = model
    }
    if (patch.effort !== undefined) {
      const effort = patch.effort.trim()
      if (!effort) throw new Error('Codex reasoning effort is required')
      overrides.effort = effort
      state.session.metadata.effort = effort
    }
    if (patch.accessProfile !== undefined) {
      Object.assign(overrides, this.turnPolicy(patch.accessProfile, state.session.metadata.cwd))
      state.session.metadata.accessProfile = patch.accessProfile
    }
    state.pendingTurnOverrides = { ...state.pendingTurnOverrides, ...overrides }
  }

  async resolveApproval(
    sessionId: string,
    requestId: string,
    decision: CodexApprovalDecision,
    message?: string,
    answers?: CodexApprovalAnswers,
  ): Promise<boolean> {
    const state = this.sessions.get(sessionId)
    const pending = state?.pendingApprovals.get(requestId)
    if (!state || !pending || state.stopped) return false
    const response = this.approvalResponse(pending, decision, message, answers)
    if (response === CODEX_REQUEST_UNHANDLED) return false
    if (!this.captureApprovalOutcome(
      state,
      requestId,
      pending,
      decision,
      'operator',
      message?.trim() ? 'operator-decision-with-message' : 'operator-decision',
      true,
    )) return false
    return this.completeApproval(state, requestId, pending, response)
  }

  async reconcileSessions(): Promise<CodexSessionReconcileResult> {
    if (this.reconcilePromise) return this.reconcilePromise
    this.reconcilePromise = this.reconcileSessionsNow()
    try {
      return await this.reconcilePromise
    } finally {
      this.reconcilePromise = null
    }
  }

  async *events(sessionId: string): AsyncIterable<DriverEvent> {
    const state = this.required(sessionId)
    yield* state.queue
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    for (const state of this.sessions.values()) {
      if (!state.stopped) this.stopState(state, 'Codex driver disposed', { detached: true })
    }
  }

  private createState(
    thread: CodexThread,
    workspaceId: OsId,
    native: Record<string, unknown>,
    tokenBudget?: number | null,
  ): CodexSessionState {
    const active = thread.status?.type === 'active'
    const resolvedModel = typeof native.model === 'string' && native.model.trim() ? native.model.trim() : undefined
    const resolvedEffort = typeof native.reasoningEffort === 'string' && native.reasoningEffort.trim()
      ? native.reasoningEffort.trim()
      : undefined
    const session: DriverSession = {
      id: `${this.id}:${thread.id}`,
      externalId: thread.id,
      driverId: this.id,
      workspaceId,
      status: active ? 'running' : 'idle',
      startedAt: this.threadStartedAt(thread),
      metadata: {
        threadId: thread.id,
        codexSessionId: thread.sessionId ?? null,
        cliVersion: thread.cliVersion ?? null,
        cwd: thread.cwd,
        parentThreadId: thread.parentThreadId ?? null,
        agentNickname: thread.agentNickname ?? null,
        agentRole: thread.agentRole ?? null,
        currentTurnId: null,
        tokenBudget: this.tokenBudget(tokenBudget),
        ...(resolvedModel ? { resolvedModel } : {}),
        ...(resolvedEffort ? { resolvedEffort } : {}),
        native,
      },
    }
    return {
      session,
      threadId: thread.id,
      activeTurnId: null,
      queue: new BoundedAsyncQueue(this.eventBufferSize),
      seq: 0,
      stopped: false,
      agentMessageDeltaItems: new Set(),
      latestUsage: null,
      droppedEvents: 0,
      pendingTurnOverrides: {},
      pendingApprovals: new Map(),
      completedApprovals: new Map(),
      tokenBudget: this.tokenBudget(tokenBudget),
      tokenBudgetInterrupted: false,
      nativeEventSeq: 0,
    }
  }

  private registerState(state: CodexSessionState): void {
    this.sessions.set(state.session.id, state)
    this.sessionsByThread.set(state.threadId, state)
  }

  private async resolveAgentHomeBinding(
    thread: CodexThread,
    context: Omit<CodexAgentHomeBindContext, 'expectedBinding'>,
  ): Promise<CodexAgentHomeBinding | undefined> {
    const expectedBinding = this.agentHomeBindingFromMetadata(
      context.metadata,
      context.workspaceId,
    )
    const resolved = await this.options.agentHomeForThread?.(
      thread.id,
      thread,
      {
        ...context,
        ...(expectedBinding ? { expectedBinding } : {}),
      },
    )
    if (this.options.agentHomeForThread && !resolved) {
      throw new Error(`Codex thread ${thread.id} Agent Home binding could not be validated`)
    }
    if (expectedBinding && resolved) this.assertSameAgentHomeBinding(expectedBinding, resolved)
    const binding = resolved ?? expectedBinding
    if (this.options.nativeEventSink && !binding) {
      throw new Error(`Codex thread ${thread.id} has no durable Agent Home binding`)
    }
    if (binding) this.validateAgentHomeBinding(binding, context.workspaceId)
    return binding
  }

  private agentHomeBindingFromMetadata(
    metadata: Record<string, unknown>,
    workspaceId?: OsId,
  ): CodexAgentHomeBinding | undefined {
    const agentHomeSessionId = metadata.agentHomeSessionId
    const agentProfileId = metadata.agentProfileId
    const agentConversationId = metadata.agentConversationId
    const values = [agentHomeSessionId, agentProfileId, agentConversationId]
    const present = values.filter((value) => typeof value === 'string' && value.length > 0).length
    if (present === 0) return undefined
    if (present !== values.length) {
      throw new Error('Agent Home binding metadata is incomplete')
    }
    return {
      agentHomeSessionId: agentHomeSessionId as string,
      agentProfileId: agentProfileId as string,
      agentConversationId: agentConversationId as string,
      ...(workspaceId ? { workspaceId } : {}),
    }
  }

  private assertSameAgentHomeBinding(
    expected: CodexAgentHomeBinding,
    resolved: CodexAgentHomeBinding,
  ): void {
    if (expected.agentHomeSessionId !== resolved.agentHomeSessionId
      || expected.agentProfileId !== resolved.agentProfileId
      || expected.agentConversationId !== resolved.agentConversationId
      || (expected.workspaceId && resolved.workspaceId
        && expected.workspaceId !== resolved.workspaceId)) {
      throw new Error('resolved Agent Home binding does not match the supplied canonical identity')
    }
  }

  private validateAgentHomeBinding(
    binding: CodexAgentHomeBinding,
    expectedWorkspaceId?: OsId,
  ): void {
    const values = [
      binding.agentHomeSessionId,
      binding.agentProfileId,
      binding.agentConversationId,
    ]
    if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
      throw new Error('resolved Agent Home binding is incomplete')
    }
    if (expectedWorkspaceId && binding.workspaceId
      && expectedWorkspaceId !== binding.workspaceId) {
      throw new Error('resolved Agent Home binding belongs to another workspace')
    }
  }

  private applyAgentHomeBinding(
    state: CodexSessionState,
    binding: CodexAgentHomeBinding,
  ): void {
    Object.assign(state.session.metadata, {
      agentHomeSessionId: binding.agentHomeSessionId,
      agentProfileId: binding.agentProfileId,
      agentConversationId: binding.agentConversationId,
    })
    state.nativeEventSeq = this.captureCursorSequence(
      binding.captureCursor ?? binding.providerCursor,
    )
  }

  private async reconcileSessionsNow(): Promise<CodexSessionReconcileResult> {
    const result: CodexSessionReconcileResult = { resumed: [], failed: [] }
    const states = [...this.sessionsByThread.values()].filter((state) => !state.stopped)
    await Promise.all(states.map(async (state) => {
      try {
        const priorActiveTurnId = state.activeTurnId
        const reconnectAt = this.now().toISOString()
        if (!this.captureNativeEvent(state, {
          method: 'orchestra/captureGap',
          params: {
            threadId: state.threadId,
            turnId: priorActiveTurnId,
            reason: 'app-server-reconnect',
          },
          receivedAt: reconnectAt,
        }, state.threadId)) {
          throw new Error(`Codex thread ${state.threadId} could not persist its reconnect capture boundary`)
        }
        state.session.metadata.nativeCaptureResume = {
          reason: 'app-server-reconnect',
          at: reconnectAt,
        }
        const resumed = await this.options.service.resumeThread(state.threadId)
        const read = await this.options.service.readThread(state.threadId, true)
        if (state.stopped) return
        const thread = read.thread ?? resumed.thread
        if (thread.id !== state.threadId) {
          throw new Error(
            `Codex reconnect returned thread ${thread.id} for bound thread ${state.threadId}`,
          )
        }
        if (typeof state.session.metadata.cwd === 'string'
          && state.session.metadata.cwd !== thread.cwd) {
          throw new Error(`Codex reconnect changed cwd for bound thread ${state.threadId}`)
        }
        const activeTurn = [...thread.turns].reverse().find((turn) => turn.status === 'inProgress')
        this.setActiveTurn(state, activeTurn?.id ?? null)
        const resolvedModel = typeof resumed.model === 'string' && resumed.model.trim()
          ? resumed.model.trim()
          : undefined
        const resolvedEffort = typeof resumed.reasoningEffort === 'string' && resumed.reasoningEffort.trim()
          ? resumed.reasoningEffort.trim()
          : undefined
        Object.assign(state.session.metadata, {
          codexSessionId: thread.sessionId ?? state.session.metadata.codexSessionId ?? null,
          cliVersion: thread.cliVersion ?? state.session.metadata.cliVersion ?? null,
          cwd: thread.cwd,
          parentThreadId: thread.parentThreadId ?? null,
          agentNickname: thread.agentNickname ?? null,
          agentRole: thread.agentRole ?? null,
          ...(resolvedModel ? { resolvedModel } : {}),
          ...(resolvedEffort ? { resolvedEffort } : {}),
          nativeReconcile: { resumed, read },
        })
        result.resumed.push(state.threadId)
        this.emitEvent(state, 'status', 'Codex session resumed after app-server reconnect', {
          method: 'orchestra/reconciled',
          params: { threadId: state.threadId, turnId: activeTurn?.id ?? null },
          receivedAt: this.now().toISOString(),
        }, { reconnected: true })
        if (!activeTurn && priorActiveTurnId) this.replayTerminalTurn(state, thread, 'app-server-reconnect')
      } catch (error) {
        if (state.stopped) return
        state.session.status = 'lost'
        result.failed.push(state.threadId)
        this.emitEvent(state, 'error', error instanceof Error ? error.message : String(error), {
          method: 'orchestra/reconcileFailed',
          params: { threadId: state.threadId },
          receivedAt: this.now().toISOString(),
        }, { reconnected: false })
        this.stopState(state, 'Codex session lost after reconnect failure', {
          lost: true,
          reconnectFailed: true,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }))
    result.resumed.sort()
    result.failed.sort()
    return result
  }

  private acceptNotification(notification: CodexServerNotification): void {
    const params = isRecord(notification.params) ? notification.params : {}
    const threadId = this.threadId(params)
    if (notification.method === 'thread/started' && isRecord(params.thread)) {
      const parentThreadId = typeof params.thread.parentThreadId === 'string' ? params.thread.parentThreadId : null
      const parent = parentThreadId ? this.sessionsByThread.get(parentThreadId) : undefined
      if (parent && !parent.stopped) {
        if (!this.captureNativeEvent(parent, notification, parent.threadId)) return
        this.emitEvent(parent, 'tool', 'Codex subagent started', notification, {
          subagentId: typeof params.thread.id === 'string' ? params.thread.id : null,
          subagentStatus: 'started',
          label: typeof params.thread.agentNickname === 'string'
            ? params.thread.agentNickname
            : typeof params.thread.agentRole === 'string' ? params.thread.agentRole : 'subagent',
          subagent: {
            threadId: typeof params.thread.id === 'string' ? params.thread.id : null,
            parentThreadId,
            nickname: params.thread.agentNickname ?? null,
            role: params.thread.agentRole ?? null,
          },
        })
      }
    }
    if (!threadId) return
    const state = this.sessionsByThread.get(threadId)
    if (!state || state.stopped) return
    if (!this.captureNativeEvent(state, notification, threadId)) return
    switch (notification.method) {
      case 'turn/started': {
        const turn = isRecord(params.turn) ? params.turn : null
        const turnId = turn && typeof turn.id === 'string' ? turn.id : this.turnId(params)
        if (turnId) this.setActiveTurn(state, turnId)
        this.emitEvent(state, 'status', 'Codex turn started', notification, { turnActive: true })
        return
      }
      case 'turn/completed': {
        const turn = isRecord(params.turn) ? params.turn as CodexTurn : null
        const turnId = turn && typeof turn.id === 'string' ? turn.id : this.turnId(params)
        if (!turnId || state.activeTurnId === turnId) this.setActiveTurn(state, null)
        const failed = turn?.status === 'failed' || turn?.status === 'interrupted'
        this.emitEvent(
          state,
          failed ? 'error' : 'status',
          turn?.status === 'interrupted'
            ? 'Codex turn interrupted'
            : failed ? this.turnError(turn) : `Codex turn ${String(turn?.status ?? 'completed')}`,
          notification,
          { turnCompleted: true, turnActive: false, status: turn?.status ?? 'completed' },
        )
        return
      }
      case 'item/agentMessage/delta': {
        const itemId = this.itemId(params)
        if (itemId) state.agentMessageDeltaItems.add(itemId)
        this.emitEvent(state, 'output', typeof params.delta === 'string' ? params.delta : '', notification)
        return
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'process/outputDelta':
      case 'command/exec/outputDelta':
        this.emitEvent(state, 'tool', typeof params.delta === 'string' ? params.delta : '', notification)
        return
      case 'item/started':
      case 'item/completed': {
        const item = isRecord(params.item) ? params.item as CodexThreadItem : null
        if (!item) return
        this.acceptItem(state, item, notification, notification.method === 'item/completed')
        return
      }
      case 'thread/tokenUsage/updated': {
        if (isRecord(params.tokenUsage)) state.latestUsage = params.tokenUsage as CodexThreadTokenUsage
        this.emitEvent(state, 'status', 'Codex token usage updated', notification, {
          tokenUsage: params.tokenUsage,
          usage: params.tokenUsage,
          tokens: this.totalTokens(params.tokenUsage),
        })
        void this.enforceTokenBudget(state)
        return
      }
      case 'turn/diff/updated':
        this.emitEvent(state, 'tool', typeof params.diff === 'string' ? params.diff : 'Codex diff updated', notification, {
          diff: params.diff,
        })
        return
      case 'turn/plan/updated':
        this.emitEvent(state, 'status', 'Codex plan updated', notification, {
          plan: params.plan,
          explanation: params.explanation,
        })
        return
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/textDelta':
        this.emitEvent(state, 'status', typeof params.delta === 'string' ? params.delta : notification.method, notification, {
          kind: 'reasoning',
        })
        return
      case 'thread/status/changed': {
        const type = isRecord(params.status) && typeof params.status.type === 'string' ? params.status.type : 'unknown'
        state.session.status = this.sessionStatus(type)
        this.emitEvent(state, type === 'systemError' ? 'error' : 'status', `Codex thread ${type}`, notification)
        return
      }
      case 'error':
        this.emitEvent(state, 'error', this.errorText(params.error), notification, { willRetry: params.willRetry })
        return
      case 'thread/closed':
      case 'thread/deleted':
        this.stopState(state, notification.method === 'thread/closed' ? 'Codex thread closed' : 'Codex thread deleted', {
          nativeMethod: notification.method,
          native: notification.params,
        })
        return
      default:
        // Keep provider-native events visible to consumers that understand a newer CLI.
        this.emitEvent(state, 'status', notification.method, notification, { unknownNativeEvent: true })
    }
  }

  private captureNativeEvent(
    state: CodexSessionState,
    notification: CodexServerNotification,
    threadId: string,
  ): boolean {
    const sink = this.options.nativeEventSink
    if (!sink) return true
    const agentHomeSessionId = state.session.metadata.agentHomeSessionId
    const agentProfileId = state.session.metadata.agentProfileId
    const agentConversationId = state.session.metadata.agentConversationId
    const present = [agentHomeSessionId, agentProfileId, agentConversationId]
      .filter((value) => typeof value === 'string').length
    if (present !== 3) {
      this.emitNativeCaptureFailure(
        state,
        notification.method,
        present === 0
          ? 'Agent Home binding metadata is missing'
          : 'Agent Home binding metadata is incomplete',
      )
      return false
    }
    const params = isRecord(notification.params) ? notification.params : {}
    const captureCursor = `orchestra-codex:${++state.nativeEventSeq}`
    try {
      sink.append({
        agentHomeSessionId: agentHomeSessionId as string,
        agentProfileId: agentProfileId as string,
        agentConversationId: agentConversationId as string,
        captureCursor,
        threadId,
        turnId: this.turnId(params),
        itemId: this.itemId(params),
        method: notification.method,
        params: notification.params,
        receivedAt: notification.receivedAt,
      })
      return true
    } catch (error) {
      this.emitNativeCaptureFailure(
        state,
        notification.method,
        error instanceof Error ? error.message : String(error),
        captureCursor,
      )
      return false
    }
  }

  private emitNativeCaptureFailure(
    state: CodexSessionState,
    nativeMethod: string,
    detail: string,
    captureCursor?: string,
  ): void {
    const message = detail.length > 1_000 ? `${detail.slice(0, 997)}...` : detail
    state.session.metadata.nativeCaptureFailure = {
      method: nativeMethod,
      detail: message,
      ...(captureCursor ? { captureCursor } : {}),
    }
    this.emitEvent(state, 'error', `Codex native event was not persisted: ${message}`, {
      method: 'orchestra/nativeCaptureFailed',
      params: { threadId: state.threadId },
      receivedAt: this.now().toISOString(),
    }, {
      nativeCaptureFailed: true,
      failedNativeMethod: nativeMethod,
      ...(captureCursor ? { captureCursor } : {}),
    })
  }

  private captureCursorSequence(providerCursor: string | null | undefined): number {
    const match = /^orchestra-codex:(\d+)$/.exec(providerCursor ?? '')
    if (!match) return 0
    const value = Number(match[1])
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  private async acceptServerRequest(request: CodexServerRequest): Promise<CodexServerRequestHandlerResult> {
    if (request.method === 'currentTime/read') {
      return { currentTimeAt: Math.floor(this.now().getTime() / 1_000) }
    }
    const kind = APPROVAL_METHODS[request.method]
    if (!kind || !isRecord(request.params)) return CODEX_REQUEST_UNHANDLED
    const threadId = typeof request.params.threadId === 'string' ? request.params.threadId : null
    if (!threadId) return CODEX_REQUEST_UNHANDLED
    const state = this.sessionsByThread.get(threadId)
    if (!state || state.stopped) return CODEX_REQUEST_UNHANDLED
    const turnId = typeof request.params.turnId === 'string' ? request.params.turnId : null
    const itemId = typeof request.params.itemId === 'string' ? request.params.itemId : null
    if (!this.captureNativeEvent(state, {
      method: request.method,
      params: {
        ...request.params,
        eventId: String(request.id),
      },
      receivedAt: request.receivedAt,
    }, threadId)) {
      return CODEX_REQUEST_UNHANDLED
    }
    const requestId = String(request.id)
    const replayKey = this.approvalReplayKey(requestId, {
      kind,
      params: request.params,
    })
    if (state.completedApprovals.has(replayKey)) {
      const completed = state.completedApprovals.get(replayKey)
      state.completedApprovals.delete(replayKey)
      state.completedApprovals.set(replayKey, completed)
      return completed
    }
    const existing = state.pendingApprovals.get(requestId)
    if (existing) {
      return this.approvalReplayKey(requestId, existing) === replayKey
        ? existing.deferred.promise
        : CODEX_REQUEST_UNHANDLED
    }
    const elicitationQuestions = kind === 'mcp-elicitation'
      ? this.elicitationQuestions(request.params)
      : []
    const questions = kind === 'user-input' && Array.isArray(request.params.questions)
      ? request.params.questions
      : elicitationQuestions
    const requestText = kind === 'mcp-elicitation' && typeof request.params.message === 'string'
      ? request.params.message
      : `Codex ${kind} approval requested`
    this.emitEvent(state, 'tool', requestText, {
      method: request.method,
      params: request.params,
      receivedAt: request.receivedAt,
    }, {
      approval: true,
      kind: 'approval',
      requestId: String(request.id),
      approvalKind: kind,
      approvalRequest: { kind, requestId: request.id, turnId, itemId },
      ...(questions.length > 0 ? { questions } : {}),
      ...(kind === 'mcp-elicitation' ? {
        elicitationMode: typeof request.params.mode === 'string' ? request.params.mode : null,
        serverName: typeof request.params.serverName === 'string' ? request.params.serverName : null,
        url: this.elicitationUrl(request.params.url),
        elicitationId: typeof request.params.elicitationId === 'string' ? request.params.elicitationId : null,
      } : {}),
    })
    const response = deferred<unknown>()
    const pending: PendingApproval = {
      kind,
      params: request.params,
      deferred: response,
      timer: null,
    }
    state.pendingApprovals.set(requestId, pending)
    pending.timer = setTimeout(() => {
      if (state.pendingApprovals.get(requestId) !== pending) return
      const cancellation = this.approvalResponse(pending, 'cancel')
      const persisted = this.captureApprovalOutcome(
        state,
        requestId,
        pending,
        'cancel',
        'timeout',
        'approval-timeout',
        true,
      )
      this.completeApproval(
        state,
        requestId,
        pending,
        persisted ? cancellation : CODEX_REQUEST_UNHANDLED,
      )
      this.emitEvent(state, 'error', `Codex approval ${requestId} timed out`, {
        method: 'orchestra/approvalTimeout',
        params: { threadId, turnId, itemId, requestId },
        receivedAt: this.now().toISOString(),
      }, {
        approvalAuditPersisted: persisted,
      })
    }, this.approvalTimeoutMs)
    pending.timer.unref?.()
    if (this.options.onApprovalRequest) {
      let handled: unknown
      try {
        handled = await this.options.onApprovalRequest({
          kind,
          sessionId: state.session.id,
          threadId,
          turnId,
          itemId,
          requestId: request.id,
          method: request.method,
          params: request.params,
        })
      } catch {
        if (state.pendingApprovals.get(requestId) === pending) {
          this.captureApprovalOutcome(
            state,
            requestId,
            pending,
            'unhandled',
            'automatic',
            'automatic-handler-failed',
            true,
          )
          this.completeApproval(
            state,
            requestId,
            pending,
            CODEX_REQUEST_UNHANDLED,
          )
        }
        return pending.deferred.promise
      }
      if (state.pendingApprovals.get(requestId) !== pending) {
        return pending.deferred.promise
      }
      if (handled !== CODEX_REQUEST_UNHANDLED) {
        const decision = this.approvalDecisionForResponse(handled)
        const persisted = this.captureApprovalOutcome(
          state,
          requestId,
          pending,
          decision,
          'automatic',
          decision === 'unhandled'
            ? 'automatic-handler-returned-an-unclassified-response'
            : 'automatic-handler-decision',
          true,
        )
        this.completeApproval(
          state,
          requestId,
          pending,
          persisted ? handled : CODEX_REQUEST_UNHANDLED,
        )
        return pending.deferred.promise
      }
    }
    const routingPersisted = this.captureApprovalOutcome(
      state,
      requestId,
      pending,
      'unhandled',
      'automatic',
      this.options.onApprovalRequest ? 'automatic-handler-deferred' : 'no-automatic-handler',
      false,
    )
    if (!routingPersisted) {
      this.completeApproval(
        state,
        requestId,
        pending,
        CODEX_REQUEST_UNHANDLED,
      )
    }
    return pending.deferred.promise
  }

  private replayTerminalTurn(
    state: CodexSessionState,
    thread: CodexThread,
    reason: 'daemon-attach' | 'app-server-reconnect',
  ): void {
    const turn = thread.turns.at(-1)
    if (!turn || !['completed', 'failed', 'interrupted'].includes(turn.status)) return
    const failed = turn.status === 'failed' || turn.status === 'interrupted'
    const native = {
      method: 'turn/completed',
      params: { threadId: state.threadId, turnId: turn.id, turn },
      receivedAt: this.now().toISOString(),
    }
    if (!this.captureNativeEvent(state, native, state.threadId)) return
    this.emitEvent(
      state,
      failed ? 'error' : 'status',
      turn.status === 'interrupted'
        ? 'Codex turn interrupted'
        : failed ? this.turnError(turn) : `Codex turn ${turn.status}`,
      native,
      {
        turnCompleted: true,
        turnActive: false,
        status: turn.status,
        replayed: true,
        reconnectReason: reason,
      },
    )
  }

  private acceptItem(
    state: CodexSessionState,
    item: CodexThreadItem,
    notification: CodexServerNotification,
    completed: boolean,
  ): void {
    if (item.type === 'agentMessage') {
      if (completed && item.id && !state.agentMessageDeltaItems.has(item.id) && typeof item.text === 'string') {
        this.emitEvent(state, 'output', item.text, notification, { item, itemCompleted: true })
      }
      return
    }
    if (item.type === 'userMessage' || item.type === 'hookPrompt') return
    const toolTypes = new Set([
      'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall',
      'subAgentActivity', 'webSearch', 'imageView', 'imageGeneration', 'sleep',
    ])
    const type = toolTypes.has(item.type) ? 'tool' : 'status'
    this.emitEvent(state, type, this.itemText(item, completed), notification, {
      item,
      itemCompleted: completed,
      ...(this.subagentMetadata(item) ?? {}),
    })
  }

  private emitEvent(
    state: CodexSessionState,
    type: DriverEvent['type'],
    data: string,
    native: Pick<CodexServerNotification, 'method' | 'params' | 'receivedAt'>,
    metadata: Record<string, unknown> = {},
  ): void {
    if (state.stopped && type !== 'exit') return
    const params = isRecord(native.params) ? native.params : {}
    const event: DriverEvent = {
      sessionId: state.session.id,
      seq: ++state.seq,
      type,
      at: this.eventTime(native.receivedAt, params),
      data,
      metadata: {
        provider: this.id,
        threadId: state.threadId,
        turnId: this.turnId(params),
        itemId: this.itemId(params),
        nativeMethod: native.method,
        method: native.method,
        native: native.params,
        ...(state.droppedEvents > 0 ? { priorDroppedEvents: state.droppedEvents } : {}),
        ...metadata,
      },
    }
    state.droppedEvents = 0
    if (!state.queue.push(event)) state.droppedEvents += 1
  }

  private setActiveTurn(state: CodexSessionState, turnId: string | null): void {
    state.activeTurnId = turnId
    state.session.status = turnId ? 'running' : 'idle'
    state.session.metadata.currentTurnId = turnId
  }

  private failState(state: CodexSessionState, error: unknown): void {
    state.session.status = 'failed'
    this.emitEvent(state, 'error', error instanceof Error ? error.message : String(error), {
      method: 'orchestra/launchFailed',
      params: {},
      receivedAt: this.now().toISOString(),
    })
    this.cancelPendingApprovals(state)
    state.stopped = true
    state.queue.close()
  }

  private stopState(state: CodexSessionState, data: string, metadata: Record<string, unknown> = {}): void {
    if (state.stopped) return
    state.session.status = 'stopped'
    state.activeTurnId = null
    state.session.metadata.currentTurnId = null
    this.emitEvent(state, 'exit', data, {
      method: typeof metadata.nativeMethod === 'string' ? metadata.nativeMethod : 'orchestra/stop',
      params: metadata.native ?? metadata,
      receivedAt: this.now().toISOString(),
    }, {
      tokens: state.latestUsage?.total.totalTokens ?? 0,
      usage: state.latestUsage,
      ...metadata,
    })
    this.cancelPendingApprovals(state)
    state.stopped = true
    state.queue.close()
  }

  private required(sessionId: string): CodexSessionState {
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error(`Codex session not attached: ${sessionId}`)
    return state
  }

  private defaultPolicy(permissionMode?: string): CodexLaunchPolicy {
    switch (permissionMode) {
      case undefined:
        return {}
      case 'default':
      case 'acceptEdits':
      case 'workspace-write':
        return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
      case 'plan':
      case 'read-only':
        return { sandbox: 'read-only', approvalPolicy: 'on-request' }
      case 'danger-full-access':
        return { sandbox: 'danger-full-access', approvalPolicy: 'on-request' }
      case 'bypassPermissions':
        throw new Error('Refusing to map Claude bypassPermissions to Codex danger-full-access implicitly')
      default:
        throw new Error(`Unsupported Codex permission mode: ${permissionMode}`)
    }
  }

  private launchPolicy(profile: CodexAccessProfile): CodexLaunchPolicy {
    switch (profile) {
      case 'read_only':
        return { sandbox: 'read-only', approvalPolicy: 'on-request' }
      case 'workspace_write':
        return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
      case 'full_access':
        return { sandbox: 'danger-full-access', approvalPolicy: 'on-request' }
    }
  }

  private turnPolicy(
    profile: CodexAccessProfile,
    cwd: unknown,
  ): Pick<CodexTurnStartParams, 'approvalPolicy' | 'sandboxPolicy'> {
    if (profile === 'read_only') {
      return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
    }
    if (profile === 'workspace_write') {
      return {
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: typeof cwd === 'string' ? [cwd] : [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      }
    }
    return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'dangerFullAccess' } }
  }

  private approvalDecisionForResponse(response: unknown): CodexApprovalAuditDecision {
    if (!isRecord(response)) return 'unhandled'
    if (response.decision === 'accept') return 'allow'
    if (response.decision === 'acceptForSession') return 'allow_session'
    if (response.decision === 'decline') return 'deny'
    if (response.decision === 'cancel') return 'cancel'
    if (response.action === 'accept') return 'allow'
    if (response.action === 'decline') return 'deny'
    if (response.action === 'cancel') return 'cancel'
    if (Object.hasOwn(response, 'permissions')) {
      const permissions = isRecord(response.permissions) ? response.permissions : {}
      if (Object.keys(permissions).length === 0) return 'deny'
      return response.scope === 'session' ? 'allow_session' : 'allow'
    }
    if (Object.hasOwn(response, 'answers')) return 'allow'
    return 'unhandled'
  }

  private captureApprovalOutcome(
    state: CodexSessionState,
    requestId: string,
    pending: Pick<PendingApproval, 'kind' | 'params'>,
    decision: CodexApprovalAuditDecision,
    source: CodexApprovalOutcomeSource,
    reason: string,
    final: boolean,
  ): boolean {
    const stage = final ? source === 'automatic' ? 'automatic-response' : 'final-response' : 'routing'
    return this.captureNativeEvent(state, {
      method: 'orchestra/approvalResponse',
      params: {
        threadId: state.threadId,
        turnId: this.turnId(pending.params),
        itemId: this.itemId(pending.params),
        eventId: `approval:${requestId}:${stage}`,
        requestId,
        approvalKind: pending.kind,
        decision,
        source,
        reason,
        final,
        actorType: source === 'operator' ? 'operator' : 'system',
        actorId: source === 'operator'
          ? null
          : source === 'automatic' ? 'codex-approval-policy' : 'codex-driver',
      },
      receivedAt: this.now().toISOString(),
    }, state.threadId)
  }

  private completeApproval(
    state: CodexSessionState,
    requestId: string,
    pending: PendingApproval,
    response: unknown,
  ): boolean {
    if (state.pendingApprovals.get(requestId) !== pending) return false
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.timer = null
    state.pendingApprovals.delete(requestId)
    state.completedApprovals.set(
      this.approvalReplayKey(requestId, pending),
      response,
    )
    if (state.completedApprovals.size > COMPLETED_APPROVAL_CACHE_SIZE) {
      const oldest = state.completedApprovals.keys().next().value
      if (oldest !== undefined) state.completedApprovals.delete(oldest)
    }
    pending.deferred.resolve(response)
    return true
  }

  private approvalReplayKey(
    requestId: string,
    pending: Pick<PendingApproval, 'kind' | 'params'>,
  ): string {
    return JSON.stringify([
      requestId,
      pending.kind,
      this.turnId(pending.params),
      this.itemId(pending.params),
    ])
  }

  private approvalResponse(
    pending: Pick<PendingApproval, 'kind' | 'params'>,
    decision: CodexApprovalDecision,
    message?: string,
    suppliedAnswers?: CodexApprovalAnswers,
  ): unknown {
    if (pending.kind === 'command' || pending.kind === 'file-change') {
      return {
        decision: decision === 'allow' ? 'accept'
          : decision === 'allow_session' ? 'acceptForSession'
            : decision === 'deny' ? 'decline' : 'cancel',
      }
    }
    if (pending.kind === 'permissions') {
      return {
        permissions: decision === 'allow' || decision === 'allow_session'
          ? (isRecord(pending.params.permissions) ? pending.params.permissions : {})
          : {},
        scope: decision === 'allow_session' ? 'session' : 'turn',
      }
    }
    if (pending.kind === 'mcp-elicitation') {
      const accepted = decision === 'allow' || decision === 'allow_session'
      return {
        action: accepted ? 'accept' : decision === 'deny' ? 'decline' : 'cancel',
        content: accepted && pending.params.mode !== 'url'
          ? this.elicitationContent(pending.params, suppliedAnswers, message)
          : null,
        _meta: null,
      }
    }
    const answers: Record<string, { answers: string[] }> = {}
    if ((decision === 'allow' || decision === 'allow_session') && Array.isArray(pending.params.questions)) {
      for (const question of pending.params.questions) {
        if (isRecord(question) && typeof question.id === 'string') {
          const supplied = suppliedAnswers?.[question.id]
          answers[question.id] = {
            answers: Array.isArray(supplied)
              ? supplied.filter((answer): answer is string => typeof answer === 'string')
              : message ? [message] : [],
          }
        }
      }
    }
    return { answers }
  }

  private elicitationQuestions(params: Record<string, unknown>): Record<string, unknown>[] {
    if (params.mode !== 'form' && params.mode !== 'openai/form') return []
    const schema = isRecord(params.requestedSchema) ? params.requestedSchema : null
    if (!schema || !isRecord(schema.properties)) return []
    const properties = schema.properties
    const required = new Set(Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [])
    return Object.entries(properties).flatMap(([id, raw]) => {
      if (!isRecord(raw)) return []
      const multiple = raw.type === 'array'
      const optionSource = multiple && isRecord(raw.items) ? raw.items : raw
      const options = this.elicitationOptions(optionSource)
      const defaultValue = raw.default
      const defaultAnswers = Array.isArray(defaultValue)
        ? defaultValue.filter((value): value is string => typeof value === 'string')
        : typeof defaultValue === 'string' || typeof defaultValue === 'number' || typeof defaultValue === 'boolean'
          ? [String(defaultValue)]
          : []
      return [{
        id,
        header: typeof raw.title === 'string' && raw.title.trim() ? raw.title : id,
        ...(typeof raw.description === 'string' && raw.description.trim() ? { question: raw.description } : {}),
        required: required.has(id),
        multiple,
        ...(options.length > 0 ? { options } : {}),
        ...(defaultAnswers.length > 0 ? { defaultAnswers } : {}),
        isSecret: raw.format === 'password' || raw.isSecret === true || raw.writeOnly === true,
        inputType: raw.type === 'number' || raw.type === 'integer'
          ? 'number'
          : raw.format === 'email' ? 'email'
            : raw.format === 'uri' ? 'url'
              : raw.format === 'date' ? 'date'
                : raw.format === 'date-time' ? 'datetime-local' : 'text',
        ...(typeof raw.minimum === 'number' ? { minimum: raw.minimum } : {}),
        ...(typeof raw.maximum === 'number' ? { maximum: raw.maximum } : {}),
        ...(raw.type === 'integer' ? { step: 1 } : {}),
      }]
    })
  }

  private elicitationOptions(schema: Record<string, unknown>): Array<{ label: string; description?: string }> {
    if (Array.isArray(schema.enum)) {
      const names = Array.isArray(schema.enumNames) ? schema.enumNames : []
      return schema.enum.flatMap((value, index) => typeof value === 'string'
        ? [{ label: value, ...(typeof names[index] === 'string' && names[index] !== value
          ? { description: names[index] }
          : {}) }]
        : [])
    }
    const titled = Array.isArray(schema.oneOf) ? schema.oneOf
      : Array.isArray(schema.anyOf) ? schema.anyOf : []
    const values = titled.flatMap((option) => isRecord(option) && typeof option.const === 'string'
      ? [{
          label: option.const,
          ...(typeof option.title === 'string' && option.title !== option.const
            ? { description: option.title }
            : {}),
        }]
      : [])
    if (values.length > 0) return values
    if (schema.type === 'boolean') return [{ label: 'true', description: 'Yes' }, { label: 'false', description: 'No' }]
    return []
  }

  private elicitationUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
    } catch {
      return null
    }
  }

  private elicitationContent(
    params: Record<string, unknown>,
    suppliedAnswers?: CodexApprovalAnswers,
    message?: string,
  ): Record<string, unknown> {
    const schema = isRecord(params.requestedSchema) ? params.requestedSchema : null
    const properties = schema && isRecord(schema.properties) ? schema.properties : null
    if (!properties) return {}
    const content: Record<string, unknown> = {}
    for (const [id, raw] of Object.entries(properties)) {
      if (!isRecord(raw)) continue
      const answers = Array.isArray(suppliedAnswers?.[id])
        ? suppliedAnswers[id].filter((answer): answer is string => typeof answer === 'string' && answer.length > 0)
        : message ? [message] : []
      if (answers.length === 0) continue
      if (raw.type === 'array') {
        content[id] = answers
      } else if (raw.type === 'boolean') {
        content[id] = answers[0] === 'true'
      } else if (raw.type === 'number' || raw.type === 'integer') {
        const value = Number(answers[0])
        if (Number.isFinite(value)) content[id] = raw.type === 'integer' ? Math.trunc(value) : value
      } else {
        content[id] = answers[0]
      }
    }
    return content
  }

  private cancelPendingApprovals(state: CodexSessionState): void {
    const reason = state.session.status === 'failed' ? 'session-failed' : 'session-stopped'
    for (const [requestId, pending] of [...state.pendingApprovals]) {
      const cancellation = this.approvalResponse(pending, 'cancel')
      const persisted = this.captureApprovalOutcome(
        state,
        requestId,
        pending,
        'cancel',
        'shutdown',
        reason,
        true,
      )
      this.completeApproval(
        state,
        requestId,
        pending,
        persisted ? cancellation : CODEX_REQUEST_UNHANDLED,
      )
    }
  }

  private isMissingThread(error: unknown): boolean {
    if (this.options.isMissingThreadError) return this.options.isMissingThreadError(error)
    if (error instanceof CodexRpcResponseError) return /not found|does not exist|unknown thread/i.test(error.rpcError.message)
    return error instanceof Error && /not found|does not exist|unknown thread/i.test(error.message)
  }

  private threadId(params: Record<string, unknown>): string | null {
    if (typeof params.threadId === 'string') return params.threadId
    if (isRecord(params.thread) && typeof params.thread.id === 'string') return params.thread.id
    return null
  }

  private turnId(params: Record<string, unknown>): string | null {
    if (typeof params.turnId === 'string') return params.turnId
    if (isRecord(params.turn) && typeof params.turn.id === 'string') return params.turn.id
    return null
  }

  private itemId(params: Record<string, unknown>): string | null {
    if (typeof params.itemId === 'string') return params.itemId
    if (isRecord(params.item) && typeof params.item.id === 'string') return params.item.id
    return null
  }

  private threadStartedAt(thread: CodexThread): string {
    if (typeof thread.createdAt === 'number' && Number.isFinite(thread.createdAt)) {
      return new Date(thread.createdAt * 1_000).toISOString()
    }
    return this.now().toISOString()
  }

  private eventTime(receivedAt: string, params: Record<string, unknown>): string {
    for (const key of ['completedAtMs', 'startedAtMs']) {
      const value = params[key]
      if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
    }
    return receivedAt
  }

  private sessionStatus(type: string): DriverSessionStatus {
    if (type === 'active') return 'running'
    if (type === 'idle') return 'idle'
    if (type === 'systemError') return 'failed'
    if (type === 'notLoaded') return 'lost'
    return 'running'
  }

  private itemText(item: CodexThreadItem, completed: boolean): string {
    const phase = completed ? 'completed' : 'started'
    if (item.type === 'commandExecution' && typeof item.command === 'string') return `${item.command} (${phase})`
    if (item.type === 'mcpToolCall') return `${String(item.server ?? 'mcp')}/${String(item.tool ?? 'tool')} (${phase})`
    if (item.type === 'dynamicToolCall') return `${String(item.tool ?? 'tool')} (${phase})`
    if (item.type === 'fileChange') return `Codex file change ${phase}`
    if (item.type === 'collabAgentToolCall') return `Codex collaboration ${String(item.tool ?? 'tool')} ${phase}`
    if (item.type === 'subAgentActivity') return `Codex subagent ${String(item.kind ?? phase)}`
    if (item.type === 'plan' && typeof item.text === 'string') return item.text
    return `Codex ${item.type} ${phase}`
  }

  private subagentMetadata(item: CodexThreadItem): Record<string, unknown> | null {
    if (item.type === 'collabAgentToolCall') {
      const receiverThreadIds = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string')
        : []
      return {
        ...(receiverThreadIds[0] ? {
          subagentId: receiverThreadIds[0],
          subagentStatus: 'started',
          label: typeof item.tool === 'string' ? item.tool : 'subagent',
        } : {}),
        subagents: {
          senderThreadId: item.senderThreadId ?? null,
          receiverThreadIds,
          agentsStates: item.agentsStates ?? {},
        },
      }
    }
    if (item.type === 'subAgentActivity') {
      return {
        subagentId: typeof item.agentThreadId === 'string' ? item.agentThreadId : null,
        subagentStatus: this.subagentStatus(item.kind),
        label: typeof item.agentPath === 'string' ? item.agentPath : 'subagent',
        subagent: {
          threadId: item.agentThreadId ?? null,
          path: item.agentPath ?? null,
          kind: item.kind ?? null,
        },
      }
    }
    return null
  }

  private subagentStatus(kind: unknown): 'started' | 'stopped' {
    return kind === 'interrupted' ? 'stopped' : 'started'
  }

  private tokenBudget(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
  }

  private async enforceTokenBudget(state: CodexSessionState): Promise<void> {
    const totalTokens = state.latestUsage?.total.totalTokens ?? 0
    if (
      state.stopped
      || state.tokenBudget === null
      || state.tokenBudgetInterrupted
      || totalTokens < state.tokenBudget
    ) return
    state.tokenBudgetInterrupted = true
    this.emitEvent(state, 'status', 'Codex token budget reached', {
      method: 'orchestra/tokenBudgetReached',
      params: { threadId: state.threadId, turnId: state.activeTurnId, totalTokens },
      receivedAt: this.now().toISOString(),
    }, {
      budgetExceeded: true,
      budgetTokens: state.tokenBudget,
      totalTokens,
    })
    if (!state.activeTurnId) return
    try {
      await this.options.service.interruptTurn(state.threadId, state.activeTurnId)
    } catch (error) {
      this.emitEvent(state, 'error', error instanceof Error ? error.message : String(error), {
        method: 'orchestra/tokenBudgetInterruptFailed',
        params: { threadId: state.threadId, turnId: state.activeTurnId },
        receivedAt: this.now().toISOString(),
      })
    }
  }

  private totalTokens(value: unknown): number {
    if (!isRecord(value) || !isRecord(value.total)) return 0
    return typeof value.total.totalTokens === 'number' ? value.total.totalTokens : 0
  }

  private turnError(turn: CodexTurn): string {
    return this.errorText(turn.error)
  }

  private errorText(error: unknown): string {
    if (typeof error === 'string') return error
    if (isRecord(error)) {
      for (const key of ['message', 'error', 'details']) {
        if (typeof error[key] === 'string') return error[key]
      }
    }
    return 'Codex turn failed'
  }
}

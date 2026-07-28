import { randomUUID } from 'node:crypto'
import { BoundedAsyncQueue } from '../../codex/async.js'
import {
  authorizeProviderLaunchV1,
  defineProviderExecutionIntentV1,
  defineProviderLaunchBoundaryV1,
  defineProviderNoCostConsentV1,
  selectProviderExecutionV1,
  type AuthorizedProviderLaunchV1,
  type ProviderActionV1,
  type ProviderCapabilityId,
  type ProviderEventV1,
  type ProviderExecutableDiscoveryV1,
  type ProviderExecutionAdapterV1,
  type ProviderExecutionScope,
  type ProviderExecutionSelectionV1,
  type ProviderSessionV1,
} from '../../provider-contract.js'
import {
  ProviderAdapterRegistryV1,
} from '../../provider-adapter-registry.js'
import type {
  AgentDriver,
  DriverCapabilities,
  DriverEvent,
  DriverLaunchRequest,
  DriverRecoveryRequest,
  DriverSession,
} from '../types.js'
import { ProviderLaunchRequestBrokerV1 } from './provider-launch-request-broker.js'

const SOURCE_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const CONFIGURATION_FINGERPRINT = /^sha256:[a-f0-9]{64}$/

export class ProviderContractRoutingError extends Error {
  constructor(
    message: string,
    readonly blockers: readonly string[] = [],
  ) {
    super(blockers.length ? `${message}: ${blockers.join(', ')}` : message)
    this.name = 'ProviderContractRoutingError'
  }
}

export type ProviderContractAgentDriverOptionsV1 = {
  registry: ProviderAdapterRegistryV1
  adapter: ProviderExecutionAdapterV1
  launchRequests: ProviderLaunchRequestBrokerV1
  source_commit: string
  configuration_fingerprint: string
  environment?: NodeJS.ProcessEnv
  execution_scope?: ProviderExecutionScope
  event_buffer_size?: number
}

type ContractDriverSessionV1 = {
  driver_session: DriverSession
  provider_session: ProviderSessionV1
  selection: ProviderExecutionSelectionV1
  queue: BoundedAsyncQueue<DriverEvent>
  next_sequence: number
  next_action: number
  event_claimed: boolean
  terminal: boolean
  stop_requested: boolean
}

const terminalStatus = (
  status: ProviderSessionV1['status'],
): status is 'stopped' | 'failed' | 'lost' =>
  status === 'stopped' || status === 'failed' || status === 'lost'

const costLimit = (
  request: Pick<DriverLaunchRequest, 'maxBudgetUsd'>,
): ProviderActionV1['cost_limit'] => {
  if (request.maxBudgetUsd === undefined) return null
  const minorUnits = Math.floor(request.maxBudgetUsd * 100)
  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) {
    throw new ProviderContractRoutingError('provider cost budget is invalid')
  }
  return {
    currency: 'USD',
    max_cost_minor_units: minorUnits,
  }
}

const supportedCapability = (
  selection: ProviderExecutionSelectionV1,
  adapter: ProviderExecutionAdapterV1,
  capability: ProviderCapabilityId,
): boolean => adapter.manifest.modes
  .find((mode) => mode.id === selection.mode_id)
  ?.capabilities[capability].state === 'supported'

const eventMetadata = (
  event: ProviderEventV1,
): Record<string, unknown> => ({
  providerContractVersion: 1,
  providerEventId: event.event_id,
  turnId: event.turn_id,
})

const mappedProviderEvent = (
  event: ProviderEventV1,
  sessionId: string,
): DriverEvent => {
  const common = {
    sessionId,
    seq: event.sequence,
    at: event.observed_at,
  }
  if (event.kind === 'output') {
    return {
      ...common,
      type: 'output',
      data: event.safe_text,
      metadata: eventMetadata(event),
    }
  }
  if (event.kind === 'tool') {
    return {
      ...common,
      type: 'tool',
      data: event.safe_summary ?? `${event.tool_name} ${event.phase}`,
      metadata: {
        ...eventMetadata(event),
        itemId: event.tool_call_id,
        toolName: event.tool_name,
        nativeMethod: `provider-tool/${event.phase}`,
      },
    }
  }
  if (event.kind === 'approval') {
    return {
      ...common,
      type: 'tool',
      data: event.safe_summary,
      metadata: {
        ...eventMetadata(event),
        kind: 'approval',
        approval: event.status === 'requested',
        requestId: event.approval_id,
        approvalKind: event.approval_kind,
        approvalRequest: {
          requestId: event.approval_id,
          kind: event.approval_kind,
          status: event.status,
        },
      },
    }
  }
  if (event.kind === 'usage') {
    return {
      ...common,
      type: 'status',
      data: `provider usage ${event.usage.status}`,
      metadata: {
        ...eventMetadata(event),
        providerUsage: event.usage,
      },
    }
  }
  if (event.kind === 'error') {
    return {
      ...common,
      type: 'error',
      data: event.safe_message,
      metadata: {
        ...eventMetadata(event),
        code: event.code,
      },
    }
  }
  if (terminalStatus(event.status)) {
    return {
      ...common,
      type: 'exit',
      data: `provider session ${event.status}`,
      metadata: {
        ...eventMetadata(event),
        exitCode: event.status === 'stopped' ? 0 : 1,
        providerStatus: event.status,
      },
    }
  }
  return {
    ...common,
    type: 'status',
    data: `provider session ${event.status}`,
    metadata: {
      ...eventMetadata(event),
      providerStatus: event.status,
      ...(event.status === 'idle' ? { turnCompleted: true } : {}),
    },
  }
}

export class ProviderContractAgentDriverV1 implements AgentDriver {
  readonly id: string
  readonly #environment: NodeJS.ProcessEnv
  readonly #executionScope: ProviderExecutionScope
  readonly #eventBufferSize: number
  readonly #selection: ProviderExecutionSelectionV1
  readonly #sessions = new Map<string, ContractDriverSessionV1>()

  constructor(private readonly options: ProviderContractAgentDriverOptionsV1) {
    if (!SOURCE_COMMIT.test(options.source_commit)) {
      throw new ProviderContractRoutingError('provider source commit is invalid')
    }
    if (!CONFIGURATION_FINGERPRINT.test(options.configuration_fingerprint)) {
      throw new ProviderContractRoutingError(
        'provider configuration fingerprint is invalid',
      )
    }
    this.#selection = selectProviderExecutionV1(options.adapter.manifest)
    if (this.#selection.billing_mode !== 'personal_subscription') {
      throw new ProviderContractRoutingError(
        'provider contract AgentDriver v1 only routes personal subscriptions',
      )
    }
    this.id = this.#selection.provider_id
    this.#environment = { ...(options.environment ?? process.env) }
    this.#executionScope = options.execution_scope ?? 'managed_background'
    this.#eventBufferSize = options.event_buffer_size ?? 4_096
    if (!Number.isInteger(this.#eventBufferSize) || this.#eventBufferSize < 1) {
      throw new ProviderContractRoutingError(
        'provider event buffer size must be a positive integer',
      )
    }
  }

  capabilities(): DriverCapabilities {
    const supported = (capability: ProviderCapabilityId): boolean =>
      supportedCapability(this.#selection, this.options.adapter, capability)
    return {
      attach: false,
      streaming: supported('structured_events'),
      interrupt: supported('interrupt'),
      stop: supported('stop'),
      rawTerminal: false,
      resume: supported('resume') && supported('restart_recovery'),
      // TOOL-013 v1 names token-budget support but does not seal an amount.
      tokenBudget: false,
      costBudget: supported('cost_budget'),
    }
  }

  async assertSupported(): Promise<ProviderExecutableDiscoveryV1> {
    const discovery = await this.options.adapter.discoverExecutable()
    const registered = this.options.registry.requireSupported(
      this.#selection,
      discovery.version ?? 'unknown',
      discovery.platform ?? 'unknown',
      this.options.source_commit,
    )
    if (registered !== this.options.adapter) {
      throw new ProviderContractRoutingError(
        'provider registry returned a different adapter',
      )
    }
    if (discovery.status !== 'validated') {
      throw new ProviderContractRoutingError(
        'provider executable is not validated',
        [discovery.status],
      )
    }
    return discovery
  }

  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    if (!request.prompt?.trim()) {
      throw new ProviderContractRoutingError('provider launch prompt is required')
    }
    if (request.taskBudgetTokens !== undefined) {
      throw new ProviderContractRoutingError(
        'provider contract v1 cannot seal a token-budget amount',
      )
    }
    const actionId = `launch-${randomUUID()}`
    const action: Extract<ProviderActionV1, { kind: 'launch' }> = {
      contract_version: 1,
      kind: 'launch',
      action_id: actionId,
      scope_id: request.workspaceId,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? null,
      effort: request.effort ?? null,
      access_profile: request.accessProfile ?? 'workspace_write',
      cost_limit: costLimit(request),
    }
    const required: ProviderCapabilityId[] = [
      'launch',
      'structured_events',
      'interrupt',
      'stop',
      'access_profile',
      ...(request.model ? ['model_selection' as const] : []),
      ...(request.effort ? ['effort' as const] : []),
      ...(request.maxBudgetUsd !== undefined ? ['cost_budget' as const] : []),
    ]
    const authorization = await this.authorize(action, required, request.env)
    const staged = await this.options.launchRequests.stage(
      actionId,
      request,
      () => this.options.adapter.launch({ authorization }),
    )
    if (!staged.request_consumed) {
      await this.options.adapter.stop(staged.value.session_id).catch(() => undefined)
      throw new ProviderContractRoutingError(
        'provider adapter did not consume its staged AgentDriver request',
      )
    }
    const providerSession = staged.value
    return this.registerSession(providerSession, request, actionId)
  }

  async attach(): Promise<DriverSession | null> {
    return null
  }

  async recover(request: DriverRecoveryRequest): Promise<DriverSession | null> {
    if (request.taskBudgetTokens !== undefined) {
      throw new ProviderContractRoutingError(
        'provider contract v1 cannot seal a token-budget amount',
      )
    }
    const actionId = `resume-${randomUUID()}`
    const action: Extract<ProviderActionV1, { kind: 'resume' }> = {
      contract_version: 1,
      kind: 'resume',
      action_id: actionId,
      scope_id: request.workspaceId,
      provider_session_id: request.externalId,
      cwd: request.cwd,
      model: request.model ?? null,
      effort: request.effort ?? null,
      access_profile: request.accessProfile,
      cost_limit: costLimit(request),
    }
    const required: ProviderCapabilityId[] = [
      'resume',
      'restart_recovery',
      'structured_events',
      'interrupt',
      'stop',
      'access_profile',
      ...(request.model ? ['model_selection' as const] : []),
      ...(request.effort ? ['effort' as const] : []),
      ...(request.maxBudgetUsd !== undefined ? ['cost_budget' as const] : []),
    ]
    const authorization = await this.authorize(action, required)
    const providerSession = await this.options.adapter.resume({ authorization })
    return this.registerSession(providerSession, request, actionId)
  }

  async send(sessionId: string, text: string): Promise<void> {
    const state = this.required(sessionId)
    if (!text.trim()) throw new ProviderContractRoutingError('provider follow-up is required')
    state.next_action += 1
    const action: Extract<ProviderActionV1, { kind: 'follow_up' }> = {
      contract_version: 1,
      kind: 'follow_up',
      action_id: `follow-up-${state.next_action}-${randomUUID()}`,
      scope_id: state.driver_session.workspaceId,
      session_id: state.provider_session.session_id,
      prompt: text,
      cost_limit: null,
    }
    await this.options.adapter.followUp({
      authorization: await this.authorize(action, ['follow_up']),
    })
  }

  async interrupt(sessionId: string): Promise<void> {
    this.required(sessionId)
    await this.options.adapter.interrupt(sessionId)
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.required(sessionId)
    if (state.terminal || state.stop_requested) return
    state.stop_requested = true
    try {
      await this.options.adapter.stop(sessionId)
      this.finish(state, 'stopped')
    } catch (error) {
      this.finish(state, 'failed', error)
      throw error
    }
  }

  async resolveApproval(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'allow_session' | 'deny' | 'cancel',
  ): Promise<boolean> {
    this.required(sessionId)
    await this.options.adapter.submitApproval(sessionId, {
      approval_id: requestId,
      decision: decision === 'allow' || decision === 'allow_session'
        ? 'approve'
        : 'reject',
    })
    return true
  }

  events(sessionId: string): AsyncIterable<DriverEvent> {
    const state = this.required(sessionId)
    if (state.event_claimed) {
      throw new ProviderContractRoutingError(
        'provider driver event stream is already claimed',
      )
    }
    state.event_claimed = true
    const sessions = this.#sessions
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const event of state.queue) yield event
        } finally {
          if (state.terminal) sessions.delete(sessionId)
        }
      },
    }
  }

  private registerSession(
    providerSession: ProviderSessionV1,
    request: Pick<
      DriverLaunchRequest,
      'workspaceId' | 'cwd' | 'model' | 'effort' | 'accessProfile' | 'metadata'
    >,
    actionId: string,
  ): DriverSession {
    const driverSession: DriverSession = {
      id: providerSession.session_id,
      externalId: providerSession.provider_session_id,
      driverId: this.id,
      workspaceId: request.workspaceId,
      status: providerSession.status,
      startedAt: new Date().toISOString(),
      metadata: {
        ...(request.metadata ?? {}),
        cwd: request.cwd,
        providerContractVersion: 1,
        providerAdapterId: this.#selection.adapter_id,
        providerModeId: this.#selection.mode_id,
        providerActionId: actionId,
        resolvedModel: providerSession.model?.effective ?? request.model ?? null,
        resolvedEffort: providerSession.effort?.effective ?? request.effort ?? null,
        accessProfile: providerSession.access_profile?.effective
          ?? request.accessProfile
          ?? 'workspace_write',
      },
    }
    const state: ContractDriverSessionV1 = {
      driver_session: driverSession,
      provider_session: providerSession,
      selection: this.#selection,
      queue: new BoundedAsyncQueue(this.#eventBufferSize),
      next_sequence: 0,
      next_action: 0,
      event_claimed: false,
      terminal: false,
      stop_requested: false,
    }
    this.#sessions.set(driverSession.id, state)
    void this.pump(state)
    return structuredClone(driverSession)
  }

  private async authorize(
    action: ProviderActionV1,
    requiredCapabilities: readonly ProviderCapabilityId[],
    environmentOverrides?: NodeJS.ProcessEnv,
  ): Promise<AuthorizedProviderLaunchV1> {
    const discovery = await this.assertSupported()
    const intent = defineProviderExecutionIntentV1({
      selection: this.#selection,
      execution_scope: this.#executionScope,
      usage_priced_api: defineProviderNoCostConsentV1(),
      provider_managed_overage: defineProviderNoCostConsentV1(),
      required_capabilities: [...new Set(requiredCapabilities)],
    })
    const environment = this.options.adapter.prepareEnvironment(
      intent,
      this.#environment,
      {
        on_conflict: 'reject',
        ...(environmentOverrides ? { overrides: environmentOverrides } : {}),
      },
    )
    const boundary = defineProviderLaunchBoundaryV1(
      this.options.adapter.manifest,
      discovery,
      this.options.configuration_fingerprint,
      environment,
    )
    const readiness = await this.options.adapter.probeReadiness(intent, boundary)
    const result = authorizeProviderLaunchV1(
      this.options.adapter.manifest,
      intent,
      readiness,
      boundary,
      action,
    )
    if (!result.ready) {
      throw new ProviderContractRoutingError(
        'provider action was not authorized',
        result.blockers,
      )
    }
    return result.authorization
  }

  private required(sessionId: string): ContractDriverSessionV1 {
    const state = this.#sessions.get(sessionId)
    if (!state || state.terminal) {
      throw new ProviderContractRoutingError(
        'provider driver session is not active',
      )
    }
    return state
  }

  private enqueue(
    state: ContractDriverSessionV1,
    event: DriverEvent,
  ): void {
    state.next_sequence = Math.max(state.next_sequence + 1, event.seq)
    const retained = state.queue.push({
      ...event,
      seq: state.next_sequence,
    })
    if (!retained) {
      throw new ProviderContractRoutingError(
        'provider driver event buffer overflow',
      )
    }
  }

  private finish(
    state: ContractDriverSessionV1,
    status: 'stopped' | 'failed' | 'lost',
    error?: unknown,
  ): void {
    if (state.terminal) return
    state.terminal = true
    state.driver_session.status = status
    try {
      this.enqueue(state, {
        sessionId: state.driver_session.id,
        seq: state.next_sequence + 1,
        type: 'exit',
        at: new Date().toISOString(),
        data: error instanceof Error
          ? `provider session ${status}: ${error.message}`
          : `provider session ${status}`,
        metadata: {
          providerContractVersion: 1,
          providerStatus: status,
          exitCode: status === 'stopped' ? 0 : 1,
        },
      })
      state.queue.close()
    } catch (queueError) {
      state.queue.close(queueError)
    }
  }

  private async pump(state: ContractDriverSessionV1): Promise<void> {
    try {
      for await (const providerEvent of this.options.adapter.events(
        state.provider_session.session_id,
      )) {
        const event = mappedProviderEvent(
          providerEvent,
          state.driver_session.id,
        )
        if (event.type === 'exit') {
          const status = providerEvent.kind === 'status'
            && terminalStatus(providerEvent.status)
            ? providerEvent.status
            : 'lost'
          this.finish(state, status)
          return
        }
        this.enqueue(state, event)
      }
      if (!state.stop_requested) this.finish(state, 'lost')
    } catch (error) {
      if (!state.stop_requested) this.finish(state, 'failed', error)
    }
  }
}

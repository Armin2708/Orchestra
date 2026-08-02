import type {
  ProviderApprovalDecisionV1,
  ProviderAuthorizedLaunchContextV1,
  ProviderEventStreamContextV1,
  ProviderEventV1,
  ProviderExecutableDiscoveryV1,
  ProviderExecutionAdapterV1,
  ProviderExecutionIntentV1,
  ProviderExecutionSelectionV1,
  ProviderManifestV1,
  ProviderModelV1,
  ProviderReadinessV1,
  ProviderSessionV1,
  ProviderUsageV1,
} from '../../provider-contract.js'
import {
  defineProviderExecutionAdapterV1,
  defineProviderManifestV1,
} from '../../provider-contract.js'
import type {
  AgentDriver,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
  MaybePromise,
} from '../types.js'

export type AgentDriverProviderSessionEvidenceV1 = {
  effective_model: string
  effective_effort: string | null
  effective_access_profile: 'read_only' | 'workspace_write' | 'full_access'
}

export type AgentDriverProviderSessionContextV1 = {
  assigned_session_id: string
  driver_session: DriverSession
  selection: Readonly<ProviderExecutionSelectionV1>
  action_id: string
  scope_id: string
}

export type AgentDriverProviderEventProjectionContextV1 =
  AgentDriverProviderSessionContextV1 & {
    sequence: number
  }

export type AgentDriverProviderAdapterOptionsV1 = {
  manifest: ProviderManifestV1
  driver: AgentDriver
  discoverExecutable(): MaybePromise<ProviderExecutableDiscoveryV1>
  probeReadiness(
    intent: Readonly<ProviderExecutionIntentV1>,
    boundary: Parameters<
      ProviderExecutionAdapterV1['probeReadiness']
    >[1],
  ): MaybePromise<ProviderReadinessV1>
  listModels(
    intent: Readonly<ProviderExecutionIntentV1>,
  ): MaybePromise<readonly ProviderModelV1[]>
  launchRequest(
    context: ProviderAuthorizedLaunchContextV1,
  ): MaybePromise<DriverLaunchRequest>
  resume?(
    context: ProviderAuthorizedLaunchContextV1,
  ): MaybePromise<DriverSession>
  sessionEvidence(
    context: ProviderAuthorizedLaunchContextV1,
    session: DriverSession,
  ): MaybePromise<AgentDriverProviderSessionEvidenceV1>
  fork?(
    context: ProviderAuthorizedLaunchContextV1,
    parent: DriverSession,
  ): MaybePromise<DriverSession>
  submitApproval?(
    context: AgentDriverProviderSessionContextV1,
    decision: Readonly<ProviderApprovalDecisionV1>,
  ): MaybePromise<void>
  projectEvent?(
    event: DriverEvent,
    context: AgentDriverProviderEventProjectionContextV1,
  ): MaybePromise<ProviderEventV1 | null>
  usage?(
    context: AgentDriverProviderSessionContextV1,
  ): MaybePromise<ProviderUsageV1>
}

type BridgeSessionStateV1 = {
  driver_session: DriverSession
  selection: Readonly<ProviderExecutionSelectionV1>
  action_id: string
  scope_id: string
  sequence: number
}

const stringMetadata = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null => {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const approvalMetadata = (
  metadata: Record<string, unknown> | undefined,
): {
  approval_id: string
  approval_kind: Extract<ProviderEventV1, { kind: 'approval' }>['approval_kind']
} | null => {
  if (metadata?.approval !== true) return null
  const request = metadata.approvalRequest
  const row = request && typeof request === 'object' && !Array.isArray(request)
    ? request as Record<string, unknown>
    : {}
  const requestId = row.requestId
  const approvalId = typeof requestId === 'string' || typeof requestId === 'number'
    ? String(requestId).trim()
    : ''
  if (!approvalId) return null
  const rawKind = typeof row.kind === 'string' ? row.kind : ''
  const approvalKind = rawKind === 'command'
    ? 'command'
    : rawKind === 'file-change'
      ? 'file_change'
      : rawKind === 'tool' || rawKind === 'user-input' || rawKind === 'mcp-elicitation'
        ? 'tool'
        : 'other'
  return { approval_id: approvalId, approval_kind: approvalKind }
}

const defaultProviderEvent = (
  event: DriverEvent,
  context: AgentDriverProviderEventProjectionContextV1,
): ProviderEventV1 => {
  const base = {
    event_id: `driver-event-${context.sequence}`,
    turn_id: stringMetadata(event.metadata, 'turnId') ?? context.action_id,
    session_id: context.assigned_session_id,
    sequence: context.sequence,
    observed_at: event.at,
  }
  const approval = approvalMetadata(event.metadata)
  if (approval) {
    return {
      kind: 'approval',
      ...base,
      ...approval,
      status: 'requested',
      safe_summary: event.data || 'Provider approval requested',
    }
  }
  if (event.type === 'exit') {
    return {
      kind: 'status',
      ...base,
      status: 'stopped',
    }
  }
  if (event.type === 'error') {
    return {
      kind: 'error',
      ...base,
      code: stringMetadata(event.metadata, 'code') ?? 'provider_driver_error',
      safe_message: event.data || 'Provider driver failed',
    }
  }
  if (event.type === 'tool') {
    const nativeMethod = stringMetadata(event.metadata, 'nativeMethod')
      ?? stringMetadata(event.metadata, 'method')
    return {
      kind: 'tool',
      ...base,
      tool_call_id: stringMetadata(event.metadata, 'itemId') ?? `driver-tool-${context.sequence}`,
      tool_name: stringMetadata(event.metadata, 'toolName') ?? 'provider_tool',
      phase: nativeMethod?.includes('completed')
        ? 'completed'
        : nativeMethod?.includes('failed')
          ? 'failed'
          : 'started',
      safe_summary: event.data || null,
    }
  }
  return {
    kind: 'output',
    ...base,
    safe_text: event.data,
  }
}

const assertCapabilityAlignment = (
  options: AgentDriverProviderAdapterOptionsV1,
): void => {
  if (options.driver.id !== options.manifest.provider_id) {
    throw new Error('provider manifest and driver identities do not match')
  }
  const capabilities = options.driver.capabilities()
  const supported = new Set(
    options.manifest.modes.flatMap((mode) =>
      Object.entries(mode.capabilities)
        .filter(([, support]) => support.state === 'supported')
        .map(([capability]) => capability)),
  )
  const requireDriver = (capability: string, available: boolean): void => {
    if (supported.has(capability) && !available) {
      throw new Error(`driver does not implement declared provider capability: ${capability}`)
    }
  }
  requireDriver('interrupt', capabilities.interrupt)
  requireDriver('cancel', capabilities.interrupt)
  requireDriver('stop', capabilities.stop)
  requireDriver('structured_events', capabilities.streaming)
  requireDriver('token_budget', capabilities.tokenBudget === true)
  requireDriver('cost_budget', capabilities.costBudget === true)
  requireDriver(
    'resume',
    capabilities.resume && typeof options.resume === 'function',
  )
  requireDriver(
    'restart_recovery',
    capabilities.resume && typeof options.resume === 'function',
  )
  requireDriver('fork', typeof options.fork === 'function')
  requireDriver('approvals', typeof options.submitApproval === 'function')
  requireDriver('usage', typeof options.usage === 'function')
}

const safeLaunchRequest = (
  requested: DriverLaunchRequest,
  context: ProviderAuthorizedLaunchContextV1,
): DriverLaunchRequest => {
  if (context.action.kind !== 'launch') throw new Error('provider launch action is required')
  if (context.action.cost_limit !== null
    && context.action.cost_limit.currency !== 'USD') {
    throw new Error('AgentDriver cost budgets require USD authorization')
  }
  const permissionMode = context.action.access_profile === 'read_only'
    ? 'plan'
    : context.action.access_profile === 'workspace_write'
      ? 'acceptEdits'
      : 'bypassPermissions'
  return {
    ...requested,
    cwd: context.action.cwd,
    prompt: context.action.prompt,
    env: { ...context.environment },
    externalId: undefined,
    model: context.action.model ?? undefined,
    effort: context.action.effort ?? undefined,
    accessProfile: context.action.access_profile,
    permissionMode,
    maxBudgetUsd: context.action.cost_limit === null
      ? undefined
      : context.action.cost_limit.max_cost_minor_units / 100,
    metadata: {
      ...(requested.metadata ?? {}),
      providerContractVersion: 1,
      providerId: context.intent.selection.provider_id,
      providerAdapterId: context.intent.selection.adapter_id,
      providerModeId: context.intent.selection.mode_id,
      providerActionId: context.action.action_id,
      providerScopeId: context.action.scope_id,
      providerBillingMode: context.intent.selection.billing_mode,
      providerCredentialKind: context.intent.selection.credential_kind,
    },
  }
}

const sessionContext = (
  assignedSessionId: string,
  state: BridgeSessionStateV1,
): AgentDriverProviderSessionContextV1 => ({
  assigned_session_id: assignedSessionId,
  driver_session: state.driver_session,
  selection: state.selection,
  action_id: state.action_id,
  scope_id: state.scope_id,
})

const validateDriverSession = (
  driver: AgentDriver,
  session: DriverSession,
  expectedWorkspaceId?: string,
): void => {
  if (!session.id.trim()
    || !session.externalId.trim()
    || session.driverId !== driver.id
    || (expectedWorkspaceId !== undefined && session.workspaceId !== expectedWorkspaceId)) {
    throw new Error('provider driver returned an invalid session')
  }
}

const providerSession = async (
  options: AgentDriverProviderAdapterOptionsV1,
  context: ProviderAuthorizedLaunchContextV1,
  session: DriverSession,
): Promise<ProviderSessionV1> => {
  const evidence = await options.sessionEvidence(context, session)
  if (!evidence.effective_model.trim()) {
    throw new Error('provider driver did not resolve an effective model')
  }
  if (context.action.kind !== 'launch'
    && context.action.kind !== 'resume'
    && context.action.kind !== 'fork') {
    throw new Error('provider session creation action is required')
  }
  return {
    contract_version: 1,
    session_id: context.assigned_session_id,
    provider_session_id: session.externalId,
    selection: context.intent.selection,
    status: session.status,
    model: {
      requested: context.action.model,
      effective: evidence.effective_model,
    },
    effort: context.action.effort === null
      ? null
      : {
          requested: context.action.effort,
          effective: evidence.effective_effort,
        },
    access_profile: {
      requested: context.action.access_profile,
      effective: evidence.effective_access_profile,
    },
  }
}

export function defineAgentDriverProviderAdapterV1(
  input: AgentDriverProviderAdapterOptionsV1,
): ProviderExecutionAdapterV1 {
  const options: AgentDriverProviderAdapterOptionsV1 = {
    ...input,
    manifest: defineProviderManifestV1(input.manifest) as ProviderManifestV1,
  }
  assertCapabilityAlignment(options)
  const states = new Map<string, BridgeSessionStateV1>()
  const required = (sessionId: string): BridgeSessionStateV1 => {
    const state = states.get(sessionId)
    if (!state) throw new Error('provider driver session is not attached')
    return state
  }
  const register = (
    context: ProviderAuthorizedLaunchContextV1,
    session: DriverSession,
  ): BridgeSessionStateV1 => {
    if (states.has(context.assigned_session_id)) {
      throw new Error('provider driver session identity is already registered')
    }
    const state = {
      driver_session: session,
      selection: context.intent.selection,
      action_id: context.action.action_id,
      scope_id: context.action.scope_id,
      sequence: 0,
    }
    states.set(context.assigned_session_id, state)
    return state
  }

  return defineProviderExecutionAdapterV1({
    contract_version: 1,
    manifest: options.manifest,
    async discoverExecutable() {
      return options.discoverExecutable()
    },
    async probeReadiness(intent, boundary) {
      return options.probeReadiness(intent, boundary)
    },
    async listModels(intent) {
      return options.listModels(intent)
    },
    async launch(context) {
      const request = safeLaunchRequest(
        await options.launchRequest(context),
        context,
      )
      const session = await options.driver.launch(request)
      register(context, session)
      validateDriverSession(options.driver, session, request.workspaceId)
      return providerSession(options, context, session)
    },
    async resume(context) {
      if (context.action.kind !== 'resume' || !options.resume) {
        throw new Error('provider resume is unsupported')
      }
      const session = await options.resume(context)
      register(context, session)
      validateDriverSession(
        options.driver,
        session,
        context.action.scope_id,
      )
      return providerSession(options, context, session)
    },
    async followUp(context) {
      if (context.action.kind !== 'follow_up') {
        throw new Error('provider follow-up action is required')
      }
      const state = required(context.assigned_session_id)
      await options.driver.send(state.driver_session.id, context.action.prompt)
      state.action_id = context.action.action_id
      state.scope_id = context.action.scope_id
    },
    async fork(context) {
      if (context.action.kind !== 'fork' || !options.fork) {
        throw new Error('provider fork is unsupported')
      }
      const parent = required(context.action.session_id)
      const child = await options.fork(context, parent.driver_session)
      register(context, child)
      validateDriverSession(options.driver, child)
      return providerSession(options, context, child)
    },
    async interrupt(sessionId) {
      const state = required(sessionId)
      await options.driver.interrupt(state.driver_session.id)
    },
    async cancel(sessionId) {
      const state = required(sessionId)
      if (!options.driver.cancel) {
        throw new Error('provider driver does not expose native cancellation')
      }
      await options.driver.cancel(state.driver_session.id)
      states.delete(sessionId)
    },
    async stop(sessionId) {
      const state = required(sessionId)
      await options.driver.stop(state.driver_session.id)
      states.delete(sessionId)
    },
    async submitApproval(sessionId, decision) {
      const state = required(sessionId)
      if (!options.submitApproval) throw new Error('provider approvals are unsupported')
      await options.submitApproval(sessionContext(sessionId, state), decision)
    },
    async *events(sessionId, streamContext: ProviderEventStreamContextV1) {
      const state = required(sessionId)
      const iterator = options.driver.events(state.driver_session.id)[Symbol.asyncIterator]()
      let terminal = false
      let returned = false
      const close = async (): Promise<void> => {
        if (returned) return
        returned = true
        await iterator.return?.()
      }
      const onAbort = (): void => {
        void close().catch(() => undefined)
      }
      streamContext.signal.addEventListener('abort', onAbort, { once: true })
      try {
        while (!streamContext.signal.aborted) {
          const next = await iterator.next()
          if (next.done || streamContext.signal.aborted) return
          const sequence = state.sequence + 1
          const context = {
            ...sessionContext(sessionId, state),
            sequence,
          }
          const projected = options.projectEvent
            ? await options.projectEvent(next.value, context)
            : defaultProviderEvent(next.value, context)
          if (projected === null) continue
          state.sequence = sequence
          terminal = projected.kind === 'status'
            && ['stopped', 'failed', 'lost'].includes(projected.status)
          yield projected
          if (terminal) return
        }
      } finally {
        streamContext.signal.removeEventListener('abort', onAbort)
        await close().catch(() => undefined)
        if (terminal) states.delete(sessionId)
      }
    },
    async usage(sessionId) {
      const state = required(sessionId)
      if (!options.usage) throw new Error('provider usage is unsupported')
      return options.usage(sessionContext(sessionId, state))
    },
  })
}

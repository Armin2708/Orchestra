import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
} from 'node:fs'
import {
  delimiter,
  isAbsolute,
  join,
} from 'node:path'
import {
  CODEX_PROVIDER_MANIFEST_V1,
} from '../../provider-manifests.js'
import type {
  ProviderAuthorizedLaunchContextV1,
  ProviderEventV1,
  ProviderExecutableDiscoveryV1,
  ProviderExecutionAdapterV1,
  ProviderReadinessV1,
  ProviderUsageV1,
  ProviderUsageWindowV1,
} from '../../provider-contract.js'
import { classifyCodexCliVersion } from '../../environment-compatibility.js'
import type {
  CodexAccountResponse,
  CodexModel,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexRateLimitsResponse,
} from '../../codex/protocol.js'
import type { CodexRuntimeService } from '../../codex/service.js'
import type {
  CodexApprovalDecision,
  CodexSessionForkOptions,
  CodexSessionForkResult,
  CodexSessionUpdate,
} from './codex.js'
import {
  defineAgentDriverProviderAdapterV1,
  type AgentDriverProviderEventProjectionContextV1,
  type AgentDriverProviderSessionContextV1,
} from './provider-adapter.js'
import type {
  AgentDriver,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
  MaybePromise,
} from '../types.js'

const CODEX_PROTOCOL_SCHEMA_SHA256_V1 =
  'd64c8fbadf596041d29fc39a9ed6fb41c2e6eb0ecd70f03c9b544f7f99cb8b2b'

export const CODEX_PROTOCOL_CONFIGURATION_FINGERPRINT_V1 =
  `sha256:${CODEX_PROTOCOL_SCHEMA_SHA256_V1}` as const

type CodexProviderRuntimePortV1 = Pick<
  CodexRuntimeService,
  'listModels' | 'readAccount' | 'readRateLimits' | 'readUsage'
>

export type CodexProviderDriverPortV1 = AgentDriver & {
  detach(sessionId: string): Promise<void>
  updateSession(
    sessionId: string,
    patch: CodexSessionUpdate,
  ): Promise<void>
  forkSession(
    sessionId: string,
    options: CodexSessionForkOptions,
  ): Promise<CodexSessionForkResult>
  resolveApproval(
    sessionId: string,
    requestId: string,
    decision: CodexApprovalDecision,
  ): Promise<boolean>
}

export type CodexProviderAdapterOptionsV1 = {
  driver: CodexProviderDriverPortV1
  service: CodexProviderRuntimePortV1
  command?: string
  environment?: NodeJS.ProcessEnv
  platform?: string
  now?: () => Date
  resolveExecutable?(
    command: string,
    environment: NodeJS.ProcessEnv,
  ): string | null
  readExecutable?(resolvedPath: string): Uint8Array
  readVersion?(resolvedPath: string): string | null
  launchRequest?(
    context: ProviderAuthorizedLaunchContextV1,
  ): MaybePromise<DriverLaunchRequest>
  resolveForkTarget?(
    scopeId: string,
  ): MaybePromise<{ workspaceId: string; cwd: string } | null>
  resolveRecoveryTarget?(
    scopeId: string,
  ): MaybePromise<{ workspaceId: string; cwd: string } | null>
}

const sha256 = (value: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const executableCandidates = (
  command: string,
  environment: NodeJS.ProcessEnv,
): string[] => {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return [command]
  }
  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .filter(Boolean)
    : ['']
  return (environment.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) =>
      join(directory, `${command}${extension}`)))
}

const resolveExecutable = (
  command: string,
  environment: NodeJS.ProcessEnv,
): string | null => {
  for (const candidate of executableCandidates(command, environment)) {
    try {
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {
      // Continue through the explicit PATH candidates.
    }
  }
  return null
}

const readVersion = (resolvedPath: string): string | null => {
  try {
    const output = execFileSync(resolvedPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      windowsHide: true,
    }).trim()
    return output ? output.slice(0, 200) : null
  } catch {
    return null
  }
}

const metadataString = (
  metadata: Record<string, unknown>,
  key: string,
): string | null => {
  const value = metadata[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const finitePercent = (value: unknown): number | null => {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(100, Math.max(0, number))
}

const resetTimestamp = (value: unknown): string | null => {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const timestamp = new Date(seconds * 1_000)
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null
}

const usageWindow = (
  window: CodexRateLimitWindow | null | undefined,
): ProviderUsageWindowV1 | null => window
  ? {
      kind: 'rolling',
      used_percent: finitePercent(window.usedPercent),
      resets_at: resetTimestamp(window.resetsAt),
    }
  : null

const rateLimitSnapshots = (
  response: CodexRateLimitsResponse,
): CodexRateLimitSnapshot[] => {
  const values = response.rateLimitsByLimitId
    ? Object.values(response.rateLimitsByLimitId)
    : [response.rateLimits]
  return values.filter((value): value is CodexRateLimitSnapshot =>
    Boolean(value && typeof value === 'object'))
}

const rateLimitWindows = (
  response: CodexRateLimitsResponse,
): ProviderUsageWindowV1[] => rateLimitSnapshots(response)
  .flatMap((snapshot) => [
    usageWindow(snapshot.primary),
    usageWindow(snapshot.secondary),
  ])
  .filter((window): window is ProviderUsageWindowV1 => window !== null)

const exhausted = (response: CodexRateLimitsResponse): boolean =>
  rateLimitSnapshots(response).some((snapshot) =>
    snapshot.rateLimitReachedType != null
    || finitePercent(snapshot.primary?.usedPercent) === 100
    || finitePercent(snapshot.secondary?.usedPercent) === 100)

const providerUsage = async (
  service: CodexProviderRuntimePortV1,
  context: AgentDriverProviderSessionContextV1,
  observedAt: string,
): Promise<ProviderUsageV1> => {
  try {
    const [limits] = await Promise.all([
      service.readRateLimits(),
      service.readUsage(),
    ])
    const isExhausted = exhausted(limits)
    return {
      contract_version: 1,
      observed_at: observedAt,
      selection: context.selection,
      action_id: context.action_id,
      scope_id: context.scope_id,
      billing_mode: context.selection.billing_mode,
      status: isExhausted ? 'exhausted' : 'available',
      overage_status: isExhausted ? 'exhausted' : 'not_applicable',
      windows: rateLimitWindows(limits),
      metered_cost: null,
    }
  } catch {
    return {
      contract_version: 1,
      observed_at: observedAt,
      selection: context.selection,
      action_id: context.action_id,
      scope_id: context.scope_id,
      billing_mode: context.selection.billing_mode,
      status: 'unavailable',
      overage_status: 'unknown',
      windows: [],
      metered_cost: null,
    }
  }
}

const authStatus = (
  account: CodexAccountResponse | null,
): ProviderReadinessV1['auth_status'] => {
  if (account === null) return 'unknown'
  if (account.account === null) return 'signed_out'
  return account.account.type === 'chatgpt' ? 'ready' : 'credential_conflict'
}

const approval = (
  event: DriverEvent,
): {
  approval_id: string
  approval_kind: Extract<ProviderEventV1, { kind: 'approval' }>['approval_kind']
} | null => {
  if (event.metadata?.approval !== true) return null
  const request = event.metadata.approvalRequest
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const row = request as Record<string, unknown>
  const approvalId = String(row.requestId ?? '').trim()
  if (!approvalId) return null
  const kind = String(row.kind ?? '')
  return {
    approval_id: approvalId,
    approval_kind: kind === 'command'
      ? 'command'
      : kind === 'file-change'
        ? 'file_change'
        : ['permissions', 'user-input', 'mcp-elicitation'].includes(kind)
          ? 'tool'
          : 'other',
  }
}

const projectEvent = (
  event: DriverEvent,
  context: AgentDriverProviderEventProjectionContextV1,
): ProviderEventV1 | null => {
  if (event.metadata?.kind === 'reasoning') return null
  const base = {
    event_id: `codex-driver-event-${context.sequence}`,
    turn_id: metadataString(event.metadata ?? {}, 'turnId')
      ?? context.action_id,
    session_id: context.assigned_session_id,
    sequence: context.sequence,
    observed_at: event.at,
  }
  const requestedApproval = approval(event)
  if (requestedApproval) {
    return {
      kind: 'approval',
      ...base,
      ...requestedApproval,
      status: 'requested',
      safe_summary: event.data || 'Codex approval requested',
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
      code: metadataString(event.metadata ?? {}, 'code') ?? 'codex_driver_error',
      safe_message: event.data || 'Codex driver failed',
    }
  }
  if (event.type === 'status') {
    return {
      kind: 'status',
      ...base,
      status: event.metadata?.turnCompleted === true
        ? 'idle'
        : context.driver_session.status,
    }
  }
  if (event.type === 'tool') {
    const nativeMethod = metadataString(event.metadata ?? {}, 'nativeMethod')
      ?? metadataString(event.metadata ?? {}, 'method')
    return {
      kind: 'tool',
      ...base,
      tool_call_id: metadataString(event.metadata ?? {}, 'itemId')
        ?? `codex-tool-${context.sequence}`,
      tool_name: metadataString(event.metadata ?? {}, 'toolName')
        ?? nativeMethod
        ?? 'codex_tool',
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

const model = (value: CodexModel) => ({
  id: value.model || value.id,
  display_name: value.displayName || value.model || value.id,
  is_default: value.isDefault === true,
  supports_effort: value.supportedReasoningEfforts.length > 0,
  effort_levels: value.supportedReasoningEfforts
    .map((effort) => effort.reasoningEffort)
    .filter((effort) => typeof effort === 'string' && effort.trim())
    .map((effort) => effort.trim()),
})

export function createCodexProviderAdapterV1(
  options: CodexProviderAdapterOptionsV1,
): ProviderExecutionAdapterV1 {
  const environment = options.environment ?? process.env
  const command = options.command?.trim()
    || environment.ORCHESTRA_CODEX_COMMAND?.trim()
    || CODEX_PROVIDER_MANIFEST_V1.executable.command
  const platform = options.platform ?? `${process.platform}-${process.arch}`
  const now = options.now ?? (() => new Date())
  const executableResolver = options.resolveExecutable ?? resolveExecutable
  const executableReader = options.readExecutable ?? readFileSync
  const versionReader = options.readVersion ?? readVersion

  return defineAgentDriverProviderAdapterV1({
    manifest: CODEX_PROVIDER_MANIFEST_V1,
    driver: options.driver,
    async discoverExecutable(): Promise<ProviderExecutableDiscoveryV1> {
      const resolvedPath = executableResolver(command, environment)
      const rawVersion = resolvedPath ? versionReader(resolvedPath) : null
      const compatibility = classifyCodexCliVersion(rawVersion)
      let executableFingerprint = sha256([
        'codex-executable-v1',
        command,
        resolvedPath ?? 'missing',
        compatibility.actual ?? 'unknown',
        platform,
      ].join('\u0000'))
      let status: ProviderExecutableDiscoveryV1['status'] = resolvedPath
        ? compatibility.status === 'validated'
          && CODEX_PROVIDER_MANIFEST_V1.executable.supported_platforms.includes(platform)
          ? 'validated'
          : 'incompatible'
        : 'missing'
      if (resolvedPath) {
        try {
          executableFingerprint = sha256(executableReader(resolvedPath))
        } catch {
          status = 'untrusted'
        }
      }
      return {
        contract_version: 1,
        provider_id: CODEX_PROVIDER_MANIFEST_V1.provider_id,
        adapter_id: CODEX_PROVIDER_MANIFEST_V1.adapter_id,
        status,
        source: command === CODEX_PROVIDER_MANIFEST_V1.executable.command
          ? 'path'
          : 'environment_override',
        version: compatibility.actual,
        platform,
        resolved_path: resolvedPath,
        executable_fingerprint: executableFingerprint,
      }
    },
    async probeReadiness(intent, boundary) {
      let account: CodexAccountResponse | null = null
      try {
        account = await options.service.readAccount(false)
      } catch {
        // Unknown is fail-closed by the provider contract.
      }
      let isExhausted = false
      try {
        isExhausted = exhausted(await options.service.readRateLimits())
      } catch {
        // Quota visibility is reported by usage; the no-overage mode remains fail-closed.
      }
      return {
        contract_version: 1,
        observed_at: now().toISOString(),
        selection: intent.selection,
        executable_status: boundary.evidence.executable_status,
        auth_status: authStatus(account),
        automation_policy: 'allowed',
        overage_status: isExhausted ? 'exhausted' : 'not_applicable',
        overage_consent: 'not_required',
        metering_status: 'not_required',
        cost_cap_status: 'not_required',
        executable_fingerprint: boundary.evidence.executable_fingerprint,
        environment_fingerprint: boundary.evidence.environment_fingerprint,
        configuration_fingerprint: boundary.evidence.configuration_fingerprint,
      }
    },
    async listModels() {
      return (await options.service.listModels()).map(model)
    },
    async launchRequest(context) {
      if (context.action.kind !== 'launch') {
        throw new Error('Codex provider launch action is required')
      }
      return options.launchRequest
        ? options.launchRequest(context)
        : {
            workspaceId: context.action.scope_id,
            cwd: context.action.cwd,
            prompt: context.action.prompt,
            metadata: {
              ...(context.action.effort
                ? { effort: context.action.effort }
                : {}),
            },
          }
    },
    async resume(context): Promise<DriverSession> {
      if (context.action.kind !== 'resume') {
        throw new Error('Codex provider resume action is required')
      }
      const target = await options.resolveRecoveryTarget?.(
        context.action.scope_id,
      )
      if (!target
        || target.workspaceId !== context.action.scope_id
        || target.cwd !== context.action.cwd
        || !target.cwd.trim()) {
        throw new Error('Codex provider recovery target is not authorized')
      }
      const session = await options.driver.attach(
        context.action.provider_session_id,
      )
      if (!session) throw new Error('Codex provider session is no longer live')
      try {
        if (session.externalId !== context.action.provider_session_id
          || session.workspaceId !== target.workspaceId
          || metadataString(session.metadata, 'cwd') !== target.cwd) {
          throw new Error('Codex provider recovery binding is inconsistent')
        }
        await options.driver.updateSession(session.id, {
          ...(context.action.model
            ? { model: context.action.model }
            : {}),
          ...(context.action.effort
            ? { effort: context.action.effort }
            : {}),
          accessProfile: context.action.access_profile,
        })
        return session
      } catch (error) {
        await options.driver.detach(session.id).catch(() => undefined)
        throw error
      }
    },
    async sessionEvidence(context, session) {
      if (context.action.kind !== 'launch'
        && context.action.kind !== 'resume'
        && context.action.kind !== 'fork') {
        throw new Error('Codex session evidence requires a creating action')
      }
      const metadata = session.metadata
      let effectiveModel = metadataString(metadata, 'resolvedModel')
        ?? metadataString(metadata, 'model')
        ?? context.action.model
      if (!effectiveModel) {
        const models = (await options.service.listModels()).map(model)
        effectiveModel = models.find((candidate) => candidate.is_default)?.id
          ?? models[0]?.id
          ?? null
      }
      if (!effectiveModel) throw new Error('Codex did not resolve an effective model')
      const effectiveAccess = metadataString(metadata, 'accessProfile')
      return {
        effective_model: effectiveModel,
        effective_effort: context.action.effort === null
          ? null
          : metadataString(metadata, 'resolvedEffort')
            ?? metadataString(metadata, 'effort')
            ?? context.action.effort,
        effective_access_profile: effectiveAccess === 'read_only'
          || effectiveAccess === 'workspace_write'
          || effectiveAccess === 'full_access'
          ? effectiveAccess
          : context.action.access_profile,
      }
    },
    async fork(context, parent): Promise<DriverSession> {
      if (context.action.kind !== 'fork') {
        throw new Error('Codex provider fork action is required')
      }
      const target = await options.resolveForkTarget?.(context.action.scope_id)
      if (!target
        || target.workspaceId !== context.action.scope_id
        || !target.cwd.trim()) {
        throw new Error('Codex provider fork target is not authorized')
      }
      const sourceCwd = metadataString(parent.metadata, 'cwd')
      if (!sourceCwd) throw new Error('Codex provider fork source cwd is missing')
      const result = await options.driver.forkSession(parent.id, {
        sourceExternalId: parent.externalId,
        sourceWorkspaceId: parent.workspaceId,
        sourceCwd,
        targetWorkspaceId: target.workspaceId,
        targetCwd: target.cwd,
      })
      const child = await options.driver.attach(result.externalId)
      if (!child
        || child.externalId !== result.externalId
        || child.workspaceId !== target.workspaceId) {
        throw new Error('Codex provider fork child could not be attached safely')
      }
      return child
    },
    async submitApproval(context, decision) {
      const resolved = await options.driver.resolveApproval(
        context.driver_session.id,
        decision.approval_id,
        decision.decision === 'approve' ? 'allow' : 'deny',
      )
      if (!resolved) throw new Error('Codex approval is no longer pending')
    },
    projectEvent,
    async usage(context) {
      return providerUsage(options.service, context, now().toISOString())
    },
  })
}

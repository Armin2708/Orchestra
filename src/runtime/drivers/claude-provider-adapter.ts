import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  defineProviderEventV1,
  type ProviderApprovalDecisionV1,
  type ProviderAuthorizedLaunchContextV1,
  type ProviderEventV1,
  type ProviderExecutableDiscoveryV1,
  type ProviderExecutionAdapterV1,
  type ProviderExecutionIntentV1,
  type ProviderModelV1,
  type ProviderReadinessV1,
  type ProviderUsageV1,
} from '../../provider-contract.js'
import { CLAUDE_PROVIDER_MANIFEST_V1 } from '../../provider-manifests.js'
import { resolveClaudeBundledCliCommand } from '../../readiness-doctor.js'
import type {
  ClaudeSessionForkOptions,
  ClaudeSessionForkResult,
} from './claude.js'
import {
  defineAgentDriverProviderAdapterV1,
  type AgentDriverProviderEventProjectionContextV1,
  type AgentDriverProviderSessionContextV1,
  type AgentDriverProviderSessionEvidenceV1,
} from './provider-adapter.js'
import { fingerprintExecutableFileV1 } from './executable-fingerprint.js'
import type {
  AgentDriver,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
  MaybePromise,
} from '../types.js'

const sha256 = (value: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

export const CLAUDE_PROVIDER_CONFIGURATION_FINGERPRINT_V1 = sha256([
  'claude-provider-adapter-v1',
  CLAUDE_PROVIDER_MANIFEST_V1.adapter_id,
  CLAUDE_PROVIDER_MANIFEST_V1.adapter_version,
  CLAUDE_PROVIDER_MANIFEST_V1.executable.source,
  CLAUDE_PROVIDER_MANIFEST_V1.executable.validated_versions.join(','),
  'claude-agent-sdk:0.3.212',
  'auth-status-json:credential-free',
].join('\u0000'))

export const CLAUDE_PROVIDER_LIFECYCLE_EVIDENCE_V1 = Object.freeze({
  launch: 'driver.launch_after_provider_authorization',
  follow_up: 'driver.send',
  fork: 'driver.forkSession_then_driver.launch',
  interrupt: 'driver.interrupt',
  cancel: 'driver.interrupt',
  stop: 'driver.stop',
  attach: 'unsupported_authorized_attach_not_implemented_v1',
  resume: 'unsupported_durable_resume_not_implemented_v1',
  restart_recovery: 'unsupported_durable_resume_not_implemented_v1',
} as const)

export type ClaudeProviderDriverPortV1 = AgentDriver & {
  forkSession(
    sessionId: string,
    options: ClaudeSessionForkOptions,
  ): Promise<ClaudeSessionForkResult>
}

export type ClaudeProviderAdapterOptionsV1 = {
  driver: ClaudeProviderDriverPortV1
  environment?: NodeJS.ProcessEnv
  platform?: string
  now?: () => Date
  resolveBundledExecutable?(): string | null
  readExecutable?(resolvedPath: string): Uint8Array
  fingerprintExecutable?(resolvedPath: string): string
  readVersion?(
    resolvedPath: string,
    minimalEnvironment: NodeJS.ProcessEnv,
  ): string | null
  probeAuthentication?(
    resolvedPath: string,
    credentialFreeEnvironment: NodeJS.ProcessEnv,
  ): MaybePromise<ProviderReadinessV1['auth_status']>
  listModels(
    intent: Readonly<ProviderExecutionIntentV1>,
  ): MaybePromise<readonly ProviderModelV1[]>
  launchRequest(
    context: ProviderAuthorizedLaunchContextV1,
  ): MaybePromise<DriverLaunchRequest>
  sessionEvidence(
    context: ProviderAuthorizedLaunchContextV1,
    session: DriverSession,
  ): MaybePromise<AgentDriverProviderSessionEvidenceV1>
  forkLaunchRequest(
    context: ProviderAuthorizedLaunchContextV1,
    parent: DriverSession,
    result: ClaudeSessionForkResult,
  ): MaybePromise<DriverLaunchRequest>
  submitApproval(
    context: AgentDriverProviderSessionContextV1,
    decision: Readonly<ProviderApprovalDecisionV1>,
  ): MaybePromise<void>
  usage(
    context: AgentDriverProviderSessionContextV1,
  ): MaybePromise<ProviderUsageV1>
}

type PrivateExecutableObservationV1 = {
  resolvedPath: string | null
  executableFingerprint: string
}

type DriverSessionBindingV1 = {
  workspaceId: string
  cwd: string
}

const readVersion = (
  resolvedPath: string,
  environment: NodeJS.ProcessEnv,
): string | null => {
  try {
    const output = execFileSync(resolvedPath, ['--version'], {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      windowsHide: true,
      maxBuffer: CLAUDE_VERSION_OUTPUT_LIMIT,
    }).trim()
    return output || null
  } catch {
    return null
  }
}

const CLAUDE_VERSION_PATTERN = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/g
const CLAUDE_VERSION_OUTPUT_LIMIT = 200

const exactClaudeVersion = (value: string | null): string | null => {
  if (value === null || value.length > CLAUDE_VERSION_OUTPUT_LIMIT) return null
  const matches = new Set<string>()
  for (const match of value.matchAll(CLAUDE_VERSION_PATTERN)) {
    const version = match[1]
    if (version) matches.add(version)
  }
  return matches.size === 1 ? [...matches][0] ?? null : null
}

const minimalVersionEnvironment = (
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {}
  for (const variable of [
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'WINDIR',
  ]) {
    if (typeof source[variable] === 'string') {
      environment[variable] = source[variable]
    }
  }
  return environment
}

const credentialFreeEnvironment = (
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {}
  for (const variable of [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'CLAUDE_CONFIG_DIR',
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TEMP',
    'TMP',
  ]) {
    if (typeof source[variable] === 'string') {
      environment[variable] = source[variable]
    }
  }
  return environment
}

export const parseClaudeAuthenticationStatusV1 = (
  output: string,
): ProviderReadinessV1['auth_status'] => {
  try {
    const value = JSON.parse(output) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown'
    const row = value as Record<string, unknown>
    if (row.loggedIn === false) return 'signed_out'
    if (row.loggedIn !== true) return 'unknown'
    const authMethod = typeof row.authMethod === 'string'
      ? row.authMethod.trim().toLowerCase()
      : ''
    if (authMethod === 'claude.ai') return 'ready'
    if (/api[\s_-]*key/.test(authMethod)) return 'credential_conflict'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

const probeAuthentication = (
  resolvedPath: string,
  environment: NodeJS.ProcessEnv,
): ProviderReadinessV1['auth_status'] => {
  try {
    const output = execFileSync(
      resolvedPath,
      ['auth', 'status', '--json'],
      {
        encoding: 'utf8',
        env: environment,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3_000,
        windowsHide: true,
      },
    ).trim()
    return parseClaudeAuthenticationStatusV1(output)
  } catch {
    return 'unknown'
  }
}

const validAuthStatus = (
  value: unknown,
): value is ProviderReadinessV1['auth_status'] =>
  typeof value === 'string'
  && [
    'ready',
    'signed_out',
    'expired',
    'revoked',
    'credential_conflict',
    'unknown',
  ].includes(value)

const metadataString = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null => {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const approval = (
  event: DriverEvent,
): {
  approval_id: string
  approval_kind: Extract<
    ProviderEventV1,
    { kind: 'approval' }
  >['approval_kind']
} | null => {
  if (event.metadata?.approval !== true) return null
  const request = event.metadata.approvalRequest
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return null
  }
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
        : ['tool', 'user-input', 'mcp-elicitation'].includes(kind)
          ? 'tool'
          : 'other',
  }
}

export function projectClaudeProviderEventV1(
  event: DriverEvent,
  context: AgentDriverProviderEventProjectionContextV1,
): ProviderEventV1 | null {
  const transcriptKind = metadataString(event.metadata, 'transcriptKind')
  if (transcriptKind === 'thinking' || transcriptKind === 'user') return null
  const base = {
    event_id: `claude-driver-event-${context.sequence}`,
    turn_id: metadataString(event.metadata, 'turnId') ?? context.action_id,
    session_id: context.assigned_session_id,
    sequence: context.sequence,
    observed_at: event.at,
  }
  const requestedApproval = approval(event)
  if (requestedApproval) {
    return defineProviderEventV1({
      kind: 'approval',
      ...base,
      ...requestedApproval,
      status: 'requested',
      safe_summary: event.data || 'Claude approval requested',
    })
  }
  if (event.type === 'exit') {
    return defineProviderEventV1({
      kind: 'status',
      ...base,
      status: 'stopped',
    })
  }
  if (event.type === 'error') {
    return defineProviderEventV1({
      kind: 'error',
      ...base,
      code: 'claude_driver_error',
      safe_message: event.data || 'Claude driver failed',
    })
  }
  if (event.type === 'status') {
    return defineProviderEventV1({
      kind: 'status',
      ...base,
      status: context.driver_session.status,
    })
  }
  if (event.type === 'tool') {
    const completed = transcriptKind === 'tool_result'
    return defineProviderEventV1({
      kind: 'tool',
      ...base,
      tool_call_id: `claude-tool-${context.sequence}`,
      tool_name: metadataString(event.metadata, 'toolName')
        ?? 'claude_tool',
      phase: completed ? 'completed' : 'started',
      safe_summary: completed
        ? 'Claude tool completed'
        : event.data || null,
    })
  }
  return defineProviderEventV1({
    kind: 'output',
    ...base,
    safe_text: event.data,
  })
}

export async function* streamClaudeProviderDriverEventsV1(
  events: AsyncIterable<DriverEvent>,
  releaseTerminalBinding: () => void,
): AsyncIterable<DriverEvent> {
  let terminal = false
  try {
    for await (const event of events) {
      if (event.type === 'exit') terminal = true
      yield event
    }
    terminal = true
  } catch (error) {
    terminal = true
    throw error
  } finally {
    if (terminal) releaseTerminalBinding()
  }
}

const permissionMode = (
  accessProfile: 'read_only' | 'workspace_write' | 'full_access',
): string => accessProfile === 'read_only'
  ? 'plan'
  : accessProfile === 'workspace_write'
    ? 'acceptEdits'
    : 'bypassPermissions'

const sealForkLaunchRequest = (
  requested: DriverLaunchRequest,
  context: ProviderAuthorizedLaunchContextV1,
  parent: DriverSession,
  result: ClaudeSessionForkResult,
  binding: DriverSessionBindingV1,
): DriverLaunchRequest => {
  if (context.action.kind !== 'fork') {
    throw new Error('Claude provider fork action is required')
  }
  if (context.action.scope_id !== parent.workspaceId
    || binding.workspaceId !== parent.workspaceId) {
    throw new Error('Claude provider fork must remain in its authorized workspace')
  }
  if (!Number.isInteger(requested.boardId) || requested.boardId! <= 0) {
    throw new Error('Claude provider fork requires an authorized board id')
  }
  if (context.action.cost_limit !== null
    && context.action.cost_limit.currency !== 'USD') {
    throw new Error('Claude AgentDriver cost budgets require USD authorization')
  }
  return {
    ...requested,
    workspaceId: context.action.scope_id,
    cwd: binding.cwd,
    prompt: undefined,
    command: undefined,
    args: undefined,
    env: { ...context.environment },
    externalId: result.externalId,
    model: context.action.model ?? undefined,
    effort: context.action.effort ?? undefined,
    accessProfile: context.action.access_profile,
    permissionMode: permissionMode(context.action.access_profile),
    maxBudgetUsd: context.action.cost_limit === null
      ? undefined
      : context.action.cost_limit.max_cost_minor_units / 100,
    taskBudgetTokens: undefined,
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
      providerForkSourceSessionId: parent.externalId,
    },
  }
}

export function createClaudeProviderAdapterV1(
  options: ClaudeProviderAdapterOptionsV1,
): ProviderExecutionAdapterV1 {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? `${process.platform}-${process.arch}`
  const now = options.now ?? (() => new Date())
  const executableResolver = options.resolveBundledExecutable
    ?? resolveClaudeBundledCliCommand
  const executableFingerprinter = options.fingerprintExecutable
    ?? (options.readExecutable
      ? (resolvedPath: string) => sha256(options.readExecutable!(resolvedPath))
      : fingerprintExecutableFileV1)
  const versionReader = options.readVersion ?? readVersion
  const authenticationProbe = options.probeAuthentication
    ?? probeAuthentication
  const driverBindings = new Map<string, DriverSessionBindingV1>()
  const pendingForkBindings = new Map<string, DriverSessionBindingV1>()
  let privateExecutable: PrivateExecutableObservationV1 | null = null
  const bridgeDriver: AgentDriver = {
    id: options.driver.id,
    capabilities: () => options.driver.capabilities(),
    launch: (request) => options.driver.launch(request),
    attach: (externalId) => options.driver.attach(externalId),
    send: (sessionId, text) => options.driver.send(sessionId, text),
    interrupt: (sessionId) => options.driver.interrupt(sessionId),
    async stop(sessionId) {
      try {
        await options.driver.stop(sessionId)
      } finally {
        driverBindings.delete(sessionId)
      }
    },
    events: (sessionId) => streamClaudeProviderDriverEventsV1(
      options.driver.events(sessionId),
      () => driverBindings.delete(sessionId),
    ),
  }

  return defineAgentDriverProviderAdapterV1({
    manifest: CLAUDE_PROVIDER_MANIFEST_V1,
    driver: bridgeDriver,
    async discoverExecutable(): Promise<ProviderExecutableDiscoveryV1> {
      const resolvedPath = executableResolver()
      let rawVersion: string | null = null
      if (resolvedPath) {
        try {
          rawVersion = versionReader(
            resolvedPath,
            minimalVersionEnvironment(environment),
          )
        } catch {
          // A version-probe failure is unknown, not evidence of incompatibility.
        }
      }
      const exactVersion = exactClaudeVersion(rawVersion)
      const versionValidated = exactVersion !== null
        && CLAUDE_PROVIDER_MANIFEST_V1.executable.validated_versions
          .includes(exactVersion)
      let executableFingerprint = sha256([
        'claude-sdk-bundled-executable-v1',
        exactVersion ?? 'unknown',
        platform,
        resolvedPath ? 'resolved' : 'missing',
      ].join('\u0000'))
      const platformSupported =
        CLAUDE_PROVIDER_MANIFEST_V1.executable.supported_platforms
          .includes(platform)
      let status: ProviderExecutableDiscoveryV1['status'] = !resolvedPath
        ? 'missing'
        : !platformSupported
          ? 'incompatible'
          : exactVersion === null
            ? 'unknown'
            : versionValidated
              ? 'validated'
              : 'incompatible'
      if (resolvedPath) {
        try {
          executableFingerprint = executableFingerprinter(resolvedPath)
        } catch {
          status = 'untrusted'
        }
      }
      privateExecutable = {
        resolvedPath,
        executableFingerprint,
      }
      return {
        contract_version: 1,
        provider_id: CLAUDE_PROVIDER_MANIFEST_V1.provider_id,
        adapter_id: CLAUDE_PROVIDER_MANIFEST_V1.adapter_id,
        status,
        source: 'sdk_bundled',
        version: exactVersion,
        platform,
        resolved_path: null,
        executable_fingerprint: executableFingerprint,
      }
    },
    async probeReadiness(intent, boundary) {
      const mode = CLAUDE_PROVIDER_MANIFEST_V1.modes.find(
        (candidate) => candidate.id === intent.selection.mode_id,
      )
      if (!mode) throw new Error('Claude provider mode is not declared')
      let authStatus: ProviderReadinessV1['auth_status'] = 'unknown'
      if (mode.id === 'native_subscription'
        && boundary.evidence.executable_status === 'validated'
        && privateExecutable?.resolvedPath
        && privateExecutable.executableFingerprint
          === boundary.evidence.executable_fingerprint) {
        const observed = await authenticationProbe(
          privateExecutable.resolvedPath,
          credentialFreeEnvironment(environment),
        )
        authStatus = validAuthStatus(observed) ? observed : 'unknown'
      }
      const usagePricedApi = mode.billing_mode === 'usage_priced_api'
      return {
        contract_version: 1,
        observed_at: now().toISOString(),
        selection: intent.selection,
        executable_status: boundary.evidence.executable_status,
        auth_status: authStatus,
        automation_policy: mode.automation_policy,
        overage_status: 'not_applicable',
        overage_consent: 'not_required',
        metering_status: usagePricedApi ? 'unknown' : 'not_required',
        cost_cap_status: usagePricedApi ? 'unknown' : 'not_required',
        executable_fingerprint: boundary.evidence.executable_fingerprint,
        environment_fingerprint: boundary.evidence.environment_fingerprint,
        configuration_fingerprint:
          boundary.evidence.configuration_fingerprint,
      }
    },
    async listModels(intent) {
      return options.listModels(intent)
    },
    async launchRequest(context) {
      if (context.action.kind !== 'launch') {
        throw new Error('Claude provider launch action is required')
      }
      return options.launchRequest(context)
    },
    async sessionEvidence(context, session) {
      try {
        const evidence = await options.sessionEvidence(context, session)
        if (context.action.kind === 'launch') {
          driverBindings.set(session.id, {
            workspaceId: context.action.scope_id,
            cwd: context.action.cwd,
          })
        } else if (context.action.kind === 'fork') {
          const binding = pendingForkBindings.get(context.action.action_id)
          if (!binding) {
            throw new Error('Claude provider fork binding is unavailable')
          }
          driverBindings.set(session.id, binding)
        }
        return evidence
      } finally {
        pendingForkBindings.delete(context.action.action_id)
      }
    },
    async fork(context, parent) {
      if (context.action.kind !== 'fork') {
        throw new Error('Claude provider fork action is required')
      }
      const binding = driverBindings.get(parent.id)
      if (!binding) throw new Error('Claude provider fork source is not bound')
      const result = await options.driver.forkSession(parent.id, {
        sourceExternalId: parent.externalId,
        workspaceId: parent.workspaceId,
        cwd: binding.cwd,
      })
      if (result.sourceExternalId !== parent.externalId
        || result.externalId === parent.externalId) {
        throw new Error('Claude provider fork returned inconsistent provenance')
      }
      const requested = await options.forkLaunchRequest(
        context,
        parent,
        result,
      )
      const request = sealForkLaunchRequest(
        requested,
        context,
        parent,
        result,
        binding,
      )
      pendingForkBindings.set(context.action.action_id, binding)
      try {
        return await options.driver.launch(request)
      } catch (error) {
        pendingForkBindings.delete(context.action.action_id)
        throw error
      }
    },
    async submitApproval(context, decision) {
      return options.submitApproval(context, decision)
    },
    projectEvent: projectClaudeProviderEventV1,
    async usage(context) {
      return options.usage(context)
    },
  })
}

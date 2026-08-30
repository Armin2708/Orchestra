import type Database from 'better-sqlite3'
import type { FastifyRequest } from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { listLocalPresenceAgents } from './org-sync/daemon-integration.js'
import { superviseDaemonOrgSync, type DaemonOrgSyncSupervisor } from './org-sync/supervisor.js'
import { openDb } from './db.js'
import { buildServer } from './server.js'
import { reap, bounceDeadLetters } from './reaper.js'
import { createGraphifyAutoSync } from './agent-os/knowledge-graphify-autosync.js'
import { cardWorktree } from './shipqueue.js'
import { Conductor } from './conductor.js'
import { ensureAgentToken, ensureToken } from './token.js'
import { LocalOwnerPasswordAuth } from './local-owner-auth.js'
import { loadSecureVapidKeys, registerPush, type VapidKeys } from './push.js'
import { Autowake, autowakeEnabled } from './autowake.js'
import { createAgentOsRuntime } from './agent-os/runtime-integration.js'
import { sessionToolPlugin } from './agent-os/session-tool-routes.js'
import { TerminalSessionStateService } from './agent-os/terminal-session-state.js'
import { OrchestrationService } from './agent-os/orchestration-service.js'
import { acquireDaemonLease } from './agent-os/daemon-lease.js'
import {
  openCompatibilityMigrationFailureJournal,
} from './agent-os/compatibility-migration-failure-journal.js'
import {
  bindCompatibilityMigrationFailureJournal,
} from './agent-os/compatibility-migration-instrumentation.js'
import { AgentHomeCodexNativeEventSink } from './agent-os/codex-native-events.js'
import { CodexAgentHomeThreadBinder } from './agent-os/codex-session-binding.js'
import { AgentHomeClaudeNativeEventSink } from './agent-os/claude-native-events.js'
import { CODEX_PROVIDER_ID, QWEN_PROVIDER_ID, writeProviderModelCache } from './agent-providers.js'
import {
  assertManagedEnvironmentCompatibility,
  runEnvironmentDoctor,
} from './environment-compatibility.js'
import {
  CodexAppServerService,
  CodexAppServerSupervisor,
  CodexProviderService,
  codexApprovalPolicyHandler,
} from './codex/index.js'
import type { CodexThread } from './codex/protocol.js'
import {
  CodexAgentDriver,
  type CodexAgentHomeBindContext,
  type CodexAgentHomeBinding,
} from './runtime/drivers/codex.js'
import {
  CODEX_PROTOCOL_CONFIGURATION_FINGERPRINT_V1,
  createCodexProviderAdapterV1,
} from './runtime/drivers/codex-provider-adapter.js'
import { discoverClaudeProviderExecutableV1 } from './runtime/drivers/claude-provider-adapter.js'
import {
  createQwenProviderAdapterV1,
  discoverQwenProviderExecutableV1,
  QWEN_PROVIDER_MODEL_CATALOG_V1,
} from './runtime/drivers/qwen-provider-adapter.js'
import { QwenAgentDriver } from './runtime/drivers/qwen.js'
import { discoverKimiProviderExecutableV1 } from './runtime/drivers/kimi-provider-adapter.js'
import {
  ProviderContractAgentDriverV1,
} from './runtime/drivers/provider-contract-driver.js'
import {
  ProviderLaunchRequestBrokerV1,
} from './runtime/drivers/provider-launch-request-broker.js'
import {
  CodexManagedAgentRuntime,
  ProviderAgentManager,
  ProviderUnavailableError,
  QwenManagedAgentRuntime,
  type AccessProfile,
} from './provider-agent-manager.js'
import { resolveExecutableOnPath } from './provider-auth-status.js'
import { prepareManagedSubscriptionEnvironmentV1 } from './provider-runtime-environment.js'
import { createDeclaredProviderToolRegistry } from './tool-capabilities.js'
import type { ToolIntegrationCheck } from './tool-capabilities.js'
import { inspectDeclaredProviderToolIntegrations } from './tool-readiness.js'
import {
  runOperatorReadinessDoctor,
  type OperatorDoctorReport,
} from './readiness-doctor.js'
import type {
  ProviderExecutableDiscoveryV1,
  ProviderManifestV1,
} from './provider-contract.js'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
} from './provider-adapter-registry.js'
import type {
  ProviderAcceptanceEvidenceRecordV1,
} from './provider-acceptance-evidence-store.js'

export type DaemonProviderToolSurface = ReturnType<
  typeof createDeclaredProviderToolRegistry
>

export type DaemonProviderDiscoveries = Readonly<Record<
  'claude' | 'codex' | 'qwen' | 'kimi',
  ProviderExecutableDiscoveryV1
>>

const acceptedProviderEvidence = (
  records: readonly ProviderAcceptanceEvidenceRecordV1[],
  discoveries: DaemonProviderDiscoveries,
  sourceCommit: string | null,
  manifest: ProviderManifestV1,
  modeId: string,
): boolean => {
  if (!sourceCommit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit)) {
    return false
  }
  const mode = manifest.modes.find((candidate) => candidate.id === modeId)
  const discovery = discoveries[manifest.provider_id as keyof DaemonProviderDiscoveries]
  if (!mode
    || !discovery
    || discovery.status !== 'validated'
    || discovery.version === null) {
    return false
  }
  return records.some((record) => {
    const matrix = record.matrix
    return /^pe_[a-f0-9]{64}$/.test(record.id)
      && /^[a-f0-9]{64}$/.test(record.matrix_sha256)
      && /^[a-f0-9]{64}$/.test(record.artifact_sha256)
      && matrix.provider_id === manifest.provider_id
      && matrix.adapter_id === manifest.adapter_id
      && matrix.adapter_version === manifest.adapter_version
      && matrix.mode_id === mode.id
      && matrix.runtime_mode === mode.runtime_mode
      && matrix.billing_mode === mode.billing_mode
      && matrix.credential_kind === mode.default_credential_kind
      && matrix.executable_version === discovery.version
      && matrix.platform === discovery.platform
      && matrix.source_commit === sourceCommit
      && DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.every((gateId) =>
        matrix.gates[gateId].state === 'passed'
        && matrix.gates[gateId].evidence_refs.length > 0)
  })
}

export const createDaemonProviderToolSurface = async (input: {
  doctor: () => OperatorDoctorReport
  discoveries: () => Promise<DaemonProviderDiscoveries>
  acceptanceEvidence?: () => readonly ProviderAcceptanceEvidenceRecordV1[]
  sourceCommit?: () => string | null
  integrations: () => readonly ToolIntegrationCheck[]
}): Promise<DaemonProviderToolSurface> => {
  const doctor = input.doctor()
  const discoveries = await input.discoveries()
  let records: readonly ProviderAcceptanceEvidenceRecordV1[] = []
  try {
    records = input.acceptanceEvidence?.() ?? []
  } catch {
    // Missing or mutated retained artifacts cannot preserve an acceptance claim.
  }
  const sourceCommit = input.sourceCommit?.() ?? null
  return createDeclaredProviderToolRegistry({
    doctor,
    discoveries,
    accepted: (manifest, modeId) => acceptedProviderEvidence(
      records,
      discoveries,
      sourceCommit,
      manifest,
      modeId,
    ),
    observedAt: doctor.checked_at,
  }, input.integrations())
}

export const synchronizeDaemonProviderToolSurface = (
  current: DaemonProviderToolSurface,
  next: DaemonProviderToolSurface,
): void => {
  current.registry.synchronize(next.registry.list())
  current.matrix.splice(0, current.matrix.length, ...next.matrix)
}

export const createDaemonProviderToolSurfaceRefresher = (
  current: DaemonProviderToolSurface,
  inspect: () => Promise<DaemonProviderToolSurface>,
  failClosed: () => DaemonProviderToolSurface,
): (() => Promise<void>) => {
  let generation = 0
  return async () => {
    const requestedGeneration = ++generation
    try {
      const refreshed = await inspect()
      if (requestedGeneration !== generation) return
      synchronizeDaemonProviderToolSurface(current, refreshed)
    } catch {
      if (requestedGeneration !== generation) return
      try {
        synchronizeDaemonProviderToolSurface(current, failClosed())
      } catch {
        synchronizeDaemonProviderToolSurface(
          current,
          createDeclaredProviderToolRegistry(),
        )
      }
    }
  }
}
import { createOperationsRuntime } from './operations/runtime.js'
import { inspectRemoteTunnelHealth } from './remote.js'
import { deliverRemotePushOutbox } from './remote-security-integration.js'
import {
  OperationsRecoveryService,
  OperationsRetentionService,
  SafeShutdownCoordinator,
} from './agent-os/operations-recovery.js'
import {
  assertOperationsShutdownClean,
  OperationsOutboxWorker,
  OperationsRetentionScheduler,
  OperationsRuntimeCoordinator,
  type OperationsRuntimeObservation,
} from './agent-os/operations-runtime.js'
import {
  acquireStateTransitionGuard,
  invalidateDaemonQuiescenceReceipt,
  writeDaemonQuiescenceReceipt,
} from './agent-os/database-quiescence.js'

export function dataDir(): string {
  const d = process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
  fs.mkdirSync(d, { recursive: true })
  return d
}
export function port(): number { return Number(process.env.ORCHESTRA_PORT ?? 4750) }
export const baseUrl = () => `http://127.0.0.1:${port()}`

export const authDisabled = () => process.env.ORCHESTRA_NO_AUTH === '1'

export function ensureTerminalHistoryDigestKey(root = dataDir()): Buffer {
  const keyPath = path.join(root, 'terminal-history.key')
  try {
    const existing = fs.readFileSync(keyPath)
    if (existing.byteLength !== 32) throw new Error('terminal history key must contain exactly 32 bytes')
    fs.chmodSync(keyPath, 0o600)
    const verified = fs.readFileSync(keyPath)
    if (verified.byteLength !== 32) throw new Error('terminal history key verification failed')
    return verified
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const created = randomBytes(32)
  try {
    const descriptor = fs.openSync(keyPath, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, created)
    } finally {
      fs.closeSync(descriptor)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  fs.chmodSync(keyPath, 0o600)
  const verified = fs.readFileSync(keyPath)
  if (verified.byteLength !== 32) throw new Error('terminal history key verification failed')
  return verified
}

export interface ServeOptions { expose?: boolean }

export type CodexProviderContractRouting = {
  enabled: boolean
  source_commit: string | null
}

export const providerToolEvidenceSourceCommit = (
  source: NodeJS.ProcessEnv = process.env,
): string | null => {
  const value = source.ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT?.trim() ?? ''
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : null
}

export const codexProviderContractRouting = (
  source: NodeJS.ProcessEnv = process.env,
): CodexProviderContractRouting => {
  const requested = source.ORCHESTRA_CODEX_PROVIDER_CONTRACT?.trim() ?? ''
  if (!requested || requested === '0') {
    return { enabled: false, source_commit: null }
  }
  if (requested !== '1') {
    throw new Error('ORCHESTRA_CODEX_PROVIDER_CONTRACT must be 0 or 1')
  }
  const sourceCommit = source.ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT?.trim() ?? ''
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit)) {
    throw new Error(
      'ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT must be an exact 40- or 64-character commit',
    )
  }
  return { enabled: true, source_commit: sourceCommit }
}

// hired agents to resurrect after a restart — sessions resume, cards and work persist.
// Limit-paused agents are deliberately excluded: resurrecting them into a still-spent
// window would just re-kill them, so the autowake timer owns their return (#62).
export const survivors = (db: Database.Database): any[] => db.prepare(`
  SELECT a.id, a.name, a.board_id, a.role, a.provider, a.sdk_session,
    a.external_session_id, a.provider_state_json, a.permission_mode, a.access_profile,
    COALESCE(os.model, a.model) AS model, a.effort, b.project_path,
    lc.id AS launched_card_id, lc.branch AS launched_branch,
    os.workspace_id AS agent_os_workspace_id,
    json_extract(os.context_json, '$.card_id') AS agent_os_card_id,
    ow.root_path AS agent_os_root_path, ow.worktree_path AS agent_os_worktree_path,
    oj.budget_tokens AS agent_os_budget_tokens, oj.budget_cents AS agent_os_budget_cents,
    oj.spent_tokens AS agent_os_spent_tokens, oj.spent_cents AS agent_os_spent_cents
  FROM agents a JOIN boards b ON b.id = a.board_id
  LEFT JOIN cards lc ON lc.owner_agent_id = a.id AND lc.column_name = 'in_progress' AND lc.branch IS NOT NULL
  LEFT JOIN agent_sessions os ON os.id = (
    SELECT s.id FROM agent_sessions s
    WHERE s.agent_id=a.id AND json_extract(s.context_json, '$.job_id') IS NOT NULL
    ORDER BY s.updated_at DESC, s.rowid DESC LIMIT 1
  )
  LEFT JOIN workspaces ow ON ow.id=os.workspace_id
  LEFT JOIN jobs oj ON oj.id=json_extract(os.context_json, '$.job_id')
  WHERE a.kind='hired' AND a.status NOT IN ('gone', 'paused_limit')`).all() as any[]

export const codexWorkspaceForThread = (db: Database.Database, threadId: string): string | undefined => {
  const durable = db.prepare(`SELECT workspace_id FROM agent_sessions
    WHERE provider=? AND external_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
    .get(CODEX_PROVIDER_ID, threadId) as { workspace_id: string } | undefined
  if (durable?.workspace_id) return durable.workspace_id
  const legacy = db.prepare(`SELECT id FROM agents WHERE provider=? AND external_session_id=?
    ORDER BY last_seen DESC, id DESC LIMIT 1`).get(CODEX_PROVIDER_ID, threadId) as { id: number } | undefined
  return legacy ? `legacy-agent:${legacy.id}` : undefined
}

export const codexTokenBudgetForThread = (db: Database.Database, threadId: string): number | null => {
  const row = db.prepare(`SELECT j.budget_tokens FROM agent_sessions s
    JOIN jobs j ON j.id=json_extract(s.context_json, '$.job_id')
    WHERE s.provider=? AND s.external_id=? ORDER BY s.updated_at DESC, s.rowid DESC LIMIT 1`)
    .get(CODEX_PROVIDER_ID, threadId) as { budget_tokens: number | null } | undefined
  return row?.budget_tokens ?? null
}

export const codexAgentHomeForThread = (
  db: Database.Database,
  threadId: string,
): CodexAgentHomeBinding | undefined =>
  new CodexAgentHomeThreadBinder(db).lookup(threadId)

export const bindCodexAgentHomeForThread = (
  db: Database.Database,
  threadId: string,
  thread: CodexThread,
  context: CodexAgentHomeBindContext,
): CodexAgentHomeBinding => new CodexAgentHomeThreadBinder(db).bind({
  threadId,
  cwd: thread.cwd,
  mode: context.mode,
  boardId: context.boardId,
  workspaceId: context.workspaceId,
  agentId: typeof context.metadata.agentId === 'number'
    ? context.metadata.agentId
    : undefined,
  jobId: typeof context.metadata.jobId === 'string'
    ? context.metadata.jobId
    : undefined,
  expected: context.expectedBinding ? {
    agentHomeSessionId: context.expectedBinding.agentHomeSessionId,
    agentProfileId: context.expectedBinding.agentProfileId,
    agentConversationId: context.expectedBinding.agentConversationId,
  } : undefined,
})

const CODEX_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'COLORTERM',
  'LANG', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_ORG_ID', 'OPENAI_PROJECT',
  'CODEX_API_KEY',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
])

const codexEnvironmentDenied = (key: string): boolean => {
  const normalized = key.toUpperCase()
  return normalized === 'ORCHESTRA_TOKEN'
    || normalized === 'ORCHESTRA_CODEX_FORWARD_ENV'
    || normalized === 'CLAUDECODE'
    || normalized.startsWith('ANTHROPIC_')
    || normalized.startsWith('CLAUDE_')
}

export const sanitizedCodexEnvironment = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const requested = new Set((source.ORCHESTRA_CODEX_FORWARD_ENV ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))
  const prepared = prepareManagedSubscriptionEnvironmentV1('codex', source).forSpawn()
  return Object.fromEntries(Object.entries(prepared).filter(([key, value]) =>
    value !== undefined
    && !codexEnvironmentDenied(key)
    && (CODEX_ENV_ALLOWLIST.has(key.toUpperCase()) || key.toUpperCase().startsWith('LC_') || requested.has(key))))
}

const QWEN_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'COLORTERM',
  'LANG', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'QWEN_CONFIG_DIR',
  'DASHSCOPE_API_KEY', 'BAILIAN_CODING_PLAN_API_KEY',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
])

const qwenEnvironmentDenied = (key: string): boolean => {
  const normalized = key.toUpperCase()
  return normalized === 'ORCHESTRA_TOKEN'
    || normalized === 'ORCHESTRA_QWEN_FORWARD_ENV'
    || normalized === 'CLAUDECODE'
    || normalized.startsWith('ANTHROPIC_')
    || normalized.startsWith('CLAUDE_')
    || normalized.startsWith('OPENAI_')
    || normalized.startsWith('CODEX_')
}

export const sanitizedQwenEnvironment = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const requested = new Set((source.ORCHESTRA_QWEN_FORWARD_ENV ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))
  return Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    value !== undefined
    && !qwenEnvironmentDenied(key)
    && (QWEN_ENV_ALLOWLIST.has(key.toUpperCase()) || key.toUpperCase().startsWith('LC_') || requested.has(key))))
}

export async function serve(opts: ServeOptions = {}): Promise<void> {
  assertManagedEnvironmentCompatibility(runEnvironmentDoctor('claude'))
  const contractRouting = codexProviderContractRouting()
  // an exposed daemon is remote code execution for anyone who can reach the port
  if (opts.expose && authDisabled())
    throw new Error('--expose requires token auth — unset ORCHESTRA_NO_AUTH to start exposed')
  const orchestraDataDir = dataDir()
  const databasePath = path.join(orchestraDataDir, 'orchestra.db')
  const startupTransition = acquireStateTransitionGuard(orchestraDataDir, 'daemon-start')
  let db: Database.Database
  let lease: ReturnType<typeof acquireDaemonLease>
  try {
    invalidateDaemonQuiescenceReceipt(orchestraDataDir)
    db = openDb(databasePath)
    lease = acquireDaemonLease(db)
  } finally {
    startupTransition.release()
  }
  const token = authDisabled() ? undefined : ensureToken()
  const agentToken = authDisabled() ? undefined : ensureAgentToken()
  const localOwnerAuth = authDisabled()
    ? undefined
    : new LocalOwnerPasswordAuth(path.join(orchestraDataDir, 'owner-password.json'))
  let compatibilityFailureJournal:
    ReturnType<typeof openCompatibilityMigrationFailureJournal> | undefined
  let unbindCompatibilityFailureJournal: (() => void) | undefined
  let maestro: Conductor | undefined
  let manager: ProviderAgentManager | undefined
  let autowake: Autowake | undefined
  let toolEvidenceRefreshTimer: ReturnType<typeof setInterval> | undefined
  let vapidKeys: VapidKeys | undefined
  let vapidCredentialReason = 'vapid_credentials_not_checked'
  let runtimeReconciled = false
  let orgSync: DaemonOrgSyncSupervisor | null = null
  const safeShutdown = new SafeShutdownCoordinator()
  const trackedActiveWork = new Map<string, () => void>()
  const reconcileActiveWork = () => {
    const active = db.prepare(`SELECT id FROM agent_sessions
      WHERE status IN ('starting','running','idle') ORDER BY id`).all() as Array<{ id: string }>
    const activeIds = new Set(active.map((row) => `session:${row.id}`))
    for (const [id, release] of trackedActiveWork) {
      if (!activeIds.has(id)) { release(); trackedActiveWork.delete(id) }
    }
    for (const id of activeIds) {
      if (trackedActiveWork.has(id)) continue
      const sessionId = id.slice('session:'.length)
      let detached = false
      const release = safeShutdown.register({
        id,
        settle: async () => {
          while (!detached) {
            const row = db.prepare('SELECT status FROM agent_sessions WHERE id=?').get(sessionId) as
              { status: string } | undefined
            if (!row || !['starting', 'running', 'idle'].includes(row.status)) return
            await new Promise<void>((resolve) => setTimeout(resolve, 250))
          }
        },
        onDeadline: 'detach',
        detach: async () => { detached = true },
      })
      trackedActiveWork.set(id, () => { detached = true; release() })
    }
  }
  const agentOs = createAgentOsRuntime(db)
  const terminalSessionState = new TerminalSessionStateService(db, {
    digestKey: ensureTerminalHistoryDigestKey(orchestraDataDir),
  })
  const claudeNativeEventSink = new AgentHomeClaudeNativeEventSink(db)
  const scheduler = agentOs.scheduler
  const orchestration = new OrchestrationService(db, scheduler)
  const codexCommand = process.env.ORCHESTRA_CODEX_COMMAND?.trim() || 'codex'
  const codexEnvironment = sanitizedCodexEnvironment()
  if (agentToken) {
    codexEnvironment.ORCHESTRA_AGENT_TOKEN = agentToken
    codexEnvironment.ORCHESTRA_MANAGED_AGENT = '1'
  }
  const codexSupervisor = new CodexAppServerSupervisor({
    client: { requestTimeoutMs: 5_000 },
    process: { command: codexCommand, env: codexEnvironment, inheritEnv: false },
  })
  const codexRpc = new CodexAppServerService(codexSupervisor)
  const codexNativeEventSink = new AgentHomeCodexNativeEventSink(db)
  const codexAgentHomeBindings = new CodexAgentHomeThreadBinder(db)
  const codexDriver = new CodexAgentDriver({
    service: codexRpc,
    nativeEventSink: codexNativeEventSink,
    agentHomeForThread: (threadId, thread, context) => codexAgentHomeBindings.bind({
      threadId,
      cwd: thread.cwd,
      mode: context.mode,
      boardId: context.boardId,
      workspaceId: context.workspaceId,
      agentId: typeof context.metadata.agentId === 'number'
        ? context.metadata.agentId
        : undefined,
      jobId: typeof context.metadata.jobId === 'string'
        ? context.metadata.jobId
        : undefined,
      expected: context.expectedBinding ? {
        agentHomeSessionId: context.expectedBinding.agentHomeSessionId,
        agentProfileId: context.expectedBinding.agentProfileId,
        agentConversationId: context.expectedBinding.agentConversationId,
      } : undefined,
    }),
    workspaceForThread: (threadId) => codexWorkspaceForThread(db, threadId),
    tokenBudgetForThread: (threadId) => codexTokenBudgetForThread(db, threadId),
    onApprovalRequest: codexApprovalPolicyHandler(db),
  })
  const codexProvider = new CodexProviderService(db, codexRpc, codexSupervisor, { command: codexCommand })
  const codexLaunchRequests = new ProviderLaunchRequestBrokerV1()
  const resolveCodexWorkspaceTarget = async (scopeId: string) => {
    const workspace = await agentOs.workspaceManager.get(scopeId)
    return workspace?.status === 'active'
      ? {
          workspaceId: workspace.id,
          cwd: agentOs.workspaceManager.root(workspace),
        }
      : null
  }
  const codexAdapter = createCodexProviderAdapterV1({
    driver: codexDriver,
    service: codexRpc,
    command: codexCommand,
    environment: codexEnvironment,
    launchRequest: codexLaunchRequests.resolve,
    resolveForkTarget: resolveCodexWorkspaceTarget,
    resolveRecoveryTarget: resolveCodexWorkspaceTarget,
  })
  agentOs.registerProviderAdapter(codexAdapter)
  const qwenCommand = process.env.ORCHESTRA_QWEN_COMMAND?.trim() || 'qwen'
  const qwenEnvironment = sanitizedQwenEnvironment()
  const qwenExecutablePath = resolveExecutableOnPath(qwenCommand)
  const qwenReady = Boolean(qwenExecutablePath)
  let qwenDriver: QwenAgentDriver | undefined
  if (qwenReady) {
    qwenDriver = new QwenAgentDriver({
      command: qwenExecutablePath!,
      environment: qwenEnvironment,
      defaultModel: 'qwen3-coder-plus',
    })
    agentOs.registerProviderAdapter(createQwenProviderAdapterV1({
      driver: qwenDriver,
      command: qwenCommand,
      environment: qwenEnvironment,
      resolveExecutable: () => qwenExecutablePath,
      probeVersion: () => {
        const result = spawnSync(qwenCommand, ['--version'], {
          encoding: 'utf8',
          env: qwenEnvironment,
          timeout: 10_000,
        })
        return (result.stdout || '').trim() || null
      },
    }))
    agentOs.registerDriver(qwenDriver)
    writeProviderModelCache(db, QWEN_PROVIDER_MODEL_CATALOG_V1.map((model) => ({
      value: model.id,
      displayName: model.displayName,
      description: model.description,
      isDefault: model.isDefault,
    })), QWEN_PROVIDER_ID)
  }
  const codexContractDriver = contractRouting.enabled
    ? new ProviderContractAgentDriverV1({
        registry: agentOs.providerAdapters,
        adapter: codexAdapter,
        launchRequests: codexLaunchRequests,
        source_commit: contractRouting.source_commit!,
        configuration_fingerprint: CODEX_PROTOCOL_CONFIGURATION_FINGERPRINT_V1,
        environment: codexEnvironment,
      })
    : null
  let runtimesClosed = false
  let runtimeShutdownProven = false
  const shutdownRuntimes = async (): Promise<boolean> => {
    if (runtimesClosed) return runtimeShutdownProven
    runtimesClosed = true
    const failures: unknown[] = []
    const settled = await Promise.allSettled([agentOs.shutdown(), manager?.shutdown() ?? Promise.resolve()])
    failures.push(...settled.filter((result) => result.status === 'rejected').map((result) => result.reason))
    try { await codexDriver.detachAll() } catch (error) { failures.push(error) }
    try { codexDriver.dispose() } catch (error) { failures.push(error) }
    try { codexProvider.dispose() } catch (error) { failures.push(error) }
    try { await codexSupervisor.stop() } catch (error) { failures.push(error) }
    try { qwenDriver?.dispose() } catch (error) { failures.push(error) }
    try { unbindCompatibilityFailureJournal?.() } catch (error) { failures.push(error) }
    unbindCompatibilityFailureJournal = undefined
    try { compatibilityFailureJournal?.close() } catch (error) { failures.push(error) }
    runtimeShutdownProven = failures.length === 0
    return runtimeShutdownProven
  }
  let codexReady = false
  let server: ReturnType<typeof buildServer>
  let operationsRuntime: ReturnType<typeof createOperationsRuntime>
  try {
    compatibilityFailureJournal = openCompatibilityMigrationFailureJournal(
      db,
      {
        journal_path: path.join(
          orchestraDataDir,
          'compatibility-migration-failures.sqlite',
        ),
      },
    )
    unbindCompatibilityFailureJournal =
      bindCompatibilityMigrationFailureJournal(
        db,
        compatibilityFailureJournal,
      )
    codexReady = await codexProvider.initialize()
    if (contractRouting.enabled) {
      if (!codexReady) {
        throw new Error(
          'Codex provider-contract routing was requested but Codex is unavailable',
        )
      }
      await codexContractDriver!.assertSupported()
      agentOs.registerDriver(codexContractDriver!)
    } else if (codexReady) {
      agentOs.registerDriver(codexDriver)
    }
    try {
      vapidKeys = await loadSecureVapidKeys()
      vapidCredentialReason = 'vapid_credentials_ready'
    } catch {
      // Push remains fail-closed while the daemon and local recovery controls stay available.
      vapidKeys = undefined
      vapidCredentialReason = 'vapid_secure_store_unavailable'
    }
    operationsRuntime = createOperationsRuntime({
      db,
      lease: { ownerId: lease.ownerId, pid: process.pid },
      drivers: () => {
        const descriptors = agentOs.descriptors()
        return { registered: descriptors.length, ready: descriptors.length }
      },
      providers: async () => {
        const catalogs = await manager?.providerCatalog() ?? []
        return {
          configured: catalogs.length,
          ready: catalogs.filter((provider) => provider.health?.status === 'ready'
            || (!provider.health && provider.available)).length,
          degraded: catalogs.filter((provider) => provider.health?.status === 'degraded').length,
          unavailable: catalogs.filter((provider) => provider.health?.status === 'unavailable'
            || (!provider.health && !provider.available)).length,
        }
      },
      ptySupervisor: () => ({
        responsive: true,
        reconciled: runtimeReconciled,
        lostProcesses: Number((db.prepare("SELECT count(*) AS count FROM processes WHERE status='lost'")
          .get() as { count: number }).count),
      }),
      hooks: () => ({ enabled: Boolean(compatibilityFailureJournal), coherent: Boolean(compatibilityFailureJournal) }),
      tunnel: inspectRemoteTunnelHealth,
      credentials: () => ({ available: Boolean(vapidKeys), reasonCode: vapidCredentialReason }),
    })
    if (!vapidKeys) {
      operationsRuntime.logger.log({
        level: 'warn',
        event: 'operations.credentials.unavailable',
        outcome: 'degraded',
        component: 'push',
        reasonCode: vapidCredentialReason,
        attributes: { push_enabled: false },
      })
    }
    server = buildServer(db, (bus) => {
      agentOs.setBus(bus)
      maestro = new Conductor(db, bus, agentToken, { nativeEventSink: claudeNativeEventSink })
      agentOs.registerClaude(maestro)
      const codex = codexReady ? new CodexManagedAgentRuntime(db, bus, codexDriver, codexProvider) : undefined
      const qwen = qwenDriver ? new QwenManagedAgentRuntime(db, bus, qwenDriver) : undefined
      manager = new ProviderAgentManager(db, bus, maestro, codex, codexProvider, agentOs.jobExecutor, qwen)
      return manager
    }, {
      // Read lazily: `orgSync` is assigned after listen(), and the supervisor replaces its
      // loop over the daemon's lifetime, so this must never capture a snapshot.
      orgSyncStatus: () => ({
        joined: orgSync?.orgId() != null,
        orgId: orgSync?.orgId() ?? null,
        state: orgSync?.state() ?? 'off',
        detail: orgSync?.detail() ?? null,
      }),
      token,
      agentToken,
      localOwnerAuth,
      // local browsers skip the password; set ORCHESTRA_REQUIRE_LOCAL_PASSWORD=1 to restore the prompt
      trustLoopbackBrowsers: process.env.ORCHESTRA_REQUIRE_LOCAL_PASSWORD !== '1',
      autowakeAt: () => autowake?.scheduledAt() ?? null,
      operations: operationsRuntime,
      vapidKeys,
      admitMutation: () => safeShutdown.admitMutation(),
      isDraining: () => safeShutdown.draining,
      reconcileActiveWork,
      registerActiveWork: (registration) => safeShutdown.register(registration),
      agentOs: {
        runtime: agentOs.adapter,
        pasteImageRoot: path.join(orchestraDataDir, 'pasted'),
        jobExecutor: agentOs.jobExecutor,
        scheduler,
        orchestration,
        compatibilityFailureJournal,
        drivers: () => agentOs.descriptors(),
        terminalSessionState,
        resolveTerminalAccessContext: (request: FastifyRequest) => {
          const address = request.raw.socket.remoteAddress ?? ''
          const local = address === '::1'
            || address.startsWith('127.')
            || address.startsWith('::ffff:127.')
          const operator = request.orchestraPrincipal === 'operator'
          return {
            authenticated: operator || request.orchestraPrincipal === 'agent',
            principal: operator && local
              ? 'local_operator'
              : operator
                ? 'remote_device'
                : 'agent',
            surface: local ? 'desktop' : 'unknown',
            scopes: [],
          }
        },
      },
    })
    const inspectToolSurface = () => createDaemonProviderToolSurface({
      doctor: () => runOperatorReadinessDoctor('both'),
      discoveries: async () => {
        const [claude, codex] = await Promise.all([
          Promise.resolve(discoverClaudeProviderExecutableV1()),
          codexAdapter.discoverExecutable(),
        ])
        return {
          claude,
          codex,
          qwen: discoverQwenProviderExecutableV1(),
          kimi: discoverKimiProviderExecutableV1(),
        }
      },
      acceptanceEvidence: () => agentOs.providerAcceptanceEvidence.verified(),
      sourceCommit: () => providerToolEvidenceSourceCommit(),
      integrations: () => inspectDeclaredProviderToolIntegrations({
        scope: 'project',
        roots: { cwd: process.cwd() },
        pluginRoot: process.cwd(),
      }),
    })
    const toolSurface = await inspectToolSurface()
    server.register(sessionToolPlugin, {
      prefix: '/api/v1/os',
      db,
      registry: toolSurface.registry,
      providerMatrix: toolSurface.matrix,
      isOperator: (request: FastifyRequest) => request.orchestraPrincipal === 'operator',
    })
    const refreshToolSurface = createDaemonProviderToolSurfaceRefresher(
      toolSurface,
      inspectToolSurface,
      () => {
        const integrations = inspectDeclaredProviderToolIntegrations({
          scope: 'project',
          roots: { cwd: process.cwd() },
          pluginRoot: process.cwd(),
        })
        return createDeclaredProviderToolRegistry({}, integrations)
      },
    )
    toolEvidenceRefreshTimer = setInterval(() => {
      void refreshToolSurface()
    }, 60_000)
    toolEvidenceRefreshTimer.unref()
    registerPush(server, { vapidKeys })
  } catch (error) {
    await shutdownRuntimes()
    lease.release()
    throw error
  }
  const reconcileJobsAfterRestart = async () => {
    for (const s of survivors(db)) {
      if (s.name.startsWith('auditor-')) { // one-shot auditors don't outlive a restart
        db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(s.id)
        bounceDeadLetters(db, s.id)
        continue
      }
      try {
        // a launched agent resumes inside its card worktree, not the shared checkout (#59)
        const wt = s.launched_card_id != null ? cardWorktree(s.project_path, s.launched_card_id) : null
        const agentOsCwd = s.agent_os_worktree_path ?? s.agent_os_root_path
        const remainingTokens = s.agent_os_budget_tokens == null ? undefined
          : Number(s.agent_os_budget_tokens) - Number(s.agent_os_spent_tokens ?? 0)
        const remainingCents = s.agent_os_budget_cents == null ? undefined
          : Number(s.agent_os_budget_cents) - Number(s.agent_os_spent_cents ?? 0)
        if (remainingTokens !== undefined && remainingTokens <= 0) throw new Error('job token budget is exhausted')
        if (remainingCents !== undefined && remainingCents <= 0) throw new Error('job cost budget is exhausted')
        // Durable Agent OS Codex jobs are reattached once by the job executor below;
        // consuming the same driver event stream from the legacy runtime would race it.
        if (s.provider === CODEX_PROVIDER_ID && s.agent_os_workspace_id) continue
        manager!.hire({ boardId: s.board_id, cwd: agentOsCwd ?? (wt && fs.existsSync(wt) ? wt : s.project_path), name: s.name,
          provider: s.provider ?? 'claude', role: s.role ?? undefined,
          resumeSession: s.external_session_id ?? s.sdk_session ?? undefined,
          permissionMode: s.permission_mode ?? undefined,
          accessProfile: s.access_profile as AccessProfile | undefined,
          model: s.model ?? undefined, effort: s.effort ?? undefined,
          cardId: s.agent_os_card_id == null ? undefined : Number(s.agent_os_card_id),
          maxBudgetUsd: remainingCents === undefined ? undefined : remainingCents / 100,
          taskBudgetTokens: remainingTokens })
        manager!.adoptLaunch(s.id)
        manager!.resumeInterrupted(s.id)
      } catch (error) {
        if (error instanceof ProviderUnavailableError) {
          db.prepare(`UPDATE agents SET status='paused_provider', last_seen=datetime('now') WHERE id=?`).run(s.id)
          continue
        }
        // could not respawn — keep the agent's cards, just mark it gone
        db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(s.id)
        bounceDeadLetters(db, s.id)
      }
    }
    return agentOs.reconcileJobs()
  }
  const recovery = new OperationsRecoveryService(db)
  const observeRecovery = (observation: OperationsRuntimeObservation): void => {
    operationsRuntime.metrics.increment('recovery_results_total', 1, {
      component: observation.source,
      result: observation.outcome,
    })
    operationsRuntime.logger.log({
      level: observation.outcome === 'failed' ? 'error' : 'info',
      event: `recovery.${observation.source}.${observation.outcome}`,
      outcome: observation.outcome === 'failed' ? 'failed' : 'succeeded',
      component: observation.source,
      attributes: {
        delivered: observation.delivered,
        retried: observation.retried,
        dead: observation.dead,
        failed_boards: observation.failedBoards,
      },
    })
  }
  const outbox = new OperationsOutboxWorker(recovery, {
    ownerId: lease.ownerId,
    observe: observeRecovery,
    destinations: {
      attention: {
        conformance: {
          mode: 'durable_idempotency_key',
          evidenceId: 'ops-outbox.attention.v1',
        },
        deliver: async (delivery, signal) => {
          if (signal.aborted) throw new Error('attention delivery aborted')
          recovery.consumeIdempotently({
            consumer: 'daemon-bus-attention',
            eventId: delivery.idempotencyKey,
            payload: delivery.payload,
          }, () => server.bus.emit('event', {
            type: 'attention',
            data: { payload: delivery.payload, idempotency_key: delivery.idempotencyKey },
          }))
        },
      },
      'remote-device-revocation': {
        conformance: {
          mode: 'durable_idempotency_key',
          evidenceId: 'ops-outbox.remote-device-revocation.v1',
        },
        deliver: async (delivery, signal) => {
          if (signal.aborted) throw new Error('remote-device-revocation delivery aborted')
          recovery.consumeIdempotently({
            consumer: 'daemon-bus-device-revocation',
            eventId: delivery.idempotencyKey,
            payload: delivery.payload,
          }, () => server.bus.emit('event', {
            type: 'remote-device-revocation',
            data: { payload: delivery.payload, idempotency_key: delivery.idempotencyKey },
          }))
        },
      },
      'remote-push-attention': {
        conformance: {
          mode: 'durable_idempotency_key',
          evidenceId: 'web-push.topic-sha256-outbox-key.v1',
        },
        deliver: async (delivery, signal) => {
          await deliverRemotePushOutbox(db, delivery, signal, vapidKeys)
        },
      },
    },
  })
  const retentionService = new OperationsRetentionService(db)
  const retention = new OperationsRetentionScheduler(retentionService, {
    observe: observeRecovery,
    authorizeCompaction: async (policy) => {
      const evidence = db.prepare(`SELECT id, actor_id FROM os_events
        WHERE board_id=? AND kind='operations.retention.authorized'
          AND actor_type='local_operator' AND actor_id IS NOT NULL
          AND json_extract(payload, '$.policy_updated_at')=?
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(
        policy.board_id,
        policy.updated_at,
      ) as { id: string; actor_id: string } | undefined
      return evidence ? {
        actorType: 'local_admin' as const,
        actorId: evidence.actor_id,
        auditEventId: evidence.id,
      } : null
    },
  })
  const operationsCoordinator = new OperationsRuntimeCoordinator({
    reconcileProcesses: () => agentOs.reconcileLost(),
    reconcileOrphans: () => recovery.reconcileOrphans({
      ownerId: lease.ownerId,
      ownsDaemonLease: (candidate) => candidate.ownerId === lease.ownerId && candidate.pid === process.pid,
    }),
    reconcileJobs: reconcileJobsAfterRestart,
    outbox,
    retention,
    shutdown: safeShutdown,
    retentionService,
    flush: async () => { await outbox.tick() },
  })
  let reapTimer: ReturnType<typeof setInterval> | undefined
  let schedulerTimer: ReturnType<typeof setInterval> | undefined
  let closing = false
  const stopProducers = () => {
    if (toolEvidenceRefreshTimer) clearInterval(toolEvidenceRefreshTimer)
    if (reapTimer) clearInterval(reapTimer)
    if (schedulerTimer) clearInterval(schedulerTimer)
    toolEvidenceRefreshTimer = undefined
    reapTimer = undefined
    schedulerTimer = undefined
    autowake?.stop()
  }
  const close = () => {
    if (closing) return
    closing = true
    stopProducers()
    void operationsCoordinator.close().then(async (report) => {
      assertOperationsShutdownClean(report)
      await server.close()
      try { fs.unlinkSync(path.join(dataDir(), 'daemon.pid')) } catch { /* already absent */ }
    }).catch((error: unknown) => {
      operationsRuntime.logger.log({
        level: 'error', event: 'shutdown.authority-retained', outcome: 'failed',
        component: 'shutdown', reasonCode: 'operator_intervention_required',
      })
      process.exitCode = 1
      closing = false
      process.stderr.write(`Fatal shutdown: ${error instanceof Error ? error.message : 'operator intervention required'}\n`)
    })
  }
  server.addHook('onClose', async () => {
    stopProducers()
    process.off('SIGTERM', close)
    process.off('SIGINT', close)
    await orgSync?.stop()
    const report = await operationsCoordinator.close()
    assertOperationsShutdownClean(report)
    operationsRuntime.close()
    const providerHooksInactive = await shutdownRuntimes()
    if (!providerHooksInactive) throw new Error('provider runtime and hook shutdown could not be proven')
    lease.release()
    db.close()
    writeDaemonQuiescenceReceipt({
      stateRoot: orchestraDataDir,
      databasePath,
      daemonPid: process.pid,
      daemonLeaseOwnerId: lease.ownerId,
      providerHooksInactive,
    })
  })
  let coordinatorStarted = false
  try {
    await operationsCoordinator.start()
    coordinatorStarted = true
    runtimeReconciled = true
    reconcileActiveWork()
    await server.listen({ host: opts.expose ? '0.0.0.0' : '127.0.0.1', port: port() })
    // Supervised, not started once: `orchestra org join` runs in a different process, so
    // the daemon watches the credential and connects without needing a restart.
    orgSync = await superviseDaemonOrgSync({
      home: orchestraDataDir,
      localDb: db,
      publishLocalChange: (event) => server.bus.emit('event', event),
      listLocalAgents: () => listLocalPresenceAgents(db),
      subscribeLocalChanges: (listener) => {
        server.bus.on('event', listener)
        return () => server.bus.off('event', listener)
      },
    })
  } catch (error) {
    if (coordinatorStarted) {
      const report = await operationsCoordinator.close()
      assertOperationsShutdownClean(report)
    }
    await shutdownRuntimes()
    lease.release()
    throw error
  }
  // limit-paused agents deliberately sit out the resurrect above — the autowake timer
  // (recomputed here from the live usage poll, never persisted) resumes them at window reset
  autowake = new Autowake(db, server.bus, (boardId) => manager!.wake(boardId))
  if (autowakeEnabled()) void autowake.reschedule()
  fs.writeFileSync(path.join(dataDir(), 'daemon.pid'), String(process.pid))
  const graphifySync = createGraphifyAutoSync(db)
  graphifySync.tick() // boards with a knowledge graph get a fresh Wiki at boot
  reapTimer = setInterval(() => { reap(db); reconcileActiveWork(); graphifySync.tick() }, 60_000)
  // best-effort: surface a freshly-upgraded Claude CLI's model catalog (e.g. a newly
  // released Opus) at boot, without waiting for the first agent to start
  void maestro?.refreshModelCatalog().catch(() => undefined)
  schedulerTimer = setInterval(() => { void scheduler.tick().catch(() => undefined) }, 2_000)
  void scheduler.tick().catch(() => undefined)

  process.once('SIGTERM', close)
  process.once('SIGINT', close)
}

async function healthy(timeoutMs = 300): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    const status = await res.json() as { live?: unknown; ok?: unknown }
    return status.live === true || status.ok === true
  } catch { return false }
}

// A daemon with hired agents drains every live session before it exits, which measured
// ~33s in practice, and only then releases the data-directory lease. The old budgets here
// were 5s to die and ~3s to boot, so a restart reliably started a replacement on top of a
// daemon that was still shutting down: the child hit the held lease, exited immediately,
// and the outgoing daemon then finished leaving. The result was no daemon at all, with no
// error anywhere — a clean SIGTERM shutdown prints no stack.
const DAEMON_EXIT_TIMEOUT_MS = 90_000
const DAEMON_BOOT_TIMEOUT_MS = 30_000

function daemonPid(): number | undefined {
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir(), 'daemon.pid'), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch { return undefined }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Resolves once no daemon holds the data directory: the recorded pid is gone *and* the
 * port stops answering. Both checks matter — the pidfile can outlive the process, and a
 * daemon mid-drain still serves /health.
 */
export async function waitForDaemonExit(timeoutMs = DAEMON_EXIT_TIMEOUT_MS): Promise<boolean> {
  const pid = daemonPid()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!(pid !== undefined && processAlive(pid)) && !(await healthy(200))) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * A daemon that answers and is not on its way out. Deliberately not keyed on `ready`:
 * readiness folds in probes (usage meters, observability) that legitimately fail on a
 * working machine, so a serving daemon can sit at ready:false indefinitely. `draining`
 * is the only field that distinguishes coming up from going down.
 */
async function daemonServing(timeoutMs = 300): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    const status = await res.json() as { live?: unknown; ok?: unknown; draining?: unknown }
    if (status.draining === true) return false
    return status.live === true || status.ok === true
  } catch { return false }
}

/** True once nothing owns the data directory: the recorded pid is gone and the port is quiet. */
async function daemonGone(): Promise<boolean> {
  const pid = daemonPid()
  if (pid !== undefined && processAlive(pid)) return false
  return !(await healthy(200))
}

export async function ensureDaemon(): Promise<boolean> {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
  // Three attempts: a child refused by a lease we failed to wait out is worth retrying,
  // and retrying always beats reporting failure with nothing left running.
  for (let attempt = 0; attempt < 3; attempt++) {
    // A daemon that is live but not ready is either booting or draining, and /health
    // cannot tell those apart — both read live:true, ready:false. So settle the question
    // by outcome: either it becomes ready (someone else's boot won, nothing to do), or
    // its process goes away and releases the lease.
    const settleBy = Date.now() + DAEMON_EXIT_TIMEOUT_MS
    for (;;) {
      if (await daemonServing()) return true
      if (await daemonGone()) break
      if (Date.now() >= settleBy) break
      await new Promise((r) => setTimeout(r, 200))
    }

    let childExited = false
    const child = spawn(process.execPath, [cli, 'serve'], { detached: true, stdio: 'ignore', env: process.env })
    child.once('exit', () => { childExited = true })
    child.unref()
    const bootBy = Date.now() + DAEMON_BOOT_TIMEOUT_MS
    while (Date.now() < bootBy) {
      if (await daemonServing()) return true
      // the child gave up (almost always the lease) — go round and wait properly
      if (childExited) break
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  return false
}

export function stopDaemon(): boolean {
  const pidFile = path.join(dataDir(), 'daemon.pid')
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); return true }
  catch { return false }
}

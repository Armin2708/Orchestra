import type Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import { buildServer } from './server.js'
import { reap, bounceDeadLetters } from './reaper.js'
import { cardWorktree } from './shipqueue.js'
import { Conductor } from './conductor.js'
import { ensureAgentToken, ensureToken } from './token.js'
import { registerPush } from './push.js'
import { Autowake, autowakeEnabled } from './autowake.js'
import { createAgentOsRuntime } from './agent-os/runtime-integration.js'
import { OrchestrationService } from './agent-os/orchestration-service.js'
import { acquireDaemonLease } from './agent-os/daemon-lease.js'
import { CODEX_PROVIDER_ID } from './agent-providers.js'
import {
  CodexAppServerService,
  CodexAppServerSupervisor,
  CodexProviderService,
  codexApprovalPolicyHandler,
} from './codex/index.js'
import { CodexAgentDriver } from './runtime/drivers/codex.js'
import {
  CodexManagedAgentRuntime,
  ProviderAgentManager,
  ProviderUnavailableError,
  type AccessProfile,
} from './provider-agent-manager.js'

export function dataDir(): string {
  const d = process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
  fs.mkdirSync(d, { recursive: true })
  return d
}
export function port(): number { return Number(process.env.ORCHESTRA_PORT ?? 4750) }
export const baseUrl = () => `http://127.0.0.1:${port()}`

export const authDisabled = () => process.env.ORCHESTRA_NO_AUTH === '1'

export interface ServeOptions { expose?: boolean }

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
  return Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    value !== undefined
    && !codexEnvironmentDenied(key)
    && (CODEX_ENV_ALLOWLIST.has(key.toUpperCase()) || key.toUpperCase().startsWith('LC_') || requested.has(key))))
}

export async function serve(opts: ServeOptions = {}): Promise<void> {
  // an exposed daemon is remote code execution for anyone who can reach the port
  if (opts.expose && authDisabled())
    throw new Error('--expose requires token auth — unset ORCHESTRA_NO_AUTH to start exposed')
  const db = openDb(path.join(dataDir(), 'orchestra.db'))
  const token = authDisabled() ? undefined : ensureToken()
  const agentToken = authDisabled() ? undefined : ensureAgentToken()
  const lease = acquireDaemonLease(db)
  let maestro: Conductor | undefined
  let manager: ProviderAgentManager | undefined
  let autowake: Autowake | undefined
  const agentOs = createAgentOsRuntime(db)
  const scheduler = agentOs.scheduler
  const orchestration = new OrchestrationService(db, scheduler)
  const codexCommand = process.env.ORCHESTRA_CODEX_COMMAND?.trim() || 'codex'
  const codexEnvironment = sanitizedCodexEnvironment()
  if (agentToken) codexEnvironment.ORCHESTRA_AGENT_TOKEN = agentToken
  const codexSupervisor = new CodexAppServerSupervisor({
    client: { requestTimeoutMs: 5_000 },
    process: { command: codexCommand, env: codexEnvironment, inheritEnv: false },
  })
  const codexRpc = new CodexAppServerService(codexSupervisor)
  const codexDriver = new CodexAgentDriver({
    service: codexRpc,
    workspaceForThread: (threadId) => codexWorkspaceForThread(db, threadId),
    tokenBudgetForThread: (threadId) => codexTokenBudgetForThread(db, threadId),
    onApprovalRequest: codexApprovalPolicyHandler(db),
  })
  const codexProvider = new CodexProviderService(db, codexRpc, codexSupervisor, { command: codexCommand })
  let runtimesClosed = false
  const shutdownRuntimes = async () => {
    if (runtimesClosed) return
    runtimesClosed = true
    await Promise.allSettled([agentOs.shutdown(), manager?.shutdown() ?? Promise.resolve()])
    await codexDriver.detachAll().catch(() => undefined)
    codexDriver.dispose()
    codexProvider.dispose()
    await codexSupervisor.stop().catch(() => undefined)
  }
  let codexReady = false
  let server: ReturnType<typeof buildServer>
  try {
    codexReady = await codexProvider.initialize()
    if (codexReady) agentOs.registerDriver(codexDriver)
    server = buildServer(db, (bus) => {
      agentOs.setBus(bus)
      maestro = new Conductor(db, bus, agentToken)
      agentOs.registerClaude(maestro)
      const codex = codexReady ? new CodexManagedAgentRuntime(db, bus, codexDriver, codexProvider) : undefined
      manager = new ProviderAgentManager(db, bus, maestro, codex, codexProvider, agentOs.jobExecutor)
      return manager
    }, {
      token,
      agentToken,
      autowakeAt: () => autowake?.scheduledAt() ?? null,
      agentOs: {
        runtime: agentOs.adapter,
        jobExecutor: agentOs.jobExecutor,
        scheduler,
        orchestration,
        drivers: () => agentOs.descriptors(),
      },
    })
    registerPush(server)
  } catch (error) {
    await shutdownRuntimes()
    lease.release()
    throw error
  }
  let reapTimer: ReturnType<typeof setInterval> | undefined
  let schedulerTimer: ReturnType<typeof setInterval> | undefined
  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    void server.close().finally(() => {
      try { fs.unlinkSync(path.join(dataDir(), 'daemon.pid')) } catch { /* already absent */ }
    })
  }
  server.addHook('onClose', async () => {
    if (reapTimer) clearInterval(reapTimer)
    if (schedulerTimer) clearInterval(schedulerTimer)
    autowake?.stop()
    process.off('SIGTERM', close)
    process.off('SIGINT', close)
    await shutdownRuntimes()
    lease.release()
  })
  try {
    await server.listen({ host: opts.expose ? '0.0.0.0' : '127.0.0.1', port: port() })
  } catch (error) {
    await shutdownRuntimes()
    lease.release()
    throw error
  }
  try {
    await agentOs.reconcileLost()
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
    await agentOs.reconcileJobs()
  } catch (error) {
    await server.close()
    throw error
  }
  // limit-paused agents deliberately sit out the resurrect above — the autowake timer
  // (recomputed here from the live usage poll, never persisted) resumes them at window reset
  autowake = new Autowake(db, server.bus, (boardId) => manager!.wake(boardId))
  if (autowakeEnabled()) void autowake.reschedule()
  fs.writeFileSync(path.join(dataDir(), 'daemon.pid'), String(process.pid))
  reapTimer = setInterval(() => reap(db), 60_000)
  schedulerTimer = setInterval(() => { void scheduler.tick().catch(() => undefined) }, 2_000)
  void scheduler.tick().catch(() => undefined)

  process.once('SIGTERM', close)
  process.once('SIGINT', close)
}

async function healthy(timeoutMs = 300): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return (await res.json()).ok === true
  } catch { return false }
}

export async function ensureDaemon(): Promise<boolean> {
  if (await healthy()) return true
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
  spawn(process.execPath, [cli, 'serve'], { detached: true, stdio: 'ignore', env: process.env }).unref()
  for (let i = 0; i < 30; i++) {
    if (await healthy(200)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

export function stopDaemon(): boolean {
  const pidFile = path.join(dataDir(), 'daemon.pid')
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); fs.unlinkSync(pidFile); return true }
  catch { return false }
}

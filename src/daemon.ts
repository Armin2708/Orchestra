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
import { ensureToken } from './token.js'
import { registerPush } from './push.js'
import { Autowake, autowakeEnabled } from './autowake.js'
import { createAgentOsRuntime } from './agent-os/runtime-integration.js'
import { acquireDaemonLease } from './agent-os/daemon-lease.js'

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
  SELECT a.id, a.name, a.board_id, a.role, a.sdk_session, a.permission_mode,
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

export async function serve(opts: ServeOptions = {}): Promise<void> {
  // an exposed daemon is remote code execution for anyone who can reach the port
  if (opts.expose && authDisabled())
    throw new Error('--expose requires token auth — unset ORCHESTRA_NO_AUTH to start exposed')
  const db = openDb(path.join(dataDir(), 'orchestra.db'))
  const token = authDisabled() ? undefined : ensureToken()
  let maestro: Conductor | undefined
  let autowake: Autowake | undefined
  const agentOs = createAgentOsRuntime(db)
  const scheduler = agentOs.scheduler
  const server = buildServer(db, (bus) => {
    agentOs.setBus(bus)
    maestro = new Conductor(db, bus)
    agentOs.registerClaude(maestro)
    return maestro
  }, {
    token,
    autowakeAt: () => autowake?.scheduledAt() ?? null,
    agentOs: {
      runtime: agentOs.adapter,
      jobExecutor: agentOs.jobExecutor,
      scheduler,
      drivers: () => agentOs.descriptors(),
    },
  })
  const lease = acquireDaemonLease(db)
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
    await Promise.allSettled([agentOs.shutdown(), maestro?.shutdown() ?? Promise.resolve()])
    lease.release()
  })
  registerPush(server)
  try {
    await server.listen({ host: opts.expose ? '0.0.0.0' : '127.0.0.1', port: port() })
  } catch (error) {
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
        maestro!.hire({ boardId: s.board_id, cwd: agentOsCwd ?? (wt && fs.existsSync(wt) ? wt : s.project_path), name: s.name,
          role: s.role ?? undefined, resumeSession: s.sdk_session ?? undefined,
          permissionMode: s.permission_mode ?? undefined,
          model: s.model ?? undefined, effort: s.effort ?? undefined,
          cardId: s.agent_os_card_id == null ? undefined : Number(s.agent_os_card_id),
          maxBudgetUsd: remainingCents === undefined ? undefined : remainingCents / 100,
          taskBudgetTokens: remainingTokens })
        maestro!.adoptLaunch(s.id)
      } catch {
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
  autowake = new Autowake(db, server.bus, (boardId) => maestro!.wake(boardId))
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

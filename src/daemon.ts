import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import { buildServer } from './server.js'
import { reap } from './reaper.js'
import { Conductor } from './conductor.js'
import { ensureToken } from './token.js'
import { registerPush } from './push.js'

export function dataDir(): string {
  const d = process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
  fs.mkdirSync(d, { recursive: true })
  return d
}
export function port(): number { return Number(process.env.ORCHESTRA_PORT ?? 4750) }
export const baseUrl = () => `http://127.0.0.1:${port()}`

export const authDisabled = () => process.env.ORCHESTRA_NO_AUTH === '1'

export interface ServeOptions { expose?: boolean }

export async function serve(opts: ServeOptions = {}): Promise<void> {
  // an exposed daemon is remote code execution for anyone who can reach the port
  if (opts.expose && authDisabled())
    throw new Error('--expose requires token auth — unset ORCHESTRA_NO_AUTH to start exposed')
  const db = openDb(path.join(dataDir(), 'orchestra.db'))
  const token = authDisabled() ? undefined : ensureToken()
  let maestro: Conductor | undefined
  const server = buildServer(db, (bus) => (maestro = new Conductor(db, bus)), { token })
  registerPush(server)
  await server.listen({ host: opts.expose ? '0.0.0.0' : '127.0.0.1', port: port() })
  // resurrect hired agents from before the restart — sessions resume, cards and work persist
  const survivors = db.prepare(`
    SELECT a.id, a.name, a.board_id, a.role, a.sdk_session, b.project_path
    FROM agents a JOIN boards b ON b.id = a.board_id
    WHERE a.kind='hired' AND a.status != 'gone'`).all() as any[]
  for (const s of survivors) {
    if (s.name.startsWith('auditor-')) { // one-shot auditors don't outlive a restart
      db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(s.id)
      continue
    }
    try {
      maestro!.hire({ boardId: s.board_id, cwd: s.project_path, name: s.name,
        role: s.role ?? undefined, resumeSession: s.sdk_session ?? undefined })
      maestro!.adoptLaunch(s.id)
    } catch {
      // could not respawn — keep the agent's cards, just mark it gone
      db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(s.id)
    }
  }
  fs.writeFileSync(path.join(dataDir(), 'daemon.pid'), String(process.pid))
  setInterval(() => reap(db), 60_000)
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

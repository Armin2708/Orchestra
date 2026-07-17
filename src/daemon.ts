import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import { buildServer } from './server.js'
import { reap } from './reaper.js'

export function dataDir(): string {
  const d = process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
  fs.mkdirSync(d, { recursive: true })
  return d
}
export function port(): number { return Number(process.env.ORCHESTRA_PORT ?? 4750) }
export const baseUrl = () => `http://127.0.0.1:${port()}`

export async function serve(): Promise<void> {
  const db = openDb(path.join(dataDir(), 'orchestra.db'))
  const server = buildServer(db)
  await server.listen({ host: '127.0.0.1', port: port() })
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

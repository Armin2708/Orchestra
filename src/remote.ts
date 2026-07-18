import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { authDisabled, dataDir, ensureDaemon, port } from './daemon.js'
import { ensureToken } from './token.js'

export type RemoteState = {
  provider: 'tailscale' | 'cloudflared'
  url: string
  pid?: number
  started_at: string
}

// other features (push deep links, status displays) read this file for the public base URL
export const remoteStatePath = () => path.join(dataDir(), 'remote.json')

export function readRemoteState(): RemoteState | undefined {
  try { return JSON.parse(fs.readFileSync(remoteStatePath(), 'utf8')) } catch { return undefined }
}

const writeState = (s: RemoteState) => {
  fs.writeFileSync(remoteStatePath(), JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  return s
}

const alive = (pid?: number) => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export const hasBin = (bin: string) => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0

// ── tailscale: serve proxies the tailnet HTTPS name to the local daemon ──
function tailscaleUrl(): string {
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('tailscale is installed but not running — start Tailscale and try again')
  const dns: string | undefined = JSON.parse(r.stdout)?.Self?.DNSName?.replace(/\.$/, '')
  if (!dns) throw new Error("could not read this machine's tailnet name from tailscale status")
  return `https://${dns}`
}

function startTailscale(): RemoteState {
  const r = spawnSync('tailscale', ['serve', '--bg', `http://127.0.0.1:${port()}`], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`tailscale serve failed: ${(r.stderr || r.stdout || '').trim()}`)
  return writeState({ provider: 'tailscale', url: tailscaleUrl(), started_at: new Date().toISOString() })
}

// ── cloudflared: quick tunnel, URL scraped from its log ──
async function startCloudflared(): Promise<RemoteState> {
  const log = path.join(dataDir(), 'cloudflared.log')
  fs.writeFileSync(log, '')
  const fd = fs.openSync(log, 'a')
  const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port()}`, '--no-autoupdate'],
    { detached: true, stdio: ['ignore', fd, fd] })
  child.unref()
  fs.closeSync(fd)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const m = fs.readFileSync(log, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (m) return writeState({ provider: 'cloudflared', url: m[0], pid: child.pid, started_at: new Date().toISOString() })
    if (child.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (child.pid) { try { process.kill(child.pid, 'SIGTERM') } catch { /* already dead */ } }
  throw new Error(`cloudflared did not report a tunnel URL — see ${log}`)
}

export async function startRemote(): Promise<{ state: RemoteState; reused: boolean }> {
  // an unauthenticated tunnel is remote code execution for anyone with the URL
  if (authDisabled()) throw new Error('remote requires token auth — unset ORCHESTRA_NO_AUTH first')
  const existing = readRemoteState()
  if (existing && (existing.provider === 'tailscale' ? hasBin('tailscale') : alive(existing.pid)))
    return { state: existing, reused: true }
  if (existing) fs.rmSync(remoteStatePath(), { force: true }) // stale — tunnel died
  if (!(await ensureDaemon())) throw new Error('daemon unreachable')
  if (hasBin('tailscale')) return { state: startTailscale(), reused: false }
  if (hasBin('cloudflared')) return { state: await startCloudflared(), reused: false }
  throw new Error([
    'no tunnel tool found — install one of:',
    '  tailscale   https://tailscale.com/download            (private to your tailnet — preferred)',
    '  cloudflared brew install cloudflared                  (public quick tunnel, random URL)',
  ].join('\n'))
}

export function stopRemote(): RemoteState | undefined {
  const s = readRemoteState()
  if (!s) return undefined
  if (s.provider === 'tailscale') spawnSync('tailscale', ['serve', 'reset'], { stdio: 'ignore' })
  else if (alive(s.pid)) { try { process.kill(s.pid!, 'SIGTERM') } catch { /* raced its exit */ } }
  fs.rmSync(remoteStatePath(), { force: true })
  return s
}

// the web app reads #token= on boot and stores it — one scan pairs the phone
export const pairUrl = (s: RemoteState) => `${s.url}/#token=${ensureToken()}`

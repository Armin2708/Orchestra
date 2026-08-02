import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { authDisabled, baseUrl, dataDir, ensureDaemon, port } from './daemon.js'
import { ensureToken } from './token.js'
import type { DeviceScope } from './agent-os/device-sessions.js'

export type RemoteState = {
  provider: 'tailscale' | 'cloudflared'
  url: string
  pid?: number
  process_fingerprint?: string
  started_at: string
}

export type StartRemoteOptions = {
  /** Required in addition to ORCHESTRA_REMOTE_PUBLIC_TUNNEL=1 for a public quick tunnel. */
  confirmPublic?: boolean
}

export const publicTunnelAllowed = (options: StartRemoteOptions = {}): boolean =>
  process.env.ORCHESTRA_REMOTE_PUBLIC_TUNNEL === '1' && options.confirmPublic === true

// other features (push deep links, status displays) read this file for the public base URL
export const remoteStatePath = () => path.join(dataDir(), 'remote.json')

const parseRemoteState = (serialized: string): RemoteState => {
  const value = JSON.parse(serialized) as Partial<RemoteState>
  if (value.provider !== 'tailscale' && value.provider !== 'cloudflared') throw new Error('invalid remote provider state')
  if (typeof value.url !== 'string' || !trustedHttpsOrigin(value.url)) throw new Error('invalid remote origin state')
  if (typeof value.started_at !== 'string' || Number.isNaN(Date.parse(value.started_at))) {
    throw new Error('invalid remote start time')
  }
  if (value.provider === 'cloudflared' && (!Number.isSafeInteger(value.pid)
    || typeof value.process_fingerprint !== 'string')) throw new Error('invalid cloudflared ownership state')
  return value as RemoteState
}

function recordedRemoteState(): RemoteState | undefined {
  if (!fs.existsSync(remoteStatePath())) return undefined
  try { return parseRemoteState(fs.readFileSync(remoteStatePath(), 'utf8')) }
  catch { throw new Error('remote state is corrupt or incompatible; refusing to lose tunnel ownership evidence') }
}

export function readRemoteState(): RemoteState | undefined {
  try { return recordedRemoteState() } catch { return undefined }
}

const writeState = (s: RemoteState) => {
  const destination = remoteStatePath()
  const temporary = `${destination}.tmp-${process.pid}`
  try {
    fs.writeFileSync(temporary, JSON.stringify(s, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, destination)
    fs.chmodSync(destination, 0o600)
    return s
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* preserve the original failure */ }
    throw error
  }
}

const alive = (pid?: number) => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

const trustedHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value.replace(/\/$/, '')
      && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

const processFingerprint = (pid?: number): string | undefined => {
  if (!alive(pid)) return undefined
  const result = spawnSync('ps', [
    '-p', String(pid), '-o', 'lstart=', '-o', 'command=',
  ], { encoding: 'utf8' })
  const identity = result.status === 0 ? result.stdout.trim() : ''
  if (!identity || !/cloudflared(?:\s|$)/.test(identity)
    || !identity.includes(`tunnel --url http://127.0.0.1:${port()}`)) return undefined
  return createHash('sha256').update(identity).digest('hex')
}

const ownsCloudflared = (state: RemoteState): boolean => state.provider === 'cloudflared'
  && typeof state.process_fingerprint === 'string'
    && processFingerprint(state.pid) === state.process_fingerprint

const pause = (milliseconds: number): void => {
  const lock = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(lock, 0, 0, milliseconds)
}

const terminateCloudflared = (state: RemoteState): void => {
  if (!ownsCloudflared(state)) throw new Error('refusing to signal an unverified Cloudflare process')
  try { process.kill(state.pid!, 'SIGTERM') } catch { /* verify below */ }
  const deadline = Date.now() + 3_000
  while (alive(state.pid) && Date.now() < deadline) pause(25)
  if (alive(state.pid)) throw new Error('Cloudflare tunnel did not stop; ownership state was retained')
}

const tailscaleServeTargets = (): string[] | undefined => {
  const result = spawnSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8' })
  if (result.status !== 0) return undefined
  try {
    const strings: string[] = []
    const visit = (value: unknown): void => {
      if (typeof value === 'string') {
        // Serve status also contains public HTTPS frontends. Only backend proxy targets decide
        // whether resetting would remove non-Orchestra routes.
        if (/^http:\/\//.test(value)) strings.push(value.replace(/\/$/, ''))
        return
      }
      if (Array.isArray(value)) return value.forEach(visit)
      if (value && typeof value === 'object') Object.values(value).forEach(visit)
    }
    visit(JSON.parse(result.stdout))
    return [...new Set(strings)]
  } catch { return undefined }
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

const ownsTailscale = (state: RemoteState): boolean => {
  if (state.provider !== 'tailscale') return false
  const targets = tailscaleServeTargets()
  return targets?.length === 1
    && targets[0] === `http://127.0.0.1:${port()}`
    && tailscaleUrl() === state.url
}

async function remoteHealthy(state: RemoteState): Promise<boolean> {
  try {
    const response = await fetch(`${state.url}/health`, {
      signal: AbortSignal.timeout(3_000),
      redirect: 'error',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const value = await response.json() as { ok?: unknown; live?: unknown }
    return value.ok === true || value.live === true
  } catch { return false }
}

async function durableRemoteControlEnabled(): Promise<boolean> {
  const response = await fetch(`${baseUrl()}/api/v1/os/devices/remote-control`, {
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    headers: { authorization: `Bearer ${ensureToken()}`, accept: 'application/json' },
  })
  if (!response.ok) throw new Error('could not verify durable remote control state')
  const value = await response.json() as { state?: unknown }
  if (value.state !== 'enabled' && value.state !== 'disabled') {
    throw new Error('durable remote control state is invalid')
  }
  return value.state === 'enabled'
}

/** Live, ownership-bound tunnel evidence for readiness; corrupt state throws and degrades health. */
export async function inspectRemoteTunnelHealth(): Promise<
  | { enabled: false }
  | {
    enabled: true
    transport: RemoteState['provider']
    checkedAt: string
    reachable: boolean
    endToEndVerified: boolean
    originVerified: boolean
    authenticationVerified: boolean
  }
> {
  const state = recordedRemoteState()
  if (!state) return { enabled: false }
  const checkedAt = new Date().toISOString()
  const owned = state.provider === 'tailscale' ? ownsTailscale(state) : ownsCloudflared(state)
  const reachable = owned && await remoteHealthy(state)
  let authenticationVerified = false
  if (reachable) {
    try {
      const response = await fetch(`${state.url}/api/v1/boards`, {
        signal: AbortSignal.timeout(3_000), redirect: 'error', headers: { accept: 'application/json' },
      })
      authenticationVerified = response.status === 401
    } catch { /* report incomplete verification below */ }
  }
  return {
    enabled: true,
    transport: state.provider,
    checkedAt,
    reachable,
    originVerified: trustedHttpsOrigin(state.url),
    authenticationVerified,
    endToEndVerified: owned && reachable && authenticationVerified,
  }
}

function startTailscale(): RemoteState {
  const configured = tailscaleServeTargets()
  if (configured === undefined) throw new Error('could not verify Tailscale serve ownership')
  if (configured.length > 0) {
    throw new Error('Tailscale serve already has routes; refusing to replace non-Orchestra configuration')
  }
  const r = spawnSync('tailscale', ['serve', '--bg', `http://127.0.0.1:${port()}`], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`tailscale serve failed: ${(r.stderr || r.stdout || '').trim()}`)
  try {
    return writeState({ provider: 'tailscale', url: tailscaleUrl(), started_at: new Date().toISOString() })
  } catch (error) {
    const reset = spawnSync('tailscale', ['serve', 'reset'], { encoding: 'utf8' })
    if (reset.status !== 0 || (tailscaleServeTargets()?.length ?? -1) !== 0) {
      throw new Error('Tailscale startup failed and rollback could not be verified; inspect serve status')
    }
    throw error
  }
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
  try {
    while (Date.now() < deadline) {
      const m = fs.readFileSync(log, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      const fingerprint = processFingerprint(child.pid)
      if (m && fingerprint) return writeState({
        provider: 'cloudflared',
        url: m[0],
        pid: child.pid,
        process_fingerprint: fingerprint,
        started_at: new Date().toISOString(),
      })
      if (child.exitCode !== null) break
      await new Promise((r) => setTimeout(r, 250))
    }
  } catch (error) {
    if (child.pid) {
      const unrecorded: RemoteState = {
        provider: 'cloudflared', url: 'https://rollback.invalid', pid: child.pid,
        process_fingerprint: processFingerprint(child.pid), started_at: new Date().toISOString(),
      }
      if (unrecorded.process_fingerprint) terminateCloudflared(unrecorded)
    }
    throw error
  }
  if (child.pid) {
    const fingerprint = processFingerprint(child.pid)
    if (fingerprint) terminateCloudflared({
      provider: 'cloudflared', url: 'https://rollback.invalid', pid: child.pid,
      process_fingerprint: fingerprint, started_at: new Date().toISOString(),
    })
  }
  throw new Error(`cloudflared did not report a tunnel URL — see ${log}`)
}

export async function startRemote(
  options: StartRemoteOptions = {},
): Promise<{ state: RemoteState; reused: boolean }> {
  // an unauthenticated tunnel is remote code execution for anyone with the URL
  if (authDisabled()) throw new Error('remote requires token auth — unset ORCHESTRA_NO_AUTH first')
  if (process.env.ORCHESTRA_REMOTE_KILL_SWITCH === '1') {
    throw new Error('remote access is disabled by ORCHESTRA_REMOTE_KILL_SWITCH')
  }
  if (!(await ensureDaemon())) throw new Error('daemon unreachable')
  if (!(await durableRemoteControlEnabled())) {
    throw new Error('remote access is disabled by durable operator rollback; explicitly enable new pairing first')
  }
  const existing = recordedRemoteState()
  if (existing) {
    const owned = existing.provider === 'tailscale'
      ? ownsTailscale(existing)
      : ownsCloudflared(existing)
    if (!owned) throw new Error('recorded remote tunnel ownership could not be verified; refusing duplicate exposure')
    if (await remoteHealthy(existing)) return { state: existing, reused: true }
    if (existing.provider === 'cloudflared') terminateCloudflared(existing)
    else {
      const reset = spawnSync('tailscale', ['serve', 'reset'], { encoding: 'utf8' })
      if (reset.status !== 0 || (tailscaleServeTargets()?.length ?? -1) !== 0) {
        throw new Error('stale Tailscale exposure could not be stopped; state was retained')
      }
    }
    fs.rmSync(remoteStatePath(), { force: true })
  }
  if (hasBin('tailscale')) return { state: startTailscale(), reused: false }
  if (hasBin('cloudflared')) {
    if (!publicTunnelAllowed(options)) {
      throw new Error([
        'public Cloudflare tunnel is disabled by default',
        'set ORCHESTRA_REMOTE_PUBLIC_TUNNEL=1 and pass --public after reviewing the exposure warning',
      ].join(' — '))
    }
    return { state: await startCloudflared(), reused: false }
  }
  throw new Error([
    'no tunnel tool found — install one of:',
    '  tailscale   https://tailscale.com/download            (private to your tailnet — preferred)',
    '  cloudflared brew install cloudflared                  (public quick tunnel, random URL)',
  ].join('\n'))
}

export function stopRemote(): RemoteState | undefined {
  const s = recordedRemoteState()
  if (!s) return undefined
  if (s.provider === 'tailscale') {
    if (!ownsTailscale(s)) throw new Error('refusing to reset unverified Tailscale serve state')
    const stopped = spawnSync('tailscale', ['serve', 'reset'], { encoding: 'utf8' })
    if (stopped.status !== 0 || (tailscaleServeTargets()?.length ?? -1) !== 0) {
      throw new Error('Tailscale serve reset could not be verified; ownership state was retained')
    }
  } else {
    terminateCloudflared(s)
  }
  fs.rmSync(remoteStatePath(), { force: true })
  return s
}

/** Mint one origin-bound, one-time ticket locally; the owner token never enters the URL. */
export async function pairUrl(
  state: RemoteState,
  boardIds: readonly number[] = [],
  scopes?: readonly DeviceScope[],
): Promise<string> {
  const response = await fetch(`${baseUrl()}/api/v1/os/devices/pairing-tickets`, {
    method: 'POST',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: {
      authorization: `Bearer ${ensureToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expected_origin: state.url, board_ids: boardIds, scopes }),
  })
  if (!response.ok) throw new Error('the daemon refused to create a device pairing ticket')
  const value = await response.json() as { pairing_ticket?: unknown }
  if (typeof value.pairing_ticket !== 'string' || !value.pairing_ticket.startsWith('orchestra_pair_v1.')) {
    throw new Error('the daemon returned an invalid device pairing ticket')
  }
  return `${state.url}/#pair=${encodeURIComponent(value.pairing_ticket)}`
}

async function remoteControlRequest(
  endpoint: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  if (!(await ensureDaemon())) throw new Error('daemon unreachable')
  const response = await fetch(`${baseUrl()}${endpoint}`, {
    method: 'POST',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: {
      authorization: `Bearer ${ensureToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`daemon remote-control request failed (${response.status})`)
  return response.json() as Promise<Record<string, unknown>>
}

/** Operable local-owner emergency rollback; old remote authority is never restored. */
export function rollbackRemoteAccess(
  confirmation: string,
  reason = 'emergency remote rollback',
): Promise<Record<string, unknown>> {
  if (confirmation !== 'REVOKE_ALL_REMOTE_AUTHORITY') {
    throw new Error('rollback requires the exact confirmation REVOKE_ALL_REMOTE_AUTHORITY')
  }
  if (!reason.trim() || reason.length > 500) throw new Error('rollback reason must be 1-500 characters')
  return remoteControlRequest('/api/v1/os/devices/rollback', { confirm: confirmation, reason: reason.trim() })
}

/** Reopens only new pairing after rollback; no revoked credential or grant is restored. */
export function enableNewRemotePairing(confirmation: string): Promise<Record<string, unknown>> {
  if (confirmation !== 'ENABLE_NEW_REMOTE_PAIRING') {
    throw new Error('enable requires the exact confirmation ENABLE_NEW_REMOTE_PAIRING')
  }
  return remoteControlRequest('/api/v1/os/devices/rollback/enable', { confirm: confirmation })
}

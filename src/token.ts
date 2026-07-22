import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// mirrors daemon.dataDir() without importing it — token must stay import-cycle-free
const home = () => process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
export const tokenPath = () => path.join(home(), 'token')
const agentTokenPath = () => path.join(home(), 'agent-token')

export function loadToken(): string | undefined {
  try { return fs.readFileSync(tokenPath(), 'utf8').trim() || undefined } catch { return undefined }
}

export function loadAgentToken(): string | undefined {
  try { return fs.readFileSync(agentTokenPath(), 'utf8').trim() || undefined } catch { return undefined }
}

/** Agent subprocesses receive a scoped credential instead of the operator credential. */
export function loadClientToken(): string | undefined {
  return process.env.ORCHESTRA_AGENT_TOKEN?.trim() || loadToken()
}

// first run mints the secret; later runs reuse it so already-paired clients never go stale
export function ensureToken(): string {
  const existing = loadToken()
  if (existing) return existing
  const token = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(home(), { recursive: true })
  fs.writeFileSync(tokenPath(), token + '\n', { mode: 0o600 })
  return token
}

export function ensureAgentToken(): string {
  const existing = loadAgentToken()
  if (existing) return existing
  const token = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(home(), { recursive: true })
  fs.writeFileSync(agentTokenPath(), token + '\n', { mode: 0o600 })
  return token
}

export function tokenEquals(given: string | undefined, expected: string): boolean {
  if (!given) return false
  // hash both sides so timingSafeEqual gets equal lengths whatever the input
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

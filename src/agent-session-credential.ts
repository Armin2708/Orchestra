import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'

export const MANAGED_AGENT_BOOTSTRAP_ENV = 'ORCHESTRA_SESSION_BOOTSTRAP'
export const MANAGED_AGENT_HOME_SESSION_ENV = 'ORCHESTRA_AGENT_HOME_SESSION_ID'
export const MANAGED_AGENT_BOOTSTRAP_TTL_SECONDS = 600

export interface AgentSessionCredential {
  agentId: number
  provider: string
  sessionId: string
  sessionToken: string
}

export interface StoredSessionCredential {
  agent_id: number
  agent_name: string
  board_id?: number
  provider: string
  session_id: string
  session_token: string
  cwd?: string
}

export interface ManagedAgentLaunchBootstrap {
  nonce: string
  hash: string
}

export interface ManagedAgentBootstrapRegistration {
  agentId: number
  boardId: number
  agentName: string
  provider: string
  externalSessionId: string
  bootstrapNonce: string
  agentHomeSessionId?: string | null
}

export interface ManagedAgentBootstrapResult {
  agentId: number
  agentName: string
  boardId: number
  provider: string
  externalSessionId: string
  sessionToken: string
}

const BOOTSTRAP_REJECTED = Symbol('managed-agent-bootstrap-rejected')

/** Mints a launch-only bearer whose hash is persisted before the provider starts. */
export function issueManagedAgentLaunchBootstrap(): ManagedAgentLaunchBootstrap {
  const nonce = randomBytes(32).toString('base64url')
  return { nonce, hash: managedAgentCredentialHash(nonce) }
}

export function managedAgentCredentialHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Exact server-side CAS contract for consuming one managed launch bootstrap.
 * Raw launch and session credentials are returned once and never persisted.
 */
export function consumeManagedAgentLaunchBootstrap(
  db: Database.Database,
  input: ManagedAgentBootstrapRegistration,
): ManagedAgentBootstrapResult | null {
  if (!validBootstrapRegistration(input)) return null
  const bootstrapHash = managedAgentCredentialHash(input.bootstrapNonce)
  const sessionToken = randomBytes(32).toString('base64url')
  const sessionTokenHash = managedAgentCredentialHash(sessionToken)
  const consume = db.transaction(() => {
    const agent = db.prepare(`SELECT id, board_id, name, kind, status, provider,
        external_session_id, hook_token_hash
      FROM agents WHERE id=?`).get(input.agentId) as {
        id: number
        board_id: number
        name: string
        kind: string
        status: string
        provider: string
        external_session_id: string | null
        hook_token_hash: string | null
      } | undefined
    if (!agent
      || agent.board_id !== input.boardId
      || agent.name !== input.agentName
      || agent.kind !== 'hired'
      || agent.provider !== input.provider
      || !['active', 'starting', 'idle'].includes(agent.status)
      || (agent.external_session_id !== null
        && agent.external_session_id !== input.externalSessionId)
      || !secretHashMatches(bootstrapHash, agent.hook_token_hash)) throw BOOTSTRAP_REJECTED

    if (input.agentHomeSessionId) {
      const session = db.prepare(`SELECT id, agent_id, provider, external_id, status
        FROM agent_sessions WHERE id=?`).get(input.agentHomeSessionId) as {
          id: string
          agent_id: number | null
          provider: string
          external_id: string | null
          status: string
        } | undefined
      if (!session
        || (session.agent_id !== null && session.agent_id !== input.agentId)
        || session.provider !== input.provider
        || (session.external_id !== null
          && session.external_id !== input.externalSessionId)
        || !['reserved', 'starting', 'running', 'idle'].includes(session.status)) {
        throw BOOTSTRAP_REJECTED
      }
      const bound = db.prepare(`UPDATE agent_sessions SET agent_id=?, external_id=?,
          status=CASE WHEN status IN ('reserved','starting') THEN 'running' ELSE status END,
          started_at=COALESCE(started_at, datetime('now')), updated_at=datetime('now')
        WHERE id=? AND provider=? AND (agent_id IS NULL OR agent_id=?)
          AND (external_id IS NULL OR external_id=?)
          AND status IN ('reserved','starting','running','idle')`)
        .run(input.agentId, input.externalSessionId, input.agentHomeSessionId,
          input.provider, input.agentId, input.externalSessionId)
      if (bound.changes !== 1) throw BOOTSTRAP_REJECTED
    }

    const claimed = db.prepare(`UPDATE agents SET session_id=?, external_session_id=?,
        hook_token_hash=?, status='active', last_seen=datetime('now')
      WHERE id=? AND board_id=? AND name=? AND kind='hired' AND provider=?
        AND status IN ('active','starting','idle')
        AND hook_token_hash=?
        AND (external_session_id IS NULL OR external_session_id=?)
        AND last_seen >= datetime('now', '-${MANAGED_AGENT_BOOTSTRAP_TTL_SECONDS} seconds')`)
      .run(input.externalSessionId, input.externalSessionId, sessionTokenHash,
        input.agentId, input.boardId, input.agentName, input.provider,
        bootstrapHash, input.externalSessionId)
    if (claimed.changes !== 1) throw BOOTSTRAP_REJECTED
    return {
      agentId: input.agentId,
      agentName: input.agentName,
      boardId: input.boardId,
      provider: input.provider,
      externalSessionId: input.externalSessionId,
      sessionToken,
    }
  })
  try {
    return consume.immediate()
  } catch (error) {
    if (error === BOOTSTRAP_REJECTED) return null
    throw error
  }
}

/** Atomically persists the post-registration credential for the shared client. */
export function persistManagedAgentSessionCredential(value: StoredSessionCredential): string {
  if (!validStoredCredential(value)) throw new Error('managed agent session credential is invalid')
  const file = managedAgentSessionCredentialPath(value.provider, value.session_id)
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryStat = fs.lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid())) {
    throw new Error('managed agent credential directory is unsafe')
  }
  fs.chmodSync(directory, 0o700)
  const temporary = path.join(directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value))
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch { /* best effort */ }
  }
  return file
}

export function managedAgentSessionCredentialPath(provider: string, sessionId: string): string {
  if (!bounded(provider, 64) || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(provider)) {
    throw new Error('managed agent credential provider is invalid')
  }
  if (!bounded(sessionId, 512)) throw new Error('managed agent credential session is invalid')
  const sessions = path.join(orchestraHome(), 'sessions')
  return provider === 'claude'
    ? path.join(sessions, `${encodeURIComponent(sessionId)}.json`)
    : path.join(sessions, provider, `${encodeURIComponent(sessionId)}.json`)
}

/**
 * Loads only the current managed process's own hook credential. Ambiguous cwd-only
 * matches fail closed; named/id-bound managed launches may select their newest session.
 */
export function loadManagedAgentSessionCredential(
  cwd = process.cwd(),
): AgentSessionCredential | null {
  if (process.env.ORCHESTRA_MANAGED_AGENT !== '1') return null
  const expectedName = process.env.ORCHESTRA_NAME?.trim() || null
  const expectedId = positiveInteger(process.env.ORCHESTRA_AGENT_ID)
  const realCwd = realpath(cwd)
  const candidates = credentialFiles().flatMap((file) => {
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return []
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return []
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredSessionCredential
      if (!validStoredCredential(value)) return []
      if (expectedName && value.agent_name !== expectedName) return []
      if (expectedId && value.agent_id !== expectedId) return []
      const sessionCwd = value.cwd ? realpath(value.cwd) : null
      if (!expectedName && !expectedId
        && (!sessionCwd || (realCwd !== sessionCwd && !realCwd.startsWith(`${sessionCwd}${path.sep}`)))) {
        return []
      }
      return [{ value, mtimeMs: stat.mtimeMs }]
    } catch {
      return []
    }
  }).sort((left, right) => right.mtimeMs - left.mtimeMs)
  if (!candidates.length) return null
  if (!expectedName && !expectedId) {
    const identities = new Set(candidates.map(({ value }) =>
      `${value.agent_id}\0${value.provider}\0${value.session_id}`))
    if (identities.size !== 1) return null
  }
  const selected = candidates[0].value
  return {
    agentId: selected.agent_id,
    provider: selected.provider,
    sessionId: selected.session_id,
    sessionToken: selected.session_token,
  }
}

function credentialFiles(): string[] {
  const sessions = path.join(
    orchestraHome(),
    'sessions',
  )
  try {
    const entries = fs.readdirSync(sessions, { withFileTypes: true }).slice(0, 512)
    const files: string[] = []
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(path.join(sessions, entry.name))
      } else if (entry.isDirectory()) {
        const directory = path.join(sessions, entry.name)
        for (const nested of fs.readdirSync(directory, { withFileTypes: true }).slice(0, 512)) {
          if (nested.isFile() && nested.name.endsWith('.json')) {
            files.push(path.join(directory, nested.name))
          }
        }
      }
    }
    return files
  } catch {
    return []
  }
}

function orchestraHome(): string {
  return process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
}

function validBootstrapRegistration(value: ManagedAgentBootstrapRegistration): boolean {
  return Number.isSafeInteger(value.agentId) && value.agentId > 0
    && Number.isSafeInteger(value.boardId) && value.boardId > 0
    && bounded(value.agentName, 200)
    && bounded(value.provider, 64)
    && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.provider)
    && bounded(value.externalSessionId, 512)
    && bounded(value.bootstrapNonce, 512)
    && (value.agentHomeSessionId == null || bounded(value.agentHomeSessionId, 512))
}

function secretHashMatches(givenHash: string, expectedHash: string | null): boolean {
  if (!expectedHash || !/^[a-f0-9]{64}$/u.test(expectedHash)) return false
  return timingSafeEqual(Buffer.from(givenHash, 'hex'), Buffer.from(expectedHash, 'hex'))
}

function validStoredCredential(value: StoredSessionCredential): boolean {
  return Number.isSafeInteger(value.agent_id) && value.agent_id > 0
    && bounded(value.agent_name, 200)
    && bounded(value.provider, 64)
    && bounded(value.session_id, 512)
    && bounded(value.session_token, 512)
    && (value.board_id === undefined
      || (Number.isSafeInteger(value.board_id) && value.board_id > 0))
    && (value.cwd === undefined || bounded(value.cwd, 4096))
}

function bounded(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0
    && value.length <= limit && value === value.trim()
}

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function realpath(value: string): string {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

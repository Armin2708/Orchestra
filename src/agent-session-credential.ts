import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface AgentSessionCredential {
  agentId: number
  provider: string
  sessionId: string
  sessionToken: string
}

interface StoredSessionCredential {
  agent_id: number
  agent_name: string
  provider: string
  session_id: string
  session_token: string
  cwd?: string
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
    process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra'),
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

function validStoredCredential(value: StoredSessionCredential): boolean {
  return Number.isSafeInteger(value.agent_id) && value.agent_id > 0
    && bounded(value.agent_name, 200)
    && bounded(value.provider, 64)
    && bounded(value.session_id, 512)
    && bounded(value.session_token, 512)
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

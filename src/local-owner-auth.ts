import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SESSION_TTL_MS = 12 * 60 * 60 * 1_000
const MAX_FAILURES = 5
const FAILURE_WINDOW_MS = 60_000
const LOCKOUT_MS = 30_000

type PasswordRecord = {
  version: 1
  salt: string
  hash: string
}

type FailureWindow = {
  failures: number
  resetAt: number
  blockedUntil: number
}

export class LocalOwnerAuthError extends Error {
  constructor(
    public readonly code: 'password_not_configured' | 'password_already_configured' | 'password_invalid' | 'password_incorrect' | 'rate_limited',
    public readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

const defaultHome = () => process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
export const localOwnerPasswordPath = () => path.join(defaultHome(), 'owner-password.json')

const digestPassword = (password: string, salt: Buffer) =>
  crypto.scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1 }).toString('hex')

const digestSession = (session: string) => crypto.createHash('sha256').update(session).digest('hex')

const safeHexEqual = (left: string, right: string) => {
  if (!/^[0-9a-f]+$/iu.test(left) || !/^[0-9a-f]+$/iu.test(right)) return false
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const validatePassword = (password: string) => {
  if (password.length < 8) {
    throw new LocalOwnerAuthError('password_invalid', 400, 'Use at least 8 characters.')
  }
  if (password.length > 256 || /\0/u.test(password)) {
    throw new LocalOwnerAuthError('password_invalid', 400, 'Password format is invalid.')
  }
}

export class LocalOwnerPasswordAuth {
  private readonly sessions = new Map<string, number>()
  private readonly failures = new Map<string, FailureWindow>()
  private readonly sessionsFile: string

  constructor(
    private readonly passwordFile = localOwnerPasswordPath(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.sessionsFile = path.join(path.dirname(this.passwordFile), 'owner-sessions.json')
    this.loadSessions()
  }

  // Sessions persist as sha256 digests so a daemon restart does not sign the
  // owner out; the raw session value never touches disk.
  private loadSessions() {
    if (!this.isConfigured()) return
    let value: unknown
    try {
      value = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'))
    } catch {
      return
    }
    const record = value as { version?: unknown; sessions?: Record<string, unknown> } | null
    if (record?.version !== 1 || typeof record.sessions !== 'object' || !record.sessions) return
    for (const [digest, expiresAt] of Object.entries(record.sessions)) {
      if (/^[0-9a-f]{64}$/iu.test(digest) && typeof expiresAt === 'number' && expiresAt > this.now()) {
        this.sessions.set(digest, expiresAt)
      }
    }
  }

  private persistSessions() {
    for (const [digest, expiresAt] of this.sessions) {
      if (expiresAt <= this.now()) this.sessions.delete(digest)
    }
    if (!this.sessions.size) {
      try { fs.unlinkSync(this.sessionsFile) } catch { /* already absent */ }
      return
    }
    fs.writeFileSync(this.sessionsFile,
      `${JSON.stringify({ version: 1, sessions: Object.fromEntries(this.sessions) })}\n`, { mode: 0o600 })
  }

  isConfigured() {
    return fs.existsSync(this.passwordFile)
  }

  private readRecord(): PasswordRecord {
    let value: unknown
    try {
      value = JSON.parse(fs.readFileSync(this.passwordFile, 'utf8'))
    } catch {
      throw new LocalOwnerAuthError('password_not_configured', 409, 'Create a local owner password first.')
    }
    const record = value as Partial<PasswordRecord>
    if (record.version !== 1 || typeof record.salt !== 'string' || typeof record.hash !== 'string'
      || !/^[0-9a-f]{32}$/iu.test(record.salt) || !/^[0-9a-f]{64}$/iu.test(record.hash)) {
      throw new LocalOwnerAuthError('password_not_configured', 409, 'The local password record is invalid.')
    }
    return record as PasswordRecord
  }

  private issueSession() {
    const session = crypto.randomBytes(32).toString('hex')
    const expiresAt = this.now() + SESSION_TTL_MS
    this.sessions.set(digestSession(session), expiresAt)
    this.persistSessions()
    return { session, expiresAt: new Date(expiresAt).toISOString() }
  }

  setup(password: string) {
    validatePassword(password)
    if (this.isConfigured()) {
      throw new LocalOwnerAuthError('password_already_configured', 409, 'A local owner password already exists.')
    }
    const salt = crypto.randomBytes(16)
    const record: PasswordRecord = {
      version: 1,
      salt: salt.toString('hex'),
      hash: digestPassword(password, salt),
    }
    fs.mkdirSync(path.dirname(this.passwordFile), { recursive: true })
    try {
      fs.writeFileSync(this.passwordFile, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new LocalOwnerAuthError('password_already_configured', 409, 'A local owner password already exists.')
      }
      throw error
    }
    return this.issueSession()
  }

  login(password: string, partition = 'loopback') {
    this.verify(password, partition)
    return this.issueSession()
  }

  /** Same lockout accounting as login, but issues no session — for remote device sign-in. */
  verify(password: string, partition = 'loopback') {
    const now = this.now()
    const previous = this.failures.get(partition)
    if (previous && previous.blockedUntil > now) {
      throw new LocalOwnerAuthError('rate_limited', 429, 'Too many attempts. Wait a moment and try again.')
    }
    const record = this.readRecord()
    const actual = digestPassword(password, Buffer.from(record.salt, 'hex'))
    if (!safeHexEqual(actual, record.hash)) {
      const current = !previous || previous.resetAt <= now
        ? { failures: 0, resetAt: now + FAILURE_WINDOW_MS, blockedUntil: 0 }
        : previous
      current.failures += 1
      if (current.failures >= MAX_FAILURES) current.blockedUntil = now + LOCKOUT_MS
      this.failures.set(partition, current)
      throw new LocalOwnerAuthError('password_incorrect', 401, 'Password is incorrect.')
    }
    this.failures.delete(partition)
  }

  authenticate(session: string | undefined) {
    if (!this.isConfigured()) {
      this.sessions.clear()
      try { fs.unlinkSync(this.sessionsFile) } catch { /* already absent */ }
      return false
    }
    if (!session) return false
    const key = digestSession(session)
    const expiresAt = this.sessions.get(key)
    if (!expiresAt || expiresAt <= this.now()) {
      if (expiresAt) {
        this.sessions.delete(key)
        this.persistSessions()
      }
      return false
    }
    return true
  }
}

export function resetLocalOwnerPassword() {
  try {
    fs.unlinkSync(localOwnerPasswordPath())
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// mirrors daemon.dataDir() without importing it — password must stay import-cycle-free
const home = () => process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
export const passwordPath = () => path.join(home(), 'password.json')

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const
export const MIN_PASSWORD_LENGTH = 8

type StoredPassword = {
  algo: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
  hash: string
}

function readStored(): StoredPassword | undefined {
  let raw: string
  try { raw = fs.readFileSync(passwordPath(), 'utf8') } catch { return undefined }
  try {
    const value = JSON.parse(raw) as Partial<StoredPassword>
    if (value.algo !== 'scrypt'
      || ![value.N, value.r, value.p].every((n) => Number.isSafeInteger(n) && Number(n) > 0)
      || typeof value.salt !== 'string' || typeof value.hash !== 'string') return undefined
    return value as StoredPassword
  } catch { return undefined }
}

export function hasPassword(): boolean {
  return readStored() !== undefined
}

export function setPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT)
  const stored: StoredPassword = {
    algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString('base64'), hash: hash.toString('base64'),
  }
  fs.mkdirSync(home(), { recursive: true })
  const destination = passwordPath()
  const temporary = `${destination}.tmp-${process.pid}`
  fs.writeFileSync(temporary, JSON.stringify(stored) + '\n', { mode: 0o600 })
  fs.renameSync(temporary, destination)
  fs.chmodSync(destination, 0o600)
}

export function clearPassword(): boolean {
  if (!fs.existsSync(passwordPath())) return false
  fs.rmSync(passwordPath(), { force: true })
  return true
}

/** Fresh read every call so set/clear applies without a daemon restart. Timing-safe compare. */
export function verifyPassword(candidate: string): boolean {
  const stored = readStored()
  if (!stored || typeof candidate !== 'string' || candidate.length === 0) return false
  let derived: Buffer
  try {
    derived = crypto.scryptSync(candidate, Buffer.from(stored.salt, 'base64'), SCRYPT.keylen, {
      N: stored.N, r: stored.r, p: stored.p,
    })
  } catch { return false }
  const expected = Buffer.from(stored.hash, 'base64')
  if (expected.length !== derived.length) return false
  return crypto.timingSafeEqual(derived, expected)
}

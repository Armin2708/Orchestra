import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from './daemon.js'

/**
 * What `orchestra login` leaves behind: proof of who you are, not access to any one
 * organization. Connecting a daemon still mints a separate device token per org — see
 * docs/superpowers/specs/2026-08-30-orchestra-cli-login-design.md.
 */
export interface CliCredential {
  hubBaseUrl: string
  token: string
  email: string
}

const credentialPath = (home?: string) => path.join(home ?? dataDir(), 'cli-auth.json')

const isCredential = (value: unknown): value is CliCredential => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CliCredential>
  if (typeof candidate.hubBaseUrl !== 'string' || typeof candidate.token !== 'string'
    || typeof candidate.email !== 'string') return false
  if (!candidate.token || !candidate.email) return false
  try {
    const url = new URL(candidate.hubBaseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Written the same way the org credential is: temp file, fsync, rename, mode 0600. */
export async function saveCliCredential(credential: CliCredential, home?: string): Promise<void> {
  if (!isCredential(credential)) throw new Error('cannot save an invalid CLI credential')
  const destination = credentialPath(home)
  const directory = path.dirname(destination)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.cli-auth.json.${process.pid}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, destination)
    await fs.chmod(destination, 0o600)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** A corrupt file returns null rather than throwing: it must never stop the CLI running. */
export async function loadCliCredential(home?: string): Promise<CliCredential | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(credentialPath(home), 'utf8'))
    return isCredential(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function clearCliCredential(home?: string): Promise<void> {
  await fs.rm(credentialPath(home), { force: true })
}

/**
 * Whether the startup splash has already offered a cloud sign-in and been declined.
 *
 * Asking once is a helpful nudge; asking on every daemon start is a nuisance in the free
 * local product, which must remain fully usable without an account. The status line stays
 * either way, so the option never becomes undiscoverable.
 */
export async function cloudSignInDeclined(home?: string): Promise<boolean> {
  try {
    await fs.access(path.join(home ?? dataDir(), 'cloud-signin-declined'))
    return true
  } catch {
    return false
  }
}

export async function declineCloudSignIn(home?: string): Promise<void> {
  const directory = home ?? dataDir()
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(directory, 'cloud-signin-declined'), `${new Date().toISOString()}\n`, { mode: 0o600 })
}

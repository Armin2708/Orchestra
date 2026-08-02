import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'

export interface PlatformCredentialStore {
  readonly facility: string
  isAvailable(): Promise<boolean>
  put(reference: string, secret: Uint8Array): Promise<void>
  get(reference: string): Promise<Uint8Array | null>
  /** Atomically replaces current with replacement, or leaves current unchanged on failure. */
  replace(currentReference: string, replacementReference: string, secret: Uint8Array): Promise<void>
  delete(reference: string): Promise<void>
}

type CredentialMap = Record<string, string>

const KEYCHAIN_COMMAND = '/usr/bin/security'

const runSecurity = (
  args: readonly string[],
  input?: string,
): Promise<{ stdout: string; stderr: string }> => new Promise((resolve, reject) => {
  const child = spawn(KEYCHAIN_COMMAND, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let bytes = 0
  const collect = (target: Buffer[], chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 4 * 1024 * 1024) child.kill('SIGKILL')
    else target.push(chunk)
  }
  child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
  child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
  child.once('error', reject)
  child.once('close', (code) => {
    const output = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
    if (code === 0) resolve(output)
    else reject(Object.assign(new Error('macOS Keychain operation failed'), { code: `KEYCHAIN_EXIT_${code}`, ...output }))
  })
  if (input === undefined) child.stdin.end()
  else child.stdin.end(`${input}\n`, 'utf8')
})

/**
 * Real macOS Keychain adapter. A single Keychain item contains a bounded reference map, allowing
 * rotation to replace old/new references in one Keychain update. Secret bytes travel over stdin,
 * never argv, environment, files, logs, or SQLite.
 */
export class MacOsKeychainCredentialStore implements PlatformCredentialStore {
  readonly facility = 'macos-keychain'
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly account = 'orchestra',
    private readonly service = 'orchestra.operations.credentials',
  ) {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(account) || !/^[A-Za-z0-9._-]{1,128}$/u.test(service)) {
      throw new Error('invalid Keychain account or service')
    }
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin') return false
    try { accessSync(KEYCHAIN_COMMAND, constants.X_OK); return true } catch { return false }
  }

  async put(reference: string, secret: Uint8Array): Promise<void> {
    await this.mutate((values) => {
      if (values[reference]) throw new Error('credential reference already exists')
      values[reference] = Buffer.from(secret).toString('base64')
    })
  }

  async get(reference: string): Promise<Uint8Array | null> {
    const encoded = (await this.read())[reference]
    return encoded ? Uint8Array.from(Buffer.from(encoded, 'base64')) : null
  }

  async replace(currentReference: string, replacementReference: string, secret: Uint8Array): Promise<void> {
    await this.mutate((values) => {
      if (!values[currentReference]) throw new Error('current credential reference is unavailable')
      if (values[replacementReference]) throw new Error('replacement credential reference already exists')
      delete values[currentReference]
      values[replacementReference] = Buffer.from(secret).toString('base64')
    })
  }

  async delete(reference: string): Promise<void> {
    await this.mutate((values) => { delete values[reference] })
  }

  private mutate(change: (values: CredentialMap) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      const values = await this.read()
      change(values)
      const entries = Object.entries(values)
      if (entries.length > 1_000) throw new Error('credential reference capacity exceeded')
      await runSecurity([
        'add-generic-password', '-a', this.account, '-s', this.service,
        '-U', '-T', process.execPath, '-w',
      ], JSON.stringify(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))))
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }

  private async read(): Promise<CredentialMap> {
    try {
      const { stdout } = await runSecurity([
        'find-generic-password', '-a', this.account, '-s', this.service, '-w',
      ])
      const parsed = JSON.parse(stdout.trim()) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Keychain credential map is invalid')
      }
      const values: CredentialMap = {}
      for (const [reference, encoded] of Object.entries(parsed)) {
        if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
          throw new Error('Keychain credential map is invalid')
        }
        values[reference] = encoded
      }
      return values
    } catch (error) {
      if ((error as { code?: string }).code === 'KEYCHAIN_EXIT_44') return {}
      throw error
    }
  }
}

export const createPlatformCredentialStore = (): PlatformCredentialStore =>
  new MacOsKeychainCredentialStore()

export interface ProtectedCredentialReference {
  id: string
  facility: string
  credential_ref: string
  created_at: string
  expires_at: string
}

export class PlatformCredentialUnavailableError extends Error {
  readonly code = 'PLATFORM_CREDENTIAL_STORE_UNAVAILABLE'
}

/**
 * Stores credential bytes only through an injected OS/platform facility. There is intentionally
 * no plaintext file or database fallback; startup and rotation fail closed when the facility is
 * unavailable. Durable application records retain only the opaque credential_ref.
 */
export class ProtectedCredentialVault {
  constructor(
    private readonly store: PlatformCredentialStore,
    private readonly namespace = 'orchestra',
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!/^[a-z][a-z0-9.-]{1,63}$/.test(namespace)) throw new Error('invalid credential namespace')
    if (!/^[a-z][a-z0-9._-]{1,63}$/.test(store.facility)) {
      throw new Error('invalid platform credential facility')
    }
  }

  async protect(secret: Uint8Array, ttlMs: number): Promise<ProtectedCredentialReference> {
    if (!(await this.store.isAvailable())) throw new PlatformCredentialUnavailableError(
      `secure credential facility unavailable: ${this.store.facility}`,
    )
    if (!(secret instanceof Uint8Array) || secret.byteLength < 16) {
      throw new Error('credential material must contain at least 16 bytes')
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 365 * 24 * 60 * 60_000) {
      throw new Error('credential expiry must be from one minute to one year')
    }
    const nowMs = this.trustedNowMs()
    const id = randomUUID()
    const credentialRef = `${this.namespace}:${id}`
    const created = new Date(nowMs)
    await this.store.put(credentialRef, Uint8Array.from(secret))
    return Object.freeze({
      id,
      facility: this.store.facility,
      credential_ref: credentialRef,
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + ttlMs).toISOString(),
    })
  }

  async resolve(reference: ProtectedCredentialReference): Promise<Uint8Array> {
    const { credentialRef, createdAtMs, expiresAtMs } = this.assertReference(reference)
    const nowMs = this.trustedNowMs()
    if (!(await this.store.isAvailable())) throw new PlatformCredentialUnavailableError(
      `secure credential facility unavailable: ${this.store.facility}`,
    )
    if (createdAtMs > nowMs) throw new Error('credential reference creation time is in the future')
    if (expiresAtMs <= nowMs) {
      throw new Error('credential reference expired')
    }
    const material = await this.store.get(credentialRef)
    if (!material) throw new Error('credential reference missing or revoked')
    return Uint8Array.from(material)
  }

  async rotate(
    current: ProtectedCredentialReference,
    replacement: Uint8Array,
    ttlMs: number,
  ): Promise<ProtectedCredentialReference> {
    const { credentialRef: currentCredentialRef, createdAtMs, expiresAtMs } = this.assertReference(current)
    const nowMs = this.trustedNowMs()
    if (createdAtMs > nowMs) throw new Error('credential reference creation time is in the future')
    if (expiresAtMs <= nowMs) throw new Error('cannot rotate an expired credential reference')
    if (!(await this.store.isAvailable())) throw new PlatformCredentialUnavailableError(
      `secure credential facility unavailable: ${this.store.facility}`,
    )
    if (!(replacement instanceof Uint8Array) || replacement.byteLength < 16) {
      throw new Error('credential material must contain at least 16 bytes')
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 365 * 24 * 60 * 60_000) {
      throw new Error('credential expiry must be from one minute to one year')
    }
    const id = randomUUID()
    const credentialRef = `${this.namespace}:${id}`
    const created = new Date(nowMs)
    await this.store.replace(currentCredentialRef, credentialRef, Uint8Array.from(replacement))
    return Object.freeze({
      id,
      facility: this.store.facility,
      credential_ref: credentialRef,
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + ttlMs).toISOString(),
    })
  }

  async revoke(reference: ProtectedCredentialReference): Promise<void> {
    const { credentialRef } = this.assertReference(reference)
    if (!(await this.store.isAvailable())) throw new PlatformCredentialUnavailableError(
      `secure credential facility unavailable: ${this.store.facility}`,
    )
    await this.store.delete(credentialRef)
  }

  private assertReference(reference: ProtectedCredentialReference): {
    credentialRef: string
    createdAtMs: number
    expiresAtMs: number
  } {
    if (!reference || typeof reference !== 'object') {
      throw new Error('credential reference does not belong to this vault')
    }
    const { facility, credential_ref: credentialRef, id, created_at: createdAt, expires_at: expiresAt } = reference
    if (facility !== this.store.facility
      || typeof credentialRef !== 'string'
      || !credentialRef.startsWith(`${this.namespace}:`)
      || typeof id !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(id)
      || credentialRef !== `${this.namespace}:${id}`) {
      throw new Error('credential reference does not belong to this vault')
    }
    const createdAtMs = canonicalTimestamp(createdAt, 'credential creation time')
    const expiresAtMs = canonicalTimestamp(expiresAt, 'credential expiry')
    const lifetimeMs = expiresAtMs - createdAtMs
    if (lifetimeMs < 60_000 || lifetimeMs > 365 * 24 * 60 * 60_000) {
      throw new Error('credential reference has invalid lifetime')
    }
    return { credentialRef, createdAtMs, expiresAtMs }
  }

  private trustedNowMs(): number {
    let candidate: Date
    try {
      candidate = this.clock()
    } catch {
      throw new Error('trusted credential clock unavailable')
    }
    if (!(candidate instanceof Date)) throw new Error('trusted credential clock unavailable')
    let value: number
    try {
      value = Date.prototype.getTime.call(candidate)
    } catch {
      throw new Error('trusted credential clock unavailable')
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('trusted credential clock unavailable')
    }
    return value
  }
}

function canonicalTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${field} must be a canonical UTC timestamp`)
  }
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || new Date(parsed).toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC timestamp`)
  }
  return parsed
}

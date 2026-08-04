export type BrowserAuthorityMode = 'local-owner' | 'paired-device' | 'pairing-required'

type StoredDeviceAuthority = {
  credential: string
  credentialId: string
  credentialGeneration: number
  privateKey: CryptoKey
  publicJwk: JsonWebKey
  deviceSessionId: string
  credentialExpiresAt: string
  tunnelOrigin: string
}

type StagedKeyMaterial = {
  purpose: 'pair' | 'rotate'
  privateKey: CryptoKey
  publicJwk: JsonWebKey
  requestId: string
  createdAt: string
}

export type DeviceCredentialRotationChallenge = {
  schema_version: 1
  operation: 'device.credential.rotate'
  method: 'POST'
  path: '/api/v1/os/devices/self/credential/rotate'
  device_session_id: string
  current_credential_id: string
  current_credential_generation: number
  new_public_key_thumbprint: string
  request_id: string
  tunnel_origin: string
}

const DB_NAME = 'orchestra-device-authority-v1'
const STORE = 'authority'
const RECORD = 'current'
const STAGED = 'staged-key-material'
const DEVICE_CREDENTIAL_PREFIX = 'orchestra_device_v1.'

export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'

export const isLoopbackBrowser = (): boolean =>
  typeof location !== 'undefined' && isLoopbackHostname(location.hostname)

const openAuthorityDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(new Error('device credential storage is unavailable'))
})

const transaction = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const db = await openAuthorityDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = operation(tx.objectStore(STORE))
    let result: T
    request.onsuccess = () => { result = request.result }
    request.onerror = () => reject(new Error('device credential storage failed closed'))
    tx.oncomplete = () => { db.close(); resolve(result) }
    tx.onabort = () => { db.close(); reject(new Error('device credential storage transaction aborted')) }
    tx.onerror = () => { db.close(); reject(new Error('device credential storage transaction failed')) }
  })
}

const validExpiry = (value: string): boolean => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > Date.now()
}

const validStoredAuthority = (value: unknown): value is StoredDeviceAuthority => {
  if (!value || typeof value !== 'object') return false
  const authority = value as Partial<StoredDeviceAuthority>
  return Boolean(
    authority.privateKey?.type === 'private'
    && !authority.privateKey.extractable
    && authority.privateKey.algorithm.name === 'ECDSA'
    && typeof authority.credential === 'string'
    && authority.credential.startsWith(DEVICE_CREDENTIAL_PREFIX)
    && typeof authority.credentialId === 'string'
    && authority.credentialId.length > 0
    && Number.isSafeInteger(authority.credentialGeneration)
    && Number(authority.credentialGeneration) >= 0
    && typeof authority.deviceSessionId === 'string'
    && authority.deviceSessionId.length > 0
    && typeof authority.credentialExpiresAt === 'string'
    && validExpiry(authority.credentialExpiresAt)
    && typeof authority.tunnelOrigin === 'string'
    && authority.tunnelOrigin === location.origin,
  )
}

export const readDeviceAuthority = async (): Promise<StoredDeviceAuthority | null> => {
  if (typeof indexedDB === 'undefined') return null
  const value = await transaction<unknown>('readonly', (store) => store.get(RECORD))
  if (!validStoredAuthority(value)) {
    if (value !== undefined) await clearRejectedCurrentDeviceAuthority()
    return null
  }
  return value
}

const stageKeyMaterial = async (stage: StagedKeyMaterial): Promise<void> => {
  await transaction<IDBValidKey>('readwrite', (store) => store.put(stage, STAGED))
}

const clearStagedKeyMaterial = async (): Promise<void> => {
  await transaction<undefined>('readwrite', (store) => store.delete(STAGED))
}

let pendingIssuedAuthority: StoredDeviceAuthority | null = null

const commitIssuedAuthority = async (authority: StoredDeviceAuthority): Promise<void> => {
  if (!validStoredAuthority(authority)) throw new Error('refusing to store invalid device authority')
  pendingIssuedAuthority = authority
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const db = await openAuthorityDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        store.put(authority, RECORD)
        store.delete(STAGED)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => { db.close(); reject(new Error('device authority commit aborted')) }
        tx.onerror = () => { db.close(); reject(new Error('device authority commit failed')) }
      })
      pendingIssuedAuthority = null
      return
    } catch (cause) { lastError = cause }
  }
  throw new Error(`The server issued new device authority but protected storage failed. Keep this tab open and use Recover credential storage; if recovery fails, revoke this device from another trusted device and pair again. ${lastError instanceof Error ? lastError.message : ''}`.trim())
}

export const hasPendingDeviceAuthorityRecovery = (): boolean => pendingIssuedAuthority !== null

export const recoverPendingDeviceAuthority = async (): Promise<boolean> => {
  if (!pendingIssuedAuthority) return false
  await commitIssuedAuthority(pendingIssuedAuthority)
  return true
}

const clearStoredDeviceAuthority = async (discardPendingIssue: boolean): Promise<void> => {
  if (typeof indexedDB !== 'undefined') {
    const db = await openAuthorityDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      store.delete(RECORD)
      if (discardPendingIssue || pendingIssuedAuthority === null) store.delete(STAGED)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(new Error('device authority clear aborted')) }
      tx.onerror = () => { db.close(); reject(new Error('device authority clear failed')) }
    })
  }
  if (discardPendingIssue) pendingIssuedAuthority = null
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration()
    registration?.active?.postMessage({ type: 'PURGE_DEVICE_DATA' })
  }
}

/** A rejected old credential must not erase a newer issued authority awaiting storage recovery. */
export const clearRejectedCurrentDeviceAuthority = async (): Promise<void> =>
  clearStoredDeviceAuthority(false)

/** Explicitly discard current and pending authority, including staged key material. */
export const clearDeviceAuthority = async (): Promise<void> =>
  clearStoredDeviceAuthority(true)

const base64url = (value: ArrayBuffer | Uint8Array): string => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

// TextEncoder always allocates an ArrayBuffer-backed view. Keep that fact in the type so the
// stricter WebCrypto BufferSource declarations do not widen it to SharedArrayBuffer.
const utf8 = (value: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>

export async function remoteMutationDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', utf8(JSON.stringify(value)))
  return `sha256:${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export async function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function devicePublicKeyThumbprint(publicJwk: JsonWebKey): Promise<string> {
  if (publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256'
    || typeof publicJwk.x !== 'string' || typeof publicJwk.y !== 'string' || publicJwk.d) {
    throw new Error('rotation requires a public P-256 JWK')
  }
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y })
  return base64url(await crypto.subtle.digest('SHA-256', utf8(canonical)))
}

export async function buildCredentialRotationRequest(input: {
  currentPrivateKey: CryptoKey
  newPrivateKey: CryptoKey
  newPublicJwk: JsonWebKey
  deviceSessionId: string
  currentCredentialId: string
  currentCredentialGeneration: number
  requestId: string
  tunnelOrigin: string
}): Promise<{
  body: { new_public_key_jwk: JsonWebKey }
  challenge: DeviceCredentialRotationChallenge
  currentKeyProof: string
  newKeyProof: string
}> {
  const challenge: DeviceCredentialRotationChallenge = {
    schema_version: 1,
    operation: 'device.credential.rotate',
    method: 'POST',
    path: '/api/v1/os/devices/self/credential/rotate',
    device_session_id: input.deviceSessionId,
    current_credential_id: input.currentCredentialId,
    current_credential_generation: input.currentCredentialGeneration,
    new_public_key_thumbprint: await devicePublicKeyThumbprint(input.newPublicJwk),
    request_id: input.requestId,
    tunnel_origin: input.tunnelOrigin,
  }
  const bytes = utf8(JSON.stringify(challenge))
  const [currentSignature, newSignature] = await Promise.all([
    crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, input.currentPrivateKey, bytes),
    crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, input.newPrivateKey, bytes),
  ])
  return {
    body: { new_public_key_jwk: input.newPublicJwk },
    challenge,
    currentKeyProof: base64url(currentSignature),
    newKeyProof: base64url(newSignature),
  }
}

export async function deviceRequestHeaders(method: string, path: string): Promise<Record<string, string>> {
  const authority = await readDeviceAuthority()
  if (!authority) return {}
  const target = new URL(`/api/v1${path}`, location.origin)
  target.search = ''
  target.hash = ''
  const encodedHeader = base64url(utf8(JSON.stringify({
    alg: 'ES256', typ: 'dpop+jwt', jwk: authority.publicJwk,
  })))
  const credentialDigest = await crypto.subtle.digest('SHA-256', utf8(authority.credential))
  const encodedClaims = base64url(utf8(JSON.stringify({
    htm: method.toUpperCase(),
    htu: target.toString(),
    iat: Math.floor(Date.now() / 1_000),
    jti: crypto.randomUUID(),
    ath: base64url(credentialDigest),
  })))
  const signingInput = `${encodedHeader}.${encodedClaims}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    authority.privateKey,
    utf8(signingInput),
  )
  return {
    authorization: `Device ${authority.credential}`,
    dpop: `${signingInput}.${base64url(signature)}`,
  }
}

const deviceName = (): string => {
  const platform = navigator.platform?.trim().replace(/[^A-Za-z0-9 ._-]/gu, '').slice(0, 40)
  return `${platform || 'Web device'} · ${new Date().toISOString().slice(0, 10)}`
}

const parseCredentialIssue = (
  value: unknown,
  expectedSessionId?: string,
): Omit<StoredDeviceAuthority, 'privateKey' | 'publicJwk' | 'tunnelOrigin'> => {
  const envelope = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rawSession = envelope.device_session
  const session = rawSession && typeof rawSession === 'object' ? rawSession as Record<string, unknown> : {}
  const rawIssue = envelope.credential_issue
  const issue = rawIssue && typeof rawIssue === 'object'
    ? rawIssue as Record<string, unknown>
    : envelope
  const rawMetadata = issue.credential_metadata
  const metadata = rawMetadata && typeof rawMetadata === 'object' ? rawMetadata as Record<string, unknown> : {}
  const credential = issue.credential
  const deviceSessionId = session.id ?? metadata.device_session_id ?? envelope.device_session_id
  const credentialExpiresAt = metadata.expires_at ?? envelope.credential_expires_at
  const credentialId = metadata.id
  const credentialGeneration = Number(metadata.rotation_generation)
  if (typeof credential !== 'string' || !credential.startsWith(DEVICE_CREDENTIAL_PREFIX)
    || typeof deviceSessionId !== 'string' || !deviceSessionId
    || (expectedSessionId && deviceSessionId !== expectedSessionId)
    || typeof credentialExpiresAt !== 'string' || !validExpiry(credentialExpiresAt)
    || typeof credentialId !== 'string' || !credentialId
    || !Number.isSafeInteger(credentialGeneration) || credentialGeneration < 0) {
    throw new Error('the daemon returned invalid device authority')
  }
  return { credential, credentialId, credentialGeneration, deviceSessionId, credentialExpiresAt }
}

const scrubLegacyBrowserAuthority = (): { pairingTicket: string | null; rejectedLegacyToken: boolean } => {
  localStorage.removeItem('orchestra-token')
  const url = new URL(location.href)
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ''))
  const pairingTicket = fragment.get('pair')
  const rejectedLegacyToken = fragment.has('token') || url.searchParams.has('token')
  url.searchParams.delete('token')
  url.hash = ''
  if (location.hash || rejectedLegacyToken) history.replaceState(null, '', `${url.pathname}${url.search}`)
  return { pairingTicket, rejectedLegacyToken }
}

/** Redeem only the short-lived fragment ticket; owner-token fragments/queries are discarded. */
export async function redeemPairingFromLocation(): Promise<void> {
  const { pairingTicket, rejectedLegacyToken } = scrubLegacyBrowserAuthority()
  if (rejectedLegacyToken) throw new Error('legacy owner-token pairing is disabled')
  if (!pairingTicket) return
  if (!/^orchestra_pair_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(pairingTicket)) {
    throw new Error('the pairing ticket is invalid')
  }
  const pair = await generateDeviceKeyPair()
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  await stageKeyMaterial({
    purpose: 'pair', privateKey: pair.privateKey, publicJwk,
    requestId: crypto.randomUUID(), createdAt: new Date().toISOString(),
  })
  const response = await fetch('/api/v1/os/devices/redeem', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairing_ticket: pairingTicket,
      device_name: deviceName(),
      device_public_key_jwk: publicJwk,
    }),
  })
  if (!response.ok) {
    await clearStagedKeyMaterial()
    throw new Error('pairing was rejected or expired')
  }
  const authority = parseCredentialIssue(await response.json())
  await commitIssuedAuthority({
    ...authority, privateKey: pair.privateKey, publicJwk, tunnelOrigin: location.origin,
  })
}

/** Exchange the operator password for device authority on a remote origin. */
export async function passwordDeviceLogin(password: string): Promise<void> {
  if (!password) throw new Error('a password is required')
  const pair = await generateDeviceKeyPair()
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  await stageKeyMaterial({
    purpose: 'pair', privateKey: pair.privateKey, publicJwk,
    requestId: crypto.randomUUID(), createdAt: new Date().toISOString(),
  })
  const response = await fetch('/api/v1/os/devices/password-login', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      password,
      device_name: deviceName(),
      device_public_key_jwk: publicJwk,
    }),
  })
  if (!response.ok) {
    await clearStagedKeyMaterial()
    if (response.status === 429) throw new Error('too many attempts — wait a few minutes and try again')
    if (response.status === 404) throw new Error('password login is not enabled — run `orchestra password` on the host')
    throw new Error('the password was rejected')
  }
  const authority = parseCredentialIssue(await response.json())
  await commitIssuedAuthority({
    ...authority, privateKey: pair.privateKey, publicJwk, tunnelOrigin: location.origin,
  })
}

/** Rotate credential/key together; ambiguous post-commit failures enter explicit recovery. */
export async function rotateDeviceAuthority(): Promise<{ credentialExpiresAt: string }> {
  const current = await readDeviceAuthority()
  if (!current) throw new Error('an active paired device is required')
  const pair = await generateDeviceKeyPair()
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const requestId = crypto.randomUUID()
  await stageKeyMaterial({
    purpose: 'rotate', privateKey: pair.privateKey, publicJwk,
    requestId, createdAt: new Date().toISOString(),
  })
  const rotation = await buildCredentialRotationRequest({
    currentPrivateKey: current.privateKey,
    newPrivateKey: pair.privateKey,
    newPublicJwk: publicJwk,
    deviceSessionId: current.deviceSessionId,
    currentCredentialId: current.credentialId,
    currentCredentialGeneration: current.credentialGeneration,
    requestId,
    tunnelOrigin: current.tunnelOrigin,
  })
  const path = '/os/devices/self/credential/rotate'
  const headers = await deviceRequestHeaders('POST', path)
  if (!headers.authorization || !headers.dpop) throw new Error('device proof is unavailable')
  headers['content-type'] = 'application/json'
  headers['x-orchestra-request-id'] = requestId
  headers['x-orchestra-credential-rotation-proof'] = rotation.currentKeyProof
  headers['x-orchestra-new-key-proof'] = rotation.newKeyProof
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: 'POST', headers,
      body: JSON.stringify(rotation.body),
      cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    })
  } catch {
    throw new Error('Credential rotation outcome is unknown. Do not queue or blindly retry it: first probe current authority; if neither authority works, revoke this device from another trusted device and pair again.')
  }
  if (!response.ok) {
    await clearStagedKeyMaterial()
    throw new Error('credential rotation was rejected; probe current authority before retrying')
  }
  let authority: ReturnType<typeof parseCredentialIssue>
  try {
    authority = parseCredentialIssue(await response.json(), current.deviceSessionId)
  } catch {
    throw new Error('Credential rotation may have committed but its response was unusable. Do not retry it: probe current authority, then revoke this device from another trusted device and pair again if needed.')
  }
  await commitIssuedAuthority({
    ...authority, privateKey: pair.privateKey, publicJwk, tunnelOrigin: current.tunnelOrigin,
  })
  return { credentialExpiresAt: authority.credentialExpiresAt }
}

export async function prepareBrowserAuthority(): Promise<BrowserAuthorityMode> {
  await redeemPairingFromLocation()
  if (isLoopbackBrowser()) return 'local-owner'
  return await readDeviceAuthority() ? 'paired-device' : 'pairing-required'
}

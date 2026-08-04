import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { api, boundedIdempotencyKey } from '../web/src/api.js'
import {
  buildCredentialRotationRequest,
  generateDeviceKeyPair,
  hasPendingDeviceAuthorityRecovery,
  isLoopbackHostname,
  readDeviceAuthority,
  recoverPendingDeviceAuthority,
  redeemPairingFromLocation,
  remoteMutationDigest,
  rotateDeviceAuthority,
} from '../web/src/deviceAuth.js'
import { normalizeRemoteBoards } from '../web/src/RemoteDeviceShell.js'
import {
  matchesDeviceRevokeGrant,
  normalizeRemoteDeviceSession,
} from '../web/src/remotePolicy.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const NOW = Date.parse('2026-08-02T12:00:00Z')
const DIGEST = `sha256:${'a'.repeat(64)}`
const decodeBase64url = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(value, 'base64url'))

const installTestAuthorityDb = () => {
  const records = new Map<IDBValidKey, unknown>()
  let opened = false
  let failRecordPuts = 0
  const database = {
    objectStoreNames: { contains: () => opened },
    createObjectStore: () => { opened = true },
    close: () => undefined,
    transaction: () => {
      const mutations: Array<() => void> = []
      let writesCurrent = false
      const tx: Record<string, unknown> = {}
      const request = <T>(result: T): IDBRequest<T> => {
        const value = { result } as IDBRequest<T>
        queueMicrotask(() => value.onsuccess?.(new Event('success') as IDBRequestEventMap['success']))
        return value
      }
      const store = {
        get: (key: IDBValidKey) => request(records.get(key)),
        put: (value: unknown, key: IDBValidKey) => {
          if (key === 'current') writesCurrent = true
          mutations.push(() => records.set(key, value))
          return request(key)
        },
        delete: (key: IDBValidKey) => {
          mutations.push(() => records.delete(key))
          return request(undefined)
        },
      }
      tx.objectStore = () => store
      setTimeout(() => {
        if (writesCurrent && failRecordPuts > 0) {
          failRecordPuts -= 1
          ;(tx.onabort as IDBTransaction['onabort'] | undefined)?.call(tx as unknown as IDBTransaction, new Event('abort'))
          return
        }
        for (const mutate of mutations) mutate()
        ;(tx.oncomplete as IDBTransaction['oncomplete'] | undefined)?.call(tx as unknown as IDBTransaction, new Event('complete'))
      }, 0)
      return tx as unknown as IDBTransaction
    },
  } as unknown as IDBDatabase
  const indexedDB = {
    open: () => {
      const value = {} as IDBOpenDBRequest
      setTimeout(() => {
        Object.defineProperty(value, 'result', { value: database })
        if (!opened) value.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent)
        value.onsuccess?.(new Event('success') as IDBRequestEventMap['success'])
      }, 0)
      return value
    },
  } as IDBFactory
  return {
    indexedDB,
    failNextCurrentWrites: (count: number) => { failRecordPuts = count },
  }
}

const revokeSession = (overrides: Record<string, unknown> = {}) => normalizeRemoteDeviceSession({
  device_session_id: 'phone-1',
  name: 'Phone',
  scopes: ['observe', 'admin'],
  expires_at: '2026-08-03T12:00:00Z',
  credential_expires_at: '2026-08-02T13:00:00Z',
  step_up: {
    id: 'grant-1',
    active_until: '2026-08-02T12:05:00Z',
    action: 'device.revoke',
    resource_type: 'device',
    resource_id: 'phone-2',
    request_digest: DIGEST,
    nonce: 'nonce-1',
    ...overrides,
  },
})

describe('remote browser authority boundary', () => {
  it('classifies only actual loopback names as owner-token eligible', () => {
    for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]']) expect(isLoopbackHostname(hostname)).toBe(true)
    for (const hostname of ['phone.example.test', 'localhost.example.test', '127.0.0.2', '0.0.0.0']) {
      expect(isLoopbackHostname(hostname)).toBe(false)
    }
  })

  it('never persists or transports a master token from the non-loopback bootstrap', () => {
    const api = read('web/src/api.ts')
    const auth = read('web/src/deviceAuth.ts')
    const main = read('web/src/main.tsx')
    expect(api).not.toContain("localStorage.setItem('orchestra-token'")
    expect(api).toContain("if (!isLoopbackBrowser()) throw new Error('owner tokens are accepted only from loopback')")
    expect(auth).toContain("localStorage.removeItem('orchestra-token')")
    expect(auth).toContain("url.searchParams.delete('token')")
    expect(auth).toContain("throw new Error('legacy owner-token pairing is disabled')")
    expect(main).not.toContain('setToken')
    expect(main).toContain('prepareBrowserAuthority')
  })

  it('renders pairing-required instead of the owner Login on an unpaired remote origin', () => {
    const app = read('web/src/App.tsx')
    const shell = read('web/src/RemoteDeviceShell.tsx')
    expect(app).toContain("if (authorityMode === 'pairing-required') return <PairingRequired onSignedIn={onAuthorityChanged} />")
    expect(app.indexOf("authorityMode === 'pairing-required'"))
      .toBeLessThan(app.indexOf('return <LocalOwnerApp />'))
    expect(shell).toContain('No token field exists on remote origins.')
    // The only secret field on remote origins is the operator password, which is exchanged
    // for scoped device authority via password-login — never stored or used as a token.
    expect(shell).not.toContain('Paste token')
    expect(shell).not.toContain('setToken')
    expect(shell).toContain('passwordDeviceLogin')
  })

  it('uses a class-only dedicated shell and only classified remote data routes', () => {
    const shell = read('web/src/RemoteDeviceShell.tsx')
    const calls = [...shell.matchAll(/api\('(?:GET|POST)', '([^']+)'/gu)].map((match) => match[1])
    expect(calls.sort()).toEqual(['/os/remote/boards', '/os/remote/messages'])
    expect(shell).not.toMatch(/['"`]\/boards(?:\/|['"`])/u)
    expect(shell).not.toContain('/snapshot')
    expect(shell).not.toContain('/push')
    expect(shell).not.toContain('PushBell')
    expect(shell).not.toContain('style=')
    expect(shell).toContain("response.target_kind !== 'no-tool'")
    expect(shell).toContain("{ 'idempotency-key': idempotencyKey }")
  })

  it('exposes classified device, agent, approval and terminal controls without legacy settings', () => {
    const shell = read('web/src/RemoteDeviceShell.tsx')
    const center = read('web/src/RemoteAccessCenter.tsx')
    expect(shell).toContain('<RemoteAccessCenter remoteShell />')
    expect(shell).toContain('setAuthorityRecovery(hasPendingDeviceAuthorityRecovery())')
    expect(shell).toContain("busy === 'recover-authority' ? 'Recovering…' : 'Recover issued credential'")
    expect(shell).toContain('/os/remote/agents?board_id=')
    expect(shell).toContain('/os/remote/approvals?board_id=')
    expect(shell).toContain('/terminal/input')
    expect(shell).toContain("operation: 'agent.stop'")
    expect(shell).toContain("operation: 'terminal.input'")
    expect(shell).toContain("const operation = 'approval.allow'")
    expect(shell).not.toContain('SettingsView')
    expect(center).toContain('remoteShell ? Promise.resolve(null)')
    expect(center).toContain("remoteShell && !access.hasScope('admin')")
    expect(center).toContain("access.requestStepUp('admin', 'device', device.id")
    expect(center).toContain('matchesDeviceRevokeGrant(')
  })

  it('passes only bounded unambiguous idempotency keys', () => {
    expect(boundedIdempotencyKey('remote-message-1')).toBe('remote-message-1')
    expect(boundedIdempotencyKey(`x${'a'.repeat(127)}`)).toHaveLength(128)
    for (const key of ['', ' ', `x${'a'.repeat(128)}`, 'a,b', 'a\nb']) {
      expect(() => boundedIdempotencyKey(key)).toThrow(/idempotency-key/)
    }
    expect(read('web/src/api.ts')).toContain("headers['idempotency-key'] = boundedIdempotencyKey")
  })

  it('normalizes the classified board summary without accepting legacy snapshot fields', () => {
    expect(normalizeRemoteBoards({ boards: [{
      id: 7, name: 'Granted', open_work: 4, attention_count: 2,
      agents: [{ transcript: 'must not cross the remote shell' }],
      cards: [{ description: 'not classified for this response' }],
    }] })).toEqual([{ id: 7, name: 'Granted', status: 'clear', attention_count: 2 }])
  })
})

describe('device credential and revoke binding', () => {
  it('creates a fresh nonextractable signing key contract', async () => {
    const first = await generateDeviceKeyPair()
    const second = await generateDeviceKeyPair()
    expect(first.privateKey.extractable).toBe(false)
    expect(first.privateKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' })
    expect(second.privateKey).not.toBe(first.privateKey)
    await expect(crypto.subtle.exportKey('jwk', first.privateKey)).rejects.toThrow()
  })

  it('binds credential rotation to the exact old/new-key challenge contract', async () => {
    const current = await generateDeviceKeyPair()
    const next = await generateDeviceKeyPair()
    const newPublicJwk = await crypto.subtle.exportKey('jwk', next.publicKey)
    const rotation = await buildCredentialRotationRequest({
      currentPrivateKey: current.privateKey,
      newPrivateKey: next.privateKey,
      newPublicJwk,
      deviceSessionId: 'device-1',
      currentCredentialId: 'credential-1',
      currentCredentialGeneration: 3,
      requestId: 'request-1',
      tunnelOrigin: 'https://phone.example.test',
    })
    expect(Object.keys(rotation.body)).toEqual(['new_public_key_jwk'])
    expect(rotation.body).toEqual({ new_public_key_jwk: newPublicJwk })
    expect(rotation.challenge).toEqual({
      schema_version: 1,
      operation: 'device.credential.rotate',
      method: 'POST',
      path: '/api/v1/os/devices/self/credential/rotate',
      device_session_id: 'device-1',
      current_credential_id: 'credential-1',
      current_credential_generation: 3,
      new_public_key_thumbprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      request_id: 'request-1',
      tunnel_origin: 'https://phone.example.test',
    })
    expect(Object.keys(rotation.challenge)).toEqual([
      'schema_version', 'operation', 'method', 'path', 'device_session_id',
      'current_credential_id', 'current_credential_generation',
      'new_public_key_thumbprint', 'request_id', 'tunnel_origin',
    ])
    const challengeBytes = new TextEncoder().encode(JSON.stringify(rotation.challenge))
    for (const [proof, key] of [
      [rotation.currentKeyProof, current.publicKey],
      [rotation.newKeyProof, next.publicKey],
    ] as const) {
      expect(decodeBase64url(proof)).toHaveLength(64)
      await expect(crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, key, decodeBase64url(proof), challengeBytes,
      )).resolves.toBe(true)
    }
    const source = read('web/src/deviceAuth.ts')
    expect(source).toContain("const path = '/os/devices/self/credential/rotate'")
    for (const header of [
      'x-orchestra-request-id',
      'x-orchestra-credential-rotation-proof',
      'x-orchestra-new-key-proof',
    ]) expect(source).toContain(`headers['${header}']`)
  })

  it('preserves issued authority through old-credential 401 polling and recovers storage', async () => {
    const authorityDb = installTestAuthorityDb()
    const originalDescriptors = Object.fromEntries(['indexedDB', 'location', 'history', 'localStorage', 'navigator', 'fetch']
      .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
    const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, {
      configurable: true, writable: true, value,
    })
    define('indexedDB', authorityDb.indexedDB)
    define('location', {
      origin: 'https://phone.example.test', hostname: 'phone.example.test',
      href: 'https://phone.example.test/#pair=orchestra_pair_v1.a.b', hash: '#pair=orchestra_pair_v1.a.b',
    })
    define('history', { replaceState: () => undefined })
    define('localStorage', { removeItem: () => undefined })
    define('navigator', { platform: 'Test phone' })
    let rotationIssued = false
    define('fetch', async (input: string | URL | Request) => {
      const url = String(input)
      if (url === '/api/v1/os/devices/redeem') return Response.json({
        device_session: { id: 'device-1' },
        credential_issue: {
          credential: 'orchestra_device_v1.old',
          credential_metadata: {
            id: 'credential-old', device_session_id: 'device-1', rotation_generation: 1,
            expires_at: '2099-08-03T12:00:00Z',
          },
        },
      })
      if (url === '/api/v1/os/devices/self/credential/rotate') {
        rotationIssued = true
        authorityDb.failNextCurrentWrites(2)
        return Response.json({
          credential: 'orchestra_device_v1.new',
          credential_metadata: {
            id: 'credential-new', device_session_id: 'device-1', rotation_generation: 2,
            expires_at: '2099-09-03T12:00:00Z',
          },
        })
      }
      if (url === '/api/v1/os/remote/boards' && rotationIssued) {
        return new Response('old credential revoked', { status: 401 })
      }
      throw new Error(`unexpected test fetch: ${url}`)
    })
    try {
      await redeemPairingFromLocation()
      await expect(rotateDeviceAuthority()).rejects.toThrow(/protected storage failed/u)
      expect(hasPendingDeviceAuthorityRecovery()).toBe(true)
      await expect(api('GET', '/os/remote/boards')).rejects.toThrow(/old credential revoked/u)
      expect(hasPendingDeviceAuthorityRecovery()).toBe(true)
      await expect(recoverPendingDeviceAuthority()).resolves.toBe(true)
      expect(hasPendingDeviceAuthorityRecovery()).toBe(false)
      await expect(readDeviceAuthority()).resolves.toMatchObject({
        credential: 'orchestra_device_v1.new',
        credentialId: 'credential-new',
        credentialGeneration: 2,
      })
    } finally {
      for (const [name, descriptor] of Object.entries(originalDescriptors)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  })

  it('matches the server canonical revoke digest bytes exactly', async () => {
    const request = { method: 'POST', path: '/api/v1/os/devices/phone-2/revoke', body: null }
    const expected = `sha256:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`
    await expect(remoteMutationDigest(request)).resolves.toBe(expected)
  })

  it('requires exact operation, device resource, digest, nonce and active authority', () => {
    expect(matchesDeviceRevokeGrant(revokeSession(), 'phone-2', DIGEST, 'nonce-1', NOW)).toBe(true)
    expect(matchesDeviceRevokeGrant(revokeSession({ action: 'admin' }), 'phone-2', DIGEST, 'nonce-1', NOW)).toBe(false)
    expect(matchesDeviceRevokeGrant(revokeSession({ resource_type: 'device-session' }), 'phone-2', DIGEST, 'nonce-1', NOW)).toBe(false)
    expect(matchesDeviceRevokeGrant(revokeSession(), 'phone-3', DIGEST, 'nonce-1', NOW)).toBe(false)
    expect(matchesDeviceRevokeGrant(revokeSession(), 'phone-2', `sha256:${'b'.repeat(64)}`, 'nonce-1', NOW)).toBe(false)
    expect(matchesDeviceRevokeGrant(revokeSession(), 'phone-2', DIGEST, 'nonce-2', NOW)).toBe(false)
    expect(matchesDeviceRevokeGrant(revokeSession({ active_until: '2026-08-02T12:00:00Z' }), 'phone-2', DIGEST, 'nonce-1', NOW)).toBe(false)
  })

  it('clears client authority when the consumed or expired grant is absent on refresh', () => {
    const consumed = normalizeRemoteDeviceSession({
      device_session_id: 'phone-1', name: 'Phone', scopes: ['observe', 'admin'],
      expires_at: '2026-08-03T12:00:00Z', credential_expires_at: '2026-08-02T13:00:00Z', step_up: null,
    })
    expect(matchesDeviceRevokeGrant(consumed, 'phone-2', DIGEST, 'nonce-1', NOW)).toBe(false)
    expect(read('web/src/RemoteAccessCenter.tsx')).toContain('finally { setPendingRevoke(null); setBusy(null) }')
  })
})

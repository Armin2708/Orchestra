import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  LocalOwnerAuthError,
  LocalOwnerPasswordAuth,
} from '../src/local-owner-auth.js'
import { buildServer } from '../src/server.js'

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-owner-password-'))
  return { root, passwordFile: path.join(root, 'owner-password.json') }
}

describe('local owner password authentication', () => {
  it('stores only a salted password hash with owner-only permissions', () => {
    const { passwordFile } = fixture()
    const auth = new LocalOwnerPasswordAuth(passwordFile)
    const issued = auth.setup('correct horse battery staple')

    expect(issued.session).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.statSync(passwordFile).mode & 0o777).toBe(0o600)
    const stored = fs.readFileSync(passwordFile, 'utf8')
    expect(stored).not.toContain('correct horse battery staple')
    expect(JSON.parse(stored)).toMatchObject({ version: 1, salt: expect.any(String), hash: expect.any(String) })
  })

  it('issues expiring sessions and rejects wrong passwords', () => {
    const { passwordFile } = fixture()
    let now = 1_000
    const auth = new LocalOwnerPasswordAuth(passwordFile, () => now)
    const issued = auth.setup('graph board password')

    expect(auth.authenticate(issued.session)).toBe(true)
    expect(() => auth.login('wrong password')).toThrowError(LocalOwnerAuthError)
    const loggedIn = auth.login('graph board password')
    expect(auth.authenticate(loggedIn.session)).toBe(true)
    now += 12 * 60 * 60 * 1_000 + 1
    expect(auth.authenticate(issued.session)).toBe(false)
    expect(auth.authenticate(loggedIn.session)).toBe(false)
  })

  it('rate-limits repeated incorrect attempts', () => {
    const { passwordFile } = fixture()
    const auth = new LocalOwnerPasswordAuth(passwordFile, () => 10_000)
    auth.setup('another good password')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => auth.login('incorrect', 'same-client')).toThrow(/incorrect/i)
    }
    expect(() => auth.login('another good password', 'same-client')).toThrow(/too many attempts/i)
  })

  it('exchanges a loopback password for an API session without exposing the master token', async () => {
    const { passwordFile } = fixture()
    const localOwnerAuth = new LocalOwnerPasswordAuth(passwordFile)
    const server = buildServer(openDb(':memory:'), undefined, {
      token: 'internal-master-token',
      localOwnerAuth,
    })
    await server.ready()

    const status = await server.inject({ method: 'GET', url: '/api/v1/auth/status' })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toEqual({ password_set: false })

    const remoteStatus = await server.inject({
      method: 'GET', url: '/api/v1/auth/status', remoteAddress: '203.0.113.8',
      headers: { host: 'phone.example.test' },
    })
    expect(remoteStatus.statusCode).toBe(404)

    const setup = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'local dashboard password' },
    })
    expect(setup.statusCode).toBe(200)
    const session = setup.json().session as string
    expect(session).not.toBe('internal-master-token')
    expect(session).not.toBe('local dashboard password')

    const authorized = await server.inject({
      method: 'GET',
      url: '/api/v1/boards',
      headers: { authorization: `Bearer ${session}` },
    })
    expect(authorized.statusCode).toBe(200)

    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'not the password' },
    })
    expect(rejected.statusCode).toBe(401)
    expect(rejected.json()).toMatchObject({ code: 'password_incorrect' })
    await server.close()
  })

  it('grants loopback browsers operator access without a password when opted in', async () => {
    const { passwordFile } = fixture()
    const localOwnerAuth = new LocalOwnerPasswordAuth(passwordFile)
    localOwnerAuth.setup('local dashboard password')
    const server = buildServer(openDb(':memory:'), undefined, {
      token: 'internal-master-token', localOwnerAuth, trustLoopbackBrowsers: true,
    })
    await server.ready()

    const local = await server.inject({ method: 'GET', url: '/api/v1/boards' })
    expect(local.statusCode).toBe(200)

    const sameOrigin = await server.inject({
      method: 'GET', url: '/api/v1/boards', headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(sameOrigin.statusCode).toBe(200)

    const crossSite = await server.inject({
      method: 'GET', url: '/api/v1/boards', headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(crossSite.statusCode).toBe(401)

    const remote = await server.inject({
      method: 'GET', url: '/api/v1/boards', remoteAddress: '203.0.113.8',
      headers: { host: 'phone.example.test' },
    })
    expect(remote.statusCode).toBe(401)
    await server.close()
  })

  it('still requires credentials on loopback without the opt-in', async () => {
    const server = buildServer(openDb(':memory:'), undefined, { token: 'internal-master-token' })
    await server.ready()
    const local = await server.inject({ method: 'GET', url: '/api/v1/boards' })
    expect(local.statusCode).toBe(401)
    await server.close()
  })

  it('keeps sessions valid across a restart without storing the raw session', () => {
    const { root, passwordFile } = fixture()
    let now = 1_000
    const issued = new LocalOwnerPasswordAuth(passwordFile, () => now).setup('graph board password')

    const restarted = new LocalOwnerPasswordAuth(passwordFile, () => now)
    expect(restarted.authenticate(issued.session)).toBe(true)

    const sessionsFile = path.join(root, 'owner-sessions.json')
    expect(fs.statSync(sessionsFile).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(sessionsFile, 'utf8')).not.toContain(issued.session)

    now += 12 * 60 * 60 * 1_000 + 1
    expect(new LocalOwnerPasswordAuth(passwordFile, () => now).authenticate(issued.session)).toBe(false)
  })

  it('drops persisted sessions when the password is deconfigured', () => {
    const { root, passwordFile } = fixture()
    const auth = new LocalOwnerPasswordAuth(passwordFile)
    const issued = auth.setup('graph board password')
    fs.unlinkSync(passwordFile)

    expect(auth.authenticate(issued.session)).toBe(false)
    expect(fs.existsSync(path.join(root, 'owner-sessions.json'))).toBe(false)
    expect(new LocalOwnerPasswordAuth(passwordFile).authenticate(issued.session)).toBe(false)
  })
})

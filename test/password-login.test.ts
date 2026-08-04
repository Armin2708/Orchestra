import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { clearPassword, hasPassword, setPassword, verifyPassword } from '../src/password.js'

const servers: Array<ReturnType<typeof buildServer>> = []
let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-password-'))
  process.env.ORCHESTRA_HOME = home
})

afterEach(async () => {
  delete process.env.ORCHESTRA_HOME
  delete process.env.ORCHESTRA_REMOTE_KILL_SWITCH
  fs.rmSync(home, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

function fixture() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO boards (project_path, name) VALUES ('/remote', 'Remote')").run()
  const server = buildServer(db, undefined, { token: 'owner-secret', agentToken: 'agent-secret' })
  servers.push(server)
  return { db, server }
}

const writeTunnelState = (url = 'https://phone.example.test') => {
  fs.writeFileSync(path.join(home, 'remote.json'), JSON.stringify({
    provider: 'tailscale', url, started_at: new Date().toISOString(),
  }), { mode: 0o600 })
}

const deviceJwk = () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return keys.publicKey.export({ format: 'jwk' })
}

const remoteLogin = (server: ReturnType<typeof buildServer>, password: string) => server.inject({
  method: 'POST',
  url: '/api/v1/os/devices/password-login',
  remoteAddress: '203.0.113.10',
  headers: {
    host: 'phone.example.test', origin: 'https://phone.example.test',
    'sec-fetch-site': 'same-origin',
  },
  payload: { password, device_name: 'Test phone', device_public_key_jwk: deviceJwk() },
})

describe('password store', () => {
  it('sets, verifies, and clears a scrypt password with owner-only permissions', () => {
    expect(hasPassword()).toBe(false)
    setPassword('correct horse battery')
    expect(hasPassword()).toBe(true)
    expect(verifyPassword('correct horse battery')).toBe(true)
    expect(verifyPassword('wrong password!')).toBe(false)
    expect(verifyPassword('')).toBe(false)
    const mode = fs.statSync(path.join(home, 'password.json')).mode & 0o777
    expect(mode).toBe(0o600)
    expect(clearPassword()).toBe(true)
    expect(hasPassword()).toBe(false)
    expect(verifyPassword('correct horse battery')).toBe(false)
  })

  it('rejects passwords below the minimum length', () => {
    expect(() => setPassword('short')).toThrow(/at least 8/)
    expect(hasPassword()).toBe(false)
  })
})

describe('POST /api/v1/os/devices/password-login', () => {
  it('is 404 when no password is set', async () => {
    const { server } = fixture()
    const response = await server.inject({
      method: 'POST', url: '/api/v1/os/devices/password-login',
      headers: { host: 'localhost' }, payload: { password: 'whatever-pass' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('exchanges the password for the owner token on loopback only', async () => {
    setPassword('local-owner-pass')
    const { server } = fixture()
    const ok = await server.inject({
      method: 'POST', url: '/api/v1/os/devices/password-login',
      headers: { host: 'localhost' }, payload: { password: 'local-owner-pass' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().token).toBe('owner-secret')
    const denied = await server.inject({
      method: 'POST', url: '/api/v1/os/devices/password-login',
      headers: { host: 'localhost' }, payload: { password: 'not-the-password' },
    })
    expect(denied.statusCode).toBe(401)
    expect(denied.body).not.toContain('owner-secret')
  })

  it('mints device authority for the active tunnel origin on remote origins', async () => {
    setPassword('phone-sign-in-pass')
    writeTunnelState()
    const { server } = fixture()
    const response = await remoteLogin(server, 'phone-sign-in-pass')
    expect(response.statusCode, response.body).toBe(200)
    const envelope = response.json()
    expect(envelope.token).toBeUndefined()
    expect(envelope.device_session.id).toBeTruthy()
    expect(envelope.credential_issue.credential).toMatch(/^orchestra_device_v1\./u)
    expect(response.body).not.toContain('owner-secret')
  })

  it('refuses remote password login without an active tunnel or from a foreign origin', async () => {
    setPassword('phone-sign-in-pass')
    const { server } = fixture()
    const noTunnel = await remoteLogin(server, 'phone-sign-in-pass')
    expect(noTunnel.statusCode).toBe(401)
    writeTunnelState('https://other-tunnel.example.test')
    const foreignOrigin = await remoteLogin(server, 'phone-sign-in-pass')
    expect(foreignOrigin.statusCode).toBe(401)
  })

  it('rate-limits repeated attempts per ingress address', async () => {
    setPassword('phone-sign-in-pass')
    writeTunnelState()
    const { server } = fixture()
    const statuses: number[] = []
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await remoteLogin(server, 'wrong-guess-password')
      statuses.push(response.statusCode)
    }
    expect(statuses.slice(0, 5)).toEqual(Array(5).fill(401))
    expect(statuses.slice(5)).toEqual([429, 429])
  })

  it('honors the remote kill switch for remote logins while loopback stays available', async () => {
    setPassword('phone-sign-in-pass')
    writeTunnelState()
    process.env.ORCHESTRA_REMOTE_KILL_SWITCH = '1'
    const { server } = fixture()
    const remote = await remoteLogin(server, 'phone-sign-in-pass')
    expect(remote.statusCode).toBe(503)
    const local = await server.inject({
      method: 'POST', url: '/api/v1/os/devices/password-login',
      headers: { host: 'localhost' }, payload: { password: 'phone-sign-in-pass' },
    })
    expect(local.statusCode).toBe(200)
  })
})

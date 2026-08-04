import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { LocalOwnerPasswordAuth } from '../src/local-owner-auth.js'

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
  db.prepare("INSERT INTO boards (project_path, name) VALUES ('/second', 'Second')").run()
  const server = buildServer(db, undefined, {
    token: 'owner-secret',
    agentToken: 'agent-secret',
    localOwnerAuth: new LocalOwnerPasswordAuth(path.join(home, 'owner-password.json')),
  })
  servers.push(server)
  return { db, server }
}

const configurePassword = (password: string) => {
  new LocalOwnerPasswordAuth(path.join(home, 'owner-password.json')).setup(password)
}

const writeTunnelState = (
  url = 'https://phone.example.test',
  provider: 'tailscale' | 'cloudflared' = 'tailscale',
) => {
  fs.writeFileSync(path.join(home, 'remote.json'), JSON.stringify({
    provider,
    url,
    started_at: new Date().toISOString(),
    ...(provider === 'cloudflared' ? { pid: process.pid, process_fingerprint: 'test-fingerprint' } : {}),
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

describe('POST /api/v1/os/devices/password-login', () => {
  it('is 404 when no local owner password is configured', async () => {
    writeTunnelState()
    const { server } = fixture()
    const response = await remoteLogin(server, 'whatever-pass')
    expect(response.statusCode).toBe(404)
  })

  it('mints limited revocable device authority for the active private tunnel', async () => {
    configurePassword('phone-sign-in-pass')
    writeTunnelState()
    const { db, server } = fixture()
    const response = await remoteLogin(server, 'phone-sign-in-pass')
    expect(response.statusCode, response.body).toBe(200)
    const envelope = response.json()
    expect(envelope.token).toBeUndefined()
    expect(envelope.device_session.id).toBeTruthy()
    expect(envelope.device_session.scopes).toEqual(['observe', 'stream', 'message', 'approve'])
    expect(envelope.device_session.scopes).not.toContain('agent-control')
    expect(envelope.device_session.scopes).not.toContain('terminal-write')
    expect(envelope.device_session.scopes).not.toContain('admin')
    expect(envelope.credential_issue.credential).toMatch(/^orchestra_device_v1\./u)
    expect(response.body).not.toContain('owner-secret')
    const grants = db.prepare(`SELECT resource_type, resource_id FROM os_remote_resource_grants
      WHERE device_session_id=?`).all(envelope.device_session.id) as Array<{ resource_type: string; resource_id: string }>
    expect(grants).toEqual([
      { resource_type: 'board', resource_id: '1' },
      { resource_type: 'board', resource_id: '2' },
      { resource_type: 'device', resource_id: envelope.device_session.id },
      { resource_type: 'tunnel', resource_id: 'primary' },
    ])
  })

  it('rejects owner-password login through a public Cloudflare tunnel', async () => {
    configurePassword('phone-sign-in-pass')
    writeTunnelState('https://phone.trycloudflare.com', 'cloudflared')
    const { db, server } = fixture()
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/os/devices/password-login',
      remoteAddress: '127.0.0.1',
      headers: {
        host: 'phone.trycloudflare.com',
        'x-forwarded-host': 'phone.trycloudflare.com',
        origin: 'https://phone.trycloudflare.com',
        'sec-fetch-site': 'same-origin',
      },
      payload: { password: 'phone-sign-in-pass', device_name: 'Public phone', device_public_key_jwk: deviceJwk() },
    })
    expect(response.statusCode).toBe(401)
    expect(db.prepare('SELECT COUNT(*) AS count FROM os_device_sessions').get()).toEqual({ count: 0 })
  })

  it('accepts requests proxied by the loopback tunnel daemon (tailscale x-forwarded-host)', async () => {
    configurePassword('phone-sign-in-pass')
    writeTunnelState()
    const { server } = fixture()
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/os/devices/password-login',
      remoteAddress: '127.0.0.1',
      headers: {
        host: 'phone.example.test',
        'x-forwarded-host': 'phone.example.test',
        'x-forwarded-proto': 'https',
        origin: 'https://phone.example.test',
        'sec-fetch-site': 'same-origin',
      },
      payload: { password: 'phone-sign-in-pass', device_name: 'Tailscale phone', device_public_key_jwk: deviceJwk() },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().credential_issue.credential).toMatch(/^orchestra_device_v1\./u)
  })

  it('still refuses forwarded hosts from non-loopback peers', async () => {
    configurePassword('phone-sign-in-pass')
    writeTunnelState()
    const { server } = fixture()
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/os/devices/password-login',
      remoteAddress: '203.0.113.10',
      headers: {
        host: 'phone.example.test',
        'x-forwarded-host': 'phone.example.test',
        origin: 'https://phone.example.test',
        'sec-fetch-site': 'same-origin',
      },
      payload: { password: 'phone-sign-in-pass', device_name: 'Spoofed proxy', device_public_key_jwk: deviceJwk() },
    })
    expect(response.statusCode).toBe(401)
  })

  it('rejects a wrong password without leaking authority', async () => {
    configurePassword('phone-sign-in-pass')
    writeTunnelState()
    const { server } = fixture()
    const response = await remoteLogin(server, 'not-the-password')
    expect(response.statusCode).toBe(401)
    expect(response.body).not.toContain('owner-secret')
    expect(response.body).not.toContain('orchestra_device_v1.')
  })

  it('refuses remote password login without an active tunnel or from a foreign origin', async () => {
    configurePassword('phone-sign-in-pass')
    const { server } = fixture()
    const noTunnel = await remoteLogin(server, 'phone-sign-in-pass')
    expect(noTunnel.statusCode).toBe(401)
    writeTunnelState('https://other-tunnel.example.test')
    const foreignOrigin = await remoteLogin(server, 'phone-sign-in-pass')
    expect(foreignOrigin.statusCode).toBe(401)
  })

  it('rate-limits repeated attempts per ingress address', async () => {
    configurePassword('phone-sign-in-pass')
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

  it('honors the remote kill switch', async () => {
    configurePassword('phone-sign-in-pass')
    writeTunnelState()
    process.env.ORCHESTRA_REMOTE_KILL_SWITCH = '1'
    const { server } = fixture()
    const response = await remoteLogin(server, 'phone-sign-in-pass')
    expect(response.statusCode).toBe(503)
  })
})

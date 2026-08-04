import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  enableNewRemotePairing,
  pairUrl,
  privatePasswordBootstrapAllowed,
  publicTunnelAllowed,
  readRemoteState,
  remoteStatePath,
  rollbackRemoteAccess,
  startRemote,
  stopRemote,
} from '../src/remote.js'
import { ensureToken } from '../src/token.js'

const tmpHome = () => { process.env.ORCHESTRA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-remote-')) }

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.ORCHESTRA_HOME
  delete process.env.ORCHESTRA_NO_AUTH
  delete process.env.ORCHESTRA_REMOTE_KILL_SWITCH
  delete process.env.ORCHESTRA_REMOTE_PUBLIC_TUNNEL
})

it('refuses to start without token auth — an open tunnel is RCE', async () => {
  tmpHome()
  process.env.ORCHESTRA_NO_AUTH = '1'
  await expect(startRemote()).rejects.toThrow(/requires token auth/)
})

it('keeps the kill switch independent from local daemon authentication', async () => {
  tmpHome()
  process.env.ORCHESTRA_REMOTE_KILL_SWITCH = '1'
  await expect(startRemote()).rejects.toThrow(/kill.switch/i)
})

it('refuses tunnel start before state write when durable rollback is disabled', async () => {
  tmpHome()
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ live: true }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'disabled' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
  await expect(startRemote()).rejects.toThrow(/durable operator rollback/i)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(readRemoteState()).toBeUndefined()
  expect(fs.existsSync(remoteStatePath())).toBe(false)
})

it('requires both the public-tunnel control and explicit per-command confirmation', () => {
  expect(publicTunnelAllowed()).toBe(false)
  expect(publicTunnelAllowed({ confirmPublic: true })).toBe(false)
  process.env.ORCHESTRA_REMOTE_PUBLIC_TUNNEL = '1'
  expect(publicTunnelAllowed()).toBe(false)
  expect(publicTunnelAllowed({ confirmPublic: true })).toBe(true)
})

it('allows password bootstrap only through a private Tailscale tunnel', () => {
  expect(privatePasswordBootstrapAllowed({
    provider: 'tailscale', url: 'https://device.tailnet.test', started_at: '2026-08-04T00:00:00.000Z',
  })).toBe(true)
  expect(privatePasswordBootstrapAllowed({
    provider: 'cloudflared', url: 'https://device.trycloudflare.com', pid: 123,
    process_fingerprint: 'fingerprint', started_at: '2026-08-04T00:00:00.000Z',
  })).toBe(false)
  expect(privatePasswordBootstrapAllowed(undefined)).toBe(false)
})

it('round-trips tunnel state through remote.json with 0600 perms', () => {
  tmpHome()
  expect(readRemoteState()).toBeUndefined()
  const state = {
    provider: 'tailscale' as const,
    url: 'https://device.example.test',
    started_at: '2026-08-02T07:00:00.000Z',
  }
  fs.writeFileSync(remoteStatePath(), JSON.stringify(state), { mode: 0o600 })
  expect(readRemoteState()).toEqual(state)
})

it('stopRemote preserves malformed ownership evidence and never signals its recorded PID', () => {
  tmpHome()
  fs.writeFileSync(remoteStatePath(), JSON.stringify({ provider: 'cloudflared', url: 'https://x', pid: 999999, started_at: 'now' }))
  expect(() => stopRemote()).toThrow(/refusing to lose tunnel ownership evidence/i)
  expect(fs.existsSync(remoteStatePath())).toBe(true)
})

it('pairUrl mints an origin-bound one-time ticket without exposing the owner token', async () => {
  tmpHome()
  const t = ensureToken()
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    pairing_ticket: 'orchestra_pair_v1.ticket.secret',
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const url = await pairUrl({ provider: 'cloudflared', url: 'https://x.trycloudflare.com', started_at: 'now' })
  expect(url).toBe('https://x.trycloudflare.com/#pair=orchestra_pair_v1.ticket.secret')
  expect(url).not.toContain(t)
  expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:/), expect.objectContaining({
    method: 'POST',
    headers: expect.objectContaining({ authorization: `Bearer ${t}` }),
    body: JSON.stringify({ expected_origin: 'https://x.trycloudflare.com', board_ids: [] }),
  }))
  fetchMock.mockRestore()
})

it('requires typed rollback confirmation and propagates the local owner request without exposing the token', async () => {
  tmpHome()
  const token = ensureToken()
  expect(() => rollbackRemoteAccess('yes')).toThrow(/REVOKE_ALL_REMOTE_AUTHORITY/)
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ live: true }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'disabled', device_sessions: 2, local_operator_available: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const result = await rollbackRemoteAccess('REVOKE_ALL_REMOTE_AUTHORITY', 'lost device drill')
  expect(result).toMatchObject({ state: 'disabled', device_sessions: 2 })
  const [, request] = fetchMock.mock.calls[1]
  expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/v1\/os\/devices\/rollback$/u)
  expect(request).toMatchObject({
    method: 'POST', redirect: 'error', referrerPolicy: 'no-referrer',
    headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
    body: JSON.stringify({
      confirm: 'REVOKE_ALL_REMOTE_AUTHORITY', reason: 'lost device drill',
    }),
  })
  expect(JSON.stringify(result)).not.toContain(token)
  fetchMock.mockRestore()
})

it('re-enables only new pairing with exact confirmation and restores no old authority', async () => {
  tmpHome()
  expect(() => enableNewRemotePairing('enable')).toThrow(/ENABLE_NEW_REMOTE_PAIRING/)
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ live: true }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'enabled', restored_credentials: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
  await expect(enableNewRemotePairing('ENABLE_NEW_REMOTE_PAIRING')).resolves.toEqual({
    state: 'enabled', restored_credentials: 0,
  })
  expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/v1\/os\/devices\/rollback\/enable$/u)
  expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(JSON.stringify({
    confirm: 'ENABLE_NEW_REMOTE_PAIRING',
  }))
  fetchMock.mockRestore()
})

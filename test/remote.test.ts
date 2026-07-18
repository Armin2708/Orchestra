import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pairUrl, readRemoteState, remoteStatePath, startRemote, stopRemote } from '../src/remote.js'
import { ensureToken } from '../src/token.js'

const tmpHome = () => { process.env.ORCHESTRA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-remote-')) }

afterEach(() => { delete process.env.ORCHESTRA_HOME; delete process.env.ORCHESTRA_NO_AUTH })

it('refuses to start without token auth — an open tunnel is RCE', async () => {
  tmpHome()
  process.env.ORCHESTRA_NO_AUTH = '1'
  await expect(startRemote()).rejects.toThrow(/requires token auth/)
})

it('round-trips tunnel state through remote.json with 0600 perms', () => {
  tmpHome()
  expect(readRemoteState()).toBeUndefined()
  const state = { provider: 'cloudflared' as const, url: 'https://x.trycloudflare.com', pid: 999999, started_at: 'now' }
  fs.writeFileSync(remoteStatePath(), JSON.stringify(state), { mode: 0o600 })
  expect(readRemoteState()).toEqual(state)
})

it('stopRemote clears stale state even when the tunnel process is gone', () => {
  tmpHome()
  fs.writeFileSync(remoteStatePath(), JSON.stringify({ provider: 'cloudflared', url: 'https://x', pid: 999999, started_at: 'now' }))
  const s = stopRemote()
  expect(s?.provider).toBe('cloudflared')
  expect(fs.existsSync(remoteStatePath())).toBe(false)
  expect(stopRemote()).toBeUndefined() // idempotent
})

it('pairUrl embeds the token in the URL fragment', () => {
  tmpHome()
  const t = ensureToken()
  const url = pairUrl({ provider: 'cloudflared', url: 'https://x.trycloudflare.com', started_at: 'now' })
  expect(url).toBe(`https://x.trycloudflare.com/#token=${t}`)
})

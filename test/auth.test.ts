import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { serve } from '../src/daemon.js'
import { ensureToken, loadToken, tokenEquals, tokenPath } from '../src/token.js'

const TOKEN = 'test-secret-token'
const srv = () => buildServer(openDb(':memory:'), undefined, { token: TOKEN })
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

afterEach(() => { delete process.env.ORCHESTRA_HOME; delete process.env.ORCHESTRA_NO_AUTH })

it('mints a 0600 token on first run and reuses it after', () => {
  process.env.ORCHESTRA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-auth-'))
  const t = ensureToken()
  expect(t).toMatch(/^[0-9a-f]{64}$/)
  expect(fs.statSync(tokenPath()).mode & 0o777).toBe(0o600)
  expect(ensureToken()).toBe(t) // stable across restarts
  expect(loadToken()).toBe(t)
})

it('compares tokens without throwing on length mismatch', () => {
  expect(tokenEquals('short', TOKEN)).toBe(false)
  expect(tokenEquals(undefined, TOKEN)).toBe(false)
  expect(tokenEquals(TOKEN, TOKEN)).toBe(true)
})

it('rejects API requests without a token', async () => {
  const s = srv(); await s.ready()
  const res = await s.inject({ method: 'GET', url: '/api/v1/boards' })
  expect(res.statusCode).toBe(401)
})

it('rejects a wrong token', async () => {
  const s = srv(); await s.ready()
  const res = await s.inject({ method: 'GET', url: '/api/v1/boards', headers: bearer('wrong') })
  expect(res.statusCode).toBe(401)
})

it('accepts a valid bearer token on GET and POST', async () => {
  const s = srv(); await s.ready()
  const post = await s.inject({ method: 'POST', url: '/api/v1/boards/resolve',
    headers: bearer(TOKEN), payload: { project_path: '/p' } })
  expect(post.statusCode).toBe(200)
  const get = await s.inject({ method: 'GET', url: '/api/v1/boards', headers: bearer(TOKEN) })
  expect(get.statusCode).toBe(200)
  expect(get.json()).toHaveLength(1)
})

it('rejects unauthenticated writes too', async () => {
  const s = srv(); await s.ready()
  const res = await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })
  expect(res.statusCode).toBe(401)
})

it('keeps /health open — clients probe it before they have the token', async () => {
  const s = srv(); await s.ready()
  const res = await s.inject({ method: 'GET', url: '/health' })
  expect(res.statusCode).toBe(200)
  expect(res.json().ok).toBe(true)
})

it('SSE requires a token', async () => {
  const s = srv(); await s.ready()
  const res = await s.inject({ method: 'GET', url: '/api/v1/events' })
  expect(res.statusCode).toBe(401)
})

it('SSE accepts the query-param fallback (EventSource cannot set headers)', async () => {
  const s = srv(); await s.ready()
  const res = await s.inject({ method: 'GET',
    url: `/api/v1/events?token=${TOKEN}`, payloadAsStream: true })
  expect(res.statusCode).toBe(200)
  expect(res.headers['content-type']).toContain('text/event-stream')
})

it('board SSE honors the same fallback', async () => {
  const s = srv(); await s.ready()
  await s.inject({ method: 'POST', url: '/api/v1/boards/resolve',
    headers: bearer(TOKEN), payload: { project_path: '/p' } })
  expect((await s.inject({ method: 'GET', url: '/api/v1/boards/1/events' })).statusCode).toBe(401)
  const ok = await s.inject({ method: 'GET',
    url: `/api/v1/boards/1/events?token=${TOKEN}`, payloadAsStream: true })
  expect(ok.statusCode).toBe(200)
  expect(ok.headers['content-type']).toContain('text/event-stream')
})

it('runs open when no token is configured (in-process test mode)', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const res = await s.inject({ method: 'GET', url: '/api/v1/boards' })
  expect(res.statusCode).toBe(200)
})

it('refuses --expose when auth is disabled', async () => {
  process.env.ORCHESTRA_NO_AUTH = '1'
  await expect(serve({ expose: true })).rejects.toThrow(/expose requires token auth/)
})

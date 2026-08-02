import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { SUPPORT_CASE_EXPORT_CONSENT } from '../src/support-case-export.js'

const servers: Array<ReturnType<typeof buildServer>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const body = {
  title: 'Provider launch is blocked',
  summary: 'The readiness check reports an accepted version mismatch.',
  reproduction_steps: ['Run the readiness check'],
  expected: 'The accepted executable is ready.',
  actual: 'The executable remains blocked.',
  exact_commit: 'b'.repeat(40),
  orchestra_version: '0.1.0',
  consent: SUPPORT_CASE_EXPORT_CONSENT,
}

const fixture = () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO boards (project_path, name) VALUES ('/support', 'Support')").run()
  const server = buildServer(db, undefined, { token: 'owner-secret', agentToken: 'agent-secret' })
  servers.push(server)
  return server
}

describe('local-owner support-case export route', () => {
  it('returns exact digest-bound diagnostics bytes without performing publication', async () => {
    const response = await fixture().inject({
      method: 'POST',
      url: '/api/v1/ops/support-case',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
      payload: body,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toMatch(/^application\/json/)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="orchestra-support-case-/)
    expect(createHash('sha256').update(response.rawPayload).digest('hex'))
      .toBe(response.headers['x-content-sha256'])

    const exported = response.json()
    expect(exported.review).toEqual({
      required_before_sharing: true,
      transport_registered: false,
      publication_performed: false,
    })
    const diagnostics = Buffer.from(exported.diagnostics_bundle.bytes, 'base64')
    expect(diagnostics.length).toBe(exported.diagnostics_bundle.byte_length)
    expect(createHash('sha256').update(diagnostics).digest('hex'))
      .toBe(exported.diagnostics_bundle.sha256)
    expect(JSON.parse(gunzipSync(diagnostics).toString('utf8'))).toMatchObject({
      schema_version: 1,
      generator: { version: '0.1.0' },
    })
  })

  it('rejects missing consent, unknown fields, agents, remote hosts, and unauthenticated callers', async () => {
    const server = fixture()
    for (const payload of [
      { ...body, consent: undefined },
      { ...body, unreviewed: true },
      { ...body, summary: 'token=should-not-pass' },
    ]) {
      const response = await server.inject({
        method: 'POST', url: '/api/v1/ops/support-case',
        headers: { host: 'localhost', authorization: 'Bearer owner-secret' }, payload,
      })
      expect(response.statusCode).toBe(400)
      expect(response.body).not.toContain('should-not-pass')
    }
    for (const headers of [
      { host: 'localhost' },
      { host: 'localhost', authorization: 'Bearer agent-secret' },
      { host: 'phone.example.test', authorization: 'Bearer owner-secret' },
    ]) {
      const response = await server.inject({
        method: 'POST', url: '/api/v1/ops/support-case', headers, payload: body,
      })
      expect([401, 403]).toContain(response.statusCode)
    }
  })

  it('retains the central mutation rate limit ahead of support-case authorization', async () => {
    const server = fixture()
    for (let index = 0; index < 240; index += 1) {
      const response = await server.inject({
        method: 'POST', url: '/api/v1/ops/support-case',
        headers: { host: 'localhost', authorization: 'Bearer owner-secret' }, payload: {},
      })
      expect(response.statusCode).toBe(400)
    }
    const limited = await server.inject({
      method: 'POST', url: '/api/v1/ops/support-case',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' }, payload: {},
    })
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
    expect(limited.json()).toMatchObject({ error: 'operational rate limit exceeded' })
  })
})

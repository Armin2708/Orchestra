import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { digestRemoteMutation } from '../src/remote-authorization-policy.js'
import {
  REMOTE_DEVICE_CREDENTIAL_ROTATION_PATH,
  REMOTE_DEVICE_CREDENTIAL_ROTATION_PROOF_HEADER,
  REMOTE_DEVICE_NEW_KEY_PROOF_HEADER,
  createRemoteCredentialRotationProofPayload,
} from '../src/remote-device-credential-rotation.js'

const servers: Array<ReturnType<typeof buildServer>> = []
afterEach(async () => {
  delete process.env.ORCHESTRA_REMOTE_KILL_SWITCH
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const proof = (input: {
  key: KeyObject
  publicJwk: JsonWebKey
  credential: string
  method: string
  path: string
  jti?: string
}) => {
  const header = Buffer.from(JSON.stringify({
    alg: 'ES256', typ: 'dpop+jwt', jwk: input.publicJwk,
  })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({
    htm: input.method,
    htu: `https://phone.example.test${input.path}`,
    iat: Math.floor(Date.now() / 1_000),
    jti: input.jti ?? crypto.randomUUID(),
    ath: createHash('sha256').update(input.credential).digest('base64url'),
  })).toString('base64url')
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: input.key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  return `${header}.${claims}.${signature}`
}

function fixture(input: {
  controls?: Record<string, unknown>
  runtime?: Record<string, unknown>
  stopRemoteTunnel?: () => unknown
} = {}) {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO boards (project_path, name) VALUES ('/remote', 'Remote')").run()
  const server = buildServer(
    db,
    input.controls ? (() => input.controls as never) : undefined,
    {
      token: 'owner-secret',
      agentToken: 'agent-secret',
      stopRemoteTunnel: input.stopRemoteTunnel,
      ...(input.runtime ? { agentOs: { runtime: input.runtime as never } } : {}),
    },
  )
  servers.push(server)
  return { db, server }
}

async function pair(server: ReturnType<typeof buildServer>, name: string, scopes?: string[]) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const publicJwk = keys.publicKey.export({ format: 'jwk' })
  const issued = await server.inject({
    method: 'POST',
    url: '/api/v1/os/devices/pairing-tickets',
    headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    payload: { expected_origin: 'https://phone.example.test', board_ids: [1], scopes },
  })
  expect(issued.statusCode).toBe(200)
  const ticket = issued.json().pairing_ticket as string
  expect(ticket).not.toContain('owner-secret')
  const redeemed = await server.inject({
    method: 'POST',
    url: '/api/v1/os/devices/redeem',
    headers: {
      host: 'phone.example.test', origin: 'https://phone.example.test',
      'sec-fetch-site': 'same-origin',
    },
    payload: {
      pairing_ticket: ticket,
      device_name: name,
      device_public_key_jwk: publicJwk,
    },
  })
  expect(redeemed.statusCode).toBe(200)
  return {
    id: redeemed.json().device_session.id as string,
    credential: redeemed.json().credential_issue.credential as string,
    credentialId: redeemed.json().credential_issue.credential_metadata.id as string,
    key: keys.privateKey,
    publicJwk,
  }
}

const deviceHeaders = (device: Awaited<ReturnType<typeof pair>>, method: string, path: string, jti?: string) => ({
  host: 'phone.example.test',
  origin: 'https://phone.example.test',
  'sec-fetch-site': 'same-origin',
  authorization: `Device ${device.credential}`,
  dpop: proof({ ...device, method, path, jti }),
})

async function stepUp(input: {
  server: ReturnType<typeof buildServer>
  device: Awaited<ReturnType<typeof pair>>
  operation: string
  resourceType: string
  resourceId: string
  requestDigest: string
  nonce: string
}) {
  const path = '/api/v1/os/devices/self/step-up'
  const requested = await input.server.inject({
    method: 'POST',
    url: path,
    headers: deviceHeaders(input.device, 'POST', path),
    payload: {
      operation: input.operation,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      request_digest: input.requestDigest,
      nonce: input.nonce,
    },
  })
  expect(requested.statusCode).toBe(202)
  const grantId = requested.json().request_id as string
  const approved = await input.server.inject({
    method: 'POST',
    url: `/api/v1/os/devices/step-up/${grantId}/approve`,
    headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
  })
  expect(approved.statusCode, approved.body).toBe(200)
  return grantId
}

describe('remote security integration', () => {
  it('never accepts owner authority from a remote host or query string', async () => {
    const { server } = fixture()
    expect((await server.inject({
      method: 'GET', url: '/api/v1/boards?token=owner-secret', headers: { host: 'phone.example.test' },
    })).statusCode).toBe(401)
    expect((await server.inject({
      method: 'GET', url: '/api/v1/boards',
      headers: { host: 'phone.example.test', authorization: 'Bearer owner-secret' },
    })).statusCode).toBe(401)
  })

  it('never accepts agent bearer authority through a remote or forwarded public Host', async () => {
    const { server } = fixture()
    for (const headers of [
      { host: 'phone.example.test' },
      { host: 'localhost', 'x-forwarded-host': 'phone.example.test' },
    ]) {
      const response = await server.inject({
        method: 'GET', url: '/api/v1/boards',
        headers: { ...headers, authorization: 'Bearer agent-secret' },
      })
      expect(response.statusCode).toBe(401)
    }
    expect((await server.inject({
      method: 'GET', url: '/api/v1/boards',
      headers: { host: 'localhost', authorization: 'Bearer agent-secret' },
    })).statusCode).not.toBe(401)
  })

  it('binds device credentials to origin, method, path, key and a durable one-use proof', async () => {
    const { db, server } = fixture()
    const device = await pair(server, 'Phone one')
    const path = '/api/v1/os/devices/self'
    const headers = deviceHeaders(device, 'GET', path, 'one-proof')
    const first = await server.inject({ method: 'GET', url: path, headers })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ device_session_id: device.id, name: 'Phone one' })
    expect((await server.inject({ method: 'GET', url: path, headers })).statusCode).toBe(401)
    const beforeDeniedContext = db.prepare(`SELECT credential.last_used_at, session.last_seen_at
      FROM os_device_credentials credential JOIN os_device_sessions session
        ON session.id=credential.device_session_id WHERE credential.device_session_id=?`).get(device.id)
    expect((await server.inject({
      method: 'GET', url: path,
      headers: { ...deviceHeaders(device, 'GET', path), host: 'attacker.example.test' },
    })).statusCode).toBe(401)
    expect(db.prepare(`SELECT credential.last_used_at, session.last_seen_at
      FROM os_device_credentials credential JOIN os_device_sessions session
        ON session.id=credential.device_session_id WHERE credential.device_session_id=?`).get(device.id))
      .toEqual(beforeDeniedContext)
  })

  it('issues purpose-bound, expiring, single-use stream credentials only in a header', async () => {
    const { db, server } = fixture()
    const device = await pair(server, 'Stream phone')
    const issuePath = '/api/v1/os/remote/streams'
    const issued = await server.inject({
      method: 'POST', url: issuePath,
      headers: deviceHeaders(device, 'POST', issuePath),
    })
    expect(issued.statusCode, issued.body).toBe(201)
    const ticket = issued.json().stream_ticket as string
    expect(ticket).toMatch(/^orchestra_stream_v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u)
    expect(issued.json()).toMatchObject({ purpose: 'remote-events' })
    expect(issued.headers.location).toBeUndefined()
    expect(issued.body).not.toContain('owner-secret')
    const stored = db.prepare(`SELECT secret_hash, consumed_at FROM os_remote_stream_tickets`).get() as {
      secret_hash: string
      consumed_at: string | null
    }
    expect(stored.secret_hash).toMatch(/^[0-9a-f]{64}$/u)
    expect(stored.secret_hash).not.toContain(ticket.split('.').at(-1))

    const openPath = '/api/v1/os/remote/stream'
    const streamHeaders = {
      host: 'phone.example.test', origin: 'https://phone.example.test',
      'sec-fetch-site': 'same-origin', authorization: `Stream ${ticket}`,
    }
    expect((await server.inject({
      method: 'GET', url: openPath,
      headers: { ...streamHeaders, host: 'attacker.example.test' },
    })).statusCode).toBe(401)
    expect(db.prepare('SELECT consumed_at FROM os_remote_stream_tickets').get())
      .toEqual({ consumed_at: null })

    await server.listen({ host: '127.0.0.1', port: 0 })
    const address = server.server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
    const opened = await new Promise<{
      response: IncomingMessage
      firstChunk: string
    }>((resolve, reject) => {
      const outbound = httpRequest({
        hostname: '127.0.0.1', port: address.port, method: 'GET', path: openPath,
        headers: streamHeaders,
      }, (response) => {
        response.once('data', (chunk) => resolve({ response, firstChunk: String(chunk) }))
        response.once('error', reject)
      })
      outbound.once('error', reject)
      outbound.end()
    })
    expect(opened.response.statusCode).toBe(200)
    expect(opened.response.headers['content-type']).toContain('text/event-stream')
    expect(opened.response.headers['cache-control']).toBe('no-store')
    expect(opened.firstChunk).toContain('event: ready')
    opened.response.destroy()
    expect((await server.inject({ method: 'GET', url: openPath, headers: streamHeaders })).statusCode)
      .toBe(401)
    expect((await server.inject({
      method: 'GET', url: '/api/v1/os/devices/self', headers: streamHeaders,
    })).statusCode).toBe(401)
    expect(db.prepare(`SELECT operation, outcome, attributed_scope FROM os_remote_mutation_audit
      WHERE operation='stream.issue'`).get()).toEqual({
      operation: 'stream.issue', outcome: 'succeeded', attributed_scope: 'stream',
    })
  })

  it('removes outstanding stream authority when its one device is revoked', async () => {
    const { db, server } = fixture()
    const device = await pair(server, 'Revoked stream phone')
    const issuePath = '/api/v1/os/remote/streams'
    const issued = await server.inject({
      method: 'POST', url: issuePath, headers: deviceHeaders(device, 'POST', issuePath),
    })
    expect(issued.statusCode, issued.body).toBe(201)
    expect((await server.inject({
      method: 'POST', url: `/api/v1/os/devices/${device.id}/revoke`,
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })).statusCode).toBe(200)
    expect(db.prepare('SELECT count(*) AS count FROM os_remote_stream_tickets').get())
      .toEqual({ count: 0 })
    expect((await server.inject({
      method: 'GET', url: '/api/v1/os/remote/stream',
      headers: {
        host: 'phone.example.test', origin: 'https://phone.example.test',
        'sec-fetch-site': 'same-origin', authorization: `Stream ${issued.json().stream_ticket}`,
      },
    })).statusCode).toBe(401)
  })

  it('keeps live streams filtered and closes only the revoked device stream', async () => {
    const { server } = fixture()
    const first = await pair(server, 'Live stream one')
    const second = await pair(server, 'Live stream two')
    const issue = async (device: Awaited<ReturnType<typeof pair>>) => {
      const path = '/api/v1/os/remote/streams'
      const response = await server.inject({
        method: 'POST', url: path, headers: deviceHeaders(device, 'POST', path),
      })
      expect(response.statusCode, response.body).toBe(201)
      return response.json().stream_ticket as string
    }
    const firstTicket = await issue(first)
    const secondTicket = await issue(second)
    await server.listen({ host: '127.0.0.1', port: 0 })
    const address = server.server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
    const open = (ticket: string) => new Promise<IncomingMessage>((resolve, reject) => {
      const outbound = httpRequest({
        hostname: '127.0.0.1', port: address.port, method: 'GET',
        path: '/api/v1/os/remote/stream',
        headers: {
          host: 'phone.example.test', origin: 'https://phone.example.test',
          'sec-fetch-site': 'same-origin', authorization: `Stream ${ticket}`,
        },
      }, (response) => {
        response.once('data', (chunk) => {
          expect(String(chunk)).toContain('event: ready')
          resolve(response)
        })
        response.once('error', reject)
      })
      outbound.once('error', reject)
      outbound.end()
    })
    const [firstStream, secondStream] = await Promise.all([open(firstTicket), open(secondTicket)])
    const nextChunk = (stream: IncomingMessage) => new Promise<string>((resolve, reject) => {
      stream.once('data', (chunk) => resolve(String(chunk)))
      stream.once('error', reject)
    })
    const firstChange = nextChunk(firstStream)
    const secondInitialChange = nextChunk(secondStream)
    server.bus.emit('event', { board_id: 1, type: 'agent', data: { raw_secret: 'never-stream-me' } })
    const firstFiltered = await firstChange
    const secondFiltered = await secondInitialChange
    expect(firstFiltered).toContain('"board_id":1')
    expect(firstFiltered).not.toContain('never-stream-me')
    expect(secondFiltered).toContain('"type":"agent"')
    expect(secondFiltered).not.toContain('never-stream-me')

    const firstClosed = nextChunk(firstStream)
    expect((await server.inject({
      method: 'POST', url: `/api/v1/os/devices/${first.id}/revoke`,
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })).statusCode).toBe(200)
    expect(await firstClosed).toContain('device_revoked')
    expect(secondStream.destroyed).toBe(false)
    const secondChange = nextChunk(secondStream)
    server.bus.emit('event', { board_id: 1, type: 'card', data: { body: 'withheld' } })
    const filtered = await secondChange
    expect(filtered).toContain('"type":"card"')
    expect(filtered).not.toContain('withheld')
    secondStream.destroy()
  })

  it('rotation closes old-generation streams and tickets without affecting another device', async () => {
    const { db, server } = fixture()
    const rotating = await pair(server, 'Rotating stream phone')
    const unrelated = await pair(server, 'Unrelated stream phone')
    const issue = async (device: Awaited<ReturnType<typeof pair>>) => {
      const path = '/api/v1/os/remote/streams'
      const response = await server.inject({
        method: 'POST', url: path, headers: deviceHeaders(device, 'POST', path),
      })
      expect(response.statusCode, response.body).toBe(201)
      return response.json().stream_ticket as string
    }
    const rotatingHeldTicket = await issue(rotating)
    await issue(rotating) // outstanding and unconsumed authority must also be removed
    const unrelatedTicket = await issue(unrelated)
    await server.listen({ host: '127.0.0.1', port: 0 })
    const address = server.server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
    const open = (ticket: string) => new Promise<IncomingMessage>((resolve, reject) => {
      const outbound = httpRequest({
        hostname: '127.0.0.1', port: address.port, method: 'GET',
        path: '/api/v1/os/remote/stream',
        headers: {
          host: 'phone.example.test', origin: 'https://phone.example.test',
          'sec-fetch-site': 'same-origin', authorization: `Stream ${ticket}`,
        },
      }, (response) => {
        response.once('data', () => resolve(response))
        response.once('error', reject)
      })
      outbound.once('error', reject)
      outbound.end()
    })
    const [rotatingStream, unrelatedStream] = await Promise.all([
      open(rotatingHeldTicket), open(unrelatedTicket),
    ])
    const rotatedClosed = new Promise<string>((resolve, reject) => {
      rotatingStream.once('data', (chunk) => resolve(String(chunk)))
      rotatingStream.once('error', reject)
    })
    const nextKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const nextJwk = nextKeys.publicKey.export({ format: 'jwk' }) as {
      kty: 'EC'; crv: 'P-256'; x: string; y: string
    }
    const requestId = 'rotate-stream-authority'
    const authenticatedDevice = {
      deviceSessionId: rotating.id,
      credentialId: rotating.credentialId,
      credentialGeneration: 0,
      tunnelOrigin: 'https://phone.example.test',
      authenticatedUserId: 'local-owner',
    }
    const rotationPayload = createRemoteCredentialRotationProofPayload({
      authenticatedDevice, newPublicKeyJwk: nextJwk, requestId,
    })
    const signRotation = (key: KeyObject) => sign('sha256', Buffer.from(rotationPayload), {
      key, dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    const rotated = await server.inject({
      method: 'POST', url: REMOTE_DEVICE_CREDENTIAL_ROTATION_PATH,
      headers: {
        ...deviceHeaders(rotating, 'POST', REMOTE_DEVICE_CREDENTIAL_ROTATION_PATH),
        'x-orchestra-request-id': requestId,
        [REMOTE_DEVICE_CREDENTIAL_ROTATION_PROOF_HEADER]: signRotation(rotating.key),
        [REMOTE_DEVICE_NEW_KEY_PROOF_HEADER]: signRotation(nextKeys.privateKey),
      },
      payload: { new_public_key_jwk: nextJwk },
    })
    expect(rotated.statusCode, rotated.body).toBe(201)
    expect(await rotatedClosed).toContain('credential_rotated')
    expect(db.prepare(`SELECT count(*) AS count FROM os_remote_stream_tickets
      WHERE device_session_id=?`).get(rotating.id)).toEqual({ count: 0 })
    expect(db.prepare(`SELECT count(*) AS count FROM os_remote_stream_tickets
      WHERE device_session_id=?`).get(unrelated.id)).toEqual({ count: 1 })
    expect(unrelatedStream.destroyed).toBe(false)
    const unrelatedChange = new Promise<string>((resolve, reject) => {
      unrelatedStream.once('data', (chunk) => resolve(String(chunk)))
      unrelatedStream.once('error', reject)
    })
    server.bus.emit('event', { board_id: 1, type: 'agent', data: { secret: 'filtered' } })
    expect(await unrelatedChange).toContain('"type":"agent"')
    unrelatedStream.destroy()
  })

  it('bounds invalid stream credential floods by stable ingress evidence', async () => {
    const { db, server } = fixture()
    const statuses: number[] = []
    for (let index = 0; index < 12; index += 1) {
      const response = await server.inject({
        method: 'GET', url: '/api/v1/os/remote/stream',
        headers: {
          host: 'phone.example.test', origin: 'https://phone.example.test',
          'sec-fetch-site': 'same-origin',
          authorization: `Stream orchestra_stream_v1.${crypto.randomUUID()}.${'A'.repeat(43)}`,
        },
      })
      statuses.push(response.statusCode)
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401))
    expect(statuses.slice(10)).toEqual([429, 429])
    expect(db.prepare(`SELECT count(*) AS count FROM os_remote_security_events
      WHERE reason_code='invalid_stream_credential'`).get()).toEqual({ count: 10 })
    expect(db.prepare(`SELECT count(*) AS count FROM os_remote_rate_limits
      WHERE family='auth-failure'`).get()).toEqual({ count: 1 })
  })

  it('closes a held stream at the credential or DeviceSession authority deadline', async () => {
    const { db, server } = fixture()
    const device = await pair(server, 'Expiring stream phone')
    const issuePath = '/api/v1/os/remote/streams'
    const issued = await server.inject({
      method: 'POST', url: issuePath, headers: deviceHeaders(device, 'POST', issuePath),
    })
    expect(issued.statusCode, issued.body).toBe(201)
    const expiresAt = new Date(Date.now() + 500).toISOString()
    db.prepare('UPDATE os_device_sessions SET expires_at=? WHERE id=?').run(expiresAt, device.id)
    db.prepare("UPDATE os_device_credentials SET expires_at=? WHERE device_session_id=? AND state='active'")
      .run(expiresAt, device.id)
    await server.listen({ host: '127.0.0.1', port: 0 })
    const address = server.server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
    const stream = await new Promise<IncomingMessage>((resolve, reject) => {
      const outbound = httpRequest({
        hostname: '127.0.0.1', port: address.port, method: 'GET',
        path: '/api/v1/os/remote/stream',
        headers: {
          host: 'phone.example.test', origin: 'https://phone.example.test',
          'sec-fetch-site': 'same-origin',
          authorization: `Stream ${issued.json().stream_ticket}`,
        },
      }, (response) => {
        response.once('data', (chunk) => {
          expect(String(chunk)).toContain('event: ready')
          resolve(response)
        })
        response.once('error', reject)
      })
      outbound.once('error', reject)
      outbound.end()
    })
    const terminal = await Promise.race([
      new Promise<string>((resolve, reject) => {
        stream.once('data', (chunk) => resolve(String(chunk)))
        stream.once('error', reject)
      }),
      new Promise<string>((_resolve, reject) => setTimeout(
        () => reject(new Error('held stream outlived authority expiry')), 2_000,
      )),
    ])
    expect(terminal).toContain('authority_expired')
  })

  it('revokes one lost phone without rotating another device or stopping the daemon', async () => {
    const { db, server } = fixture()
    const lost = await pair(server, 'Lost phone')
    const retained = await pair(server, 'Retained phone')
    const revoked = await server.inject({
      method: 'POST',
      url: `/api/v1/os/devices/${lost.id}/revoke`,
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })
    expect(revoked.statusCode).toBe(200)
    expect(db.prepare('SELECT state FROM os_device_sessions WHERE id=?').get(lost.id)).toEqual({ state: 'revoked' })
    const retainedSelf = '/api/v1/os/devices/self'
    expect((await server.inject({
      method: 'GET', url: retainedSelf,
      headers: deviceHeaders(retained, 'GET', retainedSelf),
    })).statusCode).toBe(200)
    expect((await server.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ live: true })
  })

  it('stores remote messages as no-tool work with device attribution and audit evidence', async () => {
    const { db, server } = fixture()
    const device = await pair(server, 'Q and A phone')
    const path = '/api/v1/os/remote/messages'
    const response = await server.inject({
      method: 'POST', url: path,
      headers: { ...deviceHeaders(device, 'POST', path), 'idempotency-key': 'question-1' },
      payload: { board_id: 1, body: 'What needs attention?' },
    })
    expect(response.statusCode).toBe(201)
    expect(db.prepare('SELECT target_kind, device_session_id FROM os_remote_messages').get())
      .toEqual({ target_kind: 'no-tool', device_session_id: device.id })
    expect(db.prepare(`SELECT operation, outcome, device_session_id, sensitive_values_retained
      FROM os_remote_mutation_audit WHERE operation='message.no-tool'`).get()).toEqual({
      operation: 'message.no-tool', outcome: 'succeeded',
      device_session_id: device.id, sensitive_values_retained: 0,
    })
  })

  it('surfaces authorized remote intents that lack terminal audit evidence after a crash window', async () => {
    const { db, server } = fixture()
    const device = await pair(server, 'Recovery phone')
    db.prepare(`INSERT INTO os_remote_mutation_audit (
      id, occurred_at, operation, rule_id, outcome, resource_type, resource_id,
      device_session_id, authenticated_user_id, credential_generation, attributed_scope,
      request_id, correlation_id, request_digest, tunnel_origin, sensitive_values_retained
    ) VALUES (
      'stalled-intent-1', datetime('now','-31 seconds'), 'agent.stop', 'agent.stop',
      'authorized', 'agent', 'agent-1', ?, 'local-owner', 0, 'agent-control',
      'stalled-request-1', 'stalled-request-1', ?, 'https://phone.example.test', 0
    )`).run(device.id, `sha256:${'a'.repeat(64)}`)

    const health = await server.inject({
      method: 'GET', url: '/api/v1/ops/health',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })
    expect(health.statusCode).toBe(200)
    expect(health.json().components).toContainEqual(expect.objectContaining({
      component: 'observability', status: 'degraded',
      reasonCode: 'stale_remote_authorized_intent',
      details: { stale_remote_authorized_intents: 1 },
    }))

    const alerts = await server.inject({
      method: 'GET', url: '/api/v1/ops/alerts',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })
    expect(alerts.statusCode, alerts.body).toBe(200)
    expect(alerts.json().alerts).toContainEqual(expect.objectContaining({
      type: 'remote_intent_stalled', severity: 'critical',
      reason_code: 'remote_authorized_intent_without_terminal_evidence',
    }))
  })

  it('exports retry, outbox lag and device-revoke propagation metrics from durable state', async () => {
    const { db, server } = fixture()
    db.prepare(`INSERT INTO ops_outbox (
      id, destination, dedupe_key, payload_json, payload_sha256, status, attempts,
      max_attempts, available_at, created_at
    ) VALUES (
      'revoke-observation-1', 'remote-device-revocation', 'revoke-observation-1',
      '{}', ?, 'pending', 3, 5, datetime('now','-2 minutes'), datetime('now','-2 minutes')
    )`).run('a'.repeat(64))
    const response = await server.inject({
      method: 'GET', url: '/api/v1/ops/metrics',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })
    expect(response.statusCode, response.body).toBe(200)
    const values = Object.fromEntries(response.json().metrics.map(
      (sample: { name: string; value: number }) => [sample.name, sample.value],
    ))
    expect(values.retry_attempts).toBe(2)
    expect(values.outbox_lag_ms).toBeGreaterThanOrEqual(119_000)
    expect(values.device_revoke_propagation_pending).toBe(1)
  })

  it('records pairing replay and emits explicit security alert evidence', async () => {
    const { server } = fixture()
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const issued = await server.inject({
      method: 'POST', url: '/api/v1/os/devices/pairing-tickets',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
      payload: { expected_origin: 'https://phone.example.test', board_ids: [1] },
    })
    const redeem = () => server.inject({
      method: 'POST', url: '/api/v1/os/devices/redeem',
      headers: {
        host: 'phone.example.test', origin: 'https://phone.example.test',
        'sec-fetch-site': 'same-origin',
      },
      payload: {
        pairing_ticket: issued.json().pairing_ticket,
        device_name: 'Replay phone',
        device_public_key_jwk: keys.publicKey.export({ format: 'jwk' }),
      },
    })
    expect((await redeem()).statusCode).toBe(200)
    expect((await redeem()).statusCode).toBe(401)
    const response = await server.inject({
      method: 'GET', url: '/api/v1/ops/alerts',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().alerts).toContainEqual(expect.objectContaining({
      type: 'pairing_replay', reason_code: 'pairing_ticket_replay_observed',
    }))
  })

  it('replays the same no-tool message once and rejects conflicting idempotency reuse', async () => {
    const { db, server } = fixture()
    const device = await pair(server, 'Retry phone')
    const path = '/api/v1/os/remote/messages'
    const send = (body: string) => server.inject({
      method: 'POST', url: path,
      headers: { ...deviceHeaders(device, 'POST', path), 'idempotency-key': 'stable-question' },
      payload: { board_id: 1, body },
    })
    expect((await send('Same question')).statusCode).toBe(201)
    const replay = await send('Same question')
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true })
    expect((await send('Different question')).statusCode).toBe(409)
    expect((db.prepare('SELECT count(*) AS count FROM os_remote_messages').get() as { count: number }).count).toBe(1)
  })

  it('fails existing device authority closed when the operator kill switch is active', async () => {
    const { server } = fixture()
    const device = await pair(server, 'Killed phone')
    process.env.ORCHESTRA_REMOTE_KILL_SWITCH = '1'
    const path = '/api/v1/os/devices/self'
    expect((await server.inject({ method: 'GET', url: path, headers: deviceHeaders(device, 'GET', path) })).statusCode)
      .toBe(503)
    expect((await server.inject({
      method: 'GET', url: '/api/v1/os/devices', headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })).statusCode).toBe(200)
  })

  it('practices durable rollback without stopping local recovery or restoring old authority', async () => {
    let tunnelStops = 0
    const { db, server } = fixture({ stopRemoteTunnel: () => {
      tunnelStops += 1
      return { provider: 'cloudflared', url: 'https://owned.example.test' }
    } })
    const retained = await pair(server, 'Rollback retained phone')
    const rollbackDevice = await pair(server, 'Rollback admin phone', [
      'observe', 'stream', 'message', 'approve', 'admin',
    ])
    const streamPath = '/api/v1/os/remote/streams'
    const streamIssue = await server.inject({
      method: 'POST', url: streamPath, headers: deviceHeaders(rollbackDevice, 'POST', streamPath),
    })
    expect(streamIssue.statusCode, streamIssue.body).toBe(201)
    expect((await server.inject({
      method: 'POST', url: streamPath, headers: deviceHeaders(retained, 'POST', streamPath),
    })).statusCode).toBe(201)
    const pushPath = '/api/v1/os/devices/self/push/subscriptions'
    expect((await server.inject({
      method: 'POST', url: pushPath, headers: deviceHeaders(rollbackDevice, 'POST', pushPath),
      payload: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/rollback-subscription',
        keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(24) },
      },
    })).statusCode).toBe(201)
    const revokePath = `/api/v1/os/devices/${retained.id}/revoke`
    await stepUp({
      server, device: rollbackDevice, operation: 'device.revoke', resourceType: 'device',
      resourceId: retained.id,
      requestDigest: digestRemoteMutation(JSON.stringify({ method: 'POST', path: revokePath, body: null })),
      nonce: 'rollback-step-up',
    })
    expect((await server.inject({
      method: 'POST', url: '/api/v1/os/devices/pairing-tickets',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
      payload: { expected_origin: 'https://phone.example.test', board_ids: [1] },
    })).statusCode).toBe(200)

    await server.listen({ host: '127.0.0.1', port: 0 })
    const address = server.server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
    const held = await new Promise<IncomingMessage>((resolve, reject) => {
      const outbound = httpRequest({
        hostname: '127.0.0.1', port: address.port, method: 'GET',
        path: '/api/v1/os/remote/stream',
        headers: {
          host: 'phone.example.test', origin: 'https://phone.example.test',
          'sec-fetch-site': 'same-origin',
          authorization: `Stream ${streamIssue.json().stream_ticket}`,
        },
      }, (response) => {
        response.once('data', () => resolve(response))
        response.once('error', reject)
      })
      outbound.once('error', reject)
      outbound.end()
    })
    const closed = new Promise<string>((resolve, reject) => {
      held.once('data', (chunk) => resolve(String(chunk)))
      held.once('error', reject)
    })
    const rollback = await server.inject({
      method: 'POST', url: '/api/v1/os/devices/rollback',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
      payload: { confirm: 'REVOKE_ALL_REMOTE_AUTHORITY', reason: 'rollback drill' },
    })
    expect(rollback.statusCode, rollback.body).toBe(200)
    expect(rollback.json()).toMatchObject({
      state: 'disabled', active_streams_closed: 1,
      tunnel_state_cleared: true, local_operator_available: true,
    })
    expect(await closed).toContain('remote_rollback')
    expect(tunnelStops).toBe(1)
    expect(db.prepare('SELECT state FROM os_remote_control_state WHERE id=1').get())
      .toEqual({ state: 'disabled' })
    for (const [table, predicate] of [
      ['os_pairing_tickets', "state='pending'"],
      ['os_device_sessions', "state='active'"],
      ['os_device_credentials', "state='active'"],
      ['os_remote_step_up_grants', "state IN ('pending','active')"],
      ['os_remote_stream_tickets', '1=1'],
      ['os_remote_push_subscriptions', '1=1'],
      ['os_remote_resource_grants', '1=1'],
    ]) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${predicate}`).get(), table)
        .toEqual({ count: 0 })
    }
    const deniedOld = await server.inject({
      method: 'GET', url: '/api/v1/os/devices/self',
      headers: deviceHeaders(retained, 'GET', '/api/v1/os/devices/self'),
    })
    expect(deniedOld.statusCode).toBe(503)
    expect(deniedOld.headers['clear-site-data']).toBe('"cache", "storage"')
    expect((await server.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ live: true })
    expect((await server.inject({
      method: 'GET', url: '/api/v1/os/devices/remote-control',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })).statusCode).toBe(200)
    expect((await server.inject({
      method: 'POST', url: '/api/v1/os/devices/pairing-tickets',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
      payload: { expected_origin: 'https://phone.example.test', board_ids: [1] },
    })).statusCode).toBe(503)
    expect((await server.inject({
      method: 'POST', url: '/api/v1/os/devices/rollback/enable',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
      payload: { confirm: 'ENABLE_NEW_REMOTE_PAIRING' },
    })).json()).toEqual({ state: 'enabled', restored_credentials: 0 })
    expect((await server.inject({
      method: 'GET', url: '/api/v1/os/devices/self',
      headers: deviceHeaders(retained, 'GET', '/api/v1/os/devices/self'),
    })).statusCode).toBe(401)
  })

  it('bounds rotating invalid authority cardinality by stable ingress', async () => {
    const { db, server } = fixture()
    const statuses: number[] = []
    for (let index = 0; index < 12; index += 1) {
      const response = await server.inject({
        method: 'GET', url: '/api/v1/os/devices/self',
        headers: {
          host: 'phone.example.test', origin: `https://attacker-${index}.example.test`,
          'sec-fetch-site': 'same-origin', authorization: `Device invalid.${index}.claim`, dpop: 'invalid',
        },
      })
      statuses.push(response.statusCode)
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401))
    expect(statuses.slice(10)).toEqual([429, 429])
    const rows = (db.prepare(`SELECT count(*) AS count FROM os_remote_rate_limits
      WHERE family='auth-failure'`).get() as { count: number }).count
    expect(rows).toBeLessThanOrEqual(31)
  })

  it('rate-limits random pairing tickets before ticket lookup with one bounded ingress row', async () => {
    const { db, server } = fixture()
    let last = 0
    for (let index = 0; index < 21; index += 1) {
      last = (await server.inject({
        method: 'POST', url: '/api/v1/os/devices/redeem',
        headers: { host: 'phone.example.test', origin: 'https://phone.example.test', 'sec-fetch-site': 'same-origin' },
        payload: { pairing_ticket: `orchestra_pair_v1.random-${index}.invalid`, device_name: 'scanner' },
      })).statusCode
    }
    expect(last).toBe(429)
    expect(db.prepare(`SELECT count(*) AS count FROM os_remote_rate_limits WHERE family='pairing'`).get())
      .toEqual({ count: 1 })
  })

  it('binds push subscriptions to one DeviceSession and deletes them atomically on revoke', async () => {
    const { db, server } = fixture()
    const device = await pair(server, 'Push phone')
    const path = '/api/v1/os/devices/self/push/subscriptions'
    const subscribed = await server.inject({
      method: 'POST', url: path,
      headers: deviceHeaders(device, 'POST', path),
      payload: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/subscription-one',
        keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(24) },
      },
    })
    expect(subscribed.statusCode).toBe(201)
    expect(db.prepare(`SELECT device_session_id, failures FROM os_remote_push_subscriptions`).get())
      .toEqual({ device_session_id: device.id, failures: 0 })
    expect((await server.inject({
      method: 'POST', url: `/api/v1/os/devices/${device.id}/revoke`,
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })).statusCode).toBe(200)
    expect(db.prepare('SELECT count(*) AS count FROM os_remote_push_subscriptions').get()).toEqual({ count: 0 })
  })

  it('rejects arbitrary, private, metadata and noncanonical push egress endpoints', async () => {
    const { db, server } = fixture()
    const device = await pair(server, 'Push boundary phone')
    const path = '/api/v1/os/devices/self/push/subscriptions'
    for (const endpoint of [
      'https://127.0.0.1/internal',
      'https://[::1]/internal',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/computeMetadata/v1',
      'https://attacker.example/collect',
      'https://fcm.googleapis.com:8443/fcm/send/token',
      'https://user:pass@fcm.googleapis.com/fcm/send/token',
    ]) {
      const response = await server.inject({
        method: 'POST', url: path,
        headers: deviceHeaders(device, 'POST', path),
        payload: { endpoint, keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(24) } },
      })
      expect(response.statusCode, endpoint).toBe(400)
    }
    expect(db.prepare('SELECT count(*) AS count FROM os_remote_push_subscriptions').get())
      .toEqual({ count: 0 })
    expect(db.prepare(`SELECT count(*) AS count FROM os_remote_mutation_audit
      WHERE operation='push.subscribe' AND outcome='denied'`).get()).toEqual({ count: 7 })
  })

  it('binds production agent control to scope, exact resources, step-up and closed audit evidence', async () => {
    const calls: string[] = []
    const { db, server } = fixture({
      controls: {
        interruptAgent: async (id: number) => { calls.push(`pause:${id}`); return true },
        fire: async (id: number) => { calls.push(`stop:${id}`); return true },
      },
    })
    const inserted = db.prepare(`INSERT INTO agents (board_id, name, status, provider)
      VALUES (1, 'remote-worker', 'active', 'codex')`).run()
    const agentId = Number(inserted.lastInsertRowid)
    const observer = await pair(server, 'Observer')
    const pausePath = `/api/v1/os/remote/agents/${agentId}/pause`
    expect((await server.inject({
      method: 'POST', url: pausePath,
      headers: deviceHeaders(observer, 'POST', pausePath),
    })).statusCode).toBe(403)

    const controller = await pair(server, 'Controller', ['observe', 'agent-control'])
    expect((await server.inject({
      method: 'POST', url: pausePath,
      headers: deviceHeaders(controller, 'POST', pausePath),
    })).statusCode).toBe(200)
    const stopPath = `/api/v1/os/remote/agents/${agentId}/stop`
    const canonical = JSON.stringify({ operation: 'agent.stop', agent_id: agentId })
    const nonce = 'stop-agent-nonce'
    const grantId = await stepUp({
      server,
      device: controller,
      operation: 'agent.stop',
      resourceType: 'agent',
      resourceId: String(agentId),
      requestDigest: digestRemoteMutation(canonical),
      nonce,
    })
    const elevatedHeaders = {
      ...deviceHeaders(controller, 'POST', stopPath),
      'x-orchestra-step-up-grant': grantId,
      'x-orchestra-step-up-nonce': nonce,
    }
    expect((await server.inject({
      method: 'POST', url: stopPath,
      headers: elevatedHeaders,
    })).statusCode).toBe(200)
    expect((await server.inject({
      method: 'POST', url: stopPath,
      headers: {
        ...elevatedHeaders,
        ...deviceHeaders(controller, 'POST', stopPath),
      },
    })).statusCode).toBe(403)
    expect(calls).toEqual([`pause:${agentId}`, `stop:${agentId}`])
    expect(db.prepare(`SELECT operation, outcome, attributed_scope, sensitive_values_retained
      FROM os_remote_mutation_audit WHERE operation='agent.stop' AND outcome='succeeded'`).get()).toEqual({
      operation: 'agent.stop',
      outcome: 'succeeded',
      attributed_scope: 'agent-control',
      sensitive_values_retained: 0,
    })
    const alerts = await server.inject({
      method: 'GET', url: '/api/v1/ops/alerts',
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })
    expect(alerts.json().alerts).toContainEqual(expect.objectContaining({
      type: 'step_up_replay', reason_code: 'remote_step_up_replay_observed',
    }))
  })

  it('keeps the production terminal view-only until exact action-bound step-up and never audits input', async () => {
    const writes: string[] = []
    const { db, server } = fixture({
      runtime: { writeProcessInput: async (_id: string, data: string) => { writes.push(data) } },
    })
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path)
      VALUES ('workspace-1', 1, 'remote', 'worktree', '/remote')`).run()
    db.prepare(`INSERT INTO processes (id, workspace_id, name, command, cwd, status)
      VALUES ('process-1', 'workspace-1', 'shell', 'shell', '/remote', 'running')`).run()
    db.prepare(`INSERT INTO process_output (process_id, seq, stream, data, created_at)
      VALUES ('process-1', 1, 'stdout', 'token=secret-value', ?)`).run(new Date().toISOString())

    const observer = await pair(server, 'Terminal viewer')
    const viewPath = '/api/v1/os/remote/processes/process-1/terminal'
    const view = await server.inject({
      method: 'GET', url: viewPath,
      headers: deviceHeaders(observer, 'GET', viewPath),
    })
    expect(view.statusCode).toBe(200)
    expect(JSON.stringify(view.json())).not.toContain('secret-value')

    const writer = await pair(server, 'Terminal writer', ['observe', 'terminal-write'])
    const inputPath = '/api/v1/os/remote/processes/process-1/terminal/input'
    const data = 'printf hello\n'
    expect((await server.inject({
      method: 'POST', url: inputPath,
      headers: deviceHeaders(writer, 'POST', inputPath), payload: { data },
    })).statusCode).toBe(403)
    const canonical = JSON.stringify({
      operation: 'terminal.input',
      process_id: 'process-1',
      input_digest: createHash('sha256').update(data).digest('hex'),
      byte_length: Buffer.byteLength(data),
    })
    const nonce = 'terminal-input-nonce'
    const grantId = await stepUp({
      server,
      device: writer,
      operation: 'terminal.input',
      resourceType: 'process',
      resourceId: 'process-1',
      requestDigest: digestRemoteMutation(canonical),
      nonce,
    })
    expect((await server.inject({
      method: 'POST', url: inputPath,
      headers: {
        ...deviceHeaders(writer, 'POST', inputPath),
        'x-orchestra-step-up-grant': grantId,
        'x-orchestra-step-up-nonce': nonce,
      },
      payload: { data },
    })).statusCode).toBe(200)
    expect(writes).toEqual([data])
    const audit = db.prepare(`SELECT * FROM os_remote_mutation_audit
      WHERE operation='terminal.input' AND outcome='succeeded'`).get() as Record<string, unknown>
    expect(audit).toMatchObject({ device_session_id: writer.id, attributed_scope: 'terminal-write' })
    expect(JSON.stringify(audit)).not.toContain(data.trim())
  })

  it('projects a generic approval summary and attributes an exact no-step-up denial', async () => {
    const decisions: unknown[][] = []
    const { db, server } = fixture({
      controls: {
        interruptAgent: async () => true,
        resolveApproval: async (...args: unknown[]) => { decisions.push(args); return true },
      },
    })
    const inserted = db.prepare(`INSERT INTO agents (board_id, name, status, provider)
      VALUES (1, 'approver', 'active', 'claude')`).run()
    const agentId = Number(inserted.lastInsertRowid)
    db.prepare(`INSERT INTO attention_items
      (id, board_id, agent_id, kind, severity, title, detail, status, created_at)
      VALUES ('approval-1', 1, ?, 'permission.request', 'critical', ?, ?, 'open', ?)`)
      .run(agentId, 'Dangerous /secret/path token=abc', JSON.stringify({
        request_id: 'provider-request-1', tool: 'Shell', summary: '/secret/path',
      }), new Date().toISOString())
    const device = await pair(server, 'Approval phone', ['observe', 'approve'])
    const listPath = '/api/v1/os/remote/approvals?board_id=1'
    const listed = await server.inject({
      method: 'GET', url: listPath,
      headers: deviceHeaders(device, 'GET', '/api/v1/os/remote/approvals'),
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().approvals[0]).toMatchObject({
      id: 'approval-1', summary: 'Approval requested for Shell', severity: 'critical',
    })
    expect(JSON.stringify(listed.json())).not.toContain('/secret/path')
    const decisionPath = '/api/v1/os/remote/approvals/approval-1/decision'
    expect((await server.inject({
      method: 'POST', url: decisionPath,
      headers: deviceHeaders(device, 'POST', decisionPath),
      payload: { decision: 'deny' },
    })).statusCode).toBe(200)
    expect(decisions).toEqual([[agentId, 'provider-request-1', 'deny']])
    expect(db.prepare(`SELECT operation, device_session_id, attributed_scope, outcome
      FROM os_remote_mutation_audit WHERE operation='approval.deny' AND outcome='succeeded'`).get()).toEqual({
      operation: 'approval.deny', device_session_id: device.id,
      attributed_scope: 'approve', outcome: 'succeeded',
    })
  })

  it('binds each remote agent only to a process proven by its exact session event', async () => {
    const { db, server } = fixture()
    const firstAgent = Number(db.prepare(`INSERT INTO agents (board_id, name, status, provider)
      VALUES (1, 'first', 'active', 'codex')`).run().lastInsertRowid)
    const secondAgent = Number(db.prepare(`INSERT INTO agents (board_id, name, status, provider)
      VALUES (1, 'second', 'active', 'codex')`).run().lastInsertRowid)
    db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path)
      VALUES ('shared-workspace', 1, 'shared', 'worktree', '/remote')`).run()
    for (const [session, agent] of [['session-first', firstAgent], ['session-second', secondAgent]] as const) {
      db.prepare(`INSERT INTO agent_sessions (id, workspace_id, agent_id, provider, status)
        VALUES (?, 'shared-workspace', ?, 'codex', 'running')`).run(session, agent)
    }
    for (const processId of ['process-first', 'process-second']) {
      db.prepare(`INSERT INTO processes (id, workspace_id, name, command, cwd, status)
        VALUES (?, 'shared-workspace', ?, 'shell', '/remote', 'running')`).run(processId, processId)
    }
    db.prepare(`INSERT INTO os_events
      (id, board_id, workspace_id, session_id, process_id, kind, source, payload)
      VALUES ('event-first', 1, 'shared-workspace', 'session-first', 'process-first',
        'process.bound', 'runtime', '{}')`).run()
    db.prepare(`INSERT INTO os_events
      (id, board_id, workspace_id, session_id, process_id, kind, source, payload)
      VALUES ('event-second', 1, 'shared-workspace', 'session-second', 'process-second',
        'process.bound', 'runtime', '{}')`).run()
    const device = await pair(server, 'Observer')
    const route = '/api/v1/os/remote/agents'
    const response = await server.inject({
      method: 'GET', url: `${route}?board_id=1`,
      headers: deviceHeaders(device, 'GET', route),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().agents).toEqual([
      expect.objectContaining({ id: firstAgent, process_id: 'process-first' }),
      expect.objectContaining({ id: secondAgent, process_id: 'process-second' }),
    ])
  })
})

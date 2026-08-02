import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FastifySqliteRemoteAdversarialTarget,
  type RemoteAdversarialObservation,
} from './support/fastify-sqlite-remote-adversarial-target.js'
import { runRemoteSecurityAdversarialContract } from './support/remote-ops-adversarial-contract.js'
import { remoteRequestDigest } from './support/remote-request-digest.js'

type Device = { id: string; credential: string; credentialId: string; key: string }

describe('FastifySqliteRemoteAdversarialTarget conformance simulator', () => {
  let target: FastifySqliteRemoteAdversarialTarget

  beforeEach(async () => {
    target = new FastifySqliteRemoteAdversarialTarget()
    await target.reset()
  })

  afterEach(async () => target.close())

  async function pair(name: string, scopes?: string[], ttl?: {
    credentialTtlSeconds?: number
    deviceSessionTtlSeconds?: number
  }): Promise<Device> {
    const key = `${name}-key`
    const issued = await target.perform({
      op: 'pairing.issue',
      origin: 'https://remote.example',
      scopes,
      ...ttl,
    })
    expect(issued.status).toBe(201)
    const redeemed = await target.perform({
      op: 'pairing.redeem',
      ticket: issued.ticket,
      origin: 'https://remote.example',
      name,
      deviceKey: key,
    })
    expect(redeemed.status).toBe(201)
    return {
      id: String(redeemed.deviceId),
      credential: String(redeemed.credential),
      credentialId: String(redeemed.credentialId),
      key,
    }
  }

  function request(device: Device, action: Record<string, unknown> = {}) {
    return target.perform({
      op: 'http.request',
      method: 'GET',
      path: '/api/v1/remote/observe',
      origin: 'https://remote.example',
      host: 'remote.example',
      fetchSite: 'same-origin',
      credential: device.credential,
      deviceKey: device.key,
      ...action,
    })
  }

  it('passes the canonical AC-01 through AC-20 as test-double conformance evidence', async () => {
    const results = await runRemoteSecurityAdversarialContract(target)
    expect(results.filter(({ status }) => status === 'passed')).toHaveLength(20)
    expect(results.filter(({ status }) => status === 'failed')).toEqual([])
  })

  it('makes pairing tickets origin-bound and one-time without persisting browser or master authority', async () => {
    const sentinel = 'MASTER-SENTINEL-DO-NOT-EXPOSE'
    await target.perform({ op: 'fixture.master-secret', secret: sentinel })
    const issued = await target.perform({ op: 'pairing.issue', origin: 'https://remote.example' })

    expect((await target.perform({
      op: 'pairing.redeem',
      ticket: issued.ticket,
      origin: 'https://evil.example',
      name: 'attacker',
      deviceKey: 'attacker-key',
    })).status).toBe(403)

    const redeemed = await target.perform({
      op: 'pairing.redeem',
      ticket: issued.ticket,
      origin: 'https://remote.example',
      name: 'owner-phone',
      deviceKey: 'owner-key',
    })
    expect(redeemed.status).toBe(201)
    expect((await target.perform({
      op: 'pairing.redeem',
      ticket: issued.ticket,
      origin: 'https://remote.example',
      name: 'replay',
      deviceKey: 'replay-key',
    })).status).toBe(403)

    const browser = await target.perform({ op: 'browser.inspect', deviceId: redeemed.deviceId })
    const storage = await target.perform({ op: 'security.storage-inspect' })
    const exposed = JSON.stringify({ browser, storage })
    expect(exposed).not.toContain(sentinel)
    expect(exposed).not.toContain(String(issued.ticket))
    expect(exposed).not.toContain(String(redeemed.credential))
    expect(exposed).not.toContain(String(issued.ticket).split('.').at(-1))
    expect(exposed).not.toContain(String(redeemed.credential).split('.').at(-1))
  })

  it('binds key proof to the credential and exact request and rejects replay', async () => {
    const phone = await pair('phone')
    expect((await request(phone, { deviceKey: 'stolen-key' })).status).toBe(403)

    const nonce = 'single-use-proof'
    expect((await request(phone, { proofNonce: nonce })).status).toBe(200)
    expect((await request(phone, { proofNonce: nonce })).status).toBe(409)

    const forgedPayload = JSON.stringify({
      method: 'GET',
      path: '/api/v1/system/private',
      origin: 'https://remote.example',
      nonce: 'tampered-target',
      credential_sha256: 'not-the-live-credential',
    })
    expect((await request(phone, {
      proofNonce: 'tampered-target',
      proofPayloadOverride: forgedPayload,
    })).status).toBe(401)

    expect((await target.perform({
      op: 'http.request',
      method: 'GET',
      path: '/api/v1/remote/observe',
      origin: 'https://remote.example',
      host: 'remote.example',
      fetchSite: 'same-origin',
      credential: 'MASTER-SENTINEL-DO-NOT-EXPOSE',
      deviceKey: phone.key,
    })).status).toBe(403)
  })

  it('persists consumed proof nonces across a daemon-style SQLite reopen', async () => {
    await target.close()
    const directory = mkdtempSync(join(tmpdir(), 'orchestra-remote-proof-'))
    target = new FastifySqliteRemoteAdversarialTarget(join(directory, 'remote.db'))
    try {
      await target.reset()
      const phone = await pair('persistent-phone')
      expect((await request(phone, { proofNonce: 'durable-nonce' })).status).toBe(200)
      await target.restart()
      expect((await request(phone, { proofNonce: 'durable-nonce' })).status).toBe(409)
    } finally {
      await target.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('expires credentials and sessions durably and fails their subsequent requests closed', async () => {
    const credentialExpiry = await pair('short-credential', undefined, {
      credentialTtlSeconds: 30,
      deviceSessionTtlSeconds: 60,
    })
    await target.perform({ op: 'clock.advance', milliseconds: 31_000 })
    expect((await request(credentialExpiry)).status).toBe(403)

    const firstStorage = await target.perform({ op: 'security.storage-inspect' })
    expect(states(firstStorage, 'os_device_credentials')).toContain('expired')
    expect(states(firstStorage, 'os_device_sessions')).toContain('active')

    const sessionExpiry = await pair('short-session', undefined, {
      credentialTtlSeconds: 60,
      deviceSessionTtlSeconds: 60,
    })
    await target.perform({ op: 'clock.advance', milliseconds: 61_000 })
    expect((await request(sessionExpiry)).status).toBe(403)
    const secondStorage = await target.perform({ op: 'security.storage-inspect' })
    expect(states(secondStorage, 'os_device_sessions')).toContain('expired')
  })

  it('isolates lost-device revocation while preserving unrelated authority and daemon health', async () => {
    const lost = await pair('lost-phone')
    const survivor = await pair('surviving-phone')

    const revoked = await target.perform({ op: 'device.revoke', deviceId: lost.id, reason: 'lost' })
    expect(revoked).toMatchObject({ status: 200, state: 'compromised' })
    expect((await request(lost)).status).toBe(403)
    expect((await request(survivor)).status).toBe(200)
    expect(await target.perform({ op: 'browser.reconnect', deviceId: lost.id }))
      .toMatchObject({ status: 200, purged: true, authorized: false, queuedMutations: 0 })
    expect(await target.perform({ op: 'daemon.health' }))
      .toMatchObject({ status: 200, running: true, otherStreamsClosed: 0 })
  })

  it('rejects hostile Host, forwarded Host, Origin, and Fetch Metadata before credential use', async () => {
    const phone = await pair('phone')
    const contexts = [
      { host: 'evil.example' },
      { forwardedHost: 'evil.example' },
      { origin: 'https://evil.example' },
      { fetchSite: 'cross-site' },
    ]
    for (const context of contexts) {
      expect((await request(phone, context)).status).toBe(403)
    }
    const events = await target.perform({ op: 'security.events' })
    expect(events.status).toBe(200)
    expect(events.events).toHaveLength(4)
  })

  it('defaults unclassified, cross-resource, and sensitive reads and mutations to deny', async () => {
    const observer = await pair('observer', ['observe'])
    for (const [method, path] of [
      ['GET', '/api/v1/processes/p1/output'],
      ['GET', '/api/v1/transcripts/t1'],
      ['GET', '/api/v1/boards/other/summary'],
      ['GET', '/api/v1/_fixture/unclassified-read'],
      ['POST', '/api/v1/_fixture/unclassified-mutation'],
      ['POST', '/api/v1/processes/p1/input'],
    ]) {
      expect((await request(observer, { method, path })).status).toBe(403)
    }
    expect(await request(observer)).toMatchObject({
      status: 200,
      dataClass: 'redacted_observe',
      cacheable: false,
    })
  })

  it('makes step-up grants short-lived, device/action/resource/digest-bound, and one-use', async () => {
    const terminal = await pair('terminal', ['terminal-write'])
    const other = await pair('other-terminal', ['terminal-write'])
    const safeBody = { data: 'safe\n' }
    const digest = remoteRequestDigest({
      method: 'POST', path: '/api/v1/processes/p1/input', body: safeBody,
    })
    const issued = await target.perform({
      op: 'step-up.issue',
      deviceId: terminal.id,
      action: 'terminal-write',
      resource: 'process:p1',
      digest,
      nonce: 'unique-step-up-nonce',
    })
    expect(issued.status).toBe(201)
    const stepUp = String(issued.grant)

    expect((await request(terminal, {
      method: 'POST', path: '/api/v1/processes/p2/input', body: safeBody, stepUp,
    })).status).toBe(403)
    expect((await request(other, {
      method: 'POST', path: '/api/v1/processes/p1/input', body: safeBody, stepUp,
    })).status).toBe(403)
    expect((await request(terminal, {
      method: 'POST', path: '/api/v1/processes/p1/input', body: { data: 'tampered\n' }, stepUp,
    })).status).toBe(403)
    expect((await request(terminal, {
      method: 'POST', path: '/api/v1/processes/p1/input', body: safeBody, stepUp,
    })).status).toBe(202)
    expect((await request(terminal, {
      method: 'POST', path: '/api/v1/processes/p1/input', body: safeBody, stepUp,
    })).status).toBe(403)

    const expiringBody = { data: 'expires\n' }
    const expiring = await target.perform({
      op: 'step-up.issue',
      deviceId: terminal.id,
      action: 'terminal-write',
      resource: 'process:p1',
      digest: remoteRequestDigest({
        method: 'POST', path: '/api/v1/processes/p1/input', body: expiringBody,
      }),
      nonce: 'expiring-step-up-nonce',
      expiresInMs: 1,
    })
    await target.perform({ op: 'clock.advance', milliseconds: 2 })
    expect((await request(terminal, {
      method: 'POST', path: '/api/v1/processes/p1/input', body: expiringBody, stepUp: expiring.grant,
    })).status).toBe(403)

    const storage = JSON.stringify(await target.perform({ op: 'security.storage-inspect' }))
    expect(storage).not.toContain(stepUp)
    expect(storage).not.toContain(stepUp.split('.').at(-1))
  })

  it('leaves no orphan authority in the request-scheduled, rotate-then-revoke interleaving', async () => {
    // True cross-process rotate-vs-revoke contention is covered in device-sessions.test.ts;
    // this boundary test verifies the observable post-ordering invariant through Fastify.
    const raced = await pair('raced-phone')
    const survivor = await pair('survivor')
    const pendingRequest = request(raced, { proofNonce: 'race-request' })
    const [requestResult, rotationResult, revokeResult] = await Promise.all([
      pendingRequest,
      target.perform({ op: 'device.rotate', deviceId: raced.id, proofNonce: 'race-rotate' }),
      target.perform({ op: 'device.revoke', deviceId: raced.id, reason: 'lost' }),
    ])
    expect([200, 403]).toContain(requestResult.status)
    expect(rotationResult.status).toBe(200)
    expect(revokeResult).toMatchObject({ status: 200, state: 'compromised' })
    expect((await request(raced)).status).toBe(403)
    if (typeof rotationResult.credential === 'string') {
      expect((await request({
        ...raced,
        credential: rotationResult.credential,
        credentialId: String(rotationResult.credentialId),
      })).status).toBe(403)
    }
    expect((await request(survivor)).status).toBe(200)

    const storage = await target.perform({ op: 'security.storage-inspect' })
    const sessions = rows(storage, 'os_device_sessions')
    const credentials = rows(storage, 'os_device_credentials')
    expect(sessions.find((row) => row.id === raced.id)?.state).toBe('compromised')
    expect(credentials
      .filter((row) => row.device_session_id === raced.id)
      .some((row) => row.state === 'active')).toBe(false)
  })

  it('enforces one-winner approvals, one-use stream tickets, safe offline behavior, and anti-framing', async () => {
    const first = await pair('first')
    const second = await pair('second')
    const [left, right] = await Promise.all([
      request(first, {
        method: 'POST', path: '/api/v1/approvals/race', body: { decision: 'deny' },
      }),
      request(second, {
        method: 'POST', path: '/api/v1/approvals/race', body: { decision: 'cancel' },
      }),
    ])
    expect([left, right].filter((entry) => entry.status === 201)).toHaveLength(1)
    expect([left, right].filter((entry) => entry.status === 409)).toHaveLength(1)

    const stream = await request(first, { method: 'POST', path: '/api/v1/remote/streams' })
    expect(stream.status).toBe(201)
    expect((await target.perform({
      op: 'stream.open',
      ticket: stream.streamTicket,
      origin: 'https://remote.example',
      credential: second.credential,
      deviceKey: second.key,
    })).status).toBe(403)
    expect((await target.perform({
      op: 'stream.open',
      ticket: stream.streamTicket,
      origin: 'https://remote.example',
      credential: first.credential,
      deviceKey: first.key,
    })).status).toBe(200)
    expect((await target.perform({
      op: 'stream.open',
      ticket: stream.streamTicket,
      origin: 'https://remote.example',
      credential: first.credential,
      deviceKey: first.key,
    })).status).toBe(409)

    const expiringStream = await request(first, { method: 'POST', path: '/api/v1/remote/streams' })
    await target.perform({ op: 'clock.advance', milliseconds: 30_001 })
    expect((await target.perform({
      op: 'stream.open',
      ticket: expiringStream.streamTicket,
      origin: 'https://remote.example',
      credential: first.credential,
      deviceKey: first.key,
    })).status).toBe(409)

    expect(await target.perform({ op: 'browser.offline-mutation', family: 'destructive' }))
      .toMatchObject({ status: 409, queued: false })
    const shell = await target.perform({ op: 'http.request', method: 'GET', path: '/', host: 'remote.example' })
    expect(shell.status).toBe(200)
    expect(shell.headers).toMatchObject({
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    })
  })
})

function rows(
  observation: RemoteAdversarialObservation,
  table: string,
): Array<Record<string, unknown>> {
  return ((observation.rows as Record<string, unknown[]>)[table] ?? []) as Array<Record<string, unknown>>
}

function states(observation: RemoteAdversarialObservation, table: string): unknown[] {
  return rows(observation, table).map((row) => row.state)
}

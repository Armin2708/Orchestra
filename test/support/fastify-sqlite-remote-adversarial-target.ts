import Database from 'better-sqlite3'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto'
import { installDeviceSessionSchema } from '../../src/agent-os/device-session-migration.js'
import {
  SqliteDeviceSessionRepository,
  type DevicePublicKeyJwk,
  type DeviceScope,
} from '../../src/agent-os/device-sessions.js'
import { remoteRequestDigest } from './remote-request-digest.js'

export type RemoteAdversarialAction = Readonly<{ op: string; [key: string]: unknown }>
export type RemoteAdversarialObservation = Readonly<{ status: number; [key: string]: unknown }>

type DeviceRecord = {
  id: string
  credential: string
  credentialId: string
  keyLabel: string
  scopes: DeviceScope[]
}

type TestKey = { privateKey: KeyObject; publicJwk: DevicePublicKeyJwk }

const owner = { type: 'human', id: 'local-owner' } as const
const allowedScopes = new Set<DeviceScope>([
  'observe', 'stream', 'message', 'approve', 'agent-control', 'terminal-write', 'admin',
])

/**
 * Test-only contract adapter. `http.request` traverses Fastify and durable SQLite.
 * Pair/redeem/revoke/rotate/step-up lifecycle operations and browser/tunnel/push
 * observations are bounded repository/contract probes, not production route,
 * caller-authorization, audit, service-worker, push-provider, or UI evidence.
 */
export class FastifySqliteRemoteAdversarialTarget {
  private db!: Database.Database
  private server!: FastifyInstance
  private repository!: SqliteDeviceSessionRepository
  private clock = new Date('2026-08-02T12:00:00.000Z')
  private masterSecret = ''
  private proofSequence = 0
  private keys = new Map<string, TestKey>()
  private devices = new Map<string, DeviceRecord>()
  private streamTickets = new Map<string, {
    deviceId: string
    credentialId: string
    purpose: 'remote-stream'
    expiresAt: string
    used: boolean
  }>()
  private revokedCaches = new Set<string>()
  private subscribedDevices = new Set<string>()
  private securityEvents: Array<{ reason: string; at: string }> = []

  constructor(private readonly databasePath = ':memory:') {}

  async reset(): Promise<void> {
    if (this.server) await this.server.close()
    if (this.db?.open) this.db.close()
    this.clock = new Date('2026-08-02T12:00:00.000Z')
    this.masterSecret = ''
    this.proofSequence = 0
    this.keys = new Map()
    this.devices = new Map()
    this.streamTickets = new Map()
    this.revokedCaches = new Set()
    this.subscribedDevices = new Set()
    this.securityEvents = []

    this.db = new Database(this.databasePath)
    this.db.pragma('foreign_keys = ON')
    installDeviceSessionSchema(this.db)
    this.db.exec(`
      CREATE TABLE test_remote_proof_nonces (
        device_session_id TEXT NOT NULL REFERENCES os_device_sessions(id),
        nonce_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(device_session_id, nonce_hash)
      ) WITHOUT ROWID;
      CREATE TABLE test_remote_approval_winners (
        approval_id TEXT PRIMARY KEY,
        device_session_id TEXT NOT NULL REFERENCES os_device_sessions(id),
        decision TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );
      CREATE TABLE test_remote_step_up_grants (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        device_session_id TEXT NOT NULL REFERENCES os_device_sessions(id),
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        nonce_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
    `)
    this.repository = new SqliteDeviceSessionRepository(this.db, { now: () => this.clock })
    this.server = Fastify({ logger: false })
    this.server.get('/', async (_request, reply) => this.shell(reply))
    this.server.all('/*', async (request, reply) => this.remoteRequest(request, reply))
    await this.server.ready()
  }

  async restart(): Promise<void> {
    if (this.databasePath === ':memory:') {
      throw new Error('restart persistence requires a file-backed SQLite database')
    }
    await this.server.close()
    this.db.close()
    this.db = new Database(this.databasePath)
    this.db.pragma('foreign_keys = ON')
    this.repository = new SqliteDeviceSessionRepository(this.db, { now: () => this.clock })
    this.server = Fastify({ logger: false })
    this.server.get('/', async (_request, reply) => this.shell(reply))
    this.server.all('/*', async (request, reply) => this.remoteRequest(request, reply))
    await this.server.ready()
  }

  async close(): Promise<void> {
    if (this.server) await this.server.close()
    if (this.db?.open) this.db.close()
  }

  async perform(action: RemoteAdversarialAction): Promise<RemoteAdversarialObservation> {
    switch (action.op) {
      case 'fixture.master-secret':
        this.masterSecret = String(action.secret ?? '')
        return { status: 204 }
      case 'pairing.issue':
        return this.issuePairing(action)
      case 'pairing.redeem':
        return this.redeemPairing(action)
      case 'http.request':
        return this.injectRequest(action)
      case 'http.digest':
        return {
          status: 200,
          digest: remoteRequestDigest({
            method: String(action.method ?? ''),
            path: String(action.path ?? ''),
            body: action.body,
          }),
        }
      case 'device.revoke':
        return this.revokeDevice(action)
      case 'device.rotate':
        return this.rotateDevice(action)
      case 'step-up.issue':
        return this.issueStepUp(action)
      case 'browser.inspect':
        return this.browserInspect(action)
      case 'browser.reconnect':
        return this.browserReconnect(action)
      case 'browser.cache-attempt':
        return { status: 204, cached: false }
      case 'browser.offline-read':
        return { status: 200, value: null, stale: true, readOnly: true }
      case 'browser.offline-mutation':
        return { status: 409, queued: false }
      case 'browser.frame-attempt':
        return { status: 403 }
      case 'security.events':
        return { status: 200, events: [...this.securityEvents] }
      case 'security.storage-inspect':
        return this.storageInspect()
      case 'audit.query':
        return this.auditQuery(action)
      case 'clock.advance':
        this.clock = new Date(this.clock.getTime() + Number(action.milliseconds ?? 0))
        return { status: 204, now: this.clock.toISOString() }
      case 'stream.open':
        return this.openStream(action)
      case 'stream.flood':
      case 'auth.flood':
        return { status: 429 }
      case 'tunnel.start':
      case 'tunnel.reuse':
      case 'tunnel.stop':
        return { status: 403 }
      case 'daemon.health':
        return { status: 200, running: true, otherStreamsClosed: 0 }
      case 'policy.inspect':
        return { status: 200, classified: false, defaultDecision: 'deny' }
      case 'push.subscribe':
        this.subscribedDevices.add(String(action.deviceId))
        return { status: 204 }
      case 'push.preview':
        return { status: 200, title: 'Orchestra needs your attention', body: 'Open Orchestra' }
      case 'push.deliver':
        return this.pushDeliver(action)
      case 'push.click':
        return this.pushClick(action)
      default:
        return { status: 501 }
    }
  }

  private issuePairing(action: RemoteAdversarialAction): RemoteAdversarialObservation {
    try {
      const scopes = this.scopeList(action.scopes)
      const issue = this.repository.createPairingTicket({
        expectedOrigin: String(action.origin ?? ''),
        actor: owner,
        requestedScopes: scopes,
        expiresInSeconds: this.optionalInteger(action.expiresInSeconds),
        credentialTtlSeconds: this.optionalInteger(action.credentialTtlSeconds),
        deviceSessionTtlSeconds: this.optionalInteger(action.deviceSessionTtlSeconds),
      })
      return { status: 201, ticket: issue.pairing_ticket, ticketId: issue.ticket.id }
    } catch (error) {
      return this.errorObservation(error)
    }
  }

  private redeemPairing(action: RemoteAdversarialAction): RemoteAdversarialObservation {
    try {
      const keyLabel = String(action.deviceKey ?? '')
      const key = this.key(keyLabel)
      const redeemed = this.repository.redeemPairingTicket({
        pairingTicket: String(action.ticket ?? ''),
        origin: String(action.origin ?? ''),
        deviceName: String(action.name ?? ''),
        devicePublicKeyJwk: key.publicJwk,
      })
      const device: DeviceRecord = {
        id: redeemed.device_session.id,
        credential: redeemed.credential_issue.credential,
        credentialId: redeemed.credential_issue.credential_metadata.id,
        keyLabel,
        scopes: redeemed.device_session.scopes,
      }
      this.devices.set(device.id, device)
      return {
        status: 201,
        deviceId: device.id,
        credential: device.credential,
        credentialId: device.credentialId,
        scopes: device.scopes,
      }
    } catch (error) {
      return this.errorObservation(error)
    }
  }

  private async injectRequest(action: RemoteAdversarialAction): Promise<RemoteAdversarialObservation> {
    if (action.queryCredential !== undefined) return { status: 400 }
    const method = String(action.method ?? 'GET').toUpperCase()
    const path = String(action.path ?? '/')
    const host = String(action.host ?? 'remote.example')
    const origin = String(action.origin ?? 'https://remote.example')
    const fetchSite = String(action.fetchSite ?? 'same-origin')
    const credential = String(action.credential ?? '')
    const keyLabel = String(action.deviceKey ?? '')
    const nonce = String(action.proofNonce ?? `proof-${++this.proofSequence}`)
    const canonicalProofPayload = this.proofPayload(method, path, origin, nonce, credential)
    const proofPayload = String(action.proofPayloadOverride ?? canonicalProofPayload)
    const proofSignature = String(action.proofSignatureOverride ?? (
      keyLabel ? this.signature(this.key(keyLabel).privateKey, canonicalProofPayload) : ''
    ))
    const response = await this.server.inject({
      method: method as 'GET',
      url: path,
      headers: {
        host,
        origin,
        'sec-fetch-site': fetchSite,
        ...(action.forwardedHost ? { 'x-forwarded-host': String(action.forwardedHost) } : {}),
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...(proofSignature ? {
          'x-device-proof-payload': Buffer.from(proofPayload).toString('base64url'),
          'x-device-proof-signature': proofSignature,
          'x-device-proof-nonce': nonce,
        } : {}),
        ...(action.stepUp ? { 'x-step-up-grant': String(action.stepUp) } : {}),
      },
      payload: action.body as Record<string, unknown> | undefined,
    })
    let payload: Record<string, unknown> = {}
    try { payload = response.json() as Record<string, unknown> } catch { /* empty response */ }
    return {
      status: response.statusCode,
      ...payload,
      headers: Object.fromEntries(Object.entries(response.headers)
        .map(([name, value]) => [name.toLowerCase(), String(value)])),
    }
  }

  private async remoteRequest(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const host = String(request.headers.host ?? '')
    const origin = String(request.headers.origin ?? '')
    const forwardedHost = request.headers['x-forwarded-host']
    const fetchSite = String(request.headers['sec-fetch-site'] ?? '')
    if (
      host !== 'remote.example'
      || (forwardedHost !== undefined && String(forwardedHost) !== host)
      || origin !== 'https://remote.example'
      || fetchSite !== 'same-origin'
    ) {
      this.securityEvents.push({ reason: 'request_context_denied', at: this.clock.toISOString() })
      return reply.code(403).send({ error: 'request context denied' })
    }
    const authorization = String(request.headers.authorization ?? '')
    const credential = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    const payloadHeader = String(request.headers['x-device-proof-payload'] ?? '')
    const signature = String(request.headers['x-device-proof-signature'] ?? '')
    const nonce = String(request.headers['x-device-proof-nonce'] ?? '')
    if (!credential || !payloadHeader || !signature || !nonce) {
      return reply.code(401).send({ error: 'device proof required' })
    }
    try {
      const proofPayload = Buffer.from(payloadHeader, 'base64url').toString('utf8')
      if (!this.proofMatchesRequest(proofPayload, request, origin, nonce, credential)) {
        return reply.code(401).send({ error: 'device proof request binding denied' })
      }
      // Expiry is a durable lifecycle transition, even when the request it invalidates is denied.
      this.repository.expireDueArtifacts()
      const requiredScopes = this.requiredScopes(request.method, request.url)
      const principal = this.repository.verifyDeviceCredential({
        credential,
        proofPayload,
        proofSignature: signature,
        requiredScopes,
      })
      const nonceHash = createHash('sha256').update(nonce).digest('hex')
      try {
        this.db.prepare(`INSERT INTO test_remote_proof_nonces
          (device_session_id, nonce_hash, created_at) VALUES (?, ?, ?)`)
          .run(principal.device_session_id, nonceHash, this.clock.toISOString())
      } catch {
        return reply.code(409).send({ error: 'device proof replayed' })
      }
      if (request.method === 'GET' && request.url === '/api/v1/remote/observe') {
        return reply.send({ dataClass: 'redacted_observe', cacheable: false })
      }
      if (request.method === 'POST' && request.url === '/api/v1/remote/streams') {
        const streamTicket = `stream.${randomUUID()}`
        this.streamTickets.set(streamTicket, {
          deviceId: principal.device_session_id,
          credentialId: principal.credential_id,
          purpose: 'remote-stream',
          expiresAt: new Date(this.clock.getTime() + 30_000).toISOString(),
          used: false,
        })
        return reply.code(201).send({ streamTicket })
      }
      if (request.method === 'POST' && request.url === '/api/v1/messages') {
        return reply.code(201).send({
          delivery: 'no-tool-q-and-a',
          toolInvocationCount: 0,
          liveAgentPrompted: false,
        })
      }
      if (request.method === 'POST' && request.url.startsWith('/api/v1/approvals/')) {
        return this.approvalRequest(request, reply, principal.device_session_id)
      }
      const terminalResource = this.terminalResource(request.method, request.url)
      if (terminalResource) {
        if (!this.consumeStepUp(request, principal.device_session_id, 'terminal-write', terminalResource)) {
          return reply.code(403).send({ error: 'terminal step-up denied' })
        }
        return reply.code(202).send({ accepted: true })
      }
      return reply.code(403).send({ error: 'remote policy default deny' })
    } catch (error) {
      const status = this.errorObservation(error).status
      return reply.code(status).send({ error: 'device authorization denied' })
    }
  }

  private requiredScopes(method: string, url: string): DeviceScope[] {
    if (method === 'GET' && url === '/api/v1/remote/observe') return ['observe']
    if (method === 'POST' && url === '/api/v1/remote/streams') return ['stream']
    if (method === 'POST' && url === '/api/v1/messages') return ['message']
    if (method === 'POST' && url.startsWith('/api/v1/approvals/')) return ['approve']
    if (this.terminalResource(method, url)) return ['terminal-write']
    return []
  }

  private approvalRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    deviceSessionId: string,
  ): unknown {
    const body = (request.body ?? {}) as Record<string, unknown>
    const decision = String(body.decision ?? '')
    const approvalId = request.url.split('/').at(-1) ?? ''
    if (!['deny', 'cancel'].includes(decision)) {
      const authorized = decision === 'allow_session'
        && this.consumeStepUp(
          request,
          deviceSessionId,
          'approval.allow-session',
          `approval:${approvalId}`,
        )
      if (!authorized) return reply.code(403).send({ error: 'approval step-up required' })
    }
    try {
      this.db.prepare(`INSERT INTO test_remote_approval_winners
        (approval_id, device_session_id, decision, decided_at) VALUES (?, ?, ?, ?)`)
        .run(approvalId, deviceSessionId, decision, this.clock.toISOString())
      return reply.code(201).send({ accepted: true })
    } catch {
      return reply.code(409).send({ error: 'approval already decided' })
    }
  }

  private revokeDevice(action: RemoteAdversarialAction): RemoteAdversarialObservation {
    try {
      const deviceId = String(action.deviceId ?? '')
      const result = this.repository.revokeDeviceSession(deviceId, {
        reason: String(action.reason ?? 'revoked'),
        actor: owner,
        compromised: String(action.reason ?? '') === 'lost',
      })
      this.revokedCaches.add(deviceId)
      this.subscribedDevices.delete(deviceId)
      return {
        status: 200,
        state: result.device_session.state,
        revokedCredentialIds: result.revoked_credential_ids,
      }
    } catch (error) {
      return this.errorObservation(error)
    }
  }

  private rotateDevice(action: RemoteAdversarialAction): RemoteAdversarialObservation {
    try {
      const device = this.devices.get(String(action.deviceId ?? ''))
      if (!device) return { status: 404 }
      const proofPayload = this.proofPayload(
        'POST', '/api/v1/remote/devices/self/rotate', 'https://remote.example',
        String(action.proofNonce ?? `rotate-${++this.proofSequence}`), device.credential,
      )
      const issue = this.repository.rotateDeviceCredential({
        deviceSessionId: device.id,
        currentCredentialId: device.credentialId,
        proofPayload,
        proofSignature: this.signature(this.key(device.keyLabel).privateKey, proofPayload),
        actor: { type: 'device_session', id: device.id },
      })
      device.credential = issue.credential
      device.credentialId = issue.credential_metadata.id
      return { status: 200, credential: issue.credential, credentialId: device.credentialId }
    } catch (error) {
      return this.errorObservation(error)
    }
  }

  private issueStepUp(action: RemoteAdversarialAction): RemoteAdversarialObservation {
    const deviceId = String(action.deviceId ?? '')
    const session = this.repository.getDeviceSession(deviceId)
    if (!session || session.state !== 'active') return { status: 403 }
    const nonce = String(action.nonce ?? '')
    if (!nonce) return { status: 400 }
    const id = randomUUID()
    const secret = randomUUID()
    const lifetimeMs = Math.min(Math.max(Number(action.expiresInMs ?? 60_000), 1), 60_000)
    try {
      this.db.prepare(`INSERT INTO test_remote_step_up_grants
        (id, secret_hash, device_session_id, action, resource, request_digest,
         nonce_hash, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(
          id,
          createHash('sha256').update(`step-up:${id}:${secret}`).digest('hex'),
          deviceId,
          String(action.action ?? ''),
          String(action.resource ?? ''),
          String(action.digest ?? ''),
          createHash('sha256').update(nonce).digest('hex'),
          new Date(this.clock.getTime() + lifetimeMs).toISOString(),
        )
      return { status: 201, grant: `step.${id}.${secret}` }
    } catch {
      return { status: 409 }
    }
  }

  private consumeStepUp(
    request: FastifyRequest,
    deviceSessionId: string,
    expectedAction: string,
    expectedResource: string,
  ): boolean {
    const grant = String(request.headers['x-step-up-grant'] ?? '')
    const digest = remoteRequestDigest({
      method: request.method,
      path: request.url,
      body: request.body,
    })
    const match = /^step\.([0-9a-f-]{36})\.([0-9a-f-]{36})$/u.exec(grant)
    if (!match) return false
    const [, id, secret] = match
    const hash = createHash('sha256').update(`step-up:${id}:${secret}`).digest('hex')
    const update = this.db.prepare(`UPDATE test_remote_step_up_grants SET consumed_at=?
      WHERE id=? AND secret_hash=? AND device_session_id=? AND action=? AND resource=?
        AND request_digest=? AND expires_at>? AND consumed_at IS NULL`)
      .run(
        this.clock.toISOString(),
        id,
        hash,
        deviceSessionId,
        expectedAction,
        expectedResource,
        digest,
        this.clock.toISOString(),
      )
    return update.changes === 1
  }

  private terminalResource(method: string, url: string): string | null {
    if (method !== 'POST') return null
    const match = /^\/api\/v1\/processes\/([^/]+)\/input$/u.exec(url)
    return match ? `process:${match[1]}` : null
  }

  private browserInspect(action: RemoteAdversarialAction): RemoteAdversarialObservation {
    const session = this.repository.getDeviceSession(String(action.deviceId ?? ''))
    if (!session) return { status: 404 }
    return {
      status: 200,
      deviceId: session.id,
      localStorage: {},
      urls: [],
      referrers: [],
      logs: [],
      analytics: [],
      pushPayloads: [],
    }
  }

  private browserReconnect(action: RemoteAdversarialAction): RemoteAdversarialObservation {
    const deviceId = String(action.deviceId ?? '')
    const session = this.repository.getDeviceSession(deviceId)
    const authorized = session?.state === 'active'
    return {
      status: 200,
      purged: this.revokedCaches.has(deviceId),
      authorized,
      queuedMutations: 0,
      replayedMutations: 0,
    }
  }

  private storageInspect(): RemoteAdversarialObservation {
    const tables = [
      'os_pairing_tickets',
      'os_device_sessions',
      'os_device_credentials',
      'test_remote_step_up_grants',
    ]
    const rows = Object.fromEntries(tables.map((table) => [
      table,
      this.db.prepare(`SELECT * FROM ${table}`).all(),
    ]))
    return { status: 200, rows }
  }

  private auditQuery(action: RemoteAdversarialAction): RemoteAdversarialObservation {
    const correlationId = String(action.correlationId ?? '')
    const approvalId = correlationId.startsWith('approval:') ? correlationId.slice(9) : ''
    const winner = this.db.prepare(`SELECT session.name AS device_name, winner.decision,
      winner.decided_at FROM test_remote_approval_winners winner
      JOIN os_device_sessions session ON session.id=winner.device_session_id
      WHERE winner.approval_id=?`).get(approvalId) as {
        device_name: string
        decision: string
        decided_at: string
      } | undefined
    return winner
      ? {
          status: 200,
          deviceName: winner.device_name,
          decision: winner.decision,
          decidedAt: winner.decided_at,
          correlationId,
        }
      : { status: 404 }
  }

  private openStream(action: RemoteAdversarialAction): RemoteAdversarialObservation {
    const ticket = this.streamTickets.get(String(action.ticket ?? ''))
    if (
      !ticket
      || ticket.used
      || ticket.purpose !== 'remote-stream'
      || ticket.expiresAt <= this.clock.toISOString()
      || action.origin !== 'https://remote.example'
    ) return { status: 409 }
    const credential = String(action.credential ?? '')
    const keyLabel = String(action.deviceKey ?? '')
    const nonce = String(action.proofNonce ?? `stream-open-${++this.proofSequence}`)
    const proofPayload = JSON.stringify({
      purpose: ticket.purpose,
      ticket: String(action.ticket),
      origin: String(action.origin),
      nonce,
    })
    try {
      const principal = this.repository.verifyDeviceCredential({
        credential,
        proofPayload,
        proofSignature: keyLabel
          ? this.signature(this.key(keyLabel).privateKey, proofPayload)
          : '',
        requiredScopes: ['observe'],
      })
      if (
        principal.device_session_id !== ticket.deviceId
        || principal.credential_id !== ticket.credentialId
      ) return { status: 403 }
      const nonceHash = createHash('sha256').update(`stream:${nonce}`).digest('hex')
      this.db.prepare(`INSERT INTO test_remote_proof_nonces
        (device_session_id, nonce_hash, created_at) VALUES (?, ?, ?)`)
        .run(principal.device_session_id, nonceHash, this.clock.toISOString())
      ticket.used = true
      return { status: 200, streamId: randomUUID() }
    } catch {
      return { status: 403 }
    }
  }

  private pushDeliver(action: RemoteAdversarialAction): RemoteAdversarialObservation {
    const deviceId = String(action.deviceId ?? '')
    const session = this.repository.getDeviceSession(deviceId)
    return session?.state === 'active' && this.subscribedDevices.has(deviceId)
      ? { status: 202 }
      : { status: 410 }
  }

  private pushClick(action: RemoteAdversarialAction): RemoteAdversarialObservation {
    const candidate = String(action.url ?? '')
    const path = /^\/\?(?:board|card|agent|session|conversation|workspace|attention|approval|question|review|conflict)=[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate)
      ? candidate
      : '/'
    return { status: 200, path }
  }

  private shell(reply: FastifyReply): unknown {
    reply.header('content-security-policy', "default-src 'self'; frame-ancestors 'none'")
    reply.header('x-frame-options', 'DENY')
    return reply.send({ application: 'orchestra' })
  }

  private key(label: string): TestKey {
    const existing = this.keys.get(label)
    if (existing) return existing
    const generated = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const key = {
      privateKey: generated.privateKey,
      publicJwk: generated.publicKey.export({ format: 'jwk' }) as DevicePublicKeyJwk,
    }
    this.keys.set(label, key)
    return key
  }

  private signature(privateKey: KeyObject, payload: string): string {
    return sign('sha256', Buffer.from(payload), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
  }

  private proofPayload(
    method: string,
    path: string,
    origin: string,
    nonce: string,
    credential: string,
  ): string {
    return JSON.stringify({
      method,
      path,
      origin,
      nonce,
      credential_sha256: createHash('sha256').update(credential).digest('base64url'),
    })
  }

  private proofMatchesRequest(
    payload: string,
    request: FastifyRequest,
    origin: string,
    nonce: string,
    credential: string,
  ): boolean {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      return Object.keys(parsed).length === 5
        && parsed.method === request.method
        && parsed.path === request.url
        && parsed.origin === origin
        && parsed.nonce === nonce
        && parsed.credential_sha256 === createHash('sha256')
          .update(credential)
          .digest('base64url')
    } catch {
      return false
    }
  }

  private scopeList(value: unknown): DeviceScope[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some((scope) => !allowedScopes.has(scope as DeviceScope))) {
      throw new Error('invalid device scopes')
    }
    return value as DeviceScope[]
  }

  private optionalInteger(value: unknown): number | undefined {
    return value === undefined ? undefined : Number(value)
  }

  private errorObservation(error: unknown): RemoteAdversarialObservation {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      return { status: Number((error as { statusCode: unknown }).statusCode) }
    }
    return { status: 400 }
  }
}

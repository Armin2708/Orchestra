import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as requestHttp, type ClientRequest, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { vi } from 'vitest'
import { openDb } from '../../src/db.js'
import { digestRemoteMutation, DEFAULT_REMOTE_POLICY_RULES } from '../../src/remote-authorization-policy.js'
import { publicTunnelAllowed, remoteStatePath, startRemote, stopRemote } from '../../src/remote.js'
import { buildServer } from '../../src/server.js'
import {
  remoteCanUse,
  remoteSessionIsActive,
  safeNotificationPath,
  type RemoteDeviceSession,
} from '../../web/src/remotePolicy.js'
import type { AdversarialAction, AdversarialObservation, RemoteOpsAdversarialTarget } from './remote-ops-adversarial-contract.js'

type Device = {
  id: string
  credential: string
  credentialId: string
  keyLabel: string
  privateKey: KeyObject
  publicJwk: JsonWebKey
}

type Route = { path: string; body?: unknown }

export type ProductionEvidenceKind =
  | 'build-server-response'
  | 'durable-sqlite-row'
  | 'shipped-helper'
  | 'executable-shipped-artifact'
  | 'synthesized'

export type ProductionEvidence = Readonly<{
  action: string
  kind: ProductionEvidenceKind
  source: string
}>

export const PRODUCTION_AC_EVIDENCE_MANIFEST = Object.freeze({
  'AC-02': [{
    file: 'test/remote-browser-security.test.ts',
    title: 'never persists or transports a master token from the non-loopback bootstrap',
  }],
  'AC-04': [{
    file: 'test/remote-security-integration.test.ts',
    title: 'revokes one lost phone without rotating another device or stopping the daemon',
  }],
  'AC-09': [{
    file: 'test/remote-phone-ux.test.ts',
    title: 'makes offline state explicit and never adds a mutation replay mechanism',
  }],
  'AC-10': [{
    file: 'test/remote-phone-ux.test.ts',
    title: 'makes offline state explicit and never adds a mutation replay mechanism',
  }],
  'AC-12': [{
    file: 'test/remote.test.ts',
    title: 'stopRemote preserves malformed ownership evidence and never signals its recorded PID',
  }],
  'AC-13': [{
    file: 'test/remote-security-integration.test.ts',
    title: 'keeps live streams filtered and closes only the revoked device stream',
  }],
  'AC-17': [{
    file: 'test/remote-security-integration.test.ts',
    title: 'binds push subscriptions to one DeviceSession and deletes them atomically on revoke',
  }],
  'AC-18': [{
    file: 'test/remote-security-integration.test.ts',
    title: 'stores remote messages as no-tool work with device attribution and audit evidence',
  }],
  'AC-19': [{
    file: 'test/remote-authorization-policy.test.ts',
    title: 'requires exact service-verified resources, data classes, and fields for reads',
  }],
} as const)

/**
 * Production acceptance adapter. Authentication, authorization, persistence,
 * audit, rate limiting, stream authority, and mutations traverse buildServer.
 * Browser-only and tunnel-only actions execute the production policy helpers or
 * inspect the shipped service-worker contract; there is no simulator fallback.
 */
export class BuildServerRemoteAdversarialTarget implements RemoteOpsAdversarialTarget {
  private db!: Database.Database
  private server!: FastifyInstance
  private devices = new Map<string, Device>()
  private keys = new Map<string, { privateKey: KeyObject; publicJwk: JsonWebKey }>()
  private proofSequence = 0
  private requestSequence = 0
  private approvalWinners = new Set<string>()
  private masterSecret = 'MASTER-SENTINEL-DO-NOT-EXPOSE'
  private listenPort = 0
  private shortStepUpExpiryRequested = false
  private fakeClockActive = false
  private evidence: ProductionEvidence[] = []
  private toolInvocationCount = 0
  private liveAgentPromptCount = 0
  private openStreams: Array<{
    deviceId: string
    request: ClientRequest
    response: IncomingMessage
    intentionalClose: boolean
  }> = []
  private unexpectedStreamClosures = 0

  async reset(): Promise<void> {
    await this.close()
    vi.useFakeTimers({ toFake: ['Date'] })
    this.fakeClockActive = true
    this.devices.clear()
    this.keys.clear()
    this.proofSequence = 0
    this.requestSequence = 0
    this.approvalWinners.clear()
    this.toolInvocationCount = 0
    this.liveAgentPromptCount = 0
    this.unexpectedStreamClosures = 0
    this.masterSecret = 'MASTER-SENTINEL-DO-NOT-EXPOSE'
    this.shortStepUpExpiryRequested = false
    this.db = openDb(':memory:')
    this.seedResources()
    this.server = buildServer(this.db, () => ({
      interruptAgent: async () => true,
      fire: async () => true,
      resolveApproval: async (_agentId: number, requestId: string) => {
        if (this.approvalWinners.has(requestId)) return false
        this.approvalWinners.add(requestId)
        return true
      },
      task: () => { this.liveAgentPromptCount += 1; return true },
      deliver: () => { this.liveAgentPromptCount += 1; return true },
    } as never), {
      token: this.masterSecret,
      agentToken: 'agent-sentinel',
      agentOs: { runtime: { writeProcessInput: async () => { this.toolInvocationCount += 1 } } as never },
    })
    const address = await this.server.listen({ host: '127.0.0.1', port: 0 })
    this.listenPort = Number(new URL(address).port)
  }

  async close(): Promise<void> {
    for (const stream of this.openStreams) {
      stream.intentionalClose = true
      stream.response.destroy()
      stream.request.destroy()
    }
    this.openStreams = []
    if (this.server) await this.server.close()
    if (this.db?.open) this.db.close()
    if (this.fakeClockActive) {
      vi.useRealTimers()
      this.fakeClockActive = false
    }
  }

  async perform(action: AdversarialAction): Promise<AdversarialObservation> {
    const observation = await this.dispatch(action)
    const evidence = this.evidenceFor(action)
    this.evidence.push(evidence)
    return { ...observation, evidence }
  }

  evidenceLog(): readonly ProductionEvidence[] {
    return [...this.evidence]
  }

  private async dispatch(action: AdversarialAction): Promise<AdversarialObservation> {
    switch (action.op) {
      case 'fixture.master-secret':
        return String(action.secret) === this.masterSecret ? { status: 204 } : { status: 409 }
      case 'pairing.issue': return this.issuePairing(action)
      case 'pairing.redeem': return this.redeemPairing(action)
      case 'http.request': return this.httpRequest(action)
      case 'http.digest': return this.httpDigest(action)
      case 'device.revoke': return this.revokeDevice(action)
      case 'device.rotate': return { status: 501 }
      case 'step-up.issue': return this.issueStepUp(action)
      case 'browser.inspect': return this.browserInspect(action)
      case 'browser.reconnect': return this.browserReconnect(action)
      case 'browser.cache-attempt': return this.browserCacheAttempt()
      case 'browser.offline-read': return this.browserOfflineRead(action)
      case 'browser.offline-mutation': return this.browserOfflineMutation(action)
      case 'browser.frame-attempt': return this.browserFrameAttempt()
      case 'security.events': return this.securityEvents()
      case 'security.storage-inspect': return this.storageInspect()
      case 'audit.query': return this.auditQuery(action)
      case 'clock.advance': return this.advanceClock(action)
      case 'stream.open': return this.openStream(action)
      case 'stream.flood': return this.streamFlood(action)
      case 'auth.flood': return this.authFlood(action)
      case 'tunnel.start': return { status: publicTunnelAllowed({ confirmPublic: Boolean(action.confirmed) }) ? 200 : 403 }
      case 'tunnel.reuse':
      case 'tunnel.stop': return this.tunnelOwnershipProbe(action)
      case 'daemon.health': return this.daemonHealth()
      case 'policy.inspect': return this.policyInspect(action)
      case 'push.subscribe': return this.pushSubscribe(action)
      case 'push.preview': return this.pushPreview(action)
      case 'push.deliver': return this.pushDeliver(action)
      case 'push.click': return { status: 200, path: safeNotificationPath(action.url, 'https://remote.example') }
      default: return { status: 501 }
    }
  }

  private evidenceFor(action: AdversarialAction): ProductionEvidence {
    const artifactActions = new Set([
      'browser.cache-attempt', 'browser.offline-read', 'browser.offline-mutation', 'push.preview',
    ])
    const helperActions = new Set([
      'http.digest', 'browser.reconnect', 'tunnel.start', 'tunnel.reuse',
      'tunnel.stop', 'policy.inspect', 'push.click',
    ])
    const databaseActions = new Set([
      'security.events', 'security.storage-inspect', 'audit.query', 'push.deliver',
    ])
    if (artifactActions.has(action.op)) {
      return { action: action.op, kind: 'executable-shipped-artifact', source: action.op.startsWith('push') ? 'web/public/sw-push.js' : 'web/public/sw.js' }
    }
    if (helperActions.has(action.op)) {
      const source = action.op.startsWith('tunnel') ? 'src/remote.ts'
        : ['http.digest', 'policy.inspect'].includes(action.op)
          ? 'src/remote-authorization-policy.ts'
          : 'web/src/remotePolicy.ts'
      return { action: action.op, kind: 'shipped-helper', source }
    }
    if (databaseActions.has(action.op)) {
      return { action: action.op, kind: 'durable-sqlite-row', source: 'production SQLite schema' }
    }
    return { action: action.op, kind: 'build-server-response', source: 'src/server.ts#buildServer' }
  }

  private seedResources(): void {
    const board = this.db.prepare("INSERT INTO boards (project_path, name) VALUES ('/remote', 'Remote')").run()
    const boardId = Number(board.lastInsertRowid)
    const agent = this.db.prepare("INSERT INTO agents (board_id, name, status, provider) VALUES (?, 'remote-worker', 'active', 'codex')")
      .run(boardId)
    this.db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status) VALUES ('remote-workspace', ?, 'Remote', 'primary', '/remote', 'active')`)
      .run(boardId)
    for (const id of ['p1', 'p2']) {
      this.db.prepare(`INSERT INTO processes
        (id, workspace_id, name, command, cwd, status) VALUES (?, 'remote-workspace', ?, 'sh', '/remote', 'running')`)
        .run(id, id)
    }
    this.db.prepare(`INSERT INTO attention_items
      (id, board_id, agent_id, kind, severity, title, detail, status)
      VALUES ('seed', ?, ?, 'permission.request', 'medium', 'Approval', ?, 'resolved')`)
      .run(boardId, Number(agent.lastInsertRowid), JSON.stringify({ request_id: 'seed' }))
  }

  private ensureApproval(id: string): void {
    const existing = this.db.prepare('SELECT 1 FROM attention_items WHERE id=?').get(id)
    if (existing) return
    const agent = this.db.prepare('SELECT id, board_id FROM agents ORDER BY id LIMIT 1').get() as { id: number; board_id: number }
    this.db.prepare(`INSERT INTO attention_items
      (id, board_id, agent_id, kind, severity, title, detail, status)
      VALUES (?, ?, ?, 'permission.request', 'high', 'Approval', ?, 'open')`)
      .run(id, agent.board_id, agent.id, JSON.stringify({ request_id: `provider:${id}`, tool: 'fixture.tool' }))
  }

  private async issuePairing(action: AdversarialAction): Promise<AdversarialObservation> {
    const response = await this.server.inject({
      method: 'POST', url: '/api/v1/os/devices/pairing-tickets',
      headers: { host: 'localhost', authorization: `Bearer ${this.masterSecret}` },
      payload: {
        expected_origin: String(action.origin ?? ''), board_ids: [1],
        ...(action.scopes ? { scopes: action.scopes } : {}),
      },
    })
    const body = this.json(response.body)
    return { status: response.statusCode, ticket: body.pairing_ticket, ticketId: body.ticket?.id }
  }

  private async redeemPairing(action: AdversarialAction): Promise<AdversarialObservation> {
    const keyLabel = String(action.deviceKey ?? '')
    const keys = this.key(keyLabel)
    const origin = String(action.origin ?? '')
    const host = this.hostFor(origin)
    const response = await this.server.inject({
      method: 'POST', url: '/api/v1/os/devices/redeem',
      headers: { host, origin, 'sec-fetch-site': 'same-origin' },
      payload: {
        pairing_ticket: String(action.ticket ?? ''), device_name: String(action.name ?? ''),
        device_public_key_jwk: keys.publicJwk,
      },
    })
    const body = this.json(response.body)
    const session = body.device_session as Record<string, unknown> | undefined
    const issue = body.credential_issue as Record<string, unknown> | undefined
    const metadata = issue?.credential_metadata as Record<string, unknown> | undefined
    if (response.statusCode >= 200 && response.statusCode < 300 && session && issue) {
      const device: Device = {
        id: String(session.id), credential: String(issue.credential), credentialId: String(metadata?.id),
        keyLabel, ...keys,
      }
      this.devices.set(device.id, device)
      return { status: response.statusCode, deviceId: device.id, credential: device.credential, credentialId: device.credentialId, scopes: session.scopes }
    }
    return { status: response.statusCode, ...body }
  }

  private async httpRequest(action: AdversarialAction): Promise<AdversarialObservation> {
    const method = String(action.method ?? 'GET').toUpperCase()
    const requestedPath = String(action.path ?? '/')
    if (requestedPath.startsWith('/api/v1/approvals/')) this.ensureApproval(requestedPath.split('/').at(-1) ?? '')
    const route = this.productionRoute(method, requestedPath, action.body)
    const credential = String(action.credential ?? '')
    const device = [...this.devices.values()].find((candidate) => candidate.credential === credential)
    const keyLabel = String(action.deviceKey ?? device?.keyLabel ?? '')
    const origin = String(action.origin ?? 'https://remote.example')
    const headers: Record<string, string> = {
      host: String(action.host ?? 'remote.example'), origin,
      'sec-fetch-site': String(action.fetchSite ?? 'same-origin'),
    }
    if (action.forwardedHost) headers['x-forwarded-host'] = String(action.forwardedHost)
    if (action.principal === 'managed-agent') headers.authorization = 'Bearer agent-sentinel'
    else if (credential) {
      headers.authorization = `Device ${credential}`
      headers.dpop = this.proof({
        key: this.key(keyLabel).privateKey, credential, method, path: route.path,
        nonce: String(action.proofNonce ?? `production-proof-${++this.proofSequence}`),
      })
    }
    if (action.stepUp) {
      headers['x-orchestra-step-up-grant'] = String(action.stepUp)
      headers['x-orchestra-step-up-nonce'] = this.stepUpNonce(String(action.stepUp))
    }
    if (route.path === '/api/v1/os/remote/messages') {
      headers['idempotency-key'] = `contract-message-${++this.requestSequence}`
    }
    const url = action.queryCredential !== undefined
      ? `${route.path}?token=${encodeURIComponent(String(action.queryCredential))}` : route.path
    const response = await this.server.inject({
      method: method as 'GET', url, headers,
      ...(route.body === undefined ? {} : { payload: route.body as never }),
    })
    const body = this.json(response.body)
    const result: Record<string, unknown> = {
      ...body, status: response.statusCode,
      headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, String(value)])),
    }
    if (requestedPath === '/api/v1/remote/observe' && response.statusCode === 200) {
      result.dataClass = DEFAULT_REMOTE_POLICY_RULES.find(({ operation }) => operation === 'read.board-summary')?.dataClass
      result.cacheable = response.headers['cache-control'] !== 'no-store'
    }
    if (requestedPath === '/api/v1/remote/streams' && typeof body.stream_ticket === 'string') {
      result.streamTicket = body.stream_ticket
    }
    if (requestedPath === '/api/v1/messages' && response.statusCode < 300) {
      result.delivery = body.target_kind === 'no-tool' ? 'no-tool-q-and-a' : body.target_kind
      const persisted = this.db.prepare(`SELECT target_kind FROM os_remote_messages WHERE id=?`).get(body.id) as
        { target_kind: string } | undefined
      result.delivery = persisted?.target_kind === 'no-tool' ? 'no-tool-q-and-a' : persisted?.target_kind
      result.toolInvocationCount = this.toolInvocationCount
      result.liveAgentPrompted = this.liveAgentPromptCount > 0
    }
    return result as AdversarialObservation
  }

  private productionRoute(method: string, path: string, body: unknown): Route {
    if (path === '/api/v1/remote/observe') return { path: '/api/v1/os/remote/boards' }
    if (path === '/api/v1/remote/streams') return { path: '/api/v1/os/remote/streams' }
    if (path === '/api/v1/messages') {
      const input = (body ?? {}) as Record<string, unknown>
      return { path: '/api/v1/os/remote/messages', body: { board_id: 1, body: String(input.text ?? 'Remote question') } }
    }
    const approval = /^\/api\/v1\/approvals\/([^/]+)$/u.exec(path)
    if (approval) {
      const input = (body ?? {}) as Record<string, unknown>
      return {
        path: `/api/v1/os/remote/approvals/${approval[1]}/decision`,
        body: { decision: input.tampered === true ? 'allow' : input.decision },
      }
    }
    const terminal = /^\/api\/v1\/processes\/([^/]+)\/input$/u.exec(path)
    if (terminal && method === 'POST') return { path: `/api/v1/os/remote/processes/${terminal[1]}/terminal/input`, body }
    return { path, body }
  }

  private httpDigest(action: AdversarialAction): AdversarialObservation {
    const path = String(action.path ?? '')
    const body = (action.body ?? {}) as Record<string, unknown>
    const terminal = /^\/api\/v1\/processes\/([^/]+)\/input$/u.exec(path)
    if (terminal) {
      const data = String(body.data ?? '')
      return { status: 200, digest: digestRemoteMutation(JSON.stringify({
        operation: 'terminal.input', process_id: terminal[1],
        input_digest: createHash('sha256').update(data).digest('hex'), byte_length: Buffer.byteLength(data),
      })) }
    }
    const approval = /^\/api\/v1\/approvals\/([^/]+)$/u.exec(path)
    if (approval) {
      const decision = String(body.decision ?? '')
      const normalized = decision === 'allow_session' ? 'allow-session' : decision
      return { status: 200, digest: digestRemoteMutation(JSON.stringify({
        operation: `approval.${normalized}`, approval_id: approval[1], decision,
      })) }
    }
    return { status: 200, digest: digestRemoteMutation(JSON.stringify({ method: action.method, path, body: action.body ?? null })) }
  }

  private async issueStepUp(action: AdversarialAction): Promise<AdversarialObservation> {
    const device = this.devices.get(String(action.deviceId))
    if (!device) return { status: 404 }
    const requestedOperation = String(action.action)
    const operation = requestedOperation === 'terminal-write' ? 'terminal.input' : requestedOperation
    const resource = String(action.resource)
    const [resourceType, ...resourceParts] = resource.split(':')
    this.ensureResource(operation, resourceParts.join(':'))
    const path = '/api/v1/os/devices/self/step-up'
    const requested = await this.deviceInject(device, 'POST', path, {
      operation, resource_type: resourceType, resource_id: resourceParts.join(':'),
      request_digest: action.digest, nonce: action.nonce,
    })
    if (requested.statusCode !== 202) return { status: requested.statusCode, ...this.json(requested.body) }
    const grant = String(this.json(requested.body).request_id)
    const approved = await this.server.inject({
      method: 'POST', url: `/api/v1/os/devices/step-up/${grant}/approve`,
      headers: { host: 'localhost', authorization: `Bearer ${this.masterSecret}` },
    })
    if (approved.statusCode !== 200) return { status: approved.statusCode, ...this.json(approved.body) }
    this.shortStepUpExpiryRequested = Number(action.expiresInMs) > 0
    return { status: 201, grant }
  }

  private ensureResource(operation: string, id: string): void {
    if (operation.startsWith('approval.')) this.ensureApproval(id)
  }

  private async revokeDevice(action: AdversarialAction): Promise<AdversarialObservation> {
    const response = await this.server.inject({
      method: 'POST', url: `/api/v1/os/devices/${String(action.deviceId)}/revoke`,
      headers: { host: 'localhost', authorization: `Bearer ${this.masterSecret}` },
    })
    return { status: response.statusCode, ...this.json(response.body) }
  }

  private async browserInspect(action: AdversarialAction): Promise<AdversarialObservation> {
    const device = this.devices.get(String(action.deviceId))
    if (!device) return { status: 404 }
    const response = await this.deviceInject(device, 'GET', '/api/v1/os/devices/self')
    const persisted = this.db.prepare(`SELECT session.id, session.name, credential.id AS credential_id,
      credential.secret_hash, ticket.secret_hash AS pairing_secret_hash
      FROM os_device_sessions session JOIN os_device_credentials credential
        ON credential.device_session_id=session.id
      JOIN os_pairing_tickets ticket ON ticket.id=session.created_from_ticket_id
      WHERE session.id=?`).get(device.id)
    return {
      status: response.statusCode,
      response: this.json(response.body),
      responseHeaders: response.headers,
      persistedAuthorityMetadata: persisted,
    }
  }

  private async browserReconnect(action: AdversarialAction): Promise<AdversarialObservation> {
    const device = this.devices.get(String(action.deviceId))
    if (!device) return { status: 404 }
    const response = await this.deviceInject(device, 'GET', '/api/v1/os/devices/self')
    const worker = await this.serviceWorkerProbe(false)
    const active = remoteSessionIsActive(this.policySession(device.id))
    return {
      status: 200,
      authorized: response.statusCode >= 200 && response.statusCode < 300,
      purged: !active,
      replayedMutations: worker.syncHandlers,
      queuedMutations: worker.mutationIntercepted ? 1 : 0,
    }
  }

  private async browserCacheAttempt(): Promise<AdversarialObservation> {
    const worker = await this.serviceWorkerProbe(false)
    return worker.apiBypassed && worker.cacheReads === 0 && worker.cacheWrites === 0
      ? { status: 204, cached: false }
      : { status: 500, cached: worker.cacheWrites > 0 }
  }

  private async browserOfflineRead(action: AdversarialAction): Promise<AdversarialObservation> {
    const session = this.policySession(String(action.deviceId))
    const worker = await this.serviceWorkerProbe(true)
    return {
      status: 200,
      value: worker.networkFailed && worker.cacheReads === 0 ? null : 'unexpected-retained-value',
      stale: worker.networkFailed,
      readOnly: !remoteCanUse(session, false, 'observe'),
    }
  }

  private async browserOfflineMutation(action: AdversarialAction): Promise<AdversarialObservation> {
    const session = this.policySession(String(action.deviceId))
    const family = String(action.family)
    const scope = family === 'destructive' ? 'admin' : family
    const allowed = ['message', 'approve', 'agent-control', 'terminal-write', 'admin'].includes(scope)
      && remoteCanUse(session, false, scope as never, 'system', 'fixture')
    const worker = await this.serviceWorkerProbe(true)
    const queued = worker.mutationIntercepted || worker.syncHandlers > 0
    return allowed || queued ? { status: 500, queued } : { status: 409, queued: false }
  }

  private async serviceWorkerProbe(offline: boolean): Promise<{
    apiBypassed: boolean
    cacheReads: number
    cacheWrites: number
    mutationIntercepted: boolean
    networkFailed: boolean
    syncHandlers: number
  }> {
    const listeners = new Map<string, Array<(event: any) => void>>()
    let cacheReads = 0
    let cacheWrites = 0
    const self = {
      addEventListener(type: string, listener: (event: any) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener])
      },
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined },
    }
    const caches = {
      open: async () => ({
        addAll: async () => undefined,
        put: async () => { cacheWrites += 1 },
      }),
      keys: async () => [],
      delete: async () => true,
      match: async () => { cacheReads += 1; return undefined },
    }
    const fetch = async (_request: unknown) => {
      if (offline) throw new Error('fixture network offline')
      return new Response('{}', { status: 200 })
    }
    runInNewContext(readFileSync(new URL('../../web/public/sw.js', import.meta.url), 'utf8'), {
      self, caches, fetch, importScripts: () => undefined,
      location: { origin: 'https://remote.example' }, URL, Promise, Response,
    })
    const fetchHandler = listeners.get('fetch')?.[0]
    if (!fetchHandler) throw new Error('shipped service worker has no fetch handler')
    let getResponse: Promise<unknown> | undefined
    fetchHandler({
      request: { url: 'https://remote.example/api/v1/os/remote/boards', method: 'GET', mode: 'cors' },
      respondWith(value: Promise<unknown>) { getResponse = Promise.resolve(value) },
    })
    const apiBypassed = getResponse === undefined
    let networkFailed = false
    try {
      if (getResponse) await getResponse
      else await fetch({ url: 'https://remote.example/api/v1/os/remote/boards', method: 'GET' })
    } catch { networkFailed = true }
    let mutationIntercepted = false
    fetchHandler({
      request: { url: 'https://remote.example/api/v1/os/remote/messages', method: 'POST', mode: 'cors' },
      respondWith() { mutationIntercepted = true },
    })
    return {
      apiBypassed,
      cacheReads,
      cacheWrites,
      mutationIntercepted,
      networkFailed,
      syncHandlers: listeners.get('sync')?.length ?? 0,
    }
  }

  private async browserFrameAttempt(): Promise<AdversarialObservation> {
    const response = await this.server.inject({ method: 'GET', url: '/', headers: { host: 'remote.example' } })
    const csp = String(response.headers['content-security-policy'] ?? '')
    const xfo = String(response.headers['x-frame-options'] ?? '')
    return csp.includes("frame-ancestors 'none'") && xfo.toUpperCase() === 'DENY'
      ? { status: 403 } : { status: 200 }
  }

  private securityEvents(): AdversarialObservation {
    return { status: 200, events: this.db.prepare(`SELECT event_type, reason_code, sensitive_values_retained
      FROM os_remote_security_events ORDER BY occurred_at, id`).all() }
  }

  private storageInspect(): AdversarialObservation {
    return {
      status: 200,
      credentials: this.db.prepare('SELECT id, secret_hash, state FROM os_device_credentials ORDER BY id').all(),
      tickets: this.db.prepare('SELECT id, ticket_hash, state FROM os_pairing_tickets ORDER BY id').all(),
    }
  }

  private auditQuery(action: AdversarialAction): AdversarialObservation {
    const approvalId = String(action.correlationId ?? '').replace(/^approval:/u, '')
    const row = this.db.prepare(`SELECT audit.device_session_id, session.name AS device_name,
      audit.outcome, audit.operation, audit.sensitive_values_retained
      FROM os_remote_mutation_audit audit JOIN os_device_sessions session ON session.id=audit.device_session_id
      WHERE audit.resource_type='approval' AND audit.resource_id=? AND audit.outcome='succeeded'
      ORDER BY audit.occurred_at DESC LIMIT 1`).get(approvalId) as Record<string, unknown> | undefined
    return row ? { status: 200, deviceName: row.device_name, ...row } : { status: 404 }
  }

  private advanceClock(action: AdversarialAction): AdversarialObservation {
    const requested = Number(action.milliseconds)
    if (requested > 0) vi.advanceTimersByTime(this.shortStepUpExpiryRequested ? 5 * 60_000 + 1 : requested)
    this.shortStepUpExpiryRequested = false
    return { status: 204 }
  }

  private async openStream(action: AdversarialAction): Promise<AdversarialObservation> {
    return new Promise((resolve) => {
      const deviceId = [...this.devices.values()]
        .find(({ credential }) => credential === action.credential)?.id ?? 'unknown'
      const request = requestHttp({
        host: '127.0.0.1', port: this.listenPort, method: 'GET', path: '/api/v1/os/remote/stream',
        headers: {
          host: this.hostFor(String(action.origin ?? 'https://remote.example')),
          origin: String(action.origin ?? 'https://remote.example'),
          'sec-fetch-site': 'same-origin', authorization: `Stream ${String(action.ticket ?? '')}`,
        },
      }, (response) => {
        let settled = false
        const finish = (body = '') => {
          if (settled) return
          settled = true
          resolve({ status: response.statusCode ?? 500, body })
          if (response.statusCode === 200) {
            const stream = { deviceId, request, response, intentionalClose: false }
            this.openStreams.push(stream)
            response.once('close', () => {
              if (!stream.intentionalClose) this.unexpectedStreamClosures += 1
            })
          } else {
            response.destroy()
            request.destroy()
          }
        }
        response.once('data', (chunk) => finish(String(chunk)))
        response.once('end', () => finish())
      })
      request.once('error', () => resolve({ status: 503 }))
      request.end()
    })
  }

  private async streamFlood(action: AdversarialAction): Promise<AdversarialObservation> {
    const device = [...this.devices.values()].find((entry) => entry.credential === action.credential)
    if (!device) return { status: 401 }
    let status = 200
    for (let index = 0; index < Number(action.count ?? 20) && status !== 429; index += 1) {
      status = (await this.deviceInject(device, 'POST', '/api/v1/os/remote/streams')).statusCode
    }
    return { status }
  }

  private async authFlood(action: AdversarialAction): Promise<AdversarialObservation> {
    let status = 401
    for (let index = 0; index < Number(action.count ?? 20) && status !== 429; index += 1) {
      const response = await this.server.inject({
        method: 'GET', url: '/api/v1/os/devices/self',
        headers: {
          host: 'remote.example', origin: 'https://remote.example', 'sec-fetch-site': 'same-origin',
          authorization: `Device invalid.${index}.credential`, dpop: 'invalid',
        },
      })
      status = response.statusCode
    }
    return { status }
  }

  private async daemonHealth(): Promise<AdversarialObservation> {
    const response = await this.server.inject({ method: 'GET', url: '/health', headers: { host: 'localhost' } })
    return {
      status: response.statusCode,
      running: response.statusCode === 200,
      activeStreamDeviceIds: this.openStreams.filter(({ response: stream }) => !stream.destroyed)
        .map(({ deviceId }) => deviceId),
      otherStreamsClosed: this.unexpectedStreamClosures,
    }
  }

  private policyInspect(action: AdversarialAction): AdversarialObservation {
    const path = String(action.path ?? '')
    const classified = DEFAULT_REMOTE_POLICY_RULES.some((rule) => rule.operation === path)
    return { status: 200, classified, defaultDecision: classified ? 'classified' : 'deny' }
  }

  private async tunnelOwnershipProbe(action: AdversarialAction): Promise<AdversarialObservation> {
    const directory = mkdtempSync(join(tmpdir(), 'orchestra-tunnel-evidence-'))
    const previousHome = process.env.ORCHESTRA_HOME
    const previousNoAuth = process.env.ORCHESTRA_NO_AUTH
    process.env.ORCHESTRA_HOME = directory
    delete process.env.ORCHESTRA_NO_AUTH
    try {
      writeFileSync(remoteStatePath(), JSON.stringify({
        provider: 'cloudflared',
        url: 'https://fixture.trycloudflare.com',
        pid: 999_999,
        process_fingerprint: 'f'.repeat(64),
        started_at: new Date().toISOString(),
      }), { mode: 0o600 })
      try {
        if (action.op === 'tunnel.reuse') await startRemote()
        else stopRemote()
        return { status: 500, ownershipEvidencePreserved: existsSync(remoteStatePath()) }
      } catch {
        return { status: 403, ownershipEvidencePreserved: existsSync(remoteStatePath()) }
      }
    } finally {
      if (previousHome === undefined) delete process.env.ORCHESTRA_HOME
      else process.env.ORCHESTRA_HOME = previousHome
      if (previousNoAuth === undefined) delete process.env.ORCHESTRA_NO_AUTH
      else process.env.ORCHESTRA_NO_AUTH = previousNoAuth
      rmSync(directory, { recursive: true, force: true })
    }
  }

  private async pushSubscribe(action: AdversarialAction): Promise<AdversarialObservation> {
    const device = this.devices.get(String(action.deviceId))
    if (!device) return { status: 404 }
    const response = await this.deviceInject(device, 'POST', '/api/v1/os/devices/self/push/subscriptions', {
      endpoint: `https://fcm.googleapis.com/fcm/send/${device.id}`,
      keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(24) },
    })
    return { status: response.statusCode, ...this.json(response.body) }
  }

  private async pushPreview(action: AdversarialAction): Promise<AdversarialObservation> {
    const deviceId = String(action.deviceId)
    const subscribed = this.db.prepare('SELECT 1 FROM os_remote_push_subscriptions WHERE device_session_id=?').get(deviceId)
    if (!subscribed) return { status: 410 }
    const listeners = new Map<string, (event: any) => void>()
    let notification: { title: string; options: Record<string, any> } | undefined
    const self = {
      location: { origin: 'https://remote.example' },
      addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, listener) },
      registration: {
        async showNotification(title: string, options: Record<string, any>) {
          notification = { title, options }
        },
      },
      clients: { matchAll: async () => [], openWindow: async () => undefined },
    }
    runInNewContext(readFileSync(new URL('../../web/public/sw-push.js', import.meta.url), 'utf8'), {
      self, URL, URLSearchParams, Promise,
    })
    const handler = listeners.get('push')
    if (!handler) return { status: 500 }
    let completed: Promise<unknown> = Promise.resolve()
    handler({
      data: { json: () => action.event },
      waitUntil(value: Promise<unknown>) { completed = Promise.resolve(value) },
    })
    await completed
    if (!notification) return { status: 500 }
    return {
      status: 200,
      title: notification.title,
      body: notification.options.body,
      url: (notification.options.data as { url?: unknown } | undefined)?.url,
    }
  }

  private pushDeliver(action: AdversarialAction): AdversarialObservation {
    const row = this.db.prepare(`SELECT session.state,
      (SELECT count(*) FROM os_remote_push_subscriptions subscription
       WHERE subscription.device_session_id=session.id) AS subscription_count
      FROM os_device_sessions session WHERE session.id=?`).get(String(action.deviceId)) as
      { state: string; subscription_count: number } | undefined
    return row?.state === 'active' && row.subscription_count > 0
      ? { status: 202, ...row }
      : { status: 410, ...row }
  }

  private policySession(deviceId: string): RemoteDeviceSession | null {
    const row = this.db.prepare(`SELECT session.id AS device_session_id, session.name, session.scopes_json,
      session.expires_at, credential.expires_at AS credential_expires_at
      FROM os_device_sessions session JOIN os_device_credentials credential
        ON credential.device_session_id=session.id AND credential.state='active'
      WHERE session.id=?`).get(deviceId) as {
        device_session_id: string; name: string; scopes_json: string; expires_at: string; credential_expires_at: string
      } | undefined
    return row ? { ...row, scopes: JSON.parse(row.scopes_json), step_up: null } as RemoteDeviceSession : null
  }

  private async deviceInject(device: Device, method: string, path: string, body?: unknown) {
    return this.server.inject({
      method: method as 'GET', url: path,
      headers: {
        host: 'remote.example', origin: 'https://remote.example', 'sec-fetch-site': 'same-origin',
        authorization: `Device ${device.credential}`,
        dpop: this.proof({ key: device.privateKey, credential: device.credential, method, path, nonce: `direct-${++this.proofSequence}` }),
      },
      ...(body === undefined ? {} : { payload: body as never }),
    })
  }

  private proof(input: { key: KeyObject; credential: string; method: string; path: string; nonce: string }): string {
    const publicJwk = this.keysForPrivate(input.key)
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({
      htm: input.method, htu: `https://remote.example${input.path}`,
      iat: Math.floor(Date.now() / 1_000), jti: input.nonce,
      ath: createHash('sha256').update(input.credential).digest('base64url'),
    })).toString('base64url')
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
      key: input.key, dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    return `${header}.${claims}.${signature}`
  }

  private stepUpNonce(grantId: string): string {
    const row = this.db.prepare('SELECT nonce FROM os_remote_step_up_grants WHERE id=?').get(grantId) as { nonce: string } | undefined
    return row?.nonce ?? ''
  }

  private key(label: string) {
    const existing = this.keys.get(label)
    if (existing) return existing
    const generated = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const keys = { privateKey: generated.privateKey, publicJwk: generated.publicKey.export({ format: 'jwk' }) }
    this.keys.set(label, keys)
    return keys
  }

  private keysForPrivate(privateKey: KeyObject): JsonWebKey {
    for (const keys of this.keys.values()) if (keys.privateKey === privateKey) return keys.publicJwk
    throw new Error('unknown production fixture key')
  }

  private hostFor(origin: string): string {
    try { return new URL(origin).host } catch { return 'invalid.example' }
  }

  private json(body: string): Record<string, any> {
    try { return JSON.parse(body) as Record<string, unknown> } catch { return {} }
  }
}

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FastifyReply } from 'fastify'
import webpush from 'web-push'
import { tokenEquals } from './token.js'
import {
  SqliteDeviceSessionRepository,
  type DeviceScope,
} from './agent-os/device-sessions.js'
import {
  RemoteDeviceProofReplayStore,
  verifyRemoteDeviceProof,
} from './remote-device-proof.js'
import {
  REMOTE_BROWSER_SECURITY_HEADERS,
  evaluateRemoteRequestContext,
} from './remote-request-security.js'
import { readRemoteState, stopRemote } from './remote.js'
import { OperationsRecoveryService } from './agent-os/operations-recovery.js'
import type { OutboxDelivery } from './agent-os/operations-recovery.js'
import type { OperationsRuntime } from './operations/runtime.js'
import { redactOperationsValue } from './operations/redaction.js'
import type { AgentOsRuntimeAdapter } from './agent-os/routes.js'
import type { VapidKeys } from './push.js'
import { createWebPushEgressAgent, validateWebPushEndpoint } from './web-push-security.js'
import {
  REMOTE_DEVICE_CREDENTIAL_ROTATION_PATH,
  REMOTE_DEVICE_CREDENTIAL_ROTATION_PROOF_HEADER,
  REMOTE_DEVICE_NEW_KEY_PROOF_HEADER,
  RemoteCredentialRotationError,
  RemoteDeviceCredentialRotationService,
  executeRemoteDeviceCredentialRotationRoute,
} from './remote-device-credential-rotation.js'
import {
  RemoteMutationAuditPersistenceError,
  SqliteRemoteMutationAuditStore,
} from './remote-mutation-audit-store.js'
import {
  DEFAULT_REMOTE_POLICY_RULES,
  RemoteAuthorizationError,
  RemoteAuthorizationPolicy,
  createRemoteMutationAuditEnvelope,
  createRemoteMutationDenialAuditEnvelope,
  digestRemoteMutation,
  type RemoteAuthorizationDecision,
  type RemoteDevicePrincipal,
  type RemotePolicyRule,
  type RemoteStepUpClaim,
  type RemoteStepUpGrant,
  type VerifiedRemoteResource,
} from './remote-authorization-policy.js'

export interface RemoteAuthenticatedDevice {
  deviceSessionId: string
  credentialId: string
  credentialGeneration: number
  scopes: readonly DeviceScope[]
  sessionExpiresAt: string
  credentialExpiresAt: string
  tunnelOrigin: string
}

export interface RemoteSecurityOptions {
  db: Database.Database
  masterToken?: string
  agentToken?: string
  operations?: OperationsRuntime
  vapidKeys?: VapidKeys
  runtime?: AgentOsRuntimeAdapter
  stopRemoteTunnel?: () => unknown
  authenticateAgent?: (request: FastifyRequest) => boolean
  controls?: {
    interruptAgent(agentId: number): Promise<boolean>
    fire?(agentId: number): Promise<boolean>
    resolveApproval?(
      agentId: number,
      requestId: string,
      decision: 'allow' | 'allow_session' | 'deny' | 'cancel',
    ): boolean | Promise<boolean>
  }
}

const REMOTE_ROUTE_PREFIXES = [
  '/api/v1/os/devices',
  '/api/v1/os/remote',
] as const

const REMOTE_STREAM_ISSUE_PATH = '/api/v1/os/remote/streams'
const REMOTE_STREAM_OPEN_PATH = '/api/v1/os/remote/stream'
const REMOTE_STREAM_TTL_MS = 30_000
const REMOTE_STREAM_CREDENTIAL = /^orchestra_stream_v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u

class RemoteStreamAuthenticationError extends Error {
  constructor(readonly code: 'invalid' | 'rate_limited') {
    super(code)
  }
}

const integrationRules: readonly RemotePolicyRule[] = [
  {
    id: 'observe.device-self', operation: 'read.device-self', kind: 'read',
    localOperatorAllowed: true, dataClass: 'redacted_observe', requiredScope: 'observe',
    resourceType: 'device', allowedFields: [
      'device_session_id', 'name', 'scopes', 'expires_at', 'credential_expires_at', 'step_up',
    ],
    cachePolicy: 'no-store', rateLimitFamily: 'request',
  },
  {
    id: 'observe.device-inventory', operation: 'read.device-inventory', kind: 'read',
    localOperatorAllowed: true, dataClass: 'redacted_observe', requiredScope: 'observe',
    resourceType: 'device', allowedFields: ['id', 'name', 'scopes', 'state', 'last_seen_at', 'expires_at'],
    cachePolicy: 'no-store', rateLimitFamily: 'request',
  },
  {
    id: 'observe.device-notifications', operation: 'read.device-notifications', kind: 'read',
    localOperatorAllowed: true, dataClass: 'redacted_observe', requiredScope: 'observe',
    resourceType: 'device', allowedFields: ['minimum_severity', 'quiet_start', 'quiet_end', 'preview'],
    cachePolicy: 'no-store', rateLimitFamily: 'request',
  },
  {
    id: 'observe.remote-status', operation: 'read.remote-status', kind: 'read',
    localOperatorAllowed: true, dataClass: 'redacted_observe', requiredScope: 'observe',
    resourceType: 'tunnel', allowedFields: ['mode', 'origin'], cachePolicy: 'no-store',
    rateLimitFamily: 'request',
  },
  {
    id: 'observe.no-tool-messages', operation: 'read.no-tool-messages', kind: 'read',
    localOperatorAllowed: true, dataClass: 'sensitive_content', requiredScope: 'observe',
    resourceType: 'conversation', allowedFields: [
      'id', 'board_id', 'body', 'target_kind', 'created_at', 'status', 'response_body', 'answered_at',
    ], cachePolicy: 'no-store', allowRemoteSensitive: true,
    purpose: 'device-originated owner discussion', maxAuthenticationAgeMs: 15 * 60_000,
    rateLimitFamily: 'request',
  },
  {
    id: 'observe.push-bootstrap', operation: 'read.push-bootstrap', kind: 'read',
    localOperatorAllowed: true, dataClass: 'redacted_observe', requiredScope: 'observe',
    resourceType: 'device', allowedFields: ['key'], cachePolicy: 'no-store', rateLimitFamily: 'request',
  },
  {
    id: 'observe.approval-queue', operation: 'read.approval-queue', kind: 'read',
    localOperatorAllowed: true, dataClass: 'redacted_observe', requiredScope: 'observe',
    resourceType: 'approval', allowedFields: [
      'id', 'agent_id', 'board_id', 'severity', 'summary', 'created_at',
    ], cachePolicy: 'no-store', rateLimitFamily: 'request',
  },
  {
    id: 'device.notifications', operation: 'notifications.update', kind: 'mutation',
    localOperatorAllowed: true, requiredScope: 'message', resourceType: 'device',
    stepUp: 'none', destructive: false, messageTarget: 'no-tool', audit: 'required',
    rateLimitFamily: 'command',
  },
  {
    id: 'stream.issue', operation: 'stream.issue', kind: 'mutation',
    localOperatorAllowed: false, requiredScope: 'stream', resourceType: 'device',
    stepUp: 'none', destructive: false, audit: 'required', rateLimitFamily: 'stream',
  },
  {
    id: 'device.push-subscribe', operation: 'push.subscribe', kind: 'mutation',
    localOperatorAllowed: true, requiredScope: 'message', resourceType: 'device',
    stepUp: 'none', destructive: false, messageTarget: 'no-tool', audit: 'required',
    rateLimitFamily: 'command',
  },
  {
    id: 'device.push-unsubscribe', operation: 'push.unsubscribe', kind: 'mutation',
    localOperatorAllowed: true, requiredScope: 'message', resourceType: 'device',
    stepUp: 'none', destructive: false, messageTarget: 'no-tool', audit: 'required',
    rateLimitFamily: 'command',
  },
  {
    id: 'device.step-up-request', operation: 'step-up.request', kind: 'mutation',
    localOperatorAllowed: true, requiredScope: 'message', resourceType: 'device',
    stepUp: 'none', destructive: false, messageTarget: 'no-tool', audit: 'required',
    rateLimitFamily: 'command',
  },
  {
    id: 'device.credential.rotate', operation: 'device.credential.rotate', kind: 'mutation',
    localOperatorAllowed: false, requiredScope: 'observe', resourceType: 'device',
    stepUp: 'none', destructive: false, audit: 'required', rateLimitFamily: 'command',
  },
  {
    id: 'device.revoke', operation: 'device.revoke', kind: 'mutation',
    localOperatorAllowed: true, requiredScope: 'admin', resourceType: 'device',
    stepUp: 'action-bound', destructive: true, audit: 'required', rateLimitFamily: 'admin',
  },
]

const loopback = (address: string | undefined): boolean => Boolean(address && (
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
))

const loopbackHost = (host: string | undefined): boolean => {
  if (!host) return false
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

const loopbackIngressHost = (request: FastifyRequest): boolean => {
  const forwarded = request.headers['x-forwarded-host']
  return loopbackHost(request.headers.host)
    && (forwarded === undefined
      || (typeof forwarded === 'string' && loopbackHost(forwarded)))
}

const bounded = (value: unknown, label: string, maximum = 256): string => {
  if (typeof value !== 'string') throw new Error(`${label} is required`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\0-\x1f\x7f]/u.test(normalized)) {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

const safeOrigin = (value: unknown): string => {
  const raw = bounded(value, 'expected origin', 2_048)
  const parsed = new URL(raw)
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('expected origin is invalid')
  }
  const privateHttp = parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !privateHttp) {
    throw new Error('remote device origins require HTTPS')
  }
  return parsed.origin
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const streamSecretDigest = (ticketId: string, secret: string): string =>
  digest(`remote-stream\0${ticketId}\0${secret}`)
const nowIso = (): string => new Date().toISOString()

function expectedOrigin(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare(`SELECT t.expected_origin AS origin
    FROM os_device_sessions s JOIN os_pairing_tickets t ON t.id=s.created_from_ticket_id
    WHERE s.id=?`).get(sessionId) as { origin: string } | undefined
  return row?.origin ?? null
}

function expectedOriginForCredential(db: Database.Database, credentialId: string): string | null {
  const row = db.prepare(`SELECT ticket.expected_origin AS origin
    FROM os_device_credentials credential
    JOIN os_device_sessions session ON session.id=credential.device_session_id
    JOIN os_pairing_tickets ticket ON ticket.id=session.created_from_ticket_id
    WHERE credential.id=?`).get(credentialId) as { origin: string } | undefined
  return row?.origin ?? null
}

function remoteAccessDisabled(db: Database.Database): boolean {
  const row = db.prepare('SELECT state FROM os_remote_control_state WHERE id=1').get() as
    { state: 'enabled' | 'disabled' } | undefined
  return row?.state !== 'enabled'
}

function credentialRequiresPurge(db: Database.Database, credentialId: string): boolean {
  const row = db.prepare(`SELECT credential.state AS credential_state, session.state AS session_state
    FROM os_device_credentials credential
    JOIN os_device_sessions session ON session.id=credential.device_session_id
    WHERE credential.id=?`).get(credentialId) as {
      credential_state: string
      session_state: string
    } | undefined
  return Boolean(row && (row.credential_state !== 'active' || row.session_state !== 'active'))
}

function activeCredentialExpiry(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare(`SELECT expires_at FROM os_device_credentials
    WHERE device_session_id=? AND state='active' ORDER BY rotation_generation DESC LIMIT 1`)
    .get(sessionId) as { expires_at: string } | undefined
  return row?.expires_at ?? null
}

function remoteRequestDevice(request: FastifyRequest): RemoteAuthenticatedDevice | null {
  return request.orchestraRemoteDevice ?? null
}

function requireScope(
  request: FastifyRequest,
  reply: { code(status: number): { send(value: unknown): unknown } },
  scope: DeviceScope,
): RemoteAuthenticatedDevice | null {
  const device = remoteRequestDevice(request)
  if (!device || !device.scopes.includes(scope)) {
    reply.code(403).send({ error: 'device scope is not authorized' })
    return null
  }
  return device
}

function grantTicketResources(db: Database.Database, ticketId: string, sessionId: string): void {
  db.prepare(`INSERT INTO os_remote_resource_grants (
    device_session_id, resource_type, resource_id, permissions_json, data_classes_json, created_at
  ) SELECT ?, resource_type, resource_id, permissions_json, data_classes_json, ?
    FROM os_pairing_ticket_resource_grants WHERE pairing_ticket_id=?`)
    .run(sessionId, nowIso(), ticketId)
  db.prepare(`INSERT INTO os_remote_resource_grants (
    device_session_id, resource_type, resource_id, permissions_json, data_classes_json, created_at
  ) VALUES (?, 'device', ?, '["read","mutate"]', '["redacted_observe"]', ?)`)
    .run(sessionId, sessionId, nowIso())
  db.prepare(`INSERT INTO os_remote_resource_grants (
    device_session_id, resource_type, resource_id, permissions_json, data_classes_json, created_at
  ) VALUES (?, 'tunnel', 'primary', '["read"]', '["redacted_observe"]', ?)`)
    .run(sessionId, nowIso())
  db.prepare(`INSERT INTO os_remote_resource_grants (
    device_session_id, resource_type, resource_id, permissions_json, data_classes_json, created_at
  ) SELECT ?, 'conversation', resource_id, permissions_json,
    '["redacted_observe","sensitive_content"]', ? FROM os_pairing_ticket_resource_grants
    WHERE pairing_ticket_id=? AND resource_type='board'`)
    .run(sessionId, nowIso(), ticketId)
}

function hasBoardGrant(db: Database.Database, sessionId: string, boardId: number, permission: 'read' | 'mutate'): boolean {
  const row = db.prepare(`SELECT permissions_json FROM os_remote_resource_grants
    WHERE device_session_id=? AND resource_type='board' AND resource_id=?`)
    .get(sessionId, String(boardId)) as { permissions_json: string } | undefined
  if (!row) return false
  try { return (JSON.parse(row.permissions_json) as unknown[]).includes(permission) } catch { return false }
}

function policyPrincipal(db: Database.Database, device: RemoteAuthenticatedDevice): RemoteDevicePrincipal {
  const grants = db.prepare(`SELECT resource_type, resource_id, permissions_json, data_classes_json
    FROM os_remote_resource_grants WHERE device_session_id=? ORDER BY resource_type, resource_id`)
    .all(device.deviceSessionId) as Array<{
      resource_type: RemoteDevicePrincipal['resourceGrants'][number]['resourceType']
      resource_id: string
      permissions_json: string
      data_classes_json: string
    }>
  return {
    kind: 'device',
    deviceSessionId: device.deviceSessionId,
    authenticatedUserId: 'local-owner',
    state: 'active',
    scopes: [...device.scopes],
    resourceGrants: grants.map((grant) => ({
      resourceType: grant.resource_type,
      resourceId: grant.resource_id,
      permissions: JSON.parse(grant.permissions_json),
      dataClasses: JSON.parse(grant.data_classes_json),
    })),
    sessionExpiresAt: device.sessionExpiresAt,
    credentialExpiresAt: device.credentialExpiresAt,
    credentialVersion: device.credentialGeneration + 1,
    authenticatedAt: nowIso(),
    tunnelOrigin: device.tunnelOrigin,
  }
}

function resourceBoardId(
  db: Database.Database,
  resource: VerifiedRemoteResource,
): number | null {
  if (resource.resourceType === 'board' || resource.resourceType === 'conversation') {
    const id = Number(resource.resourceId)
    return Number.isSafeInteger(id) && id > 0 ? id : null
  }
  if (resource.resourceType === 'agent') {
    const row = db.prepare('SELECT board_id FROM agents WHERE id=?').get(Number(resource.resourceId)) as
      { board_id: number } | undefined
    return row?.board_id ?? null
  }
  if (resource.resourceType === 'process') {
    const row = db.prepare(`SELECT workspace.board_id FROM processes process
      JOIN workspaces workspace ON workspace.id=process.workspace_id WHERE process.id=?`)
      .get(resource.resourceId) as { board_id: number } | undefined
    return row?.board_id ?? null
  }
  if (resource.resourceType === 'approval') {
    const row = db.prepare(`SELECT board_id FROM attention_items
      WHERE id=? AND kind='permission.request' AND status='open'`)
      .get(resource.resourceId) as { board_id: number } | undefined
    return row?.board_id ?? null
  }
  return null
}

/** Adds only a service-boundary-verified child grant derived from an existing board grant. */
function policyPrincipalForResource(
  db: Database.Database,
  device: RemoteAuthenticatedDevice,
  resource: VerifiedRemoteResource,
): RemoteDevicePrincipal {
  const principal = policyPrincipal(db, device)
  if (principal.resourceGrants.some((grant) => (
    grant.resourceType === resource.resourceType && grant.resourceId === resource.resourceId
  ))) return principal
  const boardId = resourceBoardId(db, resource)
  if (!boardId || !hasBoardGrant(db, device.deviceSessionId, boardId, 'read')) return principal
  const permissions: Array<'read' | 'mutate'> = ['read']
  if (hasBoardGrant(db, device.deviceSessionId, boardId, 'mutate')) permissions.push('mutate')
  return {
    ...principal,
    resourceGrants: [...principal.resourceGrants, {
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      permissions,
      dataClasses: ['redacted_observe', 'sensitive_content'],
    }],
  }
}

const verifiedResource = (
  resourceType: VerifiedRemoteResource['resourceType'],
  resourceId: string,
): VerifiedRemoteResource => ({ resourceType, resourceId, verifiedAtServiceBoundary: true })

function projectAllowedFields(
  decision: Extract<RemoteAuthorizationDecision, { allowed: true }>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(decision.allowedFields
    .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
    .map((field) => [field, value[field]]))
}

function readStepUpGrant(db: Database.Database, id: string): RemoteStepUpGrant | undefined {
  const row = db.prepare(`SELECT id, state, device_session_id, authenticated_user_id,
    credential_generation, operation, resource_type, resource_id, request_digest, nonce,
    issued_at, user_verified_at, expires_at FROM os_remote_step_up_grants WHERE id=?`).get(id) as {
      id: string
      state: 'active' | 'consumed' | 'revoked' | 'pending'
      device_session_id: string
      authenticated_user_id: string
      credential_generation: number
      operation: string
      resource_type: RemoteStepUpGrant['resourceType']
      resource_id: string
      request_digest: string
      nonce: string
      issued_at: string
      user_verified_at: string | null
      expires_at: string
    } | undefined
  if (!row || row.state === 'pending' || !row.user_verified_at) return undefined
  return {
    id: row.id,
    state: row.state,
    deviceSessionId: row.device_session_id,
    authenticatedUserId: row.authenticated_user_id,
    credentialVersion: row.credential_generation + 1,
    action: row.operation,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestDigest: row.request_digest,
    nonce: row.nonce,
    issuedAt: row.issued_at,
    userVerifiedAt: row.user_verified_at,
    expiresAt: row.expires_at,
    singleUse: true,
  }
}

function consumeDurableRateLimit(
  db: Database.Database,
  family: string,
  identities: readonly string[],
  limit: number,
  windowMs: number,
): boolean {
  const now = new Date()
  if (!Number.isFinite(now.getTime())) return false
  const expires = new Date(now.getTime() + windowMs).toISOString()
  const run = db.transaction(() => {
    db.prepare('DELETE FROM os_remote_rate_limits WHERE expires_at<=?').run(now.toISOString())
    for (const identity of identities) {
      const identityHash = digest(identity)
      const current = db.prepare(`SELECT request_count, expires_at FROM os_remote_rate_limits
        WHERE family=? AND identity_hash=?`).get(family, identityHash) as {
          request_count: number
          expires_at: string
        } | undefined
      if (current && current.expires_at > now.toISOString() && current.request_count >= limit) return false
    }
    const missing = identities.filter((identity) => !db.prepare(`SELECT 1 FROM os_remote_rate_limits
      WHERE family=? AND identity_hash=?`).get(family, digest(identity))).length
    const rows = Number((db.prepare('SELECT count(*) AS count FROM os_remote_rate_limits')
      .get() as { count: number }).count)
    if (rows + missing > 10_000) return false
    for (const identity of identities) {
      const identityHash = digest(identity)
      db.prepare(`INSERT INTO os_remote_rate_limits
        (family, identity_hash, window_started_at, expires_at, request_count)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(family, identity_hash) DO UPDATE SET
          request_count=CASE WHEN expires_at<=excluded.window_started_at THEN 1 ELSE request_count+1 END,
          window_started_at=CASE WHEN expires_at<=excluded.window_started_at
            THEN excluded.window_started_at ELSE window_started_at END,
          expires_at=CASE WHEN expires_at<=excluded.window_started_at
            THEN excluded.expires_at ELSE expires_at END`)
        .run(family, identityHash, now.toISOString(), expires)
    }
    return true
  })
  return run.immediate()
}

function verifiedTarget(origin: string, request: FastifyRequest): string {
  return `${origin}${request.url.split('?')[0]}`
}

function recordSecurityEvent(db: Database.Database, input: {
  eventType: 'authentication_denied' | 'pairing_disabled' | 'request_rate_limited'
    | 'step_up_approved' | 'step_up_denied' | 'remote_rollback'
  outcome: 'denied' | 'succeeded'
  deviceSessionId?: string
  actorType: 'device' | 'local_operator' | 'anonymous'
  actorId?: string
  requestId: string
  reasonCode: string
}): void {
  db.prepare(`INSERT INTO os_remote_security_events (
    id, occurred_at, event_type, outcome, device_session_id, actor_type, actor_id_hash,
    request_id, reason_code, sensitive_values_retained
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
    randomUUID(),
    nowIso(),
    input.eventType,
    input.outcome,
    input.deviceSessionId ?? null,
    input.actorType,
    input.actorId ? digest(input.actorId) : null,
    bounded(input.requestId, 'request id', 200),
    bounded(input.reasonCode, 'reason code', 120),
  )
}

const PUSH_SEVERITY = Object.freeze({ info: 0, low: 1, medium: 2, high: 3, critical: 4 })

const inQuietWindow = (start: string, end: string, date: Date): boolean => {
  const current = date.getHours() * 60 + date.getMinutes()
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
  const from = minutes(start)
  const to = minutes(end)
  return from === to ? false : from < to ? current >= from && current < to : current >= from || current < to
}

/** Durable outbox adapter: payload is generic, device-targeted, and idempotent at the push topic. */
export async function deliverRemotePushOutbox(
  db: Database.Database,
  delivery: OutboxDelivery,
  signal: AbortSignal,
  vapid: VapidKeys | undefined,
): Promise<void> {
  const payload = delivery.payload as { device_session_id?: unknown; board_id?: unknown; severity?: unknown }
  const deviceId = bounded(payload?.device_session_id, 'push device id', 200)
  const severity = String(payload?.severity ?? 'medium') as keyof typeof PUSH_SEVERITY
  if (!(severity in PUSH_SEVERITY)) throw new Error('push severity is invalid')
  const boardId = payload.board_id == null ? null : Number(payload.board_id)
  if (boardId !== null && (!Number.isSafeInteger(boardId) || boardId <= 0)) {
    throw new Error('push board id is invalid')
  }
  const at = new Date()
  const rows = db.prepare(`SELECT subscription.id, subscription.endpoint, subscription.p256dh,
    subscription.auth, subscription.failures, preference.minimum_severity,
    preference.quiet_start, preference.quiet_end
    FROM os_remote_push_subscriptions subscription
    JOIN os_device_sessions session ON session.id=subscription.device_session_id
    JOIN os_remote_notification_preferences preference
      ON preference.device_session_id=subscription.device_session_id
    WHERE session.id=? AND session.state='active' AND session.expires_at>?
      AND EXISTS (SELECT 1 FROM os_device_credentials credential
        WHERE credential.device_session_id=session.id AND credential.state='active'
          AND credential.expires_at>?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM os_remote_resource_grants grant_row
        WHERE grant_row.device_session_id=session.id AND grant_row.resource_type='board'
          AND grant_row.resource_id=CAST(? AS TEXT)))`).all(
    deviceId, at.toISOString(), at.toISOString(), boardId, boardId,
  ) as Array<{
    id: string
    endpoint: string
    p256dh: string
    auth: string
    failures: number
    minimum_severity: keyof typeof PUSH_SEVERITY
    quiet_start: string
    quiet_end: string
  }>
  const genericPayload = JSON.stringify({
    title: 'Orchestra needs attention',
    body: 'Open Orchestra to review an update.',
    url: '/',
    tag: 'orchestra-attention',
  })
  if (!vapid) throw new Error('secure VAPID credential is unavailable')
  for (const row of rows) {
    if (PUSH_SEVERITY[severity] < PUSH_SEVERITY[row.minimum_severity]
      || inQuietWindow(row.quiet_start, row.quiet_end, at)) continue
    if (signal.aborted) throw new Error('remote push delivery aborted')
    try {
      const endpoint = validateWebPushEndpoint(row.endpoint)
      await webpush.sendNotification({
        endpoint, keys: { p256dh: row.p256dh, auth: row.auth },
      }, genericPayload, {
        vapidDetails: {
          subject: 'mailto:orchestra@localhost', publicKey: vapid.publicKey, privateKey: vapid.privateKey,
        },
        TTL: 300,
        topic: digest(delivery.idempotencyKey).slice(0, 32),
        timeout: 10_000,
        agent: createWebPushEgressAgent(),
      })
      if (row.failures) db.prepare('UPDATE os_remote_push_subscriptions SET failures=0 WHERE id=?').run(row.id)
    } catch (error) {
      const status = (error as { statusCode?: number; status?: number }).statusCode
        ?? (error as { status?: number }).status
      if (status === 404 || status === 410 || row.failures + 1 >= 5) {
        db.prepare('DELETE FROM os_remote_push_subscriptions WHERE id=?').run(row.id)
        continue
      }
      db.prepare('UPDATE os_remote_push_subscriptions SET failures=failures+1 WHERE id=?').run(row.id)
      throw new Error('remote push delivery failed')
    }
  }
}

/**
 * Installs the root-owned authentication boundary and the deliberately small remote API.
 * A device credential never inherits access to legacy routes: every remote route is explicit.
 */
export function registerRemoteSecurityIntegration(
  server: FastifyInstance,
  options: RemoteSecurityOptions,
): void {
  const repository = new SqliteDeviceSessionRepository(options.db)
  const replayStore = new RemoteDeviceProofReplayStore(options.db)
  const recovery = new OperationsRecoveryService(options.db)
  const auditStore = new SqliteRemoteMutationAuditStore(options.db)
  const rotationService = new RemoteDeviceCredentialRotationService(
    options.db,
    repository,
    auditStore,
  )
  const authorizationPolicy = new RemoteAuthorizationPolicy([
    ...DEFAULT_REMOTE_POLICY_RULES,
    ...integrationRules,
  ])
  const activeRemoteStreams = new Map<string, Set<{ close(reason: string): void }>>()
  const closeRemoteStreams = (deviceSessionId: string, reason: string): number => {
    const streams = activeRemoteStreams.get(deviceSessionId)
    if (!streams) return 0
    const count = streams.size
    for (const stream of [...streams]) stream.close(reason)
    return count
  }
  const persistAllowedMutation = (
    decision: Extract<RemoteAuthorizationDecision, { allowed: true }>,
    request: FastifyRequest,
    requestDigest: string,
    outcome: 'authorized' | 'succeeded' | 'failed' = 'succeeded',
  ): void => {
    auditStore.persist(createRemoteMutationAuditEnvelope({
      authorization: decision,
      outcome,
      occurredAt: nowIso(),
      requestId: bounded(request.id, 'request id', 200),
      correlationId: bounded(request.id, 'correlation id', 200),
      requestDigest,
    }))
  }
  const persistDeniedMutation = (
    decision: Extract<RemoteAuthorizationDecision, { allowed: false }>,
    request: FastifyRequest,
    requestDigest?: string,
  ): void => {
    auditStore.persist(createRemoteMutationDenialAuditEnvelope({
      denial: decision,
      occurredAt: nowIso(),
      requestId: bounded(request.id, 'request id', 200),
      correlationId: bounded(request.id, 'correlation id', 200),
      requestDigest,
    }))
  }
  const persistInvalidMutation = (
    request: FastifyRequest,
    device: RemoteAuthenticatedDevice,
    operation: string,
    resource: VerifiedRemoteResource | null,
  ): void => {
    const rule = authorizationPolicy.rule(operation)
    auditStore.persist(createRemoteMutationDenialAuditEnvelope({
      denial: Object.freeze({
        allowed: false as const,
        operation,
        code: 'invalid_request' as const,
        ruleId: rule?.id ?? null,
        resource,
        deviceAttribution: Object.freeze({
          deviceSessionId: device.deviceSessionId,
          authenticatedUserId: 'local-owner',
          credentialVersion: device.credentialGeneration + 1,
          tunnelOrigin: device.tunnelOrigin,
        }),
      }),
      occurredAt: nowIso(),
      requestId: bounded(request.id, 'request id', 200),
      correlationId: bounded(request.id, 'correlation id', 200),
    }))
  }
  const authorizeClassified = (input: {
    request: FastifyRequest
    reply: FastifyReply
    operation: string
    resource: VerifiedRemoteResource
    requestDigest?: string
    stepUpGrant?: RemoteStepUpGrant
    nonce?: string
    principal?: RemoteDevicePrincipal
  }): RemoteAuthorizationDecision | null => {
    const device = remoteRequestDevice(input.request)
    if (!device) {
      input.reply.code(403).send({ error: 'device authority is required' })
      return null
    }
    const decision = authorizationPolicy.authorize({
      operation: input.operation,
      principal: input.principal ?? policyPrincipalForResource(options.db, device, input.resource),
      resource: input.resource,
      requestDigest: input.requestDigest,
      stepUpGrant: input.stepUpGrant,
      nonce: input.nonce,
    })
    if (!decision.allowed) {
      if (authorizationPolicy.rule(input.operation)?.kind === 'mutation') {
        try {
          persistDeniedMutation(decision, input.request, input.requestDigest)
        } catch {
          input.reply.code(503).send({ error: 'required remote audit evidence could not be persisted' })
          return null
        }
      }
      input.reply.code(403).send({ error: 'remote authorization denied', code: decision.code })
      return null
    }
    if (decision.kind === 'mutation') {
      const limits = { command: 30, approval: 60, 'pty-write': 30, admin: 10, provider: 20 } as const
      const family = decision.rateLimitFamily
      const limit = limits[family as keyof typeof limits] ?? 30
      const allowed = consumeDurableRateLimit(options.db, family, [
        `device:${device.deviceSessionId}`,
        `origin:${device.tunnelOrigin}`,
        'account:local-owner',
      ], limit, 60_000)
      if (!allowed) {
        const denial = {
          allowed: false as const,
          operation: decision.operation,
          code: 'rate_limit_exceeded' as const,
          ruleId: decision.ruleId,
          resource: decision.resource,
          deviceAttribution: decision.deviceAttribution,
        }
        persistDeniedMutation(denial, input.request, input.requestDigest)
        try {
          options.operations?.recordRateLimitRejection(device.deviceSessionId)
        } catch { /* durable denial remains authoritative */ }
        input.reply.code(429).send({ error: 'remote mutation rate limit exceeded' })
        return null
      }
    }
    return decision
  }

  const stepUpTransaction = {
    executeOnce<T>(claim: RemoteStepUpClaim, operation: () => T) {
      const execute = options.db.transaction(() => {
        const at = new Date(claim.nowMs).toISOString()
        const updated = options.db.prepare(`UPDATE os_remote_step_up_grants
          SET state='consumed', consumed_at=?
          WHERE id=? AND device_session_id=? AND authenticated_user_id=?
            AND credential_generation=? AND operation=? AND resource_type=? AND resource_id=?
            AND request_digest=? AND nonce=? AND state='active' AND expires_at=? AND expires_at>?
            AND EXISTS (SELECT 1 FROM os_device_sessions session
              JOIN os_device_credentials credential ON credential.device_session_id=session.id
              WHERE session.id=? AND session.state='active' AND session.expires_at>?
                AND credential.state='active' AND credential.rotation_generation=?
                AND credential.expires_at>?)`).run(
          at, claim.grantId, claim.deviceSessionId, claim.authenticatedUserId,
          claim.credentialVersion - 1, claim.operation, claim.resourceType, claim.resourceId,
          claim.requestDigest, claim.nonce, claim.expectedExpiresAt, at,
          claim.deviceSessionId, at, claim.credentialVersion - 1, at,
        )
        if (updated.changes !== 1) return { claimed: false } as const
        return { claimed: true, value: operation() } as const
      })
      return execute.immediate()
    },
  }

  const executeRemoteMutation = async <T>(input: {
    request: FastifyRequest
    reply: FastifyReply
    operation: string
    resource: VerifiedRemoteResource
    canonicalRequest: string
    effect: () => T | Promise<T>
  }): Promise<{ executed: false } | { executed: true; value: T }> => {
    const device = remoteRequestDevice(input.request)
    if (!device) {
      input.reply.code(403).send({ error: 'device authority is required' })
      return { executed: false }
    }
    const requestDigest = digestRemoteMutation(input.canonicalRequest)
    const grantId = typeof input.request.headers['x-orchestra-step-up-grant'] === 'string'
      ? input.request.headers['x-orchestra-step-up-grant'] : ''
    const nonce = typeof input.request.headers['x-orchestra-step-up-nonce'] === 'string'
      ? input.request.headers['x-orchestra-step-up-nonce'] : ''
    const stepUpGrant = grantId ? readStepUpGrant(options.db, grantId) : undefined
    const principal = policyPrincipalForResource(options.db, device, input.resource)
    const rule = authorizationPolicy.rule(input.operation)
    if (!rule || rule.kind !== 'mutation') {
      input.reply.code(403).send({ error: 'remote authorization denied', code: 'unclassified_operation' })
      return { executed: false }
    }
    try {
      const persistAuthorizedIntent = (
        authorization: Extract<RemoteAuthorizationDecision, { allowed: true }>,
      ) => {
        persistAllowedMutation(authorization, input.request, requestDigest, 'authorized')
      }
      const runAfterPreflight = async (
        authorization: Extract<RemoteAuthorizationDecision, { allowed: true }>,
      ) => {
        try {
          const value = await input.effect()
          persistAllowedMutation(authorization, input.request, requestDigest)
          return value
        } catch (error) {
          persistAllowedMutation(authorization, input.request, requestDigest, 'failed')
          throw error
        }
      }
      const run = (authorization: Extract<RemoteAuthorizationDecision, { allowed: true }>) => {
        persistAuthorizedIntent(authorization)
        return runAfterPreflight(authorization)
      }
      if (rule.stepUp !== 'action-bound') {
        const decision = authorizeClassified({
          request: input.request,
          reply: input.reply,
          operation: input.operation,
          resource: input.resource,
          requestDigest,
          principal,
        })
        if (!decision?.allowed) return { executed: false }
        return { executed: true, value: await run(decision) }
      }
      const precheck = authorizationPolicy.authorize({
        operation: input.operation,
        principal,
        resource: input.resource,
        requestDigest,
        stepUpGrant,
        nonce,
      })
      if (!precheck.allowed && precheck.code !== 'step_up_claim_required') {
        persistDeniedMutation(precheck, input.request, requestDigest)
        input.reply.code(403).send({ error: 'remote authorization denied', code: precheck.code })
        return { executed: false }
      }
      const limits = { command: 30, approval: 60, 'pty-write': 30, admin: 10, provider: 20 } as const
      const limit = limits[rule.rateLimitFamily as keyof typeof limits] ?? 30
      if (!consumeDurableRateLimit(options.db, rule.rateLimitFamily, [
        `device:${device.deviceSessionId}`,
        `origin:${device.tunnelOrigin}`,
        'account:local-owner',
      ], limit, 60_000)) {
        const denial = Object.freeze({
          allowed: false as const,
          operation: input.operation,
          code: 'rate_limit_exceeded' as const,
          ruleId: rule.id,
          resource: input.resource,
          deviceAttribution: precheck.deviceAttribution,
        })
        persistDeniedMutation(denial, input.request, requestDigest)
        input.reply.code(429).send({ error: 'remote mutation rate limit exceeded' })
        return { executed: false }
      }
      const value = await authorizationPolicy.runAuthorizedServiceOperation({
        operation: input.operation,
        principal,
        resource: input.resource,
        requestDigest,
        stepUpGrant,
        nonce,
      }, (context) => run(context.authorization), stepUpTransaction)
      return { executed: true, value }
    } catch (error) {
      if (error instanceof RemoteAuthorizationError) {
        persistDeniedMutation(error.decision, input.request, requestDigest)
      }
      throw error
    }
  }

  const consumeRemoteStreamCredential = (
    request: FastifyRequest,
    authorization: string,
  ): RemoteAuthenticatedDevice => {
    if (request.url !== REMOTE_STREAM_OPEN_PATH) throw new RemoteStreamAuthenticationError('invalid')
    const match = REMOTE_STREAM_CREDENTIAL.exec(authorization.slice('Stream '.length))
    if (!match) throw new RemoteStreamAuthenticationError('invalid')
    const [, ticketId, secret] = match
    const row = options.db.prepare(`SELECT
      stream.secret_hash, stream.device_session_id, stream.credential_id,
      stream.credential_generation, stream.expires_at AS stream_expires_at,
      stream.consumed_at, session.scopes_json, session.expires_at AS session_expires_at,
      credential.expires_at AS credential_expires_at, pairing.expected_origin
      FROM os_remote_stream_tickets stream
      JOIN os_device_sessions session ON session.id=stream.device_session_id
      JOIN os_device_credentials credential ON credential.id=stream.credential_id
      JOIN os_pairing_tickets pairing ON pairing.id=session.created_from_ticket_id
      WHERE stream.id=? AND stream.purpose='remote-events'`).get(ticketId) as {
        secret_hash: string
        device_session_id: string
        credential_id: string
        credential_generation: number
        stream_expires_at: string
        consumed_at: string | null
        scopes_json: string
        session_expires_at: string
        credential_expires_at: string
        expected_origin: string
      } | undefined
    if (!row) throw new RemoteStreamAuthenticationError('invalid')
    const expected = new URL(row.expected_origin)
    const context = evaluateRemoteRequestContext({
      expectedHosts: [expected.host],
      expectedOrigins: [row.expected_origin],
      trustedProxyAddresses: [],
      trustForwardedHost: false,
    }, {
      method: request.method,
      host: request.headers.host,
      forwardedHost: typeof request.headers['x-forwarded-host'] === 'string'
        ? request.headers['x-forwarded-host'] : undefined,
      origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
      secFetchSite: typeof request.headers['sec-fetch-site'] === 'string'
        ? request.headers['sec-fetch-site'] : undefined,
      remoteAddress: request.ip || request.raw.socket.remoteAddress || '',
      clientKind: request.headers.origin ? 'browser' : 'non-browser',
      credentialTransport: 'authorization-header',
      requestPurpose: 'stream',
    })
    if (!context.allowed || row.consumed_at || row.stream_expires_at <= nowIso()
      || !tokenEquals(row.secret_hash, streamSecretDigest(ticketId, secret))) {
      throw new RemoteStreamAuthenticationError('invalid')
    }
    if (!consumeDurableRateLimit(options.db, 'stream', [
      `device:${row.device_session_id}`,
      `origin:${row.expected_origin}`,
      'account:local-owner',
    ], 60, 60_000)) throw new RemoteStreamAuthenticationError('rate_limited')
    const consumedAt = nowIso()
    const claimed = options.db.prepare(`UPDATE os_remote_stream_tickets SET consumed_at=?
      WHERE id=? AND consumed_at IS NULL AND expires_at>?
        AND EXISTS (SELECT 1 FROM os_device_sessions session
          JOIN os_device_credentials credential ON credential.device_session_id=session.id
          WHERE session.id=os_remote_stream_tickets.device_session_id
            AND session.state='active' AND session.expires_at>?
            AND credential.id=os_remote_stream_tickets.credential_id
            AND credential.state='active'
            AND credential.rotation_generation=os_remote_stream_tickets.credential_generation
            AND credential.expires_at>?)`).run(consumedAt, ticketId, consumedAt, consumedAt, consumedAt)
    if (claimed.changes !== 1) throw new RemoteStreamAuthenticationError('invalid')
    return {
      deviceSessionId: row.device_session_id,
      credentialId: row.credential_id,
      credentialGeneration: row.credential_generation,
      scopes: JSON.parse(row.scopes_json) as DeviceScope[],
      sessionExpiresAt: row.session_expires_at,
      credentialExpiresAt: row.credential_expires_at,
      tunnelOrigin: row.expected_origin,
    }
  }

  server.addHook('onRequest', async (request, reply) => {
    for (const [name, value] of Object.entries(REMOTE_BROWSER_SECURITY_HEADERS)) {
      const resolved = name === 'content-security-policy' && loopbackHost(request.headers.host)
        ? value.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
        : value
      reply.header(name, resolved)
    }
    reply.header('cache-control', 'no-store')
    if (!request.url.startsWith('/api/')) return
    request.orchestraPrincipal = 'anonymous'
    request.orchestraRemoteDevice = null
    const path = request.url.split('?')[0]
    if (path === '/api/v1/os/devices/redeem') {
      if (process.env.ORCHESTRA_REMOTE_KILL_SWITCH === '1' || remoteAccessDisabled(options.db)) {
        reply.header('clear-site-data', '"cache", "storage"')
        recordSecurityEvent(options.db, {
          eventType: 'pairing_disabled', outcome: 'denied', actorType: 'anonymous',
          actorId: request.ip || request.raw.socket.remoteAddress || 'unknown',
          requestId: request.id, reasonCode: 'operator_kill_switch',
        })
        return reply.code(503).send({ error: 'remote access is disabled by the operator kill switch' })
      }
      return
    }
    const authorization = request.headers.authorization
    const address = request.ip || request.raw.socket.remoteAddress
    if (authorization?.startsWith('Bearer ')) {
      const supplied = authorization.slice(7)
      if (options.masterToken && tokenEquals(supplied, options.masterToken)
        && loopback(address) && loopbackIngressHost(request)) {
        request.orchestraPrincipal = 'operator'
        return
      }
      if (options.agentToken && tokenEquals(supplied, options.agentToken)
        && loopback(address) && loopbackIngressHost(request)) {
        request.orchestraPrincipal = 'agent'
        return
      }
    }
    if (request.headers['x-orchestra-agent-id'] !== undefined) {
      request.orchestraPrincipal = 'agent'
      try {
        if (options.authenticateAgent?.(request)) return
      } catch {
        // Exact provider-session authentication is fail-closed below.
      }
      request.orchestraPrincipal = 'anonymous'
    }
    if (!options.masterToken && !authorization
      && loopback(address) && loopbackIngressHost(request)) {
      request.orchestraPrincipal = 'operator'
      return
    }
    // A managed provider's one-time launch bootstrap is validated by the route after body parsing.
    // No other anonymous registration path is admitted by that handler.
    if (request.method === 'POST' && path === '/api/v1/agents/register') return

    if (process.env.ORCHESTRA_REMOTE_KILL_SWITCH === '1' || remoteAccessDisabled(options.db)) {
      reply.header('clear-site-data', '"cache", "storage"')
      return reply.code(503).send({ error: 'remote access is disabled by the operator kill switch' })
    }

    if (path === REMOTE_STREAM_OPEN_PATH && authorization?.startsWith('Stream ')) {
      try {
        const device = consumeRemoteStreamCredential(request, authorization)
        request.orchestraPrincipal = 'device'
        request.orchestraRemoteDevice = device
        return
      } catch (error) {
        const rateLimited = error instanceof RemoteStreamAuthenticationError
          && error.code === 'rate_limited'
        const evidenceAllowed = rateLimited || consumeDurableRateLimit(options.db, 'auth-failure', [
          `stream-ingress:${address ?? 'unknown'}`,
        ], 10, 5 * 60_000)
        if (evidenceAllowed) recordSecurityEvent(options.db, {
          eventType: rateLimited ? 'request_rate_limited' : 'authentication_denied',
          outcome: 'denied', actorType: 'anonymous', actorId: address ?? 'unknown',
          requestId: request.id, reasonCode: rateLimited ? 'stream_limit' : 'invalid_stream_credential',
        })
        return reply.code(rateLimited || !evidenceAllowed ? 429 : 401).send({
          error: rateLimited || !evidenceAllowed
            ? 'remote stream rate limit exceeded' : 'invalid stream authority',
        })
      }
    }

    if (!authorization?.startsWith('Device ')) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    if (!REMOTE_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      return reply.code(403).send({ error: 'remote route is not classified' })
    }
    const credential = authorization.slice(7)
    const proofToken = typeof request.headers.dpop === 'string' ? request.headers.dpop : ''
    const credentialId = credential.split('.')[1] ?? 'unknown'
    const originHint = typeof request.headers.origin === 'string' ? request.headers.origin : request.headers.host ?? ''
    let provisional: ReturnType<SqliteDeviceSessionRepository['verifyDeviceCredential']> | undefined
    let provisionalOrigin: string | undefined
    try {
      const parts = proofToken.split('.')
      if (parts.length !== 3) throw new Error('device proof is required')
      const origin = expectedOriginForCredential(options.db, credentialId)
      if (!origin) throw new Error('device origin is unavailable')
      provisionalOrigin = origin
      const expected = new URL(origin)
      const context = evaluateRemoteRequestContext({
        expectedHosts: [expected.host],
        expectedOrigins: [origin],
        trustedProxyAddresses: [],
        trustForwardedHost: false,
      }, {
        method: request.method,
        host: request.headers.host,
        forwardedHost: typeof request.headers['x-forwarded-host'] === 'string'
          ? request.headers['x-forwarded-host'] : undefined,
        origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
        secFetchSite: typeof request.headers['sec-fetch-site'] === 'string'
          ? request.headers['sec-fetch-site'] : undefined,
        remoteAddress: address ?? '',
        clientKind: request.headers.origin ? 'browser' : 'non-browser',
        credentialTransport: 'proof-bound-header',
        requestPurpose: 'api',
      })
      if (!context.allowed) throw new Error(`request context denied: ${context.code}`)
      provisional = repository.verifyDeviceCredential({
        credential,
        proofPayload: `${parts[0]}.${parts[1]}`,
        proofSignature: parts[2],
      })
      const verified = verifyRemoteDeviceProof({
        proof: proofToken,
        credential,
        method: request.method,
        url: verifiedTarget(origin, request),
      })
      if (verified.publicKeyThumbprint !== provisional.public_key_thumbprint) {
        throw new Error('device proof key mismatch')
      }
      replayStore.consume({
        deviceSessionId: provisional.device_session_id,
        credentialGeneration: provisional.rotation_generation,
        proof: verified,
      })
      const deviceAllowed = consumeDurableRateLimit(options.db, 'request', [
        `device:${provisional.device_session_id}`,
      ], 120, 60_000)
      const tunnelAllowed = consumeDurableRateLimit(options.db, 'request', [
        `tunnel:${origin}`,
      ], 5_000, 60_000)
      if (!deviceAllowed || !tunnelAllowed) {
        recordSecurityEvent(options.db, {
          eventType: 'request_rate_limited', outcome: 'denied',
          deviceSessionId: provisional.device_session_id,
          actorType: 'device', actorId: provisional.device_session_id,
          requestId: request.id, reasonCode: deviceAllowed ? 'tunnel_limit' : 'device_limit',
        })
        try {
          options.operations?.recordRateLimitRejection(provisional.device_session_id)
        } catch { /* durable security event remains authoritative */ }
        return reply.code(429).send({ error: 'remote request rate limit exceeded' })
      }
      request.orchestraPrincipal = 'device'
      request.orchestraRemoteDevice = {
        deviceSessionId: provisional.device_session_id,
        credentialId: provisional.credential_id,
        credentialGeneration: provisional.rotation_generation,
        scopes: provisional.scopes,
        sessionExpiresAt: provisional.session_expires_at,
        credentialExpiresAt: provisional.credential_expires_at,
        tunnelOrigin: origin,
      }
    } catch {
      if (credentialRequiresPurge(options.db, credentialId)) {
        reply.header('clear-site-data', '"cache", "storage"')
      }
      const ingressAllowed = consumeDurableRateLimit(options.db, 'auth-failure', [
        `ingress:${address ?? 'unknown'}`,
      ], 10, 5 * 60_000)
      const allowed = ingressAllowed && consumeDurableRateLimit(options.db, 'auth-failure', [
        `origin:${originHint}`, `credential:${credentialId}`,
        `origin-credential:${originHint}\0${credentialId}`,
      ], 10, 5 * 60_000)
      if (allowed) {
        recordSecurityEvent(options.db, {
          eventType: 'authentication_denied', outcome: 'denied',
          deviceSessionId: provisional?.device_session_id,
          actorType: provisional ? 'device' : 'anonymous',
          actorId: provisional?.device_session_id ?? address ?? 'unknown',
          requestId: request.id, reasonCode: 'invalid_request_proof',
        })
      }
      if (!allowed) return reply.code(429).send({ error: 'remote authentication rate limit exceeded' })
      return reply.code(401).send({ error: 'invalid device authority' })
    }
  })

  server.post<{ Body: { expected_origin?: string; scopes?: DeviceScope[]; board_ids?: number[] } }>(
    '/api/v1/os/devices/pairing-tickets',
    (request, reply) => {
      if (request.orchestraPrincipal !== 'operator') return reply.code(403).send({ error: 'local owner required' })
      if (process.env.ORCHESTRA_REMOTE_KILL_SWITCH === '1' || remoteAccessDisabled(options.db)) {
        return reply.code(503).send({ error: 'remote access is disabled by the operator kill switch' })
      }
      try {
        const boardIds = [...new Set(request.body?.board_ids ?? [])]
        if (boardIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
          throw new Error('board_ids must contain positive integers')
        }
        const issue = options.db.transaction(() => {
          for (const boardId of boardIds) {
            if (!options.db.prepare('SELECT 1 FROM boards WHERE id=?').get(boardId)) {
              throw new Error(`board ${boardId} does not exist`)
            }
          }
          const created = repository.createPairingTicket({
            expectedOrigin: safeOrigin(request.body?.expected_origin),
            requestedScopes: request.body?.scopes,
            actor: { type: 'local-operator', id: 'local-owner' },
          })
          const insert = options.db.prepare(`INSERT INTO os_pairing_ticket_resource_grants
            (pairing_ticket_id, resource_type, resource_id, permissions_json, data_classes_json)
            VALUES (?, 'board', ?, '["read","mutate"]', '["redacted_observe"]')`)
          for (const boardId of boardIds) insert.run(created.ticket.id, String(boardId))
          if (created.ticket.requested_scopes.includes('admin')) {
            options.db.prepare(`INSERT INTO os_pairing_ticket_resource_grants
              (pairing_ticket_id, resource_type, resource_id, permissions_json, data_classes_json)
              SELECT ?, 'device', id, '["read","mutate"]', '["redacted_observe"]'
              FROM os_device_sessions WHERE state='active'`).run(created.ticket.id)
          }
          return created
        })
        return issue.immediate()
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid pairing request' })
      }
    },
  )

  server.post<{ Body: {
    pairing_ticket?: string
    device_name?: string
    device_public_key_jwk?: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  } }>('/api/v1/os/devices/redeem', (request, reply) => {
    let denialReason = 'pairing_redemption_denied'
    try {
      if (!consumeDurableRateLimit(options.db, 'pairing', [
        `ingress:${request.ip || request.raw.socket.remoteAddress || 'unknown'}`,
      ], 20, 5 * 60_000)) {
        return reply.code(429).send({ error: 'pairing rate limit exceeded' })
      }
      const pairingTicket = bounded(request.body?.pairing_ticket, 'pairing ticket', 512)
      const ticketId = pairingTicket.split('.')[1] ?? 'invalid'
      const ticket = repository.getPairingTicket(ticketId)
      if (!ticket) throw new Error('pairing ticket is unavailable')
      if (ticket.state !== 'pending') denialReason = 'pairing_ticket_replay'
      const origin = safeOrigin(request.headers.origin)
      const expected = new URL(ticket.expected_origin)
      const context = evaluateRemoteRequestContext({
        expectedHosts: [expected.host], expectedOrigins: [ticket.expected_origin],
        trustedProxyAddresses: [], trustForwardedHost: false,
      }, {
        method: request.method, host: request.headers.host,
        forwardedHost: typeof request.headers['x-forwarded-host'] === 'string'
          ? request.headers['x-forwarded-host'] : undefined,
        origin,
        secFetchSite: typeof request.headers['sec-fetch-site'] === 'string'
          ? request.headers['sec-fetch-site'] : undefined,
        remoteAddress: request.ip,
        clientKind: 'browser',
        credentialTransport: 'authorization-header',
        requestPurpose: 'api',
      })
      if (!context.allowed) throw new Error(`pairing context denied: ${context.code}`)
      if (!consumeDurableRateLimit(options.db, 'pairing', [
        `origin:${origin}`, `ticket:${ticketId}`,
      ], 5, 5 * 60_000)) {
        return reply.code(429).send({ error: 'pairing rate limit exceeded' })
      }
      const redeem = options.db.transaction(() => {
        const redemption = repository.redeemPairingTicket({
          pairingTicket,
          origin,
          deviceName: bounded(request.body?.device_name, 'device name', 120),
          devicePublicKeyJwk: request.body?.device_public_key_jwk as never,
        })
        grantTicketResources(
          options.db,
          redemption.device_session.created_from_ticket_id,
          redemption.device_session.id,
        )
        options.db.prepare(`INSERT OR IGNORE INTO os_remote_resource_grants (
          device_session_id, resource_type, resource_id, permissions_json, data_classes_json, created_at
        ) SELECT session.id, 'device', ?, '["read","mutate"]', '["redacted_observe"]', ?
          FROM os_device_sessions session, json_each(session.scopes_json) scope
          WHERE session.state='active' AND scope.value='admin'`)
          .run(redemption.device_session.id, nowIso())
        return redemption
      })
      return redeem.immediate()
    } catch {
      recordSecurityEvent(options.db, {
        eventType: 'authentication_denied', outcome: 'denied', actorType: 'anonymous',
        actorId: request.ip || request.raw.socket.remoteAddress || 'unknown',
        requestId: request.id, reasonCode: denialReason,
      })
      return reply.code(401).send({ error: 'invalid or expired pairing ticket' })
    }
  })

  server.post(REMOTE_STREAM_ISSUE_PATH, (request, reply) => {
    const device = remoteRequestDevice(request)
    if (!device) return reply.code(403).send({ error: 'device authority is required' })
    const requestDigest = digestRemoteMutation(JSON.stringify({
      operation: 'stream.issue', purpose: 'remote-events',
      device_session_id: device.deviceSessionId,
    }))
    const decision = authorizeClassified({
      request,
      reply,
      operation: 'stream.issue',
      resource: verifiedResource('device', device.deviceSessionId),
      requestDigest,
    })
    if (!decision?.allowed) return
    const id = randomUUID()
    const secret = randomBytes(32).toString('base64url')
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + REMOTE_STREAM_TTL_MS).toISOString()
    try {
      options.db.transaction(() => {
        options.db.prepare('DELETE FROM os_remote_stream_tickets WHERE expires_at<=?').run(createdAt)
        options.db.prepare(`INSERT INTO os_remote_stream_tickets (
          id, secret_hash, device_session_id, credential_id, credential_generation,
          purpose, created_at, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, 'remote-events', ?, ?, NULL)`).run(
          id, streamSecretDigest(id, secret), device.deviceSessionId, device.credentialId,
          device.credentialGeneration, createdAt, expiresAt,
        )
        persistAllowedMutation(decision, request, requestDigest)
      }).immediate()
      return reply.code(201).send({
        stream_ticket: `orchestra_stream_v1.${id}.${secret}`,
        purpose: 'remote-events',
        expires_at: expiresAt,
      })
    } catch {
      return reply.code(503).send({ error: 'stream authority issuance failed closed' })
    }
  })

  server.get(REMOTE_STREAM_OPEN_PATH, (request, reply) => {
    const device = requireScope(request, reply, 'stream')
    if (!device) return
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let closed = false
    let authorityExpiry: NodeJS.Timeout | undefined
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(ping)
      if (authorityExpiry) clearTimeout(authorityExpiry)
      server.bus.off('event', onEvent)
      const streams = activeRemoteStreams.get(device.deviceSessionId)
      streams?.delete(active)
      if (streams?.size === 0) activeRemoteStreams.delete(device.deviceSessionId)
    }
    const active = {
      close(reason: string) {
        if (closed) return
        reply.raw.write(`event: authorization\ndata: ${JSON.stringify({ active: false, reason })}\n\n`)
        cleanup()
        reply.raw.end()
      },
    }
    const allowedEventTypes = new Set([
      'agent', 'attention', 'autowake', 'card', 'job', 'message', 'process',
    ])
    const onEvent = (event: unknown) => {
      if (closed || !event || typeof event !== 'object') return
      const candidate = event as { board_id?: unknown; type?: unknown }
      const boardId = Number(candidate.board_id)
      if (!Number.isSafeInteger(boardId) || boardId <= 0 || typeof candidate.type !== 'string'
        || !allowedEventTypes.has(candidate.type)
        || !hasBoardGrant(options.db, device.deviceSessionId, boardId, 'read')) return
      // The stream carries only an invalidation envelope; clients refetch through classified APIs.
      reply.raw.write(`event: change\ndata: ${JSON.stringify({ board_id: boardId, type: candidate.type })}\n\n`)
    }
    server.bus.on('event', onEvent)
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    const streams = activeRemoteStreams.get(device.deviceSessionId) ?? new Set()
    streams.add(active)
    activeRemoteStreams.set(device.deviceSessionId, streams)
    const authorityDeadline = Math.min(
      Date.parse(device.sessionExpiresAt),
      Date.parse(device.credentialExpiresAt),
    )
    authorityExpiry = setTimeout(
      () => active.close('authority_expired'),
      Math.max(0, Math.min(2_147_483_647, authorityDeadline - Date.now())),
    )
    request.raw.on('close', cleanup)
    reply.raw.write('event: ready\ndata: {"ready":true}\n\n')
  })

  server.addHook('onClose', (_instance, done) => {
    for (const deviceSessionId of [...activeRemoteStreams.keys()]) {
      closeRemoteStreams(deviceSessionId, 'server_shutdown')
    }
    done()
  })

  server.get('/api/v1/os/devices/self', (request, reply) => {
    if (request.orchestraPrincipal === 'operator') return { local_owner: true }
    const device = remoteRequestDevice(request)
    if (!device) return
    const session = repository.getDeviceSession(device.deviceSessionId)
    if (!session) return reply.code(401).send({ error: 'device session is unavailable' })
    const decision = authorizeClassified({
      request, reply, operation: 'read.device-self',
      resource: verifiedResource('device', device.deviceSessionId),
    })
    if (!decision || !decision.allowed) return
    const grant = options.db.prepare(`SELECT id, operation AS action, resource_type, resource_id,
      request_digest, nonce, expires_at AS active_until FROM os_remote_step_up_grants
      WHERE device_session_id=? AND state='active' AND expires_at>?
      ORDER BY expires_at DESC LIMIT 1`).get(device.deviceSessionId, nowIso()) ?? null
    return projectAllowedFields(decision, {
      device_session_id: session.id,
      name: session.name,
      scopes: session.scopes,
      expires_at: session.expires_at,
      credential_expires_at: device.credentialExpiresAt,
      step_up: grant,
    })
  })

  server.post<{ Body: { new_public_key_jwk?: unknown } }>(
    REMOTE_DEVICE_CREDENTIAL_ROTATION_PATH,
    (request, reply) => {
      const device = remoteRequestDevice(request)
      if (!device) return reply.code(403).send({ error: 'device authority is required' })
      try {
        const requestId = typeof request.headers['x-orchestra-request-id'] === 'string'
          ? request.headers['x-orchestra-request-id'] : ''
        const requestDigest = digestRemoteMutation(JSON.stringify({
          operation: 'device.credential.rotate',
          request_id_hash: digest(requestId),
          new_public_key_jwk: request.body?.new_public_key_jwk ?? null,
        }))
        const decision = authorizeClassified({
          request,
          reply,
          operation: 'device.credential.rotate',
          resource: verifiedResource('device', device.deviceSessionId),
          requestDigest,
        })
        if (!decision || !decision.allowed) return
        const issue = options.db.transaction(() => {
          const rotated = executeRemoteDeviceCredentialRotationRoute(rotationService, {
            authenticatedDevice: {
              deviceSessionId: device.deviceSessionId,
              credentialId: device.credentialId,
              credentialGeneration: device.credentialGeneration,
              tunnelOrigin: device.tunnelOrigin,
              authenticatedUserId: 'local-owner',
            },
            body: request.body,
            rotationProofSignature: request.headers[REMOTE_DEVICE_CREDENTIAL_ROTATION_PROOF_HEADER],
            newKeyProofSignature: request.headers[REMOTE_DEVICE_NEW_KEY_PROOF_HEADER],
            requestId,
            correlationId: requestId,
          })
          options.db.prepare(`DELETE FROM os_remote_stream_tickets
            WHERE device_session_id=? AND credential_generation<=?`)
            .run(device.deviceSessionId, device.credentialGeneration)
          return rotated
        }).immediate()
        closeRemoteStreams(device.deviceSessionId, 'credential_rotated')
        return reply.code(201).send(issue)
      } catch (error) {
        if (!(error instanceof RemoteCredentialRotationError)) {
          return reply.code(503).send({ error: 'credential rotation failed closed' })
        }
        const status = error.code === 'audit_persistence_failed' ? 503
          : ['new_public_key_required', 'new_public_key_invalid', 'invalid_request_id']
              .includes(error.code) ? 400 : 403
        return reply.code(status).send({ error: 'credential rotation denied', code: error.code })
      }
    },
  )

  server.get('/api/v1/os/devices', (request, reply) => {
    const current = remoteRequestDevice(request)
    if (request.orchestraPrincipal !== 'operator') {
      if (!current || !authorizeClassified({
        request, reply, operation: 'read.device-inventory',
        resource: verifiedResource('device', current.deviceSessionId),
      })) return
    }
    const sessions = repository.listDeviceSessions()
    if (request.orchestraPrincipal === 'operator') {
      return { devices: sessions.map((session) => ({
        ...session,
        credential_expires_at: activeCredentialExpiry(options.db, session.id),
        current: false,
      })) }
    }
    if (!current) return
    const principal = policyPrincipal(options.db, current)
    return { devices: sessions.flatMap((session) => {
      const decision = authorizationPolicy.authorize({
        operation: 'read.device-inventory', principal,
        resource: verifiedResource('device', session.id),
      })
      if (!decision.allowed) return []
      return [projectAllowedFields(decision, {
        id: session.id,
        name: session.name,
        scopes: session.scopes,
        state: session.state,
        last_seen_at: session.last_seen_at,
        expires_at: session.expires_at,
      })]
    }) }
  })

  server.get('/api/v1/os/devices/remote-control', (request, reply) => {
    if (request.orchestraPrincipal !== 'operator') {
      return reply.code(403).send({ error: 'local owner required' })
    }
    return options.db.prepare(`SELECT state, generation, disabled_at, disabled_by, reason
      FROM os_remote_control_state WHERE id=1`).get()
  })

  server.post<{ Body: { confirm?: string; reason?: string } }>(
    '/api/v1/os/devices/rollback',
    (request, reply) => {
      if (request.orchestraPrincipal !== 'operator') {
        return reply.code(403).send({ error: 'local owner required' })
      }
      if (request.body?.confirm !== 'REVOKE_ALL_REMOTE_AUTHORITY') {
        return reply.code(400).send({ error: 'explicit rollback confirmation is required' })
      }
      const at = nowIso()
      const reason = typeof request.body.reason === 'string' && request.body.reason.trim()
        ? bounded(request.body.reason.trim(), 'rollback reason', 500)
        : 'emergency remote rollback'
      try {
        const result = options.db.transaction(() => {
          const affected = options.db.prepare(`SELECT id, revocation_version FROM os_device_sessions
            WHERE state IN ('pending_pairing','active') ORDER BY id`).all() as Array<{
              id: string
              revocation_version: number
            }>
          const pairingTickets = options.db.prepare(`UPDATE os_pairing_tickets SET
            state='revoked', revoked_at=?, revocation_reason=?,
            revoked_by_actor_type='local-operator', revoked_by_actor_id='local-owner'
            WHERE state='pending'`).run(at, reason).changes
          const credentials = options.db.prepare(`UPDATE os_device_credentials SET
            state='revoked', terminal_at=?, terminal_reason=?,
            terminal_by_actor_type='local-operator', terminal_by_actor_id='local-owner'
            WHERE state='active'`).run(at, reason).changes
          const sessions = options.db.prepare(`UPDATE os_device_sessions SET
            state='revoked', revocation_version=revocation_version+1,
            revoked_at=?, revocation_reason=?,
            revoked_by_actor_type='local-operator', revoked_by_actor_id='local-owner'
            WHERE state IN ('pending_pairing','active')`).run(at, reason).changes
          const stepUps = options.db.prepare(`UPDATE os_remote_step_up_grants SET state='revoked'
            WHERE state IN ('pending','active')`).run().changes
          const streamTickets = options.db.prepare('DELETE FROM os_remote_stream_tickets').run().changes
          const pushSubscriptions = options.db.prepare('DELETE FROM os_remote_push_subscriptions').run().changes
          options.db.prepare('DELETE FROM os_remote_notification_preferences').run()
          options.db.prepare('DELETE FROM os_device_proof_replays').run()
          options.db.prepare('DELETE FROM os_remote_resource_grants').run()
          options.db.prepare(`DELETE FROM os_pairing_ticket_resource_grants
            WHERE pairing_ticket_id IN (SELECT id FROM os_pairing_tickets WHERE state='revoked')`).run()
          const state = options.db.prepare(`UPDATE os_remote_control_state SET
            state='disabled', generation=generation+1, disabled_at=?, disabled_by='local-owner', reason=?
            WHERE id=1`).run(at, reason)
          if (state.changes !== 1) throw new Error('remote control state is unavailable')
          for (const device of affected) {
            const version = device.revocation_version + 1
            recovery.enqueue({
              destination: 'remote-device-revocation',
              eventId: `remote-rollback:${device.id}:${version}`,
              dedupeKey: `rollback:${device.id}:${version}`,
              payload: { kind: 'remote.device_revoked', device_session_id: device.id },
            })
          }
          return { pairing_tickets: pairingTickets, device_sessions: sessions,
            device_credentials: credentials, step_up_grants: stepUps,
            stream_tickets: streamTickets, push_subscriptions: pushSubscriptions,
            affected_device_ids: affected.map((device) => device.id) }
        }).immediate()
        let closedStreams = 0
        for (const deviceSessionId of [...activeRemoteStreams.keys()]) {
          closedStreams += closeRemoteStreams(deviceSessionId, 'remote_rollback')
        }
        try {
          const tunnel = (options.stopRemoteTunnel ?? stopRemote)()
          recordSecurityEvent(options.db, {
            eventType: 'remote_rollback', outcome: 'succeeded', actorType: 'local_operator',
            actorId: 'local-owner', requestId: request.id, reasonCode: 'remote_authority_purged',
          })
          return {
            state: 'disabled', ...result, active_streams_closed: closedStreams,
            tunnel_state_cleared: Boolean(tunnel), local_operator_available: true,
          }
        } catch {
          recordSecurityEvent(options.db, {
            eventType: 'remote_rollback', outcome: 'denied', actorType: 'local_operator',
            actorId: 'local-owner', requestId: request.id, reasonCode: 'verified_tunnel_stop_failed',
          })
          return reply.code(503).send({
            error: 'remote authority was revoked but verified tunnel stop requires operator attention',
            state: 'disabled', ...result, active_streams_closed: closedStreams,
          })
        }
      } catch {
        return reply.code(503).send({ error: 'remote rollback failed closed' })
      }
    },
  )

  server.post<{ Body: { confirm?: string } }>('/api/v1/os/devices/rollback/enable', (request, reply) => {
    if (request.orchestraPrincipal !== 'operator') {
      return reply.code(403).send({ error: 'local owner required' })
    }
    if (request.body?.confirm !== 'ENABLE_NEW_REMOTE_PAIRING') {
      return reply.code(400).send({ error: 'explicit enable confirmation is required' })
    }
    options.db.prepare(`UPDATE os_remote_control_state SET
      state='enabled', generation=generation+1, disabled_at=NULL, disabled_by=NULL, reason=NULL
      WHERE id=1`).run()
    recordSecurityEvent(options.db, {
      eventType: 'remote_rollback', outcome: 'succeeded', actorType: 'local_operator',
      actorId: 'local-owner', requestId: request.id, reasonCode: 'new_remote_pairing_reenabled',
    })
    return { state: 'enabled', restored_credentials: 0 }
  })

  server.post<{ Params: { id: string } }>('/api/v1/os/devices/:id/revoke', (request, reply) => {
    const device = remoteRequestDevice(request)
    const revoke = (actorType: string, actorId: string) => {
      const result = repository.revokeDeviceSession(request.params.id, {
        reason: 'revoked by device management', actor: { type: actorType, id: actorId },
      })
      options.db.prepare(`UPDATE os_remote_step_up_grants SET state='revoked'
        WHERE device_session_id=? AND state IN ('pending','active')`).run(request.params.id)
      options.db.prepare('DELETE FROM os_remote_stream_tickets WHERE device_session_id=?').run(request.params.id)
      options.db.prepare('DELETE FROM os_remote_notification_preferences WHERE device_session_id=?').run(request.params.id)
      options.db.prepare('DELETE FROM os_remote_push_subscriptions WHERE device_session_id=?').run(request.params.id)
      options.db.prepare('DELETE FROM os_device_proof_replays WHERE device_session_id=?').run(request.params.id)
      options.db.prepare('DELETE FROM os_remote_resource_grants WHERE device_session_id=?').run(request.params.id)
      recovery.enqueue({
        destination: 'remote-device-revocation',
        eventId: `device-revoked:${request.params.id}:${result.revocation_version}`,
        dedupeKey: `${request.params.id}:${result.revocation_version}`,
        payload: { kind: 'remote.device_revoked', device_session_id: request.params.id },
      })
      return result
    }
    let remoteRequestDigest: string | undefined
    let remoteAuthorization: Extract<RemoteAuthorizationDecision, { allowed: true }> | undefined
    try {
      let result
      if (request.orchestraPrincipal === 'operator') {
        result = options.db.transaction(() => revoke('local-operator', 'local-owner')).immediate()
      } else {
        if (!device) return reply.code(403).send({ error: 'device authority is required' })
        const path = `/api/v1/os/devices/${request.params.id}/revoke`
        const requestDigest = digestRemoteMutation(JSON.stringify({ method: 'POST', path, body: null }))
        remoteRequestDigest = requestDigest
        if (!consumeDurableRateLimit(options.db, 'admin', [
          `device:${device.deviceSessionId}`,
          `origin:${device.tunnelOrigin}`,
          'account:local-owner',
        ], 10, 60_000)) {
          const principal = policyPrincipal(options.db, device)
          persistDeniedMutation(Object.freeze({
            allowed: false as const,
            operation: 'device.revoke',
            code: 'rate_limit_exceeded' as const,
            ruleId: 'device.revoke',
            resource: verifiedResource('device', request.params.id),
            deviceAttribution: Object.freeze({
              deviceSessionId: principal.deviceSessionId,
              authenticatedUserId: principal.authenticatedUserId,
              credentialVersion: principal.credentialVersion,
              tunnelOrigin: principal.tunnelOrigin,
            }),
          }), request, requestDigest)
          return reply.code(429).send({ error: 'remote mutation rate limit exceeded' })
        }
        const grantId = typeof request.headers['x-orchestra-step-up-grant'] === 'string'
          ? request.headers['x-orchestra-step-up-grant'] : ''
        const nonce = typeof request.headers['x-orchestra-step-up-nonce'] === 'string'
          ? request.headers['x-orchestra-step-up-nonce'] : ''
        const stepUpGrant = readStepUpGrant(options.db, grantId)
        const resource = verifiedResource('device', request.params.id)
        result = authorizationPolicy.runAuthorizedServiceOperation({
          operation: 'device.revoke',
          principal: policyPrincipal(options.db, device),
          resource,
          requestDigest,
          stepUpGrant,
          nonce,
        }, (context) => {
          remoteAuthorization = context.authorization
          const value = revoke('device', device.deviceSessionId)
          persistAllowedMutation(context.authorization, request, requestDigest)
          return value
        }, {
          executeOnce<T>(claim: RemoteStepUpClaim, operation: () => T) {
            const execute = options.db.transaction(() => {
              const at = new Date(claim.nowMs).toISOString()
              const updated = options.db.prepare(`UPDATE os_remote_step_up_grants
                SET state='consumed', consumed_at=?
                WHERE id=? AND device_session_id=? AND authenticated_user_id=?
                  AND credential_generation=? AND operation=? AND resource_type=? AND resource_id=?
                  AND request_digest=? AND nonce=? AND state='active' AND expires_at=? AND expires_at>?
                  AND EXISTS (SELECT 1 FROM os_device_sessions s
                    JOIN os_device_credentials c ON c.device_session_id=s.id
                    WHERE s.id=? AND s.state='active' AND s.expires_at>?
                      AND c.state='active' AND c.rotation_generation=? AND c.expires_at>?)`).run(
                at, claim.grantId, claim.deviceSessionId, claim.authenticatedUserId,
                claim.credentialVersion - 1, claim.operation, claim.resourceType, claim.resourceId,
                claim.requestDigest, claim.nonce, claim.expectedExpiresAt, at,
                claim.deviceSessionId, at, claim.credentialVersion - 1, at,
              )
              if (updated.changes !== 1) return { claimed: false } as const
              return { claimed: true, value: operation() } as const
            })
            return execute.immediate()
          },
        })
      }
      closeRemoteStreams(request.params.id, 'device_revoked')
      server.bus.emit('remote-device-revoked', { device_session_id: request.params.id })
      return result
    } catch (error) {
      if (device) {
        const decision = error instanceof RemoteAuthorizationError ? error.decision : undefined
        if (decision && remoteRequestDigest) persistDeniedMutation(decision, request, remoteRequestDigest)
        else if (remoteAuthorization && remoteRequestDigest) {
          persistAllowedMutation(remoteAuthorization, request, remoteRequestDigest, 'failed')
        }
      }
      return reply.code(error instanceof RemoteAuthorizationError ? 403 : 404)
        .send({ error: error instanceof RemoteAuthorizationError
          ? 'remote authorization denied' : 'device revocation failed' })
    }
  })

  server.post<{ Body: {
    operation?: string
    resource_type?: string
    resource_id?: string
    request_digest?: string
    nonce?: string
  } }>('/api/v1/os/devices/self/step-up', (request, reply) => {
    const device = remoteRequestDevice(request)
    if (!device) return reply.code(403).send({ error: 'device authority required' })
    try {
      const operation = bounded(request.body?.operation, 'operation', 128)
      const resourceType = bounded(request.body?.resource_type, 'resource type', 64)
      const resourceId = bounded(request.body?.resource_id, 'resource id', 256)
      const requestDigest = bounded(request.body?.request_digest, 'request digest', 80)
      if (!/^sha256:[0-9a-f]{64}$/u.test(requestDigest)) throw new Error('request digest is invalid')
      const nonce = bounded(request.body?.nonce, 'nonce', 128)
      const rule = authorizationPolicy.rule(operation)
      if (!rule || rule.kind !== 'mutation' || rule.stepUp !== 'action-bound'
        || rule.resourceType !== resourceType) throw new Error('operation is not step-up classified')
      const futureResource = verifiedResource(rule.resourceType, resourceId)
      const future = authorizationPolicy.authorize({
        operation,
        principal: policyPrincipalForResource(options.db, device, futureResource),
        resource: futureResource,
        requestDigest,
        nonce,
      })
      if (future.allowed || future.code !== 'step_up_required') {
        if (!future.allowed) persistDeniedMutation(future, request, requestDigest)
        return reply.code(403).send({ error: 'requested step-up is not authorized' })
      }
      const stepUpRequestDigest = digestRemoteMutation(JSON.stringify({
        operation: 'step-up.request', resource_type: 'device',
        resource_id: device.deviceSessionId, requested_operation: operation,
        requested_resource_type: resourceType, requested_resource_id: resourceId,
      }))
      if (!consumeDurableRateLimit(options.db, 'command', [
        `device:${device.deviceSessionId}`,
        `origin:${device.tunnelOrigin}`,
        'account:local-owner',
      ], 30, 60_000)) {
        persistDeniedMutation(Object.freeze({
          allowed: false as const,
          operation: 'step-up.request',
          code: 'rate_limit_exceeded' as const,
          ruleId: 'device.step-up-request',
          resource: verifiedResource('device', device.deviceSessionId),
          deviceAttribution: Object.freeze({
            deviceSessionId: device.deviceSessionId,
            authenticatedUserId: 'local-owner',
            credentialVersion: device.credentialGeneration + 1,
            tunnelOrigin: device.tunnelOrigin,
          }),
        }), request, stepUpRequestDigest)
        try {
          options.operations?.recordRateLimitRejection(device.deviceSessionId)
        } catch { /* durable denial remains authoritative */ }
        return reply.code(429).send({ error: 'remote mutation rate limit exceeded' })
      }
      const stepUpDecision: Extract<RemoteAuthorizationDecision, { allowed: true }> = Object.freeze({
        allowed: true,
        operation: 'step-up.request',
        ruleId: 'device.step-up-request',
        kind: 'mutation',
        principalKind: 'device',
        attributedScope: rule.requiredScope,
        resource: verifiedResource('device', device.deviceSessionId),
        allowedFields: Object.freeze([]),
        cachePolicy: null,
        stepUpGrantId: null,
        authorizedRequestDigest: stepUpRequestDigest,
        requiresAudit: true,
        rateLimitFamily: 'command',
        deviceAttribution: Object.freeze({
          deviceSessionId: device.deviceSessionId,
          authenticatedUserId: 'local-owner',
          credentialVersion: device.credentialGeneration + 1,
          tunnelOrigin: device.tunnelOrigin,
        }),
      })
      const id = randomUUID()
      const issued = new Date()
      const create = options.db.transaction(() => {
        options.db.prepare(`INSERT INTO os_remote_step_up_grants (
          id, device_session_id, authenticated_user_id, credential_generation, operation,
          resource_type, resource_id, request_digest, nonce, state, issued_at,
          user_verified_at, expires_at, consumed_at
        ) VALUES (?, ?, 'local-owner', ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, NULL)`).run(
          id, device.deviceSessionId, device.credentialGeneration, operation, resourceType,
          resourceId, requestDigest, nonce, issued.toISOString(),
          new Date(issued.getTime() + 5 * 60_000).toISOString(),
        )
        persistAllowedMutation(stepUpDecision, request, stepUpRequestDigest)
      })
      create.immediate()
      return reply.code(202).send({ request_id: id, state: 'pending_local_confirmation' })
    } catch (error) {
      if (!(error instanceof RemoteMutationAuditPersistenceError)) {
        persistInvalidMutation(
          request,
          device,
          'step-up.request',
          verifiedResource('device', device.deviceSessionId),
        )
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid step-up request' })
    }
  })

  server.get('/api/v1/os/devices/step-up/pending', (request, reply) => {
    if (request.orchestraPrincipal !== 'operator') return reply.code(403).send({ error: 'local owner required' })
    options.db.prepare(`UPDATE os_remote_step_up_grants SET state='revoked'
      WHERE state IN ('pending','active') AND expires_at<=?`).run(nowIso())
    return {
      requests: options.db.prepare(`SELECT id, device_session_id, operation, resource_type,
        resource_id, request_digest, issued_at, expires_at
        FROM os_remote_step_up_grants WHERE state='pending' AND expires_at>?
        ORDER BY issued_at, id LIMIT 100`).all(nowIso()),
    }
  })

  server.post<{ Params: { id: string } }>('/api/v1/os/devices/step-up/:id/approve', (request, reply) => {
    if (request.orchestraPrincipal !== 'operator') return reply.code(403).send({ error: 'local owner required' })
    const at = nowIso()
    const approve = options.db.transaction(() => {
      const target = options.db.prepare(`SELECT device_session_id FROM os_remote_step_up_grants
        WHERE id=?`).get(request.params.id) as { device_session_id: string } | undefined
      const result = options.db.prepare(`UPDATE os_remote_step_up_grants
        SET state='active', user_verified_at=? WHERE id=? AND state='pending' AND expires_at>?`)
        .run(at, request.params.id, at)
      recordSecurityEvent(options.db, {
        eventType: result.changes === 1 ? 'step_up_approved' : 'step_up_denied',
        outcome: result.changes === 1 ? 'succeeded' : 'denied',
        deviceSessionId: target?.device_session_id,
        actorType: 'local_operator', actorId: 'local-owner', requestId: request.id,
        reasonCode: result.changes === 1 ? 'explicit_local_confirmation' : 'grant_unavailable',
      })
      return result.changes
    })
    return approve.immediate() === 1
      ? { approved: true }
      : reply.code(409).send({ error: 'step-up request is unavailable' })
  })

  server.get('/api/v1/os/devices/self/notifications', (request, reply) => {
    const device = remoteRequestDevice(request)
    if (!device) return
    const decision = authorizeClassified({
      request, reply, operation: 'read.device-notifications',
      resource: verifiedResource('device', device.deviceSessionId),
    })
    if (!decision || !decision.allowed) return
    const preference = options.db.prepare(`SELECT minimum_severity, quiet_start, quiet_end, preview
      FROM os_remote_notification_preferences WHERE device_session_id=?`).get(device.deviceSessionId)
      ?? { minimum_severity: 'medium', quiet_start: '22:00', quiet_end: '07:00', preview: 'generic' }
    return projectAllowedFields(decision, preference as Record<string, unknown>)
  })

  server.put<{ Body: {
    minimum_severity?: string
    quiet_start?: string
    quiet_end?: string
    preview?: string
  } }>('/api/v1/os/devices/self/notifications', (request, reply) => {
    const device = remoteRequestDevice(request)
    if (!device) return
    const severity = String(request.body?.minimum_severity ?? '')
    const quietStart = String(request.body?.quiet_start ?? '')
    const quietEnd = String(request.body?.quiet_end ?? '')
    const preview = String(request.body?.preview ?? '')
    if (!['info', 'low', 'medium', 'high', 'critical'].includes(severity)
      || !/^\d\d:\d\d$/u.test(quietStart) || !/^\d\d:\d\d$/u.test(quietEnd)
      || !['generic', 'content'].includes(preview)) {
      persistInvalidMutation(
        request,
        device,
        'notifications.update',
        verifiedResource('device', device.deviceSessionId),
      )
      return reply.code(400).send({ error: 'invalid notification preferences' })
    }
    const requestDigest = digestRemoteMutation(JSON.stringify({ severity, quietStart, quietEnd, preview }))
    const decision = authorizeClassified({
      request, reply, operation: 'notifications.update',
      resource: verifiedResource('device', device.deviceSessionId), requestDigest,
    })
    if (!decision || !decision.allowed) return
    const update = options.db.transaction(() => {
      options.db.prepare(`INSERT INTO os_remote_notification_preferences
        (device_session_id, minimum_severity, quiet_start, quiet_end, preview, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_session_id) DO UPDATE SET minimum_severity=excluded.minimum_severity,
          quiet_start=excluded.quiet_start, quiet_end=excluded.quiet_end,
          preview=excluded.preview, push_endpoint_hash=NULL, updated_at=excluded.updated_at`)
        .run(device.deviceSessionId, severity, quietStart, quietEnd, preview, nowIso())
      persistAllowedMutation(decision, request, requestDigest)
    })
    update.immediate()
    return { updated: true }
  })

  server.get('/api/v1/os/devices/self/push/vapid-key', (request, reply) => {
    const device = remoteRequestDevice(request)
    if (!device) return
    const decision = authorizeClassified({
      request, reply, operation: 'read.push-bootstrap',
      resource: verifiedResource('device', device.deviceSessionId),
    })
    if (!decision || !decision.allowed) return
    if (!options.vapidKeys) return reply.code(503).send({ error: 'secure push credentials are unavailable' })
    return projectAllowedFields(decision, { key: options.vapidKeys.publicKey })
  })

  server.post<{ Body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } }>(
    '/api/v1/os/devices/self/push/subscriptions',
    (request, reply) => {
      const device = remoteRequestDevice(request)
      if (!device) return
      try {
        const endpoint = validateWebPushEndpoint(
          bounded(request.body?.endpoint, 'push endpoint', 2_048),
        )
        const p256dh = bounded(request.body?.keys?.p256dh, 'push p256dh', 512)
        const auth = bounded(request.body?.keys?.auth, 'push auth', 256)
        if (!/^[A-Za-z0-9_-]+$/u.test(p256dh) || !/^[A-Za-z0-9_-]+$/u.test(auth)) {
          throw new Error('push keys are invalid')
        }
        const endpointHash = digest(endpoint)
        const requestDigest = digestRemoteMutation(JSON.stringify({ endpoint_hash: endpointHash }))
        const decision = authorizeClassified({
          request, reply, operation: 'push.subscribe',
          resource: verifiedResource('device', device.deviceSessionId), requestDigest,
        })
        if (!decision || !decision.allowed) return
        const update = options.db.transaction(() => {
          const subscribed = options.db.prepare(`INSERT INTO os_remote_push_subscriptions
            (id, device_session_id, endpoint, endpoint_hash, p256dh, auth, failures, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(endpoint_hash) DO UPDATE SET
              device_session_id=excluded.device_session_id, endpoint=excluded.endpoint,
              p256dh=excluded.p256dh, auth=excluded.auth, failures=0, updated_at=excluded.updated_at
            WHERE os_remote_push_subscriptions.device_session_id=excluded.device_session_id`)
            .run(randomUUID(), device.deviceSessionId, endpoint, endpointHash, p256dh, auth, nowIso(), nowIso())
          if (subscribed.changes !== 1) throw new Error('push endpoint belongs to another device')
          options.db.prepare(`INSERT INTO os_remote_notification_preferences
            (device_session_id, minimum_severity, quiet_start, quiet_end, preview, push_endpoint_hash, updated_at)
            VALUES (?, 'medium', '22:00', '07:00', 'generic', ?, ?)
            ON CONFLICT(device_session_id) DO UPDATE SET push_endpoint_hash=excluded.push_endpoint_hash,
              updated_at=excluded.updated_at`).run(device.deviceSessionId, endpointHash, nowIso())
          persistAllowedMutation(decision, request, requestDigest)
        })
        update.immediate()
        return reply.code(201).send({ subscribed: true })
      } catch (error) {
        if (!(error instanceof RemoteMutationAuditPersistenceError)) {
          persistInvalidMutation(
            request,
            device,
            'push.subscribe',
            verifiedResource('device', device.deviceSessionId),
          )
        }
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid push subscription' })
      }
    },
  )

  server.delete<{ Body: { endpoint?: string } }>('/api/v1/os/devices/self/push/subscriptions', (request, reply) => {
    const device = remoteRequestDevice(request)
    if (!device) return
    try {
      const endpointHash = digest(bounded(request.body?.endpoint, 'push endpoint', 2_048))
      const requestDigest = digestRemoteMutation(JSON.stringify({ endpoint_hash: endpointHash }))
      const decision = authorizeClassified({
        request, reply, operation: 'push.unsubscribe',
        resource: verifiedResource('device', device.deviceSessionId), requestDigest,
      })
      if (!decision || !decision.allowed) return
      const remove = options.db.transaction(() => {
        const result = options.db.prepare(`DELETE FROM os_remote_push_subscriptions
          WHERE device_session_id=? AND endpoint_hash=?`).run(device.deviceSessionId, endpointHash)
        options.db.prepare(`UPDATE os_remote_notification_preferences SET push_endpoint_hash=NULL, updated_at=?
          WHERE device_session_id=? AND push_endpoint_hash=?`).run(nowIso(), device.deviceSessionId, endpointHash)
        persistAllowedMutation(decision, request, requestDigest)
        return result.changes
      })
      return { unsubscribed: remove.immediate() > 0 }
    } catch (error) {
      if (!(error instanceof RemoteMutationAuditPersistenceError)) {
        persistInvalidMutation(
          request,
          device,
          'push.unsubscribe',
          verifiedResource('device', device.deviceSessionId),
        )
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid push subscription' })
    }
  })

  const enqueuePush = (deviceId: string, boardId: number | null, eventId: string): void => {
    recovery.enqueue({
      boardId,
      eventId,
      destination: 'remote-push-attention',
      dedupeKey: `${eventId}:${deviceId}`,
      payload: {
        device_session_id: deviceId,
        board_id: boardId,
        severity: 'medium',
      },
    })
  }
  const onRemoteAttention = (event: { id?: unknown; board_id?: unknown; type?: unknown }) => {
    if (!['review', 'message', 'attention'].includes(String(event?.type ?? ''))) return
    const boardId = Number(event.board_id)
    if (!Number.isSafeInteger(boardId) || boardId <= 0) return
    const eventId = typeof event.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(event.id)
      ? `remote-attention:${event.id}` : `remote-attention:${randomUUID()}`
    const devices = options.db.prepare(`SELECT DISTINCT session.id FROM os_device_sessions session
      JOIN os_device_credentials credential ON credential.device_session_id=session.id
      JOIN os_remote_resource_grants grant_row ON grant_row.device_session_id=session.id
      WHERE session.state='active' AND session.expires_at>?
        AND credential.state='active' AND credential.expires_at>?
        AND grant_row.resource_type='board' AND grant_row.resource_id=?`)
      .all(nowIso(), nowIso(), String(boardId)) as Array<{ id: string }>
    for (const device of devices) enqueuePush(device.id, boardId, eventId)
  }
  const onNoToolAnswer = (event: { id?: unknown }) => {
    const row = typeof event?.id === 'string'
      ? options.db.prepare('SELECT device_session_id FROM os_remote_messages WHERE id=?').get(event.id) as
        { device_session_id: string } | undefined
      : undefined
    if (row && typeof event.id === 'string') {
      enqueuePush(row.device_session_id, null, `remote-message-answered:${event.id}`)
    }
  }
  server.bus.on('event', onRemoteAttention)
  server.bus.on('remote-no-tool-message-answered', onNoToolAnswer)
  server.addHook('onClose', async () => {
    server.bus.off('event', onRemoteAttention)
    server.bus.off('remote-no-tool-message-answered', onNoToolAnswer)
  })

  server.get('/api/v1/os/remote/status', (request, reply) => {
    const device = remoteRequestDevice(request)
    let decision: Extract<RemoteAuthorizationDecision, { allowed: true }> | null = null
    if (request.orchestraPrincipal !== 'operator') {
      if (!device || !requireScope(request, reply, 'observe')) return
      const authorized = authorizeClassified({
        request, reply, operation: 'read.remote-status', resource: verifiedResource('tunnel', 'primary'),
      })
      if (!authorized || !authorized.allowed) return
      decision = authorized
    }
    const state = readRemoteState()
    const status = state
      ? { mode: state.provider === 'tailscale' ? 'private' : 'public', origin: state.url }
      : { mode: 'local' }
    return decision ? projectAllowedFields(decision, status) : status
  })

  server.get('/api/v1/os/remote/boards', (request, reply) => {
    const device = remoteRequestDevice(request)
    if (!device) return
    const boards = (options.db.prepare(`SELECT b.id, b.name,
      CASE WHEN EXISTS (SELECT 1 FROM cards c WHERE c.board_id=b.id AND c.column_name!='done')
        THEN 'active' ELSE 'clear' END AS status,
      (SELECT count(*) FROM messages m WHERE m.board_id=b.id AND m.kind='ask'
        AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to=m.id)) AS attention_count
      FROM boards b ORDER BY b.id`).all() as Array<Record<string, unknown>>)
      .filter((board) => hasBoardGrant(options.db, device.deviceSessionId, Number(board.id), 'read'))
      .flatMap((board) => {
        const decision = authorizeClassified({
          request, reply, operation: 'read.board-summary',
          resource: verifiedResource('board', String(board.id)),
        })
        return decision?.allowed ? [projectAllowedFields(decision, board)] : []
      })
    return { boards }
  })

  server.get<{ Querystring: { board_id?: string } }>('/api/v1/os/remote/agents', (request, reply) => {
    const device = remoteRequestDevice(request)
    if (!device) return
    const boardId = Number(request.query.board_id)
    if (!Number.isSafeInteger(boardId) || boardId <= 0
      || !hasBoardGrant(options.db, device.deviceSessionId, boardId, 'read')) {
      return reply.code(403).send({ error: 'board agent status is not authorized' })
    }
    const rows = options.db.prepare(`SELECT agent.id, agent.name, agent.status, agent.provider,
      (SELECT event.process_id FROM agent_sessions session
        JOIN os_events event ON event.session_id=session.id AND event.process_id IS NOT NULL
        JOIN processes process ON process.id=event.process_id
        WHERE session.agent_id=agent.id AND process.status IN ('starting','running')
        ORDER BY event.created_at DESC, event.id DESC LIMIT 1) AS process_id
      FROM agents agent WHERE agent.board_id=? ORDER BY agent.id`).all(boardId) as Array<Record<string, unknown>>
    return { agents: rows.flatMap((row) => {
      const decision = authorizeClassified({
        request,
        reply,
        operation: 'read.agent-status',
        resource: verifiedResource('agent', String(row.id)),
      })
      return decision?.allowed ? [projectAllowedFields(decision, row)] : []
    }) }
  })

  const agentControl = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    operation: 'agent.pause' | 'agent.stop',
  ) => {
    const agentId = Number(request.params.id)
    if (!Number.isSafeInteger(agentId) || agentId <= 0
      || !options.db.prepare('SELECT 1 FROM agents WHERE id=?').get(agentId)) {
      const device = remoteRequestDevice(request)
      if (device) persistInvalidMutation(request, device, operation, null)
      return reply.code(404).send({ error: 'agent is unavailable' })
    }
    if (!options.controls) return reply.code(503).send({ error: 'agent controls are unavailable' })
    try {
      const result = await executeRemoteMutation({
        request,
        reply,
        operation,
        resource: verifiedResource('agent', String(agentId)),
        canonicalRequest: JSON.stringify({ operation, agent_id: agentId }),
        effect: async () => {
          const applied = operation === 'agent.stop'
            ? await options.controls?.fire?.(agentId) ?? false
            : await options.controls!.interruptAgent(agentId)
          if (!applied) throw new Error('agent control was not applied')
          return true
        },
      })
      if (!result.executed) return reply
      return result.value ? { ok: true } : reply.code(409).send({ error: 'agent control was not applied' })
    } catch (error) {
      return reply.code(error instanceof RemoteAuthorizationError ? 403 : 503)
        .send({ error: error instanceof RemoteAuthorizationError
          ? 'remote authorization denied' : 'agent control failed' })
    }
  }

  server.post<{ Params: { id: string } }>('/api/v1/os/remote/agents/:id/pause', (request, reply) => (
    agentControl(request, reply, 'agent.pause')
  ))
  server.post<{ Params: { id: string } }>('/api/v1/os/remote/agents/:id/stop', (request, reply) => (
    agentControl(request, reply, 'agent.stop')
  ))

  server.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/v1/os/remote/processes/:id/terminal',
    (request, reply) => {
      const device = remoteRequestDevice(request)
      if (!device) return
      const process = options.db.prepare(`SELECT process.id, process.status,
        COALESCE(MAX(output.seq), 0) AS cursor, MAX(output.created_at) AS updated_at
        FROM processes process LEFT JOIN process_output output ON output.process_id=process.id
        WHERE process.id=? GROUP BY process.id`).get(request.params.id) as {
          id: string
          status: string
          cursor: number
          updated_at: string | null
        } | undefined
      if (!process) return reply.code(404).send({ error: 'process is unavailable' })
      const decision = authorizeClassified({
        request,
        reply,
        operation: 'read.terminal-view',
        resource: verifiedResource('process', process.id),
      })
      if (!decision?.allowed) return
      const after = Math.max(0, Number(request.query.after) || 0)
      const output = options.db.prepare(`SELECT seq, stream, data, created_at FROM process_output
        WHERE process_id=? AND seq>? ORDER BY seq ASC LIMIT 500`).all(process.id, after) as
        Array<{ seq: number; stream: string; data: string; created_at: string }>
      const redactedOutput = output.map((row) => ({
        seq: row.seq,
        stream: row.stream,
        data: redactOperationsValue(row.data).value,
        created_at: row.created_at,
      }))
      return projectAllowedFields(decision, {
        process_id: process.id,
        redacted_output: redactedOutput,
        cursor: output.at(-1)?.seq ?? after,
        updated_at: process.updated_at,
      })
    },
  )

  server.post<{ Params: { id: string }; Body: { data?: string } }>(
    '/api/v1/os/remote/processes/:id/terminal/input',
    async (request, reply) => {
      const device = remoteRequestDevice(request)
      if (!device) return
      const process = options.db.prepare('SELECT id FROM processes WHERE id=?').get(request.params.id) as
        { id: string } | undefined
      if (!process) {
        persistInvalidMutation(request, device, 'terminal.input', null)
        return reply.code(404).send({ error: 'process is unavailable' })
      }
      if (!options.runtime) return reply.code(503).send({ error: 'terminal runtime is unavailable' })
      const data = typeof request.body?.data === 'string' ? request.body.data : ''
      if (!data || Buffer.byteLength(data) > 64 * 1024) {
        persistInvalidMutation(request, device, 'terminal.input', verifiedResource('process', process.id))
        return reply.code(400).send({ error: 'terminal input is invalid' })
      }
      try {
        const result = await executeRemoteMutation({
          request,
          reply,
          operation: 'terminal.input',
          resource: verifiedResource('process', process.id),
          canonicalRequest: JSON.stringify({
            operation: 'terminal.input',
            process_id: process.id,
            input_digest: digest(data),
            byte_length: Buffer.byteLength(data),
          }),
          effect: () => options.runtime!.writeProcessInput(process.id, data),
        })
        if (!result.executed) return reply
        return { ok: true }
      } catch (error) {
        return reply.code(error instanceof RemoteAuthorizationError ? 403 : 503)
          .send({ error: error instanceof RemoteAuthorizationError
            ? 'remote authorization denied' : 'terminal input failed' })
      }
    },
  )

  server.get<{ Querystring: { board_id?: string } }>('/api/v1/os/remote/approvals', (request, reply) => {
    const device = remoteRequestDevice(request)
    if (!device) return
    const boardId = Number(request.query.board_id)
    if (!Number.isSafeInteger(boardId) || boardId <= 0
      || !hasBoardGrant(options.db, device.deviceSessionId, boardId, 'read')) {
      return reply.code(403).send({ error: 'approval queue is not authorized' })
    }
    const rows = options.db.prepare(`SELECT id, board_id, agent_id, severity, title, detail, created_at
      FROM attention_items WHERE board_id=? AND kind='permission.request' AND status='open'
      ORDER BY created_at, id LIMIT 100`).all(boardId) as Array<{
        id: string
        board_id: number
        agent_id: number | null
        severity: string
        title: string
        detail: string
        created_at: string
      }>
    return { approvals: rows.flatMap((row) => {
      const decision = authorizeClassified({
        request,
        reply,
        operation: 'read.approval-queue',
        resource: verifiedResource('approval', row.id),
      })
      if (!decision?.allowed) return []
      let tool = 'tool action'
      try {
        const detail = JSON.parse(row.detail) as { tool?: unknown }
        if (typeof detail.tool === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/u.test(detail.tool)) tool = detail.tool
      } catch { /* generic summary remains intentionally content-free */ }
      return [projectAllowedFields(decision, {
        id: row.id,
        agent_id: row.agent_id,
        board_id: row.board_id,
        severity: row.severity,
        summary: `Approval requested for ${tool}`,
        created_at: row.created_at,
      })]
    }) }
  })

  server.post<{ Params: { id: string }; Body: { decision?: string } }>(
    '/api/v1/os/remote/approvals/:id/decision',
    async (request, reply) => {
      const device = remoteRequestDevice(request)
      if (!device) return
      const approval = options.db.prepare(`SELECT id, agent_id, detail FROM attention_items
        WHERE id=? AND kind='permission.request' AND status='open'`).get(request.params.id) as {
          id: string
          agent_id: number | null
          detail: string
        } | undefined
      const decisionName = request.body?.decision
      if (!approval || !approval.agent_id
        || !['allow', 'allow_session', 'deny', 'cancel'].includes(String(decisionName))) {
        persistInvalidMutation(request, device, 'approval.deny', approval
          ? verifiedResource('approval', approval.id) : null)
        return reply.code(400).send({ error: 'approval decision is invalid' })
      }
      if (!options.controls?.resolveApproval) {
        return reply.code(503).send({ error: 'approval controls are unavailable' })
      }
      let providerRequestId = ''
      try {
        const detail = JSON.parse(approval.detail) as { request_id?: unknown }
        providerRequestId = bounded(detail.request_id, 'provider request id', 512)
      } catch {
        persistInvalidMutation(request, device, 'approval.deny', verifiedResource('approval', approval.id))
        return reply.code(409).send({ error: 'approval request is unavailable' })
      }
      const normalized = decisionName === 'allow_session' ? 'allow-session' : decisionName
      const operation = `approval.${normalized}` as
        'approval.allow' | 'approval.allow-session' | 'approval.deny' | 'approval.cancel'
      try {
        const result = await executeRemoteMutation({
          request,
          reply,
          operation,
          resource: verifiedResource('approval', approval.id),
          canonicalRequest: JSON.stringify({
            operation,
            approval_id: approval.id,
            decision: decisionName,
          }),
          effect: async () => {
            const applied = await options.controls!.resolveApproval!(
              approval.agent_id!, providerRequestId,
              decisionName as 'allow' | 'allow_session' | 'deny' | 'cancel',
            )
            if (!applied) throw new Error('approval request is no longer pending')
            return true
          },
        })
        if (!result.executed) return reply
        if (!result.value) return reply.code(409).send({ error: 'approval request is no longer pending' })
        options.db.prepare(`UPDATE attention_items SET status='resolved', resolved_at=?
          WHERE id=? AND status='open'`).run(nowIso(), approval.id)
        return { ok: true, decision: decisionName }
      } catch (error) {
        return reply.code(error instanceof RemoteAuthorizationError ? 403 : 503)
          .send({ error: error instanceof RemoteAuthorizationError
            ? 'remote authorization denied' : 'approval decision failed' })
      }
    },
  )

  server.get<{ Querystring: { board_id?: string } }>('/api/v1/os/remote/messages', (request, reply) => {
    const device = remoteRequestDevice(request)
    if (!device) return
    const boardId = Number(request.query.board_id)
    if (!Number.isSafeInteger(boardId) || !hasBoardGrant(options.db, device.deviceSessionId, boardId, 'read')) {
      return reply.code(403).send({ error: 'board discussion is not authorized' })
    }
    const decision = authorizeClassified({
      request, reply, operation: 'read.no-tool-messages',
      resource: verifiedResource('conversation', String(boardId)),
    })
    if (!decision || !decision.allowed) return
    const rows = options.db.prepare(`SELECT id, board_id, body, target_kind, created_at, status,
      response_body, answered_at FROM os_remote_messages
      WHERE board_id=? AND device_session_id=? ORDER BY created_at DESC, id DESC LIMIT 100`)
      .all(boardId, device.deviceSessionId) as Array<Record<string, unknown>>
    return { messages: rows.map((row) => projectAllowedFields(decision, row)) }
  })

  server.post<{ Body: { board_id?: number; body?: string } }>(
    '/api/v1/os/remote/messages',
    (request, reply) => {
      const device = remoteRequestDevice(request)
      if (!device) return
      const boardId = Number(request.body?.board_id)
      if (!Number.isSafeInteger(boardId) || boardId <= 0) {
        persistInvalidMutation(request, device, 'message.no-tool', null)
        return reply.code(400).send({ error: 'board mutation request is invalid' })
      }
      if (!hasBoardGrant(options.db, device.deviceSessionId, boardId, 'mutate')) {
        const denial = authorizationPolicy.authorize({
          operation: 'message.no-tool',
          principal: policyPrincipal(options.db, device),
          resource: verifiedResource('conversation', String(boardId)),
        })
        if (!denial.allowed) persistDeniedMutation(denial, request)
        return reply.code(403).send({ error: 'board mutation is not authorized' })
      }
      try {
        const idempotencyKey = bounded(request.headers['idempotency-key'], 'idempotency key', 128)
        const body = bounded(request.body?.body, 'message', 4_000)
        const requestDigest = digestRemoteMutation(JSON.stringify({ board_id: boardId, body }))
        const decision = authorizeClassified({
          request, reply, operation: 'message.no-tool',
          resource: verifiedResource('conversation', String(boardId)), requestDigest,
        })
        if (!decision || !decision.allowed) return
        let id: string = randomUUID()
        let created = false
        const create = options.db.transaction(() => {
          const existing = options.db.prepare(`SELECT id, request_digest FROM os_remote_messages
            WHERE device_session_id=? AND idempotency_key=?`).get(
            device.deviceSessionId, idempotencyKey,
          ) as { id: string; request_digest: string } | undefined
          if (existing) {
            if (existing.request_digest !== requestDigest) throw new Error('idempotency key conflicts with another request')
            id = existing.id
          } else {
            options.db.prepare(`INSERT INTO os_remote_messages
              (id, board_id, device_session_id, idempotency_key, request_digest, body,
               target_kind, created_at, status)
              VALUES (?, ?, ?, ?, ?, ?, 'no-tool', ?, 'pending')`)
              .run(id, boardId, device.deviceSessionId, idempotencyKey, requestDigest, body, nowIso())
            created = true
          }
          persistAllowedMutation(decision, request, requestDigest)
        })
        create.immediate()
        if (created) server.bus.emit('remote-no-tool-message', { id, board_id: boardId })
        return reply.code(created ? 201 : 200).send({ id, status: 'pending', target_kind: 'no-tool', replayed: !created })
      } catch (error) {
        if (!(error instanceof RemoteMutationAuditPersistenceError)) {
          persistInvalidMutation(
            request,
            device,
            'message.no-tool',
            verifiedResource('conversation', String(boardId)),
          )
        }
        const message = error instanceof Error ? error.message : 'invalid message'
        return reply.code(message.includes('idempotency key conflicts') ? 409 : 400).send({ error: message })
      }
    },
  )

  server.post<{ Params: { id: string }; Body: { body?: string } }>(
    '/api/v1/os/remote/messages/:id/reply',
    (request, reply) => {
      if (request.orchestraPrincipal !== 'operator') return reply.code(403).send({ error: 'local owner required' })
      try {
        const body = bounded(request.body?.body, 'reply', 4_000)
        const at = nowIso()
        const result = options.db.prepare(`UPDATE os_remote_messages
          SET status='answered', response_body=?, answered_at=?, answered_by='local-owner'
          WHERE id=? AND status='pending'`).run(body, at, request.params.id)
        if (result.changes !== 1) return reply.code(409).send({ error: 'message is unavailable' })
        server.bus.emit('remote-no-tool-message-answered', { id: request.params.id })
        return { id: request.params.id, status: 'answered' }
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid reply' })
      }
    },
  )
}

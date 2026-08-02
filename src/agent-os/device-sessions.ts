import {
  createHash,
  createPublicKey,
  randomBytes as secureRandomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import type Database from 'better-sqlite3'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors.js'

export const DEVICE_SCOPES = Object.freeze([
  'observe',
  'stream',
  'message',
  'approve',
  'agent-control',
  'terminal-write',
  'admin',
] as const)

export type DeviceScope = (typeof DEVICE_SCOPES)[number]

export const DEFAULT_PHONE_DEVICE_SCOPES: readonly DeviceScope[] = Object.freeze([
  'observe',
  'stream',
  'message',
  'approve',
])

export type PairingTicketState = 'pending' | 'consumed' | 'expired' | 'revoked'
export type DeviceSessionState =
  | 'pending_pairing'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'compromised'
export type DeviceCredentialState = 'active' | 'rotated' | 'expired' | 'revoked'

export interface DeviceLifecycleActor {
  type: string
  id: string | null
}

export interface DevicePublicKeyJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

/** Public ticket metadata. The digest and redeemable secret are deliberately absent. */
export interface PairingTicket {
  id: string
  expected_origin: string
  requested_scopes: DeviceScope[]
  state: PairingTicketState
  created_by_actor_type: string
  created_by_actor_id: string | null
  created_at: string
  expires_at: string
  consumed_at: string | null
  consumed_session_id: string | null
  revoked_at: string | null
  revocation_reason: string | null
}

export interface DeviceSession {
  id: string
  name: string
  state: DeviceSessionState
  scopes: DeviceScope[]
  public_key_thumbprint: string
  created_from_ticket_id: string
  created_by_actor_type: string
  created_by_actor_id: string | null
  created_at: string
  activated_at: string | null
  expires_at: string
  last_seen_at: string | null
  rotation_counter: number
  revocation_version: number
  revoked_at: string | null
  revocation_reason: string | null
}

/** Public credential inventory. The digest and bearer secret are deliberately absent. */
export interface DeviceCredential {
  id: string
  device_session_id: string
  public_key_thumbprint: string
  state: DeviceCredentialState
  rotation_generation: number
  rotated_from_id: string | null
  issued_at: string
  expires_at: string
  last_used_at: string | null
  terminal_at: string | null
  terminal_reason: string | null
}

/**
 * Secret-bearing one-time result. Callers must return it directly to the intended
 * peer and must never put it in logs, analytics, referrers, push payloads, or durable UI state.
 */
export interface PairingTicketIssue {
  pairing_ticket: string
  ticket: PairingTicket
}

/**
 * Secret-bearing one-time credential result. Normal API use belongs in an
 * Authorization header plus verified key proof, never a URL or query parameter.
 */
export interface DeviceCredentialIssue {
  credential: string
  credential_metadata: DeviceCredential
}

export interface PairingRedemption {
  device_session: DeviceSession
  credential_issue: DeviceCredentialIssue
}

export interface DevicePrincipal {
  kind: 'device_session'
  device_session_id: string
  credential_id: string
  scopes: DeviceScope[]
  public_key_thumbprint: string
  /** Internal authorization material; API serializers must not expose it as credential state. */
  public_key_jwk: DevicePublicKeyJwk
  session_expires_at: string
  credential_expires_at: string
  rotation_generation: number
}

export interface DeviceSessionRevocation {
  device_session: DeviceSession
  revoked_credential_ids: string[]
  revoked_at: string
  revocation_version: number
}

export interface DeviceExpirySweep {
  pairing_tickets: number
  device_sessions: number
  device_credentials: number
  expired_at: string
}

export interface CreatePairingTicketInput {
  expectedOrigin: string
  actor: DeviceLifecycleActor
  requestedScopes?: readonly DeviceScope[]
  expiresInSeconds?: number
  deviceSessionTtlSeconds?: number
  credentialTtlSeconds?: number
}

export interface RedeemPairingTicketInput {
  pairingTicket: string
  origin: string
  deviceName: string
  devicePublicKeyJwk: DevicePublicKeyJwk
}

export interface VerifyDeviceCredentialInput {
  credential: string
  /** Exact request/challenge payload constructed by the server authorization boundary. */
  proofPayload: string
  /** Browser WebCrypto P-256/SHA-256 signature in base64url IEEE-P1363 form. */
  proofSignature: string
  requiredScopes?: readonly DeviceScope[]
}

export interface RotateDeviceCredentialInput {
  deviceSessionId: string
  currentCredentialId: string
  /** Exact rotation challenge constructed by the server authorization boundary. */
  proofPayload: string
  proofSignature: string
  actor: DeviceLifecycleActor
  newPublicKeyJwk?: DevicePublicKeyJwk
  expiresInSeconds?: number
}

export interface RevokeDeviceSessionInput {
  reason: string
  actor: DeviceLifecycleActor
  compromised?: boolean
}

export interface RevokeDeviceCredentialInput {
  reason: string
  actor: DeviceLifecycleActor
}

export interface DeviceSessionRepository {
  createPairingTicket(input: CreatePairingTicketInput): PairingTicketIssue
  redeemPairingTicket(input: RedeemPairingTicketInput): PairingRedemption
  revokePairingTicket(id: string, input: RevokeDeviceCredentialInput): PairingTicket
  getPairingTicket(id: string): PairingTicket | null
  getDeviceSession(id: string): DeviceSession | null
  listDeviceSessions(): DeviceSession[]
  listDeviceCredentials(deviceSessionId: string): DeviceCredential[]
  verifyDeviceCredential(input: VerifyDeviceCredentialInput): DevicePrincipal
  rotateDeviceCredential(input: RotateDeviceCredentialInput): DeviceCredentialIssue
  revokeDeviceCredential(id: string, input: RevokeDeviceCredentialInput): DeviceCredential
  revokeDeviceSession(id: string, input: RevokeDeviceSessionInput): DeviceSessionRevocation
  expireDueArtifacts(): DeviceExpirySweep
}

export interface DeviceSessionRepositoryOptions {
  now?: () => Date
  randomBytes?: (size: number) => Buffer
  randomId?: () => string
  pairingTicketTtlSeconds?: number
  deviceSessionTtlSeconds?: number
  credentialTtlSeconds?: number
}

interface PairingTicketRow extends Record<string, unknown> {
  id: string
  secret_hash: string
  expected_origin: string
  requested_scopes_json: string
  session_ttl_seconds: number
  credential_ttl_seconds: number
  state: PairingTicketState
  created_by_actor_type: string
  created_by_actor_id: string | null
  created_at: string
  expires_at: string
  consumed_at: string | null
  consumed_session_id: string | null
  revoked_at: string | null
  revocation_reason: string | null
}

interface DeviceSessionRow extends Record<string, unknown> {
  id: string
  name: string
  state: DeviceSessionState
  scopes_json: string
  public_key_thumbprint: string
  public_key_jwk_json: string
  created_from_ticket_id: string
  created_by_actor_type: string
  created_by_actor_id: string | null
  created_at: string
  activated_at: string | null
  expires_at: string
  last_seen_at: string | null
  rotation_counter: number
  revocation_version: number
  revoked_at: string | null
  revocation_reason: string | null
}

interface DeviceCredentialRow extends Record<string, unknown> {
  id: string
  device_session_id: string
  secret_hash: string
  public_key_thumbprint: string
  public_key_jwk_json: string
  state: DeviceCredentialState
  rotation_generation: number
  rotated_from_id: string | null
  issued_at: string
  expires_at: string
  last_used_at: string | null
  terminal_at: string | null
  terminal_reason: string | null
}

const PAIRING_TICKET_PREFIX = 'orchestra_pair_v1'
const DEVICE_CREDENTIAL_PREFIX = 'orchestra_device_v1'
const SECRET_BYTES = 32
const DEFAULT_PAIRING_TTL_SECONDS = 300
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const DEFAULT_CREDENTIAL_TTL_SECONDS = 15 * 60
const MAX_PAIRING_TTL_SECONDS = 10 * 60
const MAX_SESSION_TTL_SECONDS = 90 * 24 * 60 * 60
const MAX_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60
const MIN_SESSION_TTL_SECONDS = 60
const MIN_CREDENTIAL_TTL_SECONDS = 30
const INVALID_HASH = '0'.repeat(64)
const SCOPE_SET = new Set<string>(DEVICE_SCOPES)
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

interface CanonicalDevicePublicKey {
  jwk: DevicePublicKeyJwk
  canonicalJson: string
  thumbprint: string
}

export class SqliteDeviceSessionRepository implements DeviceSessionRepository {
  private readonly now: () => Date
  private readonly randomBytes: (size: number) => Buffer
  private readonly randomId: () => string
  private readonly pairingTicketTtlSeconds: number
  private readonly deviceSessionTtlSeconds: number
  private readonly credentialTtlSeconds: number

  constructor(
    private readonly db: Database.Database,
    options: DeviceSessionRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomBytes = options.randomBytes ?? secureRandomBytes
    this.randomId = options.randomId ?? randomUUID
    this.pairingTicketTtlSeconds = ttl(
      options.pairingTicketTtlSeconds ?? DEFAULT_PAIRING_TTL_SECONDS,
      'pairing ticket TTL',
      1,
      MAX_PAIRING_TTL_SECONDS,
    )
    this.deviceSessionTtlSeconds = ttl(
      options.deviceSessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
      'device session TTL',
      MIN_SESSION_TTL_SECONDS,
      MAX_SESSION_TTL_SECONDS,
    )
    this.credentialTtlSeconds = ttl(
      options.credentialTtlSeconds ?? DEFAULT_CREDENTIAL_TTL_SECONDS,
      'device credential TTL',
      MIN_CREDENTIAL_TTL_SECONDS,
      MAX_CREDENTIAL_TTL_SECONDS,
    )
  }

  createPairingTicket(input: CreatePairingTicketInput): PairingTicketIssue {
    const expectedOrigin = origin(input.expectedOrigin)
    const actor = lifecycleActor(input.actor)
    const requestedScopes = scopes(input.requestedScopes ?? DEFAULT_PHONE_DEVICE_SCOPES)
    const pairingTtl = ttl(
      input.expiresInSeconds ?? this.pairingTicketTtlSeconds,
      'pairing ticket TTL',
      1,
      MAX_PAIRING_TTL_SECONDS,
    )
    const sessionTtl = ttl(
      input.deviceSessionTtlSeconds ?? this.deviceSessionTtlSeconds,
      'device session TTL',
      MIN_SESSION_TTL_SECONDS,
      MAX_SESSION_TTL_SECONDS,
    )
    const credentialTtl = ttl(
      input.credentialTtlSeconds ?? this.credentialTtlSeconds,
      'device credential TTL',
      MIN_CREDENTIAL_TTL_SECONDS,
      MAX_CREDENTIAL_TTL_SECONDS,
    )
    const id = this.randomId()
    const secret = this.secret()
    const pairingTicket = serializeSecret(PAIRING_TICKET_PREFIX, id, secret)
    const createdAt = this.timestamp()
    const expiresAt = addSeconds(createdAt, pairingTtl)

    this.db.prepare(`INSERT INTO os_pairing_tickets (
      id, secret_hash, expected_origin, requested_scopes_json,
      session_ttl_seconds, credential_ttl_seconds, state,
      created_by_actor_type, created_by_actor_id, created_at, expires_at,
      consumed_at, consumed_session_id, revoked_at, revocation_reason,
      revoked_by_actor_type, revoked_by_actor_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`)
      .run(
        id,
        secretHash('pairing-ticket', id, secret),
        expectedOrigin,
        JSON.stringify(requestedScopes),
        sessionTtl,
        credentialTtl,
        actor.type,
        actor.id,
        createdAt,
        expiresAt,
      )
    return { pairing_ticket: pairingTicket, ticket: this.requirePairingTicket(id) }
  }

  redeemPairingTicket(input: RedeemPairingTicketInput): PairingRedemption {
    const parsed = parseSecret(input.pairingTicket, PAIRING_TICKET_PREFIX)
    const redeemOrigin = origin(input.origin)
    const deviceName = label(input.deviceName, 'device name', 120)
    const deviceKey = publicKey(input.devicePublicKeyJwk)
    const at = this.timestamp()

    if (!parsed) throw invalidPairingTicket()
    const redeem = this.db.transaction(() => {
      this.expireDueNow(at)
      const ticket = this.pairingTicketRow(parsed.id)
      const suppliedHash = secretHash('pairing-ticket', parsed.id, parsed.secret)
      if (
        !safeHashEqual(ticket?.secret_hash ?? INVALID_HASH, suppliedHash)
        || ticket?.state !== 'pending'
        || ticket.expected_origin !== redeemOrigin
        || ticket.expires_at <= at
      ) {
        throw invalidPairingTicket()
      }

      const deviceSessionId = this.randomId()
      const credentialId = this.randomId()
      const credentialSecret = this.secret()
      const sessionExpiresAt = addSeconds(at, ticket.session_ttl_seconds)
      const credentialExpiresAt = addSeconds(at, ticket.credential_ttl_seconds)
      this.db.prepare(`INSERT INTO os_device_sessions (
        id, name, state, scopes_json, public_key_thumbprint, public_key_jwk_json,
        created_from_ticket_id, created_by_actor_type, created_by_actor_id,
        created_at, activated_at, expires_at, last_seen_at,
        rotation_counter, revocation_version, revoked_at, revocation_reason,
        revoked_by_actor_type, revoked_by_actor_id
      ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, NULL)`)
        .run(
          deviceSessionId,
          deviceName,
          ticket.requested_scopes_json,
          deviceKey.thumbprint,
          deviceKey.canonicalJson,
          ticket.id,
          ticket.created_by_actor_type,
          ticket.created_by_actor_id,
          at,
          at,
          sessionExpiresAt,
          at,
        )
      this.insertCredential({
        id: credentialId,
        deviceSessionId,
        secret: credentialSecret,
        publicKey: deviceKey,
        generation: 0,
        rotatedFromId: null,
        issuedAt: at,
        expiresAt: credentialExpiresAt,
      })
      const consumed = this.db.prepare(`UPDATE os_pairing_tickets
        SET state='consumed', consumed_at=?, consumed_session_id=?
        WHERE id=? AND state='pending' AND expires_at>?`)
        .run(at, deviceSessionId, ticket.id, at)
      if (consumed.changes !== 1) throw invalidPairingTicket()

      return {
        device_session: this.requireDeviceSession(deviceSessionId),
        credential_issue: {
          credential: serializeSecret(DEVICE_CREDENTIAL_PREFIX, credentialId, credentialSecret),
          credential_metadata: this.requireCredential(credentialId),
        },
      }
    })
    return redeem.immediate()
  }

  revokePairingTicket(id: string, input: RevokeDeviceCredentialInput): PairingTicket {
    const ticketId = identifier(id, 'pairing ticket id')
    const reason = label(input.reason, 'revocation reason', 500)
    const actor = lifecycleActor(input.actor)
    const at = this.timestamp()
    const revoke = this.db.transaction(() => {
      this.expireDueNow(at)
      const current = this.pairingTicketRow(ticketId)
      if (!current) throw new NotFoundError('pairing ticket not found')
      if (current.state === 'revoked') return this.requirePairingTicket(ticketId)
      if (current.state !== 'pending') throw new ConflictError('pairing ticket is no longer revocable')
      this.db.prepare(`UPDATE os_pairing_tickets SET
        state='revoked', revoked_at=?, revocation_reason=?,
        revoked_by_actor_type=?, revoked_by_actor_id=?
        WHERE id=? AND state='pending'`)
        .run(at, reason, actor.type, actor.id, ticketId)
      return this.requirePairingTicket(ticketId)
    })
    return revoke.immediate()
  }

  getPairingTicket(id: string): PairingTicket | null {
    this.expireDueArtifacts()
    const row = this.pairingTicketRow(identifier(id, 'pairing ticket id'))
    return row ? mapPairingTicket(row, this.timestamp()) : null
  }

  getDeviceSession(id: string): DeviceSession | null {
    this.expireDueArtifacts()
    const row = this.deviceSessionRow(identifier(id, 'device session id'))
    return row ? mapDeviceSession(row, this.timestamp()) : null
  }

  listDeviceSessions(): DeviceSession[] {
    this.expireDueArtifacts()
    const at = this.timestamp()
    return (this.db.prepare(`SELECT * FROM os_device_sessions
      ORDER BY state='active' DESC, last_seen_at DESC, created_at DESC`).all() as DeviceSessionRow[])
      .map((row) => mapDeviceSession(row, at))
  }

  listDeviceCredentials(deviceSessionId: string): DeviceCredential[] {
    this.expireDueArtifacts()
    const sessionId = identifier(deviceSessionId, 'device session id')
    if (!this.deviceSessionRow(sessionId)) throw new NotFoundError('device session not found')
    const at = this.timestamp()
    return (this.db.prepare(`SELECT * FROM os_device_credentials
      WHERE device_session_id=? ORDER BY rotation_generation DESC, issued_at DESC`)
      .all(sessionId) as DeviceCredentialRow[])
      .map((row) => mapDeviceCredential(row, at))
  }

  verifyDeviceCredential(input: VerifyDeviceCredentialInput): DevicePrincipal {
    const parsed = parseSecret(input.credential, DEVICE_CREDENTIAL_PREFIX)
    const proofPayload = boundedProofPayload(input.proofPayload)
    const proofSignature = proofSignatureBytes(input.proofSignature)
    const requiredScopes = input.requiredScopes === undefined ? [] : scopes(input.requiredScopes, true)
    const at = this.timestamp()
    if (!parsed) throw invalidDeviceCredential()
    const verify = this.db.transaction(() => {
      this.expireDueNow(at)
      const credential = this.credentialRow(parsed.id)
      const suppliedHash = secretHash('device-credential', parsed.id, parsed.secret)
      if (!safeHashEqual(credential?.secret_hash ?? INVALID_HASH, suppliedHash)) {
        throw invalidDeviceCredential()
      }
      const session = credential ? this.deviceSessionRow(credential.device_session_id) : null
      if (
        !credential
        || !session
        || credential.state !== 'active'
        || session.state !== 'active'
        || credential.public_key_thumbprint !== session.public_key_thumbprint
        || credential.public_key_jwk_json !== session.public_key_jwk_json
      ) {
        throw invalidDeviceCredential()
      }
      const storedKey = storedPublicKey(session.public_key_jwk_json, session.public_key_thumbprint)
      if (!verifyDeviceProof(storedKey.jwk, proofPayload, proofSignature)) {
        throw invalidDeviceCredential()
      }
      const grantedScopes = parseScopes(session.scopes_json)
      if (requiredScopes.some((scope) => !grantedScopes.includes(scope))) {
        throw new ForbiddenError('device scope is not authorized')
      }
      const credentialUpdate = this.db.prepare(`UPDATE os_device_credentials SET last_used_at=?
        WHERE id=? AND state='active' AND expires_at>?`).run(at, credential.id, at)
      const sessionUpdate = this.db.prepare(`UPDATE os_device_sessions SET last_seen_at=?
        WHERE id=? AND state='active' AND expires_at>?`).run(at, session.id, at)
      if (credentialUpdate.changes !== 1 || sessionUpdate.changes !== 1) {
        throw invalidDeviceCredential()
      }
      return {
        kind: 'device_session' as const,
        device_session_id: session.id,
        credential_id: credential.id,
        scopes: grantedScopes,
        public_key_thumbprint: session.public_key_thumbprint,
        public_key_jwk: storedKey.jwk,
        session_expires_at: session.expires_at,
        credential_expires_at: credential.expires_at,
        rotation_generation: credential.rotation_generation,
      }
    })
    return verify.immediate()
  }

  rotateDeviceCredential(input: RotateDeviceCredentialInput): DeviceCredentialIssue {
    const sessionId = identifier(input.deviceSessionId, 'device session id')
    const credentialId = identifier(input.currentCredentialId, 'device credential id')
    const proofPayload = boundedProofPayload(input.proofPayload)
    const proofSignature = proofSignatureBytes(input.proofSignature)
    const requestedNextKey = input.newPublicKeyJwk === undefined
      ? null
      : publicKey(input.newPublicKeyJwk)
    const actor = lifecycleActor(input.actor)
    const credentialTtl = ttl(
      input.expiresInSeconds ?? this.credentialTtlSeconds,
      'device credential TTL',
      MIN_CREDENTIAL_TTL_SECONDS,
      MAX_CREDENTIAL_TTL_SECONDS,
    )
    const at = this.timestamp()
    const rotate = this.db.transaction(() => {
      this.expireDueNow(at)
      const session = this.deviceSessionRow(sessionId)
      const current = this.credentialRow(credentialId)
      if (
        !session
        || !current
        || current.device_session_id !== session.id
        || session.state !== 'active'
        || current.state !== 'active'
        || current.public_key_thumbprint !== session.public_key_thumbprint
        || current.public_key_jwk_json !== session.public_key_jwk_json
      ) {
        throw invalidDeviceCredential()
      }
      const currentKey = storedPublicKey(session.public_key_jwk_json, session.public_key_thumbprint)
      if (!verifyDeviceProof(currentKey.jwk, proofPayload, proofSignature)) {
        throw invalidDeviceCredential()
      }
      const nextKey = requestedNextKey ?? currentKey
      const terminal = this.db.prepare(`UPDATE os_device_credentials SET
        state='rotated', terminal_at=?, terminal_reason='credential rotated',
        terminal_by_actor_type=?, terminal_by_actor_id=?
        WHERE id=? AND state='active' AND expires_at>?`)
        .run(at, actor.type, actor.id, current.id, at)
      if (terminal.changes !== 1) throw invalidDeviceCredential()

      const nextId = this.randomId()
      const nextSecret = this.secret()
      this.insertCredential({
        id: nextId,
        deviceSessionId: session.id,
        secret: nextSecret,
        publicKey: nextKey,
        generation: current.rotation_generation + 1,
        rotatedFromId: current.id,
        issuedAt: at,
        expiresAt: addSeconds(at, credentialTtl),
      })
      this.db.prepare(`UPDATE os_device_sessions SET
        public_key_thumbprint=?, public_key_jwk_json=?,
        rotation_counter=rotation_counter+1, last_seen_at=?
        WHERE id=?`).run(nextKey.thumbprint, nextKey.canonicalJson, at, session.id)
      return {
        credential: serializeSecret(DEVICE_CREDENTIAL_PREFIX, nextId, nextSecret),
        credential_metadata: this.requireCredential(nextId),
      }
    })
    return rotate.immediate()
  }

  revokeDeviceCredential(id: string, input: RevokeDeviceCredentialInput): DeviceCredential {
    const credentialId = identifier(id, 'device credential id')
    const reason = label(input.reason, 'revocation reason', 500)
    const actor = lifecycleActor(input.actor)
    const at = this.timestamp()
    const revoke = this.db.transaction(() => {
      this.expireDueNow(at)
      const current = this.credentialRow(credentialId)
      if (!current) throw new NotFoundError('device credential not found')
      if (current.state !== 'active') return mapDeviceCredential(current, at)
      this.db.prepare(`UPDATE os_device_credentials SET
        state='revoked', terminal_at=?, terminal_reason=?,
        terminal_by_actor_type=?, terminal_by_actor_id=?
        WHERE id=? AND state='active'`)
        .run(at, reason, actor.type, actor.id, credentialId)
      return this.requireCredential(credentialId)
    })
    return revoke.immediate()
  }

  revokeDeviceSession(id: string, input: RevokeDeviceSessionInput): DeviceSessionRevocation {
    const sessionId = identifier(id, 'device session id')
    const reason = label(input.reason, 'revocation reason', 500)
    const actor = lifecycleActor(input.actor)
    const at = this.timestamp()
    const targetState: DeviceSessionState = input.compromised ? 'compromised' : 'revoked'
    const revoke = this.db.transaction(() => {
      this.expireDueNow(at)
      const current = this.deviceSessionRow(sessionId)
      if (!current) throw new NotFoundError('device session not found')
      if (current.state === 'revoked' || current.state === 'compromised') {
        return {
          device_session: mapDeviceSession(current, at),
          revoked_credential_ids: [],
          revoked_at: current.revoked_at ?? at,
          revocation_version: current.revocation_version,
        }
      }
      if (current.state === 'expired') throw new ConflictError('expired device session is terminal')
      const activeCredentials = this.db.prepare(`SELECT id FROM os_device_credentials
        WHERE device_session_id=? AND state='active' ORDER BY id`).all(sessionId) as Array<{ id: string }>
      this.db.prepare(`UPDATE os_device_credentials SET
        state='revoked', terminal_at=?, terminal_reason=?,
        terminal_by_actor_type=?, terminal_by_actor_id=?
        WHERE device_session_id=? AND state='active'`)
        .run(at, reason, actor.type, actor.id, sessionId)
      const update = this.db.prepare(`UPDATE os_device_sessions SET
        state=?, revocation_version=revocation_version+1,
        revoked_at=?, revocation_reason=?, revoked_by_actor_type=?, revoked_by_actor_id=?
        WHERE id=? AND state IN ('pending_pairing', 'active')`)
        .run(targetState, at, reason, actor.type, actor.id, sessionId)
      if (update.changes !== 1) throw new ConflictError('device session is no longer revocable')
      const deviceSession = this.requireDeviceSession(sessionId)
      return {
        device_session: deviceSession,
        revoked_credential_ids: activeCredentials.map((row) => row.id),
        revoked_at: at,
        revocation_version: deviceSession.revocation_version,
      }
    })
    return revoke.immediate()
  }

  expireDueArtifacts(): DeviceExpirySweep {
    const at = this.timestamp()
    const expire = this.db.transaction(() => this.expireDueNow(at))
    return expire.immediate()
  }

  private expireDueNow(at: string): DeviceExpirySweep {
    const pairingTickets = this.db.prepare(`UPDATE os_pairing_tickets SET state='expired'
      WHERE state='pending' AND expires_at<=?`).run(at).changes
    const credentials = this.db.prepare(`UPDATE os_device_credentials SET
      state='expired', terminal_at=?, terminal_reason=CASE
        WHEN expires_at<=? THEN 'credential expired' ELSE 'device session expired' END,
      terminal_by_actor_type='system', terminal_by_actor_id='device-expiry-sweep'
      WHERE state='active' AND (
        expires_at<=?
        OR EXISTS (
          SELECT 1 FROM os_device_sessions session
          WHERE session.id=os_device_credentials.device_session_id
            AND session.state='active' AND session.expires_at<=?
        )
      )`).run(at, at, at, at).changes
    const sessions = this.db.prepare(`UPDATE os_device_sessions SET state='expired'
      WHERE state='active' AND expires_at<=?`).run(at).changes
    return {
      pairing_tickets: pairingTickets,
      device_sessions: sessions,
      device_credentials: credentials,
      expired_at: at,
    }
  }

  private insertCredential(input: {
    id: string
    deviceSessionId: string
    secret: string
    publicKey: CanonicalDevicePublicKey
    generation: number
    rotatedFromId: string | null
    issuedAt: string
    expiresAt: string
  }): void {
    this.db.prepare(`INSERT INTO os_device_credentials (
      id, device_session_id, secret_hash, public_key_thumbprint, public_key_jwk_json,
      state, rotation_generation, rotated_from_id, issued_at, expires_at,
      last_used_at, terminal_at, terminal_reason, terminal_by_actor_type, terminal_by_actor_id
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`)
      .run(
        input.id,
        input.deviceSessionId,
        secretHash('device-credential', input.id, input.secret),
        input.publicKey.thumbprint,
        input.publicKey.canonicalJson,
        input.generation,
        input.rotatedFromId,
        input.issuedAt,
        input.expiresAt,
      )
  }

  private pairingTicketRow(id: string): PairingTicketRow | null {
    const row = this.db.prepare('SELECT * FROM os_pairing_tickets WHERE id=?').get(id) as
      PairingTicketRow | undefined
    return row ?? null
  }

  private deviceSessionRow(id: string): DeviceSessionRow | null {
    const row = this.db.prepare('SELECT * FROM os_device_sessions WHERE id=?').get(id) as
      DeviceSessionRow | undefined
    return row ?? null
  }

  private credentialRow(id: string): DeviceCredentialRow | null {
    const row = this.db.prepare('SELECT * FROM os_device_credentials WHERE id=?').get(id) as
      DeviceCredentialRow | undefined
    return row ?? null
  }

  private requirePairingTicket(id: string): PairingTicket {
    const row = this.pairingTicketRow(id)
    if (!row) throw new NotFoundError('pairing ticket not found')
    return mapPairingTicket(row, this.timestamp())
  }

  private requireDeviceSession(id: string): DeviceSession {
    const row = this.deviceSessionRow(id)
    if (!row) throw new NotFoundError('device session not found')
    return mapDeviceSession(row, this.timestamp())
  }

  private requireCredential(id: string): DeviceCredential {
    const row = this.credentialRow(id)
    if (!row) throw new NotFoundError('device credential not found')
    return mapDeviceCredential(row, this.timestamp())
  }

  private secret(): string {
    const bytes = this.randomBytes(SECRET_BYTES)
    if (!Buffer.isBuffer(bytes) || bytes.length !== SECRET_BYTES) {
      throw new Error('secure random source returned an invalid secret')
    }
    return bytes.toString('base64url')
  }

  private timestamp(): string {
    const value = this.now()
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error('device session clock returned an invalid date')
    }
    return value.toISOString()
  }
}

function mapPairingTicket(row: PairingTicketRow, at: string): PairingTicket {
  return {
    id: row.id,
    expected_origin: row.expected_origin,
    requested_scopes: parseScopes(row.requested_scopes_json),
    state: row.state === 'pending' && row.expires_at <= at ? 'expired' : row.state,
    created_by_actor_type: row.created_by_actor_type,
    created_by_actor_id: row.created_by_actor_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    consumed_session_id: row.consumed_session_id,
    revoked_at: row.revoked_at,
    revocation_reason: row.revocation_reason,
  }
}

function mapDeviceSession(row: DeviceSessionRow, at: string): DeviceSession {
  return {
    id: row.id,
    name: row.name,
    state: row.state === 'active' && row.expires_at <= at ? 'expired' : row.state,
    scopes: parseScopes(row.scopes_json),
    public_key_thumbprint: row.public_key_thumbprint,
    created_from_ticket_id: row.created_from_ticket_id,
    created_by_actor_type: row.created_by_actor_type,
    created_by_actor_id: row.created_by_actor_id,
    created_at: row.created_at,
    activated_at: row.activated_at,
    expires_at: row.expires_at,
    last_seen_at: row.last_seen_at,
    rotation_counter: row.rotation_counter,
    revocation_version: row.revocation_version,
    revoked_at: row.revoked_at,
    revocation_reason: row.revocation_reason,
  }
}

function mapDeviceCredential(row: DeviceCredentialRow, at: string): DeviceCredential {
  return {
    id: row.id,
    device_session_id: row.device_session_id,
    public_key_thumbprint: row.public_key_thumbprint,
    state: row.state === 'active' && row.expires_at <= at ? 'expired' : row.state,
    rotation_generation: row.rotation_generation,
    rotated_from_id: row.rotated_from_id,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    terminal_at: row.terminal_at,
    terminal_reason: row.terminal_reason,
  }
}

function scopes(value: readonly DeviceScope[], allowEmpty = false): DeviceScope[] {
  if (!Array.isArray(value)) throw new ValidationError('device scopes must be an array')
  const normalized = [...new Set(value)]
  if (!allowEmpty && normalized.length === 0) throw new ValidationError('at least one device scope is required')
  if (normalized.some((scope) => !SCOPE_SET.has(scope))) {
    throw new ValidationError('device scopes contain an unsupported value')
  }
  return DEVICE_SCOPES.filter((scope) => normalized.includes(scope))
}

function parseScopes(value: string): DeviceScope[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== 'string')) {
      throw new Error('invalid')
    }
    return scopes(parsed as DeviceScope[])
  } catch {
    throw new Error('stored device scopes are invalid')
  }
}

function lifecycleActor(value: DeviceLifecycleActor): DeviceLifecycleActor {
  if (!value || typeof value !== 'object') throw new ValidationError('actor is required')
  return {
    type: label(value.type, 'actor type', 64),
    id: value.id === null ? null : label(value.id, 'actor id', 256),
  }
}

function identifier(value: string, field: string): string {
  return label(value, field, 200)
}

function label(value: string, field: string, max: number): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} is required`)
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ValidationError(`${field} must be between 1 and ${max} printable characters`)
  }
  return normalized
}

function publicKey(value: DevicePublicKeyJwk): CanonicalDevicePublicKey {
  if (
    !value
    || typeof value !== 'object'
    || value.kty !== 'EC'
    || value.crv !== 'P-256'
    || !base64UrlCoordinate(value.x)
    || !base64UrlCoordinate(value.y)
  ) {
    throw new ValidationError('device public key must be a valid P-256 JWK')
  }
  const jwk: DevicePublicKeyJwk = { kty: 'EC', crv: 'P-256', x: value.x, y: value.y }
  try {
    createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' })
  } catch {
    throw new ValidationError('device public key must be a valid P-256 JWK')
  }
  const canonicalJson = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  const thumbprint = createHash('sha256').update(canonicalJson, 'utf8').digest('base64url')
  return { jwk, canonicalJson, thumbprint }
}

function storedPublicKey(value: string, expectedThumbprint: string): CanonicalDevicePublicKey {
  try {
    const parsed = JSON.parse(value) as DevicePublicKeyJwk
    const normalized = publicKey(parsed)
    if (normalized.canonicalJson !== value || normalized.thumbprint !== expectedThumbprint) {
      throw new Error('mismatch')
    }
    return normalized
  } catch {
    throw invalidDeviceCredential()
  }
}

function base64UrlCoordinate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return false
  try {
    return Buffer.from(value, 'base64url').length === 32
  } catch {
    return false
  }
}

function boundedProofPayload(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) {
    throw new ValidationError('device proof payload must be between 1 and 4096 characters')
  }
  return value
}

function proofSignatureBytes(value: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(value)) {
    throw invalidDeviceCredential()
  }
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 64) throw invalidDeviceCredential()
  return bytes
}

function verifyDeviceProof(
  jwk: DevicePublicKeyJwk,
  payload: string,
  signature: Buffer,
): boolean {
  try {
    const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' })
    return verifySignature(
      'sha256',
      Buffer.from(payload, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      signature,
    )
  } catch {
    return false
  }
}

function origin(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('expected origin is required')
  }
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new ValidationError('expected origin is invalid')
  }
  if (
    parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || !(
      parsed.protocol === 'https:'
      || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))
    )
  ) {
    throw new ValidationError('expected origin must be an HTTPS origin or loopback HTTP origin')
  }
  return parsed.origin
}

function ttl(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max} seconds`)
  }
  return value
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1000).toISOString()
}

function serializeSecret(prefix: string, id: string, secret: string): string {
  return `${prefix}.${id}.${secret}`
}

function parseSecret(
  value: string,
  expectedPrefix: string,
): { id: string; secret: string } | null {
  if (typeof value !== 'string' || value.length > 512) return null
  const parts = value.split('.')
  if (
    parts.length !== 3
    || parts[0] !== expectedPrefix
    || !/^[0-9a-f-]{36}$/u.test(parts[1] ?? '')
    || !/^[A-Za-z0-9_-]{43}$/u.test(parts[2] ?? '')
  ) return null
  return { id: parts[1]!, secret: parts[2]! }
}

function secretHash(kind: string, id: string, secret: string): string {
  return createHash('sha256').update(`${kind}\0${id}\0${secret}`, 'utf8').digest('hex')
}

function safeHashEqual(expected: string, supplied: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'hex')
  const suppliedBuffer = Buffer.from(supplied, 'hex')
  if (expectedBuffer.length !== 32 || suppliedBuffer.length !== 32) return false
  return timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function invalidPairingTicket(): ForbiddenError {
  return new ForbiddenError('pairing ticket is invalid or unavailable')
}

function invalidDeviceCredential(): ForbiddenError {
  return new ForbiddenError('device credential is invalid or unavailable')
}

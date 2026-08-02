import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  type DeviceCredentialIssue,
  type DevicePublicKeyJwk,
  type DeviceSessionRepository,
} from './agent-os/device-sessions.js'
import { digestRemoteMutation } from './remote-authorization-policy.js'
import {
  RemoteMutationAuditPersistenceError,
  type RemoteDeviceLifecycleAuditDenialCode,
  type RemoteDeviceLifecycleAuditEnvelope,
  type RemoteMutationAuditSink,
} from './remote-mutation-audit-store.js'

export const REMOTE_DEVICE_CREDENTIAL_ROTATION_PATH =
  '/api/v1/os/devices/self/credential/rotate' as const
export const REMOTE_DEVICE_CREDENTIAL_ROTATION_OPERATION = 'device.credential.rotate' as const
export const REMOTE_DEVICE_CREDENTIAL_ROTATION_PROOF_HEADER =
  'x-orchestra-credential-rotation-proof' as const
export const REMOTE_DEVICE_NEW_KEY_PROOF_HEADER =
  'x-orchestra-new-key-proof' as const

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u
const BASE64URL = /^[A-Za-z0-9_-]+$/u

export interface AuthenticatedRemoteRotationDevice {
  deviceSessionId: string
  credentialId: string
  credentialGeneration: number
  tunnelOrigin: string
  authenticatedUserId?: string
}

export interface RemoteCredentialRotationInput {
  authenticatedDevice: AuthenticatedRemoteRotationDevice
  /** A client-created public key. The current key is never accepted as its own replacement. */
  newPublicKeyJwk: unknown
  /** P-256/SHA-256 IEEE-P1363 signature of createRemoteCredentialRotationProofPayload(). */
  rotationProofSignature: unknown
  /** The same challenge signed by the replacement private key, proving it is usable. */
  newKeyProofSignature: unknown
  requestId: string
  correlationId: string
  expiresInSeconds?: number
}

export interface RemoteCredentialRotationRouteInput {
  authenticatedDevice: AuthenticatedRemoteRotationDevice
  body: unknown
  rotationProofSignature: unknown
  newKeyProofSignature: unknown
  requestId: string
  correlationId?: string
}

interface NormalizedPublicKey {
  jwk: DevicePublicKeyJwk
  thumbprint: string
}

export type RemoteCredentialRotationErrorCode =
  | 'invalid_authenticated_device'
  | RemoteDeviceLifecycleAuditDenialCode
  | 'audit_persistence_failed'

export class RemoteCredentialRotationError extends Error {
  override readonly name = 'RemoteCredentialRotationError'

  constructor(
    readonly code: RemoteCredentialRotationErrorCode,
    message = 'device credential rotation was denied',
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

const validOrigin = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname)
    return parsed.origin === value
      && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))
  } catch { return false }
}

const normalizedPublicKey = (value: unknown): NormalizedPublicKey => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteCredentialRotationError('new_public_key_required')
  }
  const input = value as Record<string, unknown>
  if ('d' in input || input.kty !== 'EC' || input.crv !== 'P-256'
    || typeof input.x !== 'string' || typeof input.y !== 'string'
    || !BASE64URL.test(input.x) || !BASE64URL.test(input.y)
    || Buffer.from(input.x, 'base64url').length !== 32
    || Buffer.from(input.y, 'base64url').length !== 32) {
    throw new RemoteCredentialRotationError('new_public_key_invalid')
  }
  const candidate: DevicePublicKeyJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: input.x,
    y: input.y,
  }
  try {
    const canonical = createPublicKey({ key: candidate, format: 'jwk' })
      .export({ format: 'jwk' })
    if (canonical.kty !== 'EC' || canonical.crv !== 'P-256'
      || typeof canonical.x !== 'string' || typeof canonical.y !== 'string') {
      throw new Error('key is not P-256')
    }
    const jwk: DevicePublicKeyJwk = {
      kty: 'EC',
      crv: 'P-256',
      x: canonical.x,
      y: canonical.y,
    }
    const thumbprint = createHash('sha256')
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
      .digest('base64url')
    return { jwk, thumbprint }
  } catch (error) {
    throw new RemoteCredentialRotationError('new_public_key_invalid', undefined, { cause: error })
  }
}

const authenticatedDevice = (
  value: AuthenticatedRemoteRotationDevice,
): Required<AuthenticatedRemoteRotationDevice> => {
  const authenticatedUserId = value.authenticatedUserId ?? 'local-owner'
  if (!OPAQUE_ID.test(value.deviceSessionId) || !OPAQUE_ID.test(value.credentialId)
    || !OPAQUE_ID.test(authenticatedUserId)
    || !Number.isSafeInteger(value.credentialGeneration) || value.credentialGeneration < 0
    || !validOrigin(value.tunnelOrigin)) {
    throw new RemoteCredentialRotationError('invalid_authenticated_device')
  }
  return { ...value, authenticatedUserId }
}

const auditId = (value: unknown, label: 'request' | 'correlation'): string => {
  if (typeof value === 'string' && OPAQUE_ID.test(value)) return value
  const digest = createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value) ?? typeof value)
    .digest('hex')
  return `invalid-${label}-${digest.slice(0, 32)}`
}

const requestIds = (requestId: string, correlationId: string): boolean =>
  OPAQUE_ID.test(requestId) && OPAQUE_ID.test(correlationId)

const verifiesProof = (
  key: DevicePublicKeyJwk,
  payload: string,
  signature: unknown,
): boolean => {
  if (typeof signature !== 'string' || !BASE64URL.test(signature)) return false
  const bytes = Buffer.from(signature, 'base64url')
  if (bytes.length !== 64) return false
  try {
    return verifySignature('sha256', Buffer.from(payload), {
      key: createPublicKey({ key, format: 'jwk' }),
      dsaEncoding: 'ieee-p1363',
    }, bytes)
  } catch { return false }
}

export interface RemoteCredentialRotationProofPayloadInput {
  authenticatedDevice: AuthenticatedRemoteRotationDevice
  newPublicKeyJwk: unknown
  requestId: string
}

/**
 * Canonical challenge signed by the current device key. It binds the exact replacement key,
 * device, ingress origin, route, and request id without carrying either credential secret.
 */
export function createRemoteCredentialRotationProofPayload(
  input: RemoteCredentialRotationProofPayloadInput,
): string {
  const device = authenticatedDevice(input.authenticatedDevice)
  const key = normalizedPublicKey(input.newPublicKeyJwk)
  if (!OPAQUE_ID.test(input.requestId)) {
    throw new RemoteCredentialRotationError('invalid_authenticated_device')
  }
  return JSON.stringify({
    schema_version: 1,
    operation: REMOTE_DEVICE_CREDENTIAL_ROTATION_OPERATION,
    method: 'POST',
    path: REMOTE_DEVICE_CREDENTIAL_ROTATION_PATH,
    device_session_id: device.deviceSessionId,
    current_credential_id: device.credentialId,
    current_credential_generation: device.credentialGeneration,
    new_public_key_thumbprint: key.thumbprint,
    request_id: input.requestId,
    tunnel_origin: device.tunnelOrigin,
  })
}

const lifecycleEnvelope = (input: {
  device: Required<AuthenticatedRemoteRotationDevice>
  outcome: 'succeeded' | 'failed' | 'denied'
  denialCode?: RemoteDeviceLifecycleAuditDenialCode
  occurredAt: string
  requestId: string
  correlationId: string
  requestDigest: string
}): RemoteDeviceLifecycleAuditEnvelope => {
  const base = {
    schema_version: 1 as const,
    occurred_at: input.occurredAt,
    operation: REMOTE_DEVICE_CREDENTIAL_ROTATION_OPERATION,
    rule_id: 'device.credential.rotate.proof-bound' as const,
    resource_type: 'device' as const,
    resource_id: input.device.deviceSessionId,
    device_session_id: input.device.deviceSessionId,
    authenticated_user_id: input.device.authenticatedUserId,
    credential_version: input.device.credentialGeneration + 1,
    request_id: input.requestId,
    correlation_id: input.correlationId,
    request_digest: input.requestDigest,
    tunnel_origin: input.device.tunnelOrigin,
    sensitive_values_retained: false as const,
  }
  if (input.outcome === 'denied') {
    if (!input.denialCode) throw new Error('credential rotation denial code is required')
    return Object.freeze({ ...base, outcome: 'denied' as const, denial_code: input.denialCode })
  }
  return Object.freeze({
    ...base,
    outcome: input.outcome,
    attributed_scope: null,
    step_up_grant_id: null,
  })
}

const safeDenialCode = (error: unknown): RemoteDeviceLifecycleAuditDenialCode => {
  if (error instanceof RemoteCredentialRotationError
    && [
      'new_public_key_required',
      'new_public_key_invalid',
      'new_public_key_reused',
      'new_key_proof_invalid',
      'invalid_request_id',
    ]
      .includes(error.code)) return error.code as RemoteDeviceLifecycleAuditDenialCode
  return 'credential_rotation_denied'
}

/**
 * The service expects the root authentication middleware to supply the attributed device.
 * The repository then re-checks active authority and the rotation-specific proof atomically.
 */
export class RemoteDeviceCredentialRotationService {
  constructor(
    private readonly db: Database.Database,
    private readonly repository: DeviceSessionRepository,
    private readonly audit: RemoteMutationAuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  rotate(input: RemoteCredentialRotationInput): DeviceCredentialIssue {
    const device = authenticatedDevice(input.authenticatedDevice)
    const auditRequestId = auditId(input.requestId, 'request')
    const auditCorrelationId = auditId(input.correlationId, 'correlation')
    let proofPayload: string
    let requestDigest: string
    try {
      if (!requestIds(input.requestId, input.correlationId)) {
        throw new RemoteCredentialRotationError('invalid_request_id')
      }
      const nextKey = normalizedPublicKey(input.newPublicKeyJwk)
      const currentSession = this.repository.getDeviceSession(device.deviceSessionId)
      const currentCredential = this.repository.listDeviceCredentials(device.deviceSessionId)
        .find((credential) => credential.id === device.credentialId && credential.state === 'active')
      if (!currentSession || currentSession.state !== 'active' || !currentCredential
        || currentCredential.rotation_generation !== device.credentialGeneration) {
        throw new RemoteCredentialRotationError('credential_rotation_denied')
      }
      if (nextKey.thumbprint === currentSession.public_key_thumbprint) {
        throw new RemoteCredentialRotationError('new_public_key_reused')
      }
      proofPayload = createRemoteCredentialRotationProofPayload({
        authenticatedDevice: device,
        newPublicKeyJwk: nextKey.jwk,
        requestId: input.requestId,
      })
      requestDigest = digestRemoteMutation(proofPayload)
      if (!verifiesProof(nextKey.jwk, proofPayload, input.newKeyProofSignature)) {
        throw new RemoteCredentialRotationError('new_key_proof_invalid')
      }

      const rotate = this.db.transaction(() => {
        const issue = this.repository.rotateDeviceCredential({
          deviceSessionId: device.deviceSessionId,
          currentCredentialId: device.credentialId,
          proofPayload,
          proofSignature: typeof input.rotationProofSignature === 'string'
            ? input.rotationProofSignature : '',
          actor: { type: 'device', id: device.deviceSessionId },
          newPublicKeyJwk: nextKey.jwk,
          expiresInSeconds: input.expiresInSeconds,
        })
        this.audit.persist(lifecycleEnvelope({
          device,
          outcome: 'succeeded',
          occurredAt: this.timestamp(),
          requestId: auditRequestId,
          correlationId: auditCorrelationId,
          requestDigest,
        }))
        return issue
      })
      return rotate.immediate()
    } catch (error) {
      if (error instanceof RemoteMutationAuditPersistenceError) {
        throw new RemoteCredentialRotationError(
          'audit_persistence_failed',
          'credential rotation could not persist required audit evidence',
          { cause: error },
        )
      }
      const denialCode = safeDenialCode(error)
      proofPayload ??= JSON.stringify({
        schema_version: 1,
        operation: REMOTE_DEVICE_CREDENTIAL_ROTATION_OPERATION,
        device_session_id: device.deviceSessionId,
        request_id: auditRequestId,
        denial: denialCode,
      })
      requestDigest ??= digestRemoteMutation(proofPayload)
      try {
        this.audit.persist(lifecycleEnvelope({
          device,
          outcome: 'denied',
          denialCode,
          occurredAt: this.timestamp(),
          requestId: auditRequestId,
          correlationId: auditCorrelationId,
          requestDigest,
        }))
      } catch (auditError) {
        throw new RemoteCredentialRotationError(
          'audit_persistence_failed',
          'credential rotation denial could not persist required audit evidence',
          { cause: auditError },
        )
      }
      throw new RemoteCredentialRotationError(denialCode, undefined, { cause: error })
    }
  }

  private timestamp(): string {
    const value = this.now()
    if (!Number.isFinite(value.getTime())) {
      throw new RemoteCredentialRotationError('audit_persistence_failed', 'rotation clock is invalid')
    }
    return value.toISOString()
  }
}

const exactBody = (value: unknown): { new_public_key_jwk: unknown } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 1
    || !Object.prototype.hasOwnProperty.call(value, 'new_public_key_jwk')) {
    throw new RemoteCredentialRotationError('new_public_key_required')
  }
  return value as { new_public_key_jwk: unknown }
}

/** Fastify-independent route boundary; central route registration remains lane-root-owned. */
export function executeRemoteDeviceCredentialRotationRoute(
  service: RemoteDeviceCredentialRotationService,
  input: RemoteCredentialRotationRouteInput,
): DeviceCredentialIssue {
  let body: { new_public_key_jwk: unknown }
  try { body = exactBody(input.body) } catch {
    body = { new_public_key_jwk: undefined }
  }
  return service.rotate({
    authenticatedDevice: input.authenticatedDevice,
    newPublicKeyJwk: body.new_public_key_jwk,
    rotationProofSignature: input.rotationProofSignature,
    newKeyProofSignature: input.newKeyProofSignature,
    requestId: input.requestId,
    correlationId: input.correlationId ?? input.requestId,
  })
}

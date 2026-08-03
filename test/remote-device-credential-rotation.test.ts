import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { installDeviceSessionSchema } from '../src/agent-os/device-session-migration.js'
import {
  SqliteDeviceSessionRepository,
  type DeviceCredentialIssue,
  type DevicePublicKeyJwk,
} from '../src/agent-os/device-sessions.js'
import {
  RemoteDeviceCredentialRotationService,
  RemoteCredentialRotationError,
  createRemoteCredentialRotationProofPayload,
  executeRemoteDeviceCredentialRotationRoute,
  type AuthenticatedRemoteRotationDevice,
} from '../src/remote-device-credential-rotation.js'
import {
  RemoteAuthorizationPolicy,
  createRemoteMutationAuditEnvelope,
  createRemoteMutationDenialAuditEnvelope,
  digestRemoteMutation,
  type RemoteDevicePrincipal,
} from '../src/remote-authorization-policy.js'
import {
  SqliteRemoteMutationAuditStore,
  installRemoteMutationAuditImmutability,
} from '../src/remote-mutation-audit-store.js'

const REMOTE_AUDIT_TABLE_SQL = `
  CREATE TABLE os_remote_mutation_audit (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    operation TEXT NOT NULL,
    rule_id TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','denied')),
    denial_code TEXT,
    resource_type TEXT,
    resource_id TEXT,
    device_session_id TEXT NOT NULL REFERENCES os_device_sessions(id) ON DELETE RESTRICT,
    authenticated_user_id TEXT NOT NULL,
    credential_generation INTEGER NOT NULL,
    attributed_scope TEXT,
    step_up_grant_id TEXT,
    request_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    request_digest TEXT,
    tunnel_origin TEXT NOT NULL,
    sensitive_values_retained INTEGER NOT NULL DEFAULT 0 CHECK(sensitive_values_retained=0)
  );
`

const owner = { type: 'human', id: 'local-owner' }
const phoneKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const tabletKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const thirdKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const phoneJwk = phoneKeys.publicKey.export({ format: 'jwk' }) as DevicePublicKeyJwk
const tabletJwk = tabletKeys.publicKey.export({ format: 'jwk' }) as DevicePublicKeyJwk
const thirdJwk = thirdKeys.publicKey.export({ format: 'jwk' }) as DevicePublicKeyJwk

const signature = (privateKey: KeyObject, payload: string): string => sign(
  'sha256',
  Buffer.from(payload),
  { key: privateKey, dsaEncoding: 'ieee-p1363' },
).toString('base64url')

const thumbprint = (jwk: DevicePublicKeyJwk): string => createHash('sha256')
  .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
  .digest('base64url')

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  installDeviceSessionSchema(db)
  db.exec(REMOTE_AUDIT_TABLE_SQL)
  installRemoteMutationAuditImmutability(db)
  const now = new Date('2026-08-02T12:00:00.000Z')
  const repository = new SqliteDeviceSessionRepository(db, { now: () => now })
  let auditSequence = 0
  const audit = new SqliteRemoteMutationAuditStore(db, () => `audit-${++auditSequence}`)
  const service = new RemoteDeviceCredentialRotationService(db, repository, audit, () => now)
  const ticket = repository.createPairingTicket({
    expectedOrigin: 'https://remote.example',
    actor: owner,
  })
  const redemption = repository.redeemPairingTicket({
    pairingTicket: ticket.pairing_ticket,
    origin: 'https://remote.example',
    deviceName: 'Owner phone',
    devicePublicKeyJwk: phoneJwk,
  })
  const authenticatedDevice: AuthenticatedRemoteRotationDevice = {
    deviceSessionId: redemption.device_session.id,
    credentialId: redemption.credential_issue.credential_metadata.id,
    credentialGeneration: 0,
    tunnelOrigin: 'https://remote.example',
  }
  return { db, repository, service, redemption, authenticatedDevice, now }
}

const rotationProof = (
  authenticatedDevice: AuthenticatedRemoteRotationDevice,
  key: DevicePublicKeyJwk,
  requestId: string,
  privateKey = phoneKeys.privateKey,
): string => signature(privateKey, createRemoteCredentialRotationProofPayload({
  authenticatedDevice,
  newPublicKeyJwk: key,
  requestId,
}))

const verify = (
  repository: SqliteDeviceSessionRepository,
  issue: DeviceCredentialIssue,
  privateKey: KeyObject,
  payload: string,
) => repository.verifyDeviceCredential({
  credential: issue.credential,
  proofPayload: payload,
  proofSignature: signature(privateKey, payload),
})

describe('remote credential rotation boundary', () => {
  it('rotates to a new proof-bound public key and persists exact audit evidence atomically', () => {
    const { db, repository, service, redemption, authenticatedDevice } = fixture()
    const requestId = 'request-rotate-1'
    const proof = rotationProof(authenticatedDevice, tabletJwk, requestId)
    const rotated = executeRemoteDeviceCredentialRotationRoute(service, {
      authenticatedDevice,
      body: { new_public_key_jwk: tabletJwk },
      rotationProofSignature: proof,
      newKeyProofSignature: rotationProof(
        authenticatedDevice,
        tabletJwk,
        requestId,
        tabletKeys.privateKey,
      ),
      requestId,
      correlationId: 'correlation-rotate-1',
    })

    expect(() => verify(
      repository,
      redemption.credential_issue,
      phoneKeys.privateKey,
      'old credential must be terminal',
    )).toThrow(/invalid or unavailable/)
    expect(verify(repository, rotated, tabletKeys.privateKey, 'new credential proof')).toMatchObject({
      device_session_id: authenticatedDevice.deviceSessionId,
      credential_id: rotated.credential_metadata.id,
      rotation_generation: 1,
      public_key_thumbprint: thumbprint(tabletJwk),
    })
    expect(repository.getDeviceSession(authenticatedDevice.deviceSessionId)).toMatchObject({
      state: 'active',
      rotation_counter: 1,
      public_key_thumbprint: thumbprint(tabletJwk),
    })
    expect(repository.listDeviceCredentials(authenticatedDevice.deviceSessionId)
      .map(({ id, state, rotation_generation }) => ({ id, state, rotation_generation }))
      .sort((left, right) => left.rotation_generation - right.rotation_generation))
      .toEqual([
        {
          id: redemption.credential_issue.credential_metadata.id,
          state: 'rotated',
          rotation_generation: 0,
        },
        { id: rotated.credential_metadata.id, state: 'active', rotation_generation: 1 },
      ])

    const audit = db.prepare('SELECT * FROM os_remote_mutation_audit').get() as Record<string, unknown>
    expect(audit).toMatchObject({
      id: 'audit-1',
      occurred_at: '2026-08-02T12:00:00.000Z',
      operation: 'device.credential.rotate',
      rule_id: 'device.credential.rotate.proof-bound',
      outcome: 'succeeded',
      denial_code: null,
      resource_type: 'device',
      resource_id: authenticatedDevice.deviceSessionId,
      device_session_id: authenticatedDevice.deviceSessionId,
      authenticated_user_id: 'local-owner',
      credential_generation: 0,
      attributed_scope: null,
      step_up_grant_id: null,
      request_id: requestId,
      correlation_id: 'correlation-rotate-1',
      sensitive_values_retained: 0,
    })
    expect(audit.request_digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const storedEvidence = JSON.stringify(audit)
    expect(storedEvidence).not.toContain(redemption.credential_issue.credential)
    expect(storedEvidence).not.toContain(rotated.credential)
    expect(storedEvidence).not.toContain(proof)
    expect(storedEvidence).not.toContain(tabletJwk.x)
    expect(storedEvidence).not.toContain(tabletJwk.y)
    db.close()
  })

  it('requires a different client key and audits malformed or reused-key denials', () => {
    const { db, repository, service, redemption, authenticatedDevice } = fixture()
    expect(() => executeRemoteDeviceCredentialRotationRoute(service, {
      authenticatedDevice,
      body: { new_public_key_jwk: phoneJwk, unexpected: 'not accepted' },
      rotationProofSignature: '',
      newKeyProofSignature: '',
      requestId: 'request-invalid-body',
    })).toThrowError(expect.objectContaining<Partial<RemoteCredentialRotationError>>({
      code: 'new_public_key_required',
    }))
    expect(() => executeRemoteDeviceCredentialRotationRoute(service, {
      authenticatedDevice,
      body: { new_public_key_jwk: phoneJwk },
      rotationProofSignature: rotationProof(authenticatedDevice, phoneJwk, 'request-reuse'),
      newKeyProofSignature: rotationProof(authenticatedDevice, phoneJwk, 'request-reuse'),
      requestId: 'request-reuse',
    })).toThrowError(expect.objectContaining<Partial<RemoteCredentialRotationError>>({
      code: 'new_public_key_reused',
    }))
    expect(repository.getDeviceSession(authenticatedDevice.deviceSessionId)).toMatchObject({
      state: 'active', rotation_counter: 0, public_key_thumbprint: thumbprint(phoneJwk),
    })
    expect(verify(repository, redemption.credential_issue, phoneKeys.privateKey, 'still active'))
      .toMatchObject({ credential_id: authenticatedDevice.credentialId })
    expect(db.prepare(`SELECT outcome, denial_code, count(*) AS count
      FROM os_remote_mutation_audit GROUP BY outcome, denial_code ORDER BY denial_code`).all())
      .toEqual([
        { outcome: 'denied', denial_code: 'new_public_key_required', count: 1 },
        { outcome: 'denied', denial_code: 'new_public_key_reused', count: 1 },
      ])
    db.close()
  })

  it('rejects an invalid rotation proof without changing current authority', () => {
    const { db, repository, service, redemption, authenticatedDevice } = fixture()
    expect(() => service.rotate({
      authenticatedDevice,
      newPublicKeyJwk: tabletJwk,
      rotationProofSignature: rotationProof(
        authenticatedDevice,
        tabletJwk,
        'request-wrong-proof',
        thirdKeys.privateKey,
      ),
      newKeyProofSignature: rotationProof(
        authenticatedDevice,
        tabletJwk,
        'request-wrong-proof',
        tabletKeys.privateKey,
      ),
      requestId: 'request-wrong-proof',
      correlationId: 'correlation-wrong-proof',
    })).toThrowError(expect.objectContaining<Partial<RemoteCredentialRotationError>>({
      code: 'credential_rotation_denied',
    }))
    expect(verify(repository, redemption.credential_issue, phoneKeys.privateKey, 'still current'))
      .toMatchObject({ credential_id: authenticatedDevice.credentialId })
    expect(repository.listDeviceCredentials(authenticatedDevice.deviceSessionId)).toHaveLength(1)
    expect(db.prepare('SELECT outcome, denial_code FROM os_remote_mutation_audit').get())
      .toEqual({ outcome: 'denied', denial_code: 'credential_rotation_denied' })
    db.close()
  })

  it('requires proof of possession for the replacement private key', () => {
    const { db, repository, service, redemption, authenticatedDevice } = fixture()
    const requestId = 'request-new-key-proof'
    expect(() => service.rotate({
      authenticatedDevice,
      newPublicKeyJwk: tabletJwk,
      rotationProofSignature: rotationProof(authenticatedDevice, tabletJwk, requestId),
      newKeyProofSignature: rotationProof(
        authenticatedDevice,
        tabletJwk,
        requestId,
        thirdKeys.privateKey,
      ),
      requestId,
      correlationId: 'correlation-new-key-proof',
    })).toThrowError(expect.objectContaining<Partial<RemoteCredentialRotationError>>({
      code: 'new_key_proof_invalid',
    }))
    expect(verify(repository, redemption.credential_issue, phoneKeys.privateKey, 'current key retained'))
      .toMatchObject({ credential_id: authenticatedDevice.credentialId })
    expect(repository.listDeviceCredentials(authenticatedDevice.deviceSessionId)).toHaveLength(1)
    expect(db.prepare('SELECT outcome, denial_code FROM os_remote_mutation_audit').get())
      .toEqual({ outcome: 'denied', denial_code: 'new_key_proof_invalid' })
    db.close()
  })

  it('audits malformed request attribution under safe surrogate ids', () => {
    const { db, repository, service, redemption, authenticatedDevice } = fixture()
    const requestId = 'request-invalid-correlation'
    expect(() => service.rotate({
      authenticatedDevice,
      newPublicKeyJwk: tabletJwk,
      rotationProofSignature: rotationProof(authenticatedDevice, tabletJwk, requestId),
      newKeyProofSignature: rotationProof(
        authenticatedDevice,
        tabletJwk,
        requestId,
        tabletKeys.privateKey,
      ),
      requestId,
      correlationId: 'invalid correlation with spaces and secret-like text',
    })).toThrowError(expect.objectContaining<Partial<RemoteCredentialRotationError>>({
      code: 'invalid_request_id',
    }))
    expect(verify(repository, redemption.credential_issue, phoneKeys.privateKey, 'authority unchanged'))
      .toMatchObject({ credential_id: authenticatedDevice.credentialId })
    expect(db.prepare(`SELECT outcome, denial_code, request_id, correlation_id
      FROM os_remote_mutation_audit`).get()).toEqual({
      outcome: 'denied',
      denial_code: 'invalid_request_id',
      request_id: requestId,
      correlation_id: expect.stringMatching(/^invalid-correlation-[0-9a-f]{32}$/),
    })
    expect(JSON.stringify(db.prepare('SELECT * FROM os_remote_mutation_audit').get()))
      .not.toContain('secret-like text')
    db.close()
  })

  it('attributes successive rotations to the credential generation that authorized each one', () => {
    const { db, repository, service, redemption, authenticatedDevice } = fixture()
    const firstRequestId = 'request-generation-0'
    const first = service.rotate({
      authenticatedDevice,
      newPublicKeyJwk: tabletJwk,
      rotationProofSignature: rotationProof(authenticatedDevice, tabletJwk, firstRequestId),
      newKeyProofSignature: rotationProof(
        authenticatedDevice,
        tabletJwk,
        firstRequestId,
        tabletKeys.privateKey,
      ),
      requestId: firstRequestId,
      correlationId: 'correlation-generation-0',
    })
    const secondDevice: AuthenticatedRemoteRotationDevice = {
      ...authenticatedDevice,
      credentialId: first.credential_metadata.id,
      credentialGeneration: 1,
    }
    const secondRequestId = 'request-generation-1'
    const second = service.rotate({
      authenticatedDevice: secondDevice,
      newPublicKeyJwk: thirdJwk,
      rotationProofSignature: rotationProof(
        secondDevice,
        thirdJwk,
        secondRequestId,
        tabletKeys.privateKey,
      ),
      newKeyProofSignature: rotationProof(
        secondDevice,
        thirdJwk,
        secondRequestId,
        thirdKeys.privateKey,
      ),
      requestId: secondRequestId,
      correlationId: 'correlation-generation-1',
    })
    expect(() => verify(repository, first, tabletKeys.privateKey, 'generation one is terminal'))
      .toThrow(/invalid or unavailable/)
    expect(verify(repository, second, thirdKeys.privateKey, 'generation two is active'))
      .toMatchObject({ rotation_generation: 2 })
    expect(repository.listDeviceCredentials(authenticatedDevice.deviceSessionId)
      .map(({ rotation_generation, state }) => ({ rotation_generation, state }))
      .sort((left, right) => left.rotation_generation - right.rotation_generation))
      .toEqual([
        { rotation_generation: 0, state: 'rotated' },
        { rotation_generation: 1, state: 'rotated' },
        { rotation_generation: 2, state: 'active' },
      ])
    expect(db.prepare(`SELECT request_id, credential_generation
      FROM os_remote_mutation_audit ORDER BY id`).all()).toEqual([
      { request_id: firstRequestId, credential_generation: 0 },
      { request_id: secondRequestId, credential_generation: 1 },
    ])
    expect(redemption.credential_issue.credential_metadata.rotation_generation).toBe(0)
    db.close()
  })

  it('fails closed for both serializable rotate/revoke race outcomes', () => {
    const revokeFirst = fixture()
    revokeFirst.repository.revokeDeviceSession(revokeFirst.authenticatedDevice.deviceSessionId, {
      reason: 'lost device', actor: owner, compromised: true,
    })
    expect(() => revokeFirst.service.rotate({
      authenticatedDevice: revokeFirst.authenticatedDevice,
      newPublicKeyJwk: tabletJwk,
      rotationProofSignature: rotationProof(
        revokeFirst.authenticatedDevice,
        tabletJwk,
        'request-revoke-won',
      ),
      newKeyProofSignature: rotationProof(
        revokeFirst.authenticatedDevice,
        tabletJwk,
        'request-revoke-won',
        tabletKeys.privateKey,
      ),
      requestId: 'request-revoke-won',
      correlationId: 'correlation-revoke-won',
    })).toThrowError(expect.objectContaining<Partial<RemoteCredentialRotationError>>({
      code: 'credential_rotation_denied',
    }))
    expect(revokeFirst.repository.listDeviceCredentials(revokeFirst.authenticatedDevice.deviceSessionId))
      .toEqual([expect.objectContaining({ state: 'revoked' })])
    expect(revokeFirst.db.prepare('SELECT outcome, denial_code FROM os_remote_mutation_audit').get())
      .toEqual({ outcome: 'denied', denial_code: 'credential_rotation_denied' })
    revokeFirst.db.close()

    const rotateFirst = fixture()
    const requestId = 'request-rotate-won'
    const rotated = rotateFirst.service.rotate({
      authenticatedDevice: rotateFirst.authenticatedDevice,
      newPublicKeyJwk: tabletJwk,
      rotationProofSignature: rotationProof(rotateFirst.authenticatedDevice, tabletJwk, requestId),
      newKeyProofSignature: rotationProof(
        rotateFirst.authenticatedDevice,
        tabletJwk,
        requestId,
        tabletKeys.privateKey,
      ),
      requestId,
      correlationId: 'correlation-rotate-won',
    })
    rotateFirst.repository.revokeDeviceSession(rotateFirst.authenticatedDevice.deviceSessionId, {
      reason: 'lost device', actor: owner, compromised: true,
    })
    expect(() => verify(
      rotateFirst.repository,
      rotated,
      tabletKeys.privateKey,
      'new key after revoke',
    )).toThrow(/invalid or unavailable/)
    expect(rotateFirst.repository.getDeviceSession(rotateFirst.authenticatedDevice.deviceSessionId))
      .toMatchObject({ state: 'compromised' })
    expect(rotateFirst.repository.listDeviceCredentials(rotateFirst.authenticatedDevice.deviceSessionId))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ state: 'rotated' }),
        expect.objectContaining({ state: 'revoked' }),
      ]))
    rotateFirst.db.close()
  })

  it('rolls rotation back when required audit evidence cannot be written', () => {
    const { db, repository, service, redemption, authenticatedDevice } = fixture()
    db.exec(`CREATE TRIGGER force_remote_audit_failure BEFORE INSERT ON os_remote_mutation_audit
      BEGIN SELECT RAISE(ABORT, 'forced audit outage'); END;`)
    const requestId = 'request-audit-outage'
    expect(() => service.rotate({
      authenticatedDevice,
      newPublicKeyJwk: tabletJwk,
      rotationProofSignature: rotationProof(authenticatedDevice, tabletJwk, requestId),
      newKeyProofSignature: rotationProof(
        authenticatedDevice,
        tabletJwk,
        requestId,
        tabletKeys.privateKey,
      ),
      requestId,
      correlationId: 'correlation-audit-outage',
    })).toThrowError(expect.objectContaining<Partial<RemoteCredentialRotationError>>({
      code: 'audit_persistence_failed',
    }))
    expect(verify(repository, redemption.credential_issue, phoneKeys.privateKey, 'rollback proof'))
      .toMatchObject({ credential_id: authenticatedDevice.credentialId, rotation_generation: 0 })
    expect(repository.listDeviceCredentials(authenticatedDevice.deviceSessionId)).toHaveLength(1)
    expect(repository.getDeviceSession(authenticatedDevice.deviceSessionId))
      .toMatchObject({ state: 'active', rotation_counter: 0 })
    db.close()
  })
})

describe('SqliteRemoteMutationAuditStore', () => {
  it('persists policy-produced success and denial envelopes exactly and append-only', () => {
    const { db, authenticatedDevice, now } = fixture()
    const audit = new SqliteRemoteMutationAuditStore(db, (() => {
      let sequence = 10
      return () => `policy-audit-${++sequence}`
    })())
    const policy = new RemoteAuthorizationPolicy([{
      id: 'message.send.no-tool',
      operation: 'message.send',
      kind: 'mutation',
      localOperatorAllowed: true,
      requiredScope: 'message',
      resourceType: 'conversation',
      stepUp: 'none',
      destructive: false,
      messageTarget: 'no-tool',
      audit: 'required',
      rateLimitFamily: 'command',
    }], () => now)
    const requestDigest = digestRemoteMutation('{"body":"redacted before audit"}')
    const principal: RemoteDevicePrincipal = {
      kind: 'device',
      deviceSessionId: authenticatedDevice.deviceSessionId,
      authenticatedUserId: 'local-owner',
      state: 'active',
      scopes: ['observe', 'message'],
      resourceGrants: [{
        resourceType: 'conversation',
        resourceId: 'conversation-1',
        permissions: ['read', 'mutate'],
        dataClasses: ['redacted_observe'],
      }],
      sessionExpiresAt: '2026-08-03T12:00:00.000Z',
      credentialExpiresAt: '2026-08-03T12:00:00.000Z',
      credentialVersion: 1,
      authenticatedAt: '2026-08-02T12:00:00.000Z',
      tunnelOrigin: 'https://remote.example',
    }
    const resource = {
      resourceType: 'conversation' as const,
      resourceId: 'conversation-1',
      verifiedAtServiceBoundary: true as const,
    }
    const allowed = policy.authorize({
      operation: 'message.send', principal, resource, requestDigest,
    })
    if (!allowed.allowed) throw new Error(`unexpected denial: ${allowed.code}`)
    const success = createRemoteMutationAuditEnvelope({
      authorization: allowed,
      outcome: 'succeeded',
      occurredAt: '2026-08-02T12:00:01.000Z',
      requestId: 'request-message-1',
      correlationId: 'correlation-message-1',
      requestDigest,
    })
    audit.persist(success)

    const denied = policy.authorize({
      operation: 'message.send', principal: { ...principal, scopes: ['observe'] },
      resource, requestDigest,
    })
    if (denied.allowed) throw new Error('expected scope denial')
    audit.persist(createRemoteMutationDenialAuditEnvelope({
      denial: denied,
      occurredAt: '2026-08-02T12:00:02.000Z',
      requestId: 'request-message-2',
      correlationId: 'correlation-message-2',
      requestDigest,
    }))

    expect(db.prepare(`SELECT id, rule_id, outcome, denial_code, credential_generation,
      attributed_scope, request_digest, sensitive_values_retained
      FROM os_remote_mutation_audit WHERE id LIKE 'policy-audit-%' ORDER BY id`).all())
      .toEqual([
        {
          id: 'policy-audit-11', rule_id: 'message.send.no-tool', outcome: 'succeeded',
          denial_code: null, credential_generation: 0, attributed_scope: 'message',
          request_digest: requestDigest, sensitive_values_retained: 0,
        },
        {
          id: 'policy-audit-12', rule_id: 'message.send.no-tool', outcome: 'denied',
          denial_code: 'scope_missing', credential_generation: 0, attributed_scope: null,
          request_digest: requestDigest, sensitive_values_retained: 0,
        },
      ])
    expect(() => db.prepare(`UPDATE os_remote_mutation_audit SET outcome='failed'
      WHERE id='policy-audit-11'`).run()).toThrow(/append-only/)
    expect(() => db.prepare(`DELETE FROM os_remote_mutation_audit
      WHERE id='policy-audit-11'`).run()).toThrow(/append-only/)
    db.close()
  })

  it('rejects non-closed or secret-extended envelopes before persistence', () => {
    const { db, authenticatedDevice } = fixture()
    const audit = new SqliteRemoteMutationAuditStore(db)
    const forged = Object.freeze({
      schema_version: 1,
      occurred_at: '2026-08-02T12:00:00.000Z',
      operation: 'device.credential.rotate',
      rule_id: 'device.credential.rotate.proof-bound',
      outcome: 'succeeded',
      resource_type: 'device',
      resource_id: authenticatedDevice.deviceSessionId,
      device_session_id: authenticatedDevice.deviceSessionId,
      authenticated_user_id: 'local-owner',
      credential_version: 1,
      attributed_scope: null,
      step_up_grant_id: null,
      request_id: 'request-forged',
      correlation_id: 'correlation-forged',
      request_digest: digestRemoteMutation('forged'),
      tunnel_origin: 'https://remote.example',
      sensitive_values_retained: false,
      credential: 'must-never-persist',
    })
    expect(() => audit.persist(forged as never)).toThrow(/not exact and closed/)
    expect(db.prepare('SELECT count(*) AS count FROM os_remote_mutation_audit').get())
      .toEqual({ count: 0 })
    db.close()
  })

  it('installs and re-verifies exact immutable guards after a database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestra-remote-audit-'))
    const databasePath = join(directory, 'orchestra.db')
    try {
      const first = new Database(databasePath)
      first.pragma('foreign_keys = ON')
      installDeviceSessionSchema(first)
      first.exec(REMOTE_AUDIT_TABLE_SQL)
      new SqliteRemoteMutationAuditStore(first)
      first.close()

      const reopened = new Database(databasePath)
      const store = new SqliteRemoteMutationAuditStore(reopened)
      expect(store).toBeInstanceOf(SqliteRemoteMutationAuditStore)
      expect(reopened.prepare(`SELECT name FROM sqlite_master
        WHERE type='trigger' AND name LIKE 'os_remote_mutation_audit_no_%'
        ORDER BY name`).all()).toEqual([
        { name: 'os_remote_mutation_audit_no_delete' },
        { name: 'os_remote_mutation_audit_no_update' },
      ])
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

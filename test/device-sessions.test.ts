import Database from 'better-sqlite3'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installDeviceSessionSchema } from '../src/agent-os/device-session-migration.js'
import {
  DEFAULT_PHONE_DEVICE_SCOPES,
  SqliteDeviceSessionRepository,
  type DeviceCredentialIssue,
  type DevicePublicKeyJwk,
  type PairingRedemption,
} from '../src/agent-os/device-sessions.js'

const owner = { type: 'human', id: 'local-owner' }
const phoneKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const tabletKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const phoneJwk = phoneKeys.publicKey.export({ format: 'jwk' }) as DevicePublicKeyJwk
const tabletJwk = tabletKeys.publicKey.export({ format: 'jwk' }) as DevicePublicKeyJwk
const phoneThumbprint = thumbprint(phoneJwk)
const tabletThumbprint = thumbprint(tabletJwk)

function thumbprint(jwk: DevicePublicKeyJwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  return createHash('sha256').update(canonical).digest('base64url')
}

function signature(privateKey: KeyObject, payload: string): string {
  return sign('sha256', Buffer.from(payload), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
}

function raceWorker(workerData: Record<string, unknown>): Promise<{ ok: boolean; result?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      new URL('./helpers/device-session-race-worker.mjs', import.meta.url).pathname,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(stderr || `worker exited ${code}`))
      else resolve(JSON.parse(stdout) as { ok: boolean; result?: string })
    })
    child.stdin.end(JSON.stringify(workerData))
  })
}

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  installDeviceSessionSchema(db)
  let now = new Date('2026-08-02T12:00:00.000Z')
  const repository = new SqliteDeviceSessionRepository(db, { now: () => now })
  return {
    db,
    repository,
    setNow(value: string) { now = new Date(value) },
  }
}

function pair(
  repository: SqliteDeviceSessionRepository,
  name = 'Owner phone',
  key = phoneJwk,
): PairingRedemption {
  const issue = repository.createPairingTicket({
    expectedOrigin: 'https://remote.example',
    actor: owner,
  })
  return repository.redeemPairingTicket({
    pairingTicket: issue.pairing_ticket,
    origin: 'https://remote.example',
    deviceName: name,
    devicePublicKeyJwk: key,
  })
}

function verify(
  repository: SqliteDeviceSessionRepository,
  issue: DeviceCredentialIssue,
  privateKey = phoneKeys.privateKey,
  payload = 'GET\n/api/v1/os/devices/self\nnonce-1',
) {
  return repository.verifyDeviceCredential({
    credential: issue.credential,
    proofPayload: payload,
    proofSignature: signature(privateKey, payload),
    requiredScopes: ['observe'],
  })
}

describe('SqliteDeviceSessionRepository', () => {
  it('redeems an origin-bound ticket exactly once without persisting plaintext authority', () => {
    const { db, repository } = fixture()
    const issue = repository.createPairingTicket({
      expectedOrigin: 'https://remote.example',
      actor: owner,
    })
    const ticketSecret = issue.pairing_ticket.split('.')[2]!
    const storedTicket = db.prepare(`SELECT secret_hash, expected_origin
      FROM os_pairing_tickets WHERE id=?`).get(issue.ticket.id) as {
        secret_hash: string
        expected_origin: string
      }
    expect(storedTicket.secret_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(storedTicket.secret_hash).not.toContain(ticketSecret)
    expect(storedTicket.expected_origin).toBe('https://remote.example')
    expect(JSON.stringify(issue.ticket)).not.toMatch(/secret|hash|master/i)

    expect(() => repository.redeemPairingTicket({
      pairingTicket: issue.pairing_ticket,
      origin: 'https://attacker.example',
      deviceName: 'Wrong origin',
      devicePublicKeyJwk: phoneJwk,
    })).toThrow(/pairing ticket is invalid or unavailable/)

    const redemption = repository.redeemPairingTicket({
      pairingTicket: issue.pairing_ticket,
      origin: 'https://remote.example',
      deviceName: 'Owner phone',
      devicePublicKeyJwk: phoneJwk,
    })
    expect(redemption.device_session).toMatchObject({
      name: 'Owner phone',
      state: 'active',
      scopes: DEFAULT_PHONE_DEVICE_SCOPES,
      public_key_thumbprint: phoneThumbprint,
    })
    expect(redemption.credential_issue.credential_metadata.state).toBe('active')
    expect(JSON.stringify(redemption.credential_issue.credential_metadata))
      .not.toMatch(/secret|hash|master/i)
    const credentialSecret = redemption.credential_issue.credential.split('.')[2]!
    const storedCredential = db.prepare(`SELECT secret_hash
      FROM os_device_credentials WHERE id=?`)
      .get(redemption.credential_issue.credential_metadata.id) as { secret_hash: string }
    expect(storedCredential.secret_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(storedCredential.secret_hash).not.toContain(credentialSecret)

    expect(() => repository.redeemPairingTicket({
      pairingTicket: issue.pairing_ticket,
      origin: 'https://remote.example',
      deviceName: 'Replay',
      devicePublicKeyJwk: phoneJwk,
    })).toThrow(/pairing ticket is invalid or unavailable/)
    expect(repository.getPairingTicket(issue.ticket.id)?.state).toBe('consumed')
    db.close()
  })

  it('allows exactly one redemption across two concurrent SQLite connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestra-device-race-'))
    const databasePath = join(directory, 'orchestra.db')
    try {
      const db = new Database(databasePath)
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      installDeviceSessionSchema(db)
      const repository = new SqliteDeviceSessionRepository(db)
      const issue = repository.createPairingTicket({
        expectedOrigin: 'https://remote.example',
        actor: owner,
      })
      db.close()
      const input = {
        pairingTicket: issue.pairing_ticket,
        origin: 'https://remote.example',
        deviceName: 'Concurrent phone',
        devicePublicKeyJwk: phoneJwk,
      }
      const outcomes = await Promise.all([
        raceWorker({ database: databasePath, operation: 'redeem', input }),
        raceWorker({ database: databasePath, operation: 'redeem', input }),
      ])
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
      const inspected = new Database(databasePath)
      expect(inspected.prepare('SELECT count(*) AS count FROM os_device_sessions').get())
        .toEqual({ count: 1 })
      expect(inspected.prepare('SELECT count(*) AS count FROM os_device_credentials').get())
        .toEqual({ count: 1 })
      inspected.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed for expired tickets and supports explicit ticket revocation', () => {
    const { db, repository, setNow } = fixture()
    const expired = repository.createPairingTicket({
      expectedOrigin: 'https://remote.example',
      actor: owner,
      expiresInSeconds: 1,
    })
    setNow('2026-08-02T12:00:02.000Z')
    expect(repository.getPairingTicket(expired.ticket.id)?.state).toBe('expired')
    expect(() => repository.redeemPairingTicket({
      pairingTicket: expired.pairing_ticket,
      origin: 'https://remote.example',
      deviceName: 'Late phone',
      devicePublicKeyJwk: phoneJwk,
    })).toThrow(/pairing ticket is invalid or unavailable/)

    setNow('2026-08-02T12:01:00.000Z')
    const revoked = repository.createPairingTicket({
      expectedOrigin: 'https://remote.example',
      actor: owner,
    })
    expect(repository.revokePairingTicket(revoked.ticket.id, {
      reason: 'pairing display was exposed',
      actor: owner,
    })).toMatchObject({ state: 'revoked', revocation_reason: 'pairing display was exposed' })
    expect(() => repository.redeemPairingTicket({
      pairingTicket: revoked.pairing_ticket,
      origin: 'https://remote.example',
      deviceName: 'Captured phone',
      devicePublicKeyJwk: phoneJwk,
    })).toThrow(/pairing ticket is invalid or unavailable/)
    db.close()
  })

  it('requires verified key binding and explicit granted scopes', () => {
    const { db, repository } = fixture()
    const redemption = pair(repository)
    const principal = verify(repository, redemption.credential_issue)
    expect(principal).toMatchObject({
      kind: 'device_session',
      device_session_id: redemption.device_session.id,
      credential_id: redemption.credential_issue.credential_metadata.id,
      scopes: DEFAULT_PHONE_DEVICE_SCOPES,
      public_key_thumbprint: phoneThumbprint,
    })
    expect(repository.getDeviceSession(redemption.device_session.id)?.last_seen_at)
      .toBe('2026-08-02T12:00:00.000Z')

    expect(() => verify(repository, redemption.credential_issue, tabletKeys.privateKey))
      .toThrow(/device credential is invalid or unavailable/)
    expect(() => repository.verifyDeviceCredential({
      credential: redemption.credential_issue.credential,
      proofPayload: 'GET\n/api/v1/os/devices/self\nnonce-admin',
      proofSignature: signature(phoneKeys.privateKey, 'GET\n/api/v1/os/devices/self\nnonce-admin'),
      requiredScopes: ['admin'],
    })).toThrow(/device scope is not authorized/)
    db.close()
  })

  it('rotates credentials atomically and invalidates the prior bearer and key binding', () => {
    const { db, repository } = fixture()
    const redemption = pair(repository)
    const rotated = repository.rotateDeviceCredential({
      deviceSessionId: redemption.device_session.id,
      currentCredentialId: redemption.credential_issue.credential_metadata.id,
      proofPayload: 'POST\n/api/v1/os/devices/self/rotate\nnonce-rotate',
      proofSignature: signature(
        phoneKeys.privateKey,
        'POST\n/api/v1/os/devices/self/rotate\nnonce-rotate',
      ),
      newPublicKeyJwk: tabletJwk,
      actor: { type: 'device_session', id: redemption.device_session.id },
    })
    expect(rotated.credential_metadata).toMatchObject({
      state: 'active',
      rotation_generation: 1,
      rotated_from_id: redemption.credential_issue.credential_metadata.id,
      public_key_thumbprint: tabletThumbprint,
    })
    expect(() => verify(repository, redemption.credential_issue))
      .toThrow(/device credential is invalid or unavailable/)
    expect(verify(repository, rotated, tabletKeys.privateKey).rotation_generation).toBe(1)
    expect(repository.getDeviceSession(redemption.device_session.id)).toMatchObject({
      public_key_thumbprint: tabletThumbprint,
      rotation_counter: 1,
    })
    const phoneJson = JSON.stringify({
      crv: phoneJwk.crv, kty: phoneJwk.kty, x: phoneJwk.x, y: phoneJwk.y,
    })
    expect(() => db.prepare(`UPDATE os_device_credentials
      SET public_key_thumbprint=?, public_key_jwk_json=? WHERE id=?`)
      .run(phoneThumbprint, phoneJson, rotated.credential_metadata.id))
      .toThrow(/device credential identity is immutable/)
    expect(() => db.prepare(`UPDATE os_device_sessions
      SET public_key_thumbprint=?, public_key_jwk_json=? WHERE id=?`)
      .run(phoneThumbprint, phoneJson, redemption.device_session.id))
      .toThrow(/device session key rotation is inconsistent/)
    expect(repository.listDeviceCredentials(redemption.device_session.id)
      .map((credential) => credential.state)).toEqual(['active', 'rotated'])
    db.close()
  })

  it('selectively revokes one lost device without changing unrelated sessions', () => {
    const { db, repository } = fixture()
    const phone = pair(repository, 'Lost phone', phoneJwk)
    const tablet = pair(repository, 'Desk tablet', tabletJwk)

    const result = repository.revokeDeviceSession(phone.device_session.id, {
      reason: 'reported lost',
      actor: owner,
      compromised: true,
    })
    expect(result.device_session).toMatchObject({
      state: 'compromised',
      revocation_reason: 'reported lost',
      revocation_version: 1,
    })
    expect(result.revoked_credential_ids)
      .toEqual([phone.credential_issue.credential_metadata.id])
    expect(() => verify(repository, phone.credential_issue, phoneKeys.privateKey))
      .toThrow(/device credential is invalid or unavailable/)
    expect(verify(repository, tablet.credential_issue, tabletKeys.privateKey).device_session_id)
      .toBe(tablet.device_session.id)
    expect(repository.getDeviceSession(tablet.device_session.id)?.state).toBe('active')
    expect(repository.listDeviceCredentials(tablet.device_session.id)[0]?.state).toBe('active')
    expect(db.prepare(`SELECT state FROM os_device_credentials
      WHERE device_session_id=?`).get(phone.device_session.id)).toEqual({ state: 'revoked' })
    expect(db.prepare(`SELECT state FROM os_device_sessions WHERE id=?`)
      .get(tablet.device_session.id)).toEqual({ state: 'active' })
    db.close()
  })

  it('leaves no active authority after a concurrent credential-rotate and lost-device revoke', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestra-device-revoke-race-'))
    const databasePath = join(directory, 'orchestra.db')
    try {
      const db = new Database(databasePath)
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      installDeviceSessionSchema(db)
      const repository = new SqliteDeviceSessionRepository(db)
      const paired = pair(repository)
      db.close()
      const proofPayload = 'POST\n/api/v1/os/devices/self/rotate\nnonce-race'
      const privateJwk = phoneKeys.privateKey.export({ format: 'jwk' })
      const outcomes = await Promise.all([
        raceWorker({
          database: databasePath,
          operation: 'rotate',
          privateJwk,
          input: {
            deviceSessionId: paired.device_session.id,
            currentCredentialId: paired.credential_issue.credential_metadata.id,
            proofPayload,
            actor: { type: 'device_session', id: paired.device_session.id },
          },
        }),
        raceWorker({
          database: databasePath,
          operation: 'revoke',
          sessionId: paired.device_session.id,
        }),
      ])
      expect(outcomes.some((outcome) => outcome.ok)).toBe(true)
      const inspected = new Database(databasePath)
      expect(inspected.prepare('SELECT state FROM os_device_sessions WHERE id=?')
        .get(paired.device_session.id)).toEqual({ state: 'compromised' })
      expect(inspected.prepare(`SELECT count(*) AS count FROM os_device_credentials
        WHERE device_session_id=? AND state='active'`).get(paired.device_session.id))
        .toEqual({ count: 0 })
      inspected.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('supports individual credential revocation and rejects expired credentials', () => {
    const { db, repository, setNow } = fixture()
    const revoked = pair(repository)
    expect(repository.revokeDeviceCredential(revoked.credential_issue.credential_metadata.id, {
      reason: 'credential copied',
      actor: owner,
    })).toMatchObject({ state: 'revoked', terminal_reason: 'credential copied' })
    expect(repository.getDeviceSession(revoked.device_session.id)?.state).toBe('active')
    expect(() => verify(repository, revoked.credential_issue))
      .toThrow(/device credential is invalid or unavailable/)

    const expiring = pair(repository, 'Short credential', tabletJwk)
    setNow('2026-08-02T12:15:01.000Z')
    expect(repository.listDeviceCredentials(expiring.device_session.id)[0]?.state).toBe('expired')
    expect(db.prepare(`SELECT state, terminal_by_actor_type FROM os_device_credentials
      WHERE device_session_id=?`).get(expiring.device_session.id)).toEqual({
      state: 'expired',
      terminal_by_actor_type: 'system',
    })
    expect(() => verify(repository, expiring.credential_issue, tabletKeys.privateKey))
      .toThrow(/device credential is invalid or unavailable/)
    db.close()
  })

  it('does not accept insecure non-loopback HTTP pairing origins', () => {
    const { db, repository } = fixture()
    expect(() => repository.createPairingTicket({
      expectedOrigin: 'http://remote.example',
      actor: owner,
    })).toThrow(/HTTPS origin or loopback HTTP origin/)
    expect(() => repository.createPairingTicket({
      expectedOrigin: 'https://remote.example/path?token=never',
      actor: owner,
    })).toThrow(/HTTPS origin or loopback HTTP origin/)
    expect(repository.createPairingTicket({
      expectedOrigin: 'http://127.0.0.1:4173',
      actor: owner,
    }).ticket.expected_origin).toBe('http://127.0.0.1:4173')
    db.close()
  })
})

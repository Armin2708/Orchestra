import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  REMOTE_DEVICE_PROOF_SCHEMA_SQL,
  RemoteDeviceProofReplayStore,
  remotePublicKeyThumbprint,
  verifyRemoteDeviceProof,
} from '../src/remote-device-proof.js'

const now = new Date('2026-08-02T08:00:00.000Z')
const credential = 'orchestra_device_v1.credential-id.secret-material'
const target = 'https://device.example.test/api/v1/boards/1?ignored=query'

function fixture() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const publicJwk = pair.publicKey.export({ format: 'jwk' })
  const proof = (
    overrides: Partial<{ htm: string; htu: string; iat: number; jti: string; ath: string }> = {},
  ) => {
    const header = Buffer.from(JSON.stringify({
      alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk,
    })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({
      htm: 'GET',
      htu: 'https://device.example.test/api/v1/boards/1',
      iat: Math.floor(now.getTime() / 1_000),
      jti: 'proof-once-1',
      ath: Buffer.from(sha256(credential)).toString('base64url'),
      ...overrides,
    })).toString('base64url')
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
      key: pair.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    return `${header}.${claims}.${signature}`
  }
  return { pair, publicJwk, proof }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

describe('remote device proof', () => {
  it('verifies ES256 possession and binds method, target, credential, and public thumbprint', () => {
    const { publicJwk, proof } = fixture()
    const verified = verifyRemoteDeviceProof({
      proof: proof(), credential, method: 'GET', url: target, now,
    })
    expect(verified.publicKeyThumbprint).toBe(remotePublicKeyThumbprint(publicJwk))
    expect(verified.claims).toMatchObject({
      htm: 'GET', htu: 'https://device.example.test/api/v1/boards/1', jti: 'proof-once-1',
    })
  })

  it('rejects target, credential, clock, and signature changes', () => {
    const { proof } = fixture()
    expect(() => verifyRemoteDeviceProof({
      proof: proof(), credential, method: 'POST', url: target, now,
    })).toThrow(/target mismatch/)
    expect(() => verifyRemoteDeviceProof({
      proof: proof(), credential: `${credential}-stolen`, method: 'GET', url: target, now,
    })).toThrow(/credential mismatch/)
    expect(() => verifyRemoteDeviceProof({
      proof: proof({ iat: Math.floor(now.getTime() / 1_000) - 120 }),
      credential, method: 'GET', url: target, now,
    })).toThrow(/expired/)
    const original = proof()
    const signatureOffset = original.lastIndexOf('.') + 2
    const tampered = `${original.slice(0, signatureOffset)}${original[signatureOffset] === 'A' ? 'B' : 'A'}${original.slice(signatureOffset + 1)}`
    expect(() => verifyRemoteDeviceProof({
      proof: tampered, credential, method: 'GET', url: target, now,
    })).toThrow(/signature/)
  })

  it('persists hashed proof identities so replay stays denied after verifier restart', () => {
    const { proof } = fixture()
    const verified = verifyRemoteDeviceProof({
      proof: proof(), credential, method: 'GET', url: target, now,
    })
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec('CREATE TABLE os_device_sessions (id TEXT PRIMARY KEY);')
    db.exec(REMOTE_DEVICE_PROOF_SCHEMA_SQL)
    db.prepare('INSERT INTO os_device_sessions (id) VALUES (?)').run('device-1')
    new RemoteDeviceProofReplayStore(db).consume({
      deviceSessionId: 'device-1', credentialGeneration: 0, proof: verified, now,
    })
    expect(() => new RemoteDeviceProofReplayStore(db).consume({
      deviceSessionId: 'device-1', credentialGeneration: 0, proof: verified, now,
    })).toThrow(/replayed/)
    const stored = db.prepare('SELECT jti_hash FROM os_device_proof_replays').get() as {
      jti_hash: string
    }
    expect(stored.jti_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.jti_hash).not.toContain(verified.claims.jti)
    db.close()
  })
})

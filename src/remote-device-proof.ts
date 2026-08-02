import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import type Database from 'better-sqlite3'
import BetterSqlite3 from 'better-sqlite3'

export const REMOTE_DEVICE_PROOF_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS os_device_proof_replays (
    device_session_id TEXT NOT NULL
      REFERENCES os_device_sessions(id) ON DELETE CASCADE,
    jti_hash TEXT NOT NULL CHECK(length(jti_hash)=64),
    credential_generation INTEGER NOT NULL CHECK(credential_generation >= 0),
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY(device_session_id, jti_hash)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_os_device_proof_replays_expiry
    ON os_device_proof_replays(expires_at);
`

type ProofSchemaRecord = { type: string; name: string; sql: string }
const proofObjects = ['os_device_proof_replays', 'idx_os_device_proof_replays_expiry'] as const
const normalizeSchemaSql = (sql: string): string => sql.replace(/\s+/gu, ' ').replace(/;\s*$/u, '').trim()
const proofSchemaRecords = (db: Database.Database): ProofSchemaRecord[] => db.prepare(
  `SELECT type, name, sql FROM sqlite_master WHERE name IN (?, ?) ORDER BY type, name`,
).all(...proofObjects) as ProofSchemaRecord[]
let proofReference: ReadonlyMap<string, ProofSchemaRecord> | undefined

function expectedProofSchema(): ReadonlyMap<string, ProofSchemaRecord> {
  if (proofReference) return proofReference
  const reference = new BetterSqlite3(':memory:')
  reference.pragma('foreign_keys = OFF')
  try {
    reference.exec(REMOTE_DEVICE_PROOF_SCHEMA_SQL)
    proofReference = new Map(proofSchemaRecords(reference).map((record) => [record.name, record]))
    return proofReference
  } finally { reference.close() }
}

export function installRemoteDeviceProofSchema(db: Database.Database): void {
  const install = db.transaction(() => {
    const wanted = expectedProofSchema()
    for (const record of proofSchemaRecords(db)) {
      const expected = wanted.get(record.name)
      if (!expected || expected.type !== record.type
        || normalizeSchemaSql(expected.sql) !== normalizeSchemaSql(record.sql)) {
        throw new Error(`remote proof schema object ${record.name} is incompatible`)
      }
    }
    db.exec(REMOTE_DEVICE_PROOF_SCHEMA_SQL)
    const actual = new Map(proofSchemaRecords(db).map((record) => [record.name, record]))
    for (const [name, expected] of wanted) {
      const record = actual.get(name)
      if (!record || record.type !== expected.type
        || normalizeSchemaSql(expected.sql) !== normalizeSchemaSql(record.sql)) {
        throw new Error(`remote proof schema object ${name} is missing or incompatible`)
      }
    }
  })
  install.immediate()
}

export interface RemoteDeviceProofClaims {
  htm: string
  htu: string
  iat: number
  jti: string
  ath: string
}

export interface VerifiedRemoteDeviceProof {
  publicKeyJwk: JsonWebKey
  publicKeyThumbprint: string
  claims: RemoteDeviceProofClaims
}

export interface VerifyRemoteDeviceProofInput {
  proof: string
  credential: string
  method: string
  url: string
  now?: Date
  maxAgeSeconds?: number
  clockSkewSeconds?: number
}

type ProofHeader = {
  alg?: unknown
  typ?: unknown
  jwk?: unknown
}

const base64url = (value: Buffer): string => value.toString('base64url')
const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest()

const boundedText = (value: unknown, name: string, maximum: number): string => {
  if (typeof value !== 'string' || !value || value.length > maximum
    || /[\0-\x1f\x7f]/u.test(value)) throw new Error(`invalid device proof ${name}`)
  return value
}

const parsePart = <T>(value: string, name: string): T => {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T
  } catch {
    throw new Error(`invalid device proof ${name}`)
  }
}

const normalizeHtu = (value: string): string => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('invalid device proof target URL')
  }
  url.search = ''
  return `${url.origin}${url.pathname}`
}

export function remotePublicKeyThumbprint(value: JsonWebKey): string {
  if (value.kty !== 'EC' || value.crv !== 'P-256'
    || typeof value.x !== 'string' || typeof value.y !== 'string'
    || value.d !== undefined) throw new Error('device proof requires a public P-256 JWK')
  const canonical = JSON.stringify({ crv: 'P-256', kty: 'EC', x: value.x, y: value.y })
  return base64url(sha256(canonical))
}

/**
 * Verifies a compact ES256 proof without trusting any caller-supplied thumbprint. The proof is
 * bound to the credential hash, HTTP method, origin/path, a short clock window, and a random jti.
 */
export function verifyRemoteDeviceProof(
  input: VerifyRemoteDeviceProofInput,
): VerifiedRemoteDeviceProof {
  const parts = input.proof.split('.')
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('invalid device proof')
  const header = parsePart<ProofHeader>(parts[0], 'header')
  const claims = parsePart<Partial<RemoteDeviceProofClaims>>(parts[1], 'claims')
  if (header.alg !== 'ES256' || header.typ !== 'dpop+jwt'
    || !header.jwk || typeof header.jwk !== 'object') throw new Error('invalid device proof header')
  const publicKeyJwk = header.jwk as JsonWebKey
  const publicKeyThumbprint = remotePublicKeyThumbprint(publicKeyJwk)
  const key = createPublicKey({ key: publicKeyJwk, format: 'jwk' })
  const signature = Buffer.from(parts[2], 'base64url')
  if (signature.length !== 64 || !verifySignature(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: 'ieee-p1363' },
    signature,
  )) throw new Error('invalid device proof signature')

  const htm = boundedText(claims.htm, 'method', 16).toUpperCase()
  const htu = normalizeHtu(boundedText(claims.htu, 'target', 2_048))
  const jti = boundedText(claims.jti, 'jti', 128)
  const ath = boundedText(claims.ath, 'credential digest', 128)
  if (!Number.isSafeInteger(claims.iat)) throw new Error('invalid device proof issued-at')
  const clock = (input.now ?? new Date()).getTime()
  if (!Number.isFinite(clock)) throw new Error('invalid device proof clock')
  const now = Math.floor(clock / 1_000)
  const maxAge = input.maxAgeSeconds ?? 60
  const skew = input.clockSkewSeconds ?? 5
  if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 300
    || !Number.isSafeInteger(skew) || skew < 0 || skew > 60) {
    throw new Error('invalid device proof clock policy')
  }
  if (claims.iat! > now + skew || claims.iat! < now - maxAge - skew) {
    throw new Error('device proof is expired')
  }
  if (htm !== input.method.toUpperCase() || htu !== normalizeHtu(input.url)) {
    throw new Error('device proof target mismatch')
  }
  const expectedAth = base64url(sha256(input.credential))
  const suppliedAth = Buffer.from(ath)
  const expected = Buffer.from(expectedAth)
  if (suppliedAth.length !== expected.length || !timingSafeEqual(suppliedAth, expected)) {
    throw new Error('device proof credential mismatch')
  }
  return {
    publicKeyJwk,
    publicKeyThumbprint,
    claims: { htm, htu, iat: claims.iat!, jti, ath },
  }
}

export class RemoteDeviceProofReplayStore {
  constructor(private readonly db: Database.Database) {}

  consume(input: {
    deviceSessionId: string
    credentialGeneration: number
    proof: VerifiedRemoteDeviceProof
    now?: Date
    retentionSeconds?: number
  }): void {
    const now = input.now ?? new Date()
    const retentionSeconds = input.retentionSeconds ?? 300
    if (!Number.isFinite(now.getTime())
      || !Number.isSafeInteger(input.credentialGeneration) || input.credentialGeneration < 0
      || !Number.isSafeInteger(retentionSeconds) || retentionSeconds < 60
      || retentionSeconds > 3_600) throw new Error('invalid proof replay policy')
    const jtiHash = createHash('sha256')
      .update(input.deviceSessionId)
      .update('\0')
      .update(input.proof.claims.jti)
      .digest('hex')
    const expiresAt = new Date(now.getTime() + retentionSeconds * 1_000).toISOString()
    const consume = this.db.transaction(() => {
      this.db.prepare('DELETE FROM os_device_proof_replays WHERE expires_at<=?')
        .run(now.toISOString())
      try {
        this.db.prepare(`INSERT INTO os_device_proof_replays (
          device_session_id, jti_hash, credential_generation, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)`).run(
          input.deviceSessionId,
          jtiHash,
          input.credentialGeneration,
          new Date(input.proof.claims.iat * 1_000).toISOString(),
          expiresAt,
        )
      } catch (error) {
        if (error && typeof error === 'object'
          && String((error as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')) {
          throw new Error('device proof was replayed')
        }
        throw error
      }
    })
    consume.immediate()
  }
}

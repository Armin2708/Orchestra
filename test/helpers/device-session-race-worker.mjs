import Database from 'better-sqlite3'
import { createPrivateKey, sign } from 'node:crypto'
import { SqliteDeviceSessionRepository } from '../../src/agent-os/device-sessions.ts'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const workerData = JSON.parse(Buffer.concat(chunks).toString('utf8'))

const db = new Database(workerData.database)
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')
const repository = new SqliteDeviceSessionRepository(db)

try {
  let result
  if (workerData.operation === 'redeem') {
    result = repository.redeemPairingTicket(workerData.input).device_session.id
  } else if (workerData.operation === 'rotate') {
    const privateKey = createPrivateKey({ key: workerData.privateJwk, format: 'jwk' })
    const proofSignature = sign('sha256', Buffer.from(workerData.input.proofPayload), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    result = repository.rotateDeviceCredential({
      ...workerData.input,
      proofSignature,
    }).credential_metadata.id
  } else if (workerData.operation === 'revoke') {
    result = repository.revokeDeviceSession(workerData.sessionId, {
      reason: 'lost-device race',
      actor: { type: 'human', id: 'owner' },
      compromised: true,
    }).device_session.id
  } else {
    throw new Error('unsupported worker operation')
  }
  process.stdout.write(JSON.stringify({ ok: true, result }))
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }))
} finally {
  db.close()
}

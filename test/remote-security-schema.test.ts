import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import {
  AGENT_OS_DEVICE_SESSION_MIGRATION_ID,
  installDeviceSessionSchema,
} from '../src/agent-os/device-session-migration.js'
import { installRemoteSecuritySchema } from '../src/remote-security-schema.js'

describe('remote security migration attestation', () => {
  it('replays migration 040 after marker loss without changing the attested object set', () => {
    const db = openDb(':memory:')
    const before = db.prepare(`SELECT type, name, sql FROM sqlite_master
      WHERE name LIKE 'os_remote_%' OR name LIKE 'os_pairing_ticket_resource_%'
      OR name LIKE 'idx_os_remote_%' ORDER BY type, name`).all()
    db.prepare('DELETE FROM os_schema_migrations WHERE id=?')
      .run(AGENT_OS_DEVICE_SESSION_MIGRATION_ID)
    applyAgentOsMigrations(db)
    expect(db.prepare('SELECT id FROM os_schema_migrations WHERE id=?')
      .get(AGENT_OS_DEVICE_SESSION_MIGRATION_ID))
      .toEqual({ id: AGENT_OS_DEVICE_SESSION_MIGRATION_ID })
    expect(db.prepare(`SELECT type, name, sql FROM sqlite_master
      WHERE name LIKE 'os_remote_%' OR name LIKE 'os_pairing_ticket_resource_%'
      OR name LIKE 'idx_os_remote_%' ORDER BY type, name`).all()).toEqual(before)
    db.close()
  })

  it('fails before mutation when a same-name remote authority table is weakened', () => {
    const db = new BetterSqlite3(':memory:')
    installDeviceSessionSchema(db)
    db.exec('CREATE TABLE os_remote_mutation_audit (id TEXT PRIMARY KEY)')
    expect(() => installRemoteSecuritySchema(db)).toThrow(/os_remote_mutation_audit is incompatible/)
    expect(db.prepare(`SELECT count(*) AS count FROM sqlite_master
      WHERE name LIKE 'os_remote_%' OR name LIKE 'os_pairing_ticket_resource_%'`).get())
      .toEqual({ count: 1 })
    db.close()
  })

  it('keeps consumed and revoked step-up authority terminal', () => {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO boards (project_path, name) VALUES ('/remote-schema', 'Remote')").run()
    const ticketId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const now = new Date().toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()
    db.prepare(`INSERT INTO os_pairing_tickets
      (id, secret_hash, expected_origin, requested_scopes_json, state, created_by_actor_type,
       created_at, expires_at, session_ttl_seconds, credential_ttl_seconds)
      VALUES (?, ?, 'https://phone.example.test', '["admin"]', 'pending', 'test', ?, ?, 3600, 900)`)
      .run(ticketId, 'a'.repeat(64), now, future)
    db.prepare(`INSERT INTO os_device_sessions
      (id, name, state, scopes_json, public_key_thumbprint, public_key_jwk_json,
       created_from_ticket_id, created_by_actor_type, created_at, activated_at, expires_at)
      VALUES (?, 'phone', 'active', '["admin"]', ?, ?, ?, 'test', ?, ?, ?)`)
      .run(sessionId, 'b'.repeat(64), '{"kty":"EC","crv":"P-256","x":"x","y":"y"}', ticketId, now, now, future)
    db.prepare(`UPDATE os_pairing_tickets SET state='consumed', consumed_at=?, consumed_session_id=?
      WHERE id=?`).run(now, sessionId, ticketId)
    const grantId = crypto.randomUUID()
    db.prepare(`INSERT INTO os_remote_step_up_grants
      (id, device_session_id, authenticated_user_id, credential_generation, operation,
       resource_type, resource_id, request_digest, nonce, state, issued_at,
       user_verified_at, expires_at, consumed_at)
      VALUES (?, ?, 'local-owner', 0, 'device.revoke', 'device', ?, ?, ?, 'consumed', ?, ?, ?, ?)`)
      .run(grantId, sessionId, sessionId, `sha256:${'c'.repeat(64)}`, crypto.randomUUID(), now, now, future, now)
    expect(() => db.prepare("UPDATE os_remote_step_up_grants SET state='active', consumed_at=NULL WHERE id=?")
      .run(grantId)).toThrow(/irreversible/)
    db.close()
  })
})

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  AGENT_OS_DEVICE_SESSION_MIGRATION_ID,
  DEVICE_SESSION_INDEXES,
  DEVICE_SESSION_TABLES,
  DEVICE_SESSION_TRIGGERS,
  deviceSessionSchemaFingerprint,
  installDeviceSessionSchema,
} from '../src/agent-os/device-session-migration.js'

function database(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return db
}

describe('device session schema', () => {
  it('installs the additive migration-030 schema and safely replays it', () => {
    const db = database()
    expect(AGENT_OS_DEVICE_SESSION_MIGRATION_ID).toBe('030-device-sessions')

    installDeviceSessionSchema(db)
    expect(() => installDeviceSessionSchema(db)).not.toThrow()
    expect(deviceSessionSchemaFingerprint(db)).toMatch(/^[0-9a-f]{64}$/)

    const objects = new Set((db.prepare(`SELECT name FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger')`).all() as Array<{ name: string }>)
      .map((row) => row.name))
    for (const name of [
      ...DEVICE_SESSION_TABLES,
      ...DEVICE_SESSION_INDEXES,
      ...DEVICE_SESSION_TRIGGERS,
    ]) {
      expect(objects.has(name), name).toBe(true)
    }
    db.close()
  })

  it('fails closed instead of adopting a partial credential table', () => {
    const db = database()
    db.exec('CREATE TABLE os_device_credentials (id TEXT PRIMARY KEY)')

    expect(() => installDeviceSessionSchema(db))
      .toThrow(/os_device_credentials is incompatible/)
    expect(db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='os_pairing_tickets'`).get()).toBeUndefined()
    db.close()
  })

  it('enforces one active credential per session and immutable authority material', () => {
    const db = database()
    installDeviceSessionSchema(db)
    const at = '2026-08-02T12:00:00.000Z'
    const later = '2026-08-02T12:15:00.000Z'
    db.prepare(`INSERT INTO os_pairing_tickets (
      id, secret_hash, expected_origin, requested_scopes_json,
      session_ttl_seconds, credential_ttl_seconds, state,
      created_by_actor_type, created_at, expires_at
    ) VALUES ('ticket', ?, 'https://remote.example', '["observe"]',
      3600, 900, 'pending', 'human', ?, ?)`)
      .run('a'.repeat(64), at, later)
    db.prepare(`INSERT INTO os_device_sessions (
      id, name, state, scopes_json, public_key_thumbprint, public_key_jwk_json,
      created_from_ticket_id,
      created_by_actor_type, created_at, activated_at, expires_at, last_seen_at
    ) VALUES ('session', 'Phone', 'active', '["observe"]', ?, ?, 'ticket',
      'human', ?, ?, ?, ?)`)
      .run(`sha256:${'b'.repeat(64)}`, '{"kty":"EC"}', at, at, later, at)
    db.prepare(`INSERT INTO os_device_credentials (
      id, device_session_id, secret_hash, public_key_thumbprint, public_key_jwk_json, state,
      rotation_generation, issued_at, expires_at
    ) VALUES ('credential-1', 'session', ?, ?, ?, 'active', 0, ?, ?)`)
      .run('c'.repeat(64), `sha256:${'b'.repeat(64)}`, '{"kty":"EC"}', at, later)

    expect(() => db.prepare(`INSERT INTO os_device_credentials (
      id, device_session_id, secret_hash, public_key_thumbprint, public_key_jwk_json, state,
      rotation_generation, issued_at, expires_at
    ) VALUES ('credential-2', 'session', ?, ?, ?, 'active', 1, ?, ?)`)
      .run('d'.repeat(64), `sha256:${'b'.repeat(64)}`, '{"kty":"EC"}', at, later))
      .toThrow(/UNIQUE constraint failed/)
    expect(() => db.prepare(`UPDATE os_device_credentials
      SET secret_hash=? WHERE id='credential-1'`).run('e'.repeat(64)))
      .toThrow(/device credential identity is immutable/)
    db.close()
  })

  it('rejects same-name weakened schema objects atomically', () => {
    const db = database()
    installDeviceSessionSchema(db)
    db.exec(`
      DROP TRIGGER os_device_credentials_identity_immutable;
      CREATE TRIGGER os_device_credentials_identity_immutable
        AFTER INSERT ON os_device_credentials BEGIN SELECT 1; END;
      DROP INDEX idx_os_device_credentials_one_active;
      CREATE INDEX idx_os_device_credentials_one_active
        ON os_device_credentials(device_session_id);
      DROP TABLE os_pairing_tickets;
    `)

    expect(() => installDeviceSessionSchema(db))
      .toThrow(/device session schema object .* is incompatible/)
    expect(db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='os_pairing_tickets'`).get()).toBeUndefined()
    db.close()
  })
})

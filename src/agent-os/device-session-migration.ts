import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

export const DEVICE_SESSION_SCHEMA_VERSION = 1 as const
export const AGENT_OS_DEVICE_SESSION_MIGRATION_ID = '040-device-sessions' as const
export const AGENT_OS_LEGACY_DEVICE_SESSION_MIGRATION_ID = '030-device-sessions' as const

export const DEVICE_SESSION_TABLES = Object.freeze([
  'os_pairing_tickets',
  'os_device_sessions',
  'os_device_credentials',
] as const)

export const DEVICE_SESSION_INDEXES = Object.freeze([
  'idx_os_pairing_tickets_expiry',
  'idx_os_device_sessions_expiry',
  'idx_os_device_sessions_state',
  'idx_os_device_credentials_expiry',
  'idx_os_device_credentials_session',
  'idx_os_device_credentials_one_active',
] as const)

export const DEVICE_SESSION_TRIGGERS = Object.freeze([
  'os_pairing_tickets_terminal_state',
  'os_pairing_tickets_secret_immutable',
  'os_device_sessions_terminal_state',
  'os_device_sessions_key_rotation',
  'os_device_credentials_terminal_state',
  'os_device_credentials_identity_immutable',
] as const)

const TABLE_COLUMNS: Readonly<Record<(typeof DEVICE_SESSION_TABLES)[number], readonly string[]>> =
  Object.freeze({
    os_pairing_tickets: [
      'id', 'secret_hash', 'expected_origin', 'requested_scopes_json',
      'session_ttl_seconds', 'credential_ttl_seconds', 'state',
      'created_by_actor_type', 'created_by_actor_id', 'created_at', 'expires_at',
      'consumed_at', 'consumed_session_id', 'revoked_at', 'revocation_reason',
      'revoked_by_actor_type', 'revoked_by_actor_id',
    ],
    os_device_sessions: [
      'id', 'name', 'state', 'scopes_json', 'public_key_thumbprint', 'public_key_jwk_json',
      'created_from_ticket_id', 'created_by_actor_type', 'created_by_actor_id',
      'created_at', 'activated_at', 'expires_at', 'last_seen_at',
      'rotation_counter', 'revocation_version', 'revoked_at', 'revocation_reason',
      'revoked_by_actor_type', 'revoked_by_actor_id',
    ],
    os_device_credentials: [
      'id', 'device_session_id', 'secret_hash', 'public_key_thumbprint', 'public_key_jwk_json',
      'state', 'rotation_generation', 'rotated_from_id', 'issued_at', 'expires_at',
      'last_used_at', 'terminal_at', 'terminal_reason', 'terminal_by_actor_type',
      'terminal_by_actor_id',
    ],
  })

/**
 * Additive R2 schema for PairingTicket, DeviceSession, and per-device credentials.
 * Secret material is represented only by SHA-256 digests. The integration-owned
 * migration registry must call installDeviceSessionSchema from its own migration.
 */
export const DEVICE_SESSION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS os_pairing_tickets (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL UNIQUE,
    expected_origin TEXT NOT NULL,
    requested_scopes_json TEXT NOT NULL,
    session_ttl_seconds INTEGER NOT NULL,
    credential_ttl_seconds INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'consumed', 'expired', 'revoked')),
    created_by_actor_type TEXT NOT NULL,
    created_by_actor_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    consumed_session_id TEXT UNIQUE REFERENCES os_device_sessions(id) ON DELETE RESTRICT,
    revoked_at TEXT,
    revocation_reason TEXT,
    revoked_by_actor_type TEXT,
    revoked_by_actor_id TEXT,
    CHECK (length(secret_hash)=64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (json_valid(requested_scopes_json) AND json_type(requested_scopes_json)='array'),
    CHECK (session_ttl_seconds BETWEEN 60 AND 7776000),
    CHECK (credential_ttl_seconds BETWEEN 30 AND 86400),
    CHECK (expires_at > created_at),
    CHECK ((state='consumed') = (consumed_at IS NOT NULL)),
    CHECK ((state='consumed') = (consumed_session_id IS NOT NULL)),
    CHECK ((state='revoked') = (revoked_at IS NOT NULL)),
    CHECK ((state='revoked') = (revocation_reason IS NOT NULL)),
    CHECK ((state='revoked') = (revoked_by_actor_type IS NOT NULL))
  );

  CREATE TABLE IF NOT EXISTS os_device_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('pending_pairing', 'active', 'expired', 'revoked', 'compromised')
    ),
    scopes_json TEXT NOT NULL,
    public_key_thumbprint TEXT NOT NULL,
    public_key_jwk_json TEXT NOT NULL,
    created_from_ticket_id TEXT NOT NULL UNIQUE
      REFERENCES os_pairing_tickets(id) ON DELETE RESTRICT,
    created_by_actor_type TEXT NOT NULL,
    created_by_actor_id TEXT,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT,
    rotation_counter INTEGER NOT NULL DEFAULT 0,
    revocation_version INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT,
    revocation_reason TEXT,
    revoked_by_actor_type TEXT,
    revoked_by_actor_id TEXT,
    CHECK (length(trim(name)) BETWEEN 1 AND 120),
    CHECK (length(public_key_thumbprint) BETWEEN 32 AND 200),
    CHECK (json_valid(public_key_jwk_json) AND json_type(public_key_jwk_json)='object'),
    CHECK (json_valid(scopes_json) AND json_type(scopes_json)='array'),
    CHECK (expires_at > created_at),
    CHECK (rotation_counter >= 0),
    CHECK (revocation_version >= 0),
    CHECK (state!='active' OR activated_at IS NOT NULL),
    CHECK ((state IN ('revoked', 'compromised')) = (revoked_at IS NOT NULL)),
    CHECK ((state IN ('revoked', 'compromised')) = (revocation_reason IS NOT NULL)),
    CHECK ((state IN ('revoked', 'compromised')) = (revoked_by_actor_type IS NOT NULL))
  );

  CREATE TABLE IF NOT EXISTS os_device_credentials (
    id TEXT PRIMARY KEY,
    device_session_id TEXT NOT NULL
      REFERENCES os_device_sessions(id) ON DELETE RESTRICT,
    secret_hash TEXT NOT NULL UNIQUE,
    public_key_thumbprint TEXT NOT NULL,
    public_key_jwk_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'rotated', 'expired', 'revoked')),
    rotation_generation INTEGER NOT NULL,
    rotated_from_id TEXT UNIQUE
      REFERENCES os_device_credentials(id) ON DELETE RESTRICT,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT,
    terminal_at TEXT,
    terminal_reason TEXT,
    terminal_by_actor_type TEXT,
    terminal_by_actor_id TEXT,
    CHECK (length(secret_hash)=64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(public_key_thumbprint) BETWEEN 32 AND 200),
    CHECK (json_valid(public_key_jwk_json) AND json_type(public_key_jwk_json)='object'),
    CHECK (rotation_generation >= 0),
    CHECK (expires_at > issued_at),
    CHECK ((state='active') = (terminal_at IS NULL)),
    CHECK ((state='active') = (terminal_reason IS NULL)),
    CHECK (state='active' OR terminal_by_actor_type IS NOT NULL)
  );

  CREATE INDEX IF NOT EXISTS idx_os_pairing_tickets_expiry
    ON os_pairing_tickets(state, expires_at);
  CREATE INDEX IF NOT EXISTS idx_os_device_sessions_expiry
    ON os_device_sessions(state, expires_at);
  CREATE INDEX IF NOT EXISTS idx_os_device_sessions_state
    ON os_device_sessions(state, last_seen_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_os_device_credentials_expiry
    ON os_device_credentials(state, expires_at);
  CREATE INDEX IF NOT EXISTS idx_os_device_credentials_session
    ON os_device_credentials(device_session_id, state, rotation_generation);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_os_device_credentials_one_active
    ON os_device_credentials(device_session_id) WHERE state='active';

  CREATE TRIGGER IF NOT EXISTS os_pairing_tickets_terminal_state
    BEFORE UPDATE OF state ON os_pairing_tickets
    WHEN OLD.state!='pending' AND NEW.state!=OLD.state
    BEGIN
      SELECT RAISE(ABORT, 'pairing ticket state is terminal');
    END;

  CREATE TRIGGER IF NOT EXISTS os_pairing_tickets_secret_immutable
    BEFORE UPDATE OF secret_hash, expected_origin, requested_scopes_json,
      session_ttl_seconds, credential_ttl_seconds
    ON os_pairing_tickets
    BEGIN
      SELECT RAISE(ABORT, 'pairing ticket authority is immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS os_device_sessions_terminal_state
    BEFORE UPDATE OF state ON os_device_sessions
    WHEN OLD.state IN ('expired', 'revoked', 'compromised') AND NEW.state!=OLD.state
    BEGIN
      SELECT RAISE(ABORT, 'device session state is terminal');
    END;

  CREATE TRIGGER IF NOT EXISTS os_device_sessions_key_rotation
    BEFORE UPDATE OF public_key_thumbprint, public_key_jwk_json, rotation_counter
    ON os_device_sessions
    WHEN NEW.public_key_thumbprint!=OLD.public_key_thumbprint
      OR NEW.public_key_jwk_json!=OLD.public_key_jwk_json
      OR NEW.rotation_counter!=OLD.rotation_counter
    BEGIN
      SELECT CASE WHEN
        OLD.state!='active'
        OR NEW.state!='active'
        OR NEW.rotation_counter!=OLD.rotation_counter+1
        OR NOT EXISTS (
          SELECT 1 FROM os_device_credentials current
          WHERE current.device_session_id=OLD.id
            AND current.state='active'
            AND current.rotation_generation=NEW.rotation_counter
            AND current.public_key_thumbprint=NEW.public_key_thumbprint
            AND current.public_key_jwk_json=NEW.public_key_jwk_json
            AND current.rotated_from_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM os_device_credentials prior
              WHERE prior.id=current.rotated_from_id
                AND prior.device_session_id=OLD.id
                AND prior.state='rotated'
                AND prior.rotation_generation=OLD.rotation_counter
            )
        )
      THEN RAISE(ABORT, 'device session key rotation is inconsistent') END;
    END;

  CREATE TRIGGER IF NOT EXISTS os_device_credentials_terminal_state
    BEFORE UPDATE OF state ON os_device_credentials
    WHEN OLD.state!='active' AND NEW.state!=OLD.state
    BEGIN
      SELECT RAISE(ABORT, 'device credential state is terminal');
    END;

  CREATE TRIGGER IF NOT EXISTS os_device_credentials_identity_immutable
    BEFORE UPDATE OF secret_hash, device_session_id, public_key_thumbprint,
      public_key_jwk_json, rotation_generation, rotated_from_id
    ON os_device_credentials
    BEGIN
      SELECT RAISE(ABORT, 'device credential identity is immutable');
    END;
`

export function installDeviceSessionSchema(db: Database.Database): void {
  const install = db.transaction(() => {
    assertExistingDeviceSessionSchemaCompatible(db)
    db.exec(DEVICE_SESSION_SCHEMA_SQL)
    assertDeviceSessionSchema(db)
  })
  install.immediate()
}

export function deviceSessionSchemaFingerprint(db: Database.Database): string {
  assertDeviceSessionSchema(db)
  const records = ownedSchemaRecords(db)
  return createHash('sha256')
    .update(records.map((record) => `${record.type}:${record.name}:${normalizeSql(record.sql)}`)
      .join('\n'))
    .digest('hex')
}

interface SchemaRecord {
  type: string
  name: string
  sql: string
}

let referenceRecords: ReadonlyMap<string, SchemaRecord> | null = null

function expectedSchemaRecords(): ReadonlyMap<string, SchemaRecord> {
  if (referenceRecords) return referenceRecords
  const reference = new Database(':memory:')
  try {
    reference.exec(DEVICE_SESSION_SCHEMA_SQL)
    referenceRecords = new Map(ownedSchemaRecords(reference).map((record) => [record.name, record]))
    return referenceRecords
  } finally {
    reference.close()
  }
}

function assertExistingDeviceSessionSchemaCompatible(db: Database.Database): void {
  const expected = expectedSchemaRecords()
  for (const actual of ownedSchemaRecords(db)) {
    const wanted = expected.get(actual.name)
    if (
      !wanted
      || wanted.type !== actual.type
      || normalizeSql(wanted.sql) !== normalizeSql(actual.sql)
    ) {
      throw new Error(`device session schema object ${actual.name} is incompatible`)
    }
  }
}

function assertDeviceSessionSchema(db: Database.Database): void {
  const expected = expectedSchemaRecords()
  const actual = new Map(ownedSchemaRecords(db).map((record) => [record.name, record]))
  for (const [name, wanted] of expected) {
    const found = actual.get(name)
    if (
      !found
      || wanted.type !== found.type
      || normalizeSql(wanted.sql) !== normalizeSql(found.sql)
    ) {
      throw new Error(`device session schema object ${name} is missing or incompatible`)
    }
  }
  for (const table of DEVICE_SESSION_TABLES) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name)
    if (
      columns.length !== TABLE_COLUMNS[table].length
      || columns.some((column, index) => column !== TABLE_COLUMNS[table][index])
    ) {
      throw new Error(`device session table ${table} has an incompatible schema`)
    }
  }
}

function ownedSchemaRecords(db: Database.Database): SchemaRecord[] {
  const names = [...DEVICE_SESSION_TABLES, ...DEVICE_SESSION_INDEXES, ...DEVICE_SESSION_TRIGGERS]
  const placeholders = names.map(() => '?').join(',')
  return db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE name IN (${placeholders}) ORDER BY type, name`).all(...names) as SchemaRecord[]
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').replace(/;\s*$/u, '').trim()
}

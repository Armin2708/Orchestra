import Database from 'better-sqlite3'

/** Durable, fail-closed integration state for remote authority and operator evidence. */
export const REMOTE_SECURITY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS os_pairing_ticket_resource_grants (
    pairing_ticket_id TEXT NOT NULL REFERENCES os_pairing_tickets(id) ON DELETE RESTRICT,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
    data_classes_json TEXT NOT NULL CHECK(json_valid(data_classes_json)),
    PRIMARY KEY(pairing_ticket_id, resource_type, resource_id)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS os_remote_resource_grants (
    device_session_id TEXT NOT NULL REFERENCES os_device_sessions(id) ON DELETE RESTRICT,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
    data_classes_json TEXT NOT NULL CHECK(json_valid(data_classes_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(device_session_id, resource_type, resource_id)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS os_remote_step_up_grants (
    id TEXT PRIMARY KEY,
    device_session_id TEXT NOT NULL REFERENCES os_device_sessions(id) ON DELETE RESTRICT,
    authenticated_user_id TEXT NOT NULL,
    credential_generation INTEGER NOT NULL CHECK(credential_generation >= 0),
    operation TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK(request_digest GLOB 'sha256:*'),
    nonce TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('pending','active','consumed','revoked')),
    issued_at TEXT NOT NULL,
    user_verified_at TEXT,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    CHECK((state='consumed') = (consumed_at IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_os_remote_step_up_active
    ON os_remote_step_up_grants(device_session_id, state, expires_at);

  CREATE TABLE IF NOT EXISTS os_remote_mutation_audit (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    operation TEXT NOT NULL,
    rule_id TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('authorized','succeeded','failed','denied')),
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
  CREATE INDEX IF NOT EXISTS idx_os_remote_audit_device
    ON os_remote_mutation_audit(device_session_id, occurred_at, id);

  CREATE TRIGGER IF NOT EXISTS os_remote_mutation_audit_no_update
  BEFORE UPDATE ON os_remote_mutation_audit
  BEGIN SELECT RAISE(ABORT, 'remote mutation audit is append-only'); END;

  CREATE TRIGGER IF NOT EXISTS os_remote_mutation_audit_no_delete
  BEFORE DELETE ON os_remote_mutation_audit
  BEGIN SELECT RAISE(ABORT, 'remote mutation audit is append-only'); END;

  CREATE TABLE IF NOT EXISTS os_remote_security_events (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN (
      'authentication_denied','pairing_disabled','request_rate_limited',
      'step_up_approved','step_up_denied','remote_rollback'
    )),
    outcome TEXT NOT NULL CHECK(outcome IN ('denied','succeeded')),
    device_session_id TEXT REFERENCES os_device_sessions(id) ON DELETE RESTRICT,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('device','local_operator','anonymous')),
    actor_id_hash TEXT,
    request_id TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    sensitive_values_retained INTEGER NOT NULL DEFAULT 0 CHECK(sensitive_values_retained=0)
  );
  CREATE INDEX IF NOT EXISTS idx_os_remote_security_events_device
    ON os_remote_security_events(device_session_id, occurred_at, id);
  CREATE TRIGGER IF NOT EXISTS os_remote_security_events_no_update
  BEFORE UPDATE ON os_remote_security_events
  BEGIN SELECT RAISE(ABORT, 'remote security events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS os_remote_security_events_no_delete
  BEFORE DELETE ON os_remote_security_events
  BEGIN SELECT RAISE(ABORT, 'remote security events are append-only'); END;

  CREATE TABLE IF NOT EXISTS os_remote_rate_limits (
    family TEXT NOT NULL,
    identity_hash TEXT NOT NULL,
    window_started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    request_count INTEGER NOT NULL CHECK(request_count > 0),
    PRIMARY KEY(family, identity_hash)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS os_remote_control_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    state TEXT NOT NULL CHECK(state IN ('enabled','disabled')),
    generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
    disabled_at TEXT,
    disabled_by TEXT,
    reason TEXT,
    CHECK((state='disabled') = (disabled_at IS NOT NULL AND disabled_by IS NOT NULL AND reason IS NOT NULL))
  );
  INSERT OR IGNORE INTO os_remote_control_state
    (id, state, generation, disabled_at, disabled_by, reason)
    VALUES (1, 'enabled', 0, NULL, NULL, NULL);

  CREATE TABLE IF NOT EXISTS os_remote_stream_tickets (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL CHECK(length(secret_hash)=64),
    device_session_id TEXT NOT NULL REFERENCES os_device_sessions(id) ON DELETE RESTRICT,
    credential_id TEXT NOT NULL REFERENCES os_device_credentials(id) ON DELETE RESTRICT,
    credential_generation INTEGER NOT NULL CHECK(credential_generation >= 0),
    purpose TEXT NOT NULL CHECK(purpose='remote-events'),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    CHECK(expires_at > created_at),
    CHECK(consumed_at IS NULL OR consumed_at >= created_at)
  );
  CREATE INDEX IF NOT EXISTS idx_os_remote_stream_active
    ON os_remote_stream_tickets(device_session_id, expires_at, consumed_at);

  CREATE TRIGGER IF NOT EXISTS os_remote_stream_ticket_immutable
  BEFORE UPDATE OF secret_hash, device_session_id, credential_id, credential_generation,
    purpose, created_at, expires_at ON os_remote_stream_tickets
  BEGIN SELECT RAISE(ABORT, 'remote stream ticket authority is immutable'); END;

  CREATE TRIGGER IF NOT EXISTS os_remote_stream_ticket_single_use
  BEFORE UPDATE OF consumed_at ON os_remote_stream_tickets
  WHEN OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
  BEGIN SELECT RAISE(ABORT, 'remote stream ticket is single-use'); END;

  CREATE TABLE IF NOT EXISTS os_remote_messages (
    id TEXT PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    device_session_id TEXT NOT NULL REFERENCES os_device_sessions(id) ON DELETE RESTRICT,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK(request_digest GLOB 'sha256:*'),
    body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 4000),
    target_kind TEXT NOT NULL DEFAULT 'no-tool' CHECK(target_kind='no-tool'),
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','archived')),
    response_body TEXT CHECK(response_body IS NULL OR length(trim(response_body)) BETWEEN 1 AND 4000),
    answered_at TEXT,
    answered_by TEXT,
    UNIQUE(device_session_id, idempotency_key),
    CHECK((status='answered') = (response_body IS NOT NULL AND answered_at IS NOT NULL))
  );

  CREATE TABLE IF NOT EXISTS os_remote_notification_preferences (
    device_session_id TEXT PRIMARY KEY REFERENCES os_device_sessions(id) ON DELETE RESTRICT,
    minimum_severity TEXT NOT NULL DEFAULT 'medium'
      CHECK(minimum_severity IN ('info','low','medium','high','critical')),
    quiet_start TEXT NOT NULL DEFAULT '22:00',
    quiet_end TEXT NOT NULL DEFAULT '07:00',
    preview TEXT NOT NULL DEFAULT 'generic' CHECK(preview IN ('generic','content')),
    push_endpoint_hash TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS os_remote_push_subscriptions (
    id TEXT PRIMARY KEY,
    device_session_id TEXT NOT NULL REFERENCES os_device_sessions(id) ON DELETE RESTRICT,
    endpoint TEXT NOT NULL,
    endpoint_hash TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_os_remote_push_device
    ON os_remote_push_subscriptions(device_session_id, id);

  CREATE TRIGGER IF NOT EXISTS os_remote_step_up_identity_immutable
  BEFORE UPDATE OF device_session_id, authenticated_user_id, credential_generation,
    operation, resource_type, resource_id, request_digest, nonce, issued_at,
    user_verified_at, expires_at ON os_remote_step_up_grants
  WHEN NOT (
    OLD.state='pending' AND NEW.state='active'
    AND OLD.user_verified_at IS NULL AND NEW.user_verified_at IS NOT NULL
    AND NEW.device_session_id=OLD.device_session_id
    AND NEW.authenticated_user_id=OLD.authenticated_user_id
    AND NEW.credential_generation=OLD.credential_generation
    AND NEW.operation=OLD.operation AND NEW.resource_type=OLD.resource_type
    AND NEW.resource_id=OLD.resource_id AND NEW.request_digest=OLD.request_digest
    AND NEW.nonce=OLD.nonce AND NEW.issued_at=OLD.issued_at
    AND NEW.expires_at=OLD.expires_at
  )
  BEGIN SELECT RAISE(ABORT, 'step-up authority is immutable'); END;

  CREATE TRIGGER IF NOT EXISTS os_remote_step_up_state_irreversible
  BEFORE UPDATE OF state, consumed_at ON os_remote_step_up_grants
  WHEN
    OLD.state IN ('consumed','revoked')
    OR (OLD.state='pending' AND NEW.state NOT IN ('active','revoked'))
    OR (OLD.state='active' AND NEW.state NOT IN ('consumed','revoked'))
    OR ((NEW.state='consumed') != (NEW.consumed_at IS NOT NULL))
  BEGIN SELECT RAISE(ABORT, 'step-up state transition is irreversible'); END;
`

const OWNED_OBJECTS = Object.freeze([
  'os_pairing_ticket_resource_grants',
  'os_remote_resource_grants',
  'os_remote_step_up_grants',
  'os_remote_mutation_audit',
  'os_remote_security_events',
  'os_remote_rate_limits',
  'os_remote_control_state',
  'os_remote_stream_tickets',
  'os_remote_messages',
  'os_remote_notification_preferences',
  'os_remote_push_subscriptions',
  'idx_os_remote_step_up_active',
  'idx_os_remote_audit_device',
  'idx_os_remote_security_events_device',
  'idx_os_remote_stream_active',
  'idx_os_remote_push_device',
  'os_remote_mutation_audit_no_update',
  'os_remote_mutation_audit_no_delete',
  'os_remote_security_events_no_update',
  'os_remote_security_events_no_delete',
  'os_remote_step_up_identity_immutable',
  'os_remote_step_up_state_irreversible',
  'os_remote_stream_ticket_immutable',
  'os_remote_stream_ticket_single_use',
] as const)

type SchemaRecord = { type: string; name: string; sql: string }
const normalizedSql = (sql: string): string => sql.replace(/\s+/gu, ' ').replace(/;\s*$/u, '').trim()
const records = (db: Database.Database): SchemaRecord[] => {
  const placeholders = OWNED_OBJECTS.map(() => '?').join(',')
  return db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE name IN (${placeholders}) ORDER BY type, name`).all(...OWNED_OBJECTS) as SchemaRecord[]
}

let expectedRecords: ReadonlyMap<string, SchemaRecord> | undefined
const expected = (): ReadonlyMap<string, SchemaRecord> => {
  if (expectedRecords) return expectedRecords
  const reference = new Database(':memory:')
  reference.pragma('foreign_keys = OFF')
  try {
    reference.exec(REMOTE_SECURITY_SCHEMA_SQL)
    expectedRecords = new Map(records(reference).map((record) => [record.name, record]))
    return expectedRecords
  } finally { reference.close() }
}

const assertExact = (db: Database.Database, allowMissing: boolean): void => {
  const wanted = expected()
  const actual = new Map(records(db).map((record) => [record.name, record]))
  for (const [name, found] of actual) {
    const target = wanted.get(name)
    if (!target || target.type !== found.type || normalizedSql(target.sql) !== normalizedSql(found.sql)) {
      throw new Error(`remote security schema object ${name} is incompatible`)
    }
  }
  if (!allowMissing) {
    for (const name of wanted.keys()) if (!actual.has(name)) {
      throw new Error(`remote security schema object ${name} is missing`)
    }
  }
}

/** Verify that every remote authority object already exists with its exact canonical definition. */
export function attestRemoteSecuritySchema(db: Database.Database): void {
  assertExact(db, false)
}

/** Exact replay-safe installer: weakened same-name objects fail before any mutation. */
export function installRemoteSecuritySchema(db: Database.Database): void {
  const install = db.transaction(() => {
    assertExact(db, true)
    db.exec(REMOTE_SECURITY_SCHEMA_SQL)
    assertExact(db, false)
  })
  install.immediate()
}

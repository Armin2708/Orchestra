import type Database from 'better-sqlite3'

export const AGENT_OS_DELIVERY_TRACKBOOK_MIGRATION_ID =
  '030-delivery-collaboration-trackbook'

export const AGENT_OS_DELIVERY_TRACKBOOK_TABLES = Object.freeze([
  'delivery_verification_runs',
  'delivery_artifact_attestations',
  'delivery_review_comments',
  'delivery_shipments',
  'delivery_regressions',
] as const)

/**
 * Installs the additive Delivery Trackbook provenance schema.
 *
 * The lane root wires this installer as migration 030. Keeping it in a focused
 * module lets the delivery slice remain independent of the central migration
 * registry while still providing one replay-safe migration contract.
 */
export function installDeliveryTrackbookSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      board_id INTEGER NOT NULL,
      workspace_id TEXT,
      card_id INTEGER,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      path TEXT,
      content TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS delivery_verification_runs (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES delivery_reports(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      environment_json TEXT NOT NULL CHECK(json_valid(environment_json)),
      environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
      exit_code INTEGER NOT NULL,
      output_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
      output_sha256 TEXT NOT NULL CHECK(length(output_sha256)=64),
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      recorded_by TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
      created_at TEXT NOT NULL,
      UNIQUE(report_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS delivery_artifact_attestations (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES delivery_reports(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
      content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
      byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('inline','file','command_output','external')),
      source_locator TEXT NOT NULL,
      source_revision TEXT,
      builder TEXT NOT NULL,
      parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
      environment_json TEXT NOT NULL CHECK(json_valid(environment_json)),
      provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
      attestation_sha256 TEXT NOT NULL CHECK(length(attestation_sha256)=64),
      recorded_by TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
      created_at TEXT NOT NULL,
      UNIQUE(report_id, artifact_id),
      UNIQUE(report_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS delivery_review_comments (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES delivery_reports(id) ON DELETE CASCADE,
      criterion_id TEXT,
      deliverable_id TEXT,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
      location_json TEXT NOT NULL CHECK(json_valid(location_json)),
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
      created_at TEXT NOT NULL,
      CHECK((criterion_id IS NOT NULL AND deliverable_id IS NULL)
        OR (criterion_id IS NULL AND deliverable_id IS NOT NULL)),
      UNIQUE(report_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS delivery_shipments (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES delivery_reports(id) ON DELETE RESTRICT,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
      job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      source_repository TEXT NOT NULL,
      source_commit TEXT NOT NULL CHECK(length(source_commit) BETWEEN 7 AND 64),
      destination TEXT NOT NULL,
      deployment_ref TEXT,
      artifact_attestations_json TEXT NOT NULL CHECK(json_valid(artifact_attestations_json)),
      manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
      shipped_by TEXT NOT NULL,
      shipped_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
      created_at TEXT NOT NULL,
      UNIQUE(report_id, idempotency_key),
      UNIQUE(report_id, destination, source_commit)
    );

    CREATE TABLE IF NOT EXISTS delivery_regressions (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES delivery_reports(id) ON DELETE RESTRICT,
      shipment_id TEXT REFERENCES delivery_shipments(id) ON DELETE RESTRICT,
      evidence_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
      summary TEXT NOT NULL,
      reopened_report_id TEXT NOT NULL UNIQUE REFERENCES delivery_reports(id) ON DELETE RESTRICT,
      recorded_by TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
      created_at TEXT NOT NULL,
      UNIQUE(report_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_verification_runs_report
      ON delivery_verification_runs(report_id, finished_at, id);
    CREATE INDEX IF NOT EXISTS idx_delivery_artifact_attestations_report
      ON delivery_artifact_attestations(report_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_delivery_review_comments_report
      ON delivery_review_comments(report_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_delivery_shipments_board
      ON delivery_shipments(board_id, shipped_at, id);
    CREATE INDEX IF NOT EXISTS idx_delivery_regressions_report
      ON delivery_regressions(report_id, observed_at, id);

    CREATE TRIGGER IF NOT EXISTS delivery_verification_runs_immutable
    BEFORE UPDATE ON delivery_verification_runs BEGIN
      SELECT RAISE(ABORT, 'delivery verification runs are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_artifact_attestations_immutable
    BEFORE UPDATE ON delivery_artifact_attestations BEGIN
      SELECT RAISE(ABORT, 'delivery artifact attestations are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_review_comments_immutable
    BEFORE UPDATE ON delivery_review_comments BEGIN
      SELECT RAISE(ABORT, 'delivery review comments are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_shipments_immutable
    BEFORE UPDATE ON delivery_shipments BEGIN
      SELECT RAISE(ABORT, 'delivery shipments are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_regressions_immutable
    BEFORE UPDATE ON delivery_regressions BEGIN
      SELECT RAISE(ABORT, 'delivery regressions are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_attested_artifacts_immutable
    BEFORE UPDATE OF board_id, workspace_id, card_id, kind, name, mime_type, path, content, metadata
      ON artifacts
    WHEN EXISTS (
      SELECT 1 FROM delivery_artifact_attestations attestation
      WHERE attestation.artifact_id=OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'attested delivery artifacts are immutable');
    END;
  `)

  assertDeliveryTrackbookSchema(db)
}

export function assertDeliveryTrackbookSchema(db: Database.Database): void {
  const tables = new Set((db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name LIKE 'delivery_%'`).all() as Array<{ name: string }>).map((row) => row.name))
  for (const table of AGENT_OS_DELIVERY_TRACKBOOK_TABLES) {
    if (!tables.has(table)) throw new Error(`delivery Trackbook migration is missing ${table}`)
  }
}

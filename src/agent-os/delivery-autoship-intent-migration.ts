import type Database from 'better-sqlite3'

export const AGENT_OS_DELIVERY_AUTOSHIP_INTENT_MIGRATION_ID =
  '037-delivery-autoship-intents'

const REQUIRED_TABLES = Object.freeze([
  'delivery_autoship_intents',
  'delivery_autoship_completions',
] as const)

const REQUIRED_TRIGGERS = Object.freeze([
  'delivery_autoship_intents_scope',
  'delivery_autoship_intents_immutable',
  'delivery_autoship_intents_delete_guard',
  'delivery_autoship_completions_scope',
  'delivery_autoship_completions_immutable',
  'delivery_autoship_completions_delete_guard',
] as const)

/**
 * Adds a durable, append-only autoship outbox around the observed shipment ledger.
 * The lane root registers this as migration 037 after shipment integrity migration 035.
 */
export function installDeliveryAutoshipIntentSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_autoship_intents (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL UNIQUE REFERENCES delivery_reports(id) ON DELETE RESTRICT,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
      job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
      source_repository TEXT NOT NULL,
      source_branch TEXT NOT NULL,
      source_commit TEXT NOT NULL CHECK(
        length(source_commit) IN (40,64)
        AND source_commit=lower(source_commit)
        AND source_commit NOT GLOB '*[^0-9a-f]*'
      ),
      destination TEXT NOT NULL CHECK(destination='main'),
      prepared_by TEXT NOT NULL,
      prepared_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_sha256 TEXT NOT NULL CHECK(
        length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_autoship_completions (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL UNIQUE REFERENCES delivery_autoship_intents(id) ON DELETE RESTRICT,
      receipt_id TEXT NOT NULL UNIQUE REFERENCES delivery_shipment_receipts(id) ON DELETE RESTRICT,
      shipment_id TEXT NOT NULL UNIQUE REFERENCES delivery_shipments(id) ON DELETE RESTRICT,
      observed_head_commit TEXT NOT NULL CHECK(
        length(observed_head_commit) IN (40,64)
        AND observed_head_commit=lower(observed_head_commit)
        AND observed_head_commit NOT GLOB '*[^0-9a-f]*'
      ),
      completed_by TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_sha256 TEXT NOT NULL CHECK(
        length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_autoship_intents_board
      ON delivery_autoship_intents(board_id, prepared_at, id);

    CREATE TRIGGER IF NOT EXISTS delivery_autoship_intents_scope
    BEFORE INSERT ON delivery_autoship_intents
    WHEN NOT EXISTS (
      SELECT 1 FROM delivery_reports report
      JOIN cards card ON card.id=report.card_id
      WHERE report.id=NEW.report_id
        AND report.status='accepted'
        AND report.board_id=NEW.board_id
        AND report.card_id=NEW.card_id
        AND report.job_id IS NEW.job_id
        AND card.board_id=NEW.board_id
        AND card.branch=NEW.source_branch
        AND (
          EXISTS (
            SELECT 1 FROM json_each(report.commits) cited
            WHERE lower(CAST(cited.value AS TEXT))=NEW.source_commit
          )
          OR EXISTS (
            SELECT 1 FROM delivery_deliverable_results result, json_each(result.evidence_refs) cited
            WHERE result.report_id=report.id
              AND json_extract(cited.value, '$.kind')='commit'
              AND lower(json_extract(cited.value, '$.ref'))=NEW.source_commit
          )
          OR EXISTS (
            SELECT 1 FROM delivery_criterion_results result, json_each(result.evidence_refs) cited
            WHERE result.report_id=report.id
              AND json_extract(cited.value, '$.kind')='commit'
              AND lower(json_extract(cited.value, '$.ref'))=NEW.source_commit
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'delivery autoship intent scope is invalid');
    END;

    CREATE TRIGGER IF NOT EXISTS delivery_autoship_intents_immutable
    BEFORE UPDATE ON delivery_autoship_intents BEGIN
      SELECT RAISE(ABORT, 'delivery autoship intents are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_autoship_intents_delete_guard
    BEFORE DELETE ON delivery_autoship_intents BEGIN
      SELECT RAISE(ABORT, 'delivery autoship intents are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS delivery_autoship_completions_scope
    BEFORE INSERT ON delivery_autoship_completions
    WHEN NOT EXISTS (
      SELECT 1
      FROM delivery_autoship_intents intent
      JOIN delivery_shipment_receipts receipt ON receipt.id=NEW.receipt_id
      JOIN delivery_shipments shipment ON shipment.id=NEW.shipment_id
      WHERE intent.id=NEW.intent_id
        AND receipt.board_id=intent.board_id
        AND receipt.card_id=intent.card_id
        AND receipt.source_repository=intent.source_repository
        AND receipt.source_commit=intent.source_commit
        AND receipt.destination=intent.destination
        AND receipt.observed_head_commit=NEW.observed_head_commit
        AND shipment.report_id=intent.report_id
        AND shipment.receipt_id=receipt.id
        AND shipment.source_repository=intent.source_repository
        AND shipment.source_commit=intent.source_commit
        AND shipment.destination=intent.destination
    )
    BEGIN
      SELECT RAISE(ABORT, 'delivery autoship completion scope is invalid');
    END;

    CREATE TRIGGER IF NOT EXISTS delivery_autoship_completions_immutable
    BEFORE UPDATE ON delivery_autoship_completions BEGIN
      SELECT RAISE(ABORT, 'delivery autoship completions are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_autoship_completions_delete_guard
    BEFORE DELETE ON delivery_autoship_completions BEGIN
      SELECT RAISE(ABORT, 'delivery autoship completions are immutable');
    END;
  `)

  assertDeliveryAutoshipIntentSchema(db)
}

export function assertDeliveryAutoshipIntentSchema(db: Database.Database): void {
  const tables = new Set((db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table'`).all() as Array<{ name: string }>).map((row) => row.name))
  for (const table of REQUIRED_TABLES) {
    if (!tables.has(table)) throw new Error(`delivery autoship migration is missing ${table}`)
  }
  const triggers = new Set((db.prepare(`SELECT name FROM sqlite_master
    WHERE type='trigger'`).all() as Array<{ name: string }>).map((row) => row.name))
  for (const trigger of REQUIRED_TRIGGERS) {
    if (!triggers.has(trigger)) throw new Error(`delivery autoship migration is missing ${trigger}`)
  }
}

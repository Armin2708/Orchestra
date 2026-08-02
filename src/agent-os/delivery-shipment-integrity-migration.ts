import type Database from 'better-sqlite3'

export const AGENT_OS_DELIVERY_SHIPMENT_INTEGRITY_MIGRATION_ID =
  '035-delivery-shipment-integrity'

const REQUIRED_TRIGGERS = Object.freeze([
  'delivery_shipment_receipts_scope',
  'delivery_shipment_receipts_immutable',
  'delivery_shipment_receipts_delete_guard',
  'delivery_shipments_require_observed_receipt',
] as const)

/** Adds an observed ShipQueue receipt without rewriting or deleting legacy shipments. */
export function installDeliveryShipmentIntegritySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_shipment_receipts (
      id TEXT PRIMARY KEY,
      receipt_kind TEXT NOT NULL CHECK(receipt_kind='ship_queue'),
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
      source_repository TEXT NOT NULL,
      source_commit TEXT NOT NULL CHECK(
        length(source_commit) IN (40,64)
        AND source_commit=lower(source_commit)
        AND source_commit NOT GLOB '*[^0-9a-f]*'
      ),
      observed_head_commit TEXT NOT NULL CHECK(
        length(observed_head_commit) IN (40,64)
        AND observed_head_commit=lower(observed_head_commit)
        AND observed_head_commit NOT GLOB '*[^0-9a-f]*'
      ),
      destination TEXT NOT NULL CHECK(destination='main'),
      deployment_ref TEXT,
      observed_by TEXT NOT NULL CHECK(observed_by='ship_queue'),
      observed_at TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL CHECK(
        length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      idempotency_key TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK(
        length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL,
      UNIQUE(receipt_kind, idempotency_key),
      UNIQUE(receipt_kind, board_id, card_id, source_commit, observed_head_commit, destination)
    );
  `)

  const shipmentColumns = new Set((db.prepare(`PRAGMA table_info(delivery_shipments)`).all() as
    Array<{ name: string }>).map((column) => column.name))
  if (!shipmentColumns.has('receipt_id')) {
    db.exec(`ALTER TABLE delivery_shipments ADD COLUMN receipt_id TEXT
      REFERENCES delivery_shipment_receipts(id) ON DELETE RESTRICT`)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_delivery_shipment_receipts_card
      ON delivery_shipment_receipts(board_id, card_id, observed_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_shipments_receipt
      ON delivery_shipments(receipt_id) WHERE receipt_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS delivery_shipment_receipts_scope
    BEFORE INSERT ON delivery_shipment_receipts
    WHEN NOT EXISTS (
      SELECT 1 FROM cards card
      WHERE card.id=NEW.card_id AND card.board_id=NEW.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'delivery shipment receipt scope is invalid');
    END;

    CREATE TRIGGER IF NOT EXISTS delivery_shipment_receipts_immutable
    BEFORE UPDATE ON delivery_shipment_receipts BEGIN
      SELECT RAISE(ABORT, 'delivery shipment receipts are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_shipment_receipts_delete_guard
    BEFORE DELETE ON delivery_shipment_receipts BEGIN
      SELECT RAISE(ABORT, 'delivery shipment receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS delivery_shipments_require_observed_receipt
    BEFORE INSERT ON delivery_shipments
    WHEN NEW.receipt_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM delivery_shipment_receipts receipt
      WHERE receipt.id=NEW.receipt_id
        AND receipt.board_id=NEW.board_id
        AND receipt.card_id=NEW.card_id
        AND receipt.source_repository=NEW.source_repository
        AND receipt.source_commit=NEW.source_commit
        AND receipt.destination=NEW.destination
        AND receipt.deployment_ref IS NEW.deployment_ref
        AND receipt.observed_at=NEW.shipped_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'delivery shipment requires an exact observed ShipQueue receipt');
    END;
  `)

  assertDeliveryShipmentIntegritySchema(db)
}

export function assertDeliveryShipmentIntegritySchema(db: Database.Database): void {
  const receiptTable = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='delivery_shipment_receipts'`).get()
  if (!receiptTable) throw new Error('delivery shipment integrity migration is missing its receipt table')
  const shipmentColumns = new Set((db.prepare(`PRAGMA table_info(delivery_shipments)`).all() as
    Array<{ name: string }>).map((column) => column.name))
  if (!shipmentColumns.has('receipt_id')) {
    throw new Error('delivery shipment integrity migration is missing delivery_shipments.receipt_id')
  }
  const triggers = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as
    Array<{ name: string }>).map((row) => row.name))
  for (const trigger of REQUIRED_TRIGGERS) {
    if (!triggers.has(trigger)) throw new Error(`delivery shipment integrity migration is missing ${trigger}`)
  }
}

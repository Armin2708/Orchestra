import type Database from 'better-sqlite3'

export const AGENT_OS_KNOWLEDGE_MANAGEMENT_MIGRATION_ID =
  '031-knowledge-management'

const REQUIRED_TABLES = Object.freeze([
  'knowledge_freshness_observations',
  'knowledge_review_requests',
  'knowledge_control_actions',
  'knowledge_promotion_requests',
  'knowledge_promotion_sources',
  'knowledge_benchmark_runs',
] as const)

const REQUIRED_COLUMNS: Readonly<Record<typeof REQUIRED_TABLES[number], readonly string[]>> =
Object.freeze({
  knowledge_freshness_observations: ['id', 'board_id', 'source_id', 'repository_head_sha',
    'observed_content_sha256', 'effective_freshness', 'reason', 'observed_at'],
  knowledge_review_requests: ['id', 'board_id', 'source_id', 'kind', 'observation_id', 'status',
    'resolution_action_id', 'requested_at', 'resolved_at'],
  knowledge_control_actions: ['id', 'board_id', 'source_id', 'action', 'replacement_source_id',
    'pinned', 'reason', 'actor_type', 'actor_id', 'source_ordinal', 'idempotency_key',
    'request_sha256', 'created_at'],
  knowledge_promotion_requests: ['id', 'board_id', 'kind', 'payload_json', 'payload_sha256',
    'status', 'requested_by', 'reviewed_by', 'review_reason', 'idempotency_key', 'request_sha256',
    'requested_at', 'reviewed_at'],
  knowledge_promotion_sources: ['promotion_id', 'board_id', 'source_id'],
  knowledge_benchmark_runs: ['id', 'board_id', 'task_fingerprint', 'evidence_json',
    'evidence_sha256', 'gate_passed', 'recorded_at'],
})

const REQUIRED_AUXILIARY_OBJECTS = Object.freeze([
  'idx_knowledge_review_pending', 'idx_knowledge_freshness_latest', 'idx_knowledge_control_latest',
  'idx_knowledge_promotions_status', 'knowledge_freshness_observations_immutable',
  'knowledge_freshness_observations_delete', 'knowledge_control_actions_immutable',
  'knowledge_control_actions_delete', 'knowledge_review_requests_update',
  'knowledge_review_requests_delete', 'knowledge_promotion_requests_update',
  'knowledge_promotion_requests_delete', 'knowledge_promotion_sources_insert',
  'knowledge_promotion_sources_immutable', 'knowledge_promotion_sources_delete',
  'knowledge_benchmark_runs_immutable', 'knowledge_benchmark_runs_delete',
] as const)

const INSTALL_SQL = `
  CREATE TABLE IF NOT EXISTS knowledge_freshness_observations (
    id TEXT PRIMARY KEY CHECK(length(id)=67 AND substr(id,1,3)='kf_'),
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
    source_id TEXT NOT NULL,
    repository_head_sha TEXT NOT NULL
      CHECK(length(repository_head_sha) IN (40,64)),
    observed_content_sha256 TEXT
      CHECK(observed_content_sha256 IS NULL OR length(observed_content_sha256)=64),
    effective_freshness TEXT NOT NULL
      CHECK(effective_freshness IN ('fresh','stale','unknown','contradicted')),
    reason TEXT NOT NULL
      CHECK(reason IN ('head_unchanged','head_changed','content_changed','source_missing','contradiction')),
    observed_at TEXT NOT NULL CHECK(length(observed_at)=24),
    FOREIGN KEY(board_id, source_id)
      REFERENCES knowledge_sources(board_id, id) ON DELETE RESTRICT,
    UNIQUE(board_id, source_id, id),
    UNIQUE(board_id, source_id, repository_head_sha, observed_content_sha256, reason)
  );

  CREATE TABLE IF NOT EXISTS knowledge_review_requests (
    id TEXT PRIMARY KEY CHECK(length(id)=67 AND substr(id,1,3)='kr_'),
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
    source_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('stale','contradiction')),
    observation_id TEXT NOT NULL REFERENCES knowledge_freshness_observations(id),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','resolved','superseded')),
    resolution_action_id TEXT REFERENCES knowledge_control_actions(id),
    requested_at TEXT NOT NULL CHECK(length(requested_at)=24),
    resolved_at TEXT,
    FOREIGN KEY(board_id, source_id)
      REFERENCES knowledge_sources(board_id, id) ON DELETE RESTRICT,
    FOREIGN KEY(board_id, source_id, observation_id)
      REFERENCES knowledge_freshness_observations(board_id, source_id, id) ON DELETE RESTRICT,
    CHECK((status='pending' AND resolution_action_id IS NULL AND resolved_at IS NULL)
      OR (status!='pending' AND resolution_action_id IS NOT NULL AND resolved_at IS NOT NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_review_pending
    ON knowledge_review_requests(board_id, source_id, kind)
    WHERE status='pending';

  CREATE TABLE IF NOT EXISTS knowledge_control_actions (
    id TEXT PRIMARY KEY CHECK(length(id)=67 AND substr(id,1,3)='ka_'),
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
    source_id TEXT NOT NULL,
    action TEXT NOT NULL
      CHECK(action IN ('accept','edit','pin','reject','supersede','forget')),
    replacement_source_id TEXT,
    pinned INTEGER CHECK(pinned IS NULL OR pinned IN (0,1)),
    reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
    actor_type TEXT NOT NULL CHECK(actor_type='operator'),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
    source_ordinal INTEGER NOT NULL CHECK(source_ordinal>=1),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
    request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
    created_at TEXT NOT NULL CHECK(length(created_at)=24),
    FOREIGN KEY(board_id, source_id)
      REFERENCES knowledge_sources(board_id, id) ON DELETE RESTRICT,
    FOREIGN KEY(board_id, replacement_source_id)
      REFERENCES knowledge_sources(board_id, id) ON DELETE RESTRICT,
    UNIQUE(board_id, idempotency_key),
    UNIQUE(board_id, source_id, source_ordinal),
    CHECK((action='pin' AND pinned IS NOT NULL) OR (action!='pin' AND pinned IS NULL)),
    CHECK((action IN ('edit','supersede') AND replacement_source_id IS NOT NULL)
      OR (action NOT IN ('edit','supersede') AND replacement_source_id IS NULL)),
    CHECK(replacement_source_id IS NULL OR replacement_source_id!=source_id)
  );

  CREATE TABLE IF NOT EXISTS knowledge_promotion_requests (
    id TEXT PRIMARY KEY CHECK(length(id)=67 AND substr(id,1,3)='kp_'),
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN ('accepted_answer','verified_delivery')),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json(payload_json)=payload_json),
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','promoted','rejected')),
    requested_by TEXT NOT NULL CHECK(length(requested_by) BETWEEN 1 AND 256),
    reviewed_by TEXT,
    review_reason TEXT,
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
    request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
    requested_at TEXT NOT NULL CHECK(length(requested_at)=24),
    reviewed_at TEXT,
    UNIQUE(board_id, id),
    UNIQUE(board_id, idempotency_key),
    CHECK((status='pending' AND reviewed_by IS NULL AND review_reason IS NULL AND reviewed_at IS NULL)
      OR (status!='pending' AND reviewed_by IS NOT NULL AND review_reason IS NOT NULL AND reviewed_at IS NOT NULL))
  );

  CREATE TABLE IF NOT EXISTS knowledge_promotion_sources (
    promotion_id TEXT NOT NULL,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
    source_id TEXT NOT NULL,
    PRIMARY KEY(promotion_id, source_id),
    FOREIGN KEY(board_id, source_id)
      REFERENCES knowledge_sources(board_id, id) ON DELETE RESTRICT,
    FOREIGN KEY(board_id, promotion_id)
      REFERENCES knowledge_promotion_requests(board_id, id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS knowledge_benchmark_runs (
    id TEXT PRIMARY KEY CHECK(length(id)=67 AND substr(id,1,3)='kb_'),
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
    task_fingerprint TEXT NOT NULL CHECK(length(task_fingerprint)=64),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json(evidence_json)=evidence_json),
    evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
    gate_passed INTEGER NOT NULL CHECK(gate_passed IN (0,1)),
    recorded_at TEXT NOT NULL CHECK(length(recorded_at)=24),
    UNIQUE(board_id, task_fingerprint, evidence_sha256)
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_freshness_latest
    ON knowledge_freshness_observations(board_id, source_id, observed_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_knowledge_control_latest
    ON knowledge_control_actions(board_id, source_id, source_ordinal DESC);
  CREATE INDEX IF NOT EXISTS idx_knowledge_promotions_status
    ON knowledge_promotion_requests(board_id, status, requested_at DESC, id DESC);

  CREATE TRIGGER IF NOT EXISTS knowledge_freshness_observations_immutable
  BEFORE UPDATE ON knowledge_freshness_observations BEGIN
    SELECT RAISE(ABORT, 'knowledge freshness evidence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_freshness_observations_delete
  BEFORE DELETE ON knowledge_freshness_observations BEGIN
    SELECT RAISE(ABORT, 'knowledge freshness evidence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_control_actions_immutable
  BEFORE UPDATE ON knowledge_control_actions BEGIN
    SELECT RAISE(ABORT, 'knowledge control audit is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_control_actions_delete
  BEFORE DELETE ON knowledge_control_actions BEGIN
    SELECT RAISE(ABORT, 'knowledge control audit is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_review_requests_update
  BEFORE UPDATE ON knowledge_review_requests BEGIN
    SELECT CASE WHEN OLD.status!='pending' OR NEW.status='pending'
      OR NEW.id!=OLD.id OR NEW.board_id!=OLD.board_id OR NEW.source_id!=OLD.source_id
      OR NEW.kind!=OLD.kind OR NEW.observation_id!=OLD.observation_id
      OR NEW.requested_at!=OLD.requested_at
      OR NOT EXISTS (SELECT 1 FROM knowledge_control_actions action
        WHERE action.id=NEW.resolution_action_id AND action.board_id=NEW.board_id
          AND action.source_id=NEW.source_id AND action.action!='pin')
      THEN RAISE(ABORT, 'knowledge review transition is invalid') END;
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_review_requests_delete
  BEFORE DELETE ON knowledge_review_requests BEGIN
    SELECT RAISE(ABORT, 'knowledge review evidence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_promotion_requests_update
  BEFORE UPDATE ON knowledge_promotion_requests BEGIN
    SELECT CASE WHEN OLD.status!='pending' OR NEW.status='pending'
      OR NEW.id!=OLD.id OR NEW.board_id!=OLD.board_id OR NEW.kind!=OLD.kind
      OR NEW.payload_json!=OLD.payload_json OR NEW.payload_sha256!=OLD.payload_sha256
      OR NEW.requested_by!=OLD.requested_by OR NEW.idempotency_key!=OLD.idempotency_key
      OR NEW.request_sha256!=OLD.request_sha256 OR NEW.requested_at!=OLD.requested_at
      OR (NEW.status='promoted' AND NOT EXISTS (
        SELECT 1 FROM knowledge_promotion_sources linked
        WHERE linked.board_id=NEW.board_id AND linked.promotion_id=NEW.id))
      OR (NEW.status='rejected' AND EXISTS (
        SELECT 1 FROM knowledge_promotion_sources linked
        WHERE linked.board_id=NEW.board_id AND linked.promotion_id=NEW.id))
      THEN RAISE(ABORT, 'knowledge promotion transition is invalid') END;
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_promotion_requests_delete
  BEFORE DELETE ON knowledge_promotion_requests BEGIN
    SELECT RAISE(ABORT, 'knowledge promotion evidence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_promotion_sources_insert
  BEFORE INSERT ON knowledge_promotion_sources BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM knowledge_promotion_requests promotion
      JOIN knowledge_sources source ON source.board_id=NEW.board_id AND source.id=NEW.source_id
      WHERE promotion.board_id=NEW.board_id AND promotion.id=NEW.promotion_id
        AND promotion.status='pending'
        AND ((promotion.kind='accepted_answer' AND source.source_kind IN ('discussion_answer','decision'))
          OR (promotion.kind='verified_delivery' AND source.source_kind IN ('verified_delivery','gotcha')))
    ) THEN RAISE(ABORT, 'knowledge promotion source is invalid') END;
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_promotion_sources_immutable
  BEFORE UPDATE ON knowledge_promotion_sources BEGIN
    SELECT RAISE(ABORT, 'knowledge promotion evidence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_promotion_sources_delete
  BEFORE DELETE ON knowledge_promotion_sources BEGIN
    SELECT RAISE(ABORT, 'knowledge promotion evidence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_benchmark_runs_immutable
  BEFORE UPDATE ON knowledge_benchmark_runs BEGIN
    SELECT RAISE(ABORT, 'knowledge benchmark evidence is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS knowledge_benchmark_runs_delete
  BEFORE DELETE ON knowledge_benchmark_runs BEGIN
    SELECT RAISE(ABORT, 'knowledge benchmark evidence is immutable');
  END;
`

export function installKnowledgeManagementSchema(db: Database.Database): void {
  const prerequisites = db.prepare(`SELECT count(*) AS count FROM sqlite_master
    WHERE type='table' AND name IN ('boards','knowledge_sources','knowledge_chunks','context_builds')`)
    .get() as { count: number }
  if (prerequisites.count !== 4) {
    throw new Error('knowledge management requires the durable Knowledge schema')
  }
  try {
    db.transaction(() => db.exec(INSTALL_SQL)).immediate()
  } catch {
    throw new Error('knowledge management schema is invalid')
  }
  const placeholders = REQUIRED_TABLES.map(() => '?').join(',')
  const retained = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name IN (${placeholders}) ORDER BY name`)
    .all(...REQUIRED_TABLES) as Array<{ name: string }>
  if (retained.length !== REQUIRED_TABLES.length) {
    throw new Error('knowledge management schema is incomplete')
  }
  for (const table of REQUIRED_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    const expected = REQUIRED_COLUMNS[table]
    if (columns.length !== expected.length
      || columns.some((column, index) => column.name !== expected[index])) {
      throw new Error('knowledge management schema is invalid')
    }
  }
  const objectPlaceholders = REQUIRED_AUXILIARY_OBJECTS.map(() => '?').join(',')
  const objects = db.prepare(`SELECT name FROM sqlite_master
    WHERE name IN (${objectPlaceholders})`).all(...REQUIRED_AUXILIARY_OBJECTS) as Array<{ name: string }>
  if (objects.length !== REQUIRED_AUXILIARY_OBJECTS.length) {
    throw new Error('knowledge management schema is incomplete')
  }
}

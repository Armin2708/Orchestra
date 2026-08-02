import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

export const OUTCOME_ANALYTICS_SCHEMA_VERSION = 1

const TABLE_COLUMNS = Object.freeze({
  outcome_usage_observations: [
    'id', 'request_sha256', 'board_id', 'team_id', 'session_id', 'job_id',
    'contract_ref', 'provider', 'billing_mode', 'cached_input_semantics',
    'input_tokens', 'cached_input_tokens', 'output_tokens', 'thinking_tokens',
    'context_injection_tokens', 'provider_total_tokens', 'observed_at', 'created_at',
  ],
  outcome_activity_observations: [
    'id', 'request_sha256', 'board_id', 'team_id', 'session_id', 'job_id',
    'contract_ref', 'category', 'quantity', 'resource_sha256', 'occurred_at', 'created_at',
  ],
  outcome_budget_policies: [
    'id', 'board_id', 'scope_kind', 'scope_id', 'max_provider_tokens',
    'max_context_tokens', 'max_fanout', 'max_planning_round_tokens',
    'warning_milli', 'enforcement', 'created_by', 'created_at', 'superseded_at',
  ],
  outcome_operation_confirmations: [
    'id', 'request_sha256', 'board_id', 'team_id', 'job_id', 'operation_kind',
    'fanout', 'estimated_tokens', 'reason', 'status', 'requested_by', 'requested_at',
    'confirmed_by', 'confirmed_at', 'expires_at',
  ],
  outcome_team_digests: [
    'id', 'request_sha256', 'board_id', 'team_id', 'leader_profile_id',
    'window_start', 'window_end', 'metrics_json', 'source_count', 'created_at',
  ],
  outcome_benchmark_observations: [
    'id', 'request_sha256', 'board_id', 'suite_key', 'scenario_key', 'variant',
    'provider_tokens', 'context_tokens', 'accepted_deliveries', 'quality_milli',
    'duration_ms', 'evidence_ref', 'observed_at', 'created_at',
  ],
} as const)

const REQUIRED_TRIGGERS = Object.freeze([
  'outcome_usage_immutable_update',
  'outcome_usage_immutable_delete',
  'outcome_activity_immutable_update',
  'outcome_activity_immutable_delete',
  'outcome_budget_update_guard',
  'outcome_confirmation_update_guard',
  'outcome_digest_immutable_update',
  'outcome_digest_immutable_delete',
  'outcome_benchmark_immutable_update',
  'outcome_benchmark_immutable_delete',
] as const)

const schemaDigest = createHash('sha256')
  .update(JSON.stringify({ columns: TABLE_COLUMNS, triggers: REQUIRED_TRIGGERS }), 'utf8')
  .digest('hex')

/**
 * Focused forward migration. The central migration train can call this function
 * without importing the analytics service or route layer.
 */
export function applyOutcomeAnalyticsMigration(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS outcome_analytics_schema (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        version INTEGER NOT NULL CHECK(version>=1),
        schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256)=64),
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outcome_usage_observations (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        team_id TEXT REFERENCES os_teams(id) ON DELETE SET NULL,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        contract_ref TEXT NOT NULL CHECK(length(contract_ref) BETWEEN 1 AND 512),
        provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 100),
        billing_mode TEXT NOT NULL CHECK(billing_mode IN ('subscription','api','unknown')),
        cached_input_semantics TEXT NOT NULL CHECK(cached_input_semantics IN ('subset','additive')),
        input_tokens INTEGER NOT NULL CHECK(input_tokens BETWEEN 0 AND 1000000000000),
        cached_input_tokens INTEGER NOT NULL CHECK(cached_input_tokens BETWEEN 0 AND 1000000000000),
        output_tokens INTEGER NOT NULL CHECK(output_tokens BETWEEN 0 AND 1000000000000),
        thinking_tokens INTEGER NOT NULL CHECK(thinking_tokens BETWEEN 0 AND output_tokens),
        context_injection_tokens INTEGER NOT NULL
          CHECK(context_injection_tokens BETWEEN 0 AND 1000000000000),
        provider_total_tokens INTEGER NOT NULL
          CHECK(provider_total_tokens BETWEEN 0 AND 1000000000000),
        observed_at TEXT NOT NULL CHECK(strftime('%s', observed_at) IS NOT NULL),
        created_at TEXT NOT NULL CHECK(strftime('%s', created_at) IS NOT NULL),
        CHECK(cached_input_semantics!='subset' OR cached_input_tokens<=input_tokens),
        CHECK(provider_total_tokens >= input_tokens + output_tokens),
        CHECK(cached_input_semantics!='additive'
          OR provider_total_tokens >= input_tokens + cached_input_tokens + output_tokens)
      );

      CREATE INDEX IF NOT EXISTS idx_outcome_usage_board_time
        ON outcome_usage_observations(board_id, observed_at, id);
      CREATE INDEX IF NOT EXISTS idx_outcome_usage_job
        ON outcome_usage_observations(board_id, job_id, observed_at, id);
      CREATE INDEX IF NOT EXISTS idx_outcome_usage_team
        ON outcome_usage_observations(board_id, team_id, observed_at, id)
        WHERE team_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS outcome_activity_observations (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        team_id TEXT REFERENCES os_teams(id) ON DELETE SET NULL,
        session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
        contract_ref TEXT CHECK(contract_ref IS NULL OR length(contract_ref) BETWEEN 1 AND 512),
        category TEXT NOT NULL CHECK(category IN (
          'context.selected','context.reused','context.rejected','context.refreshed',
          'coordination.wake','coordination.fanout','coordination.model_ack',
          'exploration.file_read','exploration.duplicate',
          'result.first_useful','delivery.evidence_gap','delivery.retry',
          'delivery.human_override'
        )),
        quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),
        resource_sha256 TEXT CHECK(resource_sha256 IS NULL OR length(resource_sha256)=64),
        occurred_at TEXT NOT NULL CHECK(strftime('%s', occurred_at) IS NOT NULL),
        created_at TEXT NOT NULL CHECK(strftime('%s', created_at) IS NOT NULL),
        CHECK(category NOT IN ('exploration.file_read','exploration.duplicate')
          OR resource_sha256 IS NOT NULL)
      );

      CREATE INDEX IF NOT EXISTS idx_outcome_activity_board_category
        ON outcome_activity_observations(board_id, category, occurred_at, id);
      CREATE INDEX IF NOT EXISTS idx_outcome_activity_job
        ON outcome_activity_observations(board_id, job_id, occurred_at, id)
        WHERE job_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS outcome_budget_policies (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project','team','job')),
        scope_id TEXT NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 512),
        max_provider_tokens INTEGER CHECK(max_provider_tokens BETWEEN 1 AND 1000000000000),
        max_context_tokens INTEGER CHECK(max_context_tokens BETWEEN 1 AND 1000000000000),
        max_fanout INTEGER CHECK(max_fanout BETWEEN 1 AND 1000000),
        max_planning_round_tokens INTEGER
          CHECK(max_planning_round_tokens BETWEEN 1 AND 1000000000000),
        warning_milli INTEGER NOT NULL CHECK(warning_milli BETWEEN 1 AND 1000),
        enforcement TEXT NOT NULL CHECK(enforcement IN ('soft','hard')),
        created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 256),
        created_at TEXT NOT NULL CHECK(strftime('%s', created_at) IS NOT NULL),
        superseded_at TEXT CHECK(superseded_at IS NULL OR strftime('%s', superseded_at) IS NOT NULL),
        CHECK(max_provider_tokens IS NOT NULL OR max_context_tokens IS NOT NULL
          OR max_fanout IS NOT NULL OR max_planning_round_tokens IS NOT NULL)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_budget_active_scope
        ON outcome_budget_policies(board_id, scope_kind, scope_id)
        WHERE superseded_at IS NULL;

      CREATE TABLE IF NOT EXISTS outcome_operation_confirmations (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        team_id TEXT REFERENCES os_teams(id) ON DELETE SET NULL,
        job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
        operation_kind TEXT NOT NULL CHECK(operation_kind IN ('swarm','planning_round')),
        fanout INTEGER NOT NULL CHECK(fanout BETWEEN 1 AND 1000000),
        estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens BETWEEN 0 AND 1000000000000),
        reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
        status TEXT NOT NULL CHECK(status IN ('not_required','awaiting_confirmation','confirmed','expired')),
        requested_by TEXT NOT NULL CHECK(length(requested_by) BETWEEN 1 AND 256),
        requested_at TEXT NOT NULL CHECK(strftime('%s', requested_at) IS NOT NULL),
        confirmed_by TEXT CHECK(confirmed_by IS NULL OR length(confirmed_by) BETWEEN 1 AND 256),
        confirmed_at TEXT CHECK(confirmed_at IS NULL OR strftime('%s', confirmed_at) IS NOT NULL),
        expires_at TEXT NOT NULL CHECK(strftime('%s', expires_at) IS NOT NULL),
        CHECK(
          (status='confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
          OR (status!='confirmed' AND confirmed_by IS NULL AND confirmed_at IS NULL)
        ),
        CHECK(expires_at>requested_at),
        CHECK(confirmed_at IS NULL OR (confirmed_at>=requested_at AND confirmed_at<expires_at))
      );

      CREATE INDEX IF NOT EXISTS idx_outcome_confirmation_board_status
        ON outcome_operation_confirmations(board_id, status, expires_at);

      CREATE TABLE IF NOT EXISTS outcome_team_digests (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE CASCADE,
        leader_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
        window_start TEXT NOT NULL CHECK(strftime('%s', window_start) IS NOT NULL),
        window_end TEXT NOT NULL CHECK(strftime('%s', window_end) IS NOT NULL),
        metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)),
        source_count INTEGER NOT NULL CHECK(source_count BETWEEN 0 AND 1000000000),
        created_at TEXT NOT NULL CHECK(strftime('%s', created_at) IS NOT NULL),
        CHECK(window_end>window_start)
      );

      CREATE INDEX IF NOT EXISTS idx_outcome_digest_team_window
        ON outcome_team_digests(board_id, team_id, window_end, id);

      CREATE TABLE IF NOT EXISTS outcome_benchmark_observations (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        suite_key TEXT NOT NULL CHECK(length(suite_key) BETWEEN 1 AND 200),
        scenario_key TEXT NOT NULL CHECK(length(scenario_key) BETWEEN 1 AND 200),
        variant TEXT NOT NULL CHECK(variant IN ('before','after')),
        provider_tokens INTEGER NOT NULL CHECK(provider_tokens BETWEEN 0 AND 1000000000000),
        context_tokens INTEGER NOT NULL CHECK(context_tokens BETWEEN 0 AND 1000000000000),
        accepted_deliveries INTEGER NOT NULL CHECK(accepted_deliveries BETWEEN 0 AND 1000000),
        quality_milli INTEGER NOT NULL CHECK(quality_milli BETWEEN 0 AND 1000),
        duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 0 AND 31536000000),
        evidence_ref TEXT NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 1000),
        observed_at TEXT NOT NULL CHECK(strftime('%s', observed_at) IS NOT NULL),
        created_at TEXT NOT NULL CHECK(strftime('%s', created_at) IS NOT NULL),
        UNIQUE(board_id, suite_key, scenario_key, variant)
      );

      CREATE INDEX IF NOT EXISTS idx_outcome_benchmark_suite
        ON outcome_benchmark_observations(board_id, suite_key, scenario_key, variant);

      CREATE TRIGGER IF NOT EXISTS outcome_usage_immutable_update
        BEFORE UPDATE ON outcome_usage_observations BEGIN
          SELECT RAISE(ABORT, 'outcome usage observation is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_usage_immutable_delete
        BEFORE DELETE ON outcome_usage_observations BEGIN
          SELECT RAISE(ABORT, 'outcome usage observation is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_activity_immutable_update
        BEFORE UPDATE ON outcome_activity_observations BEGIN
          SELECT RAISE(ABORT, 'outcome activity observation is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_activity_immutable_delete
        BEFORE DELETE ON outcome_activity_observations BEGIN
          SELECT RAISE(ABORT, 'outcome activity observation is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_budget_update_guard
        BEFORE UPDATE ON outcome_budget_policies
        WHEN NEW.id IS NOT OLD.id
          OR NEW.board_id IS NOT OLD.board_id
          OR NEW.scope_kind IS NOT OLD.scope_kind
          OR NEW.scope_id IS NOT OLD.scope_id
          OR NEW.max_provider_tokens IS NOT OLD.max_provider_tokens
          OR NEW.max_context_tokens IS NOT OLD.max_context_tokens
          OR NEW.max_fanout IS NOT OLD.max_fanout
          OR NEW.max_planning_round_tokens IS NOT OLD.max_planning_round_tokens
          OR NEW.warning_milli IS NOT OLD.warning_milli
          OR NEW.enforcement IS NOT OLD.enforcement
          OR NEW.created_by IS NOT OLD.created_by
          OR NEW.created_at IS NOT OLD.created_at
          OR OLD.superseded_at IS NOT NULL
          OR NEW.superseded_at IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'outcome budget identity is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_confirmation_update_guard
        BEFORE UPDATE ON outcome_operation_confirmations
        WHEN NEW.id IS NOT OLD.id
          OR NEW.request_sha256 IS NOT OLD.request_sha256
          OR NEW.board_id IS NOT OLD.board_id
          OR NEW.team_id IS NOT OLD.team_id
          OR NEW.job_id IS NOT OLD.job_id
          OR NEW.operation_kind IS NOT OLD.operation_kind
          OR NEW.fanout IS NOT OLD.fanout
          OR NEW.estimated_tokens IS NOT OLD.estimated_tokens
          OR NEW.reason IS NOT OLD.reason
          OR NEW.requested_by IS NOT OLD.requested_by
          OR NEW.requested_at IS NOT OLD.requested_at
          OR NEW.expires_at IS NOT OLD.expires_at
          OR OLD.status!='awaiting_confirmation'
          OR NEW.status NOT IN ('confirmed','expired')
          OR (NEW.status='expired' AND (NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL))
          OR (NEW.status='confirmed' AND (NEW.confirmed_by IS NULL OR NEW.confirmed_at IS NULL))
        BEGIN
          SELECT RAISE(ABORT, 'outcome operation confirmation transition is invalid');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_digest_immutable_update
        BEFORE UPDATE ON outcome_team_digests BEGIN
          SELECT RAISE(ABORT, 'outcome team digest is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_digest_immutable_delete
        BEFORE DELETE ON outcome_team_digests BEGIN
          SELECT RAISE(ABORT, 'outcome team digest is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_benchmark_immutable_update
        BEFORE UPDATE ON outcome_benchmark_observations BEGIN
          SELECT RAISE(ABORT, 'outcome benchmark observation is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_benchmark_immutable_delete
        BEFORE DELETE ON outcome_benchmark_observations BEGIN
          SELECT RAISE(ABORT, 'outcome benchmark observation is immutable');
        END;
    `)

    const current = db.prepare(`SELECT version, schema_sha256 FROM outcome_analytics_schema
      WHERE singleton=1`).get() as { version: number; schema_sha256: string } | undefined
    if (!current) {
      db.prepare(`INSERT INTO outcome_analytics_schema
        (singleton, version, schema_sha256, applied_at) VALUES (1, ?, ?, ?)`)
        .run(OUTCOME_ANALYTICS_SCHEMA_VERSION, schemaDigest, new Date().toISOString())
    } else if (
      current.version !== OUTCOME_ANALYTICS_SCHEMA_VERSION
      || current.schema_sha256 !== schemaDigest
    ) {
      throw new Error('outcome analytics schema marker is incompatible')
    }
    assertOutcomeAnalyticsSchema(db)
  })
  migrate.immediate()
}

export function assertOutcomeAnalyticsSchema(db: Database.Database): void {
  for (const [table, expected] of Object.entries(TABLE_COLUMNS)) {
    const actual = db.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
      .all(table).map((row) => String((row as { name: string }).name))
    if (actual.length !== expected.length
      || actual.some((column, index) => column !== expected[index])) {
      throw new Error(`outcome analytics schema is incompatible (${table})`)
    }
  }
  const triggers = new Set((db.prepare(`SELECT name FROM sqlite_master
    WHERE type='trigger' AND name LIKE 'outcome_%'`).all() as Array<{ name: string }>)
    .map((row) => row.name))
  if (REQUIRED_TRIGGERS.some((name) => !triggers.has(name))) {
    throw new Error('outcome analytics schema is incompatible (triggers)')
  }
}

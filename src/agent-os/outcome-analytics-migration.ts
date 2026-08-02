import { createHash, createHmac, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'

export const OUTCOME_ANALYTICS_SCHEMA_VERSION = 3

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
  outcome_analytics_secrets: [
    'singleton', 'hmac_key_hex', 'created_at',
  ],
  outcome_operation_bindings: [
    'operation_id', 'execution_sha256', 'confirmation_required', 'created_at',
  ],
  outcome_operation_consumptions: [
    'operation_id', 'board_id', 'team_id', 'job_id', 'provider_tokens',
    'context_tokens', 'fanout', 'planning_round_tokens', 'consumed_by', 'consumed_at',
  ],
  outcome_operation_usage_links: [
    'operation_id', 'usage_id', 'linked_at',
  ],
  outcome_usage_provider_bindings: [
    'usage_id', 'evidence_id', 'provider_id', 'adapter_id', 'mode_id',
    'runtime_mode', 'billing_mode', 'platform', 'source_commit',
    'evidence_sha256', 'created_at',
  ],
  outcome_benchmark_evidence_bindings: [
    'observation_id', 'artifact_id', 'artifact_sha256', 'evidence_version',
    'verifier_ref', 'provenance_sha256', 'artifact_created_at', 'created_at',
  ],
} as const)

const REQUIRED_TRIGGERS = Object.freeze([
  'outcome_usage_immutable_update',
  'outcome_activity_immutable_update',
  'outcome_budget_update_guard',
  'outcome_confirmation_update_guard',
  'outcome_digest_immutable_update',
  'outcome_benchmark_immutable_update',
  'outcome_secret_update_guard',
  'outcome_secret_delete_guard',
  'outcome_binding_immutable_update',
  'outcome_consumption_immutable_update',
  'outcome_operation_usage_link_immutable_update',
  'outcome_usage_provider_binding_immutable_update',
  'outcome_benchmark_evidence_binding_immutable_update',
] as const)

const OWNED_SCHEMA_OBJECTS = /^outcome_/u

const REQUIRED_SQL_FRAGMENTS = Object.freeze({
  outcome_analytics_schema: ['singleton=1', 'version>=1', 'length(schema_sha256)=64'],
  outcome_usage_observations: [
    "billing_mode IN ('subscription','api','unknown')",
    'REFERENCES boards(id) ON DELETE CASCADE',
    'provider_total_tokens >= input_tokens + output_tokens',
  ],
  outcome_activity_observations: [
    'REFERENCES boards(id) ON DELETE CASCADE',
    "category NOT IN ('exploration.file_read','exploration.duplicate')",
  ],
  outcome_budget_policies: [
    "scope_kind IN ('project','team','job')", "enforcement IN ('soft','hard')",
    'max_provider_tokens IS NOT NULL OR max_context_tokens IS NOT NULL',
  ],
  outcome_operation_confirmations: [
    "status IN ('not_required','awaiting_confirmation','confirmed','expired')",
    'expires_at>requested_at',
  ],
  outcome_team_digests: ['json_valid(metrics_json)', 'window_end>window_start'],
  outcome_benchmark_observations: [
    "variant IN ('before','after')", 'quality_milli BETWEEN 0 AND 1000',
    'UNIQUE(board_id, suite_key, scenario_key, variant)',
  ],
  outcome_analytics_secrets: ['singleton=1', 'length(hmac_key_hex)=64'],
  outcome_operation_bindings: [
    'REFERENCES outcome_operation_confirmations(id) ON DELETE CASCADE',
    'confirmation_required IN (0,1)',
  ],
  outcome_operation_consumptions: [
    'REFERENCES outcome_operation_confirmations(id) ON DELETE CASCADE',
    'planning_round_tokens BETWEEN 0 AND 1000000000000',
  ],
  outcome_operation_usage_links: [
    'REFERENCES outcome_operation_consumptions(operation_id) ON DELETE CASCADE',
    'REFERENCES outcome_usage_observations(id) ON DELETE CASCADE',
  ],
  outcome_usage_provider_bindings: [
    'REFERENCES outcome_usage_observations(id) ON DELETE CASCADE',
    'REFERENCES provider_acceptance_evidence(id) ON DELETE RESTRICT',
    'evidence_sha256 NOT GLOB',
  ],
  outcome_benchmark_evidence_bindings: [
    'REFERENCES outcome_benchmark_observations(id) ON DELETE CASCADE',
    'REFERENCES artifacts(id) ON DELETE RESTRICT',
    'evidence_version=1',
  ],
  outcome_confirmation_update_guard: [
    'BEFORE UPDATE ON outcome_operation_confirmations',
    "NEW.status NOT IN ('confirmed','expired')",
  ],
  outcome_budget_update_guard: [
    'BEFORE UPDATE ON outcome_budget_policies',
    'outcome budget identity is immutable',
  ],
  outcome_usage_immutable_update: [
    'BEFORE UPDATE ON outcome_usage_observations', 'outcome usage observation is immutable',
  ],
  outcome_activity_immutable_update: [
    'BEFORE UPDATE ON outcome_activity_observations', 'outcome activity observation is immutable',
  ],
  outcome_digest_immutable_update: [
    'BEFORE UPDATE ON outcome_team_digests', 'outcome team digest is immutable',
  ],
  outcome_benchmark_immutable_update: [
    'BEFORE UPDATE ON outcome_benchmark_observations', 'outcome benchmark observation is immutable',
  ],
  outcome_secret_update_guard: [
    'BEFORE UPDATE ON outcome_analytics_secrets', 'outcome analytics secret is immutable',
  ],
  outcome_secret_delete_guard: [
    'BEFORE DELETE ON outcome_analytics_secrets', 'outcome analytics secret is required',
  ],
  outcome_binding_immutable_update: [
    'BEFORE UPDATE ON outcome_operation_bindings', 'outcome operation binding is immutable',
  ],
  outcome_consumption_immutable_update: [
    'BEFORE UPDATE ON outcome_operation_consumptions', 'outcome operation consumption is immutable',
  ],
  outcome_operation_usage_link_immutable_update: [
    'BEFORE UPDATE ON outcome_operation_usage_links', 'outcome operation usage link is immutable',
  ],
  outcome_usage_provider_binding_immutable_update: [
    'BEFORE UPDATE ON outcome_usage_provider_bindings', 'outcome provider evidence binding is immutable',
  ],
  outcome_benchmark_evidence_binding_immutable_update: [
    'BEFORE UPDATE ON outcome_benchmark_evidence_bindings',
    'outcome benchmark evidence binding is immutable',
  ],
} as const)

const EXPECTED_FOREIGN_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  outcome_analytics_schema: [],
  outcome_usage_observations: [
    'boards:board_id:id:CASCADE', 'os_teams:team_id:id:SET NULL',
    'agent_sessions:session_id:id:CASCADE', 'jobs:job_id:id:CASCADE',
  ],
  outcome_activity_observations: [
    'boards:board_id:id:CASCADE', 'os_teams:team_id:id:SET NULL',
    'agent_sessions:session_id:id:CASCADE', 'jobs:job_id:id:CASCADE',
  ],
  outcome_budget_policies: ['boards:board_id:id:CASCADE'],
  outcome_operation_confirmations: [
    'boards:board_id:id:CASCADE', 'os_teams:team_id:id:SET NULL', 'jobs:job_id:id:CASCADE',
  ],
  outcome_team_digests: [
    'boards:board_id:id:CASCADE', 'os_teams:team_id:id:CASCADE',
    'agent_profiles:leader_profile_id:id:SET NULL',
  ],
  outcome_benchmark_observations: ['boards:board_id:id:CASCADE'],
  outcome_analytics_secrets: [],
  outcome_operation_bindings: [
    'outcome_operation_confirmations:operation_id:id:CASCADE',
  ],
  outcome_operation_consumptions: [
    'boards:board_id:id:CASCADE', 'jobs:job_id:id:CASCADE',
    'outcome_operation_confirmations:operation_id:id:CASCADE', 'os_teams:team_id:id:SET NULL',
  ],
  outcome_operation_usage_links: [
    'outcome_operation_consumptions:operation_id:operation_id:CASCADE',
    'outcome_usage_observations:usage_id:id:CASCADE',
  ],
  outcome_usage_provider_bindings: [
    'outcome_usage_observations:usage_id:id:CASCADE',
    'provider_acceptance_evidence:evidence_id:id:RESTRICT',
  ],
  outcome_benchmark_evidence_bindings: [
    'outcome_benchmark_observations:observation_id:id:CASCADE',
    'artifacts:artifact_id:id:RESTRICT',
  ],
})

const EXPECTED_INDEXES = Object.freeze({
  idx_outcome_usage_board_time: ['0', '0', 'board_id,observed_at,id'],
  idx_outcome_usage_job: ['0', '0', 'board_id,job_id,observed_at,id'],
  idx_outcome_usage_team: ['0', '1', 'board_id,team_id,observed_at,id'],
  idx_outcome_activity_board_category: ['0', '0', 'board_id,category,occurred_at,id'],
  idx_outcome_activity_job: ['0', '1', 'board_id,job_id,occurred_at,id'],
  idx_outcome_budget_active_scope: ['1', '1', 'board_id,scope_kind,scope_id'],
  idx_outcome_confirmation_board_status: ['0', '0', 'board_id,status,expires_at'],
  idx_outcome_digest_team_window: ['0', '0', 'board_id,team_id,window_end,id'],
  idx_outcome_benchmark_suite: ['0', '0', 'board_id,suite_key,scenario_key,variant'],
  idx_outcome_consumption_board: ['0', '0', 'board_id,consumed_at,operation_id'],
  idx_outcome_consumption_team: ['0', '1', 'board_id,team_id,consumed_at,operation_id'],
  idx_outcome_consumption_job: ['0', '1', 'board_id,job_id,consumed_at,operation_id'],
  idx_outcome_operation_usage_unique: ['1', '0', 'usage_id'],
  idx_outcome_usage_provider_evidence: ['0', '0', 'evidence_id,usage_id'],
  idx_outcome_benchmark_evidence_artifact: ['0', '0', 'artifact_id,observation_id'],
} as const)

/**
 * Focused forward migration. The central migration train can call this function
 * without importing the analytics service or route layer.
 */
export function applyOutcomeAnalyticsMigration(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const markerExists = db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='outcome_analytics_schema'`).get()
    const current = markerExists
      ? db.prepare(`SELECT version, schema_sha256 FROM outcome_analytics_schema
          WHERE singleton=1`).get() as { version: number; schema_sha256: string } | undefined
      : undefined
    if (!markerExists && db.prepare(`SELECT 1 FROM sqlite_master
      WHERE name LIKE 'outcome_%' LIMIT 1`).get()) {
      throw new Error('outcome analytics schema exists without an authoritative marker')
    }
    if (current && ![1, 2, OUTCOME_ANALYTICS_SCHEMA_VERSION].includes(current.version)) {
      throw new Error('outcome analytics schema marker is incompatible')
    }
    if (current && current.version >= 2 && current.schema_sha256 !== actualSchemaDigest(db)) {
      throw new Error('outcome analytics schema marker is incompatible')
    }
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

      CREATE TABLE IF NOT EXISTS outcome_analytics_secrets (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        hmac_key_hex TEXT NOT NULL CHECK(length(hmac_key_hex)=64
          AND hmac_key_hex NOT GLOB '*[^0-9a-f]*'),
        created_at TEXT NOT NULL CHECK(strftime('%s', created_at) IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS outcome_operation_bindings (
        operation_id TEXT PRIMARY KEY REFERENCES outcome_operation_confirmations(id) ON DELETE CASCADE,
        execution_sha256 TEXT NOT NULL CHECK(length(execution_sha256)=64
          AND execution_sha256 NOT GLOB '*[^0-9a-f]*'),
        confirmation_required INTEGER NOT NULL CHECK(confirmation_required IN (0,1)),
        created_at TEXT NOT NULL CHECK(strftime('%s', created_at) IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS outcome_operation_consumptions (
        operation_id TEXT PRIMARY KEY REFERENCES outcome_operation_confirmations(id) ON DELETE CASCADE,
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        team_id TEXT REFERENCES os_teams(id) ON DELETE SET NULL,
        job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
        provider_tokens INTEGER NOT NULL CHECK(provider_tokens BETWEEN 0 AND 1000000000000),
        context_tokens INTEGER NOT NULL CHECK(context_tokens BETWEEN 0 AND 1000000000000),
        fanout INTEGER NOT NULL CHECK(fanout BETWEEN 1 AND 1000000),
        planning_round_tokens INTEGER NOT NULL
          CHECK(planning_round_tokens BETWEEN 0 AND 1000000000000),
        consumed_by TEXT NOT NULL CHECK(length(consumed_by) BETWEEN 1 AND 256),
        consumed_at TEXT NOT NULL CHECK(strftime('%s', consumed_at) IS NOT NULL)
      );

      CREATE INDEX IF NOT EXISTS idx_outcome_consumption_board
        ON outcome_operation_consumptions(board_id, consumed_at, operation_id);
      CREATE INDEX IF NOT EXISTS idx_outcome_consumption_team
        ON outcome_operation_consumptions(board_id, team_id, consumed_at, operation_id)
        WHERE team_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_outcome_consumption_job
        ON outcome_operation_consumptions(board_id, job_id, consumed_at, operation_id)
        WHERE job_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS outcome_operation_usage_links (
        operation_id TEXT PRIMARY KEY
          REFERENCES outcome_operation_consumptions(operation_id) ON DELETE CASCADE,
        usage_id TEXT NOT NULL REFERENCES outcome_usage_observations(id) ON DELETE CASCADE,
        linked_at TEXT NOT NULL CHECK(strftime('%s', linked_at) IS NOT NULL)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_operation_usage_unique
        ON outcome_operation_usage_links(usage_id);

      CREATE TABLE IF NOT EXISTS outcome_usage_provider_bindings (
        usage_id TEXT PRIMARY KEY REFERENCES outcome_usage_observations(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES provider_acceptance_evidence(id) ON DELETE RESTRICT,
        provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 128),
        adapter_id TEXT NOT NULL CHECK(length(adapter_id) BETWEEN 1 AND 128),
        mode_id TEXT NOT NULL CHECK(length(mode_id) BETWEEN 1 AND 128),
        runtime_mode TEXT NOT NULL CHECK(runtime_mode IN ('native_cli','provider_api')),
        billing_mode TEXT NOT NULL
          CHECK(billing_mode IN ('personal_subscription','usage_priced_api')),
        platform TEXT NOT NULL CHECK(length(platform) BETWEEN 1 AND 128),
        source_commit TEXT NOT NULL CHECK(length(source_commit) IN (40,64)
          AND source_commit NOT GLOB '*[^0-9a-f]*'),
        evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64
          AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
        created_at TEXT NOT NULL CHECK(strftime('%s', created_at) IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_outcome_usage_provider_evidence
        ON outcome_usage_provider_bindings(evidence_id, usage_id);

      CREATE TABLE IF NOT EXISTS outcome_benchmark_evidence_bindings (
        observation_id TEXT PRIMARY KEY
          REFERENCES outcome_benchmark_observations(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
        artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64
          AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
        evidence_version INTEGER NOT NULL CHECK(evidence_version=1),
        verifier_ref TEXT NOT NULL CHECK(length(verifier_ref) BETWEEN 1 AND 1000),
        provenance_sha256 TEXT NOT NULL CHECK(length(provenance_sha256)=64
          AND provenance_sha256 NOT GLOB '*[^0-9a-f]*'),
        artifact_created_at TEXT NOT NULL CHECK(strftime('%s', artifact_created_at) IS NOT NULL),
        created_at TEXT NOT NULL CHECK(strftime('%s', created_at) IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_outcome_benchmark_evidence_artifact
        ON outcome_benchmark_evidence_bindings(artifact_id, observation_id);

      CREATE TRIGGER IF NOT EXISTS outcome_usage_immutable_update
        BEFORE UPDATE ON outcome_usage_observations BEGIN
          SELECT RAISE(ABORT, 'outcome usage observation is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_activity_immutable_update
        BEFORE UPDATE ON outcome_activity_observations BEGIN
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
      CREATE TRIGGER IF NOT EXISTS outcome_benchmark_immutable_update
        BEFORE UPDATE ON outcome_benchmark_observations BEGIN
          SELECT RAISE(ABORT, 'outcome benchmark observation is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_secret_update_guard
        BEFORE UPDATE ON outcome_analytics_secrets BEGIN
          SELECT RAISE(ABORT, 'outcome analytics secret is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_secret_delete_guard
        BEFORE DELETE ON outcome_analytics_secrets BEGIN
          SELECT RAISE(ABORT, 'outcome analytics secret is required');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_binding_immutable_update
        BEFORE UPDATE ON outcome_operation_bindings BEGIN
          SELECT RAISE(ABORT, 'outcome operation binding is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_consumption_immutable_update
        BEFORE UPDATE ON outcome_operation_consumptions BEGIN
          SELECT RAISE(ABORT, 'outcome operation consumption is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_operation_usage_link_immutable_update
        BEFORE UPDATE ON outcome_operation_usage_links BEGIN
          SELECT RAISE(ABORT, 'outcome operation usage link is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_usage_provider_binding_immutable_update
        BEFORE UPDATE ON outcome_usage_provider_bindings BEGIN
          SELECT RAISE(ABORT, 'outcome provider evidence binding is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS outcome_benchmark_evidence_binding_immutable_update
        BEFORE UPDATE ON outcome_benchmark_evidence_bindings BEGIN
          SELECT RAISE(ABORT, 'outcome benchmark evidence binding is immutable');
        END;

      DROP TRIGGER IF EXISTS outcome_usage_immutable_delete;
      DROP TRIGGER IF EXISTS outcome_activity_immutable_delete;
      DROP TRIGGER IF EXISTS outcome_digest_immutable_delete;
      DROP TRIGGER IF EXISTS outcome_benchmark_immutable_delete;
    `)

    const secret = db.prepare(`SELECT hmac_key_hex FROM outcome_analytics_secrets WHERE singleton=1`)
      .get() as { hmac_key_hex: string } | undefined
    const key = secret?.hmac_key_hex ?? randomBytes(32).toString('hex')
    if (!secret) {
      db.prepare(`INSERT INTO outcome_analytics_secrets(singleton, hmac_key_hex, created_at)
        VALUES (1, ?, ?)`).run(key, new Date().toISOString())
      if (current?.version === 1) {
        db.exec(`DROP TRIGGER outcome_activity_immutable_update`)
        const rows = db.prepare(`SELECT id, resource_sha256 FROM outcome_activity_observations
          WHERE resource_sha256 IS NOT NULL`).all() as Array<{ id: string; resource_sha256: string }>
        for (const row of rows) {
          db.prepare(`UPDATE outcome_activity_observations SET resource_sha256=? WHERE id=?`)
            .run(createHmac('sha256', Buffer.from(key, 'hex'))
              .update(`legacy:${row.resource_sha256}`, 'utf8').digest('hex'), row.id)
        }
        db.exec(`CREATE TRIGGER outcome_activity_immutable_update
          BEFORE UPDATE ON outcome_activity_observations BEGIN
            SELECT RAISE(ABORT, 'outcome activity observation is immutable');
          END`)
      }
    }
    assertOutcomeAnalyticsSchema(db, false)
    const schemaDigest = actualSchemaDigest(db)
    if (!current) {
      db.prepare(`INSERT INTO outcome_analytics_schema
        (singleton, version, schema_sha256, applied_at) VALUES (1, ?, ?, ?)`)
        .run(OUTCOME_ANALYTICS_SCHEMA_VERSION, schemaDigest, new Date().toISOString())
    } else if (current.version < OUTCOME_ANALYTICS_SCHEMA_VERSION) {
      db.prepare(`UPDATE outcome_analytics_schema
        SET version=?, schema_sha256=?, applied_at=? WHERE singleton=1`)
        .run(OUTCOME_ANALYTICS_SCHEMA_VERSION, schemaDigest, new Date().toISOString())
    } else if (current.schema_sha256 !== schemaDigest) {
      throw new Error('outcome analytics schema marker is incompatible')
    }
  })
  migrate.immediate()
}

export function assertOutcomeAnalyticsSchema(
  db: Database.Database,
  verifyMarker = true,
): void {
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
  if (triggers.size !== REQUIRED_TRIGGERS.length
    || REQUIRED_TRIGGERS.some((name) => !triggers.has(name))) {
    throw new Error('outcome analytics schema is incompatible (triggers)')
  }
  for (const [name, fragments] of Object.entries(REQUIRED_SQL_FRAGMENTS)) {
    const object = db.prepare(`SELECT sql FROM sqlite_master WHERE name=?`).get(name) as { sql: string | null } | undefined
    const sql = String(object?.sql ?? '').replace(/\s+/gu, ' ')
    if (fragments.some((fragment) => !sql.includes(fragment))) {
      throw new Error(`outcome analytics schema is incompatible (${name} SQL)`)
    }
  }
  for (const [table, spec] of Object.entries(EXPECTED_FOREIGN_KEYS)) {
    const foreignKeys = db.prepare(`SELECT "table", "from", "to", on_delete
      FROM pragma_foreign_key_list(?)`).all(table) as Array<{
        table: string; from: string; to: string; on_delete: string
      }>
    const expected = new Set(spec)
    if (foreignKeys.length !== expected.size || foreignKeys.some((key) =>
      !expected.has(`${key.table}:${key.from}:${key.to}:${key.on_delete}`))) {
      throw new Error(`outcome analytics schema is incompatible (${table} foreign keys)`)
    }
  }
  const explicitIndexes = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND name LIKE 'idx_outcome_%' ORDER BY name`).all() as Array<{ name: string }>
  if (explicitIndexes.length !== Object.keys(EXPECTED_INDEXES).length) {
    throw new Error('outcome analytics schema is incompatible (indexes)')
  }
  for (const [name, [unique, partial, columns]] of Object.entries(EXPECTED_INDEXES)) {
    const index = db.prepare(`SELECT "unique", partial FROM pragma_index_list(?) WHERE name=?`)
      .get(indexTable(db, name), name) as { unique: number; partial: number } | undefined
    const actualColumns = (db.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`)
      .all(name) as Array<{ name: string }>).map((column) => column.name).join(',')
    if (!index || String(index.unique) !== unique || String(index.partial) !== partial
      || actualColumns !== columns) {
      throw new Error(`outcome analytics schema is incompatible (${name} index)`)
    }
  }
  const forbiddenDeleteTriggers = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='trigger' AND name IN (
      'outcome_usage_immutable_delete','outcome_activity_immutable_delete',
      'outcome_digest_immutable_delete','outcome_benchmark_immutable_delete'
    )`).all()
  if (forbiddenDeleteTriggers.length > 0) {
    throw new Error('outcome analytics schema is incompatible (retention)')
  }
  if (verifyMarker) {
    const marker = db.prepare(`SELECT version, schema_sha256 FROM outcome_analytics_schema
      WHERE singleton=1`).get() as { version: number; schema_sha256: string } | undefined
    if (!marker || marker.version !== OUTCOME_ANALYTICS_SCHEMA_VERSION
      || marker.schema_sha256 !== actualSchemaDigest(db)) {
      throw new Error('outcome analytics schema marker is incompatible')
    }
  }
}

function indexTable(db: Database.Database, name: string): string {
  const row = db.prepare(`SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(name) as { tbl_name: string } | undefined
  return row?.tbl_name ?? ''
}

function actualSchemaDigest(db: Database.Database): string {
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name LIKE 'outcome_%' ORDER BY type, name`).all() as Array<{
      type: string; name: string; tbl_name: string; sql: string | null
    }>
  const owned = rows.filter((row) => OWNED_SCHEMA_OBJECTS.test(row.name)).map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: String(row.sql ?? '').replace(/\s+/gu, ' ').trim(),
  }))
  return createHash('sha256').update(JSON.stringify(owned), 'utf8').digest('hex')
}

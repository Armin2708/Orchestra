import type Database from 'better-sqlite3'

export const AGENT_OS_TEAM_PLANNING_MIGRATION_ID =
  '033-teams-planning-conflicts'

export const AGENT_OS_TEAM_PLANNING_TABLES = Object.freeze([
  'os_team_plans',
  'os_team_plan_participants',
  'os_team_plan_roles',
  'os_planning_sessions',
  'os_planning_artifacts',
  'os_planning_overrides',
  'os_team_work_bindings',
  'os_team_delegations',
  'os_team_integrations',
  'os_conflicts',
  'os_conflict_participants',
  'os_conflict_proposals',
  'os_conflict_resolutions',
  'os_work_leases',
  'os_conflict_knowledge_candidates',
  'os_team_command_receipts',
] as const)

const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  os_team_plans: [
    'id', 'board_id', 'team_id', 'card_id', 'name', 'purpose',
    'status', 'created_at', 'updated_at', 'completed_at',
  ],
  os_team_plan_participants: [
    'id', 'plan_id', 'agent_profile_id', 'membership_id', 'status', 'joined_at', 'left_at',
  ],
  os_team_plan_roles: [
    'id', 'plan_id', 'participant_id', 'role', 'scope_json', 'created_at', 'ended_at',
  ],
  os_planning_sessions: [
    'id', 'plan_id', 'status', 'version', 'current_round', 'max_rounds', 'deadline_at',
    'completion_conditions_json', 'participant_budget', 'wake_budget',
    'token_budget', 'cost_budget_cents', 'wakes_used', 'tokens_used',
    'cost_used_cents', 'stop_reason', 'escalation_ref', 'created_at',
    'updated_at', 'completed_at',
  ],
  os_planning_artifacts: [
    'id', 'session_id', 'plan_id', 'author_participant_id', 'kind', 'round_number',
    'summary', 'content_json', 'source_artifact_ids_json', 'recipient_participant_ids_json',
    'wake_cost', 'token_cost', 'cost_cents', 'created_at',
  ],
  os_planning_overrides: [
    'id', 'session_id', 'plan_id', 'actor_type', 'actor_id', 'reason',
    'scope_json', 'destructive_decision', 'expires_at', 'created_at',
  ],
  os_team_work_bindings: [
    'id', 'plan_id', 'team_id', 'board_id', 'card_id', 'exclusive_assignment_id',
    'executable_profile_id', 'assignment_market_version', 'assignment_version',
    'team_snapshot_json', 'participant_snapshot_json', 'role_snapshot_json',
    'status', 'version', 'bound_by_type',
    'bound_by_id', 'reason', 'created_at', 'updated_at', 'ended_at',
  ],
  os_team_delegations: [
    'id', 'binding_id', 'plan_id', 'participant_id', 'delegated_by_participant_id',
    'contract_ref', 'objective', 'criterion_ids_json', 'scope_paths_json',
    'status', 'created_at', 'accepted_at', 'completed_at',
  ],
  os_team_integrations: [
    'id', 'plan_id', 'binding_id', 'integrator_participant_id',
    'delivery_report_id', 'conflict_resolution_ids_json', 'verification_refs_json',
    'source_sha256', 'actor_type', 'actor_id', 'created_at',
  ],
  os_conflicts: [
    'id', 'board_id', 'plan_id', 'kind', 'severity', 'status', 'version', 'dedupe_sha256',
    'discussion_id', 'summary', 'causal_job_ids_json', 'affected_resources_json',
    'detection_evidence_json', 'attention_item_id', 'created_at', 'updated_at',
    'resolved_at',
  ],
  os_conflict_participants: [
    'id', 'conflict_id', 'participant_id', 'position', 'created_at',
  ],
  os_conflict_proposals: [
    'id', 'conflict_id', 'proposed_by_participant_id', 'kind', 'summary',
    'details_json', 'status', 'created_at', 'selected_at',
  ],
  os_conflict_resolutions: [
    'id', 'conflict_id', 'proposal_id', 'arbiter_type', 'arbiter_id',
    'rationale', 'follow_up_actions_json', 'integration_member_id',
    'human_override_id', 'created_at',
  ],
  os_work_leases: [
    'id', 'plan_id', 'participant_id', 'resource_kind', 'resource_key', 'mode',
    'policy_ref', 'status', 'acquired_at', 'expires_at', 'released_at',
  ],
  os_conflict_knowledge_candidates: [
    'id', 'conflict_id', 'resolution_id', 'status', 'source_kind',
    'source_ref', 'source_sha256', 'summary', 'requested_by_type',
    'requested_by_id', 'created_at', 'reviewed_at',
  ],
  os_team_command_receipts: [
    'board_id', 'idempotency_key', 'command_kind', 'request_sha256',
    'result_json', 'created_at',
  ],
})

export function installTeamPlanningSchema(db: Database.Database): void {
  assertTeamPlanningPrerequisites(db)
  assertExistingTeamPlanningTablesCompatible(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS os_team_plans (
      id TEXT PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
      team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      card_id INTEGER REFERENCES cards(id) ON DELETE RESTRICT,
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
      purpose TEXT NOT NULL CHECK (length(trim(purpose)) BETWEEN 1 AND 4000),
      status TEXT NOT NULL CHECK (status IN (
        'draft', 'planning', 'active', 'completed', 'stopped', 'escalated'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK ((status IN ('completed', 'stopped', 'escalated')) = (completed_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_team_plan_participants (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES os_team_plans(id) ON DELETE RESTRICT,
      agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      membership_id TEXT NOT NULL REFERENCES os_team_memberships(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('active', 'left')),
      joined_at TEXT NOT NULL,
      left_at TEXT,
      UNIQUE (plan_id, agent_profile_id),
      CHECK ((status='left') = (left_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_team_plan_roles (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES os_team_plans(id) ON DELETE RESTRICT,
      participant_id TEXT NOT NULL REFERENCES os_team_plan_participants(id) ON DELETE RESTRICT,
      role TEXT NOT NULL CHECK (role IN (
        'facilitator', 'researcher', 'implementer', 'reviewer', 'integrator', 'synthesizer'
      )),
      scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
      created_at TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE (plan_id, participant_id, role)
    );

    CREATE TABLE IF NOT EXISTS os_planning_sessions (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES os_team_plans(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'running', 'completed', 'stopped', 'escalated'
      )),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      current_round INTEGER NOT NULL DEFAULT 0 CHECK (current_round >= 0),
      max_rounds INTEGER NOT NULL CHECK (max_rounds BETWEEN 1 AND 100),
      deadline_at TEXT NOT NULL,
      completion_conditions_json TEXT NOT NULL CHECK (json_valid(completion_conditions_json)),
      participant_budget INTEGER NOT NULL CHECK (participant_budget BETWEEN 2 AND 100),
      wake_budget INTEGER NOT NULL CHECK (wake_budget BETWEEN 0 AND 10000),
      token_budget INTEGER NOT NULL CHECK (token_budget BETWEEN 1 AND 1000000000),
      cost_budget_cents INTEGER NOT NULL CHECK (cost_budget_cents BETWEEN 0 AND 1000000000),
      wakes_used INTEGER NOT NULL DEFAULT 0 CHECK (wakes_used >= 0),
      tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
      cost_used_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_used_cents >= 0),
      stop_reason TEXT,
      escalation_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK (wakes_used <= wake_budget),
      CHECK (tokens_used <= token_budget),
      CHECK (cost_used_cents <= cost_budget_cents),
      CHECK ((status IN ('completed', 'stopped', 'escalated')) = (completed_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_planning_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES os_planning_sessions(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL REFERENCES os_team_plans(id) ON DELETE RESTRICT,
      author_participant_id TEXT NOT NULL REFERENCES os_team_plan_participants(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN (
        'proposal', 'critique', 'position', 'synthesis', 'digest', 'plan'
      )),
      round_number INTEGER NOT NULL CHECK (round_number >= 1),
      summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 4000),
      content_json TEXT NOT NULL CHECK (json_valid(content_json)),
      source_artifact_ids_json TEXT NOT NULL CHECK (json_valid(source_artifact_ids_json)),
      recipient_participant_ids_json TEXT NOT NULL CHECK (json_valid(recipient_participant_ids_json)),
      wake_cost INTEGER NOT NULL DEFAULT 0 CHECK (wake_cost >= 0),
      token_cost INTEGER NOT NULL DEFAULT 0 CHECK (token_cost >= 0),
      cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS os_planning_overrides (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES os_planning_sessions(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL REFERENCES os_team_plans(id) ON DELETE RESTRICT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 4000),
      scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
      destructive_decision INTEGER NOT NULL CHECK (destructive_decision IN (0, 1)),
      expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS os_team_work_bindings (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES os_team_plans(id) ON DELETE RESTRICT,
      team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
      exclusive_assignment_id TEXT NOT NULL REFERENCES job_market_assignments(id) ON DELETE RESTRICT,
      executable_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      assignment_market_version INTEGER NOT NULL CHECK (assignment_market_version >= 1),
      assignment_version INTEGER NOT NULL CHECK (assignment_version >= 1),
      team_snapshot_json TEXT NOT NULL CHECK (json_valid(team_snapshot_json)),
      participant_snapshot_json TEXT NOT NULL CHECK (json_valid(participant_snapshot_json)),
      role_snapshot_json TEXT NOT NULL CHECK (json_valid(role_snapshot_json)),
      status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      bound_by_type TEXT NOT NULL,
      bound_by_id TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      CHECK ((status='ended') = (ended_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_team_delegations (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES os_team_work_bindings(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL REFERENCES os_team_plans(id) ON DELETE RESTRICT,
      participant_id TEXT NOT NULL REFERENCES os_team_plan_participants(id) ON DELETE RESTRICT,
      delegated_by_participant_id TEXT NOT NULL REFERENCES os_team_plan_participants(id) ON DELETE RESTRICT,
      contract_ref TEXT NOT NULL,
      objective TEXT NOT NULL CHECK (length(trim(objective)) BETWEEN 1 AND 4000),
      criterion_ids_json TEXT NOT NULL CHECK (json_valid(criterion_ids_json)),
      scope_paths_json TEXT NOT NULL CHECK (json_valid(scope_paths_json)),
      status TEXT NOT NULL CHECK (status IN ('assigned', 'accepted', 'completed', 'cancelled')),
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS os_team_integrations (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL UNIQUE REFERENCES os_team_plans(id) ON DELETE RESTRICT,
      binding_id TEXT NOT NULL REFERENCES os_team_work_bindings(id) ON DELETE RESTRICT,
      integrator_participant_id TEXT NOT NULL REFERENCES os_team_plan_participants(id) ON DELETE RESTRICT,
      delivery_report_id TEXT NOT NULL UNIQUE REFERENCES delivery_reports(id) ON DELETE RESTRICT,
      conflict_resolution_ids_json TEXT NOT NULL CHECK (json_valid(conflict_resolution_ids_json)),
      verification_refs_json TEXT NOT NULL CHECK (json_valid(verification_refs_json)),
      source_sha256 TEXT NOT NULL CHECK (
        length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS os_conflicts (
      id TEXT PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL REFERENCES os_team_plans(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('path', 'branch', 'dependency', 'resource', 'decision')),
      severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
      status TEXT NOT NULL CHECK (status IN ('open', 'negotiating', 'resolved', 'needs_human', 'archived')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      dedupe_sha256 TEXT NOT NULL CHECK (
        length(dedupe_sha256)=64 AND dedupe_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      discussion_id TEXT NOT NULL,
      summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 4000),
      causal_job_ids_json TEXT NOT NULL CHECK (json_valid(causal_job_ids_json)),
      affected_resources_json TEXT NOT NULL CHECK (json_valid(affected_resources_json)),
      detection_evidence_json TEXT NOT NULL CHECK (json_valid(detection_evidence_json)),
      attention_item_id TEXT REFERENCES attention_items(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      CHECK ((status IN ('resolved', 'archived')) = (resolved_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_conflict_participants (
      id TEXT PRIMARY KEY,
      conflict_id TEXT NOT NULL REFERENCES os_conflicts(id) ON DELETE RESTRICT,
      participant_id TEXT NOT NULL REFERENCES os_team_plan_participants(id) ON DELETE RESTRICT,
      position TEXT NOT NULL CHECK (position IN ('affected', 'consulted', 'arbiter', 'integrator')),
      created_at TEXT NOT NULL,
      UNIQUE (conflict_id, participant_id, position)
    );

    CREATE TABLE IF NOT EXISTS os_conflict_proposals (
      id TEXT PRIMARY KEY,
      conflict_id TEXT NOT NULL REFERENCES os_conflicts(id) ON DELETE RESTRICT,
      proposed_by_participant_id TEXT NOT NULL REFERENCES os_team_plan_participants(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN (
        'split_ownership', 'rebase', 'handoff', 'serialize', 'merge', 'assign_integrator'
      )),
      summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 4000),
      details_json TEXT NOT NULL CHECK (json_valid(details_json)),
      status TEXT NOT NULL CHECK (status IN ('proposed', 'selected', 'rejected')),
      created_at TEXT NOT NULL,
      selected_at TEXT
    );

    CREATE TABLE IF NOT EXISTS os_conflict_resolutions (
      id TEXT PRIMARY KEY,
      conflict_id TEXT NOT NULL UNIQUE REFERENCES os_conflicts(id) ON DELETE RESTRICT,
      proposal_id TEXT NOT NULL REFERENCES os_conflict_proposals(id) ON DELETE RESTRICT,
      arbiter_type TEXT NOT NULL,
      arbiter_id TEXT NOT NULL,
      rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 4000),
      follow_up_actions_json TEXT NOT NULL CHECK (json_valid(follow_up_actions_json)),
      integration_member_id TEXT REFERENCES os_team_plan_participants(id) ON DELETE RESTRICT,
      human_override_id TEXT REFERENCES os_planning_overrides(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS os_work_leases (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES os_team_plans(id) ON DELETE RESTRICT,
      participant_id TEXT NOT NULL REFERENCES os_team_plan_participants(id) ON DELETE RESTRICT,
      resource_kind TEXT NOT NULL CHECK (resource_kind IN ('path', 'branch', 'workspace', 'resource')),
      resource_key TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('advisory', 'enforced')),
      policy_ref TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT,
      CHECK (mode='advisory' OR policy_ref IS NOT NULL),
      CHECK ((status='active') = (released_at IS NULL))
    );

    CREATE TABLE IF NOT EXISTS os_conflict_knowledge_candidates (
      id TEXT PRIMARY KEY,
      conflict_id TEXT NOT NULL REFERENCES os_conflicts(id) ON DELETE RESTRICT,
      resolution_id TEXT NOT NULL REFERENCES os_conflict_resolutions(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('pending_review', 'accepted', 'rejected', 'superseded')),
      source_kind TEXT NOT NULL CHECK (source_kind='conflict_resolution'),
      source_ref TEXT NOT NULL,
      source_sha256 TEXT NOT NULL CHECK (
        length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 4000),
      requested_by_type TEXT NOT NULL,
      requested_by_id TEXT,
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      UNIQUE (resolution_id, source_sha256)
    );

    CREATE TABLE IF NOT EXISTS os_team_command_receipts (
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL,
      command_kind TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (
        length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (board_id, idempotency_key)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_session_active
      ON os_planning_sessions(plan_id)
      WHERE status IN ('pending', 'running');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_team_facilitator
      ON os_team_plan_roles(plan_id)
      WHERE role='facilitator' AND ended_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_work_binding_card
      ON os_team_work_bindings(board_id, card_id)
      WHERE status='active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_work_binding_assignment
      ON os_team_work_bindings(exclusive_assignment_id)
      WHERE status='active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_active_work_lease
      ON os_work_leases(plan_id, resource_kind, resource_key)
      WHERE status='active' AND mode='enforced';
    CREATE INDEX IF NOT EXISTS idx_planning_team_board
      ON os_team_plans(board_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_planning_artifact_session
      ON os_planning_artifacts(session_id, round_number, created_at);
    CREATE INDEX IF NOT EXISTS idx_conflict_board_status
      ON os_conflicts(board_id, status, severity, updated_at);
    CREATE INDEX IF NOT EXISTS idx_conflict_team
      ON os_conflicts(plan_id, status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conflict_active_dedupe
      ON os_conflicts(board_id, dedupe_sha256)
      WHERE status IN ('open', 'negotiating', 'needs_human');

    CREATE TRIGGER IF NOT EXISTS os_planning_team_scope_insert
    BEFORE INSERT ON os_team_plans
    WHEN (NEW.card_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cards WHERE id=NEW.card_id AND board_id=NEW.board_id
    )) OR NOT EXISTS (
      SELECT 1 FROM os_teams team
      JOIN os_organizations organization ON organization.id=team.organization_id
      WHERE team.id=NEW.team_id AND organization.board_id=NEW.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'planning team scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_team_plan_participant_scope_insert
    BEFORE INSERT ON os_team_plan_participants
    WHEN NOT EXISTS (
      SELECT 1 FROM os_team_plans plan
      JOIN os_team_memberships membership ON membership.id=NEW.membership_id
      JOIN agent_profiles profile ON profile.id=NEW.agent_profile_id
      WHERE plan.id=NEW.plan_id
        AND membership.team_id=plan.team_id
        AND membership.agent_profile_id=NEW.agent_profile_id
        AND membership.state='active'
        AND profile.board_id=plan.board_id
        AND profile.status='active'
    )
    BEGIN
      SELECT RAISE(ABORT, 'planning participant must retain active canonical membership');
    END;

    CREATE TRIGGER IF NOT EXISTS os_planning_role_scope_insert
    BEFORE INSERT ON os_team_plan_roles
    WHEN NOT EXISTS (
      SELECT 1 FROM os_team_plan_participants participant
      WHERE participant.id=NEW.participant_id AND participant.plan_id=NEW.plan_id
        AND participant.status='active'
    )
    BEGIN
      SELECT RAISE(ABORT, 'planning role scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_team_work_binding_scope_insert
    BEFORE INSERT ON os_team_work_bindings
    WHEN NOT EXISTS (
      SELECT 1 FROM os_team_plans plan
      JOIN job_market_assignments assignment
        ON assignment.id=NEW.exclusive_assignment_id
      WHERE plan.id=NEW.plan_id
        AND plan.team_id=NEW.team_id
        AND plan.board_id=NEW.board_id
        AND plan.card_id=NEW.card_id
        AND assignment.board_id=NEW.board_id
        AND assignment.card_id=NEW.card_id
        AND assignment.status='active'
        AND assignment.profile_id=NEW.executable_profile_id
        AND assignment.assigned_market_version=NEW.assignment_market_version
        AND assignment.version=NEW.assignment_version
    )
    BEGIN
      SELECT RAISE(ABORT, 'collaborative binding must preserve one active exclusive assignment');
    END;

    CREATE TRIGGER IF NOT EXISTS os_team_delegation_scope_insert
    BEFORE INSERT ON os_team_delegations
    WHEN NOT EXISTS (
      SELECT 1 FROM os_team_work_bindings binding
      JOIN os_team_plan_participants assignee ON assignee.id=NEW.participant_id
      JOIN os_team_plan_participants delegator ON delegator.id=NEW.delegated_by_participant_id
      WHERE binding.id=NEW.binding_id
        AND binding.plan_id=NEW.plan_id
        AND binding.status='active'
        AND assignee.plan_id=NEW.plan_id AND assignee.status='active'
        AND delegator.plan_id=NEW.plan_id AND delegator.status='active'
    )
    BEGIN
      SELECT RAISE(ABORT, 'team delegation scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_conflict_scope_insert
    BEFORE INSERT ON os_conflicts
    WHEN NOT EXISTS (
      SELECT 1 FROM os_team_plans plan
      WHERE plan.id=NEW.plan_id AND plan.board_id=NEW.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'conflict scope is inconsistent');
    END;
  `)
}

function assertTeamPlanningPrerequisites(db: Database.Database): void {
  const required = [
    'boards', 'cards', 'agent_profiles', 'os_teams', 'os_organizations',
    'job_market_assignments', 'delivery_reports', 'attention_items', 'os_events',
  ]
  const present = new Set((db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table'`).all() as Array<{ name: string }>).map((row) => row.name))
  const missing = required.filter((table) => !present.has(table))
  if (missing.length) {
    throw new Error(`migration ${AGENT_OS_TEAM_PLANNING_MIGRATION_ID} requires ${missing.join(', ')}`)
  }
}

function assertExistingTeamPlanningTablesCompatible(db: Database.Database): void {
  for (const [table, expected] of Object.entries(TABLE_COLUMNS)) {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name=?`).get(table)
    if (!exists) continue
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((row) => row.name)
    if (columns.length !== expected.length || expected.some((name) => !columns.includes(name))) {
      throw new Error(`${table} has an incompatible schema`)
    }
  }
}

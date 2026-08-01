import type Database from 'better-sqlite3'

export const AGENT_OS_ORGANIZATION_COORDINATION_MIGRATION_ID =
  '028-agent-organization-coordination'

export const AGENT_OS_ORGANIZATION_COORDINATION_TABLES = Object.freeze([
  'os_team_interactions',
  'os_responsibility_assignments',
  'os_objectives',
  'os_team_goals',
  'os_capacity_snapshots',
  'os_message_envelopes',
  'os_decision_records',
  'os_escalations',
  'os_risk_evaluations',
  'os_participation_history',
  'os_control_approvals',
] as const)

const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  os_team_interactions: [
    'id', 'organization_id', 'mode', 'owner_team_id', 'provider_team_id',
    'consumer_team_id', 'participants_json', 'purpose', 'service_contract_ref',
    'service_level_json', 'exit_condition', 'starts_at', 'expires_at', 'status',
    'created_at', 'updated_at', 'ended_at',
  ],
  os_responsibility_assignments: [
    'id', 'organization_id', 'work_kind', 'work_id', 'dri_profile_id',
    'decider_profile_id', 'consulted_json', 'reviewer_profile_ids_json',
    'informed_json', 'risk_tier', 'status', 'created_at', 'updated_at', 'ended_at',
  ],
  os_objectives: [
    'id', 'organization_id', 'parent_id', 'objective_key', 'version', 'statement',
    'outcome_definition_json', 'customer_evidence_refs_json', 'owner_team_id',
    'status', 'valid_from', 'valid_until', 'created_at', 'superseded_by_id',
  ],
  os_team_goals: [
    'id', 'organization_id', 'objective_id', 'team_id', 'goal_key', 'version',
    'statement', 'measure_json', 'design_ref', 'design_version', 'design_sha256',
    'contract_card_id', 'contract_version', 'contract_sha256', 'contract_frozen_at',
    'status', 'created_at', 'completed_at',
  ],
  os_capacity_snapshots: [
    'id', 'organization_id', 'team_id', 'window_start', 'window_end',
    'available_milli', 'allocated_milli', 'wip_limit', 'current_wip',
    'queued_demand', 'blocked_count', 'oldest_blocked_at', 'constraints_json',
    'source_refs_json', 'created_at',
  ],
  os_message_envelopes: [
    'id', 'organization_id', 'thread_id', 'parent_id', 'causal_id', 'team_id',
    'actor_profile_id', 'session_id', 'role_activation_id', 'intent',
    'recipient_profile_ids_json', 'recipient_team_ids_json', 'visibility',
    'urgency', 'requested_action', 'deadline', 'expires_at', 'links_json',
    'payload_version', 'payload_json', 'summary', 'idempotency_key',
    'receipt_policy', 'redaction_class', 'retention_policy', 'automated',
    'fanout_depth', 'status', 'created_at',
  ],
  os_decision_records: [
    'id', 'organization_id', 'decision_key', 'version', 'question', 'owner_team_id',
    'decider_profile_id', 'responsibility_id', 'consulted_json', 'options_json',
    'evidence_refs_json', 'constraints_json', 'selected_option', 'rationale',
    'accepted_risks_json', 'effective_from', 'effective_until', 'review_at',
    'supersedes_id', 'status', 'created_at', 'decided_at',
  ],
  os_escalations: [
    'id', 'organization_id', 'source_kind', 'source_id', 'threshold',
    'attempted_actions_json', 'evidence_refs_json', 'risk_of_waiting',
    'options_json', 'recommendation', 'required_authority', 'target_role_key',
    'response_deadline', 'status', 'resolution', 'decision_id', 'created_at',
    'resolved_at',
  ],
  os_risk_evaluations: [
    'id', 'organization_id', 'actor_profile_id', 'session_id', 'resource_kind',
    'resource_id', 'action', 'environment', 'signals_json', 'risk_tier',
    'control', 'authority_evaluation_json', 'created_at', 'expires_at',
  ],
  os_participation_history: [
    'id', 'organization_id', 'subject_kind', 'subject_id', 'artifact_sha256',
    'agent_profile_id', 'session_id', 'participation_kind', 'created_at',
  ],
  os_control_approvals: [
    'id', 'organization_id', 'subject_kind', 'subject_id', 'artifact_sha256',
    'risk_tier', 'control', 'decision', 'approver_profile_id', 'session_id',
    'role_activation_id', 'approver_principal_type', 'specialist_role_key',
    'rationale', 'expires_at', 'created_at', 'revoked_at',
  ],
})

export function installOrganizationCoordinationSchema(db: Database.Database): void {
  assertExistingTablesCompatible(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS os_team_interactions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      mode TEXT NOT NULL CHECK (mode IN ('collaboration', 'x_as_a_service', 'facilitating')),
      owner_team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      provider_team_id TEXT REFERENCES os_teams(id) ON DELETE RESTRICT,
      consumer_team_id TEXT REFERENCES os_teams(id) ON DELETE RESTRICT,
      participants_json TEXT NOT NULL CHECK (json_valid(participants_json)),
      purpose TEXT NOT NULL,
      service_contract_ref TEXT,
      service_level_json TEXT NOT NULL CHECK (json_valid(service_level_json)),
      exit_condition TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'ended', 'cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      CHECK (expires_at > starts_at),
      CHECK ((status IN ('ended','cancelled')) = (ended_at IS NOT NULL)),
      CHECK (mode!='x_as_a_service' OR (
        provider_team_id IS NOT NULL AND consumer_team_id IS NOT NULL
        AND service_contract_ref IS NOT NULL
      ))
    );

    CREATE TABLE IF NOT EXISTS os_responsibility_assignments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      work_kind TEXT NOT NULL,
      work_id TEXT NOT NULL,
      dri_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      decider_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      consulted_json TEXT NOT NULL CHECK (json_valid(consulted_json)),
      reviewer_profile_ids_json TEXT NOT NULL CHECK (json_valid(reviewer_profile_ids_json)),
      informed_json TEXT NOT NULL CHECK (json_valid(informed_json)),
      risk_tier TEXT NOT NULL CHECK (risk_tier IN ('R0','R1','R2','R3','R4')),
      status TEXT NOT NULL CHECK (status IN ('active','ended')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      CHECK ((status='ended') = (ended_at IS NOT NULL))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_os_responsibility_current
      ON os_responsibility_assignments(organization_id, work_kind, work_id)
      WHERE status='active';

    CREATE TABLE IF NOT EXISTS os_objectives (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      parent_id TEXT REFERENCES os_objectives(id) ON DELETE RESTRICT,
      objective_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      statement TEXT NOT NULL,
      outcome_definition_json TEXT NOT NULL CHECK (json_valid(outcome_definition_json)),
      customer_evidence_refs_json TEXT NOT NULL CHECK (json_valid(customer_evidence_refs_json)),
      owner_team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('draft','active','achieved','cancelled','superseded')),
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      created_at TEXT NOT NULL,
      superseded_by_id TEXT REFERENCES os_objectives(id) ON DELETE RESTRICT,
      UNIQUE (organization_id, objective_key, version),
      CHECK (parent_id IS NULL OR parent_id != id),
      CHECK (superseded_by_id IS NULL OR superseded_by_id != id),
      CHECK (valid_until IS NULL OR valid_until > valid_from)
    );

    CREATE TABLE IF NOT EXISTS os_team_goals (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      objective_id TEXT NOT NULL REFERENCES os_objectives(id) ON DELETE RESTRICT,
      team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      goal_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      statement TEXT NOT NULL,
      measure_json TEXT NOT NULL CHECK (json_valid(measure_json)),
      design_ref TEXT NOT NULL,
      design_version TEXT NOT NULL,
      design_sha256 TEXT NOT NULL,
      contract_card_id INTEGER NOT NULL REFERENCES task_contracts(card_id) ON DELETE RESTRICT,
      contract_version INTEGER NOT NULL CHECK (contract_version >= 1),
      contract_sha256 TEXT NOT NULL,
      contract_frozen_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','achieved','cancelled','superseded')),
      created_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (organization_id, goal_key, version),
      CHECK (length(design_sha256)=64 AND design_sha256 NOT GLOB '*[^0-9a-f]*'),
      CHECK (length(contract_sha256)=64 AND contract_sha256 NOT GLOB '*[^0-9a-f]*'),
      CHECK ((status IN ('achieved','cancelled','superseded')) = (completed_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_capacity_snapshots (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      available_milli INTEGER NOT NULL CHECK (available_milli >= 0),
      allocated_milli INTEGER NOT NULL CHECK (allocated_milli >= 0),
      wip_limit INTEGER NOT NULL CHECK (wip_limit >= 0),
      current_wip INTEGER NOT NULL CHECK (current_wip >= 0),
      queued_demand INTEGER NOT NULL CHECK (queued_demand >= 0),
      blocked_count INTEGER NOT NULL CHECK (blocked_count >= 0),
      oldest_blocked_at TEXT,
      constraints_json TEXT NOT NULL CHECK (json_valid(constraints_json)),
      source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
      created_at TEXT NOT NULL,
      CHECK (window_end > window_start),
      CHECK (blocked_count>0 OR oldest_blocked_at IS NULL)
    );

    CREATE TABLE IF NOT EXISTS os_message_envelopes (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      thread_id TEXT NOT NULL,
      parent_id TEXT REFERENCES os_message_envelopes(id) ON DELETE RESTRICT,
      causal_id TEXT REFERENCES os_message_envelopes(id) ON DELETE RESTRICT,
      team_id TEXT REFERENCES os_teams(id) ON DELETE RESTRICT,
      actor_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
      role_activation_id TEXT NOT NULL REFERENCES os_role_activations(id) ON DELETE RESTRICT,
      intent TEXT NOT NULL CHECK (intent IN (
        'QUESTION','ANSWER','PROPOSAL','DECISION','ASSIGNMENT','STATUS_UPDATE','BLOCKER',
        'REVIEW_REQUEST','REVIEW_FINDING','APPROVAL','REJECTION','EVIDENCE','INCIDENT','ESCALATION'
      )),
      recipient_profile_ids_json TEXT NOT NULL CHECK (json_valid(recipient_profile_ids_json)),
      recipient_team_ids_json TEXT NOT NULL CHECK (json_valid(recipient_team_ids_json)),
      visibility TEXT NOT NULL CHECK (visibility IN ('private','team','organization','public')),
      urgency TEXT NOT NULL CHECK (urgency IN ('routine','normal','urgent','critical')),
      requested_action TEXT,
      deadline TEXT,
      expires_at TEXT,
      links_json TEXT NOT NULL CHECK (json_valid(links_json)),
      payload_version INTEGER NOT NULL CHECK (payload_version >= 1),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      summary TEXT,
      idempotency_key TEXT NOT NULL,
      receipt_policy TEXT NOT NULL CHECK (receipt_policy IN ('none','delivery','read')),
      redaction_class TEXT NOT NULL,
      retention_policy TEXT NOT NULL,
      automated INTEGER NOT NULL CHECK (automated IN (0,1)),
      fanout_depth INTEGER NOT NULL CHECK (fanout_depth BETWEEN 0 AND 3),
      status TEXT NOT NULL CHECK (status IN ('durable','expired','redacted')),
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, idempotency_key),
      CHECK (parent_id IS NULL OR parent_id != id),
      CHECK (causal_id IS NULL OR causal_id != id)
    );

    CREATE INDEX IF NOT EXISTS idx_os_messages_thread
      ON os_message_envelopes(organization_id, thread_id, created_at);

    CREATE TABLE IF NOT EXISTS os_decision_records (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      decision_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      question TEXT NOT NULL,
      owner_team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      decider_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      responsibility_id TEXT NOT NULL REFERENCES os_responsibility_assignments(id) ON DELETE RESTRICT,
      consulted_json TEXT NOT NULL CHECK (json_valid(consulted_json)),
      options_json TEXT NOT NULL CHECK (json_valid(options_json)),
      evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
      constraints_json TEXT NOT NULL CHECK (json_valid(constraints_json)),
      selected_option TEXT NOT NULL,
      rationale TEXT NOT NULL,
      accepted_risks_json TEXT NOT NULL CHECK (json_valid(accepted_risks_json)),
      effective_from TEXT NOT NULL,
      effective_until TEXT,
      review_at TEXT,
      supersedes_id TEXT REFERENCES os_decision_records(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('effective','expired','superseded','reversed')),
      created_at TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      UNIQUE (organization_id, decision_key, version),
      CHECK (supersedes_id IS NULL OR supersedes_id != id),
      CHECK (effective_until IS NULL OR effective_until > effective_from)
    );

    CREATE TABLE IF NOT EXISTS os_escalations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      threshold TEXT NOT NULL,
      attempted_actions_json TEXT NOT NULL CHECK (json_valid(attempted_actions_json)),
      evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
      risk_of_waiting TEXT NOT NULL,
      options_json TEXT NOT NULL CHECK (json_valid(options_json)),
      recommendation TEXT NOT NULL,
      required_authority TEXT NOT NULL,
      target_role_key TEXT NOT NULL,
      response_deadline TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','resolved','rejected','expired')),
      resolution TEXT,
      decision_id TEXT REFERENCES os_decision_records(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      CHECK ((status='open') = (resolved_at IS NULL))
    );

    CREATE TABLE IF NOT EXISTS os_risk_evaluations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      actor_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      action TEXT NOT NULL,
      environment TEXT NOT NULL,
      signals_json TEXT NOT NULL CHECK (json_valid(signals_json)),
      risk_tier TEXT NOT NULL CHECK (risk_tier IN ('R0','R1','R2','R3','R4')),
      control TEXT NOT NULL CHECK (control IN (
        'automatic','independent_review','specialist_approval','human_approval',
        'two_person','prohibited'
      )),
      authority_evaluation_json TEXT NOT NULL CHECK (json_valid(authority_evaluation_json)),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      CHECK (expires_at > created_at)
    );

    CREATE TABLE IF NOT EXISTS os_participation_history (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
      participation_kind TEXT NOT NULL CHECK (participation_kind IN (
        'dri','author','operator','contributor','reviewer','approver','releaser'
      )),
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, subject_kind, subject_id, artifact_sha256,
        agent_profile_id, session_id, participation_kind),
      CHECK (length(artifact_sha256)=64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*')
    );

    CREATE TABLE IF NOT EXISTS os_control_approvals (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      risk_tier TEXT NOT NULL CHECK (risk_tier IN ('R1','R2','R3')),
      control TEXT NOT NULL CHECK (control IN (
        'independent_review','specialist_approval','human_approval','two_person'
      )),
      decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
      approver_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
      role_activation_id TEXT NOT NULL REFERENCES os_role_activations(id) ON DELETE RESTRICT,
      approver_principal_type TEXT NOT NULL CHECK (approver_principal_type IN ('human','agent')),
      specialist_role_key TEXT,
      rationale TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE (organization_id, subject_kind, subject_id, artifact_sha256,
        approver_profile_id, decision),
      CHECK (length(artifact_sha256)=64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
      CHECK (expires_at > created_at)
    );

    CREATE INDEX IF NOT EXISTS idx_os_control_approvals_subject
      ON os_control_approvals(
        organization_id, subject_kind, subject_id, artifact_sha256, decision, expires_at
      );

    CREATE TRIGGER IF NOT EXISTS os_interactions_scope_insert
    BEFORE INSERT ON os_team_interactions
    WHEN NOT EXISTS (
      SELECT 1 FROM os_teams owner
      WHERE owner.id=NEW.owner_team_id AND owner.organization_id=NEW.organization_id
        AND (NEW.provider_team_id IS NULL OR EXISTS (
          SELECT 1 FROM os_teams provider WHERE provider.id=NEW.provider_team_id
            AND provider.organization_id=NEW.organization_id
        ))
        AND (NEW.consumer_team_id IS NULL OR EXISTS (
          SELECT 1 FROM os_teams consumer WHERE consumer.id=NEW.consumer_team_id
            AND consumer.organization_id=NEW.organization_id
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'team interaction scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_interactions_scope_update
    BEFORE UPDATE OF organization_id, owner_team_id, provider_team_id, consumer_team_id
    ON os_team_interactions
    WHEN NOT EXISTS (
      SELECT 1 FROM os_teams owner
      WHERE owner.id=NEW.owner_team_id AND owner.organization_id=NEW.organization_id
        AND (NEW.provider_team_id IS NULL OR EXISTS (
          SELECT 1 FROM os_teams provider WHERE provider.id=NEW.provider_team_id
            AND provider.organization_id=NEW.organization_id
        ))
        AND (NEW.consumer_team_id IS NULL OR EXISTS (
          SELECT 1 FROM os_teams consumer WHERE consumer.id=NEW.consumer_team_id
            AND consumer.organization_id=NEW.organization_id
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'team interaction scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_responsibility_scope_insert
    BEFORE INSERT ON os_responsibility_assignments
    WHEN NOT EXISTS (
      SELECT 1 FROM os_organizations organization
      JOIN agent_profiles dri ON dri.id=NEW.dri_profile_id
      JOIN agent_profiles decider ON decider.id=NEW.decider_profile_id
      WHERE organization.id=NEW.organization_id
        AND dri.board_id=organization.board_id AND decider.board_id=organization.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'responsibility principals are outside organization board');
    END;

    CREATE TRIGGER IF NOT EXISTS os_responsibility_scope_update
    BEFORE UPDATE OF organization_id, dri_profile_id, decider_profile_id
    ON os_responsibility_assignments
    WHEN NOT EXISTS (
      SELECT 1 FROM os_organizations organization
      JOIN agent_profiles dri ON dri.id=NEW.dri_profile_id
      JOIN agent_profiles decider ON decider.id=NEW.decider_profile_id
      WHERE organization.id=NEW.organization_id
        AND dri.board_id=organization.board_id AND decider.board_id=organization.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'responsibility principals are outside organization board');
    END;

    CREATE TRIGGER IF NOT EXISTS os_objective_scope_insert
    BEFORE INSERT ON os_objectives
    WHEN NOT EXISTS (
      SELECT 1 FROM os_teams team
      WHERE team.id=NEW.owner_team_id AND team.organization_id=NEW.organization_id
        AND (NEW.parent_id IS NULL OR EXISTS (
          SELECT 1 FROM os_objectives parent WHERE parent.id=NEW.parent_id
            AND parent.organization_id=NEW.organization_id
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'objective scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_goal_scope_insert
    BEFORE INSERT ON os_team_goals
    WHEN NOT EXISTS (
      SELECT 1 FROM os_objectives objective
      JOIN os_teams team ON team.id=NEW.team_id
      WHERE objective.id=NEW.objective_id
        AND objective.organization_id=NEW.organization_id
        AND team.organization_id=NEW.organization_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'team goal scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_capacity_scope_insert
    BEFORE INSERT ON os_capacity_snapshots
    WHEN NOT EXISTS (
      SELECT 1 FROM os_teams team
      WHERE team.id=NEW.team_id AND team.organization_id=NEW.organization_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'capacity team is outside organization');
    END;

    CREATE TRIGGER IF NOT EXISTS os_message_scope_insert
    BEFORE INSERT ON os_message_envelopes
    WHEN NOT EXISTS (
      SELECT 1 FROM os_role_activations activation
      JOIN agent_sessions session ON session.id=NEW.session_id
      WHERE activation.id=NEW.role_activation_id
        AND activation.organization_id=NEW.organization_id
        AND activation.agent_profile_id=NEW.actor_profile_id
        AND activation.session_id=NEW.session_id
        AND activation.status='active'
        AND session.profile_id=NEW.actor_profile_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'message actor session and active role are inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_decision_scope_insert
    BEFORE INSERT ON os_decision_records
    WHEN NOT EXISTS (
      SELECT 1 FROM os_responsibility_assignments responsibility
      JOIN os_teams team ON team.id=NEW.owner_team_id
      WHERE responsibility.id=NEW.responsibility_id
        AND responsibility.organization_id=NEW.organization_id
        AND responsibility.decider_profile_id=NEW.decider_profile_id
        AND team.organization_id=NEW.organization_id
        AND (NEW.supersedes_id IS NULL OR EXISTS (
          SELECT 1 FROM os_decision_records prior WHERE prior.id=NEW.supersedes_id
            AND prior.organization_id=NEW.organization_id
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'decision scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_risk_scope_insert
    BEFORE INSERT ON os_risk_evaluations
    WHEN NOT EXISTS (
      SELECT 1 FROM os_organizations organization
      JOIN agent_profiles profile ON profile.id=NEW.actor_profile_id
      JOIN agent_sessions session ON session.id=NEW.session_id
      WHERE organization.id=NEW.organization_id
        AND profile.board_id=organization.board_id
        AND session.profile_id=NEW.actor_profile_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'risk actor session is outside organization');
    END;

    CREATE TRIGGER IF NOT EXISTS os_participation_scope_insert
    BEFORE INSERT ON os_participation_history
    WHEN NOT EXISTS (
      SELECT 1 FROM os_organizations organization
      JOIN agent_profiles profile ON profile.id=NEW.agent_profile_id
      JOIN agent_sessions session ON session.id=NEW.session_id
      WHERE organization.id=NEW.organization_id
        AND profile.board_id=organization.board_id
        AND session.profile_id=NEW.agent_profile_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'participation principal and session are inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_approval_scope_insert
    BEFORE INSERT ON os_control_approvals
    WHEN NOT EXISTS (
      SELECT 1 FROM os_role_activations activation
      WHERE activation.id=NEW.role_activation_id
        AND activation.organization_id=NEW.organization_id
        AND activation.agent_profile_id=NEW.approver_profile_id
        AND activation.session_id=NEW.session_id
        AND activation.status='active'
    )
    BEGIN
      SELECT RAISE(ABORT, 'approval requires the approver active role and session');
    END;
  `)
  assertOrganizationCoordinationSchemaCompatible(db)
}

export function assertOrganizationCoordinationSchemaCompatible(db: Database.Database): void {
  for (const table of AGENT_OS_ORGANIZATION_COORDINATION_TABLES) {
    const existing = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table)
    if (!existing) throw new Error(`organization coordination schema is missing table ${table}`)
    assertTableColumnsCompatible(db, table)
  }
}

function assertExistingTablesCompatible(db: Database.Database): void {
  for (const table of AGENT_OS_ORGANIZATION_COORDINATION_TABLES) {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)) {
      assertTableColumnsCompatible(db, table)
    }
  }
}

function assertTableColumnsCompatible(
  db: Database.Database,
  table: typeof AGENT_OS_ORGANIZATION_COORDINATION_TABLES[number],
): void {
  const actual = (db.pragma(`table_info('${table}')`) as Array<{ name: string }>)
    .map((column) => column.name)
  if (JSON.stringify(actual) !== JSON.stringify(TABLE_COLUMNS[table])) {
    throw new Error(`organization coordination table ${table} has an incompatible schema`)
  }
}

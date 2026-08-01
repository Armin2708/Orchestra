import type Database from 'better-sqlite3'

export const AGENT_OS_ORGANIZATION_ASSURANCE_MIGRATION_ID =
  '029-agent-organization-assurance'

export const AGENT_OS_ORGANIZATION_ASSURANCE_TABLES = Object.freeze([
  'os_trace_nodes',
  'os_trace_edges',
  'os_provenance_attestations',
  'os_quality_gate_definitions',
  'os_quality_gate_runs',
  'os_quality_gate_results',
  'os_quality_gate_overrides',
  'os_metric_definitions',
  'os_scorecards',
  'os_metric_observations',
  'os_calibration_reviews',
  'os_access_certifications',
  'os_review_appeals',
  'os_incidents',
  'os_incident_timeline',
  'os_postmortems',
  'os_corrective_actions',
  'os_knowledge_promotions',
] as const)

const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  os_trace_nodes: [
    'id', 'organization_id', 'node_kind', 'external_ref', 'version', 'sha256',
    'metadata_json', 'created_at',
  ],
  os_trace_edges: [
    'id', 'organization_id', 'from_node_id', 'to_node_id', 'relationship',
    'evidence_ref', 'created_at',
  ],
  os_provenance_attestations: [
    'id', 'organization_id', 'subject_kind', 'subject_id', 'artifact_sha256',
    'source_uri', 'source_sha256', 'builder_type', 'builder_id', 'build_type',
    'inputs_json', 'parameters_json', 'environment_json', 'outputs_json',
    'predicate_type', 'signature_ref', 'created_at',
  ],
  os_quality_gate_definitions: [
    'id', 'organization_id', 'gate_key', 'version', 'name', 'risk_tiers_json',
    'graph_json', 'entry_criteria_json', 'required_evidence_families_json',
    'approver_role_keys_json', 'timeout_seconds', 'waiver_role_key',
    'failure_behavior', 'status', 'created_at', 'retired_at',
  ],
  os_quality_gate_runs: [
    'id', 'organization_id', 'definition_id', 'subject_kind', 'subject_id',
    'artifact_sha256', 'risk_tier', 'status', 'started_at', 'deadline',
    'completed_at',
  ],
  os_quality_gate_results: [
    'id', 'organization_id', 'run_id', 'node_key', 'status', 'evidence_refs_json',
    'approval_ids_json', 'finding', 'evaluated_by_profile_id', 'evaluated_at',
  ],
  os_quality_gate_overrides: [
    'id', 'organization_id', 'run_id', 'node_key', 'gap', 'authority_role_key',
    'actor_profile_id', 'role_activation_id', 'rationale', 'scope', 'expires_at',
    'compensating_control', 'follow_up_ref', 'created_at', 'revoked_at',
  ],
  os_metric_definitions: [
    'id', 'organization_id', 'metric_key', 'version', 'dimension', 'name',
    'purpose', 'population', 'owner_team_id', 'source', 'window_definition',
    'freshness_seconds', 'uncertainty_definition', 'known_confounders_json',
    'access_policy', 'prohibited_uses_json', 'unit_of_analysis', 'status',
    'created_at', 'retired_at',
  ],
  os_scorecards: [
    'id', 'organization_id', 'subject_kind', 'subject_id', 'owner_team_id',
    'window_start', 'window_end', 'operating_context', 'confidence', 'status',
    'created_at', 'calibrated_at',
  ],
  os_metric_observations: [
    'id', 'organization_id', 'scorecard_id', 'metric_definition_id', 'status',
    'value_json', 'evidence_refs_json', 'uncertainty', 'observed_at', 'expires_at',
  ],
  os_calibration_reviews: [
    'id', 'organization_id', 'review_kind', 'subject_kind', 'subject_id',
    'window_start', 'window_end', 'reviewer_profile_id', 'assigned_goals_json',
    'evidence_refs_json', 'operating_context', 'uncertainty', 'finding',
    'confidence', 'status', 'next_review_at', 'correction', 'created_at',
    'completed_at',
  ],
  os_access_certifications: [
    'id', 'organization_id', 'role_assignment_id', 'reviewer_profile_id',
    'decision', 'evidence_refs_json', 'reason', 'reviewed_at', 'expires_at',
    'remediation_ref',
  ],
  os_review_appeals: [
    'id', 'organization_id', 'review_kind', 'review_id', 'appellant_profile_id',
    'grounds', 'evidence_refs_json', 'status', 'independent_reviewer_profile_id',
    'resolution', 'created_at', 'resolved_at',
  ],
  os_incidents: [
    'id', 'organization_id', 'incident_key', 'service_ownership_id', 'severity',
    'status', 'summary', 'impact', 'error_budget_consumed',
    'commander_profile_id', 'started_at', 'detected_at', 'contained_at',
    'resolved_at', 'created_at',
  ],
  os_incident_timeline: [
    'id', 'organization_id', 'incident_id', 'event_kind', 'summary',
    'evidence_refs_json', 'actor_profile_id', 'occurred_at', 'created_at',
  ],
  os_postmortems: [
    'id', 'organization_id', 'incident_id', 'author_profile_id',
    'reviewer_profile_id', 'blameless', 'summary', 'causal_analysis_json',
    'impact_analysis', 'containment_evidence_refs_json',
    'recovery_evidence_refs_json', 'lessons_json', 'status', 'created_at',
    'reviewed_at',
  ],
  os_corrective_actions: [
    'id', 'organization_id', 'postmortem_id', 'action_kind', 'description',
    'owner_team_id', 'owner_profile_id', 'due_at', 'status', 'verification_ref',
    'created_at', 'completed_at',
  ],
  os_knowledge_promotions: [
    'id', 'organization_id', 'board_id', 'postmortem_id', 'lesson_key',
    'lesson_sha256', 'knowledge_source_id', 'reviewer_profile_id', 'created_at',
  ],
})

export function installOrganizationAssuranceSchema(db: Database.Database): void {
  assertExistingTablesCompatible(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS os_trace_nodes (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      node_kind TEXT NOT NULL CHECK (node_kind IN (
        'objective','customer_evidence','prd','design','decision','contract','assignment',
        'session','source','commit','review','test','build','deployment','outcome','incident'
      )),
      external_ref TEXT NOT NULL,
      version TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, node_kind, external_ref, version),
      CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*')
    );

    CREATE TABLE IF NOT EXISTS os_trace_edges (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      from_node_id TEXT NOT NULL REFERENCES os_trace_nodes(id) ON DELETE RESTRICT,
      to_node_id TEXT NOT NULL REFERENCES os_trace_nodes(id) ON DELETE RESTRICT,
      relationship TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, from_node_id, to_node_id, relationship),
      CHECK (from_node_id != to_node_id)
    );

    CREATE TABLE IF NOT EXISTS os_provenance_attestations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      source_uri TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      builder_type TEXT NOT NULL,
      builder_id TEXT NOT NULL,
      build_type TEXT NOT NULL,
      inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
      parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
      environment_json TEXT NOT NULL CHECK (json_valid(environment_json)),
      outputs_json TEXT NOT NULL CHECK (json_valid(outputs_json)),
      predicate_type TEXT NOT NULL,
      signature_ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, subject_kind, subject_id, artifact_sha256),
      CHECK (length(artifact_sha256)=64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
      CHECK (length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*')
    );

    CREATE TABLE IF NOT EXISTS os_quality_gate_definitions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      gate_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      name TEXT NOT NULL,
      risk_tiers_json TEXT NOT NULL CHECK (json_valid(risk_tiers_json)),
      graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
      entry_criteria_json TEXT NOT NULL CHECK (json_valid(entry_criteria_json)),
      required_evidence_families_json TEXT NOT NULL CHECK (json_valid(required_evidence_families_json)),
      approver_role_keys_json TEXT NOT NULL CHECK (json_valid(approver_role_keys_json)),
      timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 31536000),
      waiver_role_key TEXT,
      failure_behavior TEXT NOT NULL CHECK (failure_behavior IN ('block','escalate','rollback')),
      status TEXT NOT NULL CHECK (status IN ('active','retired')),
      created_at TEXT NOT NULL,
      retired_at TEXT,
      UNIQUE (organization_id, gate_key, version),
      CHECK ((status='retired') = (retired_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_quality_gate_runs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      definition_id TEXT NOT NULL REFERENCES os_quality_gate_definitions(id) ON DELETE RESTRICT,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      risk_tier TEXT NOT NULL CHECK (risk_tier IN ('R0','R1','R2','R3','R4')),
      status TEXT NOT NULL CHECK (status IN ('running','passed','failed','blocked','overridden')),
      started_at TEXT NOT NULL,
      deadline TEXT NOT NULL,
      completed_at TEXT,
      CHECK (length(artifact_sha256)=64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
      CHECK ((status='running') = (completed_at IS NULL)),
      CHECK (deadline > started_at)
    );

    CREATE TABLE IF NOT EXISTS os_quality_gate_results (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      run_id TEXT NOT NULL REFERENCES os_quality_gate_runs(id) ON DELETE RESTRICT,
      node_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed','failed','blocked','waived')),
      evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
      approval_ids_json TEXT NOT NULL CHECK (json_valid(approval_ids_json)),
      finding TEXT,
      evaluated_by_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      evaluated_at TEXT NOT NULL,
      UNIQUE (run_id, node_key)
    );

    CREATE TABLE IF NOT EXISTS os_quality_gate_overrides (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      run_id TEXT NOT NULL REFERENCES os_quality_gate_runs(id) ON DELETE RESTRICT,
      node_key TEXT NOT NULL,
      gap TEXT NOT NULL,
      authority_role_key TEXT NOT NULL,
      actor_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      role_activation_id TEXT NOT NULL REFERENCES os_role_activations(id) ON DELETE RESTRICT,
      rationale TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      compensating_control TEXT NOT NULL,
      follow_up_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      CHECK (expires_at > created_at)
    );

    CREATE TABLE IF NOT EXISTS os_metric_definitions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      metric_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      dimension TEXT NOT NULL CHECK (dimension IN (
        'outcome','quality','reliability','flow','cost','collaboration','capability','safety'
      )),
      name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      population TEXT NOT NULL,
      owner_team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      source TEXT NOT NULL,
      window_definition TEXT NOT NULL,
      freshness_seconds INTEGER NOT NULL CHECK (freshness_seconds BETWEEN 1 AND 31536000),
      uncertainty_definition TEXT NOT NULL,
      known_confounders_json TEXT NOT NULL CHECK (json_valid(known_confounders_json)),
      access_policy TEXT NOT NULL,
      prohibited_uses_json TEXT NOT NULL CHECK (json_valid(prohibited_uses_json)),
      unit_of_analysis TEXT NOT NULL CHECK (unit_of_analysis IN ('product','service','team','role_capability')),
      status TEXT NOT NULL CHECK (status IN ('active','retired')),
      created_at TEXT NOT NULL,
      retired_at TEXT,
      UNIQUE (organization_id, metric_key, version),
      CHECK ((status='retired') = (retired_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_scorecards (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('product','service','team','role_capability')),
      subject_id TEXT NOT NULL,
      owner_team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      operating_context TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
      status TEXT NOT NULL CHECK (status IN ('draft','calibrated','final')),
      created_at TEXT NOT NULL,
      calibrated_at TEXT,
      CHECK (window_end > window_start),
      CHECK ((status='draft') = (calibrated_at IS NULL))
    );

    CREATE TABLE IF NOT EXISTS os_metric_observations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      scorecard_id TEXT NOT NULL REFERENCES os_scorecards(id) ON DELETE RESTRICT,
      metric_definition_id TEXT NOT NULL REFERENCES os_metric_definitions(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('observed','insufficient_evidence')),
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),
      evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
      uncertainty TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE (scorecard_id, metric_definition_id),
      CHECK (expires_at > observed_at)
    );

    CREATE TABLE IF NOT EXISTS os_calibration_reviews (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      review_kind TEXT NOT NULL CHECK (review_kind IN ('goal','capability','performance')),
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      reviewer_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      assigned_goals_json TEXT NOT NULL CHECK (json_valid(assigned_goals_json)),
      evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
      operating_context TEXT NOT NULL,
      uncertainty TEXT NOT NULL,
      finding TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
      status TEXT NOT NULL CHECK (status IN ('draft','complete','corrected')),
      next_review_at TEXT NOT NULL,
      correction TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK (window_end > window_start),
      CHECK ((status='draft') = (completed_at IS NULL)),
      CHECK (next_review_at > window_end)
    );

    CREATE TABLE IF NOT EXISTS os_access_certifications (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      role_assignment_id TEXT NOT NULL REFERENCES os_role_assignments(id) ON DELETE RESTRICT,
      reviewer_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      decision TEXT NOT NULL CHECK (decision IN ('certified','revoke','remediate','insufficient_evidence')),
      evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
      reason TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      remediation_ref TEXT,
      CHECK (expires_at > reviewed_at),
      CHECK (decision!='remediate' OR remediation_ref IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS os_review_appeals (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      review_kind TEXT NOT NULL CHECK (review_kind IN ('calibration','access')),
      review_id TEXT NOT NULL,
      appellant_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      grounds TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
      status TEXT NOT NULL CHECK (status IN ('open','upheld','modified','rejected')),
      independent_reviewer_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      resolution TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      CHECK ((status='open') = (resolved_at IS NULL)),
      CHECK (status='open' OR independent_reviewer_profile_id IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS os_incidents (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      incident_key TEXT NOT NULL,
      service_ownership_id TEXT NOT NULL REFERENCES os_team_ownerships(id) ON DELETE RESTRICT,
      severity TEXT NOT NULL CHECK (severity IN ('SEV0','SEV1','SEV2','SEV3')),
      status TEXT NOT NULL CHECK (status IN ('open','contained','resolved','closed')),
      summary TEXT NOT NULL,
      impact TEXT NOT NULL,
      error_budget_consumed REAL NOT NULL CHECK (error_budget_consumed >= 0),
      commander_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      started_at TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      contained_at TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, incident_key),
      CHECK (detected_at >= started_at),
      CHECK (status='open' OR contained_at IS NOT NULL),
      CHECK (status NOT IN ('resolved','closed') OR resolved_at IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS os_incident_timeline (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      incident_id TEXT NOT NULL REFERENCES os_incidents(id) ON DELETE RESTRICT,
      event_kind TEXT NOT NULL CHECK (event_kind IN (
        'detected','investigated','decision','mitigation','contained','recovered','resolved'
      )),
      summary TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
      actor_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS os_postmortems (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      incident_id TEXT NOT NULL REFERENCES os_incidents(id) ON DELETE RESTRICT,
      author_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      reviewer_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      blameless INTEGER NOT NULL CHECK (blameless=1),
      summary TEXT NOT NULL,
      causal_analysis_json TEXT NOT NULL CHECK (json_valid(causal_analysis_json)),
      impact_analysis TEXT NOT NULL,
      containment_evidence_refs_json TEXT NOT NULL CHECK (json_valid(containment_evidence_refs_json)),
      recovery_evidence_refs_json TEXT NOT NULL CHECK (json_valid(recovery_evidence_refs_json)),
      lessons_json TEXT NOT NULL CHECK (json_valid(lessons_json)),
      status TEXT NOT NULL CHECK (status IN ('draft','reviewed')),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      UNIQUE (incident_id),
      CHECK (author_profile_id != reviewer_profile_id),
      CHECK ((status='reviewed') = (reviewed_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_corrective_actions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      postmortem_id TEXT NOT NULL REFERENCES os_postmortems(id) ON DELETE RESTRICT,
      action_kind TEXT NOT NULL CHECK (action_kind IN ('corrective','preventive')),
      description TEXT NOT NULL,
      owner_team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      owner_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','verified','cancelled')),
      verification_ref TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK ((status='open') = (completed_at IS NULL)),
      CHECK (status!='verified' OR verification_ref IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS os_knowledge_promotions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
      postmortem_id TEXT NOT NULL REFERENCES os_postmortems(id) ON DELETE RESTRICT,
      lesson_key TEXT NOT NULL,
      lesson_sha256 TEXT NOT NULL,
      knowledge_source_id TEXT NOT NULL,
      reviewer_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      UNIQUE (postmortem_id, lesson_key),
      FOREIGN KEY (board_id, knowledge_source_id)
        REFERENCES knowledge_sources(board_id, id) ON DELETE RESTRICT,
      CHECK (length(lesson_sha256)=64 AND lesson_sha256 NOT GLOB '*[^0-9a-f]*')
    );

    CREATE INDEX IF NOT EXISTS idx_os_trace_edges_from ON os_trace_edges(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_os_trace_edges_to ON os_trace_edges(to_node_id);
    CREATE INDEX IF NOT EXISTS idx_os_gate_runs_subject
      ON os_quality_gate_runs(organization_id, subject_kind, subject_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_os_metric_observations_freshness
      ON os_metric_observations(organization_id, expires_at, status);
    CREATE INDEX IF NOT EXISTS idx_os_incidents_status
      ON os_incidents(organization_id, status, severity, started_at);

    CREATE TRIGGER IF NOT EXISTS os_trace_edge_scope_insert
    BEFORE INSERT ON os_trace_edges
    WHEN NOT EXISTS (
      SELECT 1 FROM os_trace_nodes source JOIN os_trace_nodes target
      WHERE source.id=NEW.from_node_id AND target.id=NEW.to_node_id
        AND source.organization_id=NEW.organization_id
        AND target.organization_id=NEW.organization_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'trace edge scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_gate_run_scope_insert
    BEFORE INSERT ON os_quality_gate_runs
    WHEN NOT EXISTS (
      SELECT 1 FROM os_quality_gate_definitions definition
      WHERE definition.id=NEW.definition_id
        AND definition.organization_id=NEW.organization_id AND definition.status='active'
    )
    BEGIN
      SELECT RAISE(ABORT, 'quality gate definition is outside organization or inactive');
    END;

    CREATE TRIGGER IF NOT EXISTS os_gate_result_scope_insert
    BEFORE INSERT ON os_quality_gate_results
    WHEN NOT EXISTS (
      SELECT 1 FROM os_quality_gate_runs run
      JOIN os_organizations organization ON organization.id=run.organization_id
      JOIN agent_profiles profile ON profile.id=NEW.evaluated_by_profile_id
      WHERE run.id=NEW.run_id AND run.organization_id=NEW.organization_id
        AND profile.board_id=organization.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'quality gate result scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_metric_observation_scope_insert
    BEFORE INSERT ON os_metric_observations
    WHEN NOT EXISTS (
      SELECT 1 FROM os_scorecards scorecard JOIN os_metric_definitions metric
      WHERE scorecard.id=NEW.scorecard_id AND metric.id=NEW.metric_definition_id
        AND scorecard.organization_id=NEW.organization_id
        AND metric.organization_id=NEW.organization_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'metric observation scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_metric_definition_scope_insert
    BEFORE INSERT ON os_metric_definitions
    WHEN NOT EXISTS (
      SELECT 1 FROM os_teams team
      WHERE team.id=NEW.owner_team_id AND team.organization_id=NEW.organization_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'metric owner team is outside organization');
    END;

    CREATE TRIGGER IF NOT EXISTS os_scorecard_scope_insert
    BEFORE INSERT ON os_scorecards
    WHEN NOT EXISTS (
      SELECT 1 FROM os_teams team
      WHERE team.id=NEW.owner_team_id AND team.organization_id=NEW.organization_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'scorecard owner team is outside organization');
    END;

    CREATE TRIGGER IF NOT EXISTS os_calibration_scope_insert
    BEFORE INSERT ON os_calibration_reviews
    WHEN NOT EXISTS (
      SELECT 1 FROM os_organizations organization
      JOIN agent_profiles reviewer ON reviewer.id=NEW.reviewer_profile_id
      WHERE organization.id=NEW.organization_id
        AND reviewer.board_id=organization.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'calibration reviewer is outside organization');
    END;

    CREATE TRIGGER IF NOT EXISTS os_access_certification_scope_insert
    BEFORE INSERT ON os_access_certifications
    WHEN NOT EXISTS (
      SELECT 1 FROM os_role_assignments assignment
      JOIN os_organizations organization ON organization.id=assignment.organization_id
      JOIN agent_profiles reviewer ON reviewer.id=NEW.reviewer_profile_id
      WHERE assignment.id=NEW.role_assignment_id
        AND assignment.organization_id=NEW.organization_id
        AND reviewer.board_id=organization.board_id
        AND reviewer.id!=assignment.agent_profile_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'access certification scope or reviewer independence is invalid');
    END;

    CREATE TRIGGER IF NOT EXISTS os_incident_scope_insert
    BEFORE INSERT ON os_incidents
    WHEN NOT EXISTS (
      SELECT 1 FROM os_team_ownerships ownership
      JOIN os_organizations organization ON organization.id=ownership.organization_id
      JOIN agent_profiles commander ON commander.id=NEW.commander_profile_id
      WHERE ownership.id=NEW.service_ownership_id
        AND ownership.organization_id=NEW.organization_id
        AND commander.board_id=organization.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'incident ownership or commander scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_incident_timeline_scope_insert
    BEFORE INSERT ON os_incident_timeline
    WHEN NOT EXISTS (
      SELECT 1 FROM os_incidents incident
      JOIN os_organizations organization ON organization.id=incident.organization_id
      JOIN agent_profiles actor ON actor.id=NEW.actor_profile_id
      WHERE incident.id=NEW.incident_id
        AND incident.organization_id=NEW.organization_id
        AND actor.board_id=organization.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'incident timeline scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_postmortem_scope_insert
    BEFORE INSERT ON os_postmortems
    WHEN NOT EXISTS (
      SELECT 1 FROM os_incidents incident
      JOIN os_organizations organization ON organization.id=incident.organization_id
      JOIN agent_profiles author ON author.id=NEW.author_profile_id
      JOIN agent_profiles reviewer ON reviewer.id=NEW.reviewer_profile_id
      WHERE incident.id=NEW.incident_id AND incident.organization_id=NEW.organization_id
        AND author.board_id=organization.board_id AND reviewer.board_id=organization.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'postmortem scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_corrective_action_scope_insert
    BEFORE INSERT ON os_corrective_actions
    WHEN NOT EXISTS (
      SELECT 1 FROM os_postmortems postmortem
      JOIN os_teams team ON team.id=NEW.owner_team_id
      JOIN os_organizations organization ON organization.id=postmortem.organization_id
      JOIN agent_profiles owner ON owner.id=NEW.owner_profile_id
      WHERE postmortem.id=NEW.postmortem_id
        AND postmortem.organization_id=NEW.organization_id
        AND team.organization_id=NEW.organization_id
        AND owner.board_id=organization.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'corrective action scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_knowledge_promotion_scope_insert
    BEFORE INSERT ON os_knowledge_promotions
    WHEN NOT EXISTS (
      SELECT 1 FROM os_postmortems postmortem
      JOIN os_organizations organization ON organization.id=postmortem.organization_id
      JOIN agent_profiles reviewer ON reviewer.id=NEW.reviewer_profile_id
      JOIN knowledge_sources source
        ON source.board_id=NEW.board_id AND source.id=NEW.knowledge_source_id
      WHERE postmortem.id=NEW.postmortem_id
        AND postmortem.organization_id=NEW.organization_id
        AND organization.board_id=NEW.board_id
        AND reviewer.board_id=NEW.board_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'knowledge promotion scope is inconsistent');
    END;
  `)
  assertOrganizationAssuranceSchemaCompatible(db)
}

export function assertOrganizationAssuranceSchemaCompatible(db: Database.Database): void {
  for (const table of AGENT_OS_ORGANIZATION_ASSURANCE_TABLES) {
    const existing = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table)
    if (!existing) throw new Error(`organization assurance schema is missing table ${table}`)
    assertTableColumnsCompatible(db, table)
  }
}

function assertExistingTablesCompatible(db: Database.Database): void {
  for (const table of AGENT_OS_ORGANIZATION_ASSURANCE_TABLES) {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)) {
      assertTableColumnsCompatible(db, table)
    }
  }
}

function assertTableColumnsCompatible(
  db: Database.Database,
  table: typeof AGENT_OS_ORGANIZATION_ASSURANCE_TABLES[number],
): void {
  const actual = (db.pragma(`table_info('${table}')`) as Array<{ name: string }>)
    .map((column) => column.name)
  if (JSON.stringify(actual) !== JSON.stringify(TABLE_COLUMNS[table])) {
    throw new Error(`organization assurance table ${table} has an incompatible schema`)
  }
}

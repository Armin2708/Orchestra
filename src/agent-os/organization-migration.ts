import type Database from 'better-sqlite3'

export const AGENT_OS_ORGANIZATION_CORE_MIGRATION_ID =
  '027-agent-organization-core'

export const AGENT_OS_ORGANIZATION_CORE_TABLES = Object.freeze([
  'os_organizations',
  'os_product_areas',
  'os_teams',
  'os_positions',
  'os_team_memberships',
  'os_membership_transitions',
  'os_role_definitions',
  'os_role_assignments',
  'os_role_activations',
  'os_capability_attestations',
  'os_authority_policies',
  'os_team_ownerships',
] as const)

const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  os_organizations: [
    'id', 'board_id', 'organization_key', 'name', 'mission', 'status',
    'created_at', 'updated_at', 'archived_at',
  ],
  os_product_areas: [
    'id', 'organization_id', 'parent_id', 'area_key', 'name', 'mission',
    'status', 'created_at', 'updated_at', 'archived_at',
  ],
  os_teams: [
    'id', 'organization_id', 'product_area_id', 'team_key', 'name', 'mission',
    'status', 'created_at', 'updated_at', 'archived_at',
  ],
  os_positions: [
    'id', 'team_id', 'position_key', 'role_family', 'title', 'capacity_milli',
    'state', 'created_at', 'updated_at', 'closed_at',
  ],
  os_team_memberships: [
    'id', 'organization_id', 'team_id', 'agent_profile_id', 'position_id',
    'state', 'allocation_milli', 'effective_from', 'effective_until',
    'transition_reason', 'created_at', 'updated_at',
  ],
  os_membership_transitions: [
    'id', 'membership_id', 'from_state', 'to_state', 'reason', 'handoff_ref',
    'retention_policy_ref', 'audit_hold_ref', 'actor_type', 'actor_id',
    'created_at',
  ],
  os_role_definitions: [
    'id', 'organization_id', 'role_key', 'version', 'name', 'duties_json',
    'capabilities_json', 'permissions_json', 'budgets_json', 'constraints_json',
    'evidence_ttl_days', 'status', 'created_at', 'retired_at',
  ],
  os_role_assignments: [
    'id', 'organization_id', 'role_definition_id', 'agent_profile_id',
    'team_id', 'scope_kind', 'scope_id', 'status', 'granted_by_type',
    'granted_by_id', 'valid_from', 'valid_until', 'reason', 'created_at',
    'updated_at', 'revoked_at',
  ],
  os_role_activations: [
    'id', 'organization_id', 'role_assignment_id', 'agent_profile_id',
    'session_id', 'job_id', 'status', 'activated_at', 'ended_at', 'end_reason',
  ],
  os_capability_attestations: [
    'id', 'organization_id', 'agent_profile_id', 'role_assignment_id',
    'capability', 'verdict', 'evidence_ref', 'evidence_sha256', 'observed_at',
    'expires_at', 'created_at',
  ],
  os_authority_policies: [
    'id', 'organization_id', 'policy_key', 'version', 'name', 'scope_kind',
    'resource_kind', 'actions_json', 'risk_tier', 'decision', 'control',
    'required_roles_json', 'constraints_json', 'priority', 'status',
    'created_at', 'retired_at',
  ],
  os_team_ownerships: [
    'id', 'organization_id', 'team_id', 'resource_kind', 'resource_id',
    'service_name', 'service_level_json', 'effective_from', 'effective_until',
    'created_at', 'updated_at',
  ],
})

export function installOrganizationCoreSchema(db: Database.Database): void {
  assertExistingOrganizationCoreTablesCompatible(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS os_organizations (
      id TEXT PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
      organization_key TEXT NOT NULL,
      name TEXT NOT NULL,
      mission TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE (board_id, organization_key),
      CHECK (length(trim(organization_key)) BETWEEN 1 AND 80),
      CHECK (length(trim(name)) BETWEEN 1 AND 160),
      CHECK (length(trim(mission)) BETWEEN 1 AND 4000),
      CHECK ((status='archived') = (archived_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_product_areas (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      parent_id TEXT REFERENCES os_product_areas(id) ON DELETE RESTRICT,
      area_key TEXT NOT NULL,
      name TEXT NOT NULL,
      mission TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE (organization_id, area_key),
      CHECK (parent_id IS NULL OR parent_id != id),
      CHECK ((status='archived') = (archived_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_teams (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      product_area_id TEXT REFERENCES os_product_areas(id) ON DELETE RESTRICT,
      team_key TEXT NOT NULL,
      name TEXT NOT NULL,
      mission TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE (organization_id, team_key),
      CHECK ((status='archived') = (archived_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_positions (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      position_key TEXT NOT NULL,
      role_family TEXT NOT NULL,
      title TEXT NOT NULL,
      capacity_milli INTEGER NOT NULL CHECK (capacity_milli BETWEEN 1 AND 100000),
      state TEXT NOT NULL CHECK (state IN ('planned', 'open', 'filled', 'closed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE (team_id, position_key),
      CHECK ((state='closed') = (closed_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_team_memberships (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      position_id TEXT REFERENCES os_positions(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK (
        state IN ('candidate', 'onboarding', 'active', 'leave', 'suspended', 'offboarded')
      ),
      allocation_milli INTEGER NOT NULL CHECK (allocation_milli BETWEEN 0 AND 100000),
      effective_from TEXT NOT NULL,
      effective_until TEXT,
      transition_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((state='offboarded') = (effective_until IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_membership_transitions (
      id TEXT PRIMARY KEY,
      membership_id TEXT NOT NULL REFERENCES os_team_memberships(id) ON DELETE RESTRICT,
      from_state TEXT,
      to_state TEXT NOT NULL CHECK (
        to_state IN ('candidate', 'onboarding', 'active', 'leave', 'suspended', 'offboarded')
      ),
      reason TEXT NOT NULL,
      handoff_ref TEXT,
      retention_policy_ref TEXT,
      audit_hold_ref TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      created_at TEXT NOT NULL,
      CHECK (from_state IS NULL OR from_state IN (
        'candidate', 'onboarding', 'active', 'leave', 'suspended', 'offboarded'
      )),
      CHECK (from_state IS NULL OR from_state != to_state)
    );

    CREATE TABLE IF NOT EXISTS os_role_definitions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      role_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      name TEXT NOT NULL,
      duties_json TEXT NOT NULL CHECK (json_valid(duties_json)),
      capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
      permissions_json TEXT NOT NULL CHECK (json_valid(permissions_json)),
      budgets_json TEXT NOT NULL CHECK (json_valid(budgets_json)),
      constraints_json TEXT NOT NULL CHECK (json_valid(constraints_json)),
      evidence_ttl_days INTEGER NOT NULL CHECK (evidence_ttl_days BETWEEN 1 AND 3650),
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      created_at TEXT NOT NULL,
      retired_at TEXT,
      UNIQUE (organization_id, role_key, version),
      CHECK ((status='retired') = (retired_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_role_assignments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      role_definition_id TEXT NOT NULL REFERENCES os_role_definitions(id) ON DELETE RESTRICT,
      agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      team_id TEXT REFERENCES os_teams(id) ON DELETE RESTRICT,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
      granted_by_type TEXT NOT NULL,
      granted_by_id TEXT,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT,
      CHECK ((status IN ('revoked', 'expired')) = (revoked_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_role_activations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      role_assignment_id TEXT NOT NULL REFERENCES os_role_assignments(id) ON DELETE RESTRICT,
      agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
      job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('active', 'ended', 'revoked')),
      activated_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      CHECK ((status='active') = (ended_at IS NULL))
    );

    CREATE TABLE IF NOT EXISTS os_capability_attestations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      role_assignment_id TEXT REFERENCES os_role_assignments(id) ON DELETE RESTRICT,
      capability TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('verified', 'rejected', 'insufficient_evidence')),
      evidence_ref TEXT NOT NULL,
      evidence_sha256 TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')
    );

    CREATE TABLE IF NOT EXISTS os_authority_policies (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      policy_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      name TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      actions_json TEXT NOT NULL CHECK (json_valid(actions_json)),
      risk_tier TEXT NOT NULL CHECK (risk_tier IN ('R0', 'R1', 'R2', 'R3', 'R4')),
      decision TEXT NOT NULL CHECK (decision IN ('allow', 'review', 'deny')),
      control TEXT NOT NULL CHECK (
        control IN ('automatic', 'independent_review', 'specialist_approval',
          'human_approval', 'two_person', 'prohibited')
      ),
      required_roles_json TEXT NOT NULL CHECK (json_valid(required_roles_json)),
      constraints_json TEXT NOT NULL CHECK (json_valid(constraints_json)),
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      created_at TEXT NOT NULL,
      retired_at TEXT,
      UNIQUE (organization_id, policy_key, version),
      CHECK ((status='retired') = (retired_at IS NOT NULL)),
      CHECK (risk_tier!='R4' OR decision='deny'),
      CHECK (risk_tier!='R4' OR control='prohibited')
    );

    CREATE TABLE IF NOT EXISTS os_team_ownerships (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES os_organizations(id) ON DELETE RESTRICT,
      team_id TEXT NOT NULL REFERENCES os_teams(id) ON DELETE RESTRICT,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      service_name TEXT NOT NULL,
      service_level_json TEXT NOT NULL CHECK (json_valid(service_level_json)),
      effective_from TEXT NOT NULL,
      effective_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_os_team_memberships_current
      ON os_team_memberships(team_id, agent_profile_id)
      WHERE state!='offboarded';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_os_role_assignments_active_scope
      ON os_role_assignments(role_definition_id, agent_profile_id, scope_kind, scope_id)
      WHERE status IN ('active', 'suspended');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_os_role_activations_active_session
      ON os_role_activations(role_assignment_id, session_id)
      WHERE status='active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_os_team_ownerships_current
      ON os_team_ownerships(organization_id, resource_kind, resource_id)
      WHERE effective_until IS NULL;
    CREATE INDEX IF NOT EXISTS idx_os_product_areas_organization
      ON os_product_areas(organization_id, status, area_key);
    CREATE INDEX IF NOT EXISTS idx_os_teams_organization
      ON os_teams(organization_id, status, team_key);
    CREATE INDEX IF NOT EXISTS idx_os_memberships_profile
      ON os_team_memberships(agent_profile_id, state, team_id);
    CREATE INDEX IF NOT EXISTS idx_os_membership_transitions_membership
      ON os_membership_transitions(membership_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_os_role_assignments_profile
      ON os_role_assignments(agent_profile_id, status, organization_id);
    CREATE INDEX IF NOT EXISTS idx_os_capability_attestations_freshness
      ON os_capability_attestations(agent_profile_id, capability, expires_at);
    CREATE INDEX IF NOT EXISTS idx_os_authority_policies_lookup
      ON os_authority_policies(
        organization_id, status, scope_kind, resource_kind, risk_tier, priority
      );

    CREATE TRIGGER IF NOT EXISTS os_product_areas_parent_scope_insert
    BEFORE INSERT ON os_product_areas
    WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM os_product_areas parent
      WHERE parent.id=NEW.parent_id AND parent.organization_id=NEW.organization_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'product area parent must belong to the same organization');
    END;

    CREATE TRIGGER IF NOT EXISTS os_product_areas_parent_scope_update
    BEFORE UPDATE OF organization_id, parent_id ON os_product_areas
    WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM os_product_areas parent
      WHERE parent.id=NEW.parent_id AND parent.organization_id=NEW.organization_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'product area parent must belong to the same organization');
    END;

    CREATE TRIGGER IF NOT EXISTS os_teams_area_scope_insert
    BEFORE INSERT ON os_teams
    WHEN NEW.product_area_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM os_product_areas area
      WHERE area.id=NEW.product_area_id AND area.organization_id=NEW.organization_id
        AND area.status='active'
    )
    BEGIN
      SELECT RAISE(ABORT, 'team product area must be active in the same organization');
    END;

    CREATE TRIGGER IF NOT EXISTS os_teams_area_scope_update
    BEFORE UPDATE OF organization_id, product_area_id ON os_teams
    WHEN NEW.product_area_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM os_product_areas area
      WHERE area.id=NEW.product_area_id AND area.organization_id=NEW.organization_id
        AND area.status='active'
    )
    BEGIN
      SELECT RAISE(ABORT, 'team product area must be active in the same organization');
    END;

    CREATE TRIGGER IF NOT EXISTS os_memberships_scope_insert
    BEFORE INSERT ON os_team_memberships
    WHEN NOT EXISTS (
      SELECT 1 FROM os_teams team
      JOIN os_organizations organization ON organization.id=team.organization_id
      JOIN agent_profiles profile ON profile.id=NEW.agent_profile_id
      WHERE team.id=NEW.team_id
        AND team.organization_id=NEW.organization_id
        AND profile.board_id=organization.board_id
        AND (NEW.position_id IS NULL OR EXISTS (
          SELECT 1 FROM os_positions position
          WHERE position.id=NEW.position_id AND position.team_id=NEW.team_id
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'membership scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_memberships_scope_update
    BEFORE UPDATE OF organization_id, team_id, agent_profile_id, position_id
    ON os_team_memberships
    WHEN NOT EXISTS (
      SELECT 1 FROM os_teams team
      JOIN os_organizations organization ON organization.id=team.organization_id
      JOIN agent_profiles profile ON profile.id=NEW.agent_profile_id
      WHERE team.id=NEW.team_id
        AND team.organization_id=NEW.organization_id
        AND profile.board_id=organization.board_id
        AND (NEW.position_id IS NULL OR EXISTS (
          SELECT 1 FROM os_positions position
          WHERE position.id=NEW.position_id AND position.team_id=NEW.team_id
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'membership scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_role_assignments_scope_insert
    BEFORE INSERT ON os_role_assignments
    WHEN NOT EXISTS (
      SELECT 1 FROM os_role_definitions role
      JOIN os_organizations organization ON organization.id=role.organization_id
      JOIN agent_profiles profile ON profile.id=NEW.agent_profile_id
      WHERE role.id=NEW.role_definition_id
        AND role.organization_id=NEW.organization_id
        AND role.status='active'
        AND profile.board_id=organization.board_id
        AND (NEW.team_id IS NULL OR EXISTS (
          SELECT 1 FROM os_teams team
          WHERE team.id=NEW.team_id AND team.organization_id=NEW.organization_id
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'role assignment scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_role_assignments_scope_update
    BEFORE UPDATE OF organization_id, role_definition_id, agent_profile_id, team_id
    ON os_role_assignments
    WHEN NOT EXISTS (
      SELECT 1 FROM os_role_definitions role
      JOIN os_organizations organization ON organization.id=role.organization_id
      JOIN agent_profiles profile ON profile.id=NEW.agent_profile_id
      WHERE role.id=NEW.role_definition_id
        AND role.organization_id=NEW.organization_id
        AND role.status='active'
        AND profile.board_id=organization.board_id
        AND (NEW.team_id IS NULL OR EXISTS (
          SELECT 1 FROM os_teams team
          WHERE team.id=NEW.team_id AND team.organization_id=NEW.organization_id
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'role assignment scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_role_activations_scope_insert
    BEFORE INSERT ON os_role_activations
    WHEN NOT EXISTS (
      SELECT 1 FROM os_role_assignments assignment
      JOIN agent_sessions session ON session.id=NEW.session_id
      WHERE assignment.id=NEW.role_assignment_id
        AND assignment.organization_id=NEW.organization_id
        AND assignment.agent_profile_id=NEW.agent_profile_id
        AND assignment.status='active'
        AND session.profile_id=NEW.agent_profile_id
        AND (NEW.job_id IS NULL OR session.job_id=NEW.job_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'role activation scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_role_activations_scope_update
    BEFORE UPDATE OF organization_id, role_assignment_id, agent_profile_id, session_id, job_id
    ON os_role_activations
    WHEN NOT EXISTS (
      SELECT 1 FROM os_role_assignments assignment
      JOIN agent_sessions session ON session.id=NEW.session_id
      WHERE assignment.id=NEW.role_assignment_id
        AND assignment.organization_id=NEW.organization_id
        AND assignment.agent_profile_id=NEW.agent_profile_id
        AND assignment.status='active'
        AND session.profile_id=NEW.agent_profile_id
        AND (NEW.job_id IS NULL OR session.job_id=NEW.job_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'role activation scope is inconsistent');
    END;

    CREATE TRIGGER IF NOT EXISTS os_team_ownerships_scope_insert
    BEFORE INSERT ON os_team_ownerships
    WHEN NOT EXISTS (
      SELECT 1 FROM os_teams team
      WHERE team.id=NEW.team_id AND team.organization_id=NEW.organization_id
        AND team.status='active'
    )
    BEGIN
      SELECT RAISE(ABORT, 'ownership team must be active in the organization');
    END;

    CREATE TRIGGER IF NOT EXISTS os_team_ownerships_scope_update
    BEFORE UPDATE OF organization_id, team_id ON os_team_ownerships
    WHEN NOT EXISTS (
      SELECT 1 FROM os_teams team
      WHERE team.id=NEW.team_id AND team.organization_id=NEW.organization_id
        AND team.status='active'
    )
    BEGIN
      SELECT RAISE(ABORT, 'ownership team must be active in the organization');
    END;
  `)

  assertOrganizationCoreSchemaCompatible(db)
}

function assertExistingOrganizationCoreTablesCompatible(db: Database.Database): void {
  for (const table of AGENT_OS_ORGANIZATION_CORE_TABLES) {
    const existing = db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name=?`).get(table)
    if (!existing) continue
    assertOrganizationTableColumnsCompatible(db, table)
  }
}

export function assertOrganizationCoreSchemaCompatible(
  db: Database.Database,
): void {
  for (const table of AGENT_OS_ORGANIZATION_CORE_TABLES) {
    const existing = db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name=?`).get(table)
    if (!existing) throw new Error(`organization core schema is missing table ${table}`)
    assertOrganizationTableColumnsCompatible(db, table)
  }
}

function assertOrganizationTableColumnsCompatible(
  db: Database.Database,
  table: typeof AGENT_OS_ORGANIZATION_CORE_TABLES[number],
): void {
  const actual = (db.pragma(`table_info('${table}')`) as Array<{ name: string }>)
    .map((column) => column.name)
  if (JSON.stringify(actual) !== JSON.stringify(TABLE_COLUMNS[table])) {
    throw new Error(`organization core table ${table} has an incompatible schema`)
  }
}

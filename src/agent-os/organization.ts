import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  actorIdentity,
  boundedString,
  canonicalHash,
  jsonRecord,
  optionalBoundedString,
  stringList,
  type ActorIdentity,
} from './agent-home-support.js'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { parseJson, timestamp } from './json.js'

export const MEMBERSHIP_STATES = Object.freeze([
  'candidate', 'onboarding', 'active', 'leave', 'suspended', 'offboarded',
] as const)
export type MembershipState = typeof MEMBERSHIP_STATES[number]

export const RISK_TIERS = Object.freeze(['R0', 'R1', 'R2', 'R3', 'R4'] as const)
export type RiskTier = typeof RISK_TIERS[number]

export const AUTHORITY_CONTROLS = Object.freeze([
  'automatic', 'independent_review', 'specialist_approval', 'human_approval',
  'two_person', 'prohibited',
] as const)
export type AuthorityControl = typeof AUTHORITY_CONTROLS[number]

const MEMBERSHIP_TRANSITIONS: Readonly<Record<MembershipState, readonly MembershipState[]>> = {
  candidate: ['onboarding', 'offboarded'],
  onboarding: ['active', 'suspended', 'offboarded'],
  active: ['leave', 'suspended', 'offboarded'],
  leave: ['active', 'suspended', 'offboarded'],
  suspended: ['active', 'offboarded'],
  offboarded: [],
}

export interface Organization {
  id: string
  board_id: number
  organization_key: string
  name: string
  mission: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface ProductArea {
  id: string
  organization_id: string
  parent_id: string | null
  area_key: string
  name: string
  mission: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface Team {
  id: string
  organization_id: string
  product_area_id: string | null
  team_key: string
  name: string
  mission: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface Position {
  id: string
  team_id: string
  position_key: string
  role_family: string
  title: string
  capacity_milli: number
  state: 'planned' | 'open' | 'filled' | 'closed'
  created_at: string
  updated_at: string
  closed_at: string | null
}

export interface TeamMembership {
  id: string
  organization_id: string
  team_id: string
  agent_profile_id: string
  position_id: string | null
  state: MembershipState
  allocation_milli: number
  effective_from: string
  effective_until: string | null
  transition_reason: string | null
  created_at: string
  updated_at: string
}

export interface RoleDefinition {
  id: string
  organization_id: string
  role_key: string
  version: number
  name: string
  duties: string[]
  capabilities: string[]
  permissions: string[]
  budgets: Record<string, unknown>
  constraints: Record<string, unknown>
  evidence_ttl_days: number
  status: 'active' | 'retired'
  created_at: string
  retired_at: string | null
}

export interface RoleAssignment {
  id: string
  organization_id: string
  role_definition_id: string
  agent_profile_id: string
  team_id: string | null
  scope_kind: string
  scope_id: string
  status: 'active' | 'suspended' | 'revoked' | 'expired'
  granted_by_type: string
  granted_by_id: string | null
  valid_from: string
  valid_until: string | null
  reason: string
  created_at: string
  updated_at: string
  revoked_at: string | null
}

export interface RoleActivation {
  id: string
  organization_id: string
  role_assignment_id: string
  agent_profile_id: string
  session_id: string
  job_id: string | null
  status: 'active' | 'ended' | 'revoked'
  activated_at: string
  ended_at: string | null
  end_reason: string | null
}

export interface AuthorityPolicy {
  id: string
  organization_id: string
  policy_key: string
  version: number
  name: string
  scope_kind: string
  resource_kind: string
  actions: string[]
  risk_tier: RiskTier
  decision: 'allow' | 'review' | 'deny'
  control: AuthorityControl
  required_roles: string[]
  constraints: Record<string, unknown>
  priority: number
  status: 'active' | 'retired'
  created_at: string
  retired_at: string | null
}

export interface AuthorityEvaluation {
  permitted: boolean
  decision: AuthorityPolicy['decision']
  control: AuthorityControl
  policy_id: string | null
  risk_tier: RiskTier
  active_role_keys: string[]
  missing_role_keys: string[]
  reason: string
}

export interface TeamOwnership {
  id: string
  organization_id: string
  team_id: string
  resource_kind: string
  resource_id: string
  service_name: string
  service_level: Record<string, unknown>
  effective_from: string
  effective_until: string | null
  created_at: string
  updated_at: string
}

interface CommandInput {
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

interface CommandReplay {
  result_id?: unknown
  request_fingerprint?: unknown
}

export class OrganizationService {
  private readonly events: EventStore

  constructor(private readonly db: Database.Database, events = new EventStore(db)) {
    this.events = events
  }

  createOrganization(input: CommandInput & {
    boardId: number
    key: string
    name: string
    mission: string
  }): Organization {
    const boardId = positiveInteger(input.boardId, 'board id')
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(boardId)) {
      throw new NotFoundError('board not found')
    }
    const normalized = {
      organization_key: identifier(input.key, 'organization key'),
      name: boundedString(input.name, 'organization name', 160),
      mission: boundedString(input.mission, 'organization mission', 4000),
    }
    return this.createCommand({
      boardId,
      kind: 'organization.created',
      input,
      fingerprint: { command: 'organization.create', boardId, ...normalized },
      load: (id) => this.requireOrganization(id),
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_organizations
          (id, board_id, organization_key, name, mission, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
          .run(id, boardId, normalized.organization_key, normalized.name, normalized.mission, at, at)
        return id
      },
    })
  }

  createProductArea(input: CommandInput & {
    organizationId: string
    parentId?: string | null
    key: string
    name: string
    mission: string
  }): ProductArea {
    const organization = this.requireActiveOrganization(input.organizationId)
    const normalized = {
      parent_id: optionalBoundedString(input.parentId, 'parent product area id', 200),
      area_key: identifier(input.key, 'product area key'),
      name: boundedString(input.name, 'product area name', 160),
      mission: boundedString(input.mission, 'product area mission', 4000),
    }
    if (normalized.parent_id) this.requireProductArea(normalized.parent_id)
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.product_area.created',
      input,
      fingerprint: { command: 'product_area.create', organizationId: organization.id, ...normalized },
      load: (id) => this.requireProductArea(id),
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_product_areas
          (id, organization_id, parent_id, area_key, name, mission, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
          .run(id, organization.id, normalized.parent_id, normalized.area_key,
            normalized.name, normalized.mission, at, at)
        return id
      },
    })
  }

  createTeam(input: CommandInput & {
    organizationId: string
    productAreaId?: string | null
    key: string
    name: string
    mission: string
  }): Team {
    const organization = this.requireActiveOrganization(input.organizationId)
    const normalized = {
      product_area_id: optionalBoundedString(input.productAreaId, 'product area id', 200),
      team_key: identifier(input.key, 'team key'),
      name: boundedString(input.name, 'team name', 160),
      mission: boundedString(input.mission, 'team mission', 4000),
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.team.created',
      input,
      fingerprint: { command: 'team.create', organizationId: organization.id, ...normalized },
      load: (id) => this.requireTeam(id),
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_teams
          (id, organization_id, product_area_id, team_key, name, mission, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
          .run(id, organization.id, normalized.product_area_id, normalized.team_key,
            normalized.name, normalized.mission, at, at)
        return id
      },
    })
  }

  createPosition(input: CommandInput & {
    teamId: string
    key: string
    roleFamily: string
    title: string
    capacityMilli?: number
    state?: Position['state']
  }): Position {
    const team = this.requireActiveTeam(input.teamId)
    const organization = this.requireOrganization(team.organization_id)
    const state = input.state ?? 'open'
    if (!['planned', 'open', 'filled'].includes(state)) {
      throw new ValidationError('new position state must be planned, open, or filled')
    }
    const normalized = {
      position_key: identifier(input.key, 'position key'),
      role_family: boundedString(input.roleFamily, 'role family', 120),
      title: boundedString(input.title, 'position title', 160),
      capacity_milli: allocation(input.capacityMilli ?? 100000, 'position capacity', false),
      state,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.position.created',
      input,
      fingerprint: { command: 'position.create', teamId: team.id, ...normalized },
      load: (id) => this.requirePosition(id),
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_positions
          (id, team_id, position_key, role_family, title, capacity_milli,
           state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, team.id, normalized.position_key, normalized.role_family,
            normalized.title, normalized.capacity_milli, normalized.state, at, at)
        return id
      },
    })
  }

  createMembership(input: CommandInput & {
    organizationId: string
    teamId: string
    agentProfileId: string
    positionId?: string | null
    allocationMilli?: number
    state?: Extract<MembershipState, 'candidate' | 'onboarding' | 'active'>
    reason: string
  }): TeamMembership {
    const organization = this.requireActiveOrganization(input.organizationId)
    const team = this.requireActiveTeam(input.teamId)
    if (team.organization_id !== organization.id) throw new ValidationError('team is outside organization')
    const profileId = boundedString(input.agentProfileId, 'agent profile id', 200)
    const profile = this.db.prepare('SELECT board_id, status FROM agent_profiles WHERE id=?')
      .get(profileId) as { board_id: number; status: string } | undefined
    if (!profile || profile.status !== 'active') throw new NotFoundError('active agent profile not found')
    if (profile.board_id !== organization.board_id) throw new ValidationError('agent profile is outside board')
    const state = input.state ?? 'candidate'
    const positionId = optionalBoundedString(input.positionId, 'position id', 200)
    const reason = boundedString(input.reason, 'membership reason', 2000)
    const normalized = {
      team_id: team.id,
      agent_profile_id: profileId,
      position_id: positionId,
      allocation_milli: allocation(input.allocationMilli ?? 100000, 'allocation', true),
      state,
      reason,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.membership.created',
      input,
      fingerprint: { command: 'membership.create', organizationId: organization.id, ...normalized },
      load: (id) => this.requireMembership(id),
      create: (actor) => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_team_memberships
          (id, organization_id, team_id, agent_profile_id, position_id, state,
           allocation_milli, effective_from, transition_reason, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, team.id, profileId, positionId, state,
            normalized.allocation_milli, at, reason, at, at)
        this.insertMembershipTransition({
          membershipId: id,
          fromState: null,
          toState: state,
          reason,
          actor,
          at,
        })
        return id
      },
    })
  }

  transitionMembership(id: string, input: CommandInput & {
    toState: MembershipState
    reason: string
    handoffRef?: string | null
    retentionPolicyRef?: string | null
    auditHoldRef?: string | null
  }): TeamMembership {
    const current = this.requireMembership(id)
    const organization = this.requireOrganization(current.organization_id)
    const toState = membershipState(input.toState)
    if (!MEMBERSHIP_TRANSITIONS[current.state].includes(toState)) {
      throw new ConflictError(`membership cannot transition from ${current.state} to ${toState}`)
    }
    const evidence = {
      reason: boundedString(input.reason, 'transition reason', 2000),
      handoff_ref: optionalBoundedString(input.handoffRef, 'handoff reference', 1000),
      retention_policy_ref: optionalBoundedString(
        input.retentionPolicyRef,
        'retention policy reference',
        1000,
      ),
      audit_hold_ref: optionalBoundedString(input.auditHoldRef, 'audit hold reference', 1000),
    }
    if (toState === 'offboarded' && (!evidence.handoff_ref || !evidence.retention_policy_ref)) {
      throw new ValidationError('offboarding requires handoff and retention policy references')
    }
    return this.updateCommand({
      boardId: organization.board_id,
      kind: 'organization.membership.transitioned',
      input,
      fingerprint: { command: 'membership.transition', membershipId: current.id, toState, ...evidence },
      resultId: current.id,
      load: () => this.requireMembership(current.id),
      update: (actor) => {
        const latest = this.requireMembership(current.id)
        if (!MEMBERSHIP_TRANSITIONS[latest.state].includes(toState)) {
          throw new ConflictError(`membership cannot transition from ${latest.state} to ${toState}`)
        }
        const at = timestamp()
        this.db.prepare(`UPDATE os_team_memberships SET state=?, transition_reason=?,
          effective_until=?, updated_at=? WHERE id=?`)
          .run(toState, evidence.reason, toState === 'offboarded' ? at : null, at, latest.id)
        if (toState === 'suspended' || toState === 'offboarded') {
          const terminal = toState === 'offboarded'
          this.db.prepare(`UPDATE os_role_assignments SET status=?, revoked_at=?, updated_at=?
            WHERE agent_profile_id=? AND organization_id=? AND status IN ('active','suspended')`)
            .run(terminal ? 'revoked' : 'suspended', terminal ? at : null, at,
              latest.agent_profile_id, latest.organization_id)
          this.db.prepare(`UPDATE os_role_activations SET status='revoked', ended_at=?, end_reason=?
            WHERE agent_profile_id=? AND organization_id=? AND status='active'`)
            .run(at, `membership ${toState}`, latest.agent_profile_id, latest.organization_id)
        } else if (toState === 'active' && latest.state === 'suspended') {
          this.db.prepare(`UPDATE os_role_assignments SET status='active', updated_at=?
            WHERE agent_profile_id=? AND organization_id=? AND status='suspended'
              AND (valid_until IS NULL OR valid_until>?)`)
            .run(at, latest.agent_profile_id, latest.organization_id, at)
        }
        this.insertMembershipTransition({
          membershipId: latest.id,
          fromState: latest.state,
          toState,
          ...evidence,
          actor,
          at,
        })
      },
    })
  }

  createRoleDefinition(input: CommandInput & {
    organizationId: string
    key: string
    version: number
    name: string
    duties: string[]
    capabilities: string[]
    permissions: string[]
    budgets?: Record<string, unknown>
    constraints?: Record<string, unknown>
    evidenceTtlDays?: number
  }): RoleDefinition {
    const organization = this.requireActiveOrganization(input.organizationId)
    const normalized = {
      role_key: identifier(input.key, 'role key'),
      version: positiveInteger(input.version, 'role version'),
      name: boundedString(input.name, 'role name', 160),
      duties: stringList(input.duties, 'duties').map((item) => boundedString(item, 'duty', 500)),
      capabilities: stringList(input.capabilities, 'capabilities')
        .map((item) => boundedString(item, 'capability', 160)),
      permissions: stringList(input.permissions, 'permissions')
        .map((item) => boundedString(item, 'permission', 200)),
      budgets: jsonRecord(input.budgets, 'budgets'),
      constraints: jsonRecord(input.constraints, 'constraints'),
      evidence_ttl_days: boundedInteger(input.evidenceTtlDays ?? 90, 'evidence TTL days', 1, 3650),
    }
    validateRoleConstraints(normalized.constraints)
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.role_definition.created',
      input,
      fingerprint: { command: 'role_definition.create', organizationId: organization.id, ...normalized },
      load: (id) => this.requireRoleDefinition(id),
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_role_definitions
          (id, organization_id, role_key, version, name, duties_json, capabilities_json,
           permissions_json, budgets_json, constraints_json, evidence_ttl_days, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
          .run(id, organization.id, normalized.role_key, normalized.version, normalized.name,
            JSON.stringify(normalized.duties), JSON.stringify(normalized.capabilities),
            JSON.stringify(normalized.permissions), JSON.stringify(normalized.budgets),
            JSON.stringify(normalized.constraints), normalized.evidence_ttl_days, at)
        return id
      },
    })
  }

  assignRole(input: CommandInput & {
    roleDefinitionId: string
    agentProfileId: string
    teamId?: string | null
    scopeKind: string
    scopeId: string
    validUntil?: string | null
    reason: string
  }): RoleAssignment {
    const role = this.requireRoleDefinition(input.roleDefinitionId)
    if (role.status !== 'active') throw new ConflictError('role definition is retired')
    const organization = this.requireActiveOrganization(role.organization_id)
    const profileId = boundedString(input.agentProfileId, 'agent profile id', 200)
    const teamId = optionalBoundedString(input.teamId, 'team id', 200)
    const scopeKind = boundedString(input.scopeKind, 'scope kind', 120)
    const scopeId = boundedString(input.scopeId, 'scope id', 300)
    const reason = boundedString(input.reason, 'assignment reason', 2000)
    const validUntil = optionalIsoTimestamp(input.validUntil, 'valid until')
    this.assertStaticSeparationOfDuties(role, profileId)
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.role_assignment.created',
      input,
      fingerprint: {
        command: 'role_assignment.create', roleDefinitionId: role.id, profileId,
        teamId, scopeKind, scopeId, validUntil, reason,
      },
      load: (id) => this.requireRoleAssignment(id),
      create: (actor) => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_role_assignments
          (id, organization_id, role_definition_id, agent_profile_id, team_id,
           scope_kind, scope_id, status, granted_by_type, granted_by_id, valid_from,
           valid_until, reason, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, role.id, profileId, teamId, scopeKind, scopeId,
            actor.type, actor.id, at, validUntil, reason, at, at)
        return id
      },
    })
  }

  attestCapability(input: CommandInput & {
    organizationId: string
    agentProfileId: string
    roleAssignmentId?: string | null
    capability: string
    verdict: 'verified' | 'rejected' | 'insufficient_evidence'
    evidenceRef: string
    evidenceSha256: string
    observedAt?: string
    expiresAt: string
  }): Record<string, unknown> {
    const organization = this.requireActiveOrganization(input.organizationId)
    const profileId = boundedString(input.agentProfileId, 'agent profile id', 200)
    const roleAssignmentId = optionalBoundedString(input.roleAssignmentId, 'role assignment id', 200)
    const capability = boundedString(input.capability, 'capability', 160)
    const verdict = input.verdict
    if (!['verified', 'rejected', 'insufficient_evidence'].includes(verdict)) {
      throw new ValidationError('capability verdict is invalid')
    }
    const evidenceRef = boundedString(input.evidenceRef, 'evidence reference', 1000)
    const evidenceSha256 = sha256(input.evidenceSha256, 'evidence sha256')
    const observedAt = optionalIsoTimestamp(input.observedAt, 'observed at') ?? timestamp()
    const expiresAt = requiredIsoTimestamp(input.expiresAt, 'expires at')
    if (expiresAt <= observedAt) throw new ValidationError('capability evidence must expire after observation')
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.capability.attested',
      input,
      fingerprint: {
        command: 'capability.attest', organizationId: organization.id, profileId,
        roleAssignmentId, capability, verdict, evidenceRef, evidenceSha256, observedAt, expiresAt,
      },
      load: (id) => this.requireRecord('os_capability_attestations', id),
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_capability_attestations
          (id, organization_id, agent_profile_id, role_assignment_id, capability,
           verdict, evidence_ref, evidence_sha256, observed_at, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, profileId, roleAssignmentId, capability, verdict,
            evidenceRef, evidenceSha256, observedAt, expiresAt, timestamp())
        return id
      },
    })
  }

  activateRole(input: CommandInput & {
    roleAssignmentId: string
    sessionId: string
    jobId?: string | null
  }): RoleActivation {
    const assignment = this.requireRoleAssignment(input.roleAssignmentId)
    if (assignment.status !== 'active') throw new ForbiddenError('role assignment is not active')
    const organization = this.requireActiveOrganization(assignment.organization_id)
    const at = timestamp()
    if (assignment.valid_until && assignment.valid_until <= at) {
      throw new ForbiddenError('role assignment has expired')
    }
    const sessionId = boundedString(input.sessionId, 'session id', 200)
    const jobId = optionalBoundedString(input.jobId, 'job id', 200)
    const role = this.requireRoleDefinition(assignment.role_definition_id)
    this.assertActiveMembership(assignment)
    this.assertFreshCapabilities(role, assignment.agent_profile_id, at)
    this.assertDynamicSeparationOfDuties(role, sessionId)
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.role_activation.created',
      input,
      fingerprint: { command: 'role_activation.create', assignmentId: assignment.id, sessionId, jobId },
      load: (id) => this.requireRoleActivation(id),
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_role_activations
          (id, organization_id, role_assignment_id, agent_profile_id, session_id,
           job_id, status, activated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`)
          .run(id, organization.id, assignment.id, assignment.agent_profile_id,
            sessionId, jobId, at)
        return id
      },
    })
  }

  createAuthorityPolicy(input: CommandInput & {
    organizationId: string
    key: string
    version: number
    name: string
    scopeKind: string
    resourceKind: string
    actions: string[]
    riskTier: RiskTier
    decision: AuthorityPolicy['decision']
    control: AuthorityControl
    requiredRoles?: string[]
    constraints?: Record<string, unknown>
    priority?: number
  }): AuthorityPolicy {
    const organization = this.requireActiveOrganization(input.organizationId)
    const normalized = {
      policy_key: identifier(input.key, 'policy key'),
      version: positiveInteger(input.version, 'policy version'),
      name: boundedString(input.name, 'policy name', 160),
      scope_kind: boundedString(input.scopeKind, 'scope kind', 120),
      resource_kind: boundedString(input.resourceKind, 'resource kind', 120),
      actions: stringList(input.actions, 'actions').map((item) => boundedString(item, 'action', 160)),
      risk_tier: riskTier(input.riskTier),
      decision: authorityDecision(input.decision),
      control: authorityControl(input.control),
      required_roles: stringList(input.requiredRoles, 'required roles')
        .map((item) => identifier(item, 'required role')),
      constraints: jsonRecord(input.constraints, 'constraints'),
      priority: boundedInteger(input.priority ?? 0, 'priority', -100000, 100000),
    }
    if (normalized.risk_tier === 'R4'
      && (normalized.decision !== 'deny' || normalized.control !== 'prohibited')) {
      throw new ValidationError('R4 policy must deny with prohibited control')
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.authority_policy.created',
      input,
      fingerprint: { command: 'authority_policy.create', organizationId: organization.id, ...normalized },
      load: (id) => this.requireAuthorityPolicy(id),
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_authority_policies
          (id, organization_id, policy_key, version, name, scope_kind, resource_kind,
           actions_json, risk_tier, decision, control, required_roles_json,
           constraints_json, priority, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
          .run(id, organization.id, normalized.policy_key, normalized.version,
            normalized.name, normalized.scope_kind, normalized.resource_kind,
            JSON.stringify(normalized.actions), normalized.risk_tier, normalized.decision,
            normalized.control, JSON.stringify(normalized.required_roles),
            JSON.stringify(normalized.constraints), normalized.priority, at)
        return id
      },
    })
  }

  evaluateAuthority(input: {
    organizationId: string
    agentProfileId: string
    sessionId: string
    scopeKind: string
    resourceKind: string
    action: string
    riskTier: RiskTier
  }): AuthorityEvaluation {
    const organization = this.requireActiveOrganization(input.organizationId)
    const profileId = boundedString(input.agentProfileId, 'agent profile id', 200)
    const sessionId = boundedString(input.sessionId, 'session id', 200)
    const scopeKind = boundedString(input.scopeKind, 'scope kind', 120)
    const resourceKind = boundedString(input.resourceKind, 'resource kind', 120)
    const action = boundedString(input.action, 'action', 160)
    const tier = riskTier(input.riskTier)
    const activeRoleKeys = this.activeRoleKeys(organization.id, profileId, sessionId)
    const candidates = (this.db.prepare(`SELECT * FROM os_authority_policies
      WHERE organization_id=? AND status='active' AND risk_tier=?
        AND scope_kind IN (?, '*') AND resource_kind IN (?, '*')
      ORDER BY priority DESC, version DESC, created_at DESC`)
      .all(organization.id, tier, scopeKind, resourceKind) as Record<string, unknown>[])
      .map(mapAuthorityPolicy)
      .filter((policy) => policy.actions.includes(action) || policy.actions.includes('*'))
    const policy = candidates[0]
    if (!policy) return deniedEvaluation(tier, activeRoleKeys, 'no matching authority policy')
    const missingRoles = policy.required_roles.filter((role) => !activeRoleKeys.includes(role))
    if (missingRoles.length) {
      return {
        permitted: false,
        decision: 'deny',
        control: 'prohibited',
        policy_id: policy.id,
        risk_tier: tier,
        active_role_keys: activeRoleKeys,
        missing_role_keys: missingRoles,
        reason: 'required active roles are missing',
      }
    }
    return {
      permitted: policy.decision !== 'deny' && policy.control !== 'prohibited',
      decision: policy.decision,
      control: policy.control,
      policy_id: policy.id,
      risk_tier: tier,
      active_role_keys: activeRoleKeys,
      missing_role_keys: [],
      reason: policy.decision === 'deny' ? 'policy denied action' : 'matched explicit authority policy',
    }
  }

  assignOwnership(input: CommandInput & {
    organizationId: string
    teamId: string
    resourceKind: string
    resourceId: string
    serviceName: string
    serviceLevel?: Record<string, unknown>
  }): TeamOwnership {
    const organization = this.requireActiveOrganization(input.organizationId)
    const team = this.requireActiveTeam(input.teamId)
    if (team.organization_id !== organization.id) throw new ValidationError('team is outside organization')
    const normalized = {
      resource_kind: boundedString(input.resourceKind, 'resource kind', 120),
      resource_id: boundedString(input.resourceId, 'resource id', 300),
      service_name: boundedString(input.serviceName, 'service name', 200),
      service_level: jsonRecord(input.serviceLevel, 'service level'),
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.ownership.assigned',
      input,
      fingerprint: { command: 'ownership.assign', organizationId: organization.id, teamId: team.id, ...normalized },
      load: (id) => this.requireOwnership(id),
      create: () => {
        const at = timestamp()
        this.db.prepare(`UPDATE os_team_ownerships SET effective_until=?, updated_at=?
          WHERE organization_id=? AND resource_kind=? AND resource_id=?
            AND effective_until IS NULL`)
          .run(at, at, organization.id, normalized.resource_kind, normalized.resource_id)
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_team_ownerships
          (id, organization_id, team_id, resource_kind, resource_id, service_name,
           service_level_json, effective_from, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, team.id, normalized.resource_kind,
            normalized.resource_id, normalized.service_name,
            JSON.stringify(normalized.service_level), at, at, at)
        return id
      },
    })
  }

  organizationSnapshot(organizationId: string): Record<string, unknown> {
    const organization = this.requireOrganization(organizationId)
    const areas = (this.db.prepare(`SELECT * FROM os_product_areas
      WHERE organization_id=? ORDER BY area_key`).all(organization.id) as Record<string, unknown>[])
      .map(mapProductArea)
    const teams = (this.db.prepare(`SELECT * FROM os_teams
      WHERE organization_id=? ORDER BY team_key`).all(organization.id) as Record<string, unknown>[])
      .map(mapTeam)
    const memberships = (this.db.prepare(`SELECT * FROM os_team_memberships
      WHERE organization_id=? ORDER BY created_at`).all(organization.id) as Record<string, unknown>[])
      .map(mapMembership)
    const roles = (this.db.prepare(`SELECT * FROM os_role_definitions
      WHERE organization_id=? ORDER BY role_key, version`).all(organization.id) as Record<string, unknown>[])
      .map(mapRoleDefinition)
    const assignments = (this.db.prepare(`SELECT * FROM os_role_assignments
      WHERE organization_id=? ORDER BY created_at`).all(organization.id) as Record<string, unknown>[])
      .map(mapRoleAssignment)
    const ownerships = (this.db.prepare(`SELECT * FROM os_team_ownerships
      WHERE organization_id=? AND effective_until IS NULL ORDER BY resource_kind, resource_id`)
      .all(organization.id) as Record<string, unknown>[]).map(mapOwnership)
    return { organization, product_areas: areas, teams, memberships, roles, assignments, ownerships }
  }

  listBoardOrganizations(boardId: number): Organization[] {
    const id = positiveInteger(boardId, 'board id')
    return (this.db.prepare(`SELECT * FROM os_organizations
      WHERE board_id=? ORDER BY status, organization_key`).all(id) as Record<string, unknown>[])
      .map(mapOrganization)
  }

  requireOrganization(id: string): Organization {
    return mapRequired(this.db, 'os_organizations', id, 'organization', mapOrganization)
  }

  requireProductArea(id: string): ProductArea {
    return mapRequired(this.db, 'os_product_areas', id, 'product area', mapProductArea)
  }

  requireTeam(id: string): Team {
    return mapRequired(this.db, 'os_teams', id, 'team', mapTeam)
  }

  requirePosition(id: string): Position {
    return mapRequired(this.db, 'os_positions', id, 'position', mapPosition)
  }

  requireMembership(id: string): TeamMembership {
    return mapRequired(this.db, 'os_team_memberships', id, 'membership', mapMembership)
  }

  requireRoleDefinition(id: string): RoleDefinition {
    return mapRequired(this.db, 'os_role_definitions', id, 'role definition', mapRoleDefinition)
  }

  requireRoleAssignment(id: string): RoleAssignment {
    return mapRequired(this.db, 'os_role_assignments', id, 'role assignment', mapRoleAssignment)
  }

  requireRoleActivation(id: string): RoleActivation {
    return mapRequired(this.db, 'os_role_activations', id, 'role activation', mapRoleActivation)
  }

  requireAuthorityPolicy(id: string): AuthorityPolicy {
    return mapRequired(this.db, 'os_authority_policies', id, 'authority policy', mapAuthorityPolicy)
  }

  requireOwnership(id: string): TeamOwnership {
    return mapRequired(this.db, 'os_team_ownerships', id, 'ownership', mapOwnership)
  }

  private requireActiveOrganization(id: string): Organization {
    const organization = this.requireOrganization(id)
    if (organization.status !== 'active') throw new ConflictError('organization is archived')
    return organization
  }

  private requireActiveTeam(id: string): Team {
    const team = this.requireTeam(id)
    if (team.status !== 'active') throw new ConflictError('team is archived')
    return team
  }

  private requireRecord(table: string, id: string): Record<string, unknown> {
    const value = boundedString(id, 'record id', 200)
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(value) as
      Record<string, unknown> | undefined
    if (!row) throw new NotFoundError('organization record not found')
    return row
  }

  private insertMembershipTransition(input: {
    membershipId: string
    fromState: MembershipState | null
    toState: MembershipState
    reason: string
    handoff_ref?: string | null
    retention_policy_ref?: string | null
    audit_hold_ref?: string | null
    actor: ActorIdentity
    at: string
  }): void {
    this.db.prepare(`INSERT INTO os_membership_transitions
      (id, membership_id, from_state, to_state, reason, handoff_ref,
       retention_policy_ref, audit_hold_ref, actor_type, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), input.membershipId, input.fromState, input.toState, input.reason,
        input.handoff_ref ?? null, input.retention_policy_ref ?? null,
        input.audit_hold_ref ?? null, input.actor.type, input.actor.id, input.at)
  }

  private assertStaticSeparationOfDuties(role: RoleDefinition, profileId: string): void {
    const incompatible = constraintStringList(role.constraints, 'incompatible_role_keys')
    const active = this.activeAssignedRoleKeys(role.organization_id, profileId)
    if (incompatible.some((key) => active.includes(key))) {
      throw new ForbiddenError('role assignment violates static separation of duties')
    }
    const reverse = (this.db.prepare(`SELECT definition.constraints_json
      FROM os_role_assignments assignment
      JOIN os_role_definitions definition ON definition.id=assignment.role_definition_id
      WHERE assignment.organization_id=? AND assignment.agent_profile_id=?
        AND assignment.status IN ('active','suspended')`)
      .all(role.organization_id, profileId) as Array<{ constraints_json: string }>)
      .some((row) => constraintStringList(parseJson(row.constraints_json, {}),
        'incompatible_role_keys').includes(role.role_key))
    if (reverse) throw new ForbiddenError('role assignment violates static separation of duties')
  }

  private assertDynamicSeparationOfDuties(role: RoleDefinition, sessionId: string): void {
    const active = this.activeRoleKeys(role.organization_id, null, sessionId)
    const incompatible = constraintStringList(role.constraints, 'incompatible_role_keys')
    if (incompatible.some((key) => active.includes(key))) {
      throw new ForbiddenError('role activation violates dynamic separation of duties')
    }
    const reverse = (this.db.prepare(`SELECT definition.role_key, definition.constraints_json
      FROM os_role_activations activation
      JOIN os_role_assignments assignment ON assignment.id=activation.role_assignment_id
      JOIN os_role_definitions definition ON definition.id=assignment.role_definition_id
      WHERE activation.organization_id=? AND activation.session_id=? AND activation.status='active'`)
      .all(role.organization_id, sessionId) as Array<{ role_key: string; constraints_json: string }>)
      .some((row) => constraintStringList(parseJson(row.constraints_json, {}),
        'incompatible_role_keys').includes(role.role_key))
    if (reverse) throw new ForbiddenError('role activation violates dynamic separation of duties')
  }

  private assertActiveMembership(assignment: RoleAssignment): void {
    const row = this.db.prepare(`SELECT 1 FROM os_team_memberships
      WHERE organization_id=? AND agent_profile_id=? AND state='active'
        AND (? IS NULL OR team_id=?) LIMIT 1`)
      .get(assignment.organization_id, assignment.agent_profile_id,
        assignment.team_id, assignment.team_id)
    if (!row) throw new ForbiddenError('active team membership is required to activate a role')
  }

  private assertFreshCapabilities(role: RoleDefinition, profileId: string, at: string): void {
    for (const capability of role.capabilities) {
      const evidence = this.db.prepare(`SELECT 1 FROM os_capability_attestations
        WHERE organization_id=? AND agent_profile_id=? AND capability=?
          AND verdict='verified' AND observed_at<=? AND expires_at>?
        ORDER BY observed_at DESC LIMIT 1`)
        .get(role.organization_id, profileId, capability, at, at)
      if (!evidence) throw new ForbiddenError(`fresh capability evidence is required for ${capability}`)
    }
  }

  private activeAssignedRoleKeys(organizationId: string, profileId: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT definition.role_key
      FROM os_role_assignments assignment
      JOIN os_role_definitions definition ON definition.id=assignment.role_definition_id
      WHERE assignment.organization_id=? AND assignment.agent_profile_id=?
        AND assignment.status IN ('active','suspended')`)
      .all(organizationId, profileId) as Array<{ role_key: string }>).map((row) => row.role_key)
  }

  private activeRoleKeys(
    organizationId: string,
    profileId: string | null,
    sessionId: string,
  ): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT definition.role_key, definition.constraints_json
      FROM os_role_activations activation
      JOIN os_role_assignments assignment ON assignment.id=activation.role_assignment_id
      JOIN os_role_definitions definition ON definition.id=assignment.role_definition_id
      WHERE activation.organization_id=? AND activation.session_id=? AND activation.status='active'
        AND (? IS NULL OR activation.agent_profile_id=?)`)
      .all(organizationId, sessionId, profileId, profileId) as Array<{
        role_key: string
        constraints_json: string
      }>
    const keys = new Set(rows.map((row) => row.role_key))
    for (const row of rows) {
      for (const inherited of constraintStringList(parseJson(row.constraints_json, {}),
        'inherits_role_keys')) keys.add(inherited)
    }
    return [...keys].sort()
  }

  private createCommand<T>(input: {
    boardId: number
    kind: string
    input: CommandInput
    fingerprint: Record<string, unknown>
    load: (id: string) => T
    create: (actor: ActorIdentity) => string
  }): T {
    const actor = actorIdentity(input.input.actor)
    const key = boundedString(input.input.idempotencyKey, 'idempotency key', 200)
    const fingerprint = canonicalHash(input.fingerprint)
    const replay = this.commandReplay(input.boardId, key, input.kind, fingerprint)
    if (replay) return input.load(String(replay.result_id))
    return this.db.transaction(() => {
      const raced = this.commandReplay(input.boardId, key, input.kind, fingerprint)
      if (raced) return input.load(String(raced.result_id))
      const id = input.create(actor)
      this.events.append({
        boardId: input.boardId,
        actor,
        kind: input.kind,
        source: 'organization',
        idempotencyKey: key,
        correlationId: input.input.correlationId ?? key,
        payload: { result_id: id, request_fingerprint: fingerprint, actor },
      })
      return input.load(id)
    }).immediate()
  }

  private updateCommand<T>(input: {
    boardId: number
    kind: string
    input: CommandInput
    fingerprint: Record<string, unknown>
    resultId?: string
    load: () => T
    update: (actor: ActorIdentity) => void
  }): T {
    const actor = actorIdentity(input.input.actor)
    const key = boundedString(input.input.idempotencyKey, 'idempotency key', 200)
    const fingerprint = canonicalHash(input.fingerprint)
    const replay = this.commandReplay(input.boardId, key, input.kind, fingerprint)
    if (replay) return input.load()
    return this.db.transaction(() => {
      const raced = this.commandReplay(input.boardId, key, input.kind, fingerprint)
      if (raced) return input.load()
      input.update(actor)
      this.events.append({
        boardId: input.boardId,
        actor,
        kind: input.kind,
        source: 'organization',
        idempotencyKey: key,
        correlationId: input.input.correlationId ?? key,
        payload: {
          result_id: input.resultId ?? null,
          request_fingerprint: fingerprint,
          actor,
        },
      })
      return input.load()
    }).immediate()
  }

  private commandReplay(
    boardId: number,
    key: string,
    kind: string,
    fingerprint: string,
  ): CommandReplay | null {
    const row = this.db.prepare(`SELECT kind, payload FROM os_events
      WHERE board_id=? AND idempotency_key=?`).get(boardId, key) as
      { kind: string; payload: string } | undefined
    if (!row) return null
    const payload = parseJson<CommandReplay>(row.payload, {})
    if (row.kind !== kind || payload.request_fingerprint !== fingerprint) {
      throw new ConflictError('idempotency key was already used for a different organization command')
    }
    return payload
  }
}

function mapRequired<T>(
  db: Database.Database,
  table: string,
  id: string,
  label: string,
  mapper: (row: Record<string, unknown>) => T,
): T {
  const value = boundedString(id, `${label} id`, 200)
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(value) as
    Record<string, unknown> | undefined
  if (!row) throw new NotFoundError(`${label} not found`)
  return mapper(row)
}

function mapOrganization(row: Record<string, unknown>): Organization {
  return { ...row, board_id: Number(row.board_id), archived_at: nullable(row.archived_at) } as Organization
}

function mapProductArea(row: Record<string, unknown>): ProductArea {
  return { ...row, parent_id: nullable(row.parent_id), archived_at: nullable(row.archived_at) } as ProductArea
}

function mapTeam(row: Record<string, unknown>): Team {
  return {
    ...row,
    product_area_id: nullable(row.product_area_id),
    archived_at: nullable(row.archived_at),
  } as Team
}

function mapPosition(row: Record<string, unknown>): Position {
  return {
    ...row,
    capacity_milli: Number(row.capacity_milli),
    closed_at: nullable(row.closed_at),
  } as Position
}

function mapMembership(row: Record<string, unknown>): TeamMembership {
  return {
    ...row,
    position_id: nullable(row.position_id),
    allocation_milli: Number(row.allocation_milli),
    effective_until: nullable(row.effective_until),
    transition_reason: nullable(row.transition_reason),
  } as TeamMembership
}

function mapRoleDefinition(row: Record<string, unknown>): RoleDefinition {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    role_key: String(row.role_key),
    version: Number(row.version),
    name: String(row.name),
    duties: parseJson(row.duties_json, []),
    capabilities: parseJson(row.capabilities_json, []),
    permissions: parseJson(row.permissions_json, []),
    budgets: parseJson(row.budgets_json, {}),
    constraints: parseJson(row.constraints_json, {}),
    evidence_ttl_days: Number(row.evidence_ttl_days),
    status: String(row.status) as RoleDefinition['status'],
    created_at: String(row.created_at),
    retired_at: nullable(row.retired_at),
  }
}

function mapRoleAssignment(row: Record<string, unknown>): RoleAssignment {
  return {
    ...row,
    team_id: nullable(row.team_id),
    granted_by_id: nullable(row.granted_by_id),
    valid_until: nullable(row.valid_until),
    revoked_at: nullable(row.revoked_at),
  } as RoleAssignment
}

function mapRoleActivation(row: Record<string, unknown>): RoleActivation {
  return {
    ...row,
    job_id: nullable(row.job_id),
    ended_at: nullable(row.ended_at),
    end_reason: nullable(row.end_reason),
  } as RoleActivation
}

function mapAuthorityPolicy(row: Record<string, unknown>): AuthorityPolicy {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    policy_key: String(row.policy_key),
    version: Number(row.version),
    name: String(row.name),
    scope_kind: String(row.scope_kind),
    resource_kind: String(row.resource_kind),
    actions: parseJson(row.actions_json, []),
    risk_tier: String(row.risk_tier) as RiskTier,
    decision: String(row.decision) as AuthorityPolicy['decision'],
    control: String(row.control) as AuthorityControl,
    required_roles: parseJson(row.required_roles_json, []),
    constraints: parseJson(row.constraints_json, {}),
    priority: Number(row.priority),
    status: String(row.status) as AuthorityPolicy['status'],
    created_at: String(row.created_at),
    retired_at: nullable(row.retired_at),
  }
}

function mapOwnership(row: Record<string, unknown>): TeamOwnership {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    team_id: String(row.team_id),
    resource_kind: String(row.resource_kind),
    resource_id: String(row.resource_id),
    service_name: String(row.service_name),
    service_level: parseJson(row.service_level_json, {}),
    effective_from: String(row.effective_from),
    effective_until: nullable(row.effective_until),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

function nullable(value: unknown): string | null {
  return value == null ? null : String(value)
}

function identifier(value: unknown, field: string): string {
  const normalized = boundedString(value, field, 80).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new ValidationError(`${field} must be a lowercase identifier`)
  }
  return normalized
}

function positiveInteger(value: unknown, field: string): number {
  return boundedInteger(value, field, 1, Number.MAX_SAFE_INTEGER)
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ValidationError(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return Number(value)
}

function allocation(value: unknown, field: string, allowZero: boolean): number {
  return boundedInteger(value, field, allowZero ? 0 : 1, 100000)
}

function membershipState(value: unknown): MembershipState {
  if (!MEMBERSHIP_STATES.includes(value as MembershipState)) {
    throw new ValidationError(`membership state must be ${MEMBERSHIP_STATES.join(', ')}`)
  }
  return value as MembershipState
}

function riskTier(value: unknown): RiskTier {
  if (!RISK_TIERS.includes(value as RiskTier)) throw new ValidationError('risk tier is invalid')
  return value as RiskTier
}

function authorityDecision(value: unknown): AuthorityPolicy['decision'] {
  if (!['allow', 'review', 'deny'].includes(String(value))) {
    throw new ValidationError('authority decision must be allow, review, or deny')
  }
  return value as AuthorityPolicy['decision']
}

function authorityControl(value: unknown): AuthorityControl {
  if (!AUTHORITY_CONTROLS.includes(value as AuthorityControl)) {
    throw new ValidationError('authority control is invalid')
  }
  return value as AuthorityControl
}

function optionalIsoTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredIsoTimestamp(value, field)
}

function requiredIsoTimestamp(value: unknown, field: string): string {
  const normalized = boundedString(value, field, 64)
  if (Number.isNaN(Date.parse(normalized))) throw new ValidationError(`${field} must be an ISO timestamp`)
  return new Date(normalized).toISOString()
}

function sha256(value: unknown, field: string): string {
  const normalized = boundedString(value, field, 64).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new ValidationError(`${field} must be lowercase sha256`)
  return normalized
}

function validateRoleConstraints(value: Record<string, unknown>): void {
  for (const key of ['incompatible_role_keys', 'inherits_role_keys']) {
    if (value[key] !== undefined) constraintStringList(value, key)
  }
}

function constraintStringList(value: Record<string, unknown>, key: string): string[] {
  const list = value[key]
  if (list === undefined) return []
  return stringList(list, key).map((item) => identifier(item, key))
}

function deniedEvaluation(
  tier: RiskTier,
  activeRoleKeys: string[],
  reason: string,
): AuthorityEvaluation {
  return {
    permitted: false,
    decision: 'deny',
    control: 'prohibited',
    policy_id: null,
    risk_tier: tier,
    active_role_keys: activeRoleKeys,
    missing_role_keys: [],
    reason,
  }
}

import { describe, expect, it } from 'vitest'
import { AgentProfileService, type AgentProfile } from '../src/agent-os/agent-profiles.js'
import { OrganizationAssuranceService } from '../src/agent-os/organization-assurance.js'
import { OrganizationService, type Team } from '../src/agent-os/organization.js'
import { openDb } from '../src/db.js'

const actor = { type: 'human', id: 'governance-owner' } as const
const future = '2099-12-01T00:00:00.000Z'

function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/organization-governance', 'Organization Governance')`).run().lastInsertRowid)
  const profiles = new AgentProfileService(db)
  const member = profiles.create({
    boardId,
    name: 'Member',
    actor,
    idempotencyKey: 'governance-member',
  })
  const reviewer = profiles.create({
    boardId,
    name: 'Reviewer',
    actor,
    idempotencyKey: 'governance-reviewer',
  })
  const service = new OrganizationService(db)
  const organization = service.createOrganization({
    boardId,
    key: 'governance',
    name: 'Governance',
    mission: 'Prove organization lifecycle and authority controls.',
    actor,
    idempotencyKey: 'governance-organization',
  })
  const team = service.createTeam({
    organizationId: organization.id,
    key: 'product',
    name: 'Product',
    mission: 'Own governed delivery.',
    actor,
    idempotencyKey: 'governance-team',
  })
  return { db, boardId, profiles, member, reviewer, service, organization, team }
}

function createSession(
  context: ReturnType<typeof fixture>,
  profile: AgentProfile,
  key: string,
): string {
  const conversation = context.db.prepare(`SELECT id FROM agent_conversations
    WHERE profile_id=? AND is_default=1`).get(profile.id) as { id: string }
  const workspaceId = `governance-workspace-${key}`
  const sessionId = `governance-session-${key}`
  context.db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, ?, 'worktree', ?, 'active')`)
    .run(workspaceId, context.boardId, workspaceId, `/tmp/${workspaceId}`)
  context.db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, status, profile_id, conversation_id, mode)
    VALUES (?, ?, 'codex', 'running', ?, ?, 'managed')`)
    .run(sessionId, workspaceId, profile.id, conversation.id)
  return sessionId
}

function activateSimpleRole(input: {
  context: ReturnType<typeof fixture>
  profile: AgentProfile
  team: Team
  sessionId: string
  key: string
  permissions: string[]
  constraints?: Record<string, unknown>
}) {
  const role = input.context.service.createRoleDefinition({
    organizationId: input.context.organization.id,
    key: input.key,
    version: 1,
    name: input.key,
    duties: [`Perform ${input.key}.`],
    capabilities: [],
    permissions: input.permissions,
    constraints: input.constraints,
    actor,
    idempotencyKey: `governance-role-${input.key}`,
  })
  const assignment = input.context.service.assignRole({
    roleDefinitionId: role.id,
    agentProfileId: input.profile.id,
    teamId: input.team.id,
    scopeKind: 'team',
    scopeId: input.team.id,
    validUntil: future,
    reason: `Exercise ${input.key}.`,
    actor,
    idempotencyKey: `governance-assignment-${input.key}`,
  })
  const activation = input.context.service.activateRole({
    roleAssignmentId: assignment.id,
    sessionId: input.sessionId,
    actor,
    idempotencyKey: `governance-activation-${input.key}`,
  })
  return { role, assignment, activation }
}

describe('Organization governance controls', () => {
  it('traverses every membership state and retains offboarding evidence', () => {
    const context = fixture()
    const membership = context.service.createMembership({
      organizationId: context.organization.id,
      teamId: context.team.id,
      agentProfileId: context.member.id,
      state: 'candidate',
      reason: 'Candidate accepted into onboarding.',
      actor,
      idempotencyKey: 'governance-membership-candidate',
    })
    const transitions = [
      ['onboarding', 'Begin policy and capability onboarding.'],
      ['active', 'Onboarding evidence accepted.'],
      ['leave', 'Enter a bounded leave window.'],
      ['active', 'Return from leave.'],
      ['suspended', 'Suspend while access is reviewed.'],
      ['active', 'Independent review restored membership.'],
    ] as const
    for (const [index, [toState, reason]] of transitions.entries()) {
      expect(context.service.transitionMembership(membership.id, {
        toState,
        reason,
        actor,
        idempotencyKey: `governance-membership-transition-${index}`,
      }).state).toBe(toState)
    }
    expect(context.service.transitionMembership(membership.id, {
      toState: 'offboarded',
      reason: 'The bounded assignment ended.',
      handoffRef: 'artifact://handoff/governance-member',
      retentionPolicyRef: 'policy://retention/redacted-audit',
      auditHoldRef: 'audit://hold/none',
      actor,
      idempotencyKey: 'governance-membership-offboarded',
    }).state).toBe('offboarded')
    expect(context.db.prepare(`SELECT from_state, to_state, handoff_ref,
      retention_policy_ref, audit_hold_ref FROM os_membership_transitions
      WHERE membership_id=? ORDER BY rowid DESC LIMIT 1`).get(membership.id)).toEqual({
      from_state: 'active',
      to_state: 'offboarded',
      handoff_ref: 'artifact://handoff/governance-member',
      retention_policy_ref: 'policy://retention/redacted-audit',
      audit_hold_ref: 'audit://hold/none',
    })
    expect((context.db.prepare(`SELECT to_state FROM os_membership_transitions
      WHERE membership_id=? ORDER BY rowid`).all(membership.id) as Array<{ to_state: string }>)
      .map((row) => row.to_state)).toEqual([
      'candidate', 'onboarding', 'active', 'leave', 'active', 'suspended', 'active', 'offboarded',
    ])
    context.db.close()
  })

  it('honors inherited roles and re-evaluates dynamic separation at activation', () => {
    const context = fixture()
    context.service.createMembership({
      organizationId: context.organization.id,
      teamId: context.team.id,
      agentProfileId: context.member.id,
      state: 'active',
      reason: 'Staff governed delivery.',
      actor,
      idempotencyKey: 'governance-membership-active',
    })
    const sessionId = createSession(context, context.member, 'member')
    const senior = activateSimpleRole({
      context,
      profile: context.member,
      team: context.team,
      sessionId,
      key: 'senior-builder',
      permissions: ['source.write'],
      constraints: { inherits_role_keys: ['builder'] },
    })
    context.service.createAuthorityPolicy({
      organizationId: context.organization.id,
      key: 'builder-source-r1',
      version: 1,
      name: 'Inherited builder source policy',
      scopeKind: 'team',
      resourceKind: 'source',
      actions: ['write'],
      riskTier: 'R1',
      decision: 'review',
      control: 'independent_review',
      requiredRoles: ['builder'],
      actor,
      idempotencyKey: 'governance-policy-builder',
    })
    expect(context.service.evaluateAuthority({
      organizationId: context.organization.id,
      agentProfileId: context.member.id,
      sessionId,
      scopeKind: 'team',
      resourceKind: 'source',
      action: 'write',
      riskTier: 'R1',
    })).toMatchObject({
      permitted: true,
      active_role_keys: ['builder', 'senior-builder'],
      missing_role_keys: [],
    })

    const approverRole = context.service.createRoleDefinition({
      organizationId: context.organization.id,
      key: 'release-approver',
      version: 1,
      name: 'Release approver',
      duties: ['Approve releases independently.'],
      capabilities: [],
      permissions: ['release.approve'],
      actor,
      idempotencyKey: 'governance-role-release-approver',
    })
    const approverAssignment = context.service.assignRole({
      roleDefinitionId: approverRole.id,
      agentProfileId: context.member.id,
      teamId: context.team.id,
      scopeKind: 'team',
      scopeId: context.team.id,
      reason: 'Assignment predates the stricter dynamic policy.',
      actor,
      idempotencyKey: 'governance-assignment-release-approver',
    })
    context.db.prepare(`UPDATE os_role_definitions SET constraints_json=? WHERE id=?`)
      .run(JSON.stringify({ incompatible_role_keys: ['senior-builder'] }), approverRole.id)
    expect(() => context.service.activateRole({
      roleAssignmentId: approverAssignment.id,
      sessionId,
      actor,
      idempotencyKey: 'governance-prohibited-dynamic-activation',
    })).toThrow(/dynamic separation of duties/)
    expect(senior.activation.status).toBe('active')
    context.db.close()
  })

  it('requires independent access certification, remediation evidence, revocation, and appeal', () => {
    const context = fixture()
    context.service.createMembership({
      organizationId: context.organization.id,
      teamId: context.team.id,
      agentProfileId: context.member.id,
      state: 'active',
      reason: 'Staff governed delivery.',
      actor,
      idempotencyKey: 'governance-access-membership',
    })
    const sessionId = createSession(context, context.member, 'access-member')
    const active = activateSimpleRole({
      context,
      profile: context.member,
      team: context.team,
      sessionId,
      key: 'access-worker',
      permissions: ['source.read'],
    })
    const assurance = new OrganizationAssuranceService(context.db)
    expect(() => assurance.certifyAccess({
      organizationId: context.organization.id,
      roleAssignmentId: active.assignment.id,
      reviewerProfileId: context.member.id,
      decision: 'certified',
      evidenceRefs: ['audit://access/self'],
      reason: 'Attempted self certification.',
      expiresAt: future,
      actor,
      idempotencyKey: 'governance-access-self-certification',
    })).toThrow(/independently reviewed/)
    expect(() => assurance.certifyAccess({
      organizationId: context.organization.id,
      roleAssignmentId: active.assignment.id,
      reviewerProfileId: context.reviewer.id,
      decision: 'remediate',
      evidenceRefs: ['audit://access/missing-scope'],
      reason: 'Scope should be narrowed.',
      expiresAt: future,
      actor,
      idempotencyKey: 'governance-access-remediation-missing-ref',
    })).toThrow(/remediation reference/)
    expect(assurance.certifyAccess({
      organizationId: context.organization.id,
      roleAssignmentId: active.assignment.id,
      reviewerProfileId: context.reviewer.id,
      decision: 'remediate',
      evidenceRefs: ['audit://access/missing-scope'],
      reason: 'Scope should be narrowed.',
      expiresAt: future,
      remediationRef: 'action://access/narrow-scope',
      actor,
      idempotencyKey: 'governance-access-remediation',
    })).toMatchObject({
      decision: 'remediate',
      remediation_ref: 'action://access/narrow-scope',
    })
    const revocation = assurance.certifyAccess({
      organizationId: context.organization.id,
      roleAssignmentId: active.assignment.id,
      reviewerProfileId: context.reviewer.id,
      decision: 'revoke',
      evidenceRefs: ['audit://access/revocation'],
      reason: 'The assignment no longer has a valid purpose.',
      expiresAt: future,
      actor,
      idempotencyKey: 'governance-access-revocation',
    })
    expect(context.service.requireRoleAssignment(active.assignment.id).status).toBe('revoked')
    expect(context.db.prepare(`SELECT status, end_reason FROM os_role_activations WHERE id=?`)
      .get(active.activation.id)).toEqual({
      status: 'revoked',
      end_reason: 'access certification revoked',
    })
    const appeal = assurance.fileReviewAppeal({
      organizationId: context.organization.id,
      reviewKind: 'access',
      reviewId: String(revocation.id),
      appellantProfileId: context.member.id,
      grounds: 'The role purpose has been corrected and should be independently reconsidered.',
      evidenceRefs: ['action://access/narrow-scope/verified'],
      actor,
      idempotencyKey: 'governance-access-appeal',
    })
    expect(assurance.resolveReviewAppeal(String(appeal.id), {
      status: 'modified',
      independentReviewerProfileId: context.reviewer.id,
      resolution: 'The historical revocation stands; a narrower fresh assignment may be created.',
      actor,
      idempotencyKey: 'governance-access-appeal-resolution',
    })).toMatchObject({
      status: 'modified',
      independent_reviewer_profile_id: context.reviewer.id,
    })
    context.db.close()
  })
})

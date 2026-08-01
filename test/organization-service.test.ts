import { describe, expect, it } from 'vitest'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { OrganizationService } from '../src/agent-os/organization.js'
import { openDb } from '../src/db.js'

const actor = { type: 'human', id: 'product-owner' }

function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/organization-service', 'Organization Service')`).run().lastInsertRowid)
  const profile = new AgentProfileService(db).create({
    boardId,
    name: 'Builder',
    actor,
    idempotencyKey: 'profile-builder',
  })
  const service = new OrganizationService(db)
  const organization = service.createOrganization({
    boardId,
    key: 'acme',
    name: 'Acme',
    mission: 'Deliver reliable customer value.',
    actor,
    idempotencyKey: 'organization-acme',
  })
  const area = service.createProductArea({
    organizationId: organization.id,
    key: 'product',
    name: 'Product',
    mission: 'Own the customer product.',
    actor,
    idempotencyKey: 'area-product',
  })
  const team = service.createTeam({
    organizationId: organization.id,
    productAreaId: area.id,
    key: 'stream',
    name: 'Stream Team',
    mission: 'Own product delivery.',
    actor,
    idempotencyKey: 'team-stream',
  })
  return { db, boardId, profile, service, organization, area, team }
}

function createSession(
  db: ReturnType<typeof openDb>,
  boardId: number,
  profileId: string,
  suffix = 'builder',
): string {
  const conversation = db.prepare(`SELECT id FROM agent_conversations
    WHERE profile_id=? AND is_default=1`).get(profileId) as { id: string }
  const workspaceId = `workspace-${suffix}`
  const sessionId = `session-${suffix}`
  db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, ?, 'worktree', ?, 'active')`)
    .run(workspaceId, boardId, workspaceId, `/tmp/${workspaceId}`)
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, status, profile_id, conversation_id, mode)
    VALUES (?, ?, 'codex', 'running', ?, ?, 'managed')`)
    .run(sessionId, workspaceId, profileId, conversation.id)
  return sessionId
}

describe('OrganizationService', () => {
  it('separates identity, membership, assignment, activation, and authority with replay safety', () => {
    const { db, boardId, profile, service, organization, team } = fixture()
    const replay = service.createOrganization({
      boardId,
      key: 'acme',
      name: 'Acme',
      mission: 'Deliver reliable customer value.',
      actor,
      idempotencyKey: 'organization-acme',
    })
    expect(replay.id).toBe(organization.id)

    const position = service.createPosition({
      teamId: team.id,
      key: 'engineer-1',
      roleFamily: 'engineering',
      title: 'Product Engineer',
      actor,
      idempotencyKey: 'position-engineer-1',
    })
    const membership = service.createMembership({
      organizationId: organization.id,
      teamId: team.id,
      agentProfileId: profile.id,
      positionId: position.id,
      state: 'active',
      reason: 'Staff the stream team.',
      actor,
      idempotencyKey: 'membership-builder',
    })
    const role = service.createRoleDefinition({
      organizationId: organization.id,
      key: 'builder',
      version: 1,
      name: 'Builder',
      duties: ['Implement frozen contracts'],
      capabilities: ['typescript'],
      permissions: ['source.write'],
      budgets: { token_limit: 100000 },
      constraints: { incompatible_role_keys: ['approver'] },
      evidenceTtlDays: 90,
      actor,
      idempotencyKey: 'role-builder-v1',
    })
    const assignment = service.assignRole({
      roleDefinitionId: role.id,
      agentProfileId: profile.id,
      teamId: team.id,
      scopeKind: 'team',
      scopeId: team.id,
      reason: 'Implement this team backlog.',
      actor,
      idempotencyKey: 'assign-builder',
    })
    const sessionId = createSession(db, boardId, profile.id)
    expect(() => service.activateRole({
      roleAssignmentId: assignment.id,
      sessionId,
      actor,
      idempotencyKey: 'activate-without-evidence',
    })).toThrow(/fresh capability evidence/)

    service.attestCapability({
      organizationId: organization.id,
      agentProfileId: profile.id,
      roleAssignmentId: assignment.id,
      capability: 'typescript',
      verdict: 'verified',
      evidenceRef: 'test://typescript-suite',
      evidenceSha256: 'a'.repeat(64),
      observedAt: '2026-08-01T20:00:00.000Z',
      expiresAt: '2027-08-01T20:00:00.000Z',
      actor,
      idempotencyKey: 'attest-typescript',
    })
    const activation = service.activateRole({
      roleAssignmentId: assignment.id,
      sessionId,
      actor,
      idempotencyKey: 'activate-builder',
    })
    expect(activation.agent_profile_id).toBe(profile.id)
    expect(activation.role_assignment_id).toBe(assignment.id)
    expect(membership.agent_profile_id).toBe(profile.id)

    service.createAuthorityPolicy({
      organizationId: organization.id,
      key: 'source-r1',
      version: 1,
      name: 'R1 source changes',
      scopeKind: 'team',
      resourceKind: 'source',
      actions: ['write'],
      riskTier: 'R1',
      decision: 'review',
      control: 'independent_review',
      requiredRoles: ['builder'],
      actor,
      idempotencyKey: 'policy-source-r1',
    })
    expect(service.evaluateAuthority({
      organizationId: organization.id,
      agentProfileId: profile.id,
      sessionId,
      scopeKind: 'team',
      resourceKind: 'source',
      action: 'write',
      riskTier: 'R1',
    })).toMatchObject({
      permitted: true,
      decision: 'review',
      control: 'independent_review',
      active_role_keys: ['builder'],
    })
    expect(service.evaluateAuthority({
      organizationId: organization.id,
      agentProfileId: profile.id,
      sessionId,
      scopeKind: 'team',
      resourceKind: 'production',
      action: 'delete',
      riskTier: 'R3',
    })).toMatchObject({ permitted: false, control: 'prohibited' })
    db.close()
  })

  it('enforces static separation of duties and immediate offboarding revocation', () => {
    const { db, boardId, profile, service, organization, team } = fixture()
    const membership = service.createMembership({
      organizationId: organization.id,
      teamId: team.id,
      agentProfileId: profile.id,
      state: 'active',
      reason: 'Join team.',
      actor,
      idempotencyKey: 'membership-builder',
    })
    const builder = service.createRoleDefinition({
      organizationId: organization.id,
      key: 'builder',
      version: 1,
      name: 'Builder',
      duties: ['Build'],
      capabilities: [],
      permissions: ['source.write'],
      constraints: { incompatible_role_keys: ['approver'] },
      actor,
      idempotencyKey: 'builder-role',
    })
    const approver = service.createRoleDefinition({
      organizationId: organization.id,
      key: 'approver',
      version: 1,
      name: 'Approver',
      duties: ['Approve'],
      capabilities: [],
      permissions: ['release.approve'],
      constraints: { incompatible_role_keys: ['builder'] },
      actor,
      idempotencyKey: 'approver-role',
    })
    const assignment = service.assignRole({
      roleDefinitionId: builder.id,
      agentProfileId: profile.id,
      teamId: team.id,
      scopeKind: 'team',
      scopeId: team.id,
      reason: 'Build.',
      actor,
      idempotencyKey: 'builder-assignment',
    })
    expect(() => service.assignRole({
      roleDefinitionId: approver.id,
      agentProfileId: profile.id,
      teamId: team.id,
      scopeKind: 'team',
      scopeId: team.id,
      reason: 'Self approve.',
      actor,
      idempotencyKey: 'approver-assignment',
    })).toThrow(/static separation of duties/)
    const sessionId = createSession(db, boardId, profile.id)
    service.activateRole({
      roleAssignmentId: assignment.id,
      sessionId,
      actor,
      idempotencyKey: 'activate-builder',
    })

    const offboarded = service.transitionMembership(membership.id, {
      toState: 'offboarded',
      reason: 'End assignment.',
      handoffRef: 'artifact://handoff/1',
      retentionPolicyRef: 'policy://retention/default',
      actor,
      idempotencyKey: 'offboard-builder',
    })
    expect(offboarded.state).toBe('offboarded')
    expect(service.requireRoleAssignment(assignment.id).status).toBe('revoked')
    const activation = db.prepare('SELECT status, end_reason FROM os_role_activations WHERE session_id=?')
      .get(sessionId)
    expect(activation).toEqual({ status: 'revoked', end_reason: 'membership offboarded' })
    expect(db.prepare(`SELECT handoff_ref, retention_policy_ref
      FROM os_membership_transitions WHERE membership_id=? AND to_state='offboarded'`)
      .get(membership.id)).toEqual({
      handoff_ref: 'artifact://handoff/1',
      retention_policy_ref: 'policy://retention/default',
    })
    db.close()
  })

  it('keeps exactly one effective accountable owner per resource', () => {
    const { db, service, organization, team } = fixture()
    const second = service.createTeam({
      organizationId: organization.id,
      key: 'platform',
      name: 'Platform',
      mission: 'Serve stream teams.',
      actor,
      idempotencyKey: 'team-platform',
    })
    service.assignOwnership({
      organizationId: organization.id,
      teamId: team.id,
      resourceKind: 'service',
      resourceId: 'checkout',
      serviceName: 'Checkout',
      serviceLevel: { availability: 99.9 },
      actor,
      idempotencyKey: 'own-checkout-stream',
    })
    const current = service.assignOwnership({
      organizationId: organization.id,
      teamId: second.id,
      resourceKind: 'service',
      resourceId: 'checkout',
      serviceName: 'Checkout',
      serviceLevel: { availability: 99.95 },
      actor,
      idempotencyKey: 'own-checkout-platform',
    })
    expect(current.team_id).toBe(second.id)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_team_ownerships
      WHERE organization_id=? AND resource_kind='service' AND resource_id='checkout'
        AND effective_until IS NULL`).get(organization.id) as { count: number }).count).toBe(1)
    expect((service.organizationSnapshot(organization.id).ownerships as Array<{ team_id: string }>)[0]
      .team_id).toBe(second.id)
    db.close()
  })
})

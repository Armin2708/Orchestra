import { describe, expect, it } from 'vitest'
import { AgentProfileService, type AgentProfile } from '../src/agent-os/agent-profiles.js'
import { OrganizationCoordinationService } from '../src/agent-os/organization-coordination.js'
import { OrganizationService, type RoleActivation } from '../src/agent-os/organization.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { openDb } from '../src/db.js'

const actor = { type: 'human', id: 'owner' }

function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/coordination', 'Coordination')`).run().lastInsertRowid)
  const profiles = new AgentProfileService(db)
  const builder = profiles.create({ boardId, name: 'Builder', actor, idempotencyKey: 'profile-builder' })
  const decider = profiles.create({ boardId, name: 'Decider', actor, idempotencyKey: 'profile-decider' })
  const reviewer = profiles.create({ boardId, name: 'Reviewer', actor, idempotencyKey: 'profile-reviewer' })
  const organizationService = new OrganizationService(db)
  const organization = organizationService.createOrganization({
    boardId,
    key: 'acme',
    name: 'Acme',
    mission: 'Ship safely.',
    actor,
    idempotencyKey: 'organization',
  })
  const productTeam = organizationService.createTeam({
    organizationId: organization.id,
    key: 'product',
    name: 'Product',
    mission: 'Own customer value.',
    actor,
    idempotencyKey: 'product-team',
  })
  const platformTeam = organizationService.createTeam({
    organizationId: organization.id,
    key: 'platform',
    name: 'Platform',
    mission: 'Provide reliable services.',
    actor,
    idempotencyKey: 'platform-team',
  })
  for (const [profile, team, key] of [
    [builder, productTeam, 'builder'],
    [decider, productTeam, 'decider'],
    [reviewer, platformTeam, 'reviewer'],
  ] as const) {
    organizationService.createMembership({
      organizationId: organization.id,
      teamId: team.id,
      agentProfileId: profile.id,
      state: 'active',
      reason: 'Staff delivery.',
      actor,
      idempotencyKey: `membership-${key}`,
    })
  }
  const coordination = new OrganizationCoordinationService(db)
  return {
    db, boardId, builder, decider, reviewer, organizationService, organization,
    productTeam, platformTeam, coordination,
  }
}

function activate(
  context: ReturnType<typeof fixture>,
  profile: AgentProfile,
  teamId: string,
  roleKey: string,
): RoleActivation {
  const role = context.organizationService.createRoleDefinition({
    organizationId: context.organization.id,
    key: roleKey,
    version: 1,
    name: roleKey,
    duties: [`Perform ${roleKey} duties`],
    capabilities: [],
    permissions: [`${roleKey}.act`],
    actor,
    idempotencyKey: `role-${roleKey}`,
  })
  const assignment = context.organizationService.assignRole({
    roleDefinitionId: role.id,
    agentProfileId: profile.id,
    teamId,
    scopeKind: 'organization',
    scopeId: context.organization.id,
    reason: `Act as ${roleKey}.`,
    actor,
    idempotencyKey: `assignment-${roleKey}-${profile.id}`,
  })
  const conversation = context.db.prepare(`SELECT id FROM agent_conversations
    WHERE profile_id=? AND is_default=1`).get(profile.id) as { id: string }
  const workspaceId = `workspace-${roleKey}-${profile.id}`
  const sessionId = `session-${roleKey}-${profile.id}`
  context.db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, ?, 'worktree', ?, 'active')`)
    .run(workspaceId, context.boardId, workspaceId, `/tmp/${workspaceId}`)
  context.db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, status, profile_id, conversation_id, mode)
    VALUES (?, ?, 'codex', 'running', ?, ?, 'managed')`)
    .run(sessionId, workspaceId, profile.id, conversation.id)
  return context.organizationService.activateRole({
    roleAssignmentId: assignment.id,
    sessionId,
    actor,
    idempotencyKey: `activation-${roleKey}-${profile.id}`,
  })
}

describe('OrganizationCoordinationService', () => {
  it('links two-team work from objective and design to contract, decision, capacity, and escalation', () => {
    const context = fixture()
    const { db, boardId, builder, decider, reviewer, organization, productTeam,
      platformTeam, coordination } = context
    const interaction = coordination.createTeamInteraction({
      organizationId: organization.id,
      mode: 'x_as_a_service',
      ownerTeamId: productTeam.id,
      providerTeamId: platformTeam.id,
      consumerTeamId: productTeam.id,
      participantTeamIds: [productTeam.id, platformTeam.id],
      purpose: 'Consume build service.',
      serviceContractRef: 'service://build/v1',
      serviceLevel: { response_minutes: 30 },
      exitCondition: 'Product delivery completes.',
      expiresAt: '2027-01-01T00:00:00.000Z',
      actor,
      idempotencyKey: 'interaction-build-service',
    })
    expect(interaction.mode).toBe('x_as_a_service')
    const responsibility = coordination.assignResponsibility({
      organizationId: organization.id,
      workKind: 'product_slice',
      workId: 'slice-1',
      driProfileId: builder.id,
      deciderProfileId: decider.id,
      consulted: ['customer-research'],
      reviewerProfileIds: [reviewer.id],
      informed: ['stakeholders'],
      riskTier: 'R2',
      actor,
      idempotencyKey: 'responsibility-slice-1',
    })
    const objective = coordination.createObjective({
      organizationId: organization.id,
      key: 'checkout-success',
      version: 1,
      statement: 'Increase successful checkout completion.',
      outcomeDefinition: { metric: 'completion_rate', target: 0.9 },
      customerEvidenceRefs: ['research://checkout/1'],
      ownerTeamId: productTeam.id,
      actor,
      idempotencyKey: 'objective-checkout',
    })
    const cardId = Number(db.prepare(`INSERT INTO cards
      (board_id, title, description) VALUES (?, 'Checkout', 'Improve checkout')`)
      .run(boardId).lastInsertRowid)
    new TaskContractService(db).getOrCreate(cardId)
    const goal = coordination.createTeamGoal({
      organizationId: organization.id,
      objectiveId: String(objective.id),
      teamId: productTeam.id,
      key: 'checkout-slice',
      version: 1,
      statement: 'Deliver the validated checkout slice.',
      measure: { completion_rate: 0.9 },
      designRef: 'figma://checkout/frame-1',
      designVersion: 'v3',
      designSha256: 'a'.repeat(64),
      contractCardId: cardId,
      actor,
      idempotencyKey: 'goal-checkout-slice',
    })
    expect(goal).toMatchObject({
      objective_id: objective.id,
      contract_card_id: cardId,
      contract_version: 1,
      design_sha256: 'a'.repeat(64),
    })
    const capacity = coordination.captureCapacity({
      organizationId: organization.id,
      teamId: productTeam.id,
      windowStart: '2026-08-01T00:00:00.000Z',
      windowEnd: '2026-08-08T00:00:00.000Z',
      availableMilli: 200000,
      allocatedMilli: 180000,
      wipLimit: 3,
      currentWip: 3,
      queuedDemand: 4,
      blockedCount: 1,
      oldestBlockedAt: '2026-08-01T10:00:00.000Z',
      constraints: { required_skill: 'payments', review_slots: 1 },
      sourceRefs: ['board://capacity/2026-w31'],
      actor,
      idempotencyKey: 'capacity-w31',
    })
    expect(capacity).toMatchObject({ current_wip: 3, queued_demand: 4, blocked_count: 1 })
    const decision = coordination.recordDecision({
      organizationId: organization.id,
      key: 'checkout-architecture',
      version: 1,
      question: 'Which checkout integration should we use?',
      ownerTeamId: productTeam.id,
      deciderProfileId: decider.id,
      responsibilityId: String(responsibility.id),
      options: [{ id: 'adapter', summary: 'Adapter' }, { id: 'direct', summary: 'Direct' }],
      evidenceRefs: ['benchmark://checkout/1'],
      selectedOption: 'adapter',
      rationale: 'The adapter bounds provider coupling.',
      acceptedRisks: ['Small translation overhead'],
      actor,
      idempotencyKey: 'decision-checkout-architecture',
    })
    const escalation = coordination.createEscalation({
      organizationId: organization.id,
      sourceKind: 'service_dependency',
      sourceId: String(interaction.id),
      threshold: 'Build response SLO breached.',
      attemptedActions: ['Retried once', 'Checked provider status'],
      evidenceRefs: ['log://build/timeout-1'],
      riskOfWaiting: 'Release window will be missed.',
      options: ['Restore build service', 'Use approved fallback'],
      recommendation: 'Restore service and preserve provenance.',
      requiredAuthority: 'platform-decider',
      targetRoleKey: 'decider',
      responseDeadline: '2026-12-01T00:00:00.000Z',
      actor,
      idempotencyKey: 'escalation-build-timeout',
    })
    expect(coordination.resolveEscalation(String(escalation.id), {
      status: 'resolved',
      resolution: 'Build service restored.',
      decisionId: String(decision.id),
      actor,
      idempotencyKey: 'resolve-build-timeout',
    })).toMatchObject({ status: 'resolved', decision_id: decision.id })
    expect(coordination.coordinationSnapshot(organization.id)).toMatchObject({
      interactions: expect.any(Array),
      objectives: expect.any(Array),
      goals: expect.any(Array),
      decisions: expect.any(Array),
    })
    db.close()
  })

  it('uses targeted typed durable messages and stops automated acknowledgement fanout', () => {
    const context = fixture()
    const activation = activate(context, context.builder, context.productTeam.id, 'builder')
    const message = context.coordination.sendMessage({
      organizationId: context.organization.id,
      threadId: 'work-slice-1',
      teamId: context.productTeam.id,
      actorProfileId: context.builder.id,
      sessionId: activation.session_id,
      roleActivationId: activation.id,
      intent: 'BLOCKER',
      recipientProfileIds: [context.decider.id],
      requestedAction: 'Resolve the service dependency.',
      links: { work_id: 'slice-1' },
      payload: { reason: 'service timeout' },
      summary: 'Build service is blocked.',
      automated: true,
      actor,
      idempotencyKey: 'message-blocker',
    })
    expect(message).toMatchObject({
      intent: 'BLOCKER',
      recipient_profile_ids: [context.decider.id],
      fanout_depth: 0,
      status: 'durable',
    })
    expect(context.coordination.sendMessage({
      organizationId: context.organization.id,
      threadId: 'work-slice-1',
      parentId: message.id,
      actorProfileId: context.builder.id,
      sessionId: activation.session_id,
      roleActivationId: activation.id,
      intent: 'ANSWER',
      recipientProfileIds: [context.decider.id],
      links: {},
      payload: { status: 'received' },
      automated: true,
      actor,
      idempotencyKey: 'message-auto-answer',
    })).toMatchObject({ fanout_depth: 1 })
    const parent = context.coordination.sendMessage({
      organizationId: context.organization.id,
      threadId: 'ack-loop',
      actorProfileId: context.builder.id,
      sessionId: activation.session_id,
      roleActivationId: activation.id,
      intent: 'QUESTION',
      recipientProfileIds: [context.decider.id],
      links: {},
      automated: true,
      actor,
      idempotencyKey: 'message-automated-no-action',
    })
    expect(() => context.coordination.sendMessage({
      organizationId: context.organization.id,
      threadId: 'ack-loop',
      parentId: parent.id,
      actorProfileId: context.builder.id,
      sessionId: activation.session_id,
      roleActivationId: activation.id,
      intent: 'ANSWER',
      recipientProfileIds: [context.decider.id],
      links: {},
      automated: true,
      actor,
      idempotencyKey: 'message-prohibited-ack',
    })).toThrow(/acknowledgement loops/)
    context.db.close()
  })

  it('selects risk controls and enforces history-based and two-person separation', () => {
    const context = fixture()
    const builderActivation = activate(context, context.builder, context.productTeam.id, 'builder')
    const reviewerActivation = activate(context, context.reviewer, context.platformTeam.id, 'security-reviewer')
    const deciderActivation = activate(context, context.decider, context.productTeam.id, 'release-approver')
    context.organizationService.createAuthorityPolicy({
      organizationId: context.organization.id,
      key: 'source-r2',
      version: 1,
      name: 'Shared source changes',
      scopeKind: 'team',
      resourceKind: 'source',
      actions: ['write'],
      riskTier: 'R2',
      decision: 'review',
      control: 'specialist_approval',
      requiredRoles: ['builder'],
      actor,
      idempotencyKey: 'policy-source-r2',
    })
    context.organizationService.createAuthorityPolicy({
      organizationId: context.organization.id,
      key: 'release-r3',
      version: 1,
      name: 'Public release',
      scopeKind: 'team',
      resourceKind: 'release',
      actions: ['publish'],
      riskTier: 'R3',
      decision: 'review',
      control: 'two_person',
      requiredRoles: ['builder'],
      actor,
      idempotencyKey: 'policy-release-r3',
    })
    const digest = 'b'.repeat(64)
    context.coordination.recordParticipation({
      organizationId: context.organization.id,
      subjectKind: 'change',
      subjectId: 'change-1',
      artifactSha256: digest,
      agentProfileId: context.builder.id,
      sessionId: builderActivation.session_id,
      participationKind: 'author',
      actor,
      idempotencyKey: 'participation-author-change-1',
    })
    const r2 = context.coordination.assessRisk({
      organizationId: context.organization.id,
      actorProfileId: context.builder.id,
      sessionId: builderActivation.session_id,
      scopeKind: 'team',
      resourceKind: 'source',
      resourceId: 'change-1',
      action: 'write',
      environment: 'shared',
      signals: { mutating: true, shared_interface: true },
      expiresAt: '2026-12-01T00:00:00.000Z',
      actor,
      idempotencyKey: 'risk-change-1',
    })
    expect(r2).toMatchObject({ risk_tier: 'R2', control: 'specialist_approval' })
    expect(() => context.coordination.recordControlApproval({
      riskEvaluationId: r2.id,
      subjectKind: 'change',
      subjectId: 'change-1',
      artifactSha256: digest,
      decision: 'approved',
      approverProfileId: context.builder.id,
      sessionId: builderActivation.session_id,
      roleActivationId: builderActivation.id,
      approverPrincipalType: 'agent',
      specialistRoleKey: 'builder',
      rationale: 'Self approval.',
      expiresAt: '2026-11-01T00:00:00.000Z',
      actor,
      idempotencyKey: 'self-approval-change-1',
    })).toThrow(/history-based separation/)
    context.coordination.recordControlApproval({
      riskEvaluationId: r2.id,
      subjectKind: 'change',
      subjectId: 'change-1',
      artifactSha256: digest,
      decision: 'approved',
      approverProfileId: context.reviewer.id,
      sessionId: reviewerActivation.session_id,
      roleActivationId: reviewerActivation.id,
      approverPrincipalType: 'agent',
      specialistRoleKey: 'security-reviewer',
      rationale: 'Security review passed.',
      expiresAt: '2026-11-01T00:00:00.000Z',
      actor,
      idempotencyKey: 'specialist-approval-change-1',
    })
    expect(context.coordination.controlStatus({
      organizationId: context.organization.id,
      subjectKind: 'change',
      subjectId: 'change-1',
      artifactSha256: digest,
      control: 'specialist_approval',
    })).toMatchObject({ satisfied: true, valid_approvals: 1 })

    const releaseDigest = 'c'.repeat(64)
    const r3 = context.coordination.assessRisk({
      organizationId: context.organization.id,
      actorProfileId: context.builder.id,
      sessionId: builderActivation.session_id,
      scopeKind: 'team',
      resourceKind: 'release',
      resourceId: 'release-1',
      action: 'publish',
      environment: 'public',
      signals: { mutating: true, public_release: true },
      expiresAt: '2026-12-01T00:00:00.000Z',
      actor,
      idempotencyKey: 'risk-release-1',
    })
    expect(r3).toMatchObject({ risk_tier: 'R3', control: 'two_person' })
    for (const [profile, activation, key] of [
      [context.reviewer, reviewerActivation, 'reviewer'],
      [context.decider, deciderActivation, 'decider'],
    ] as const) {
      context.coordination.recordControlApproval({
        riskEvaluationId: r3.id,
        subjectKind: 'release',
        subjectId: 'release-1',
        artifactSha256: releaseDigest,
        decision: 'approved',
        approverProfileId: profile.id,
        sessionId: activation.session_id,
        roleActivationId: activation.id,
        approverPrincipalType: 'human',
        rationale: `Human ${key} approval.`,
        expiresAt: '2026-11-01T00:00:00.000Z',
        actor,
        idempotencyKey: `release-approval-${key}`,
      })
    }
    expect(context.coordination.controlStatus({
      organizationId: context.organization.id,
      subjectKind: 'release',
      subjectId: 'release-1',
      artifactSha256: releaseDigest,
      control: 'two_person',
    })).toMatchObject({
      satisfied: true,
      required_approvals: 2,
      distinct_profiles: 2,
      distinct_sessions: 2,
    })
    context.db.close()
  })
})

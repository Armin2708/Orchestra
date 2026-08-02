import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { JobAssignmentService } from '../src/agent-os/job-assignments.js'
import { JobMarketService } from '../src/agent-os/job-market.js'
import { OrganizationService } from '../src/agent-os/organization.js'
import {
  AGENT_OS_TEAM_PLANNING_MIGRATION_ID,
  AGENT_OS_TEAM_PLANNING_TABLES,
  installTeamPlanningSchema,
} from '../src/agent-os/team-planning-migration.js'
import {
  PlanningTeamService,
  type ConflictDiscussionAdapter,
} from '../src/agent-os/team-planning.js'
import { teamPlanningPlugin } from '../src/agent-os/team-planning-routes.js'
import { openDb } from '../src/db.js'

const operator = { type: 'operator', id: 'team-test' }
const human = { type: 'human', id: 'product-owner' }

function future(minutes = 60): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

function fixture() {
  const db = openDb(':memory:')
  installTeamPlanningSchema(db)
  db.exec(`CREATE TABLE test_conflict_discussions (
    id TEXT PRIMARY KEY,
    conflict_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL
  )`)
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES (?, 'Team planning')`).run(`/team-planning-${Math.random()}`).lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Collaborative slice', 'Plan and integrate one bounded slice')`)
    .run(boardId).lastInsertRowid)
  const profiles = new AgentProfileService(db)
  const facilitator = profiles.create({
    boardId,
    name: 'Facilitator',
    capabilities: ['typescript'],
    actor: operator,
    idempotencyKey: `profile-facilitator-${boardId}`,
  })
  const implementer = profiles.create({
    boardId,
    name: 'Implementer',
    capabilities: ['typescript'],
    actor: operator,
    idempotencyKey: `profile-implementer-${boardId}`,
  })
  const reviewer = profiles.create({
    boardId,
    name: 'Reviewer',
    capabilities: ['typescript'],
    actor: operator,
    idempotencyKey: `profile-reviewer-${boardId}`,
  })
  const organization = new OrganizationService(db)
  const org = organization.createOrganization({
    boardId,
    key: 'delivery-org',
    name: 'Delivery Org',
    mission: 'Deliver bounded collaborative work.',
    actor: operator,
    idempotencyKey: `org-${boardId}`,
  })
  const canonicalTeam = organization.createTeam({
    organizationId: org.id,
    key: 'delivery-team',
    name: 'Delivery Team',
    mission: 'Own one integrated delivery.',
    actor: operator,
    idempotencyKey: `canonical-team-${boardId}`,
  })
  for (const [index, profile] of [facilitator, implementer, reviewer].entries()) {
    organization.createMembership({
      organizationId: org.id,
      teamId: canonicalTeam.id,
      agentProfileId: profile.id,
      state: 'active',
      reason: 'Explicit planning participant.',
      actor: operator,
      idempotencyKey: `membership-${boardId}-${index}`,
    })
  }
  const market = new JobMarketService(db)
  const before = market.get(cardId)
  const assignment = new JobAssignmentService(db).assign({
    cardId,
    profileId: facilitator.id,
    expectedMarketVersion: before.market_version,
    actor: operator,
    idempotencyKey: `exclusive-assignment-${boardId}`,
  }).assignment
  const discussionAdapter: ConflictDiscussionAdapter = {
    createConflictDiscussion(input) {
      const id = `discussion:${input.conflictId}`
      db.prepare(`INSERT INTO test_conflict_discussions (id, conflict_id, status)
        VALUES (?, ?, 'open')`).run(id, input.conflictId)
      return { id }
    },
    resolveConflictDiscussion(input) {
      db.prepare(`UPDATE test_conflict_discussions SET status='resolved' WHERE id=?`)
        .run(input.discussionId)
    },
  }
  const service = new PlanningTeamService(db, { discussionAdapter })
  const plan = service.createPlan({
    boardId,
    teamId: canonicalTeam.id,
    cardId,
    name: 'Collaborative beta slice',
    purpose: 'Plan, delegate, resolve overlap, and integrate one delivery.',
    participants: [
      { profileId: facilitator.id, roles: ['facilitator', 'synthesizer'] },
      { profileId: implementer.id, roles: ['implementer'] },
      { profileId: reviewer.id, roles: ['reviewer', 'integrator'] },
    ],
    maxRounds: 2,
    deadlineAt: future(),
    completionConditions: { required_artifacts: ['proposal', 'synthesis'] },
    participantBudget: 3,
    wakeBudget: 3,
    tokenBudget: 1_000,
    costBudgetCents: 100,
    actor: operator,
    idempotencyKey: `plan-${boardId}`,
  })
  const members = plan.members as Array<{
    id: string
    agent_profile_id: string
    roles: string[]
  }>
  return {
    db,
    boardId,
    cardId,
    facilitator,
    implementer,
    reviewer,
    canonicalTeam,
    assignment,
    service,
    discussionAdapter,
    plan,
    facilitatorMember: members.find((item) => item.agent_profile_id === facilitator.id)!,
    implementerMember: members.find((item) => item.agent_profile_id === implementer.id)!,
    reviewerMember: members.find((item) => item.agent_profile_id === reviewer.id)!,
  }
}

describe('TEAM-001–020 and JOB-012 bounded collaboration', () => {
  it('installs an additive schema that reuses canonical os_teams identity', () => {
    const db = openDb(':memory:')
    installTeamPlanningSchema(db)
    const tableRows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    const tables = new Set(tableRows.map((row) => row.name))
    for (const table of AGENT_OS_TEAM_PLANNING_TABLES) expect(tables.has(table), table).toBe(true)
    expect(tables.has('os_planning_teams')).toBe(false)
    expect(AGENT_OS_TEAM_PLANNING_MIGRATION_ID).toBe('033-teams-planning-conflicts')
    expect(() => installTeamPlanningSchema(db)).not.toThrow()
    db.close()
  })

  it('freezes one canonical team and exclusive executable assignment while delegating roles', () => {
    const value = fixture()
    const delegated = value.service.delegateWork({
      teamId: String(value.plan.id),
      exclusiveAssignmentId: value.assignment.id,
      assignmentMarketVersion: value.assignment.assigned_market_version,
      memberId: value.implementerMember.id,
      delegatedByMemberId: value.facilitatorMember.id,
      contractRef: `task-contract:${value.cardId}:v1`,
      objective: 'Implement the isolated service slice.',
      criterionIds: ['criterion-service', 'criterion-tests'],
      scopePaths: ['src/agent-os/team-planning.ts'],
      reason: 'Facilitator delegates bounded contract work.',
      actor: operator,
      idempotencyKey: `delegate-${value.boardId}`,
    })
    expect(delegated).toMatchObject({
      exclusive_ownership_preserved: true,
      binding: {
        team_id: value.canonicalTeam.id,
        plan_id: value.plan.id,
        exclusive_assignment_id: value.assignment.id,
        executable_profile_id: value.facilitator.id,
        assignment_version: value.assignment.version,
      },
      delegation: {
        participant_id: value.implementerMember.id,
        delegated_by_participant_id: value.facilitatorMember.id,
      },
    })
    const binding = delegated.binding as Record<string, unknown>
    expect(binding.participant_snapshot).toHaveLength(3)
    expect(binding.role_snapshot).toHaveLength(5)
    expect(value.db.prepare(`SELECT COUNT(*) count FROM job_market_assignments
      WHERE card_id=? AND status='active'`).get(value.cardId)).toEqual({ count: 1 })
    expect(value.db.prepare(`SELECT job_assignment_id, assigned_profile_id
      FROM jobs WHERE card_id=?`).get(value.cardId)).toBeUndefined()
    value.db.close()
  })

  it('enforces facilitator synthesis, digest fanout, budgets, deadlines, and human override', () => {
    const value = fixture()
    expect(() => value.service.recordArtifact({
      teamId: String(value.plan.id),
      authorMemberId: value.reviewerMember.id,
      kind: 'synthesis',
      summary: 'Reviewer tries to synthesize.',
      actor: operator,
      idempotencyKey: `bad-synthesis-${value.boardId}`,
    })).toThrow(/facilitator/)
    const proposal = value.service.recordArtifact({
      teamId: String(value.plan.id),
      authorMemberId: value.implementerMember.id,
      kind: 'proposal',
      summary: 'Implement the bounded schema first.',
      tokenCost: 100,
      actor: operator,
      idempotencyKey: `proposal-${value.boardId}`,
    })
    expect(proposal.accepted).toBe(true)
    const synthesis = value.service.recordArtifact({
      teamId: String(value.plan.id),
      authorMemberId: value.facilitatorMember.id,
      kind: 'synthesis',
      summary: 'Use canonical team identity and preserve exclusive dispatch.',
      sourceArtifactIds: [String(proposal.artifact!.id)],
      tokenCost: 100,
      actor: operator,
      idempotencyKey: `synthesis-${value.boardId}`,
    })
    expect(synthesis.accepted).toBe(true)
    expect(() => value.service.recordArtifact({
      teamId: String(value.plan.id),
      authorMemberId: value.facilitatorMember.id,
      kind: 'digest',
      summary: 'Bounded digest.',
      sourceArtifactIds: [String(proposal.artifact!.id), String(synthesis.artifact!.id)],
      recipientMemberIds: [value.reviewerMember.id],
      wakeCost: 2,
      actor: operator,
      idempotencyKey: `bad-digest-${value.boardId}`,
    })).toThrow(/wake cost/)
    expect(() => value.service.recordHumanOverride({
      teamId: String(value.plan.id),
      reason: 'Operator is not the human decider.',
      scope: { decision: 'destructive' },
      destructiveDecision: true,
      actor: operator,
      idempotencyKey: `bad-override-${value.boardId}`,
    })).toThrow(/human/)
    const override = value.service.recordHumanOverride({
      teamId: String(value.plan.id),
      reason: 'Human narrows a destructive choice to an isolated test database.',
      scope: { decision: 'drop-test-table', bounded_to: ':memory:' },
      destructiveDecision: true,
      expiresAt: future(1),
      actor: human,
      idempotencyKey: `override-${value.boardId}`,
    })
    expect(override).toMatchObject({ actor_type: 'human', destructive_decision: 1 })
    value.db.prepare(`UPDATE os_planning_sessions SET deadline_at='2000-01-01T00:00:00.000Z'
      WHERE plan_id=?`).run(value.plan.id)
    const late = value.service.recordArtifact({
      teamId: String(value.plan.id),
      authorMemberId: value.implementerMember.id,
      kind: 'proposal',
      summary: 'This arrives after the bounded deadline.',
      actor: operator,
      idempotencyKey: `late-${value.boardId}`,
    })
    expect(late).toMatchObject({ accepted: false, escalation_reason: 'planning deadline elapsed' })
    expect(late.session).toMatchObject({ status: 'escalated' })
    value.db.close()
  })

  it('deduplicates conflicts, atomically links discussion, resolves with audit, and stages exact knowledge', () => {
    const value = fixture()
    const conflictInput = {
      teamId: String(value.plan.id),
      kind: 'path' as const,
      severity: 'high' as const,
      summary: 'Implementation and review both touch the route boundary.',
      participantMemberIds: [value.implementerMember.id, value.reviewerMember.id],
      causalJobIds: ['job-implement', 'job-review'],
      affectedResources: [{ kind: 'path', key: 'src/agent-os/team-planning-routes.ts' }],
      detectionEvidence: { detector: 'owned-path-overlap', source_hash: 'a'.repeat(64) },
      actor: operator,
      correlationId: `conflict-correlation-${value.boardId}`,
    }
    const opened = value.service.openConflict({
      ...conflictInput,
      idempotencyKey: `conflict-open-${value.boardId}`,
    })
    const deduped = value.service.openConflict({
      ...conflictInput,
      idempotencyKey: `conflict-dedupe-${value.boardId}`,
    })
    expect(deduped.id).toBe(opened.id)
    expect(value.db.prepare(`SELECT COUNT(*) count FROM test_conflict_discussions`).get())
      .toEqual({ count: 1 })
    expect(opened).toMatchObject({ discussion_id: `discussion:${opened.id}` })
    expect(value.db.prepare(`SELECT COUNT(*) count FROM attention_items
      WHERE kind='team.conflict' AND status='open'`).get()).toEqual({ count: 1 })
    const proposal = value.service.addConflictProposal({
      conflictId: String(opened.id),
      proposedByMemberId: value.implementerMember.id,
      kind: 'serialize',
      summary: 'Implement first; reviewer follows the exact commit.',
      details: { order: [value.implementerMember.id, value.reviewerMember.id] },
      actor: operator,
      idempotencyKey: `conflict-proposal-${value.boardId}`,
    })
    const resolved = value.service.resolveConflict({
      conflictId: String(opened.id),
      proposalId: String(proposal.id),
      rationale: 'Serialization preserves independent review without overlapping writes.',
      followUpActions: [{ owner: value.reviewer.id, action: 'Review the exact implementation commit.' }],
      actor: human,
      idempotencyKey: `conflict-resolve-${value.boardId}`,
    })
    expect(resolved).toMatchObject({ status: 'resolved', resolution: { arbiter_type: 'human' } })
    expect(value.db.prepare(`SELECT status FROM test_conflict_discussions`).get())
      .toEqual({ status: 'resolved' })
    expect(value.db.prepare(`SELECT COUNT(*) count FROM attention_items
      WHERE kind='team.conflict' AND status='resolved'`).get()).toEqual({ count: 1 })
    const candidate = value.service.requestConflictKnowledgePromotion({
      conflictId: String(opened.id),
      summary: 'Serialize implementation and exact-source review on overlapping route files.',
      actor: human,
      idempotencyKey: `conflict-knowledge-${value.boardId}`,
    })
    expect(candidate).toMatchObject({
      status: 'pending_review',
      source_kind: 'conflict_resolution',
      source_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      review_required: true,
    })
    const firstLease = value.service.createWorkLease({
      teamId: String(value.plan.id),
      memberId: value.implementerMember.id,
      resourceKind: 'path',
      resourceKey: 'src/agent-os/team-planning.ts',
      expiresAt: future(),
      actor: operator,
      idempotencyKey: `lease-1-${value.boardId}`,
    })
    const secondLease = value.service.createWorkLease({
      teamId: String(value.plan.id),
      memberId: value.reviewerMember.id,
      resourceKind: 'path',
      resourceKey: 'src/agent-os/team-planning.ts',
      expiresAt: future(),
      actor: operator,
      idempotencyKey: `lease-2-${value.boardId}`,
    })
    expect(firstLease.mode).toBe('advisory')
    expect(secondLease.mode).toBe('advisory')
    expect(() => value.service.createWorkLease({
      teamId: String(value.plan.id),
      memberId: value.implementerMember.id,
      resourceKind: 'path',
      resourceKey: 'enforced-path',
      mode: 'enforced',
      policyRef: 'policy:exclusive-path-v1',
      expiresAt: future(),
      actor: operator,
      idempotencyKey: `bad-enforced-lease-${value.boardId}`,
    })).toThrow(/human/)
    value.db.close()
  })

  it('passes TEAM-GATE with bounded plan, delegation, overlap resolution, and one audited delivery', () => {
    const value = fixture()
    const proposalArtifact = value.service.recordArtifact({
      teamId: String(value.plan.id),
      authorMemberId: value.implementerMember.id,
      kind: 'proposal',
      summary: 'Implement, review, then integrate the accepted report.',
      tokenCost: 80,
      actor: operator,
      idempotencyKey: `gate-proposal-${value.boardId}`,
    })
    value.service.recordArtifact({
      teamId: String(value.plan.id),
      authorMemberId: value.facilitatorMember.id,
      kind: 'synthesis',
      summary: 'Use one exclusive dispatch and explicit internal delegations.',
      sourceArtifactIds: [String(proposalArtifact.artifact!.id)],
      tokenCost: 60,
      actor: operator,
      idempotencyKey: `gate-synthesis-${value.boardId}`,
    })
    value.service.advanceRound({
      teamId: String(value.plan.id),
      completionSatisfied: true,
      reason: 'Required proposal and synthesis exist.',
      actor: operator,
      idempotencyKey: `gate-plan-complete-${value.boardId}`,
    })
    value.service.delegateWork({
      teamId: String(value.plan.id),
      exclusiveAssignmentId: value.assignment.id,
      assignmentMarketVersion: value.assignment.assigned_market_version,
      memberId: value.implementerMember.id,
      delegatedByMemberId: value.facilitatorMember.id,
      contractRef: `task-contract:${value.cardId}:v1`,
      objective: 'Implement the frozen contract.',
      criterionIds: ['criterion-gate'],
      scopePaths: ['src/agent-os/team-planning.ts'],
      reason: 'Bounded implementation slice.',
      actor: operator,
      idempotencyKey: `gate-delegate-${value.boardId}`,
    })
    const conflict = value.service.openConflict({
      teamId: String(value.plan.id),
      kind: 'path',
      severity: 'medium',
      summary: 'Implementation and integration initially overlap.',
      participantMemberIds: [value.implementerMember.id, value.reviewerMember.id],
      causalJobIds: ['job-gate'],
      affectedResources: [{ kind: 'path', key: 'src/agent-os/team-planning.ts' }],
      detectionEvidence: { detector: 'gate-fixture', exact: true },
      actor: operator,
      idempotencyKey: `gate-conflict-${value.boardId}`,
    })
    const resolutionProposal = value.service.addConflictProposal({
      conflictId: String(conflict.id),
      proposedByMemberId: value.reviewerMember.id,
      kind: 'assign_integrator',
      summary: 'Reviewer becomes the explicit integrator after implementation.',
      actor: operator,
      idempotencyKey: `gate-resolution-proposal-${value.boardId}`,
    })
    value.service.resolveConflict({
      conflictId: String(conflict.id),
      proposalId: String(resolutionProposal.id),
      rationale: 'One integration owner serializes assembly and verification.',
      followUpActions: [{ owner: value.reviewer.id, action: 'Integrate and verify the exact report.' }],
      integrationMemberId: value.reviewerMember.id,
      actor: human,
      idempotencyKey: `gate-resolve-${value.boardId}`,
    })
    const deliveryId = `delivery-gate-${value.boardId}`
    const at = new Date().toISOString()
    value.db.prepare(`INSERT INTO delivery_reports
      (id, lineage_id, parent_report_id, sequence, board_id, card_id, status,
       asked_snapshot, created_by, accepted_by, created_at, updated_at, accepted_at)
      VALUES (?, ?, NULL, 1, ?, ?, 'accepted', '{}', 'implementer', 'product-owner', ?, ?, ?)`)
      .run(deliveryId, deliveryId, value.boardId, value.cardId, at, at, at)
    const integrated = value.service.recordIntegratedDelivery({
      teamId: String(value.plan.id),
      integratorMemberId: value.reviewerMember.id,
      deliveryReportId: deliveryId,
      verificationRefs: ['test:team-planning-conflicts', `delivery:${deliveryId}`],
      actor: human,
      idempotencyKey: `gate-integrate-${value.boardId}`,
    })
    expect(integrated).toMatchObject({
      delivery_report_id: deliveryId,
      integrator_participant_id: value.reviewerMember.id,
      conflict_resolution_ids: [expect.any(String)],
      source_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      audited: true,
    })
    expect(value.service.getTeam(String(value.plan.id))).toMatchObject({
      status: 'completed',
      integration: { delivery_report_id: deliveryId },
    })
    expect(value.db.prepare(`SELECT COUNT(*) count FROM job_market_assignments
      WHERE card_id=? AND status='active'`).get(value.cardId)).toEqual({ count: 1 })
    expect(value.db.prepare(`SELECT kind FROM os_events
      WHERE kind='planning_team.delivery_integrated'`).get()).toEqual({
      kind: 'planning_team.delivery_integrated',
    })
    value.db.close()
  })

  it('exposes focused authenticated routes without central registration', async () => {
    const value = fixture()
    const app = Fastify()
    app.addHook('preHandler', async (request) => {
      request.orchestraPrincipal = 'route-owner'
    })
    await app.register(teamPlanningPlugin, {
      prefix: '/api/v1/os',
      db: value.db,
      discussionAdapter: value.discussionAdapter,
      isOperator: (request) => request.headers.authorization === 'Bearer test',
    })
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/os/team-plans/${value.plan.id}/round.advance`,
      headers: { 'idempotency-key': `route-round-denied-${value.boardId}` },
      payload: { completionSatisfied: false },
    })
    expect(denied.statusCode).toBe(403)
    const advanced = await app.inject({
      method: 'POST',
      url: `/api/v1/os/team-plans/${value.plan.id}/round.advance`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': `route-round-${value.boardId}`,
      },
      payload: { completionSatisfied: false },
    })
    expect(advanced.statusCode).toBe(201)
    expect(advanced.json().result).toMatchObject({ current_round: 2, replayed: false })
    const visualization = await app.inject({
      method: 'GET',
      url: `/api/v1/os/boards/${value.boardId}/team-visualization`,
    })
    expect(visualization.statusCode).toBe(200)
    expect(visualization.json().nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: value.plan.id, kind: 'planning_team' }),
    ]))
    await app.close()
    value.db.close()
  })
})

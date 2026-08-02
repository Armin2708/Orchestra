import { describe, expect, it } from 'vitest'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import {
  CanonicalConflictDiscussionAdapter,
  DiscussionAttentionWakeAdapter,
} from '../src/agent-os/collaboration-adapters.js'
import { DiscussionService } from '../src/agent-os/discussions.js'
import { OrganizationService } from '../src/agent-os/organization.js'
import { PlanningTeamService } from '../src/agent-os/team-planning.js'
import { openDb } from '../src/db.js'

const operator = { type: 'operator' as const, id: 'discussion-review' }

function future(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString()
}

function collaborationFixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES (?, 'Discussion adapter review')`)
    .run(`/discussion-adapter-${Math.random()}`).lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Resolve overlap', 'Exercise the composed conflict discussion adapter')`)
    .run(boardId).lastInsertRowid)
  const profiles = new AgentProfileService(db)
  const facilitator = profiles.create({
    boardId,
    name: 'Facilitator',
    capabilities: ['planning'],
    actor: operator,
    idempotencyKey: `facilitator:${boardId}`,
  })
  const reviewer = profiles.create({
    boardId,
    name: 'Reviewer',
    capabilities: ['review'],
    actor: operator,
    idempotencyKey: `reviewer:${boardId}`,
  })
  const organization = new OrganizationService(db)
  const org = organization.createOrganization({
    boardId,
    key: 'review-org',
    name: 'Review Org',
    mission: 'Verify composed collaboration behavior.',
    actor: operator,
    idempotencyKey: `org:${boardId}`,
  })
  const team = organization.createTeam({
    organizationId: org.id,
    key: 'review-team',
    name: 'Review Team',
    mission: 'Resolve one bounded conflict.',
    actor: operator,
    idempotencyKey: `team:${boardId}`,
  })
  for (const [index, profile] of [facilitator, reviewer].entries()) {
    organization.createMembership({
      organizationId: org.id,
      teamId: team.id,
      agentProfileId: profile.id,
      state: 'active',
      reason: 'Explicit conflict participant.',
      actor: operator,
      idempotencyKey: `membership:${boardId}:${index}`,
    })
  }
  const discussions = new DiscussionService(
    db,
    new DiscussionAttentionWakeAdapter(db),
  )
  const planning = new PlanningTeamService(db, {
    discussionAdapter: new CanonicalConflictDiscussionAdapter(discussions),
  })
  const plan = planning.createPlan({
    boardId,
    teamId: team.id,
    cardId,
    name: 'Adapter integration',
    purpose: 'Prove conflict-to-discussion causality.',
    participants: [
      { profileId: facilitator.id, roles: ['facilitator', 'synthesizer'] },
      { profileId: reviewer.id, roles: ['reviewer', 'integrator'] },
    ],
    maxRounds: 2,
    deadlineAt: future(),
    completionConditions: { conflict_resolved: true },
    participantBudget: 2,
    wakeBudget: 2,
    tokenBudget: 1_000,
    costBudgetCents: 100,
    actor: operator,
    idempotencyKey: `plan:${boardId}`,
  })
  const members = plan.members as Array<{ id: string; agent_profile_id: string }>
  return {
    db,
    boardId,
    planning,
    planId: String(plan.id),
    facilitator,
    reviewer,
    facilitatorMemberId: members.find((member) =>
      member.agent_profile_id === facilitator.id)!.id,
    reviewerMemberId: members.find((member) => member.agent_profile_id === reviewer.id)!.id,
  }
}

describe('Discussion independent-review regressions', () => {
  it('composes conflict adapters with real Discussion event causality', async () => {
    const value = collaborationFixture()
    const conflict = value.planning.openConflict({
      teamId: value.planId,
      kind: 'path',
      severity: 'high',
      summary: 'Implementation and review overlap on the same Discussion boundary.',
      participantMemberIds: [value.facilitatorMemberId, value.reviewerMemberId],
      causalJobIds: ['job:implementation', 'job:review'],
      affectedResources: [{ kind: 'path', key: 'src/agent-os/discussions.ts' }],
      detectionEvidence: { detector: 'review-regression', exact: true },
      actor: operator,
      correlationId: `correlation:${value.boardId}`,
      idempotencyKey: `conflict:open:${value.boardId}`,
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const created = value.db.prepare(`SELECT id, causation_id FROM os_discussion_events
      WHERE discussion_id=? AND event_type='discussion.created'`).get(conflict.discussion_id) as
      { id: string; causation_id: string | null }
    expect(created.causation_id).toBeNull()
    expect(value.db.prepare(`SELECT COUNT(*) AS count FROM attention_items
      WHERE kind LIKE 'discussion.wake:%'`).get()).toEqual({ count: 2 })

    const proposal = value.planning.addConflictProposal({
      conflictId: String(conflict.id),
      proposedByMemberId: value.reviewerMemberId,
      kind: 'serialize',
      summary: 'Serialize implementation before independent review.',
      actor: operator,
      idempotencyKey: `conflict:proposal:${value.boardId}`,
    })
    value.planning.resolveConflict({
      conflictId: String(conflict.id),
      proposalId: String(proposal.id),
      rationale: 'The reviewer follows the exact implementation commit.',
      followUpActions: [{ owner: value.reviewer.id, action: 'Review the exact commit.' }],
      actor: { type: 'human', id: 'product-owner' },
      idempotencyKey: `conflict:resolve:${value.boardId}`,
    })
    const resolved = value.db.prepare(`SELECT id, causation_id FROM os_discussion_events
      WHERE discussion_id=? AND event_type='discussion.state.changed'`).get(conflict.discussion_id) as
      { id: string; causation_id: string | null }
    expect(resolved.causation_id).toBe(created.id)
    expect(value.db.prepare(`SELECT COUNT(*) AS count FROM os_discussion_events cause
      JOIN os_discussion_events effect ON effect.causation_id=cause.id
      WHERE effect.id=? AND effect.discussion_id=cause.discussion_id`).get(resolved.id))
      .toEqual({ count: 1 })
    value.db.close()
  })

  it('freezes accepted answers and rejects tampered acceptance evidence at review', async () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES (?, 'Exact-source review')`).run(`/exact-source-${Math.random()}`).lastInsertRowid)
    const profiles = new AgentProfileService(db)
    const answerer = profiles.create({
      boardId,
      name: 'Answerer',
      capabilities: ['discussion'],
      actor: operator,
      idempotencyKey: `answerer:${boardId}`,
    })
    const service = new DiscussionService(db)
    const question = service.createDiscussion({
      boardId,
      type: 'question',
      title: 'What exact source may become Knowledge?',
      body: 'Only the reviewed accepted answer.',
      actor: operator,
      idempotencyKey: `question:${boardId}`,
    })
    const answer = service.addPost({
      discussionId: question.discussion.id,
      parentPostId: question.posts[0].id,
      kind: 'answer',
      body: 'Freeze this exact answer after acceptance.',
      actor: { type: 'agent', id: answerer.id, profileId: answerer.id },
      idempotencyKey: `answer:${boardId}`,
    })
    service.acceptAnswer({
      discussionId: question.discussion.id,
      postId: answer.id,
      actor: operator,
      idempotencyKey: `accept:${boardId}`,
    })
    expect(() => service.editPost({
      discussionId: question.discussion.id,
      postId: answer.id,
      body: 'Attempt to replace the accepted exact source.',
      expectedVersion: answer.version,
      actor: { type: 'agent', id: answerer.id, profileId: answerer.id },
      idempotencyKey: `edit:${boardId}`,
    })).toThrow(/accepted answer is immutable/)
    const promotion = service.requestPromotion({
      discussionId: question.discussion.id,
      postId: answer.id,
      actor: { type: 'operator', id: 'promotion-requester' },
      idempotencyKey: `promotion:${boardId}`,
    })
    db.prepare(`UPDATE os_discussion_events SET payload_json=? WHERE id=?`).run(
      JSON.stringify({ post_id: answer.id, content_sha256: '0'.repeat(64) }),
      promotion.acceptance_event_id,
    )
    await expect(service.reviewPromotion({
      promotionId: promotion.id,
      decision: 'approve',
      note: 'Independent reviewer checks the captured source.',
      actor: { type: 'operator', id: 'promotion-reviewer' },
      idempotencyKey: `promotion-review:${boardId}`,
    })).rejects.toThrow(/accepted answer evidence does not match the exact source/)
    expect(service.promotions(boardId)).toEqual([
      expect.objectContaining({ id: promotion.id, status: 'pending_review' }),
    ])
    db.close()
  })
})

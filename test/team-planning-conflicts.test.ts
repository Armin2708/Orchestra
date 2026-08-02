import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { JobAssignmentService } from '../src/agent-os/job-assignments.js'
import { JobMarketService } from '../src/agent-os/job-market.js'
import { OrganizationService } from '../src/agent-os/organization.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import { CanonicalConflictKnowledgeAdapter } from '../src/agent-os/team-conflict-knowledge.js'
import { canonicalKnowledgeJson } from '../src/agent-os/knowledge-contracts.js'
import { AGENT_OS_TEAM_COLLABORATION_REVIEW_MIGRATION_ID } from '../src/agent-os/team-collaboration-review-migration.js'
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

function fixture(options: { canonicalKnowledge?: boolean; projectPath?: string } = {}) {
  const db = openDb(':memory:')
  installTeamPlanningSchema(db)
  db.exec(`CREATE TABLE test_conflict_discussions (
    id TEXT PRIMARY KEY,
    conflict_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL
  )`)
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES (?, 'Team planning')`)
    .run(options.projectPath ?? `/team-planning-${Math.random()}`).lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Collaborative slice', 'Plan and integrate one bounded slice')`)
    .run(boardId).lastInsertRowid)
  const workspaceId = `team-planning-workspace-${boardId}`
  db.prepare(`INSERT INTO workspaces
    (id, board_id, card_id, name, kind, root_path, base_ref, status)
    VALUES (?, ?, ?, ?, 'shared', ?, 'HEAD', 'active')`)
    .run(workspaceId, boardId, cardId, workspaceId, `/tmp/${workspaceId}`)
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
    workspaceId,
    expectedMarketVersion: before.market_version,
    actor: operator,
    idempotencyKey: `exclusive-assignment-${boardId}`,
  }).assignment
  const job = new JobScheduler(db).create({
    boardId,
    cardId,
    workspaceId,
    provider: 'claude',
    jobAssignment: {
      jobAssignmentId: assignment.id,
      assignedProfileId: assignment.profile_id,
      assignmentMarketVersion: assignment.assigned_market_version,
    },
  })
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
  const service = new PlanningTeamService(db, {
    discussionAdapter,
    conflictKnowledgeAdapter: options.canonicalKnowledge
      ? new CanonicalConflictKnowledgeAdapter(db)
      : null,
  })
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
    job,
    workspaceId,
    service,
    discussionAdapter,
    plan,
    facilitatorMember: members.find((item) => item.agent_profile_id === facilitator.id)!,
    implementerMember: members.find((item) => item.agent_profile_id === implementer.id)!,
    reviewerMember: members.find((item) => item.agent_profile_id === reviewer.id)!,
  }
}

function createRepository(): { root: string; head: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'agentboard-conflict-knowledge-'))
  execFileSync('git', ['init', '--quiet', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'knowledge-review@example.test'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Knowledge Reviewer'])
  writeFileSync(path.join(root, 'README.md'), '# Exact conflict evidence\n', 'utf8')
  execFileSync('git', ['-C', root, 'add', 'README.md'])
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture'])
  return {
    root,
    head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function resolveConflictFixture(
  value: ReturnType<typeof fixture>,
  suffix: string,
  resourceKey = `src/agent-os/team-planning-${suffix}.ts`,
) {
  const conflict = value.service.openConflict({
    teamId: String(value.plan.id),
    kind: 'path',
    severity: 'medium',
    summary: `Exact overlap ${suffix}`,
    participantMemberIds: [value.implementerMember.id, value.reviewerMember.id],
    causalJobIds: [value.job.id],
    affectedResources: [{ kind: 'path', key: resourceKey }],
    detectionEvidence: { detector: 'review-fixture', suffix },
    actor: operator,
    idempotencyKey: `review-conflict-${value.boardId}-${suffix}`,
  })
  const proposal = value.service.addConflictProposal({
    conflictId: String(conflict.id),
    proposedByMemberId: value.implementerMember.id,
    kind: 'serialize',
    summary: `Serialize ${suffix}`,
    details: { order: ['implementation', 'review'] },
    actor: operator,
    idempotencyKey: `review-proposal-${value.boardId}-${suffix}`,
  })
  value.service.resolveConflict({
    conflictId: String(conflict.id),
    proposalId: String(proposal.id),
    rationale: `Retain exact causal evidence for ${suffix}.`,
    followUpActions: [{ owner: value.reviewer.id, action: 'Review the exact resolution.' }],
    actor: human,
    idempotencyKey: `review-resolution-${value.boardId}-${suffix}`,
  })
  return conflict
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
    expect(AGENT_OS_TEAM_COLLABORATION_REVIEW_MIGRATION_ID).toBe('034-team-collaboration-review')
    expect(db.prepare(`SELECT 1 AS present FROM os_schema_migrations WHERE id=?`)
      .get(AGENT_OS_TEAM_COLLABORATION_REVIEW_MIGRATION_ID)).toEqual({ present: 1 })
    expect((db.prepare(`PRAGMA table_info(os_team_delegations)`).all() as Array<{ name: string }>)
      .map((column) => column.name)).toEqual(expect.arrayContaining([
      'job_id', 'version', 'updated_at', 'cancelled_at', 'transition_reason',
    ]))
    expect(() => installTeamPlanningSchema(db)).not.toThrow()
    db.close()
  })

  it('freezes one canonical team and exclusive executable assignment while delegating roles', () => {
    const value = fixture()
    const delegated = value.service.delegateWork({
      teamId: String(value.plan.id),
      exclusiveAssignmentId: value.assignment.id,
      assignmentMarketVersion: value.assignment.assigned_market_version,
      jobId: value.job.id,
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
      FROM jobs WHERE card_id=?`).get(value.cardId)).toEqual({
        job_assignment_id: value.assignment.id,
        assigned_profile_id: value.facilitator.id,
      })
    value.db.close()
  })

  it('links delegation to one existing executable job and owns only its internal lifecycle', () => {
    const value = fixture()
    const jobsBefore = value.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()
    const sessionsBefore = value.db.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get()
    const delegated = value.service.delegateWork({
      teamId: String(value.plan.id),
      exclusiveAssignmentId: value.assignment.id,
      assignmentMarketVersion: value.assignment.assigned_market_version,
      jobId: value.job.id,
      memberId: value.implementerMember.id,
      delegatedByMemberId: value.facilitatorMember.id,
      contractRef: `task-contract:${value.cardId}:v1`,
      objective: 'Accept and complete one existing executable job.',
      criterionIds: ['criterion-existing-job'],
      scopePaths: ['src/agent-os/team-planning.ts'],
      reason: 'Internal responsibility without a second executable owner.',
      actor: operator,
      idempotencyKey: `lifecycle-delegate-${value.boardId}`,
    })
    const delegation = delegated.delegation as Record<string, unknown>
    const acceptedInput = {
      teamId: String(value.plan.id),
      delegationId: String(delegation.id),
      memberId: value.implementerMember.id,
      transition: 'accept' as const,
      expectedVersion: 1,
      reason: 'Assignee accepts the bounded internal responsibility.',
      actor: operator,
      idempotencyKey: `lifecycle-accept-${value.boardId}`,
    }
    expect(value.service.transitionDelegation(acceptedInput)).toMatchObject({
      delegation: { status: 'accepted', version: 2, job_id: value.job.id },
      canonical_job_id: value.job.id,
      exclusive_assignment_id: value.assignment.id,
      exclusive_ownership_preserved: true,
      replayed: false,
    })
    expect(value.service.transitionDelegation(acceptedInput)).toMatchObject({ replayed: true })
    value.db.prepare(`UPDATE jobs SET status='running', attempts=1, started_at=datetime('now')
      WHERE id=?`).run(value.job.id)
    expect(value.service.transitionDelegation({
      ...acceptedInput,
      transition: 'complete',
      expectedVersion: 2,
      reason: 'Assignee completes the delegated slice against the same running job.',
      idempotencyKey: `lifecycle-complete-${value.boardId}`,
    })).toMatchObject({ delegation: { status: 'completed', version: 3, job_id: value.job.id } })
    const cancellable = value.service.delegateWork({
      teamId: String(value.plan.id),
      exclusiveAssignmentId: value.assignment.id,
      assignmentMarketVersion: value.assignment.assigned_market_version,
      jobId: value.job.id,
      memberId: value.reviewerMember.id,
      delegatedByMemberId: value.facilitatorMember.id,
      contractRef: `task-contract:${value.cardId}:v1`,
      objective: 'Cancel a second bounded review responsibility.',
      criterionIds: ['criterion-cancel'],
      scopePaths: ['test/team-planning-conflicts.test.ts'],
      reason: 'Exercise the explicit cancellation lifecycle.',
      actor: operator,
      idempotencyKey: `lifecycle-cancellable-${value.boardId}`,
    }).delegation as Record<string, unknown>
    expect(value.service.transitionDelegation({
      teamId: String(value.plan.id),
      delegationId: String(cancellable.id),
      memberId: value.facilitatorMember.id,
      transition: 'cancel',
      expectedVersion: 1,
      reason: 'Facilitator cancels the internal review responsibility.',
      actor: operator,
      idempotencyKey: `lifecycle-cancel-${value.boardId}`,
    })).toMatchObject({ delegation: { status: 'cancelled', version: 2, job_id: value.job.id } })
    expect(value.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual(jobsBefore)
    expect(value.db.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get()).toEqual(sessionsBefore)
    expect(value.db.prepare(`SELECT COUNT(*) AS count FROM job_market_assignments
      WHERE board_id=? AND card_id=? AND status='active'`).get(value.boardId, value.cardId))
      .toEqual({ count: 1 })
    expect(() => value.service.delegateWork({
      teamId: String(value.plan.id),
      exclusiveAssignmentId: value.assignment.id,
      assignmentMarketVersion: value.assignment.assigned_market_version,
      jobId: 'job-that-does-not-exist',
      memberId: value.reviewerMember.id,
      delegatedByMemberId: value.facilitatorMember.id,
      contractRef: `task-contract:${value.cardId}:v1`,
      objective: 'This must not mint an executable job.',
      criterionIds: ['criterion-invalid-job'],
      scopePaths: ['src/agent-os/team-planning.ts'],
      reason: 'Invalid canonical identity fixture.',
      actor: operator,
      idempotencyKey: `lifecycle-invalid-${value.boardId}`,
    })).toThrow(/reference the executable job/)
    value.db.close()
  })

  it('validates causal job and affected resource identities before conflict persistence', () => {
    const value = fixture()
    const base = {
      teamId: String(value.plan.id),
      kind: 'path' as const,
      severity: 'medium' as const,
      summary: 'Validate canonical conflict scope.',
      participantMemberIds: [value.implementerMember.id, value.reviewerMember.id],
      causalJobIds: [value.job.id],
      detectionEvidence: { detector: 'scope-validator' },
      actor: operator,
    }
    expect(() => value.service.openConflict({
      ...base,
      causalJobIds: ['missing-causal-job'],
      affectedResources: [{ kind: 'path', key: 'src/agent-os/team-planning.ts' }],
      idempotencyKey: `invalid-causal-${value.boardId}`,
    })).toThrow(/canonical assignment in plan scope/)
    expect(() => value.service.openConflict({
      ...base,
      affectedResources: [{ kind: 'path', key: '../outside.ts' }],
      idempotencyKey: `invalid-path-${value.boardId}`,
    })).toThrow(/repository-relative identity/)
    expect(() => value.service.openConflict({
      ...base,
      affectedResources: [{ kind: 'unsupported', key: 'anything' }] as never,
      idempotencyKey: `invalid-resource-kind-${value.boardId}`,
    })).toThrow(/affected resource kind/)
    expect(value.db.prepare('SELECT COUNT(*) AS count FROM os_conflicts').get()).toEqual({ count: 0 })
    const opened = value.service.openConflict({
      ...base,
      affectedResources: [
        { kind: 'workspace', key: value.workspaceId },
        { kind: 'card', key: String(value.cardId) },
        { kind: 'job', key: value.job.id },
        { kind: 'assignment', key: value.assignment.id },
        { kind: 'branch', key: 'codex/beta-collaboration' },
        { kind: 'path', key: 'src/agent-os/team-planning.ts' },
      ],
      idempotencyKey: `valid-resource-scope-${value.boardId}`,
    })
    expect(opened.causal_job_ids).toEqual([value.job.id])
    expect(opened.affected_resources).toHaveLength(6)
    expect(value.db.prepare('SELECT COUNT(*) AS count FROM os_conflicts').get()).toEqual({ count: 1 })
    value.db.close()
  })

  it('requires independent review and promotes only exact conflict evidence into canonical Knowledge', () => {
    const repository = createRepository()
    const value = fixture({ canonicalKnowledge: true, projectPath: repository.root })
    try {
      const rejectedConflict = resolveConflictFixture(value, 'reject')
      const rejectedCandidate = value.service.requestConflictKnowledgePromotion({
        conflictId: String(rejectedConflict.id),
        summary: 'Arbitrary prose must remain review metadata, never source content.',
        actor: human,
        idempotencyKey: `candidate-reject-${value.boardId}`,
      })
      expect(() => value.service.reviewConflictKnowledgeCandidate({
        candidateId: String(rejectedCandidate.id),
        decision: 'reject',
        reason: 'Requester cannot self-review.',
        actor: human,
        idempotencyKey: `candidate-self-review-${value.boardId}`,
      })).toThrow(/independent/)
      const rejectInput = {
        candidateId: String(rejectedCandidate.id),
        decision: 'reject' as const,
        reason: 'Exact evidence is valid but not reusable beyond this incident.',
        actor: { type: 'human' as const, id: 'knowledge-reviewer' },
        idempotencyKey: `candidate-independent-reject-${value.boardId}`,
      }
      expect(value.service.reviewConflictKnowledgeCandidate(rejectInput)).toMatchObject({
        status: 'rejected',
        reviewed_by_id: 'knowledge-reviewer',
        knowledge_source_id: null,
        independently_reviewed: true,
        replayed: false,
      })
      expect(value.service.reviewConflictKnowledgeCandidate(rejectInput))
        .toMatchObject({ status: 'rejected', replayed: true })

      const acceptedConflict = resolveConflictFixture(value, 'accept')
      const acceptedCandidate = value.service.requestConflictKnowledgePromotion({
        conflictId: String(acceptedConflict.id),
        summary: 'UNTRUSTED CANDIDATE SUMMARY MUST NOT ENTER CHUNK CONTENT',
        actor: human,
        idempotencyKey: `candidate-accept-${value.boardId}`,
      })
      expect(() => value.db.prepare(`UPDATE os_conflict_knowledge_candidates
        SET status='accepted' WHERE id=?`).run(acceptedCandidate.id)).toThrow(/review transition/)
      const accepted = value.service.reviewConflictKnowledgeCandidate({
        candidateId: String(acceptedCandidate.id),
        decision: 'accept',
        reason: 'Independent reviewer verified exact resolution provenance.',
        actor: { type: 'human', id: 'knowledge-reviewer' },
        idempotencyKey: `candidate-independent-accept-${value.boardId}`,
      })
      expect(accepted).toMatchObject({
        status: 'accepted',
        source_sha256: acceptedCandidate.source_sha256,
        reviewed_by_id: 'knowledge-reviewer',
        knowledge_source_id: expect.stringMatching(/^ks_[a-f0-9]{64}$/),
        repository_head_sha: repository.head,
        independently_reviewed: true,
      })
      const source = value.db.prepare(`SELECT * FROM knowledge_sources
        WHERE board_id=? AND id=?`).get(value.boardId, accepted.knowledge_source_id) as
        Record<string, unknown>
      const chunk = value.db.prepare(`SELECT * FROM knowledge_chunks
        WHERE board_id=? AND source_id=?`).get(value.boardId, accepted.knowledge_source_id) as
        Record<string, unknown>
      expect(source).toMatchObject({
        source_kind: 'decision',
        source_revision: acceptedCandidate.source_sha256,
        content_sha256: acceptedCandidate.source_sha256,
        freshness_policy: 'manual_until_superseded',
      })
      expect(JSON.parse(String(source.provenance_json))).toMatchObject({
        base_commit_sha: repository.head,
        adapter_id: 'conflict-resolution-promotion',
      })
      expect(chunk.content).toBe(canonicalKnowledgeJson(
        accepted.exact_source as Record<string, unknown>,
      ))
      expect(String(chunk.content)).not.toContain('UNTRUSTED CANDIDATE SUMMARY')
      expect(value.service.getTeam(String(value.plan.id))).toMatchObject({
        conflicts: expect.arrayContaining([
          expect.objectContaining({
            id: acceptedConflict.id,
            knowledge_candidates: [expect.objectContaining({
              id: acceptedCandidate.id,
              status: 'accepted',
              knowledge_source_id: accepted.knowledge_source_id,
            })],
          }),
        ]),
      })
    } finally {
      value.db.close()
      repository.cleanup()
    }
  })

  it('rejects a conflict Knowledge request from the exact profile that arbitrated resolution', () => {
    const value = fixture()
    const conflict = value.service.openConflict({
      teamId: String(value.plan.id),
      kind: 'path',
      severity: 'medium',
      summary: 'Reviewer arbitrates an overlap.',
      participantMemberIds: [value.implementerMember.id, value.reviewerMember.id],
      causalJobIds: [value.job.id],
      affectedResources: [{ kind: 'path', key: 'src/agent-os/team-planning.ts' }],
      detectionEvidence: { detector: 'arbiter-independence' },
      actor: operator,
      idempotencyKey: `arbiter-conflict-${value.boardId}`,
    })
    const proposal = value.service.addConflictProposal({
      conflictId: String(conflict.id),
      proposedByMemberId: value.implementerMember.id,
      kind: 'serialize',
      summary: 'Serialize exact changes.',
      actor: operator,
      idempotencyKey: `arbiter-proposal-${value.boardId}`,
    })
    value.service.resolveConflict({
      conflictId: String(conflict.id),
      proposalId: String(proposal.id),
      arbiterMemberId: value.reviewerMember.id,
      rationale: 'Reviewer arbitrates the exact ordering.',
      followUpActions: [],
      actor: { type: 'agent', id: value.reviewer.id },
      idempotencyKey: `arbiter-resolution-${value.boardId}`,
    })
    expect(() => value.service.requestConflictKnowledgePromotion({
      conflictId: String(conflict.id),
      summary: 'The arbiter must not request its own promotion candidate.',
      actor: { type: 'agent', id: value.reviewer.id },
      idempotencyKey: `arbiter-candidate-${value.boardId}`,
    })).toThrow(/differ from the resolution arbiter/)
    expect(value.db.prepare(`SELECT COUNT(*) AS count FROM os_conflict_knowledge_candidates`).get())
      .toEqual({ count: 0 })
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
      causalJobIds: [value.job.id],
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
      jobId: value.job.id,
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
      causalJobIds: [value.job.id],
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

  it('scopes agent team commands to the exact explicit participant and preserves human override', async () => {
    const value = fixture()
    const app = Fastify()
    app.addHook('preHandler', async (request) => {
      request.orchestraPrincipal = 'agent'
    })
    await app.register(teamPlanningPlugin, {
      prefix: '/api/v1/os',
      db: value.db,
      discussionAdapter: value.discussionAdapter,
      isOperator: () => false,
      resolveAgentPrincipal: (request) => request.headers['x-test-profile'] === value.implementer.id
        ? {
            agentId: 42,
            boardId: value.boardId,
            profileId: value.implementer.id,
            provider: 'codex',
            providerSessionId: 'provider-session-42',
            sessionId: 'canonical-session-42',
            jobId: value.job.id,
            jobAssignmentId: value.assignment.id,
            assignmentMarketVersion: value.assignment.assigned_market_version,
          }
        : null,
    })
    const url = `/api/v1/os/team-plans/${value.plan.id}/artifact.record`
    const sharedOnly = await app.inject({
      method: 'POST',
      url,
      headers: { 'idempotency-key': `team-agent-shared-${value.boardId}` },
      payload: {
        authorMemberId: value.implementerMember.id,
        kind: 'proposal',
        summary: 'A shared bearer is not mutation identity.',
      },
    })
    expect(sharedOnly.statusCode).toBe(403)

    const exact = await app.inject({
      method: 'POST',
      url,
      headers: {
        'x-test-profile': value.implementer.id,
        'idempotency-key': `team-agent-exact-${value.boardId}`,
      },
      payload: {
        authorMemberId: value.implementerMember.id,
        kind: 'proposal',
        summary: 'The exact explicit participant records its own artifact.',
      },
    })
    expect(exact.statusCode, exact.body).toBe(201)
    expect(value.db.prepare(`SELECT actor_type, actor_id FROM os_events
      WHERE idempotency_key=?`).get(`team:team-agent-exact-${value.boardId}`)).toEqual({
      actor_type: 'agent',
      actor_id: value.implementer.id,
    })

    const impersonation = await app.inject({
      method: 'POST',
      url,
      headers: {
        'x-test-profile': value.implementer.id,
        'idempotency-key': `team-agent-impersonation-${value.boardId}`,
      },
      payload: {
        authorMemberId: value.reviewerMember.id,
        kind: 'critique',
        summary: 'An implementer must not impersonate the reviewer.',
      },
    })
    expect(impersonation.statusCode).toBe(403)

    const humanOverride = await app.inject({
      method: 'POST',
      url: `/api/v1/os/team-plans/${value.plan.id}/override.record`,
      headers: {
        'x-test-profile': value.implementer.id,
        'idempotency-key': `team-agent-override-${value.boardId}`,
      },
      payload: { reason: 'Agents cannot grant themselves a human override.', scope: {} },
    })
    expect(humanOverride.statusCode).toBe(403)
    await app.close()
    value.db.close()
  })

  it('composes an exact participant request with distinct operator review and promotion', async () => {
    const repository = createRepository()
    const value = fixture({ canonicalKnowledge: true, projectPath: repository.root })
    const conflict = resolveConflictFixture(value, 'route-agent-request')
    const app = Fastify()
    app.addHook('preHandler', async (request) => {
      request.orchestraPrincipal = request.headers.authorization === 'Bearer test'
        ? 'knowledge-reviewer'
        : 'agent'
    })
    await app.register(teamPlanningPlugin, {
      prefix: '/api/v1/os',
      db: value.db,
      discussionAdapter: value.discussionAdapter,
      isOperator: (request) => request.headers.authorization === 'Bearer test',
      resolveAgentPrincipal: (request) => {
        const profileId = request.headers['x-test-profile']
        if (profileId !== value.implementer.id && profileId !== value.facilitator.id) return null
        return {
          agentId: profileId === value.implementer.id ? 42 : 43,
          boardId: value.boardId,
          profileId,
          provider: 'codex',
          providerSessionId: `provider-${profileId}`,
          sessionId: `session-${profileId}`,
          jobId: value.job.id,
          jobAssignmentId: value.assignment.id,
          assignmentMarketVersion: value.assignment.assigned_market_version,
        }
      },
    })
    try {
      const requestUrl = `/api/v1/os/team-conflicts/${conflict.id}/knowledge-candidates`
      const outsideConflict = await app.inject({
        method: 'POST',
        url: requestUrl,
        headers: {
          'x-test-profile': value.facilitator.id,
          'idempotency-key': `route-candidate-outside-${value.boardId}`,
        },
        payload: { summary: 'A plan participant outside this conflict cannot request promotion.' },
      })
      expect(outsideConflict.statusCode).toBe(403)

      const requested = await app.inject({
        method: 'POST',
        url: requestUrl,
        headers: {
          'x-test-profile': value.implementer.id,
          'idempotency-key': `route-candidate-agent-${value.boardId}`,
        },
        payload: { summary: 'Request exact conflict evidence for independent human review.' },
      })
      expect(requested.statusCode, requested.body).toBe(201)
      expect(requested.json().result).toMatchObject({
        status: 'pending_review',
        requested_by_type: 'agent',
        requested_by_id: value.implementer.id,
        review_required: true,
      })
      const candidateId = String(requested.json().result.id)

      const agentReview = await app.inject({
        method: 'POST',
        url: `/api/v1/os/team-conflict-knowledge-candidates/${candidateId}/review`,
        headers: {
          'x-test-profile': value.implementer.id,
          'idempotency-key': `route-candidate-agent-review-${value.boardId}`,
        },
        payload: { decision: 'accept', reason: 'Agents cannot review their candidates.' },
      })
      expect(agentReview.statusCode).toBe(403)

      const reviewed = await app.inject({
        method: 'POST',
        url: `/api/v1/os/team-conflict-knowledge-candidates/${candidateId}/review`,
        headers: {
          authorization: 'Bearer test',
          'idempotency-key': `route-candidate-human-review-${value.boardId}`,
        },
        payload: {
          decision: 'accept',
          reason: 'Distinct human reviewer verified the exact source and provenance.',
        },
      })
      expect(reviewed.statusCode, reviewed.body).toBe(201)
      expect(reviewed.json().result).toMatchObject({
        id: candidateId,
        status: 'accepted',
        requested_by_id: value.implementer.id,
        reviewed_by_type: 'human',
        reviewed_by_id: 'knowledge-reviewer',
        knowledge_source_id: expect.stringMatching(/^ks_[a-f0-9]{64}$/),
        independently_reviewed: true,
      })
      expect(value.db.prepare(`SELECT source_kind FROM knowledge_sources
        WHERE board_id=? AND id=?`).get(
        value.boardId,
        reviewed.json().result.knowledge_source_id,
      )).toEqual({ source_kind: 'decision' })
    } finally {
      await app.close()
      value.db.close()
      repository.cleanup()
    }
  })
})

import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { AttentionService } from './attention.js'
import type { ActorIdentity } from './agent-home-support.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { parseJson, timestamp } from './json.js'

export const PLANNING_TEAM_ROLES = Object.freeze([
  'facilitator',
  'researcher',
  'implementer',
  'reviewer',
  'integrator',
  'synthesizer',
] as const)
export type PlanningTeamRole = typeof PLANNING_TEAM_ROLES[number]

export const PLANNING_ARTIFACT_KINDS = Object.freeze([
  'proposal', 'critique', 'position', 'synthesis', 'digest', 'plan',
] as const)
export type PlanningArtifactKind = typeof PLANNING_ARTIFACT_KINDS[number]

export const CONFLICT_KINDS = Object.freeze([
  'path', 'branch', 'dependency', 'resource', 'decision',
] as const)
export type CanonicalConflictKind = typeof CONFLICT_KINDS[number]

export const CONFLICT_PROPOSAL_KINDS = Object.freeze([
  'split_ownership', 'rebase', 'handoff', 'serialize', 'merge', 'assign_integrator',
] as const)
export type ConflictProposalKind = typeof CONFLICT_PROPOSAL_KINDS[number]

export const CONFLICT_RESOURCE_KINDS = Object.freeze([
  'path', 'branch', 'workspace', 'card', 'job', 'assignment',
] as const)
export type ConflictResourceKind = typeof CONFLICT_RESOURCE_KINDS[number]

export interface ConflictDiscussionAdapter {
  createConflictDiscussion(input: {
    boardId: number
    teamId: string
    conflictId: string
    title: string
    participantProfileIds: string[]
    idempotencyKey: string
    correlationId?: string | null
  }): { id: string }
  resolveConflictDiscussion?(input: {
    discussionId: string
    conflictId: string
    resolutionId: string
    summary: string
    idempotencyKey: string
  }): void
}

export interface ConflictKnowledgePromotionAdapter {
  promoteConflictResolution(input: {
    boardId: number
    cardId: number | null
    conflictId: string
    resolutionId: string
    title: string
    exactSource: Record<string, unknown>
    sourceSha256: string
    reviewedAt: string
  }): { sourceId: string; chunkId: string; repositoryHeadSha: string }
}

export interface PlanningParticipantInput {
  profileId: string
  roles: PlanningTeamRole[]
  scope?: Record<string, unknown>
}

export interface CreatePlanningTeamInput {
  boardId: number
  teamId: string
  cardId?: number | null
  name: string
  purpose: string
  participants: PlanningParticipantInput[]
  maxRounds: number
  deadlineAt: string
  completionConditions: Record<string, unknown>
  participantBudget: number
  wakeBudget: number
  tokenBudget: number
  costBudgetCents: number
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface RecordPlanningArtifactInput {
  teamId: string
  authorMemberId: string
  kind: PlanningArtifactKind
  summary: string
  content?: Record<string, unknown>
  sourceArtifactIds?: string[]
  recipientMemberIds?: string[]
  wakeCost?: number
  tokenCost?: number
  costCents?: number
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface PlanningArtifactCommandResult {
  accepted: boolean
  artifact: Record<string, unknown> | null
  session: Record<string, unknown>
  escalation_reason: string | null
  replayed: boolean
}

export interface DelegateTeamWorkInput {
  teamId: string
  exclusiveAssignmentId: string
  assignmentMarketVersion: number
  jobId: string
  memberId: string
  delegatedByMemberId: string
  contractRef: string
  objective: string
  criterionIds: string[]
  scopePaths: string[]
  reason: string
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface TransitionTeamDelegationInput {
  teamId: string
  delegationId: string
  memberId: string
  transition: 'accept' | 'complete' | 'cancel'
  expectedVersion: number
  reason: string
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface OpenConflictInput {
  teamId: string
  kind: CanonicalConflictKind
  severity: 'low' | 'medium' | 'high' | 'critical'
  summary: string
  participantMemberIds: string[]
  causalJobIds: string[]
  affectedResources: Array<{ kind: ConflictResourceKind; key: string }>
  detectionEvidence: Record<string, unknown>
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface AddConflictProposalInput {
  conflictId: string
  proposedByMemberId: string
  kind: ConflictProposalKind
  summary: string
  details?: Record<string, unknown>
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface ResolveConflictInput {
  conflictId: string
  proposalId: string
  arbiterMemberId?: string | null
  rationale: string
  followUpActions: Array<{ owner: string; action: string; due_at?: string }>
  integrationMemberId?: string | null
  humanOverrideId?: string | null
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

interface PlanningTeamServiceOptions {
  discussionAdapter?: ConflictDiscussionAdapter | null
  conflictKnowledgeAdapter?: ConflictKnowledgePromotionAdapter | null
  events?: EventStore
  attention?: AttentionService
}

interface CommandResult<T> {
  result: T
  replayed: boolean
}

export class PlanningTeamService {
  private readonly events: EventStore
  private readonly attention: AttentionService
  private readonly discussionAdapter: ConflictDiscussionAdapter | null
  private readonly conflictKnowledgeAdapter: ConflictKnowledgePromotionAdapter | null

  constructor(
    private readonly db: Database.Database,
    options: PlanningTeamServiceOptions = {},
  ) {
    this.events = options.events ?? new EventStore(db)
    this.attention = options.attention ?? new AttentionService(db)
    this.discussionAdapter = options.discussionAdapter ?? null
    this.conflictKnowledgeAdapter = options.conflictKnowledgeAdapter ?? null
  }

  createPlan(input: CreatePlanningTeamInput): Record<string, unknown> {
    const boardId = positiveInteger(input.boardId, 'board id')
    this.requireBoard(boardId)
    const name = boundedText(input.name, 'team name', 160)
    const purpose = boundedText(input.purpose, 'team purpose', 4000)
    const participantBudget = boundedInteger(input.participantBudget, 'participant budget', 2, 100)
    const maxRounds = boundedInteger(input.maxRounds, 'max rounds', 1, 100)
    const wakeBudget = boundedInteger(input.wakeBudget, 'wake budget', 0, 10000)
    const tokenBudget = boundedInteger(input.tokenBudget, 'token budget', 1, 1_000_000_000)
    const costBudgetCents = boundedInteger(input.costBudgetCents, 'cost budget', 0, 1_000_000_000)
    const deadlineAt = futureTimestamp(input.deadlineAt, 'planning deadline')
    const completionConditions = boundedJsonObject(
      input.completionConditions,
      'completion conditions',
    )
    const organizationTeamId = boundedText(input.teamId, 'canonical team id', 200)
    const cardId = input.cardId == null ? null : positiveInteger(input.cardId, 'card id')
    this.validateTeamScope(boardId, organizationTeamId, cardId)
    const participants = this.normalizeParticipants(
      boardId,
      organizationTeamId,
      input.participants,
      participantBudget,
    )
    const actor = normalizeActor(input.actor)
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)

    const command = this.runCommand(boardId, idempotencyKey, 'planning_team.create', {
      boardId,
      organizationTeamId,
      cardId,
      name,
      purpose,
      participants,
      maxRounds,
      deadlineAt,
      completionConditions,
      participantBudget,
      wakeBudget,
      tokenBudget,
      costBudgetCents,
      actor,
    }, () => {
      const planId = randomUUID()
      const sessionId = randomUUID()
      const at = timestamp()
      this.db.prepare(`INSERT INTO os_team_plans
        (id, board_id, team_id, card_id, name, purpose, status,
         created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?, NULL)`)
        .run(planId, boardId, organizationTeamId, cardId, name, purpose, at, at)
      const members: Record<string, unknown>[] = []
      for (const participant of participants) {
        const memberId = randomUUID()
        this.db.prepare(`INSERT INTO os_team_plan_participants
          (id, plan_id, agent_profile_id, membership_id, status, joined_at, left_at)
          VALUES (?, ?, ?, ?, 'active', ?, NULL)`)
          .run(memberId, planId, participant.profileId, participant.membershipId, at)
        for (const role of participant.roles) {
          this.db.prepare(`INSERT INTO os_team_plan_roles
            (id, plan_id, participant_id, role, scope_json, created_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)`)
            .run(randomUUID(), planId, memberId, role, stableJson(participant.scope), at)
        }
        members.push({
          id: memberId,
          plan_id: planId,
          agent_profile_id: participant.profileId,
          roles: participant.roles,
          status: 'active',
        })
      }
      this.db.prepare(`INSERT INTO os_planning_sessions
        (id, plan_id, status, version, current_round, max_rounds, deadline_at,
         completion_conditions_json, participant_budget, wake_budget, token_budget,
         cost_budget_cents, wakes_used, tokens_used, cost_used_cents, stop_reason,
         escalation_ref, created_at, updated_at, completed_at)
        VALUES (?, ?, 'running', 1, 1, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, ?, ?, NULL)`)
        .run(
          sessionId,
          planId,
          maxRounds,
          deadlineAt,
          stableJson(completionConditions),
          participantBudget,
          wakeBudget,
          tokenBudget,
          costBudgetCents,
          at,
          at,
        )
      this.events.append({
        boardId,
        cardId,
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: 'planning_team.created',
        source: 'planning-team-service',
        payload: {
          plan_id: planId,
          team_id: organizationTeamId,
          session_id: sessionId,
          participant_profile_ids: participants.map((item) => item.profileId),
          roles: participants.flatMap((item) => item.roles),
          budgets: { participantBudget, wakeBudget, tokenBudget, costBudgetCents },
        },
      })
      return {
        id: planId,
        board_id: boardId,
        team_id: organizationTeamId,
        card_id: cardId,
        name,
        purpose,
        status: 'planning',
        members,
        planning_session: this.requireSession(sessionId),
      }
    })
    return { ...command.result, replayed: command.replayed }
  }

  recordArtifact(input: RecordPlanningArtifactInput): PlanningArtifactCommandResult {
    const team = this.requireTeam(input.teamId)
    const boardId = Number(team.board_id)
    const member = this.requireActiveMember(team.id as string, input.authorMemberId)
    const kind = enumValue(input.kind, PLANNING_ARTIFACT_KINDS, 'planning artifact kind')
    this.requireArtifactRole(String(member.id), kind)
    const summary = boundedText(input.summary, 'artifact summary', 4000)
    const content = boundedJsonObject(input.content ?? {}, 'artifact content')
    const sourceArtifactIds = stringList(input.sourceArtifactIds ?? [], 'source artifact ids', 200)
    const recipientMemberIds = stringList(
      input.recipientMemberIds ?? [],
      'recipient member ids',
      200,
    )
    const wakeCost = boundedInteger(input.wakeCost ?? 0, 'wake cost', 0, 10000)
    const tokenCost = boundedInteger(input.tokenCost ?? 0, 'token cost', 0, 1_000_000_000)
    const costCents = boundedInteger(input.costCents ?? 0, 'cost cents', 0, 1_000_000_000)
    this.validateArtifactFanout(team.id as string, kind, sourceArtifactIds, recipientMemberIds, wakeCost)
    const actor = normalizeActor(input.actor)
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const command = this.runCommand(boardId, idempotencyKey, 'planning_artifact.record', {
      teamId: team.id,
      memberId: member.id,
      kind,
      summary,
      content,
      sourceArtifactIds,
      recipientMemberIds,
      wakeCost,
      tokenCost,
      costCents,
      actor,
    }, () => {
      const session = this.requireRunningSession(String(team.id))
      const budgetReason = planningBudgetReason(session, wakeCost, tokenCost, costCents)
      if (budgetReason || Date.parse(String(session.deadline_at)) <= Date.now()) {
        const reason = budgetReason ?? 'planning deadline elapsed'
        const escalated = this.escalateSession(session, reason, actor, input.correlationId)
        return {
          accepted: false,
          artifact: null,
          session: escalated,
          escalation_reason: reason,
          replayed: false,
        }
      }
      const artifactId = randomUUID()
      const at = timestamp()
      this.db.prepare(`INSERT INTO os_planning_artifacts
        (id, session_id, plan_id, author_participant_id, kind, round_number, summary,
         content_json, source_artifact_ids_json, recipient_participant_ids_json,
         wake_cost, token_cost, cost_cents, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          artifactId,
          session.id,
          team.id,
          member.id,
          kind,
          session.current_round,
          summary,
          stableJson(content),
          stableJson(sourceArtifactIds),
          stableJson(recipientMemberIds),
          wakeCost,
          tokenCost,
          costCents,
          at,
        )
      this.db.prepare(`UPDATE os_planning_sessions SET
        wakes_used=wakes_used+?, tokens_used=tokens_used+?,
        cost_used_cents=cost_used_cents+?, version=version+1, updated_at=?
        WHERE id=? AND version=?`)
        .run(wakeCost, tokenCost, costCents, at, session.id, session.version)
      const artifact = this.requireRow('os_planning_artifacts', artifactId, 'planning artifact')
      this.events.append({
        boardId,
        cardId: nullableNumber(team.card_id),
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: `planning.${kind}_recorded`,
        source: 'planning-team-service',
        payload: {
          team_id: team.id,
          session_id: session.id,
          artifact_id: artifactId,
          round: session.current_round,
          recipient_member_ids: recipientMemberIds,
          source_artifact_ids: sourceArtifactIds,
          wake_cost: wakeCost,
          token_cost: tokenCost,
          cost_cents: costCents,
        },
      })
      return {
        accepted: true,
        artifact: mapRow(artifact),
        session: mapRow(this.requireSession(String(session.id))),
        escalation_reason: null,
        replayed: false,
      }
    })
    return { ...command.result, replayed: command.replayed }
  }

  advanceRound(input: {
    teamId: string
    completionSatisfied?: boolean
    reason?: string
    actor: ActorIdentity
    idempotencyKey: string
    correlationId?: string | null
  }): Record<string, unknown> {
    const team = this.requireTeam(input.teamId)
    const boardId = Number(team.board_id)
    const actor = normalizeActor(input.actor)
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const reason = optionalText(input.reason, 'round reason', 2000)
    const command = this.runCommand(boardId, idempotencyKey, 'planning_round.advance', {
      teamId: team.id,
      completionSatisfied: input.completionSatisfied === true,
      reason,
      actor,
    }, () => {
      const session = this.requireRunningSession(String(team.id))
      const at = timestamp()
      if (input.completionSatisfied === true) {
        const synthesis = this.db.prepare(`SELECT 1 FROM os_planning_artifacts
          WHERE session_id=? AND kind IN ('synthesis', 'plan') LIMIT 1`).get(session.id)
        if (!synthesis) throw new ConflictError('planning cannot complete without a synthesis or plan artifact')
        const changed = this.db.prepare(`UPDATE os_planning_sessions SET status='completed',
          version=version+1, stop_reason=?, updated_at=?, completed_at=?
          WHERE id=? AND status='running' AND version=?`)
          .run(reason ?? 'completion conditions satisfied', at, at, session.id, session.version)
        if (changed.changes !== 1) throw new ConflictError('planning session changed concurrently')
        this.db.prepare(`UPDATE os_team_plans SET status='active', updated_at=? WHERE id=?`)
          .run(at, team.id)
      } else if (Number(session.current_round) >= Number(session.max_rounds)) {
        this.escalateSession(session, reason ?? 'planning failed to converge within bounded rounds', actor, input.correlationId)
      } else if (Date.parse(String(session.deadline_at)) <= Date.now()) {
        this.escalateSession(session, reason ?? 'planning deadline elapsed', actor, input.correlationId)
      } else {
        const changed = this.db.prepare(`UPDATE os_planning_sessions SET
          version=version+1, current_round=current_round+1,
          updated_at=? WHERE id=? AND status='running' AND version=?`)
          .run(at, session.id, session.version)
        if (changed.changes !== 1) throw new ConflictError('planning session changed concurrently')
      }
      const current = mapRow(this.requireSession(String(session.id)))
      this.events.append({
        boardId,
        cardId: nullableNumber(team.card_id),
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: `planning.${current.status === 'running' ? 'round_advanced' : current.status}`,
        source: 'planning-team-service',
        payload: { team_id: team.id, session_id: session.id, reason },
      })
      return current
    })
    return { ...command.result, replayed: command.replayed }
  }

  recordHumanOverride(input: {
    teamId: string
    reason: string
    scope: Record<string, unknown>
    destructiveDecision?: boolean
    expiresAt?: string | null
    actor: ActorIdentity
    idempotencyKey: string
    correlationId?: string | null
  }): Record<string, unknown> {
    const team = this.requireTeam(input.teamId)
    const boardId = Number(team.board_id)
    const actor = requireHumanActor(input.actor)
    const reason = boundedText(input.reason, 'override reason', 4000)
    const scope = boundedJsonObject(input.scope, 'override scope')
    const expiresAt = input.expiresAt == null ? null : futureTimestamp(input.expiresAt, 'override expiry')
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const command = this.runCommand(boardId, idempotencyKey, 'planning_override.record', {
      teamId: team.id,
      reason,
      scope,
      destructiveDecision: input.destructiveDecision === true,
      expiresAt,
      actor,
    }, () => {
      const session = this.requireCurrentSession(String(team.id))
      const id = randomUUID()
      const at = timestamp()
      this.db.prepare(`INSERT INTO os_planning_overrides
        (id, session_id, plan_id, actor_type, actor_id, reason, scope_json,
         destructive_decision, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          session.id,
          team.id,
          actor.type,
          actor.id,
          reason,
          stableJson(scope),
          input.destructiveDecision === true ? 1 : 0,
          expiresAt,
          at,
        )
      this.events.append({
        boardId,
        cardId: nullableNumber(team.card_id),
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: 'planning.human_override_recorded',
        source: 'planning-team-service',
        payload: {
          team_id: team.id,
          session_id: session.id,
          override_id: id,
          destructive_decision: input.destructiveDecision === true,
          expires_at: expiresAt,
        },
      })
      return mapRow(this.requireRow('os_planning_overrides', id, 'planning override'))
    })
    return { ...command.result, replayed: command.replayed }
  }

  delegateWork(input: DelegateTeamWorkInput): Record<string, unknown> {
    const team = this.requireTeam(input.teamId)
    const boardId = Number(team.board_id)
    const cardId = nullableNumber(team.card_id)
    if (cardId === null) throw new ValidationError('collaborative work requires a card-scoped planning team')
    const member = this.requireActiveMember(String(team.id), input.memberId)
    const delegator = this.requireActiveMember(String(team.id), input.delegatedByMemberId)
    this.requireAnyRole(String(delegator.id), ['facilitator'])
    this.requireAnyRole(String(member.id), ['researcher', 'implementer', 'reviewer', 'integrator'])
    const assignmentId = boundedText(input.exclusiveAssignmentId, 'exclusive assignment id', 200)
    const assignmentMarketVersion = positiveInteger(
      input.assignmentMarketVersion,
      'assignment market version',
    )
    const assignment = this.db.prepare(`SELECT * FROM job_market_assignments
      WHERE id=? AND board_id=? AND card_id=? AND status='active'`)
      .get(assignmentId, boardId, cardId) as Record<string, unknown> | undefined
    if (!assignment) throw new ConflictError('collaborative work requires the current active exclusive assignment')
    if (Number(assignment.assigned_market_version) !== assignmentMarketVersion) {
      throw new ConflictError('exclusive assignment market version is stale')
    }
    const ownerMember = this.db.prepare(`SELECT 1 FROM os_team_plan_participants
      WHERE plan_id=? AND agent_profile_id=? AND status='active'`)
      .get(team.id, assignment.profile_id)
    if (!ownerMember) {
      throw new ConflictError('the exclusive assignment owner must be an explicit planning-team participant')
    }
    const jobId = boundedText(input.jobId, 'canonical job id', 200)
    const job = this.db.prepare(`SELECT id, board_id, card_id, job_assignment_id,
        assigned_profile_id, assignment_market_version, status
      FROM jobs WHERE id=? AND board_id=? AND card_id=?`)
      .get(jobId, boardId, cardId) as Record<string, unknown> | undefined
    if (!job
      || String(job.job_assignment_id) !== assignmentId
      || String(job.assigned_profile_id) !== String(assignment.profile_id)
      || Number(job.assignment_market_version) !== assignmentMarketVersion) {
      throw new ConflictError(
        'collaborative delegation must reference the executable job for the exclusive assignment',
      )
    }
    if (!['queued', 'running'].includes(String(job.status))) {
      throw new ConflictError('collaborative delegation requires a queued or running canonical job')
    }
    const contractRef = boundedText(input.contractRef, 'contract reference', 512)
    const objective = boundedText(input.objective, 'delegated objective', 4000)
    const criterionIds = stringList(input.criterionIds, 'criterion ids', 200)
    if (!criterionIds.length) throw new ValidationError('at least one stable criterion id is required')
    const scopePaths = stringList(input.scopePaths, 'scope paths', 512)
    const reason = boundedText(input.reason, 'delegation reason', 2000)
    const actor = normalizeActor(input.actor)
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const command = this.runCommand(boardId, idempotencyKey, 'planning_team.delegate_work', {
      teamId: team.id,
      assignmentId,
      assignmentMarketVersion,
      jobId,
      memberId: member.id,
      delegatorId: delegator.id,
      contractRef,
      objective,
      criterionIds,
      scopePaths,
      reason,
      actor,
    }, () => {
      let binding = this.db.prepare(`SELECT * FROM os_team_work_bindings
        WHERE plan_id=? AND status='active'`).get(team.id) as Record<string, unknown> | undefined
      const at = timestamp()
      if (!binding) {
        const bindingId = randomUUID()
        const participantSnapshot = this.participantSnapshot(String(team.id))
        const roleSnapshot = this.roleSnapshot(String(team.id))
        const canonicalTeam = this.db.prepare(`SELECT id, organization_id, team_key, name,
          mission, status, updated_at FROM os_teams WHERE id=?`).get(team.team_id)
        this.db.prepare(`INSERT INTO os_team_work_bindings
          (id, plan_id, team_id, board_id, card_id, exclusive_assignment_id,
           executable_profile_id, assignment_market_version, assignment_version,
           team_snapshot_json, participant_snapshot_json, role_snapshot_json,
           status, version, bound_by_type, bound_by_id,
           reason, created_at, updated_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, NULL)`)
          .run(
            bindingId,
            team.id,
            team.team_id,
            boardId,
            cardId,
            assignmentId,
            assignment.profile_id,
            assignmentMarketVersion,
            assignment.version,
            stableJson(canonicalTeam),
            stableJson(participantSnapshot),
            stableJson(roleSnapshot),
            actor.type,
            actor.id,
            reason,
            at,
            at,
          )
        binding = this.requireRow('os_team_work_bindings', bindingId, 'team work binding')
      } else if (
        String(binding.exclusive_assignment_id) !== assignmentId
        || Number(binding.assignment_market_version) !== assignmentMarketVersion
      ) {
        throw new ConflictError('planning team is already bound to a different exclusive assignment')
      }
      const delegationId = randomUUID()
      this.db.prepare(`INSERT INTO os_team_delegations
        (id, binding_id, plan_id, participant_id, delegated_by_participant_id, contract_ref,
         objective, criterion_ids_json, scope_paths_json, status, created_at,
         accepted_at, completed_at, job_id, version, updated_at, cancelled_at,
         transition_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, NULL, NULL, ?, 1, ?, NULL, NULL)`)
        .run(
          delegationId,
          binding.id,
          team.id,
          member.id,
          delegator.id,
          contractRef,
          objective,
          stableJson(criterionIds),
          stableJson(scopePaths),
          at,
          jobId,
          at,
        )
      this.events.append({
        boardId,
        cardId,
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: 'planning_team.work_delegated',
        source: 'planning-team-service',
        payload: {
          team_id: team.id,
          binding_id: binding.id,
          exclusive_assignment_id: assignmentId,
          delegation_id: delegationId,
          job_id: jobId,
          member_id: member.id,
          criterion_ids: criterionIds,
          scope_paths: scopePaths,
        },
      })
      return {
        binding: mapRow(binding),
        delegation: mapRow(this.requireRow('os_team_delegations', delegationId, 'team delegation')),
        exclusive_ownership_preserved: true,
      }
    })
    return { ...command.result, replayed: command.replayed }
  }

  transitionDelegation(input: TransitionTeamDelegationInput): Record<string, unknown> {
    const team = this.requireTeam(input.teamId)
    const boardId = Number(team.board_id)
    const delegationId = boundedText(input.delegationId, 'delegation id', 200)
    const memberId = boundedText(input.memberId, 'team member id', 200)
    const transition = enumValue(
      input.transition,
      ['accept', 'complete', 'cancel'] as const,
      'delegation transition',
    )
    const expectedVersion = positiveInteger(input.expectedVersion, 'expected delegation version')
    const reason = boundedText(input.reason, 'delegation transition reason', 2000)
    const actor = normalizeActor(input.actor)
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const command = this.runCommand(boardId, idempotencyKey, 'planning_team.transition_delegation', {
      teamId: team.id,
      delegationId,
      memberId,
      transition,
      expectedVersion,
      reason,
      actor,
    }, () => {
      const delegation = this.db.prepare(`SELECT delegation.*, binding.exclusive_assignment_id,
          binding.executable_profile_id, binding.assignment_market_version,
          job.status AS job_status
        FROM os_team_delegations delegation
        JOIN os_team_work_bindings binding ON binding.id=delegation.binding_id
        JOIN jobs job ON job.id=delegation.job_id
        WHERE delegation.id=? AND delegation.plan_id=?`)
        .get(delegationId, team.id) as Record<string, unknown> | undefined
      if (!delegation) throw new NotFoundError('team delegation not found')
      const member = this.requireActiveMember(String(team.id), memberId)
      if (Number(delegation.version) !== expectedVersion) {
        throw new ConflictError('team delegation version is stale')
      }
      if (transition === 'accept' || transition === 'complete') {
        if (String(member.id) !== String(delegation.participant_id)) {
          throw new ConflictError('only the assigned participant can accept or complete delegated work')
        }
      } else if (
        String(member.id) !== String(delegation.participant_id)
        && String(member.id) !== String(delegation.delegated_by_participant_id)
        && !this.memberHasRole(String(member.id), 'facilitator')
      ) {
        throw new ConflictError('only the assignee, delegator, or facilitator can cancel delegated work')
      }
      const currentStatus = String(delegation.status)
      const nextStatus = transition === 'accept'
        ? 'accepted'
        : transition === 'complete'
          ? 'completed'
          : 'cancelled'
      const transitionAllowed = (currentStatus === 'assigned'
        && (nextStatus === 'accepted' || nextStatus === 'cancelled'))
        || (currentStatus === 'accepted'
          && (nextStatus === 'completed' || nextStatus === 'cancelled'))
      if (!transitionAllowed) {
        throw new ConflictError(`delegated work in ${currentStatus} cannot transition to ${nextStatus}`)
      }
      if (nextStatus === 'accepted' && !['queued', 'running'].includes(String(delegation.job_status))) {
        throw new ConflictError('delegated work cannot be accepted after its canonical job stopped')
      }
      if (nextStatus === 'completed'
        && !['running', 'succeeded'].includes(String(delegation.job_status))) {
        throw new ConflictError('delegated work can complete only while its canonical job runs or succeeds')
      }
      const at = timestamp()
      const changed = this.db.prepare(`UPDATE os_team_delegations SET
          status=?, version=version+1, updated_at=?, transition_reason=?,
          accepted_at=CASE WHEN ?='accepted' THEN ? ELSE accepted_at END,
          completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END,
          cancelled_at=CASE WHEN ?='cancelled' THEN ? ELSE cancelled_at END
        WHERE id=? AND plan_id=? AND status=? AND version=?`)
        .run(
          nextStatus,
          at,
          reason,
          nextStatus,
          at,
          nextStatus,
          at,
          nextStatus,
          at,
          delegationId,
          team.id,
          currentStatus,
          expectedVersion,
        )
      if (changed.changes !== 1) throw new ConflictError('team delegation changed concurrently')
      const updated = mapRow(this.requireRow('os_team_delegations', delegationId, 'team delegation'))
      this.events.append({
        boardId,
        cardId: nullableNumber(team.card_id),
        jobId: String(delegation.job_id),
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: `planning_team.work_${nextStatus}`,
        source: 'planning-team-service',
        payload: {
          plan_id: team.id,
          delegation_id: delegationId,
          job_id: delegation.job_id,
          exclusive_assignment_id: delegation.exclusive_assignment_id,
          participant_id: member.id,
          previous_status: currentStatus,
          status: nextStatus,
          version: updated.version,
          reason,
        },
      })
      return {
        delegation: updated,
        canonical_job_id: delegation.job_id,
        exclusive_assignment_id: delegation.exclusive_assignment_id,
        exclusive_ownership_preserved: true,
      }
    })
    return { ...command.result, replayed: command.replayed }
  }

  openConflict(input: OpenConflictInput): Record<string, unknown> {
    const team = this.requireTeam(input.teamId)
    const boardId = Number(team.board_id)
    if (!this.discussionAdapter) {
      throw new ConflictError('canonical conflict creation requires a Discussion adapter')
    }
    const kind = enumValue(input.kind, CONFLICT_KINDS, 'conflict kind')
    const severity = enumValue(
      input.severity,
      ['low', 'medium', 'high', 'critical'] as const,
      'conflict severity',
    )
    const summary = boundedText(input.summary, 'conflict summary', 4000)
    const memberIds = stringList(input.participantMemberIds, 'conflict participant ids', 200)
    if (memberIds.length < 2) throw new ValidationError('a conflict requires at least two explicit participants')
    const members = memberIds.map((id) => this.requireActiveMember(String(team.id), id))
    const profileIds = members.map((member) => String(member.agent_profile_id))
    const causalJobIds = this.validateCausalJobs(
      team,
      stringList(input.causalJobIds, 'causal job ids', 200),
    )
    const affectedResources = this.validateAffectedResources(team, input.affectedResources)
    if (!affectedResources.length) throw new ValidationError('at least one affected resource is required')
    const detectionEvidence = boundedJsonObject(input.detectionEvidence, 'detection evidence')
    const dedupeSha256 = sha256(stableJson({
      plan_id: team.id,
      kind,
      causal_job_ids: causalJobIds,
      affected_resources: affectedResources,
    }))
    const actor = normalizeActor(input.actor)
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const command = this.runCommand(boardId, idempotencyKey, 'conflict.open', {
      teamId: team.id,
      kind,
      severity,
      summary,
      memberIds,
      causalJobIds,
      affectedResources,
      detectionEvidence,
      dedupeSha256,
      actor,
    }, () => {
      const existing = this.db.prepare(`SELECT id FROM os_conflicts
        WHERE board_id=? AND dedupe_sha256=?
          AND status IN ('open', 'negotiating', 'needs_human')`)
        .get(boardId, dedupeSha256) as { id: string } | undefined
      if (existing) return this.conflictDetail(existing.id)
      const conflictId = randomUUID()
      const discussion = this.discussionAdapter!.createConflictDiscussion({
        boardId,
        teamId: String(team.id),
        conflictId,
        title: summary,
        participantProfileIds: profileIds,
        idempotencyKey: `conflict-discussion:${idempotencyKey}`,
        correlationId: input.correlationId,
      })
      const discussionId = boundedText(discussion.id, 'discussion id', 200)
      const at = timestamp()
      let attentionItemId: string | null = null
      if (severity === 'high' || severity === 'critical') {
        attentionItemId = this.attention.create({
          boardId,
          cardId: nullableNumber(team.card_id),
          kind: 'team.conflict',
          severity,
          title: `Unresolved ${severity} ${kind} conflict`,
          detail: summary,
        }).id
      }
      this.db.prepare(`INSERT INTO os_conflicts
        (id, board_id, plan_id, kind, severity, status, version, dedupe_sha256,
         discussion_id, summary,
         causal_job_ids_json, affected_resources_json, detection_evidence_json,
         attention_item_id, created_at, updated_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(
          conflictId,
          boardId,
          team.id,
          kind,
          severity,
          dedupeSha256,
          discussionId,
          summary,
          stableJson(causalJobIds),
          stableJson(affectedResources),
          stableJson(detectionEvidence),
          attentionItemId,
          at,
          at,
        )
      for (const member of members) {
        this.db.prepare(`INSERT INTO os_conflict_participants
          (id, conflict_id, participant_id, position, created_at)
          VALUES (?, ?, ?, 'affected', ?)`)
          .run(randomUUID(), conflictId, member.id, at)
      }
      this.events.append({
        boardId,
        cardId: nullableNumber(team.card_id),
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: 'conflict.opened',
        source: 'planning-team-service',
        payload: {
          conflict_id: conflictId,
          team_id: team.id,
          discussion_id: discussionId,
          participant_member_ids: memberIds,
          causal_job_ids: causalJobIds,
          affected_resources: affectedResources,
          detection_evidence: detectionEvidence,
        },
      })
      return this.conflictDetail(conflictId)
    })
    return { ...command.result, replayed: command.replayed }
  }

  addConflictProposal(input: AddConflictProposalInput): Record<string, unknown> {
    const conflict = this.requireConflict(input.conflictId)
    const member = this.requireConflictParticipant(String(conflict.id), input.proposedByMemberId)
    const kind = enumValue(input.kind, CONFLICT_PROPOSAL_KINDS, 'conflict proposal kind')
    const summary = boundedText(input.summary, 'proposal summary', 4000)
    const details = boundedJsonObject(input.details ?? {}, 'proposal details')
    const actor = normalizeActor(input.actor)
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const boardId = Number(conflict.board_id)
    const command = this.runCommand(boardId, idempotencyKey, 'conflict.propose', {
      conflictId: conflict.id,
      memberId: member.id,
      kind,
      summary,
      details,
      actor,
    }, () => {
      if (!['open', 'negotiating', 'needs_human'].includes(String(conflict.status))) {
        throw new ConflictError('resolved or archived conflicts cannot accept proposals')
      }
      const id = randomUUID()
      const at = timestamp()
      this.db.prepare(`INSERT INTO os_conflict_proposals
        (id, conflict_id, proposed_by_participant_id, kind, summary, details_json,
         status, created_at, selected_at)
        VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, NULL)`)
        .run(id, conflict.id, member.id, kind, summary, stableJson(details), at)
      const changed = this.db.prepare(`UPDATE os_conflicts SET status='negotiating',
        version=version+1, updated_at=?
        WHERE id=? AND status IN ('open', 'needs_human', 'negotiating') AND version=?`)
        .run(at, conflict.id, conflict.version)
      if (changed.changes !== 1) throw new ConflictError('conflict changed concurrently')
      this.events.append({
        boardId,
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: 'conflict.proposal_recorded',
        source: 'planning-team-service',
        payload: { conflict_id: conflict.id, proposal_id: id, member_id: member.id, kind },
      })
      return mapRow(this.requireRow('os_conflict_proposals', id, 'conflict proposal'))
    })
    return { ...command.result, replayed: command.replayed }
  }

  resolveConflict(input: ResolveConflictInput): Record<string, unknown> {
    const conflict = this.requireConflict(input.conflictId)
    const proposal = this.requireRow('os_conflict_proposals', input.proposalId, 'conflict proposal')
    if (String(proposal.conflict_id) !== String(conflict.id)) {
      throw new ValidationError('proposal does not belong to this conflict')
    }
    const actor = normalizeActor(input.actor)
    const rationale = boundedText(input.rationale, 'resolution rationale', 4000)
    const followUpActions = input.followUpActions.map((item) => ({
      owner: boundedText(item.owner, 'follow-up owner', 200),
      action: boundedText(item.action, 'follow-up action', 1000),
      ...(item.due_at ? { due_at: validTimestamp(item.due_at, 'follow-up due date') } : {}),
    }))
    const arbiterMemberId = optionalText(input.arbiterMemberId, 'arbiter member id', 200)
    if (actor.type !== 'human') {
      if (!arbiterMemberId) throw new ValidationError('agent resolution requires an explicit arbiter member')
      const arbiter = this.requireConflictParticipant(String(conflict.id), arbiterMemberId)
      this.requireAnyRole(String(arbiter.id), ['facilitator', 'reviewer', 'integrator'])
    }
    const integrationMemberId = optionalText(
      input.integrationMemberId,
      'integration member id',
      200,
    )
    if (['merge', 'assign_integrator'].includes(String(proposal.kind))) {
      if (!integrationMemberId) {
        throw new ValidationError('merge and assign-integrator resolutions require an integration member')
      }
      const integrator = this.requireActiveMember(String(conflict.plan_id), integrationMemberId)
      this.requireAnyRole(String(integrator.id), ['integrator'])
    }
    const humanOverrideId = optionalText(input.humanOverrideId, 'human override id', 200)
    if (humanOverrideId) {
      const override = this.requireRow('os_planning_overrides', humanOverrideId, 'planning override')
      if (String(override.plan_id) !== String(conflict.plan_id)) {
        throw new ValidationError('human override belongs to another team')
      }
    }
    const boardId = Number(conflict.board_id)
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const command = this.runCommand(boardId, idempotencyKey, 'conflict.resolve', {
      conflictId: conflict.id,
      proposalId: proposal.id,
      arbiterMemberId,
      rationale,
      followUpActions,
      integrationMemberId,
      humanOverrideId,
      actor,
    }, () => {
      const current = this.requireConflict(String(conflict.id))
      if (current.status === 'resolved' || current.status === 'archived') {
        throw new ConflictError('conflict has already been resolved')
      }
      const id = randomUUID()
      const at = timestamp()
      this.db.prepare(`UPDATE os_conflict_proposals SET status='rejected'
        WHERE conflict_id=? AND id!=? AND status='proposed'`).run(conflict.id, proposal.id)
      this.db.prepare(`UPDATE os_conflict_proposals SET status='selected', selected_at=?
        WHERE id=? AND status='proposed'`).run(at, proposal.id)
      this.db.prepare(`INSERT INTO os_conflict_resolutions
        (id, conflict_id, proposal_id, arbiter_type, arbiter_id, rationale,
         follow_up_actions_json, integration_member_id, human_override_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          conflict.id,
          proposal.id,
          actor.type,
          actor.id ?? arbiterMemberId ?? 'unknown',
          rationale,
          stableJson(followUpActions),
          integrationMemberId,
          humanOverrideId,
          at,
        )
      const changed = this.db.prepare(`UPDATE os_conflicts SET status='resolved',
        version=version+1, updated_at=?, resolved_at=?
        WHERE id=? AND version=? AND status IN ('open', 'negotiating', 'needs_human')`)
        .run(at, at, conflict.id, current.version)
      if (changed.changes !== 1) throw new ConflictError('conflict changed concurrently')
      if (current.attention_item_id) this.attention.resolve(String(current.attention_item_id))
      this.discussionAdapter?.resolveConflictDiscussion?.({
        discussionId: String(current.discussion_id),
        conflictId: String(conflict.id),
        resolutionId: id,
        summary: rationale,
        idempotencyKey: `conflict-resolution:${idempotencyKey}`,
      })
      this.events.append({
        boardId,
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: 'conflict.resolved',
        source: 'planning-team-service',
        payload: {
          conflict_id: conflict.id,
          resolution_id: id,
          proposal_id: proposal.id,
          rationale,
          follow_up_actions: followUpActions,
          integration_member_id: integrationMemberId,
          human_override_id: humanOverrideId,
        },
      })
      return this.conflictDetail(String(conflict.id))
    })
    return { ...command.result, replayed: command.replayed }
  }

  requestConflictKnowledgePromotion(input: {
    conflictId: string
    summary: string
    actor: ActorIdentity
    idempotencyKey: string
    correlationId?: string | null
  }): Record<string, unknown> {
    const conflict = this.requireConflict(input.conflictId)
    if (conflict.status !== 'resolved') throw new ConflictError('only resolved conflicts can become knowledge candidates')
    const resolution = this.db.prepare(`SELECT * FROM os_conflict_resolutions
      WHERE conflict_id=?`).get(conflict.id) as Record<string, unknown> | undefined
    if (!resolution) throw new ConflictError('resolved conflict is missing its exact resolution source')
    const summary = boundedText(input.summary, 'knowledge candidate summary', 4000)
    const actor = normalizeActor(input.actor)
    if (actor.type === 'agent') {
      const requester = this.db.prepare(`SELECT participant.agent_profile_id
        FROM os_conflict_participants affected
        JOIN os_team_plan_participants participant ON participant.id=affected.participant_id
        WHERE affected.conflict_id=? AND participant.agent_profile_id=?
          AND participant.status='active'`)
        .get(conflict.id, actor.id) as { agent_profile_id: string } | undefined
      if (!requester || requester.agent_profile_id !== actor.id) {
        throw new ConflictError(
          'conflict knowledge requester must be the exact affected participant profile',
        )
      }
      if (requester.agent_profile_id === resolution.arbiter_id) {
        throw new ConflictError(
          'conflict knowledge requester must differ from the resolution arbiter',
        )
      }
    }
    const source = this.conflictKnowledgeSource(conflict, resolution)
    const sourceSha256 = sha256(stableJson(source))
    const boardId = Number(conflict.board_id)
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const command = this.runCommand(boardId, idempotencyKey, 'conflict.request_knowledge_promotion', {
      conflictId: conflict.id,
      summary,
      sourceSha256,
      actor,
    }, () => {
      const id = randomUUID()
      const sourceRef = `conflict-resolution:${resolution.id}`
      const at = timestamp()
      this.db.prepare(`INSERT INTO os_conflict_knowledge_candidates
        (id, conflict_id, resolution_id, status, source_kind, source_ref,
         source_sha256, summary, requested_by_type, requested_by_id, created_at, reviewed_at)
        VALUES (?, ?, ?, 'pending_review', 'conflict_resolution', ?, ?, ?, ?, ?, ?, NULL)`)
        .run(
          id,
          conflict.id,
          resolution.id,
          sourceRef,
          sourceSha256,
          summary,
          actor.type,
          actor.id,
          at,
        )
      this.events.append({
        boardId,
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: 'conflict.knowledge_candidate_requested',
        source: 'planning-team-service',
        payload: {
          conflict_id: conflict.id,
          resolution_id: resolution.id,
          candidate_id: id,
          source_ref: sourceRef,
          source_sha256: sourceSha256,
          review_required: true,
        },
      })
      return {
        ...mapRow(this.requireRow(
          'os_conflict_knowledge_candidates',
          id,
          'conflict knowledge candidate',
        )),
        exact_source: source,
        review_required: true,
      }
    })
    return { ...command.result, replayed: command.replayed }
  }

  reviewConflictKnowledgeCandidate(input: {
    candidateId: string
    decision: 'accept' | 'reject'
    reason: string
    actor: ActorIdentity
    idempotencyKey: string
    correlationId?: string | null
  }): Record<string, unknown> {
    const candidateId = boundedText(input.candidateId, 'conflict knowledge candidate id', 200)
    const candidate = this.db.prepare(`SELECT candidate.*, conflict.board_id, conflict.plan_id,
        plan.card_id, resolution.arbiter_id
      FROM os_conflict_knowledge_candidates candidate
      JOIN os_conflicts conflict ON conflict.id=candidate.conflict_id
      JOIN os_team_plans plan ON plan.id=conflict.plan_id
      JOIN os_conflict_resolutions resolution ON resolution.id=candidate.resolution_id
      WHERE candidate.id=?`).get(candidateId) as Record<string, unknown> | undefined
    if (!candidate) throw new NotFoundError('conflict knowledge candidate not found')
    const decision = enumValue(input.decision, ['accept', 'reject'] as const, 'review decision')
    const reason = boundedText(input.reason, 'knowledge review reason', 4000)
    const actor = requireHumanActor(input.actor)
    if (actor.id === candidate.requested_by_id || actor.id === candidate.arbiter_id) {
      throw new ConflictError('conflict knowledge review must be independent of requester and arbiter')
    }
    const conflict = this.requireConflict(String(candidate.conflict_id))
    const resolution = this.db.prepare(`SELECT * FROM os_conflict_resolutions WHERE id=?`)
      .get(candidate.resolution_id) as Record<string, unknown> | undefined
    if (!resolution) throw new ConflictError('conflict knowledge exact resolution is missing')
    const exactSource = this.conflictKnowledgeSource(conflict, resolution)
    const sourceSha256 = sha256(stableJson(exactSource))
    if (sourceSha256 !== candidate.source_sha256) {
      throw new ConflictError('conflict knowledge exact source changed before independent review')
    }
    const boardId = Number(candidate.board_id)
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const command = this.runCommand(boardId, idempotencyKey, 'conflict.review_knowledge_candidate', {
      candidateId,
      decision,
      reason,
      sourceSha256,
      actor,
    }, () => {
      const currentCandidate = this.db.prepare(`SELECT candidate.*, conflict.board_id,
          conflict.plan_id, plan.card_id, resolution.arbiter_id
        FROM os_conflict_knowledge_candidates candidate
        JOIN os_conflicts conflict ON conflict.id=candidate.conflict_id
        JOIN os_team_plans plan ON plan.id=conflict.plan_id
        JOIN os_conflict_resolutions resolution ON resolution.id=candidate.resolution_id
        WHERE candidate.id=?`).get(candidateId) as Record<string, unknown> | undefined
      if (!currentCandidate) throw new NotFoundError('conflict knowledge candidate not found')
      if (currentCandidate.status !== 'pending_review') {
        throw new ConflictError('conflict knowledge candidate has already been reviewed')
      }
      if (decision === 'accept' && !this.conflictKnowledgeAdapter) {
        throw new ConflictError('canonical Knowledge adapter is required to accept conflict knowledge')
      }
      const at = timestamp()
      const promotion = decision === 'accept'
        ? this.conflictKnowledgeAdapter!.promoteConflictResolution({
            boardId,
            cardId: nullableNumber(candidate.card_id),
            conflictId: String(candidate.conflict_id),
            resolutionId: String(candidate.resolution_id),
            title: boundedText(candidate.summary, 'knowledge candidate summary', 4000),
            exactSource,
            sourceSha256,
            reviewedAt: at,
          })
        : null
      if (promotion) {
        this.validateConflictKnowledgePromotion({
          boardId,
          cardId: nullableNumber(candidate.card_id),
          conflictId: String(candidate.conflict_id),
          resolutionId: String(candidate.resolution_id),
          exactSource,
          sourceSha256,
          ...promotion,
        })
      }
      const changed = this.db.prepare(`UPDATE os_conflict_knowledge_candidates SET
          status=?, reviewed_at=?, reviewed_by_type=?, reviewed_by_id=?, review_reason=?,
          knowledge_source_id=?
        WHERE id=? AND status='pending_review' AND source_sha256=?`)
        .run(
          decision === 'accept' ? 'accepted' : 'rejected',
          at,
          actor.type,
          actor.id,
          reason,
          promotion?.sourceId ?? null,
          candidateId,
          sourceSha256,
        )
      if (changed.changes !== 1) {
        throw new ConflictError('conflict knowledge candidate changed concurrently')
      }
      this.events.append({
        boardId,
        cardId: nullableNumber(candidate.card_id),
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: decision === 'accept'
          ? 'conflict.knowledge_candidate_accepted'
          : 'conflict.knowledge_candidate_rejected',
        source: 'planning-team-service',
        payload: {
          candidate_id: candidateId,
          conflict_id: candidate.conflict_id,
          resolution_id: candidate.resolution_id,
          source_ref: candidate.source_ref,
          source_sha256: sourceSha256,
          knowledge_source_id: promotion?.sourceId ?? null,
          knowledge_chunk_id: promotion?.chunkId ?? null,
          repository_head_sha: promotion?.repositoryHeadSha ?? null,
          reviewed_by: actor.id,
          decision,
          reason,
        },
      })
      return {
        ...mapRow(this.requireRow(
          'os_conflict_knowledge_candidates',
          candidateId,
          'conflict knowledge candidate',
        )),
        exact_source: exactSource,
        knowledge_chunk_id: promotion?.chunkId ?? null,
        repository_head_sha: promotion?.repositoryHeadSha ?? null,
        independently_reviewed: true,
      }
    })
    return { ...command.result, replayed: command.replayed }
  }

  createWorkLease(input: {
    teamId: string
    memberId: string
    resourceKind: 'path' | 'branch' | 'workspace' | 'resource'
    resourceKey: string
    mode?: 'advisory' | 'enforced'
    policyRef?: string | null
    expiresAt: string
    actor: ActorIdentity
    idempotencyKey: string
    correlationId?: string | null
  }): Record<string, unknown> {
    const team = this.requireTeam(input.teamId)
    const member = this.requireActiveMember(String(team.id), input.memberId)
    const resourceKind = enumValue(
      input.resourceKind,
      ['path', 'branch', 'workspace', 'resource'] as const,
      'lease resource kind',
    )
    const resourceKey = boundedText(input.resourceKey, 'lease resource key', 512)
    const mode = enumValue(input.mode ?? 'advisory', ['advisory', 'enforced'] as const, 'lease mode')
    const policyRef = optionalText(input.policyRef, 'lease policy reference', 512)
    const actor = mode === 'enforced' ? requireHumanActor(input.actor) : normalizeActor(input.actor)
    if (mode === 'enforced' && !policyRef) {
      throw new ValidationError('enforced leases require an explicit policy reference')
    }
    const expiresAt = futureTimestamp(input.expiresAt, 'lease expiry')
    const boardId = Number(team.board_id)
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const command = this.runCommand(boardId, idempotencyKey, 'planning_team.create_lease', {
      teamId: team.id,
      memberId: member.id,
      resourceKind,
      resourceKey,
      mode,
      policyRef,
      expiresAt,
      actor,
    }, () => {
      const id = randomUUID()
      const at = timestamp()
      this.db.prepare(`INSERT INTO os_work_leases
        (id, plan_id, participant_id, resource_kind, resource_key, mode, policy_ref,
         status, acquired_at, expires_at, released_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`)
        .run(id, team.id, member.id, resourceKind, resourceKey, mode, policyRef, at, expiresAt)
      this.events.append({
        boardId,
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: 'planning_team.lease_created',
        source: 'planning-team-service',
        payload: {
          lease_id: id,
          team_id: team.id,
          member_id: member.id,
          resource_kind: resourceKind,
          resource_key: resourceKey,
          mode,
          policy_ref: policyRef,
          advisory_by_default: mode === 'advisory',
        },
      })
      return mapRow(this.requireRow('os_work_leases', id, 'work lease'))
    })
    return { ...command.result, replayed: command.replayed }
  }

  recordIntegratedDelivery(input: {
    teamId: string
    integratorMemberId: string
    deliveryReportId: string
    verificationRefs: string[]
    actor: ActorIdentity
    idempotencyKey: string
    correlationId?: string | null
  }): Record<string, unknown> {
    const plan = this.requireTeam(input.teamId)
    const boardId = Number(plan.board_id)
    const integrator = this.requireActiveMember(String(plan.id), input.integratorMemberId)
    this.requireAnyRole(String(integrator.id), ['integrator'])
    const deliveryReportId = boundedText(input.deliveryReportId, 'delivery report id', 200)
    const delivery = this.db.prepare(`SELECT id, board_id, card_id, job_id, status,
      accepted_at, updated_at FROM delivery_reports WHERE id=?`).get(deliveryReportId) as
      Record<string, unknown> | undefined
    if (!delivery || Number(delivery.board_id) !== boardId
      || Number(delivery.card_id) !== nullableNumber(plan.card_id)
      || delivery.status !== 'accepted') {
      throw new ConflictError('integrated delivery must be an accepted report for the bound card')
    }
    const binding = this.db.prepare(`SELECT * FROM os_team_work_bindings
      WHERE plan_id=? AND status='active'`).get(plan.id) as Record<string, unknown> | undefined
    if (!binding) throw new ConflictError('integrated delivery requires an active collaborative binding')
    const unresolved = this.db.prepare(`SELECT COUNT(*) count FROM os_conflicts
      WHERE plan_id=? AND status NOT IN ('resolved', 'archived')`).get(plan.id) as { count: number }
    if (unresolved.count > 0) throw new ConflictError('all team conflicts must be resolved before integration')
    const resolutionIds = (this.db.prepare(`SELECT resolution.id FROM os_conflict_resolutions resolution
      JOIN os_conflicts conflict ON conflict.id=resolution.conflict_id
      WHERE conflict.plan_id=? ORDER BY resolution.created_at, resolution.id`).all(plan.id) as
      Array<{ id: string }>).map((row) => row.id)
    const verificationRefs = stringList(input.verificationRefs, 'integration verification refs', 512)
    if (!verificationRefs.length) throw new ValidationError('integration requires exact verification references')
    const actor = normalizeActor(input.actor)
    const exactSource = {
      plan_id: plan.id,
      canonical_team_id: plan.team_id,
      binding_id: binding.id,
      exclusive_assignment_id: binding.exclusive_assignment_id,
      executable_profile_id: binding.executable_profile_id,
      assignment_market_version: binding.assignment_market_version,
      assignment_version: binding.assignment_version,
      participant_snapshot: parseJson(binding.participant_snapshot_json, []),
      role_snapshot: parseJson(binding.role_snapshot_json, []),
      conflict_resolution_ids: resolutionIds,
      delivery: delivery,
      verification_refs: verificationRefs,
    }
    const sourceSha256 = sha256(stableJson(exactSource))
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency key', 200)
    const command = this.runCommand(boardId, idempotencyKey, 'planning_team.integrate_delivery', {
      exactSource,
      integratorMemberId: integrator.id,
      actor,
    }, () => {
      const id = randomUUID()
      const at = timestamp()
      this.db.prepare(`INSERT INTO os_team_integrations
        (id, plan_id, binding_id, integrator_participant_id, delivery_report_id,
         conflict_resolution_ids_json, verification_refs_json, source_sha256,
         actor_type, actor_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          plan.id,
          binding.id,
          integrator.id,
          deliveryReportId,
          stableJson(resolutionIds),
          stableJson(verificationRefs),
          sourceSha256,
          actor.type,
          actor.id,
          at,
        )
      const bindingChanged = this.db.prepare(`UPDATE os_team_work_bindings SET
        status='ended', version=version+1, updated_at=?, ended_at=?
        WHERE id=? AND status='active' AND version=?`).run(at, at, binding.id, binding.version)
      if (bindingChanged.changes !== 1) throw new ConflictError('collaborative binding changed concurrently')
      this.db.prepare(`UPDATE os_team_plans SET status='completed', updated_at=?, completed_at=?
        WHERE id=? AND status IN ('planning', 'active')`).run(at, at, plan.id)
      this.events.append({
        boardId,
        cardId: nullableNumber(plan.card_id),
        actor,
        correlationId: input.correlationId,
        idempotencyKey: `team:${idempotencyKey}`,
        kind: 'planning_team.delivery_integrated',
        source: 'planning-team-service',
        payload: {
          integration_id: id,
          plan_id: plan.id,
          canonical_team_id: plan.team_id,
          binding_id: binding.id,
          delivery_report_id: deliveryReportId,
          integrator_participant_id: integrator.id,
          conflict_resolution_ids: resolutionIds,
          verification_refs: verificationRefs,
          source_sha256: sourceSha256,
        },
      })
      return {
        ...mapRow(this.requireRow('os_team_integrations', id, 'team integration')),
        exact_source: exactSource,
        audited: true,
      }
    })
    return { ...command.result, replayed: command.replayed }
  }

  getTeam(teamId: string): Record<string, unknown> {
    const team = mapRow(this.requireTeam(teamId))
    const members = (this.db.prepare(`SELECT * FROM os_team_plan_participants
      WHERE plan_id=? ORDER BY joined_at, id`).all(teamId) as Record<string, unknown>[])
      .map((member) => ({
        ...mapRow(member),
        roles: (this.db.prepare(`SELECT role, scope_json, created_at, ended_at
          FROM os_team_plan_roles WHERE participant_id=? ORDER BY created_at, role`)
          .all(member.id) as Record<string, unknown>[]).map(mapRow),
      }))
    const sessions = (this.db.prepare(`SELECT * FROM os_planning_sessions
      WHERE plan_id=? ORDER BY created_at`).all(teamId) as Record<string, unknown>[]).map(mapRow)
    const artifacts = (this.db.prepare(`SELECT * FROM os_planning_artifacts
      WHERE plan_id=? ORDER BY round_number, created_at, id`).all(teamId) as Record<string, unknown>[])
      .map(mapRow)
    const bindings = (this.db.prepare(`SELECT * FROM os_team_work_bindings
      WHERE plan_id=? ORDER BY created_at`).all(teamId) as Record<string, unknown>[]).map(mapRow)
    const delegations = (this.db.prepare(`SELECT * FROM os_team_delegations
      WHERE plan_id=? ORDER BY created_at`).all(teamId) as Record<string, unknown>[]).map(mapRow)
    const integration = this.db.prepare(`SELECT * FROM os_team_integrations
      WHERE plan_id=?`).get(teamId) as Record<string, unknown> | undefined
    const conflicts = (this.db.prepare(`SELECT * FROM os_conflicts
      WHERE plan_id=? ORDER BY updated_at DESC`).all(teamId) as Record<string, unknown>[])
      .map((row) => this.conflictDetail(String(row.id)))
    const leases = (this.db.prepare(`SELECT * FROM os_work_leases
      WHERE plan_id=? ORDER BY acquired_at`).all(teamId) as Record<string, unknown>[]).map(mapRow)
    return {
      ...team,
      members,
      sessions,
      artifacts,
      bindings,
      delegations,
      integration: integration ? mapRow(integration) : null,
      conflicts,
      leases,
    }
  }

  listBoardTeams(boardId: number): Record<string, unknown>[] {
    this.requireBoard(positiveInteger(boardId, 'board id'))
    return (this.db.prepare(`SELECT id FROM os_team_plans
      WHERE board_id=? ORDER BY updated_at DESC, id`).all(boardId) as Array<{ id: string }>)
      .map((row) => this.getTeam(row.id))
  }

  listBoardConflicts(boardId: number, status?: string): Record<string, unknown>[] {
    this.requireBoard(positiveInteger(boardId, 'board id'))
    const rows = status
      ? this.db.prepare(`SELECT id FROM os_conflicts WHERE board_id=? AND status=?
          ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
          WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC`).all(boardId, status)
      : this.db.prepare(`SELECT id FROM os_conflicts WHERE board_id=?
          ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
          WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC`).all(boardId)
    return (rows as Array<{ id: string }>).map((row) => this.conflictDetail(row.id))
  }

  visualization(boardId: number): {
    nodes: Array<Record<string, unknown>>
    edges: Array<Record<string, unknown>>
    needs_you: Array<Record<string, unknown>>
  } {
    const teams = this.listBoardTeams(boardId)
    const nodes: Array<Record<string, unknown>> = []
    const edges: Array<Record<string, unknown>> = []
    for (const team of teams) {
      nodes.push({ id: team.id, kind: 'planning_team', label: team.name, status: team.status })
      for (const member of team.members as Array<Record<string, unknown>>) {
        nodes.push({
          id: member.id,
          kind: 'member',
          profile_id: member.agent_profile_id,
          roles: (member.roles as Array<Record<string, unknown>>).map((role) => role.role),
        })
        edges.push({ from: team.id, to: member.id, kind: 'participant' })
      }
      for (const delegation of team.delegations as Array<Record<string, unknown>>) {
        nodes.push({ id: delegation.id, kind: 'delegation', status: delegation.status })
        edges.push({ from: team.id, to: delegation.id, kind: 'delegates' })
        edges.push({ from: delegation.id, to: delegation.participant_id, kind: 'assigned_to' })
      }
      for (const conflict of team.conflicts as Array<Record<string, unknown>>) {
        nodes.push({
          id: conflict.id,
          kind: 'conflict',
          label: conflict.summary,
          severity: conflict.severity,
          status: conflict.status,
        })
        edges.push({ from: team.id, to: conflict.id, kind: 'has_conflict' })
        for (const participant of conflict.participants as Array<Record<string, unknown>>) {
          edges.push({ from: conflict.id, to: participant.participant_id, kind: 'affects' })
        }
      }
    }
    const needsYou = this.attention.listBoard(boardId)
      .filter((item) => item.kind === 'team.conflict')
      .map((item) => ({ ...item }))
    return { nodes, edges, needs_you: needsYou }
  }

  private conflictKnowledgeSource(
    conflict: Record<string, unknown>,
    resolution: Record<string, unknown>,
  ): Record<string, unknown> {
    const plan = this.requireTeam(String(conflict.plan_id))
    const proposal = this.db.prepare(`SELECT id, kind, summary, details_json
      FROM os_conflict_proposals WHERE id=? AND conflict_id=?`)
      .get(resolution.proposal_id, conflict.id) as Record<string, unknown> | undefined
    if (!proposal) throw new ConflictError('conflict knowledge exact proposal is missing')
    return {
      schema_version: 1,
      source_kind: 'conflict_resolution',
      board_id: conflict.board_id,
      plan_id: conflict.plan_id,
      canonical_team_id: plan.team_id,
      card_id: plan.card_id,
      conflict_id: conflict.id,
      discussion_id: conflict.discussion_id,
      conflict_kind: conflict.kind,
      severity: conflict.severity,
      conflict_summary: conflict.summary,
      causal_job_ids: parseJson(conflict.causal_job_ids_json, []),
      affected_resources: parseJson(conflict.affected_resources_json, []),
      detection_evidence: parseJson(conflict.detection_evidence_json, {}),
      resolution_id: resolution.id,
      proposal: {
        id: proposal.id,
        kind: proposal.kind,
        summary: proposal.summary,
        details: parseJson(proposal.details_json, {}),
      },
      arbiter: { type: resolution.arbiter_type, id: resolution.arbiter_id },
      rationale: resolution.rationale,
      follow_up_actions: parseJson(resolution.follow_up_actions_json, []),
      integration_member_id: resolution.integration_member_id,
      human_override_id: resolution.human_override_id,
      resolved_at: conflict.resolved_at,
    }
  }

  private validateConflictKnowledgePromotion(input: {
    boardId: number
    cardId: number | null
    conflictId: string
    resolutionId: string
    exactSource: Record<string, unknown>
    sourceSha256: string
    sourceId: string
    chunkId: string
    repositoryHeadSha: string
  }): void {
    const retained = this.db.prepare(`SELECT source.source_kind, source.normalized_locator,
        source.source_revision, source.content_sha256, source.access_scope_json,
        source.targets_json, source.provenance_json,
        chunk.content, chunk.content_sha256 AS chunk_content_sha256
      FROM knowledge_sources source
      JOIN knowledge_chunks chunk
        ON chunk.board_id=source.board_id AND chunk.source_id=source.id
      WHERE source.board_id=? AND source.id=? AND chunk.id=?`)
      .get(input.boardId, input.sourceId, input.chunkId) as Record<string, unknown> | undefined
    const expectedLocator = `conflicts/${input.conflictId}/resolutions/${input.resolutionId}.json`
    const accessScope = retained
      ? parseJson<Record<string, unknown>>(retained.access_scope_json, {})
      : null
    const targets = retained
      ? parseJson<Record<string, unknown>>(retained.targets_json, {})
      : null
    const provenance = retained
      ? parseJson<Record<string, unknown>>(retained.provenance_json, {})
      : null
    if (!retained
      || retained.source_kind !== 'decision'
      || retained.normalized_locator !== expectedLocator
      || retained.source_revision !== input.sourceSha256
      || retained.content_sha256 !== input.sourceSha256
      || retained.chunk_content_sha256 !== input.sourceSha256
      || retained.content !== stableJson(input.exactSource)
      || !accessScope || accessScope.kind !== 'board'
      || !targets || Number(targets.board_id) !== input.boardId
      || nullableNumber(targets.card_id) !== input.cardId
      || !provenance || provenance.base_commit_sha !== input.repositoryHeadSha
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.repositoryHeadSha)) {
      throw new ConflictError('canonical conflict Knowledge promotion evidence is incomplete')
    }
  }

  private validateCausalJobs(
    team: Record<string, unknown>,
    values: string[],
  ): string[] {
    const boardId = Number(team.board_id)
    const cardId = nullableNumber(team.card_id)
    const binding = this.db.prepare(`SELECT exclusive_assignment_id FROM os_team_work_bindings
      WHERE plan_id=? AND status='active'`).get(team.id) as
      { exclusive_assignment_id: string } | undefined
    const normalized = [...new Set(values)].sort()
    for (const jobId of normalized) {
      const job = this.db.prepare(`SELECT board_id, card_id, job_assignment_id,
          assigned_profile_id, assignment_market_version
        FROM jobs WHERE id=?`).get(jobId) as Record<string, unknown> | undefined
      if (!job || Number(job.board_id) !== boardId
        || (cardId !== null && Number(job.card_id) !== cardId)
        || typeof job.job_assignment_id !== 'string'
        || typeof job.assigned_profile_id !== 'string'
        || !Number.isSafeInteger(job.assignment_market_version)) {
        throw new ValidationError('causal job must retain a canonical assignment in plan scope')
      }
      if (binding && job.job_assignment_id !== binding.exclusive_assignment_id) {
        throw new ValidationError('causal job does not belong to the collaborative plan binding')
      }
    }
    return normalized
  }

  private validateAffectedResources(
    team: Record<string, unknown>,
    values: Array<{ kind: ConflictResourceKind; key: string }>,
  ): Array<{ kind: ConflictResourceKind; key: string }> {
    if (!Array.isArray(values) || values.length === 0 || values.length > 200) {
      throw new ValidationError('affected resources must contain between 1 and 200 identities')
    }
    const boardId = Number(team.board_id)
    const cardId = nullableNumber(team.card_id)
    const binding = this.db.prepare(`SELECT exclusive_assignment_id FROM os_team_work_bindings
      WHERE plan_id=? AND status='active'`).get(team.id) as
      { exclusive_assignment_id: string } | undefined
    const seen = new Set<string>()
    const resources: Array<{ kind: ConflictResourceKind; key: string }> = []
    for (const value of values) {
      if (!value || typeof value !== 'object') throw new ValidationError('affected resource is invalid')
      const kind = enumValue(value.kind, CONFLICT_RESOURCE_KINDS, 'affected resource kind')
      const key = boundedText(value.key, 'affected resource key', 512)
      if (kind === 'path') {
        const normalized = path.posix.normalize(key)
        if (path.posix.isAbsolute(key) || key.includes('\\') || normalized !== key
          || normalized === '..' || normalized.startsWith('../')
          || normalized.split('/').some((part) => part === '.git' || !part)) {
          throw new ValidationError('affected path must be a normalized repository-relative identity')
        }
      } else if (kind === 'branch') {
        if (key.startsWith('-') || key.endsWith('.') || key.endsWith('.lock')
          || key.includes('..') || key.includes('@{')
          || /[\s~^:?*[\]\\]/u.test(key)) {
          throw new ValidationError('affected branch identity is invalid')
        }
      } else if (kind === 'workspace') {
        const workspace = this.db.prepare(`SELECT board_id, card_id FROM workspaces WHERE id=?`)
          .get(key) as { board_id: number; card_id: number | null } | undefined
        if (!workspace || workspace.board_id !== boardId
          || (cardId !== null && workspace.card_id !== null && workspace.card_id !== cardId)) {
          throw new ValidationError('affected workspace is outside plan scope')
        }
      } else if (kind === 'card') {
        if (!/^[1-9]\d*$/u.test(key)) throw new ValidationError('affected card identity is invalid')
        const resourceCardId = Number(key)
        const card = this.db.prepare('SELECT board_id FROM cards WHERE id=?').get(resourceCardId) as
          { board_id: number } | undefined
        if (!card || card.board_id !== boardId || (cardId !== null && resourceCardId !== cardId)) {
          throw new ValidationError('affected card is outside plan scope')
        }
      } else if (kind === 'job') {
        this.validateCausalJobs(team, [key])
      } else {
        const assignment = this.db.prepare(`SELECT board_id, card_id FROM job_market_assignments
          WHERE id=?`).get(key) as { board_id: number; card_id: number } | undefined
        if (!assignment || assignment.board_id !== boardId
          || (cardId !== null && assignment.card_id !== cardId)
          || (binding && binding.exclusive_assignment_id !== key)) {
          throw new ValidationError('affected assignment is outside plan scope')
        }
      }
      const identity = `${kind}\u0000${key}`
      if (!seen.has(identity)) {
        seen.add(identity)
        resources.push({ kind, key })
      }
    }
    return resources.sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key))
  }

  private memberHasRole(memberId: string, role: PlanningTeamRole): boolean {
    return !!this.db.prepare(`SELECT 1 FROM os_team_plan_roles
      WHERE participant_id=? AND role=? AND ended_at IS NULL`).get(memberId, role)
  }

  private participantSnapshot(planId: string): Array<Record<string, unknown>> {
    return (this.db.prepare(`SELECT participant.id, participant.agent_profile_id,
      participant.membership_id, participant.joined_at, profile.name, profile.status
      FROM os_team_plan_participants participant
      JOIN agent_profiles profile ON profile.id=participant.agent_profile_id
      WHERE participant.plan_id=? AND participant.status='active'
      ORDER BY participant.id`).all(planId) as Record<string, unknown>[]).map(mapRow)
  }

  private roleSnapshot(planId: string): Array<Record<string, unknown>> {
    return (this.db.prepare(`SELECT role.id, role.participant_id, role.role,
      role.scope_json, role.created_at
      FROM os_team_plan_roles role
      WHERE role.plan_id=? AND role.ended_at IS NULL
      ORDER BY role.participant_id, role.role`).all(planId) as Record<string, unknown>[]).map(mapRow)
  }

  private conflictDetail(conflictId: string): Record<string, unknown> {
    const conflict = mapRow(this.requireConflict(conflictId))
    const participants = (this.db.prepare(`SELECT * FROM os_conflict_participants
      WHERE conflict_id=? ORDER BY created_at, id`).all(conflictId) as Record<string, unknown>[])
      .map(mapRow)
    const proposals = (this.db.prepare(`SELECT * FROM os_conflict_proposals
      WHERE conflict_id=? ORDER BY created_at, id`).all(conflictId) as Record<string, unknown>[])
      .map(mapRow)
    const resolution = this.db.prepare(`SELECT * FROM os_conflict_resolutions
      WHERE conflict_id=?`).get(conflictId) as Record<string, unknown> | undefined
    const knowledgeCandidates = (this.db.prepare(`SELECT * FROM os_conflict_knowledge_candidates
      WHERE conflict_id=? ORDER BY created_at, id`).all(conflictId) as Record<string, unknown>[])
      .map(mapRow)
    return {
      ...conflict,
      participants,
      proposals,
      resolution: resolution ? mapRow(resolution) : null,
      knowledge_candidates: knowledgeCandidates,
    }
  }

  private normalizeParticipants(
    boardId: number,
    canonicalTeamId: string,
    values: PlanningParticipantInput[],
    participantBudget: number,
  ): Array<{
    profileId: string
    membershipId: string
    roles: PlanningTeamRole[]
    scope: Record<string, unknown>
  }> {
    if (!Array.isArray(values) || values.length < 2) {
      throw new ValidationError('planning teams require at least two explicit participants')
    }
    if (values.length > participantBudget) {
      throw new ValidationError('explicit participants exceed the participant budget')
    }
    const seen = new Set<string>()
    const normalized = values.map((participant) => {
      const profileId = boundedText(participant.profileId, 'participant profile id', 200)
      if (seen.has(profileId)) throw new ValidationError('planning participants must be unique')
      seen.add(profileId)
      const profile = this.db.prepare(`SELECT board_id, status FROM agent_profiles WHERE id=?`)
        .get(profileId) as { board_id: number; status: string } | undefined
      if (!profile || profile.board_id !== boardId || profile.status !== 'active') {
        throw new ValidationError('planning participant must be an active profile on the same board')
      }
      const membership = this.db.prepare(`SELECT id FROM os_team_memberships
        WHERE team_id=? AND agent_profile_id=? AND state='active'
        ORDER BY effective_from DESC LIMIT 1`).get(canonicalTeamId, profileId) as
        { id: string } | undefined
      if (!membership) {
        throw new ValidationError('planning participant requires active canonical team membership')
      }
      const roles = [...new Set(participant.roles.map((role) =>
        enumValue(role, PLANNING_TEAM_ROLES, 'planning team role')))]
      if (!roles.length) throw new ValidationError('each planning participant requires an explicit role')
      return {
        profileId,
        membershipId: membership.id,
        roles,
        scope: boundedJsonObject(participant.scope ?? {}, 'participant role scope'),
      }
    })
    const facilitators = normalized.filter((participant) => participant.roles.includes('facilitator'))
    if (facilitators.length !== 1) throw new ValidationError('planning teams require exactly one facilitator')
    return normalized
  }

  private validateTeamScope(
    boardId: number,
    organizationTeamId: string | null,
    cardId: number | null,
  ): void {
    if (cardId !== null && !this.db.prepare('SELECT 1 FROM cards WHERE id=? AND board_id=?')
      .get(cardId, boardId)) throw new ValidationError('planning card belongs to another board')
    if (organizationTeamId !== null && !this.db.prepare(`SELECT 1 FROM os_teams team
      JOIN os_organizations organization ON organization.id=team.organization_id
      WHERE team.id=? AND organization.board_id=? AND team.status='active'`)
      .get(organizationTeamId, boardId)) {
      throw new ValidationError('organization team belongs to another board or is inactive')
    }
  }

  private validateArtifactFanout(
    teamId: string,
    kind: PlanningArtifactKind,
    sourceArtifactIds: string[],
    recipientMemberIds: string[],
    wakeCost: number,
  ): void {
    for (const recipient of recipientMemberIds) this.requireActiveMember(teamId, recipient)
    if (kind === 'digest') {
      if (!sourceArtifactIds.length) throw new ValidationError('digest requires exact source artifact ids')
      if (wakeCost !== recipientMemberIds.length) {
        throw new ValidationError('digest wake cost must equal its explicit recipient count')
      }
      return
    }
    if (recipientMemberIds.length || wakeCost !== 0) {
      throw new ValidationError('only digest artifacts may wake explicit recipients')
    }
  }

  private requireArtifactRole(memberId: string, kind: PlanningArtifactKind): void {
    const roles: PlanningTeamRole[] = kind === 'critique'
      ? ['researcher', 'reviewer', 'facilitator']
      : kind === 'synthesis'
        ? ['facilitator']
        : kind === 'digest'
          ? ['facilitator', 'synthesizer', 'integrator']
          : kind === 'plan'
            ? ['facilitator']
            : PLANNING_TEAM_ROLES.slice() as PlanningTeamRole[]
    this.requireAnyRole(memberId, roles)
  }

  private requireAnyRole(memberId: string, roles: readonly PlanningTeamRole[]): void {
    const placeholders = roles.map(() => '?').join(',')
    const found = this.db.prepare(`SELECT 1 FROM os_team_plan_roles
      WHERE participant_id=? AND role IN (${placeholders}) AND ended_at IS NULL LIMIT 1`)
      .get(memberId, ...roles)
    if (!found) throw new ConflictError(`planning action requires one of roles: ${roles.join(', ')}`)
  }

  private escalateSession(
    session: Record<string, unknown>,
    reason: string,
    actor: ActorIdentity,
    correlationId?: string | null,
  ): Record<string, unknown> {
    const team = this.requireTeam(String(session.plan_id))
    const at = timestamp()
    const escalationRef = `planning-escalation:${session.id}`
    const changed = this.db.prepare(`UPDATE os_planning_sessions SET status='escalated',
      version=version+1, stop_reason=?, escalation_ref=?, updated_at=?, completed_at=?
      WHERE id=? AND status='running' AND version=?`)
      .run(reason, escalationRef, at, at, session.id, session.version)
    if (changed.changes !== 1) throw new ConflictError('planning session changed concurrently')
    this.db.prepare(`UPDATE os_team_plans SET status='escalated', updated_at=?, completed_at=?
      WHERE id=?`).run(at, at, team.id)
    this.attention.create({
      boardId: Number(team.board_id),
      cardId: nullableNumber(team.card_id),
      kind: 'team.planning_escalation',
      severity: 'high',
      title: 'Bounded team planning needs human attention',
      detail: reason,
    })
    this.events.append({
      boardId: Number(team.board_id),
      cardId: nullableNumber(team.card_id),
      actor,
      correlationId,
      kind: 'planning.escalated',
      source: 'planning-team-service',
      payload: { team_id: team.id, session_id: session.id, reason, escalation_ref: escalationRef },
    })
    return mapRow(this.requireSession(String(session.id)))
  }

  private requireBoard(boardId: number): void {
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(boardId)) {
      throw new NotFoundError('board not found')
    }
  }

  private requireTeam(teamId: string): Record<string, unknown> {
    return this.requireRow('os_team_plans', boundedText(teamId, 'team plan id', 200), 'team plan')
  }

  private requireSession(sessionId: string): Record<string, unknown> {
    return this.requireRow('os_planning_sessions', sessionId, 'planning session')
  }

  private requireCurrentSession(teamId: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT * FROM os_planning_sessions WHERE plan_id=?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(teamId) as Record<string, unknown> | undefined
    if (!row) throw new NotFoundError('planning session not found')
    return row
  }

  private requireRunningSession(teamId: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT * FROM os_planning_sessions
      WHERE plan_id=? AND status='running' ORDER BY created_at DESC LIMIT 1`)
      .get(teamId) as Record<string, unknown> | undefined
    if (!row) throw new ConflictError('planning session is not running')
    return row
  }

  private requireActiveMember(teamId: string, memberId: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT * FROM os_team_plan_participants
      WHERE id=? AND plan_id=? AND status='active'`)
      .get(boundedText(memberId, 'planning member id', 200), teamId) as
      Record<string, unknown> | undefined
    if (!row) throw new ValidationError('planning member is not an active participant of this team')
    return row
  }

  private requireConflict(conflictId: string): Record<string, unknown> {
    return this.requireRow('os_conflicts', boundedText(conflictId, 'conflict id', 200), 'conflict')
  }

  private requireConflictParticipant(
    conflictId: string,
    memberId: string,
  ): Record<string, unknown> {
    const participant = this.db.prepare(`SELECT member.* FROM os_conflict_participants participant
      JOIN os_team_plan_participants member ON member.id=participant.participant_id
      WHERE participant.conflict_id=? AND participant.participant_id=? AND member.status='active'
      LIMIT 1`).get(conflictId, memberId) as Record<string, unknown> | undefined
    if (!participant) throw new ValidationError('member is not a participant in this conflict')
    return participant
  }

  private requireRow(table: string, id: string, label: string): Record<string, unknown> {
    if (!Object.keys(ROW_TABLES).includes(table)) throw new Error('unsupported table')
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as
      Record<string, unknown> | undefined
    if (!row) throw new NotFoundError(`${label} not found`)
    return row
  }

  private runCommand<T>(
    boardId: number,
    idempotencyKey: string,
    commandKind: string,
    fingerprintValue: unknown,
    operation: () => T,
  ): CommandResult<T> {
    const requestSha256 = sha256(stableJson(fingerprintValue))
    const replay = this.commandReplay<T>(boardId, idempotencyKey, commandKind, requestSha256)
    if (replay) return { result: replay, replayed: true }
    return this.db.transaction(() => {
      const raced = this.commandReplay<T>(boardId, idempotencyKey, commandKind, requestSha256)
      if (raced) return { result: raced, replayed: true }
      const result = operation()
      this.db.prepare(`INSERT INTO os_team_command_receipts
        (board_id, idempotency_key, command_kind, request_sha256, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(boardId, idempotencyKey, commandKind, requestSha256, stableJson(result), timestamp())
      return { result, replayed: false }
    })()
  }

  private commandReplay<T>(
    boardId: number,
    idempotencyKey: string,
    commandKind: string,
    requestSha256: string,
  ): T | null {
    const row = this.db.prepare(`SELECT command_kind, request_sha256, result_json
      FROM os_team_command_receipts WHERE board_id=? AND idempotency_key=?`)
      .get(boardId, idempotencyKey) as
      { command_kind: string; request_sha256: string; result_json: string } | undefined
    if (!row) return null
    if (row.command_kind !== commandKind || row.request_sha256 !== requestSha256) {
      throw new ConflictError('team command idempotency key was already used for different intent')
    }
    return parseJson(row.result_json, null) as T
  }
}

const ROW_TABLES = Object.freeze({
  os_team_plans: true,
  os_planning_sessions: true,
  os_planning_artifacts: true,
  os_planning_overrides: true,
  os_team_work_bindings: true,
  os_team_delegations: true,
  os_team_integrations: true,
  os_conflicts: true,
  os_conflict_proposals: true,
  os_conflict_resolutions: true,
  os_work_leases: true,
  os_conflict_knowledge_candidates: true,
})

function planningBudgetReason(
  session: Record<string, unknown>,
  wakeCost: number,
  tokenCost: number,
  costCents: number,
): string | null {
  if (Number(session.wakes_used) + wakeCost > Number(session.wake_budget)) return 'planning wake budget exhausted'
  if (Number(session.tokens_used) + tokenCost > Number(session.token_budget)) return 'planning token budget exhausted'
  if (Number(session.cost_used_cents) + costCents > Number(session.cost_budget_cents)) {
    return 'planning cost budget exhausted'
  }
  return null
}

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = { ...row }
  for (const [key, value] of Object.entries(mapped)) {
    if (key.endsWith('_json')) {
      mapped[key.slice(0, -5)] = parseJson(value, key.endsWith('s_json') ? [] : {})
      delete mapped[key]
    }
  }
  return mapped
}

function normalizeActor(actor: ActorIdentity): ActorIdentity {
  if (!actor || typeof actor.type !== 'string' || !actor.type.trim()) {
    throw new ValidationError('actor type is required')
  }
  const type = boundedText(actor.type, 'actor type', 64)
  if (actor.id == null) throw new ValidationError('authenticated actor id is required')
  const id = boundedText(actor.id, 'actor id', 256)
  return { type, id }
}

function requireHumanActor(actor: ActorIdentity): ActorIdentity & { type: 'human'; id: string } {
  const normalized = normalizeActor(actor)
  if (normalized.type !== 'human' || !normalized.id) {
    throw new ConflictError('this action requires an explicitly identified human actor')
  }
  return { type: 'human', id: normalized.id }
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new ValidationError(`${label} is required`)
  const normalized = value.trim()
  if (!normalized || normalized.length > max) {
    throw new ValidationError(`${label} must contain 1-${max} characters`)
  }
  return normalized
}

function optionalText(value: unknown, label: string, max: number): string | null {
  return value == null ? null : boundedText(value, label, max)
}

function positiveInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER)
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}`)
  }
  return Number(value)
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ValidationError(`${label} must be one of ${values.join(', ')}`)
  }
  return value as T
}

function stringList(value: unknown, label: string, maxItemLength: number): string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`)
  const normalized = value.map((item) => boundedText(item, label, maxItemLength))
  if (normalized.length > 500) throw new ValidationError(`${label} exceeds 500 items`)
  if (new Set(normalized).size !== normalized.length) throw new ValidationError(`${label} contains duplicates`)
  return normalized
}

function boundedJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`)
  }
  const encoded = stableJson(value)
  if (encoded.length > 64_000) throw new ValidationError(`${label} exceeds 64KB`)
  return JSON.parse(encoded) as Record<string, unknown>
}

function validTimestamp(value: unknown, label: string): string {
  const normalized = boundedText(value, label, 80)
  if (!Number.isFinite(Date.parse(normalized))) throw new ValidationError(`${label} must be an ISO timestamp`)
  return normalized
}

function futureTimestamp(value: unknown, label: string): string {
  const normalized = validTimestamp(value, label)
  if (Date.parse(normalized) <= Date.now()) throw new ValidationError(`${label} must be in the future`)
  return normalized
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value)
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? 'null'
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]))
  }
  return value
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

import type Database from 'better-sqlite3'
import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest } from 'fastify'
import { AgentOsError, ForbiddenError, NotFoundError, ValidationError } from './errors.js'
import { resolveIdempotencyKey } from './idempotency.js'
import { objectBody, positiveId } from './json.js'
import {
  PlanningTeamService,
  type ConflictDiscussionAdapter,
  type ConflictKnowledgePromotionAdapter,
} from './team-planning.js'
import { CanonicalConflictKnowledgeAdapter } from './team-conflict-knowledge.js'
import type { AgentMutationPrincipal } from './agent-mutation-principal.js'

export interface TeamPlanningRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  discussionAdapter: ConflictDiscussionAdapter
  conflictKnowledgeAdapter?: ConflictKnowledgePromotionAdapter
  isOperator?: (request: FastifyRequest) => boolean
  resolveAgentPrincipal?: (request: FastifyRequest) => AgentMutationPrincipal | null
}

type CommandHandler = (body: Record<string, unknown>) => unknown

export const teamPlanningPlugin: FastifyPluginAsync<TeamPlanningRouteOptions> = async (
  app,
  options,
) => {
  const service = new PlanningTeamService(options.db, {
    discussionAdapter: options.discussionAdapter,
    conflictKnowledgeAdapter:
      options.conflictKnowledgeAdapter ?? new CanonicalConflictKnowledgeAdapter(options.db),
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AgentOsError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code })
    }
    if (error && typeof error === 'object' && 'validation' in error && error.validation) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'request validation failed',
        code: 'validation_error',
      })
    }
    return reply.send(error)
  })

  app.get<{ Params: { boardId: string } }>('/boards/:boardId/team-plans', (request) => ({
    plans: service.listBoardTeams(positiveId(request.params.boardId, 'board id')),
  }))

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/team-plans',
    (request, reply) => {
      const boardId = positiveId(request.params.boardId, 'board id')
      const body = mutationBody(request, request.body, options, {
        actorType: 'operator',
        boardId,
        participantListField: 'participants',
      })
      const result = service.createPlan({
        ...body,
        boardId,
      } as never)
      return reply.code(result.replayed ? 200 : 201).send({ result })
    },
  )

  app.get<{ Params: { planId: string } }>('/team-plans/:planId', (request) => ({
    plan: service.getTeam(requiredText(request.params.planId, 'plan id')),
  }))

  app.get<{ Params: { boardId: string }; Querystring: { status?: string } }>(
    '/boards/:boardId/team-conflicts',
    (request) => ({
      conflicts: service.listBoardConflicts(
        positiveId(request.params.boardId, 'board id'),
        request.query.status,
      ),
    }),
  )

  app.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/team-visualization',
    (request) => service.visualization(positiveId(request.params.boardId, 'board id')),
  )

  const planCommands: Readonly<Record<string, CommandHandler>> = Object.freeze({
    'artifact.record': (body) => service.recordArtifact(body as never),
    'round.advance': (body) => service.advanceRound(body as never),
    'override.record': (body) => service.recordHumanOverride(body as never),
    'work.delegate': (body) => service.delegateWork(body as never),
    'work.transition': (body) => service.transitionDelegation(body as never),
    'integration.record': (body) => service.recordIntegratedDelivery(body as never),
    'conflict.open': (body) => service.openConflict(body as never),
    'lease.create': (body) => service.createWorkLease(body as never),
  })

  app.post<{
    Params: { planId: string; command: string }
    Body: unknown
  }>('/team-plans/:planId/:command', (request, reply) => {
    const handler = planCommands[request.params.command]
    if (!handler) throw new NotFoundError('team planning command not found')
    const raw = objectBody(request.body)
    const human = request.params.command === 'override.record'
      || (request.params.command === 'lease.create' && raw.mode === 'enforced')
    const memberField = PLAN_COMMAND_MEMBER_FIELDS[request.params.command]
    const body = mutationBody(request, raw, options, {
      actorType: human ? 'human' : 'operator',
      operatorOnly: human,
      planId: request.params.planId,
      memberField,
      memberListField: request.params.command === 'conflict.open'
        ? 'participantMemberIds'
        : undefined,
    })
    const result = handler({ ...body, teamId: request.params.planId }) as
      Record<string, unknown>
    return reply.code(result.replayed ? 200 : 201).send({ result })
  })

  app.post<{ Params: { conflictId: string }; Body: unknown }>(
    '/team-conflicts/:conflictId/proposals',
    (request, reply) => {
      const body = mutationBody(request, request.body, options, {
        actorType: 'operator',
        conflictId: request.params.conflictId,
        memberField: 'proposedByMemberId',
      })
      const result = service.addConflictProposal({
        ...body,
        conflictId: request.params.conflictId,
      } as never)
      return reply.code(result.replayed ? 200 : 201).send({ result })
    },
  )

  app.post<{ Params: { conflictId: string }; Body: unknown }>(
    '/team-conflicts/:conflictId/resolve',
    (request, reply) => {
      const body = mutationBody(request, request.body, options, {
        actorType: 'human',
        conflictId: request.params.conflictId,
        memberField: 'arbiterMemberId',
      })
      const result = service.resolveConflict({
        ...body,
        conflictId: request.params.conflictId,
      } as never)
      return reply.code(result.replayed ? 200 : 201).send({ result })
    },
  )

  app.post<{ Params: { conflictId: string }; Body: unknown }>(
    '/team-conflicts/:conflictId/knowledge-candidates',
    (request, reply) => {
      const body = mutationBody(request, request.body, options, {
        actorType: 'human',
        conflictId: request.params.conflictId,
      })
      const result = service.requestConflictKnowledgePromotion({
        ...body,
        conflictId: request.params.conflictId,
      } as never)
      return reply.code(result.replayed ? 200 : 201).send({ result })
    },
  )

  app.post<{ Params: { candidateId: string }; Body: unknown }>(
    '/team-conflict-knowledge-candidates/:candidateId/review',
    (request, reply) => {
      const body = mutationBody(request, request.body, options, {
        actorType: 'human',
        operatorOnly: true,
      })
      const result = service.reviewConflictKnowledgeCandidate({
        ...body,
        candidateId: request.params.candidateId,
      } as never)
      return reply.code(result.replayed ? 200 : 201).send({ result })
    },
  )
}

const PLAN_COMMAND_MEMBER_FIELDS: Readonly<Record<string, string | undefined>> = Object.freeze({
  'artifact.record': 'authorMemberId',
  'round.advance': undefined,
  'override.record': undefined,
  'work.delegate': 'delegatedByMemberId',
  'work.transition': 'memberId',
  'integration.record': 'integratorMemberId',
  'conflict.open': undefined,
  'lease.create': 'memberId',
})

interface MutationScope {
  actorType: 'operator' | 'human'
  operatorOnly?: boolean
  boardId?: number
  planId?: string
  conflictId?: string
  memberField?: string
  memberListField?: string
  participantListField?: string
}

function mutationBody(
  request: FastifyRequest,
  value: unknown,
  options: TeamPlanningRouteOptions,
  scope: MutationScope,
): Record<string, unknown> {
  const body = objectBody(value)
  const idempotencyKey = resolveIdempotencyKey({
    header: request.headers['idempotency-key'],
    rawHeaders: request.raw.rawHeaders,
    snake: body.idempotency_key,
    camel: body.idempotencyKey,
  })
  let actor: { type: 'operator' | 'human' | 'agent'; id: string }
  if (options.isOperator?.(request)) {
    const principal = request.orchestraPrincipal
    if (!principal) throw new ForbiddenError('authenticated operator principal is required')
    actor = { type: scope.actorType, id: principal }
  } else {
    if (scope.operatorOnly) {
      throw new ForbiddenError('human operator authorization is required for this team command')
    }
    const principal = options.resolveAgentPrincipal?.(request)
    if (!principal) {
      throw new ForbiddenError('session-bound agent identity is required for team commands')
    }
    authorizeAgentScope(options.db, principal, body, scope)
    actor = { type: 'agent', id: principal.profileId }
  }
  return {
    ...body,
    actor,
    idempotencyKey,
    correlationId: optionalText(body.correlationId ?? body.correlation_id),
  }
}

function authorizeAgentScope(
  db: Database.Database,
  principal: AgentMutationPrincipal,
  body: Record<string, unknown>,
  scope: MutationScope,
): void {
  if (scope.boardId !== undefined) {
    if (principal.boardId !== scope.boardId) forbiddenTeamScope()
    const participants = scope.participantListField
      ? body[scope.participantListField]
      : undefined
    if (!Array.isArray(participants) || !participants.some((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const participant = value as Record<string, unknown>
      return (participant.profileId ?? participant.profile_id) === principal.profileId
    })) forbiddenTeamScope()
    return
  }

  const member = scope.planId
    ? db.prepare(`SELECT participant.id, plan.board_id
        FROM os_team_plan_participants participant
        JOIN os_team_plans plan ON plan.id=participant.plan_id
        WHERE participant.plan_id=? AND participant.agent_profile_id=?
          AND participant.status='active'`)
      .get(scope.planId, principal.profileId) as { id: string; board_id: number } | undefined
    : scope.conflictId
      ? db.prepare(`SELECT participant.id, conflict.board_id
          FROM os_conflict_participants affected
          JOIN os_team_plan_participants participant ON participant.id=affected.participant_id
          JOIN os_conflicts conflict ON conflict.id=affected.conflict_id
          WHERE affected.conflict_id=? AND participant.agent_profile_id=?
            AND participant.status='active'`)
        .get(scope.conflictId, principal.profileId) as { id: string; board_id: number } | undefined
      : undefined
  if (!member || member.board_id !== principal.boardId) forbiddenTeamScope()
  if (scope.memberField && body[scope.memberField] !== member.id) forbiddenTeamScope()
  if (scope.memberListField) {
    const memberIds = body[scope.memberListField]
    if (!Array.isArray(memberIds) || !memberIds.includes(member.id)) forbiddenTeamScope()
  }
}

function forbiddenTeamScope(): never {
  throw new ForbiddenError('agent credential is outside this explicit team participant scope')
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field} is required`)
  return value.trim()
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('correlation id must be a non-empty string')
  }
  return value.trim()
}

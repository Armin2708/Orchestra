import type Database from 'better-sqlite3'
import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest } from 'fastify'
import { AgentOsError, ForbiddenError, NotFoundError, ValidationError } from './errors.js'
import { resolveIdempotencyKey } from './idempotency.js'
import { objectBody, positiveId } from './json.js'
import {
  PlanningTeamService,
  type ConflictDiscussionAdapter,
} from './team-planning.js'

export interface TeamPlanningRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  discussionAdapter: ConflictDiscussionAdapter
  isOperator?: (request: FastifyRequest) => boolean
}

type CommandHandler = (body: Record<string, unknown>) => unknown

export const teamPlanningPlugin: FastifyPluginAsync<TeamPlanningRouteOptions> = async (
  app,
  options,
) => {
  const service = new PlanningTeamService(options.db, {
    discussionAdapter: options.discussionAdapter,
  })
  const isOperator = options.isOperator ?? (() => false)

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
      const body = mutationBody(request, request.body, isOperator, 'operator')
      const result = service.createPlan({
        ...body,
        boardId: positiveId(request.params.boardId, 'board id'),
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
    const body = mutationBody(request, raw, isOperator, human ? 'human' : 'operator')
    const result = handler({ ...body, teamId: request.params.planId }) as
      Record<string, unknown>
    return reply.code(result.replayed ? 200 : 201).send({ result })
  })

  app.post<{ Params: { conflictId: string }; Body: unknown }>(
    '/team-conflicts/:conflictId/proposals',
    (request, reply) => {
      const body = mutationBody(request, request.body, isOperator, 'operator')
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
      const body = mutationBody(request, request.body, isOperator, 'human')
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
      const body = mutationBody(request, request.body, isOperator, 'human')
      const result = service.requestConflictKnowledgePromotion({
        ...body,
        conflictId: request.params.conflictId,
      } as never)
      return reply.code(result.replayed ? 200 : 201).send({ result })
    },
  )
}

function mutationBody(
  request: FastifyRequest,
  value: unknown,
  isOperator: (request: FastifyRequest) => boolean,
  actorType: 'operator' | 'human',
): Record<string, unknown> {
  if (!isOperator(request)) {
    throw new ForbiddenError('operator authorization is required for team planning commands')
  }
  const body = objectBody(value)
  const idempotencyKey = resolveIdempotencyKey({
    header: request.headers['idempotency-key'],
    rawHeaders: request.raw.rawHeaders,
    snake: body.idempotency_key,
    camel: body.idempotencyKey,
  })
  const principal = request.orchestraPrincipal
  if (!principal) throw new ForbiddenError('authenticated operator principal is required')
  return {
    ...body,
    actor: { type: actorType, id: principal },
    idempotencyKey,
    correlationId: optionalText(body.correlationId ?? body.correlation_id),
  }
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

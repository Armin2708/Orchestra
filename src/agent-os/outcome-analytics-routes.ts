import type Database from 'better-sqlite3'
import type {
  FastifyPluginAsync,
  FastifyPluginOptions,
  FastifyRequest,
} from 'fastify'
import { AgentOsError, ForbiddenError, ValidationError } from './errors.js'
import { objectBody, positiveId } from './json.js'
import {
  OutcomeAnalyticsService,
  type ActivityObservationInput,
  type BenchmarkObservationInput,
  type BudgetPolicyInput,
  type OperationPlanInput,
  type UsageObservationInput,
} from './outcome-analytics.js'

export interface OutcomeAnalyticsRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  isOperator?: (request: FastifyRequest) => boolean
  publish?: (event: {
    board_id: number
    type: 'outcome_analytics'
    data: { kind: string; id: string }
  }) => void
}

/**
 * Isolated registrar. The central Agent OS composition layer should mount this
 * plugin under `/api/v1/os`; it performs no registration by import side effect.
 */
export const outcomeAnalyticsPlugin: FastifyPluginAsync<OutcomeAnalyticsRouteOptions> = async (
  app,
  options,
) => {
  const service = new OutcomeAnalyticsService(options.db)
  const isOperator = options.isOperator ?? (() => false)
  const inheritedBus = (app as typeof app & {
    bus?: { emit(event: 'event', payload: unknown): unknown }
  }).bus
  const publish = options.publish ?? ((event: {
    board_id: number
    type: 'outcome_analytics'
    data: { kind: string; id: string }
  }) => { inheritedBus?.emit('event', event) })
  const changed = (boardId: number, kind: string, id: unknown) => publish({
    board_id: boardId,
    type: 'outcome_analytics',
    data: { kind, id: String(id) },
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

  const operatorBody = (request: FastifyRequest, body: unknown): Record<string, unknown> => {
    if (!isOperator(request)) throw new ForbiddenError('operator authorization is required')
    return objectBody(body)
  }

  app.get<{
    Params: { boardId: string }
    Querystring: { since?: string; until?: string }
  }>('/boards/:boardId/outcomes/dashboard', (request) => service.dashboard(
    positiveId(request.params.boardId, 'board id'),
    { since: request.query.since, until: request.query.until },
  ))

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/outcomes/usage',
    (request, reply) => {
      const body = operatorBody(request, request.body)
      const result = service.recordUsage({
        ...body,
        boardId: positiveId(request.params.boardId, 'board id'),
      } as unknown as UsageObservationInput)
      changed(positiveId(request.params.boardId, 'board id'), 'usage.recorded', result.id)
      return reply.code(201).send({ result })
    },
  )

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/outcomes/activity',
    (request, reply) => {
      const body = operatorBody(request, request.body)
      const result = service.recordActivity({
        ...body,
        boardId: positiveId(request.params.boardId, 'board id'),
      } as unknown as ActivityObservationInput)
      changed(positiveId(request.params.boardId, 'board id'), 'activity.recorded', result.id)
      return reply.code(201).send({ result })
    },
  )

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/outcomes/budgets',
    (request, reply) => {
      const body = operatorBody(request, request.body)
      const result = service.setBudget({
        ...body,
        actor: request.orchestraPrincipal ?? 'operator',
        boardId: positiveId(request.params.boardId, 'board id'),
      } as unknown as BudgetPolicyInput)
      changed(positiveId(request.params.boardId, 'board id'), 'budget.updated', result.id)
      return reply.code(201).send({ result })
    },
  )

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/outcomes/budgets/evaluate',
    (request) => {
      const body = objectBody(request.body)
      return service.evaluateBudgets({
        boardId: positiveId(request.params.boardId, 'board id'),
        jobId: optionalText(body.jobId, 'jobId'),
        teamId: optionalText(body.teamId, 'teamId'),
        additionalProviderTokens: optionalInteger(body.additionalProviderTokens, 'additionalProviderTokens'),
        additionalContextTokens: optionalInteger(body.additionalContextTokens, 'additionalContextTokens'),
        fanout: optionalInteger(body.fanout, 'fanout'),
        planningRoundTokens: optionalInteger(body.planningRoundTokens, 'planningRoundTokens'),
      })
    },
  )

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/outcomes/operations',
    (request, reply) => {
      const body = operatorBody(request, request.body)
      const result = service.planOperation({
        ...body,
        requestedBy: request.orchestraPrincipal ?? 'operator',
        boardId: positiveId(request.params.boardId, 'board id'),
      } as unknown as OperationPlanInput)
      changed(positiveId(request.params.boardId, 'board id'), 'operation.planned', result.id)
      return reply.code(201).send({ result })
    },
  )

  app.post<{ Params: { operationId: string }; Body: unknown }>(
    '/outcomes/operations/:operationId/confirm',
    (request) => {
      operatorBody(request, request.body)
      const result = service.confirmOperation(
        request.params.operationId,
        request.orchestraPrincipal ?? 'operator',
      )
      changed(Number(result.board_id), 'operation.confirmed', result.id)
      return { result }
    },
  )

  app.get<{ Params: { operationId: string } }>(
    '/outcomes/operations/:operationId/authorization',
    (request) => ({ result: service.assertOperationAuthorized(request.params.operationId) }),
  )

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/outcomes/digests',
    (request, reply) => {
      const body = operatorBody(request, request.body)
      const result = service.createTeamDigest({
        id: requiredText(body.id, 'id'),
        boardId: positiveId(request.params.boardId, 'board id'),
        teamId: requiredText(body.teamId, 'teamId'),
        leaderProfileId: optionalText(body.leaderProfileId, 'leaderProfileId'),
        windowStart: requiredText(body.windowStart, 'windowStart'),
        windowEnd: requiredText(body.windowEnd, 'windowEnd'),
      })
      changed(positiveId(request.params.boardId, 'board id'), 'digest.created', result.id)
      return reply.code(201).send({ result })
    },
  )

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/outcomes/benchmarks',
    (request, reply) => {
      const body = operatorBody(request, request.body)
      const result = service.recordBenchmark({
        ...body,
        boardId: positiveId(request.params.boardId, 'board id'),
      } as unknown as BenchmarkObservationInput)
      changed(positiveId(request.params.boardId, 'board id'), 'benchmark.recorded', result.id)
      return reply.code(201).send({ result })
    },
  )

  app.get<{ Params: { boardId: string; suiteKey: string } }>(
    '/boards/:boardId/outcomes/benchmarks/:suiteKey',
    (request) => service.benchmarkComparison(
      positiveId(request.params.boardId, 'board id'),
      request.params.suiteKey,
    ),
  )
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field} is required`)
  return value.trim()
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredText(value, field)
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`)
  }
  return Number(value)
}

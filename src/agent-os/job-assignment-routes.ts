import type Database from 'better-sqlite3'
import type {
  FastifyPluginAsync,
  FastifyPluginOptions,
  FastifyRequest,
} from 'fastify'
import { AgentOsError, ForbiddenError, ValidationError } from './errors.js'
import {
  JobAssignmentService,
  type JobAssignmentStatus,
} from './job-assignments.js'
import { resolveIdempotencyKey } from './idempotency.js'
import { objectBody, positiveId } from './json.js'

export interface JobAssignmentRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  isOperator?: (request: FastifyRequest) => boolean
}

export const jobAssignmentPlugin: FastifyPluginAsync<JobAssignmentRouteOptions> = async (
  app,
  options,
) => {
  const assignments = new JobAssignmentService(options.db)
  const isOperator = options.isOperator ?? (() => true)

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

  app.get<{
    Params: { boardId: string }
    Querystring: {
      status?: string
      profile_id?: string
      workspace_id?: string
      card_id?: string
      limit?: string
    }
  }>('/boards/:boardId/assignments', (request) => ({
    assignments: assignments.listBoard(positiveId(request.params.boardId, 'board id'), {
      status: optionalText(request.query.status, 'status') as JobAssignmentStatus | undefined,
      profileId: optionalText(request.query.profile_id, 'profile_id'),
      workspaceId: optionalText(request.query.workspace_id, 'workspace_id'),
      cardId: optionalPositiveId(request.query.card_id, 'card_id'),
      limit: optionalPositiveId(request.query.limit, 'limit'),
    }),
  }))

  app.get<{ Params: { cardId: string } }>(
    '/cards/:cardId/assignments',
    (request) => ({
      assignments: assignments.history(positiveId(request.params.cardId, 'card id')),
    }),
  )

  app.get<{ Params: { cardId: string } }>(
    '/cards/:cardId/assignments/current',
    (request) => ({
      assignment: assignments.current(positiveId(request.params.cardId, 'card id')),
    }),
  )

  app.post<{ Params: { cardId: string }; Body: unknown }>(
    '/cards/:cardId/assignments/claim',
    (request, reply) => {
      const body = requestBody(request.body)
      const result = assignments.claim({
        cardId: positiveId(request.params.cardId, 'card id'),
        profileId: requiredAliasedText(body, 'profile_id', 'profileId'),
        workspaceId: optionalAliasedText(body, 'workspace_id', 'workspaceId'),
        expectedMarketVersion: requiredAliasedPositiveId(
          body,
          'expected_market_version',
          'expectedMarketVersion',
        ),
        reason: optionalAliasedText(body, 'reason'),
        ...mutation(request, body, isOperator),
      })
      return reply.code(result.replayed ? 200 : 201).send(result)
    },
  )

  app.post<{ Params: { cardId: string }; Body: unknown }>(
    '/cards/:cardId/assignments/assign',
    (request, reply) => {
      const body = requestBody(request.body)
      const result = assignments.assign({
        cardId: positiveId(request.params.cardId, 'card id'),
        profileId: requiredAliasedText(body, 'profile_id', 'profileId'),
        workspaceId: optionalAliasedText(body, 'workspace_id', 'workspaceId'),
        expectedMarketVersion: requiredAliasedPositiveId(
          body,
          'expected_market_version',
          'expectedMarketVersion',
        ),
        reason: optionalAliasedText(body, 'reason'),
        ...mutation(request, body, isOperator),
      })
      return reply.code(result.replayed ? 200 : 201).send(result)
    },
  )

  app.post<{
    Params: { cardId: string; assignmentId: string }
    Body: unknown
  }>('/cards/:cardId/assignments/:assignmentId/release', (request) => {
    const body = requestBody(request.body)
    return assignments.release({
      cardId: positiveId(request.params.cardId, 'card id'),
      assignmentId: request.params.assignmentId,
      expectedMarketVersion: requiredAliasedPositiveId(
        body,
        'expected_market_version',
        'expectedMarketVersion',
      ),
      expectedAssignmentVersion: requiredAliasedPositiveId(
        body,
        'expected_assignment_version',
        'expectedAssignmentVersion',
      ),
      reason: optionalAliasedText(body, 'reason'),
      ...mutation(request, body, isOperator),
    })
  })

  app.post<{
    Params: { cardId: string; assignmentId: string }
    Body: unknown
  }>('/cards/:cardId/assignments/:assignmentId/reassign', (request, reply) => {
    const body = requestBody(request.body)
    const result = assignments.reassign({
      cardId: positiveId(request.params.cardId, 'card id'),
      assignmentId: request.params.assignmentId,
      profileId: requiredAliasedText(body, 'profile_id', 'profileId'),
      workspaceId: optionalAliasedText(body, 'workspace_id', 'workspaceId'),
      expectedMarketVersion: requiredAliasedPositiveId(
        body,
        'expected_market_version',
        'expectedMarketVersion',
      ),
      expectedAssignmentVersion: requiredAliasedPositiveId(
        body,
        'expected_assignment_version',
        'expectedAssignmentVersion',
      ),
      reason: optionalAliasedText(body, 'reason'),
      ...mutation(request, body, isOperator),
    })
    return reply.code(result.replayed ? 200 : 201).send(result)
  })
}

function mutation(
  request: FastifyRequest,
  body: Record<string, unknown>,
  isOperator: (request: FastifyRequest) => boolean,
): {
  actor: { type: 'operator'; id: string }
  idempotencyKey: string
  correlationId: string | null
} {
  if (!isOperator(request)) {
    throw new ForbiddenError('operator authorization is required for this action')
  }
  const idempotencyKey = resolveIdempotencyKey({
    header: request.headers['idempotency-key'],
    rawHeaders: request.raw.rawHeaders,
    snake: body.idempotency_key,
    camel: body.idempotencyKey,
  })
  if (!idempotencyKey) throw new ValidationError('an idempotency key is required')
  return {
    actor: { type: 'operator', id: request.orchestraPrincipal ?? 'operator' },
    idempotencyKey,
    correlationId: optionalAliasedText(body, 'correlation_id', 'correlationId') ?? null,
  }
}

function requestBody(value: unknown): Record<string, unknown> {
  return objectBody(value)
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`)
  const normalized = value.trim()
  if (!normalized) throw new ValidationError(`${field} must not be empty`)
  return normalized
}

function optionalAliasedText(
  body: Record<string, unknown>,
  snake: string,
  camel = snake,
): string | null | undefined {
  const value = Object.hasOwn(body, snake) ? body[snake] : body[camel]
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ValidationError(`${snake} must be a string or null`)
  const normalized = value.trim()
  if (!normalized) return null
  return normalized
}

function requiredAliasedText(
  body: Record<string, unknown>,
  snake: string,
  camel: string,
): string {
  const value = optionalAliasedText(body, snake, camel)
  if (!value) throw new ValidationError(`${snake} is required`)
  return value
}

function requiredAliasedPositiveId(
  body: Record<string, unknown>,
  snake: string,
  camel: string,
): number {
  const value = Object.hasOwn(body, snake) ? body[snake] : body[camel]
  if (value === undefined || value === null || value === '') {
    throw new ValidationError(`${snake} is required`)
  }
  return positiveId(value, snake)
}

function optionalPositiveId(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return positiveId(value, field)
}

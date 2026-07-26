import type {
  FastifyPluginAsync,
  FastifyPluginOptions,
  FastifyRequest,
} from 'fastify'
import type Database from 'better-sqlite3'
import {
  AgentOsError,
  ForbiddenError,
  ValidationError,
} from './errors.js'
import { AgentHomeRetentionService } from './agent-home-retention.js'
import { resolveIdempotencyKey } from './idempotency.js'
import { objectBody, positiveId } from './json.js'

export interface AgentHomeRetentionRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  isOperator?: (request: FastifyRequest) => boolean
}

export const agentHomeRetentionPlugin:
FastifyPluginAsync<AgentHomeRetentionRouteOptions> = async (app, options) => {
  const retention = new AgentHomeRetentionService(options.db)
  const isOperator = options.isOperator ?? (() => true)
  const requireOperator = (request: FastifyRequest): void => {
    if (!isOperator(request)) {
      throw new ForbiddenError('operator authorization is required for retention controls')
    }
  }

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

  app.get<{ Params: { id: string } }>('/boards/:id/retention', (request) => {
    requireOperator(request)
    return {
      policy: retention.getPolicy(positiveId(request.params.id, 'board id')),
    }
  })

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/boards/:id/retention',
    (request) => {
      requireOperator(request)
      const body = objectBody(request.body)
      const command = retentionCommand(request, body)
      return retention.configure({
        boardId: positiveId(request.params.id, 'board id'),
        transcriptDays: optionalIntegerAlias(
          body,
          'transcript_days',
          'transcriptDays',
        ),
        ephemeralDays: optionalIntegerAlias(
          body,
          'ephemeral_days',
          'ephemeralDays',
        ),
        rawArtifactDays: optionalIntegerAlias(
          body,
          'raw_artifact_days',
          'rawArtifactDays',
        ),
        ...command,
      })
    },
  )

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/boards/:id/retention/run',
    (request) => {
      requireOperator(request)
      const body = optionalBody(request.body)
      const command = retentionCommand(request, body)
      return {
        run: retention.run({
          boardId: positiveId(request.params.id, 'board id'),
          asOf: optionalStringAlias(body, 'as_of', 'asOf'),
          ...command,
        }),
      }
    },
  )
}

function retentionCommand(
  request: FastifyRequest,
  body: Record<string, unknown>,
): {
  actor: { type: 'operator'; id: string }
  idempotencyKey: string
  correlationId: string | null
} {
  const idempotencyKey = resolveIdempotencyKey({
    header: request.headers['idempotency-key'],
    rawHeaders: request.raw.rawHeaders,
    snake: body.idempotency_key,
    camel: body.idempotencyKey,
  })
  if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required')
  return {
    actor: { type: 'operator', id: request.orchestraPrincipal ?? 'operator' },
    idempotencyKey,
    correlationId: optionalStringAlias(body, 'correlation_id', 'correlationId') ?? null,
  }
}

function optionalBody(value: unknown): Record<string, unknown> {
  return value === undefined || value === null || value === ''
    ? {}
    : objectBody(value)
}

function optionalIntegerAlias(
  body: Record<string, unknown>,
  snake: string,
  camel: string,
): number | undefined {
  const value = Object.prototype.hasOwnProperty.call(body, snake)
    ? body[snake]
    : body[camel]
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ValidationError(`${snake} must be an integer`)
  }
  return parsed
}

function optionalStringAlias(
  body: Record<string, unknown>,
  snake: string,
  camel: string,
): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(body, snake)
    ? body[snake]
    : body[camel]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ValidationError(`${snake} must be a string`)
  return value
}

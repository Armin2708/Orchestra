import type Database from 'better-sqlite3'
import type {
  FastifyPluginAsync,
  FastifyPluginOptions,
  FastifyRequest,
} from 'fastify'
import { AgentOsError, ForbiddenError, ValidationError } from './errors.js'
import { requireIdempotencyKey } from './idempotency.js'
import { objectBody, positiveId } from './json.js'
import {
  OpenWorkService,
  type DependencyReadiness,
  type OpenWorkDispatchMatch,
} from './open-work.js'
import type { OrchestrationService } from './orchestration-service.js'

export interface OpenWorkRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  orchestration: Pick<OrchestrationService, 'createCardJob' | 'launchCard'>
  supportedProviders: readonly string[]
  globalCapacity?: number
  perProfileCapacity?: number
  isOperator?: (request: FastifyRequest) => boolean
}

interface OpenWorkQuerystring {
  board_id?: string
  repository?: string
  capability?: string | string[]
  priority?: string
  dependency_readiness?: string
  max_tokens?: string
  max_cost_cents?: string
  max_time_seconds?: string
}

/**
 * Focused registrar. Lane 1 mounts this plugin under the future `/api/v1/os`
 * prefix; this module intentionally performs no central registration.
 */
export const openWorkPlugin: FastifyPluginAsync<OpenWorkRouteOptions> = async (
  app,
  options,
) => {
  const service = new OpenWorkService(options.db, {
    orchestration: options.orchestration,
    supportedProviders: options.supportedProviders,
    globalCapacity: options.globalCapacity,
    perProfileCapacity: options.perProfileCapacity,
  })
  // Composition must opt into dispatch authority. An omitted hook is never an
  // authorization grant.
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

  app.get<{ Querystring: OpenWorkQuerystring }>('/open-work', (request) =>
    service.query({
      boardId: optionalPositiveInteger(request.query.board_id, 'board_id'),
      repository: optionalText(request.query.repository, 'repository'),
      capabilities: repeatedText(request.query.capability, 'capability'),
      priority: optionalInteger(request.query.priority, 'priority'),
      dependencyReadiness: optionalReadiness(request.query.dependency_readiness),
      maxTokens: optionalNonNegativeInteger(request.query.max_tokens, 'max_tokens'),
      maxCostCents: optionalNonNegativeInteger(
        request.query.max_cost_cents,
        'max_cost_cents',
      ),
      maxTimeSeconds: optionalNonNegativeInteger(
        request.query.max_time_seconds,
        'max_time_seconds',
      ),
    }))

  app.post<{ Params: { cardId: string }; Body: unknown }>(
    '/cards/:cardId/contract/brief-preview',
    (request) => {
      const body = objectBody(request.body)
      const draft = requiredRecord(body.contract, 'contract')
      return {
        preview: service.preview(
          positiveId(request.params.cardId, 'card id'),
          draft,
          requiredPositiveInteger(
            body.expected_market_version,
            'expected_market_version',
          ),
        ),
      }
    },
  )

  app.post<{ Params: { cardId: string }; Body: unknown }>(
    '/cards/:cardId/open-work/match',
    (request) => {
      const body = objectBody(request.body)
      return {
        match: service.matchCard(
          positiveId(request.params.cardId, 'card id'),
          requiredPositiveInteger(
            body.expected_market_version,
            'expected_market_version',
          ),
        ),
      }
    },
  )

  app.post<{ Params: { cardId: string }; Body: unknown }>(
    '/cards/:cardId/open-work/dispatch',
    async (request, reply) => {
      if (!isOperator(request)) {
        throw new ForbiddenError('operator authorization is required for Open Work dispatch')
      }
      const body = objectBody(request.body)
      const match = requiredRecord(body.match, 'match') as unknown as OpenWorkDispatchMatch
      if (Number(match.card_id) !== positiveId(request.params.cardId, 'card id')) {
        throw new ValidationError('match card_id must equal the route card id')
      }
      const result = await service.dispatch({
        match,
        confirm: requiredBoolean(body.confirm, 'confirm'),
        actor: {
          type: 'operator',
          id: request.orchestraPrincipal ?? 'operator',
        },
        idempotencyKey: requireIdempotencyKey({
          header: request.headers['idempotency-key'],
          rawHeaders: request.raw.rawHeaders,
        }),
      })
      return reply.code(result.replayed ? 200 : 201).send(result)
    },
  )
}

function optionalReadiness(value: unknown): DependencyReadiness | undefined {
  const text = optionalText(value, 'dependency_readiness')
  if (text === undefined) return undefined
  if (text !== 'ready' && text !== 'blocked') {
    throw new ValidationError('dependency_readiness must be ready or blocked')
  }
  return text
}

function repeatedText(value: unknown, field: string): string[] {
  if (value === undefined) return []
  const values = Array.isArray(value) ? value : [value]
  if (values.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new ValidationError(`${field} must contain non-empty strings`)
  }
  return [...new Set(values.map((item) => String(item).trim()))]
    .sort(textOrder)
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new ValidationError(`${field} must be an integer`)
  return parsed
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  const parsed = optionalInteger(value, field)
  if (parsed !== undefined && parsed <= 0) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  return parsed
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  const parsed = optionalInteger(value, field)
  if (parsed !== undefined && parsed < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`)
  }
  return parsed
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const parsed = optionalPositiveInteger(value, field)
  if (parsed === undefined) throw new ValidationError(`${field} is required`)
  return parsed
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be a boolean`)
  return value
}

function textOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

import type Database from 'better-sqlite3'
import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest } from 'fastify'
import { AgentOsError, ForbiddenError, ValidationError } from './errors.js'
import { resolveIdempotencyKey } from './idempotency.js'
import { objectBody, positiveId } from './json.js'
import { KnowledgeBenchmarkStore, type KnowledgeBenchmarkEvidence } from './knowledge-benchmark.js'
import {
  KnowledgeManagementService,
  type CreatePromotionInput,
  type KnowledgeControlAction,
} from './knowledge-management.js'

export interface KnowledgeManagementRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  isOperator?: (request: FastifyRequest) => boolean
}

export const knowledgeManagementPlugin: FastifyPluginAsync<KnowledgeManagementRouteOptions> =
async (app, options) => {
  const service = new KnowledgeManagementService(options.db)
  const benchmarks = new KnowledgeBenchmarkStore(options.db)
  const isOperator = options.isOperator ?? (() => false)

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AgentOsError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code })
    }
    return reply.send(error)
  })

  app.get<{ Params: { boardId: string }; Querystring: {
    q?: string; limit?: string; include_stale?: string; include_rejected?: string
  } }>('/boards/:boardId/knowledge', (request) => ({
    knowledge: service.browse({
      board_id: positiveId(request.params.boardId, 'board id'),
      query: request.query.q,
      limit: request.query.limit === undefined ? undefined : positiveId(request.query.limit, 'limit'),
      include_stale: request.query.include_stale === 'true',
      include_rejected: request.query.include_rejected === 'true',
    }),
  }))

  app.get<{ Params: { boardId: string } }>('/boards/:boardId/knowledge/reviews', (request) => ({
    reviews: service.listReviews(positiveId(request.params.boardId, 'board id')),
  }))

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/knowledge/refresh',
    (request, reply) => {
      requireOperator(request, isOperator)
      const body = objectBody(request.body)
      return reply.code(201).send({ result: service.refreshRepository(
        positiveId(request.params.boardId, 'board id'),
        optionalText(body.observed_at),
      ) })
    },
  )

  app.post<{ Params: { boardId: string; sourceId: string }; Body: unknown }>(
    '/boards/:boardId/knowledge/sources/:sourceId/actions',
    (request, reply) => {
      requireOperator(request, isOperator)
      const body = objectBody(request.body)
      const result = service.applyControl({
        board_id: positiveId(request.params.boardId, 'board id'),
        source_id: request.params.sourceId,
        action: requiredText(body.action, 'action') as KnowledgeControlAction,
        replacement_source_id: optionalText(body.replacement_source_id) ?? undefined,
        pinned: body.pinned as boolean | undefined,
        reason: requiredText(body.reason, 'reason'),
        actor: { type: 'operator', id: request.orchestraPrincipal ?? 'operator' },
        idempotency_key: idempotency(request, body),
      })
      return reply.code(201).send({ result })
    },
  )

  app.get<{ Params: { boardId: string } }>('/boards/:boardId/knowledge/promotions', (request) => ({
    promotions: service.listPromotions(positiveId(request.params.boardId, 'board id')),
  }))

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/knowledge/promotions',
    (request, reply) => {
      requireOperator(request, isOperator)
      const body = objectBody(request.body)
      const result = service.createPromotion({
        board_id: positiveId(request.params.boardId, 'board id'),
        kind: requiredText(body.kind, 'kind') as CreatePromotionInput['kind'],
        payload: body.payload as CreatePromotionInput['payload'],
        requested_by: exactPrincipal(request),
        idempotency_key: idempotency(request, body),
      })
      return reply.code(201).send({ result })
    },
  )

  app.post<{ Params: { boardId: string; promotionId: string }; Body: unknown }>(
    '/boards/:boardId/knowledge/promotions/:promotionId/review',
    (request, reply) => {
      requireOperator(request, isOperator)
      const body = objectBody(request.body)
      const result = service.reviewPromotion({
        board_id: positiveId(request.params.boardId, 'board id'),
        promotion_id: request.params.promotionId,
        decision: requiredText(body.decision, 'decision') as 'promote' | 'reject',
        actor: { type: 'operator', id: exactPrincipal(request) },
        reason: requiredText(body.reason, 'reason'),
      })
      return reply.code(201).send({ result })
    },
  )

  app.get<{ Params: { boardId: string } }>('/boards/:boardId/knowledge/benchmarks', (request) => ({
    benchmarks: benchmarks.list(positiveId(request.params.boardId, 'board id')),
  }))

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/knowledge/benchmarks',
    (request, reply) => {
      requireOperator(request, isOperator)
      const body = objectBody(request.body)
      return reply.code(201).send({ result: benchmarks.record(
        positiveId(request.params.boardId, 'board id'),
        body.evidence as unknown as KnowledgeBenchmarkEvidence,
      ) })
    },
  )

  app.get<{ Params: { buildId: string }; Querystring: { board_id?: string } }>(
    '/context-builds/:buildId/knowledge-manifest',
    (request) => ({
      manifest: service.contextManifest(
        request.params.buildId,
        positiveId(request.query.board_id, 'board id'),
      ),
    }),
  )
}

function requireOperator(
  request: FastifyRequest,
  isOperator: (request: FastifyRequest) => boolean,
): void {
  if (!isOperator(request)) {
    throw new ForbiddenError('operator authorization is required for knowledge controls')
  }
}

function exactPrincipal(request: FastifyRequest): string {
  if (typeof request.orchestraPrincipal !== 'string' || !request.orchestraPrincipal.trim()) {
    throw new ForbiddenError('exact operator identity is required for knowledge promotion')
  }
  return request.orchestraPrincipal.trim()
}

function idempotency(request: FastifyRequest, body: Record<string, unknown>): string {
  return resolveIdempotencyKey({
    header: request.headers['idempotency-key'],
    rawHeaders: request.raw.rawHeaders,
    snake: body.idempotency_key,
    camel: body.idempotencyKey,
  }) ?? (() => { throw new ValidationError('idempotency key is required') })()
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field} is required`)
  return value.trim()
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError('invalid optional text')
  return value.trim()
}

import type Database from 'better-sqlite3'
import type {
  FastifyPluginAsync,
  FastifyPluginOptions,
  FastifyRequest,
} from 'fastify'
import { AgentOsError, ForbiddenError, ValidationError } from './errors.js'
import { resolveIdempotencyKey } from './idempotency.js'
import { objectBody, positiveId } from './json.js'
import {
  DISCUSSION_LINK_TYPES,
  DISCUSSION_PERMISSIONS,
  DISCUSSION_POST_KINDS,
  DISCUSSION_STATES,
  DISCUSSION_TYPES,
  DiscussionService,
  type DiscussionActor,
  type DiscussionKnowledgePromotionAdapter,
  type DiscussionLinkInput,
  type DiscussionListFilter,
  type DiscussionWakeAdapter,
} from './discussions.js'

export interface DiscussionRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  service?: DiscussionService
  wakeAdapter?: DiscussionWakeAdapter
  knowledgeAdapter?: DiscussionKnowledgePromotionAdapter
  isOperator?: (request: FastifyRequest) => boolean
  /** Trusted authentication adapter; request bodies are never accepted as actor evidence. */
  resolveActor?: (request: FastifyRequest) => DiscussionActor | null
}

export const discussionPlugin: FastifyPluginAsync<DiscussionRouteOptions> = async (
  app,
  options,
) => {
  const discussions = options.service ?? new DiscussionService(
    options.db,
    options.wakeAdapter,
    options.knowledgeAdapter,
  )
  const isOperator = options.isOperator ?? (() => false)
  const resolveActor = options.resolveActor ?? ((request) => isOperator(request)
    ? { type: 'operator', id: request.orchestraPrincipal ?? 'operator' }
    : null)

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
    Querystring: DiscussionQuery
  }>('/boards/:boardId/discussions', (request) => {
    const boardId = positiveId(request.params.boardId, 'board id')
    const filter = listFilter(request.query)
    const query = optionalQuery(request.query.q, 1_000)
    return {
      discussions: query
        ? discussions.search(boardId, query, filter)
        : discussions.list(boardId, filter),
    }
  })

  app.get<{
    Params: { boardId: string; queue: string }
    Querystring: { limit?: string }
  }>('/boards/:boardId/discussion-queues/:queue', (request) => {
    if (request.params.queue !== 'unanswered' && request.params.queue !== 'needs_human') {
      throw new ValidationError('discussion queue is invalid')
    }
    return {
      discussions: discussions.queue(
        positiveId(request.params.boardId, 'board id'),
        request.params.queue,
        optionalInteger(request.query.limit, 'limit', 1, 200) ?? 50,
      ),
    }
  })

  app.get<{
    Params: { boardId: string }
    Querystring: { status?: string }
  }>('/boards/:boardId/discussion-promotions', (request) => ({
    promotions: discussions.promotions(
      positiveId(request.params.boardId, 'board id'),
      optionalPromotionStatus(request.query.status),
    ),
  }))

  app.get<{ Params: { discussionId: string } }>(
    '/discussions/:discussionId',
    (request) => discussions.require(request.params.discussionId),
  )

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/discussions',
    (request, reply) => {
      const body = objectBody(request.body)
      const result = discussions.createDiscussion({
        ...mutation(request, body, resolveActor),
        boardId: positiveId(request.params.boardId, 'board id'),
        type: requiredMember(body.type, DISCUSSION_TYPES, 'discussion type'),
        title: requiredText(body.title, 'title'),
        body: requiredText(body.body, 'body'),
        tags: optionalStringArray(body.tags, 'tags'),
        links: optionalLinks(body.links),
        mentions: optionalStringArray(body.mentions, 'mentions'),
        automated: optionalBoolean(body.automated, 'automated'),
        requestedAction: optionalText(body.requested_action ?? body.requestedAction),
      })
      return reply.code(201).send(result)
    },
  )

  app.post<{ Params: { discussionId: string }; Body: unknown }>(
    '/discussions/:discussionId/posts',
    (request, reply) => {
      const body = objectBody(request.body)
      const post = discussions.addPost({
        ...mutation(request, body, resolveActor),
        discussionId: request.params.discussionId,
        parentPostId: optionalText(body.parent_post_id ?? body.parentPostId),
        kind: requiredMember(body.kind, DISCUSSION_POST_KINDS, 'post kind'),
        body: requiredText(body.body, 'body'),
        mentions: optionalStringArray(body.mentions, 'mentions'),
        automated: optionalBoolean(body.automated, 'automated'),
        requestedAction: optionalText(body.requested_action ?? body.requestedAction),
      })
      return reply.code(201).send({ post })
    },
  )

  app.patch<{
    Params: { discussionId: string; postId: string }
    Body: unknown
  }>('/discussions/:discussionId/posts/:postId', (request) => {
    const body = objectBody(request.body)
    return {
      post: discussions.editPost({
        ...mutation(request, body, resolveActor),
        discussionId: request.params.discussionId,
        postId: request.params.postId,
        body: requiredText(body.body, 'body'),
        expectedVersion: requiredInteger(
          body.expected_version ?? body.expectedVersion,
          'expected version',
          1,
          Number.MAX_SAFE_INTEGER,
        ),
      }),
    }
  })

  app.post<{ Params: { discussionId: string }; Body: unknown }>(
    '/discussions/:discussionId/accept',
    (request) => {
      const body = objectBody(request.body)
      return discussions.acceptAnswer({
        ...mutation(request, body, resolveActor),
        discussionId: request.params.discussionId,
        postId: requiredText(body.post_id ?? body.postId, 'post id'),
      })
    },
  )

  app.post<{ Params: { discussionId: string }; Body: unknown }>(
    '/discussions/:discussionId/transition',
    (request) => {
      const body = objectBody(request.body)
      return discussions.transition({
        ...mutation(request, body, resolveActor),
        discussionId: request.params.discussionId,
        state: requiredMember(body.state, DISCUSSION_STATES, 'discussion state'),
        resolutionSummary: optionalText(
          body.resolution_summary ?? body.resolutionSummary,
        ),
        supersededById: optionalText(body.superseded_by_id ?? body.supersededById),
      })
    },
  )

  app.put<{
    Params: { discussionId: string; profileId: string }
    Body: unknown
  }>('/discussions/:discussionId/subscriptions/:profileId', (request) => {
    const body = objectBody(request.body)
    return discussions.subscribe({
      ...mutation(request, body, resolveActor),
      discussionId: request.params.discussionId,
      profileId: request.params.profileId,
    })
  })

  app.delete<{
    Params: { discussionId: string; profileId: string }
    Body: unknown
  }>('/discussions/:discussionId/subscriptions/:profileId', (request) => {
    const body = objectBody(request.body)
    return discussions.unsubscribe({
      ...mutation(request, body, resolveActor),
      discussionId: request.params.discussionId,
      profileId: request.params.profileId,
    })
  })

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/discussion-permissions',
    (request, reply) => {
      const body = objectBody(request.body)
      const result = discussions.grantPermission({
        ...mutation(request, body, resolveActor),
        boardId: positiveId(request.params.boardId, 'board id'),
        discussionId: requiredText(
          body.discussion_id ?? body.discussionId,
          'discussion id',
        ),
        subjectType: requiredMember(
          body.subject_type ?? body.subjectType,
          ['operator', 'profile', 'service'] as const,
          'subject type',
        ),
        subjectId: requiredText(body.subject_id ?? body.subjectId, 'subject id'),
        permission: requiredMember(body.permission, DISCUSSION_PERMISSIONS, 'permission'),
        reason: requiredText(body.reason, 'reason'),
        expiresAt: optionalText(body.expires_at ?? body.expiresAt),
      })
      return reply.code(201).send({ permission: result })
    },
  )

  app.post<{ Params: { permissionId: string }; Body: unknown }>(
    '/discussion-permissions/:permissionId/revoke',
    (request) => {
      const body = objectBody(request.body)
      return {
        permission: discussions.revokePermission({
          ...mutation(request, body, resolveActor),
          permissionId: request.params.permissionId,
        }),
      }
    },
  )

  app.post<{
    Params: { discussionId: string; postId: string }
    Body: unknown
  }>('/discussions/:discussionId/posts/:postId/promotion', (request, reply) => {
    const body = objectBody(request.body)
    const promotion = discussions.requestPromotion({
      ...mutation(request, body, resolveActor),
      discussionId: request.params.discussionId,
      postId: request.params.postId,
    })
    return reply.code(201).send({ promotion })
  })

  app.post<{ Params: { promotionId: string }; Body: unknown }>(
    '/discussion-promotions/:promotionId/review',
    async (request) => {
      const body = objectBody(request.body)
      return {
        promotion: await discussions.reviewPromotion({
          ...mutation(request, body, resolveActor),
          promotionId: request.params.promotionId,
          decision: requiredMember(
            body.decision,
            ['approve', 'reject'] as const,
            'decision',
          ),
          note: requiredText(body.note, 'review note'),
        }),
      }
    },
  )
}

interface DiscussionQuery {
  q?: string
  type?: string
  state?: string
  tag?: string
  link_type?: string
  link_target?: string
  author_profile_id?: string
  queue?: string
  limit?: string
  offset?: string
}

function listFilter(query: DiscussionQuery): DiscussionListFilter {
  const queue = query.queue === undefined ? undefined
    : requiredMember(query.queue, ['unanswered', 'needs_human'] as const, 'queue')
  return {
    types: optionalMembers(query.type, DISCUSSION_TYPES, 'discussion type'),
    states: optionalMembers(query.state, DISCUSSION_STATES, 'discussion state'),
    tags: optionalCsv(query.tag, 'tag'),
    linkType: query.link_type
      ? requiredMember(query.link_type, DISCUSSION_LINK_TYPES, 'link type') : undefined,
    linkTarget: optionalQuery(query.link_target, 2_000),
    authorProfileId: optionalQuery(query.author_profile_id, 200),
    queue,
    limit: optionalInteger(query.limit, 'limit', 1, 200),
    offset: optionalInteger(query.offset, 'offset', 0, 1_000_000),
  }
}

function mutation(
  request: FastifyRequest,
  body: Record<string, unknown>,
  resolveActor: (request: FastifyRequest) => DiscussionActor | null,
): {
  actor: DiscussionActor
  idempotencyKey: string
  correlationId: string | null
  causationId: string | null
} {
  const actor = resolveActor(request)
  if (!actor) throw new ForbiddenError('authenticated discussion actor is required')
  const idempotencyKey = resolveIdempotencyKey({
    header: request.headers['idempotency-key'],
    rawHeaders: request.raw.rawHeaders,
    snake: body.idempotency_key,
    camel: body.idempotencyKey,
  })
  if (!idempotencyKey) throw new ValidationError('an idempotency key is required')
  return {
    actor,
    idempotencyKey,
    correlationId: optionalText(body.correlation_id ?? body.correlationId),
    causationId: optionalText(body.causation_id ?? body.causationId),
  }
}

function optionalLinks(value: unknown): DiscussionLinkInput[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 64) {
    throw new ValidationError('links must be an array with at most 64 entries')
  }
  return value.map((entry) => {
    const link = objectBody(entry)
    return {
      type: requiredMember(link.type, DISCUSSION_LINK_TYPES, 'link type'),
      targetId: optionalText(link.target_id ?? link.targetId),
      path: optionalText(link.path),
      symbol: optionalText(link.symbol),
      sourceRevision: optionalText(link.source_revision ?? link.sourceRevision),
      sourceSha256: optionalText(link.source_sha256 ?? link.sourceSha256),
    }
  })
}

function optionalPromotionStatus(value: unknown):
  | 'pending_review' | 'approved' | 'promoting' | 'promoted' | 'rejected' | 'failed'
  | undefined {
  if (value === undefined || value === '') return undefined
  return requiredMember(value,
    ['pending_review', 'approved', 'promoting', 'promoted', 'rejected', 'failed'] as const,
    'promotion status')
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new ValidationError(`${field} is required and must not have surrounding whitespace`)
  }
  return value
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new ValidationError('optional text must not have surrounding whitespace')
  }
  return value
}

function optionalQuery(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ValidationError('query value is invalid')
  }
  return value.trim()
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 50
    || value.some((item) => typeof item !== 'string')) {
    throw new ValidationError(`${field} must be an array with at most 50 strings`)
  }
  return value as string[]
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be a boolean`)
  return value
}

function requiredMember<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (!allowed.includes(value as T)) throw new ValidationError(`${field} is invalid`)
  return value as T
}

function optionalMembers<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T[] | undefined {
  if (value === undefined || value === '') return undefined
  return optionalCsv(value, field)?.map((item) => requiredMember(item, allowed, field))
}

function optionalCsv(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 1_000) {
    throw new ValidationError(`${field} filter is invalid`)
  }
  const values = value.split(',').map((item) => item.trim()).filter(Boolean)
  if (!values.length || values.length > 32) throw new ValidationError(`${field} filter is invalid`)
  return values
}

function requiredInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) < min || Number(parsed) > max) {
    throw new ValidationError(`${field} is invalid`)
  }
  return Number(parsed)
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === '') return undefined
  return requiredInteger(value, field, min, max)
}

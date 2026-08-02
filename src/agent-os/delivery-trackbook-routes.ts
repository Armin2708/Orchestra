import type Database from 'better-sqlite3'
import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest } from 'fastify'
import type { ActorIdentity } from './agent-home-support.js'
import {
  DeliveryTrackbookService,
  type AddReviewCommentInput,
  type DeliveryReviewLocation,
  type DeliveryTrackbookFilter,
} from './delivery-trackbook.js'
import { AgentOsError, ForbiddenError, ValidationError } from './errors.js'
import { requireIdempotencyKey } from './idempotency.js'
import { objectBody, positiveId, requiredString } from './json.js'
import {
  requireAgentOwnsDelivery,
  type AgentMutationPrincipal,
} from './agent-mutation-principal.js'

export interface DeliveryTrackbookRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  isOperator?: (request: FastifyRequest) => boolean
  resolveAgentPrincipal?: (request: FastifyRequest) => AgentMutationPrincipal | null
}

/** Focused route module; the lane root registers it under `/api/v1/os`. */
export const deliveryTrackbookPlugin: FastifyPluginAsync<DeliveryTrackbookRouteOptions> = async (
  app,
  options,
) => {
  const service = new DeliveryTrackbookService(options.db)

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AgentOsError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code })
    }
    return reply.send(error)
  })

  app.get<{ Params: { id: string } }>('/jobs/:id/detail', (request) => ({
    job_detail: service.jobDetail(request.params.id),
  }))

  app.get<{ Params: { id: string }; Querystring: { filter?: string; limit?: string } }>(
    '/boards/:id/delivery-trackbook',
    (request) => ({
      deliveries: service.listBoard(
        positiveId(request.params.id, 'board id'),
        (request.query.filter ?? 'all') as DeliveryTrackbookFilter,
        request.query.limit === undefined ? 100 : Number(request.query.limit),
      ),
    }),
  )

  app.post<{ Params: { id: string }; Body: unknown }>('/deliveries/:id/verification-runs', (request, reply) => {
    const body = safeBody(request.body)
    const verification = service.recordVerificationRun(request.params.id, {
      actor: authenticatedActor(request, options, request.params.id),
      command: requiredString(body.command, 'command'),
      cwd: requiredString(body.cwd, 'cwd'),
      environment: stringRecord(body.environment, 'environment'),
      exitCode: integer(body.exit_code ?? body.exitCode, 'exit_code'),
      outputArtifactId: requiredString(body.output_artifact_id ?? body.outputArtifactId, 'output_artifact_id'),
      startedAt: requiredString(body.started_at ?? body.startedAt, 'started_at'),
      finishedAt: requiredString(body.finished_at ?? body.finishedAt, 'finished_at'),
      idempotencyKey: idempotencyKey(request, body),
    })
    return reply.code(201).send({ verification })
  })

  app.post<{ Params: { id: string; artifactId: string }; Body: unknown }>(
    '/deliveries/:id/artifacts/:artifactId/attest',
    (request, reply) => {
      const body = safeBody(request.body)
      const attestation = service.attestArtifact(request.params.id, {
        actor: authenticatedActor(request, options, request.params.id),
        artifactId: request.params.artifactId,
        contentSha256: optionalString(body.content_sha256 ?? body.contentSha256),
        byteSize: optionalInteger(body.byte_size ?? body.byteSize, 'byte_size'),
        sourceKind: requiredString(body.source_kind ?? body.sourceKind, 'source_kind') as any,
        sourceLocator: requiredString(body.source_locator ?? body.sourceLocator, 'source_locator'),
        sourceRevision: optionalString(body.source_revision ?? body.sourceRevision),
        builder: requiredString(body.builder, 'builder'),
        parameters: record(body.parameters, 'parameters'),
        environment: stringRecord(body.environment, 'environment'),
        provenance: record(body.provenance, 'provenance'),
        idempotencyKey: idempotencyKey(request, body),
      })
      return reply.code(201).send({ attestation })
    },
  )

  app.post<{ Params: { id: string }; Body: unknown }>('/deliveries/:id/review-comments', (request, reply) => {
    const body = safeBody(request.body)
    const comment = service.addReviewComment(request.params.id, {
      actor: operatorActor(request, options),
      criterionId: optionalString(body.criterion_id ?? body.criterionId),
      deliverableId: optionalString(body.deliverable_id ?? body.deliverableId),
      artifactId: requiredString(body.artifact_id ?? body.artifactId, 'artifact_id'),
      location: reviewLocation(body.location),
      body: requiredString(body.body, 'body'),
      idempotencyKey: idempotencyKey(request, body),
    })
    return reply.code(201).send({ comment })
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/deliveries/:id/reject-with-feedback', (request) => {
    const body = safeBody(request.body)
    const actor = operatorActor(request, options)
    const comments = array(body.comments, 'comments').map((value) => {
      const comment = safeBody(value)
      return {
        criterionId: optionalString(comment.criterion_id ?? comment.criterionId),
        deliverableId: optionalString(comment.deliverable_id ?? comment.deliverableId),
        artifactId: requiredString(comment.artifact_id ?? comment.artifactId, 'artifact_id'),
        location: reviewLocation(comment.location),
        body: requiredString(comment.body, 'body'),
        idempotencyKey: requiredString(comment.idempotency_key ?? comment.idempotencyKey, 'comment.idempotency_key'),
      } satisfies Omit<AddReviewCommentInput, 'actor'>
    })
    return { delivery: service.rejectWithFeedback(request.params.id, {
      actor,
      reason: requiredString(body.reason, 'reason'),
      comments,
    }) }
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/deliveries/:id/revise-rejected', (request, reply) => {
    safeBody(request.body ?? {})
    const delivery = service.reviseRejected(
      request.params.id,
      authenticatedActor(request, options, request.params.id),
    )
    return reply.code(201).send({ delivery })
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/deliveries/:id/ship', (request, reply) => {
    const body = safeBody(request.body)
    const shipment = service.ship(request.params.id, {
      actor: operatorActor(request, options),
      sourceRepository: requiredString(body.source_repository ?? body.sourceRepository, 'source_repository'),
      sourceCommit: requiredString(body.source_commit ?? body.sourceCommit, 'source_commit'),
      destination: requiredString(body.destination, 'destination'),
      deploymentRef: optionalString(body.deployment_ref ?? body.deploymentRef),
      artifactAttestationIds: stringArray(body.artifact_attestation_ids ?? body.artifactAttestationIds, 'artifact_attestation_ids'),
      shippedAt: optionalString(body.shipped_at ?? body.shippedAt),
      idempotencyKey: idempotencyKey(request, body),
    })
    return reply.code(201).send({ shipment })
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/deliveries/:id/reopen-regression', (request, reply) => {
    const body = safeBody(request.body)
    const regression = service.reopenAfterRegression(request.params.id, {
      actor: operatorActor(request, options),
      shipmentId: optionalString(body.shipment_id ?? body.shipmentId),
      evidenceArtifactId: requiredString(body.evidence_artifact_id ?? body.evidenceArtifactId, 'evidence_artifact_id'),
      summary: requiredString(body.summary, 'summary'),
      observedAt: optionalString(body.observed_at ?? body.observedAt),
      idempotencyKey: idempotencyKey(request, body),
    })
    return reply.code(201).send({ regression })
  })
}

function authenticatedActor(
  request: FastifyRequest,
  options: DeliveryTrackbookRouteOptions,
  deliveryId?: string,
): ActorIdentity {
  if (options.isOperator?.(request)) {
    return { type: 'operator', id: request.orchestraPrincipal ?? 'operator' }
  }
  const principal = options.resolveAgentPrincipal?.(request)
  if (!principal) {
    throw new ForbiddenError(
      'session-bound agent identity is required for Delivery Trackbook commands',
    )
  }
  if (deliveryId) requireAgentOwnsDelivery(options.db, principal, deliveryId)
  return { type: 'agent', id: principal.profileId }
}

function operatorActor(request: FastifyRequest, options: DeliveryTrackbookRouteOptions): ActorIdentity {
  if (!options.isOperator?.(request)) {
    throw new ForbiddenError('operator authorization is required for this Delivery Trackbook command')
  }
  const actor = authenticatedActor(request, options)
  return { type: 'operator', id: actor.id }
}

function safeBody(value: unknown): Record<string, unknown> {
  const body = objectBody(value)
  for (const key of ['actor', 'actor_id', 'actorId', 'recorded_by', 'recordedBy', 'author', 'shipped_by', 'shippedBy']) {
    if (Object.hasOwn(body, key)) {
      throw new ValidationError(`${key} is server-derived and must not appear in the request body`)
    }
  }
  return body
}

function idempotencyKey(request: FastifyRequest, body: Record<string, unknown>): string {
  return requireIdempotencyKey({
    header: request.headers['idempotency-key'],
    rawHeaders: request.raw.rawHeaders,
    snake: body.idempotency_key,
    camel: body.idempotencyKey,
  })
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new ValidationError(`${field} must be an integer`)
  return Number(value)
}

function optionalInteger(value: unknown, field: string): number | undefined {
  return value === undefined || value === null ? undefined : integer(value, field)
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : requiredString(value, 'value')
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${field} must be an object`)
  return value as Record<string, unknown>
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  const input = record(value, field)
  if (Object.values(input).some((item) => typeof item !== 'string')) {
    throw new ValidationError(`${field} values must be strings`)
  }
  return input as Record<string, string>
}

function array(value: unknown, field: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`)
  return value
}

function stringArray(value: unknown, field: string): string[] {
  const values = array(value, field)
  if (values.some((item) => typeof item !== 'string')) throw new ValidationError(`${field} must contain strings`)
  return values as string[]
}

function reviewLocation(value: unknown): DeliveryReviewLocation {
  return record(value, 'location') as DeliveryReviewLocation
}

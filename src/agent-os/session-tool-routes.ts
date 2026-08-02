import type Database from 'better-sqlite3'
import type {
  FastifyPluginAsync,
  FastifyPluginOptions,
  FastifyRequest,
} from 'fastify'
import {
  type DeclaredProviderCapabilityMatrixRow,
  type ToolCapabilityRegistry,
  type ToolPolicyDecision,
} from '../tool-capabilities.js'
import {
  AgentOsError,
  ForbiddenError,
  ValidationError,
} from './errors.js'
import {
  SessionToolService,
  type SessionToolPolicyRule,
  type ToolInvocationProvenance,
} from './session-tools.js'
import type { ActorIdentity } from './agent-home-support.js'

export interface SessionToolRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  registry: ToolCapabilityRegistry
  providerMatrix: readonly DeclaredProviderCapabilityMatrixRow[]
  isOperator?: (request: FastifyRequest) => boolean
}

const recordBody = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('request body must be an object')
  }
  return value as Record<string, unknown>
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${name} is required`)
  }
  return value.trim()
}

const optionalText = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined
  if (value === null) return null
  return text(value, 'value')
}

const integer = (value: unknown, name: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${name} must be a non-negative integer`)
  }
  return parsed
}

const idempotencyKey = (
  request: FastifyRequest,
  body: Record<string, unknown>,
): string => text(
  request.headers['idempotency-key']
    ?? body.idempotency_key
    ?? body.idempotencyKey,
  'idempotency key',
)

const actorId = (
  request: FastifyRequest,
): ActorIdentity => ({
  type: 'human',
  id: text(request.orchestraPrincipal ?? 'operator', 'actor id'),
})

export const sessionToolPlugin: FastifyPluginAsync<SessionToolRouteOptions> = async (
  app,
  options,
) => {
  const service = new SessionToolService(
    options.db,
    options.registry,
    options.providerMatrix,
  )
  const isOperator = options.isOperator ?? (() => false)
  const requireOperator = (request: FastifyRequest) => {
    if (!isOperator(request)) {
      throw new ForbiddenError('operator authorization is required for managed session tool mutations')
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AgentOsError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
      })
    }
    if (error && typeof error === 'object' && 'validation' in error && error.validation) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'request validation failed',
        code: 'validation_error',
      })
    }
    return reply.send(error)
  })

  app.get('/provider-tool-capabilities', () => ({
    schema_version: 1,
    providers: options.providerMatrix,
    direct_terminal_is_source_of_truth: true,
  }))

  app.get<{ Params: { id: string } }>('/sessions/:id/tools', (request) => ({
    tools: service.snapshot(request.params.id),
  }))

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/sessions/:id/tools/policy',
    (request) => {
      requireOperator(request)
      const body = recordBody(request.body)
      return {
        policy: service.setPolicy(request.params.id, {
          defaultDecision: text(
            body.default_decision ?? body.defaultDecision,
            'default decision',
          ) as ToolPolicyDecision,
          rules: (body.rules ?? []) as SessionToolPolicyRule[],
          expectedRevision: integer(
            body.expected_revision ?? body.expectedRevision,
            'expected revision',
          ),
          actor: actorId(request),
          idempotencyKey: idempotencyKey(request, body),
        }),
      }
    },
  )

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/sessions/:id/tools/authorize',
    (request) => {
      requireOperator(request)
      const body = recordBody(request.body)
      return {
        authorization: service.requestInvocation(request.params.id, {
          toolId: text(body.tool_id ?? body.toolId, 'tool id'),
          actor: actorId(request),
          requestId: optionalText(body.request_id ?? body.requestId) ?? undefined,
          idempotencyKey: idempotencyKey(request, body),
        }),
      }
    },
  )

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/sessions/:id/tools/invocations',
    (request, reply) => {
      requireOperator(request)
      const body = recordBody(request.body)
      const status = text(body.status, 'tool invocation status') as ToolInvocationProvenance['status']
      const invocation = service.recordInvocation(request.params.id, {
        invocationId: optionalText(body.invocation_id ?? body.invocationId) ?? undefined,
        toolId: text(body.tool_id ?? body.toolId, 'tool id'),
        status,
        arguments: body.arguments,
        providerCallId: optionalText(body.provider_call_id ?? body.providerCallId),
        providerEventId: optionalText(body.provider_event_id ?? body.providerEventId),
        errorCode: optionalText(body.error_code ?? body.errorCode),
        observedAt: optionalText(body.observed_at ?? body.observedAt) ?? undefined,
        actor: actorId(request),
        idempotencyKey: idempotencyKey(request, body),
      })
      return reply.code(201).send({ invocation })
    },
  )
}

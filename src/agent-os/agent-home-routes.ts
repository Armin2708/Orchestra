import type Database from 'better-sqlite3'
import type {
  FastifyPluginAsync,
  FastifyPluginOptions,
  FastifyRequest,
} from 'fastify'
import { AgentProfileService } from './agent-profiles.js'
import {
  ConversationService,
  type ConversationEventKind,
} from './conversations.js'
import {
  AgentOsError,
  ForbiddenError,
  ValidationError,
} from './errors.js'
import { resolveIdempotencyKey } from './idempotency.js'
import { objectBody, positiveId } from './json.js'
import type {
  AgentHomeAccessProfile,
  AgentSessionHistoryState,
  AgentSessionMode,
  AgentSessionRecoveryState,
} from './agent-home-support.js'

export interface AgentHomeRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  isOperator?: (request: FastifyRequest) => boolean
}

export const agentHomePlugin: FastifyPluginAsync<AgentHomeRouteOptions> = async (app, options) => {
  const profiles = new AgentProfileService(options.db)
  const conversations = new ConversationService(options.db)
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
    Params: { id: string }
    Querystring: { archived?: string }
  }>('/boards/:id/agent-profiles', (request) => ({
    profiles: profiles.listBoard(
      positiveId(request.params.id, 'board id'),
      truthyQuery(request.query.archived),
    ),
  }))

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/boards/:id/agent-profiles',
    (request, reply) => {
      const body = requestBody(request.body)
      const command = mutation(request, body, isOperator)
      const profile = profiles.create({
        boardId: positiveId(request.params.id, 'board id'),
        name: body.name as string,
        role: optionalValue(body, 'role'),
        defaultProvider: optionalValue(body, 'default_provider', 'defaultProvider'),
        defaultModel: optionalValue(body, 'default_model', 'defaultModel'),
        defaultEffort: optionalValue(body, 'default_effort', 'defaultEffort'),
        defaultAccessProfile: optionalValue(
          body,
          'default_access_profile',
          'defaultAccessProfile',
        ) as AgentHomeAccessProfile | null | undefined,
        capabilities: body.capabilities as string[] | undefined,
        ...command,
      })
      return reply.code(201).send({ profile })
    },
  )

  app.get<{ Params: { id: string } }>('/agent-profiles/:id', (request) => ({
    profile: profiles.require(request.params.id),
  }))

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/agent-profiles/:id',
    (request) => {
      const body = requestBody(request.body)
      const command = mutation(request, body, isOperator)
      return {
        profile: profiles.update(request.params.id, {
          ...(has(body, 'name') ? { name: body.name as string } : {}),
          ...(has(body, 'role') ? { role: body.role as string | null } : {}),
          ...(hasEither(body, 'default_provider', 'defaultProvider')
            ? { defaultProvider: optionalValue(body, 'default_provider', 'defaultProvider') }
            : {}),
          ...(hasEither(body, 'default_model', 'defaultModel')
            ? { defaultModel: optionalValue(body, 'default_model', 'defaultModel') }
            : {}),
          ...(hasEither(body, 'default_effort', 'defaultEffort')
            ? { defaultEffort: optionalValue(body, 'default_effort', 'defaultEffort') }
            : {}),
          ...(hasEither(body, 'default_access_profile', 'defaultAccessProfile')
            ? {
                defaultAccessProfile: optionalValue(
                  body,
                  'default_access_profile',
                  'defaultAccessProfile',
                ) as AgentHomeAccessProfile | null,
              }
            : {}),
          ...(has(body, 'capabilities') ? { capabilities: body.capabilities as string[] } : {}),
          ...command,
        }),
      }
    },
  )

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/agent-profiles/:id/archive',
    (request) => {
      const body = requestBody(request.body, true)
      return {
        profile: profiles.archive(
          request.params.id,
          mutation(request, body, isOperator),
        ),
      }
    },
  )

  app.get<{ Params: { id: string } }>('/agent-profiles/:id/home', (request) => ({
    home: conversations.home(request.params.id),
  }))

  app.get<{
    Params: { id: string }
    Querystring: { archived?: string }
  }>('/agent-profiles/:id/conversations', (request) => ({
    conversations: conversations.listConversations(
      request.params.id,
      truthyQuery(request.query.archived),
    ),
  }))

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/agent-profiles/:id/conversations',
    (request, reply) => {
      const body = requestBody(request.body)
      const conversation = conversations.createConversation(request.params.id, {
        title: optionalValue(body, 'title'),
        isDefault: booleanValue(body.is_default ?? body.isDefault, 'is_default', false),
        ...mutation(request, body, isOperator),
      })
      return reply.code(201).send({ conversation })
    },
  )

  app.get<{ Params: { id: string } }>('/conversations/:id', (request) => ({
    conversation: conversations.requireConversation(request.params.id),
  }))

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/conversations/:id',
    (request) => {
      const body = requestBody(request.body)
      return {
        conversation: conversations.updateConversation(request.params.id, {
          title: body.title as string,
          ...mutation(request, body, isOperator),
        }),
      }
    },
  )

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/conversations/:id/archive',
    (request) => {
      const body = requestBody(request.body, true)
      return {
        conversation: conversations.archiveConversation(
          request.params.id,
          mutation(request, body, isOperator),
        ),
      }
    },
  )

  app.get<{ Params: { id: string } }>('/agent-profiles/:id/sessions', (request) => ({
    sessions: conversations.listSessions(request.params.id),
  }))

  app.get<{ Params: { id: string } }>('/sessions/:id', (request) => ({
    session: conversations.requireSession(request.params.id),
  }))

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/sessions/:id/link',
    (request) => {
      const body = requestBody(request.body)
      return {
        session: conversations.linkSession(request.params.id, {
          profileId: requiredAliasedValue(body, 'profile_id', 'profileId'),
          conversationId: requiredAliasedValue(body, 'conversation_id', 'conversationId'),
          jobId: optionalValue(body, 'job_id', 'jobId'),
          mode: (body.mode ?? 'compatibility') as AgentSessionMode,
          driverId: optionalValue(body, 'driver_id', 'driverId'),
          effort: optionalValue(body, 'effort'),
          accessProfile: optionalValue(
            body,
            'access_profile',
            'accessProfile',
          ) as AgentHomeAccessProfile | null | undefined,
          providerThreadId: optionalValue(body, 'provider_thread_id', 'providerThreadId'),
          providerCursor: optionalValue(body, 'provider_cursor', 'providerCursor'),
          recoveryState: optionalValue(
            body,
            'recovery_state',
            'recoveryState',
          ) as AgentSessionRecoveryState | undefined,
          recovery: optionalRecord(body.recovery ?? body.recovery_json, 'recovery'),
          historyState: optionalValue(
            body,
            'history_state',
            'historyState',
          ) as AgentSessionHistoryState | undefined,
          ...mutation(request, body, isOperator),
        }),
      }
    },
  )

  app.get<{
    Params: { id: string }
    Querystring: { after?: string; limit?: string; kind?: string; kinds?: string }
  }>('/conversations/:id/events', (request) => {
    const events = conversations.listEvents(request.params.id, {
      afterSequence: optionalNonNegativeInteger(request.query.after, 'after'),
      limit: optionalPositiveInteger(request.query.limit, 'limit'),
      kinds: eventKinds(request.query.kind ?? request.query.kinds),
    })
    return {
      events,
      next_sequence: events.at(-1)?.sequence ?? Number(request.query.after ?? 0),
    }
  })

  app.get<{
    Params: { id: string }
    Querystring: { after?: string; limit?: string; kind?: string; kinds?: string }
  }>('/sessions/:id/events', (request) => {
    const events = conversations.listSessionEvents(request.params.id, {
      afterSequence: optionalNonNegativeInteger(request.query.after, 'after'),
      limit: optionalPositiveInteger(request.query.limit, 'limit'),
      kinds: eventKinds(request.query.kind ?? request.query.kinds),
    })
    return {
      events,
      next_sequence: events.at(-1)?.sequence ?? Number(request.query.after ?? 0),
    }
  })

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/sessions/:id/events',
    (request, reply) => {
      const body = requestBody(request.body)
      const command = mutation(request, body, isOperator)
      const result = conversations.appendEvent(request.params.id, {
        idempotencyKey: command.idempotencyKey,
        dedupeKey: requiredAliasedValue(body, 'dedupe_key', 'dedupeKey'),
        kind: body.kind as ConversationEventKind,
        provider: optionalValue(body, 'provider'),
        providerEventId: optionalValue(body, 'provider_event_id', 'providerEventId'),
        providerThreadId: optionalValue(body, 'provider_thread_id', 'providerThreadId'),
        providerTurnId: optionalValue(body, 'provider_turn_id', 'providerTurnId'),
        providerItemId: optionalValue(body, 'provider_item_id', 'providerItemId'),
        providerCursor: optionalValue(body, 'provider_cursor', 'providerCursor'),
        projectedText: optionalValue(body, 'projected_text', 'projectedText'),
        metadata: optionalRecord(body.metadata ?? body.metadata_json, 'metadata'),
        rawArtifactId: optionalValue(body, 'raw_artifact_id', 'rawArtifactId'),
        actor: command.actor,
        correlationId: optionalValue(body, 'correlation_id', 'correlationId'),
        causationId: optionalValue(body, 'causation_id', 'causationId'),
        redactionState: optionalValue(body, 'redaction_state', 'redactionState') as
          | 'none'
          | 'redacted'
          | 'withheld'
          | undefined,
        retentionClass: optionalValue(body, 'retention_class', 'retentionClass') as
          | 'transcript'
          | 'audit'
          | 'ephemeral'
          | 'pinned'
          | undefined,
        schemaVersion: optionalPositiveInteger(
          body.schema_version ?? body.schemaVersion,
          'schema_version',
        ),
      })
      return reply.code(result.replayed ? 200 : 201).send(result)
    },
  )
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
  if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required')
  return {
    actor: { type: 'operator', id: request.orchestraPrincipal ?? 'operator' },
    idempotencyKey,
    correlationId: optionalValue(body, 'correlation_id', 'correlationId') ?? null,
  }
}

function requestBody(value: unknown, optional = false): Record<string, unknown> {
  if (optional && (value === undefined || value === null || value === '')) return {}
  return objectBody(value)
}

function optionalValue(
  body: Record<string, unknown>,
  snake: string,
  camel = snake,
): string | null | undefined {
  const value = has(body, snake) ? body[snake] : body[camel]
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ValidationError(`${snake} must be a string or null`)
  return value
}

function requiredAliasedValue(
  body: Record<string, unknown>,
  snake: string,
  camel: string,
): string {
  const value = optionalValue(body, snake, camel)
  if (!value) throw new ValidationError(`${snake} is required`)
  return value
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function booleanValue(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be a boolean`)
  return value
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`)
  }
  return parsed
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  return parsed
}

function eventKinds(value: unknown): ConversationEventKind[] | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ValidationError('kind must be a comma-separated string')
  return [...new Set(
    value.split(',').map((kind) => kind.trim()).filter(Boolean),
  )] as ConversationEventKind[]
}

function truthyQuery(value: unknown): boolean {
  return value === '1' || value === 'true'
}

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key)
}

function hasEither(body: Record<string, unknown>, snake: string, camel: string): boolean {
  return has(body, snake) || has(body, camel)
}

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
  AgentHomeTranscriptExporter,
  type AgentHomeExportFormat,
} from './agent-home-export.js'
import {
  AGENT_HOME_SESSION_ACTIONS,
  AgentHomeLifecycleService,
  type AgentHomeForkReconciliationResolution,
  type AgentHomeRuntimeControl,
  type AgentHomeSessionAction,
} from './agent-home-lifecycle.js'
import { AgentHomeLinkService } from './agent-home-links.js'
import { AgentHomeSearchService } from './agent-home-search.js'
import {
  AgentOsError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
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
import type { OrchestrationService } from './orchestration-service.js'
import type { JobScheduler } from './scheduler.js'

export interface AgentHomeRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  isOperator?: (request: FastifyRequest) => boolean
  lifecycleRuntime?: AgentHomeRuntimeControl
  orchestration?: OrchestrationService
  scheduler?: JobScheduler
}

export const agentHomePlugin: FastifyPluginAsync<AgentHomeRouteOptions> = async (app, options) => {
  const profiles = new AgentProfileService(options.db)
  const conversations = new ConversationService(options.db)
  const isOperator = options.isOperator ?? (() => true)
  const lifecycle = new AgentHomeLifecycleService(options.db, {
    runtime: options.lifecycleRuntime,
    orchestration: options.orchestration,
    scheduler: options.scheduler,
  })
  const links = new AgentHomeLinkService(options.db)
  const search = new AgentHomeSearchService(options.db)
  const exporter = new AgentHomeTranscriptExporter(options.db)

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

  app.get<{ Params: { id: string } }>('/sessions/:id', (request) => {
    const session = conversations.requireSession(request.params.id)
    return {
      session,
      capabilities: lifecycle.capabilities(session, isOperator(request)),
      links: session.profile_id ? links.forSession(session) : null,
    }
  })

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

  app.get<{
    Params: { id: string }
    Querystring: {
      query?: string
      after?: string
      limit?: string
      kind?: string
      kinds?: string
      actor_type?: string
      actor_id?: string
      tool?: string
      status?: string
      from?: string
      to?: string
      session_id?: string
      archived?: string
    }
  }>('/conversations/:id/search', (request) => search.search(request.params.id, {
    query: request.query.query,
    after: optionalNonNegativeInteger(request.query.after, 'after'),
    limit: optionalPositiveInteger(request.query.limit, 'limit'),
    kinds: eventKinds(request.query.kind ?? request.query.kinds),
    actorType: request.query.actor_type,
    actorId: request.query.actor_id,
    tool: request.query.tool,
    status: request.query.status,
    from: request.query.from,
    to: request.query.to,
    sessionId: request.query.session_id,
    includeArchived: truthyQuery(request.query.archived),
  }))

  app.get<{
    Params: { id: string; eventId: string }
  }>('/conversations/:id/events/:eventId', (request) => {
    const conversation = conversations.requireConversation(request.params.id)
    const event = conversations.requireEvent(request.params.eventId)
    if (event.conversation_id !== conversation.id) {
      throw new NotFoundError('conversation event not found')
    }
    return {
      event,
      links: links.forEvent(event),
    }
  })

  app.get<{
    Params: { id: string }
    Querystring: { format?: string; session_id?: string }
  }>('/conversations/:id/export', (request, reply) => {
    const format = exportFormat(request.query.format)
    const document = exporter.document(request.params.id, request.query.session_id)
    if (format === 'human') {
      return reply.type('text/plain; charset=utf-8').send(exporter.renderHuman(document))
    }
    return document
  })

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/conversations/:id/export',
    (request, reply) => {
      const body = requestBody(request.body, true)
      const command = mutation(request, body, isOperator)
      const result = exporter.createArtifact({
        conversationId: request.params.id,
        sessionId: optionalValue(body, 'session_id', 'sessionId') ?? undefined,
        format: exportFormat(optionalValue(body, 'format') ?? undefined),
        actor: command.actor,
        idempotencyKey: command.idempotencyKey,
        correlationId: command.correlationId,
      })
      return reply.code(result.export.replayed ? 200 : 201).send(result)
    },
  )

  app.get<{
    Params: { id: string }
    Querystring: { format?: string }
  }>('/sessions/:id/export', (request, reply) => {
    const session = conversations.requireSession(request.params.id)
    if (!session.conversation_id) {
      throw new ConflictError('session is not linked to an Agent Home conversation')
    }
    const format = exportFormat(request.query.format)
    const document = exporter.document(session.conversation_id, session.id)
    if (format === 'human') {
      return reply.type('text/plain; charset=utf-8').send(exporter.renderHuman(document))
    }
    return document
  })

  app.get<{
    Params: { id: string }
    Querystring: {
      query?: string
      after?: string
      limit?: string
      kind?: string
      kinds?: string
      actor_type?: string
      actor_id?: string
      tool?: string
      status?: string
      from?: string
      to?: string
      archived?: string
    }
  }>('/sessions/:id/search', (request) => {
    const session = conversations.requireSession(request.params.id)
    if (!session.conversation_id) {
      throw new ConflictError('session is not linked to an Agent Home conversation')
    }
    return search.search(session.conversation_id, {
      query: request.query.query,
      after: optionalNonNegativeInteger(request.query.after, 'after'),
      limit: optionalPositiveInteger(request.query.limit, 'limit'),
      kinds: eventKinds(request.query.kind ?? request.query.kinds),
      actorType: request.query.actor_type,
      actorId: request.query.actor_id,
      tool: request.query.tool,
      status: request.query.status,
      from: request.query.from,
      to: request.query.to,
      sessionId: session.id,
      includeArchived: truthyQuery(request.query.archived),
    })
  })

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/sessions/:id/export',
    (request, reply) => {
      const session = conversations.requireSession(request.params.id)
      if (!session.conversation_id) {
        throw new ConflictError('session is not linked to an Agent Home conversation')
      }
      const body = requestBody(request.body, true)
      const command = mutation(request, body, isOperator)
      const result = exporter.createArtifact({
        conversationId: session.conversation_id,
        sessionId: session.id,
        format: exportFormat(optionalValue(body, 'format') ?? undefined),
        actor: command.actor,
        idempotencyKey: command.idempotencyKey,
        correlationId: command.correlationId,
      })
      return reply.code(result.export.replayed ? 200 : 201).send(result)
    },
  )

  for (const action of AGENT_HOME_SESSION_ACTIONS) {
    app.post<{ Params: { id: string }; Body: unknown }>(
      `/sessions/:id/${action}`,
      async (request) => {
        const body = requestBody(request.body, true)
        const command = mutation(request, body, isOperator)
        return lifecycle.run(request.params.id, action as AgentHomeSessionAction, {
          ...command,
          ...(action === 'rename' ? { name: body.name as string } : {}),
        })
      },
    )
  }

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/session-actions/:id/reconcile',
    async (request) => {
      const body = requestBody(request.body)
      const command = mutation(request, body, isOperator)
      const resolution = optionalValue(body, 'resolution')
      if (resolution !== 'verify_adopt' && resolution !== 'confirm_absent') {
        throw new ValidationError(
          'resolution must be verify_adopt or confirm_absent',
        )
      }
      return lifecycle.reconcileFork(request.params.id, {
        actor: command.actor,
        idempotencyKey: command.idempotencyKey,
        resolution: resolution as AgentHomeForkReconciliationResolution,
        note: optionalValue(body, 'note'),
      })
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

function exportFormat(value: unknown): AgentHomeExportFormat {
  if (value === undefined || value === null || value === '' || value === 'human') return 'human'
  if (value === 'json') return 'json'
  throw new ValidationError('format must be human or json')
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

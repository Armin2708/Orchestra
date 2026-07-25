import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  TaskContractTemplateService,
  type TemplateConflictStrategy,
} from './contract-templates.js'
import { EventStore } from './event-store.js'
import { ValidationError } from './errors.js'
import { objectBody, positiveId } from './json.js'

export interface TaskContractTemplateRouteOptions {
  db: Database.Database
  events: EventStore
  requireOperator(request: FastifyRequest): void
}

export function registerTaskContractTemplateRoutes(
  app: FastifyInstance,
  options: TaskContractTemplateRouteOptions,
): void {
  const templates = new TaskContractTemplateService(options.db, options.events)

  app.get('/contract-templates', () => ({ templates: templates.list() }))

  app.post<{ Params: { templateId: string }; Body: unknown }>(
    '/contract-templates/:templateId/preview',
    (request) => {
      const body = objectBody(request.body)
      return { preview: templates.preview(request.params.templateId, body.variables) }
    },
  )

  app.post<{ Params: { cardId: string; templateId: string }; Body: unknown }>(
    '/cards/:cardId/contract/templates/:templateId/apply',
    (request) => {
      options.requireOperator(request)
      const body = objectBody(request.body)
      const strategy = conflictStrategy(body.conflict_strategy ?? body.conflictStrategy)
      const result = templates.apply(
        positiveId(request.params.cardId, 'card id'),
        request.params.templateId,
        body.variables,
        strategy,
        actor(body.actor),
      )
      return {
        template: result.template,
        variables: result.variables,
        conflict_strategy: result.conflict_strategy,
        changed: result.changed,
        replaced_fields: result.replaced_fields,
        contract: result.job_market.contract,
        job_market: result.job_market,
      }
    },
  )
}

function conflictStrategy(value: unknown): TemplateConflictStrategy {
  if (value === undefined || value === null || value === '') return 'reject'
  if (value !== 'reject' && value !== 'replace') {
    throw new ValidationError('conflict_strategy must be reject or replace')
  }
  return value
}

function actor(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'human'
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError('actor must be a string')
  return value.trim()
}

import type Database from 'better-sqlite3'
import type {
  FastifyReply,
  FastifyPluginAsync,
  FastifyPluginOptions,
  FastifyRequest,
} from 'fastify'
import { AgentOsError, ForbiddenError, NotFoundError, ValidationError } from './errors.js'
import { resolveIdempotencyKey } from './idempotency.js'
import { objectBody, positiveId } from './json.js'
import { OrganizationAssuranceService } from './organization-assurance.js'
import { OrganizationCoordinationService } from './organization-coordination.js'
import { OrganizationService } from './organization.js'

export interface OrganizationRouteOptions extends FastifyPluginOptions {
  db: Database.Database
  isOperator?: (request: FastifyRequest) => boolean
}

type CommandHandler = (body: Record<string, unknown>) => unknown

export const organizationPlugin: FastifyPluginAsync<OrganizationRouteOptions> = async (
  app,
  options,
) => {
  const organization = new OrganizationService(options.db)
  const coordination = new OrganizationCoordinationService(options.db)
  const assurance = new OrganizationAssuranceService(options.db)
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

  app.get<{ Params: { boardId: string } }>('/boards/:boardId/organizations', (request) => ({
    organizations: organization.listBoardOrganizations(
      positiveId(request.params.boardId, 'board id'),
    ),
  }))

  app.post<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/organizations',
    (request, reply) => {
      const body = commandBody(request, request.body, isOperator)
      const result = organization.createOrganization({
        ...body,
        boardId: positiveId(request.params.boardId, 'board id'),
      } as Parameters<OrganizationService['createOrganization']>[0])
      return reply.code(201).send({ result })
    },
  )

  app.get<{ Params: { organizationId: string } }>(
    '/organizations/:organizationId/control-center',
    (request) => {
      const organizationId = request.params.organizationId
      return {
        organization: organization.organizationSnapshot(organizationId),
        coordination: coordination.coordinationSnapshot(organizationId),
        assurance: assurance.dashboard(organizationId),
      }
    },
  )

  const coreCommands: Readonly<Record<string, CommandHandler>> = Object.freeze({
    'product-area.create': (body) => organization.createProductArea(body as never),
    'team.create': (body) => organization.createTeam(body as never),
    'position.create': (body) => organization.createPosition(body as never),
    'membership.create': (body) => organization.createMembership(body as never),
    'membership.transition': (body) => organization.transitionMembership(
      requiredText(body.membershipId, 'membershipId'),
      body as never,
    ),
    'role-definition.create': (body) => organization.createRoleDefinition(body as never),
    'role.assign': (body) => organization.assignRole(body as never),
    'capability.attest': (body) => organization.attestCapability(body as never),
    'role.activate': (body) => organization.activateRole(body as never),
    'authority-policy.create': (body) => organization.createAuthorityPolicy(body as never),
    'authority.evaluate': (body) => organization.evaluateAuthority(body as never),
    'ownership.assign': (body) => organization.assignOwnership(body as never),
  })

  const coordinationCommands: Readonly<Record<string, CommandHandler>> = Object.freeze({
    'interaction.create': (body) => coordination.createTeamInteraction(body as never),
    'responsibility.assign': (body) => coordination.assignResponsibility(body as never),
    'objective.create': (body) => coordination.createObjective(body as never),
    'goal.create': (body) => coordination.createTeamGoal(body as never),
    'capacity.capture': (body) => coordination.captureCapacity(body as never),
    'message.send': (body) => coordination.sendMessage(body as never),
    'decision.record': (body) => coordination.recordDecision(body as never),
    'escalation.create': (body) => coordination.createEscalation(body as never),
    'escalation.resolve': (body) => coordination.resolveEscalation(
      requiredText(body.escalationId, 'escalationId'),
      body as never,
    ),
    'risk.assess': (body) => coordination.assessRisk(body as never),
    'participation.record': (body) => coordination.recordParticipation(body as never),
    'control.approve': (body) => coordination.recordControlApproval(body as never),
    'control.status': (body) => coordination.controlStatus(body as never),
  })

  const assuranceCommands: Readonly<Record<string, CommandHandler>> = Object.freeze({
    'trace.node.add': (body) => assurance.addTraceNode(body as never),
    'trace.edge.add': (body) => assurance.linkTraceNodes(body as never),
    'trace.verify': (body) => assurance.verifyTrace(body as never),
    'provenance.attest': (body) => assurance.attestProvenance(body as never),
    'provenance.verify': (body) => assurance.verifyProvenance(
      requiredText(body.provenanceId, 'provenanceId'),
      requiredText(body.expectedArtifactSha256, 'expectedArtifactSha256'),
    ),
    'gate.define': (body) => assurance.createQualityGateDefinition(body as never),
    'gate.start': (body) => assurance.startQualityGate(body as never),
    'gate.result': (body) => assurance.recordQualityGateResult(body as never),
    'gate.override': (body) => assurance.overrideQualityGate(body as never),
    'gate.evaluate': (body) => assurance.evaluateQualityGate(
      requiredText(body.runId, 'runId'),
    ),
    'metric.define': (body) => assurance.createMetricDefinition(body as never),
    'scorecard.create': (body) => assurance.createScorecard(body as never),
    'metric.observe': (body) => assurance.recordMetricObservation(body as never),
    'scorecard.calibrate': (body) => assurance.calibrateScorecard(
      requiredText(body.scorecardId, 'scorecardId'),
      body as never,
    ),
    'calibration.create': (body) => assurance.createCalibrationReview(body as never),
    'access.certify': (body) => assurance.certifyAccess(body as never),
    'appeal.file': (body) => assurance.fileReviewAppeal(body as never),
    'appeal.resolve': (body) => assurance.resolveReviewAppeal(
      requiredText(body.appealId, 'appealId'),
      body as never,
    ),
    'incident.open': (body) => assurance.openIncident(body as never),
    'incident.timeline': (body) => assurance.addIncidentTimeline(body as never),
    'incident.resolve': (body) => assurance.resolveIncident(
      requiredText(body.incidentId, 'incidentId'),
      body as never,
    ),
    'postmortem.create': (body) => assurance.createPostmortem(body as never),
    'postmortem.review': (body) => assurance.reviewPostmortem(
      requiredText(body.postmortemId, 'postmortemId'),
      body as never,
    ),
    'corrective-action.create': (body) => assurance.createCorrectiveAction(body as never),
    'corrective-action.verify': (body) => assurance.verifyCorrectiveAction(
      requiredText(body.actionId, 'actionId'),
      body as never,
    ),
    'lesson.promote': (body) => assurance.promotePostmortemLesson(body as never),
  })

  app.post('/organizations/:organizationId/core/:command',
    commandRouteHandler(coreCommands, isOperator))
  app.post('/organizations/:organizationId/coordination/:command',
    commandRouteHandler(coordinationCommands, isOperator))
  app.post('/organizations/:organizationId/assurance/:command',
    commandRouteHandler(assuranceCommands, isOperator))
}

function commandRouteHandler(
  commands: Readonly<Record<string, CommandHandler>>,
  isOperator: (request: FastifyRequest) => boolean,
): (request: FastifyRequest<{
    Params: { organizationId: string; command: string }
    Body: unknown
  }>, reply: FastifyReply) => unknown {
  return (request, reply) => {
    const handler = commands[request.params.command]
    if (!handler) throw new NotFoundError('organization command not found')
    const body = commandBody(request, request.body, isOperator)
    const result = handler({ ...body, organizationId: request.params.organizationId })
    return reply.code(201).send({ result })
  }
}

function commandBody(
  request: FastifyRequest,
  value: unknown,
  isOperator: (request: FastifyRequest) => boolean,
): Record<string, unknown> {
  if (!isOperator(request)) {
    throw new ForbiddenError('operator authorization is required for organization commands')
  }
  const body = objectBody(value)
  const idempotencyKey = resolveIdempotencyKey({
    header: request.headers['idempotency-key'],
    rawHeaders: request.raw.rawHeaders,
    snake: body.idempotency_key,
    camel: body.idempotencyKey,
  })
  return {
    ...body,
    actor: { type: 'operator', id: request.orchestraPrincipal ?? 'operator' },
    idempotencyKey,
    correlationId: optionalText(body.correlationId ?? body.correlation_id),
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${field} is required`)
  }
  return value.trim()
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('correlation id must be a non-empty string')
  }
  return value.trim()
}

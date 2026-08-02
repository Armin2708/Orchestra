import type Database from 'better-sqlite3'
import {
  ComputedWorkspaceConflictService,
  type ConflictDetectionServiceBoundary,
} from './conflict-service.js'
import { ConversationService } from './conversations.js'
import { DeliveryReportService } from './delivery-reports.js'
import { KnowledgeService } from './knowledge-service.js'
import { KnowledgeStore } from './knowledge-store.js'
import { OrchestrationService } from './orchestration-service.js'
import { OrganizationService } from './organization.js'
import { OrganizationCoordinationService } from './organization-coordination.js'
import { OrganizationAssuranceService } from './organization-assurance.js'
import type { JobScheduler } from './scheduler.js'
import {
  SqliteDeviceSessionRepository,
  type DeviceSessionRepository,
} from './device-sessions.js'

export const AGENT_OS_DOMAIN_SERVICE_NAMES = Object.freeze([
  'orchestration',
  'conversations',
  'deliveries',
  'discussions',
  'knowledge',
  'organization',
  'coordination',
  'assurance',
  'conflicts',
  'device_pairing',
] as const)

export type AgentOsDomainServiceName = typeof AGENT_OS_DOMAIN_SERVICE_NAMES[number]

export type AgentOsDomainServiceImplementationState =
  | 'canonical'
  | 'persistence_only'
  | 'compatibility_only'
  | 'reserved'

export type OrchestrationServiceBoundary = Pick<
  OrchestrationService,
  'createCardJob' | 'launchCard' | 'getJobSnapshot'
>

export type ConversationServiceBoundary = Pick<
  ConversationService,
  | 'createConversation'
  | 'getConversation'
  | 'requireConversation'
  | 'listConversations'
  | 'updateConversation'
  | 'archiveConversation'
  | 'getSession'
  | 'requireSession'
  | 'listSessions'
  | 'linkSession'
  | 'appendEvent'
  | 'getEvent'
  | 'requireEvent'
  | 'listEvents'
  | 'listSessionEvents'
  | 'home'
>

export type DeliveryServiceBoundary = Pick<
  DeliveryReportService,
  | 'prepareForJob'
  | 'attachRuntimeScope'
  | 'createForCard'
  | 'get'
  | 'listCard'
  | 'currentForCard'
  | 'currentForJob'
  | 'submit'
  | 'verify'
  | 'verifySubmission'
  | 'accept'
  | 'reject'
  | 'revise'
  | 'assertReviewReady'
  | 'assertCompletionReady'
  | 'assertJobReviewReady'
  | 'assertJobCompletionReady'
  | 'renderHuman'
>

export type KnowledgePersistenceServiceBoundary = Pick<
  KnowledgeStore,
  | 'putSource'
  | 'getSource'
  | 'putChunk'
  | 'getChunk'
  | 'listChunks'
  | 'putContextBuild'
  | 'getContextBuild'
  | 'putContextUse'
  | 'getContextUse'
  | 'listContextUses'
  | 'finishContextUse'
>

export type KnowledgeServiceBoundary = Pick<
  KnowledgeService,
  | keyof KnowledgePersistenceServiceBoundary
  | 'ingestStructural'
  | 'ingestGitContext'
  | 'ingestVerifiedDelivery'
  | 'synchronizeRetrievalIndex'
  | 'rebuildRetrievalIndex'
  | 'retrieve'
>

export type OrganizationServiceBoundary = Pick<
  OrganizationService,
  | 'createOrganization'
  | 'createProductArea'
  | 'createTeam'
  | 'createPosition'
  | 'createMembership'
  | 'transitionMembership'
  | 'createRoleDefinition'
  | 'assignRole'
  | 'attestCapability'
  | 'activateRole'
  | 'createAuthorityPolicy'
  | 'evaluateAuthority'
  | 'assignOwnership'
  | 'organizationSnapshot'
  | 'listBoardOrganizations'
>

export type OrganizationCoordinationServiceBoundary = Pick<
  OrganizationCoordinationService,
  | 'createTeamInteraction'
  | 'assignResponsibility'
  | 'createObjective'
  | 'createTeamGoal'
  | 'captureCapacity'
  | 'sendMessage'
  | 'recordDecision'
  | 'createEscalation'
  | 'resolveEscalation'
  | 'assessRisk'
  | 'recordParticipation'
  | 'recordControlApproval'
  | 'controlStatus'
  | 'coordinationSnapshot'
>

export type OrganizationAssuranceServiceBoundary = Pick<
  OrganizationAssuranceService,
  | 'addTraceNode'
  | 'linkTraceNodes'
  | 'verifyTrace'
  | 'attestProvenance'
  | 'verifyProvenance'
  | 'createQualityGateDefinition'
  | 'startQualityGate'
  | 'recordQualityGateResult'
  | 'overrideQualityGate'
  | 'evaluateQualityGate'
  | 'createMetricDefinition'
  | 'createScorecard'
  | 'recordMetricObservation'
  | 'calibrateScorecard'
  | 'createCalibrationReview'
  | 'certifyAccess'
  | 'fileReviewAppeal'
  | 'resolveReviewAppeal'
  | 'openIncident'
  | 'addIncidentTimeline'
  | 'resolveIncident'
  | 'createPostmortem'
  | 'reviewPostmortem'
  | 'createCorrectiveAction'
  | 'verifyCorrectiveAction'
  | 'promotePostmortemLesson'
  | 'dashboard'
>

export type DevicePairingServiceBoundary = Pick<
  DeviceSessionRepository,
  | 'createPairingTicket'
  | 'redeemPairingTicket'
  | 'listDeviceSessions'
  | 'listDeviceCredentials'
  | 'verifyDeviceCredential'
  | 'rotateDeviceCredential'
  | 'revokeDeviceCredential'
  | 'revokeDeviceSession'
  | 'expireDueArtifacts'
>

interface AgentOsServiceBoundaryBase<
  Name extends AgentOsDomainServiceName,
  State extends AgentOsDomainServiceImplementationState,
> {
  readonly name: Name
  readonly implementation_state: State
  readonly owns: readonly string[]
  readonly excludes: readonly string[]
  readonly detail: string
}

export interface AgentOsActiveServiceBoundary<
  Name extends AgentOsDomainServiceName,
  State extends Exclude<AgentOsDomainServiceImplementationState, 'reserved'>,
  Service,
> extends AgentOsServiceBoundaryBase<Name, State> {
  readonly service: Service
}

export interface AgentOsReservedServiceBoundary<
  Name extends AgentOsDomainServiceName,
> extends AgentOsServiceBoundaryBase<Name, 'reserved'> {
  readonly service: null
}

export interface AgentOsDomainServiceBoundaries {
  readonly orchestration: AgentOsActiveServiceBoundary<
    'orchestration',
    'canonical',
    OrchestrationServiceBoundary
  >
  readonly conversations: AgentOsActiveServiceBoundary<
    'conversations',
    'canonical',
    ConversationServiceBoundary
  >
  readonly deliveries: AgentOsActiveServiceBoundary<
    'deliveries',
    'canonical',
    DeliveryServiceBoundary
  >
  readonly discussions: AgentOsReservedServiceBoundary<'discussions'>
  readonly knowledge: AgentOsActiveServiceBoundary<
    'knowledge',
    'canonical',
    KnowledgeServiceBoundary
  >
  readonly organization: AgentOsActiveServiceBoundary<
    'organization',
    'canonical',
    OrganizationServiceBoundary
  >
  readonly coordination: AgentOsActiveServiceBoundary<
    'coordination',
    'canonical',
    OrganizationCoordinationServiceBoundary
  >
  readonly assurance: AgentOsActiveServiceBoundary<
    'assurance',
    'canonical',
    OrganizationAssuranceServiceBoundary
  >
  readonly conflicts: AgentOsActiveServiceBoundary<
    'conflicts',
    'compatibility_only',
    ConflictDetectionServiceBoundary
  >
  readonly device_pairing: AgentOsActiveServiceBoundary<
    'device_pairing',
    'canonical',
    DevicePairingServiceBoundary
  >
}

export interface CreateAgentOsDomainServiceBoundariesOptions {
  scheduler: JobScheduler
  orchestration?: OrchestrationServiceBoundary
  conversations?: ConversationServiceBoundary
  deliveries?: DeliveryServiceBoundary
  knowledge?: KnowledgeServiceBoundary
  organization?: OrganizationServiceBoundary
  coordination?: OrganizationCoordinationServiceBoundary
  assurance?: OrganizationAssuranceServiceBoundary
  conflicts?: ConflictDetectionServiceBoundary
  devicePairing?: DevicePairingServiceBoundary
}

/**
 * Creates one explicit composition catalog without moving domain behavior into a router or
 * server bootstrap. Discussions stay reserved; device pairing is a canonical focused boundary
 * and transport authorization remains the root server composition's responsibility.
 */
export function createAgentOsDomainServiceBoundaries(
  db: Database.Database,
  options: CreateAgentOsDomainServiceBoundariesOptions,
): AgentOsDomainServiceBoundaries {
  return Object.freeze({
    orchestration: activeBoundary(
      'orchestration',
      'canonical',
      options.orchestration ?? new OrchestrationService(db, options.scheduler),
      [
        'contract-backed launch reservation',
        'job, session, and workspace-assignment identity',
        'scheduler dispatch',
      ],
      [
        'provider runtime implementation',
        'HTTP authentication',
        'legacy projection',
      ],
      'Canonical managed-work launch boundary.',
    ),
    conversations: activeBoundary(
      'conversations',
      'canonical',
      options.conversations ?? new ConversationService(db),
      [
        'durable conversations and session links',
        'ordered normalized conversation events',
        'conversation replay conflicts',
      ],
      [
        'low-level wake transport',
        'provider process control',
        'discussion lifecycle',
      ],
      'Canonical Agent Home conversation boundary.',
    ),
    deliveries: activeBoundary(
      'deliveries',
      'canonical',
      options.deliveries ?? new DeliveryReportService(db),
      [
        'frozen Asked snapshots',
        'delivery report revisions',
        'verification and acceptance evidence',
      ],
      [
        'job scheduling',
        'legacy card review controls',
        'knowledge promotion',
      ],
      'Canonical delivery and evidence boundary.',
    ),
    discussions: reservedBoundary(
      'discussions',
      [
        'durable discussion and post lifecycle',
        'accepted answers and resolutions',
        'explicit subscriptions and promotion',
      ],
      [
        'messages wake transport',
        'implicit broadcast',
        'tool-capable prompt injection',
      ],
      'Reserved until the canonical Discussion domain is implemented; messages remain transport.',
    ),
    knowledge: activeBoundary(
      'knowledge',
      'canonical',
      options.knowledge ?? new KnowledgeService(db),
      [
        'knowledge source and chunk persistence',
        'context build manifests',
        'context use accounting',
        'accepted discussion and decision evidence ingestion',
        'verified repository evidence ingestion',
        'deterministic retrieval synchronization and query',
      ],
      [
        'managed prompt injection',
        'automatic freshness or promotion',
      ],
      'Canonical bounded Knowledge ingestion and retrieval boundary.',
    ),
    organization: activeBoundary(
      'organization',
      'canonical',
      options.organization ?? new OrganizationService(db),
      [
        'organization hierarchy and accountable ownership',
        'membership lifecycle and authority revocation',
        'versioned role, capability, activation, and authority policy',
      ],
      [
        'work assignment identity',
        'provider runtime identity',
        'implicit authority from capability or seniority labels',
      ],
      'Canonical organization, membership, role, ownership, and authority boundary.',
    ),
    coordination: activeBoundary(
      'coordination',
      'canonical',
      options.coordination ?? new OrganizationCoordinationService(db),
      [
        'team interaction modes and responsibility tuples',
        'objectives, team goals, capacity, typed messages, and decisions',
        'risk selection, escalation, participation history, and control approvals',
      ],
      [
        'transport-only wake delivery',
        'implicit broadcast or model-generated acknowledgement loops',
        'self-approval or authority inferred from capability labels',
      ],
      'Canonical cross-team coordination, decision, escalation, and risk-control boundary.',
    ),
    assurance: activeBoundary(
      'assurance',
      'canonical',
      options.assurance ?? new OrganizationAssuranceService(db),
      [
        'digest-verifiable trace and artifact provenance',
        'risk-selected gate graphs and contextual scorecards',
        'calibration, access certification, appeal, incident, CAPA, and learning',
      ],
      [
        'raw activity-volume individual ranking',
        'self-review or hidden quality overrides',
        'blame attribution from incident learning records',
      ],
      'Canonical traceability, quality, measurement, access-review, and learning boundary.',
    ),
    conflicts: activeBoundary(
      'conflicts',
      'compatibility_only',
      options.conflicts ?? new ComputedWorkspaceConflictService(db),
      [
        'computed execution-root overlap',
        'computed owned-path overlap',
      ],
      [
        'durable Conflict lifecycle',
        'negotiation and arbitration',
        'enforcement or automatic resolution',
      ],
      'Compatibility detection boundary; durable Conflict resolution remains open.',
    ),
    device_pairing: activeBoundary(
      'device_pairing',
      'canonical',
      options.devicePairing ?? new SqliteDeviceSessionRepository(db),
      [
        'single-use pairing tickets',
        'named scoped DeviceSessions',
        'expiry, revocation, and device attribution',
      ],
      [
        'operator master-token QR bootstrap',
        'broad bearer persistence',
        'unclassified remote reads or mutations',
      ],
      'Canonical credential lifecycle boundary; route and service authorization remain default-deny.',
    ),
  })
}

function activeBoundary<
  Name extends AgentOsDomainServiceName,
  State extends Exclude<AgentOsDomainServiceImplementationState, 'reserved'>,
  Service,
>(
  name: Name,
  implementationState: State,
  service: Service,
  owns: readonly string[],
  excludes: readonly string[],
  detail: string,
): AgentOsActiveServiceBoundary<Name, State, Service> {
  return Object.freeze({
    name,
    implementation_state: implementationState,
    service,
    owns: Object.freeze([...owns]),
    excludes: Object.freeze([...excludes]),
    detail,
  })
}

function reservedBoundary<Name extends AgentOsDomainServiceName>(
  name: Name,
  owns: readonly string[],
  excludes: readonly string[],
  detail: string,
): AgentOsReservedServiceBoundary<Name> {
  return Object.freeze({
    name,
    implementation_state: 'reserved',
    service: null,
    owns: Object.freeze([...owns]),
    excludes: Object.freeze([...excludes]),
    detail,
  })
}

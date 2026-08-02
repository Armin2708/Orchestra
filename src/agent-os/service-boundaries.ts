import type Database from 'better-sqlite3'
import { ConversationService } from './conversations.js'
import { DeliveryReportService } from './delivery-reports.js'
import { DiscussionService } from './discussions.js'
import { KnowledgeService } from './knowledge-service.js'
import { KnowledgeStore } from './knowledge-store.js'
import { OrchestrationService } from './orchestration-service.js'
import { OrganizationService } from './organization.js'
import { OrganizationCoordinationService } from './organization-coordination.js'
import { OrganizationAssuranceService } from './organization-assurance.js'
import { PlanningTeamService } from './team-planning.js'
import type { JobScheduler } from './scheduler.js'

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

export type DiscussionServiceBoundary = Pick<
  DiscussionService,
  | 'createDiscussion'
  | 'addPost'
  | 'editPost'
  | 'acceptAnswer'
  | 'transition'
  | 'subscribe'
  | 'unsubscribe'
  | 'grantPermission'
  | 'revokePermission'
  | 'requestPromotion'
  | 'get'
  | 'require'
  | 'list'
  | 'search'
  | 'queue'
  | 'notifications'
  | 'promotions'
>

export type ConflictResolutionServiceBoundary = Pick<
  PlanningTeamService,
  | 'openConflict'
  | 'addConflictProposal'
  | 'resolveConflict'
  | 'requestConflictKnowledgePromotion'
  | 'listBoardConflicts'
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
  readonly discussions: AgentOsActiveServiceBoundary<
    'discussions',
    'canonical',
    DiscussionServiceBoundary
  >
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
    'canonical',
    ConflictResolutionServiceBoundary
  >
  readonly device_pairing: AgentOsReservedServiceBoundary<'device_pairing'>
}

export interface CreateAgentOsDomainServiceBoundariesOptions {
  scheduler: JobScheduler
  orchestration?: OrchestrationServiceBoundary
  conversations?: ConversationServiceBoundary
  deliveries?: DeliveryServiceBoundary
  discussions?: DiscussionServiceBoundary
  knowledge?: KnowledgeServiceBoundary
  organization?: OrganizationServiceBoundary
  coordination?: OrganizationCoordinationServiceBoundary
  assurance?: OrganizationAssuranceServiceBoundary
  conflicts?: ConflictResolutionServiceBoundary
}

/**
 * Creates one explicit composition catalog without moving domain behavior into a router or
 * server bootstrap. Reserved domains stay null so the master-token QR cannot be mistaken for
 * secure device pairing.
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
    discussions: activeBoundary(
      'discussions',
      'canonical',
      options.discussions ?? new DiscussionService(db),
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
      'Canonical durable Discussion and reviewable exact-source promotion boundary.',
    ),
    knowledge: activeBoundary(
      'knowledge',
      'canonical',
      options.knowledge ?? new KnowledgeService(db),
      [
        'knowledge source and chunk persistence',
        'context build manifests',
        'context use accounting',
        'committed decision evidence ingestion',
        'verified repository evidence ingestion',
        'deterministic retrieval synchronization and query',
      ],
      [
        'unreviewed arbitrary-text promotion',
        'provider-reported token estimates as actual usage',
      ],
      'Canonical bounded Knowledge compilation, injection, freshness, review, and retrieval boundary.',
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
      'canonical',
      options.conflicts ?? new PlanningTeamService(db),
      [
        'durable conflict lifecycle and participants',
        'bounded proposals and explicit arbitration',
        'rationale, resolution, follow-up, and reviewed knowledge candidates',
      ],
      [
        'implicit last-write-wins resolution',
        'self-approval or status-only knowledge promotion',
        'unbounded negotiation fanout',
      ],
      'Canonical durable Conflict negotiation and resolution boundary.',
    ),
    device_pairing: reservedBoundary(
      'device_pairing',
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
      'Reserved until secure DeviceSession pairing is implemented and threat-model gates pass.',
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

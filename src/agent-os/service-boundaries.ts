import type Database from 'better-sqlite3'
import {
  ComputedWorkspaceConflictService,
  type ConflictDetectionServiceBoundary,
} from './conflict-service.js'
import { ConversationService } from './conversations.js'
import { DeliveryReportService } from './delivery-reports.js'
import { KnowledgeStore } from './knowledge-store.js'
import { OrchestrationService } from './orchestration-service.js'
import type { JobScheduler } from './scheduler.js'

export const AGENT_OS_DOMAIN_SERVICE_NAMES = Object.freeze([
  'orchestration',
  'conversations',
  'deliveries',
  'discussions',
  'knowledge',
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
    'persistence_only',
    KnowledgePersistenceServiceBoundary
  >
  readonly conflicts: AgentOsActiveServiceBoundary<
    'conflicts',
    'compatibility_only',
    ConflictDetectionServiceBoundary
  >
  readonly device_pairing: AgentOsReservedServiceBoundary<'device_pairing'>
}

export interface CreateAgentOsDomainServiceBoundariesOptions {
  scheduler: JobScheduler
  orchestration?: OrchestrationServiceBoundary
  conversations?: ConversationServiceBoundary
  deliveries?: DeliveryServiceBoundary
  knowledge?: KnowledgePersistenceServiceBoundary
  conflicts?: ConflictDetectionServiceBoundary
}

/**
 * Creates one explicit composition catalog without moving domain behavior into a router or
 * server bootstrap. Reserved domains stay null so legacy messages and the master-token QR cannot
 * be mistaken for canonical Discussions or secure device pairing.
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
      'persistence_only',
      options.knowledge ?? new KnowledgeStore(db),
      [
        'knowledge source and chunk persistence',
        'context build manifests',
        'context use accounting',
      ],
      [
        'retrieval and ranking',
        'managed prompt injection',
        'automatic freshness or promotion',
      ],
      'Durable Knowledge persistence boundary; the Knowledge Compiler remains open.',
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
